"""Shared pytest fixtures for the proxy container test-suite.

The proxy application modules are imported as top-level names (``import app``,
``from agentcore_client import ...``). When pytest collects this ``tests/``
package it inserts the ``tests/`` directory on ``sys.path`` (not the proxy
directory), so this conftest defensively prepends the proxy directory so those
imports resolve regardless of the working directory pytest was launched from.

Run the suite from the proxy directory:

    cd cdk/src/container/proxy && python -m pytest tests -q

With ``AGENT_RUNTIME_ARN`` unset, the proxy runs in offline *mock mode*:
``agentcore_client.stream_tokens`` yields a synthesized multi-token response so
the WebSocket protocol and demo frontend are exercisable without a live
AgentCore runtime.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest

# --- Make the proxy modules importable as top-level names --------------------
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROXY_DIR = os.path.dirname(_TESTS_DIR)
if _PROXY_DIR not in sys.path:
    sys.path.insert(0, _PROXY_DIR)


@pytest.fixture
def app_module():
    """Import (and reload) the proxy ``app`` module so its state starts fresh.

    Reloading re-evaluates the module-level imports (e.g. the ``stream_tokens``
    / ``invoke_async`` symbols bound into the app module from
    ``agentcore_client``), so tests can monkeypatch ``app.stream_tokens`` /
    ``app.invoke_async`` in isolation from one another.
    """
    import app as _app

    return importlib.reload(_app)


@pytest.fixture
def client(app_module):
    """A FastAPI ``TestClient`` for the proxy app.

    The proxy is stateless (no lifespan readiness gating), but the context
    manager is still used for correctness so any startup/shutdown hooks run.
    """
    from fastapi.testclient import TestClient

    with TestClient(app_module.app) as test_client:
        yield test_client
