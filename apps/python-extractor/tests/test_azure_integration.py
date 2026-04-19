"""Live Azure OpenAI smoke test.

Skipped by default so CI never burns tokens or depends on a reachable
Azure resource. Enable with ``AZURE_OPENAI_INTEGRATION=1`` when you
want a one-shot manual check that your resource is reachable and the
Responses-API request shape is still correct.

Reads ``AZURE_OPENAI_*`` from the process environment (via
``Settings``). If the key is missing or empty the test is skipped even
if the integration flag is set — no point trying to authenticate with
an empty header.
"""

from __future__ import annotations

import os

import pytest

from extractor.config import Settings
from extractor.llm import AzureOpenAIProvider, build_provider

_INTEGRATION_ENV_VAR = "AZURE_OPENAI_INTEGRATION"
_INTEGRATION_ENABLED = os.getenv(_INTEGRATION_ENV_VAR) == "1"


@pytest.mark.skipif(
    not _INTEGRATION_ENABLED,
    reason=(
        "live Azure call; enable with AZURE_OPENAI_INTEGRATION=1 "
        "and populate AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY."
    ),
)
async def test_chat_round_trip_against_real_azure() -> None:
    """One real ``chat`` call returns a non-empty assistant reply.

    Kept intentionally minimal — we want smoke, not depth. Deeper
    behaviour (retries, structured output) is covered by the respx-
    mocked unit tests so we don't need to burn tokens on them.
    """
    settings = Settings()
    if not settings.azure_openai_api_key.strip():
        pytest.skip("AZURE_OPENAI_API_KEY not set; cannot run live call.")

    provider = build_provider(settings)
    assert isinstance(provider, AzureOpenAIProvider), (
        "integration test requires the real provider — check config."
    )

    try:
        reply, usage = await provider.chat(
            system_prompt="Antworte kurz auf Deutsch.",
            messages=[{"role": "user", "content": "Sag hallo."}],
        )
    finally:
        await provider.aclose()

    assert isinstance(reply, str)
    assert len(reply.strip()) > 0
    # PF2: live Azure responses always carry usage; if the deployment
    # returns zero counts something is off with Responses-API parsing.
    assert usage["prompt_tokens"] > 0
    assert usage["completion_tokens"] > 0
    assert usage["model"]
