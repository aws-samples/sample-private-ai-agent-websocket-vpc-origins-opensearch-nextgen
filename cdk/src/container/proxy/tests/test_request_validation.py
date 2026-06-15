"""Request validation unit tests for the proxy ``/invocations`` and ``/ws``.

Verifies the proxy's input-validation contract end-to-end through the real
FastAPI app (offline mock mode, no AgentCore runtime):

  * ``POST /invocations`` returns 200 for a valid 1..10,000-char query and 400
    for missing / empty / oversize (10,001) / non-string / invalid-JSON
    queries, and does NOT invoke the AgentCore runtime on a rejected request.
    (R7.7, R7.8)
  * ``WS /ws`` accepts a valid query (>=1 ``token`` then ``complete``) and, for
    an unparseable / missing-query / empty / oversize message, replies with a
    single ``error`` whose ``code`` is ``bad_request`` while keeping the
    connection OPEN — a subsequent valid query still streams tokens + complete.
    (R8.6, R8.7)

In mock mode the proxy synthesizes a short multi-token streamed response, so a
valid POST returns 200 with a non-empty ``response`` string and a valid WS query
streams >=1 token then ``complete``.

Requirements: 7.7, 7.8, 8.6, 8.7.
"""

from __future__ import annotations

from config import QUERY_MAX_CHARS, QUERY_MIN_CHARS

from .ws_helpers import (
    drain_until_terminal,
    recv_welcome,
    run_query,
)


# ---------------------------------------------------------------------------
# POST /invocations
# ---------------------------------------------------------------------------


def test_invocations_accepts_min_length_query(client):
    """A 1-char query (lower boundary) returns 200 with a response body (R7.7)."""
    resp = client.post("/invocations", json={"query": "a" * QUERY_MIN_CHARS})
    assert resp.status_code == 200
    assert isinstance(resp.json().get("response"), str)
    assert resp.json()["response"] != ""


def test_invocations_accepts_max_length_query(client):
    """A 10,000-char query (upper boundary) returns 200 (R7.7)."""
    resp = client.post("/invocations", json={"query": "a" * QUERY_MAX_CHARS})
    assert resp.status_code == 200
    assert isinstance(resp.json().get("response"), str)


def test_invocations_accepts_typical_query(client):
    resp = client.post("/invocations", json={"query": "What is our compliance posture?"})
    assert resp.status_code == 200
    assert "response" in resp.json()


def test_invocations_rejects_empty_query(client):
    """Empty string (length 0) -> 400 with an error identifying the field (R7.8)."""
    resp = client.post("/invocations", json={"query": ""})
    assert resp.status_code == 400
    assert "error" in resp.json()
    assert "query" in resp.json()["error"].lower()


def test_invocations_rejects_missing_query(client):
    """Body without a ``query`` field -> 400 (R7.8)."""
    resp = client.post("/invocations", json={"notquery": "hello"})
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_invocations_rejects_oversize_query(client):
    """10,001-char query (one past the ceiling) -> 400 (R7.8)."""
    resp = client.post("/invocations", json={"query": "a" * (QUERY_MAX_CHARS + 1)})
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_invocations_rejects_non_string_query(client):
    """Non-string ``query`` (int) -> 400 (R7.8)."""
    resp = client.post("/invocations", json={"query": 12345})
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_invocations_rejects_null_query(client):
    resp = client.post("/invocations", json={"query": None})
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_invocations_rejects_list_query(client):
    resp = client.post("/invocations", json={"query": ["a", "b"]})
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_invocations_rejects_invalid_json(client):
    """A body that is not valid JSON -> 400, runtime not invoked."""
    resp = client.post(
        "/invocations",
        content=b"this is not json",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 400
    assert "error" in resp.json()


def test_invocations_does_not_invoke_runtime_on_rejection(client, app_module, monkeypatch):
    """A rejected (invalid) request must NOT reach the AgentCore runtime (R7.8).

    The proxy's ``/invocations`` handler calls ``invoke_async`` (the symbol
    imported into the proxy ``app`` module from ``agentcore_client``). We replace
    it with a recorder that counts calls and raises if reached on a rejection
    path; a 400 must never touch it. A subsequent valid request proves the
    recorder works.
    """
    calls = {"count": 0}

    async def _tracking_invoke_async(prompt, session_id, **kwargs):
        calls["count"] += 1
        return "recorded-response"

    monkeypatch.setattr(app_module, "invoke_async", _tracking_invoke_async)

    # Invalid requests across every rejection branch.
    assert client.post("/invocations", json={"query": ""}).status_code == 400
    assert client.post("/invocations", json={"notquery": 1}).status_code == 400
    assert (
        client.post(
            "/invocations", json={"query": "a" * (QUERY_MAX_CHARS + 1)}
        ).status_code
        == 400
    )
    assert client.post("/invocations", json={"query": 5}).status_code == 400

    assert calls["count"] == 0, "runtime was invoked on an invalid /invocations request"

    # A valid request DOES reach the (recording) runtime, proving the guard works.
    resp = client.post("/invocations", json={"query": "hi"})
    assert resp.status_code == 200
    assert resp.json()["response"] == "recorded-response"
    assert calls["count"] == 1


def test_invocations_boundary_matrix(client):
    """Boundary lengths: {1, 10000} -> 200 ; {0, 10001} -> 400."""
    accept = {QUERY_MIN_CHARS, QUERY_MAX_CHARS}  # 1, 10000
    reject = {0, QUERY_MAX_CHARS + 1}  # 0, 10001
    for n in accept:
        resp = client.post("/invocations", json={"query": "a" * n})
        assert resp.status_code == 200, f"length {n} should be accepted"
    for n in reject:
        resp = client.post("/invocations", json={"query": "a" * n})
        assert resp.status_code == 400, f"length {n} should be rejected"


# ---------------------------------------------------------------------------
# WS /ws
# ---------------------------------------------------------------------------


def test_ws_accepts_valid_query_streams_tokens_then_complete(client):
    """A valid query yields >=1 ``token`` then exactly one ``complete`` (R8.2, R8.3)."""
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        tokens, terminal = run_query(ws, "hi")
        assert len(tokens) >= 1
        assert terminal["type"] == "complete"


def test_ws_rejects_unparseable_message_and_stays_open(client):
    """Unparseable frame -> bad_request error, then a valid query still works (R8.6, R8.7)."""
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        ws.send_text("this is not json {")
        terminal = drain_until_terminal(ws)
        assert terminal["type"] == "error"
        assert terminal["code"] == "bad_request"

        # Connection must remain OPEN: a valid query still streams + completes.
        tokens, terminal2 = run_query(ws, "hello")
        assert len(tokens) >= 1
        assert terminal2["type"] == "complete"


def test_ws_rejects_missing_query_field_and_stays_open(client):
    """Message missing the ``query`` field -> bad_request, connection stays open."""
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        ws.send_json({"notquery": "value"})
        terminal = drain_until_terminal(ws)
        assert terminal["type"] == "error"
        assert terminal["code"] == "bad_request"

        tokens, terminal2 = run_query(ws, "follow-up question")
        assert len(tokens) >= 1
        assert terminal2["type"] == "complete"


def test_ws_rejects_empty_query_and_stays_open(client):
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        ws.send_json({"query": ""})
        terminal = drain_until_terminal(ws)
        assert terminal["type"] == "error"
        assert terminal["code"] == "bad_request"

        tokens, terminal2 = run_query(ws, "valid now")
        assert len(tokens) >= 1
        assert terminal2["type"] == "complete"


def test_ws_rejects_oversize_query_and_stays_open(client):
    """Oversize (10,001-char) query -> bad_request, connection stays open (R8.6)."""
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        ws.send_json({"query": "a" * (QUERY_MAX_CHARS + 1)})
        terminal = drain_until_terminal(ws)
        assert terminal["type"] == "error"
        assert terminal["code"] == "bad_request"

        tokens, terminal2 = run_query(ws, "a" * QUERY_MAX_CHARS)
        assert len(tokens) >= 1
        assert terminal2["type"] == "complete"


def test_ws_accepts_min_and_max_length_queries(client):
    """Boundary queries {1, 10000} chars both stream tokens + complete (R8.1-8.3)."""
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        for n in (QUERY_MIN_CHARS, QUERY_MAX_CHARS):
            tokens, terminal = run_query(ws, "a" * n)
            assert len(tokens) >= 1, f"length {n} should stream tokens"
            assert terminal["type"] == "complete"
