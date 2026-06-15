"""Shared helpers for driving the ``/ws`` endpoint through Starlette's TestClient.

The server's wire protocol interleaves several server->client frame types:

    welcome | status | token | complete | error | ping | pong

These helpers collect ``token`` frames in order and stop at the first terminal
frame (``complete`` or ``error``), skipping non-terminal informational frames
(``status``, ``ping``, ``pong``) so individual tests can focus on the protocol
invariants rather than frame bookkeeping.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

# Frame types that terminate a single query's response stream.
_TERMINAL_TYPES = {"complete", "error"}
# Informational frames that may appear before/around tokens and are skipped.
_SKIP_TYPES = {"status", "ping", "pong"}


def recv_welcome(ws) -> Dict[str, Any]:
    """Receive and return the initial ``welcome`` frame sent on connect."""
    frame = ws.receive_json()
    assert frame.get("type") == "welcome", f"expected welcome, got {frame!r}"
    return frame


def drain_until_terminal(ws) -> Dict[str, Any]:
    """Receive frames until the first ``complete``/``error`` and return it.

    Skips ``status``/``ping``/``pong`` frames. Token frames are tolerated and
    ignored (use :func:`collect_tokens_until_terminal` when token contents
    matter).
    """
    while True:
        frame = ws.receive_json()
        ftype = frame.get("type")
        if ftype in _TERMINAL_TYPES:
            return frame
        if ftype == "token" or ftype in _SKIP_TYPES:
            continue
        # Any other frame type is unexpected for a query response.
        raise AssertionError(f"unexpected frame before terminal: {frame!r}")


def collect_tokens_until_terminal(ws) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Collect ``token`` frames (in order) until the terminal frame.

    Returns ``(token_frames, terminal_frame)`` where ``token_frames`` preserves
    arrival order and ``terminal_frame`` is the ``complete`` or ``error`` frame
    that ended the stream. ``status``/``ping``/``pong`` frames are skipped.
    """
    tokens: List[Dict[str, Any]] = []
    while True:
        frame = ws.receive_json()
        ftype = frame.get("type")
        if ftype == "token":
            tokens.append(frame)
            continue
        if ftype in _SKIP_TYPES:
            continue
        if ftype in _TERMINAL_TYPES:
            return tokens, frame
        raise AssertionError(f"unexpected frame during stream: {frame!r}")


def run_query(ws, query: str) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Send one query and collect its token frames + terminal frame."""
    ws.send_json({"query": query})
    return collect_tokens_until_terminal(ws)
