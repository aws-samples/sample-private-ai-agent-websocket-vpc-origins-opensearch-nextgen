"""AgentCore Runtime entrypoint for the Strands agent (v2).

In v1 the Strands agent ran as a FastAPI app on ECS Fargate. In v2 it runs
inside **Bedrock AgentCore Runtime**, so the HTTP surface (``/invocations`` POST
and ``/ping`` GET on :8080) and the SSE streaming transport are provided by the
``bedrock-agentcore`` SDK's ``BedrockAgentCoreApp``. This module is the
container entrypoint AgentCore invokes.

The agent itself — the Strands ``Agent`` with a ``BedrockModel`` and the
``opensearch_retriever`` RAG ``@tool`` — is reused verbatim from
:mod:`agent_runtime` and :mod:`retriever`, so RAG stays *inside* the agent
(it queries Amazon OpenSearch Serverless through AgentCore's VPC egress ENIs).

Contract with the ECS proxy:
  * Input payload: ``{"prompt": "<user query>"}`` (the proxy maps each browser
    WebSocket query / HTTP invocation to this shape).
  * Output: the handler is an async generator that ``yield``s the agent's
    streaming events; AgentCore serializes them as SSE. Each text delta becomes
    one SSE event the proxy re-emits as a ``token`` frame; the proxy synthesizes
    the ``complete`` terminator when the stream ends.

Health: ``BedrockAgentCoreApp`` automatically serves ``GET /ping`` returning
``{"status": "Healthy"}`` once the module imports and the agent is built.

Requirements: 7.1 (Strands agent), 8.1-8.3 (token streaming), 10.x, 11.x.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator

from agent_runtime import build_agent
from config import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agentcore.entrypoint")

# Build the agent once at import time so the first invocation is warm and
# `/ping` reports healthy as soon as the container is up. In mock mode (no
# OpenSearch endpoint) this returns the offline MockAgent.
_settings = get_settings()
_agent = build_agent(_settings)
logger.info(
    "agentcore entrypoint ready: model_id=%s region=%s mock_mode=%s",
    _settings.bedrock_model_id,
    _settings.aws_region,
    _settings.mock_mode,
)

# The BedrockAgentCoreApp provides the /invocations + /ping HTTP surface and the
# SSE transport. Imported here (not at top level) so unit tests / py_compile do
# not require the bedrock-agentcore package to be installed.
try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp  # type: ignore import-not-found

    app = BedrockAgentCoreApp()

    @app.entrypoint
    async def handler(payload: dict[str, Any], context: Any) -> AsyncIterator[Any]:
        """AgentCore invocation entrypoint — streams the agent response.

        Extracts ``prompt`` from the payload, runs the Strands agent's
        ``stream_async`` generator, and yields each event so AgentCore emits it
        as an SSE chunk. Strands text deltas arrive as ``{"data": "..."}``
        events; the proxy extracts ``data`` and forwards it as a ``token``.
        """
        prompt = ""
        if isinstance(payload, dict):
            prompt = payload.get("prompt") or payload.get("query") or ""
        prompt = str(prompt).strip()

        if not prompt:
            # Surface a single error event the proxy maps to a WS `error` frame.
            yield {"error": "missing 'prompt' in payload"}
            return

        logger.info("invoking agent: prompt_chars=%d", len(prompt))
        async for event in _agent.stream_async(prompt):
            # Strands emits rich event dicts; the incremental text delta lives
            # under "data". Yield ONLY the text delta so AgentCore's SSE carries
            # clean tokens (not the stringified event object). Non-text events
            # (tool_use, lifecycle, metadata) carry no "data" and are skipped.
            text = ""
            if isinstance(event, dict):
                data = event.get("data")
                if isinstance(data, str):
                    text = data
            elif isinstance(event, str):
                text = event
            if text:
                yield text

    def main() -> None:
        """Run the AgentCore app server (invoked by the Dockerfile CMD)."""
        app.run()

except Exception:  # noqa: BLE001 - bedrock-agentcore absent (local/test env)
    logger.warning(
        "bedrock_agentcore not available; entrypoint import is a no-op "
        "(expected in local/test environments)",
        exc_info=True,
    )
    app = None  # type: ignore[assignment]

    def main() -> None:  # type: ignore[misc]
        raise RuntimeError(
            "bedrock_agentcore is not installed; cannot run the AgentCore app"
        )


if __name__ == "__main__":
    main()
