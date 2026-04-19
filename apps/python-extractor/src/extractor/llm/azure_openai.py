"""Azure OpenAI provider using the **Responses API**.

The user's Azure resource is on api-version ``2025-04-01-preview``,
which exposes the Responses API at
``POST {endpoint}/openai/responses?api-version=...``. This is a
different surface from the older Chat Completions API:

- Body carries ``model`` (the deployment name), ``instructions`` (the
  system prompt as a plain string), ``input`` (a list of message
  objects with a ``content`` array of parts — ``input_text`` for text,
  ``input_image`` for vision).
- Structured-output enforcement via ``response_format =
  {type: "json_schema", json_schema: {schema: ..., name: ...}}``.
- Auth via the ``api-key`` request header (not ``Authorization`` —
  Azure-specific).

We deliberately use ``httpx`` directly instead of the ``openai`` SDK:
- The Responses API is new enough that SDK coverage is uneven; direct
  JSON gives us one less dependency to track for breaking changes.
- Keeps the Docker image small.
- Testing via ``respx`` is trivial against bare ``httpx`` calls.

Retries (3 attempts total, exponential backoff) fire only for the two
transient error classes: ``provider_unavailable`` (5xx / network /
timeout) and ``rate_limited`` (429). ``invalid_request`` /
``auth_failure`` are terminal — retrying them is pointless and wastes
budget.
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import Sequence
from types import TracebackType
from typing import Any

import httpx
import tenacity
import tenacity.wait

from extractor.llm.errors import LLMProviderError
from extractor.llm.provider import ChatMessage, LLMProvider, TokenUsage, VisionInput

logger = logging.getLogger("extractor.llm")

# Timeout for each HTTP attempt. LLM calls are slow — 120s headroom
# avoids false negatives while still catching truly-stuck connections.
_REQUEST_TIMEOUT_SECONDS: float = 120.0

# Default retry policy knobs. Factory overrides to 0-wait for unit tests.
_DEFAULT_MAX_RETRIES: int = 3
_DEFAULT_RETRY_WAIT_SECONDS: float = 2.0


class _RetryableLLMError(Exception):
    """Internal exception wrapping retryable LLM failures.

    tenacity's ``retry_if_exception_type`` matches on exact classes.
    We wrap the real ``LLMProviderError`` here so only the two
    retryable codes trigger retry — terminal codes propagate directly.
    ``retry_after_seconds`` is the server's ``Retry-After`` hint (None
    when absent) so the wait strategy can honour it.
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


def _wait_strategy(
    default_wait_seconds: float,
) -> tenacity.wait.wait_base:
    """Wait ``Retry-After`` when the last exception carried one, else
    exponential backoff.

    tenacity expects a callable taking ``RetryCallState`` → seconds.
    Wrapped as a ``wait_base`` so the decorator accepts it.
    """
    expo = tenacity.wait_exponential(
        multiplier=default_wait_seconds, min=default_wait_seconds, max=30.0
    )

    class _Strategy(tenacity.wait.wait_base):
        def __call__(self, retry_state: tenacity.RetryCallState) -> float:
            outcome = retry_state.outcome
            if outcome is not None and outcome.failed:
                exc = outcome.exception()
                if isinstance(exc, _RetryableLLMError) and exc.retry_after_seconds is not None:
                    return exc.retry_after_seconds
            return expo(retry_state)

    return _Strategy()


def _parse_retry_after(header_value: str | None) -> float | None:
    """Parse a ``Retry-After`` header into seconds.

    Azure sends integer seconds; RFC 7231 also allows HTTP-date, which
    we don't attempt to parse (never seen from Azure). Returns ``None``
    if the header is absent or unparseable.
    """
    if header_value is None:
        return None
    with contextlib.suppress(ValueError):
        return float(int(header_value.strip()))
    return None


class AzureOpenAIProvider(LLMProvider):
    """Production ``LLMProvider`` talking to the Azure OpenAI Responses API."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        api_version: str,
        deployment_structuring: str,
        deployment_chat: str,
        max_retries: int = _DEFAULT_MAX_RETRIES,
        retry_wait_seconds: float = _DEFAULT_RETRY_WAIT_SECONDS,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        """
        Parameters
        ----------
        endpoint
            Base URL, e.g. ``https://resource.openai.azure.com`` (no
            trailing slash; we normalise).
        api_key
            Sent as the ``api-key`` header. Never logged.
        api_version
            Query-string ``api-version`` value. Pinned at the settings
            layer; passing per-provider so tests can vary it.
        deployment_structuring
            Deployment name used for ``extract_structured`` and
            ``vision_extract`` (larger / cheaper-wins models).
        deployment_chat
            Deployment name used for ``chat``.
        max_retries
            Total attempts on a retryable failure (default 3).
        retry_wait_seconds
            Base wait for exponential backoff. Factory keeps the
            default; unit tests pass ``0.0`` for snappiness.
        http_client
            Optional pre-built client — lets the factory share a client
            across providers in the future. Defaults to a fresh
            ``AsyncClient`` with a 120s timeout.
        """
        self._endpoint = endpoint.rstrip("/")
        # Redacted endpoint for structured logs — host only, no path.
        self._endpoint_host = httpx.URL(self._endpoint).host
        self._api_key = api_key
        self._api_version = api_version
        self._deployment_structuring = deployment_structuring
        self._deployment_chat = deployment_chat
        self._max_retries = max_retries
        self._retry_wait_seconds = retry_wait_seconds
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(_REQUEST_TIMEOUT_SECONDS)
        )

    # -- lifecycle -------------------------------------------------------

    async def aclose(self) -> None:
        """Close the HTTP client if we own it."""
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> AzureOpenAIProvider:
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
        body = self._build_request(
            model=self._deployment_structuring,
            system_prompt=system_prompt,
            input_messages=[self._chat_message_to_input(m) for m in messages],
            json_schema=json_schema,
        )
        response_body = await self._post_with_retries(body)
        text = self._extract_output_text(response_body)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMProviderError(
                "Azure response did not contain valid JSON for structured extraction",
                code="schema_mismatch",
            ) from exc
        if not isinstance(parsed, dict):
            raise LLMProviderError(
                "Azure response JSON is not a JSON object (expected dict at top level)",
                code="schema_mismatch",
            )
        usage = self._extract_usage(response_body, fallback_model=self._deployment_structuring)
        return parsed, usage

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> tuple[str, TokenUsage]:
        body = self._build_request(
            model=self._deployment_chat,
            system_prompt=system_prompt,
            input_messages=[self._chat_message_to_input(m) for m in messages],
            json_schema=None,
        )
        response_body = await self._post_with_retries(body)
        text = self._extract_output_text(response_body)
        usage = self._extract_usage(response_body, fallback_model=self._deployment_chat)
        return text, usage

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        content_parts: list[dict[str, Any]] = [{"type": "input_text", "text": instruction}]
        for image in images:
            content_parts.append(
                {
                    "type": "input_image",
                    "image_url": image["image_url"],
                    "detail": image["detail"],
                }
            )
        body = self._build_request(
            model=self._deployment_structuring,
            system_prompt=system_prompt,
            input_messages=[{"role": "user", "content": content_parts}],
            json_schema=json_schema,
        )
        response_body = await self._post_with_retries(body)
        text = self._extract_output_text(response_body)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMProviderError(
                "Azure vision response did not contain valid JSON",
                code="schema_mismatch",
            ) from exc
        if not isinstance(parsed, dict):
            raise LLMProviderError(
                "Azure vision response JSON is not a JSON object",
                code="schema_mismatch",
            )
        usage = self._extract_usage(response_body, fallback_model=self._deployment_structuring)
        return parsed, usage

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _chat_message_to_input(message: ChatMessage) -> dict[str, Any]:
        """Convert a ``ChatMessage`` to the Responses-API ``input`` shape.

        Each message carries a ``content`` array of parts (``input_text``
        for plain text, ``input_image`` for vision). For non-vision
        chat, every part is a single ``input_text`` part.
        """
        return {
            "role": message["role"],
            "content": [{"type": "input_text", "text": message["content"]}],
        }

    def _build_request(
        self,
        *,
        model: str,
        system_prompt: str,
        input_messages: list[dict[str, Any]],
        json_schema: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Assemble the Responses-API JSON body.

        Broken out so tests can introspect the shape and so the three
        public methods share one code path for the fiddly parts.
        """
        body: dict[str, Any] = {
            "model": model,
            "instructions": system_prompt,
            "input": input_messages,
        }
        if json_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    # Azure requires a schema name; keep it stable so log
                    # diffs don't churn across calls.
                    "name": "extractor_response",
                    "schema": json_schema,
                    "strict": True,
                },
            }
        return body

    async def _post_with_retries(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST to the Responses endpoint, retrying on transient failures.

        The inner function raises:
        - ``_RetryableLLMError`` for 5xx / 429 / network — tenacity
          catches this and retries.
        - ``LLMProviderError`` (terminal codes) — tenacity's
          ``retry_if_exception_type(_RetryableLLMError)`` does NOT
          catch this, so it propagates immediately.
        On retry exhaustion we unwrap the last ``_RetryableLLMError``
        and raise its inner ``LLMProviderError``.
        """
        retry_decorator = tenacity.AsyncRetrying(
            stop=tenacity.stop_after_attempt(self._max_retries),
            wait=_wait_strategy(self._retry_wait_seconds),
            retry=tenacity.retry_if_exception_type(_RetryableLLMError),
            reraise=True,
        )
        try:
            async for attempt in retry_decorator:
                with attempt:
                    return await self._post_once(body)
            # Unreachable: AsyncRetrying always either returns or raises.
            raise AssertionError("unreachable: AsyncRetrying loop exited cleanly")
        except _RetryableLLMError as exc:
            raise exc.inner from exc

    async def _post_once(self, body: dict[str, Any]) -> dict[str, Any]:
        """Single HTTP attempt. Translates transport / status errors
        into either ``_RetryableLLMError`` (retryable) or
        ``LLMProviderError`` (terminal)."""
        url = f"{self._endpoint}/openai/responses"
        params = {"api-version": self._api_version}
        headers = {"api-key": self._api_key, "content-type": "application/json"}

        logger.info(
            "azure-openai request model=%s host=%s",
            body.get("model"),
            self._endpoint_host,
        )

        try:
            response = await self._client.post(url, params=params, headers=headers, json=body)
        except httpx.TimeoutException as exc:
            logger.warning("azure-openai timeout host=%s", self._endpoint_host)
            raise _RetryableLLMError(
                LLMProviderError(
                    f"Azure OpenAI request timed out after {_REQUEST_TIMEOUT_SECONDS}s",
                    code="provider_unavailable",
                )
            ) from exc
        except httpx.TransportError as exc:
            logger.warning(
                "azure-openai transport error host=%s err=%s",
                self._endpoint_host,
                type(exc).__name__,
            )
            raise _RetryableLLMError(
                LLMProviderError(
                    f"Azure OpenAI transport error: {type(exc).__name__}",
                    code="provider_unavailable",
                )
            ) from exc

        logger.info(
            "azure-openai response host=%s status=%d",
            self._endpoint_host,
            response.status_code,
        )
        # Raw response body is PII-risk (user content + LLM output).
        # DEBUG-only, never INFO. Still truncated defensively.
        logger.debug(
            "azure-openai response body (truncated): %s",
            response.text[:500],
        )

        if response.status_code == 200:
            return _decode_json_or_raise(response)

        if response.status_code == 400:
            raise LLMProviderError(
                _extract_error_message(response, fallback="Azure 400 Bad Request"),
                code="invalid_request",
            )
        if response.status_code == 401:
            raise LLMProviderError(
                _extract_error_message(response, fallback="Azure 401 Unauthorized"),
                code="auth_failure",
            )
        if response.status_code == 429:
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            raise _RetryableLLMError(
                LLMProviderError(
                    _extract_error_message(response, fallback="Azure 429 Too Many Requests"),
                    code="rate_limited",
                ),
                retry_after_seconds=retry_after,
            )
        if 500 <= response.status_code < 600:
            raise _RetryableLLMError(
                LLMProviderError(
                    _extract_error_message(
                        response,
                        fallback=f"Azure {response.status_code} server error",
                    ),
                    code="provider_unavailable",
                )
            )

        # Unexpected status (3xx, 402, …). Treat as terminal invalid_request
        # so we surface to the caller without silently retrying.
        raise LLMProviderError(
            f"Azure returned unexpected status {response.status_code}",
            code="invalid_request",
        )

    @staticmethod
    def _extract_usage(response_body: dict[str, Any], *, fallback_model: str) -> TokenUsage:
        """Pull a :class:`TokenUsage` out of the Responses-API body (PF2).

        Azure reports ``usage`` as:

        .. code-block:: json

            {"input_tokens": 123, "output_tokens": 45,
             "input_tokens_details": {"cached_tokens": 40}}

        Missing / malformed numbers degrade to zero rather than raising
        so an unusual response (e.g. a streamed chunk without a final
        ``usage`` envelope) doesn't kill a successful extraction. The
        .NET side treats zero token-counts as "no data, leave columns
        NULL". ``model`` comes from the top-level ``model`` field Azure
        echoes back; when absent we fall back to the caller's
        deployment name so operators always see *some* label.

        Logs prompt + completion counts at INFO so we have
        operational visibility (useful to spot runaway cost) without
        leaking any user content.
        """
        usage_raw = response_body.get("usage") if isinstance(response_body, dict) else None
        prompt_tokens = _safe_int(usage_raw, "input_tokens")
        completion_tokens = _safe_int(usage_raw, "output_tokens")
        cached_prompt_tokens = 0
        if isinstance(usage_raw, dict):
            details = usage_raw.get("input_tokens_details")
            if isinstance(details, dict):
                cached_prompt_tokens = _safe_int(details, "cached_tokens")

        model_raw = response_body.get("model") if isinstance(response_body, dict) else None
        model = model_raw if isinstance(model_raw, str) and model_raw else fallback_model

        logger.info(
            "azure-openai usage model=%s prompt=%d completion=%d cached=%d",
            model,
            prompt_tokens,
            completion_tokens,
            cached_prompt_tokens,
        )

        return TokenUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cached_prompt_tokens=cached_prompt_tokens,
            model=model,
        )

    @staticmethod
    def _extract_output_text(response_body: dict[str, Any]) -> str:
        """Pull the first ``output_text`` string out of a Responses-API body.

        The Responses API nests text inside ``output[].content[]`` where
        each content entry has ``type`` ``output_text``. Raises
        ``schema_mismatch`` if the shape doesn't fit — never coerces.
        """
        output = response_body.get("output")
        if not isinstance(output, list) or len(output) == 0:
            raise LLMProviderError(
                "Azure response missing 'output' array",
                code="schema_mismatch",
            )
        for entry in output:
            if not isinstance(entry, dict):
                continue
            content = entry.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if (
                    isinstance(part, dict)
                    and part.get("type") == "output_text"
                    and isinstance(part.get("text"), str)
                ):
                    text_value: str = part["text"]
                    return text_value
        raise LLMProviderError(
            "Azure response had no output_text part",
            code="schema_mismatch",
        )


def _safe_int(source: Any, key: str) -> int:
    """Coerce ``source[key]`` to a non-negative int, defaulting to 0.

    Defends the usage-parsing path against Azure quirks: missing keys,
    string-typed numbers, negative values, or a ``usage`` envelope that
    isn't a dict at all. Anything unparseable → 0 so a successful
    extraction is never sacrificed to a telemetry detail.
    """
    if not isinstance(source, dict):
        return 0
    value = source.get(key)
    if isinstance(value, bool):  # bool is a subclass of int — reject.
        return 0
    if isinstance(value, int):
        return value if value >= 0 else 0
    if isinstance(value, str):
        try:
            n = int(value)
        except ValueError:
            return 0
        return n if n >= 0 else 0
    return 0


def _decode_json_or_raise(response: httpx.Response) -> dict[str, Any]:
    """Decode the response body as JSON or raise ``schema_mismatch``."""
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise LLMProviderError(
            "Azure returned 200 with non-JSON body", code="schema_mismatch"
        ) from exc
    if not isinstance(data, dict):
        raise LLMProviderError(
            "Azure returned 200 with non-object JSON body", code="schema_mismatch"
        )
    return data


def _extract_error_message(response: httpx.Response, *, fallback: str) -> str:
    """Pull an error message out of Azure's JSON body if present."""
    try:
        data = response.json()
    except json.JSONDecodeError:
        return fallback
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            message = err.get("message")
            if isinstance(message, str) and message:
                return message
        message = data.get("message")
        if isinstance(message, str) and message:
            return message
    return fallback


__all__ = ["AzureOpenAIProvider"]
