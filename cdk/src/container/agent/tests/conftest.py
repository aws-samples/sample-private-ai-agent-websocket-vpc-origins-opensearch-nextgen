"""Shared pytest configuration for the agent container test-suite.

In v2 the agent no longer hosts a FastAPI app — it runs the Strands agent
inside the Bedrock AgentCore Runtime via ``agent_core.py``. The remaining tests
exercise the pure units (``agent_runtime`` invocation/timeout helpers and the
``retriever`` RAG logic), which import the application modules as top-level
names (``from agent_runtime import ...``, ``import retriever``).

When pytest collects this ``tests/`` package it places the ``tests/`` directory
on ``sys.path`` (not the agent directory), so this conftest defensively
prepends the agent directory so those imports resolve regardless of the working
directory pytest was launched from.

Run the suite from the agent directory:

    cd cdk/src/container/agent && python -m pytest tests -q

With ``OPENSEARCH_ENDPOINT`` unset, the retriever runs in offline *mock mode*
(in-memory keyword retriever) so its logic is exercisable without
Bedrock/OpenSearch access.
"""

from __future__ import annotations

import os
import sys

# --- Make the agent modules importable as top-level names --------------------
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_AGENT_DIR = os.path.dirname(_TESTS_DIR)
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)
