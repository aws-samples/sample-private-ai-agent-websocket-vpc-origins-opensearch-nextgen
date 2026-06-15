/**
 * NetworkStack (v2) — the long-lived networking layer.
 *
 * Holds the VPC, the (unrouted) internet gateway, every interface/gateway VPC
 * endpoint, and the shared security groups. This stack is deployed ONCE and left
 * up: the slow part of any teardown is AWS releasing the managed ENIs (Lambda
 * Hyperplane, AgentCore egress, interface endpoints) that live in this VPC, so
 * keeping NetworkStack stable lets the application stacks (Data/Agent/App) be
 * destroyed and redeployed quickly without ever tearing down the VPC.
 *
 * It exposes the VPC, the three shared security groups, and the OpenSearch
 * Serverless data-plane endpoint id; downstream stacks consume them via ordinary
 * cross-stack references (CDK synthesizes the Export/ImportValue wiring). There
 * are no cycles because NetworkStack depends on nothing.
 */
import { Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { AgentConfig } from './config';
import { VpcConstruct } from './construct/vpc-construct';

/** Props for {@link NetworkStack}. */
export interface NetworkStackProps extends StackProps {
  /** The validated agent configuration (drives AZ pinning). */
  config: AgentConfig;
}

/** The networking foundation: VPC + endpoints + shared security groups. */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.IVpc;
  public readonly albSg: ec2.ISecurityGroup;
  public readonly ecsTaskSg: ec2.ISecurityGroup;
  public readonly endpointSg: ec2.ISecurityGroup;
  public readonly aossVpcEndpointId: string;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const vpcConstruct = new VpcConstruct(this, 'Vpc', { config: props.config });

    this.vpc = vpcConstruct.vpc;
    this.albSg = vpcConstruct.albSg;
    this.ecsTaskSg = vpcConstruct.ecsTaskSg;
    this.endpointSg = vpcConstruct.endpointSg;
    this.aossVpcEndpointId = vpcConstruct.aossVpcEndpointId;
  }
}
