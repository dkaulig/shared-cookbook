"""Abstract ``LLMProvider`` interface + typed message shapes.

This is the stable contract Phase 2 slices consume. Implementations:

- ``AzureOpenAIProvider`` (production, real HTTP against the Azure
  OpenAI Responses API).
- ``MockLLMProvider`` (tests — scripted replies).
- ``NullProvider`` (safe default when credentials are missing).

The ``TypedDict`` shapes are deliberately narrow: one role literal, one
content string for chat messages; an image URL + detail level for
vision. Downstream code keeps its own schemas for tool calls, function
calls, etc. — those are per-endpoint concerns.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from typing import Any, Literal, TypedDict


class ChatMessage(TypedDict):
    """One turn of a chat conversation.

    Shape mirrors the OpenAI / Azure OpenAI message wire format so the
    Azure provider can pass it through with minimal translation.
    """

    role: Literal["system", "user", "assistant"]
    content: str


class VisionInput(TypedDict):
    """One image input to a vision-LLM call.

    - ``image_url`` — signed https URL or a ``data:`` URL with embedded
      base64 payload. The provider does no fetching or preprocessing.
    - ``detail`` — Azure's detail-level hint. ``"auto"`` lets the model
      decide; ``"low"`` is cheap + fast; ``"high"`` burns more tokens
      for better OCR on dense photos (handwritten cookbooks).
    """

    image_url: str
    detail: Literal["low", "high", "auto"]


class TokenUsage(TypedDict):
    """Token-consumption metadata reported by the provider (PF2).

    Every ``LLMProvider`` method returns a ``TokenUsage`` alongside its
    result. The service emits these as ``X-Extractor-*`` response
    headers; the .NET side persists them on ``RecipeImport`` +
    ``ChatUsageLog`` rows so ops can see per-user / per-model spend.

    - ``prompt_tokens`` — input tokens sent to the model (post-caching
      is counted separately via ``cached_prompt_tokens``, which is a
      subset of the total input the model actually billed at the
      cached rate — Azure reports both on every Responses API call).
    - ``completion_tokens`` — output tokens the model generated.
    - ``cached_prompt_tokens`` — portion of ``prompt_tokens`` billed at
      the cached-input rate. Azure reports this via
      ``input_tokens_details.cached_tokens``; zero when the request
      didn't hit cache.
    - ``model`` — deployment name as Azure returned it (e.g.
      ``"gpt-5.1-chat"``). Used by :class:`AiPricingService` on the
      .NET side to look up $/1M rates.

    Fakes and the ``MockLLMProvider`` return ``model="mock"`` + zeros
    by default so tests that don't care about accounting don't have to
    script anything; tests that *do* care can pin explicit counts via
    the scripted-entry expanded-tuple format.
    """

    prompt_tokens: int
    completion_tokens: int
    cached_prompt_tokens: int
    model: str


class LLMProvider(ABC):
    """Abstract provider contract.

    Every method is ``async`` because the rest of the service is async
    (``httpx.AsyncClient``, FastAPI). Every method raises
    ``LLMProviderError`` on failure — callers should not need to catch
    raw network errors.
    """

    @abstractmethod
    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        """Run a structured extraction.

        Returns the parsed JSON payload + a :class:`TokenUsage` record
        (PF2 cost-tracking). The response is parsed JSON, guaranteed
        to match ``json_schema`` at the response-format level (Azure
        enforces). Callers still perform their own pydantic validation
        downstream — defence in depth.
        """

    @abstractmethod
    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> tuple[str, TokenUsage]:
        """Plain conversational turn.

        Returns the assistant's reply text + a :class:`TokenUsage`
        record for the request.
        """

    @abstractmethod
    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        """Vision-LLM structured extraction from ordered image inputs.

        Returns the parsed JSON payload + a :class:`TokenUsage` record.
        ``instruction`` is the user-level prompt explaining *what* to
        extract (e.g. "Extrahiere ein Rezept aus diesen Kochbuch-
        Seiten"). ``json_schema`` constrains the output the same way
        ``extract_structured`` does.
        """
