"""Strands agent composition, Amazon Bedrock retry/timeout policy, and offline mock.

This module (task 9.3) owns *how the agent is built and invoked* and is kept
separate from ``app.py`` (the FastAPI wiring) so the HTTP/WebSocket endpoints
(tasks 9.5 / 9.6 / 9.7) can be implemented independently.

It provides three things:

1. :func:`build_agent` — constructs the Strands ``Agent`` backed by an
   Amazon Bedrock ``BedrockModel`` configured with a 3-attempt retry budget and a 120-second
   read ceiling (R10.6 / R10.7). When ``settings.mock_mode`` is True it returns
   a :class:`MockAgent` instead, so the wire protocol and demo frontend run
   fully offline without touching Amazon Bedrock or Amazon OpenSearch.

2. A uniform invocation surface the endpoints can call regardless of whether
   the underlying object is a real Strands ``Agent`` or a :class:`MockAgent`:

     * ``async def stream_tokens(agent, query) -> AsyncIterator[str]`` — yields
       text tokens in generation order (drives ``/ws``).
     * ``def invoke(agent, query) -> str`` — returns the complete response
       (drives ``/invocations``).
     * ``async def invoke_async(agent, query) -> str`` — the same, run off the
       event loop and bounded by the overall timeout ceiling.

   Both the real ``Agent`` and :class:`MockAgent` share the same duck-typed
   interface: an async-generator ``stream_async(query)`` and a callable
   ``__call__(query)`` returning a complete (``str()``-able) result.

3. :data:`SYSTEM_PROMPT` — the agent's system prompt.

Heavy third-party imports (``strands``, ``boto3``/``botocore``, and the
``retriever`` module created by task 9.4) are performed lazily inside
:func:`build_agent` so this module imports cleanly — and ``py_compile`` passes —
in environments where those packages are not installed (local dev, CI).

Requirements: 7.1, 10.1, 10.2, 10.4, 10.5, 10.6, 10.7.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional

from config import Settings, get_settings

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    pass

logger = logging.getLogger("agent.runtime")

# ---------------------------------------------------------------------------
# System prompt (R7.1).
#
# This deployment is a LOCKED-DOWN, single-purpose agent: the NextGen Solutions
# Contract Review Agent. The prompt is the EXACT, authoritative copy bundled
# into the container as ``system_prompt.md`` (sourced from
# ``Agent-Documents/agent-prompt/system-prompt.md``). It is loaded verbatim — no
# generic fallback — so the agent can ONLY perform contract review against the
# SOP knowledge base and refuses everything else. If the file is missing the
# import fails hard rather than silently degrading to a generic assistant.
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "system_prompt.md")


def _load_system_prompt() -> str:
    """Load the locked contract-review system prompt verbatim from disk.

    Raises ``RuntimeError`` if the bundled prompt file is missing or empty, so a
    misbuilt image can never run with a generic/absent prompt.
    """
    try:
        with open(_SYSTEM_PROMPT_FILE, "r", encoding="utf-8") as handle:
            text = handle.read().strip()
    except OSError as exc:  # pragma: no cover - exercised only on a broken build
        raise RuntimeError(
            f"locked system prompt not found at {_SYSTEM_PROMPT_FILE}; the agent "
            f"image must bundle system_prompt.md (the Contract Review Agent prompt)"
        ) from exc
    if not text:
        raise RuntimeError(f"system prompt file {_SYSTEM_PROMPT_FILE} is empty")
    return text


SYSTEM_PROMPT: str = _load_system_prompt()

# ---------------------------------------------------------------------------
# Bedrock retry / timeout policy (R10.6 / R10.7).
#
#   * MAX_ATTEMPTS  — total invocation attempts (1 initial + 2 retries) applied
#                     by the botocore client for transient/throttling errors.
#   * AGENT_TIMEOUT_SECONDS — the hard ceiling for a single agent invocation.
#                     Applied both as the boto socket read_timeout AND as an
#                     asyncio.wait_for deadline around the wrapper helpers so a
#                     stuck stream cannot exceed it.
# ---------------------------------------------------------------------------
MAX_ATTEMPTS: int = 3
RETRY_MODE: str = "adaptive"
AGENT_TIMEOUT_SECONDS: float = 120.0


class AgentInvocationError(RuntimeError):
    """Raised when an agent invocation fails (e.g. retry budget exhausted).

    Surfaced to callers (HTTP ``/invocations`` -> 502, WS ``/ws`` -> ``error``)
    so the failure is reported descriptively and never as a false success
    (R10.7).
    """


class AgentTimeoutError(AgentInvocationError):
    """Raised when an agent invocation exceeds :data:`AGENT_TIMEOUT_SECONDS`."""


# ---------------------------------------------------------------------------
# Mock model / agent (offline mode).
# ---------------------------------------------------------------------------

# A tiny in-memory knowledge base so offline answers feel grounded. This is NOT
# the production RAG store (that is OpenSearch via the retriever in task 9.4);
# it only exists so the WebSocket protocol and demo frontend are exercisable
# without Bedrock/OpenSearch access.
_MOCK_KNOWLEDGE: dict[str, str] = {
    "compliance": (
        "Q3 compliance review passed all SOC 2 controls with no major findings."
    ),
    "incident": (
        "The incident response runbook requires paging on-call within 5 minutes "
        "of a Sev-1 alert."
    ),
    "privacy": (
        "Customer data is retained for 90 days and then irreversibly purged."
    ),
    "infrastructure": (
        "All backend services run in private subnets reachable only through "
        "VPC endpoints."
    ),
    "cost": (
        "Scale-to-zero OpenSearch Serverless keeps idle RAG infrastructure cost "
        "at zero."
    ),
}


def _mock_retrieve(query: str) -> str:
    """Return a short, deterministic context string for the mock agent.

    Picks knowledge snippets whose keyword appears in the query; falls back to a
    generic line so a response is always produced.
    """
    q = query.lower()
    hits = [text for keyword, text in _MOCK_KNOWLEDGE.items() if keyword in q]
    if not hits:
        # Deterministic fallback: surface one snippet so the answer is grounded.
        hits = [next(iter(_MOCK_KNOWLEDGE.values()))]
    return " ".join(hits)


def _tokenize(text: str) -> list[str]:
    """Split text into whitespace-preserving tokens for token-by-token streaming.

    Each token carries its trailing space so concatenating all tokens
    reconstructs the original text exactly. This lets ``/ws`` stream the mock
    response one token at a time (R8.2) while ``/invocations`` can join them
    back into the complete response (R7.7).
    """
    if not text:
        return []
    words = text.split(" ")
    tokens: list[str] = []
    last = len(words) - 1
    for i, word in enumerate(words):
        tokens.append(word if i == last else word + " ")
    return [t for t in tokens if t]


class MockAgent:
    """Offline stand-in for the Strands ``Agent`` (used when ``mock_mode``).

    Exposes the SAME interface the endpoints rely on:

      * ``async def stream_async(query)`` — async generator yielding text token
        chunks one at a time (so ``/ws`` streaming can be exercised).
      * ``def __call__(query)`` — returns the complete response string (so
        ``/invocations`` can return a non-streamed body).

    The response is derived from the query plus a snippet of the in-memory mock
    knowledge base, so the demo frontend shows meaningful, grounded-looking text
    without any Bedrock/OpenSearch calls.
    """

    is_mock: bool = True

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _compose_response(self, query: str) -> str:
        query = (query or "").strip()
        context = _mock_retrieve(query)
        return (
            f"[mock] Based on organizational knowledge, here is what I found "
            f"about \"{query}\": {context} "
            f"(This is an offline mock response; configure OPENSEARCH_ENDPOINT "
            f"and Bedrock access for live answers.)"
        )

    async def stream_async(self, query: str) -> AsyncIterator[str]:
        """Yield the mock response token-by-token (mirrors Strands streaming)."""
        text = self._compose_response(query)
        for token in _tokenize(text):
            # Cooperative yield so the event loop can interleave sends on /ws
            # and the stream is genuinely incremental rather than all-at-once.
            await asyncio.sleep(0)
            yield token

    def __call__(self, query: str) -> str:
        """Return the complete mock response (mirrors ``Agent.__call__``)."""
        return self._compose_response(query)


# ---------------------------------------------------------------------------
# Agent construction.
# ---------------------------------------------------------------------------


def build_agent(settings: Optional[Settings] = None) -> Any:
    """Construct and return the agent used by the container's endpoints.

    In **mock mode** (``settings.mock_mode`` — i.e. no OpenSearch endpoint
    configured) this returns a :class:`MockAgent` and performs no third-party
    imports, so it works offline.

    Otherwise it builds a real Strands ``Agent`` backed by a ``BedrockModel``
    configured with:

      * ``model_id`` = ``settings.bedrock_model_id`` (R10.4 / R10.5),
      * ``region_name`` = ``settings.aws_region`` so inference routes through
        the in-VPC Bedrock Runtime endpoint (R10.1 / R10.2), and
      * a botocore ``Config`` with ``retries={"max_attempts": 3, "mode":
        "adaptive"}`` and ``read_timeout=120`` (R10.6 / R10.7),

    wired with :data:`SYSTEM_PROMPT` and the ``opensearch_retriever`` tool
    (R7.1). The ``strands`` / ``botocore`` / ``retriever`` imports are done here
    (lazily) so this module imports cleanly where those packages are absent.

    Raises:
        AgentInvocationError: if the real agent cannot be constructed (missing
            dependencies or misconfiguration). The caller (``app.py`` lifespan)
            logs this and leaves ``READY`` False so ``/health`` returns 503.
    """
    settings = settings or get_settings()

    if settings.mock_mode:
        logger.info(
            "building MockAgent (offline mode): no OpenSearch endpoint configured"
        )
        return MockAgent(settings)

    logger.info(
        "building Strands Agent: model_id=%s region=%s max_attempts=%s "
        "read_timeout=%ss",
        settings.bedrock_model_id,
        settings.aws_region,
        MAX_ATTEMPTS,
        int(AGENT_TIMEOUT_SECONDS),
    )

    try:
        # Lazy, guarded imports: only required for the live Bedrock path.
        from botocore.config import Config  # type: ignore import-not-found
        from strands import Agent  # type: ignore import-not-found
        from strands.models import BedrockModel  # type: ignore import-not-found

        # retriever.py is provided by task 9.4 and exposes the @tool-decorated
        # ``opensearch_retriever``. Imported directly (preferred) here so the
        # real agent always has the RAG tool available.
        from retriever import opensearch_retriever  # type: ignore import-not-found

        boto_config = Config(
            retries={"max_attempts": MAX_ATTEMPTS, "mode": RETRY_MODE},
            read_timeout=int(AGENT_TIMEOUT_SECONDS),
            connect_timeout=10,
        )

        model = BedrockModel(
            model_id=settings.bedrock_model_id,
            region_name=settings.aws_region,
            boto_client_config=boto_config,
        )

        agent = Agent(
            model=model,
            system_prompt=SYSTEM_PROMPT,
            tools=[opensearch_retriever],
        )
    except Exception as exc:  # noqa: BLE001 - surface a single descriptive error
        raise AgentInvocationError(
            f"failed to construct the Strands agent: {exc}"
        ) from exc

    return agent


# ---------------------------------------------------------------------------
# Uniform invocation helpers (used by /ws, /invocations).
# ---------------------------------------------------------------------------


def _extract_text(chunk: Any) -> str:
    """Normalize a streamed chunk from either agent type into a text token.

    * :class:`MockAgent` yields plain ``str`` tokens -> returned as-is.
    * The real Strands ``Agent.stream_async`` yields event ``dict``s; the
      incremental text delta lives under the ``"data"`` key. Non-text events
      (tool-use, lifecycle, metadata) yield no token and are skipped.
    """
    if isinstance(chunk, str):
        return chunk
    if isinstance(chunk, dict):
        data = chunk.get("data")
        if isinstance(data, str):
            return data
    return ""


async def stream_tokens(
    agent: Any,
    query: str,
    *,
    timeout: float = AGENT_TIMEOUT_SECONDS,
) -> AsyncIterator[str]:
    """Stream text tokens from ``agent`` in generation order.

    Works for both the real Strands ``Agent`` and :class:`MockAgent` by
    normalizing each chunk via :func:`_extract_text` and yielding only
    non-empty text deltas (R8.2 ordering is preserved by iteration order).

    An overall ``timeout`` ceiling (default :data:`AGENT_TIMEOUT_SECONDS`,
    R10.7) is enforced across the whole stream: if the agent has not finished
    within the budget, the generator is closed and :class:`AgentTimeoutError`
    is raised so the caller reports a descriptive failure rather than a partial
    success. The 3-attempt retry budget (R10.6) is enforced one layer down by
    the ``BedrockModel`` boto client config.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    agen = agent.stream_async(query)
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AgentTimeoutError(
                    f"agent did not complete within {timeout:.0f}s"
                )
            try:
                chunk = await asyncio.wait_for(agen.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError as exc:
                raise AgentTimeoutError(
                    f"agent did not complete within {timeout:.0f}s"
                ) from exc
            text = _extract_text(chunk)
            if text:
                yield text
    finally:
        aclose = getattr(agen, "aclose", None)
        if aclose is not None:
            # Ensure the underlying generator (and any Bedrock stream) is closed
            # on early exit, timeout, or caller cancellation.
            await aclose()


def invoke(agent: Any, query: str) -> str:
    """Return the complete agent response as a string (synchronous).

    Mirrors how a Strands ``Agent`` is called (``agent(query)``) and how
    :class:`MockAgent` is called, then coerces the result to ``str`` for the
    ``/invocations`` body (R7.7). Construction-time/inference errors are wrapped
    in :class:`AgentInvocationError` so the caller never mistakes a failure for
    success (R10.7). The 3-attempt retry budget (R10.6) and the 120s socket
    ceiling (R10.7) are applied by the ``BedrockModel`` boto client config.
    """
    try:
        result = agent(query)
    except Exception as exc:  # noqa: BLE001 - surface a single descriptive error
        raise AgentInvocationError(
            f"the agent response could not be generated: {exc}"
        ) from exc
    return str(result)


async def invoke_async(
    agent: Any,
    query: str,
    *,
    timeout: float = AGENT_TIMEOUT_SECONDS,
) -> str:
    """Async wrapper around :func:`invoke` bounded by an overall ``timeout``.

    Runs the (potentially blocking) synchronous invocation off the event loop
    and enforces the :data:`AGENT_TIMEOUT_SECONDS` ceiling with
    ``asyncio.wait_for`` (R10.7). On timeout it raises :class:`AgentTimeoutError`
    so callers surface a descriptive error without reporting success.

    Note: the endpoint-level deadlines (e.g. the 60s ``/invocations`` ceiling in
    R7.10) are applied by the endpoint task (9.5); this helper enforces the
    model-level 120s ceiling from R10.7.
    """
    try:
        return await asyncio.wait_for(asyncio.to_thread(invoke, agent, query), timeout)
    except asyncio.TimeoutError as exc:
        raise AgentTimeoutError(
            f"agent did not complete within {timeout:.0f}s"
        ) from exc
