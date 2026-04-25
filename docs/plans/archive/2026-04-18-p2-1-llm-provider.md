# P2-1 — LLM Provider Abstraction (Azure OpenAI + Mock)

**Slice:** P2-1
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-0 (Python scaffold).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

Everything Phase 2 does with language models routes through one interface. Defining it first gives P2-2/P2-3/P2-4 a stable contract, lets tests use a mock provider (no real Azure calls in CI), and keeps the door open for swapping providers (OpenAI direct, Gemini) via config.

## Scope

### 1. Provider interface

File: `apps/python-extractor/src/extractor/llm/provider.py`

```python
from abc import ABC, abstractmethod
from typing import Any, Sequence

class ChatMessage(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str

class VisionInput(TypedDict):
    image_url: str       # signed URL or data: URL
    detail: Literal["low", "high", "auto"]

class LLMProvider(ABC):
    @abstractmethod
    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        """Structured extraction with JSON schema enforcement.
        Returns parsed JSON matching `json_schema`. Raises
        LLMProviderError on failure or schema-mismatch."""

    @abstractmethod
    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> str:
        """Plain conversational turn. Returns the assistant's reply."""

    @abstractmethod
    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        """Vision-LLM extraction from ordered image inputs. Returns
        parsed JSON. Used by P2-3 photo-recipe path."""
```

### 2. Errors

`apps/python-extractor/src/extractor/llm/errors.py`:

```python
class LLMProviderError(Exception):
    """Base class for provider failures the orchestrator can react to."""
    # Carries an optional `code` for error classification:
    # - "provider_unavailable"  → Azure 5xx / network / timeout
    # - "rate_limited"          → 429 with Retry-After
    # - "invalid_request"       → 400 from Azure (schema / content filter)
    # - "schema_mismatch"       → response didn't match json_schema
    # - "auth_failure"          → 401 from Azure (bad key)
```

Hard-fail behaviour for Azure outages (per Phase 2 master plan decision #4) — callers surface a user-visible German message, no local fallback model.

### 3. Azure OpenAI provider

File: `apps/python-extractor/src/extractor/llm/azure_openai.py`

- Uses the **Responses API** (`POST {endpoint}/openai/responses?api-version={version}`) — user-supplied URL template.
- Auth via `api-key` header from `AZURE_OPENAI_API_KEY`.
- `extract_structured` → Responses-API request with `response_format = { type: "json_schema", json_schema: {…} }`. Uses `AZURE_OPENAI_DEPLOYMENT_STRUCTURING` as the deployment.
- `chat` → same API, plain text response. Uses `AZURE_OPENAI_DEPLOYMENT_CHAT`.
- `vision_extract` → multimodal message array with `type: "input_image"` entries. Uses `AZURE_OPENAI_DEPLOYMENT_STRUCTURING` (or allow override via kwarg).
- HTTP client: `httpx.AsyncClient` with timeout 120s (long-running LLM calls need headroom).
- Retries: `tenacity` with exponential backoff, 3 attempts, only for `LLMProviderError(code="provider_unavailable" | "rate_limited")`. Never retry `invalid_request` / `auth_failure`.

### 4. Mock provider

File: `apps/python-extractor/src/extractor/llm/mock.py`

```python
class MockLLMProvider(LLMProvider):
    def __init__(self, scripted: dict[str, Any] | None = None) -> None:
        self._scripted = scripted or {}
    # Returns canned responses keyed on a stable hash of the input
    # messages. Tests set `scripted` to pin specific replies.
```

Used by every downstream sub-slice's tests so no real Azure call goes out in CI.

### 5. Provider factory

File: `apps/python-extractor/src/extractor/llm/__init__.py`

```python
def build_provider(settings: Settings) -> LLMProvider:
    """Pick the provider based on config. Only AzureOpenAIProvider today;
    adding OpenAI-direct or Gemini is a config-only swap."""
```

If `AZURE_OPENAI_API_KEY == ""` → return a `NullProvider` that raises `LLMProviderError(code="not_configured")` on any call. Prevents misconfiguration silently succeeding.

### 6. Integration smoke test (skipped by default)

`tests/test_azure_integration.py`:

```python
@pytest.mark.skipif(
    os.getenv("AZURE_OPENAI_INTEGRATION") != "1",
    reason="live Azure call; enable with AZURE_OPENAI_INTEGRATION=1",
)
async def test_chat_round_trip() -> None:
    ...
```

Runs a single `chat` call and asserts a non-empty response. Always skipped in CI; used for manual smoke when real Azure keys are present.

### 7. Unit tests (mock-only, always-on)

`tests/test_azure_provider.py`:
- `extract_structured` sends the right headers + body shape (MSW-style HTTP mocking via `respx` or `httpx-mock`).
- `chat` sends the right deployment + returns text.
- `vision_extract` serialises images correctly.
- 429 with `Retry-After` triggers retry.
- 500 triggers retry.
- 400 surfaces as `invalid_request` without retry.
- 401 surfaces as `auth_failure` without retry.
- Response missing JSON surfaces as `schema_mismatch`.

`tests/test_mock_provider.py`:
- Scripted responses match.
- Unmapped keys raise `LLMProviderError(code="not_configured")`.

`tests/test_factory.py`:
- Empty API key → `NullProvider`.
- Populated key → `AzureOpenAIProvider`.

## Non-goals

- No prompt library (prompts live in P2-2/P2-3/P2-4 where they're used).
- No streaming responses (v1.1 polish).
- No OpenAI-direct or Gemini provider implementations yet (architecture supports, not built).
- No token-usage accounting (P2-10 might extend).

## Acceptance criteria

- `pytest apps/python-extractor/tests -v` green, including new LLM tests.
- `ruff check` / `ruff format --check` / `mypy --strict` all green.
- Docker image still builds under 300 MB (no new heavyweight deps — just `httpx`, `tenacity`, maybe `respx` dev-only).
- Existing web (548) / .NET (474) / shared (32) tests stay green.

## Anti-shortcut reminders

- Every retry scenario has a test (429, 500, network timeout). Do not omit one.
- `mypy --strict`: no untyped dicts escaping the interface boundary. Use `TypedDict` for message shapes.
- Do not log API keys — ever.
- Do not log raw LLM responses that may contain user data at `INFO` level. Use `DEBUG` and redact if necessary.
- Integration test is skipped in CI by default; do NOT commit code that makes it run unconditionally.
- Mock provider must match the interface exactly — no extra public methods that real provider doesn't expose (would encourage test-only APIs).

## Dispatch notes

**Impl agent:**
- Read plan + P2-0 scaffold before starting.
- Work order: interface + errors → mock provider + test → Azure provider + tests → factory + test → integration smoke (skipped by default).
- Add `httpx` + `tenacity` to runtime deps, `respx` to dev deps.
- Run gates from `apps/python-extractor`: `pytest -v`, `ruff check .`, `ruff format --check .`, `mypy --strict src tests`.
- Sanity-run the other suites once at the end.

**Reviewer:**
- Confirm no real Azure call in the always-on test suite.
- Confirm retry policy matches plan (which codes retry, which don't).
- Confirm `mypy --strict` clean.
- Read for API-key leak risk in logs.
