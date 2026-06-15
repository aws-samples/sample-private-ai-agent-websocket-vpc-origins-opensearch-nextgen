# Deployment Guide — Private Real-Time AI Agent

This guide walks you through deploying the Contract Review Agent end to end. The
entire flow runs from your terminal or **AWS CloudShell** — there is **no Docker
or local container engine requirement**, because the container images are built
in the cloud with AWS CodeBuild and pushed to Amazon ECR.

For an architecture overview and configuration reference, see
[README.md](README.md).

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **AWS account** | A dedicated, single-purpose account is recommended. |
| **AWS CLI** | Configured with credentials for the target account/region. |
| **Node.js 20.x or later and npm** | Required for the AWS CDK app. |
| **AWS CDK CLI** | Install with `npm install -g aws-cdk`. |
| **Amazon Bedrock model access** | Enable access in your Region for the chat model (Claude Sonnet) and the embeddings model (Amazon Titan Text v2). |

> 💡 **Tip:** Everything below works unchanged in **AWS CloudShell**, which comes
> with the AWS CLI and Node.js preinstalled.

### Enable Amazon Bedrock model access

1. Open the **Amazon Bedrock** console in your target Region.
2. Go to **Model access**.
3. Enable the **Anthropic Claude Sonnet** chat model and **Amazon Titan Text
   Embeddings V2**.
4. Wait until both show **Access granted**.

---

## 2. One-time bootstrap (per account/region)

The AWS CDK needs a one-time bootstrap in each account/Region. This provisions
shared infrastructure (an S3 bucket and roles) used by all CDK deployments and
is **not** removed when you tear the solution down.

```bash
npx cdk bootstrap aws://<account-id>/<region>
```

---

## 3. Deploy

```bash
cd cdk
npm install
./scripts/deploy.sh
```

The script will:

1. Verify your credentials and the CDK bootstrap.
2. **Auto-select Availability Zones** that support both Amazon Bedrock AgentCore
   and Amazon OpenSearch Serverless (nothing is hardcoded).
3. Ask how Amazon CloudFront should reach the internal ALB (HTTP or HTTPS — see
   below).
4. Deploy all six stacks in order: **Waf → Network → Build → Data → Agent →
   App**.
5. Print the **site URL**, the demo **username**, and the demo **password**.

> ⏱️ The first deploy takes roughly **15–25 minutes** (cloud image builds,
> CloudFront distribution, and the AgentCore runtime).

### Non-interactive deploy

```bash
./scripts/deploy.sh --yes        # HTTP origin hop, default settings
```

### Choosing the CloudFront → ALB origin hop

The browser ↔ CloudFront hop is **always** HTTPS/WSS. This choice only affects
the next hop, CloudFront → internal ALB:

- **HTTP (default):** private over the AWS backbone to the internal ALB, with
  network-level encryption in transit. Zero prework.
- **HTTPS (recommended for sensitive/production use):** end-to-end TLS. Requires
  a publicly-trusted **AWS Certificate Manager (ACM) certificate in the stack
  Region** and an origin hostname that matches it. The origin hostname needs
  **no public DNS record** — it is used only for the TLS SNI/certificate match.

```bash
ALB_ORIGIN_PROTOCOL=HTTPS \
ORIGIN_CERTIFICATE_ARN=arn:aws:acm:<region>:<account>:certificate/<id> \
ORIGIN_DOMAIN_NAME=agent-origin.example.com \
  ./scripts/deploy.sh --yes
```

---

## 4. Test the deployment

1. Open the **site URL** printed by the deploy script.
2. Sign in with the printed demo **username** and **password**.
3. Download the sample contract:
   `Sample-Contract/partner-services-agreement.pdf`.
4. In the chat composer, attach the PDF (📎) and run the live review.
5. The agent returns a structured findings report grounded in the SOPs, ending
   with an overall disposition (the sample contract is intentionally
   **REJECTED**).

> The agent is locked to contract review. Off-topic prompts (for example, "what's
> the weather?") are refused by design, and it will not reveal its system prompt
> or SOP contents.

### Quick command-line smoke check (optional)

```bash
# Expect 302 -> /auth/login (auth is enforced)
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://<your-site-url>/

# Expect 401 (the config endpoint is gated behind auth)
curl -s -o /dev/null -w "%{http_code}\n" https://<your-site-url>/api/config
```

---

## 5. Configuration reference

Edit `cdk/cdk.json` under `context.agent` to change defaults:

| Key | Default | Notes |
|---|---|---|
| `bedrockModelId` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | inference profile id |
| `bedrockEmbedModelId` | `amazon.titan-embed-text-v2:0` | 1024-dim Titan v2 |
| `openSearchIndex` | `agent-knowledge` | vector index name |
| `ragTopK` | `5` | 1..5 |
| `cpuArchitecture` | `X86_64` | proxy architecture |
| `desiredCount` | `2` | proxy task count (≥2, spans 2 AZs) |
| `instanceName` | `demo` | namespaces stacks + collection + runtime |

To deploy to a different Region, change only the deploy-time inputs (for example
`REGION=...`); no source edits are needed.

---

## 6. Build & test locally (offline, no AWS)

```bash
cd cdk
npm install
npx tsc --noEmit          # typecheck
npx jest                  # CDK snapshot + assertions + config tests

# Python unit tests:
cd src/container/agent && python -m pytest tests -q
cd ../proxy            && python -m pytest tests -q
```

---

## 7. Tear down

```bash
cd cdk
./scripts/destroy.sh                 # ordered teardown of all per-deploy stacks
./scripts/destroy.sh --yes           # skip the confirmation prompt
./scripts/destroy.sh --include-network   # ALSO remove the long-lived VPC
```

> ⚠️ **Data loss warning:** destroy empties and deletes the Amazon S3 uploads
> bucket (permanently deleting any uploaded contracts and extracted text) and
> deletes the OpenSearch Serverless collection (the indexed SOP knowledge base).
> Back up anything you need first.

By default, `destroy.sh` removes every per-deploy stack
(**App → Agent → Data → Build → Waf**) and runs a verify-empty check. It
**intentionally retains the long-lived `…Network` stack** (the VPC) so a
redeploy with the same `instanceName` can reuse it.

### Removing the network stack

In VPC-egress mode, AgentCore injects AWS-managed network interfaces
(interface-type `agentic_ai`) into your subnets. These are owned by AWS and are
released **automatically after the runtime is gone, typically within ~8 hours**.
While any remain attached, the VPC cannot be deleted.

To remove the network completely once AWS has released the interfaces:

```bash
# 1) Wait until this prints 0:
aws ec2 describe-network-interfaces --region <region> \
  --filters Name=interface-type,Values=agentic_ai \
  --query 'length(NetworkInterfaces)'

# 2) Then run:
./scripts/destroy.sh --include-network
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Deploy fails at bootstrap check | Run `npx cdk bootstrap aws://<account-id>/<region>`. |
| Bedrock access/permission errors | Enable model access in the Bedrock console (Step 1) and confirm the Region. |
| `--include-network` fails on "subnet has dependencies" | AgentCore ENIs are still attached; wait until the ENI count (above) is 0, then retry. |
| First deploy seems slow | The initial build (CodeBuild images + CloudFront + AgentCore) takes ~15–25 min. |
