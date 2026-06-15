"""Typed configuration for the Strands agent container.

Settings are sourced from environment variables (set by the ECS task definition
in production, or by a local ``.env``/shell when developing). The CDK
``ecs-construct`` injects: ``PORT``, ``AWS_REGION``, ``BEDROCK_MODEL_ID``,
``BEDROCK_EMBED_MODEL_ID``, ``OPENSEARCH_ENDPOINT``, ``OPENSEARCH_INDEX``, and
``RAG_TOP_K``.

When the Bedrock / OpenSearch wiring is not configured (e.g. local development
or CI), the app runs in "mock mode" so the WebSocket protocol and demo frontend
work fully offline. The mock model + in-memory retriever are wired up in task
9.3; this module only exposes the ``mock_mode`` signal that drives that choice.

Requirements: 7.1 (Strands agent app), 7.2 (listen on port 8080).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache

# --- Defaults (kept in sync with cdk.json `context.agent`) --------------------

DEFAULT_PORT = 8080
DEFAULT_REGION = "us-east-1"
DEFAULT_BEDROCK_MODEL_ID = "anthropic.claude-sonnet-4-20250514"
DEFAULT_BEDROCK_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"
DEFAULT_OPENSEARCH_INDEX = "agent-knowledge"
DEFAULT_RAG_TOP_K = 5
RAG_TOP_K_MIN = 1
RAG_TOP_K_MAX = 5

# OpenSearch (aoss) client socket read timeout, in seconds. opensearch-py
# defaults to 10s, which fires on the FIRST query after a fresh deploy while the
# NextGen collection is scaling from zero — surfacing as a noisy
# ConnectionTimeout/ReadTimeoutError even though the retriever's cold-start retry
# loop would otherwise wait it out. A larger per-request read timeout lets a
# single search ride out the scale-from-zero warm-up instead of erroring.
DEFAULT_OPENSEARCH_TIMEOUT = 30
OPENSEARCH_TIMEOUT_MIN = 1
OPENSEARCH_TIMEOUT_MAX = 120

# Query length bounds shared by /invocations and /ws validation (R7.7/R7.8/R8.6).
QUERY_MIN_CHARS = 1
QUERY_MAX_CHARS = 10_000


def _env_str(name: str, default: str = "") -> str:
    """Read an environment variable, treating blank/whitespace as unset."""
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_int(name: str, default: int) -> int:
    """Read an integer environment variable, falling back on parse errors."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable, typed view of the container's runtime configuration."""

    port: int = DEFAULT_PORT
    aws_region: str = DEFAULT_REGION
    bedrock_model_id: str = DEFAULT_BEDROCK_MODEL_ID
    bedrock_embed_model_id: str = DEFAULT_BEDROCK_EMBED_MODEL_ID
    opensearch_endpoint: str = ""
    opensearch_index: str = DEFAULT_OPENSEARCH_INDEX
    rag_top_k: int = DEFAULT_RAG_TOP_K
    opensearch_timeout: int = DEFAULT_OPENSEARCH_TIMEOUT

    # Static dirs are resolved relative to this module so the app works
    # regardless of the working directory it is launched from.
    base_dir: str = field(
        default_factory=lambda: os.path.dirname(os.path.abspath(__file__))
    )

    @property
    def static_dir(self) -> str:
        """Absolute path to the demo SPA static assets directory."""
        return os.path.join(self.base_dir, "static")

    @property
    def has_opensearch(self) -> bool:
        """True when an OpenSearch Serverless endpoint is configured."""
        return bool(self.opensearch_endpoint)

    @property
    def mock_mode(self) -> bool:
        """Run offline with a mock model + in-memory retriever.

        Mock mode is enabled whenever the OpenSearch endpoint is not configured.
        Task 9.3 consumes this flag to swap in the mock model so the protocol
        and frontend can be exercised without Bedrock/OpenSearch access.
        """
        return not self.has_opensearch


def _normalize_rag_top_k(value: int) -> int:
    """Clamp RAG top-k into the supported [1, 5] range."""
    if value < RAG_TOP_K_MIN:
        return RAG_TOP_K_MIN
    if value > RAG_TOP_K_MAX:
        return RAG_TOP_K_MAX
    return value


def _normalize_opensearch_timeout(value: int) -> int:
    """Clamp the OpenSearch client read timeout into the supported range."""
    if value < OPENSEARCH_TIMEOUT_MIN:
        return OPENSEARCH_TIMEOUT_MIN
    if value > OPENSEARCH_TIMEOUT_MAX:
        return OPENSEARCH_TIMEOUT_MAX
    return value


def load_settings() -> Settings:
    """Build a :class:`Settings` instance from the current environment."""
    return Settings(
        port=_env_int("PORT", DEFAULT_PORT),
        aws_region=_env_str("AWS_REGION", DEFAULT_REGION),
        bedrock_model_id=_env_str("BEDROCK_MODEL_ID", DEFAULT_BEDROCK_MODEL_ID),
        bedrock_embed_model_id=_env_str(
            "BEDROCK_EMBED_MODEL_ID", DEFAULT_BEDROCK_EMBED_MODEL_ID
        ),
        opensearch_endpoint=_env_str("OPENSEARCH_ENDPOINT", ""),
        opensearch_index=_env_str("OPENSEARCH_INDEX", DEFAULT_OPENSEARCH_INDEX),
        rag_top_k=_normalize_rag_top_k(_env_int("RAG_TOP_K", DEFAULT_RAG_TOP_K)),
        opensearch_timeout=_normalize_opensearch_timeout(
            _env_int("OPENSEARCH_TIMEOUT", DEFAULT_OPENSEARCH_TIMEOUT)
        ),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached, process-wide :class:`Settings` singleton."""
    return load_settings()
