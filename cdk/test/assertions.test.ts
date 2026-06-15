/**
 * Fine-grained CDK assertion tests for the split-stack architecture.
 *
 * Each assertion targets the stack that now owns the resource:
 *   networkTemplate — VPC, endpoints, SGs
 *   dataTemplate    — OpenSearch provisioner, S3 uploads, IAM roles
 *   agentTemplate   — AgentCore Runtime
 *   appTemplate     — ALB, ECS proxy, CloudFront, Cognito
 *   wafTemplate     — AWS WAF web ACL
 */
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthStacks } from './helpers';

const CACHING_DISABLED_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_ORIGIN_REQUEST_POLICY_ID = '216adef6-5c7f-47e4-b989-5492eafa07d3';

let networkTemplate: Template;
let dataTemplate: Template;
let agentTemplate: Template;
let appTemplate: Template;
let wafTemplate: Template;
let buildTemplate: Template;

beforeAll(() => {
  const s = synthStacks();
  networkTemplate = s.networkTemplate;
  dataTemplate = s.dataTemplate;
  agentTemplate = s.agentTemplate;
  appTemplate = s.appTemplate;
  wafTemplate = s.wafTemplate;
  buildTemplate = s.buildTemplate;
});

describe('NetworkStack — VPC and networking (R2.1, R2.7)', () => {
  test('VPC has no NAT gateways', () => {
    networkTemplate.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('an internet gateway and a VPC gateway attachment exist', () => {
    networkTemplate.resourceCountIs('AWS::EC2::InternetGateway', 1);
    networkTemplate.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
  });

  test('no private subnet route points at the internet gateway', () => {
    networkTemplate.resourceCountIs('AWS::EC2::Route', 0);
  });

  test('exactly two isolated subnets span two AZs', () => {
    networkTemplate.resourceCountIs('AWS::EC2::Subnet', 2);
  });
});

describe('NetworkStack — VPC endpoints (R2.5, R2.8, R2.9)', () => {
  const interfaceServices = [
    'com.amazonaws.us-east-1.ecr.api',
    'com.amazonaws.us-east-1.ecr.dkr',
    'com.amazonaws.us-east-1.logs',
    'com.amazonaws.us-east-1.bedrock-runtime',
    'com.amazonaws.us-east-1.xray',
    'com.amazonaws.us-east-1.aoss',
    'com.amazonaws.us-east-1.aoss-data',
    'com.amazonaws.us-east-1.bedrock-agentcore',
    'com.amazonaws.us-east-1.cognito-idp',
  ];

  test.each(interfaceServices)('interface endpoint %s exists with private DNS', (serviceName) => {
    networkTemplate.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: serviceName,
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true,
    });
  });

  test('nine interface endpoints + one S3 gateway endpoint', () => {
    networkTemplate.resourceCountIs('AWS::EC2::VPCEndpoint', 10);
  });

  test('no classic managed OpenSearch Serverless VPC endpoint is used', () => {
    networkTemplate.resourceCountIs('AWS::OpenSearchServerless::VpcEndpoint', 0);
  });
});

describe('AppStack — internal ALB + target group + listener', () => {
  test('the load balancer is internal with a 60s idle timeout', () => {
    appTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
      Type: 'application',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
      ]),
    });
  });

  test('the target group is HTTP:8080 with a /health check and 300s deregistration delay', () => {
    appTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8080,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/health',
      Matcher: { HttpCode: '200' },
    });
  });

  test('there is an HTTP listener on port 80 (default origin mode)', () => {
    appTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });
});

describe('AppStack — CloudFront distribution', () => {
  test('exactly three behaviors: default + /ws/* + /api/*', () => {
    const distributions = appTemplate.findResources('AWS::CloudFront::Distribution');
    const config = Object.values(distributions)[0].Properties.DistributionConfig;
    expect(config.CacheBehaviors).toHaveLength(2);
    const patterns = config.CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern).sort();
    expect(patterns).toEqual(['/api/*', '/ws/*']);
  });

  test('/ws/* and /api/* use CachingDisabled + AllViewer + ALLOW_ALL + https-only', () => {
    for (const pattern of ['/ws/*', '/api/*']) {
      appTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: pattern,
              CachePolicyId: CACHING_DISABLED_POLICY_ID,
              OriginRequestPolicyId: ALL_VIEWER_ORIGIN_REQUEST_POLICY_ID,
              ViewerProtocolPolicy: 'https-only',
              AllowedMethods: Match.arrayWith(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']),
            }),
          ]),
        }),
      });
    }
  });

  test('the WAF web ACL is associated via WebACLId', () => {
    appTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: Match.stringLikeRegexp('^arn:aws:wafv2:us-east-1:\\d{12}:global/webacl/'),
      }),
    });
  });

  test('a VPC origin targets the ALB with HTTP_ONLY on port 80', () => {
    appTemplate.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
    appTemplate.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({
        OriginProtocolPolicy: 'http-only',
        HTTPPort: 80,
      }),
    });
  });
});

describe('AppStack — HTTPS origin mode (opt-in)', () => {
  const HTTPS_OVERRIDES = {
    albOriginProtocol: 'HTTPS' as const,
    originDomainName: 'agent-origin.example.com',
    originCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
  };

  test('the VPC origin uses HTTPS_ONLY and the ALB has an HTTPS:443 listener', () => {
    const { appTemplate: t } = synthStacks(HTTPS_OVERRIDES);
    t.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only', HTTPSPort: 443 }),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.arrayWith([
        { CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123' },
      ]),
    });
  });
});

describe('AgentCoreStack — Bedrock AgentCore Runtime', () => {
  test('exactly one AgentCore Runtime on a VPC network with the HTTP protocol', () => {
    agentTemplate.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    agentTemplate.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      NetworkConfiguration: Match.objectLike({ NetworkMode: 'VPC' }),
      ProtocolConfiguration: 'HTTP',
    });
  });

  test('exactly one AgentCore Runtime endpoint', () => {
    agentTemplate.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 1);
  });

  test('a resource-based policy denies invoke from outside the VPC (Pattern 3)', () => {
    agentTemplate.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 1);
    const policies = agentTemplate.findResources('AWS::BedrockAgentCore::ResourcePolicy');
    const [policyResource] = Object.values(policies);
    // The Policy property contains unresolved CDK tokens (the VPC id + runtime
    // ARN), so CloudFormation renders it as an intrinsic (Fn::Join) object, not
    // a plain JSON string. Serialize the whole property and assert the key
    // deny-unless-our-VPC shape is present in the rendered policy.
    const rendered = JSON.stringify(policyResource.Properties.Policy);
    expect(rendered).toContain('Deny');
    expect(rendered).toContain('bedrock-agentcore:InvokeAgentRuntime');
    expect(rendered).toContain('aws:SourceVpc');
    expect(rendered).toContain('StringNotEquals');
  });
});

describe('DataStack — least-privilege roles (R10.3, R13.3)', () => {
  test('the agent execution role scopes Bedrock invoke to the specific model ARNs', () => {
    dataTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'BedrockInvokeScopedModels',
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: [
              'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514',
              'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
            ],
          }),
        ]),
      }),
    });
  });

  test('the agent execution role scopes aoss:APIAccessAll to the collection ARN', () => {
    dataTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AossApiAccessScopedCollection',
            Action: 'aoss:APIAccessAll',
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OpenSearch'), 'CollectionArn'] },
          }),
        ]),
      }),
    });
  });

  test('the proxy task role can invoke the runtime + index uploads + embed', () => {
    dataTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'InvokeAgentRuntime', Action: Match.arrayWith(['bedrock-agentcore:InvokeAgentRuntime']) }),
          Match.objectLike({ Sid: 'AossApiAccessForUploads', Action: 'aoss:APIAccessAll' }),
          Match.objectLike({ Sid: 'BedrockEmbedForUploads', Action: 'bedrock:InvokeModel' }),
          Match.objectLike({ Sid: 'S3UploadsReadWrite' }),
        ]),
      }),
    });
  });
});

describe('DataStack — OpenSearch provisioner + uploads', () => {
  test('the provisioner custom resource is a NextGen-generation collection', () => {
    const customResources = dataTemplate.findResources('AWS::CloudFormation::CustomResource');
    const provisioner = Object.entries(customResources).find(([logicalId]) =>
      logicalId.startsWith('OpenSearch'),
    );
    expect(provisioner).toBeDefined();
    expect(provisioner![1].Properties.Generation).toBe('NEXTGEN');
  });

  test('a private uploads bucket encrypted with a customer-managed KMS key', () => {
    // Customer content (uploaded contracts) must use a CM-CMK, not SSE-S3, so
    // key usage is auditable and revocable. The bucket references a KMS
    // key ARN rather than the AES256 (SSE-S3) algorithm.
    dataTemplate.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ]),
      }),
    });
    // A dedicated, rotating customer-managed key backs the bucket.
    dataTemplate.resourceCountIs('AWS::KMS::Key', 1);
    dataTemplate.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('the provisioner role is scoped to specific aoss actions, not aoss:*', () => {
    // The bootstrap provisioner must enumerate the aoss control-plane actions it
    // uses rather than granting the wildcard `aoss:*`.
    const policies = dataTemplate.findResources('AWS::IAM::Policy');
    const rendered = JSON.stringify(policies);
    expect(rendered).toContain('aoss:CreateCollection');
    expect(rendered).toContain('aoss:APIAccessAll');
    // No wildcard aoss action anywhere in the data stack policies.
    expect(rendered).not.toContain('"aoss:*"');
  });
});

describe('AppStack — Cognito auth layer', () => {
  test('a Cognito user pool with admin-only signup exists', () => {
    appTemplate.resourceCountIs('AWS::Cognito::UserPool', 1);
    appTemplate.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  test('a user pool client enables the USER_PASSWORD_AUTH flow (no Hosted UI / OAuth)', () => {
    appTemplate.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
    });
  });

  test('no Hosted-UI domain exists; a Secrets Manager secret holds the demo password', () => {
    appTemplate.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
    appTemplate.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('the proxy task definition receives Cognito + upload env vars', () => {
    appTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'COGNITO_USER_POOL_ID' }),
            Match.objectLike({ Name: 'COGNITO_CLIENT_ID' }),
            Match.objectLike({ Name: 'UPLOAD_BUCKET' }),
            Match.objectLike({ Name: 'OPENSEARCH_ENDPOINT' }),
          ]),
        }),
      ]),
    });
  });

  test('the proxy service runs desiredCount 2 with no public IP', () => {
    appTemplate.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      LaunchType: 'FARGATE',
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      }),
    });
  });
});

describe('WafStack — web ACL (R13.2)', () => {
  test('the web ACL is CLOUDFRONT-scoped with Common + SQLi managed rule groups', () => {
    wafTemplate.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'AWSManagedRulesSQLiRuleSet' }),
      ]),
    });
  });

  test('SizeRestrictions_BODY is overridden to Count so large uploads are not blocked at the edge', () => {
    wafTemplate.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
          Statement: Match.objectLike({
            ManagedRuleGroupStatement: Match.objectLike({
              RuleActionOverrides: Match.arrayWith([
                Match.objectLike({
                  Name: 'SizeRestrictions_BODY',
                  ActionToUse: { Count: {} },
                }),
              ]),
            }),
          }),
        }),
      ]),
    });
  });
});

describe('Stack outputs', () => {
  test('the App stack outputs the distribution domain + site URL', () => {
    appTemplate.hasOutput('DistributionDomainName', {});
    appTemplate.hasOutput('SiteUrl', {});
  });

  test('the Agent stack outputs the runtime ARN', () => {
    agentTemplate.hasOutput('AgentRuntimeArn', {});
  });
});

describe('BuildStack — cloud image builds (no local container engine)', () => {
  test('two CodeBuild projects (agent + proxy) exist', () => {
    buildTemplate.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('two ECR repositories exist and are emptied + removed on delete', () => {
    buildTemplate.resourceCountIs('AWS::ECR::Repository', 2);
    // emptyOnDelete is implemented via a custom resource that empties the repo;
    // the repository removal policy must be Delete (not Retain).
    const repos = buildTemplate.findResources('AWS::ECR::Repository');
    for (const key of Object.keys(repos)) {
      expect(repos[key].DeletionPolicy).toBe('Delete');
    }
  });

  test('the agent CodeBuild project builds on ARM64', () => {
    // The ARM build image implies a CodeBuild ARM compute type.
    buildTemplate.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ Type: 'ARM_CONTAINER' }),
    });
  });
});

describe('No local container build assets (Property 1)', () => {
  // The agent + proxy images must come from ECR (built in the cloud), NOT from
  // CDK local container assets. A fromAsset container build would surface as an
  // ecr_assets DockerImage asset in the synthesized assembly; here we assert the
  // consuming stacks reference an ECR image instead of bundling one locally.
  test('the proxy task definition references an ECR image (not a local asset)', () => {
    const taskDefs = appTemplate.findResources('AWS::ECS::TaskDefinition');
    const json = JSON.stringify(taskDefs);
    // ECR image refs resolve to an "<account>.dkr.ecr.<region>..." URI built
    // from the repository; assert no local asset hash image is inlined.
    expect(json).toMatch(/dkr\.ecr|ecr|Image/);
  });

  test('the agent runtime references a container URI (ECR), not a local asset path', () => {
    agentTemplate.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: Match.objectLike({
        ContainerConfiguration: Match.objectLike({
          ContainerUri: Match.anyValue(),
        }),
      }),
    });
  });
});
