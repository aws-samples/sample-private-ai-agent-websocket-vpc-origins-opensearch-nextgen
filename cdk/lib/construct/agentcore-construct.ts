/**
 * AgentCore construct (v2): the Strands agent hosted in **Bedrock AgentCore
 * Runtime** instead of on ECS Fargate.
 *
 * The agent container (`src/container/agent`) is built as an **ARM64** image
 * (AgentCore requires arm64) in the cloud by BuildStack (CodeBuild → ECR) and
 * referenced here by `AgentRuntimeArtifact.fromEcrRepository`. The runtime is
 * created in **VPC egress mode** (`RuntimeNetworkConfiguration.usingVpc`) so the
 * agent's outbound calls
 * to Amazon OpenSearch Serverless and Amazon Bedrock Runtime traverse ENIs in the private
 * subnets and the existing VPC endpoints — no internet egress.
 *
 * Inbound invocations to the runtime are NOT VPC-routed by AgentCore; the
 * in-VPC ECS proxy reaches the `InvokeAgentRuntime` data-plane API privately
 * through the `com.amazonaws.{region}.bedrock-agentcore` PrivateLink endpoint
 * created in the VPC construct. {@link AgentCoreConstruct.grantInvoke} wires the
 * proxy task role's IAM permission to invoke this specific runtime. As
 * defense-in-depth, a resource-based policy (`AWS::BedrockAgentCore::Resource
 * Policy`) DENIES any invoke whose `aws:SourceVpc` is not this VPC, so the
 * runtime cannot be invoked from the public internet even with valid
 * credentials (Pattern 3 of the AWS AgentCore network-connectivity patterns).
 *
 * The execution role is scoped (least privilege) to invoke only the configured
 * chat + embeddings Bedrock models and to access only the specific OpenSearch
 * Serverless collection.
 *
 * _Requirements: 6.x (agent host), 7.1, 10.1–10.3, 11.x, 13.3_
 */
import { CfnResource, Stack } from 'aws-cdk-lib';
import { aws_bedrockagentcore as agentcore } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentConfig } from '../config';

/**
 * Props for {@link AgentCoreConstruct}.
 */
export interface AgentCoreConstructProps {
  /** The validated agent configuration. */
  readonly config: AgentConfig;

  /** The VPC the runtime's egress ENIs are placed in. */
  readonly vpc: ec2.IVpc;

  /**
   * Security group for the runtime's egress ENIs. Reuse the ECS task SG so the
   * runtime is already permitted through the interface-endpoint SG (443 to the
   * OpenSearch/Bedrock endpoints).
   */
  readonly securityGroup: ec2.ISecurityGroup;

  /**
   * The execution role AgentCore assumes. Created in the DataStack (which owns
   * the OpenSearch collection + data-access policy) and passed in here so the
   * collection's data-access policy can reference this role's ARN without a
   * cross-stack cycle. Already scoped to the chat + embed models and the
   * specific collection. (R10.3, R13.3)
   */
  readonly executionRole: iam.IRole;

  /**
   * The OpenSearch Serverless collection data-plane endpoint, injected as the
   * agent's `OPENSEARCH_ENDPOINT` env var. Deploy-time token.
   */
  readonly openSearchEndpoint: string;

  /**
   * ECR repository holding the ARM64 agent image built in the cloud by
   * BuildStack (no local container engine). The runtime references the image
   * via {@link agentImageTag}.
   */
  readonly agentImageRepository: ecr.IRepository;

  /** The agent image tag in {@link agentImageRepository} (source asset hash). */
  readonly agentImageTag: string;

  /** Subnets for the runtime egress ENIs. Defaults to the VPC isolated subnets. */
  readonly subnets?: ec2.SubnetSelection;
}

/**
 * Provisions the Bedrock AgentCore Runtime that hosts the Strands agent, in VPC
 * egress mode, with a least-privilege execution role (created in the DataStack).
 */
export class AgentCoreConstruct extends Construct {
  /** The AgentCore Runtime. */
  public readonly runtime: agentcore.Runtime;

  /** The named runtime endpoint (stable invoke target). */
  public readonly endpoint: agentcore.RuntimeEndpoint;

  /** The runtime ARN (consumed by the proxy as `AGENT_RUNTIME_ARN`). */
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;

    // --- Agent container image (ARM64 — AgentCore requirement) -------------
    // Built in the cloud by BuildStack (CodeBuild → ECR); NO local container
    // engine. The runtime references the image from the ECR repository by tag.
    // In tests (`testSynth` context) a registry placeholder is used so the
    // stack synthesizes offline.
    const testSynth =
      this.node.tryGetContext('testSynth') === true ||
      this.node.tryGetContext('testSynth') === 'true';

    const artifact = testSynth
      ? agentcore.AgentRuntimeArtifact.fromImageUri(
          // Placeholder ECR URI for offline synth only (never deployed in tests).
          `${Stack.of(this).account}.dkr.ecr.${region}.amazonaws.com/agentcore-agent:test`,
        )
      : agentcore.AgentRuntimeArtifact.fromImageUri(
          // The image is built in the cloud by BuildStack (CodeBuild → ECR).
          // We reference it by URI rather than `fromEcrRepository` on purpose:
          // `fromEcrRepository().bind()` calls `repository.grantPull(role)` on
          // the AgentCore execution role — but that role is owned by DataStack
          // and the repo by BuildStack, producing an inconsistent triangular
          // cross-stack reference. The ECR pull grant is instead made
          // explicitly in DataStack (where the role lives) as a clean
          // Data → Build reference. `fromImageUri().bind()` is a no-op.
          props.agentImageRepository.repositoryUriForTag(props.agentImageTag),
        );

    // --- Runtime (VPC egress mode) -----------------------------------------
    this.runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName: props.config.agentRuntimeName,
      agentRuntimeArtifact: artifact,
      executionRole: props.executionRole,
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
        vpc: props.vpc,
        vpcSubnets: props.subnets ?? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [props.securityGroup],
      }),
      environmentVariables: {
        AWS_REGION: region,
        BEDROCK_MODEL_ID: props.config.bedrockModelId,
        BEDROCK_EMBED_MODEL_ID: props.config.bedrockEmbedModelId,
        OPENSEARCH_ENDPOINT: props.openSearchEndpoint,
        OPENSEARCH_INDEX: props.config.openSearchIndex,
        RAG_TOP_K: String(props.config.ragTopK),
        // Per-request aoss read timeout (seconds). Larger than opensearch-py's
        // 10s default so the first query after a fresh deploy rides out the
        // NextGen scale-from-zero warm-up instead of logging a ReadTimeoutError.
        OPENSEARCH_TIMEOUT: String(props.config.openSearchTimeout),
      },
      description: 'Strands agent for the Private Real-Time AI Agent (v2, AgentCore)',
      tracingEnabled: true,
    });

    // Named endpoint as the stable invoke target for the proxy.
    this.endpoint = this.runtime.addEndpoint('live', {
      description: 'Stable invoke endpoint for the ECS proxy',
    });

    this.runtimeArn = this.runtime.agentRuntimeArn;

    // --- Inbound hardening: resource-based policy (Pattern 3) --------------
    // Defense-in-depth on the AGENT'S OWN inbound surface. By default an
    // AgentCore Runtime can be invoked by any IAM principal with the right
    // identity-based permission from anywhere (including the public internet).
    // Our only intended caller is the in-VPC ECS proxy, which reaches
    // `InvokeAgentRuntime` PRIVATELY over the `bedrock-agentcore` PrivateLink
    // endpoint — so those requests carry our VPC id in `aws:SourceVpc`.
    //
    // This resource-based policy DENIES every invoke/management call whose
    // `aws:SourceVpc` is not our VPC. Even a leaked credential cannot invoke the
    // runtime from outside the VPC. We use an explicit Deny (not Allow) so the
    // existing identity-based grant on the proxy task role still governs
    // *who* may invoke; this policy only constrains *from where*.
    //
    // `aws:SourceVpc` is absent on requests that don't traverse a VPC endpoint
    // (e.g. public-internet calls), so `Null`-guarding it would be bypassable;
    // instead we Deny when SourceVpc is present-and-not-ours OR absent, by
    // denying unless it equals our VPC. A request with no `aws:SourceVpc` key
    // fails the `StringEquals`, so it is denied. (Pattern 3 from the AWS
    // "network connectivity patterns for AgentCore" blog.)
    //
    // No L2/L1 construct exists for `AWS::BedrockAgentCore::ResourcePolicy` in
    // this CDK version, so we use the CfnResource escape hatch. NOTE: the
    // PutResourcePolicy API requires the statement's `Resource` to be EXACTLY
    // the single runtime ARN that matches `ResourceArn` (it rejects an array or
    // a `/*` wildcard variant), so `Resource` is the bare runtime ARN.
    const vpcId = props.vpc.vpcId;
    const resourcePolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInvokeOutsideVpc',
          Effect: 'Deny',
          Principal: '*',
          Action: [
            'bedrock-agentcore:InvokeAgentRuntime',
            'bedrock-agentcore:InvokeAgentRuntimeForUser',
          ],
          Resource: this.runtimeArn,
          Condition: {
            StringNotEquals: { 'aws:SourceVpc': vpcId },
          },
        },
      ],
    };

    const cfnResourcePolicy = new CfnResource(this, 'RuntimeResourcePolicy', {
      type: 'AWS::BedrockAgentCore::ResourcePolicy',
      properties: {
        ResourceArn: this.runtimeArn,
        Policy: Stack.of(this).toJsonString(resourcePolicy),
      },
    });
    // The policy targets the runtime by ARN, so it must be created after the
    // runtime exists and removed before it (the endpoint is part of the runtime).
    cfnResourcePolicy.node.addDependency(this.runtime);
  }

  /**
   * Grant a principal (the ECS proxy task role) permission to invoke this
   * runtime via `bedrock-agentcore:InvokeAgentRuntime`, scoped to this runtime
   * ARN (and its sessions). (R13.3)
   */
  public grantInvoke(grantee: iam.IGrantable): void {
    this.runtime.grantInvoke(grantee);
  }
}

