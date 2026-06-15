"""Amazon Cognito auth for the proxy (v2) — self-hosted login, fully private.

The proxy is the sole origin behind Amazon CloudFront and runs in **no-egress isolated
subnets**. The Cognito *Hosted UI* OAuth flow cannot work here: its OAuth domain
(`<prefix>.auth.<region>.amazoncognito.com`) has **no PrivateLink endpoint**, so
the authorize redirect and the `/oauth2/token` code exchange would time out.

Instead the proxy hosts its **own** username/password login form and
authenticates directly against the Cognito Identity Provider API
(`InitiateAuth` with `USER_PASSWORD_AUTH`) over the
`com.amazonaws.<region>.cognito-idp` interface VPC endpoint. The pool JWKS lives
on the same host (`cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/...`),
so that single endpoint serves both token issuance and signature verification —
no internet, no NAT.

Flow:
  1. Browser hits ``GET /`` with no session cookie -> proxy redirects to
     ``GET /auth/login`` (its own form).
  2. User submits username + password -> ``POST /auth/login`` calls
     :func:`initiate_auth`, validates the returned ID token, and sets a signed,
     HttpOnly session cookie holding it.
  3. The SPA opens the WebSocket; the cookie rides the upgrade and
     :func:`verify_token` validates it before any query is processed.

When Cognito is not configured (``settings.auth_enabled`` is False) every helper
degrades to "open" so local dev / CI and the existing tests keep working.

JWT validation uses ``python-jose`` against the cached pool JWKS; only RS256
tokens issued by this pool + audience are accepted, and expiry is enforced.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.request
from typing import Any, Dict, Optional

from config import Settings, get_settings

logger = logging.getLogger("proxy.auth")

# Cache the pool JWKS (rotates rarely) to avoid fetching on every verify.
_JWKS_CACHE: Dict[str, Any] = {}
_JWKS_FETCHED_AT: float = 0.0
_JWKS_TTL_SECONDS = 3600.0


class AuthError(Exception):
    """Raised when a token is missing, malformed, or fails validation."""


class LoginError(Exception):
    """Raised when username/password authentication fails (bad credentials)."""


# ---------------------------------------------------------------------------
# Username/password authentication (InitiateAuth over the PrivateLink endpoint).
# ---------------------------------------------------------------------------


def initiate_auth(settings: Settings, username: str, password: str) -> Dict[str, Any]:
    """Authenticate a user via Cognito ``USER_PASSWORD_AUTH`` and return tokens.

    Returns the ``AuthenticationResult`` dict (``IdToken``, ``AccessToken``,
    ``ExpiresIn``, ...). Raises :class:`LoginError` on bad credentials and
    :class:`AuthError` on any other failure (e.g. an unexpected challenge).

    This is a **blocking** boto call; async callers should run it on a worker
    thread (``asyncio.to_thread``) so the event loop is never blocked.
    """
    import boto3  # local import keeps the module importable offline
    from botocore.config import Config
    from botocore.exceptions import ClientError

    client = boto3.client(
        "cognito-idp",
        region_name=settings.aws_region,
        config=Config(connect_timeout=10, read_timeout=15, retries={"max_attempts": 2}),
    )
    try:
        resp = client.initiate_auth(
            ClientId=settings.cognito_client_id,
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": username, "PASSWORD": password},
        )
    except ClientError as exc:  # noqa: BLE001
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("NotAuthorizedException", "UserNotFoundException"):
            raise LoginError("incorrect username or password") from exc
        if code == "UserNotConfirmedException":
            raise LoginError("user is not confirmed") from exc
        logger.exception("initiate_auth failed: %s", code)
        raise AuthError(f"authentication failed: {code or exc}") from exc

    result = resp.get("AuthenticationResult")
    if not result or "IdToken" not in result:
        # A challenge (e.g. NEW_PASSWORD_REQUIRED) means the demo user is not in
        # a directly-usable state; surface it as a login failure for the form.
        challenge = resp.get("ChallengeName", "unknown")
        raise LoginError(f"additional authentication step required ({challenge})")
    return result


# ---------------------------------------------------------------------------
# JWKS + token verification.
# ---------------------------------------------------------------------------


def _issuer(settings: Settings) -> str:
    return f"https://cognito-idp.{settings.aws_region}.amazonaws.com/{settings.cognito_user_pool_id}"


def _fetch_jwks(settings: Settings) -> Dict[str, Any]:
    global _JWKS_CACHE, _JWKS_FETCHED_AT
    now = time.monotonic()
    if _JWKS_CACHE and (now - _JWKS_FETCHED_AT) < _JWKS_TTL_SECONDS:
        return _JWKS_CACHE
    url = f"{_issuer(settings)}/.well-known/jwks.json"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:  # noqa: S310 - fixed Cognito URL
            _JWKS_CACHE = json.loads(resp.read().decode("utf-8"))
            _JWKS_FETCHED_AT = now
    except Exception as exc:  # noqa: BLE001
        raise AuthError(f"could not fetch Cognito JWKS: {exc}") from exc
    return _JWKS_CACHE


def verify_token(token: str, settings: Optional[Settings] = None) -> Dict[str, Any]:
    """Validate a Cognito ID/access token; return its claims.

    Raises :class:`AuthError` on any problem. When auth is disabled this should
    not be called (callers gate on ``settings.auth_enabled``).
    """
    settings = settings or get_settings()
    if not token:
        raise AuthError("missing token")

    # jose is only needed when auth is enabled; import lazily so the module (and
    # the test suite) load without the dependency in mock mode.
    try:
        from jose import jwt  # type: ignore import-not-found
        from jose.utils import base64url_decode  # noqa: F401  (ensures jose present)
    except Exception as exc:  # noqa: BLE001
        raise AuthError("python-jose is required for token verification") from exc

    jwks = _fetch_jwks(settings)
    try:
        headers = jwt.get_unverified_header(token)
    except Exception as exc:  # noqa: BLE001
        raise AuthError("malformed token header") from exc

    kid = headers.get("kid")
    key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
    if key is None:
        # Key rotation: refresh once and retry.
        _JWKS_CACHE.clear()
        jwks = _fetch_jwks(settings)
        key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
    if key is None:
        raise AuthError("no matching JWKS key for token")

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=settings.cognito_client_id,
            issuer=_issuer(settings),
            options={"verify_at_hash": False},
        )
    except Exception as exc:  # noqa: BLE001
        # Access tokens have no 'aud' claim; retry without audience for those.
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=_issuer(settings),
                options={"verify_aud": False, "verify_at_hash": False},
            )
            if claims.get("client_id") != settings.cognito_client_id:
                raise AuthError("token client_id mismatch")
        except AuthError:
            raise
        except Exception as exc2:  # noqa: BLE001
            raise AuthError(f"token validation failed: {exc2}") from exc

    return claims
