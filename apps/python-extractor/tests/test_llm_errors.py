"""Tests for ``extractor.llm.errors.LLMProviderError``.

The error class is the shared contract every provider raises against.
Downstream orchestrator code branches on ``code`` to decide whether to
retry, surface a user-visible message, or escalate — so the set of
valid codes is part of the public API and must not drift silently.
"""

from __future__ import annotations

import pytest

from extractor.llm.errors import LLM_ERROR_CODES, LLMProviderError


def test_error_is_exception_subclass() -> None:
    """``LLMProviderError`` must be catchable via ``except Exception``."""
    assert issubclass(LLMProviderError, Exception)


def test_error_carries_message_and_code() -> None:
    """The error exposes both a human-readable message and a classification code."""
    err = LLMProviderError("boom", code="provider_unavailable")
    assert str(err) == "boom"
    assert err.code == "provider_unavailable"


def test_error_message_accessible_via_args() -> None:
    """Standard ``Exception`` semantics — the message is in ``args[0]``."""
    err = LLMProviderError("detail", code="rate_limited")
    assert err.args == ("detail",)


def test_error_code_enumeration_is_complete() -> None:
    """Guard against accidental code removals.

    The orchestrator (P2-5/P2-6) will match on these literals; dropping
    one is a breaking change and must be deliberate.
    """
    assert set(LLM_ERROR_CODES) == {
        "provider_unavailable",
        "rate_limited",
        "invalid_request",
        "schema_mismatch",
        "auth_failure",
        "not_configured",
    }


@pytest.mark.parametrize("code", list(LLM_ERROR_CODES))
def test_error_accepts_every_documented_code(code: str) -> None:
    """Each documented code must be accepted without runtime validation error."""
    err = LLMProviderError("x", code=code)  # type: ignore[arg-type]
    # The above type: ignore is intentional: mypy sees `code` as `str`
    # coming from `parametrize`, but the dataclass field is typed as the
    # Literal union. The narrower runtime check lives in the constructor
    # usage across the codebase — this parametrized test is a belt-and-
    # suspenders check that the runtime accepts every listed code.
    assert err.code == code


def test_error_optional_cause_is_chained() -> None:
    """When raised from another exception, ``__cause__`` is preserved."""
    original = RuntimeError("network")
    try:
        try:
            raise original
        except RuntimeError as exc:
            raise LLMProviderError("wrapped", code="provider_unavailable") from exc
    except LLMProviderError as llm_err:
        assert llm_err.__cause__ is original


def test_repr_includes_code_for_debuggability() -> None:
    """Debug logs rely on ``repr()`` to show the classification code."""
    err = LLMProviderError("meh", code="schema_mismatch")
    assert "schema_mismatch" in repr(err)
