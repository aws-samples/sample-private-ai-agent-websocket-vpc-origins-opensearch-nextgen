"""WebSocket <-> SSE proxy — FastAPI application (v2).

This is the ECS Fargate container that fronts the Bedrock AgentCore Runtime. It
preserves the EXACT browser-facing contract of v1 (same demo SPA, same WebSocket
wire protocol) but, instead of running the Strands agent in-process, it bridges
each query to ``bedrock-agentcore:InvokeAgentRuntime`` over the
``bedrock-agentcore`` PrivateLink endpoint and re-emits the runtime's SSE token
stream as WebSocket frames.

Endpoints:
  * ``GET  /health``               — ALB readiness probe (always 200 once up).
  * ``GET  /``                     — demo SPA (default CloudFront behavior).
  * ``POST /invocations`` + ``/api/invocations`` — synchronous complete response.
  * ``WS   /ws`` + ``/ws/``        — token streaming + keep-alive.

Server->client WS frames: ``welcome | status | token | complete | error | ping | pong``
(identical to v1, so the existing SPA works unchanged). One AgentCore
``runtimeSessionId`` is created per browser WebSocket connection for multi-turn.

Requirements: 3.8, 7.2, 8.x, 9.x, 12.x.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

import auth as auth_mod
import documents as docs_mod
from agentcore_client import AgentCoreError, invoke_async, stream_tokens
from config import QUERY_MAX_CHARS, QUERY_MIN_CHARS, get_settings

logger = logging.getLogger("proxy")

# Ensure the "proxy" logger emits under uvicorn. uvicorn configures its own
# loggers but not arbitrary app loggers, so without this our INFO/ERROR records
# can be silently dropped (which previously masked where requests stalled). Make
# the logger propagate to a configured handler at import time.
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)
logger.setLevel(logging.INFO)

# --- Fail-closed auth guard (CWE-1188) -------------------------------------
# If this is a deployed environment (a real AgentCore runtime is configured) but
# Cognito auth is NOT enabled — e.g. the COGNITO_* env vars were accidentally
# omitted — refuse to start rather than silently serving the app open to the
# internet. An operator who genuinely wants an unauthenticated deployment must
# set ALLOW_UNAUTHENTICATED=true on purpose. Local dev / CI (no runtime) is
# unaffected and stays auth-disabled for testability.
_startup_settings = get_settings()
if _startup_settings.auth_misconfigured:
    raise RuntimeError(
        "Refusing to start: a runtime is configured but authentication is "
        "disabled (Cognito env vars unset). This would expose the app without "
        "login. Set COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID, or explicitly set "
        "ALLOW_UNAUTHENTICATED=true to run without auth on purpose."
    )
if not _startup_settings.auth_enabled:
    logger.warning(
        "AUTH IS DISABLED — Cognito is not configured. All endpoints are open. "
        "This is expected ONLY in local development / CI."
    )

INVOCATION_TIMEOUT_SECONDS: float = 60.0
WS_KEEPALIVE_INTERVAL_SECONDS: float = 25.0

# Session cookie name holding the validated Cognito ID token.
SESSION_COOKIE = "prra_session"
# CSRF token cookie name (double-submit pattern for the login form).
CSRF_COOKIE = "prra_csrf"

_ERR_INVALID_QUERY = (
    f"query must be a non-empty string of {QUERY_MIN_CHARS}..{QUERY_MAX_CHARS} characters"
)
_ERR_INVALID_JSON = "request body must be valid JSON containing a 'query' field"
_ERR_GENERATION_FAILED = "the agent response could not be generated"
_ERR_TIMED_OUT = "the request timed out"

_WS_ERR_BAD_REQUEST = "bad_request"
_WS_ERR_INFERENCE_FAILED = "inference_failed"
_WS_ERR_TIMEOUT = "timeout"
_WS_MSG_BAD_REQUEST = (
    f"message must be JSON with a 'query' string of "
    f"{QUERY_MIN_CHARS}..{QUERY_MAX_CHARS} characters"
)
_WS_MSG_INFERENCE_FAILED = "the agent response could not be generated"
_WS_MSG_TIMEOUT = "the agent response timed out"

_SPA_PLACEHOLDER_HTML = (
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<title>Private Real-Time AI Agent (v2)</title></head>"
    "<body><main><h1>Private Real-Time AI Agent (v2)</h1>"
    "<p>The demo frontend has not been deployed yet.</p></main></body></html>"
)

# ---------------------------------------------------------------------------
# Simple per-IP rate limiter for login attempts (CWE-307 mitigation).
# ---------------------------------------------------------------------------
_LOGIN_MAX_ATTEMPTS = 5
_LOGIN_WINDOW_SECONDS = 300  # 5 minutes
_login_attempts: dict[str, list[float]] = {}


def _check_login_rate_limit(ip: str) -> bool:
    """Return True if the IP is within the rate limit, False if blocked."""
    now = time.time()
    attempts = _login_attempts.setdefault(ip, [])
    attempts[:] = [t for t in attempts if now - t < _LOGIN_WINDOW_SECONDS]
    if len(attempts) >= _LOGIN_MAX_ATTEMPTS:
        return False
    attempts.append(now)
    return True

app = FastAPI(
    title="Private Real-Time AI Agent — Proxy (v2)",
    description="WebSocket<->SSE proxy in front of Bedrock AgentCore Runtime.",
    version="0.2.0",
)


@app.get("/health")
async def health() -> JSONResponse:
    """ALB/ECS readiness probe. The proxy is stateless, so it is ready as soon
    as the process is up."""
    return JSONResponse(status_code=200, content={"status": "ok"})


# ===========================================================================
# Auth (self-hosted username/password login, fully private).
#
# The proxy runs in no-egress isolated subnets and the Cognito Hosted-UI OAuth
# domain has no PrivateLink endpoint, so we DON'T redirect to the Hosted UI.
# Instead the proxy serves its own login form and authenticates directly against
# the Cognito Identity Provider API (InitiateAuth) over the cognito-idp VPC
# endpoint. The pool JWKS is on the same host, so token verification is private
# too. All blocking boto/urllib calls run on a worker thread so the event loop
# is never blocked (the original event-loop block was the invocation becoming unresponsive).
# ===========================================================================


def _login_error_response(message: str, status_code: int) -> Response:
    """Re-render the login form on an error, issuing a FRESH CSRF token + cookie
    so the user's retry has a valid token (the previous one is single-use per
    page render). Used for every error path in the POST handler."""
    csrf_token = secrets.token_urlsafe(32)
    resp = HTMLResponse(
        content=_login_page_html(message, csrf_token=csrf_token), status_code=status_code
    )
    resp.set_cookie(
        CSRF_COOKIE,
        csrf_token,
        max_age=1800,
        httponly=False,
        secure=True,
        samesite="strict",
        path="/auth/login",
    )
    return resp


async def _session_token(request: Request) -> str | None:
    """Return a validated ID token from the session cookie, or None."""
    settings = get_settings()
    if not settings.auth_enabled:
        return "anonymous"  # auth disabled (local/dev) -> treat as authenticated
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    try:
        await asyncio.to_thread(auth_mod.verify_token, token, settings)
        return token
    except auth_mod.AuthError:
        return None


def _login_page_html(error: str = "", csrf_token: str = "") -> str:
    """A self-contained sign-in form matching the console's terminal-noir look."""
    err_block = (
        f'<p class="err" role="alert">{error}</p>' if error else ""
    )
    csrf_field = (
        f'<input type="hidden" name="csrf_token" value="{csrf_token}">' if csrf_token else ""
    )
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Sign in · Private Real-Time AI Agent</title>
<style>
  :root {{
    --bg:#07090d; --panel:#0e1219; --ink:#e8eef2; --ink-dim:#9fb0bd;
    --line:#1d2633; --line-bright:#2c3a4a; --phosphor:#5af2b0; --signal:#57d6ff;
    --rose:#ff6b8b; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:"Avenir Next","Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif;
  }}
  * {{ box-sizing:border-box; }}
  html,body {{ margin:0; height:100%; }}
  body {{
    background:
      radial-gradient(1200px 700px at 80% -10%, rgba(87,214,255,0.08), transparent 60%),
      radial-gradient(900px 600px at -5% 110%, rgba(90,242,176,0.07), transparent 55%),
      var(--bg);
    color:var(--ink); font-family:var(--sans);
    display:flex; align-items:center; justify-content:center; min-height:100%;
  }}
  .card {{
    width:min(92vw,400px); background:var(--panel);
    border:1px solid var(--line-bright); border-radius:16px;
    padding:34px 30px; box-shadow:0 22px 60px -24px rgba(0,0,0,0.85);
  }}
  .brand {{ display:flex; align-items:center; gap:12px; margin-bottom:22px; }}
  .mark {{
    width:36px; height:36px; border-radius:10px;
    background:linear-gradient(150deg,var(--phosphor),var(--signal));
    box-shadow:0 0 22px -4px var(--phosphor); position:relative;
  }}
  .mark::after {{ content:""; position:absolute; inset:6px; border-radius:5px; background:var(--bg); }}
  h1 {{ font-size:16px; margin:0; letter-spacing:.3px; }}
  h1 span {{ display:block; font-family:var(--mono); font-size:10.5px; font-weight:400;
    color:#5e6e7a; letter-spacing:1.6px; text-transform:uppercase; }}
  label {{ display:block; font-family:var(--mono); font-size:11px; letter-spacing:1px;
    text-transform:uppercase; color:var(--ink-dim); margin:16px 0 7px; }}
  input {{
    width:100%; padding:12px 13px; border-radius:10px; background:#070b11;
    border:1px solid var(--line-bright); color:var(--ink); font-size:15px;
    font-family:var(--mono); outline:none;
  }}
  input:focus {{ border-color:var(--signal); box-shadow:0 0 0 3px rgba(87,214,255,0.15); }}
  button {{
    width:100%; margin-top:24px; padding:13px; border:0; border-radius:10px;
    background:linear-gradient(150deg,var(--phosphor),var(--signal)); color:#04221a;
    font-weight:700; font-size:14px; letter-spacing:.4px; cursor:pointer;
  }}
  button:hover {{ filter:brightness(1.06); }}
  .err {{ margin:16px 0 0; padding:10px 12px; border-radius:9px; font-size:13px;
    color:var(--rose); background:rgba(255,107,139,0.08);
    border:1px solid rgba(255,107,139,0.35); }}
  .hint {{ margin-top:20px; font-size:12px; color:#5e6e7a; line-height:1.5; }}
</style></head>
<body>
  <form class="card" method="post" action="/auth/login" autocomplete="off">
    <div class="brand"><div class="mark"></div>
      <h1>Private Real-Time AI Agent<span>secure console · sign in</span></h1></div>
    {csrf_field}
    <label for="u">Username</label>
    <input id="u" name="username" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" required>
    <button type="submit">Sign in</button>
    {err_block}
    <p class="hint">Credentials are generated at deploy time and printed by the
    deployment script. This console is private behind CloudFront.</p>
  </form>
</body></html>"""


@app.get("/auth/login")
async def auth_login_form(request: Request) -> Response:
    """Serve the self-hosted sign-in form (or pass through when auth disabled)."""
    settings = get_settings()
    if not settings.auth_enabled:
        return RedirectResponse(url="/", status_code=302)
    if await _session_token(request) is not None:
        return RedirectResponse(url="/", status_code=302)
    # CSRF (double-submit cookie): issue a random token, embed it in the form as
    # a hidden field AND set it as a cookie. The POST handler requires the two to
    # match. A cross-site attacker cannot read the victim's cookie nor predict the
    # token, so a forged login POST fails. This complements the SameSite=lax
    # session cookie (defense-in-depth against login CSRF). (CWE-352)
    csrf_token = secrets.token_urlsafe(32)
    resp = HTMLResponse(content=_login_page_html(csrf_token=csrf_token), status_code=200)
    resp.set_cookie(
        CSRF_COOKIE,
        csrf_token,
        max_age=1800,  # 30 min to complete the login
        httponly=False,  # the value is also in the form; not a session secret
        secure=True,
        samesite="strict",  # strict: the CSRF cookie never rides cross-site
        path="/auth/login",
    )
    return resp


@app.post("/auth/login")
async def auth_login_submit(request: Request) -> Response:
    """Authenticate username/password via Cognito InitiateAuth; set the session."""
    settings = get_settings()
    if not settings.auth_enabled:
        return RedirectResponse(url="/", status_code=302)

    client_ip = request.client.host if request.client else "unknown"
    if not _check_login_rate_limit(client_ip):
        return _login_error_response(
            "Too many login attempts. Please wait a few minutes.", 429
        )

    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _login_error_response("Invalid form submission.", 400)

    # CSRF double-submit validation: the hidden form token must match the cookie.
    # Constant-time compare; reject if either is missing or they differ. (CWE-352)
    form_csrf = str(form.get("csrf_token", ""))
    cookie_csrf = request.cookies.get(CSRF_COOKIE, "")
    if (
        not form_csrf
        or not cookie_csrf
        or not hmac.compare_digest(form_csrf, cookie_csrf)
    ):
        return _login_error_response(
            "Your session expired. Please try signing in again.", 403
        )

    username = str(form.get("username", "")).strip()
    password = str(form.get("password", ""))
    if not username or not password:
        return _login_error_response("Enter both a username and password.", 400)

    try:
        result = await asyncio.to_thread(
            auth_mod.initiate_auth, settings, username, password
        )
        id_token = result["IdToken"]
        # Validate before trusting it (also warms the JWKS cache).
        await asyncio.to_thread(auth_mod.verify_token, id_token, settings)
    except auth_mod.LoginError:
        # Don't reflect the raw exception text into the page (info exposure);
        # log server-side and show a fixed, generic credential error.
        logger.info("login attempt failed")
        return _login_error_response("Incorrect username or password.", 401)
    except (auth_mod.AuthError, KeyError):
        logger.exception("login failed")
        return _login_error_response(
            "Sign-in is temporarily unavailable. Please try again.", 503
        )

    resp = RedirectResponse(url="/", status_code=303)  # 303 -> GET after POST
    # The CSRF token has served its purpose; clear it.
    resp.delete_cookie(CSRF_COOKIE, path="/auth/login")
    expires_in = int(result.get("ExpiresIn", 3600))
    resp.set_cookie(
        SESSION_COOKIE,
        id_token,
        max_age=expires_in,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )
    return resp


@app.get("/auth/logout")
async def auth_logout() -> Response:
    """Clear the session cookie and return to the login form."""
    resp = RedirectResponse(url="/auth/login", status_code=302)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.get("/api/config")
async def api_config(request: Request) -> JSONResponse:
    """Feature flags the SPA needs. Gated on auth when auth is enabled — the SPA
    only fetches this after the page loads, which already requires a valid
    session via the `/` redirect, so gating here closes a pre-auth info-
    disclosure (CWE-200) without breaking the app."""
    settings = get_settings()
    if settings.auth_enabled and await _session_token(request) is None:
        return JSONResponse(status_code=401, content={"error": "authentication required"})
    return JSONResponse(
        status_code=200,
        content={
            "authEnabled": settings.auth_enabled,
            "uploadsEnabled": settings.uploads_enabled,
            "maxUploadBytes": settings.max_upload_bytes,
        },
    )


def _validate_query(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    query = body.get("query")
    if not isinstance(query, str):
        return None
    if len(query) < QUERY_MIN_CHARS or len(query) > QUERY_MAX_CHARS:
        return None
    return query


@app.post("/invocations")
@app.post("/api/invocations")
async def invocations(request: Request) -> JSONResponse:
    """Synchronous HTTP invocation: validate, invoke AgentCore, return full text."""
    if await _session_token(request) is None:
        return JSONResponse(status_code=401, content={"error": "authentication required"})

    try:
        raw = await request.body()
        body = json.loads(raw) if raw else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(status_code=400, content={"error": _ERR_INVALID_JSON})

    query = _validate_query(body)
    if query is None:
        return JSONResponse(status_code=400, content={"error": _ERR_INVALID_QUERY})

    session_id = _new_session_id()
    try:
        response = await asyncio.wait_for(
            invoke_async(query, session_id),
            timeout=INVOCATION_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning("invocations timed out after %ss", INVOCATION_TIMEOUT_SECONDS)
        return JSONResponse(status_code=504, content={"error": _ERR_TIMED_OUT})
    except AgentCoreError:
        logger.exception("invocations agentcore error")
        return JSONResponse(status_code=502, content={"error": _ERR_GENERATION_FAILED})
    except Exception:  # noqa: BLE001
        logger.exception("invocations unexpected error")
        return JSONResponse(status_code=502, content={"error": _ERR_GENERATION_FAILED})

    return JSONResponse(status_code=200, content={"response": response})


@app.get("/")
async def index(request: Request) -> Response:
    """Serve the demo SPA at the site root through the default CloudFront behavior.

    When Cognito auth is enabled, an unauthenticated visitor is redirected to the
    Hosted UI first; the SPA only loads for a valid session.
    """
    if await _session_token(request) is None:
        return RedirectResponse(url="/auth/login", status_code=302)
    index_path = os.path.join(get_settings().static_dir, "index.html")
    if os.path.isfile(index_path):
        return FileResponse(index_path, media_type="text/html")
    return HTMLResponse(content=_SPA_PLACEHOLDER_HTML, status_code=200)


# ===========================================================================
# Document upload + ingestion (drives the live-audit feature).
# ===========================================================================

_ERR_UPLOAD_DISABLED = "document uploads are not enabled on this deployment"
_ERR_UPLOAD_TOO_LARGE = "the uploaded file exceeds the size limit"
_ERR_UPLOAD_TYPE = "unsupported file type; allowed: PDF, DOCX, TXT, MD"
_ERR_UPLOAD_EMPTY = "the uploaded document contained no extractable text"


@app.post("/api/upload")
async def upload(request: Request) -> JSONResponse:
    """Accept a document upload: parse to text, store in S3, index into OpenSearch.

    Returns a ``documentId`` + ``textKey`` the SPA passes back over the WebSocket
    to trigger the live audit, plus a short preview. Auth-gated when Cognito is on.
    """
    from config import ALLOWED_UPLOAD_EXTENSIONS

    settings = get_settings()
    if await _session_token(request) is None:
        return JSONResponse(status_code=401, content={"error": "authentication required"})
    if not settings.uploads_enabled:
        return JSONResponse(status_code=503, content={"error": _ERR_UPLOAD_DISABLED})

    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=400, content={"error": "invalid multipart form"})

    upload_file = form.get("file")
    if upload_file is None or not hasattr(upload_file, "read"):
        return JSONResponse(status_code=400, content={"error": "missing 'file' field"})

    filename = getattr(upload_file, "filename", "") or "document"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        return JSONResponse(status_code=400, content={"error": _ERR_UPLOAD_TYPE})

    data = await upload_file.read()
    if len(data) > settings.max_upload_bytes:
        return JSONResponse(status_code=413, content={"error": _ERR_UPLOAD_TOO_LARGE})

    try:
        text = docs_mod.extract_text(filename, data)
    except docs_mod.DocumentError:
        # Do not echo the exception text back to the client (info exposure);
        # log it server-side and return a fixed, generic message.
        logger.exception("upload text extraction failed")
        return JSONResponse(status_code=400, content={"error": _ERR_UPLOAD_TYPE})
    if not text.strip():
        return JSONResponse(status_code=400, content={"error": _ERR_UPLOAD_EMPTY})

    doc_id = f"upload-{uuid.uuid4().hex}"
    # Store original + extracted text (best-effort); index for future retrieval.
    docs_mod.store_in_s3(filename, data, settings=settings)
    text_key = docs_mod.store_text_in_s3(doc_id, text, settings=settings)
    indexed = docs_mod.index_in_opensearch(doc_id, filename, text, settings=settings)

    return JSONResponse(
        status_code=200,
        content={
            "documentId": doc_id,
            "textKey": text_key or "",
            "filename": filename,
            "chars": len(text),
            "indexed": bool(indexed),
            "preview": text[:600],
        },
    )


_static_dir = get_settings().static_dir
if os.path.isdir(_static_dir):
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")


# ===========================================================================
# WebSocket streaming endpoint — bridges to AgentCore SSE.
# ===========================================================================


def _new_session_id() -> str:
    """AgentCore runtimeSessionId must be >= 33 chars; pad a uuid4 hex."""
    return f"sess-{uuid.uuid4().hex}{uuid.uuid4().hex}"[:64]


class _WSConnection:
    """Per-connection state + serialized sender for one ``/ws`` socket."""

    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.connection_id = str(uuid.uuid4())
        # One AgentCore session per browser connection (multi-turn).
        self.session_id = _new_session_id()
        self._send_lock = asyncio.Lock()
        self.active = False
        self.closed = False
        # Auth state: set True by the WS endpoint (cookie) or an `auth` frame.
        # When auth is disabled the endpoint sets this True immediately.
        self.authed = False

    async def send_json(self, payload: dict[str, Any]) -> None:
        if self.closed:
            return
        async with self._send_lock:
            if self.closed:
                return
            await self.ws.send_json(payload)

    async def send_welcome(self) -> None:
        await self.send_json(
            {
                "type": "welcome",
                "connectionId": self.connection_id,
                "serverTime": datetime.now(timezone.utc).isoformat(),
            }
        )

    async def send_status(self, phase: str, message: str) -> None:
        await self.send_json({"type": "status", "phase": phase, "message": message})

    async def send_error(self, code: str, message: str) -> None:
        await self.send_json({"type": "error", "code": code, "message": message})


async def _safe_send_error(conn: _WSConnection, code: str, message: str) -> None:
    with contextlib.suppress(Exception):
        await conn.send_error(code, message)


async def _keepalive_loop(conn: _WSConnection) -> None:
    try:
        while True:
            await asyncio.sleep(WS_KEEPALIVE_INTERVAL_SECONDS)
            if conn.active or conn.closed:
                continue
            try:
                await conn.send_json({"type": "ping", "t": int(time.time() * 1000)})
            except Exception:  # noqa: BLE001
                return
    except asyncio.CancelledError:  # pragma: no cover
        raise


async def _run_query(conn: _WSConnection, query: str) -> None:
    """Stream the AgentCore response for one validated query over the socket."""
    conn.active = True
    query_id = str(uuid.uuid4())
    seq = 0
    try:
        try:
            await conn.send_status("retrieving", "Invoking the agent…")
        except Exception:  # noqa: BLE001
            return

        token_count = 0
        try:
            async for chunk in stream_tokens(query, conn.session_id):
                try:
                    await conn.send_json({"type": "token", "content": chunk, "seq": seq})
                except Exception:  # noqa: BLE001 - client gone mid-stream
                    conn.closed = True
                    return
                seq += 1
                token_count += 1
        except asyncio.TimeoutError:
            await _safe_send_error(conn, _WS_ERR_TIMEOUT, _WS_MSG_TIMEOUT)
            return
        except AgentCoreError:
            logger.exception("ws agentcore error")
            await _safe_send_error(conn, _WS_ERR_INFERENCE_FAILED, _WS_MSG_INFERENCE_FAILED)
            return
        except Exception:  # noqa: BLE001
            logger.exception("ws unexpected stream error")
            await _safe_send_error(conn, _WS_ERR_INFERENCE_FAILED, _WS_MSG_INFERENCE_FAILED)
            return

        try:
            await conn.send_json(
                {"type": "complete", "queryId": query_id, "tokenCount": token_count}
            )
        except Exception:  # noqa: BLE001
            logger.warning("ws complete send failed; suppressing further frames")
            conn.closed = True
    finally:
        conn.active = False


async def _handle_message(conn: _WSConnection, raw: str) -> None:
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        await _safe_send_error(conn, _WS_ERR_BAD_REQUEST, _WS_MSG_BAD_REQUEST)
        return

    if isinstance(data, dict):
        msg_type = data.get("type")
        if msg_type == "ping":
            with contextlib.suppress(Exception):
                await conn.send_json({"type": "pong", "t": data.get("t")})
            return
        if msg_type == "pong":
            return
        if msg_type == "auth":
            # Non-browser clients authenticate with an explicit token frame.
            settings = get_settings()
            if not settings.auth_enabled:
                conn.authed = True
                return
            try:
                await asyncio.to_thread(
                    auth_mod.verify_token, str(data.get("token", "")), settings
                )
                conn.authed = True
            except auth_mod.AuthError:
                await _safe_send_error(conn, "unauthorized", "authentication required")
            return

    # Enforce auth before any query/audit work.
    if not conn.authed:
        await _safe_send_error(conn, "unauthorized", "authentication required")
        return

    if isinstance(data, dict) and data.get("type") == "audit":
        await _run_audit(conn, data)
        return

    query = _validate_query(data)
    if query is None:
        await _safe_send_error(conn, _WS_ERR_BAD_REQUEST, _WS_MSG_BAD_REQUEST)
        return

    await _run_query(conn, query)


# --- Live document audit ----------------------------------------------------

_AUDIT_SYSTEM_FRAMING = (
    "A partner has submitted the following contract for review. Perform your "
    "standard contract review against the NextGen SOPs in your knowledge base "
    "and return the full structured findings report (summary, per-finding "
    "detail with severity and SOP reference, summary statistics, and final "
    "disposition) exactly as defined by your operating instructions. Use the "
    "opensearch_retriever tool to ground each finding in the relevant SOP "
    "requirements. Always complete the full report, ending with the disposition.\n\n"
    "=== CONTRACT START ===\n"
)


def _build_audit_prompt(text: str) -> str:
    # Cap the document portion so the whole prompt — and the resulting audit —
    # stays within the agent's 120s generation ceiling while still producing a
    # substantial, ~1-minute WebSocket stream. A focused (not exhaustive) audit
    # of this slice reliably completes before the ceiling.
    capped = text[:9000]
    # Defense-in-depth (CWE-77 prompt injection): the document text is UNTRUSTED.
    # The agent's locked system prompt (refuse non-review tasks) is the primary
    # control; here we add VISIBILITY by logging when an uploaded document
    # contains known injection markers, so abuse attempts are detectable in logs.
    # We deliberately do NOT silently strip the text (that would hide tampering
    # and could corrupt a legitimate contract); we surface it.
    _flag_prompt_injection(capped)
    return f"{_AUDIT_SYSTEM_FRAMING}{capped}\n=== CONTRACT END ===\n"


# Known prompt-injection marker phrases (lowercased). Not exhaustive — purely a
# detection aid for logging/alerting on suspicious uploads.
_INJECTION_MARKERS = (
    "ignore the above",
    "ignore previous instructions",
    "ignore all previous",
    "disregard your instructions",
    "disregard the above",
    "you are now",
    "new instructions:",
    "system prompt",
    "reveal your system",
    "repeat your system prompt",
    "act as",
    "developer mode",
)


def _flag_prompt_injection(text: str) -> bool:
    """Log a warning if the (untrusted) document text contains known prompt-
    injection markers. Returns True if any marker matched. Does not modify text."""
    lowered = text.lower()
    matched = [m for m in _INJECTION_MARKERS if m in lowered]
    if matched:
        logger.warning(
            "potential prompt-injection markers in uploaded document: %s", matched
        )
        return True
    return False


async def _run_audit(conn: _WSConnection, data: dict[str, Any]) -> None:
    """Fetch the uploaded document's text and stream a long, thorough audit."""
    text_key = data.get("textKey")
    inline_text = data.get("text")
    settings = get_settings()

    text = ""
    if isinstance(text_key, str) and text_key:
        text = await asyncio.to_thread(
            docs_mod.fetch_text_from_s3, text_key, settings=settings
        )
    if not text and isinstance(inline_text, str):
        text = inline_text
    if not text.strip():
        await _safe_send_error(
            conn, _WS_ERR_BAD_REQUEST, "no document text available to audit"
        )
        return

    try:
        await conn.send_status("auditing", "Auditing the document section by section…")
    except Exception:  # noqa: BLE001
        return
    await _run_query(conn, _build_audit_prompt(text))


@app.websocket("/ws")
@app.websocket("/ws/")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    conn = _WSConnection(websocket)

    # --- Auth (Cognito), order-independent ---------------------------------
    # The browser carries the session cookie on the WS upgrade, so it is
    # authenticated immediately and `welcome` follows. Non-browser clients (no
    # cookie) may instead send an {"type":"auth","token":"..."} frame; we send
    # `welcome` first regardless and enforce auth per-message in _handle_message.
    settings = get_settings()
    if not settings.auth_enabled:
        conn.authed = True
    else:
        cookie = websocket.cookies.get(SESSION_COOKIE)
        if cookie:
            try:
                await asyncio.to_thread(auth_mod.verify_token, cookie, settings)
                conn.authed = True
            except auth_mod.AuthError:
                conn.authed = False
        if not conn.authed:
            await websocket.close(code=4001, reason="authentication required")
            return

    try:
        await conn.send_welcome()
    except Exception:  # noqa: BLE001
        return

    keepalive = asyncio.create_task(_keepalive_loop(conn))
    try:
        while True:
            raw = await websocket.receive_text()
            await _handle_message(conn, raw)
    except WebSocketDisconnect:
        logger.info("ws disconnected: %s", conn.connection_id)
    except Exception:  # noqa: BLE001
        logger.exception("ws handler error: %s", conn.connection_id)
    finally:
        conn.closed = True
        keepalive.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await keepalive


if __name__ == "__main__":
    import uvicorn

    _settings = get_settings()
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(
        "app:app",
        host="0.0.0.0",  # noqa: S104
        port=_settings.port,
        log_level="info",
    )
