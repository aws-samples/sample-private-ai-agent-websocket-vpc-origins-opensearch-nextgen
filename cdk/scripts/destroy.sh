#!/usr/bin/env bash
#
# destroy.sh — clean, ordered teardown of the Private Real-Time AI Agent.
#
# The solution is six stacks. By DEFAULT this tears down everything EXCEPT the
# long-lived NetworkStack (the VPC + endpoints + security groups), in strict
# reverse-dependency order:
#
#   App → Agent → Data → Build → Waf      (Network is RETAINED by default)
#
# Why retain Network by default — the AgentCore egress ENIs:
#   AgentCore Runtime in VPC mode injects AWS-managed ENIs (interface-type
#   `agentic_ai`, tag `AmazonBedrockAgentCoreManaged=true`) into the VPC. These
#   are owned by AWS (attachment type `ela-attach`); they CANNOT be detached or
#   deleted by the customer. When the Runtime is deleted they are released
#   ASYNCHRONOUSLY by the service — per AWS docs this can take "up to 8 hours".
#   While they linger they block deletion of the subnets/SG/VPC they sit in.
#
#   Rather than block teardown waiting on AWS's reclaim (the old, unreliable
#   approach), we simply RETAIN the long-lived NetworkStack. The Runtime itself
#   deletes cleanly; the lingering ENIs sit harmlessly inside the still-present
#   (and FREE — there is no NAT gateway) VPC and AWS reaps them on its own. The
#   next deploy reuses the same network. This makes the everyday teardown fast
#   and deterministic, with nothing fighting itself.
#
# Full teardown (also remove Network) — use `--include-network`. If the ENIs are
# still present, the NetworkStack delete will fail until AWS releases them
# (re-run later); this is expected and is why it is opt-in.
#
# Clean teardown of the per-deploy resources is achieved IN THE STACKS:
#   - ECR repositories are `emptyOnDelete` + DESTROY (images removed with them).
#   - S3 buckets are `autoDeleteObjects` + DESTROY.
#   - The OpenSearch provisioner deletes the collection/policies/group on Delete.
#
# No local container engine is required for destroy.
#
# Usage:
#   ./scripts/destroy.sh                      # destroy all EXCEPT Network
#   ./scripts/destroy.sh --yes                # no confirmation prompt
#   ./scripts/destroy.sh --include-network    # also remove the VPC/Network
#   ./scripts/destroy.sh --sweep              # optional aoss safety sweep
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${CDK_DIR}"

# shellcheck source=./_common.sh
source "${SCRIPT_DIR}/_common.sh"

REGION="${REGION:-us-east-1}"
OUTPUT_DIR="cdk.out.deploy"
ASSUME_YES=0
RUN_SWEEP=0
INCLUDE_NETWORK=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --sweep) RUN_SWEEP=1 ;;
    --include-network) INCLUDE_NETWORK=1 ;;
    *) ;;
  esac
done

log_header "Private Real-Time AI Agent — destroy"

preflight_credentials   # sets ACCOUNT (no container engine needed for destroy)

INSTANCE_NAME="${INSTANCE_NAME:-$(node -e "try{const c=require('./cdk.json');process.stdout.write(((c.context||{}).agent||{}).instanceName||'demo')}catch(e){process.stdout.write('demo')}")}"
SUFFIX="$(echo "${INSTANCE_NAME}" | awk -F- '{out="";for(i=1;i<=NF;i++){if(length($i)>0){out=out toupper(substr($i,1,1)) substr($i,2)}}; print out}')"
BASE="PrivateRealtimeAiAgent${SUFFIX}"
COLLECTION_NAME="agent-rag-${INSTANCE_NAME}"

# Stacks to destroy, in strict reverse-dependency order. Network is OMITTED by
# default (long-lived) and appended only when --include-network is given. The
# Waf stack lives in us-east-1; cdk destroy handles its region from the app.
DESTROY_STACKS=("${BASE}App" "${BASE}Agent" "${BASE}Data" "${BASE}Build" "${BASE}Waf")
if [[ "${INCLUDE_NETWORK}" == "1" ]]; then
  # Insert Network just before Waf (App→Agent→Data→Build→Network→Waf).
  DESTROY_STACKS=("${BASE}App" "${BASE}Agent" "${BASE}Data" "${BASE}Build" "${BASE}Network" "${BASE}Waf")
fi

log_info "Target: ${ACCOUNT}/${REGION} — instance '${INSTANCE_NAME}'"
if [[ "${INCLUDE_NETWORK}" == "1" ]]; then
  log_warn "FULL teardown: including the NetworkStack (VPC). If AgentCore egress"
  log_warn "ENIs are still releasing, the VPC delete may fail until AWS frees"
  log_warn "them (re-run later). This is expected."
else
  log_info "Default teardown: removing all stacks EXCEPT ${BASE}Network (the"
  log_info "long-lived, FREE VPC). Use --include-network for a full teardown."
fi

if [[ "${ASSUME_YES}" != "1" ]]; then
  echo
  log_warn "This will DELETE: ${DESTROY_STACKS[*]}"
  read -r -p "Type the instance name '${INSTANCE_NAME}' to confirm: " confirm || true
  if [[ "${confirm}" != "${INSTANCE_NAME}" ]]; then
    log_error "Confirmation did not match. Aborting (nothing was deleted)."
    exit 1
  fi
fi

# --- Ordered destroy ---------------------------------------------------------
# Destroy the selected stacks explicitly (NOT `--all`), so the long-lived
# Network stack is retained by default. CDK destroys the listed stacks in the
# order given (reverse dependency), and refuses any that others still depend on.
log_info "Destroying stacks in reverse dependency order: ${DESTROY_STACKS[*]}"
set -x
AWS_REGION="${REGION}" \
CDK_DEFAULT_REGION="${REGION}" \
CDK_DEFAULT_ACCOUNT="${ACCOUNT}" \
  npx cdk destroy "${DESTROY_STACKS[@]}" --force --output "${OUTPUT_DIR}"
set +x
log_success "cdk destroy completed."

# --- Optional idempotent aoss safety sweep (off by default) -----------------
if [[ "${RUN_SWEEP}" == "1" ]]; then
  log_info "Optional aoss safety sweep (idempotent)..."
  bash "${SCRIPT_DIR}/sweep-aoss.sh" "${COLLECTION_NAME}" "${REGION}" || \
    log_warn "aoss sweep reported issues; the verify step below is authoritative."
fi

# --- Verify-empty: confirm no per-deploy residue remains --------------------
# Network is verified only when it was part of this teardown.
VERIFY_RC=0
verify_no_residue "${BASE}" "${REGION}" "${COLLECTION_NAME}" "${INSTANCE_NAME}" "${INCLUDE_NETWORK}" || VERIFY_RC=$?

# --- Closing note: explain what (if anything) is intentionally left behind ---
if [[ "${INCLUDE_NETWORK}" != "1" ]]; then
  NET_STATUS="$(aws cloudformation describe-stacks --stack-name "${BASE}Network" --region "${REGION}" \
                 --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'DOES_NOT_EXIST')"
  if [[ "${NET_STATUS}" != "DOES_NOT_EXIST" && "${NET_STATUS}" != "DELETE_COMPLETE" ]]; then
    echo
    log_header "What's left behind (and why)"
    log_info "Retained: ${BASE}Network — the long-lived VPC (subnets, security groups,"
    log_info "and VPC endpoints). It has NO NAT gateway, so it costs nothing to keep."
    echo
    log_info "Why it isn't deleted now:"
    log_info "  • By design, a default 'destroy' keeps the network so the next 'deploy'"
    log_info "    of the same instance reuses it (faster, stable, and the AgentCore"
    log_info "    egress ENIs are reused rather than re-created)."
    log_info "  • AgentCore Runtime injects AWS-managed ENIs (interface-type"
    log_info "    'agentic_ai') into this VPC. They are owned by AWS and CANNOT be"
    log_info "    deleted by us; AWS releases them AUTOMATICALLY after the runtime is"
    log_info "    gone — typically within ~8 hours (occasionally longer). While any"
    log_info "    remain attached, the VPC/subnets/SG cannot be deleted."
    echo
    log_info "To remove the network completely LATER (once AWS has released the ENIs):"
    log_info "    ./scripts/destroy.sh --include-network"
    log_info "  or check that none remain, then delete the stack directly:"
    log_info "    aws ec2 describe-network-interfaces --region ${REGION} \\"
    log_info "      --filters Name=interface-type,Values=agentic_ai \\"
    log_info "      --query 'length(NetworkInterfaces)'        # wait until this is 0"
    log_info "    aws cloudformation delete-stack --stack-name ${BASE}Network --region ${REGION}"
    echo
  fi
fi

exit ${VERIFY_RC}

