/**
 * ImageBuildConstruct — cloud image build (no local container engine).
 *
 * Builds a container image in AWS CodeBuild at deploy time and pushes it to an
 * Amazon ECR repository, so deploying needs NO local Docker/Finch (and works
 * from AWS CloudShell). The flow:
 *
 *   1. The source directory is zipped + uploaded to S3 as a CDK **file asset**
 *      (this is a plain zip — no container engine is invoked during synth).
 *   2. An AWS CodeBuild project (native ARM64 or x86_64 image, `privileged` for
 *      Docker) pulls that S3 source, runs `docker build` for the requested
 *      platform, and `docker push`es to the ECR repository.
 *   3. A Lambda-backed custom resource starts the build on Create/Update and
 *      waits for it to finish (polling), failing the stack if the build fails.
 *
 * The image tag is the source asset hash, so any source change produces a new
 * tag → a new build → a new {@link imageUri}, which makes downstream stacks
 * (AgentCore Runtime, ECS task) update. Consumers reference the image by
 * {@link repository} + {@link imageTag} (e.g. `ContainerImage.fromEcrRepository`
 * or `AgentRuntimeArtifact.fromEcrRepository`).
 *
 * Teardown: the ECR repository is created with `emptyOnDelete` + DESTROY, so it
 * (and its images) are removed cleanly with the stack — no orphaned repo.
 */
import * as path from 'path';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/** Target build/runtime platform for the image. */
export type ImagePlatform = 'linux/arm64' | 'linux/amd64';

/** Props for {@link ImageBuildConstruct}. */
export interface ImageBuildConstructProps {
  /** Absolute path to the directory containing the Dockerfile + build context. */
  readonly sourceDirectory: string;
  /** Target platform. AgentCore requires `linux/arm64`. */
  readonly platform: ImagePlatform;
  /**
   * ECR repository name. Lowercase, may include slashes; namespaced by the
   * caller (e.g. `private-realtime-ai-agent-agent/agent`).
   */
  readonly repositoryName: string;
}

/**
 * Builds and pushes a container image to ECR using CodeBuild (no local engine).
 */
export class ImageBuildConstruct extends Construct {
  /** The ECR repository the image is pushed to. */
  public readonly repository: ecr.Repository;
  /** The image tag (the source asset hash). */
  public readonly imageTag: string;
  /** Full image URI `<repoUri>:<tag>` consumers reference. */
  public readonly imageUri: string;
  /** The CodeBuild project performing the build. */
  public readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: ImageBuildConstructProps) {
    super(scope, id);

    const stack = Stack.of(this);

    // --- ECR repository (clean teardown: emptied + deleted with the stack) --
    this.repository = new ecr.Repository(this, 'Repo', {
      repositoryName: props.repositoryName,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: true,
    });

    // --- Source asset (plain zip upload to S3; no container engine) ---------
    const asset = new s3assets.Asset(this, 'Source', {
      path: props.sourceDirectory,
    });
    // The asset hash is a stable, content-addressed tag: it changes only when
    // the source changes, so a rebuild + new image URI happen exactly then.
    this.imageTag = asset.assetHash;
    this.imageUri = `${this.repository.repositoryUri}:${this.imageTag}`;

    // --- CodeBuild project (builds for the requested platform, pushes to ECR) -
    const isArm = props.platform === 'linux/arm64';
    const buildImage = isArm
      ? codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0
      : codebuild.LinuxBuildImage.AMAZON_LINUX_2_5;

    this.project = new codebuild.Project(this, 'Build', {
      projectName: `${props.repositoryName.replace(/[^a-zA-Z0-9-_]/g, '-')}-build`,
      source: codebuild.Source.s3({
        bucket: asset.bucket,
        path: asset.s3ObjectKey,
      }),
      environment: {
        buildImage,
        privileged: true, // required to run the Docker daemon in the build
      },
      environmentVariables: {
        REPO_URI: { value: this.repository.repositoryUri },
        IMAGE_TAG: { value: this.imageTag },
        TARGET_PLATFORM: { value: props.platform },
        AWS_DEFAULT_REGION: { value: stack.region },
      },
      timeout: Duration.minutes(30),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "Logging in to Amazon ECR..."',
              'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$(echo "$REPO_URI" | cut -d/ -f1)"',
            ],
          },
          build: {
            commands: [
              'echo "Building image $REPO_URI:$IMAGE_TAG for $TARGET_PLATFORM..."',
              'docker build --platform "$TARGET_PLATFORM" -t "$REPO_URI:$IMAGE_TAG" .',
            ],
          },
          post_build: {
            commands: [
              'echo "Pushing image..."',
              'docker push "$REPO_URI:$IMAGE_TAG"',
            ],
          },
        },
      }),
    });

    // CodeBuild needs to push to the repo and read the S3 source asset.
    this.repository.grantPullPush(this.project);
    asset.grantRead(this.project);

    // --- Build trigger: start the build on deploy and wait for it ----------
    const triggerFn = new lambda.Function(this, 'TriggerOnEventFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      timeout: Duration.minutes(2),
      logRetention: logs.RetentionDays.ONE_WEEK,
      code: lambda.Code.fromInline(BUILD_TRIGGER_SOURCE),
      description: 'Starts the image CodeBuild on deploy (onEvent)',
    });
    const isCompleteFn = new lambda.Function(this, 'TriggerIsCompleteFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.is_complete',
      timeout: Duration.minutes(2),
      logRetention: logs.RetentionDays.ONE_WEEK,
      code: lambda.Code.fromInline(BUILD_TRIGGER_SOURCE),
      description: 'Polls the image CodeBuild until done (isComplete)',
    });
    for (const fn of [triggerFn, isCompleteFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:ListBuildsForProject'],
          resources: [this.project.projectArn],
        }),
      );
    }

    const provider = new cr.Provider(this, 'BuildProvider', {
      onEventHandler: triggerFn,
      isCompleteHandler: isCompleteFn,
      queryInterval: Duration.seconds(15),
      totalTimeout: Duration.minutes(40),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const trigger = new CustomResource(this, 'BuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: this.project.projectName,
        // Changing the tag (source hash) re-triggers the build via Update.
        ImageTag: this.imageTag,
      },
    });
    trigger.node.addDependency(this.project);
  }
}

/**
 * Inline Python for the build-trigger custom resource.
 *
 * onEvent (Create/Update): starts a CodeBuild build and records the build id.
 * isComplete: polls until the build reaches a terminal state; SUCCEEDED → done,
 * any failure state → raise (fails the stack with the build id). Delete is a
 * no-op (the ECR repo is emptied+deleted with the stack).
 */
const BUILD_TRIGGER_SOURCE = `
import boto3

_TERMINAL_OK = "SUCCEEDED"
_TERMINAL_BAD = ("FAILED", "FAULT", "TIMED_OUT", "STOPPED")


def on_event(event, context):
    request_type = event["RequestType"]
    if request_type == "Delete":
        return {"PhysicalResourceId": event.get("PhysicalResourceId") or "image-build"}

    project = event["ResourceProperties"]["ProjectName"]
    build_id = boto3.client("codebuild").start_build(projectName=project)["build"]["id"]
    print(f"started build {build_id} for project {project}")
    # Carry the build id forward to is_complete via Data.
    return {"PhysicalResourceId": "image-build", "Data": {"BuildId": build_id}}


def _latest_build_id(project):
    ids = boto3.client("codebuild").list_builds_for_project(projectName=project).get("ids", [])
    return ids[0] if ids else None


def is_complete(event, context):
    if event["RequestType"] == "Delete":
        return {"IsComplete": True}

    project = event["ResourceProperties"]["ProjectName"]
    build_id = (event.get("Data") or {}).get("BuildId") or _latest_build_id(project)
    if not build_id:
        return {"IsComplete": False}

    cb = boto3.client("codebuild")
    builds = cb.batch_get_builds(ids=[build_id]).get("builds", [])
    if not builds:
        return {"IsComplete": False}
    status = builds[0].get("buildStatus", "IN_PROGRESS")
    print(f"build {build_id} status={status}")
    if status == _TERMINAL_OK:
        return {"IsComplete": True}
    if status in _TERMINAL_BAD:
        raise Exception(f"image build {build_id} did not succeed (status {status}); see CodeBuild logs")
    return {"IsComplete": False}
`;
