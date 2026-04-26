"""Error type surfaced by every ``LLMProvider`` implementation.

A single exception class with a discriminator ``code`` field keeps
caller code simple (one ``except`` clause) while still letting the
orchestrator branch on the classification:

- ``provider_unavailable`` — Azure 5xx / network / timeout; eligible for retry.
- ``rate_limited``         — 429 with ``Retry-After``; eligible for retry.
- ``invalid_request``      — 400 from Azure (schema / content filter); do NOT retry.
- ``schema_mismatch``      — response didn't match ``json_schema``; do NOT retry.
- ``auth_failure``         — 401 from Azure (bad key); do NOT retry.
- ``not_configured``       — provider was asked to run without credentials.
- ``ai_disabled``          — REL-7: operator-set ``LLM_PROVIDER=disabled``.
  Distinct from ``not_configured`` so the caller can map it to a 503 with
  a user-visible "läuft ohne AI" message instead of a 500 "misconfigured".
- ``truncated_response``   — Azure returned 200 with ``status: "incomplete"``
  and ``incomplete_details.reason: "max_output_tokens"``. The body's
  ``output_text`` is a partial string that almost always fails JSON parsing.
  Distinct from ``schema_mismatch`` so the operator log reads the actual
  cause (cap too low) instead of "bad JSON". Do NOT retry — the next
  attempt with the same cap will truncate at the same spot. Bumping
  ``llm.structured.max_completion_tokens`` is the operator action.

The set of codes is part of the public API; adding / removing one is a
breaking change. ``LLM_ERROR_CODES`` + the ``LLMErrorCode`` literal keep
this enforceable at both runtime and type-check time.
"""

from __future__ import annotations

from typing import Final, Literal, get_args

LLMErrorCode = Literal[
    "provider_unavailable",
    "rate_limited",
    "invalid_request",
    "schema_mismatch",
    "auth_failure",
    "not_configured",
    "ai_disabled",
    "truncated_response",
]

# Runtime-accessible tuple of every valid code. Tests pin this to catch
# drift; downstream code can iterate it when mapping HTTP status → code.
LLM_ERROR_CODES: Final[tuple[LLMErrorCode, ...]] = get_args(LLMErrorCode)


class LLMProviderError(Exception):
    """Raised by any ``LLMProvider`` implementation on failure.

    The ``code`` attribute drives orchestrator behaviour:
    retryable vs. terminal, user-visible vs. admin-only, etc.
    See module docstring for the documented code set.
    """

    def __init__(self, message: str, *, code: LLMErrorCode) -> None:
        super().__init__(message)
        self.code: LLMErrorCode = code

    def __repr__(self) -> str:
        # Explicit repr so log lines (``logger.exception(exc)``) show the
        # classification code, not just the message. Without this the
        # default ``Exception.__repr__`` omits the ``code`` attribute.
        return f"LLMProviderError(code={self.code!r}, message={self.args[0]!r})"
