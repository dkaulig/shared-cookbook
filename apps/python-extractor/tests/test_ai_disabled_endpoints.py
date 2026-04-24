"""REL-7 — endpoint-level "AI disabled" integration tests.

When ``LLM_PROVIDER=disabled`` the extractor service should still boot
and serve ``/health``, but every AI-requiring endpoint must return a
clean 503 with the German "KI-Funktionen sind deaktiviert" message so
the frontend can surface something sensible instead of a generic 500.

These tests wire a :class:`DisabledProvider` in via FastAPI's
``dependency_overrides`` and hit the real endpoints via
:class:`TestClient`. We do NOT boot the full AI-enabled path (which
would involve yt-dlp + Whisper) — the provider is the only piece that
matters for the error mapping.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from extractor.llm.mock import DisabledProvider
from extractor.main import create_app, get_llm_provider


def _app_with_disabled_provider() -> TestClient:
    """Return a TestClient whose LLM dependency is the DisabledProvider."""
    app = create_app()
    app.dependency_overrides[get_llm_provider] = lambda: DisabledProvider()
    return TestClient(app)


def test_health_still_works_when_ai_disabled() -> None:
    """/health is dep-free and must always answer."""
    with _app_with_disabled_provider() as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_chat_to_recipe_returns_503_ai_disabled() -> None:
    """Calling the chat → recipe endpoint surfaces 503 + German message."""
    with _app_with_disabled_provider() as client:
        response = client.post(
            "/chat/00000000-0000-0000-0000-000000000001/to-recipe",
            json={
                "messages": [
                    {"role": "user", "content": "Mach mir Kartoffelsalat"},
                ],
            },
        )
    assert response.status_code == 503
    body = response.json()
    # The German error message is the user-visible surface.
    assert "deaktiviert" in body["detail"]
