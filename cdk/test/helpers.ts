/**
 * Shared test helpers for the split-stack CDK tests.
 *
 * Synthesizes the five stacks (Waf + Network + Data + AgentCore + App) with the
 * documented `testSynth` context flag so they build without Docker (the agent +
 * proxy images and the provisioner Lambda bundling are swapped for non-Docker
 * equivalents). Cross-stack references resolve within a single App.
 *
 * Tests that assert on a specific stack pick the matching Template from the
 * returned {@link SynthResult}.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentConfig } from '../lib/config';
import { WafStack } from '../lib/waf-stack';
import { NetworkStack } from '../lib/network-stack';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { AppStack } from '../lib/app-stack';

/** A fixed account/region used for every synthesized test stack. */
export const TEST_ENV = { account: '123456789012', region: 'us-east-1' } as const;

/** The WAF web ACL ARN passed to the app stack in tests. */
export const TEST_WEB_ACL_ARN =
  'arn:aws:wafv2:us-east-1:123456789012:global/webacl/PrivateRealtimeAiAgentWebAcl/abcd1234-5678-90ab-cdef-1234567890ab';

/**
 * Build a valid {@link AgentConfig} for tests, mirroring the `context.agent`
 * defaults in `cdk.json`. Overrides may be supplied to exercise variations.
 */
export function makeTestConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    region: 'us-east-1',
    bedrockModelId: 'anthropic.claude-sonnet-4-20250514',
    bedrockEmbedModelId: 'amazon.titan-embed-text-v2:0',
    openSearchIndex: 'agent-knowledge',
    ragTopK: 5,
    openSearchTimeout: 30,
    cpuArchitecture: 'X86_64',
    desiredCount: 2,
    deregistrationDelaySeconds: 300,
    priceClass: 'PriceClass_100',
    domainName: null,
    certificateArn: null,
    albOriginProtocol: 'HTTP',
    originDomainName: null,
    originCertificateArn: null,
    containerInsights: false,
    cloudFrontAccessLogs: false,
    availabilityZones: ['us-east-1a', 'us-east-1d'],
    instanceName: 'agent',
    collectionName: 'agent-rag-agent',
    agentRuntimeName: 'private_realtime_ai_agent_agent',
    ...overrides,
  };
}

/** The synthesized stacks and their {@link Template}s for assertions. */
export interface SynthResult {
  app: App;
  wafStack: WafStack;
  networkStack: NetworkStack;
  buildStack: BuildStack;
  dataStack: DataStack;
  agentStack: AgentCoreStack;
  appStack: AppStack;
  wafTemplate: Template;
  networkTemplate: Template;
  buildTemplate: Template;
  dataTemplate: Template;
  agentTemplate: Template;
  appTemplate: Template;
}

/**
 * Create an {@link App} with `testSynth` set, instantiate all five stacks, and
 * return them plus their synthesized {@link Template}s.
 */
export function synthStacks(configOverrides: Partial<AgentConfig> = {}): SynthResult {
  const app = new App({ context: { testSynth: true } });
  const config = makeTestConfig(configOverrides);
  const env = { account: TEST_ENV.account, region: TEST_ENV.region };

  const wafStack = new WafStack(app, 'TestWaf', {
    env: { account: TEST_ENV.account, region: 'us-east-1' },
    crossRegionReferences: true,
  });

  const networkStack = new NetworkStack(app, 'TestNetwork', { env, config });

  const buildStack = new BuildStack(app, 'TestBuild', { env, config });

  const dataStack = new DataStack(app, 'TestData', {
    env,
    config,
    vpc: networkStack.vpc,
    lambdaSecurityGroup: networkStack.ecsTaskSg,
    aossVpcEndpointId: networkStack.aossVpcEndpointId,
    agentImageRepository: buildStack.agentRepository,
  });
  dataStack.addDependency(networkStack);
  dataStack.addDependency(buildStack);

  const agentStack = new AgentCoreStack(app, 'TestAgent', {
    env,
    config,
    vpc: networkStack.vpc,
    securityGroup: networkStack.ecsTaskSg,
    executionRole: dataStack.agentExecutionRole,
    openSearchEndpoint: dataStack.collectionEndpoint,
    agentImageRepository: buildStack.agentRepository,
    agentImageTag: buildStack.agentImageTag,
  });
  agentStack.addDependency(dataStack);
  agentStack.addDependency(buildStack);

  const appStack = new AppStack(app, 'TestApp', {
    env,
    crossRegionReferences: true,
    config,
    vpc: networkStack.vpc,
    albSg: networkStack.albSg,
    ecsTaskSg: networkStack.ecsTaskSg,
    proxyTaskRole: dataStack.proxyTaskRole,
    uploadBucket: dataStack.uploadBucketName,
    openSearchEndpoint: dataStack.collectionEndpoint,
    agentRuntimeArn: agentStack.runtimeArn,
    webAclArn: TEST_WEB_ACL_ARN,
    proxyImageRepository: buildStack.proxyRepository,
    proxyImageTag: buildStack.proxyImageTag,
  });
  appStack.addDependency(wafStack);
  appStack.addDependency(agentStack);
  appStack.addDependency(dataStack);
  appStack.addDependency(buildStack);

  // The App stack wires the ALB SG ingress off an AwsCustomResource lookup that
  // (by design) depends on the distribution / VPC Origin → ALB → SG, which the
  // assertions library flags as cyclic; skip that check for the App template.
  return {
    app,
    wafStack,
    networkStack,
    buildStack,
    dataStack,
    agentStack,
    appStack,
    wafTemplate: Template.fromStack(wafStack),
    networkTemplate: Template.fromStack(networkStack),
    buildTemplate: Template.fromStack(buildStack),
    dataTemplate: Template.fromStack(dataStack),
    agentTemplate: Template.fromStack(agentStack),
    appTemplate: Template.fromStack(appStack, { skipCyclicalDependenciesCheck: true }),
  };
}
