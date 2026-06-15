/**
 * Helper for building the IAM resource ARNs that authorize invoking a given
 * Bedrock model identifier.
 *
 * Bedrock model identifiers come in two shapes, requiring different IAM
 * resources:
 *
 * - **Bare foundation-model id** (e.g. `amazon.titan-embed-text-v2:0`): a single
 *   account-less `foundation-model` ARN.
 * - **Cross-region inference profile id** (e.g.
 *   `us.anthropic.claude-sonnet-4-5-20250929-v1:0`): requires BOTH the
 *   account-scoped `inference-profile` ARN AND the underlying `foundation-model`
 *   ARNs in every region the profile can route to.
 */

/**
 * Build the list of ARNs to grant `bedrock:InvokeModel*` on for `modelId`.
 *
 * @param region  The stack region (e.g. `us-east-1`).
 * @param account The AWS account id (used only for inference-profile ARNs).
 * @param modelId The Bedrock model id or inference-profile id.
 */
export function bedrockModelArns(region: string, account: string, modelId: string): string[] {
  // Already a full ARN — grant exactly it.
  if (modelId.startsWith('arn:')) {
    return [modelId];
  }

  // Cross-region inference profile (geo-prefixed: us. / eu. / apac. / global.).
  const geoMatch = /^([a-z]+)\.(.+)$/.exec(modelId);
  const knownGeos: Record<string, string[]> = {
    us: ['us-east-1', 'us-east-2', 'us-west-2'],
    eu: ['eu-west-1', 'eu-west-3', 'eu-central-1', 'eu-north-1'],
    apac: ['ap-northeast-1', 'ap-northeast-2', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2'],
    global: ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1'],
  };
  if (geoMatch && knownGeos[geoMatch[1]]) {
    const geo = geoMatch[1];
    const baseModelId = geoMatch[2];
    return [
      `arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`,
      ...knownGeos[geo].map((r) => `arn:aws:bedrock:${r}::foundation-model/${baseModelId}`),
    ];
  }

  // Bare foundation-model id — single account-less ARN.
  return [`arn:aws:bedrock:${region}::foundation-model/${modelId}`];
}
