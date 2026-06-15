/**
 * Unit tests for `resolveConfig` and the fail-fast validation rules in
 * `lib/config.ts`.
 *
 * These tests exercise the configuration parser by constructing a `cdk.App`
 * with an `agent` context object and asserting both the success and the
 * throwing paths.
 *
 * Requirements covered: 1.5 (synth fails on invalid config / valid config
 * synthesizes), 1.9 (invalid region rejected), 14.4 (domain without cert
 * throws), 14.5 (cert without domain throws), plus the 14.3 default path and
 * the design defaults (R6.2 desiredCount, R11.3 ragTopK), and the v2
 * AgentCore runtime-name validation rule (no hyphens, underscore-only).
 */
import * as cdk from 'aws-cdk-lib';

import { AGENT_CONFIG_DEFAULTS, AgentConfig, resolveConfig } from '../lib/config';

/**
 * Build a CDK App whose `agent` context equals `agent`, then resolve the
 * config from it. Passing the App as the scope mirrors how `bin/app.ts`
 * resolves config at synth time.
 */
function resolveWithContext(agent: Record<string, unknown>): AgentConfig {
  const app = new cdk.App({ context: { agent } });
  return resolveConfig(app);
}

/**
 * A minimal but valid `agent` context. Individual tests override fields to
 * exercise specific validation branches.
 */
const VALID_AGENT_CONTEXT: Record<string, unknown> = {
  region: 'us-east-1',
  bedrockModelId: 'anthropic.claude-sonnet-4-20250514',
  bedrockEmbedModelId: 'amazon.titan-embed-text-v2:0',
  openSearchIndex: 'agent-knowledge',
  ragTopK: 5,
  cpuArchitecture: 'X86_64',
  desiredCount: 2,
  deregistrationDelaySeconds: 300,
  priceClass: 'PriceClass_100',
  domainName: null,
  certificateArn: null,
  containerInsights: false,
  agentRuntimeName: 'private_realtime_ai_agent_v2',
};

describe('resolveConfig', () => {
  // The CDK environment region influences the region-fallback branch, so we
  // isolate every test from whatever is set in the surrounding environment and
  // restore it afterwards.
  const ORIGINAL_CDK_DEFAULT_REGION = process.env.CDK_DEFAULT_REGION;

  beforeEach(() => {
    delete process.env.CDK_DEFAULT_REGION;
  });

  afterAll(() => {
    if (ORIGINAL_CDK_DEFAULT_REGION === undefined) {
      delete process.env.CDK_DEFAULT_REGION;
    } else {
      process.env.CDK_DEFAULT_REGION = ORIGINAL_CDK_DEFAULT_REGION;
    }
  });

  describe('region validation (R1.9)', () => {
    it('throws when the region is not a valid AWS region identifier', () => {
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, region: 'not-a-region' })).toThrow(
        /Invalid AWS region/,
      );
    });

    it('accepts a well-formed region identifier', () => {
      const config = resolveWithContext({ ...VALID_AGENT_CONTEXT, region: 'eu-west-2' });
      expect(config.region).toBe('eu-west-2');
    });

    it('falls back to CDK_DEFAULT_REGION when no region is provided in context (R1.6)', () => {
      process.env.CDK_DEFAULT_REGION = 'us-east-1';
      const { region, ...withoutRegion } = VALID_AGENT_CONTEXT;
      const config = resolveWithContext(withoutRegion);
      expect(config.region).toBe('us-east-1');
    });
  });

  describe('desiredCount validation (R6.2)', () => {
    it('throws when desiredCount is less than 2', () => {
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, desiredCount: 1 })).toThrow(
        /Invalid desiredCount/,
      );
    });

    it('accepts desiredCount equal to 2 (the lower boundary)', () => {
      const config = resolveWithContext({ ...VALID_AGENT_CONTEXT, desiredCount: 2 });
      expect(config.desiredCount).toBe(2);
    });

    it('accepts desiredCount greater than 2', () => {
      const config = resolveWithContext({ ...VALID_AGENT_CONTEXT, desiredCount: 4 });
      expect(config.desiredCount).toBe(4);
    });
  });

  describe('ragTopK validation (R11.3)', () => {
    it('throws when ragTopK is below the lower bound (0)', () => {
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, ragTopK: 0 })).toThrow(/Invalid ragTopK/);
    });

    it('throws when ragTopK is above the upper bound (6)', () => {
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, ragTopK: 6 })).toThrow(/Invalid ragTopK/);
    });

    it('accepts ragTopK at both boundaries (1 and 5)', () => {
      expect(resolveWithContext({ ...VALID_AGENT_CONTEXT, ragTopK: 1 }).ragTopK).toBe(1);
      expect(resolveWithContext({ ...VALID_AGENT_CONTEXT, ragTopK: 5 }).ragTopK).toBe(5);
    });

    it('defaults openSearchTimeout to 30 when omitted', () => {
      expect(resolveWithContext(VALID_AGENT_CONTEXT).openSearchTimeout).toBe(30);
    });

    it('accepts a custom openSearchTimeout within [1, 120]', () => {
      expect(
        resolveWithContext({ ...VALID_AGENT_CONTEXT, openSearchTimeout: 45 }).openSearchTimeout,
      ).toBe(45);
    });

    it('throws when openSearchTimeout is out of range', () => {
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, openSearchTimeout: 0 })).toThrow(
        /Invalid openSearchTimeout/,
      );
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, openSearchTimeout: 121 })).toThrow(
        /Invalid openSearchTimeout/,
      );
    });

    it('defaults albOriginProtocol to HTTP with null origin domain/cert', () => {
      const config = resolveWithContext(VALID_AGENT_CONTEXT);
      expect(config.albOriginProtocol).toBe('HTTP');
      expect(config.originDomainName).toBeNull();
      expect(config.originCertificateArn).toBeNull();
    });

    it('accepts HTTPS origin mode when domain + cert are both provided', () => {
      const config = resolveWithContext({
        ...VALID_AGENT_CONTEXT,
        albOriginProtocol: 'HTTPS',
        originDomainName: 'agent-origin.example.com',
        originCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      });
      expect(config.albOriginProtocol).toBe('HTTPS');
      expect(config.originDomainName).toBe('agent-origin.example.com');
      expect(config.originCertificateArn).toBe(
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      );
    });

    it('throws when albOriginProtocol is HTTPS without origin domain + cert', () => {
      expect(() =>
        resolveWithContext({ ...VALID_AGENT_CONTEXT, albOriginProtocol: 'HTTPS' }),
      ).toThrow(/requires BOTH/);
    });

    it('throws when origin domain/cert are set but protocol is HTTP', () => {
      expect(() =>
        resolveWithContext({
          ...VALID_AGENT_CONTEXT,
          originDomainName: 'agent-origin.example.com',
          originCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
        }),
      ).toThrow(/albOriginProtocol is "HTTP"/);
    });

    it('throws on an invalid albOriginProtocol value', () => {
      expect(() =>
        resolveWithContext({ ...VALID_AGENT_CONTEXT, albOriginProtocol: 'TCP' }),
      ).toThrow(/Invalid albOriginProtocol/);
    });

    it('merges flat dotted-key overrides (-c agent.<field>=<value>) over the agent object', () => {
      // The CDK CLI stores `-c agent.albOriginProtocol=HTTPS` as a FLAT context
      // key "agent.albOriginProtocol", not merged into the "agent" object.
      // resolveConfig must read those flat keys so per-key CLI/script overrides
      // actually take effect (and win over the object).
      const app = new cdk.App({
        context: {
          agent: { ...VALID_AGENT_CONTEXT, albOriginProtocol: 'HTTP' },
          'agent.albOriginProtocol': 'HTTPS',
          'agent.originDomainName': 'agent-origin.example.com',
          'agent.originCertificateArn': 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
          'agent.openSearchTimeout': 45,
        },
      });
      const config = resolveConfig(app);
      expect(config.albOriginProtocol).toBe('HTTPS');
      expect(config.originDomainName).toBe('agent-origin.example.com');
      expect(config.openSearchTimeout).toBe(45);
    });
  });

  describe('agentRuntimeName validation (v2 AgentCore naming)', () => {
    it('throws when agentRuntimeName contains a hyphen (AgentCore disallows hyphens)', () => {
      expect(() => resolveWithContext({ ...VALID_AGENT_CONTEXT, agentRuntimeName: 'bad-name' })).toThrow(
        /Invalid agentRuntimeName/,
      );
    });

    it('accepts a valid underscore-separated agentRuntimeName', () => {
      const config = resolveWithContext({
        ...VALID_AGENT_CONTEXT,
        agentRuntimeName: 'my_agent_runtime_v2',
      });
      expect(config.agentRuntimeName).toBe('my_agent_runtime_v2');
    });
  });

  describe('instanceName namespacing (multi-deployment isolation)', () => {
    it('defaults instanceName to "demo" and derives the agent names', () => {
      const config = resolveWithContext({ ...VALID_AGENT_CONTEXT, agentRuntimeName: undefined });
      expect(config.instanceName).toBe('demo');
      expect(config.collectionName).toBe('agent-rag-demo');
      expect(config.agentRuntimeName).toBe('private_realtime_ai_agent_demo');
    });

    it('derives distinct collection + runtime names for a different instanceName', () => {
      const config = resolveWithContext({
        ...VALID_AGENT_CONTEXT,
        instanceName: 'dev',
        // no explicit agentRuntimeName -> derived from instanceName
        agentRuntimeName: undefined,
      });
      expect(config.collectionName).toBe('agent-rag-dev');
      expect(config.agentRuntimeName).toBe('private_realtime_ai_agent_dev');
    });

    it('converts hyphens to underscores in the derived runtime name', () => {
      const config = resolveWithContext({
        ...VALID_AGENT_CONTEXT,
        instanceName: 'blue-1',
        agentRuntimeName: undefined,
      });
      expect(config.collectionName).toBe('agent-rag-blue-1');
      expect(config.agentRuntimeName).toBe('private_realtime_ai_agent_blue_1');
    });

    it('lets an explicit agentRuntimeName override the derived value', () => {
      const config = resolveWithContext({
        ...VALID_AGENT_CONTEXT,
        instanceName: 'dev',
        agentRuntimeName: 'custom_runtime_name',
      });
      expect(config.collectionName).toBe('agent-rag-dev');
      expect(config.agentRuntimeName).toBe('custom_runtime_name');
    });

    it('throws when instanceName has invalid characters (uppercase)', () => {
      expect(() =>
        resolveWithContext({ ...VALID_AGENT_CONTEXT, instanceName: 'Dev', agentRuntimeName: undefined }),
      ).toThrow(/Invalid instanceName/);
    });

    it('throws when instanceName is too long (derived collection name > 28 chars)', () => {
      // 19-char instanceName fails the <=18 pattern bound first.
      expect(() =>
        resolveWithContext({
          ...VALID_AGENT_CONTEXT,
          instanceName: 'abcdefghijklmnopqrs',
          agentRuntimeName: undefined,
        }),
      ).toThrow(/Invalid instanceName/);
    });
  });

  describe('custom domain / certificate mutual presence (R14.3, R14.4, R14.5)', () => {
    it('throws when a domain name is provided without a certificate ARN (R14.4)', () => {
      expect(() =>
        resolveWithContext({ ...VALID_AGENT_CONTEXT, domainName: 'agent.example.com', certificateArn: null }),
      ).toThrow(/without an ACM certificateArn/);
    });

    it('throws when a certificate ARN is provided without a domain name (R14.5)', () => {
      expect(() =>
        resolveWithContext({
          ...VALID_AGENT_CONTEXT,
          domainName: null,
          certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc',
        }),
      ).toThrow(/without a custom domainName/);
    });

    it('returns null domain and certificate when neither is provided (R14.3 default path)', () => {
      const config = resolveWithContext({ ...VALID_AGENT_CONTEXT, domainName: null, certificateArn: null });
      expect(config.domainName).toBeNull();
      expect(config.certificateArn).toBeNull();
    });

    it('returns both values when domain and certificate are both provided', () => {
      const config = resolveWithContext({
        ...VALID_AGENT_CONTEXT,
        domainName: 'agent.example.com',
        certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/abc',
      });
      expect(config.domainName).toBe('agent.example.com');
      expect(config.certificateArn).toBe('arn:aws:acm:us-east-1:111122223333:certificate/abc');
    });
  });

  describe('valid full configuration and defaults (R1.5)', () => {
    it('returns the expected typed values for a fully specified config', () => {
      const config = resolveWithContext(VALID_AGENT_CONTEXT);
      expect(config).toEqual({
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
        availabilityZones: [],
        instanceName: 'demo',
        collectionName: 'agent-rag-demo',
        agentRuntimeName: 'private_realtime_ai_agent_v2',
      });
    });

    it('applies design defaults when optional fields are omitted', () => {
      process.env.CDK_DEFAULT_REGION = 'us-east-1';
      // Empty agent context: every field should fall back to its default.
      const config = resolveWithContext({});
      expect(config.bedrockModelId).toBe(AGENT_CONFIG_DEFAULTS.bedrockModelId);
      expect(config.bedrockEmbedModelId).toBe(AGENT_CONFIG_DEFAULTS.bedrockEmbedModelId);
      expect(config.openSearchIndex).toBe(AGENT_CONFIG_DEFAULTS.openSearchIndex);
      expect(config.ragTopK).toBe(5);
      expect(config.desiredCount).toBe(2);
      expect(config.cpuArchitecture).toBe('X86_64');
      expect(config.deregistrationDelaySeconds).toBe(AGENT_CONFIG_DEFAULTS.deregistrationDelaySeconds);
      expect(config.priceClass).toBe(AGENT_CONFIG_DEFAULTS.priceClass);
      expect(config.containerInsights).toBe(false);
      expect(config.domainName).toBeNull();
      expect(config.certificateArn).toBeNull();
      // instanceName defaults to 'demo'; the runtime + collection names derive from it.
      expect(config.instanceName).toBe(AGENT_CONFIG_DEFAULTS.instanceName);
      expect(config.collectionName).toBe('agent-rag-demo');
      expect(config.agentRuntimeName).toBe('private_realtime_ai_agent_demo');
    });
  });
});
