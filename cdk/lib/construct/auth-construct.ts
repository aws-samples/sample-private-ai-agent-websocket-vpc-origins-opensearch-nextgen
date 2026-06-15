/**
 * Auth construct (v2): an Amazon Cognito User Pool for the demo's self-hosted login.
 *
 * The proxy runs in no-egress isolated subnets and enforces login itself with
 * its **own** username/password form (not the Cognito Hosted UI, whose OAuth
 * domain has no PrivateLink endpoint and would be unreachable from a private VPC).
 * The proxy authenticates directly against the Cognito Identity Provider API
 * (`InitiateAuth` / `USER_PASSWORD_AUTH`) over the `cognito-idp` VPC endpoint,
 * so this construct only needs to provision:
 *   - a User Pool (email sign-in, admin-only user creation — no public signup),
 *   - an app client with the `USER_PASSWORD_AUTH` flow enabled (public client,
 *     no secret; no OAuth/Hosted-UI config required), and
 *   - one demo user whose password is auto-generated at deploy time and stored
 *     in Secrets Manager so the deploy script can print it.
 *
 * There is no Hosted-UI domain and no OAuth callback wiring, so this construct
 * has no dependency on the CloudFront distribution domain — removing the
 * previous post-hoc `addCallbackUrls` cycle entirely.
 *
 * _Requirements: auth layer (login with generated credentials)._
 */
import { CfnOutput, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/** Props for {@link AuthConstruct}. */
export interface AuthConstructProps {
  /** Username for the auto-created demo user. */
  readonly demoUsername: string;

  /** Demo user's email (Cognito requires it for email sign-in). */
  readonly demoEmail: string;
}

/**
 * Cognito User Pool + app client + a single auto-provisioned demo user.
 */
export class AuthConstruct extends Construct {
  /** The user pool. */
  public readonly userPool: cognito.UserPool;

  /** The app client (USER_PASSWORD_AUTH flow). */
  public readonly userPoolClient: cognito.UserPoolClient;

  /** Secret holding the generated demo-user password (read by the deploy script). */
  public readonly credentialsSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    // --- User pool ---------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // admin-created users only (private demo)
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY, // demo: tear down cleanly
    });

    // --- App client (USER_PASSWORD_AUTH; no Hosted UI / OAuth) -------------
    // A public client (no secret). The proxy calls InitiateAuth with the
    // username/password from its own login form; no OAuth flows are configured
    // because the Hosted UI is unreachable from the private VPC.
    this.userPoolClient = this.userPool.addClient('AppClient', {
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(8),
      idTokenValidity: Duration.hours(8),
      refreshTokenValidity: Duration.days(7),
    });

    // --- Generated demo-user password (Secrets Manager) --------------------
    // Cognito password policy requires upper/lower/digit/symbol; the generated
    // secret template guarantees inclusion and excludes ambiguous/url-unsafe chars.
    this.credentialsSecret = new secretsmanager.Secret(this, 'DemoUserPassword', {
      description: 'Auto-generated password for the demo Cognito user',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: props.demoUsername }),
        generateStringKey: 'password',
        passwordLength: 20,
        excludePunctuation: false,
        // Exclude characters that are awkward in URLs/CLIs or ambiguous to read.
        excludeCharacters: '"\'`\\/@%&<>|;: {}[]()',
        includeSpace: false,
        requireEachIncludedType: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Demo user (admin-created, permanent generated password) -----------
    //
    // IMPORTANT: the demo password must NOT be passed via a CloudFormation
    // `{{resolve:secretsmanager:...}}` dynamic reference into a custom resource.
    // CloudFormation does NOT resolve Secrets Manager dynamic references inside
    // Custom::AWS / AwsCustomResource properties (to avoid leaking secrets into
    // custom-resource events), so the literal token string `{{resolve:...}}`
    // would be set as the Cognito password — while the deploy script reads the
    // REAL generated value from Secrets Manager. That divergence is the
    // "password drift" bug.
    //
    // The robust fix: a single Lambda-backed custom resource that, at runtime,
    // reads the secret value via the SDK and performs adminCreateUser +
    // adminSetUserPassword atomically. The password set on Cognito and the value
    // stored in Secrets Manager are therefore the SAME string — no dynamic
    // reference, no drift.
    const provisionUserFn = new lambda.Function(this, 'DemoUserProvisionerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.minutes(2),
      logRetention: logs.RetentionDays.ONE_WEEK,
      code: lambda.Code.fromInline(DEMO_USER_PROVISIONER_SOURCE),
      description: 'Creates the demo Cognito user and sets its password from Secrets Manager (single source of truth)',
    });

    // Least-privilege: read only this secret; admin user ops only on this pool.
    this.credentialsSecret.grantRead(provisionUserFn);
    provisionUserFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword'],
        resources: [this.userPool.userPoolArn],
      }),
    );

    const provider = new cr.Provider(this, 'DemoUserProvider', {
      onEventHandler: provisionUserFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    new CustomResource(this, 'DemoUser', {
      serviceToken: provider.serviceToken,
      properties: {
        UserPoolId: this.userPool.userPoolId,
        Username: props.demoUsername,
        Email: props.demoEmail,
        // Pass the secret ARN (NOT the value) — the Lambda resolves the value
        // at runtime via GetSecretValue, so no secret token ever transits a
        // CloudFormation custom-resource property.
        SecretArn: this.credentialsSecret.secretArn,
        // Re-run the password set whenever the secret version changes.
        SecretVersionId: this.credentialsSecret.secretFullArn ?? this.credentialsSecret.secretArn,
        // Bump to force the custom resource to re-apply the password on deploy.
        Revision: '2',
      },
    });

    // --- Outputs (consumed by the deploy script) ---------------------------
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'DemoUsername', { value: props.demoUsername });
    new CfnOutput(this, 'DemoPasswordSecretArn', {
      description: 'Secrets Manager ARN holding the generated demo-user password',
      value: this.credentialsSecret.secretArn,
    });
  }
}

/**
 * Inline Python source for the demo-user provisioner custom resource.
 *
 * Reads the demo password from Secrets Manager AT RUNTIME (so the value set on
 * the Cognito user is the exact same string stored in the secret — the single
 * source of truth the deploy script also reads), then idempotently creates the
 * user and sets the password as PERMANENT. This avoids the CloudFormation
 * dynamic-reference resolution gap that caused password drift when the password
 * was passed through an AwsCustomResource property.
 *
 * Create/Update both (re)apply the password; Delete is a no-op (the user pool is
 * destroyed with the stack).
 */
const DEMO_USER_PROVISIONER_SOURCE = `
import json
import urllib.request

import boto3


def _send(event, context, status, reason=""):
    body = json.dumps({
        "Status": status,
        "Reason": reason or f"see CloudWatch log stream {context.log_stream_name}",
        "PhysicalResourceId": event.get("PhysicalResourceId") or context.log_stream_name,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": {},
    }).encode("utf-8")
    req = urllib.request.Request(
        event["ResponseURL"], data=body, method="PUT",
        headers={"content-type": "", "content-length": str(len(body))},
    )
    urllib.request.urlopen(req)  # noqa: S310 - the URL is the CFN-provided presigned S3 URL


def handler(event, context):
    try:
        request_type = event["RequestType"]
        if request_type == "Delete":
            _send(event, context, "SUCCESS", "delete is a no-op")
            return

        props = event["ResourceProperties"]
        user_pool_id = props["UserPoolId"]
        username = props["Username"]
        email = props["Email"]
        secret_arn = props["SecretArn"]

        secret_json = boto3.client("secretsmanager").get_secret_value(
            SecretId=secret_arn
        )["SecretString"]
        password = json.loads(secret_json)["password"]

        idp = boto3.client("cognito-idp")
        try:
            idp.admin_create_user(
                UserPoolId=user_pool_id,
                Username=username,
                MessageAction="SUPPRESS",
                UserAttributes=[
                    {"Name": "email", "Value": email},
                    {"Name": "email_verified", "Value": "true"},
                ],
            )
        except idp.exceptions.UsernameExistsException:
            pass  # idempotent: user already exists

        # Set the SAME password as a permanent password (no FORCE_CHANGE flow).
        idp.admin_set_user_password(
            UserPoolId=user_pool_id,
            Username=username,
            Password=password,
            Permanent=True,
        )
        _send(event, context, "SUCCESS", f"provisioned demo user {username}")
    except Exception as exc:  # noqa: BLE001 - report any failure back to CFN
        _send(event, context, "FAILED", str(exc))
`;

