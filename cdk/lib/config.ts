/**
 * Configuration parsing and validation for the Private Real-Time AI Agent CDK app.
 *
 * `resolveConfig` reads the `context.agent` object from CDK context, applies the
 * design defaults, and enforces fail-fast validation rules. Any invalid value
 * throws an `Error` during synthesis so that no CloudFormation template is
 * produced (Requirements 1.5, 1.9, 14.4, 14.5).
 */
import { Construct } from 'constructs';

/**
 * The validated, typed agent configuration resolved from `context.agent`.
 */
export interface AgentConfig {
  /** Target AWS region (resolved from context or the CDK environment region). */
  region?: string;
  /** Amazon Bedrock foundation model identifier used for inference. */
  bedrockModelId: string;
  /** Amazon Bedrock embeddings model identifier used for RAG. */
  bedrockEmbedModelId: string;
  /** OpenSearch Serverless vector index name. */
  openSearchIndex: string;
  /** Maximum number of RAG documents to retrieve (1..5). */
  ragTopK: number;
  /**
   * Per-request OpenSearch Serverless (aoss) client read timeout in seconds
   * (1..120). Larger than opensearch-py's 10s default so the first query after
   * a fresh deploy rides out the NextGen scale-from-zero warm-up instead of
   * logging a transient ReadTimeoutError. Default 30.
   */
  openSearchTimeout: number;
  /** Fargate CPU architecture. */
  cpuArchitecture: 'X86_64' | 'ARM64';
  /** Desired number of running Fargate tasks (>= 2). */
  desiredCount: number;
  /** Target group deregistration delay in seconds. */
  deregistrationDelaySeconds: number;
  /** CloudFront price class. */
  priceClass: string;
  /** Optional custom domain name for the CloudFront distribution. */
  domainName: string | null;
  /** Optional ACM certificate ARN (must be in us-east-1) for the custom domain. */
  certificateArn: string | null;
  /**
   * Protocol for the CloudFront VPC Origin -> internal ALB hop.
   *
   * - `'HTTP'` (default): CloudFront connects to the ALB on HTTP:80. The hop is
   *   private (AWS backbone, internal ALB) with network-level encryption in
   *   transit over the AWS backbone. Zero prework.
   * - `'HTTPS'`: CloudFront connects to the ALB on HTTPS:443 with SNI/cert
   *   validation. Requires {@link originDomainName} + {@link originCertificateArn}
   *   (a publicly-trusted ACM cert in the stack region whose domain matches
   *   {@link originDomainName}). Gives end-to-end TLS (defense-in-depth / "encrypt
   *   in transit everywhere" compliance). The origin domain does NOT need a public
   *   DNS record — the VPC Origin routes to the ALB by ARN; the name is used only
   *   for the TLS SNI + certificate match.
   */
  albOriginProtocol: 'HTTP' | 'HTTPS';
  /**
   * The origin hostname CloudFront presents to the ALB in the TLS SNI and
   * validates the ALB certificate against (e.g. `agent-origin.example.com`).
   * Required when {@link albOriginProtocol} is `'HTTPS'`; otherwise null.
   */
  originDomainName: string | null;
  /**
   * ARN of a publicly-trusted ACM certificate (in the STACK region, not
   * necessarily us-east-1) that the ALB HTTPS listener presents and whose domain
   * matches {@link originDomainName}. Required when {@link albOriginProtocol} is
   * `'HTTPS'`; otherwise null.
   */
  originCertificateArn: string | null;
  /** Whether to enable ECS Container Insights. */
  containerInsights: boolean;
  /**
   * Whether to enable CloudFront standard access logging to a dedicated S3
   * bucket. Off by default to keep the sample lean (the proxy already logs
   * request-level detail). When true, an ACL-enabled log bucket is provisioned
   * (CloudFront's log-delivery group writes via ACL) and removed on teardown.
   */
  cloudFrontAccessLogs: boolean;
  /**
   * Explicit Availability Zone *names* the VPC spans. Required because Bedrock
   * AgentCore Runtime only supports a subset of AZs per region (by AZ ID): in
   * us-east-1 those are `use1-az1`, `use1-az2`, `use1-az4`. The VPC (and thus
   * the AgentCore VPC-egress ENIs) must live only in supported AZs, so the
   * default `maxAzs`-based selection (which can pick an unsupported AZ such as
   * us-east-1b / use1-az6) is replaced by this explicit list. When empty, the
   * VPC falls back to `maxAzs: 2`.
   *
   * NOTE: AZ *names* (e.g. `us-east-1a`) map to different AZ *IDs* per account,
   * so the correct names are account-specific. Verify with
   * `aws ec2 describe-availability-zones` that the chosen names map to
   * AgentCore-supported AZ IDs.
   */
  availabilityZones: string[];
  /**
   * Logical instance name that namespaces every globally-or-account-scoped
   * resource so multiple v2 deployments can coexist in one account/region
   * without conflict. Lowercase letters/digits/hyphen, starts with a letter,
   * <= 18 chars (`^[a-z][a-z0-9-]{0,17}$`). Default `v2`.
   *
   * It derives:
   *  - the stack ids (`PrivateRealtimeAiAgent<Pascal>` + `...Waf`),
   *  - the OpenSearch collection name (`agent-rag-<instanceName>`), and
   *  - the AgentCore runtime name (`private_realtime_ai_agent_<underscored>`),
   * unless an explicit `agentRuntimeName` override is supplied.
   */
  instanceName: string;
  /**
   * The OpenSearch Serverless collection name, derived from {@link instanceName}
   * (`agent-rag-<instanceName>`). 3-28 chars, lowercase letters/numbers/hyphen,
   * starts with a letter.
   */
  collectionName: string;
  /**
   * The AgentCore Runtime name. Derived from {@link instanceName} as
   * `private_realtime_ai_agent_<underscored>` unless explicitly overridden via
   * `context.agent.agentRuntimeName`. Must match `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`
   * (letters/numbers/underscore, starts with a letter, <= 48 chars; no hyphens).
   */
  agentRuntimeName: string;
}

/**
 * Default values for the agent configuration, consistent with the
 * `context.agent` block in `cdk.json` and the design document defaults.
 */
export const AGENT_CONFIG_DEFAULTS = {
  // Cross-region inference profile id (NOT a bare foundation-model id): modern
  // Claude models on Bedrock are invoked through a `us.`-prefixed inference
  // profile via the Converse/ConverseStream API. The bare foundation-model id
  // (e.g. `anthropic.claude-sonnet-4-20250514`) returns "model identifier is
  // invalid".
  bedrockModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  bedrockEmbedModelId: 'amazon.titan-embed-text-v2:0',
  openSearchIndex: 'agent-knowledge',
  ragTopK: 5,
  openSearchTimeout: 30,
  cpuArchitecture: 'X86_64' as const,
  desiredCount: 2,
  deregistrationDelaySeconds: 300,
  priceClass: 'PriceClass_100',
  containerInsights: false,
  cloudFrontAccessLogs: false,
  albOriginProtocol: 'HTTP' as const,
  instanceName: 'demo',
  // No hardcoded Availability Zones. The deploy script selects AZs at deploy
  // time that satisfy BOTH AgentCore Runtime AND every VPC endpoint service we
  // use (notably aoss), and passes them via `-c agent.availabilityZones=...`.
  // AZ *names* map to different AZ *IDs* per account, so they must not be baked
  // into source. When empty, the VPC falls back to `maxAzs: 2` (see below).
  availabilityZones: [] as string[],
} satisfies Partial<AgentConfig>;

/**
 * Matches a valid instance name: starts with a lowercase letter, then up to 17
 * lowercase letters/digits/hyphens. Kept short (<= 18 chars) so the derived
 * collection name (`agent-rag-<instanceName>`, prefix 10 chars) stays within
 * the OpenSearch Serverless 28-char collection-name limit, and the derived
 * runtime name stays within the AgentCore 48-char limit.
 */
const INSTANCE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,17}$/;

/**
 * Derive the PascalCase stack-id segment from an instance name, e.g.
 * `blue-1` -> `Blue1`. Used to build `PrivateRealtimeAiAgent<Segment>`.
 */
export function instanceNameToPascal(instanceName: string): string {
  return instanceName
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Derive the AgentCore runtime name from an instance name. AgentCore names use
 * underscores (no hyphens), so hyphens are converted: `blue-1` ->
 * `private_realtime_ai_agent_blue_1`.
 */
function deriveAgentRuntimeName(instanceName: string): string {
  return `private_realtime_ai_agent_${instanceName.replace(/-/g, '_')}`;
}

/** Derive the OpenSearch collection name: `agent-rag-<instanceName>`. */
function deriveCollectionName(instanceName: string): string {
  return `agent-rag-${instanceName}`;
}

/**
 * Matches a valid AgentCore Runtime name: starts with a letter, then up to 47
 * letters/numbers/underscores. Hyphens are NOT permitted by the AgentCore API.
 */
const AGENT_RUNTIME_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

/**
 * Matches a well-formed AWS region identifier, e.g. `us-east-1`, `eu-west-2`,
 * `ap-southeast-1`. Used for fail-fast region validation (Requirement 1.9).
 */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;

/** The valid Fargate CPU architecture values. */
const VALID_CPU_ARCHITECTURES: ReadonlyArray<AgentConfig['cpuArchitecture']> = ['X86_64', 'ARM64'];

/**
 * Returns a trimmed string when `value` is a non-empty string, otherwise `null`.
 * Treats `null`, `undefined`, and whitespace-only strings as "not provided".
 */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerces a context value to an integer. Accepts numbers and numeric strings
 * (CLI `-c` overrides arrive as strings). Returns `null` when the value is not
 * a finite integer.
 */
function toInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Coerces a context value to a boolean. Accepts booleans and the strings
 * `"true"`/`"false"` (case-insensitive). Falls back to `fallback` otherwise.
 */
function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

/**
 * Resolve and validate the {@link AgentConfig} from CDK context.
 *
 * Parses `context.agent`, applies the design defaults, resolves the target
 * region (context value, otherwise the CDK environment region from
 * `CDK_DEFAULT_REGION`), and enforces the following fail-fast validation rules
 * (throwing a descriptive `Error` so synthesis produces no template):
 *
 * - the resolved region must match a known AWS region pattern (R1.9);
 * - `desiredCount` must be an integer `>= 2` (R6.2);
 * - `ragTopK` must be an integer in `[1, 5]` (R11.3);
 * - a `domainName` without a `certificateArn` throws (R14.4);
 * - a `certificateArn` without a `domainName` throws (R14.5);
 * - neither provided selects the default CloudFront domain/certificate (R14.3).
 *
 * @param scope - A construct used to read CDK context (e.g. the App or Stack).
 * @returns the resolved, validated agent configuration.
 */
export function resolveConfig(scope: Construct): AgentConfig {
  const raw = { ...((scope.node.tryGetContext('agent') ?? {}) as Record<string, unknown>) };

  // Merge flat dotted-key overrides (e.g. `-c agent.albOriginProtocol=HTTPS`)
  // on top of the `agent` object. The CDK CLI stores `-c a.b=c` as a FLAT
  // context key "a.b" — it does NOT deep-merge into the "agent" object — so
  // without this, per-key CLI overrides would be silently ignored (the
  // documented and script-driven way to override a single field). Reading the
  // flat keys here makes `-c agent.<field>=<value>` work as expected, while
  // `-c agent='{...}'` (whole-object replace) still works via tryGetContext
  // above. Flat keys win over the object so an explicit CLI override is honored.
  const FLAT_KEYS = [
    'region',
    'bedrockModelId',
    'bedrockEmbedModelId',
    'openSearchIndex',
    'ragTopK',
    'openSearchTimeout',
    'cpuArchitecture',
    'desiredCount',
    'deregistrationDelaySeconds',
    'priceClass',
    'domainName',
    'certificateArn',
    'albOriginProtocol',
    'originDomainName',
    'originCertificateArn',
    'containerInsights',
    'cloudFrontAccessLogs',
    'availabilityZones',
    'instanceName',
    'agentRuntimeName',
  ];
  for (const key of FLAT_KEYS) {
    const flat = scope.node.tryGetContext(`agent.${key}`);
    if (flat !== undefined) {
      raw[key] = flat;
    }
  }

  // Region: explicit context value, otherwise the CDK environment region.
  const region = optionalString(raw.region) ?? optionalString(process.env.CDK_DEFAULT_REGION) ?? undefined;
  if (region !== undefined && !AWS_REGION_PATTERN.test(region)) {
    throw new Error(
      `Invalid AWS region "${region}": region must be a valid AWS region identifier ` +
        `(e.g. "us-east-1", "eu-west-2"). Provide a valid value via context.agent.region ` +
        `or the CDK_DEFAULT_REGION environment variable.`,
    );
  }

  // Bedrock model identifiers: default when not provided (R10.4/R10.5).
  const bedrockModelId = optionalString(raw.bedrockModelId) ?? AGENT_CONFIG_DEFAULTS.bedrockModelId;
  const bedrockEmbedModelId =
    optionalString(raw.bedrockEmbedModelId) ?? AGENT_CONFIG_DEFAULTS.bedrockEmbedModelId;

  const openSearchIndex = optionalString(raw.openSearchIndex) ?? AGENT_CONFIG_DEFAULTS.openSearchIndex;
  const priceClass = optionalString(raw.priceClass) ?? AGENT_CONFIG_DEFAULTS.priceClass;

  // CPU architecture: validate against the supported union (R6).
  const cpuArchitecture =
    raw.cpuArchitecture === undefined || raw.cpuArchitecture === null
      ? AGENT_CONFIG_DEFAULTS.cpuArchitecture
      : (raw.cpuArchitecture as AgentConfig['cpuArchitecture']);
  if (!VALID_CPU_ARCHITECTURES.includes(cpuArchitecture)) {
    throw new Error(
      `Invalid cpuArchitecture "${String(raw.cpuArchitecture)}": must be one of ` +
        `${VALID_CPU_ARCHITECTURES.join(', ')}.`,
    );
  }

  // desiredCount: integer >= 2 (R6.2).
  const desiredCount = raw.desiredCount === undefined ? AGENT_CONFIG_DEFAULTS.desiredCount : toInteger(raw.desiredCount);
  if (desiredCount === null || desiredCount < 2) {
    throw new Error(
      `Invalid desiredCount "${String(raw.desiredCount)}": must be an integer >= 2 ` +
        `so the service spans at least two Availability Zones.`,
    );
  }

  // ragTopK: integer in [1, 5] (R11.3).
  const ragTopK = raw.ragTopK === undefined ? AGENT_CONFIG_DEFAULTS.ragTopK : toInteger(raw.ragTopK);
  if (ragTopK === null || ragTopK < 1 || ragTopK > 5) {
    throw new Error(`Invalid ragTopK "${String(raw.ragTopK)}": must be an integer between 1 and 5 inclusive.`);
  }

  // openSearchTimeout: integer in [1, 120] seconds (aoss client read timeout).
  const openSearchTimeout =
    raw.openSearchTimeout === undefined
      ? AGENT_CONFIG_DEFAULTS.openSearchTimeout
      : toInteger(raw.openSearchTimeout);
  if (openSearchTimeout === null || openSearchTimeout < 1 || openSearchTimeout > 120) {
    throw new Error(
      `Invalid openSearchTimeout "${String(raw.openSearchTimeout)}": must be an integer between 1 and 120 seconds inclusive.`,
    );
  }

  // deregistrationDelaySeconds: non-negative integer.
  const deregistrationDelaySeconds =
    raw.deregistrationDelaySeconds === undefined
      ? AGENT_CONFIG_DEFAULTS.deregistrationDelaySeconds
      : toInteger(raw.deregistrationDelaySeconds);
  if (deregistrationDelaySeconds === null || deregistrationDelaySeconds < 0) {
    throw new Error(
      `Invalid deregistrationDelaySeconds "${String(raw.deregistrationDelaySeconds)}": ` +
        `must be a non-negative integer.`,
    );
  }

  const containerInsights = toBoolean(raw.containerInsights, AGENT_CONFIG_DEFAULTS.containerInsights);
  const cloudFrontAccessLogs = toBoolean(
    raw.cloudFrontAccessLogs,
    AGENT_CONFIG_DEFAULTS.cloudFrontAccessLogs,
  );

  // Availability Zones the VPC spans. Accepts a string array or a comma-
  // separated string. Provided at DEPLOY TIME by the deploy script (which
  // selects AZs supporting both AgentCore and aoss) — never hardcoded in source.
  // Empty => the VPC falls back to maxAzs: 2. A single explicit AZ is invalid
  // (the service must span >= 2 AZs), so fail fast.
  let availabilityZones: string[] = [...AGENT_CONFIG_DEFAULTS.availabilityZones];
  if (Array.isArray(raw.availabilityZones)) {
    availabilityZones = raw.availabilityZones
      .map((z) => (typeof z === 'string' ? z.trim() : ''))
      .filter((z) => z.length > 0);
  } else if (typeof raw.availabilityZones === 'string') {
    availabilityZones = raw.availabilityZones
      .split(',')
      .map((z) => z.trim())
      .filter((z) => z.length > 0);
  }
  if (availabilityZones.length === 1) {
    throw new Error(
      `Invalid availabilityZones [${availabilityZones[0]}]: provide at least TWO ` +
        `Availability Zones (the service must span >= 2 AZs), or none to let the VPC ` +
        `choose. The deploy script selects AgentCore+aoss-supported AZs automatically.`,
    );
  }

  // Instance name: namespaces every account/region-scoped resource (stack
  // names, OpenSearch collection, AgentCore runtime) so multiple deployments
  // coexist without conflict. Default `demo`.
  const instanceName = optionalString(raw.instanceName) ?? AGENT_CONFIG_DEFAULTS.instanceName;
  if (!INSTANCE_NAME_PATTERN.test(instanceName)) {
    throw new Error(
      `Invalid instanceName "${instanceName}": must match ^[a-z][a-z0-9-]{0,17}$ ` +
        `(lowercase letters, digits, and hyphens, starting with a letter, max 18 ` +
        `characters). It namespaces the stack names, the OpenSearch collection, ` +
        `and the AgentCore runtime so multiple deployments do not collide.`,
    );
  }

  // Derive the collection name from the instance name and validate the
  // OpenSearch Serverless naming rule (3-28 chars, lowercase, starts with a letter).
  const collectionName = deriveCollectionName(instanceName);
  if (collectionName.length > 28) {
    throw new Error(
      `Derived OpenSearch collection name "${collectionName}" exceeds 28 characters. ` +
        `Use a shorter instanceName (the prefix "agent-rag-" consumes 10 characters).`,
    );
  }

  // AgentCore Runtime name: explicit override, else derived from instanceName.
  // Validate against the AgentCore naming rule (letters/numbers/underscore,
  // starts with a letter, <= 48 chars; no hyphens).
  const agentRuntimeName =
    optionalString(raw.agentRuntimeName) ?? deriveAgentRuntimeName(instanceName);
  if (!AGENT_RUNTIME_NAME_PATTERN.test(agentRuntimeName)) {
    throw new Error(
      `Invalid agentRuntimeName "${agentRuntimeName}": must match ` +
        `^[a-zA-Z][a-zA-Z0-9_]{0,47}$ (letters, numbers, and underscores only, ` +
        `starting with a letter, max 48 characters; hyphens are not allowed). ` +
        `It is derived from instanceName unless you set context.agent.agentRuntimeName.`,
    );
  }

  // Custom domain / certificate mutual-presence checks (R14.3/R14.4/R14.5).
  const domainName = optionalString(raw.domainName);
  const certificateArn = optionalString(raw.certificateArn);
  if (domainName !== null && certificateArn === null) {
    throw new Error(
      `A custom domainName ("${domainName}") was provided without an ACM certificateArn. ` +
        `Provide context.agent.certificateArn referencing an ACM certificate in the us-east-1 region.`,
    );
  }
  if (certificateArn !== null && domainName === null) {
    throw new Error(
      `An ACM certificateArn ("${certificateArn}") was provided without a custom domainName. ` +
        `Provide context.agent.domainName for the alternate domain name.`,
    );
  }

  // ALB-origin TLS mode (HTTP default | HTTPS opt-in for end-to-end encryption).
  const rawOriginProtocol = optionalString(raw.albOriginProtocol);
  const albOriginProtocol = (rawOriginProtocol ?? AGENT_CONFIG_DEFAULTS.albOriginProtocol).toUpperCase();
  if (albOriginProtocol !== 'HTTP' && albOriginProtocol !== 'HTTPS') {
    throw new Error(
      `Invalid albOriginProtocol "${rawOriginProtocol}": must be "HTTP" or "HTTPS". ` +
        `"HTTP" (default) connects CloudFront to the internal ALB on port 80 over the ` +
        `private AWS backbone; "HTTPS" enables end-to-end TLS and requires ` +
        `context.agent.originDomainName + context.agent.originCertificateArn.`,
    );
  }
  const originDomainName = optionalString(raw.originDomainName);
  const originCertificateArn = optionalString(raw.originCertificateArn);
  if (albOriginProtocol === 'HTTPS') {
    if (originDomainName === null || originCertificateArn === null) {
      throw new Error(
        `albOriginProtocol "HTTPS" requires BOTH context.agent.originDomainName and ` +
          `context.agent.originCertificateArn. The certificate must be a publicly-trusted ` +
          `ACM certificate in the stack region whose domain matches originDomainName. ` +
          `Note: the origin domain does NOT need a public DNS record (the VPC Origin routes ` +
          `to the ALB by ARN); the name is used only for the TLS SNI + certificate match.`,
      );
    }
  } else if (originDomainName !== null || originCertificateArn !== null) {
    throw new Error(
      `context.agent.originDomainName / originCertificateArn were provided but ` +
        `albOriginProtocol is "HTTP". Set albOriginProtocol to "HTTPS" to enable the ` +
        `encrypted CloudFront->ALB hop, or remove the origin domain/cert values.`,
    );
  }

  return {
    region,
    bedrockModelId,
    bedrockEmbedModelId,
    openSearchIndex,
    ragTopK,
    openSearchTimeout,
    cpuArchitecture,
    desiredCount,
    deregistrationDelaySeconds,
    priceClass,
    domainName,
    certificateArn,
    albOriginProtocol: albOriginProtocol as 'HTTP' | 'HTTPS',
    originDomainName,
    originCertificateArn,
    containerInsights,
    cloudFrontAccessLogs,
    availabilityZones,
    instanceName,
    collectionName,
    agentRuntimeName,
  };
}
