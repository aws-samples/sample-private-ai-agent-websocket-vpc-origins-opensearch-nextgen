/**
 * OpenSearch construct (v2): API-driven Amazon OpenSearch Serverless **NextGen**
 * provisioner.
 *
 * OpenSearch Serverless NextGen is selected by creating a **collection group**
 * with `generation=NEXTGEN` and scale-to-zero capacity limits
 * (`minIndexingCapacityInOCU=0`, `minSearchCapacityInOCU=0`), then creating the
 * VECTORSEARCH collection associated with that group. None of this is reliably
 * expressible through CloudFormation, so this construct creates NO
 * `AWS::OpenSearchServerless::*` CFN resources and instead deploys a single
 * in-VPC custom-resource Lambda (`seed/provisioner_handler.py`) that calls the
 * `opensearchserverless` API directly to create the collection group, the
 * encryption / network / data-access policies, the collection, the
 * `knn_vector` index, and to seed the sample documents.
 *
 * The collection endpoint and ARN are deploy-time tokens read from the custom
 * resource response. Data-access principals (the AgentCore execution role) can
 * be added after construction via {@link OpenSearchConstruct.addDataAccessPrincipal}
 * (resolved through a {@link Lazy} list so the principal ARN can be a token from
 * a sibling construct created later).
 *
 * _Requirements: 11.1, 11.2, 11.5, 11.9_
 */
import * as path from 'path';
import { execSync } from 'child_process';
import { CustomResource, Duration, Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/** Absolute path to the `cdk/seed/` directory bundled into the provisioner Lambda. */
const SEED_DIR = path.join(__dirname, '../../seed');

/**
 * Props for {@link OpenSearchConstruct}.
 */
export interface OpenSearchConstructProps {
  /** Collection name (3-28 chars, lowercase letters/numbers/hyphen, starts with a letter). */
  readonly collectionName: string;

  /** The vector index name the provisioner creates and seeds. */
  readonly indexName: string;

  /** The OpenSearch Serverless data-plane VPC endpoint id (`vpce-...`). (R11) */
  readonly aossEndpointId: string;

  /** The Amazon Bedrock embeddings model id used to embed the sample documents. (R11.9) */
  readonly bedrockEmbedModelId: string;

  /** The VPC that hosts the provisioner Lambda (private-isolated subnets). */
  readonly vpc: ec2.IVpc;

  /** Security group for the provisioner Lambda (reuse the ECS task SG). (R13.5) */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;

  /**
   * The OpenSearch Serverless generation. `NEXTGEN` provisions a NextGen
   * collection group (scale-to-zero) and associates the collection with it;
   * `CLASSIC` skips the collection group. (R11.1, R11.2)
   *
   * @default 'NEXTGEN'
   */
  readonly generation?: 'NEXTGEN' | 'CLASSIC';

  /**
   * Optional S3 bucket name where the provisioner stores the original SOP PDFs
   * (the durable source copy of the PDF-only knowledge base). When set, it is
   * injected as the provisioner's `UPLOAD_BUCKET` env var; the caller is
   * responsible for granting the provisioner role write access to the `sops/*`
   * prefix.
   */
  readonly sopBucketName?: string;

  /** Subnets for the provisioner Lambda. Defaults to the VPC's isolated subnets. */
  readonly subnets?: ec2.SubnetSelection;
}

/**
 * Provisions OpenSearch Serverless NextGen via an in-VPC custom-resource Lambda.
 */
export class OpenSearchConstruct extends Construct {
  /** The provisioner Lambda. */
  public readonly provisionerFunction: lambda.Function;

  /** The custom resource backed by the provisioner Lambda. */
  public readonly customResource: CustomResource;

  /** Collection data-plane endpoint, e.g. `https://<id>.<region>.aoss.amazonaws.com`. */
  public readonly collectionEndpoint: string;

  /** The collection ARN (from the provisioner response). */
  public readonly collectionArn: string;

  /** The collection id (from the provisioner response). */
  public readonly collectionId: string;

  /** The resolved collection name. */
  public readonly collectionName: string;

  /**
   * Extra data-access principal ARNs to add to the data-access policy, resolved
   * lazily so callers can pass tokens from sibling constructs created after this
   * one. Always includes the provisioner Lambda's own role.
   */
  private readonly extraDataAccessPrincipals: string[] = [];

  constructor(scope: Construct, id: string, props: OpenSearchConstructProps) {
    super(scope, id);

    this.collectionName = props.collectionName;
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const generation = props.generation ?? 'NEXTGEN';

    const testSynth =
      this.node.tryGetContext('testSynth') === true ||
      this.node.tryGetContext('testSynth') === 'true';

    // Bundle the provisioner Lambda's Python deps WITHOUT a local container
    // engine. CDK's `local` bundler runs `pip install` directly on the host
    // (works in AWS CloudShell and any machine with python3 + pip). The Docker
    // `image` is only a fallback CDK uses if local bundling reports it cannot
    // run — so a normal deploy needs no Docker/Finch. (No-local-engine goal.)
    const code = testSynth
      ? lambda.Code.fromAsset(SEED_DIR)
      : lambda.Code.fromAsset(SEED_DIR, {
          bundling: {
            image: lambda.Runtime.PYTHON_3_12.bundlingImage, // fallback only
            command: [
              'bash',
              '-c',
              ['pip install -r requirements.txt -t /asset-output', 'cp -au . /asset-output'].join(
                ' && ',
              ),
            ],
            local: {
              tryBundle(outputDir: string): boolean {
                // Prefer python3.12, then python3, then python; pip target install.
                const py = ['python3.12', 'python3', 'python'].find((cmd) => {
                  try {
                    execSync(`${cmd} --version`, { stdio: 'ignore' });
                    return true;
                  } catch {
                    return false;
                  }
                });
                if (!py) {
                  return false; // no host python -> let CDK fall back to Docker
                }
                try {
                  execSync(
                    `${py} -m pip install -r requirements.txt -t "${outputDir}"`,
                    { cwd: SEED_DIR, stdio: 'inherit' },
                  );
                  // Copy the handler + seed assets alongside the installed deps.
                  execSync(
                    `cp -a "${SEED_DIR}/." "${outputDir}/"`,
                    { stdio: 'inherit' },
                  );
                  return true;
                } catch {
                  return false; // local bundling failed -> fall back to Docker
                }
              },
            },
          },
        });

    this.provisionerFunction = new lambda.Function(this, 'ProvisionerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'provisioner_handler.handler',
      code,
      timeout: Duration.minutes(15),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: props.subnets ?? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        COLLECTION_NAME: props.collectionName,
        OPENSEARCH_INDEX: props.indexName,
        BEDROCK_EMBED_MODEL_ID: props.bedrockEmbedModelId,
        AOSS_VPC_ENDPOINT_ID: props.aossEndpointId,
        GENERATION: generation,
        // S3 bucket for the durable SOP PDF source copy (empty = skip storage).
        UPLOAD_BUCKET: props.sopBucketName ?? '',
        LAMBDA_ROLE_ARN: '', // set below once the role exists
      },
      description:
        'Provisions OpenSearch Serverless NextGen (collection group + policies + ' +
        'collection + index + seed) via the aoss API',
    });

    this.provisionerFunction.addEnvironment(
      'LAMBDA_ROLE_ARN',
      this.provisionerFunction.role!.roleArn,
    );
    // The Lambda's own role is always a data-access principal.
    this.extraDataAccessPrincipals.push(this.provisionerFunction.role!.roleArn);

    // --- IAM: control plane + data plane + bedrock embed -------------------
    this.provisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AossControlPlaneBootstrap',
        effect: iam.Effect.ALLOW,
        // The provisioner is a deploy-time BOOTSTRAP admin: it creates the
        // NextGen collection group, the encryption/network/data-access
        // policies, the collection, and associates them, then (data plane)
        // creates the index. NextGen aoss control-plane actions do not support
        // resource-level scoping (resources must be `*`), but we enumerate the
        // SPECIFIC actions the provisioner calls instead of granting `aoss:*`,
        // so a compromised bootstrap role cannot, e.g., DeleteCollection or
        // rewrite unrelated access policies. The security-sensitive
        // RUNTIME principals (ECS proxy task role + AgentCore execution role)
        // remain tightly scoped to specific ARNs.
        actions: [
          // Collection group lifecycle.
          'aoss:CreateCollectionGroup',
          'aoss:UpdateCollectionGroup',
          'aoss:DeleteCollectionGroup',
          'aoss:BatchGetCollectionGroup',
          'aoss:ListCollectionGroups',
          'aoss:AddCollectionToCollectionGroup',
          // Collection lifecycle.
          'aoss:CreateCollection',
          'aoss:DeleteCollection',
          'aoss:BatchGetCollection',
          'aoss:ListCollections',
          // Security/network/encryption + data-access policies.
          'aoss:CreateSecurityPolicy',
          'aoss:UpdateSecurityPolicy',
          'aoss:GetSecurityPolicy',
          'aoss:DeleteSecurityPolicy',
          'aoss:ListSecurityPolicies',
          'aoss:CreateAccessPolicy',
          'aoss:UpdateAccessPolicy',
          'aoss:GetAccessPolicy',
          'aoss:DeleteAccessPolicy',
          'aoss:ListAccessPolicies',
          // Data-plane access (index create/seed) — required for the bootstrap
          // index mapping + seed bulk load.
          'aoss:APIAccessAll',
        ],
        // aoss control-plane actions do not support resource-level permissions.
        resources: ['*'],
      }),
    );
    // The FIRST OpenSearch Serverless collection created in an account requires
    // the aoss service-linked role (AWSServiceRoleForAmazonOpenSearchServerless
    // for observability.aoss.amazonaws.com). aoss creates it during
    // CreateCollection, which needs iam:CreateServiceLinkedRole. Without this,
    // a brand-new account fails the first deploy with an IAM AccessDenied on
    // CreateCollection. Scoped to ONLY that service-linked role (exact ARN path
    // + iam:AWSServiceName condition), so the bootstrap role cannot create any
    // other role. On accounts that already have the SLR this is a harmless
    // no-op (aoss does not recreate it), keeping the deploy portable.
    this.provisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAossServiceLinkedRoleCreation',
        effect: iam.Effect.ALLOW,
        actions: ['iam:CreateServiceLinkedRole'],
        resources: [
          'arn:aws:iam::*:role/aws-service-role/observability.aoss.amazonaws.com/AWSServiceRoleForAmazonOpenSearchServerless',
        ],
        conditions: {
          StringEquals: { 'iam:AWSServiceName': 'observability.aoss.amazonaws.com' },
        },
      }),
    );
    this.provisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeEmbeddingsModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${region}::foundation-model/${props.bedrockEmbedModelId}`],
      }),
    );

    const provisionerProviderLogGroup = new logs.LogGroup(this, 'ProvisionerProviderLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const provider = new cr.Provider(this, 'ProvisionerProvider', {
      onEventHandler: this.provisionerFunction,
      logGroup: provisionerProviderLogGroup,
    });

    this.customResource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      removalPolicy: RemovalPolicy.DESTROY,
      properties: {
        CollectionName: props.collectionName,
        IndexName: props.indexName,
        Generation: generation,
        // Include the aoss data-plane VPC endpoint id as a custom-resource
        // PROPERTY (not just a Lambda env var) so that any change to the
        // endpoint id triggers the custom resource to re-run and rewrite the
        // network policy's SourceVPCEs. (Env-var-only changes do NOT re-invoke
        // a CloudFormation custom resource.)
        AossVpcEndpointId: props.aossEndpointId,
        // Data-access principals resolved lazily (provisioner role + any added
        // later, e.g. the AgentCore execution role). Joined as a comma string so
        // the value is a single resolvable token.
        DataAccessPrincipals: Lazy.string({
          produce: () => this.extraDataAccessPrincipals.join(','),
        }),
        // Bump to force re-provisioning/re-seeding on each deploy.
        Revision: '4',
      },
    });

    this.collectionEndpoint = this.customResource.getAttString('CollectionEndpoint');
    this.collectionArn = this.customResource.getAttString('CollectionArn');
    this.collectionId = this.customResource.getAttString('CollectionId');
  }

  /**
   * Add a data-access principal ARN (e.g. the AgentCore execution role) to the
   * collection's data-access policy. Safe to call with a CDK token; resolved
   * lazily into the custom resource's `DataAccessPrincipals` property.
   */
  public addDataAccessPrincipal(roleArn: string): void {
    this.extraDataAccessPrincipals.push(roleArn);
  }
}
