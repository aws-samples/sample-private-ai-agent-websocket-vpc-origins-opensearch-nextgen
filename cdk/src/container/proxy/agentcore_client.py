"""AgentCore Runtime invocation + SSE parsing for the proxy (v2).

This module owns *how the proxy talks to AgentCore* and is kept separate from
``app.py`` (the FastAPI wiring) so the transport can be unit-tested in isolation.

It provides:

  * :func:`stream_tokens` — an async generator that invokes
    ``bedrock-agentcore:InvokeAgentRuntime`` for a given prompt + session id and
    yields text tokens in order, parsing the runtime's SSE / chunked response.
    In mock mode (no runtime ARN) it yields a short synthesized response so the
    WebSocket protocol and demo frontend work offline.
  * :func:`invoke` / :func:`invoke_async` — return the complete (non-streamed)
    response string for the HTTP ``/invocations`` path.

The boto ``invoke_agent_runtime`` call is blocking and its response body is a
streaming object, so the streaming bridge runs the blocking iteration on a
worker thread and hands chunks back to the event loop through an
``asyncio.Queue``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any, AsyncIterator, Iterator, Optional

from config import Settings, get_settings

logger = logging.getLogger("proxy.agentcore")

# Overall ceiling for a single agent invocation. Set slightly ABOVE the agent's
# own 120s generation ceiling so that, on a genuinely long run, the agent's
# internal timeout fires first and returns a clean error frame rather than the
# proxy severing the stream mid-token. Normal audits/queries finish well under
# this (focused audits target ~1 minute).
INVOKE_TIMEOUT_SECONDS: float = 150.0

# Sentinels passed through the bridge queue.
_DONE = object()


class AgentCoreError(RuntimeError):
    """Raised when invoking the AgentCore runtime fails."""


# ---------------------------------------------------------------------------
# Mock streaming (offline mode).
# ---------------------------------------------------------------------------

_MOCK_RESPONSE = (
    "[mock proxy] AgentCore runtime is not configured. This is a synthesized "
    "streamed response so the WebSocket protocol and demo frontend can be "
    "exercised end to end without a live runtime."
)


def _tokenize(text: str) -> list[str]:
    if not text:
        return []
    words = text.split(" ")
    out: list[str] = []
    last = len(words) - 1
    for i, w in enumerate(words):
        out.append(w if i == last else w + " ")
    return [t for t in out if t]


# ---------------------------------------------------------------------------
# SSE / chunk parsing.
# ---------------------------------------------------------------------------


def _extract_text_from_event(obj: Any) -> str:
    """Pull a text delta from a decoded AgentCore/Strands event object.

    Strands stream events arrive as ``{"data": "<delta>"}``. Some events are
    dicts with other shapes (tool use, metadata, lifecycle) and yield no text.
    Plain strings are returned as-is.
    """
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        # Surface explicit errors so the caller can map them to a WS error frame.
        if "error" in obj and obj["error"]:
            raise AgentCoreError(str(obj["error"]))
        data = obj.get("data")
        if isinstance(data, str):
            return data
        # Some SDKs wrap the text under {"event": {"contentBlockDelta": ...}} or
        # {"chunk": {"bytes": ...}}; best-effort common keys.
        for key in ("delta", "text", "outputText", "completion"):
            val = obj.get(key)
            if isinstance(val, str):
                return val
    return ""


def _decode_sse_line(line: str) -> Optional[str]:
    """Decode one SSE ``data:`` line into a text token (or None to skip)."""
    line = line.strip()
    if not line or line.startswith(":"):
        return None
    if line.startswith("data:"):
        payload = line[len("data:") :].strip()
        if not payload or payload == "[DONE]":
            return None
        # The data payload may be JSON (an event object) or a raw string.
        try:
            obj = json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            return payload
        return _extract_text_from_event(obj)
    return None


# Wire-read size for the incremental raw-stream path. For a chunked
# (transfer-encoding: chunked) SSE response — which is how AgentCore Runtime
# streams — urllib3's read_chunked yields one HTTP chunk per SSE event as the
# runtime flushes it, regardless of this ceiling, so events surface immediately
# instead of being batched behind a fixed-size read.
_WIRE_READ_SIZE = 65536


def _iter_byte_chunks(body: Any) -> Iterator[bytes]:
    """Yield raw byte chunks from a botocore StreamingBody *incrementally*.

    botocore's ``StreamingBody.iter_lines``/``iter_chunks`` read in fixed
    1024-byte blocks (``read(1024)`` blocks until 1024 bytes accumulate), which
    batches a stream of small SSE token events. To stream smoothly we iterate
    the underlying urllib3 response (``_raw_stream``) directly: for a chunked
    response its ``.stream()`` is a generator that yields each HTTP chunk the
    moment it arrives. We fall back to botocore's API if the private raw stream
    is unavailable (e.g. a stubbed/mocked body in tests).
    """
    raw = getattr(body, "_raw_stream", None)
    if raw is not None and hasattr(raw, "stream"):
        for chunk in raw.stream(_WIRE_READ_SIZE, decode_content=True):
            if chunk:
                yield chunk if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode("utf-8")
        return
    if hasattr(body, "iter_chunks"):
        # Smaller chunk size than the 1024 default still batches less; this is
        # only reached when the raw urllib3 stream is not exposed.
        for chunk in body.iter_chunks(chunk_size=64):
            if chunk:
                yield chunk if isinstance(chunk, (bytes, bytearray)) else str(chunk).encode("utf-8")
        return
    if hasattr(body, "read"):
        data = body.read()
        if data:
            yield data if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8")


def _iter_sse_lines(body: Any) -> Iterator[str]:
    """Yield decoded text lines from ``body`` as bytes arrive, without batching.

    Reassembles lines across HTTP-chunk boundaries (a chunk may end mid-line)
    and emits each complete line as soon as its terminating newline is seen.
    """
    pending = b""
    for chunk in _iter_byte_chunks(body):
        pending += bytes(chunk)
        while True:
            idx = pending.find(b"\n")
            if idx == -1:
                break
            line = pending[:idx]
            pending = pending[idx + 1 :]
            yield line.decode("utf-8", "replace")
    if pending:
        yield pending.decode("utf-8", "replace")


def _iter_response_text(response: dict[str, Any]) -> Iterator[str]:
    """Yield text tokens from a boto ``invoke_agent_runtime`` response (blocking).

    Handles the common response shapes:
      * ``response["response"]`` is a streaming body (botocore StreamingBody or
        an EventStream) — iterate it INCREMENTALLY, decoding SSE ``data:`` lines
        as the runtime flushes them so tokens stream smoothly (not in batches).
      * a non-streaming ``response`` containing the full text.
    """
    body = response.get("response") or response.get("completion") or response.get("body")
    if body is None:
        return

    # EventStream (iterable of event dicts with a "chunk"/"bytes" payload).
    # Has __iter__ but no read(); StreamingBody has both, so check this first.
    if hasattr(body, "__iter__") and not hasattr(body, "read"):
        for event in body:
            chunk = None
            if isinstance(event, dict):
                # {"chunk": {"bytes": b"..."}} or a direct event dict.
                if "chunk" in event and isinstance(event["chunk"], dict):
                    chunk = event["chunk"].get("bytes")
                else:
                    text = _extract_text_from_event(event)
                    if text:
                        yield text
                    continue
            elif isinstance(event, (bytes, bytearray)):
                chunk = bytes(event)
            if chunk:
                for line in bytes(chunk).decode("utf-8", "replace").splitlines():
                    token = _decode_sse_line(line)
                    if token:
                        yield token
        return

    # StreamingBody (a streaming blob — AgentCore's actual response shape).
    # Iterate the underlying wire incrementally so each SSE event surfaces as
    # soon as it is flushed. If the body is NOT SSE (plain text or a single
    # JSON object), salvage the whole payload at the end.
    if hasattr(body, "read") or hasattr(body, "iter_chunks") or hasattr(body, "iter_lines"):
        produced_any = False
        salvage: list[str] = []
        for line in _iter_sse_lines(body):
            token = _decode_sse_line(line)
            if token:
                produced_any = True
                yield token
            elif not produced_any:
                salvage.append(line)
        if not produced_any:
            text = "\n".join(salvage).strip()
            if text:
                try:
                    obj = json.loads(text)
                    t = _extract_text_from_event(obj)
                    yield t if t else text
                except (json.JSONDecodeError, ValueError):
                    yield text
        return

    # Fallback: a plain string field.
    if isinstance(body, str) and body:
        yield body


# ---------------------------------------------------------------------------
# Public streaming API.
# ---------------------------------------------------------------------------


def _blocking_invoke_stream(
    settings: Settings, prompt: str, session_id: str, queue: "asyncio.Queue[Any]", loop: asyncio.AbstractEventLoop
) -> None:
    """Invoke the runtime and push text tokens onto the asyncio queue (worker thread)."""

    def _put(item: Any) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(item), loop)

    try:
        import boto3  # local import keeps the module importable offline
        from botocore.config import Config  # type: ignore[import-not-found]

        # AgentCore invocations can be slow on a cold start (microVM spin-up +
        # OpenSearch warm + first Bedrock call). The botocore default read
        # timeout is 60s, which fires mid-stream on the first call. Give the
        # client a generous read timeout and disable client-side retries (the
        # agent itself retries Bedrock).
        client = boto3.client(
            "bedrock-agentcore",
            region_name=settings.aws_region,
            config=Config(
                connect_timeout=10,
                read_timeout=240,
                retries={"max_attempts": 1, "mode": "standard"},
            ),
        )
        kwargs: dict[str, Any] = {
            "agentRuntimeArn": settings.agent_runtime_arn,
            "runtimeSessionId": session_id,
            "payload": json.dumps({"prompt": prompt}).encode("utf-8"),
        }
        if settings.qualifier:
            kwargs["qualifier"] = settings.qualifier
        response = client.invoke_agent_runtime(**kwargs)
        for token in _iter_response_text(response):
            if token:
                _put(token)
    except AgentCoreError as exc:
        _put(exc)
    except Exception as exc:  # noqa: BLE001 - surface as a single error
        logger.exception("invoke_agent_runtime failed")
        _put(AgentCoreError(f"failed to invoke the agent runtime: {exc}"))
    finally:
        _put(_DONE)


async def stream_tokens(
    prompt: str,
    session_id: str,
    *,
    settings: Optional[Settings] = None,
    timeout: float = INVOKE_TIMEOUT_SECONDS,
) -> AsyncIterator[str]:
    """Yield text tokens for ``prompt`` from the AgentCore runtime in order.

    In mock mode yields a synthesized response. Raises :class:`AgentCoreError`
    if the runtime invocation fails, and :class:`asyncio.TimeoutError` if the
    overall ceiling is exceeded.
    """
    settings = settings or get_settings()

    if settings.mock_mode:
        for token in _tokenize(_MOCK_RESPONSE):
            await asyncio.sleep(0)
            yield token
        return

    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[Any]" = asyncio.Queue()
    worker = threading.Thread(
        target=_blocking_invoke_stream,
        args=(settings, prompt, session_id, queue, loop),
        daemon=True,
    )
    worker.start()

    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise asyncio.TimeoutError("agent runtime invocation timed out")
        item = await asyncio.wait_for(queue.get(), timeout=remaining)
        if item is _DONE:
            return
        if isinstance(item, AgentCoreError):
            raise item
        if isinstance(item, str) and item:
            yield item


async def invoke_async(
    prompt: str,
    session_id: str,
    *,
    settings: Optional[Settings] = None,
    timeout: float = INVOKE_TIMEOUT_SECONDS,
) -> str:
    """Return the complete (joined) agent response for the HTTP path."""
    parts: list[str] = []
    async for token in stream_tokens(prompt, session_id, settings=settings, timeout=timeout):
        parts.append(token)
    return "".join(parts)
