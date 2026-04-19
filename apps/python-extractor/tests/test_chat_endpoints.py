"""Tests for ``POST /chat`` and ``POST /chat/{session_id}/to-recipe``.

All tests override the ``LLMProvider`` dependency with a fake — no
Azure calls. Happy-path, validation (400 / 413), and provider-outage
(503 / 500) paths are all covered.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi.testclient import TestClient

from extractor.llm import ChatMessage, LLMProvider, LLMProviderError, TokenUsage
from extractor.main import create_app, get_llm_provider


def _canonical_recipe_payload() -> dict[str, Any]:
    return {
        "title": "Kartoffelgratin",
        "description": "Cremiger Gratin.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 15,
        "cook_minutes": 45,
        "ingredients": [
            {
                "name": "Kartoffeln",
                "quantity": "1",
                "unit": "kg",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [{"position": 1, "content": "Schälen.", "confidence": "high"}],
        "tags": ["vegan"],
        "source_url": "ignored",
        "thumbnail_url": None,
    }


def _stub_usage() -> TokenUsage:
    return {
        "prompt_tokens": 250,
        "completion_tokens": 80,
        "cached_prompt_tokens": 30,
        "model": "gpt-5.1-chat",
    }


class _FakeProvider(LLMProvider):
    """Records chat / extract calls + returns canned replies."""

    def __init__(
        self,
        *,
        chat_reply: str = "Hallo aus dem Koch-Assistent!",
        extract_reply: dict[str, Any] | None = None,
        usage: TokenUsage | None = None,
    ) -> None:
        self.chat_reply = chat_reply
        self.extract_reply = extract_reply or _canonical_recipe_payload()
        self.usage: TokenUsage = usage if usage is not None else _stub_usage()
        self.chat_calls: list[tuple[str, list[ChatMessage]]] = []
        self.extract_calls: list[tuple[str, list[ChatMessage], dict[str, Any]]] = []

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.extract_calls.append((system_prompt, list(messages), json_schema))
        return dict(self.extract_reply), self.usage

    async def chat(
        self, system_prompt: str, messages: Sequence[ChatMessage]
    ) -> tuple[str, TokenUsage]:
        self.chat_calls.append((system_prompt, list(messages)))
        return self.chat_reply, self.usage

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[Any],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise NotImplementedError


class _FailingProvider(LLMProvider):
    def __init__(self, error: LLMProviderError) -> None:
        self.error = error

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error

    async def chat(
        self, system_prompt: str, messages: Sequence[ChatMessage]
    ) -> tuple[str, TokenUsage]:
        raise self.error

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[Any],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error


def _client_with_provider(provider: LLMProvider) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_llm_provider] = lambda: provider
    return TestClient(app)


# ─────────────────────────────────────────────────────────────────────
# POST /chat
# ─────────────────────────────────────────────────────────────────────


def test_post_chat_returns_200_for_single_user_turn() -> None:
    """One-message dialogue → 200 + the provider's canned reply."""
    provider = _FakeProvider(chat_reply="Klar, welche Ernährung?")
    client = _client_with_provider(provider)

    response = client.post(
        "/chat",
        json={
            "session_id": "sess-abc",
            "messages": [{"role": "user", "content": "Ich hab Kartoffeln, Quark, Lauch"}],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"assistant_message": "Klar, welche Ernährung?"}
    assert len(provider.chat_calls) == 1
    (_, forwarded) = provider.chat_calls[0]
    assert forwarded == [{"role": "user", "content": "Ich hab Kartoffeln, Quark, Lauch"}]


def test_post_chat_forwards_all_five_turns_in_order() -> None:
    """5-turn dialogue — provider sees every turn in the submitted order."""
    provider = _FakeProvider(chat_reply="Ok")
    client = _client_with_provider(provider)

    history = [
        {"role": "user", "content": "Kartoffeln, Quark, Lauch"},
        {"role": "assistant", "content": "Welche Ernährung?"},
        {"role": "user", "content": "Vegan"},
        {"role": "assistant", "content": "Wie viele Portionen?"},
        {"role": "user", "content": "4"},
    ]
    response = client.post(
        "/chat",
        json={"session_id": "sess-xyz", "messages": history},
    )

    assert response.status_code == 200
    assert len(provider.chat_calls) == 1
    (_, forwarded) = provider.chat_calls[0]
    assert forwarded == history


def test_post_chat_rejects_empty_messages_with_400() -> None:
    """Empty ``messages`` → HTTP 400 with a German message."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    response = client.post(
        "/chat",
        json={"session_id": "sess", "messages": []},
    )

    assert response.status_code == 400
    assert provider.chat_calls == []


def test_post_chat_rejects_over_max_length_with_413() -> None:
    """31-turn history → HTTP 413 ("zu lang")."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    history = [{"role": "user", "content": f"m{i}"} for i in range(31)]
    response = client.post(
        "/chat",
        json={"session_id": "sess", "messages": history},
    )

    assert response.status_code == 413
    assert "zu lang" in response.json()["detail"].lower()
    assert provider.chat_calls == []


def test_post_chat_returns_503_on_provider_unavailable() -> None:
    """Azure outage → LLMProviderError(provider_unavailable) → HTTP 503."""
    provider = _FailingProvider(LLMProviderError("down", code="provider_unavailable"))
    client = _client_with_provider(provider)

    response = client.post(
        "/chat",
        json={
            "session_id": "sess",
            "messages": [{"role": "user", "content": "Hi"}],
        },
    )

    assert response.status_code == 503
    assert "KI-Service" in response.json()["detail"]


def test_post_chat_returns_500_on_auth_failure() -> None:
    """Bad API key → LLMProviderError(auth_failure) → HTTP 500 (service misconfig)."""
    provider = _FailingProvider(LLMProviderError("bad key", code="auth_failure"))
    client = _client_with_provider(provider)

    response = client.post(
        "/chat",
        json={
            "session_id": "sess",
            "messages": [{"role": "user", "content": "Hi"}],
        },
    )

    assert response.status_code == 500


def test_post_chat_rejects_unknown_role_at_schema_layer() -> None:
    """A message with an invalid role → pydantic 422 (schema validation)."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    response = client.post(
        "/chat",
        json={
            "session_id": "sess",
            "messages": [{"role": "system-override", "content": "Hi"}],
        },
    )

    assert response.status_code == 422


def test_post_chat_rejects_missing_session_id() -> None:
    """Body must carry ``session_id`` — schema 422 when absent."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    response = client.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "Hi"}]},
    )

    assert response.status_code == 422


# ─────────────────────────────────────────────────────────────────────
# POST /chat/{session_id}/to-recipe
# ─────────────────────────────────────────────────────────────────────


def test_post_to_recipe_returns_structured_result() -> None:
    """Happy path: dialog → structured recipe JSON, 200."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    response = client.post(
        "/chat/sess-abc/to-recipe",
        json={
            "messages": [
                {"role": "user", "content": "Ich hab Kartoffeln"},
                {"role": "assistant", "content": "Gratin?"},
                {"role": "user", "content": "Ja"},
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["recipe"]["title"] == "Kartoffelgratin"
    # Synthetic chat: URL pinned by post_process.
    assert body["recipe"]["source_url"] == "chat:sess-abc"
    assert body["recipe"]["thumbnail_url"] is None
    assert body["confidence"]["overall"] in ("high", "medium", "low")


def test_post_to_recipe_rejects_empty_messages_with_400() -> None:
    """Empty messages → 400."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    response = client.post(
        "/chat/sess/to-recipe",
        json={"messages": []},
    )

    assert response.status_code == 400
    assert provider.extract_calls == []


def test_post_to_recipe_rejects_over_max_length_with_413() -> None:
    """Too-long history → 413."""
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    history = [{"role": "user", "content": f"m{i}"} for i in range(31)]
    response = client.post(
        "/chat/sess/to-recipe",
        json={"messages": history},
    )

    assert response.status_code == 413
    assert provider.extract_calls == []


def test_post_to_recipe_returns_503_on_provider_outage() -> None:
    """Provider outage during structuring → 503."""
    provider = _FailingProvider(LLMProviderError("down", code="provider_unavailable"))
    client = _client_with_provider(provider)

    response = client.post(
        "/chat/sess/to-recipe",
        json={
            "messages": [{"role": "user", "content": "Rezept bitte"}],
        },
    )

    assert response.status_code == 503
    assert "KI-Service" in response.json()["detail"]


def test_post_to_recipe_rejects_empty_session_id_path() -> None:
    """Routing: missing session_id isn't a match — FastAPI returns 404.

    Documents the endpoint shape: the session_id is a path segment, not
    a query param, so empty strings in the URL can't hit the handler.
    """
    provider = _FakeProvider()
    client = _client_with_provider(provider)

    response = client.post(
        "/chat//to-recipe",
        json={"messages": [{"role": "user", "content": "Hi"}]},
    )

    # FastAPI's router treats ``/chat//to-recipe`` as a not-found path.
    assert response.status_code in (404, 307)
