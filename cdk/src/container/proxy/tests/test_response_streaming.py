"""Tests for ``agentcore_client._iter_response_text`` incremental SSE decoding.

These guard the fix for batchy streaming: AgentCore Runtime returns ``response``
as a botocore ``StreamingBody`` over a chunked SSE socket. botocore's
``iter_lines`` reads in fixed 1024-byte blocks, which batches small token
events. The proxy must instead iterate the underlying wire incrementally and
decode SSE ``data:`` lines as they arrive — including events split across HTTP
chunk boundaries.

Wire format note: ``BedrockAgentCoreApp._convert_to_sse`` frames each yielded
value as ``data: <json.dumps(value)>\\n\\n`` (the payload is JSON-encoded, so
leading/trailing spaces in a text delta survive, and events are separated by a
blank line). The helpers below reproduce that exact framing.
"""

from __future__ import annotations

import json
from typing import Iterator, List

import agentcore_client as ac


def _sse(text: str) -> bytes:
    """Frame a text delta exactly like the AgentCore SDK does on the wire."""
    return ("data: " + json.dumps(text, ensure_ascii=False) + "\n\n").encode("utf-8")


class _FakeRawStream:
    """Stand-in for a urllib3 response exposing ``.stream()`` over byte chunks.

    Each element of ``chunks`` simulates one HTTP chunk flushed by the runtime;
    yielding them one at a time models incremental, non-batched delivery.
    """

    def __init__(self, chunks: List[bytes]) -> None:
        self._chunks = chunks

    def stream(self, amt: int = 65536, decode_content: bool = True) -> Iterator[bytes]:
        for c in self._chunks:
            yield c


class _FakeStreamingBody:
    """Mimic botocore StreamingBody: exposes ``_raw_stream`` + ``read``."""

    def __init__(self, chunks: List[bytes]) -> None:
        self._raw_stream = _FakeRawStream(chunks)
        self._joined = b"".join(chunks)
        self._pos = 0

    def read(self, amt: int | None = None) -> bytes:
        if amt is None:
            data, self._pos = self._joined[self._pos :], len(self._joined)
            return data
        data = self._joined[self._pos : self._pos + amt]
        self._pos += len(data)
        return data


def _collect(chunks: List[bytes]) -> List[str]:
    body = _FakeStreamingBody(chunks)
    return list(ac._iter_response_text({"response": body}))


def test_sse_tokens_decoded_in_order_preserving_spaces():
    # Real wire framing: each delta is its own JSON-encoded data event, so the
    # leading space in " world" must be preserved.
    chunks = [_sse("Hello"), _sse(" world"), _sse("!")]
    assert _collect(chunks) == ["Hello", " world", "!"]


def test_event_split_across_chunk_boundary_is_reassembled():
    # One SSE event arrives in three separate HTTP chunks; it must be emitted
    # exactly once, fully reassembled (this is the core anti-batching guard).
    full = _sse("partial token")
    third = len(full) // 3
    chunks = [full[:third], full[third : 2 * third], full[2 * third :]]
    assert _collect(chunks) == ["partial token"]


def test_done_sentinel_and_blank_lines_skipped():
    chunks = [
        _sse("a"),
        b"\n",
        b": keep-alive comment\n",
        b"data: [DONE]\n\n",
        _sse("b"),
    ]
    assert _collect(chunks) == ["a", "b"]


def test_json_event_object_data_field_extracted():
    # Some events carry a structured object whose text lives under "data".
    chunks = [("data: " + json.dumps({"data": "chunked text"}) + "\n\n").encode()]
    assert _collect(chunks) == ["chunked text"]


def test_trailing_event_without_final_newline_is_emitted():
    # Stream closes mid-event (no terminating newline); it must still flush.
    chunks = [_sse("first"), b'data: "last"']
    assert _collect(chunks) == ["first", "last"]


def test_non_sse_plain_text_salvaged():
    # Body is not SSE at all — salvage the whole payload rather than dropping it.
    chunks = [b"just plain text, no data prefix"]
    assert _collect(chunks) == ["just plain text, no data prefix"]


def test_non_sse_json_object_salvaged():
    chunks = [b'{"data": "whole-object reply"}']
    assert _collect(chunks) == ["whole-object reply"]


def test_fallback_to_iter_chunks_when_no_raw_stream():
    """A body without ``_raw_stream`` still streams via iter_chunks."""

    class _NoRawBody:
        def __init__(self, data: bytes) -> None:
            self._data = data
            self._pos = 0

        def iter_chunks(self, chunk_size: int = 1024) -> Iterator[bytes]:
            for i in range(0, len(self._data), chunk_size):
                yield self._data[i : i + chunk_size]

        def read(self, amt: int | None = None) -> bytes:  # pragma: no cover
            return self._data

    body = _NoRawBody(_sse("x") + _sse("y"))
    assert list(ac._iter_response_text({"response": body})) == ["x", "y"]
