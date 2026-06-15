/**
 * Uploads construct (v2): a private Amazon S3 bucket for user-uploaded documents.
 *
 * The proxy stores both the original upload and its extracted text here (the
 * extracted text lets the live-audit flow run on whichever proxy task picks up
 * the WebSocket). The bucket is fully private (no public access, SSE, TLS-only)
 * and the proxy task role is granted scoped read/write via {@link grantReadWrite}.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** Props for {@link UploadsConstruct}. */
export interface UploadsConstructProps {
  /**
   * Days after which uploaded objects expire (demo hygiene / cost). Set 0 to
   * disable expiry.
   * @default 30
   */
  readonly expireAfterDays?: number;
}

/**
 * A private, encrypted S3 bucket for user document uploads.
 */
export class UploadsConstruct extends Construct {
  /** The upload bucket. */
  public readonly bucket: s3.Bucket;

  /** The customer-managed KMS key encrypting the bucket (CM-CMK). */
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: UploadsConstructProps = {}) {
    super(scope, id);

    const expireDays = props.expireAfterDays ?? 30;

    // Customer content (uploaded contract documents) is encrypted at rest with a
    // dedicated, rotating Customer Managed KMS Key (CM-CMK) rather than SSE-S3,
    // so key usage is auditable via CloudTrail KMS data events and access can be
    // revoked at the key. (Customer-content encryption.)
    this.encryptionKey = new kms.Key(this, 'Key', {
      description: 'CMK for user-uploaded contract documents (uploads bucket)',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY, // demo: deleted with the stack
    });

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true, // reduce KMS request costs via S3 Bucket Keys
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY, // demo: empty + delete on teardown
      autoDeleteObjects: true,
      // Expiry applies ONLY to the transient user-upload prefixes. The SOP
      // knowledge-base PDFs under `sops/` are the durable source copy and must
      // NOT expire, so the lifecycle rules are prefix-scoped rather than
      // bucket-wide.
      lifecycleRules:
        expireDays > 0
          ? [
              { prefix: 'uploads/', expiration: Duration.days(expireDays) },
              { prefix: 'extracted/', expiration: Duration.days(expireDays) },
            ]
          : undefined,
    });
  }

  /**
   * Grant a principal (the proxy task role) scoped read/write to the uploads
   * bucket — only the `uploads/*` and `extracted/*` prefixes the proxy uses.
   */
  public grantReadWrite(grantee: iam.IGrantable): void {
    this.bucket.grantReadWrite(grantee, 'uploads/*');
    this.bucket.grantReadWrite(grantee, 'extracted/*');
  }
}
