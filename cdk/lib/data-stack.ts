/**
 * DataStack (v2) — stateful data layer: Amazon OpenSearch Serverless NextGen + Amazon S3 uploads.
 *
 * Owns:
 *   - the API-driven OpenSearch Serverless NextGen collection (provisioner Lambda),
 *   - the S3 uploads bucket (user documents + extracted text), and
 *   - the **AgentCore execution role**.
 *
 * Why the AgentCore execution role lives here (not in the AgentStack): the
 * OpenSearch collection's data-access policy must name the agent's role as a
 * principal, and the agent's role needs the collection ARN — a cross-stack
 * cycle if they were in different stacks pointing at each other. Creating the
 * role in this stack (which also owns the collection) breaks the cycle: the
 * dependency flows strictly Network -> Data -> Agent -> App. The AgentStack
 * simply consumes this role by ARN.
 *
 * This stack is destroyed/redeployed independently of the long-lived
 * NetworkStack. Its in-VPC provisioner Lambda still creates Hyperplane ENIs, but
 * because the VPC itself is NOT torn down with this stack, a destroy here is not
 * gated on the slow VPC/ENI teardown.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentConfig } from './config';
import { bedrockModelArns } from './bedrock-arns';
import { OpenSearchConstruct } from './construct/opensearch-construct';
import { UploadsConstruct } from './construct/uploads-construct';

/** Props for {@link DataStack}. */
export interface DataStackProps extends StackProps {
  config: AgentConfig;
  vpc: ec2.IVpc;
  /** SG reused for the in-VPC provisioner Lambda (the shared ECS task SG). */
  lambdaSecurityGroup: ec2.ISecurityGroup;
  /** The aoss data-plane VPC endpoint id (for the network policy SourceVPCEs). */
  aossVpcEndpointId: string;
  /**
   * ECR repository holding the ARM64 agent image (built in BuildStack). The
   * AgentCore execution role (created in this stack) is granted pull on it here,
   * as a clean Data → Build cross-stack reference. See the note in
   * agentcore-construct where the artifact is referenced by URI (not
   * `fromEcrRepository`) to avoid a triangular grant.
   */
  agentImageRepository: ecr.IRepository;
}

/** OpenSearch NextGen + S3 uploads + the AgentCore execution role. */
export class DataStack extends Stack {
  public readonly openSearch: OpenSearchConstruct;
  public readonly uploads: UploadsConstruct;

  /** The AgentCore execution role (consumed by the AgentStack). */
  public readonly agentExecutionRole: iam.Role;

  /**
   * The ECS proxy task role (consumed by the AppStack). Created here — not in
   * the AppStack — so it can be a data-access principal on the collection
   * without a cross-stack cycle. InvokeAgentRuntime is scoped to the runtime
   * NAME (a wildcard ARN built from config) so this role needs no reference to
   * the AgentStack.
   */
  public readonly proxyTaskRole: iam.Role;

  /** Deploy-time tokens consumed by downstream stacks. */
  public readonly collectionArn: string;
  public readonly collectionEndpoint: string;
  public readonly uploadBucketName: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config } = props;

    // --- S3 uploads bucket (created first so the OpenSearch provisioner can
    //     store the durable SOP PDF source copy under sops/) ----------------
    this.uploads = new UploadsConstruct(this, 'Uploads', {});

    // --- OpenSearch Serverless NextGen (API-driven provisioner) ------------
    this.openSearch = new OpenSearchConstruct(this, 'OpenSearch', {
      collectionName: config.collectionName,
      indexName: config.openSearchIndex,
      aossEndpointId: props.aossVpcEndpointId,
      bedrockEmbedModelId: config.bedrockEmbedModelId,
      vpc: props.vpc,
      lambdaSecurityGroup: props.lambdaSecurityGroup,
      generation: 'NEXTGEN',
      sopBucketName: this.uploads.bucket.bucketName,
    });

    // The provisioner stores the original SOP PDFs under sops/ — grant its role
    // write access to that prefix only.
    this.uploads.bucket.grantPut(this.openSearch.provisionerFunction, 'sops/*');

    const chatArns = bedrockModelArns(this.region, this.account, config.bedrockModelId);
    const embedArns = bedrockModelArns(this.region, this.account, config.bedrockEmbedModelId);

    // --- AgentCore execution role (created here to break the cycle) --------
    this.agentExecutionRole = new iam.Role(this, 'AgentExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the AgentCore-hosted Strands agent (v2)',
    });
    this.agentExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeScopedModels',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [...chatArns, ...embedArns],
      }),
    );
    this.agentExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AossApiAccessScopedCollection',
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: [this.openSearch.collectionArn],
      }),
    );

    // ECR pull for the ARM64 agent image (built in BuildStack). Granted here —
    // where the execution role lives — as a clean Data → Build reference. (The
    // AgentCore Runtime references the image by URI, not `fromEcrRepository`, so
    // it does NOT also try to grant pull from the AgentStack; see
    // agentcore-construct.) `grantPull` adds the repo-scoped ECR read actions
    // plus the account-wide `ecr:GetAuthorizationToken`.
    props.agentImageRepository.grantPull(this.agentExecutionRole);

    // --- Proxy task role (created here so it can be a data-access principal) --
    // InvokeAgentRuntime is scoped to the runtime NAME via a wildcard ARN built
    // from config (AgentCore appends a random suffix to the name at create time,
    // so the exact ARN isn't known here — the name-prefix wildcard keeps this
    // least-privilege without forcing a dependency on the AgentStack).
    const runtimeArnWildcard = `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:runtime/${config.agentRuntimeName}-*`;
    this.proxyTaskRole = new iam.Role(this, 'ProxyTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Proxy task role: invoke the AgentCore runtime + upload ingestion (v2)',
    });
    this.proxyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeAgentRuntime',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeForUser',
        ],
        resources: [runtimeArnWildcard, `${runtimeArnWildcard}/*`],
      }),
    );
    this.proxyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AossApiAccessForUploads',
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: [this.openSearch.collectionArn],
      }),
    );
    this.proxyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockEmbedForUploads',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [...embedArns],
      }),
    );
    // Scoped S3 read/write to the upload prefixes (identity-side grant; no bucket
    // policy edit, so no cross-stack cycle).
    this.proxyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3UploadsReadWrite',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          `${this.uploads.bucket.bucketArn}/uploads/*`,
          `${this.uploads.bucket.bucketArn}/extracted/*`,
        ],
      }),
    );
    // The uploads bucket is encrypted with a customer-managed KMS key,
    // so reading/writing objects requires KMS Decrypt + GenerateDataKey on that
    // key. The S3 statement above grants object access; this grants the matching
    // key usage. (The provisioner's `grantPut` above gets its KMS grant
    // automatically because it uses the CDK grant API.)
    this.uploads.encryptionKey.grantEncryptDecrypt(this.proxyTaskRole);

    // Both roles are OpenSearch data-access principals (same stack, no cycle).
    this.openSearch.addDataAccessPrincipal(this.agentExecutionRole.roleArn);
    this.openSearch.addDataAccessPrincipal(this.proxyTaskRole.roleArn);

    this.collectionArn = this.openSearch.collectionArn;
    this.collectionEndpoint = this.openSearch.collectionEndpoint;
    this.uploadBucketName = this.uploads.bucket.bucketName;

    new CfnOutput(this, 'CollectionEndpoint', { value: this.collectionEndpoint });
    new CfnOutput(this, 'UploadBucket', { value: this.uploadBucketName });
  }
}
