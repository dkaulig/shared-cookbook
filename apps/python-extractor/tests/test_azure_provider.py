"""Tests for ``AzureOpenAIProvider``.

The provider talks to Azure's **Responses API** — not the older Chat
Completions API — at ``{endpoint}/openai/responses?api-version=...``.
All tests use ``respx`` to intercept the HTTP calls; no real Azure
traffic goes out.

Each test pins one facet of the contract:
- Request shape: URL template, ``api-key`` header, body layout.
- Response parsing: structured JSON, plain text, vision.
- Failure mapping: 400 / 401 / 429 / 500 / network.
- Retry policy: transient codes retried, terminal codes not.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import respx

from extractor.llm import LLMProviderError
from extractor.llm.azure_openai import AzureOpenAIProvider

_ENDPOINT = "https://fake.openai.azure.com"
_API_KEY = "fake-api-key"
_API_VERSION = "2025-04-01-preview"
_DEPLOYMENT_STRUCT = "gpt-4.1-mini"
_DEPLOYMENT_CHAT = "gpt-5.1-chat"

_URL = f"{_ENDPOINT}/openai/responses"


@pytest.fixture()
async def provider() -> AsyncIterator[AzureOpenAIProvider]:
    """Build a provider with zero-wait retries so tests don't sleep."""
    p = AzureOpenAIProvider(
        endpoint=_ENDPOINT,
        api_key=_API_KEY,
        api_version=_API_VERSION,
        deployment_structuring=_DEPLOYMENT_STRUCT,
        deployment_chat=_DEPLOYMENT_CHAT,
        # Zero-wait retry for unit tests; production default comes from
        # the factory. See `retry_wait_seconds` doc on the class.
        retry_wait_seconds=0.0,
        max_retries=3,
    )
    try:
        yield p
    finally:
        await p.aclose()


def _responses_payload(text: str) -> dict[str, Any]:
    """Minimal Responses-API success body shaped like Azure returns."""
    return {
        "id": "resp_123",
        "model": _DEPLOYMENT_CHAT,
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
    }


def _structured_payload(obj: dict[str, Any]) -> dict[str, Any]:
    """Responses-API success body carrying a JSON string as output_text."""
    return _responses_payload(json.dumps(obj))


# ---------- extract_structured ----------


@respx.mock
async def test_extract_structured_sends_correct_request(
    provider: AzureOpenAIProvider,
) -> None:
    """URL, headers, and body shape match the Responses API contract."""
    route = respx.post(_URL).mock(
        return_value=httpx.Response(200, json=_structured_payload({"title": "Pizza"}))
    )

    result = await provider.extract_structured(
        system_prompt="Du bist ein Rezept-Extraktor.",
        messages=[{"role": "user", "content": "Extrahiere aus: Pizza Margherita"}],
        json_schema={
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    )

    assert result == {"title": "Pizza"}
    assert route.called
    request = route.calls.last.request

    # URL includes api-version query param.
    assert request.url.params["api-version"] == _API_VERSION
    # api-key header present; Authorization header absent.
    assert request.headers["api-key"] == _API_KEY
    assert "authorization" not in {k.lower() for k in request.headers}

    body = json.loads(request.content)
    # Deployment routed via the `model` field (Responses API convention).
    assert body["model"] == _DEPLOYMENT_STRUCT
    # System prompt goes into `instructions` per Responses-API shape.
    assert body["instructions"] == "Du bist ein Rezept-Extraktor."
    # User messages go into `input` as a list of message objects.
    assert body["input"] == [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "Extrahiere aus: Pizza Margherita"}],
        }
    ]
    # Structured output enforcement via response_format.
    fmt = body["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["schema"]["required"] == ["title"]
    # P2-1 plan §3 explicitly requires ``strict: true`` so the LLM enforces
    # the schema rather than returning loose JSON. A ``name`` field is also
    # part of the Responses-API contract for json_schema responses.
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["name"] == "extractor_response"


@respx.mock
async def test_extract_structured_schema_mismatch_on_missing_text(
    provider: AzureOpenAIProvider,
) -> None:
    """If the response lacks a JSON-parseable ``output_text``, surface
    ``schema_mismatch`` (plan §3 'Don't attempt to coerce')."""
    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "resp_123",
                "output": [{"type": "message", "role": "assistant", "content": []}],
            },
        )
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.extract_structured(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "schema_mismatch"


@respx.mock
async def test_extract_structured_schema_mismatch_on_invalid_json(
    provider: AzureOpenAIProvider,
) -> None:
    """``output_text`` present but not valid JSON → ``schema_mismatch``."""
    respx.post(_URL).mock(return_value=httpx.Response(200, json=_responses_payload("{not json")))

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.extract_structured(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "schema_mismatch"


# ---------- chat ----------


@respx.mock
async def test_chat_returns_plain_text(provider: AzureOpenAIProvider) -> None:
    """``chat`` returns the ``output_text`` string verbatim."""
    respx.post(_URL).mock(return_value=httpx.Response(200, json=_responses_payload("Hallo!")))

    reply = await provider.chat(
        system_prompt="sei nett",
        messages=[{"role": "user", "content": "hallo"}],
    )
    assert reply == "Hallo!"


@respx.mock
async def test_chat_uses_chat_deployment(provider: AzureOpenAIProvider) -> None:
    """``chat`` routes through ``deployment_chat``, not structuring."""
    route = respx.post(_URL).mock(return_value=httpx.Response(200, json=_responses_payload("ok")))

    await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )

    body = json.loads(route.calls.last.request.content)
    assert body["model"] == _DEPLOYMENT_CHAT
    # Chat calls don't include a response_format override.
    assert "response_format" not in body


@respx.mock
async def test_chat_schema_mismatch_when_text_missing(
    provider: AzureOpenAIProvider,
) -> None:
    """If the response has no text at all, surface ``schema_mismatch``."""
    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json={"id": "resp_x", "output": []},
        )
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "schema_mismatch"


# ---------- vision_extract ----------


@respx.mock
async def test_vision_extract_serialises_images(
    provider: AzureOpenAIProvider,
) -> None:
    """Vision requests ship images as ``input_image`` parts with detail."""
    route = respx.post(_URL).mock(
        return_value=httpx.Response(200, json=_structured_payload({"t": "Brot"}))
    )

    result = await provider.vision_extract(
        system_prompt="extract recipe",
        images=[
            {"image_url": "https://cdn.test/a.jpg", "detail": "high"},
            {"image_url": "https://cdn.test/b.jpg", "detail": "auto"},
        ],
        instruction="Lies diese Kochbuchseiten.",
        json_schema={"type": "object"},
    )
    assert result == {"t": "Brot"}

    body = json.loads(route.calls.last.request.content)
    # Vision uses the structuring deployment (bigger model).
    assert body["model"] == _DEPLOYMENT_STRUCT
    user_msg = body["input"][0]
    assert user_msg["role"] == "user"
    parts = user_msg["content"]
    # First part is the user instruction, then N input_image parts in order.
    assert parts[0] == {"type": "input_text", "text": "Lies diese Kochbuchseiten."}
    assert parts[1] == {
        "type": "input_image",
        "image_url": "https://cdn.test/a.jpg",
        "detail": "high",
    }
    assert parts[2] == {
        "type": "input_image",
        "image_url": "https://cdn.test/b.jpg",
        "detail": "auto",
    }


# ---------- HTTP error mapping ----------


@respx.mock
async def test_400_maps_to_invalid_request_no_retry(
    provider: AzureOpenAIProvider,
) -> None:
    """400 → ``invalid_request``, one call only."""
    route = respx.post(_URL).mock(
        return_value=httpx.Response(400, json={"error": {"message": "bad schema"}})
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "invalid_request"
    assert route.call_count == 1


@respx.mock
async def test_401_maps_to_auth_failure_no_retry(
    provider: AzureOpenAIProvider,
) -> None:
    """401 → ``auth_failure``, one call only."""
    route = respx.post(_URL).mock(
        return_value=httpx.Response(401, json={"error": {"message": "bad key"}})
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "auth_failure"
    assert route.call_count == 1


@respx.mock
async def test_429_retries_and_then_succeeds(provider: AzureOpenAIProvider) -> None:
    """429 triggers retry; a subsequent 200 returns the body."""
    route = respx.post(_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "slow"}),
            httpx.Response(200, json=_responses_payload("ok")),
        ]
    )

    reply = await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )
    assert reply == "ok"
    assert route.call_count == 2


@respx.mock
async def test_429_exhausts_retries_and_raises_rate_limited(
    provider: AzureOpenAIProvider,
) -> None:
    """Persistent 429 → ``rate_limited`` after max_retries attempts."""
    route = respx.post(_URL).mock(
        return_value=httpx.Response(429, headers={"Retry-After": "0"}, json={})
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "rate_limited"
    assert route.call_count == 3


@respx.mock
async def test_500_retries_then_succeeds(provider: AzureOpenAIProvider) -> None:
    """500 triggers retry; a subsequent 200 returns the body."""
    route = respx.post(_URL).mock(
        side_effect=[
            httpx.Response(500, json={"error": "nope"}),
            httpx.Response(200, json=_responses_payload("fine")),
        ]
    )

    reply = await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )
    assert reply == "fine"
    assert route.call_count == 2


@respx.mock
async def test_500_exhausts_retries_as_provider_unavailable(
    provider: AzureOpenAIProvider,
) -> None:
    """Persistent 500 → ``provider_unavailable`` after max_retries."""
    route = respx.post(_URL).mock(return_value=httpx.Response(500, json={}))

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "provider_unavailable"
    assert route.call_count == 3


@respx.mock
async def test_network_error_retries_as_provider_unavailable(
    provider: AzureOpenAIProvider,
) -> None:
    """Connection errors retry up to ``max_retries`` then surface as
    ``provider_unavailable``."""
    route = respx.post(_URL).mock(side_effect=httpx.ConnectError("simulated network failure"))

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "provider_unavailable"
    assert route.call_count == 3


@respx.mock
async def test_timeout_retries_as_provider_unavailable(
    provider: AzureOpenAIProvider,
) -> None:
    """Per plan anti-shortcut: every retry scenario has a test. httpx
    timeouts should follow the same path as connection errors —
    wrapped into ``provider_unavailable`` and retried up to 3 times."""
    route = respx.post(_URL).mock(side_effect=httpx.TimeoutException("simulated timeout"))

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "provider_unavailable"
    assert route.call_count == 3


# ---------- Retry-After honour ----------


@respx.mock
async def test_429_honours_retry_after_header(
    provider: AzureOpenAIProvider,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When a 429 carries ``Retry-After``, the provider waits that long
    before retrying (plan §3 'prefer wait_fixed')."""
    sleeps: list[float] = []

    async def fake_async_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    # tenacity's asyncio sleep ultimately calls asyncio.sleep; we patch
    # that out so the test finishes immediately but records the delay.
    monkeypatch.setattr("asyncio.sleep", fake_async_sleep)

    respx.post(_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "7"}, json={}),
            httpx.Response(200, json=_responses_payload("ok")),
        ]
    )

    await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )

    # The 7-second header must appear in the observed sleep sequence.
    assert any(abs(s - 7.0) < 0.01 for s in sleeps)


# ---------- never log API key ----------


@respx.mock
async def test_api_key_never_appears_in_logs(
    provider: AzureOpenAIProvider,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Anti-shortcut guard: even at DEBUG level, logs must not leak the key."""
    import logging

    caplog.set_level(logging.DEBUG, logger="extractor.llm")

    respx.post(_URL).mock(return_value=httpx.Response(200, json=_responses_payload("ok")))
    await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )

    for record in caplog.records:
        assert _API_KEY not in record.getMessage()
        assert _API_KEY not in str(record.args)
