/**
 * AWS WAF stack: us-east-1 AWS WAF WebACL (WAFv2 API, scope=CLOUDFRONT) with AWS managed rule
 * groups.
 *
 * A CloudFront-scoped AWS WAF web ACL must be created in `us-east-1` regardless of
 * the region the application stack is deployed to. This stack is therefore
 * deployed independently in us-east-1, and its {@link WafStack.webAclArn} is
 * consumed cross-region by the agent stack via `crossRegionReferences: true`.
 *
 * The web ACL has a default action of `allow` and includes the AWS managed rule
 * groups `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesSQLiRuleSet`. Each
 * group is added with an override action of `none` so the managed rules' own
 * block actions take effect, dropping common web exploits (including SQL
 * injection and cross-site scripting) at the edge before they reach the VPC
 * Origin (Requirements 13.1, 13.2, 13.6).
 */
import { Stack, StackProps } from 'aws-cdk-lib';
import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface WafStackProps extends StackProps {}

export class WafStack extends Stack {
  /**
   * The ARN of the CloudFront-scoped AWS WAF web ACL. Passed cross-region to the
   * agent stack (via `crossRegionReferences`) and associated with the
   * CloudFront distribution as its `webAclId`.
   */
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafStackProps = {}) {
    super(scope, id, props);

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      // CloudFront-scoped web ACLs must be created in us-east-1.
      scope: 'CLOUDFRONT',
      // Allow by default; the managed rule groups below block matching requests.
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'PrivateRealtimeAiAgentWebAcl',
      },
      rules: [
        {
          // Highest priority: explicitly ALLOW WebSocket upgrade requests so the
          // managed rule groups below never evaluate (and never block) the
          // handshake. CloudFront forwards the `Upgrade: websocket` header via
          // the AllViewer origin request policy; the AWS CommonRuleSet otherwise
          // blocks the upgrade GET (it has no body / trips header heuristics),
          // which surfaced as a 403 on `wss://.../ws/`. A WAF `allow` match
          // terminates rule evaluation for that request, so this is scoped
          // narrowly to requests that actually carry the WebSocket upgrade
          // header and does not weaken protection for normal HTTP traffic.
          name: 'AllowWebSocketUpgrade',
          priority: 0,
          action: { allow: {} },
          statement: {
            byteMatchStatement: {
              // `fieldToMatch` is an untyped passthrough in this CDK version, so
              // the nested keys must use raw CloudFormation casing (`Name`).
              fieldToMatch: { singleHeader: { Name: 'upgrade' } },
              positionalConstraint: 'CONTAINS',
              searchString: 'websocket',
              textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AllowWebSocketUpgrade',
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          // `none` lets the managed group's internal block actions apply, so
          // common web exploits (including XSS) are blocked.
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // The CommonRuleSet's `SizeRestrictions_BODY` rule blocks ANY
              // request body larger than 8 KB at the edge. That is fine for the
              // chat/query paths but it blocks the document-upload endpoint
              // (`POST /api/upload`, up to 5 MB) with a 403 before the request
              // ever reaches the proxy. Override just that one sub-rule to
              // COUNT so it no longer blocks; every other CommonRuleSet rule
              // (XSS, LFI/RFI, bad-bots, etc.) still BLOCKS as normal. The proxy
              // enforces its own body limits on every route (5 MB + extension
              // allowlist on uploads, 10k-char cap on queries), so dropping the
              // generic 8 KB edge cap does not weaken meaningful protection.
              ruleActionOverrides: [
                {
                  name: 'SizeRestrictions_BODY',
                  actionToUse: { count: {} },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
          },
        },
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 2,
          // `none` lets the managed group's internal block actions apply, so
          // SQL injection attempts are blocked.
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AWSManagedRulesSQLiRuleSet',
          },
        },
        {
          // Rate-based rule: block IPs exceeding 100 requests per 5-minute
          // window. Protects against cost amplification via unbounded Bedrock
          // inference invocations and brute-force login attempts.
          name: 'RateLimitPerIP',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'RateLimitPerIP',
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;
  }
}
