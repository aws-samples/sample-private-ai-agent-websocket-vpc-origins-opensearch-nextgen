"""Amazon OpenSearch Serverless provisioner — CloudFormation custom-resource handler.

Amazon OpenSearch Serverless NextGen collection groups and the surrounding policies are
not reliably expressible through CloudFormation, so the entire OpenSearch
Serverless setup is provisioned **imperatively** here via the boto3
``opensearchserverless`` API. This Lambda is the single CloudFormation custom
resource backing the OpenSearch construct.

It runs **inside the VPC** (private-isolated subnets) and reaches:

  * the OpenSearch Serverless **control plane** (`aoss.{region}.amazonaws.com`)
    through the `com.amazonaws.{region}.aoss` interface VPC endpoint, to create
    the security policies and the collection; and
  * the OpenSearch Serverless **data plane** (the collection's
    `{id}.{region}.aoss.amazonaws.com` host) through the managed
    OpenSearch Serverless VPC endpoint, to create the vector index and seed the
    sample documents; and
  * **Amazon Bedrock Runtime** through its interface endpoint, to embed the
    sample documents with the Titan v2 model.

On ``Create``/``Update`` it (idempotently):
  1. creates an encryption policy (AWS-owned key) for the collection,
  2. creates a network policy restricting collection + dashboard access to the
     supplied data-plane VPC endpoint (no public access),
  3. creates a data-access policy granting the ECS task role and the role of
     this Lambda function collection- and index-level data actions,
  4. creates the ``VECTORSEARCH`` collection and waits for it to become ACTIVE,
  5. creates the ``knn_vector`` index (dimension 1024) if missing, and
  6. embeds + bulk-indexes the bundled sample documents (best-effort).

On ``Delete`` it best-effort tears the collection and policies down.

Returns ``CollectionEndpoint``, ``CollectionArn``, ``CollectionId``, and a
``Seeded`` flag in the resource ``Data`` so the stack can wire the agent
container's ``OPENSEARCH_ENDPOINT`` and scope the task-role IAM to the exact
collection ARN.

Resilience: collection creation/ACTIVE is required (the resource fails if the
collection cannot be created), but **document seeding is best-effort** — if the
data-plane VPC endpoint's private DNS has not finished propagating, seeding is
skipped with ``Seeded=false`` rather than failing the stack. Re-running the
deploy re-seeds once DNS has settled. The rest of the solution (CloudFront, ALB,
Fargate agent, demo frontend) is fully functional without the sample documents;
RAG just returns no matches until seeded.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("provisioner")
logger.setLevel(logging.INFO)

# --- Tunables ----------------------------------------------------------------

EMBED_DIMENSIONS = 1024  # Titan v2 — must match the knn_vector index mapping.

# The SOP knowledge base is PDF-only: each SOP is a PDF whose text is extracted,
# chunked, embedded with Titan v2, and indexed. Chunking keeps each embedded
# unit focused so RAG retrieval returns the relevant SOP section.
PDF_CHUNK_MAX_CHARS = 1500

# S3 prefix under which the original SOP PDFs are stored at deploy time so the
# knowledge base source documents are durably retained (separate from the
# user-upload prefixes, which expire).
SOP_S3_PREFIX = "sops/"

# Wait up to ~6 min for the collection to reach ACTIVE (control plane).
COLLECTION_ACTIVE_TIMEOUT_SECONDS = 360.0
COLLECTION_POLL_INTERVAL_SECONDS = 10.0

# Wait up to ~5 min for the data-plane endpoint DNS to resolve + collection to
# accept index/search calls. Best-effort: on timeout we skip seeding.
DATA_PLANE_TIMEOUT_SECONDS = 300.0
DATA_PLANE_BACKOFF_START_SECONDS = 5.0
DATA_PLANE_BACKOFF_MAX_SECONDS = 20.0

_HERE = Path(__file__).resolve().parent
_INDEX_MAPPING_FILE = _HERE / "index-mapping.json"
_DOCUMENTS_DIR = _HERE / "documents"


# --- Environment -------------------------------------------------------------


def _env(name: str, *, required: bool = True, default: str = "") -> str:
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def _endpoint_host(endpoint: str) -> str:
    host = endpoint.strip()
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
            break
    return host.split("/", 1)[0]


# --- Policy names (<=32 chars, lowercase, start with a letter) ---------------


def _policy_name(base: str, suffix: str, max_len: int = 32) -> str:
    room = max_len - len(suffix) - 1
    trimmed = base[: max(room, 1)].rstrip("-")
    if not trimmed:
        trimmed = "c"
    return f"{trimmed}-{suffix}"


def _sanitize(name: str) -> str:
    out = "".join(c if (c.isalnum() or c == "-") else "-" for c in name.lower())
    while "--" in out:
        out = out.replace("--", "-")
    out = out.strip("-")
    if not out or not out[0].isalpha():
        out = "c" + out
    return out or "collection"


# --- Control-plane provisioning (boto3 opensearchserverless) -----------------


def _aoss_control_client(*, fail_fast: bool = False):
    """Build an opensearchserverless control-plane client.

    The provisioner runs INSIDE the private VPC and reaches the aoss control
    plane only through the `com.amazonaws.{region}.aoss` interface endpoint.
    During a stack DELETE/rollback that endpoint may itself be deleting, so
    control-plane calls can hang until the socket times out. ``fail_fast`` uses
    short connect/read timeouts and no retries so the Delete handler degrades to
    "best-effort, quickly" instead of looping for the full 15-minute Lambda
    timeout (which deadlocks the rollback).
    """
    import boto3  # present in the Lambda runtime

    region = _env("AWS_REGION", required=False) or _env("AWS_DEFAULT_REGION")
    if fail_fast:
        from botocore.config import Config  # type: ignore[import-not-found]

        cfg = Config(
            connect_timeout=5,
            read_timeout=5,
            retries={"max_attempts": 1, "mode": "standard"},
        )
        return boto3.client("opensearchserverless", region_name=region, config=cfg)
    return boto3.client("opensearchserverless", region_name=region)


def _is_conflict(exc: BaseException) -> bool:
    """True when an AWS error means the resource already exists (idempotent)."""
    name = type(exc).__name__
    if name in ("ConflictException",):
        return True
    msg = str(exc).lower()
    return "conflict" in msg or "already exists" in msg or "alreadyexists" in msg


def _ensure_encryption_policy(client, name: str, collection: str) -> None:
    policy = json.dumps(
        {
            "Rules": [{"ResourceType": "collection", "Resource": [f"collection/{collection}"]}],
            "AWSOwnedKey": True,
        }
    )
    try:
        client.create_security_policy(name=name, type="encryption", policy=policy)
        logger.info("created encryption policy %s", name)
    except Exception as exc:  # noqa: BLE001
        if _is_conflict(exc):
            logger.info("encryption policy %s already exists", name)
            return
        raise


def _ensure_network_policy(
    client, name: str, collection: str, vpc_endpoint_id: str
) -> None:
    policy = json.dumps(
        [
            {
                "Rules": [
                    {"ResourceType": "collection", "Resource": [f"collection/{collection}"]},
                    {"ResourceType": "dashboard", "Resource": [f"collection/{collection}"]},
                ],
                "AllowFromPublic": False,
                "SourceVPCEs": [vpc_endpoint_id],
            }
        ]
    )
    try:
        client.create_security_policy(name=name, type="network", policy=policy)
        logger.info("created network policy %s (SourceVPCE=%s)", name, vpc_endpoint_id)
    except Exception as exc:  # noqa: BLE001
        if _is_conflict(exc):
            # Update so a changed SourceVPCE (e.g. a new aoss-data endpoint id)
            # takes effect — otherwise a stale endpoint id would persist and the
            # collection would remain unreachable.
            try:
                version = client.get_security_policy(name=name, type="network")[
                    "securityPolicyDetail"
                ]["policyVersion"]
                client.update_security_policy(
                    name=name, type="network", policyVersion=version, policy=policy
                )
                logger.info(
                    "updated network policy %s (SourceVPCE=%s)", name, vpc_endpoint_id
                )
            except Exception:  # noqa: BLE001
                logger.warning("could not update network policy %s; continuing", name)
            return
        raise


def _ensure_data_access_policy(
    client, name: str, collection: str, index: str, principals: List[str]
) -> None:
    policy = json.dumps(
        [
            {
                "Rules": [
                    {
                        "ResourceType": "collection",
                        "Resource": [f"collection/{collection}"],
                        "Permission": [
                            "aoss:CreateCollectionItems",
                            "aoss:DeleteCollectionItems",
                            "aoss:UpdateCollectionItems",
                            "aoss:DescribeCollectionItems",
                        ],
                    },
                    {
                        "ResourceType": "index",
                        "Resource": [
                            f"index/{collection}/{index}",
                            f"index/{collection}/*",
                        ],
                        "Permission": [
                            "aoss:CreateIndex",
                            "aoss:DeleteIndex",
                            "aoss:UpdateIndex",
                            "aoss:DescribeIndex",
                            "aoss:ReadDocument",
                            "aoss:WriteDocument",
                        ],
                    },
                ],
                "Principal": principals,
            }
        ]
    )
    try:
        client.create_access_policy(name=name, type="data", policy=policy)
        logger.info("created data-access policy %s for %s", name, principals)
    except Exception as exc:  # noqa: BLE001
        if _is_conflict(exc):
            # Update so a changed principal set / index takes effect.
            try:
                version = client.get_access_policy(name=name, type="data")[
                    "accessPolicyDetail"
                ]["policyVersion"]
                client.update_access_policy(
                    name=name, type="data", policyVersion=version, policy=policy
                )
                logger.info("updated existing data-access policy %s", name)
            except Exception:  # noqa: BLE001
                logger.warning("could not update data-access policy %s; continuing", name)
            return
        raise


# --- NextGen collection group ------------------------------------------------

# NextGen scale-to-zero capacity limits, applied at the collection-group level.
# minIndexingCapacityInOCU / minSearchCapacityInOCU = 0 => no compute cost while
# idle; the group warms on first use. max* must be >= 1 (API constraint).
NEXTGEN_MAX_INDEXING_OCU = 4.0
NEXTGEN_MAX_SEARCH_OCU = 4.0


def _collection_group_name(base: str) -> str:
    """Derive a valid collection-group name (3-32 chars, [a-z][a-z0-9-]+)."""
    name = _policy_name(base, "cg", max_len=32)
    return name


def _ensure_collection_group(client, name: str) -> None:
    """Create the NextGen collection group (scale-to-zero) if missing.

    The collection group is what selects the NextGen generation and carries the
    scale-to-zero capacity limits. The VECTORSEARCH collection is then associated
    with this group via ``collectionGroupName``.
    """
    try:
        client.create_collection_group(
            name=name,
            # NextGen collection groups REQUIRE standby replicas ENABLED
            # (the API rejects DISABLED for generation=NEXTGEN). This is the
            # multi-AZ durability posture for NextGen.
            standbyReplicas="ENABLED",
            generation="NEXTGEN",
            description="NextGen scale-to-zero group for the private real-time AI agent",
            capacityLimits={
                "minIndexingCapacityInOCU": 0,
                "minSearchCapacityInOCU": 0,
                "maxIndexingCapacityInOCU": NEXTGEN_MAX_INDEXING_OCU,
                "maxSearchCapacityInOCU": NEXTGEN_MAX_SEARCH_OCU,
            },
        )
        logger.info("created NextGen collection group %s (scale-to-zero)", name)
    except Exception as exc:  # noqa: BLE001
        if _is_conflict(exc):
            logger.info("collection group %s already exists", name)
            return
        # Older boto3 in the Lambda runtime may not know create_collection_group.
        if isinstance(exc, AttributeError) or "create_collection_group" in str(exc):
            raise RuntimeError(
                "boto3 in the Lambda runtime does not support create_collection_group; "
                "the bundled requirements.txt must pin a NextGen-capable boto3"
            ) from exc
        raise


def _ensure_collection(
    client, name: str, collection_group_name: Optional[str] = None
) -> Dict[str, Any]:
    """Create the VECTORSEARCH collection if missing; return its detail once ACTIVE.

    When ``collection_group_name`` is provided the collection is associated with
    that NextGen collection group (selecting the NextGen generation +
    scale-to-zero). Otherwise a CLASSIC collection is created.
    """
    create_kwargs: Dict[str, Any] = {
        "name": name,
        "type": "VECTORSEARCH",
        "description": "Vector collection for private real-time AI agent RAG",
    }
    if collection_group_name:
        create_kwargs["collectionGroupName"] = collection_group_name
    try:
        client.create_collection(**create_kwargs)
        logger.info(
            "create_collection requested for %s (group=%s)",
            name,
            collection_group_name or "<classic>",
        )
    except Exception as exc:  # noqa: BLE001
        if _is_conflict(exc):
            logger.info("collection %s already exists", name)
        else:
            raise

    deadline = time.monotonic() + COLLECTION_ACTIVE_TIMEOUT_SECONDS
    last_status = "UNKNOWN"
    while time.monotonic() < deadline:
        resp = client.batch_get_collection(names=[name])
        details = resp.get("collectionDetails", [])
        if details:
            detail = details[0]
            last_status = detail.get("status", "UNKNOWN")
            if last_status == "ACTIVE":
                logger.info("collection %s is ACTIVE", name)
                return detail
            if last_status == "FAILED":
                raise RuntimeError(f"collection {name} entered FAILED state")
        logger.info("collection %s status=%s; waiting...", name, last_status)
        time.sleep(COLLECTION_POLL_INTERVAL_SECONDS)

    raise TimeoutError(
        f"collection {name} did not reach ACTIVE within "
        f"{COLLECTION_ACTIVE_TIMEOUT_SECONDS:.0f}s (last status {last_status})"
    )


def _delete_collection_and_policies(
    client, name: str, base: str, generation: str = "NEXTGEN"
) -> None:
    """Best-effort teardown: delete the collection, then its policies + group."""
    # Collection first (the policies / group cannot be deleted while in use).
    try:
        resp = client.batch_get_collection(names=[name])
        details = resp.get("collectionDetails", [])
        if details:
            cid = details[0]["id"]
            client.delete_collection(id=cid)
            logger.info("delete_collection requested for %s (%s)", name, cid)
            # Wait for it to disappear so policy deletion can succeed.
            deadline = time.monotonic() + COLLECTION_ACTIVE_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                d = client.batch_get_collection(names=[name]).get("collectionDetails", [])
                if not d or d[0].get("status") == "DELETED":
                    break
                time.sleep(COLLECTION_POLL_INTERVAL_SECONDS)
    except Exception:  # noqa: BLE001
        logger.warning("collection delete best-effort failed for %s", name, exc_info=True)

    for delete, kind, pname in (
        (lambda n: client.delete_access_policy(name=n, type="data"), "data", _policy_name(base, "data")),
        (lambda n: client.delete_security_policy(name=n, type="network"), "network", _policy_name(base, "net")),
        (lambda n: client.delete_security_policy(name=n, type="encryption"), "encryption", _policy_name(base, "enc")),
    ):
        try:
            delete(pname)
            logger.info("deleted %s policy %s", kind, pname)
        except Exception:  # noqa: BLE001
            logger.warning("best-effort delete of %s policy %s failed", kind, pname, exc_info=True)

    # NextGen collection group last (only after its collection is gone).
    if generation.upper() == "NEXTGEN":
        cg_name = _collection_group_name(base)
        try:
            # delete_collection_group requires the group ID, not the name, so
            # resolve the id by listing groups and matching on name.
            group_id = None
            try:
                resp = client.list_collection_groups()
                for summary in resp.get("collectionGroupSummaries", []):
                    if summary.get("name") == cg_name:
                        group_id = summary.get("id")
                        break
            except Exception:  # noqa: BLE001
                logger.warning("could not list collection groups for %s", cg_name, exc_info=True)
            if group_id:
                client.delete_collection_group(id=group_id)
                logger.info("deleted collection group %s (%s)", cg_name, group_id)
            else:
                logger.info("collection group %s not found; nothing to delete", cg_name)
        except Exception:  # noqa: BLE001
            logger.warning(
                "best-effort delete of collection group %s failed", cg_name, exc_info=True
            )


# --- Data-plane: index creation + seeding (opensearch-py) --------------------


def _data_plane_client(endpoint: str, region: str):
    import boto3
    from opensearchpy import (  # type: ignore[import-not-found]
        AWSV4SignerAuth,
        OpenSearch,
        RequestsHttpConnection,
    )

    credentials = boto3.Session().get_credentials()
    auth = AWSV4SignerAuth(credentials, region, "aoss")
    return OpenSearch(
        hosts=[{"host": _endpoint_host(endpoint), "port": 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        pool_maxsize=20,
        timeout=30,
    )


def _load_mapping() -> Dict[str, Any]:
    with _INDEX_MAPPING_FILE.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _humanize_title(filename: str) -> str:
    """Derive a readable SOP title from a PDF filename.

    e.g. ``SOP-001-financial-terms-review.pdf`` -> ``SOP-001 Financial Terms Review``.
    """
    # Words that should be fully uppercased rather than title-cased.
    _ACRONYMS = {"ip"}
    stem = Path(filename).stem
    parts = stem.split("-")
    # Keep an "SOP" + number prefix uppercased/joined, title-case the rest.
    out: List[str] = []
    for i, part in enumerate(parts):
        if i == 0 and part.upper() == "SOP":
            out.append("SOP")
        elif part.isdigit():
            # attach the number to the preceding SOP token (SOP-001 -> "SOP-001")
            if out and out[-1] == "SOP":
                out[-1] = f"SOP-{part}"
            else:
                out.append(part)
        elif part.lower() in _ACRONYMS:
            out.append(part.upper())
        else:
            out.append(part.capitalize())
    return " ".join(out)


def _extract_pdf_text(path: Path) -> str:
    """Extract plain text from a PDF using pypdf (bundled in requirements.txt)."""
    from pypdf import PdfReader  # type: ignore[import-not-found]

    reader = PdfReader(str(path))
    parts = [(page.extract_text() or "") for page in reader.pages]
    return "\n\n".join(p.strip() for p in parts if p.strip())


def _chunk_text(text: str, max_chars: int = PDF_CHUNK_MAX_CHARS) -> List[str]:
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


def _load_documents() -> List[Dict[str, Any]]:
    """Load the SOP knowledge base from the bundled PDFs (PDF-only corpus).

    Each PDF is parsed to text and split into chunks; every chunk becomes one
    indexed document so RAG retrieval can return the most relevant SOP section.
    The logical ``id`` is ``<pdf-stem>-<chunk-index>`` and the ``title`` is a
    humanized SOP name. Tags carry the SOP id for traceability.
    """
    docs: List[Dict[str, Any]] = []
    for path in sorted(_DOCUMENTS_DIR.glob("*.pdf")):
        try:
            text = _extract_pdf_text(path)
        except Exception:  # noqa: BLE001 - skip an unreadable PDF, keep the rest
            logger.warning("could not extract text from %s; skipping", path.name, exc_info=True)
            continue
        if not text.strip():
            logger.warning("no extractable text in %s; skipping", path.name)
            continue
        stem = path.stem
        title = _humanize_title(path.name)
        sop_tag = stem.split("-review")[0].lower()  # e.g. "sop-001-financial-terms"
        for i, chunk in enumerate(_chunk_text(text)):
            docs.append(
                {
                    "id": f"{stem}-{i}",
                    "title": title,
                    "text": chunk,
                    "tags": ["sop", sop_tag],
                }
            )
    return docs


def _embed(text: str, region: str, model_id: str) -> List[float]:
    import boto3

    client = boto3.client("bedrock-runtime", region_name=region)
    resp = client.invoke_model(
        modelId=model_id,
        accept="application/json",
        contentType="application/json",
        body=json.dumps({"inputText": text, "dimensions": EMBED_DIMENSIONS, "normalize": True}),
    )
    payload = json.loads(resp["body"].read())
    vec = payload.get("embedding")
    if not vec:
        raise RuntimeError("Titan embeddings response did not contain a vector")
    return vec


def _seed_documents(endpoint: str, index: str, region: str, embed_model_id: str) -> int:
    """Create the index and bulk-index the sample docs. Returns count indexed.

    Waits out data-plane DNS propagation / collection warm-up up to the deadline.
    """
    from opensearchpy.helpers import bulk  # type: ignore[import-not-found]

    mapping = _load_mapping()
    documents = _load_documents()
    if not documents:
        logger.warning("no seed documents found; skipping seeding")
        return 0

    # Wait for the data plane to become reachable (DNS + warm-up). On each
    # provision run we DELETE and recreate the index so seeding is idempotent:
    # OpenSearch Serverless auto-generates document ids and REJECTS any
    # client-supplied `_id` ("Document ID is not supported in create/index
    # operation request"), so we cannot upsert by id. A fresh index per run
    # avoids duplicates instead.
    deadline = time.monotonic() + DATA_PLANE_TIMEOUT_SECONDS
    backoff = DATA_PLANE_BACKOFF_START_SECONDS
    client = _data_plane_client(endpoint, region)
    while True:
        try:
            if client.indices.exists(index=index):
                client.indices.delete(index=index)
                logger.info("deleted existing index %s for a clean re-seed", index)
            client.indices.create(index=index, body=mapping)
            logger.info("created index %s", index)
            break
        except Exception as exc:  # noqa: BLE001
            if time.monotonic() >= deadline:
                raise
            logger.info("data plane not ready (%s); retrying in %.0fs", type(exc).__name__, backoff)
            time.sleep(min(backoff, max(deadline - time.monotonic(), 0)))
            backoff = min(backoff * 2, DATA_PLANE_BACKOFF_MAX_SECONDS)
            client = _data_plane_client(endpoint, region)

    actions = []
    for doc in documents:
        actions.append(
            {
                "_op_type": "index",
                "_index": index,
                # NOTE: no "_id" — OpenSearch Serverless rejects client-supplied
                # ids. The document's logical id is kept in the "id" field below.
                "_source": {
                    "id": doc["id"],
                    "title": doc.get("title", ""),
                    "text": doc["text"],
                    "tags": doc.get("tags", []),
                    "embedding": _embed(doc["text"], region, embed_model_id),
                },
            }
        )
    success, _errors = bulk(client, actions)
    logger.info("indexed %d documents into %s", success, index)
    return int(success)


def _store_sop_pdfs_in_s3(bucket: str, region: str) -> int:
    """Upload the original SOP PDFs to S3 under ``sops/`` (durable source copy).

    The PDF-only knowledge base is indexed into OpenSearch, but the original
    source PDFs are also stored in S3 so the deployment retains the authoritative
    documents (separate from the expiring user-upload prefixes). Best-effort:
    returns the count uploaded and never raises, so an S3 hiccup cannot fail the
    stack.
    """
    if not bucket:
        logger.info("no upload bucket configured; skipping SOP PDF storage")
        return 0
    try:
        import boto3

        client = boto3.client("s3", region_name=region)
        stored = 0
        for path in sorted(_DOCUMENTS_DIR.glob("*.pdf")):
            key = f"{SOP_S3_PREFIX}{path.name}"
            with path.open("rb") as fh:
                client.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=fh.read(),
                    ContentType="application/pdf",
                )
            stored += 1
            logger.info("stored SOP PDF s3://%s/%s", bucket, key)
        return stored
    except Exception:  # noqa: BLE001 - storage is best-effort
        logger.warning("failed to store SOP PDFs in S3; continuing", exc_info=True)
        return 0


# --- Custom-resource entry point ---------------------------------------------


def _physical_id(event: Dict[str, Any], collection: str) -> str:
    return event.get("PhysicalResourceId") or f"aoss-provisioner::{collection}"


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_type = event.get("RequestType", "Create")
    collection = _env("COLLECTION_NAME")
    base = _sanitize(collection)
    physical_id = _physical_id(event, collection)
    props = event.get("ResourceProperties", {}) or {}
    generation = (props.get("Generation") or _env("GENERATION", required=False) or "NEXTGEN").upper()
    logger.info(
        "provisioner RequestType=%s collection=%s generation=%s",
        request_type,
        collection,
        generation,
    )

    if request_type == "Delete":
        # Best-effort teardown that MUST NOT block the rollback. The provisioner
        # runs inside the VPC and the aoss interface endpoint may be deleting in
        # the same rollback, so control-plane calls can time out. Use a
        # fail-fast client (short timeouts, no retries) and ALWAYS return
        # success — any aoss resources that cannot be reached are left as
        # harmless orphans (scale-to-zero => ~no cost) and can be cleaned
        # separately. Returning success lets CloudFormation finish the rollback
        # instead of deadlocking on a 15-minute Lambda timeout loop.
        try:
            fast_client = _aoss_control_client(fail_fast=True)
            _delete_collection_and_policies(fast_client, collection, base, generation)
        except Exception:  # noqa: BLE001 - never fail a Delete
            logger.warning(
                "best-effort teardown encountered an error; returning success "
                "so the stack rollback/delete can complete",
                exc_info=True,
            )
        return {"PhysicalResourceId": physical_id, "Data": {}}

    client = _aoss_control_client()

    # Create / Update — control plane (required).
    index = _env("OPENSEARCH_INDEX")
    embed_model_id = _env("BEDROCK_EMBED_MODEL_ID")
    # Prefer the resource property (so a changed endpoint id re-triggers and is
    # honoured); fall back to the env var for backward compatibility.
    vpc_endpoint_id = props.get("AossVpcEndpointId") or _env("AOSS_VPC_ENDPOINT_ID")
    lambda_role_arn = _env("LAMBDA_ROLE_ARN")
    region = _env("AWS_REGION", required=False) or _env("AWS_DEFAULT_REGION")

    # Data-access principals: the CDK passes a comma-joined list (the provisioner
    # Lambda role plus, e.g., the AgentCore execution role). Fall back to just
    # the Lambda role when the property is absent. De-duplicate and drop blanks.
    raw_principals = props.get("DataAccessPrincipals", "") or ""
    principals = [p.strip() for p in raw_principals.split(",") if p.strip()]
    if lambda_role_arn and lambda_role_arn not in principals:
        principals.append(lambda_role_arn)
    if not principals:
        principals = [lambda_role_arn]
    logger.info("data-access principals: %s", principals)

    # NextGen: create the scale-to-zero collection group first; the collection
    # is then associated with it.
    collection_group_name: Optional[str] = None
    if generation == "NEXTGEN":
        collection_group_name = _collection_group_name(base)
        _ensure_collection_group(client, collection_group_name)

    _ensure_encryption_policy(client, _policy_name(base, "enc"), collection)
    _ensure_network_policy(client, _policy_name(base, "net"), collection, vpc_endpoint_id)
    _ensure_data_access_policy(
        client,
        _policy_name(base, "data"),
        collection,
        index,
        principals=principals,
    )
    detail = _ensure_collection(client, collection, collection_group_name)
    collection_id = detail["id"]
    collection_arn = detail["arn"]
    collection_endpoint = detail.get("collectionEndpoint") or (
        f"https://{collection_id}.{region}.aoss.amazonaws.com"
    )

    # Data plane — best-effort seeding (must not roll back the stack).
    seeded = "false"
    indexed = 0
    try:
        indexed = _seed_documents(collection_endpoint, index, region, embed_model_id)
        seeded = "true" if indexed > 0 else "false"
    except Exception as exc:  # noqa: BLE001
        logger.exception("seeding failed; collection is provisioned but empty (%s)", type(exc).__name__)

    # Store the original SOP PDFs in S3 (durable source copy) — best-effort.
    upload_bucket = _env("UPLOAD_BUCKET", required=False)
    sops_stored = _store_sop_pdfs_in_s3(upload_bucket, region)

    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "CollectionEndpoint": collection_endpoint,
            "CollectionArn": collection_arn,
            "CollectionId": collection_id,
            "Seeded": seeded,
            "DocumentsIndexed": str(indexed),
            "SopPdfsStored": str(sops_stored),
        },
    }
