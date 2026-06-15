"""Document upload pipeline for the proxy (v2).

Handles a user-uploaded document end to end:

  1. :func:`extract_text` — parse PDF / DOCX / TXT / MD bytes to plain text.
  2. :func:`store_in_s3` — persist the original bytes to the Amazon S3 upload bucket.
  3. :func:`index_in_opensearch` — embed the text (Amazon Titan v2) and index it into
     the Amazon OpenSearch Serverless NextGen collection so future agent queries can
     retrieve it (same index/schema the seed documents use).

All three are best-effort and independently guarded so a parsing/ingestion
hiccup never crashes the request: the audit can still run on extracted text even
if S3/OpenSearch are momentarily unavailable. Heavy deps (pypdf, python-docx,
opensearch-py, boto3) are imported lazily so the module loads in test/mock mode.
"""

from __future__ import annotations

import io
import logging
import os
import time
import uuid
from typing import List, Optional

from config import Settings, get_settings

logger = logging.getLogger("proxy.documents")

EMBED_DIMENSIONS = 1024  # Titan v2 — must match the knn_vector index mapping.


class DocumentError(Exception):
    """Raised when a document cannot be parsed."""


# ---------------------------------------------------------------------------
# Text extraction.
# ---------------------------------------------------------------------------


def extract_text(filename: str, data: bytes) -> str:
    """Extract plain text from an uploaded document by extension."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext == ".pdf":
        return _extract_pdf(data)
    if ext == ".docx":
        return _extract_docx(data)
    if ext in (".txt", ".md", ".markdown"):
        return data.decode("utf-8", "replace")
    raise DocumentError(f"unsupported file type: {ext or '(none)'}")


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader  # type: ignore import-not-found
    except Exception as exc:  # noqa: BLE001
        raise DocumentError("pypdf is required to parse PDF uploads") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
        parts = [(page.extract_text() or "") for page in reader.pages]
        return "\n\n".join(p.strip() for p in parts if p.strip())
    except Exception as exc:  # noqa: BLE001
        raise DocumentError("could not parse the PDF document") from exc


def _extract_docx(data: bytes) -> str:
    try:
        import docx  # type: ignore import-not-found  (python-docx)
    except Exception as exc:  # noqa: BLE001
        raise DocumentError("python-docx is required to parse DOCX uploads") from exc
    try:
        document = docx.Document(io.BytesIO(data))
        return "\n".join(p.text for p in document.paragraphs if p.text and p.text.strip())
    except Exception as exc:  # noqa: BLE001
        raise DocumentError("could not parse the DOCX document") from exc


# ---------------------------------------------------------------------------
# S3 storage.
# ---------------------------------------------------------------------------


def store_in_s3(
    filename: str, data: bytes, *, settings: Optional[Settings] = None
) -> Optional[str]:
    """Store the original upload in S3; return the s3:// key, or None on failure."""
    settings = settings or get_settings()
    if not settings.uploads_enabled:
        return None
    try:
        import boto3

        key = f"uploads/{time.strftime('%Y/%m/%d')}/{uuid.uuid4().hex}-{_safe_name(filename)}"
        client = boto3.client("s3", region_name=settings.aws_region)
        client.put_object(
            Bucket=settings.upload_bucket,
            Key=key,
            Body=data,
            ContentType=_content_type(filename),
        )
        logger.info("stored upload in s3://%s/%s", settings.upload_bucket, key)
        return f"s3://{settings.upload_bucket}/{key}"
    except Exception:  # noqa: BLE001 - storage is best-effort
        logger.exception("failed to store upload in S3")
        return None


def _safe_name(filename: str) -> str:
    base = os.path.basename(filename or "document")
    return "".join(c if (c.isalnum() or c in "-._") else "-" for c in base)[:120] or "document"


def store_text_in_s3(
    doc_id: str, text: str, *, settings: Optional[Settings] = None
) -> Optional[str]:
    """Store the EXTRACTED text under a stable key so the audit flow (which may
    run on a different proxy task) can fetch it back by key. Returns the key."""
    settings = settings or get_settings()
    if not settings.uploads_enabled:
        return None
    try:
        import boto3

        key = f"extracted/{doc_id}.txt"
        client = boto3.client("s3", region_name=settings.aws_region)
        client.put_object(
            Bucket=settings.upload_bucket,
            Key=key,
            Body=text.encode("utf-8"),
            ContentType="text/plain; charset=utf-8",
        )
        return key
    except Exception:  # noqa: BLE001 - best-effort
        logger.exception("failed to store extracted text in S3")
        return None


def fetch_text_from_s3(key: str, *, settings: Optional[Settings] = None) -> str:
    """Fetch previously-stored extracted text by key. Returns '' on failure."""
    settings = settings or get_settings()
    if not settings.uploads_enabled or not key:
        return ""
    # Only allow keys matching the exact format generated by store_text_in_s3.
    import re
    if not re.match(r'^extracted/upload-[0-9a-f]{32}\.txt$', key):
        return ""
    try:
        import boto3

        client = boto3.client("s3", region_name=settings.aws_region)
        obj = client.get_object(Bucket=settings.upload_bucket, Key=key)
        return obj["Body"].read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        logger.exception("failed to fetch extracted text from S3")
        return ""


def _content_type(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
    }.get(ext, "application/octet-stream")


# ---------------------------------------------------------------------------
# OpenSearch ingestion (embed + index).
# ---------------------------------------------------------------------------


def index_in_opensearch(
    doc_id: str,
    title: str,
    text: str,
    *,
    settings: Optional[Settings] = None,
) -> bool:
    """Embed ``text`` and index it into the collection. Returns True on success.

    The document is split into chunks so a large upload is retrievable by
    section; each chunk is embedded with Titan v2 and indexed with the same
    schema as the seed corpus (``id``/``title``/``text``/``tags``/``embedding``).
    Best-effort: returns False (never raises) so a transient aoss issue does not
    fail the upload.
    """
    settings = settings or get_settings()
    if not settings.opensearch_endpoint:
        return False
    try:
        import boto3
        from opensearchpy import (  # type: ignore import-not-found
            AWSV4SignerAuth,
            OpenSearch,
            RequestsHttpConnection,
        )
        from opensearchpy.helpers import bulk  # type: ignore import-not-found

        credentials = boto3.Session().get_credentials()
        auth = AWSV4SignerAuth(credentials, settings.aws_region, "aoss")
        client = OpenSearch(
            hosts=[{"host": _endpoint_host(settings.opensearch_endpoint), "port": 443}],
            http_auth=auth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            pool_maxsize=10,
            timeout=30,
        )
        chunks = _chunk_text(text)
        actions = []
        for i, chunk in enumerate(chunks):
            actions.append(
                {
                    "_op_type": "index",
                    "_index": settings.opensearch_index,
                    "_source": {
                        "id": f"{doc_id}-{i}",
                        "title": title,
                        "text": chunk,
                        "tags": ["user-upload"],
                        "embedding": _embed(chunk, settings),
                    },
                }
            )
        if not actions:
            return False
        success, _errors = bulk(client, actions)
        logger.info("indexed %d chunk(s) from upload %s", success, doc_id)
        return bool(success)
    except Exception:  # noqa: BLE001 - ingestion is best-effort
        logger.exception("failed to index upload into OpenSearch")
        return False


def _embed(text: str, settings: Settings) -> List[float]:
    import json

    import boto3

    client = boto3.client("bedrock-runtime", region_name=settings.aws_region)
    resp = client.invoke_model(
        modelId=settings.bedrock_embed_model_id,
        accept="application/json",
        contentType="application/json",
        body=json.dumps({"inputText": text[:8000], "dimensions": EMBED_DIMENSIONS, "normalize": True}),
    )
    payload = json.loads(resp["body"].read())
    vec = payload.get("embedding")
    if not vec:
        raise DocumentError("Titan embeddings response did not contain a vector")
    return vec


def _chunk_text(text: str, max_chars: int = 1500) -> List[str]:
    """Split text into ~max_chars chunks on paragraph boundaries."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 2 > max_chars and current:
            chunks.append(current)
            current = para
        else:
            current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)
    return chunks or ([text.strip()] if text.strip() else [])


def _endpoint_host(endpoint: str) -> str:
    host = endpoint.strip()
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    return host.split("/", 1)[0]
