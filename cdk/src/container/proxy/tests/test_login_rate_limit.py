"""Security tests: login rate limiting.

Validates:
  * POST /auth/login returns 429 after exceeding the rate limit.
  * Requests within the limit succeed normally (200/401 depending on creds).
"""

from __future__ import annotations

import importlib
import os
import sys
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def auth_client_with_rate_limit():
    """TestClient with auth enabled for rate limit testing."""
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
        app_mod = importlib.reload(app_mod)
        # Clear any stale rate limit state from prior tests
        app_mod._login_attempts.clear()

        with TestClient(app_mod.app) as tc:
            yield tc, app_mod

        config_mod.get_settings.cache_clear()


def test_login_rate_limit_blocks_after_max_attempts(auth_client_with_rate_limit):
    """POST /auth/login returns 429 after 5 failed attempts from same IP."""
    client, app_mod = auth_client_with_rate_limit

    # Make 5 requests (the max allowed)
    for _ in range(5):
        resp = client.post(
            "/auth/login",
            data={"username": "attacker", "password": "wrong"},
        )
        # These should be 401 (bad creds) or similar, not 429 yet
        assert resp.status_code != 429

    # The 6th request should be rate-limited
    resp = client.post(
        "/auth/login",
        data={"username": "attacker", "password": "wrong"},
    )
    assert resp.status_code == 429
    assert "Too many login attempts" in resp.text


def test_login_rate_limit_allows_within_threshold(auth_client_with_rate_limit):
    """POST /auth/login allows requests within the rate limit window."""
    client, _ = auth_client_with_rate_limit

    # First request should not be rate limited
    resp = client.post(
        "/auth/login",
        data={"username": "user", "password": "pass"},
    )
    assert resp.status_code != 429
