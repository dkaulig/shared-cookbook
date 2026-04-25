# LANG-2: On-Demand Recipe Re-Translation

**Date:** 2026-04-25
**Status:** Designed, not yet scheduled
**Scope:** Single focused slice (LANG-2). Builds on LANG-1 + LANG-1b
(`docs/plans/2026-04-24-lang-aware-system-prompts-design.md`).

## Why

LANG-1 made new AI-extracted recipes follow the user's UI language at
import time. Existing recipes (created before LANG-1, or imported in
a different UI language) stay in whatever language they were created
in. A user with 40 German recipes who toggles to EN sees German
content. LANG-2 closes that gap with a per-recipe, user-triggered
re-translation that caches the result so repeat-views are free.

## Decisions locked (from brainstorm 2026-04-25)

- **Trigger:** per-recipe button on the detail page (Q1-A). No
  auto-translate, no global setting in the first iteration.
- **Display:** in-place swap with toggle button + small
  "automatically translated" hint banner (Q2-A). No side-by-side, no
  tab UI.
- **Storage:** new `RecipeTranslation` table — separate row per
  (recipe, language) with the full translated payload as JSONB
  (Q3-A). Source-of-truth stays `Recipe`.
- **Stale invalidation:** any edit to the source recipe flips the
  translation's `IsStale = true` (Q4-A). User decides if/when to
  refresh. Granular per-field tracking is YAGNI.
- **Export / Cook-Now / Print / Share:** view-respecting (Q5-B). What
  the user sees in the detail page is what gets exported. URL-share
  is naturally language-neutral (recipient resolves via
  Accept-Language).
- **Cost gating:** no rate limit (Q6-A). Trust the user. Single-family
  app, low abuse risk. Admin-toggle can be added later if Azure-bill
  surprises.
- **Source-language tracking:** new `Recipe.SourceLanguage` column,
  `'de'` backfill for existing rows (Q7-A). The translate button
  appears only when `Recipe.SourceLanguage !== UI-Language`.

## Architecture

```
User klickt "Auf Englisch anzeigen" auf RecipeDetailPage
  │
  ▼ Frontend
  POST /api/recipes/{id}/translate?lang=en
  │
  ▼ .NET API
  1. Lade Recipe + check SourceLanguage
  2. Wenn lang == SourceLanguage: 400 already_in_language
  3. Wenn RecipeTranslation existiert + !IsStale: return cached
  4. Sonst:
     a. Build LLM-prompt aus Recipe (übersetzbare Felder)
     b. Azure-Call (existing IAzureOpenAIChatClient) mit structured-output
     c. Persist → RecipeTranslation upsert, IsStale = false
     d. Return TranslatedPayload + isStale flag
  │
  ▼ Frontend
  Replace view-state mit TranslatedPayload
  Render TranslationBanner + Toggle "Original anzeigen"
  Cook-Now / PDF / Print / Share lesen den aktiven view-state
```

**Schema:**

```sql
ALTER TABLE Recipes
  ADD SourceLanguage VARCHAR(2) NOT NULL DEFAULT 'de';
-- Backfill: 'de' für alle existing Rows.

CREATE TABLE RecipeTranslations (
    Id UUID PRIMARY KEY,
    RecipeId UUID NOT NULL FK Recipes.Id ON DELETE CASCADE,
    Language VARCHAR(2) NOT NULL,
    TranslatedPayload JSONB NOT NULL,
    UpdatedAt TIMESTAMPTZ NOT NULL,
    IsStale BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (RecipeId, Language)
);
CREATE INDEX ON RecipeTranslations (RecipeId);
```

The translation runs **directly in .NET** via the existing
`IAzureOpenAIChatClient` — no Python-extractor proxy hop. Reason:
the input is already structured (`Recipe` entity), the LLM call is
self-contained, and we keep the round-trip short.

## Components / concrete changes

### Backend (`apps/api/`)

**Domain:**
- `Recipe.cs` — new `SourceLanguage` property + factory/method
  signatures updated to require it on create.
- `RecipeTranslation.cs` — new entity with `MarkStale()` and
  `Refresh(payload)` methods + invariants.
- New `RecipeUpdated` domain event OR direct service-call from each
  Recipe-Update-Endpoint to `MarkTranslationsStale(recipeId)` —
  decided in the verification audit (Sektion below) based on what
  the codebase already does.

**Migrations:**
- `AddRecipeSourceLanguage` — `DEFAULT 'de'` for existing rows.
- `AddRecipeTranslationsTable` — schema as above.

**Services:**
- `RecipeTranslationService.TranslateAsync(recipeId, targetLang, force)` —
  cache-lookup, LLM-call when needed, persist, return.
- `RecipeTranslationPrompt.Build(recipe, targetLang)` — produces the
  translation system-prompt with schema-hint and source-recipe-JSON.
  Reuses `LanguageNormalizer.TargetName` for the directive wording
  (consistency with LANG-1b).

**Endpoints:**
- `POST /api/recipes/{id}/translate?lang=de|en&force=true|false` with
  `[Authorize]` + group-membership gate. Response: `TranslatedPayload`
  DTO + `isStale` flag + `cacheHit` indicator.
- New `ErrorCodes.AlreadyInLanguage = "already_in_language"`.

**Stale-cascade:**
- Every existing Recipe-update-endpoint (title / description /
  ingredients / steps / tags / servings / notes …) triggers
  `MarkTranslationsStale(recipeId)` in the same transaction.
- Photo-updates do NOT trigger stale (photos aren't translated).

### Frontend (`apps/web/`)

**RecipeDetailPage:**
- New translate button in the header, visible only when
  `recipe.sourceLanguage !== i18n.language`.
- Local `viewState: 'original' | 'translated'`. Translate-click runs
  the mutation and switches state on success.
- Cook-Now / PDF / Print / Share read from active `viewState` and
  pass the corresponding payload (original or translated) to the
  consuming component.

**Components:**
- New `<TranslationBanner />` — "Automatisch übersetzt aus dem
  Deutschen" + optional stale hint "Übersetzung könnte veraltet
  sein, [Aktualisieren]" + "Original anzeigen" link.
- New `useTranslateRecipe` hook (TanStack-Query useMutation).
  Cache-key `['translation', recipeId, lang]`.

**i18n:**
- New keys in `recipes.translation.*` namespace (de + en).

**Tests:**
- Vitest for the hook + banner + toggle behaviour. MSW-mocked API.
- Existing recipe-detail tests must stay green.

### Untouched

Recipe-list view, photo-upload flow, import pipelines, chat. List
keeps the original title — no list-level translation in this slice.

## Error handling

- **400 `already_in_language`** when `targetLang === SourceLanguage`.
  Frontend hides the button, backend defends.
- **404 `recipe_not_found`** — existing code path.
- **403 `forbidden`** — group-membership gate.
- **503 `ai_service_unavailable`** — Azure timeout / outage. Toast
  "Übersetzung gerade nicht möglich, bitte später erneut versuchen."
- **503 `ai_disabled`** — REL-7 AI-off profile. Frontend hides the
  translate button via `useFeatures().ai.enabled`.

**Frontend edge cases:**
- Re-click while translate is in-flight: idempotent via TanStack-
  Query dedup.
- UI-language toggle mid-translation: in-flight call completes for
  the original target language and lands in cache. New target
  language requires a fresh click.
- Concurrent edit (other tab) while translate runs: edit's
  transaction sets `IsStale=true`; translate's transaction lands
  the payload. Result = stale-flagged translation, banner appears
  on next render. No data loss.
- Cache-hit on stale translation: backend returns cached payload +
  `isStale: true`. Frontend renders the stale-hint inline.
- LLM JSON-parse failure: structured-output prevents this in
  practice; if it leaks through, 502 + toast.

**Backfill caveat:**
- `SourceLanguage = 'de'` for all existing rows is an assumption
  based on CLAUDE.md's "German UI throughout". If a non-DE recipe
  exists in production it will be mis-tagged and the translate
  button will hide when it should show. Not catastrophic — user
  edits manually if needed. Documented in the migration commit body.

## Testing strategy

**Backend (.NET):**
- `RecipeTranslationServiceTests` — cache-hit, stale-cache-hit,
  stale-with-force, cache-miss, same-language-rejection.
- `RecipeTranslationTests` — domain-entity invariants and
  `MarkStale()` / `Refresh()` semantics.
- Endpoint integration tests covering authorize + group-membership
  + 400/403/404 paths, plus stale-cascade verification across
  several recipe-update endpoints (title-edit, ingredient-add,
  tag-add).
- Migration tests — backfill on existing rows, defaults on new rows.
- Azure client mocked deterministically; one test per direction
  (DE→EN, EN→DE).

**Frontend (web):**
- Vitest hook + banner + toggle behaviour.
- MSW-mocked translate endpoint with deterministic payload +
  `isStale` flag.
- i18n-smoke for banner copy in DE and EN.

**E2E (optional, can drop):**
- Playwright `e2e/recipe-translation.spec.ts` — translate + edit-
  triggers-stale + refresh workflow. Credentials-gated, skip-clean.

**Regression guard:**
- No snapshot test on translated payload (LLM is non-deterministic).
- Schema-conformance and field-presence checks instead.

**Gates:** all stacks green per CLAUDE.md (`dotnet build` 0/0,
`dotnet test`, vitest, lint, build).

## Rollout sequence

Four commits, file-disjoint:

1. `feat(api): LANG-2 Recipe.SourceLanguage column + backfill`
   - Domain property + migration with `'de'` default backfill.
   - LANG-1's recipe-insert path wired to set `SourceLanguage` from
     the request's `Accept-Language` (no relying on default).
2. `feat(api): LANG-2 RecipeTranslation table + service + endpoint`
   - Migration, domain entity, service, prompt builder, endpoint.
   - Stale-cascade in all recipe-update endpoints.
   - New `ErrorCodes.AlreadyInLanguage`.
3. `feat(web): LANG-2 useTranslateRecipe hook + TranslationBanner`
   - Hook + banner + i18n keys.
   - `RecipeDetailPage` toggle + view-state plumbing for
     Cook-Now / PDF / Print / Share.
4. `test(e2e): LANG-2 recipe translation spec` (optional)

## Verification step (mandatory before ship verdict)

LANG-1 had a scope-error: the design assumed all five AI touchpoints
lived in Python, but two (chat-turn + auto-title) were in .NET.
LANG-2 must verify its assumptions against the real codebase before
the implementing sub-agent claims `ship`.

The sub-agent must answer the following in a checklist (with
`file:line` references) inside the Commit-2 body and the
return-summary:

1. **Recipe-insert-path audit.** Where is `Recipe` created today?
   (`rg 'new Recipe\(|Recipes\.Add' apps/api/src`). For each insert
   site: is `SourceLanguage` set explicitly? If not, does the
   migration default `'de'` actually apply? Verify with a read-after-
   insert test.

2. **Recipe-update-path audit.** Where is `Recipe` mutated? List
   every update-endpoint and verify each calls
   `MarkTranslationsStale(recipeId)` in the same transaction. A
   missed update path is a real bug.

3. **Azure-client reuse check.** Is the existing
   `IAzureOpenAIChatClient` usable for the translation call, or does
   a wrapper / new client need to be introduced? No assumption —
   read the actual interface and its existing call-sites.

4. **Domain-event existence check.** Does a `RecipeUpdated` domain
   event already exist? If yes, hook the stale-cascade onto it. If
   no, direct service calls from each update endpoint. Decide based
   on the codebase, don't invent infrastructure.

5. **Recipe-shape audit.** What fields does `Recipe` have today?
   (`rg 'public.* Recipe' apps/api/src/FamilienKochbuch.Domain`).
   Are the assumed translatable fields (title, description,
   ingredients, steps, notes, tags) the right list? Are there
   nested components (REL-COMP-2-slice — if recipes have
   sub-components / sub-recipes, the translation prompt must
   include them)?

6. **Cook-Now / PDF / Print / Share lifecycle.** How do they get
   the recipe today? If they fetch on their own (instead of
   receiving a prop), the view-respecting promise needs frontend
   state-passing rework. Don't assume — read the components.

The sub-agent treats any of those that turn up surprising findings
as in-scope for LANG-2: either fix in the same slice or document a
scoped follow-up before claiming ship.

## Risks

- **Components / sub-recipes:** REL-COMP-2 introduced
  recipe-components. If recipes contain nested ingredient/step lists
  per component, the translation prompt has to handle the nested
  shape. Verification audit point 5 catches this.
- **Tag-stale-cascade volume:** marking all translations stale on
  every tag-add could fan out widely if a tag is auto-applied to
  many recipes. Probably fine for the family-app scale, but worth
  measuring during integration tests.
- **Backfill mis-tag:** `SourceLanguage='de'` for everything is an
  assumption. If a non-DE recipe slipped through, button-visibility
  becomes wrong. Manual user-fix path acceptable; documented.

## Release-gate positioning

LANG-2 is **not** a public-release blocker. LANG-1 + LANG-1b deliver
the core promise ("new content follows your UI language"). LANG-2 is
quality-of-life polish for the existing-recipe corpus. Schedule
post-REL-1/2/6 unless the user-corpus migration story matters at
launch time.

## Follow-ups (out of LANG-2 scope)

- **Global "always translate" setting** — Q1-D from the brainstorm.
  Per-recipe button stays the manual override; settings toggle
  flips on auto-translate-on-view. Needs cost gating
  reconsideration.
- **Per-field stale tracking** — Q4-B granularity. If users complain
  that minor edits (servings tweak) shouldn't invalidate the whole
  translation, decompose.
- **More languages** — LANG-4 (FR/IT/ES). Translation prompt is
  language-agnostic already; mainly an i18n-locale-extension and
  ErrorCodes.cs `AlreadyInLanguage` semantics.
- **Recipe-list translation** — currently list shows original title.
  If users find that confusing, lazy-translate titles only on list
  view. Probably YAGNI until reported.
