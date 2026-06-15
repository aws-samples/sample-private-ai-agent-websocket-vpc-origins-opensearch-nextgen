# CDK app — Private Real-Time AI Agent

This is the AWS CDK application for the solution. For full prerequisites,
deploy/destroy instructions, architecture, and configuration, see the
**[top-level README](../README.md)**.

Quick reference (no local container engine required — images build in AWS
CodeBuild; deployable from AWS CloudShell):

```bash
npm install
npx cdk bootstrap aws://<account-id>/<region>   # one-time, shared
./scripts/deploy.sh        # deploy (Waf → Network → Build → Data → Agent → App)
./scripts/destroy.sh       # ordered teardown of per-deploy stacks + verify-empty
                           #   (retains the free VPC; --include-network removes it too)
```

Offline checks:

```bash
npx tsc --noEmit
npx jest
```
