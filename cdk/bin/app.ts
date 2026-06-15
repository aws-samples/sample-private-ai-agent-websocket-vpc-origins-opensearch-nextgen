#!/usr/bin/env node
/**
 * CDK application entry point (v2 — split-stack architecture).
 *
 * The solution is decomposed into isolated stacks so deploy/destroy is clean and
 * the long-lived networking layer is not torn down on every iteration:
 *
 *   WafStack       (us-east-1)  — CloudFront-scoped AWS WAF web ACL.
 *   NetworkStack               — VPC + endpoints + shared SGs (LONG-LIVED).
 *   BuildStack                 — CodeBuild image builds → ECR (no local Docker).
 *   DataStack                  — OpenSearch NextGen + S3 uploads + IAM roles.
 *   AgentCoreStack             — Bedrock AgentCore Runtime (the agent).
 *   AppStack                   — ALB + ECS proxy + CloudFront + Cognito.
 *
 * Dependency flow (no cycles):
 *   Waf ─┐
 *        ├─▶ App
 *   Network ─▶ Data ─▶ AgentCore ─▶ App
 *   Build ─▶ AgentCore   Build ─▶ App
 *   Network ─────────────────────▶ App
 *   Network ─▶ Data ──────────────▶ App
 *
 * Stack ids are namespaced by instanceName so multiple deployments coexist:
 *   PrivateRealtimeAiAgent<Pascal>{Waf,Network,Build,Data,Agent,App}.
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { resolveConfig, instanceNameToPascal } from '../lib/config';
import { WafStack } from '../lib/waf-stack';
import { NetworkStack } from '../lib/network-stack';
import { BuildStack } from '../lib/build-stack';
import { DataStack } from '../lib/data-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();

const config = resolveConfig(app);

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = config.region ?? process.env.CDK_DEFAULT_REGION;
const env = { account, region };

const suffix = instanceNameToPascal(config.instanceName);
const base = `PrivateRealtimeAiAgent${suffix}`;

// 1. WAF web ACL — always us-east-1 (CloudFront scope requirement).
const wafStack = new WafStack(app, `${base}Waf`, {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
});

// 2. Network — long-lived VPC + endpoints + SGs.
const networkStack = new NetworkStack(app, `${base}Network`, { env, config });

// 3. Build — CodeBuild builds the agent (ARM64) + proxy images → ECR.
//    No local container engine is used; consumers reference the ECR images.
const buildStack = new BuildStack(app, `${base}Build`, { env, config });

// 4. Data — OpenSearch NextGen + S3 uploads + AgentCore exec role + proxy task role.
const dataStack = new DataStack(app, `${base}Data`, {
  env,
  config,
  vpc: networkStack.vpc,
  lambdaSecurityGroup: networkStack.ecsTaskSg,
  aossVpcEndpointId: networkStack.aossVpcEndpointId,
  agentImageRepository: buildStack.agentRepository,
});
dataStack.addDependency(networkStack);
// The agent execution role (created in DataStack to break the aoss data-access
// cycle) is granted ECR pull on the BuildStack agent repository, so Data must
// depend on Build for CDK to emit a clean cross-stack export/import.
dataStack.addDependency(buildStack);

// 5. AgentCore Runtime (consumes the ARM64 agent image from BuildStack).
const agentStack = new AgentCoreStack(app, `${base}Agent`, {
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

// 6. App — ALB + ECS proxy + CloudFront + Cognito (consumes the proxy image).
const appStack = new AppStack(app, `${base}App`, {
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
  webAclArn: wafStack.webAclArn,
  proxyImageRepository: buildStack.proxyRepository,
  proxyImageTag: buildStack.proxyImageTag,
});
appStack.addDependency(wafStack);
appStack.addDependency(agentStack);
appStack.addDependency(dataStack);
appStack.addDependency(buildStack);

app.synth();
