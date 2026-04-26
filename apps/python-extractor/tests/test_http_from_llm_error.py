"""Tests for the ``_http_from_llm_error`` mapping in ``extractor.main``.

The function maps an :class:`LLMProviderError`'s ``code`` field to an
``HTTPException`` that the FastAPI endpoints raise. The mapping is
user-facing surface: the resulting ``detail`` string lands on
``RecipeImport.ErrorMessage`` via the .NET ``PythonExtractorRunner``
and is what the React layer renders. Codes documented in
:mod:`extractor.llm.errors` should each have an explicit branch so a
fresh code doesn't silently fall through to the generic 500.
"""

from __future__ import annotations

from extractor.llm.errors import LLMProviderError
from extractor.main import _http_from_llm_error


def test_truncated_response_maps_to_422_with_actionable_german_copy() -> None:
    """``truncated_response`` is a user-actionable failure, not a 500.

    The Azure Responses API returns ``status: incomplete`` with
    ``incomplete_details.reason: max_output_tokens`` when the model
    runs out of output budget mid-string. The resulting partial body
    is JSON-broken; falling through to the generic 500 + "Interner
    Fehler bei der KI-Verarbeitung" copy hides the real cause from
    the user.

    Wire contract: 422 status (not retryable, user-input-shaped) plus
    a German message that
    (a) starts with the ``truncated_response:`` code prefix so the FE
    can substring-match on the wire and substitute a friendlier copy
    on legacy server payloads, and
    (b) tells the user what to do — try a shorter source or a direct
    recipe URL.
    """
    exc = LLMProviderError("Azure capped output at max_output_tokens", code="truncated_response")
    http = _http_from_llm_error(exc)
    assert http.status_code == 422
    detail = str(http.detail)
    # Code prefix is part of the wire contract — the FE keys off it.
    assert detail.startswith("truncated_response:")
    # User-actionable German copy.
    assert "zu lang" in detail.lower()
    assert "kürzere quelle" in detail.lower() or "direkte rezept" in detail.lower()
