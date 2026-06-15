#!/usr/bin/env bash
#
# deploy.sh — guided, portable deployment of the Private Real-Time AI Agent.
#
# NO local container engine is required: the agent + proxy images are built in
# the cloud by AWS CodeBuild (see build-stack.ts). This script needs only the
# AWS CLI, Node.js, and the CDK CLI — it runs from AWS CloudShell.
#
# It wraps `cdk deploy --all` with: credential + bootstrap preflight, deploy-time
# Availability Zone selection (AZs that support AgentCore + aoss, never
# hardcoded), and an interactive choice for the CloudFront->ALB origin hop:
#
#   * HTTP  (default) — private over the AWS backbone, zero prework.
#   * HTTPS (opt-in)  — end-to-end TLS; requires a publicly-trusted ACM cert in
#                        the stack region whose domain matches an origin
#                        hostname you supply.
#
# CloudFormation (via `cdk deploy`) remains the source of truth; this script
# only sets env vars and passes `-c` context overrides.
#
# Usage:
#   ./scripts/deploy.sh                 # interactive
#   ./scripts/deploy.sh --yes           # non-interactive (HTTP origin, defaults)
#   ACCOUNT=... REGION=... ./scripts/deploy.sh
#
# Environment overrides (all optional; sensible defaults below):
#   ACCOUNT                 AWS account id        (default: current STS account)
#   REGION                  AWS region            (default: us-east-1)
#   INSTANCE_NAME           instanceName context  (default: from cdk.json)
#   AVAILABILITY_ZONES      comma AZ names         (default: auto-selected)
#   AGENTCORE_AZ_IDS        comma AZ IDs allow-list for AgentCore (optional)
#   ALB_ORIGIN_PROTOCOL     HTTP | HTTPS          (default: prompt, else HTTP)
#   ORIGIN_DOMAIN_NAME      origin hostname       (required for HTTPS)
#   ORIGIN_CERTIFICATE_ARN  ACM cert ARN (region) (required for HTTPS)
#   NON_INTERACTIVE         1 to skip all prompts (same as --yes)
set -euo pipefail

# --- locate the cdk app dir (script lives in <cdk>/scripts) ------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${CDK_DIR}"

# --- shared helpers ----------------------------------------------------------
# shellcheck source=./_common.sh
source "${SCRIPT_DIR}/_common.sh"

REGION="${REGION:-us-east-1}"
OUTPUT_DIR="cdk.out.deploy"

for arg in "$@"; do
  case "$arg" in
    --yes|-y) NON_INTERACTIVE=1 ;;
    *) ;;
  esac
done
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"

log_header "Private Real-Time AI Agent — deploy (cloud build, no local engine)"

# Cost notice: this deploy creates billable AWS resources — Amazon OpenSearch
# Serverless (NextGen), Amazon ECS on AWS Fargate tasks, several VPC interface
# endpoints (~$0.01/hour each), AWS WAF, an Amazon CloudFront distribution, AWS
# CodeBuild (build-time), and Amazon Bedrock model invocations. There is no NAT
# gateway, so idle cost is low. Run ./scripts/destroy.sh when finished to remove
# the per-deploy resources and stop ongoing charges.
log_warn "This deployment creates BILLABLE AWS resources. Run ./scripts/destroy.sh when finished to avoid ongoing charges."

# --- preflight: PATH, credentials, bootstrap (NO container engine) -----------
preflight_path
preflight_credentials   # sets ACCOUNT if unset
preflight_bootstrap "${ACCOUNT}" "${REGION}"

CTX_ARGS=()

# --- Availability Zone selection (deploy-time; never hardcoded) --------------
AZS="${AVAILABILITY_ZONES:-}"
if [[ -z "${AZS}" ]]; then
  if AZS="$(select_supported_azs "${REGION}")"; then
    log_success "Selected Availability Zones: ${AZS}"
  else
    log_error "Could not auto-select >= 2 Availability Zones supporting AgentCore + aoss in ${REGION}."
    log_error "Set AVAILABILITY_ZONES=<az1,az2> (and optionally AGENTCORE_AZ_IDS) and retry."
    exit 1
  fi
fi
CTX_ARGS+=("-c" "agent.availabilityZones=${AZS}")

# --- origin TLS mode selection -----------------------------------------------
# This choice controls the SECOND TLS hop only: CloudFront -> the internal ALB.
# (The first hop, browser -> CloudFront, is ALWAYS HTTPS/WSS regardless.)
ALB_ORIGIN_PROTOCOL="${ALB_ORIGIN_PROTOCOL:-}"
if [[ -z "${ALB_ORIGIN_PROTOCOL}" ]]; then
  if [[ "${NON_INTERACTIVE}" == "1" ]]; then
    ALB_ORIGIN_PROTOCOL="HTTP"
  else
    echo
    echo "──────────────────────────────────────────────────────────────────────"
    echo " Encryption for the CloudFront → internal ALB hop"
    echo "──────────────────────────────────────────────────────────────────────"
    echo
    echo " The browser → CloudFront hop is ALWAYS encrypted (HTTPS/WSS)."
    echo " This question is ONLY about the next hop: how CloudFront talks to your"
    echo " private internal ALB inside the VPC."
    echo
    echo "   1) HTTP  (default)"
    echo "      CloudFront → ALB on port 80. The traffic is private (it rides the"
    echo "      AWS backbone to an internal ALB in isolated subnets, with WAF at"
    echo "      the edge) with network-level encryption in transit over the AWS"
    echo "      backbone. No prework needed — just deploys."
    echo
    echo "   2) HTTPS  (end-to-end TLS)"
    echo "      CloudFront → ALB on port 443 with TLS terminating at the ALB, so"
    echo "      traffic is encrypted on every hop. Choose this for 'encrypt in"
    echo "      transit everywhere' / compliance (PCI, HIPAA, etc.)."
    echo "      Requires an ACM certificate ARN (a publicly-trusted cert in"
    echo "      ${REGION}). You will be asked for the ARN next if you pick this."
    echo
    read -r -p " Select origin hop protocol [1=HTTP / 2=HTTPS] (default 1): " choice || true
    case "${choice:-1}" in
      2) ALB_ORIGIN_PROTOCOL="HTTPS" ;;
      *) ALB_ORIGIN_PROTOCOL="HTTP" ;;
    esac
  fi
fi

CTX_ARGS+=()
if [[ "${ALB_ORIGIN_PROTOCOL}" == "HTTPS" ]]; then
  echo
  log_info "HTTPS origin selected — an ACM certificate (in ${REGION}) is required."
  # Ask for the certificate ARN (the essential input for HTTPS).
  if [[ -z "${ORIGIN_CERTIFICATE_ARN:-}" && "${NON_INTERACTIVE}" != "1" ]]; then
    read -r -p " ACM certificate ARN (in ${REGION}): " ORIGIN_CERTIFICATE_ARN || true
  fi
  if [[ -z "${ORIGIN_CERTIFICATE_ARN:-}" ]]; then
    log_error "HTTPS origin mode requires an ACM certificate ARN (ORIGIN_CERTIFICATE_ARN)."
    exit 1
  fi

  # The origin hostname must match the certificate. If not supplied, try to
  # derive it from the cert's primary domain. For a wildcard cert
  # (e.g. *.example.com) we substitute a concrete label ("agent-origin").
  if [[ -z "${ORIGIN_DOMAIN_NAME:-}" ]]; then
    cert_domain="$(cert_primary_domain "${ORIGIN_CERTIFICATE_ARN}" "${REGION}")"
    if [[ "${cert_domain}" == \** ]]; then
      # wildcard: replace the leading "*" with a concrete hostname label
      suggested="agent-origin.${cert_domain#\*.}"
    else
      suggested="${cert_domain}"
    fi
    if [[ "${NON_INTERACTIVE}" == "1" ]]; then
      ORIGIN_DOMAIN_NAME="${suggested}"
    else
      read -r -p " Origin hostname for SNI [default: ${suggested}]: " entered || true
      ORIGIN_DOMAIN_NAME="${entered:-${suggested}}"
    fi
  fi
  if [[ -z "${ORIGIN_DOMAIN_NAME:-}" ]]; then
    log_error "Could not determine an origin hostname; set ORIGIN_DOMAIN_NAME and retry."
    exit 1
  fi

  # Best-effort validation that the cert exists, is in REGION, and is ISSUED.
  verify_origin_certificate "${ORIGIN_CERTIFICATE_ARN}" "${REGION}" "${ORIGIN_DOMAIN_NAME}"
  CTX_ARGS+=("-c" "agent.albOriginProtocol=HTTPS")
  CTX_ARGS+=("-c" "agent.originDomainName=${ORIGIN_DOMAIN_NAME}")
  CTX_ARGS+=("-c" "agent.originCertificateArn=${ORIGIN_CERTIFICATE_ARN}")
  log_info "Origin hop: HTTPS (SNI host=${ORIGIN_DOMAIN_NAME})"
else
  log_info "Origin hop: HTTP (private over the AWS backbone, network-level encryption in transit on this hop)"
fi

if [[ -n "${INSTANCE_NAME:-}" ]]; then
  CTX_ARGS+=("-c" "agent.instanceName=${INSTANCE_NAME}")
fi

# --- deploy ------------------------------------------------------------------
# NOTE: per-key `-c agent.<k>=<v>` context overrides MERGE into the cdk.json
# `agent` object (unlike `-c agent='{...}'` which would replace it wholesale).
#
# The solution is six stacks (Waf, Network, Build, Data, Agent, App). CDK
# deploys them in dependency order with `--all`. Images build in the cloud
# (CodeBuild) — NO local container engine, so CDK_DOCKER is not set.
log_info "Deploying all stacks (Waf + Network + Build + Data + Agent + App) to ${ACCOUNT}/${REGION}..."
set -x
AWS_REGION="${REGION}" \
CDK_DEFAULT_REGION="${REGION}" \
CDK_DEFAULT_ACCOUNT="${ACCOUNT}" \
  npx cdk deploy --all \
    --require-approval never \
    --output "${OUTPUT_DIR}" \
    "${CTX_ARGS[@]}"
set +x

log_success "Deploy complete."

# --- print the access credentials -------------------------------------------
# Resolve the stack base name (instanceName -> PascalCase) to read the App
# stack outputs, then fetch the generated demo password from Secrets Manager.
INSTANCE_NAME="${INSTANCE_NAME:-$(node -e "try{const c=require('./cdk.json');process.stdout.write(((c.context||{}).agent||{}).instanceName||'demo')}catch(e){process.stdout.write('demo')}")}"
SUFFIX="$(echo "${INSTANCE_NAME}" | awk -F- '{out="";for(i=1;i<=NF;i++){if(length($i)>0){out=out toupper(substr($i,1,1)) substr($i,2)}}; print out}')"
APP_STACK="PrivateRealtimeAiAgent${SUFFIX}App"

print_access_details "${APP_STACK}" "${REGION}"
