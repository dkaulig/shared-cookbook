"""Tests for :class:`OllamaProvider` — REL-7 self-hosted LLM backend.

We use ``respx`` to intercept HTTP calls against the Ollama REST API
(``POST {base_url}/api/chat``). No real Ollama traffic goes out.

Each test pins one facet of the contract:
- Request shape: URL, headers, body layout (model, messages, format,
  stream=false).
- Response parsing: structured JSON extraction, plain-text chat,
  vision with images.
- Failure mapping: 400 / 404 (model-not-pulled) / 429 / 500 / timeout.
- Token-usage parse via ``prompt_eval_count`` + ``eval_count``.
- Data-URL base64 stripping for vision images.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import respx

from extractor.llm import LLMProviderError
from extractor.llm.ollama import OllamaProvider

_BASE_URL = "http://ollama.internal:11434"
_MODEL = "gemma3:12b"
_VISION_MODEL = "gemma3:12b"

_URL = f"{_BASE_URL}/api/chat"


@pytest.fixture()
async def provider() -> AsyncIterator[OllamaProvider]:
    """Build a provider with zero-wait retries so tests don't sleep."""
    p = OllamaProvider(
        base_url=_BASE_URL,
        model=_MODEL,
        vision_model=_VISION_MODEL,
        retry_wait_seconds=0.0,
        max_retries=3,
    )
    try:
        yield p
    finally:
        await p.aclose()


def _chat_payload(
    content: str,
    *,
    model: str = _MODEL,
    prompt_tokens: int = 42,
    completion_tokens: int = 17,
) -> dict[str, Any]:
    """Minimal Ollama /api/chat success body."""
    return {
        "model": model,
        "message": {"role": "assistant", "content": content},
        "done": True,
        "prompt_eval_count": prompt_tokens,
        "eval_count": completion_tokens,
    }


# ─────────────────────────────────────────────────────────────────────
# extract_structured
# ─────────────────────────────────────────────────────────────────────


async def test_extract_structured_posts_request_with_format_schema(
    provider: OllamaProvider,
) -> None:
    """Verifies the request body carries model + messages + format."""
    schema = {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
    }
    captured: dict[str, Any] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_chat_payload('{"title":"Rezept"}'))

    with respx.mock(assert_all_called=True) as mock:
        mock.post(_URL).mock(side_effect=_handler)
        result, usage = await provider.extract_structured(
            system_prompt="system prompt",
            messages=[{"role": "user", "content": "hello"}],
            json_schema=schema,
        )

    assert result == {"title": "Rezept"}
    assert usage["prompt_tokens"] == 42
    assert usage["completion_tokens"] == 17
    assert usage["cached_prompt_tokens"] == 0
    assert usage["model"] == _MODEL

    body = captured["body"]
    assert body["model"] == _MODEL
    assert body["stream"] is False
    assert body["format"] == schema
    # System prompt lives in the first message with role=system.
    assert body["messages"][0] == {"role": "system", "content": "system prompt"}
    # User message follows.
    assert body["messages"][1] == {"role": "user", "content": "hello"}


async def test_extract_structured_schema_mismatch_on_non_json(
    provider: OllamaProvider,
) -> None:
    """A model that ignored ``format`` and returned prose raises schema_mismatch."""
    with respx.mock() as mock:
        mock.post(_URL).mock(return_value=httpx.Response(200, json=_chat_payload("not-json")))
        with pytest.raises(LLMProviderError) as exc_info:
            await provider.extract_structured(
                system_prompt="s",
                messages=[{"role": "user", "content": "x"}],
                json_schema={"type": "object"},
            )
    assert exc_info.value.code == "schema_mismatch"


async def test_extract_structured_schema_mismatch_on_array_top_level(
    provider: OllamaProvider,
) -> None:
    """Response JSON must be an object at the top level."""
    with respx.mock() as mock:
        mock.post(_URL).mock(return_value=httpx.Response(200, json=_chat_payload("[1, 2]")))
        with pytest.raises(LLMProviderError) as exc_info:
            await provider.extract_structured(
                system_prompt="s",
                messages=[{"role": "user", "content": "x"}],
                json_schema={"type": "object"},
            )
    assert exc_info.value.code == "schema_mismatch"


# ─────────────────────────────────────────────────────────────────────
# chat
# ─────────────────────────────────────────────────────────────────────


async def test_chat_returns_plain_text(provider: OllamaProvider) -> None:
    with respx.mock() as mock:
        mock.post(_URL).mock(return_value=httpx.Response(200, json=_chat_payload("Hallo!")))
        text, usage = await provider.chat(
            system_prompt="s",
            messages=[{"role": "user", "content": "hi"}],
        )
    assert text == "Hallo!"
    assert usage["model"] == _MODEL


async def test_chat_omits_format_key(provider: OllamaProvider) -> None:
    """Chat request must NOT set ``format`` (free-form completion)."""
    captured: dict[str, Any] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_chat_payload("ok"))

    with respx.mock() as mock:
        mock.post(_URL).mock(side_effect=_handler)
        await provider.chat(
            system_prompt="s",
            messages=[{"role": "user", "content": "hi"}],
        )
    assert "format" not in captured["body"]


# ─────────────────────────────────────────────────────────────────────
# vision_extract
# ─────────────────────────────────────────────────────────────────────


async def test_vision_extract_strips_data_url_prefix(
    provider: OllamaProvider,
) -> None:
    """Data URLs must be stripped to raw base64 before hitting Ollama."""
    raw_bytes = b"fake-image-bytes"
    b64 = base64.b64encode(raw_bytes).decode("ascii")
    data_url = f"data:image/jpeg;base64,{b64}"

    captured: dict[str, Any] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_chat_payload('{"title":"X"}'))

    with respx.mock() as mock:
        mock.post(_URL).mock(side_effect=_handler)
        await provider.vision_extract(
            system_prompt="s",
            images=[{"image_url": data_url, "detail": "auto"}],
            instruction="extrahiere Rezept",
            json_schema={"type": "object"},
        )

    body = captured["body"]
    user_msg = body["messages"][1]
    assert user_msg["role"] == "user"
    assert user_msg["content"] == "extrahiere Rezept"
    assert user_msg["images"] == [b64]
    assert body["model"] == _VISION_MODEL


async def test_vision_extract_passes_http_url_through(
    provider: OllamaProvider,
) -> None:
    """HTTP URLs stay verbatim — Ollama fetches them server-side."""
    captured: dict[str, Any] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_chat_payload('{"title":"X"}'))

    with respx.mock() as mock:
        mock.post(_URL).mock(side_effect=_handler)
        await provider.vision_extract(
            system_prompt="s",
            images=[{"image_url": "https://cdn.example/pic.jpg", "detail": "high"}],
            instruction="x",
            json_schema={"type": "object"},
        )
    assert captured["body"]["messages"][1]["images"] == ["https://cdn.example/pic.jpg"]


async def test_vision_extract_rejects_malformed_data_url(
    provider: OllamaProvider,
) -> None:
    """A data URL with a bogus base64 payload raises invalid_request."""
    # respx never hits because the failure is at the payload-decode step.
    with pytest.raises(LLMProviderError) as exc_info:
        await provider.vision_extract(
            system_prompt="s",
            images=[{"image_url": "data:image/jpeg;base64,!!!not-base64!!!", "detail": "auto"}],
            instruction="x",
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "invalid_request"


# ─────────────────────────────────────────────────────────────────────
# Error mapping
# ─────────────────────────────────────────────────────────────────────


async def test_400_maps_to_invalid_request(provider: OllamaProvider) -> None:
    with respx.mock() as mock:
        mock.post(_URL).mock(return_value=httpx.Response(400, json={"error": "bad request"}))
        with pytest.raises(LLMProviderError) as exc_info:
            await provider.chat(
                system_prompt="s",
                messages=[{"role": "user", "content": "hi"}],
            )
    assert exc_info.value.code == "invalid_request"


async def test_404_maps_to_invalid_request_with_pull_hint(
    provider: OllamaProvider,
) -> None:
    """404 means the operator didn't ``ollama pull`` the model."""
    with respx.mock() as mock:
        mock.post(_URL).mock(
            return_value=httpx.Response(404, json={"error": f"model '{_MODEL}' not found"})
        )
        with pytest.raises(LLMProviderError) as exc_info:
            await provider.chat(
                system_prompt="s",
                messages=[{"role": "user", "content": "hi"}],
            )
    assert exc_info.value.code == "invalid_request"


async def test_500_retries_then_raises_provider_unavailable(
    provider: OllamaProvider,
) -> None:
    """5xx must be retried; after exhaustion the final code is
    ``provider_unavailable``."""
    with respx.mock() as mock:
        route = mock.post(_URL).mock(return_value=httpx.Response(500, json={"error": "boom"}))
        with pytest.raises(LLMProviderError) as exc_info:
            await provider.chat(
                system_prompt="s",
                messages=[{"role": "user", "content": "hi"}],
            )
    assert exc_info.value.code == "provider_unavailable"
    assert route.call_count == 3  # three attempts


async def test_timeout_retries_then_raises_provider_unavailable(
    provider: OllamaProvider,
) -> None:
    with respx.mock() as mock:
        route = mock.post(_URL).mock(side_effect=httpx.ConnectTimeout("boom"))
        with pytest.raises(LLMProviderError) as exc_info:
            await provider.chat(
                system_prompt="s",
                messages=[{"role": "user", "content": "hi"}],
            )
    assert exc_info.value.code == "provider_unavailable"
    assert route.call_count == 3


async def test_500_then_200_recovers(provider: OllamaProvider) -> None:
    """A single 500 followed by a 200 surfaces the successful payload."""
    with respx.mock() as mock:
        route = mock.post(_URL).mock(
            side_effect=[
                httpx.Response(500, json={"error": "flaky"}),
                httpx.Response(200, json=_chat_payload("ok")),
            ]
        )
        text, _ = await provider.chat(
            system_prompt="s",
            messages=[{"role": "user", "content": "hi"}],
        )
    assert text == "ok"
    assert route.call_count == 2
