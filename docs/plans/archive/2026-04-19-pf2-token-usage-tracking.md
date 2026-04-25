# PF2 — Token-Usage & Cost-Tracking

**Slice:** PF2 (Post-Phase-2 Follow-up 2)
**Status:** planned
**Date:** 2026-04-19
**Depends on:** Phase 2 complete, PF1 can land before or after (no file conflicts beyond migration-timestamp).
**User request:** 2026-04-19 — "wir brauchen ne kosten erfassung, damit ich weiß was wir an tokens verbrauchen".

## Why

Every AI call (URL extract, photo extract, chat turn, chat-to-recipe, future nutrition via prompt-extension) costs tokens. Without visibility we can't tell if a user/family is running up €5 or €500 per month. Need: per-request token counts, per-user monthly totals, a simple admin dashboard.

## Azure OpenAI token prices (as of 2026-04-19)

Pinned in `appsettings.json` under `AiPricing:*` so the user can update without a deploy when Microsoft changes rates. **Per 1M tokens, USD, standard/global deployment.** Source: pricing fetched 2026-04-19 from Microsoft Azure + cloudprice.net + helicone.ai aggregators.

| Model deployment | Input $/1M | Output $/1M | Cached-input $/1M |
|---|---|---|---|
| `gpt-4.1` | 2.00 | 8.00 | 0.50 |
| `gpt-4.1-mini` | 0.40 | 1.60 | 0.10 |
| `gpt-5.1` | 1.25 | 10.00 | 0.13 |
| `gpt-5.1-chat` | 1.25 | 10.00 | 0.13 |
| `gpt-5.1-codex-mini` | 1.25 | 10.00 | 0.13 |
| `gpt-5.1-codex-max` | 1.25 | 10.00 | 0.13 |
| `gpt-5.2` | 1.75 | 14.00 | 0.18 |
| `gpt-5.2-codex` | 1.75 | 14.00 | 0.18 |
| `gpt-5.3-codex` | 1.75 | 14.00 | 0.18 |

Notes:
- USD → EUR via a single `AiPricing:UsdToEurRate` config key (default `0.92`). Microsoft Azure prices are billed in USD even in EU regions; we store USD internally, convert at display time.
- Cached-input pricing only applies when Azure reports `cache_read_input_tokens > 0` in the usage response. For this phase we count cached + uncached separately.
- Codex-mini/max numbers mirror gpt-5.1 family per Azure's current pricing (no official separate tier published as of search date). If Microsoft later splits the tier, update the table.

## Scope

### 1. Python extractor — surface token usage

Azure Responses API already returns `usage: { input_tokens, output_tokens, input_tokens_details: { cached_tokens } }` on every call. The LLM-provider abstraction in P2-1 currently discards it.

- Extend `LLMProvider` interface: every method now returns a tuple `(result, TokenUsage)` instead of just `result`. `TokenUsage` TypedDict: `{ prompt_tokens, completion_tokens, cached_prompt_tokens, model }`.
- `AzureOpenAIProvider` reads the usage object from each response and populates.
- `MockLLMProvider` returns `TokenUsage(0, 0, 0, "mock")` by default; scripted responses can pin explicit counts for tests.
- Pipelines (`url.py`, `photo.py`, `chat.py`) accumulate token usage across any multi-call scenarios (current code is single-call but future-proof) and pass through in the response metadata.
- `ExtractionResult` gets a new optional `usage: TokenUsage | None` field.
- Chat endpoints (`/chat`, `/chat/{sid}/to-recipe`) return `X-Extractor-Prompt-Tokens`, `X-Extractor-Completion-Tokens`, `X-Extractor-Cached-Tokens`, `X-Extractor-Model` headers so the .NET proxy can pick them up.

### 2. .NET — persist + aggregate

**New columns on `RecipeImport`:**
- `PromptTokens int?`
- `CompletionTokens int?`
- `CachedPromptTokens int?`
- `ModelDeployment string?`

Populated by the Hangfire jobs when the Python response arrives.

**New table `ChatUsageLog`:**
- `Id Guid`
- `UserId Guid`
- `SessionId string`
- `Kind enum` (`ChatTurn` / `ChatToRecipe`)
- `PromptTokens int`
- `CompletionTokens int`
- `CachedPromptTokens int`
- `ModelDeployment string`
- `CreatedAt DateTimeOffset`

Written by the synchronous chat + chat-to-recipe proxy endpoints when the Python response lands.

Migration: `AddTokenUsageTracking`.

**New service `AiPricingService`:**
- Reads the `AiPricing:*` config section.
- `CalculateCost(ModelDeployment, PromptTokens, CachedPromptTokens, CompletionTokens) → decimal usd` + `ConvertToEur(usd) → decimal eur`.
- Unknown model → warn + use a conservative fallback (use gpt-5.1 rates as the "unknown family" default).

**New admin endpoint `GET /api/admin/ai-usage`:**
- Query params: `userId?`, `from?`, `to?`, `groupBy? = 'user' | 'model' | 'day'`.
- Admin-only (site-role).
- Aggregates across `RecipeImport` + `ChatUsageLog` tables.
- Returns: total prompt/completion/cached tokens + total USD + total EUR, plus the grouping breakdown.

### 3. Web — admin usage dashboard

**New route `/admin/ai-usage`** behind admin-role guard:

- Period picker (last 7d / 30d / 90d / custom).
- Grand totals card: total tokens, total EUR spent.
- Grouped bar chart (use `recharts` already in the dep tree — verify; if not available, raw HTML/CSS stacked bars are fine for v1).
- Table: per-user rows (user, tokens, cost).
- Per-model breakdown as pie or stacked.
- Link from `ProfilStub` (admin-only): "KI-Verbrauch einsehen".

**Per-user self-view (optional scope):** if time allows, a slim "Mein KI-Verbrauch diesen Monat" on `/profil` showing just the current user's numbers. Nice-to-have, not required.

### 4. Tests

Python:
- Every LLM-provider method returns a TokenUsage.
- MockLLMProvider returns scripted TokenUsage.
- AzureOpenAIProvider extracts prompt_tokens + completion_tokens + cached_tokens from a fixture Responses API response.
- Pipelines propagate usage through to their final result.
- Chat endpoint includes usage headers.

.NET:
- `AiPricingService` computes correct USD for each model + EUR conversion.
- `AiPricingService` falls back when model is unknown.
- Jobs persist token counts on `RecipeImport`.
- Chat endpoints persist `ChatUsageLog` rows.
- `/api/admin/ai-usage` aggregates correctly across both tables.
- Admin-only guard.

Shared types: `AiUsageSummary`, `AiUsageGroupedRow`.

Web:
- Admin-usage page renders totals + breakdowns.
- Period-picker updates query.
- Non-admin navigating to `/admin/ai-usage` gets 403.

## Non-goals

- No hard rate-limit / quota enforcement (Phase 2 §6 explicitly deferred — just reporting for now).
- No alert if monthly cost crosses a threshold (Phase 3 polish).
- No per-recipe cost display to regular users.
- No cost estimation before running — only after-the-fact accounting.
- No billing / invoicing integration.

## Acceptance criteria

- All four test suites green + new tests.
- `dotnet test`, `pytest`, `pnpm test`, `pnpm build`, `pnpm lint` all clean.
- Migration applies.
- A live extraction → `RecipeImport` row has non-null `PromptTokens` / `CompletionTokens`.
- A live chat turn → `ChatUsageLog` row created.
- Admin visiting `/admin/ai-usage` sees the total EUR for the last 30 days with correct math (manual check: 1 M gpt-5.1 input tokens at $1.25 × 0.92 EUR ≈ €1.15).
- Non-admin → 403.

## Anti-shortcut reminders

- TDD per layer.
- No hard-coded prices in code — all via `appsettings.json`.
- Unknown-model fallback must log a warning (so operators notice new deployments aren't priced).
- Don't mix cost-calculation into storage code — `AiPricingService` is the single source of truth, tests pin every model's calculation.
- Don't break the existing `LLMProvider` signatures silently — update every caller + every test in the same slice.

## Dispatch notes

**Impl agent:** big-ish slice (3 layers, new migration, new admin surface). Work order: Python provider-interface change + tests → pipelines propagate → chat endpoints emit headers → .NET DTOs + RecipeImport columns + ChatUsageLog table + migration → AiPricingService → admin endpoint → web admin dashboard. Commit per layer + per-endpoint. All four gates green at end. No deployment.
