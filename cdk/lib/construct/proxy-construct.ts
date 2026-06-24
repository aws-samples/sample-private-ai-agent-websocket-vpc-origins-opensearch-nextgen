/**
 * Proxy construct (v2): the Amazon ECS on AWS Fargate service that runs the thin
 * **WebSocket <-> SSE proxy** in front of the AgentCore Runtime.
 *
 * In v1 this service ran the Strands agent. In v2 the agent moved to AgentCore
 * Runtime, and this service is demoted to a stateless proxy that:
 *   - serves the demo SPA at `GET /` (default CloudFront behavior),
 *   - terminates the browser WebSocket at `/ws`,
 *   - exposes `POST /invocations` + `/api/invocations`, and
 *   - bridges each request to `bedrock-agentcore:InvokeAgentRuntime` over the
 *     `bedrock-agentcore` PrivateLink endpoint, re-emitting the runtime's SSE
 *     stream as the v1 WebSocket wire protocol.
 *
 * Mirrors the v1 ECS construct's networking/health/logging/rollout settings, but
 * the task role only ever receives `InvokeAgentRuntime` on the specific runtime
 * (granted by {@link AgentCoreConstruct.grantInvoke}); it has no Bedrock or aoss
 * permissions (those live on the AgentCore execution role).
 *
 * _Requirements: 2.3, 2.4, 5.1, 6.1, 6.3, 6.5, 6.6, 7.2_
 */
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AgentConfig } from '../config';

/**
 * Optional Cognito wiring for the proxy (enables self-hosted login enforcement).
 */
export interface ProxyAuthOptions {
  readonly userPoolId: string;
  readonly clientId: string;
}

/**
 * Optional document-upload wiring for the proxy (S3 + OpenSearch ingestion).
 */
export interface ProxyUploadsOptions {
  /** S3 bucket name for uploaded documents + extracted text. */
  readonly uploadBucket: string;
  /** OpenSearch Serverless data-plane endpoint for ingestion. */
  readonly openSearchEndpoint: string;
  /** Vector index name (shared with the seed corpus). */
  readonly openSearchIndex: string;
  /** Bedrock embeddings model id used to embed uploaded chunks. */
  readonly bedrockEmbedModelId: string;
}

/**
 * Props for {@link ProxyConstruct}.
 */
export interface ProxyConstructProps {
  /** The VPC that hosts the cluster and the Fargate proxy tasks. */
  readonly vpc: ec2.IVpc;

  /** Security group attached to the proxy tasks (created by the VPC construct). */
  readonly ecsTaskSg: ec2.ISecurityGroup;

  /** The internal ALB target group the service registers its tasks with. */
  readonly targetGroup: elbv2.IApplicationTargetGroup;

  /** The validated agent configuration. */
  readonly config: AgentConfig;

  /**
   * The AgentCore Runtime ARN the proxy invokes, injected as the container
   * `AGENT_RUNTIME_ARN` env var. Deploy-time token.
   */
  readonly agentRuntimeArn: string;

  /**
   * The task role for the proxy. Created in the DataStack (so it can be an
   * OpenSearch data-access principal without a cross-stack cycle) and passed in
   * here; it already holds InvokeAgentRuntime + aoss + bedrock-embed + S3.
   */
  readonly taskRole: iam.IRole;

  /**
   * ECR repository holding the proxy image built in the cloud by BuildStack
   * (no local container engine). Referenced via {@link imageTag}.
   */
  readonly imageRepository: ecr.IRepository;

  /** The proxy image tag in {@link imageRepository} (source asset hash). */
  readonly imageTag: string;

  /** Optional Cognito auth wiring. When set, the proxy enforces Hosted-UI login. */
  readonly auth?: ProxyAuthOptions;

  /** Optional document-upload wiring (S3 + OpenSearch ingestion). */
  readonly uploads?: ProxyUploadsOptions;
}

/**
 * Provisions the ECS on AWS Fargate service that runs the proxy container.
 */
export class ProxyConstruct extends Construct {
  /** The ECS cluster. */
  public readonly cluster: ecs.Cluster;

  /** The Fargate task definition for the proxy container. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  /** The Fargate service that runs and maintains the proxy tasks. */
  public readonly service: ecs.FargateService;

  /** The proxy task role (injected from the DataStack). */
  public readonly taskRole: iam.IRole;

  /** The CloudWatch log group that receives the proxy logs. */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ProxyConstructProps) {
    super(scope, id);

    const { vpc, ecsTaskSg, targetGroup, config } = props;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      // containerInsightsV2 replaces the deprecated `containerInsights` boolean;
      // both map to the same underlying ECS ClusterSettings, so this is a no-op
      // for the deployed cluster (default DISABLED).
      containerInsightsV2: config.containerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
    });

    // Task role is created in the DataStack (so it can be an aoss data-access
    // principal without a cycle) and injected here.
    this.taskRole = props.taskRole;

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role (ECR pull + CloudWatch Logs)',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // The proxy is a light Python ASGI app; the CPU arch follows config. The
    // image is built for the matching platform in the cloud by BuildStack.
    const isArm = config.cpuArchitecture === 'ARM64';
    const cpuArchitecture = isArm ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64;

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture,
      },
      taskRole: this.taskRole,
      executionRole,
    });

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const testSynth =
      this.node.tryGetContext('testSynth') === true ||
      this.node.tryGetContext('testSynth') === 'true';
    const image = testSynth
      ? ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/python:3.12-slim')
      : ecs.ContainerImage.fromEcrRepository(props.imageRepository, props.imageTag);

    const containerEnv: Record<string, string> = {
      PORT: '8080',
      AWS_REGION: Stack.of(this).region,
      AGENT_RUNTIME_ARN: props.agentRuntimeArn,
    };

    // --- Optional Cognito auth (self-hosted login enforcement) -------------
    if (props.auth) {
      containerEnv.COGNITO_USER_POOL_ID = props.auth.userPoolId;
      containerEnv.COGNITO_CLIENT_ID = props.auth.clientId;
    }

    // --- Optional document upload + ingestion ------------------------------
    // The task role's IAM (aoss/bedrock/S3) is granted in the DataStack; here we
    // only inject the env the proxy reads.
    if (props.uploads) {
      containerEnv.UPLOAD_BUCKET = props.uploads.uploadBucket;
      containerEnv.OPENSEARCH_ENDPOINT = props.uploads.openSearchEndpoint;
      containerEnv.OPENSEARCH_INDEX = props.uploads.openSearchIndex;
      containerEnv.BEDROCK_EMBED_MODEL_ID = props.uploads.bedrockEmbedModelId;
    }

    this.taskDefinition.addContainer('ProxyContainer', {
      image,
      portMappings: [{ containerPort: 8080 }], // R7.2
      environment: containerEnv,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'proxy', logGroup: this.logGroup }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q -O- http://localhost:8080/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: config.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [ecsTaskSg],
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    this.service.attachToApplicationTargetGroup(targetGroup);
  }
}
