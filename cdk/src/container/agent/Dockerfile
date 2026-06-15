# Strands agent image for Bedrock AgentCore Runtime (v2).
#
# AgentCore Runtime requires ARM64 images. CDK builds + pushes this to ECR via
# AgentRuntimeArtifact.fromAsset({ platform: LINUX_ARM64 }). The bedrock-agentcore
# SDK's BedrockAgentCoreApp provides the /invocations (POST) + /ping (GET) HTTP
# surface and the SSE streaming transport on port 8080.
#
# Base image is pulled from the Amazon ECR Public mirror of Docker Hub
# (public.ecr.aws/docker/library/...) rather than docker.io, so cloud builds are
# not subject to Docker Hub's unauthenticated pull-rate limit (HTTP 429).
#
# Supply-chain note (BSC39): the tag below is intentionally NOT digest-pinned so
# each build picks up the latest patched 3.12-slim base. ECR scans the pushed
# image (`imageScanOnPush: true`). For reproducible/audited builds, pin to a
# digest and update it on the patching cadence, e.g.:
#   FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim@sha256:<digest>
# Resolve the current digest with:
#   docker manifest inspect public.ecr.aws/docker/library/python:3.12-slim
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Runtime modules: the AgentCore entrypoint plus the agent + retriever + config
# it imports, and the locked contract-review system prompt loaded at runtime.
COPY config.py agent_core.py agent_runtime.py retriever.py system_prompt.md ./

RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# AgentCore serves /ping for health; the SDK app binds 0.0.0.0:8080.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q -O- http://localhost:8080/ping || exit 1

# Start the AgentCore app (serves /invocations + /ping, streams via SSE).
CMD ["python", "-m", "agent_core"]
