"""Typed configuration for the WebSocket<->SSE proxy container (v2).

The proxy is a thin FastAPI app that bridges the browser WebSocket / HTTP API to
the Amazon Bedrock AgentCore Runtime. Settings are sourced from environment variables
set by the ECS task definition (`proxy-construct.ts`):

  * ``PORT``               — listen port (8080).
  * ``AWS_REGION``         — region for the bedrock-agentcore boto client.
  * ``AGENT_RUNTIME_ARN``  — the AgentCore Runtime ARN to invoke.

When ``AGENT_RUNTIME_ARN`` is not set the proxy runs in **mock mode**: it
synthesizes a short streamed response locally so the WebSocket protocol and demo
frontend can be exercised without an AgentCore runtime (local dev / CI).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache

DEFAULT_PORT = 8080
DEFAULT_REGION = "us-east-1"

# Query length bounds shared with the WS / HTTP validation (mirror v1).
QUERY_MIN_CHARS = 1
QUERY_MAX_CHARS = 10_000

# AgentCore qualifier (endpoint name) the proxy invokes. The AgentCore construct
# creates a named "live" endpoint; DEFAULT also works. Overridable via env.
DEFAULT_QUALIFIER = "DEFAULT"

# Upload limits for the document-audit feature.
DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB
# File extensions accepted by the /api/upload endpoint (parsed to text server-side).
ALLOWED_UPLOAD_EXTENSIONS = (".pdf", ".txt", ".md", ".markdown", ".docx")


def _env_str(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable, typed view of the proxy's runtime configuration."""

    port: int = DEFAULT_PORT
    aws_region: str = DEFAULT_REGION
    agent_runtime_arn: str = ""
    qualifier: str = DEFAULT_QUALIFIER

    # --- Cognito auth (self-hosted login at the proxy) ---------------------
    # When a user pool is configured the proxy enforces login: it serves its own
    # username/password form, authenticates via the Cognito InitiateAuth API over
    # the cognito-idp VPC endpoint, and validates the issued JWT on the SPA load
    # and on the WebSocket upgrade. When unset (local dev / CI) auth is disabled
    # so the protocol stays testable.
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""

    # --- Document upload + audit -------------------------------------------
    upload_bucket: str = ""  # S3 bucket for user-uploaded documents
    opensearch_endpoint: str = ""  # aoss data-plane endpoint for ingestion
    opensearch_index: str = "agent-knowledge"
    bedrock_embed_model_id: str = "amazon.titan-embed-text-v2:0"
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES

    base_dir: str = field(
        default_factory=lambda: os.path.dirname(os.path.abspath(__file__))
    )

    @property
    def static_dir(self) -> str:
        return os.path.join(self.base_dir, "static")

    @property
    def has_runtime(self) -> bool:
        return bool(self.agent_runtime_arn)

    @property
    def mock_mode(self) -> bool:
        """Run offline (no AgentCore runtime configured)."""
        return not self.has_runtime

    @property
    def auth_enabled(self) -> bool:
        """True when Cognito is configured, so the proxy enforces login."""
        return bool(self.cognito_user_pool_id and self.cognito_client_id)

    @property
    def allow_unauthenticated(self) -> bool:
        """Explicit opt-in to run WITHOUT auth (local dev / CI only).

        Running with no Cognito configured is fail-OPEN, so in any environment
        that has a real AgentCore runtime (i.e. a deployed environment) we
        require this flag to be set to `true` on purpose — otherwise startup
        fails closed. This prevents a misconfigured deployment (Cognito env vars
        accidentally unset) from silently serving the app with no authentication.
        """
        return _env_str("ALLOW_UNAUTHENTICATED", "").lower() in ("1", "true", "yes")

    @property
    def auth_misconfigured(self) -> bool:
        """Fail-closed condition: a real runtime is configured (deployed env) but
        auth is NOT enabled and the unauthenticated opt-in was not set."""
        return self.has_runtime and not self.auth_enabled and not self.allow_unauthenticated

    @property
    def uploads_enabled(self) -> bool:
        """True when an S3 upload bucket is configured."""
        return bool(self.upload_bucket)


def load_settings() -> Settings:
    return Settings(
        port=_env_int("PORT", DEFAULT_PORT),
        aws_region=_env_str("AWS_REGION", DEFAULT_REGION),
        agent_runtime_arn=_env_str("AGENT_RUNTIME_ARN", ""),
        qualifier=_env_str("AGENT_RUNTIME_QUALIFIER", DEFAULT_QUALIFIER),
        cognito_user_pool_id=_env_str("COGNITO_USER_POOL_ID", ""),
        cognito_client_id=_env_str("COGNITO_CLIENT_ID", ""),
        upload_bucket=_env_str("UPLOAD_BUCKET", ""),
        opensearch_endpoint=_env_str("OPENSEARCH_ENDPOINT", ""),
        opensearch_index=_env_str("OPENSEARCH_INDEX", "agent-knowledge"),
        bedrock_embed_model_id=_env_str(
            "BEDROCK_EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0"
        ),
        max_upload_bytes=_env_int("MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
