"""Security tests: authentication enforcement on invocation and WebSocket endpoints.

Validates:
  * POST /invocations returns 401 when auth is enabled and no valid session cookie
    is provided.
  * POST /api/invocations returns 401 when auth is enabled.
  * WS /ws closes with 4001 when auth is enabled and no valid cookie.
  * Authenticated requests still succeed (positive tests).
"""

from __future__ import annotations

import importlib
import os
import sys
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from fastapi.websockets import WebSocketDisconnect


@pytest.fixture
def auth_enabled_client():
    """TestClient with auth enabled via mocked Cognito settings."""
    _tests_dir = os.path.dirname(os.path.abspath(__file__))
    _proxy_dir = os.path.dirname(_tests_dir)
    if _proxy_dir not in sys.path:
        sys.path.insert(0, _proxy_dir)

    # Patch env to enable auth
    env_patch = {
        "COGNITO_USER_POOL_ID": "us-east-1_TestPool",
        "COGNITO_CLIENT_ID": "test-client-id-123",
    }
    with patch.dict(os.environ, env_patch):
        # Clear cached settings so new env vars take effect
        import config as config_mod
        config_mod.get_settings.cache_clear()

        import app as app_mod
        app_mod = importlib.reload(app_mod)

        with TestClient(app_mod.app) as tc:
            yield tc

        config_mod.get_settings.cache_clear()


@pytest.fixture
def authed_client():
    """TestClient with auth enabled AND a valid session cookie (mocked verify)."""
    _tests_dir = os.path.dirname(os.path.abspath(__file__))
    _proxy_dir = os.path.dirname(_tests_dir)
    if _proxy_dir not in sys.path:
        sys.path.insert(0, _proxy_dir)

    env_patch = {
        "COGNITO_USER_POOL_ID": "us-east-1_TestPool",
        "COGNITO_CLIENT_ID": "test-client-id-123",
    }
    with patch.dict(os.environ, env_patch):
        import config as config_mod
        config_mod.get_settings.cache_clear()

        import app as app_mod
        import auth as auth_mod
        app_mod = importlib.reload(app_mod)

        # Mock verify_token to accept our test cookie
        with patch.object(auth_mod, "verify_token", return_value=None):
            with TestClient(app_mod.app, cookies={"prra_session": "valid-test-token"}) as tc:
                yield tc

        config_mod.get_settings.cache_clear()


# ---------------------------------------------------------------------------
# POST /invocations rejects unauthenticated requests
# ---------------------------------------------------------------------------


def test_invocations_rejects_unauthenticated(auth_enabled_client):
    """POST /invocations returns 401 without a valid session cookie."""
    resp = auth_enabled_client.post("/invocations", json={"query": "test query"})
    assert resp.status_code == 401
    assert "authentication required" in resp.json()["error"]


def test_api_invocations_rejects_unauthenticated(auth_enabled_client):
    """POST /api/invocations returns 401 without a valid session cookie."""
    resp = auth_enabled_client.post("/api/invocations", json={"query": "test query"})
    assert resp.status_code == 401
    assert "authentication required" in resp.json()["error"]


def test_invocations_accepts_authenticated(authed_client):
    """POST /invocations returns 200 with a valid session cookie."""
    resp = authed_client.post("/invocations", json={"query": "test query"})
    assert resp.status_code == 200
    assert "response" in resp.json()


# ---------------------------------------------------------------------------
# WebSocket rejects unauthenticated connections
# ---------------------------------------------------------------------------


def test_websocket_rejects_unauthenticated(auth_enabled_client):
    """WS /ws closes connection with 4001 when no valid cookie is provided."""
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with auth_enabled_client.websocket_connect("/ws") as ws:
            ws.receive_json()  # Should not get here
    assert exc_info.value.code == 4001


def test_websocket_accepts_authenticated(authed_client):
    """WS /ws sends welcome frame when valid cookie is present."""
    with authed_client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "welcome"
        assert "connectionId" in msg


# ---------------------------------------------------------------------------
# GET /api/config is gated on auth when auth is enabled
# ---------------------------------------------------------------------------


def test_api_config_rejects_unauthenticated_when_auth_enabled(auth_enabled_client):
    """GET /api/config returns 401 without a valid session when auth is on."""
    resp = auth_enabled_client.get("/api/config")
    assert resp.status_code == 401
    assert "authentication required" in resp.json()["error"]


def test_api_config_allows_authenticated(authed_client):
    """GET /api/config returns the feature flags for an authenticated session."""
    resp = authed_client.get("/api/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["authEnabled"] is True
    assert "uploadsEnabled" in body


# ---------------------------------------------------------------------------
# fail-closed when a runtime is configured but auth is not (CWE-1188)
# ---------------------------------------------------------------------------


def test_app_refuses_to_start_when_auth_misconfigured():
    """Importing the app with a runtime configured but Cognito unset must raise,
    rather than silently serving the app without authentication."""
    _tests_dir = os.path.dirname(os.path.abspath(__file__))
    _proxy_dir = os.path.dirname(_tests_dir)
    if _proxy_dir not in sys.path:
        sys.path.insert(0, _proxy_dir)

    env_patch = {
        "AGENT_RUNTIME_ARN": "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/test-abc",
        "COGNITO_USER_POOL_ID": "",
        "COGNITO_CLIENT_ID": "",
    }
    # Ensure no stray opt-out is set in the test environment.
    with patch.dict(os.environ, env_patch):
        os.environ.pop("ALLOW_UNAUTHENTICATED", None)
        import config as config_mod
        config_mod.get_settings.cache_clear()
        import app as app_mod
        with pytest.raises(RuntimeError, match="authentication is disabled"):
            importlib.reload(app_mod)
        config_mod.get_settings.cache_clear()


def test_app_starts_unauthenticated_with_explicit_optin():
    """With ALLOW_UNAUTHENTICATED=true the app starts (intentional open mode)."""
    _tests_dir = os.path.dirname(os.path.abspath(__file__))
    _proxy_dir = os.path.dirname(_tests_dir)
    if _proxy_dir not in sys.path:
        sys.path.insert(0, _proxy_dir)

    env_patch = {
        "AGENT_RUNTIME_ARN": "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/test-abc",
        "COGNITO_USER_POOL_ID": "",
        "COGNITO_CLIENT_ID": "",
        "ALLOW_UNAUTHENTICATED": "true",
    }
    with patch.dict(os.environ, env_patch):
        import config as config_mod
        config_mod.get_settings.cache_clear()
        import app as app_mod
        # Should NOT raise.
        importlib.reload(app_mod)
        config_mod.get_settings.cache_clear()
