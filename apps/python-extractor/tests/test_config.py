"""Tests for the pydantic-settings `Settings` class.

Covers:
- Default values come through cleanly when the environment is empty.
- Per-field env-var overrides are picked up (case-insensitive).
- Unknown envs don't leak into the model.
- The class is instantiable from callers that pass nothing (used as a
  module-level singleton later; must not raise at import time).
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from extractor.config import Settings

# All env vars the Settings class reads. Any test that mutates the
# environment must scrub these first so leaked parent-process values
# don't mask defaults-loading bugs.
_MANAGED_ENV_VARS = (
    "SERVICE_NAME",
    "LOG_LEVEL",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_STRUCTURING",
    "AZURE_OPENAI_DEPLOYMENT_CHAT",
    "EXTRACTOR_SHARED_SECRET",
)


@pytest.fixture()
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Strip all managed env vars so each test starts from a known baseline."""
    for var in _MANAGED_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    yield


@pytest.mark.usefixtures("clean_env")
def test_defaults_load_without_environment() -> None:
    """With no env vars set, the Settings object populates from defaults."""
    settings = Settings()
    assert settings.service_name == "extractor"
    assert settings.log_level == "INFO"
    assert settings.azure_openai_endpoint == ""
    assert settings.azure_openai_api_key == ""
    assert settings.azure_openai_api_version == "2025-04-01-preview"
    assert settings.azure_openai_deployment_structuring == "gpt-4.1"
    assert settings.azure_openai_deployment_chat == "gpt-5.1-chat"
    assert settings.extractor_shared_secret == ""


@pytest.mark.usefixtures("clean_env")
def test_env_overrides_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each managed env var overrides the matching Settings attribute."""
    monkeypatch.setenv("SERVICE_NAME", "extractor-test")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://fake.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key-abc")
    monkeypatch.setenv("AZURE_OPENAI_API_VERSION", "2099-01-01-preview")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT_STRUCTURING", "test-structuring")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT_CHAT", "test-chat")
    monkeypatch.setenv("EXTRACTOR_SHARED_SECRET", "shared-secret-xyz")

    settings = Settings()

    assert settings.service_name == "extractor-test"
    assert settings.log_level == "DEBUG"
    assert settings.azure_openai_endpoint == "https://fake.openai.azure.com"
    assert settings.azure_openai_api_key == "test-key-abc"
    assert settings.azure_openai_api_version == "2099-01-01-preview"
    assert settings.azure_openai_deployment_structuring == "test-structuring"
    assert settings.azure_openai_deployment_chat == "test-chat"
    # S105 suppressed: test fixture string, not a real secret — the point
    # of this assertion is that env-var overrides make it onto the model.
    assert settings.extractor_shared_secret == "shared-secret-xyz"  # noqa: S105


@pytest.mark.usefixtures("clean_env")
def test_env_vars_are_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    """pydantic-settings defaults to case-insensitive env-var matching.

    Guard against accidentally turning on `case_sensitive = True` in a
    future edit — that would break docker-compose's UPPERCASE env vars.
    """
    monkeypatch.setenv("service_name", "lowercased-wins")
    settings = Settings()
    assert settings.service_name == "lowercased-wins"


@pytest.mark.usefixtures("clean_env")
def test_extra_env_vars_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unknown env vars must not raise on instantiation — docker-compose
    hands the process lots of unrelated vars (PATH, HOME, ...)."""
    monkeypatch.setenv("SOME_UNRELATED_VAR", "nonsense")
    settings = Settings()
    assert not hasattr(settings, "some_unrelated_var")


def test_instantiable_with_no_args() -> None:
    """Callers use `Settings()` as a module-level singleton in later
    slices; it must never require explicit args."""
    settings = Settings()
    assert isinstance(settings.service_name, str)
