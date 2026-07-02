#!/usr/bin/env bash
#
# _common.sh — shared helpers for deploy.sh / destroy.sh.
#
# Sourced (not executed). Provides logging + preflight checks. Reads/writes the
# ACCOUNT env var (resolved from STS when unset).

# --- logging -----------------------------------------------------------------
if [[ -t 1 ]]; then
  _C_RESET="\033[0m"; _C_BOLD="\033[1m"; _C_BLUE="\033[34m"
  _C_GREEN="\033[32m"; _C_YELLOW="\033[33m"; _C_RED="\033[31m"
else
  _C_RESET=""; _C_BOLD=""; _C_BLUE=""; _C_GREEN=""; _C_YELLOW=""; _C_RED=""
fi

log_header()  { echo -e "\n${_C_BOLD}${_C_BLUE}==> $*${_C_RESET}"; }
log_info()    { echo -e "${_C_BLUE}info:${_C_RESET} $*"; }
log_success() { echo -e "${_C_GREEN}ok:${_C_RESET} $*"; }
log_warn()    { echo -e "${_C_YELLOW}warn:${_C_RESET} $*"; }
log_error()   { echo -e "${_C_RED}error:${_C_RESET} $*" >&2; }

# --- PATH preflight (no container engine required) ---------------------------
# Images are built in the cloud (CodeBuild), so deploy/destroy need NO local
# Docker/Finch. We only ensure common CLIs are reachable on PATH.
preflight_path() {
  export PATH="/usr/local/bin:${PATH}"
  if ! command -v aws >/dev/null 2>&1; then
    log_error "aws CLI not found on PATH. Install the AWS CLI and retry."
    exit 1
  fi
}

# --- AWS credentials ---------------------------------------------------------
# Resolves ACCOUNT from STS when unset; fails fast (with the refresh hint) if
# credentials are missing/expired.
preflight_credentials() {
  local ident
  if ! ident="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
    log_error "AWS credentials are missing or expired."
    log_error "Refresh, e.g.: ada credentials update --account=<id> --provider=isengard --role=Admin --once"
    exit 1
  fi
  local sts_account
  sts_account="$(echo "${ident}" | sed -n 's/.*"Account": *"\([0-9]*\)".*/\1/p')"
  ACCOUNT="${ACCOUNT:-${sts_account}}"
  if [[ -z "${ACCOUNT}" ]]; then
    log_error "could not resolve the AWS account id."
    exit 1
  fi
  if [[ "${ACCOUNT}" != "${sts_account}" ]]; then
    log_warn "Requested ACCOUNT=${ACCOUNT} differs from the active credentials' account ${sts_account}."
  fi
  log_success "AWS credentials valid (account ${sts_account})."
}

# --- CDK bootstrap -----------------------------------------------------------
# Ensures the target environment is CDK-bootstrapped. If the CDKToolkit stack is
# missing, this runs `cdk bootstrap` automatically (it is idempotent and the
# required prerequisite for `cdk deploy`) instead of only warning. Set
# SKIP_BOOTSTRAP=1 to opt out (e.g. when a restricted role bootstraps
# separately). A failed bootstrap is fatal, since the deploy cannot succeed
# without it.
preflight_bootstrap() {
  local account="$1" region="$2"
  if aws cloudformation describe-stacks \
        --stack-name CDKToolkit --region "${region}" >/dev/null 2>&1; then
    log_success "CDK bootstrap present in ${region}."
    return 0
  fi

  log_warn "CDK bootstrap (CDKToolkit) not found in ${region}."
  if [[ "${SKIP_BOOTSTRAP:-0}" == "1" ]]; then
    log_warn "SKIP_BOOTSTRAP=1 set — skipping. Deploy will fail if the environment is not bootstrapped elsewhere."
    return 0
  fi

  log_info "Bootstrapping aws://${account}/${region} (one-time setup; idempotent)..."
  if AWS_REGION="${region}" CDK_DEFAULT_REGION="${region}" CDK_DEFAULT_ACCOUNT="${account}" \
       npx cdk bootstrap "aws://${account}/${region}"; then
    log_success "CDK bootstrap complete in ${region}."
  else
    log_error "CDK bootstrap failed for aws://${account}/${region}."
    log_error "Fix the underlying issue (often insufficient IAM permissions) and retry,"
    log_error "or run it manually: npx cdk bootstrap aws://${account}/${region}"
    exit 1
  fi
}

# --- Availability Zone selection (deploy-time; no hardcoded AZs) -------------
# Selects AZ NAMES (e.g. us-east-1a) that support BOTH AgentCore Runtime AND
# OpenSearch Serverless (aoss), so the VPC (and the AgentCore egress ENIs) live
# only in AZs every service we use supports. Prints a comma-separated list of
# >= 2 AZ names on success; prints nothing (and returns 1) if it cannot find 2.
#
# AgentCore-supported AZ *IDs* per region are not exposed by a public API, so we
# allow an override via the AGENTCORE_AZ_IDS env var (comma-separated AZ IDs,
# e.g. "use1-az1,use1-az2,use1-az4"). For regions with a known AgentCore AZ-ID
# set we default it here (AZ IDs are stable per-region service facts, not
# account-specific AZ names). When unknown, we intersect account AZs with the
# aoss endpoint-service AZs only.
#
# Args: <region>
select_supported_azs() {
  local region="$1"

  # Known AgentCore-supported AZ IDs by region (extend as AWS expands support).
  # us-east-1: AgentCore supports use1-az1, use1-az2, use1-az4 (NOT az3/az5/az6).
  local agentcore_az_ids="${AGENTCORE_AZ_IDS:-}"
  if [[ -z "${agentcore_az_ids}" ]]; then
    case "${region}" in
      us-east-1) agentcore_az_ids="use1-az1,use1-az2,use1-az4" ;;
      *) agentcore_az_ids="" ;; # unknown -> rely on aoss intersection only
    esac
  fi

  # All AZ names + their AZ IDs available to THIS account in the region.
  local az_json
  az_json="$(aws ec2 describe-availability-zones --region "${region}" \
    --filters Name=state,Values=available Name=zone-type,Values=availability-zone \
    --query 'AvailabilityZones[].{Name:ZoneName,Id:ZoneId}' --output json 2>/dev/null || echo '[]')"

  # AZs the aoss interface endpoint service supports in this region.
  local aoss_azs
  aoss_azs="$(aws ec2 describe-vpc-endpoint-services --region "${region}" \
    --service-names "com.amazonaws.${region}.aoss" \
    --query 'ServiceDetails[0].AvailabilityZones' --output text 2>/dev/null | tr '\t' '\n' | sort -u || true)"

  # Candidate set: account AZ names that are aoss-supported AND (if known)
  # whose AZ ID is AgentCore-supported. Take the first two (sorted).
  local selected
  selected="$(AOSS_AZS="${aoss_azs}" AGENTCORE_AZ_IDS="${agentcore_az_ids}" node -e '
    const azs = JSON.parse(process.argv[1] || "[]");
    const aoss = (process.env.AOSS_AZS || "").split(/\s+/).filter(Boolean);
    const acIds = (process.env.AGENTCORE_AZ_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
    const ok = azs.filter(z => {
      const aossOk = aoss.length === 0 || aoss.includes(z.Name);
      const acOk = acIds.length === 0 || acIds.includes(z.Id);
      return aossOk && acOk;
    }).map(z => z.Name).sort();
    process.stdout.write(ok.slice(0, 2).join(","));
  ' "${az_json}")"

  if [[ -z "${selected}" || "${selected}" != *,* ]]; then
    return 1
  fi
  echo "${selected}"
}

# --- ACM certificate sanity (HTTPS origin mode) ------------------------------
# Return the certificate's primary domain name (e.g. "*.example.com"), or empty
# on any error. Used to suggest an origin hostname when one isn't supplied.
cert_primary_domain() {
  local arn="$1" region="$2"
  aws acm describe-certificate --certificate-arn "${arn}" --region "${region}" \
    --query 'Certificate.DomainName' --output text 2>/dev/null || true
}

# Best-effort: confirms the cert exists in REGION, is ISSUED, and (loosely) that
# its domain plausibly matches the origin hostname. Warnings, not hard failures,
# except for a clearly wrong region/missing cert.
verify_origin_certificate() {
  local arn="$1" region="$2" domain="$3"
  # ARN region segment: arn:aws:acm:<region>:<acct>:certificate/<id>
  local arn_region
  arn_region="$(echo "${arn}" | cut -d: -f4)"
  if [[ -n "${arn_region}" && "${arn_region}" != "${region}" ]]; then
    log_error "Certificate ARN region '${arn_region}' != stack region '${region}'."
    log_error "The ALB origin certificate must live in the stack region (${region})."
    exit 1
  fi
  local desc
  if ! desc="$(aws acm describe-certificate --certificate-arn "${arn}" --region "${region}" --output json 2>/dev/null)"; then
    log_error "Could not describe certificate ${arn} in ${region}. Check the ARN and region."
    exit 1
  fi
  local cert_status
  cert_status="$(echo "${desc}" | sed -n 's/.*"Status": *"\([A-Z_]*\)".*/\1/p' | head -1)"
  if [[ "${cert_status}" != "ISSUED" ]]; then
    log_error "Certificate status is '${cert_status}' (expected ISSUED). Complete ACM validation first."
    exit 1
  fi
  if ! echo "${desc}" | grep -q "${domain}"; then
    # The literal hostname won't appear when the cert is a wildcard
    # (e.g. cert "*.example.com" covers "agent-origin.example.com"). Accept the
    # hostname if it matches a wildcard SAN/domain on the cert.
    local parent="${domain#*.}"   # strip the leftmost label
    if echo "${desc}" | grep -q "\*\.${parent}"; then
      log_success "Origin hostname '${domain}' matches a wildcard on the certificate (*.${parent})."
    else
      log_warn "Origin hostname '${domain}' not obviously present in the certificate's domains."
      log_warn "Proceeding, but a mismatch will cause a 502 at the CloudFront->ALB TLS handshake."
    fi
  fi
  log_success "Origin certificate is ISSUED in ${region}."
}

# --- CloudFormation stack helpers (resilient teardown) -----------------------
# All read ${REGION} from the calling script.

# Echo a stack's status, "DOES_NOT_EXIST", or "ERROR:<msg>".
stack_status() {
  local name="$1" out rc
  out="$(aws cloudformation describe-stacks --stack-name "${name}" --region "${REGION}" \
        --query 'Stacks[0].StackStatus' --output text 2>&1)"; rc=$?
  if [[ ${rc} -ne 0 ]]; then
    if echo "${out}" | grep -qi "does not exist"; then echo "DOES_NOT_EXIST"; else echo "ERROR:${out}"; fi
    return
  fi
  echo "${out}"
}

# Poll until a stack is gone or DELETE_FAILED.
# Returns: 0 gone, 2 DELETE_FAILED, 3 timeout.
wait_stack_gone() {
  local name="$1" timeout="${2:-3600}" interval=20 s
  local deadline=$(( $(date +%s) + timeout ))
  while true; do
    s="$(stack_status "${name}")"
    case "${s}" in
      DOES_NOT_EXIST|DELETE_COMPLETE) return 0 ;;
      DELETE_FAILED) return 2 ;;
      ERROR:*) log_warn "status check error for ${name}: ${s#ERROR:}" ;;
      *) : ;; # *_IN_PROGRESS or other transient state — keep waiting
    esac
    if (( $(date +%s) >= deadline )); then return 3; fi
    sleep "${interval}"
  done
}

# --- access details (deploy summary) -----------------------------------------
# Print the site URL, username, and generated password once a deploy completes.
# Reads the App stack's outputs (SiteUrl, DemoUsername, DemoPasswordSecretArn)
# and fetches the password from Secrets Manager.
print_access_details() {
  local app_stack="$1" region="$2"
  local outs
  outs="$(aws cloudformation describe-stacks --stack-name "${app_stack}" --region "${region}" \
            --query 'Stacks[0].Outputs' --output json 2>/dev/null || echo '[]')"
  local get_out
  get_out() {
    echo "${outs}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s)||[];const m=o.find(x=>x.OutputKey==='$1');process.stdout.write(m?m.OutputValue:'')}catch(e){process.stdout.write('')}})"
  }
  local site user secret_arn password
  site="$(get_out SiteUrl)"
  user="$(get_out DemoUsername)"
  secret_arn="$(get_out DemoPasswordSecretArn)"
  password=""
  if [[ -n "${secret_arn}" ]]; then
    password="$(aws secretsmanager get-secret-value --secret-id "${secret_arn}" --region "${region}" \
                  --query SecretString --output text 2>/dev/null \
                | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).password||'')}catch(e){process.stdout.write('')}})" || true)"
  fi

  echo
  echo -e "${_C_BOLD}${_C_GREEN}╔══════════════════════════════════════════════════════════════╗${_C_RESET}"
  echo -e "${_C_BOLD}${_C_GREEN}║  Private Real-Time AI Agent — ready                          ║${_C_RESET}"
  echo -e "${_C_BOLD}${_C_GREEN}╚══════════════════════════════════════════════════════════════╝${_C_RESET}"
  echo -e "  ${_C_BOLD}URL:${_C_RESET}      ${site:-"(see App stack outputs)"}"
  echo -e "  ${_C_BOLD}Username:${_C_RESET} ${user:-demo}"
  if [[ -n "${password}" ]]; then
    echo -e "  ${_C_BOLD}Password:${_C_RESET} ${password}"
  else
    echo -e "  ${_C_BOLD}Password:${_C_RESET} (retrieve: aws secretsmanager get-secret-value --secret-id ${secret_arn})"
  fi
  echo -e "  ${_C_YELLOW}Sign in at the URL with the username/password above (no password change required).${_C_RESET}"
  echo -e "  ${_C_YELLOW}First query is slow (AgentCore cold start + OpenSearch scale-from-zero); warm ~6-12s.${_C_RESET}"
  echo
}

# Verify the per-deploy resources left NO residue after destroy. Checks
# CloudFormation stacks, solution ECR repos, the OpenSearch collection, and
# (when a full teardown was requested) the long-lived Network stack. AgentCore
# egress ENIs are reported for visibility only — they are AWS-managed and reaped
# by the service asynchronously, so they never fail this check. The CDK bootstrap
# is never inspected (shared, intentionally retained).
#
# Args: <stackBase> <region> <collectionName> <instanceName> [includeNetwork=0]
verify_no_residue() {
  local base="$1" region="$2" collection="$3" instance="$4" include_network="${5:-0}"
  local residue=0

  log_header "Verify-empty: confirming no per-deploy residue remains"

  # 1. CloudFormation stacks. The Network stack is RETAINED by default (it is
  #    long-lived), so it is only expected gone on a full (--include-network)
  #    teardown.
  local stacks=("${base}App" "${base}Agent" "${base}Data" "${base}Build" "${base}Waf")
  if [[ "${include_network}" == "1" ]]; then
    stacks+=("${base}Network")
  fi
  local stk st
  for stk in "${stacks[@]}"; do
    if [[ "${stk}" == "${base}Waf" ]]; then
      st="$(aws cloudformation describe-stacks --stack-name "${stk}" --region us-east-1 \
            --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'DOES_NOT_EXIST')"
    else
      st="$(aws cloudformation describe-stacks --stack-name "${stk}" --region "${region}" \
            --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'DOES_NOT_EXIST')"
    fi
    if [[ "${st}" == "DOES_NOT_EXIST" || "${st}" == "DELETE_COMPLETE" ]]; then
      log_success "stack ${stk}: gone"
    else
      log_error "stack ${stk}: still present (${st})"
      residue=1
    fi
  done

  if [[ "${include_network}" != "1" ]]; then
    local netst
    netst="$(aws cloudformation describe-stacks --stack-name "${base}Network" --region "${region}" \
            --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'DOES_NOT_EXIST')"
    if [[ "${netst}" == "DOES_NOT_EXIST" || "${netst}" == "DELETE_COMPLETE" ]]; then
      log_info "stack ${base}Network: already gone"
    else
      log_info "stack ${base}Network: RETAINED (long-lived VPC; free, reused next deploy)"
    fi
  fi

  # 2. AgentCore egress ENIs — informational only (AWS-managed; reaped async,
  #    per AWS docs up to ~8h). Never a failure: they cannot be deleted by us and
  #    harm nothing inside the retained VPC.
  local eni_all
  eni_all="$(aws ec2 describe-network-interfaces --region "${region}" \
    --filters "Name=interface-type,Values=agentic_ai" \
    --query 'length(NetworkInterfaces)' --output text 2>/dev/null || echo '0')"
  if [[ "${eni_all}" == "0" ]]; then
    log_success "agentcore egress ENIs: none"
  else
    log_info "agentcore egress ENIs present in region: ${eni_all} (AWS-managed; released automatically by the service, up to ~8h — not a failure)"
  fi

  # 3. Solution ECR repositories.
  local repo
  for repo in "private-realtime-ai-agent-${instance}/agent" "private-realtime-ai-agent-${instance}/proxy"; do
    if aws ecr describe-repositories --repository-names "${repo}" --region "${region}" >/dev/null 2>&1; then
      log_error "ECR repo ${repo}: still present"
      residue=1
    else
      log_success "ECR repo ${repo}: gone"
    fi
  done

  # 4. OpenSearch collection.
  local cid
  cid="$(aws opensearchserverless batch-get-collection --names "${collection}" --region "${region}" \
        --query 'collectionDetails[0].id' --output text 2>/dev/null || echo 'None')"
  if [[ -z "${cid}" || "${cid}" == "None" ]]; then
    log_success "aoss collection ${collection}: gone"
  else
    log_error "aoss collection ${collection}: still present (${cid})"
    residue=1
  fi

  if [[ ${residue} -eq 0 ]]; then
    log_success "Verify-empty PASSED: no per-deploy residue detected."
    return 0
  fi
  log_error "Verify-empty FAILED: residue detected above. Investigate before re-deploying."
  return 1
}
