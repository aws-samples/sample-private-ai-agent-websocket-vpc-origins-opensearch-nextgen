/**
 * AppStack (v2) — the public-facing application layer.
 *
 * Owns the internal ALB, the ECS Fargate proxy, CloudFront (the sole public
 * surface), and Cognito (Hosted-UI login enforced at the proxy). Reuses the VPC
 * + SGs from NetworkStack, the proxy task role + upload bucket + collection
 * endpoint from DataStack, and the runtime ARN from AgentCoreStack.
 *
 * This is the stack iterated on most often. It can be destroyed and redeployed
 * without touching the VPC (NetworkStack) — so a teardown here only releases the
 * ECS task ENIs (fast) and the CloudFront VPC Origin, never the whole VPC.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentConfig } from './config';
import { AlbConstruct } from './construct/alb-construct';
import { ProxyConstruct } from './construct/proxy-construct';
import { CloudFrontConstruct } from './construct/cloudfront-construct';
import { AuthConstruct } from './construct/auth-construct';

/** Props for {@link AppStack}. */
export interface AppStackProps extends StackProps {
  config: AgentConfig;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  ecsTaskSg: ec2.ISecurityGroup;
  /** Proxy task role created in the DataStack. */
  proxyTaskRole: iam.IRole;
  /** Upload bucket name (DataStack). */
  uploadBucket: string;
  /** OpenSearch data-plane endpoint (DataStack). */
  openSearchEndpoint: string;
  /** AgentCore runtime ARN (AgentCoreStack). */
  agentRuntimeArn: string;
  /** WAF web ACL ARN (WafStack, us-east-1). */
  webAclArn?: string;
  /** ECR repo holding the proxy image (BuildStack). */
  proxyImageRepository: ecr.IRepository;
  /** Proxy image tag in the repo (BuildStack). */
  proxyImageTag: string;
}

/** The public application stack: ALB + proxy + CloudFront + Cognito. */
export class AppStack extends Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { config } = props;

    // --- Internal ALB -------------------------------------------------------
    const alb = new AlbConstruct(this, 'Alb', {
      vpc: props.vpc,
      albSg: props.albSg,
      deregistrationDelaySeconds: config.deregistrationDelaySeconds,
      originProtocol: config.albOriginProtocol,
      originCertificateArn: config.originCertificateArn ?? undefined,
    });

    // --- Cognito (self-hosted login enforced at the proxy) -----------------
    const auth = new AuthConstruct(this, 'Auth', {
      demoUsername: 'demo',
      demoEmail: `demo@${config.instanceName}.invalid`,
    });

    // --- ECS proxy (WS <-> SSE bridge to AgentCore) ------------------------
    const proxy = new ProxyConstruct(this, 'Proxy', {
      vpc: props.vpc,
      ecsTaskSg: props.ecsTaskSg,
      targetGroup: alb.targetGroup,
      config,
      agentRuntimeArn: props.agentRuntimeArn,
      taskRole: props.proxyTaskRole,
      imageRepository: props.proxyImageRepository,
      imageTag: props.proxyImageTag,
      auth: {
        userPoolId: auth.userPool.userPoolId,
        clientId: auth.userPoolClient.userPoolClientId,
      },
      uploads: {
        uploadBucket: props.uploadBucket,
        openSearchEndpoint: props.openSearchEndpoint,
        openSearchIndex: config.openSearchIndex,
        bedrockEmbedModelId: config.bedrockEmbedModelId,
      },
    });

    // --- CloudFront (sole public entry point) ------------------------------
    const cloudFront = new CloudFrontConstruct(this, 'CloudFront', {
      alb: alb.alb,
      webAclArn: props.webAclArn,
      config,
    });

    // The public site URL (custom domain when configured, else the CloudFront
    // distribution domain). No Cognito callback wiring is needed — the proxy
    // hosts its own login form rather than redirecting to the Hosted UI.
    const siteUrl = config.domainName
      ? `https://${config.domainName}`
      : `https://${cloudFront.distribution.distributionDomainName}`;

    // --- Restrict ALB ingress to the VPC Origin service SG -----------------
    alb.restrictIngressToVpcOriginServiceSg({ dependsOn: cloudFront.distribution });

    this.distributionDomainName = cloudFront.distribution.distributionDomainName;

    new CfnOutput(this, 'DistributionDomainName', {
      description: 'CloudFront distribution domain name (sole public entry point)',
      value: this.distributionDomainName,
    });
    new CfnOutput(this, 'SiteUrl', {
      description: 'The public site URL (login required)',
      value: siteUrl,
    });
    new CfnOutput(this, 'DemoUsername', { value: 'demo' });
    new CfnOutput(this, 'DemoPasswordSecretArn', {
      description: 'Secrets Manager ARN with the generated demo-user password',
      value: auth.credentialsSecret.secretArn,
    });
  }
}
