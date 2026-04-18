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
    ) -> dict[str, Any]:
        """Run a structured extraction.

        The response is parsed JSON, guaranteed to match ``json_schema``
        at the response-format level (Azure enforces). Callers still
        perform their own pydantic validation downstream — defence in
        depth.
        """

    @abstractmethod
    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> str:
        """Plain conversational turn. Returns the assistant's reply text."""

    @abstractmethod
    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        """Vision-LLM structured extraction from ordered image inputs.

        ``instruction`` is the user-level prompt explaining *what* to
        extract (e.g. "Extrahiere ein Rezept aus diesen Kochbuch-
        Seiten"). ``json_schema`` constrains the output the same way
        ``extract_structured`` does.
        """
