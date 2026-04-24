"""REL-7 — the Whisper prefetch must skip when AI is disabled.

Two guards protect the fire-and-forget prefetch task:

1. ``PYTEST_CURRENT_TEST`` — CI runners have no HF cache so the
   prefetch would kick off a 3 GB download per ``TestClient`` context.
   This guard is pre-existing (CLAUDE.md-documented).
2. ``AI_ENABLED=false`` (REL-7) — Path-1 minimal installs shouldn't
   pay the 3 GB cost when they have no way to use the transcriber
   anyway. Video-URL imports gate on ``--profile ai``; without AI the
   pipeline can't structure a transcript at all.

Both guards must fire independently so removing one can't accidentally
re-enable the download via the other path.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from extractor.config import Settings
from extractor.main import _get_settings, _prefetch_whisper_model


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    """Invalidate the :func:`_get_settings` cache so per-test env
    changes take effect without having to rebuild the app."""
    _get_settings.cache_clear()


async def test_prefetch_skips_under_pytest_guard() -> None:
    """Pre-existing guard — ``PYTEST_CURRENT_TEST`` is always set here so
    the prefetch returns immediately without importing Whisper."""
    # Even with AI enabled, the pytest guard keeps us out.
    with patch.dict(os.environ, {"AI_ENABLED": "true"}, clear=False):
        _get_settings.cache_clear()
        # If this returned without error, the guard fired.
        await _prefetch_whisper_model()


async def test_prefetch_skips_when_ai_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REL-7 — ``AI_ENABLED=false`` short-circuits the prefetch even if
    the pytest guard somehow goes away.

    We temporarily scrub ``PYTEST_CURRENT_TEST`` so the first guard
    can't silently pass the test; the only reason the function should
    return cleanly is the ``ai_enabled=False`` check.
    """
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("AI_ENABLED", "false")
    _get_settings.cache_clear()

    # If the AI_ENABLED guard works, the function returns immediately
    # without ever importing faster_whisper (otherwise it would try to
    # pull the 3 GB model weights on a CI runner).
    await _prefetch_whisper_model()

    # Spot-check the settings path the guard reads from.
    assert _get_settings().ai_enabled is False


async def test_prefetch_settings_ai_enabled_true_by_default_is_false() -> None:
    """Fresh :class:`Settings` defaults to AI off — the stack is opt-in."""
    settings = Settings()
    assert settings.ai_enabled is False
    assert settings.llm_provider == "disabled"
