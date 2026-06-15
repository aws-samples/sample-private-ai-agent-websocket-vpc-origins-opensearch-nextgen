# WebSocket<->SSE proxy image (v2).
# Built and pushed to ECR by AWS CodeBuild at deploy time (see build-stack.ts /
# image-build-construct.ts) — no local container engine. Platform follows
# config.cpuArchitecture (default x86_64); unlike the AgentCore agent image, the
# proxy is a normal ECS Fargate task and has no arch constraint.
#
# Base image is pulled from the Amazon ECR Public mirror of Docker Hub
# (public.ecr.aws/docker/library/...) rather than docker.io, so cloud builds are
# not subject to Docker Hub's unauthenticated pull-rate limit (HTTP 429).
#
# Supply-chain note (BSC39): the tag below is intentionally NOT digest-pinned so
# each build picks up the latest patched 3.12-slim base. ECR scans the pushed
# image (`imageScanOnPush: true`). For reproducible/audited builds, pin to a
# digest and update it on the patching cadence, e.g.:
#   FROM public.ecr.aws/docker/library/python:3.12-slim@sha256:<digest>
# Resolve the current digest with:
#   docker manifest inspect public.ecr.aws/docker/library/python:3.12-slim
FROM public.ecr.aws/docker/library/python:3.12-slim

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

# App modules + demo SPA static assets.
COPY config.py app.py agentcore_client.py auth.py documents.py ./
COPY static/ ./static/

RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q -O- http://localhost:8080/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
