"""agent_runtime retry/timeout + retriever unit tests.

In v2 the agent no longer exposes a FastAPI app (the HTTP/WS surface moved to
the separate proxy container), so this module covers only the pure units that
remain in the agent container:

  * agent_runtime timeout/exhaustion surfacing (R10.6, R10.7): the model-level
    retry budget is enforced by the boto client config (asserted via the
    documented constants), while this layer surfaces a descriptive
    ``AgentTimeoutError`` when a stream exceeds its ceiling and wraps a throwing
    agent in ``AgentInvocationError`` — never a false success.
  * Retriever (R11.3, R11.6, R11.7, R11.8): ``_effective_top_k`` caps at 5; the
    cold-start path emits the status callback exactly once then returns hits;
    persistent cold-start raises ``RetrievalTimeout``; a non-cold-start search
    error raises ``RetrievalFailed``; the ``k``/``size`` sent to OpenSearch never
    exceeds 5.

Requirements: 10.6, 10.7, 11.3, 11.6, 11.7, 11.8.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Dict, List

import pytest

from agent_runtime import (
    AGENT_TIMEOUT_SECONDS,
    MAX_ATTEMPTS,
    AgentInvocationError,
    AgentTimeoutError,
    invoke,
    invoke_async,
    stream_tokens,
)
from config import Settings


# ===========================================================================
# agent_runtime: timeout + exhaustion surfacing (R10.6, R10.7)
# ===========================================================================


def test_retry_and_timeout_constants_match_policy():
    """The model retry budget (3 attempts) and 120s ceiling are configured (R10.6/R10.7)."""
    assert MAX_ATTEMPTS == 3
    assert AGENT_TIMEOUT_SECONDS == 120.0


class _SlowStreamAgent:
    """Agent whose stream never produces a token within the test timeout."""

    is_mock = True

    async def stream_async(self, query: str) -> AsyncIterator[str]:
        await asyncio.sleep(10)
        yield "never-reached"  # pragma: no cover


async def test_stream_tokens_raises_timeout_when_stream_exceeds_ceiling():
    """A stream exceeding its timeout surfaces AgentTimeoutError, not success (R10.7)."""
    agent = _SlowStreamAgent()
    with pytest.raises(AgentTimeoutError):
        async for _token in stream_tokens(agent, "q", timeout=0.05):
            pass


class _SlowBlockingAgent:
    """Agent whose synchronous call blocks past the invoke_async ceiling."""

    is_mock = True

    def __call__(self, query: str) -> str:
        import time

        time.sleep(0.3)
        return "late"


async def test_invoke_async_raises_timeout_when_blocking_call_exceeds_ceiling():
    """invoke_async enforces the timeout ceiling and surfaces AgentTimeoutError (R10.7)."""
    with pytest.raises(AgentTimeoutError):
        await invoke_async(_SlowBlockingAgent(), "q", timeout=0.05)


def test_invoke_wraps_throwing_agent_in_invocation_error():
    """A throwing agent (e.g. retry budget exhausted) -> AgentInvocationError (R10.6/R10.7)."""

    class _BoomAgent:
        def __call__(self, query: str) -> str:
            raise RuntimeError("bedrock throttling: retries exhausted")

    with pytest.raises(AgentInvocationError):
        invoke(_BoomAgent(), "q")


# ===========================================================================
# Retriever: top-k cap, cold-start, timeout, failure (R11.3, R11.6-R11.8)
# ===========================================================================


def _aoss_settings(rag_top_k: int = 5) -> Settings:
    """A non-mock Settings (OpenSearch endpoint configured) for the live path."""
    return Settings(
        opensearch_endpoint="https://example.us-east-1.aoss.amazonaws.com",
        rag_top_k=rag_top_k,
    )


@pytest.mark.parametrize(
    "configured,expected",
    [(3, 3), (5, 5), (100, 5), (0, 1)],
)
def test_effective_top_k_caps_at_five(configured, expected):
    """top-k is clamped to [1, 5] regardless of the configured value (R11.3)."""
    import retriever

    assert retriever._effective_top_k(_aoss_settings(configured)) == expected


class _ColdThenWarmClient:
    """Fake aoss client: raises a cold-start-looking error N times, then succeeds."""

    def __init__(self, cold_times: int, hits: List[Dict[str, Any]]) -> None:
        self._cold_times = cold_times
        self._hits = hits
        self.calls = 0
        self.bodies: List[Dict[str, Any]] = []

    def search(self, index: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self.calls += 1
        self.bodies.append(body)
        if self.calls <= self._cold_times:
            # ConnectionError's class name is classified as a cold-start signal.
            raise ConnectionError("connection refused: collection is scaling")
        return {"hits": {"hits": self._hits}}


class _AlwaysColdClient:
    """Fake aoss client that never warms up (always a cold-start signal)."""

    def __init__(self) -> None:
        self.calls = 0

    def search(self, index: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self.calls += 1
        raise ConnectionError("connection refused: collection is scaling")


def _shrink_cold_start_timing(monkeypatch, retriever, ceiling: float) -> None:
    """Shrink the cold-start backoff + ceiling so tests run fast."""
    monkeypatch.setattr(retriever, "COLD_START_BACKOFF_START_SECONDS", 0.01)
    monkeypatch.setattr(retriever, "COLD_START_BACKOFF_MAX_SECONDS", 0.02)
    monkeypatch.setattr(retriever, "COLD_START_CEILING_SECONDS", ceiling)


def test_retriever_cold_start_emits_status_once_then_succeeds(monkeypatch):
    """Cold-start: callback fires exactly once, then the search succeeds (R11.6)."""
    import retriever

    _shrink_cold_start_timing(monkeypatch, retriever, ceiling=5.0)
    monkeypatch.setattr(retriever, "_embed_query", lambda query, settings: [0.1, 0.2, 0.3])

    fake = _ColdThenWarmClient(
        cold_times=3,
        hits=[{"_source": {"title": "Doc Alpha", "text": "alpha context body"}}],
    )
    monkeypatch.setattr(retriever, "_build_opensearch_client", lambda settings: fake)

    cold_calls = {"n": 0}

    def _on_cold_start() -> None:
        cold_calls["n"] += 1

    result = retriever.retrieve(
        "find alpha", settings=_aoss_settings(5), on_cold_start=_on_cold_start
    )

    assert "Doc Alpha" in result
    assert "alpha context body" in result
    assert cold_calls["n"] == 1, "on_cold_start must be invoked exactly once"
    assert fake.calls == 4, "expected 3 cold attempts + 1 successful attempt"


def test_retriever_persistent_cold_start_raises_timeout(monkeypatch):
    """A collection that never warms up within the ceiling -> RetrievalTimeout (R11.7)."""
    import retriever

    _shrink_cold_start_timing(monkeypatch, retriever, ceiling=0.2)
    monkeypatch.setattr(retriever, "_embed_query", lambda query, settings: [0.1, 0.2])

    fake = _AlwaysColdClient()
    monkeypatch.setattr(retriever, "_build_opensearch_client", lambda settings: fake)

    cold_calls = {"n": 0}

    with pytest.raises(retriever.RetrievalTimeout):
        retriever.retrieve(
            "q",
            settings=_aoss_settings(5),
            on_cold_start=lambda: cold_calls.__setitem__("n", cold_calls["n"] + 1),
        )

    # The cold-start callback still fires exactly once before timing out (R11.6).
    assert cold_calls["n"] == 1
    assert fake.calls >= 1


def test_retriever_search_error_raises_retrieval_failed(monkeypatch):
    """A non-cold-start search exception -> RetrievalFailed (R11.8)."""
    import retriever

    monkeypatch.setattr(retriever, "_embed_query", lambda query, settings: [0.1, 0.2])

    class _BadQueryClient:
        def search(self, index: str, body: Dict[str, Any]) -> Dict[str, Any]:
            raise ValueError("malformed query DSL")

    monkeypatch.setattr(
        retriever, "_build_opensearch_client", lambda settings: _BadQueryClient()
    )

    with pytest.raises(retriever.RetrievalFailed):
        retriever.retrieve("q", settings=_aoss_settings(5))


def test_retriever_k_never_exceeds_five(monkeypatch):
    """The ``size`` and knn ``k`` sent to OpenSearch never exceed 5 (R11.3)."""
    import retriever

    monkeypatch.setattr(retriever, "_embed_query", lambda query, settings: [0.1, 0.2])

    captured: Dict[str, Any] = {}

    class _CaptureClient:
        def search(self, index: str, body: Dict[str, Any]) -> Dict[str, Any]:
            captured["body"] = body
            return {"hits": {"hits": []}}

    monkeypatch.setattr(
        retriever, "_build_opensearch_client", lambda settings: _CaptureClient()
    )

    # rag_top_k=100 is intentionally far above the cap to prove the clamp bites.
    retriever.retrieve("q", settings=_aoss_settings(100))

    body = captured["body"]
    assert body["size"] <= 5
    assert body["query"]["knn"]["embedding"]["k"] <= 5
