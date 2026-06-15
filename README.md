# Private Real-Time AI Agent — Example Corp Contract Review Agent

A fully private, real-time AI agent that reviews partner contracts against your
internal Standard Operating Procedures (SOPs). It runs on **Amazon Bedrock
AgentCore Runtime** (in VPC-egress mode), retrieves SOP context from **Amazon
OpenSearch Serverless (NextGen, scale-to-zero)**, and is fronted by **Amazon
CloudFront → VPC Origin → internal ALB → Amazon ECS on AWS Fargate proxy** with WebSocket
streaming. The only internet-facing surface is CloudFront.

Container images are built **in the cloud** (AWS CodeBuild → Amazon ECR), so you
do **not** need Docker or any local container engine — you can deploy from **AWS
CloudShell** with nothing but the AWS CLI, Node.js, and the CDK CLI.

> The agent is locked to contract review. It refuses any request that is not a
> contract review against the Example Corp SOPs, and it will not reveal its prompt or
> SOP contents.

> 📘 **New here?** See **[DEPLOYMENT.md](DEPLOYMENT.md)** for a step-by-step
> deployment walkthrough (prerequisites, deploy, test, and teardown).

## Architecture (privacy-preserving)

```
Browser ── wss/https:443 ─▶ CloudFront (WAF) ─▶ VPC Origin ─▶ internal ALB ─▶ ECS proxy (:8080)
     proxy ── InvokeAgentRuntime (AWS PrivateLink) ─▶ AgentCore Runtime (VPC egress ENIs)
          AgentCore ── aoss VPC endpoint ─▶ OpenSearch Serverless NextGen (RAG)
          AgentCore ── bedrock-runtime VPC endpoint ─▶ Amazon Bedrock
```

All agent egress is configured to traverse VPC endpoints — no NAT gateway, nothing but
CloudFront touches the internet.

**Inbound hardening (defense-in-depth):** the AgentCore Runtime carries a
resource-based policy (`AWS::BedrockAgentCore::ResourcePolicy`) that **denies**
`InvokeAgentRuntime`/`InvokeAgentRuntimeForUser` unless the request's
`aws:SourceVpc` matches this solution's VPC. The only intended caller — the
in-VPC ECS proxy — invokes the runtime over the `bedrock-agentcore` PrivateLink
endpoint, so its requests carry the VPC id and are allowed; a call from the
public internet (even with valid IAM credentials) is denied at the AgentCore
layer. Together with the isolated-VPC egress posture (all-VPC-endpoints, no NAT,
no internet egress), this implements **Pattern 4** ("agent in an isolated VPC")
from the AWS
[network-connectivity patterns for AgentCore](https://aws.amazon.com/blogs/networking-and-content-delivery/network-connectivity-patterns-for-agents-deployed-on-amazon-bedrock-agentcore-runtime/):
the resource-based policy provides the inbound control and the VPC endpoints
provide the private egress.

### Security notes & accepted risks

This is a self-contained demo intended for a **single-purpose account**. A few
deliberate, documented trade-offs:

- **Proxy task role uses a name-prefix wildcard for the AgentCore runtime ARN**
  (`runtime/<name>-*`). AgentCore appends a random suffix to the runtime name at
  create time, and the proxy task role is created in the DataStack *before* the
  runtime exists (to keep the stack dependency order acyclic), so the exact ARN
  isn't known when the policy is written. Exploiting the wildcard would require
  an attacker to already hold `bedrock-agentcore:CreateRuntime` in **this**
  account and create a name-colliding runtime — i.e. they'd already have a
  larger foothold. **Accepted** for a single-purpose account. For a shared
  account, tighten it to the exact ARN via a post-deploy custom resource or an
  SSM-published value.
- **Container base images are not digest-pinned.** The Dockerfiles pull
  `python:3.12-slim` by tag (from the ECR Public mirror) so each build gets the
  latest patched base; ECR scans images on push. Pin to a digest for fully
  reproducible/audited builds (see the note in each Dockerfile).
- **CloudFront→ALB defaults to HTTP** (private AWS backbone, network-level
  encryption in transit). Choose **HTTPS** at deploy time for application-layer
  end-to-end TLS on sensitive/production use (see the origin-hop section below).
- **ECS task execution role uses the AWS-managed `AmazonECSTaskExecutionRolePolicy`**
  and **CodeBuild runs privileged** for image builds — both are standard AWS
  patterns, acceptable in a single-purpose account.

## Cost Considerations

This solution deploys billable AWS resources. While idle cost is low (there is
no NAT gateway, and the agent + OpenSearch scale toward zero), the following
incur charges:

- **Amazon OpenSearch Serverless (NextGen)** collection — scales toward zero when
  idle, but bills for active indexing/search capacity (OCUs) during use.
- **Amazon ECS on AWS Fargate** proxy tasks — continuous charge while running
  (default 2 tasks for availability).
- **VPC interface endpoints** — roughly $0.01/hour each, and this solution
  provisions several (Amazon Bedrock Runtime, Amazon Bedrock AgentCore, aoss
  control + data, Amazon ECR API + Docker, Amazon CloudWatch Logs, Amazon
  Cognito, AWS X-Ray).
- **AWS WAF** web ACL and **Amazon CloudFront** distribution.
- **AWS CodeBuild** — charged per build minute during image builds (deploy time).
- **Amazon Bedrock** model invocations — per-token charges for the chat and
  embeddings models.

Run `./scripts/destroy.sh` when you are finished to remove the per-deploy
resources and stop ongoing charges (the long-lived VPC is free; see Destroy
below). Review the [AWS Pricing](https://aws.amazon.com/pricing/) pages for the
current rates in your Region.

## Prerequisites

- **Node.js 20.x or later** and **npm**
- **AWS CLI** configured with credentials for the target account/region
- **AWS CDK CLI** (`npm install -g aws-cdk`)
- Amazon Bedrock **model access** enabled in the region for the chat model
  (Claude Sonnet) and the embeddings model (Titan Text v2)

There is **no Docker/Finch requirement** — images build in AWS CodeBuild. The
whole flow works from **AWS CloudShell**.

One-time per account/region (shared infrastructure, NOT removed by destroy):

```bash
npx cdk bootstrap aws://<account-id>/<region>
```

## Deploy

```bash
cd cdk
npm install
./scripts/deploy.sh            # interactive: origin HTTP/HTTPS choice
./scripts/deploy.sh --yes      # non-interactive (HTTP origin, defaults)
```

`deploy.sh`:
1. checks credentials + CDK bootstrap (no container engine),
2. **auto-selects Availability Zones** that support both AgentCore and
   OpenSearch Serverless (nothing AZ-specific is hardcoded),
3. asks how CloudFront should reach the internal ALB (see below),
4. runs `cdk deploy --all` (Waf → Network → Build → Data → Agent → App), and
5. prints the **site URL**, demo **username**, and demo **password**.

The first deploy takes ~15-25 min (CodeBuild image builds + CloudFront + the
AgentCore runtime). Sign in at the printed URL.

### CloudFront → ALB origin hop: HTTP vs HTTPS

The browser↔CloudFront hop is always HTTPS/WSS. The CloudFront→internal-ALB hop
has two modes:

- **HTTP (default):** private over the AWS backbone to the internal ALB; zero
  prework.
- **HTTPS (opt-in, end-to-end TLS):** requires a publicly-trusted **ACM
  certificate in the stack region** and an origin hostname that matches it. The
  origin hostname needs **no public DNS record** — the VPC Origin routes to the
  ALB by ARN; the name is used only for the TLS SNI/cert match.

```bash
ALB_ORIGIN_PROTOCOL=HTTPS \
ORIGIN_CERTIFICATE_ARN=arn:aws:acm:<region>:<acct>:certificate/<id> \
ORIGIN_DOMAIN_NAME=agent-origin.example.com \
  ./scripts/deploy.sh --yes
```

> **Production recommendation:** choose **HTTPS** (Option 2) for the origin hop so
> traffic is encrypted end-to-end at the application layer (browser→CloudFront→ALB),
> satisfying "encrypt in transit everywhere" / compliance requirements (e.g. PCI,
> HIPAA). HTTP is the default only because it needs zero prework; that hop is
> private (AWS backbone → internal ALB in isolated subnets, WAF at the edge) with
> network-level encryption in transit over the AWS backbone, while HTTPS adds
> application-layer TLS terminating at the ALB. For deployments handling sensitive
> contracts, we recommend HTTPS.

## Test it

1. Open the site URL and sign in with the printed demo credentials.
2. Download `../Sample-Contract/partner-services-agreement.pdf`.
3. Attach it (📎) in the chat composer and run the live review.
4. The agent returns a structured findings report grounded in the SOPs, with an
   overall disposition (the sample is intentionally **REJECTED**).

Off-topic prompts (e.g. "what's the weather?") are refused by design.

## Destroy — fast, ordered teardown (retains the free VPC)

```bash
cd cdk
./scripts/destroy.sh                 # ordered teardown of all per-deploy stacks + verify-empty
./scripts/destroy.sh --yes           # no confirmation prompt
./scripts/destroy.sh --include-network   # ALSO remove the long-lived VPC (full teardown)
```

> **Warning — data loss:** destroy empties and deletes the S3 uploads bucket,
> which **permanently deletes any uploaded contracts and extracted text**, and
> deletes the OpenSearch Serverless collection (the indexed SOP knowledge base).
> Back up anything you need before running destroy.

By **default**, `destroy.sh` deletes every per-deploy stack in reverse
dependency order — **App → Agent → Data → Build → Waf** — and then runs a
**verify-empty** check. It removes, with no residue:

- those five CloudFormation stacks,
- the AgentCore Runtime,
- the OpenSearch Serverless collection + collection group + policies,
- every solution S3 bucket (emptied first),
- every solution **ECR repository** (images deleted first) and the CodeBuild projects,
- the Cognito user pool, the Secrets Manager secret, and all CloudWatch log groups.

It **intentionally retains the long-lived `…Network` stack** (the VPC, subnets,
security groups, and VPC endpoints). See below for why. The shared CDK bootstrap
(`CDKToolkit`) is also left untouched.

### Why the network stack is left behind (and how to remove it)

This is deliberate, for two reasons:

1. **Reuse on redeploy.** Re-running `deploy` with the same `instanceName` reuses
   the existing VPC (faster, stable) instead of building a new one. A new VPC is
   created only for a new `instanceName` or after a full `--include-network`
   teardown.
2. **AgentCore egress ENIs.** In VPC-egress mode, AgentCore injects
   **AWS-managed** network interfaces (interface-type `agentic_ai`) into your
   subnets. They are owned by AWS and **cannot be detached or deleted by you** —
   AWS releases them **automatically after the runtime is gone, typically within
   ~8 hours** (occasionally longer; see the
   [AgentCore VPC docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html)).
   While any remain attached, the VPC/subnets/SG cannot be deleted. Rather than
   block teardown waiting for AWS to reclaim them, the default destroy keeps the (free,
   NAT-less) VPC so the ENIs sit there harmlessly.

**To remove the network completely**, once AWS has released the ENIs:

```bash
# 1) wait until this prints 0:
aws ec2 describe-network-interfaces --region us-east-1 \
  --filters Name=interface-type,Values=agentic_ai \
  --query 'length(NetworkInterfaces)'

# 2) then either:
./scripts/destroy.sh --include-network
# or delete the one stack directly:
aws cloudformation delete-stack \
  --stack-name PrivateRealtimeAiAgent<Instance>Network --region us-east-1
```

> `--include-network` run while ENIs are still attached will fail on "subnet has
> dependencies" — re-run it after AWS releases the ENIs (when the count above is 0).

## Configuration (`cdk/cdk.json` → `context.agent`)

| Key | Default | Notes |
|---|---|---|
| `bedrockModelId` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | inference profile id |
| `bedrockEmbedModelId` | `amazon.titan-embed-text-v2:0` | 1024-dim Titan v2 |
| `openSearchIndex` | `agent-knowledge` | vector index name |
| `ragTopK` | `5` | 1..5 |
| `cpuArchitecture` | `X86_64` | proxy arch (the agent image is always ARM64) |
| `desiredCount` | `2` | proxy task count (≥2, spans 2 AZs) |
| `instanceName` | `demo` | namespaces stacks + collection + runtime |

Availability Zones and the AWS account/region are resolved at deploy time — none
are hardcoded. To target a different region, change only the deploy-time inputs
(`REGION=...`), no source edits.

## Build & test (offline, no AWS)

```bash
cd cdk
npm install
npx tsc --noEmit          # typecheck
npx jest                  # CDK snapshot + assertions + config tests

# Python unit tests:
cd src/container/agent && python -m pytest tests -q
cd ../proxy            && python -m pytest tests -q
```

## Repository layout

```
.
  README.md                       # this file
  DEPLOYMENT.md                   # step-by-step deployment guide
  cdk/                            # the CDK app
    bin/app.ts                    # Waf → Network → Build → Data → Agent → App
    lib/
      build-stack.ts              # cloud image builds (CodeBuild → ECR)
      network-stack.ts            # VPC + endpoints + SGs (no NAT)
      data-stack.ts               # OpenSearch NextGen + S3 + IAM roles
      agentcore-stack.ts          # AgentCore Runtime (VPC egress)
      app-stack.ts                # ALB + ECS proxy + CloudFront + Cognito
      waf-stack.ts                # CloudFront-scoped AWS WAF web ACL
      construct/                  # image-build, vpc, opensearch, agentcore, proxy, ...
    seed/                         # OpenSearch provisioner + SOP PDFs + index mapping
    src/container/agent|proxy/    # agent + proxy app code (built in the cloud)
    scripts/deploy.sh destroy.sh  # portable deploy/destroy (no container engine)
    test/                         # CDK tests
  Sample-Contract/                # downloadable sample contract (PDF)
  Agent-Documents/                # SOPs + the locked system prompt (source of truth)
```
