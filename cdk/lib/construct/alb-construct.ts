/**
 * ALB construct: internal Application Load Balancer + target group (:8080) +
 * HTTP:80 listener.
 *
 * Adopts the validated reference pattern from
 * `non-97/aws-cdk-cloudfront-websockets-vpc-origins`: an internal ALB in
 * private-isolated subnets with a 60s idle timeout (so idle WebSocket
 * connections survive the Amazon CloudFront 60s idle window), an IP-target group on
 * container port 8080 with a `/health` health check, and a plain HTTP:80
 * listener that the CloudFront VPC Origin connects to.
 *
 * Implements task 3.1.
 * _Requirements: 2.2, 4.1, 4.2, 4.3, 5.1, 5.3, 5.4, 5.5, 5.6, 5.7_
 *
 * The VPC Origin security-group ingress restriction (R4.4 / R13.4) is added by
 * {@link AlbConstruct.restrictIngressToVpcOriginServiceSg} (task 3.2).
 */
import { Duration } from 'aws-cdk-lib';
import { aws_certificatemanager as acm } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct, IDependable } from 'constructs';

/** The container port the Agent_Container listens on (R5.1, R7.2). */
const CONTAINER_PORT = 8080;

/** Default target-group deregistration delay in seconds (R5.7). */
const DEFAULT_DEREGISTRATION_DELAY_SECONDS = 300;

/**
 * The well-known name of the managed security group that CloudFront VPC Origins
 * creates in the account/region when the first VPC Origin is provisioned. The
 * ALB ingress rule (R4.4 / R13.4) must allow TCP 80 only from this group.
 *
 * CloudFront does not expose this group's id in CloudFormation, so it is
 * resolved post-deploy via `ec2:DescribeSecurityGroups` filtered on this name.
 */
const VPC_ORIGIN_SERVICE_SG_NAME = 'CloudFront-VPCOrigins-Service-SG';

/** The HTTP port the CloudFront VPC Origin connects to on the internal ALB (R4.2). */
const ALB_HTTP_PORT = 80;

/** The HTTPS port the CloudFront VPC Origin connects to when origin TLS is enabled. */
const ALB_HTTPS_PORT = 443;

/**
 * Props for {@link AlbConstruct}.
 */
export interface AlbConstructProps {
  /** The VPC the ALB is provisioned into (from {@link VpcConstruct}). */
  readonly vpc: ec2.IVpc;

  /**
   * The security group to attach to the ALB (from {@link VpcConstruct}). The
   * VPC Origin ingress rule is added to this group by task 3.2.
   */
  readonly albSg: ec2.ISecurityGroup;

  /**
   * Target-group deregistration delay in seconds. R5.7 mandates draining
   * in-flight WebSocket connections for up to 300s.
   *
   * @default 300
   */
  readonly deregistrationDelaySeconds?: number;

  /**
   * Protocol for the CloudFront VPC Origin -> ALB hop.
   *
   * - `'HTTP'` (default): a single HTTP:80 listener.
   * - `'HTTPS'`: an HTTPS:443 listener using {@link originCertificateArn} (TLS
   *   terminates at the ALB; ALB -> container stays HTTP on 8080 inside the task
   *   boundary). No HTTP:80 listener is created in this mode.
   *
   * @default 'HTTP'
   */
  readonly originProtocol?: 'HTTP' | 'HTTPS';

  /**
   * ARN of the ACM certificate (in the stack region) for the ALB HTTPS
   * listener. Required when {@link originProtocol} is `'HTTPS'`.
   */
  readonly originCertificateArn?: string;
}

/**
 * Provisions the internal Application Load Balancer that fronts the ECS
 * Fargate agent tasks.
 *
 * Topology:
 * - An internal {@link elbv2.ApplicationLoadBalancer} (`internetFacing: false`)
 *   in the VPC's `PRIVATE_ISOLATED` subnets with an `idleTimeout` of 60s, so an
 *   idle WebSocket connection is not closed within the CloudFront 60s idle
 *   timeout window. (R2.2, R5.3)
 * - An {@link elbv2.ApplicationTargetGroup} over HTTP on container port 8080
 *   with `targetType: IP` (Fargate `awsvpc` tasks register by IP) and a
 *   `/health` HTTP health check: 30s interval, 5s timeout, healthy/unhealthy
 *   thresholds of 3, expecting HTTP 200, and a configurable deregistration
 *   delay (default 300s). (R5.1, R5.4, R5.5, R5.6, R5.7)
 * - An HTTP listener on port 80 that defaults all traffic to the target group,
 *   which the CloudFront VPC Origin connects to. (R4.1, R4.2, R4.3)
 */
export class AlbConstruct extends Construct {
  /** The internal Application Load Balancer. */
  public readonly alb: elbv2.IApplicationLoadBalancer;

  /** The target group registering the agent tasks on port 8080. */
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  /** The listener (HTTP:80 or HTTPS:443) that the CloudFront VPC Origin connects to. */
  public readonly listener: elbv2.ApplicationListener;

  /** The security group attached to the ALB (target of the task 3.2 ingress rule). */
  public readonly albSg: ec2.ISecurityGroup;

  /** The port the CloudFront VPC Origin connects to (80 for HTTP, 443 for HTTPS). */
  public readonly originPort: number;

  /**
   * The VPC the ALB lives in. Retained so the VPC Origin service-SG lookup can
   * scope its `describeSecurityGroups` call to this VPC (see
   * {@link AlbConstruct.restrictIngressToVpcOriginServiceSg}).
   */
  private readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: AlbConstructProps) {
    super(scope, id);

    this.albSg = props.albSg;
    this.vpc = props.vpc;
    const originProtocol = props.originProtocol ?? 'HTTP';
    this.originPort = originProtocol === 'HTTPS' ? ALB_HTTPS_PORT : ALB_HTTP_PORT;

    const deregistrationDelaySeconds =
      props.deregistrationDelaySeconds ?? DEFAULT_DEREGISTRATION_DELAY_SECONDS;

    // --- Internal ALB -------------------------------------------------------
    // internetFacing: false => scheme "internal"; placed in PRIVATE_ISOLATED
    // subnets (no public IPs). 60s idle timeout keeps idle WebSocket
    // connections alive within the CloudFront idle window. (R2.2, R5.3)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Default', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      idleTimeout: Duration.seconds(60),
    });
    this.alb = alb;

    // --- Target group (IP targets on container port 8080) ------------------
    // Fargate awsvpc tasks register by IP. Health check hits /health on the
    // container port every 30s with a 5s timeout, requiring 3 consecutive
    // successes/failures to flip healthy/unhealthy, expecting HTTP 200.
    // deregistrationDelay drains in-flight (WebSocket) connections. (R5.1, R5.4-R5.7)
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: CONTAINER_PORT,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: Duration.seconds(deregistrationDelaySeconds),
      healthCheck: {
        path: '/health',
        port: String(CONTAINER_PORT),
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
      },
    });

    // --- Listener (HTTP:80 or HTTPS:443) -----------------------------------
    // The CloudFront VPC Origin connects on this listener; default all requests
    // to the agent target group. (R4.2, R4.3)
    //
    // HTTPS mode terminates TLS at the ALB using the supplied ACM certificate
    // (end-to-end encryption: browser->CloudFront and CloudFront->ALB are both
    // TLS). The ALB->container hop stays HTTP on 8080 inside the task boundary,
    // which is the standard ALB pattern. HTTP mode is the default (private hop
    // over the AWS backbone with network-level encryption in transit, no
    // certificate prework).
    if (originProtocol === 'HTTPS') {
      if (!props.originCertificateArn) {
        throw new Error(
          'AlbConstruct: originProtocol "HTTPS" requires originCertificateArn.',
        );
      }
      this.listener = alb.addListener('Https443', {
        port: ALB_HTTPS_PORT,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [
          elbv2.ListenerCertificate.fromArn(props.originCertificateArn),
        ],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [this.targetGroup],
      });
    } else {
      this.listener = alb.addListener('Http80', {
        port: ALB_HTTP_PORT,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [this.targetGroup],
      });
    }
  }

  /**
   * Restrict the internal ALB security group so that it accepts inbound TCP 80
   * **only** from the CloudFront VPC Origins managed service security group
   * (`CloudFront-VPCOrigins-Service-SG`), denying all other inbound traffic
   * (R4.4, R13.4).
   *
   * CloudFront VPC Origins create that managed security group in the
   * account/region, but its id is not exposed directly through CloudFormation.
   * This method therefore resolves the id post-deploy with an
   * {@link cr.AwsCustomResource} that calls `ec2:DescribeSecurityGroups`
   * filtered on `group-name = CloudFront-VPCOrigins-Service-SG` **and
   * `vpc-id` = this ALB's VPC** (accounts that have provisioned VPC Origins
   * before have several identically-named groups, one per VPC), reads
   * `SecurityGroups.0.GroupId` from the response, and adds an ingress rule to
   * the ALB security group allowing TCP 80 from the resolved group id.
   *
   * Important ordering constraint: the managed VPC Origin service SG only
   * exists **after** a VPC Origin has been created in the account/region. The
   * CloudFront construct (task 6.2) creates the VPC Origin and the stack wiring
   * (task 7.1) connects the constructs, so the returned {@link cr.AwsCustomResource}
   * must be made to depend on the distribution / VPC Origin. Pass that
   * dependency via {@link RestrictIngressOptions.dependsOn}, or add it to the
   * returned resource with `resource.node.addDependency(...)` in task 7.1.
   * Without that dependency the `DescribeSecurityGroups` lookup can run before
   * the service SG exists and resolve nothing.
   *
   * The resolved group is referenced by id (it is not a CDK-managed group), so
   * the ingress rule is added with `ec2.Peer.securityGroupId(resolvedId)` via
   * `connections.allowFrom`.
   *
   * @param options - optional dependency (the distribution / VPC Origin) and a
   *   custom logical id for the lookup resource.
   * @returns the {@link cr.AwsCustomResource} performing the lookup, so callers
   *   (task 7.1) can wire additional dependencies if needed.
   */
  public restrictIngressToVpcOriginServiceSg(
    options: RestrictIngressOptions = {},
  ): cr.AwsCustomResource {
    // Resolve the CloudFront VPC Origins managed service security group id by
    // its well-known name. The lookup runs on Create and Update so a recreated
    // service SG is re-resolved. physicalResourceId is bound to the resolved
    // group id so CloudFormation treats a different group as a replacement.
    const lookup = new cr.AwsCustomResource(this, options.id ?? 'VpcOriginServiceSgLookup', {
      onCreate: {
        service: 'EC2',
        action: 'describeSecurityGroups',
        parameters: {
          Filters: [
            { Name: 'group-name', Values: [VPC_ORIGIN_SERVICE_SG_NAME] },
            // Scope to THIS VPC. Accounts that have used VPC Origins before have
            // multiple SGs with this same name across different VPCs; without the
            // vpc-id filter the lookup can resolve a group in the wrong VPC and
            // the ingress rule fails with "resources that belong to different
            // networks".
            { Name: 'vpc-id', Values: [this.vpc.vpcId] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('SecurityGroups.0.GroupId'),
        outputPaths: ['SecurityGroups.0.GroupId'],
      },
      onUpdate: {
        service: 'EC2',
        action: 'describeSecurityGroups',
        parameters: {
          Filters: [
            { Name: 'group-name', Values: [VPC_ORIGIN_SERVICE_SG_NAME] },
            { Name: 'vpc-id', Values: [this.vpc.vpcId] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('SecurityGroups.0.GroupId'),
        outputPaths: ['SecurityGroups.0.GroupId'],
      },
      // ec2:DescribeSecurityGroups does not support resource-level permissions,
      // so the read-only describe is scoped to ANY_RESOURCE.
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    // The managed service SG only exists once a VPC Origin has been created.
    // Depend on the distribution / VPC Origin (wired in task 7.1) so the lookup
    // runs only after the SG is present.
    if (options.dependsOn) {
      lookup.node.addDependency(options.dependsOn);
    }

    const resolvedSgId = lookup.getResponseField('SecurityGroups.0.GroupId');

    // Allow inbound TCP 80 only from the resolved VPC Origin service SG.
    //
    // This is intentionally a STANDALONE `CfnSecurityGroupIngress` resource
    // rather than `albSg.connections.allowFrom(...)`. An inline ingress rule
    // would attach to the ALB security group itself, making that SG depend on
    // the lookup custom resource — which depends on the CloudFront distribution
    // / VPC Origin, which depends on the ALB (and therefore its SG). That closes
    // a CloudFormation circular dependency
    // (ALB → AlbSg → Lookup → Distribution → VpcOrigin → ALB).
    //
    // A separate ingress resource references the ALB SG by id and the resolved
    // peer SG by id without adding any dependency edge *into* the ALB SG, so the
    // ALB/SG can be created first and this rule is attached afterwards once the
    // lookup has resolved the service SG id. Default-deny otherwise. (R4.4, R13.4)
    new ec2.CfnSecurityGroupIngress(this, 'VpcOriginIngress', {
      groupId: this.albSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: this.originPort,
      toPort: this.originPort,
      sourceSecurityGroupId: resolvedSgId,
      description: `Allow CloudFront VPC Origin service SG to reach the internal ALB on TCP ${this.originPort}`,
    });

    return lookup;
  }
}

/**
 * Options for {@link AlbConstruct.restrictIngressToVpcOriginServiceSg}.
 */
export interface RestrictIngressOptions {
  /**
   * A resource the lookup must run after — typically the CloudFront
   * distribution / VPC Origin (wired in task 7.1). The CloudFront VPC Origins
   * managed service security group only exists after a VPC Origin has been
   * created in the account/region, so the `DescribeSecurityGroups` lookup must
   * not run before then.
   *
   * @default - no explicit dependency (the caller is responsible for ordering)
   */
  readonly dependsOn?: IDependable;

  /**
   * Logical id for the lookup {@link cr.AwsCustomResource}.
   *
   * @default 'VpcOriginServiceSgLookup'
   */
  readonly id?: string;
}
