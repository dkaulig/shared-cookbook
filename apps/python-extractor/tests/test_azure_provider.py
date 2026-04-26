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
from extractor.llm.azure_openai import (
    _DEFAULT_STRUCTURED_MAX_COMPLETION_TOKENS,
    AzureOpenAIProvider,
)

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


def _responses_payload(
    text: str,
    *,
    input_tokens: int = 42,
    output_tokens: int = 17,
    cached_tokens: int = 0,
    model: str = _DEPLOYMENT_CHAT,
) -> dict[str, Any]:
    """Minimal Responses-API success body shaped like Azure returns.

    Defaults include a realistic ``usage`` envelope so every test
    exercising the happy path also covers the PF2 token-usage parse.
    Tests that want to assert explicit counts pass explicit values.
    """
    return {
        "id": "resp_123",
        "model": model,
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "input_tokens_details": {"cached_tokens": cached_tokens},
        },
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

    result, usage = await provider.extract_structured(
        system_prompt="Du bist ein Rezept-Extraktor.",
        messages=[{"role": "user", "content": "Extrahiere aus: Pizza Margherita"}],
        json_schema={
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    )

    assert result == {"title": "Pizza"}
    assert usage == {
        "prompt_tokens": 42,
        "completion_tokens": 17,
        "cached_prompt_tokens": 0,
        "model": _DEPLOYMENT_CHAT,
    }
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
    # Structured output enforcement lives under ``text.format`` in the
    # Responses API (Azure deprecated ``response_format`` in 2025-04+).
    # The json_schema sub-object is flattened: name/schema/strict sit
    # directly on ``format`` rather than nested under ``json_schema``.
    assert "response_format" not in body
    fmt = body["text"]["format"]
    assert fmt["type"] == "json_schema"
    assert fmt["schema"]["required"] == ["title"]
    # P2-1 plan §3 explicitly requires ``strict: true`` so the LLM enforces
    # the schema rather than returning loose JSON. A ``name`` field is also
    # part of the Responses-API contract for json_schema responses.
    assert fmt["strict"] is True
    assert fmt["name"] == "extractor_response"


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
async def test_extract_structured_uses_text_format_not_response_format(
    provider: AzureOpenAIProvider,
) -> None:
    """Regression guard for the Azure Responses-API deprecation.

    Azure (mirroring OpenAI's Responses API contract) rejects the legacy
    top-level ``response_format`` parameter since ~2025-04 with::

        Unsupported parameter: 'response_format'. In the Responses API,
        this parameter has moved to 'text.format'.

    This test pins the new shape so a regression would fail immediately
    rather than burn a production URL/photo extraction attempt.
    """
    route = respx.post(_URL).mock(
        return_value=httpx.Response(200, json=_structured_payload({"x": 1}))
    )

    await provider.extract_structured(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
        json_schema={"type": "object", "properties": {"x": {"type": "integer"}}},
    )

    body = json.loads(route.calls.last.request.content)
    # Must NOT use the deprecated top-level key.
    assert "response_format" not in body, (
        "legacy response_format must not be sent — Azure rejects it with "
        "invalid_request since the Responses-API 2025-04 rollout"
    )
    # Must use the new nested path.
    assert "text" in body
    assert "format" in body["text"]
    fmt = body["text"]["format"]
    assert fmt["type"] == "json_schema"
    # Flattened: no intermediate ``json_schema`` object; name/schema/strict
    # live directly on ``format``.
    assert "json_schema" not in fmt
    assert "schema" in fmt
    assert "name" in fmt
    assert fmt["strict"] is True


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


@respx.mock
async def test_extract_structured_pins_temperature_zero(
    provider: AzureOpenAIProvider,
) -> None:
    """COMP-FIX: the structured-extraction payload pins ``temperature: 0``.

    Rationale — identical FB-reel inputs were producing different
    component-splits across runs (2 components one day, 1 lumped
    "Hauptzutaten" the next). The delta is pure LLM stochasticity; the
    gpt-4.1-mini deployment used for structured extraction accepts
    ``temperature=0`` so we pin it for determinism. The chat deployment
    (gpt-5.1-chat) is untouched because it rejects non-default
    temperatures — that path stays silent per existing contract.
    """
    route = respx.post(_URL).mock(
        return_value=httpx.Response(200, json=_structured_payload({"x": 1}))
    )

    await provider.extract_structured(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
        json_schema={"type": "object", "properties": {"x": {"type": "integer"}}},
    )

    body = json.loads(route.calls.last.request.content)
    assert body.get("temperature") == 0, (
        "extract_structured must pin temperature=0 for deterministic "
        "component-splitting on gpt-4.1-mini (COMP-FIX)"
    )


@respx.mock
async def test_vision_extract_pins_temperature_zero(
    provider: AzureOpenAIProvider,
) -> None:
    """COMP-FIX: the vision-extraction payload also pins ``temperature: 0``.

    ``vision_extract`` uses the same structuring deployment
    (gpt-4.1-mini) and suffers the same stochasticity risk on the
    photo-path. Kept consistent with ``extract_structured`` so both
    paths are deterministic for the same reason.
    """
    route = respx.post(_URL).mock(
        return_value=httpx.Response(200, json=_structured_payload({"t": "Brot"}))
    )

    await provider.vision_extract(
        system_prompt="sys",
        images=[{"image_url": "https://cdn.test/a.jpg", "detail": "auto"}],
        instruction="x",
        json_schema={"type": "object"},
    )

    body = json.loads(route.calls.last.request.content)
    assert body.get("temperature") == 0


@respx.mock
async def test_chat_omits_temperature(provider: AzureOpenAIProvider) -> None:
    """COMP-FIX: the ``chat`` path must NOT set ``temperature``.

    ``AzureOpenAIChatClient`` runs on a different deployment
    (gpt-5.1-chat) that rejects non-default temperature values. The
    structuring-path temperature pin is strictly scoped to the
    structured-output + vision payloads.
    """
    route = respx.post(_URL).mock(return_value=httpx.Response(200, json=_responses_payload("ok")))

    await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )

    body = json.loads(route.calls.last.request.content)
    assert "temperature" not in body, (
        "chat() must not pin temperature — gpt-5.1-chat rejects non-default values"
    )


# ---------- chat ----------


@respx.mock
async def test_chat_returns_plain_text(provider: AzureOpenAIProvider) -> None:
    """``chat`` returns the ``output_text`` string verbatim + usage."""
    respx.post(_URL).mock(return_value=httpx.Response(200, json=_responses_payload("Hallo!")))

    reply, usage = await provider.chat(
        system_prompt="sei nett",
        messages=[{"role": "user", "content": "hallo"}],
    )
    assert reply == "Hallo!"
    assert usage["prompt_tokens"] == 42
    assert usage["completion_tokens"] == 17
    assert usage["model"] == _DEPLOYMENT_CHAT


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
    # Chat calls don't include a structured-output override — neither the
    # legacy ``response_format`` nor the new ``text`` wrapper.
    assert "response_format" not in body
    assert "text" not in body


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

    result, usage = await provider.vision_extract(
        system_prompt="extract recipe",
        images=[
            {"image_url": "https://cdn.test/a.jpg", "detail": "high"},
            {"image_url": "https://cdn.test/b.jpg", "detail": "auto"},
        ],
        instruction="Lies diese Kochbuchseiten.",
        json_schema={"type": "object"},
    )
    assert result == {"t": "Brot"}
    assert usage["prompt_tokens"] == 42

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

    reply, _ = await provider.chat(
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

    reply, _ = await provider.chat(
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


# ---------- PF2 token usage parsing ----------


@respx.mock
async def test_token_usage_parses_all_three_counts(
    provider: AzureOpenAIProvider,
) -> None:
    """Every Azure success includes ``usage``; the provider surfaces it
    alongside the parsed payload. Counts + cached tokens + model round
    through the returned tuple."""
    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json=_responses_payload(
                "hello",
                input_tokens=1000,
                output_tokens=200,
                cached_tokens=800,
                model="gpt-5.1-chat",
            ),
        )
    )

    reply, usage = await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert reply == "hello"
    assert usage == {
        "prompt_tokens": 1000,
        "completion_tokens": 200,
        "cached_prompt_tokens": 800,
        "model": "gpt-5.1-chat",
    }


@respx.mock
async def test_token_usage_missing_falls_back_to_zero(
    provider: AzureOpenAIProvider,
) -> None:
    """A 200 response without a ``usage`` key degrades to zero counts
    (defensive — don't sacrifice a successful extraction to a telemetry
    detail). Model falls back to the provider's deployment name when
    ``model`` is also absent."""
    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "resp_x",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "ok"}],
                    }
                ],
            },
        )
    )

    _, usage = await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "x"}],
    )

    assert usage["prompt_tokens"] == 0
    assert usage["completion_tokens"] == 0
    assert usage["cached_prompt_tokens"] == 0
    # Fallback: the caller's deployment name is preserved so downstream
    # pricing still has something sensible to look up.
    assert usage["model"] == _DEPLOYMENT_CHAT


@respx.mock
async def test_token_usage_logs_counts_not_content(
    provider: AzureOpenAIProvider,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Anti-shortcut: the INFO usage line carries integers only. Neither
    the prompt nor the assistant reply appears in the log record."""
    import logging

    caplog.set_level(logging.INFO, logger="extractor.llm")

    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json=_responses_payload(
                "geheim-antwort-XYZ",
                input_tokens=777,
                output_tokens=88,
            ),
        )
    )

    await provider.chat(
        system_prompt="streng geheim system",
        messages=[{"role": "user", "content": "streng geheim user"}],
    )

    usage_records = [r for r in caplog.records if "usage" in r.getMessage()]
    assert usage_records, "expected at least one usage log line"
    for record in usage_records:
        msg = record.getMessage()
        assert "777" in msg
        assert "88" in msg
        assert "geheim-antwort-XYZ" not in msg
        assert "streng geheim" not in msg


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


# ---------- truncated_response detection (incomplete + max_output_tokens) ----------


def test_default_structured_max_completion_tokens_is_4096() -> None:
    """Regression guard for the production-import truncation fix.

    Production import ``fbbf192b-3c51-4932-867d-f7395b436fed`` against
    ``https://www.facebook.com/share/r/1963bBySqX/`` returned HTTP 200
    with ``status: "incomplete"`` + ``incomplete_details.reason:
    "max_output_tokens"`` because the previous 2048 cap was tight for
    a 3-component recipe translated to German. Bumped to 4096 — still
    safely inside the gpt-4.1-mini ceiling of 8192. CFG-1 admins can
    override per-deployment via ``llm.structured.max_completion_tokens``.
    """
    assert _DEFAULT_STRUCTURED_MAX_COMPLETION_TOKENS == 4096


def _truncated_payload(text: str) -> dict[str, Any]:
    """Responses-API body shaped exactly like Azure's truncation case.

    Azure returns HTTP 200 with ``status: "incomplete"`` +
    ``incomplete_details.reason: "max_output_tokens"`` and a partial
    ``output_text`` that almost always fails ``json.loads``. The
    ``output_text`` payload here is intentionally an unterminated JSON
    string so the previous code path would surface ``schema_mismatch``
    on the failed parse — the new path must detect the truncation
    flag first and raise ``truncated_response`` instead.
    """
    return {
        "id": "resp_truncated",
        "model": _DEPLOYMENT_STRUCT,
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
        "usage": {
            "input_tokens": 1000,
            "output_tokens": 2048,
            "input_tokens_details": {"cached_tokens": 0},
        },
    }


@respx.mock
async def test_extract_structured_raises_truncated_response_on_max_output_tokens(
    provider: AzureOpenAIProvider,
) -> None:
    """Truncation path must surface ``truncated_response``, not ``schema_mismatch``.

    Diagnosed against production import
    ``fbbf192b-3c51-4932-867d-f7395b436fed`` — the operator log read
    ``schema_mismatch`` even though the real cause was the model
    hitting ``max_output_tokens``. Renaming the failure makes future
    debugging self-explanatory.
    """
    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json=_truncated_payload('{"title": "Honey Chipotle Quesadilla", "des'),
        )
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.extract_structured(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "truncated_response"


@respx.mock
async def test_chat_raises_truncated_response_on_max_output_tokens(
    provider: AzureOpenAIProvider,
) -> None:
    """Same truncation contract for the ``chat`` call site."""
    respx.post(_URL).mock(
        return_value=httpx.Response(200, json=_truncated_payload("partial reply..."))
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "truncated_response"


@respx.mock
async def test_vision_extract_raises_truncated_response_on_max_output_tokens(
    provider: AzureOpenAIProvider,
) -> None:
    """Same truncation contract for the ``vision_extract`` call site."""
    respx.post(_URL).mock(
        return_value=httpx.Response(
            200,
            json=_truncated_payload('{"title": "Brot", "components": [{"label": null'),
        )
    )

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.vision_extract(
            system_prompt="sys",
            images=[{"image_url": "https://cdn.test/a.jpg", "detail": "auto"}],
            instruction="x",
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "truncated_response"
