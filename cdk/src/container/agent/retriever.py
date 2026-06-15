"""Custom RAG tool — ``opensearch_retriever`` for the Strands agent.

This module implements the agent's retrieval-augmented-generation (RAG) tool.
It is intentionally split into two layers so the retrieval logic stays testable
offline (no Strands, Bedrock, or OpenSearch required):

  * :func:`retrieve` — a plain function holding all retrieval logic. It can be
    unit-tested directly and accepts an injectable ``settings`` plus an optional
    ``on_cold_start`` callback that the ``/ws`` handler (task 9.7) uses to emit a
    cold-start ``status`` message.
  * :func:`opensearch_retriever` — a thin Strands ``@tool`` wrapper that simply
    delegates to :func:`retrieve`. The ``@tool`` decorator is imported lazily and
    guarded so the module imports cleanly when ``strands`` is not installed.

Behaviour summary (R11.3, R11.4, R11.6, R11.7, R11.8):

  * Embed the query with the Amazon Titan v2 embeddings model via Amazon Bedrock
    ``bedrock-runtime`` ``invoke_model``.
  * Run a ``knn`` search with ``size = min(rag_top_k, 5)`` against the ``aoss``
    endpoint using ``opensearch-py`` with
    ``AWSV4SignerAuth(credentials, region, service="aoss")``.
  * Return the concatenated top-k document text (``title`` + ``text``) as a
    single string suitable for injection into the agent's context.
  * Cold-start handling: the first connection/timeout/503/"scaling" signal from
    ``aoss`` is treated as a cold-start. The search is retried through it (with a
    small backoff) up to a 60s ceiling, raising :class:`RetrievalTimeout` if the
    collection never becomes warm, and :class:`RetrievalFailed` on a
    non-cold-start search error. ``on_cold_start`` is invoked exactly once the
    first time a cold start is detected.
  * Mock mode: when ``settings.mock_mode`` is True (no OpenSearch endpoint), an
    in-memory retriever loads the ``seed/documents/*.json`` sample corpus (or a
    small built-in list) and does trivial keyword/substring scoring so the agent
    and demo frontend work fully offline.

Requirements: 11.3, 11.4, 11.6, 11.7, 11.8.
"""

from __future__ import annotations

import contextvars
import glob
import json
import logging
import os
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from config import RAG_TOP_K_MAX, Settings, get_settings

logger = logging.getLogger("agent.retriever")

__all__ = [
    "RetrievalError",
    "RetrievalColdStart",
    "RetrievalTimeout",
    "RetrievalFailed",
    "retrieve",
    "opensearch_retriever",
    "current_cold_start_callback",
]

# ---------------------------------------------------------------------------
# Cold-start callback wiring (R11.6).
#
# The ``opensearch_retriever`` @tool is invoked *inside* the Strands agent loop,
# so the ``/ws`` handler cannot pass an ``on_cold_start`` callback to it
# directly. Instead the handler sets this context variable for the duration of a
# query; the tool wrapper reads it and forwards it to :func:`retrieve` as
# ``on_cold_start``. When ``aoss`` is scaling from zero, :func:`retrieve` invokes
# the callback so the handler can emit a ``status`` message within 1 second.
#
# The default is ``None`` (no callback), so this is fully backward compatible:
# any caller that imports and uses :func:`retrieve` / :func:`opensearch_retriever`
# without setting the context variable behaves exactly as before.
# ---------------------------------------------------------------------------
current_cold_start_callback: contextvars.ContextVar[
    Optional[Callable[[], None]]
] = contextvars.ContextVar("current_cold_start_callback", default=None)

# --- Tunables ----------------------------------------------------------------

# Hard ceiling for waiting out an OpenSearch Serverless cold-start (R11.7).
COLD_START_CEILING_SECONDS = 60.0
# Backoff bounds for the cold-start retry loop (kept small so the ≤1s status
# emit and the 60s ceiling both stay accurate).
COLD_START_BACKOFF_START_SECONDS = 1.0
COLD_START_BACKOFF_MAX_SECONDS = 5.0

# Amazon Titan v2 embedding dimensionality — must match the knn_vector index mapping.
EMBED_DIMENSIONS = 1024


# --- Exceptions --------------------------------------------------------------


class RetrievalError(Exception):
    """Base class for all retrieval failures surfaced to the caller."""


class RetrievalColdStart(RetrievalError):
    """Signals that ``aoss`` is scaling up from zero (a transient condition).

    Raised internally by the single-shot search helper when the underlying
    error looks like a cold-start signal. The retry loop in :func:`retrieve`
    catches it and waits the collection out, rather than propagating it to the
    caller. It is exported so callers/tests can reason about the cold-start
    condition explicitly.
    """


class RetrievalTimeout(RetrievalError):
    """The collection did not become available within the 60s ceiling (R11.7)."""


class RetrievalFailed(RetrievalError):
    """A non-cold-start vector search (or embedding) error occurred (R11.8)."""


# --- Strands @tool decorator (lazy / guarded import) -------------------------

try:  # pragma: no cover - exercised implicitly by import environment
    from strands import tool as _strands_tool
except Exception:  # ImportError when strands is not installed (offline/tests)

    def _strands_tool(func=None, *_args, **_kwargs):  # type: ignore[misc]
        """No-op fallback decorator standing in for ``strands.tool``.

        Supports both bare ``@tool`` and parameterized ``@tool(...)`` usage so
        the module imports and behaves identically whether or not Strands is
        present.
        """
        if func is not None and callable(func):
            return func

        def _decorator(real_func):
            return real_func

        return _decorator


# --- Public retrieval logic --------------------------------------------------


def retrieve(
    query: str,
    settings: Optional[Settings] = None,
    on_cold_start: Optional[Callable[[], None]] = None,
) -> str:
    """Retrieve the most relevant document text for ``query``.

    In mock mode this uses an offline in-memory keyword retriever. Otherwise it
    embeds the query with Amazon Titan v2 and runs a ``knn`` search against ``aoss``.

    Args:
        query: The user's natural-language query.
        settings: Optional :class:`~config.Settings`. Defaults to the cached
            process settings via :func:`config.get_settings`.
        on_cold_start: Optional zero-arg callback invoked exactly once when an
            OpenSearch cold-start is first detected, so the ``/ws`` handler can
            emit a ``status`` message within 1s (R11.6).

    Returns:
        A single string containing the concatenated top-k document text
        (``title`` + ``text``), ready to inject into the agent's context.

    Raises:
        RetrievalTimeout: The collection did not warm up within 60s (R11.7).
        RetrievalFailed: Embedding or the vector search failed (R11.8).
    """
    settings = settings or get_settings()
    top_k = _effective_top_k(settings)

    text = (query or "").strip()
    if not text:
        return ""

    if settings.mock_mode:
        return _mock_retrieve(text, settings, top_k)

    return _opensearch_retrieve(text, settings, top_k, on_cold_start)


@_strands_tool
def opensearch_retriever(query: str) -> str:
    """Search the private knowledge base for context relevant to the query.

    Use this tool whenever answering a question would benefit from internal
    company knowledge (compliance, incident response, runbooks, architecture,
    cost, data privacy, etc.). It returns the most relevant document excerpts
    from the OpenSearch Serverless vector index.

    Args:
        query: The natural-language query to find supporting context for.

    Returns:
        The concatenated text of the most relevant documents, or an empty
        string when nothing relevant is found.
    """
    # Forward the context-local cold-start callback (set by the /ws handler)
    # so a status message can be emitted within 1s when aoss is scaling from
    # zero (R11.6). Defaults to None, so non-WebSocket callers are unaffected.
    return retrieve(query, on_cold_start=current_cold_start_callback.get())


# --- Top-k sizing ------------------------------------------------------------


def _effective_top_k(settings: Settings) -> int:
    """Return the search size, capped at ``min(rag_top_k, 5)`` (R11.3)."""
    return max(1, min(settings.rag_top_k, RAG_TOP_K_MAX))


# --- OpenSearch (aoss) path --------------------------------------------------


def _opensearch_retrieve(
    query: str,
    settings: Settings,
    top_k: int,
    on_cold_start: Optional[Callable[[], None]],
) -> str:
    """Embed the query and run a knn search against the aoss endpoint."""
    embedding = _embed_query(query, settings)
    client = _build_opensearch_client(settings)
    body = {
        "size": top_k,
        "query": {"knn": {"embedding": {"vector": embedding, "k": top_k}}},
        "_source": ["title", "text", "id"],
    }

    hits = _search_with_cold_start(client, settings, body, on_cold_start)
    return _format_hits(hits)


def _search_with_cold_start(
    client: Any,
    settings: Settings,
    body: Dict[str, Any],
    on_cold_start: Optional[Callable[[], None]],
) -> List[Dict[str, Any]]:
    """Run the knn search, waiting out a cold-start up to the 60s ceiling.

    Returns the raw list of search hits. Raises :class:`RetrievalTimeout` if the
    collection never warms up in time and :class:`RetrievalFailed` on any
    non-cold-start search error.
    """
    deadline = time.monotonic() + COLD_START_CEILING_SECONDS
    backoff = COLD_START_BACKOFF_START_SECONDS
    cold_start_notified = False

    while True:
        try:
            response = _search_once(client, settings.opensearch_index, body)
            return list(response.get("hits", {}).get("hits", []))
        except RetrievalColdStart as exc:
            if not cold_start_notified:
                cold_start_notified = True
                logger.info("opensearch cold-start detected; waiting for warm-up")
                _invoke_cold_start_callback(on_cold_start)

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RetrievalTimeout(
                    "context retrieval timed out waiting for the collection "
                    "to become available"
                ) from exc

            time.sleep(min(backoff, remaining))
            backoff = min(backoff * 2, COLD_START_BACKOFF_MAX_SECONDS)


def _search_once(client: Any, index: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Issue a single knn search, classifying errors as cold-start vs failure."""
    try:
        return client.search(index=index, body=body)
    except RetrievalError:
        raise
    except Exception as exc:  # noqa: BLE001 - classify any transport error
        if _is_cold_start_signal(exc):
            raise RetrievalColdStart(str(exc)) from exc
        raise RetrievalFailed("vector similarity search failed") from exc


def _invoke_cold_start_callback(on_cold_start: Optional[Callable[[], None]]) -> None:
    """Invoke the cold-start callback, never letting it break retrieval."""
    if on_cold_start is None:
        return
    try:
        on_cold_start()
    except Exception:  # noqa: BLE001 - a noisy callback must not stop retrieval
        logger.warning("on_cold_start callback raised; ignoring", exc_info=True)


def _is_cold_start_signal(exc: BaseException) -> bool:
    """Heuristically classify ``exc`` as an aoss cold-start (scaling) signal.

    opensearch-py is imported lazily, so this matches by exception class name,
    HTTP status code, and message substrings rather than importing concrete
    exception types. A cold start looks like a connection error, a timeout, an
    HTTP 503, or an explicit "scaling"/"not available" message.
    """
    name = type(exc).__name__.lower()
    if any(
        token in name
        for token in ("connectiontimeout", "connectionerror", "timeout", "connection")
    ):
        return True

    status = getattr(exc, "status_code", None)
    if status == 503:
        return True

    message = str(exc).lower()
    cold_markers = (
        "scaling",
        "503",
        "service unavailable",
        "not available",
        "temporarily unavailable",
        "no available connection",
        "connection refused",
        "timed out",
    )
    return any(marker in message for marker in cold_markers)


def _embed_query(query: str, settings: Settings) -> List[float]:
    """Embed ``query`` with the Amazon Titan v2 model via Amazon Bedrock ``invoke_model``."""
    try:
        import boto3  # local import keeps the module importable offline

        client = boto3.client("bedrock-runtime", region_name=settings.aws_region)
        request_body = json.dumps(
            {
                "inputText": query,
                "dimensions": EMBED_DIMENSIONS,
                "normalize": True,
            }
        )
        response = client.invoke_model(
            modelId=settings.bedrock_embed_model_id,
            body=request_body,
            accept="application/json",
            contentType="application/json",
        )
        payload = json.loads(response["body"].read())
        embedding = payload.get("embedding")
        if not embedding:
            raise RetrievalFailed("embeddings response did not contain a vector")
        return embedding
    except RetrievalError:
        raise
    except Exception as exc:  # noqa: BLE001 - any embed failure is a hard failure
        raise RetrievalFailed("failed to embed the query for retrieval") from exc


def _build_opensearch_client(settings: Settings) -> Any:
    """Construct a SigV4-signed opensearch-py client for the aoss endpoint."""
    import boto3
    from opensearchpy import (  # type: ignore[import-not-found]
        AWSV4SignerAuth,
        OpenSearch,
        RequestsHttpConnection,
    )

    credentials = boto3.Session().get_credentials()
    auth = AWSV4SignerAuth(credentials, settings.aws_region, "aoss")
    host = _endpoint_host(settings.opensearch_endpoint)

    return OpenSearch(
        hosts=[{"host": host, "port": 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        pool_maxsize=20,
        # opensearch-py defaults to a 10s socket read timeout, which fires on the
        # first query after a fresh deploy while the NextGen collection scales
        # from zero. A larger per-request timeout lets one search ride out the
        # warm-up; the cold-start retry loop in `_search_with_cold_start` still
        # bounds total wait at COLD_START_CEILING_SECONDS. (config: OPENSEARCH_TIMEOUT)
        timeout=settings.opensearch_timeout,
        max_retries=0,
    )


def _endpoint_host(endpoint: str) -> str:
    """Strip the scheme and any trailing path from an aoss endpoint URL."""
    host = endpoint.strip()
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix) :]
            break
    return host.split("/", 1)[0]


def _format_hits(hits: Sequence[Dict[str, Any]]) -> str:
    """Concatenate ``title`` + ``text`` from the search hits into one string."""
    documents = [hit.get("_source", {}) for hit in hits]
    return _format_documents(documents)


# --- Mock (offline, in-memory) path ------------------------------------------

# Minimal built-in corpus used only when the seed documents are not present on
# disk (e.g. running the agent image, which does not bundle the seed PDFs, in
# offline mock mode). Keeps offline mock mode coherent with the deployed
# contract-review purpose. In production the agent always has OpenSearch
# configured, so this fallback is never used.
_BUILTIN_DOCUMENTS: List[Dict[str, Any]] = [
    {
        "id": "sop-001",
        "title": "SOP-001 Financial Terms Review",
        "text": (
            "Financial terms standards: maximum upfront payment is 20% of the "
            "contract value; late fees may not exceed 5% simple interest; "
            "reimbursable expenses above $5,000 require prior written approval."
        ),
        "tags": ["sop", "sop-001-financial-terms"],
    },
    {
        "id": "sop-002",
        "title": "SOP-002 IP & Confidentiality Review",
        "text": (
            "Intellectual property and confidentiality standards: NextGen must "
            "own all deliverables and work product; licenses to work product must "
            "be irrevocable; confidentiality obligations must survive at least "
            "three years; subcontractor sharing requires prior consent."
        ),
        "tags": ["sop", "sop-002-ip-confidentiality"],
    },
    {
        "id": "sop-003",
        "title": "SOP-003 Liability & Risk Review",
        "text": (
            "Liability and risk standards: liability caps must be commensurate "
            "with contract value; indemnification must be mutual; termination "
            "requires at least 30 days' notice with a cure period."
        ),
        "tags": ["sop", "sop-003-liability-risk"],
    },
    {
        "id": "sop-004",
        "title": "SOP-004 Data & Security Compliance Review",
        "text": (
            "Data and security standards: security controls must be specific and "
            "measurable; breach notification within 72 hours; data retention no "
            "longer than 30 days post-termination; no unilateral amendment rights."
        ),
        "tags": ["sop", "sop-004-data-security"],
    },
]

# Cache of seed documents loaded from disk, keyed by resolved directory.
_seed_cache: Optional[List[Dict[str, Any]]] = None


def _mock_retrieve(query: str, settings: Settings, top_k: int) -> str:
    """In-memory keyword retriever for offline/mock mode (no Bedrock/OpenSearch)."""
    documents = _load_seed_documents(settings)
    tokens = _tokenize(query)

    scored = [
        (_score_document(doc, tokens, query), doc) for doc in documents
    ]
    # Keep deterministic ordering: highest score first, ties by document id.
    scored.sort(key=lambda pair: (-pair[0], str(pair[1].get("id", ""))))

    matched = [doc for score, doc in scored if score > 0][:top_k]
    if not matched:
        # Graceful fallback so the agent always receives some context offline.
        matched = [doc for _score, doc in scored][:top_k]

    return _format_documents(matched)


def _tokenize(text: str) -> List[str]:
    """Split text into lowercase alphanumeric word tokens."""
    cleaned = [
        char.lower() if (char.isalnum()) else " " for char in text
    ]
    return [token for token in "".join(cleaned).split() if token]


def _score_document(doc: Dict[str, Any], tokens: Sequence[str], query: str) -> int:
    """Trivial keyword/substring score over a document's fields."""
    title = str(doc.get("title", ""))
    text = str(doc.get("text", ""))
    tags = doc.get("tags", []) or []
    haystack = " ".join([title, text, " ".join(str(t) for t in tags)]).lower()

    score = sum(haystack.count(token) for token in tokens)

    # Bonus for a whole-query substring match (helps multi-word queries).
    normalized_query = query.strip().lower()
    if normalized_query and normalized_query in haystack:
        score += 5

    return score


def _load_seed_documents(settings: Settings) -> List[Dict[str, Any]]:
    """Load sample documents from ``seed/documents/*.json`` (cached).

    Walks up from this module's directory looking for a ``seed/documents``
    folder so it works regardless of how deeply nested the container directory
    is. Falls back to a small built-in corpus when none is found.
    """
    global _seed_cache
    if _seed_cache is not None:
        return _seed_cache

    seed_dir = _find_seed_documents_dir(settings.base_dir)
    documents: List[Dict[str, Any]] = []
    if seed_dir:
        for path in sorted(glob.glob(os.path.join(seed_dir, "*.json"))):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    doc = json.load(handle)
                if isinstance(doc, dict) and (doc.get("text") or doc.get("title")):
                    documents.append(doc)
            except (OSError, json.JSONDecodeError):
                logger.warning("skipping unreadable seed document: %s", path)

    if not documents:
        logger.info("no seed documents found on disk; using built-in mock corpus")
        documents = list(_BUILTIN_DOCUMENTS)

    _seed_cache = documents
    return documents


def _find_seed_documents_dir(start_dir: str, max_levels: int = 6) -> Optional[str]:
    """Search ``start_dir`` and its ancestors for a ``seed/documents`` directory."""
    current = os.path.abspath(start_dir)
    for _ in range(max_levels):
        candidate = os.path.join(current, "seed", "documents")
        if os.path.isdir(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:  # reached the filesystem root
            break
        current = parent
    return None


def _format_documents(documents: Sequence[Dict[str, Any]]) -> str:
    """Render documents as ``title`` + ``text`` blocks joined for the context."""
    blocks: List[str] = []
    for doc in documents:
        title = str(doc.get("title", "")).strip()
        text = str(doc.get("text", "")).strip()
        if not title and not text:
            continue
        if title:
            blocks.append(f"## {title}\n{text}".rstrip())
        else:
            blocks.append(text)
    return "\n\n".join(blocks)
