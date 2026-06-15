/**
 * AgentCoreStack (v2) — the Amazon Bedrock AgentCore Runtime that hosts the agent.
 *
 * Thin stack: it builds + publishes the ARM64 agent image and creates the
 * AgentCore Runtime in VPC-egress mode, reusing the VPC + SG from NetworkStack
 * and the execution role + collection endpoint from DataStack. Splitting it out
 * means the (slow-to-release AgentCore egress ENI) lifecycle is isolated to this
 * stack — destroying/redeploying the App or Data stacks is never gated on it.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AgentConfig } from './config';
import { AgentCoreConstruct } from './construct/agentcore-construct';

/** Props for {@link AgentCoreStack}. */
export interface AgentCoreStackProps extends StackProps {
  config: AgentConfig;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  /** Execution role created in the DataStack (already scoped to models + collection). */
  executionRole: iam.IRole;
  /** OpenSearch data-plane endpoint (agent's OPENSEARCH_ENDPOINT). */
  openSearchEndpoint: string;
  /** ECR repo holding the ARM64 agent image (BuildStack). */
  agentImageRepository: ecr.IRepository;
  /** Agent image tag in the repo (BuildStack). */
  agentImageTag: string;
}

/** The AgentCore Runtime stack. */
export class AgentCoreStack extends Stack {
  public readonly agentCore: AgentCoreConstruct;
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    this.agentCore = new AgentCoreConstruct(this, 'AgentCore', {
      config: props.config,
      vpc: props.vpc,
      securityGroup: props.securityGroup,
      executionRole: props.executionRole,
      openSearchEndpoint: props.openSearchEndpoint,
      agentImageRepository: props.agentImageRepository,
      agentImageTag: props.agentImageTag,
    });

    this.runtimeArn = this.agentCore.runtimeArn;

    new CfnOutput(this, 'AgentRuntimeArn', {
      description: 'Bedrock AgentCore Runtime ARN hosting the Strands agent',
      value: this.runtimeArn,
    });
  }
}
