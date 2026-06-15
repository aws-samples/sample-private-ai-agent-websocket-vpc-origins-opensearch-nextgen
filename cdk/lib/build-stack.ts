/**
 * BuildStack — cloud image builds (no local container engine).
 *
 * Builds the two container images this solution needs entirely in AWS CodeBuild
 * (pushed to ECR), so deploying requires NO local Docker/Finch and works from
 * AWS CloudShell:
 *
 *   - the **agent** image (ARM64 — Amazon Bedrock AgentCore Runtime requirement), and
 *   - the **proxy** image (matches the configured ECS CPU architecture).
 *
 * It exposes the resulting ECR repositories + image tags as deploy-time tokens
 * that downstream stacks consume:
 *   - AgentCoreStack → `agentRepository` + `agentImageTag`
 *     (via `AgentRuntimeArtifact.fromEcrRepository`).
 *   - AppStack/ProxyConstruct → `proxyRepository` + `proxyImageTag`
 *     (via `ContainerImage.fromEcrRepository`).
 *
 * Both ECR repos are `emptyOnDelete` + DESTROY, so teardown leaves no orphaned
 * repositories or images. This stack depends only on the account/region env (the
 * CodeBuild builds run on AWS-managed compute, not inside the VPC).
 */
import * as path from 'path';
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { AgentConfig } from './config';
import { ImageBuildConstruct } from './construct/image-build-construct';

/** Props for {@link BuildStack}. */
export interface BuildStackProps extends StackProps {
  config: AgentConfig;
}

/** Cloud-build stack: produces the agent (ARM64) and proxy image URIs in ECR. */
export class BuildStack extends Stack {
  /** ECR repo + tag for the ARM64 agent image (AgentCore Runtime). */
  public readonly agentRepository: ecr.IRepository;
  public readonly agentImageTag: string;

  /** ECR repo + tag for the proxy image (ECS Fargate). */
  public readonly proxyRepository: ecr.IRepository;
  public readonly proxyImageTag: string;

  constructor(scope: Construct, id: string, props: BuildStackProps) {
    super(scope, id, props);

    const { config } = props;
    const repoPrefix = `private-realtime-ai-agent-${config.instanceName}`;

    // --- Agent image (ALWAYS ARM64 — AgentCore Runtime requirement) --------
    const agentBuild = new ImageBuildConstruct(this, 'AgentImage', {
      sourceDirectory: path.join(__dirname, '../src/container/agent'),
      platform: 'linux/arm64',
      repositoryName: `${repoPrefix}/agent`,
    });
    this.agentRepository = agentBuild.repository;
    this.agentImageTag = agentBuild.imageTag;

    // --- Proxy image (follows the configured CPU architecture) -------------
    const proxyPlatform = config.cpuArchitecture === 'ARM64' ? 'linux/arm64' : 'linux/amd64';
    const proxyBuild = new ImageBuildConstruct(this, 'ProxyImage', {
      sourceDirectory: path.join(__dirname, '../src/container/proxy'),
      platform: proxyPlatform,
      repositoryName: `${repoPrefix}/proxy`,
    });
    this.proxyRepository = proxyBuild.repository;
    this.proxyImageTag = proxyBuild.imageTag;

    new CfnOutput(this, 'AgentImageUri', { value: agentBuild.imageUri });
    new CfnOutput(this, 'ProxyImageUri', { value: proxyBuild.imageUri });
  }
}
