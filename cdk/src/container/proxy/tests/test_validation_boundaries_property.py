"""PROPERTY-BASED test: validation-boundary classification on the proxy.

PROPERTY 2 (Validation boundary classification)
-----------------------------------------------
For query lengths at and around the boundaries ``{0, 1, 10000, 10001}`` and for
whitespace-only inputs, both the proxy ``/invocations`` HTTP path and the
``/ws`` query path always classify accept/reject *consistently* and *correctly*
with respect to the IMPLEMENTED contract in ``app._validate_query``:

  * a value is ACCEPTED iff it is a ``str`` whose length is in
    ``[QUERY_MIN_CHARS, QUERY_MAX_CHARS]`` == ``[1, 10000]``;
  * length ``0`` (empty), length ``> 10000``, a missing field, and non-string
    values are REJECTED.

Per the implemented contract (confirmed by reading ``app._validate_query``,
which checks only type + length), a whitespace-only string of length in
``[1, 10000]`` is ACCEPTED at this layer. Acceptance therefore depends purely on
``len(query)`` for string inputs.

On the ``/invocations`` path accept -> HTTP 200 (with a non-empty ``response``
string in mock mode) and reject -> HTTP 400. On the ``/ws`` path accept ->
tokens + ``complete`` and reject -> a single ``error`` with
``code == "bad_request"``. The two paths must agree for every generated input.

**Validates: Requirements 7.8, 8.6**
"""

from __future__ import annotations

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from config import QUERY_MAX_CHARS, QUERY_MIN_CHARS

from .ws_helpers import collect_tokens_until_terminal, drain_until_terminal, recv_welcome


def _is_accepted(query) -> bool:
    """Expected classification mirroring ``app._validate_query`` exactly."""
    if not isinstance(query, str):
        return False
    return QUERY_MIN_CHARS <= len(query) <= QUERY_MAX_CHARS


# Lengths concentrated at and around the boundaries {0, 1, 10000, 10001} plus a
# spread of interior/exterior values so the property covers both classes.
_boundary_lengths = st.sampled_from(
    [0, 1, 2, 5, 100, 9999, QUERY_MAX_CHARS, QUERY_MAX_CHARS + 1, QUERY_MAX_CHARS + 50]
)
# Whitespace-only strings of various lengths (accepted at this layer when
# length is in [1, 10000], rejected at length 0).
_whitespace_only = st.integers(min_value=0, max_value=12).map(lambda n: " " * n)


def _assert_invocations(client, query) -> None:
    resp = client.post("/invocations", json={"query": query})
    if _is_accepted(query):
        assert resp.status_code == 200, (
            f"len={len(query)} should be ACCEPTED (200), got {resp.status_code}"
        )
        assert "response" in resp.json()
    else:
        assert resp.status_code == 400, (
            f"query should be REJECTED (400), got {resp.status_code}"
        )
        assert "error" in resp.json()


def _assert_ws(client, query) -> None:
    with client.websocket_connect("/ws") as ws:
        recv_welcome(ws)
        ws.send_json({"query": query})
        if _is_accepted(query):
            tokens, terminal = collect_tokens_until_terminal(ws)
            assert len(tokens) >= 1, "accepted query should stream >=1 token"
            assert terminal["type"] == "complete"
        else:
            terminal = drain_until_terminal(ws)
            assert terminal["type"] == "error"
            assert terminal["code"] == "bad_request"


@settings(
    max_examples=40,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(length=_boundary_lengths)
def test_length_boundary_classification_matches_on_both_paths(client, length):
    """Property 2 (length axis): 'a'*length classified identically on both paths."""
    query = "a" * length
    expected = _is_accepted(query)
    # Both paths agree with the expected classification (and thus each other).
    _assert_invocations(client, query)
    _assert_ws(client, query)
    # Sanity: the boundary maths is what we think it is.
    assert expected == (1 <= length <= QUERY_MAX_CHARS)


@settings(
    max_examples=20,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(query=_whitespace_only)
def test_whitespace_only_classification_matches_implemented_contract(client, query):
    """Property 2 (whitespace axis): whitespace-only accepted iff length in [1,10000].

    This asserts the ACTUAL implemented HTTP/WS contract: ``_validate_query``
    only checks type + length, so a non-empty whitespace-only string is
    accepted; a zero-length string is rejected.
    """
    _assert_invocations(client, query)
    _assert_ws(client, query)


@settings(
    max_examples=20,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(value=st.one_of(st.integers(), st.none(), st.booleans(), st.lists(st.text())))
def test_non_string_query_always_rejected_on_both_paths(client, value):
    """Property 2 (type axis): non-string ``query`` always rejected on both paths."""
    assert _is_accepted(value) is False
    _assert_invocations(client, value)
    _assert_ws(client, value)
