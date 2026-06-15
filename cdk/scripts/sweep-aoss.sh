#!/usr/bin/env bash
#
# sweep-aoss.sh — remove orphaned OpenSearch Serverless control-plane resources
# left behind after a stack delete.
#
# The provisioner's Delete handler is fail-fast/best-effort by design (so a
# rollback can't deadlock on the deleting aoss VPC endpoint). On the rare path
# where it couldn't reach the control plane, the collection, its security/data
# policies, and the NextGen collection group can survive the stack delete. They
# are control-plane objects, so they can be deleted from anywhere with IAM (no
# VPC access needed). Scale-to-zero makes such orphans ~free; this sweep removes
# them so the account is genuinely clean.
#
# Idempotent: deletes only what exists, in dependency order (collection first,
# then policies, then the collection group). Safe to run repeatedly.
#
# Usage: sweep-aoss.sh <collection-name> <region>
#   e.g. sweep-aoss.sh agent-rag-v2 us-east-1
#
# Policy/group names mirror provisioner_handler.py's naming:
#   base       = sanitized collection name
#   enc policy = <base-trimmed>-enc   (<=32 chars)
#   net policy = <base-trimmed>-net
#   data policy= <base-trimmed>-data
#   group      = <base-trimmed>-cg
set -euo pipefail

COLLECTION_NAME="${1:?usage: sweep-aoss.sh <collection-name> <region>}"
REGION="${2:?usage: sweep-aoss.sh <collection-name> <region>}"

# Mirror provisioner_handler.py::_policy_name(base, suffix, max_len=32):
#   room = 32 - len(suffix) - 1 ; trimmed = base[:room].rstrip('-')
_policy_name() {
  local base="$1" suffix="$2" max=32
  local room=$(( max - ${#suffix} - 1 ))
  (( room < 1 )) && room=1
  local trimmed="${base:0:room}"
  trimmed="${trimmed%-}"   # rstrip a single trailing hyphen
  [[ -z "${trimmed}" ]] && trimmed="c"
  echo "${trimmed}-${suffix}"
}

BASE="${COLLECTION_NAME}"
ENC_POLICY="$(_policy_name "${BASE}" enc)"
NET_POLICY="$(_policy_name "${BASE}" net)"
DATA_POLICY="$(_policy_name "${BASE}" data)"
GROUP_NAME="$(_policy_name "${BASE}" cg)"

aoss() { aws opensearchserverless "$@" --region "${REGION}"; }

echo "sweep: region=${REGION} collection=${COLLECTION_NAME}"

# 1) Collection (must go before its policies / group).
CID="$(aoss batch-get-collection --names "${COLLECTION_NAME}" \
        --query 'collectionDetails[0].id' --output text 2>/dev/null || echo "None")"
if [[ -n "${CID}" && "${CID}" != "None" ]]; then
  echo "  deleting collection ${COLLECTION_NAME} (${CID})..."
  aoss delete-collection --id "${CID}" >/dev/null 2>&1 || echo "  (collection delete best-effort failed)"
  # Wait for it to disappear so policy/group deletes can succeed.
  for _ in $(seq 1 30); do
    S="$(aoss batch-get-collection --names "${COLLECTION_NAME}" \
          --query 'collectionDetails[0].status' --output text 2>/dev/null || echo "None")"
    [[ -z "${S}" || "${S}" == "None" || "${S}" == "DELETED" ]] && break
    sleep 10
  done
else
  echo "  no collection named ${COLLECTION_NAME}; nothing to delete."
fi

# 2) Policies (best-effort; ignore "not found").
del_security_policy() {
  local name="$1" type="$2"
  if aoss get-security-policy --name "${name}" --type "${type}" >/dev/null 2>&1; then
    echo "  deleting ${type} security policy ${name}..."
    aoss delete-security-policy --name "${name}" --type "${type}" >/dev/null 2>&1 \
      || echo "  (delete of ${type} policy ${name} failed)"
  fi
}
del_access_policy() {
  local name="$1"
  if aoss get-access-policy --name "${name}" --type data >/dev/null 2>&1; then
    echo "  deleting data access policy ${name}..."
    aoss delete-access-policy --name "${name}" --type data >/dev/null 2>&1 \
      || echo "  (delete of data policy ${name} failed)"
  fi
}
del_access_policy   "${DATA_POLICY}"
del_security_policy "${NET_POLICY}" network
del_security_policy "${ENC_POLICY}" encryption

# 3) NextGen collection group (last; needs the id, resolved by name).
if aoss list-collection-groups >/dev/null 2>&1; then
  GID="$(aoss list-collection-groups \
          --query "collectionGroupSummaries[?name=='${GROUP_NAME}'].id | [0]" \
          --output text 2>/dev/null || echo "None")"
  if [[ -n "${GID}" && "${GID}" != "None" ]]; then
    echo "  deleting collection group ${GROUP_NAME} (${GID})..."
    aoss delete-collection-group --id "${GID}" >/dev/null 2>&1 \
      || echo "  (collection group delete best-effort failed)"
  else
    echo "  no collection group named ${GROUP_NAME}; nothing to delete."
  fi
else
  echo "  list-collection-groups unavailable (older CLI?); skipping group sweep."
fi

echo "sweep: done."
