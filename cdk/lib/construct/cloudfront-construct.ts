/**
 * Amazon CloudFront construct: VPC Origin + distribution (default, /ws/*, /api/*
 * behaviors) + WAF association + stack outputs.
 *
 * Implements task 6.2. This is the sole public entry point for the solution:
 * CloudFront fronts the internal ALB through a VPC Origin so the ALB never
 * requires an internet-facing configuration. The distribution defines three
 * behaviors, all routed to the same VPC Origin:
 *
 *  - default — serves the demo SPA from the container.
 *  - `/ws/*` — WebSocket streaming traffic.
 *  - `/api/*` — synchronous HTTP REST traffic.
 *
 * WebSocket support is enabled *implicitly* by forwarding the `Sec-WebSocket-*`
 * headers via the `AllViewer` managed origin request policy combined with the
 * caching-disabled cache policy and `ALLOW_ALL` methods. There is no
 * `webSocketSupport` property on CDK behaviors.
 *
 * _Requirements: 1.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 13.1,
 * 13.6, 14.1, 14.2, 14.3_
 */
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
// AWS Certificate Manager (ACM) — provides the TLS certificate for the
// CloudFront -> ALB HTTPS origin when that mode is selected.
import { aws_certificatemanager as acm } from 'aws-cdk-lib';
import { aws_cloudfront as cloudfront } from 'aws-cdk-lib';
import { aws_cloudfront_origins as origins } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { AgentConfig } from '../config';

/**
 * Maps the `priceClass` configuration string (e.g. `"PriceClass_100"`) to the
 * corresponding {@link cloudfront.PriceClass} enum member.
 */
const PRICE_CLASS_BY_NAME: Record<string, cloudfront.PriceClass> = {
  PriceClass_100: cloudfront.PriceClass.PRICE_CLASS_100,
  PriceClass_200: cloudfront.PriceClass.PRICE_CLASS_200,
  PriceClass_All: cloudfront.PriceClass.PRICE_CLASS_ALL,
};

/**
 * Resolve the configured price-class string to the CloudFront enum, defaulting
 * to `PRICE_CLASS_100` when the value is unrecognized.
 */
function resolvePriceClass(value: string): cloudfront.PriceClass {
  return PRICE_CLASS_BY_NAME[value] ?? cloudfront.PriceClass.PRICE_CLASS_100;
}

/**
 * Props for {@link CloudFrontConstruct}.
 */
export interface CloudFrontConstructProps {
  /**
   * The internal Application Load Balancer the VPC Origin targets (from
   * {@link AlbConstruct}).
   */
  readonly alb: elbv2.IApplicationLoadBalancer;

  /**
   * The ARN of the CloudFront-scoped AWS WAF web ACL (created in the us-east-1
   * WAF stack) to associate with the distribution. When omitted, the
   * distribution is created without a web ACL association.
   */
  readonly webAclArn?: string;

  /** The validated agent configuration. */
  readonly config: AgentConfig;
}

/**
 * Provisions the CloudFront VPC Origin and distribution that serve as the sole
 * public entry point to the privately-deployed agent.
 *
 * - The {@link origins.VpcOrigin} targets the internal ALB. By default it uses
 *   HTTP-only on port 80 (the ALB never needs an internet-facing config); when
 *   `config.albOriginProtocol` is `'HTTPS'` it uses HTTPS on 443 with the origin
 *   domain name for SNI/cert validation (end-to-end TLS). (R4.1, R4.2)
 * - The {@link cloudfront.Distribution} defines three behaviors routed to the
 *   same VPC Origin: a default behavior that serves the demo SPA
 *   (`REDIRECT_TO_HTTPS`), and `/ws/*` and `/api/*` behaviors (`HTTPS_ONLY`).
 *   All three use the caching-disabled cache policy, the `AllViewer` origin
 *   request policy (which forwards the `Sec-WebSocket-*` headers required to
 *   enable WebSocket support), and `ALLOW_ALL` HTTP methods (so POST reaches
 *   `/api/invocations`). (R3.1–R3.8)
 * - TLS is pinned to `TLS_V1_2_2021`, HTTP/2 is enabled, the price class comes
 *   from configuration, and the WAF web ACL is associated via `webAclId`.
 *   (R13.1, R13.6)
 * - When both a custom domain name and an ACM certificate ARN are provided, the
 *   distribution uses them as its alternate domain name and viewer certificate;
 *   otherwise it uses the default CloudFront domain and certificate. (R14.1,
 *   R14.2, R14.3)
 * - Emits `CfnOutput`s for the distribution domain, the WebSocket endpoint, and
 *   the API endpoint. (R1.4)
 */
export class CloudFrontConstruct extends Construct {
  /** The CloudFront distribution that is the sole public entry point. */
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontConstructProps) {
    super(scope, id);

    const { alb, webAclArn, config } = props;

    // --- VPC Origin ---------------------------------------------------------
    // Targets the internal ALB through the VPC Origin, so the ALB stays
    // internal (private over the AWS backbone). (R4.1, R4.2)
    //
    // Two modes:
    //  - HTTP (default): CloudFront -> ALB on HTTP:80. Private but unencrypted.
    //  - HTTPS (opt-in): CloudFront -> ALB on HTTPS:443 with SNI set to the
    //    origin domain name so CloudFront validates the ALB's ACM certificate.
    //    The origin domain does NOT need a public DNS record — the VPC Origin
    //    routes to the ALB by ARN; the name is only for the TLS handshake.
    const useHttpsOrigin = config.albOriginProtocol === 'HTTPS';
    const vpcOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      // When HTTPS, set the origin domain so the TLS SNI + cert CN/SAN match
      // (otherwise CloudFront presents the ALB DNS name and the handshake 502s).
      domainName: useHttpsOrigin ? (config.originDomainName as string) : undefined,
      protocolPolicy: useHttpsOrigin
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      httpsPort: useHttpsOrigin ? 443 : undefined,
      originSslProtocols: useHttpsOrigin ? [cloudfront.OriginSslPolicy.TLS_V1_2] : undefined,
      // 60s is the max standard CloudFront origin response timeout. The agent's
      // synchronous /api/invocations cold start can approach this; the
      // streaming WebSocket path (/ws) is not bound by this (each token resets
      // the idle timer), so streaming is the recommended path for cold starts.
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(5),
    });

    // --- Shared behavior building blocks -----------------------------------
    // WebSocket support is enabled implicitly: ALL_VIEWER forwards the
    // Sec-WebSocket-* headers and CACHING_DISABLED prevents caching of the
    // streaming/synchronous responses. ALLOW_ALL permits GET/HEAD/OPTIONS plus
    // POST/PUT/PATCH/DELETE. (R3.1, R3.2, R3.4, R3.5)
    const cachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;
    const originRequestPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER;
    const allowedMethods = cloudfront.AllowedMethods.ALLOW_ALL;

    // --- Custom domain + ACM (R14) -----------------------------------------
    // Mutual-presence validation happens in config.ts; here we just apply.
    // When both are present, use the custom domain + certificate; otherwise
    // fall back to the default CloudFront domain/certificate. (R14.1–R14.3)
    const useCustomDomain = config.domainName !== null && config.certificateArn !== null;
    const domainNames = useCustomDomain ? [config.domainName as string] : undefined;
    const certificate = useCustomDomain
      ? acm.Certificate.fromCertificateArn(this, 'ViewerCertificate', config.certificateArn as string)
      : undefined;

    // --- Access logging (opt-in) -------------------------------------------
    // CloudFront standard access logs to a dedicated S3 bucket. Off by default
    // (the proxy already logs request-level detail). The bucket MUST keep ACLs
    // enabled (BUCKET_OWNER_PREFERRED) because CloudFront's log-delivery group
    // writes objects via ACL; a BUCKET_OWNER_ENFORCED bucket would reject them.
    // Removed on teardown so the sample stays clean.
    const accessLogBucket = config.cloudFrontAccessLogs
      ? new s3.Bucket(this, 'AccessLogsBucket', {
          objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
          encryption: s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          removalPolicy: RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          lifecycleRules: [{ expiration: Duration.days(90) }],
        })
      : undefined;

    // --- Distribution -------------------------------------------------------
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Private Real-Time AI Agent - sole public entry point',
      // Standard access logging (opt-in via config.cloudFrontAccessLogs).
      enableLogging: config.cloudFrontAccessLogs,
      logBucket: accessLogBucket,
      logFilePrefix: accessLogBucket ? 'cf-access-logs/' : undefined,
      // Default behavior: serves the demo SPA through the VPC Origin. Viewers
      // are redirected to HTTPS. (R3.8)
      defaultBehavior: {
        origin: vpcOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy,
        originRequestPolicy,
        allowedMethods,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        // WebSocket streaming. HTTPS-only viewer protocol rejects non-HTTPS
        // requests before they reach the origin. (R3.1, R3.3–R3.7)
        '/ws/*': {
          origin: vpcOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy,
          originRequestPolicy,
          allowedMethods,
        },
        // Synchronous HTTP REST (includes POST to /api/invocations). HTTPS-only.
        // (R3.2, R3.3–R3.7)
        '/api/*': {
          origin: vpcOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy,
          originRequestPolicy,
          allowedMethods,
        },
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: resolvePriceClass(config.priceClass),
      // Associate the CloudFront-scoped WAF web ACL by ARN. (R13.1, R13.6)
      webAclId: webAclArn,
      domainNames,
      certificate,
    });

    // --- Outputs (R1.4) -----------------------------------------------------
    // Use the custom domain when configured, otherwise the CloudFront domain.
    const domain = useCustomDomain ? (config.domainName as string) : this.distribution.distributionDomainName;

    new CfnOutput(this, 'DistributionDomainName', {
      description: 'CloudFront distribution HTTPS URL (sole public entry point)',
      value: `https://${domain}`,
    });
    new CfnOutput(this, 'WebSocketEndpoint', {
      description: 'WebSocket streaming endpoint served through CloudFront',
      value: `wss://${domain}/ws/`,
    });
    if (accessLogBucket) {
      new CfnOutput(this, 'AccessLogsBucketName', {
        description: 'S3 bucket receiving CloudFront standard access logs',
        value: accessLogBucket.bucketName,
      });
    }
    new CfnOutput(this, 'ApiEndpoint', {
      description: 'HTTP invocation endpoint served through CloudFront',
      value: `https://${domain}/api/invocations`,
    });
  }
}
