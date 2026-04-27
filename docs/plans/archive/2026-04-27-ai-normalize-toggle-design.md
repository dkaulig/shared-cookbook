# AI-Normalize Toggle for Blog Imports — Design

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan slice-by-slice with the 4-stage review flow per CLAUDE.md.

**Goal:** Give the user an opt-in per-import toggle that runs schema.org/Recipe JSON-LD through the LLM for translation + quantity normalisation, instead of the existing REL-8 direct-mapping path. Same toggle on the Reimport dialog.

**Architecture:** A new `force_llm: bool` flag flows from the web form through the .NET API DTO into the Python extractor's `extract_from_url`. When `force_llm=True`, the REL-8 JSON-LD pre-LLM branch is skipped — `blog_text` (already produced by `_format_jsonld_for_prompt`) is fed to the existing structured-extraction LLM call with a strict-normalize prompt. JSON-LD remains source-of-truth: the prompt forbids inventing ingredients or steps. Soft fallback to the JSON-LD-direct result on any LLM failure, plus a user-visible note.

**Tech Stack:** Python 3.13 + FastAPI (extractor), .NET 10 ASP.NET Core (api), React 19 + Vite + Tailwind + shadcn/ui (web), pytest, xunit, vitest, Playwright.

---

## Context

User reported (2026-04-27) that the import from `https://pinchofyum.com/saucy-gochujang-noodles-with-chicken` produced duplicated ingredient text — root cause was the `note` field carrying the raw imperial string while `_translate_unit` rewrote `quantity`/`unit` to metric. Fixed in commit `bcebc99` (drop the audit-trail note). During brainstorming the user asked: "are blog recipes not normalised/translated through AI?" The answer: at REL-8 they bypass the LLM entirely when JSON-LD is valid. This plan adds an explicit per-import opt-in to route JSON-LD-blogs through the LLM for the cases where the user wants German output for an English blog.

## Decisions locked during brainstorming

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Per-import toggle (not global, not auto-detect) | User knows when they paste an English blog URL |
| 2 | Default off | DE-blogs (Chefkoch etc.) don't need it; opt-in for token cost |
| 3 | Strict normalize (LLM may not invent ingredients/steps) | JSON-LD = source of truth; prevents hallucination |
| 4 | Soft fallback on LLM error → JSON-LD-direct + note | Successful import beats hard-fail |
| 5 | Toggle present in URL-import dialog AND reimport dialog | Reimport with different toggle is the recovery UX |
| 6 | Persistence: `ai_normalize_active` flag on `ConfigSnapshot` | Audit trail; no separate raw-blog-text store |
| 7 | Toggle disabled when `llm.provider = none` | Honest UX over silent no-op |

## Architecture

### Data flow

```
[Web URL form]                                    [Reimport dialog]
       │                                                │
       │  POST /imports                                 │  POST /imports/{id}/reimport
       │  { url, aiNormalize: bool }                    │  { aiNormalize: bool }
       ▼                                                ▼
[.NET API: ImportFromUrlRequest / ReimportRequest]
       │
       │  POST extract/url
       │  { url, force_llm: bool, lang: "de" }
       ▼
[Python: extract_from_url(force_llm=...)]
       │
       ├── force_llm=False → existing path (REL-8 direct when JSON-LD valid)
       │
       └── force_llm=True
              │
              ├── _run_blog_path() → blog_text (from JSON-LD via _format_jsonld_for_prompt)
              │
              ├── _run_llm_structuring(blog_text, system_prompt=NORMALIZE_ONLY_PROMPT, lang=lang)
              │
              ├── on LLMProviderError / schema violation:
              │      ├── notes.append("KI-Verfeinerung fehlgeschlagen — Originaldaten verwendet")
              │      └── fall through to extract_recipe_from_html(html)  # JSON-LD direct
              │
              └── post_process(...) with config_snapshot.ai_normalize_active=True
```

### LLM prompt — strict normalize variant

New CFG-1 key `llm.structured.system_prompt_normalize_only`. Default value (German):

> "Du erhältst eine bereits-strukturierte Rezept-Quelle aus einem Blog (schema.org/Recipe JSON-LD), gerendert als deutscher Klartext. Übersetze sie in die Zielsprache und normalisiere Mengen (Imperial → Metric, Bereiche wie '1-2 cups' als '240–480 ml'). KEINE Zutaten oder Schritte erfinden. Jede Output-Zutat muss eine Entsprechung im Input haben. Bei qualitativen Hinweisen ('salt to taste', 'freshly ground pepper') das Original sinngemäß erhalten, ohne Mengen zu schätzen. Reihenfolge der Zutaten und Schritte bleibt erhalten."

Wrapped through `apply_language_directive(lang)` like the existing `system_prompt`.

### Persistence

`ConfigSnapshot` (`apps/python-extractor/src/extractor/pipeline/types.py`) gains `ai_normalize_active: bool`. Threads through `_build_config_snapshot()` → `post_process()` → DB import-snapshot column. The .NET side reads it back for the Reimport-dialog default.

No additional storage of raw blog text — the URL is the source-of-truth, reimport reproduces it.

### Frontend UX

URL form (`apps/web/src/components/imports/ImportRecipeUrlDialog.tsx`) and reimport dialog gain a single Checkbox:

```
☐ Mit AI verfeinern (für englische Blogs)
   └─ Tooltip: "Übersetzt das Rezept und normalisiert Mengen.
      Kostet AI-Tokens und dauert ~10 s länger."
```

Provider availability: read from existing `GET /admin/extractor-config` (or whatever surface exposes `llm.provider`). When `llm.provider = none` the checkbox is `disabled` with a tooltip *"Nicht verfügbar — kein AI-Provider konfiguriert."*

Reimport dialog pre-fills from the current import's `ai_normalize_active`.

---

## Implementation slices

Each slice is one PR-shaped chunk. Per CLAUDE.md every non-trivial slice runs the 4-stage flow (impl TDD → /simplify → /security → fix-commit → reviewer self-pass).

### Slice 1 — Python extractor: `force_llm` parameter & strict-normalize prompt

**Files:**
- Modify: `apps/python-extractor/src/extractor/main.py` — `ExtractRequest` body schema gets `force_llm: bool = False`; pass through to `extract_from_url`.
- Modify: `apps/python-extractor/src/extractor/pipeline/url.py:564-907` — `extract_from_url(..., force_llm: bool = False)`. When `force_llm=True` AND `kind == "blog"`, skip the `if jsonld_llm_output is not None:` early-return at line 793 and fall through to the LLM-call block. The `blog_text` already contains the labelled JSON-LD render from `_format_jsonld_for_prompt`.
- Modify: `apps/python-extractor/src/extractor/prompts/recipe_extraction.py` — add `SYSTEM_PROMPT_DE_NORMALIZE_ONLY` constant (the German-text from "LLM prompt — strict normalize variant" above).
- Modify: `apps/python-extractor/src/extractor/pipeline/url.py` — when `force_llm=True`, resolve the prompt via `await get_str(config, "llm.structured.system_prompt_normalize_only", SYSTEM_PROMPT_DE_NORMALIZE_ONLY)` instead of the regular `system_prompt`.
- Modify: `apps/python-extractor/src/extractor/pipeline/types.py` — `ConfigSnapshot` TypedDict gains `ai_normalize_active: bool`.
- Modify: `apps/python-extractor/src/extractor/pipeline/url.py::_build_config_snapshot` — accept + emit the new flag.
- Test: `apps/python-extractor/tests/test_url_pipeline.py` (or co-located) — three new tests:
  1. `force_llm=True` + JSON-LD blog → REL-8 branch is skipped, MockLLMProvider receives a request with `blog_text` containing the JSON-LD-rendered text, returned recipe has `config_snapshot.ai_normalize_active is True`.
  2. `force_llm=True` + LLM raises `LLMProviderError` → result equals what `extract_recipe_from_html(html)` would produce, AND `notes` contains `"KI-Verfeinerung fehlgeschlagen — Originaldaten verwendet"`.
  3. `force_llm=False` (default) → existing REL-8 path unchanged (regression guard).

**Soft-fallback wiring.** Wrap `_run_llm_structuring(...)` in try/except inside `extract_from_url`. On `LLMProviderError` (and `JSONDecodeError` from schema violation):
- log at WARNING with `host=`, `err=type-name-only` (no URL body)
- append note
- compute the JSON-LD-direct result via `extract_recipe_from_html(html)` and feed it into `post_process` with `config_snapshot.ai_normalize_active=True` so audit shows the user *requested* normalisation even when it fell back

**Acceptance:** four-gate locally (pytest, ruff check, ruff format --check, mypy --strict src tests) all green.

**Out-of-scope:** No changes to `_translate_unit` (BUG-030 stays as the second-stage safety net even on the LLM path).

### Slice 2 — .NET API: DTO + extractor-call passthrough

**Files:**
- Modify: `apps/api/src/FamilienKochbuch.Application/Imports/Commands/ImportFromUrl/ImportFromUrlCommand.cs` (or equivalent) — add `bool AiNormalize { get; init; } = false;`.
- Modify: the corresponding Reimport command analogously.
- Modify: the HTTP layer that posts to `extract/url` — include `force_llm: bool` in the body.
- Modify: the import-snapshot persistence path — store `ai_normalize_active` from the extractor's `config_snapshot` on the DB import row.
- Test: existing xunit suite — DTO roundtrip test + a handler test that verifies `force_llm` lands in the outbound HTTP body.

**Acceptance:** `dotnet test apps/api/SharedCookbook.sln` green.

**Out-of-scope:** No DB schema migration if the existing `config_snapshot` column is JSON; if it's typed columns, a migration is needed and lands here as part of this slice.

### Slice 3 — Web: checkbox + provider-disabled state

**Files:**
- Modify: `apps/web/src/components/imports/ImportRecipeUrlDialog.tsx` (or whatever the URL-import form is named — Explore agent should verify the path) — add `<Checkbox>` with German label + tooltip; bind to local form state; include in submit body as `aiNormalize`.
- Modify: corresponding `ReimportDialog` component — same checkbox; pre-fill from the existing recipe's `aiNormalizeActive` snapshot.
- Modify: shared DTO in `packages/shared` — `ImportFromUrlRequest` and `ReimportRequest` types gain `aiNormalize: boolean`.
- Provider-availability gate: read from existing config-loader hook (Explore should locate); if `llm.provider === "none"` → `disabled` + tooltip variant.
- Test: vitest unit on the dialog — checkbox toggles, disabled-state when provider unset, submit body shape.

**Acceptance:** `pnpm --filter web run test`, `pnpm --filter web run lint`, `pnpm --filter web run build` all green. Visual sanity check in the dev stack on `http://localhost`.

### Slice 4 — Playwright E2E

**Files:**
- Create: `apps/web/e2e/url-import-ai-normalize.spec.ts`.
- Test scenarios:
  1. URL form open, checkbox visible + unchecked by default, tooltip text matches.
  2. (Optional, gated on `AZURE_OPENAI_API_KEY` env): paste pinchofyum URL, check the box, submit, wait for import to complete, navigate to recipe, assert at least one ingredient name is German (`/Hähnchenhackfleisch|Knoblauch|Sojasauce/`) AND `note` field contains no English residue.
  3. Same URL with checkbox unchecked → English ingredient name → `note` field is null (regression guard for `bcebc99`).
- Skip-cleanly when env unset (`test.skip(!process.env.AZURE_OPENAI_API_KEY, "azure key missing")`).

**Acceptance:** spec runs locally via `PLAYWRIGHT_TEST_EMAIL=orchestrator@example.com PLAYWRIGHT_TEST_PASSWORD=<...> pnpm --filter web exec playwright test --config=playwright.docker.config.ts e2e/url-import-ai-normalize.spec.ts`.

---

## Slice ordering & parallelism

Slices 1 → 2 → 3 are sequential (each depends on the previous wire format). Slice 4 depends on all three. No parallelism within this plan.

## Risk register

| Risk | Mitigation |
|------|-----------|
| LLM hallucinates an extra ingredient despite the prompt | Strict-normalize prompt is explicit; soft-fallback if schema violation; `_translate_unit` still runs |
| Token cost surprises user | Tooltip mentions "kostet AI-Tokens"; default off; reimport-toggle lets user revert without re-typing URL |
| Provider=none case not gated → 503 at import time | Frontend checkbox disabled; backend still soft-fallback if it slips through |
| `llm.structured.system_prompt_normalize_only` config key missing on cold-boot | Hardcoded Python constant `SYSTEM_PROMPT_DE_NORMALIZE_ONLY` is the fallback, same pattern as the existing `SYSTEM_PROMPT_DE` |

## Out of scope (explicit)

- No new DB table for raw-blog-text history.
- No side-by-side compare UI.
- No global "always use AI" setting.
- No auto-detection of blog language.
- No translation between non-DE/EN pairs (uses existing `lang` param, which today is DE-only at the UI surface).

## Done definition

- All four slices shipped on `main` with tests green and CI parity (pytest, ruff, mypy --strict, dotnet test, pnpm test/lint/build).
- A real import of the pinchofyum URL with the toggle ON produces German ingredient names + metric quantities.
- A real import of the same URL with the toggle OFF produces the today-shape (English names, metric quantities via `_translate_unit`, no `note` duplication).
- This design-doc is moved to `docs/plans/archive/` once Slice 4 ships (per CLAUDE.md doc-housekeeping rule).
