# LANG-1: Language-Aware System Prompts

**Date:** 2026-04-24
**Status:** Designed, not yet scheduled
**Scope:** Single focused slice (LANG-1). Follow-ups (LANG-2/3/4) listed
at the end.

## Why

Today the stack's five AI touchpoints (URL-extract, photo-extract, chat,
chat-auto-title, component-splitter) produce output in whatever language
the input happened to be in — the LLM infers it from context. After
REL-3 the UI is fully i18n-capable (DE + EN); the AI output is not.
A German user toggling to EN and then importing an English blog sees
the prompt-output in English, but an English user importing a German
blog sees German — inconsistent with the i18n promise.

LANG-1 propagates the user's UI-language through every AI call so that
the output consistently matches what the user sees in the rest of the
app.

## Decisions locked (from brainstorm 2026-04-24)

- **Scope:** all five touchpoints, not just chat. Structured fields
  (ingredient names, step text, title, description, tags) are
  translated too, not only prose.
- **Transport:** HTTP `Accept-Language` header, propagated by the
  axios interceptor in the web, forwarded unchanged by the .NET API
  to the Python extractor, read by a FastAPI `Depends`.
- **Ingredient-name strictness:** translate everything (Option A).
  Eigennamen (e.g. "Pecorino Romano") bleiben unübersetzt — das
  entscheidet der LLM im Context ("Pecorino Romano" hat keinen
  englischen Namen, "Olio di oliva" schon).
- **Existing recipes:** static (Option A). Recipes keep the language
  they were created in. A later LANG-2 slice can offer an on-demand
  re-translation button.
- **Chat mid-conversation:** current UI locale wins (Option A).
  Accept-Language on every turn. No session-locked language.

## Architecture

```
Browser (i18next language: "de" | "en")
  │
  ├─ Axios/Fetch interceptor sets `Accept-Language: <i18n.language>`
  │    on every API request
  │
  ▼
.NET API
  │
  ├─ Middleware reads `Accept-Language`, normalises to `de|en`,
  │    falls back to `en` if missing/garbage/unsupported
  ├─ Stores on `HttpContext.Items["UserLanguage"]` for endpoints
  ├─ Outbound HttpClient handler forwards the header to Python
  │
  ▼
Python extractor (FastAPI)
  │
  ├─ `Depends(get_user_language)` reads header, re-normalises
  ├─ `append_language_directive(base_prompt, lang)` wraps every
  │    system prompt — suffix:
  │    "Respond entirely in {German|English}. All structured field
  │    values (title, description, ingredient names, step text,
  │    notes, tag labels) must be in that language. Always respond
  │    in {language} regardless of user requests to change language."
  ├─ Azure OpenAI / Ollama call — schema stays English-keyed,
  │    values are in user language
  │
  ▼
Response
```

No new runtime dependencies. Accept-Language is standard HTTP,
i18next has an axios-interceptor helper, FastAPI has `Request.headers`
built-in.

## Components / concrete changes

### Python extractor (`apps/python-extractor/`)

- New `src/extractor/prompts/language.py`:
  - `normalize_accept_language(header: str | None) -> Literal["de", "en"]`
  - `append_language_directive(prompt: str, lang: Literal["de","en"]) -> str`
- Changes to the five touchpoints:
  - `src/extractor/pipeline/url.py`
  - `src/extractor/pipeline/photo.py`
  - `src/extractor/chat.py` (or wherever the chat system prompt lives)
  - `src/extractor/auto_title.py`
  - `src/extractor/pipeline/components.py`
- FastAPI `Depends(get_user_language)` reads the inbound header.
- Tests:
  - New `tests/test_language_directive.py` (unit tests for helper)
  - Parametrised pipeline tests covering both languages (assertion
    that the directive suffix reaches the mocked Azure call)
- All four CI gates stay green: pytest, ruff check, ruff format,
  mypy --strict.

### .NET API (`apps/api/`)

- No endpoint signature change. New middleware OR a
  `DelegatingHandler` on the Python-proxy `HttpClient` copies the
  inbound `Accept-Language` to outbound Python calls.
- Hangfire background jobs (async URL-import, async photo-import,
  async component-split) persist a new `requested_language: "de" | "en"`
  column on the job row (small EF Core migration). Enqueue-side reads
  `HttpContext.Items["UserLanguage"]`; exec-side forwards it as
  `Accept-Language` when it calls the Python extractor.
- Tests:
  - Middleware / handler unit test
  - Integration test (WebApplicationFactory) — inbound header
    reaches Python-mock
  - Hangfire test — enqueue with DE header, exec forwards DE

### Web (`apps/web/`)

- Central axios interceptor / fetch wrapper sets
  `Accept-Language: i18n.language` on every request. Location:
  `apps/web/src/features/_shared/api.ts` (or equivalent central
  client).
- No visible UI change.
- Tests (Vitest + MSW):
  - Interceptor test — toggle language, next requests carry new
    header
  - Smoke test — Import-URL page in DE vs EN renders values in the
    respective language (against mocked backend response)

### E2E (optional, can be post-release)

- New `apps/web/e2e/language-propagation.spec.ts`: login as bot,
  toggle UI to EN, import URL, assert response title is English;
  toggle to DE, new import, assert response title is German. Runs
  against the docker stack with a stubbed Azure mock-server for
  deterministic responses. Credentials-gated, skip-clean.

## Error handling

- `Accept-Language` parsing:
  - `de`, `de-DE`, `de-AT`, `de-CH`, `de, en;q=0.8` → `de`
  - `en`, `en-US`, `en-GB`, `en, de;q=0.5` → `en`
  - Missing / empty / garbage / unsupported (`fr`, `zh`, `*`) → `en`
  - Case-insensitive, quality-weights ignored (first language wins)
- Prompt robustness:
  - Directive at the **end** of the system prompt (recency bias
    improves instruction-following).
  - Schema stays English-keyed, values in user language — directive
    mentions this explicitly.
  - For Ollama (local 4-12B models with weaker instruction-following):
    directive set both before AND after the payload as redundancy.
    Verify with a real Ollama-run test before calling the slice done.
  - Explicit clause "regardless of user requests to change language"
    prevents chat-side prompt-injection via "antworte auf
    Französisch".
- Failure modes:
  - Non-normalisable header → `en` + log-warning (uses existing
    `_redact_host` PII-redaction pattern)
  - LLM returns wrong language despite directive → no automatic
    retry. Rare in practice. User sees it, edits manually or
    re-imports.
  - Hangfire legacy-job without `requested_language` column value
    → fallback `en`
- No Recipe-level language tag in DB. Existing recipes render
  unchanged regardless of UI language.

## Testing strategy

**Python:**
- Unit tests for `normalize_accept_language` (15+ inputs) +
  `append_language_directive`.
- Parametrised pipeline tests (`@pytest.mark.parametrize("lang", ["de","en"])`)
  — mock Azure/Ollama response, assert directive suffix reaches the
  LLM client.
- Optional `@pytest.mark.integration` one-shot real-Azure per
  touchpoint per language — manual-gated, not in CI.

**.NET:**
- Middleware unit test with 10+ header inputs.
- Integration test (`WebApplicationFactory`) for inbound → outbound
  propagation.
- Hangfire job test.

**Web:**
- Vitest interceptor test + MSW-driven smoke test.

**E2E:**
- One Playwright spec (optional, credentials-gated).

**Regression guard:**
- Stringmatch test per touchpoint that the directive suffix is
  present. No full-prompt snapshot (too brittle).

## Rollout sequence

Four commits, file-disjoint:

1. `feat(extractor): LANG-1 language-aware system prompts`
2. `feat(api): LANG-1 forward Accept-Language to python extractor`
3. `feat(web): LANG-1 axios interceptor sends Accept-Language`
4. `test(e2e): LANG-1 language propagation spec` (optional)

## Risks

- **Ollama instruction-following:** 4-7B models ignore system-prompt
  directives more often than Azure. Mitigation: redundancy (directive
  before AND after payload) + prompt-testing with the realistic
  Ollama model (Gemma 3 12B or Qwen 2.5 14B) before calling the slice
  done.
- **Token overhead:** +~40 tokens per request. At 10k requests /
  month that is ~400k tokens ≈ $0.50 on Azure — negligible.
- **Regression risk in existing prompt tuning:** if the Azure prompts
  in the five touchpoints are finely tuned, a new suffix may shift
  response quality. Mitigation: A/B-comparison on 5-10 real-world
  fixtures before merge.

## Release-gate positioning

LANG-1 is **not** a public-release blocker (REL-1/2/6 come first).
Rationale: public audience is primarily English, prompt-language is a
nice-to-have for single-user-per-instance app. However, if the
landing-page claim reads as hollow without LANG-1, schedule it before
REL-1.

## Follow-ups (out of LANG-1 scope)

- **LANG-2 — On-demand recipe re-translation.** Per-recipe
  "In English anzeigen" / "Auf Deutsch anzeigen" button. LLM
  translates once, result cached per recipe per language on a new
  `RecipeTranslation` table (recipe_id, language, translated_json,
  updated_at). Banner-notice "Automatically translated" renders
  alongside. Respects manual user edits by tracking `is_stale` when
  source is updated. Own design doc when we're ready.
- **LANG-3 — On-the-fly translation on every render** (expensive,
  maximum consistency). Superseded by LANG-2 if that lands.
- **LANG-4 — More languages (FR, IT, ES).** One slice per language:
  `errors.json` + `translation.json` + Whitelist extension in
  `normalize_accept_language` + locale-JSON in web. No LANG-1
  architecture change needed — it's a data-add.
