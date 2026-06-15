/**
 * VPC construct: VPC + IGW (attached, unrouted) + interface/gateway VPC endpoints
 * and the shared security groups.
 *
 * Adopts the validated reference pattern from
 * `non-97/aws-cdk-cloudfront-websockets-vpc-origins`, extended so that the
 * interface endpoints span both Availability Zones (R2.5 / R2.8).
 *
 * Implements task 2.1.
 * _Requirements: 2.1, 2.5, 2.6, 2.7, 2.8, 2.9, 13.5_
 */
import { Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { AgentConfig } from '../config';

/**
 * Props for {@link VpcConstruct}.
 *
 * The construct does not currently require any configuration, but it optionally
 * accepts the resolved {@link AgentConfig} so future wiring can influence the
 * networking layer without changing the construct's signature.
 */
export interface VpcConstructProps {
  /** The validated agent configuration (optional). */
  readonly config?: AgentConfig;
}

/**
 * Provisions the private-isolated VPC for the solution.
 *
 * Topology:
 * - One L2 {@link ec2.Vpc} with `natGateways: 0`, `maxAzs: 2`, and a single
 *   `PRIVATE_ISOLATED` subnet configuration (`cidrMask: 24`). No public
 *   subnets, so the private subnets span >=2 AZs with no route off-VPC. (R2.1)
 * - An internet gateway attached with L1 constructs (CloudFront VPC Origins
 *   provisioning prerequisite) but with **no route** added to it from any
 *   private subnet route table, keeping the subnets isolated. (R2.7)
 * - Interface VPC endpoints (private DNS enabled) deployed across both AZs for
 *   `ecr.api`, `ecr.dkr`, `logs`, `bedrock-runtime`, and `aoss`. (R2.5, R2.8)
 * - An S3 gateway endpoint associated with the private route tables. (R2.9)
 * - Shared security groups: `endpointSg` (443 only from `ecsTaskSg`), `albSg`,
 *   and `ecsTaskSg`. (R13.5)
 */
export class VpcConstruct extends Construct {
  /** The provisioned VPC. */
  public readonly vpc: ec2.Vpc;

  /** Security group for the internal ALB (ingress configured by the ALB construct). */
  public readonly albSg: ec2.SecurityGroup;

  /** Security group attached to the ECS Fargate tasks. */
  public readonly ecsTaskSg: ec2.SecurityGroup;

  /** Security group shared by the interface VPC endpoints (443 only from `ecsTaskSg`). */
  public readonly endpointSg: ec2.SecurityGroup;

  /**
   * The OpenSearch Serverless (`aoss`) VPC endpoint id, exposed so the
   * OpenSearch network policy can reference it in `SourceVPCEs`.
   *
   * This is a **managed OpenSearch Serverless VPC endpoint**
   * (`AWS::OpenSearchServerless::VpcEndpoint`), not a generic
   * `AWS::EC2::VPCEndpoint`. The Serverless data plane requires its own endpoint
   * type, which provisions the private DNS for the collection's
   * `*.{region}.aoss.amazonaws.com` hostname so clients inside the VPC can reach
   * it. A generic `aoss` interface endpoint covers only the control plane and
   * leaves the collection hostname resolving to an unreachable address. (R2.5, R11.3)
   */
  public readonly aossVpcEndpointId: string;

  constructor(scope: Construct, id: string, props: VpcConstructProps = {}) {
    super(scope, id);

    // --- VPC (private-isolated, no NAT) ------------------------------------
    // Reference pattern: a single PRIVATE_ISOLATED subnet config across 2 AZs.
    //
    // AZ selection: Bedrock AgentCore Runtime only supports a subset of AZs per
    // region (by AZ ID). The AgentCore VPC-egress ENIs reuse this VPC's subnets,
    // so the VPC must span ONLY AgentCore-supported AZs — otherwise runtime
    // creation fails with "subnets are in unsupported availability zones". When
    // `config.availabilityZones` is provided we pin the VPC to those AZ names;
    // otherwise we fall back to `maxAzs: 2`. (Explicit AZs require the stack to
    // have a concrete env, which it does.)
    const explicitAzs = props.config?.availabilityZones ?? [];
    const useExplicitAzs = explicitAzs.length >= 2;

    this.vpc = new ec2.Vpc(this, 'Default', {
      ipAddresses: ec2.IpAddresses.cidr('10.10.8.0/22'),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      ...(useExplicitAzs ? { availabilityZones: explicitAzs } : { maxAzs: 2 }),
      subnetConfiguration: [
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      // S3 gateway endpoint associated with the private (isolated) route tables
      // so ECR image layers stored in S3 are reachable without an IGW. (R2.9)
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // --- Internet gateway: attached but unrouted ---------------------------
    // An L2 Vpc will not create an IGW without a public subnet. CloudFront VPC
    // Origins require an IGW attached to the VPC, so attach one explicitly with
    // L1 constructs. Critically, NO route to this IGW is added to any private
    // subnet route table, so the isolated subnets remain isolated. (R2.7, R2.1)
    const igw = new ec2.CfnInternetGateway(this, 'InternetGateway');
    new ec2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', {
      vpcId: this.vpc.vpcId,
      internetGatewayId: igw.ref,
    });

    // --- Security groups ---------------------------------------------------
    // Network least-privilege: SGs deny all egress by default and only
    // the specific flows this solution needs are added explicitly. The subnets
    // are already isolated (no NAT/IGW route), so this is defense-in-depth — if
    // a route were ever added, the SGs would still constrain the blast radius.
    //
    // ECS task SG: the Fargate proxy egresses HTTPS:443 to the interface VPC
    // endpoints (Bedrock, aoss, ECR, logs, cognito-idp, ...). Egress to the
    // endpoint SG on 443 is added after the endpoint SG is created (below).
    this.ecsTaskSg = new ec2.SecurityGroup(this, 'EcsTaskSg', {
      vpc: this.vpc,
      description: 'Security group for the ECS Fargate agent tasks',
      allowAllOutbound: false,
    });

    // Internal ALB SG. Ingress (TCP 80 from the CloudFront VPC Origin SG) is
    // added later by the ALB construct; default-deny otherwise. Its only egress
    // is forwarding to the proxy task port.
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Security group for the internal Application Load Balancer',
      allowAllOutbound: false,
    });

    // Interface VPC endpoint SG: allow inbound HTTPS:443 only from the ECS task
    // SG and deny all other inbound traffic. Endpoints never initiate outbound
    // connections, so egress stays closed. (R13.5)
    this.endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'Security group for the interface VPC endpoints (443 from ECS tasks only)',
      allowAllOutbound: false,
    });
    this.endpointSg.addIngressRule(
      this.ecsTaskSg,
      ec2.Port.tcp(443),
      'Allow HTTPS from ECS tasks only',
    );

    // Explicit least-privilege egress (replacing allowAllOutbound):
    //  - ECS tasks → VPC interface endpoints on 443 (Bedrock/aoss/ECR/logs/...).
    // The ALB <-> ECS:8080 flow is added AUTOMATICALLY by CDK when the ECS
    // service registers with the ALB target group (`registerConnectable` adds
    // the ALB-SG egress + ECS-SG ingress on the container port), so we do not
    // add those rules here to avoid duplicates.
    this.ecsTaskSg.addEgressRule(
      this.endpointSg,
      ec2.Port.tcp(443),
      'HTTPS to the interface VPC endpoints',
    );

    // ECS tasks → Amazon S3 via the S3 GATEWAY endpoint on 443.
    //
    // Required for image pulls from isolated subnets: an Amazon ECR image pull
    // happens in two phases. The manifest/auth phase reaches the `ecr.api` /
    // `ecr.dkr` INTERFACE endpoints (covered by the rule above), but the image
    // LAYER blobs are stored in Amazon S3 and downloaded through the S3 GATEWAY
    // endpoint. With `allowAllOutbound:false` the task security group must
    // therefore also permit egress to Amazon S3 so the layer download can
    // complete; this rule also covers any other S3 reads the task performs.
    //
    // Gateway endpoints have no security group / ENI, so egress is scoped to the
    // region's S3 managed prefix list (`com.amazonaws.<region>.s3`) to stay
    // least-privilege (no 0.0.0.0/0). The prefix-list id is resolved at deploy
    // time via DescribePrefixLists.
    const s3PrefixList = new cr.AwsCustomResource(this, 'S3PrefixListLookup', {
      onUpdate: {
        service: 'EC2',
        action: 'describePrefixLists',
        parameters: {
          Filters: [
            { Name: 'prefix-list-name', Values: [`com.amazonaws.${Stack.of(this).region}.s3`] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`s3-prefix-list-${Stack.of(this).region}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    const s3PrefixListId = s3PrefixList.getResponseField('PrefixLists.0.PrefixListId');
    this.ecsTaskSg.addEgressRule(
      ec2.Peer.prefixList(s3PrefixListId),
      ec2.Port.tcp(443),
      'HTTPS to Amazon S3 (ECR image-layer pulls) via the S3 gateway endpoint',
    );

    // --- Interface VPC endpoints (private DNS enabled, both AZs) -----------
    // Deployed across all PRIVATE_ISOLATED subnets, which (with maxAzs: 2) span
    // both Availability Zones. `open: false` prevents the default rule that
    // would otherwise open 443 to the whole VPC CIDR, so the endpointSg's
    // "443 from ecsTaskSg only" rule is the sole ingress. (R2.5, R2.6, R2.8, R13.5)
    const interfaceSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    };

    const addInterfaceEndpoint = (
      endpointId: string,
      service: ec2.IInterfaceVpcEndpointService,
    ): ec2.InterfaceVpcEndpoint =>
      this.vpc.addInterfaceEndpoint(endpointId, {
        service,
        subnets: interfaceSubnets,
        securityGroups: [this.endpointSg],
        privateDnsEnabled: true,
        open: false,
      });

    // Amazon ECR API + Amazon ECR Docker + Amazon CloudWatch Logs: required for
    // image pull and logging from isolated subnets. (R2.8)
    addInterfaceEndpoint('EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR);
    addInterfaceEndpoint('EcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER);
    addInterfaceEndpoint('CloudWatchLogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);

    // Amazon Bedrock Runtime: private foundation-model inference. (R2.5, R10.2)
    addInterfaceEndpoint('BedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME);

    // X-Ray: the AgentCore Runtime has tracing enabled and runs in VPC-egress
    // mode, so trace export must traverse a private endpoint (no internet). (R10.1)
    addInterfaceEndpoint('XRayEndpoint', ec2.InterfaceVpcEndpointAwsService.XRAY);

    // Cognito Identity Provider (`com.amazonaws.{region}.cognito-idp`).
    // The proxy enforces login itself and runs in these no-egress isolated
    // subnets, so it MUST reach Cognito privately for two things:
    //   1. `InitiateAuth` (USER_PASSWORD_AUTH) — the proxy authenticates the
    //      username/password from its own login form (no public Hosted-UI
    //      redirect, whose OAuth domain has no PrivateLink endpoint).
    //   2. The pool JWKS at
    //      `https://cognito-idp.{region}.amazonaws.com/{poolId}/.well-known/jwks.json`
    //      — same host as the API, so this one endpoint (private DNS enabled)
    //      serves both token issuance and signature verification.
    // Without it the synchronous JWKS/auth HTTPS calls time out and block the
    // proxy's event loop until the client keepalive times out. (R2.5)
    addInterfaceEndpoint('CognitoIdpEndpoint', ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP);

    // Bedrock AgentCore DATA-PLANE endpoint (`com.amazonaws.{region}.bedrock-agentcore`).
    // v2-specific: the in-VPC ECS proxy calls `bedrock-agentcore:InvokeAgentRuntime`
    // on the AgentCore Runtime through THIS PrivateLink endpoint, so the
    // proxy->runtime hop never touches the internet. AgentCore inbound
    // invocations are not VPC-routed by the service itself; PrivateLink is how a
    // private VPC caller reaches the data-plane API. Private DNS enabled so the
    // boto client resolves `bedrock-agentcore.{region}.amazonaws.com` to the
    // endpoint ENIs. (Proxy -> AgentCore, fully private.)
    addInterfaceEndpoint(
      'BedrockAgentCoreEndpoint',
      new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${Stack.of(this).region}.bedrock-agentcore`,
        443,
      ),
    );

    // OpenSearch Serverless CONTROL-PLANE interface endpoint
    // (`com.amazonaws.{region}.aoss`). Required so the in-VPC provisioner Lambda
    // can call the `opensearchserverless` API (CreateCollection,
    // CreateSecurityPolicy, BatchGetCollection, ...) privately from the isolated
    // subnets. This is distinct from the DATA-PLANE endpoint below, which serves
    // collection index/search traffic. (R2.5, R11.3)
    addInterfaceEndpoint(
      'AossControlEndpoint',
      new ec2.InterfaceVpcEndpointService(`com.amazonaws.${Stack.of(this).region}.aoss`, 443),
    );

    // OpenSearch Serverless (aoss) DATA-PLANE endpoint for **NextGen**.
    //
    // NextGen collection endpoints live on `*.aoss.{region}.on.aws` (NOT the
    // classic `*.aoss.amazonaws.com`). The classic OpenSearch Serverless-managed
    // endpoint (`AWS::OpenSearchServerless::VpcEndpoint`) only provisions a
    // private hosted zone for the `aoss.amazonaws.com` domain, so it does NOT
    // make the NextGen `.on.aws` hostname resolve privately — clients fall
    // through to public DNS (public IPs) and time out in an isolated VPC.
    //
    // The correct NextGen mechanism is a STANDARD EC2 interface VPC endpoint to
    // the service `com.amazonaws.{region}.aoss-data` with private DNS enabled;
    // AWS PrivateLink then resolves `*.aoss.{region}.on.aws` to the endpoint
    // ENIs. Its id is referenced by the OpenSearch network policy's
    // `SourceVPCEs`. (R2.5, R11.3)
    const aossDataEndpoint = addInterfaceEndpoint(
      'AossDataEndpoint',
      new ec2.InterfaceVpcEndpointService(`com.amazonaws.${Stack.of(this).region}.aoss-data`, 443),
    );
    this.aossVpcEndpointId = aossDataEndpoint.vpcEndpointId;
  }
}
