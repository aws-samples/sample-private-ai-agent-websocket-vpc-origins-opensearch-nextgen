"""PROPERTY-BASED test: the proxy ``/ws`` streaming-protocol invariant.

PROPERTY 1 (Streaming protocol invariant)
-----------------------------------------
For an *arbitrary* mocked token sequence, the proxy ``/ws`` handler:

  * emits one ``token`` message per chunk yielded by ``stream_tokens``, in
    generation order (token contents and order are preserved), each carrying a
    strictly increasing, contiguous ``seq`` starting at 0 (R8.2);
  * terminates the stream with EXACTLY ONE ``complete`` message after the final
    token (a single ``error`` terminator may legitimately replace it), whose
    ``tokenCount`` equals the number of emitted tokens (R8.3);
  * keeps the connection OPEN afterward, so a subsequent valid query also
    yields tokens followed by ``complete`` (R8.7).

The property is driven by Hypothesis-generated token lists. We monkeypatch the
``stream_tokens`` symbol bound into the proxy ``app`` module with an async
generator that yields exactly those tokens; the unmodified ``app._run_query``
then forwards EVERY chunk it receives as a ``token`` frame (it does NOT filter
empty strings — confirmed by reading ``app._run_query``). The expected emitted
sequence is therefore the full generated list.

**Validates: Requirements 8.2, 8.3, 8.7**
"""

from __future__ import annotations

from typing import List

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from .ws_helpers import collect_tokens_until_terminal, recv_welcome, run_query

# Short text tokens (incl. occasional empty strings) keep examples small/fast
# while still exercising arbitrary content/ordering.
_token_text = st.text(
    alphabet=st.characters(min_codepoint=32, max_codepoint=126),
    min_size=0,
    max_size=8,
)
_token_lists = st.lists(_token_text, min_size=0, max_size=20)


def _make_fake_stream_tokens(tokens: List[str]):
    """Build an async-generator stand-in for ``stream_tokens`` over ``tokens``."""

    async def fake_stream_tokens(prompt, session_id, **kwargs):
        for t in tokens:
            yield t

    return fake_stream_tokens


# A deterministic fake used only to prove the socket is still open after the
# first stream completes (the "stays open afterward" half of the invariant).
_FOLLOWUP_TOKENS = ["follow", "-", "up"]


@settings(
    max_examples=60,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(generated=_token_lists)
def test_streaming_protocol_invariant(client, app_module, monkeypatch, generated):
    """Property 1: token ordering + contiguous seq + single terminal + stays open."""
    # app._run_query forwards every chunk it receives (no empty filtering), so
    # the expected emitted sequence is exactly the generated list.
    expected_tokens = list(generated)

    # Inject the Hypothesis-generated stream for this example.
    monkeypatch.setattr(app_module, "stream_tokens", _make_fake_stream_tokens(generated))

    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)

        ws.send_json({"query": "drive the generated stream"})
        token_frames, terminal = collect_tokens_until_terminal(ws)

        # --- token contents + order match generation order (R8.2) -----------
        assert [f["content"] for f in token_frames] == expected_tokens

        # --- seq is 0,1,2,...,n-1: strictly increasing and contiguous (R8.2) -
        seqs = [f["seq"] for f in token_frames]
        assert seqs == list(range(len(expected_tokens)))

        # --- terminated by exactly one complete (or a single error) (R8.3) ---
        assert terminal["type"] in {"complete", "error"}
        # In this fault-free fake, the terminator is always `complete`.
        assert terminal["type"] == "complete"
        assert terminal.get("tokenCount") == len(expected_tokens)

        # --- the socket stays OPEN: a subsequent valid query streams again ---
        # If a duplicate/leftover terminal had been buffered, this follow-up
        # would return zero tokens with a stale terminal — so >=1 token here
        # also proves exactly one terminator was sent for the first query.
        monkeypatch.setattr(
            app_module, "stream_tokens", _make_fake_stream_tokens(_FOLLOWUP_TOKENS)
        )
        followup_tokens, followup_terminal = run_query(ws, "second query")
        assert [f["content"] for f in followup_tokens] == _FOLLOWUP_TOKENS
        assert [f["seq"] for f in followup_tokens] == [0, 1, 2]
        assert followup_terminal["type"] == "complete"
