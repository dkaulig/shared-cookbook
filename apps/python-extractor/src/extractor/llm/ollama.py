"""Ollama provider — self-hosted peer to :class:`AzureOpenAIProvider`.

REL-7 adds Ollama as a first-class LLM backend for operators who
don't want to depend on Azure OpenAI. The provider talks directly to
Ollama's REST API (``POST {base_url}/api/chat``) over plain HTTP on the
internal docker network. No third-party proxy SDK, no OpenAI-compat
shim — Ollama's native surface is already close enough to OpenAI's that
the translation fits in one file.

Structured output uses Ollama's ``format`` field: when set to a JSON
Schema dict, Ollama enforces the response body matches the schema. The
model returns raw JSON text in the ``message.content`` field which we
then ``json.loads``. Vision support piggybacks on ``message.images`` —
a list of data URLs (base64) or HTTP URLs the server fetches itself.

Error handling mirrors Azure's shape so the downstream orchestrator
code (HTTP mapping in ``main.py``, retry policy in ``_post_once``) is
identical:

- 5xx / network / timeout → ``provider_unavailable`` (retryable).
- 429 → ``rate_limited`` (retryable; Ollama rarely 429s but we stay
  symmetrical).
- 400 → ``invalid_request`` (terminal).
- 404 → ``invalid_request`` with a "model not pulled" message
  (operators forgot to ``ollama pull``).
- JSON-decode / schema-mismatch → ``schema_mismatch`` (terminal).

**Security note (REL-7 /security stage):** the Ollama base URL is
operator-controlled (``OLLAMA_BASE_URL`` env var), NOT user-controlled,
so the SSRF class of attack does not apply here — the operator trusts
their own container. The remaining attack surface is prompt injection
via caption / transcript content, which the call sites already wrap in
``<untrusted_blog>…</untrusted_blog>`` delimiters (REL-0b fix commit
``958aa34``); that wrapping applies equally to Azure and Ollama
because it lives in the pipeline layer upstream of the provider.
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
from collections.abc import Sequence
from types import TracebackType
from typing import Any, ClassVar

import httpx
import tenacity
import tenacity.wait

from extractor.llm.errors import LLMProviderError
from extractor.llm.provider import ChatMessage, LLMProvider, TokenUsage, VisionInput

logger = logging.getLogger("extractor.llm")

# Ollama's /api/chat is slow on CPU (12B-class model → multi-minute per
# request). 300 s matches the REL-6 Path-3 quality-expectations ceiling.
_REQUEST_TIMEOUT_SECONDS: float = 300.0

_DEFAULT_MAX_RETRIES: int = 3
_DEFAULT_RETRY_WAIT_SECONDS: float = 2.0


class _RetryableOllamaError(Exception):
    """Internal wrapper for retryable Ollama failures.

    Same pattern as :class:`extractor.llm.azure_openai._RetryableLLMError`
    — tenacity's ``retry_if_exception_type`` matches on exact classes,
    so the terminal errors (schema-mismatch, invalid-request) bypass
    the retry loop and propagate immediately.
    """

    def __init__(
        self,
        inner: LLMProviderError,
        *,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(str(inner))
        self.inner = inner
        self.retry_after_seconds = retry_after_seconds


def _wait_strategy(default_wait_seconds: float) -> tenacity.wait.wait_base:
    """Wait strategy honouring an explicit retry-after hint when present."""
    expo = tenacity.wait_exponential(
        multiplier=default_wait_seconds, min=default_wait_seconds, max=30.0
    )

    class _Strategy(tenacity.wait.wait_base):
        def __call__(self, retry_state: tenacity.RetryCallState) -> float:
            outcome = retry_state.outcome
            if outcome is not None and outcome.failed:
                exc = outcome.exception()
                if isinstance(exc, _RetryableOllamaError) and exc.retry_after_seconds is not None:
                    return exc.retry_after_seconds
            return expo(retry_state)

    return _Strategy()


class OllamaProvider(LLMProvider):
    """Self-hosted ``LLMProvider`` talking to an Ollama server over HTTP."""

    # POLISH-1 / LANG-1 — local 4-12B-class models follow long-prompt
    # instructions less reliably than Azure's frontier models. Opt into
    # the pipeline's redundant-directive path so the language rule
    # frames the base system prompt on both sides.
    requires_redundant_language_directive: ClassVar[bool] = True

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        vision_model: str,
        max_retries: int = _DEFAULT_MAX_RETRIES,
        retry_wait_seconds: float = _DEFAULT_RETRY_WAIT_SECONDS,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """
        Parameters
        ----------
        base_url
            Ollama server root, e.g. ``http://ollama:11434``. No trailing
            slash — we normalise. Operator-controlled via
            ``OLLAMA_BASE_URL``.
        model
            Default model tag used for ``extract_structured`` + ``chat``.
            Operators must ``ollama pull <model>`` on first boot; we
            surface a 404 as ``invalid_request`` if the tag is missing.
        vision_model
            Model tag used for ``vision_extract``. Must be a multimodal
            model tag (Gemma 3, Llava, etc.). Same 404-handling as
            ``model``.
        max_retries, retry_wait_seconds
            Retry policy — mirrors :class:`AzureOpenAIProvider`.
        http_client
            Optional pre-built client. Default is a 300 s timeout client
            owned by the provider.
        """
        self._base_url = base_url.rstrip("/")
        self._host = httpx.URL(self._base_url).host
        self._model = model
        self._vision_model = vision_model
        self._max_retries = max_retries
        self._retry_wait_seconds = retry_wait_seconds
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(_REQUEST_TIMEOUT_SECONDS)
        )

    # -- lifecycle -------------------------------------------------------

    async def aclose(self) -> None:
        """Close the owned HTTP client."""
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> OllamaProvider:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    # -- public API ------------------------------------------------------

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        body = self._build_chat_body(
            model=self._model,
            system_prompt=system_prompt,
            messages=list(messages),
            json_schema=json_schema,
        )
        response_body = await self._post_with_retries(body)
        text = _extract_message_content(response_body)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMProviderError(
                "Ollama response did not contain valid JSON for structured extraction",
                code="schema_mismatch",
            ) from exc
        if not isinstance(parsed, dict):
            raise LLMProviderError(
                "Ollama response JSON is not a JSON object",
                code="schema_mismatch",
            )
        usage = _extract_usage(response_body, fallback_model=self._model)
        return parsed, usage

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> tuple[str, TokenUsage]:
        body = self._build_chat_body(
            model=self._model,
            system_prompt=system_prompt,
            messages=list(messages),
            json_schema=None,
        )
        response_body = await self._post_with_retries(body)
        text = _extract_message_content(response_body)
        usage = _extract_usage(response_body, fallback_model=self._model)
        return text, usage

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        # Ollama's /api/chat accepts images on the user message via a
        # dedicated ``images`` array of base64-encoded bytes OR URLs.
        # Our ``VisionInput`` carries either a signed https URL or a
        # ``data:image/...;base64,...`` payload; we normalise both to the
        # base64 payload Ollama expects.
        encoded_images: list[str] = []
        for image in images:
            encoded_images.append(_vision_image_to_b64(image))
        user_message: dict[str, Any] = {
            "role": "user",
            "content": instruction,
            "images": encoded_images,
        }
        body: dict[str, Any] = {
            "model": self._vision_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                user_message,
            ],
            "stream": False,
            "format": json_schema,
        }
        response_body = await self._post_with_retries(body)
        text = _extract_message_content(response_body)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMProviderError(
                "Ollama vision response did not contain valid JSON",
                code="schema_mismatch",
            ) from exc
        if not isinstance(parsed, dict):
            raise LLMProviderError(
                "Ollama vision response JSON is not a JSON object",
                code="schema_mismatch",
            )
        usage = _extract_usage(response_body, fallback_model=self._vision_model)
        return parsed, usage

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _build_chat_body(
        *,
        model: str,
        system_prompt: str,
        messages: list[ChatMessage],
        json_schema: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Assemble the Ollama ``/api/chat`` request body.

        ``stream: false`` — the FastAPI layer aggregates the response
        synchronously; streaming would require an SSE plumb which we
        don't have on the Python side today. A future slice can swap
        this out.

        ``format`` is load-bearing for structured extraction: when set
        to a JSON Schema dict, Ollama constrains the model to emit
        schema-valid JSON. Missing → plain-text completion.
        """
        wire_messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
        ]
        for m in messages:
            wire_messages.append({"role": m["role"], "content": m["content"]})
        body: dict[str, Any] = {
            "model": model,
            "messages": wire_messages,
            "stream": False,
        }
        if json_schema is not None:
            body["format"] = json_schema
        return body

    async def _post_with_retries(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST with tenacity retries; unwrap the last retryable on exhaustion."""
        retry_decorator = tenacity.AsyncRetrying(
            stop=tenacity.stop_after_attempt(self._max_retries),
            wait=_wait_strategy(self._retry_wait_seconds),
            retry=tenacity.retry_if_exception_type(_RetryableOllamaError),
            reraise=True,
        )
        try:
            async for attempt in retry_decorator:
                with attempt:
                    return await self._post_once(body)
            raise AssertionError("unreachable: AsyncRetrying loop exited cleanly")
        except _RetryableOllamaError as exc:
            raise exc.inner from exc

    async def _post_once(self, body: dict[str, Any]) -> dict[str, Any]:
        """Single HTTP attempt. Maps transport + status errors onto the
        terminal / retryable split the orchestrator expects.
        """
        url = f"{self._base_url}/api/chat"
        headers = {"content-type": "application/json"}

        logger.info(
            "ollama request model=%s host=%s",
            body.get("model"),
            self._host,
        )

        try:
            response = await self._client.post(url, headers=headers, json=body)
        except httpx.TimeoutException as exc:
            logger.warning("ollama timeout host=%s", self._host)
            raise _RetryableOllamaError(
                LLMProviderError(
                    f"Ollama request timed out after {_REQUEST_TIMEOUT_SECONDS}s",
                    code="provider_unavailable",
                )
            ) from exc
        except httpx.TransportError as exc:
            logger.warning(
                "ollama transport error host=%s err=%s",
                self._host,
                type(exc).__name__,
            )
            raise _RetryableOllamaError(
                LLMProviderError(
                    f"Ollama transport error: {type(exc).__name__}",
                    code="provider_unavailable",
                )
            ) from exc

        logger.info(
            "ollama response host=%s status=%d",
            self._host,
            response.status_code,
        )

        if response.status_code == 200:
            return _decode_json_or_raise(response)

        if response.status_code == 400:
            raise LLMProviderError(
                _extract_error_message(response, fallback="Ollama 400 Bad Request"),
                code="invalid_request",
            )
        if response.status_code == 404:
            # Ollama returns 404 when the requested model tag hasn't
            # been ``ollama pull``'d. Surface a clear operator-hint
            # message.
            raise LLMProviderError(
                _extract_error_message(
                    response,
                    fallback=(
                        f"Ollama model not available on {self._host}. "
                        "Operator must run `ollama pull <model>` first."
                    ),
                ),
                code="invalid_request",
            )
        if response.status_code == 429:
            raise _RetryableOllamaError(
                LLMProviderError(
                    _extract_error_message(response, fallback="Ollama 429 Too Many Requests"),
                    code="rate_limited",
                )
            )
        if 500 <= response.status_code < 600:
            raise _RetryableOllamaError(
                LLMProviderError(
                    _extract_error_message(
                        response,
                        fallback=f"Ollama {response.status_code} server error",
                    ),
                    code="provider_unavailable",
                )
            )

        # Unexpected statuses → terminal.
        raise LLMProviderError(
            f"Ollama returned unexpected status {response.status_code}",
            code="invalid_request",
        )


def _extract_message_content(response_body: dict[str, Any]) -> str:
    """Pull ``message.content`` out of an Ollama /api/chat response.

    Ollama returns ``{"message": {"role": "assistant", "content": "..."},
    "done": true, ...}``. Any other shape raises ``schema_mismatch``.
    """
    message = response_body.get("message")
    if not isinstance(message, dict):
        raise LLMProviderError(
            "Ollama response missing 'message' object",
            code="schema_mismatch",
        )
    content = message.get("content")
    if not isinstance(content, str):
        raise LLMProviderError(
            "Ollama response 'message.content' is not a string",
            code="schema_mismatch",
        )
    return content


def _extract_usage(response_body: dict[str, Any], *, fallback_model: str) -> TokenUsage:
    """Read the per-request usage numbers off the Ollama response body.

    Ollama's fields are:
    - ``prompt_eval_count`` → prompt tokens.
    - ``eval_count`` → completion tokens.
    - ``model`` → the model tag the server actually used (may differ
      from the requested tag when ``:latest`` resolves to a specific
      digest).

    No ``cached_prompt_tokens`` equivalent exists; we report 0.
    Missing / malformed values fall back to 0 rather than raising so a
    successful extraction isn't sacrificed to a telemetry detail — same
    defensive posture as the Azure provider.
    """
    prompt_tokens = _safe_int(response_body, "prompt_eval_count")
    completion_tokens = _safe_int(response_body, "eval_count")
    model_raw = response_body.get("model") if isinstance(response_body, dict) else None
    model = model_raw if isinstance(model_raw, str) and model_raw else fallback_model

    logger.info(
        "ollama usage model=%s prompt=%d completion=%d",
        model,
        prompt_tokens,
        completion_tokens,
    )
    return TokenUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cached_prompt_tokens=0,
        model=model,
    )


def _safe_int(source: Any, key: str) -> int:
    """Coerce ``source[key]`` to a non-negative int, defaulting to 0."""
    if not isinstance(source, dict):
        return 0
    value = source.get(key)
    if isinstance(value, bool):  # bool is a subclass of int — reject.
        return 0
    if isinstance(value, int):
        return value if value >= 0 else 0
    if isinstance(value, str):
        with contextlib.suppress(ValueError):
            n = int(value)
            return n if n >= 0 else 0
    return 0


def _decode_json_or_raise(response: httpx.Response) -> dict[str, Any]:
    """Decode the 200 response body as JSON or raise ``schema_mismatch``."""
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise LLMProviderError(
            "Ollama returned 200 with non-JSON body", code="schema_mismatch"
        ) from exc
    if not isinstance(data, dict):
        raise LLMProviderError(
            "Ollama returned 200 with non-object JSON body", code="schema_mismatch"
        )
    return data


def _extract_error_message(response: httpx.Response, *, fallback: str) -> str:
    """Pull an error message out of Ollama's JSON body if present."""
    try:
        data = response.json()
    except json.JSONDecodeError:
        return fallback
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, str) and err:
            return err
        if isinstance(err, dict):
            message = err.get("message")
            if isinstance(message, str) and message:
                return message
    return fallback


def _vision_image_to_b64(image: VisionInput) -> str:
    """Normalise a :class:`VisionInput` into the base64 payload Ollama expects.

    Ollama's ``images`` array takes raw base64-encoded bytes (no
    ``data:`` prefix). We accept both:
    - ``data:image/jpeg;base64,<payload>`` — strip the prefix.
    - ``http(s)://...`` signed URL — return as-is and let the model
      server fetch. Ollama 0.3+ supports URL entries in the ``images``
      array directly; older releases would need us to download here,
      which we avoid since it would re-introduce an SSRF surface the
      Azure path deliberately sidesteps.
    """
    url = image["image_url"]
    if url.startswith("data:"):
        # Strip everything up to the first comma (``data:...;base64,``).
        _, _, payload = url.partition(",")
        # Validate the payload decodes cleanly so a malformed data URL
        # surfaces as a terminal ``invalid_request`` rather than a
        # puzzling Ollama 400.
        try:
            base64.b64decode(payload, validate=True)
        except (ValueError, TypeError) as exc:
            raise LLMProviderError(
                "VisionInput data URL carried invalid base64 payload",
                code="invalid_request",
            ) from exc
        return payload
    return url


__all__ = ["OllamaProvider"]
