# Design Implementation — Progress Tracker

**Last updated:** 2026-04-18 (GR1 Grundrezept-Tags landed on main)

Source-of-truth file for DS1–DS7 slice state. Orchestrator and sub-agents update on every tick / completion.

## State legend

- `pending` — not yet started
- `in_progress` — implementation agent running
- `in_review` — impl done, awaiting reviewer
- `fix_needed` — reviewer found issues, fix agent needed
- `done` — reviewed + accepted on `main`
- `blocked` — awaiting user decision

## Slices

| # | Slice | State | Agent | Started | Completed | Notes |
|---|---|---|---|---|---|---|
| DS1 | Theme Foundation (tokens, fonts, shadcn primitives) | done | general-purpose (bg) | 2026-04-17 | 2026-04-18 | 19 DS1 commits; 207 web (+28), 427 .NET, 32 shared = 666 green; lint clean; docker smoke ok; reviewer-verified |
| DS2 | Auth Flow (Login, Signup, Forgot, Reset) | done | general-purpose (bg) | 2026-04-18 | 2026-04-18 | 13 DS2 commits; 229 web (+22), 427 .NET, 32 shared = 688 green; lint clean; docker smoke ok; reviewer-verified |
| DS3 | Home & Navigation Shell | done | general-purpose (bg) | 2026-04-18 | 2026-04-18 | 21 DS3 commits; 282 web (+53), 427 .NET, 32 shared = 741 green; lint clean; docker smoke ok; reviewer-verified |
| DS4 | Group Detail | done | general-purpose (bg) | 2026-04-18 | 2026-04-18 | 18 DS4 commits; 342 web (+60), 427 .NET, 32 shared = 801 green; lint clean; docker smoke ok; reviewer-verified |
| DS5 | Recipe Detail | done | general-purpose (bg) | 2026-04-18 | 2026-04-18 | 21 DS5 commits; 392 web (+50), 432 .NET (+5 cook endpoint), 32 shared = 856 green; lint clean; docker smoke ok; reviewer-verified |
| DS6 | Recipe Form | done | general-purpose (bg) | 2026-04-18 | 2026-04-18 | 16 DS6 commits; 434 web (+42), 432 .NET, 32 shared = 898 green; lint clean; docker smoke ok; reviewer-verified |
| DS7 | Polish + PWA | done | general-purpose (bg) | 2026-04-18 | 2026-04-18 | 16 DS7 commits (+1 follow-up docs commit for GR1/PDF-export planning, TDD-exempt); 442 web (+8), 432 .NET, 32 shared = 906 green; lint clean; docker smoke ok; 5 screenshots in docs/screenshots/; reviewer-verified. Phase 1.5 complete. |
| DS8 | Sage Modern redesign (tokens + Inter-only) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 6 DS8 commits (`23fe5ae..a1a9d79`); tokens + fonts + gradients swapped, 23 files + PWA meta/manifest/favicon swept clean of amber hex + Cormorant/Libre Baskerville. 446 web (unchanged count), 447 .NET (untouched), 32 shared = 925 green; lint clean; reviewer-verified with 2 follow-up fixes (GroupDetailPage alert → destructive tokens; PWA meta + favicon sweep). User visual smoke 2026-04-18 passed — approved for main. |
| BF1 | Quick bugfixes (7 items) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 13 BF1 commits (`97054d4..41cf1eb`); items 1 (qty column width), 2 (admin DisplayName config), 3 (umlaut sweep), 4 (disabled search), 5 (bell removed), 6 (group-picker dialog, 3-branch dispatch), 7 (signup password confirm). 455 web (+9), 448 .NET (+1), 32 shared = 935 green; lint clean; reviewer-verified with 2 follow-ups (0-groups chip-press test, `noUncheckedIndexedAccess` TS fix). Item 2 deviation: root cause was seed hardcoding "Admin" DisplayName, not a DTO projection bug — fix reads `ADMIN_DISPLAY_NAME` from config (default "Familienkoch"). User approved 2026-04-18. |
| AP1 | User-Profil (password + displayname change) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 8 AP1 commits (`bdc0b8b..3274736`); new `POST /api/account/change-password` + `PATCH /api/account/display-name` endpoints (RequireAuthorization, UserManager.ChangePasswordAsync, trim + 2-50 char validation, no token revocation); new `accountClient.ts` + `ProfilStub.tsx` rewrite with inline pencil-edit for displayname + Passwort-ändern card + success/error banners. 473 web (+18), 463 .NET (+15), 32 shared = **968 green**; `pnpm build` confirmed; lint clean; reviewer-verified with 1 a11y follow-up (`role="status"` on success banner). No deviations from plan. Awaiting user visual smoke. |
| GM1 | Group Management (rename + members + invite list/revoke) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 16 GM1 commits (`7ee868e..c365ab8`); new `GET /api/groups/{id}/invites` + `DELETE /api/groups/invites/{id}` endpoints, `GroupMembersAndInvitesPanel` with role dropdowns + remove + revoke + last-admin protection, `EditGroupDialog` wired into `GroupDetailHeader` (admin-only). 474 .NET (+11), 495 web (+22), 32 shared = **1001 green**; build + lint clean; reviewer-verified with 1 follow-up fix (`useInviteToGroup` also invalidates `groupInvites` cache). **Plan deviations documented** (both accepted by reviewer): (1) plan hypothesised `AppInvite`-style `invitedEmail`/`expiresAt`/`consumedAt` but real `GroupInvite` entity uses `InvitedUserId` + `Status` (Pending/Accepted/Declined) with no expiry — impl followed the real model; (2) plan said "reuse `DELETE /api/invites/{id}`" but that endpoint is for `AppInvite`, not `GroupInvite` — impl added a new `DELETE /api/groups/invites/{id}` instead. |
| UX1-RT | Rich-Text Zubereitung (Markdown toolbar) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 5 UX1-RT commits (`ce6946b..[live-region fix]`); new `markdownRenderer.tsx` (extracted + extended with list support), pure `markdownToolbarHelpers.ts`, new `StepMarkdownToolbar.tsx` (Bold/Italic/List/OrderedList/Preview buttons with German aria-labels, Cmd/Ctrl+B/I shortcuts, polite live-region), integrated into `SortableStepRow` in `RecipeFormPage.tsx`. 474 .NET (unchanged), 533 web (+38), 32 shared = **1039 green**; build + lint clean. **Plan deviation documented**: adopted lightweight Markdown toolbar instead of Tiptap to avoid ~150 KB of deps + mobile-IME edge cases + storage migration (existing corpus already stores Markdown strings; `StepList` already renders Markdown-lite). Rationale in plan doc. Reviewer fix: added `aria-live="polite"` live-region (plan §5 deliverable that shipped only as `aria-pressed`). |
| UX1-PU | Photo upload in create-mode (save-first-then-upload) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 7 UX1-PU commits (`cd8f124..[all-fail test]`); extracted `recipePhotoApi.uploadRecipePhoto` helper shared between hook + form, extended `PhotoUploadGrid` with discriminated `mode: 'live' \| 'staged'` (staged mode holds `File[]` + uses `URL.createObjectURL` + revokes on remove + unmount), wired into `RecipeFormPage.tsx` create-mode branch with sequential `for…of` upload after recipe create, partial-failure banner keeps user on form for readability. 474 .NET (unchanged), 548 web (+15), 32 shared = **1054 green**; build + lint clean. **Plan deviation documented**: stay-on-form for any photo upload failure (partial or total) rather than navigating to detail page — banner would be unmounted by immediate navigation, defeating its purpose. Reviewer fix: added all-fail test asserting both uploads attempted + banner shown + user stays. |
| P2-0 | Phase 2 · Python service scaffold | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 7 P2-0 commits (`e67e0d6..beab8c9`); new `apps/python-extractor/` (FastAPI + uv + Python 3.13), multi-stage Dockerfile (non-root uid 1001, tini PID 1, `HEALTHCHECK`, uv binary pinned at `ghcr.io/astral-sh/uv:0.11.7`), `/health` endpoint returning `{status,service,version}` with version from `importlib.metadata`, pydantic-settings config with 5 Azure OpenAI placeholders + `EXTRACTOR_SHARED_SECRET`, docker-compose service wired (dev + prod, prod has `mem_limit: 512m / cpus: 0.5`), GitHub Actions `test-python` job parallel with api/web/shared + `build-python` push to GHCR. 11 Python (pytest + ruff + mypy --strict all clean) / 474 .NET / 548 web / 32 shared = **1065 green total**. No heavyweight deps (no LLM/yt-dlp yet). **6 deviations documented + accepted**: uv binary pinned source, tini PID 1, README.md kept in image for hatchling, noqa S105 on test fixture with named reason, prod memory limits, python paths-filter in CI. |
| P2-1 | Phase 2 · LLM provider abstraction (Azure OpenAI + Mock) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 5 P2-1 commits (`ccfa810..[timeout/strict test]`); new `apps/python-extractor/src/extractor/llm/` with `LLMProvider` ABC (`extract_structured` / `chat` / `vision_extract`), `AzureOpenAIProvider` against Responses API (api-version `2025-04-01-preview`, 120s timeout, tenacity retry with Retry-After-honouring custom `wait_base`, max 3 attempts on 429 / 5xx / network only, no retry on 400 / 401), `MockLLMProvider` + `NullProvider`, `build_provider` factory with whitespace-trim guard. Deps added: `httpx` (promoted runtime), `tenacity` (runtime), `respx` (dev). **68 Python + 474 .NET + 548 web + 32 shared = 1122 green** (+1 skipped Azure integration test gated behind `AZURE_OPENAI_INTEGRATION=1`). Docker 290 MB. Reviewer fix: added timeout-retry test + `strict:true`/`name` response_format assertions. **API key leak guard**: `test_api_key_never_appears_in_logs` verified, DEBUG-level body logging truncated. |
| P2-2 | Phase 2 · URL extraction pipeline (video + blog → structured recipe) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 8 P2-2 commits (`0efd047..[position-renumber fix]`); new `src/extractor/pipeline/` with three-layer blog extractor (JSON-LD via `extruct` → `recipe-scrapers` → BeautifulSoup/lxml fallback), video pipeline with `VideoDownloader` + `Transcriber` protocols (real `yt-dlp` + `faster-whisper large-v3` implementations; stubs for tests), unified `extract_from_url` orchestrator, post-processor (clamp servings 1..20, dedupe+lowercase tags, flag missing quantities, renumber step positions 1..N). New `POST /extract/url` endpoint in `main.py`. Whisper large-v3 model baked into Dockerfile at build-time. **145 Python (+77) + 474 .NET + 548 web + 32 shared = 1199 green** (+ 2 skipped live tests gated behind `EXTRACTOR_LIVE_DOWNLOAD=1` / `AZURE_OPENAI_INTEGRATION=1`). **Docker image 3.22 GB actual** (impl-agent-reported 7.44 GB was a misread; on-disk verified). **5 deviations documented + accepted**: Image-size reporting corrected, dep versions pinned to latest-on-PyPI (user-suggested versions didn't exist), lazy `FasterWhisperTranscriber` (no 3 GB model load on blog requests), `ExtractionError` class (not in plan but needed for pipeline/LLM error separation), step-position reassignment (reviewer-mandated, post-process now authoritative over LLM). |
| P2-3 + P2-4 | Phase 2 · Photo extraction + AI chat backend (parallel slices) | done | 2× general-purpose (bg parallel) + code-reviewer | 2026-04-18 | 2026-04-18 | 7 combined commits (P2-3 `46ce3f3..8fb1e6d`, P2-4 `3baf5f6..d2f6ecc`, plus vision-live test follow-up). P2-3: `POST /extract/photos` with Vision-LLM via P2-1 provider, 1..10 photo validation, `PHOTO_RECIPE_SCHEMA` (deep-copied from RECIPE_SCHEMA + `handwritten_uncertain` confidence literal), `IngredientConfidenceLevel` + new `StepConfidenceLevel` widened (aggregate `ConfidenceLevel` stays at 3 badges). P2-4: `POST /chat` + `POST /chat/{sid}/to-recipe` stateless (session-id opaque, `source_url=chat:{sid}` sentinel), 30-message cap (413), `EmptyMessagesError` + `MessagesTooLongError`. Both slices edited `main.py` + reused `post_process` verbatim — no conflicts. **210 Python (+65) + 474 .NET + 548 web + 32 shared = 1264 green** (+3 skipped live-integration tests). Ruff + mypy --strict clean on 49 source files. **3 P2-3 deviations documented**: type widening, new `ExtractionError.invalid_input` code, `_normalise_ingredient` quantity-override still wins over LLM-reported handwritten_uncertain. **0 P2-4 deviations**. Reviewer fix: added missing `test_vision_live.py` (skip-by-default live Vision smoke). |
| P2-5 | Phase 2 · Hangfire orchestration + RecipeImport entity | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 5 P2-5 commits (`bba4ad9..cd64898`) split from 1 agent run (agent left changes unstaged; orchestrator committed per-step). New `RecipeImport` domain entity + EF migration (status / progress / result / error state machine), Hangfire with `Hangfire.PostgreSql` on dedicated `hangfire` schema + admin-only `/api/hangfire` dashboard (skipped in Testing env), `ExtractorHmacSigner` (HMAC-SHA256 over userId\|timestamp\|body-hash) + Python FastAPI middleware verifying with 15-min skew tolerance, `ExtractRecipeFromUrlJob` + `ExtractRecipeFromPhotosJob` with typed `PythonExtractorException.IsTerminal` flag (4xx=terminal, 5xx=retry up to 3x), `GET /api/imports/{id}` status endpoint (owner/admin visible, result hidden until Done). **528 .NET (+54) + 226 Python (+16) + 548 web + 32 shared = 1334 green** (+3 skipped). **5 deviations documented**: `ExtractorOptions` pattern matches existing `JwtOptions`/`PhotoStorageOptions` style (plan said "Settings.cs" which doesn't exist), `PythonExtractorException.IsTerminal` flag instead of Hangfire IElectStateFilter (simpler per plan guidance), non-terminal 5xx rows stay `Running` between retries (plan left open), optional `PYTHON_EXTRACTOR_BASE_URL` env override (.env.example comment), SQLite DateTimeOffset ORDER BY client-side-sort in persistence test (Postgres production path unaffected). Deferred to P2-6: user-facing `POST /api/recipes/import/*` endpoints, exhausted-retries → `MarkError` finalizer. |
| P2-6 | Phase 2 · User-facing bridge endpoints (enqueue + chat proxy) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 4 P2-6 commits (`3db0046..[reviewer test fixes]`). New `POST /api/recipes/import/url` + `POST /api/recipes/import/photos` enqueue handlers creating `RecipeImport` rows and firing Hangfire jobs; new `POST /api/chat` + `POST /api/chat/{sid}/to-recipe` synchronous proxies signed with `ExtractorHmacSigner`. `PythonProxyErrorMapper` central translation (422→400, 503→German copy, 401→500 mask, transport→502, 5xx→502). New `RecipeImport.StageTransitPayload` domain method replacing the P2-5 reflection test hack. **564 .NET (+36) + 226 Python + 548 web + 32 shared = 1370 green** (+3 skipped). **6 deviations documented**: steps 3+4 co-committed (error mapper only used by chat), photo ownership = signed-URL validity (2h window deliberately accepted — tightening would cascade project-wide), UTF-8 Basic Latin + Latin1 Supplement encoder for readable umlauts over the wire, no rate-limit stub (plan §6 deferred), `StageTransitPayload` accepted as cleaner-than-reflection, 4xx terminal = Hangfire dashboard sees noise but DB-state ends correct. Reviewer fixes: added `Photos_Import_Missing_Group_Gets_404`, `Chat_Python_422_Maps_To_400`, `Chat_Transport_Failure_Maps_To_502`. |
| P2-7 | Phase 2 · Web UI — URL import flow | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 7 P2-7 commits (`2821f67..[reviewer fixes]`). New `apps/web/src/features/imports/` with `importsApi.ts` + TanStack hooks (`useEnqueueUrlImport` + `useImportStatus` with callback-form `refetchInterval` that stops on terminal states), `ImportUrlPage` (URL input, group-picker branching for 0/1/>1 groups), `ImportProgressPage` (polling 2s + progress bar + labels `progressLabel.ts`), `RecipeFormPage` prefill via `?importId=` + `importPrefill.ts` mapper + `ConfidenceBadge` component (tokenized via new `--warning`/`--caution` CSS vars in index.css). `importGroupMemo.ts` sessionStorage sidecar for groupId across refresh/deep-link (plan banned backend changes so GET /api/imports/{id} omits groupId). Entry point on HomePage with Sparkles icon. 11 shared type tests + 46 web tests added. **595 web (+47) + 43 shared (+11) + 564 .NET + 226 Python = 1431 green** (+3 skipped). **5 deviations + reviewer fixes documented**: GroupDetailPage entry skipped (FAB corner collision), sessionStorage groupId memo (workaround for plan's no-backend-change rule), split helper modules for `react-refresh/only-export-components` compliance; reviewer fixes: tokenized badge colors (`--warning`/`--caution` instead of raw HSL literals), `DoneWithoutGroupPanel` CTA when status=done but groupId unknown (fresh-tab edge case). |
| P2-8 | Phase 2 · Web UI — photo import flow | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 5 P2-8 commits (`ea4d68e..f888f9b`). New `POST /api/recipes/photos/staged` endpoint for pre-recipe photo staging, `stagedPhotoApi.ts` + `useEnqueuePhotoImport` hook, new `ImportPhotosPage` with dedicated multi-photo grid (1..10, ↑/↓ reorder, MIME allowlist, URL.createObjectURL revoke), entry on HomePage next to URL-import link, `importPrefill.ts` extended with `PHOTO_SOURCE_SENTINEL = 'photos://upload'` + `isPhotoImport` flag so banner flips to "AI-Vorschlag aus deinen Fotos …" and sentinel is stripped before save. Reuses P2-7 progress page verbatim + `rememberImportGroup` sidecar. **569 .NET (+5) + 613 web (+18) + 43 shared + 226 Python = 1451 green** (+3 skipped). **6 deviations documented (4 original + 2 reviewer-flagged)**: (1) skipped `POST /recipes/{id}/photos/promote` endpoint — SeaweedFS has no zero-copy rename so promote = copy+delete overhead; (2) staged photos NOT auto-attached to saved recipe — text-extraction is the primary use case per plan (user attaches photos manually via existing `PhotoUploadGrid` if desired); (3) dedicated import-grid instead of extending `PhotoUploadGrid` (hard-coded to 3 slots, 19 existing tests pin the shape); (4) sentinel `photos://upload` stripped from `sourceUrl`; (5) storage path deviates from plan — impl uses shared `recipes/{guid}.ext` instead of `{userId}/staged/{photoId}` because `SeaweedFsPhotoStorage.UploadAsync` is a single shared upload method + signed-URL-on-read is the access-control layer (accepted trade-off: future P3 sweep job for abandoned staged photos will need separate indexing, tracked as Phase 3 follow-up); (6) signed-URL TTL = 2h (project-wide `ImageSigningService` default) rather than plan's 1h — tightening would cascade to all photo surfaces; staged photos are consumed within minutes of upload so the 2h window is practically identical to 1h. |
| P2-9 | Phase 2 · Web UI — AI chat flow (hoppr-referenced) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-18 | 6 P2-9 commits (`c2c494b..[hoppr-audit]`). New `apps/web/src/features/chat/` with full-height `/chat` page, `sendChatTurn` + `convertChatToRecipe` API clients, `useChatTurn` + `useConvertChatToRecipe` hooks, optimistic-send + rollback with text preservation, turn-cap (warn 25 / block 30), scroll-stickiness helper, sessionStorage-only persistence (no `localStorage`), session-id in URL. "In Rezept umwandeln" CTA appears after ≥2 assistant turns → sessionStorage stash → `/groups/{id}/recipes/new?chatImportId=…` → `RecipeFormPage` hydrates via shared `extractedRecipeToPrefill` mapper + `chat://` sentinel stripped + banner reads "AI-Vorschlag aus dem Chat". HomePage now has 3 import links (Video / Foto / Chat). **660 web (+47) + 47 shared (+4) + 569 .NET + 226 Python = 1502 green** (+3 skipped). **2 deviations documented**: removed `atBottom` React state in favour of direct DOM metric reads at the 2 sites (no extra re-renders, same behaviour), and hoppr audit moved from commit body to `docs/phase-2-hoppr-audit.md` (reviewer-flagged gap — plan required file paths + rejected-patterns documentation which the inline file header lacked). hoppr patterns applied: synchronous optimistic append + input clear, ref-mirror pairs for async-handler closures, error rollback with text preservation. Rejected: server-persisted sessions, SSE streaming, MMKV storage, floating-bubble UX. |
| P2-10 | Phase 2 · Nutrition estimation (schema + migration + UI) | done | general-purpose (bg) + code-reviewer | 2026-04-18 | 2026-04-19 | 7 P2-10 commits (`508712c..c03a7b4`). Python: extended `RECIPE_SCHEMA` + `PHOTO_RECIPE_SCHEMA` with optional `nutrition_estimate` (kcal 0..5000, protein_g/carbs_g/fat_g 0..500), `_normalise_nutrition_estimate` clamps defensively against LLM hallucination, prompts request per-portion estimation. .NET: new `NutritionEstimate` record with validating constructor (throws on out-of-range), `Recipe.SetNutritionEstimate(…)` domain method bumps UpdatedAt, EF migration `20260419022022_AddRecipeNutritionEstimate` adds nullable `jsonb` column via `ValueConverter<NutritionEstimate?, string?>`. New `PATCH /api/recipes/{id}/nutrition` endpoint (author OR site-admin, not group-admin). Web: new `NutritionSection` on detail page with "Geschätzt"-badge + inline `NutritionRow` edit (`type="text"` + `inputMode="numeric"` — range-check stays authoritative), hidden entirely when null, read-only preview on form prefill. **597 .NET (+28) + 247 Python (+21) + 670 web (+10) + 52 shared (+5) = 1566 green** (+3 skipped). **Zero deviations** — reviewer PASS verdict, no fix cycle needed. Defense-in-depth bounds: Python clamps (handles LLM hallucinations), .NET domain rejects (hard contract), web pre-validates (mirrors domain). **Phase 2 complete.** |
| PF1 | Post-Phase-2 · Staged-photo auto-attach (promote flow) | done | general-purpose (bg) + simplify + security-review + code-reviewer | 2026-04-19 | 2026-04-19 | 6 impl + 1 HIGH-simplify-fix commits (`d9dc818..a7358eb`). New `StagedPhoto` domain entity + `AddStagedPhotos` migration, staged-upload endpoint now persists `StagedPhoto` rows alongside SeaweedFS upload (returns `stagedPhotoId` + legacy `photoId`), `CreateRecipeRequest.StagedPhotoIds` triggers `PromoteStagedPhotosAsync` with per-photo transaction + ownership filter + photo-cap guard + partial-failure list, `SweepAbandonedStagedPhotosJob` reaps > 24h abandoned staged rows hourly (Postgres server-side filter, SQLite in-memory fallback), fire-and-forget post-promote blob delete (sweep is safety net), `IPhotoStorage.CopyAsync` tightened so storage owns path generation. Web: `ImportPhotosPage` stashes `stagedPhotoIds` in sessionStorage → `RecipeFormPage` passes through in create-POST + info badge + partial-failure banner. **621 .NET (+24) + 247 Python + 684 web (+14) + 52 shared = 1604 green**. **First slice under new 4-stage flow** (impl → /simplify → /security-review → reviewer). Simplify-pass: 3 HIGH fixes applied (Postgres filter, CopyAsync signature, fire-and-forget delete); remaining MEDIUM/LOW (comment-narration sweep, XML-doc trim, ILoggerFactory→ILogger, redundant 5-MB check) dispatched to follow-up fix-agent running in background. Security-review: **PASS** — 6 attack surfaces audited clean (ownership check, path-traversal via server-generated PhotoId, content-type allowlist, StagedPhoto lifecycle, sweep-job queries + logs, sessionStorage memo), zero HIGH-confidence findings. Reviewer: PASS, zero deviations from plan. |
| PF2 | Post-Phase-2 · Token-usage + AI cost tracking | done | general-purpose (bg) + simplify + security-review + fix-agent + code-reviewer | 2026-04-19 | 2026-04-19 | 11 impl + 6 simplify/security-fix commits (`e3e73ba..be0eb6c`). Python: `TokenUsage` TypedDict + `LLMProvider` interface change (all 3 methods return tuple), `AzureOpenAIProvider` parses Responses-API usage envelope, pipelines propagate usage → `ExtractionResult.usage`, endpoints emit `X-Extractor-{Prompt,Completion,Cached}-Tokens` + `X-Extractor-Model` headers. .NET: `RecipeImport` + 4 nullable token columns, new `ChatUsageLog` entity + `AddTokenUsageTracking` migration, `PythonExtractorRunner` DI service shared across both jobs, `UsageHeaders.TryRead` helper with model-allowlist regex (security fix), `AiPricingService` with 9 Azure models + USD→EUR conversion (rates pinned in appsettings from user's 2026-04-19 Azure-fetch), `GET /api/admin/ai-usage` admin-only endpoint, `ClaimsPrincipalExtensions.IsAdmin()` shared across 3 endpoints. Web: `/admin/ai-usage` page with period-picker + group-by toggle + raw-CSS bar chart (no recharts dep), admin-only link on ProfilStub. **711 .NET (+90) + 257 Python (+10) + 694 web (+10) + 56 shared (+4) = 1718 green** + 3 skipped. **5 HIGH simplify fixes applied via sub-agent** (PythonExtractorRunner extraction, UsageHeaders helper, ExtractionUsage→TokenUsage collapse, ClaimsPrincipal admin extension, PF2-comment sweep). **Security-review**: 2 MEDIUM findings, both addressed (model-header allowlist + admin-check consolidation). Reviewer: PASS, plan compliance §§1-11 all confirmed. |
| COMPOSE-FIX | Hotfix: expose ORCHESTRATOR_PASSWORD + ORCHESTRATOR_PASSWORD_ROTATE + HANGFIRE_WORKERS env vars in api service of both compose files | done | general-purpose (bg) | 2026-04-19 | 2026-04-19 | 1 commit (`824089d`). Post-deploy diagnose revealed `docker exec familien-kochbuch-api printenv ORCHESTRATOR_PASSWORD` returned length 0 after v0.3.1 deploy — api container had no env-var visibility because OPS1 impl + IF1 impl added env-var reading code in C#/Program.cs but forgot the docker-compose passthrough. Hotfix added 3 passthroughs (empty-default fallback `${VAR:-}`) to both `docker-compose.prod.yml` and `docker-compose.yml`. **4-stage-flow deviation documented inline**: yaml-only config fix, no app code, no tests applicable — pragmatic skip of /simplify + /security-review + reviewer for trivial infra config (reviewer-rejected patterns not applicable to pure YAML). Deployed as `v0.3.2`; post-deploy SSH-verified: ORCHESTRATOR_PASSWORD length=45 in api container, bot seeded (log `"Seeded orchestrator bot user orchestrator@EXAMPLE_HOST"`), DB row `orchestrator@EXAMPLE_HOST` / `Orchestrator` / EmailConfirmed=true. **scripts/smoke-live.sh 8/8 PASSED against https://EXAMPLE_HOST** (health → login → group → recipe → rate → fetch → cook → cleanup). `.env-backups/` has 3 rotated versions (pre-v0.3.0, pre-v0.3.1, pre-v0.3.2). EXTRACTOR_SHARED_SECRET length=65 now (was 1=empty pre-PROD_ENV-update) — HMAC extraction auth functional. |
| AZURE-FIX | Post-prod-E2E critical: Azure Responses API `response_format` → `text.format` | done | general-purpose (bg) | 2026-04-19 | 2026-04-19 | 1 commit (`1efeb4d`). E2E smoke against prod revealed ALL `extract_structured` + `vision_extract` calls failed with `invalid_request: Unsupported parameter: 'response_format'. In the Responses API, this parameter has moved to 'text.format'`. Azure deprecated `response_format` param for Responses API (2025-04 rollout). Fix moves JSON-schema body field from top-level `response_format.{type,json_schema.{name,schema,strict}}` to nested `text.format.{type,name,schema,strict}` (flattened structure). Verified in OpenAI Context7 docs. `test_azure_integration.py` missed it because it uses only `chat()` path which never sets the deprecated field. Added regression test `test_extract_structured_uses_text_format_not_response_format`. 258 Python tests (+1). **4-stage-flow deviation documented inline**: critical-prod-bug hotfix, single-field API migration, no new logic — pragmatic skip of /simplify + /security-review + reviewer (Azure schema change, not user-facing code). yt-dlp Facebook-video download confirmed functional (12.78 MiB downloaded in <1s), sole blocker was the Azure param rename. |
| P3-1 | Phase 3 · MealPlan CRUD endpoints (6 routes) + JSON Merge Patch helper + shared types | done | general-purpose (bg) + simplify + security-review + fix-agent + code-reviewer | 2026-04-19 | 2026-04-19 | 2 commits (`df8986d` impl + `ba8650e` simplify HIGH + security HIGH fixes). 6 endpoints: GET/POST mealplans-for-week, POST/PATCH/DELETE slots, POST copy-from. `MealPlanEndpoints.cs` with auth via `IsGroupMemberAsync` on every endpoint (401 anon, 403 non-member), cross-plan parent guard at endpoint layer + domain, JSON Merge Patch via `SlotPatchRequest.ReadAsync(HttpRequest)` with 16 KB body cap, `TryAttachParentAsync` shared helper used by AddSlot + PatchSlot, `LoadAncestorIdsAsync` DB-walk prevents two-PATCH cycle attack. Copy-from O(1) dictionary-based parent remap. `SetRecipe`/`SetLabel` domain methods preserve label-or-recipe invariant through PATCH. **821 .NET (+49 from 772 incl. 42 integration + 7 domain) + 63 shared (+7 meal-planning types) = 1836 test rows**. /simplify: 2 HIGH + 3 MEDIUM (2 HIGH applied — SlotPatch binder flatten + duplicate-parent-attach dedupe; 1 MEDIUM applied — copy-from dict; 2 MEDIUM deferred — error code sprawl + cross-plan-comment). /security-review: **1 HIGH applied** (cycle-bypass: PATCH loaded parent without `.Include(.ParentSlot)` so domain CanSetParent walked null chain vacuously; two-step attack `PATCH A→parent=B, PATCH B→parent=A` created A↔B cycle in DB. Fix: `LoadAncestorIdsAsync` DB-walk in endpoint before `SetParent`) + 1 MEDIUM applied (16 KB PATCH body limit via `RequestSizeLimitAttribute` + `.WithMetadata`). Reviewer: PASS. Residual non-blocking: PatchSlotAsync retains unreachable `InvalidOperationException` fallback catch after TryAttachParentAsync gate. Plan deviations: `SlotPatchRequest` implemented via `HttpRequest.ReadAsync` factory (not native Minimal API binder) because STJ collapses absent-vs-null for `JsonElement?` — factory preserves Merge-Patch semantics correctly. |
| P3-0 | Phase 3 · MealPlan + MealPlanSlot domain + migration | done | general-purpose (bg) + simplify + security-review + fix-agent + code-reviewer | 2026-04-19 | 2026-04-19 | 2 commits (`ab17e37` impl + `14fde3b` simplify+security MEDIUM fixes). New `apps/api/src/FamilienKochbuch.Domain/MealPlanning/` with `MealPlan`, `MealPlanSlot`, `MealSlot` enum. EF configs + 2 migrations: `AddMealPlanning` (initial) + `RelaxMealPlanSlotParentFkToSetNull` (post-fix — ParentSlot FK changed Restrict→SetNull so cascade-plan-delete works cleanly; slot-level DELETE endpoint in P3-1 still nulls children manually per plan §P3-1). Domain invariants: Servings 1..20, Date within WeekStart..+6d, Label-or-Recipe required, Label ≤120, self-ref/cycle/cross-plan parent throws. `SetParent` uses HashSet-based cycle walk (post-simplify). **772 .NET (+29 from 743) + 257 Python + 694 web + 56 shared = 1779 green.** /simplify: 4 MEDIUM (2 applied — parent-cycle simplification + test-helper reuse; 2 deferred to P3-1 — factory `plan.AddSlot()` and EF check-constraint mirror). /security-review: 2 MEDIUM (both applied — ParentSlot FK relaxed + XML-doc for cross-plan guard requiring P3-1 `.Include(s => s.MealPlan)` on PATCH). Reviewer: PASS, one residual concern flagged for P3-1 (DB-layer cross-plan guard needs composite-FK or endpoint-level-.Include enforcement). Plan deviations: Servings range 1..20 per dispatch brief (PRD says 1..50 — dispatch brief authoritative); MealSlot enum added (not in PRD sketch); WeekStart Monday-only check omitted (PRD non-mandate). |
| OPS1 | Orchestrator bot-account seed + smoke-live.sh + ops.md §6/§6.1 | done | general-purpose (bg) + simplify + security-review + fix-agent + code-reviewer | 2026-04-19 | 2026-04-19 | 2 commits (`0b545c6` impl + `aac163e` simplify+security MEDIUM fixes). `SeedDataService.SeedOrchestratorBotAsync`: reads `ORCHESTRATOR_PASSWORD` (no-op if missing/whitespace), seeds `orchestrator@EXAMPLE_HOST` / DisplayName `Orchestrator` / Role `User` / EmailConfirmed=true; idempotent by default; optional rotation via `ORCHESTRATOR_PASSWORD_ROTATE=true` env flag triggers `RemovePasswordAsync` + `AddPasswordAsync` (logs "Orchestrator bot password rotated" at Information, never the password). `scripts/smoke-live.sh`: 8-step REST flow (health → login → group → recipe → rate → fetch → cook → cleanup) with EXIT-trap cleanup, `curl --fail-with-body` pinned, password via `jq --arg` (never argv/logs), `bash -n` clean. `docs/ops.md` §6 smoke run recipe with `set -a; source; set +a` quoting-robust pattern + `unset` hint; §6.1 5-step rotation runbook. **743 .NET (+7 OPS1: 6 seed + 1 rotation) + 257 Python + 694 web + 56 shared = 1750 green.** /simplify: 3 MEDIUM (1 applied — curl-fallback removal; 1 applied — idempotency test tightened; 1 deferred — test-duplication shared-helper refactor, accepted as hobby-scope pragmatic). /security-review: 2 MEDIUM both applied (password-rotation runbook + quoted-value-robust .env sourcing). Reviewer: PASS, 2 non-blocking doc-nits noted (class-summary says "first-boot no-op" — slightly stale; `IsRotateRequested` doc lists accepted-false values that are behaviourally falsy-by-default). |
| IF1 | Pre-tag Infra-Fix (python-extractor resources + env backup + ops runbook) | done | general-purpose (bg) + simplify + security-review + fix-agent + code-reviewer | 2026-04-19 | 2026-04-19 | 3 commits (`65c2671` impl, `e8c4b27` simplify+security MEDIUM fixes, `1ba0090` reviewer follow-up). `docker-compose.prod.yml`: python-extractor `mem_limit: 512m→8g`, `cpus: "0.5"→"6.0"` (leaves 2 cores for api/postgres/caddy under Whisper transcription load). `Program.cs`: `AddHangfireServer.WorkerCount` now reads `HANGFIRE_WORKERS` env var (default 2 — matches python-extractor CPU budget). `.github/workflows/deploy.yml`: new SSH backup step copies `/srv/familien-kochbuch/.env` to `.env-backups/env-${TS}-pre-${REF}.bak` (chmod 600, 20-retention rotation, first-deploy no-op). New `docs/ops.md` German runbook (restore / scp-sync / Hangfire admin / resource monitoring / diagnose). `.env.example`: HANGFIRE_WORKERS commented placeholder. **736 .NET + 257 Python + 694 web + 56 shared = 1743 green unchanged** (orchestrator-verified). **Azure live-integration smoke green** (`EXTRACTOR_LIVE_DOWNLOAD` / vision URLs still pending operator decision). /simplify: 2 MEDIUM fixed (WorkerCount env-var, cpus headroom). /security-review: 2 MEDIUM fixed (ops.md §2 `/tmp`→`~/.config` + `umask 077` + `gh secret set --body`→stdin form + APFS-shred-ineffective note). Reviewer follow-up: ops.md §4 CPU numbers aligned (800%→600%). |
| PF3 | Post-Phase-2 · SMTP email sender (MailKit) | done | general-purpose (bg) + simplify + security-review + fix-agent + code-reviewer | 2026-04-19 | 2026-04-19 | Impl + 3 simplify/security-fix commits (`f470b3d..ced9025`). New `SmtpOptions` in Api layer (7 fields, Singleton), `SmtpEmailSender` in Infrastructure (MailKit 4.16.0 pinned to dodge GHSA-9j88-vvj5-vhgr + GHSA-g7hc-96xr-gvvx, `using var client` disposal, STARTTLS conditional, AUTH-guard on empty User, 30s timeout, throws only `EmailSendException`, never logs credentials or body). `IEmailSender` extended with 3 methods (`SendPasswordResetEmailAsync`, `SendAppInviteEmailAsync`, `SendGroupInviteEmailAsync`); `NoOpEmailSender` extended to match. New `EmailTemplates` static class with plain-text German bodies. New `ISmtpOptionsAccessor` seam (Infrastructure→Api layer boundary respected). `Program.cs` conditional registration gated on non-empty Host + FromAddress with startup warning when disabled. Three call-sites (`AuthEndpoints.PasswordResetRequest`, `InviteEndpoints.CreateAsync`, `GroupEndpoints.CreateGroupInviteAsync`) wired through new `EmailDeliveryHelper.TrySendAsync` DRY helper (narrow `EmailSendException` catch, always swallows to preserve anti-user-enumeration response parity). netDumbster 3.1.1 (Apache-2.0) backs 5 `SmtpEmailSenderTests` (auth-fail, connection-refused, graceful-fallback paths). `.env.example` + `docker-compose.yml` dev passthrough for all 6 Smtp__ keys. **736 .NET (+25) + 257 Python + 694 web + 56 shared = 1743 green** + 3 skipped. **Zero deviations from plan §§1-9**. One non-blocking observation: lambda param `token` in `InviteEndpoints.CreateAsync` shadows outer invite-token string (C# resolves correctly; flagged LOW by simplify, deferred). Orchestrator-verified all 4 test gates green (`dotnet test` / `pytest` / `pnpm test` / `pnpm -F shared test`). |

## Last orchestrator tick

- **Time:** 2026-04-19 (PF1/PF2/PF3 + IF1 all green — pre-tag ready)
- **Action:** Four slices landed on `main` today under the 4-stage flow (impl → /simplify → /security-review → reviewer): **PF1** staged-photo auto-attach, **PF2** token-usage + AI cost tracking, **PF3** SMTP email sender, **IF1** pre-tag infra-fix (python-extractor 8g/6.0cpu + Hangfire WorkerCount env + deploy.yml .env backup + docs/ops.md runbook). All four test gates orchestrator-verified: **736 .NET + 257 Python + 694 web + 56 shared = 1743 green** (+ 3 skipped live-integration tests). Web build + lint clean. Live Azure-integration smoke green (real Azure Responses-API call returned in 4.18s). Orchestrator stripped 195-commit backlog down to pre-tag state on `main`.
- **Next:** Prompt user for optional video + vision live-smoke URLs (or skip to post-deploy VPS smoke) → `git tag v0.3.0` → push → GitHub Actions deploy → VPS smoke (containers, health, migrations, logs) → scp `.env` from VPS + seed `ORCHESTRATOR_PASSWORD` + gh secret PROD_ENV update → OPS1 orchestrator bot + smoke-live.sh → `v0.3.1` → deploy.

## Previous tick

- **Time:** 2026-04-18 (GR1 Grundrezept-Tags landed on main)
- **Action:** GR1 follow-up slice complete. 7 commits (4 TDD pairs — Domain enum, Infra seed migration, Web category rendering — plus 1 type-level shared update and 1 TDD-exempt EF migration and tracker update). Enum gains `TagCategory.Komponente` at integer 7 (Custom stays at 6 so existing rows don't re-categorize); EF migration `20260418193334_AddKomponenteTagCategory` seeds 7 global tags (`Grundrezept`, `Teig`, `Sauce`, `Glasur`, `Dressing`, `Beilage`, `Topping`) with stable `a0000007-…` GUIDs; filter panel, form tag-picker, and CreateTagDialog all render the new category in source order `Mahlzeit → Saison → Typ → Aufwand → Diät → Küche → Komponente → Custom`. Final counts: 447 .NET (+15) + 446 web (+4) + 32 shared = **925 green**. Docker stack healthy 6/6, migration applied on boot, `curl … | jq '[.[] | select(.category == "Komponente")] | length'` returns 7, full smoke script (13 steps) exits 0.
- **Next:** orchestrator idle — await user direction on remaining post-Phase-1.5 follow-ups (PDF export v2, toast library, dark-mode toggle v2).

## Blockers / pauses

_(none)_

## Autonomous execution mandate (2026-04-18)

User directive: run GM1 → UX1-RT → UX1-PU → full Phase 2 (P2-0…P2-10) autonomously without further approval. Stop only on hard blockers that make continuation impossible. Deviations from plan or PRD are to be **documented** inline in the per-slice entry below, not escalated.

- TDD + reviewer loop per sub-slice, same pattern as Phase 1 (DS1–DS7, GR1, DS8, BF1, AP1).
- Anti-shortcut checklist enforced by every reviewer.
- No deployment during this run — commits land on `main`, user triggers tagged deploy later.
- Phase 2 open architectural questions (#3 HMAC, #4 Azure-fail hard, #5 cost server-side, #6 rate-limit 10/50) default to the recommendations documented in `docs/plans/2026-04-18-phase-2-architecture.md`; orchestrator records the decision at each sub-slice kickoff.
- Hoppr chat reference path (`/Users/dkaulig/Projects/hoppr`) handed to P2-4 impl agent as read-only design source.

## Follow-up slices

- **GR1 — Grundrezept-Tags** — **done** 2026-04-18. 7 commits (`9f29ba4..d8b5a4a`); added `TagCategory.Komponente` (integer 7), seeded 7 global Komponente tags via `AddKomponenteTagCategory` migration, surfaced the new category in filter panel + form + create-tag dialog. 447 .NET + 446 web + 32 shared = 925 green; lint clean; docker smoke ok.

## Planned follow-ups (post-DS7)

**Order after DS8 lands:** BF1 → AP1 → GM1 → UX1-RichText → UX1-PhotoUpload. User-agreed 2026-04-18.

- **DS8 — Sage Modern redesign** — **done** 2026-04-18. 5 commits (`23fe5ae..fa67e69`); tokens + fonts + gradients swapped, 23 files swept clean of amber hex + Cormorant/Libre Baskerville. Plan at `docs/plans/2026-04-18-ds8-sage-modern-redesign.md`. 446 web + 447 .NET + 32 shared = 925 green; reviewer-verified with 1 follow-up fix (GroupDetailPage alert → destructive tokens).
- **BF1 — Quick Bugfixes** (est. 30-45 min, user-reported 2026-04-18):
  1. Ingredient amount field — placeholder is cut off; fix input width/padding.
  2. "Zuletzt geändert" shows role ("Admin") instead of user displayname — projection/mapping bug in revision history query.
  3. Umlaute rendered as `ae`/`oe`/`ue` in some strings instead of `ä`/`ö`/`ü` — likely a slugify/normalize helper applied to plain-text output where it doesn't belong. Audit usage sites.
  4. Header search icon routes to Groups overview — not useful; disable button + tooltip "bald verfügbar" until a real search view lands.
  5. Header notification bell has no function — remove the icon for now; re-add in Phase 2 when the notification backend exists.
  6. Home "Warm" (and other) filter chips jump into a seemingly random group — replace `goToBiggestGroup(preset)` with either a group-picker modal or route to a new `/rezepte?preset=warm` cross-group view. Pick the simpler option (picker modal if only one group, direct if user is in only one).
  7. Signup page (invite flow, `SignupPage.tsx`) has only one password input — add "Passwort bestätigen" field with client-side match validation (mirror what `ResetPasswordPage.tsx` already does). Error message if mismatch, block submit.
- **AP1 — User-Profil** (est. 45-60 min, original AP1 scope + password confirm): Change-password flow takes old password + new password + **confirm new password** (reject on mismatch client-side, reject on wrong old password server-side). Displayname change endpoint + inline edit on `ProfilStub`. TDD as usual.
- **GM1 — Group Management** (est. 2-3 h, user-requested 2026-04-18):
  1. Rename group — Admin-only PATCH `/api/groups/{id}` endpoint + edit dialog accessible from `GroupDetailHeader`.
  2. Invite link list + revoke — Admin sees all outstanding invite links for a group, can revoke (`DELETE /api/groups/{id}/invites/{inviteId}`). New `GroupInvitesPanel` component.
  3. Member management — Admin sees member list with roles, can change role (Member ↔ Admin), can remove members (`DELETE /api/groups/{id}/members/{userId}`). Safety: cannot remove last Admin.
- **UX1-RichText — Rich-Text Zubereitung** (est. 2-3 h, user-requested 2026-04-18): replace plain textarea for recipe steps with a Tiptap editor (bold, italic, lists). Store as Markdown or TipTap-JSON in DB. Sanitize on render. Accessibility: keyboard shortcuts + ARIA live region for toolbar state.
- **UX1-PhotoUpload — Create-mode photo upload** (est. 1-2 h, user-requested 2026-04-18 earlier): save-first-then-upload flow on the recipe create form.
- **Recipe composition (v2)**: cross-recipe linking where one recipe references another as a sub-ingredient (e.g. "Pizza Margherita verwendet 1× Pizzateig-Rezept"). Scales sub-recipe portions with the parent recipe. NOT in Phase 1 or 1.5; defer to Phase 2+.
- **Recipe PDF export (v2)**: download a recipe as a PDF for printing or sharing via email/WhatsApp/Telegram. Two plausible implementations: (a) print-friendly CSS + browser-native "Save as PDF" dialog — simplest, no server dep, acceptable quality; (b) server-rendered PDF via `QuestPDF` in .NET or headless Chromium in the Python extractor microservice — better typography + branding but more infra. User-requested 2026-04-18; defer to Phase 2.
- **Staged-photo sweep job (Phase 3 follow-up from P2-8 deviation)**: abandoned photos from `POST /api/recipes/photos/staged` currently share the `recipes/{guid}.ext` namespace with attached recipe photos (SeaweedFS filer has no zero-copy rename, so the promote-on-save pattern was skipped). A future sweep job needs a separate index — e.g. a new `StagedPhoto` DB table seeded at stage-time + cleared on recipe-save — so it can GC photos older than N hours without touching attached photos. Keep until storage cost matters; current volume is trivial.
- **SignalR live-updates (v2 / Phase 3)** — user-requested 2026-04-18. Real-time push for: new recipes created in a group, recipe edits (revision history), shopping list mutations, weekly-plan changes, membership changes. Implementation path: ASP.NET Core SignalR hub behind JWT auth; group-scoped connections (one hub connection per user, subscribes to their groups); frontend TanStack Query cache invalidation on received events (no manual refetch). Reconnect-on-disconnect + exponential backoff. Fits naturally with Phase 3 (Meal Planning + Shopping List) since those features need realtime anyway. Out of Phase 2 scope (which is AI-centric).

## Review outcomes

### DS1 — Review (2026-04-18) → pass

- **Commit range:** `5d778b1..HEAD` minus `31c1d6a` (orchestrator CI-fix, not DS1). 19 DS1 commits; all 7 primitives follow strict TDD (test-commit precedes matching feat-commit). Config commits (fontsource install, fontsource import, token mapping) are TDD-exempt per plan rules.
- **TDD pairs verified:** Button `aba4428→d4abc2a`, Card `9e8cced→f5de8dc`, Input `66f650f→35702d4`, Label `5e043db→6bd3e95`, Textarea `07e2f1b→b2c13fe`, Select `cd4dbd4→e1ddd76`, Badge `5e6eda2→3d03be3` (+ `fbc23a6` react-refresh chore follow-up).
- **Static checks:** zero `Assert.True(true)`, zero `it.skip`/`.only`, zero new TODO/FIXME/HACK, zero new `@ts-ignore`/`eslint-disable`/`pragma warning disable` beyond the pre-existing Phase-1 baseline (5 EF migrations, `useSession.ts`, `RecipeFilterPanel.tsx`), zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`.
- **Deliverables verified:** `@fontsource/{cormorant-garamond,inter,libre-baskerville}` added; `apps/web/src/styles/fonts.ts` imports the expected 11 CSS files; `main.tsx` imports fonts before `index.css`; no `googleapis`/`gstatic` references anywhere in `apps/web/src`; `index.css` `:root` tokens match the Warme-Küche spec (`--background 48 100% 96%`, `--foreground 20 14% 10%`, `--primary 32 95% 37%`, `--primary-foreground 48 100% 96%`, `--destructive 0 72% 51%`, `--ring 32 95% 37%`) with hex-mapping comments; `.dark` block present with inverted values; `@theme inline` block defines `--font-sans` (Inter), `--font-serif` (Cormorant Garamond), `--font-serif-body` (Libre Baskerville) per Tailwind 4.
- **Primitives:** Button, Card, Input, Label, Textarea, Select, Badge all present with co-located test files. Button default variant ships `bg-primary text-primary-foreground`, amber shadow `shadow-[0_1px_2px_rgba(120,53,15,0.1),0_4px_12px_-4px_rgba(180,83,9,0.4)]`, `hover:bg-[var(--primary-hover)]`, `active:scale-[0.99]`, transition; Badge has the `mini` variant with `bg-secondary text-secondary-foreground text-[11px] font-medium` matching the mockup `.mini-tag`.
- **Runtime:** `dotnet test apps/api/FamilienKochbuch.sln` → 427 passed, 0 skipped (176 Domain + 72 Infra + 179 API). `pnpm -C apps/web test --run` → 207 passed across 47 files (+28 vs. Phase 1's 179). `pnpm -C packages/shared test --run` → 32/32. `pnpm lint` → clean. `pnpm -C apps/web build` → succeeds, bundle self-hosts 22 WOFF/WOFF2 font assets, zero Google Fonts warnings.
- **Docker smoke:** `docker compose up --build -d` brought 6/6 services up (api, postgres, redis healthy; caddy, web, seaweedfs Up without healthcheck). `curl -sI http://localhost/` → 200, served CSS `/assets/index-Dm1Ftnjn.css` contains all three font family declarations and zero `googleapis|gstatic` references. `curl http://localhost/api/health` → `{"status":"ok",…}`. Stack cleanly torn down via `docker compose down`.
- **Token-class assertions:** `button.test.tsx` asserts `bg-primary` class lands on the default variant (spot-check satisfied). Multiple primitives' tests assert token-backed utility classes (bg-secondary, text-secondary-foreground, bg-destructive).
- **pnpm-lock integrity:** `git diff 5d778b1..HEAD -- pnpm-lock.yaml` shows only the three `@fontsource/*` entries and their lockfile metadata — no spurious dep bumps.
- **Deviations assessed:**
  - Native `<select>` over Radix — **accept**. Justified in `select.tsx` header comment; bundle saving is real, accessibility comes for free from the platform, and DS4/DS6 only need single-value selection.
  - Select chevron painted via inline `style` — **accept**. `select.tsx` comment explains the tailwind-merge `bg-*` collision and the surface-token preservation concern. Scoped to one primitive.
  - `--primary-hover` custom token — **accept**. Documented in the `index.css` header block; captures a literal amber-800 hover colour cleanly, enables dark-mode overrides, does not pollute the canonical shadcn token set.
- **Cleanup:** `git status` clean, `git log origin/main..HEAD` empty at review start.

**Verdict:** STATUS=pass. DS1 flipped to `done`, Completed 2026-04-18.

### DS2 — Review (2026-04-18) → pass

- **Commit range:** `36b0426..HEAD` contains 13 DS2 commits (all under this range; `36b0426` itself was the orchestrator dispatch tracker update and is excluded by the `..` syntax). Every non-trivial deliverable follows strict TDD (test-commit precedes matching feat-commit). The `AuthLayout` wiring commit `b786c08` is a config-grade router plumbing follow-up to the feat commit `0ec31d8` and is TDD-exempt per plan rules.
- **TDD pairs verified:** ChefHatLogo `074ec90 → 59f8839`, AuthLayout `8da110a → 0ec31d8` (+ `b786c08` router wire-up), LoginPage `8138dd8 → 40f0804`, SignupPage `005ddb5 → dc3c861`, ForgotPasswordPage `b883de2 → e50a4f7`, ResetPasswordPage `c562b3f → f722389`.
- **Static checks:** zero `Assert.True(true)`, zero `it.skip`/`.only` (package.json `test` scripts that `echo 'no tests yet'` are scripts, not tests), zero new TODO/FIXME/HACK, zero new `@ts-ignore`/`eslint-disable`/`pragma warning disable` beyond the Phase-1 baseline (5 EF migrations, `useSession.ts`, `RecipeFilterPanel.tsx`), zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`.
- **Deliverables verified:** `apps/web/src/components/brand/ChefHatLogo.tsx` (+ test) inlined from mockup SVG with `aria-hidden="true"` default; `apps/web/src/features/auth/AuthLayout.tsx` (+ test) mounting a shared brand header + parchment wrapper + `<Outlet />` + footer; `apps/web/src/App.tsx` wraps all four auth routes in `<Route element={<AuthLayout />}>`; `apps/web/src/index.css` defines the scoped `.auth-parchment::before` utility (fixed radial-gradient dotted grid using `hsl(var(--primary) / 0.06)` — no `body::before`, so protected routes get a clean background from DS3 onward).
- **Mockup fidelity (each page):**
  - **LoginPage:** hero `<h1>` "Was kochen wir heute?" with `font-serif`; italic Libre Baskerville tagline via `font-serif-body` + `italic`; kicker pill "Willkommen zurück" with leading amber-700 dot; DS1 Card + CardHeader + CardTitle + CardDescription + CardContent structure; E-Mail + Passwort fields; "30 Tage angemeldet bleiben" checkbox + "Passwort vergessen?" link; "Anmelden" Button `size="lg"` full-width; "oder" divider; invite footer "Du hast einen Einladungs-Link bekommen? · Jetzt registrieren →"; AuthLayout footer "© Familien-Kochbuch · privat & Gruppen-gated".
  - **SignupPage:** invite preview fetch (`/api/invites/app/:token`) preserved; kicker pill shows the inviter display name (`${inviterName} lädt dich ein`); German phrasing flows naturally; three fields E-Mail + Passwort + Anzeigename (labels render as "Anzeigename", "E-Mail-Adresse", "Passwort"); form disabled until preview resolves `ok`.
  - **ForgotPasswordPage:** title "Passwort zurücksetzen"; always-success copy "Wenn diese E-Mail existiert, haben wir einen Link geschickt. Schau in dein Postfach."; Button "Link anfordern".
  - **ResetPasswordPage:** title "Neues Passwort wählen"; two password fields (new + confirm); Button "Speichern"; auto-redirect to `/login` 1.2 s after success.
- **Runtime:** `dotnet test apps/api/FamilienKochbuch.sln` → 427 passed, 0 skipped (176 Domain + 72 Infra + 179 API). `pnpm -C apps/web test --run` → 229 passed across 51 files (+22 vs. DS1's 207). `pnpm -C packages/shared test --run` → 32/32. `pnpm lint` → clean. `pnpm -C apps/web build` → succeeds in ~216 ms, 65 PWA precache entries.
- **Docker smoke:** `docker compose up --build -d` brought 6/6 services up (api, postgres, redis healthy; caddy, web, seaweedfs Up without healthcheck by design). `curl -s http://localhost/login | grep -c "<html"` → 1 (SPA shell served, content hydrates client-side). `curl -s -o /dev/null -w "%{http_code}" http://localhost/api/health` → 200 (GET; the endpoint returns 405 for HEAD by design). Full E2E `bash scripts/smoke-test.sh` → all 13 steps green, exits 0. Stack cleanly torn down via `docker compose down`.
- **Accessibility:** ChefHatLogo ships `aria-hidden="true"` (decorative), consistent with the mockup's `<div class="logo" aria-hidden="true">` wrapper. AuthLayout's amber-tile chip around the logo also carries `aria-hidden="true"`. Inputs are all `<Label htmlFor>`-bound.
- **`data-testid` hygiene:** All DS2 testids are scoped to Route stubs inside test harnesses (`login`, `signup`, `forgot`, `home`, `child`) or primitive smoke-tests (ChefHatLogo passes `data-testid` through via `...rest`). Zero production `data-testid` leakage into the actual page JSX. Naming is purpose-descriptive and matches the anti-shortcut spirit.
- **Deviations assessed:**
  - **Kicker as inline `<span>`, not a Badge variant** — **accept**. The kicker is purely presentational text with a leading dot glyph; the existing DS1 Badge `mini` variant does not carry the `text-[12px] uppercase tracking-[0.1em] text-primary bg-primary/10` palette that this pill needs, and the four kickers intentionally diverge per-page ("Willkommen zurück", inviter name, "Alles halb so wild", "Fast fertig"). Introducing a `kicker` Badge variant for four single-use call sites would be over-abstraction. The inline span is locally readable, tokenised (`bg-primary/10`, `text-primary`), and does not leak styling into other slices. Revisit if a fifth kicker appears in DS3–DS7.
  - **CardTitle renders as `<h3>`, hero is `<h1>`, `<h2>` is skipped** — **accept**. The DS1 Card primitive's `<h3>` is shadcn-canonical and was already locked in by DS1's review. Auth pages are single-card layouts with no intermediate sections, so there is no honest `<h2>` to insert. The LoginPage test explicitly documents the choice (`// The shadcn CardTitle renders as <h3> (DS1 default).`). Skipping a level on a single-card page is tolerated by WCAG best-practice (not a failure), and forcing a fake `<h2>` would be less correct. The alternative — downgrading the hero to `<h2>` — would lose the page's primary heading landmark.
  - **Signup inviter copy** — **accept**. Kicker reads "`${inviterName} lädt dich ein`"; tagline adds "`${inviterName} lädt dich zum Familien-Kochbuch ein.` / Leg ein Konto an und koch mit." The German flows naturally, addresses the reader with "du" consistently, and gracefully falls back ("Einladung prüfen" / "Mit deinem Einladungs-Link bist du gleich dabei.") when the preview hasn't resolved yet. Tone matches the warm-family voice of the mockup.
  - **Signup copy assertion relaxed** — **accept**. The test uses `screen.findAllByText(/tante herta/i)` with `expect(mentions.length).toBeGreaterThanOrEqual(1)`. Because the inviter name appears in *both* the kicker pill and the italic tagline (the implementation renders two mentions by design), the test correctly tolerates either copy layout while still asserting the inviter is surfaced. `findAllByText` + `length >= 1` is a real assertion, not a placeholder, and it still fails if the name does not appear at all. This is a reasonable tolerance, not a shortcut.
- **Cleanup:** `git status` clean after docker teardown, `git log origin/main..HEAD` empty at review start.

**Verdict:** STATUS=pass. DS2 flipped to `done`, Completed 2026-04-18.

### DS3 — Review (2026-04-18) → pass

- **Commit range:** `3c92ed2..HEAD` contains exactly 21 DS3 commits. Every non-trivial deliverable follows strict TDD (test-commit precedes matching feat-commit). Two config-grade commits (`13aabc3` App.tsx routing wire-up, `c933f1e` GroupsPage cleanup that removes now-duplicated Abmelden + invite banner) are TDD-exempt per plan rules.
- **TDD pairs verified:** seasonalEveningLabel `ef6666b → 50c3b14`, localeTimeGreeting `6ac130e → 545e561`, recipePhotoGradient `7b26562 → 96f7c15`, useRecentlyCooked `59fd245 → f0ef330`, TopNav `562fe04 → f0015fe`, BottomNav `30c77a0 → 86af0c8`, AppLayout `3876197 → ac95a5c`, Stubs `07e4f20 → ff546a8`, HomePage `16eb02d → b4c402c`. ReceivedInvitesBanner restyle `94bcfaa` is an in-place visual edit on a pre-DS3 component with existing test coverage (no new TDD pair required — the existing banner tests still pass against the new styling, as is the plan intent).
- **Static checks:** zero `Assert.True(true)`/`Assert.True(false)`, zero `[Skip]`/`.Skip(`, zero `it.skip`/`it.todo`/`describe.skip`/`.only(`/`xit`/`xdescribe`, zero new TODO/FIXME/HACK/XXX across apps + packages, zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`. Existing `@ts-ignore`/`eslint-disable`/`pragma warning disable` baseline unchanged — same 5 EF migrations + `useSession.ts` + `RecipeFilterPanel.tsx` as DS1/DS2.
- **Deliverables verified:** `apps/web/src/components/layout/{TopNav,BottomNav,AppLayout}.tsx` (+ co-located test files); `apps/web/src/features/stubs/{WochenplanStub,ProfilStub}.tsx` (+ tests); `apps/web/src/features/recipes/{useRecentlyCooked.ts,recipePhotoGradient.ts}` (+ tests); `apps/web/src/lib/{greeting.ts,seasonalLabel.ts}` (+ tests); `apps/web/src/App.tsx` wires `AuthLayout` around auth routes and `AppLayout` (within `ProtectedRoute`) around Home, Gruppen, Rezepte, Wochenplan, Profil; `/wochenplan` and `/profil` routes present and mount the stub pages.
- **Component deep-dive:**
  - **TopNav:** brand lockup (amber-tile chef-hat + `font-serif` "Familien-Kochbuch"); three actions — Suchen (`Link` to `/groups` with `aria-label`), Benachrichtigungen (`button` with `aria-label`; red dot appears only when `useMyReceivedInvites().data.length > 0`, with `aria-hidden` on the dot itself), Avatar (`Link` to `/profil`, initial from `user.displayName[0]`); sticky top-0 z-20 + backdrop-blur + `bg-background/85` applied.
  - **BottomNav:** 5 items in the expected visual order Start / Gruppen / + FAB / Wochenplan / Profil. FAB is a 52×52 rounded-full amber-primary with `-mt-[14px]` translate, `shadow-[0_6px_20px_-4px_rgba(180,83,9,0.55)]`, and links to `/groups` so the user selects a target group before entering the recipe form (logic-correct given Home lacks group context — documented in the component's header comment). Start → `/`, Gruppen → `/groups`, Wochenplan → `/wochenplan`, Profil → `/profil`. Safe-area handled via `style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}`. `md:hidden` class present on the nav.
  - **AppLayout:** wraps `<TopNav />` + `<main>` with `<Outlet />` + `<BottomNav />`; `min-h-dvh flex-col bg-background`; main pads bottom `calc(88px+env(safe-area-inset-bottom))` on mobile, `md:pb-10` on desktop so fixed bottom nav doesn't clip content. No parchment pattern (auth-only, as spec requires).
  - **HomePage:** greeting kicker uses `localeTimeGreeting` + `user.displayName` (falls back to "willkommen"); `<h1 font-serif>Was kochen wir heute?</h1>` hero with `clamp(30px,7vw,40px)`; italic Libre Baskerville tagline "Ein schneller Tipp, was Hunger beruhigt." underneath; chip row is horizontally scrollable (`overflow-x-auto` + hidden scrollbar), primary "Schnell (< 30 Min)" chip first with amber fill + 5 other outline chips (Warm, Vegetarisch, Zufall, Sommer-/Winter-Abend, Wenig Aufwand); `<ReceivedInvitesBanner />` mounted directly below hero; "Meine Gruppen" section renders `GroupCard` grid + "+ Neue Gruppe anlegen" dashed card that opens `CreateGroupDialog`; "Zuletzt gekocht" renders `RecipeCard` grid using `useRecentlyCooked(biggestGroupId)` + friendly German `EmptyRecent` fallback when no recipes cooked yet.
- **Stub pages:** `WochenplanStub` renders serif `<h1>Wochenplan</h1>` + italic tagline + "Bald verfügbar" Card with Phase-3 note. `ProfilStub` renders serif `<h1>Mein Profil</h1>` + italic "Angemeldet als {displayName}" + "Bald verfügbar" Card + **preserves the Abmelden button** (calls `logout()` then navigates to `/login`, replacing history).
- **Chip-preset convention (DS3→DS4 hand-off):** `goToBiggestGroup(filterPreset)` navigates to `/groups/${biggestGroup.id}?preset=${encodeURIComponent(filterPreset)}`. 6 presets defined: `quick`, `warm`, `veggie`, `random`, `season`, `easy`. DS4 will consume `URLSearchParams.get('preset')` and wire each to the appropriate `useRecipeSearch` filter. No magic values hard-coded in the Group page yet (correct — DS3 is producer, DS4 is consumer).
- **Empty states:** When user has 0 groups, **every chip** opens `CreateGroupDialog` via `setShowCreate(true)` (goToBiggestGroup short-circuits when `biggestGroup === undefined`). When user has groups but 0 recent recipes, `EmptyRecent` renders with serif "Noch nichts gekocht." + contextual CTA ("Probier ein Rezept aus deiner Sammlung." → "Zu meinen Gruppen" button).
- **Accessibility:** TopNav icon-only buttons carry `aria-label` attrs (`"Suchen"`, `"Benachrichtigungen"`, `"Dein Profil"`, `"Familien-Kochbuch — Startseite"`). BottomNav items use `aria-label` mirroring the visible label; NavLink's active state surfaces as `aria-current="page"` (verified by tests). Bell dot carries `aria-hidden="true"`. FAB inner chevron icon also `aria-hidden="true"`. Avatar initial carries `title={user.displayName}` as hover hint. Chef-hat logo is decorative via `aria-hidden="true"` on its wrapper span.
- **Runtime:** `dotnet test apps/api/FamilienKochbuch.sln` → 427 passed, 0 skipped (176 Domain + 72 Infra + 179 API). `pnpm -C apps/web test --run` → 282 passed across 61 files (+53 vs. DS2's 229). `pnpm -C packages/shared test --run` → 32/32. `pnpm -C apps/web lint` → clean. `pnpm -C apps/web build` → succeeds in 217 ms (65 PWA precache entries, 459 kB JS, 63.7 kB CSS; fonts self-hosted, no Google Fonts network reference). Note: on the first parallel web-test run one test flaked (`<App /> > redirects to /login when silent refresh fails`) due to concurrent-task pressure waiting for the login hero to paint after redirect; the same test passed cleanly when run on its own (2/2) and the full-suite re-run was also 282/282. No real defect — the retry confirmed the suite is stable.
- **Docker smoke:** `docker compose up --build -d` brought all 6 services up (api, postgres, redis healthy; caddy, web, seaweedfs Up without healthcheck). Route checks — `/` 200, `/login` 200, `/groups` 200, `/wochenplan` 200, `/profil` 200, `/api/health` returns `{"status":"ok","timestamp":"…"}`. `curl` on `/wochenplan` served the `<!doctype html>` SPA shell (stubs hydrate client-side). Full E2E `bash scripts/smoke-test.sh` → all 13 steps green, exits 0 (login, app-invite, signup, re-login, group create, recipe create with 5 ingredients + 3 steps + 2 tags, rating, search, fork, revision log, recipe delete, group delete). Stack cleanly torn down via `docker compose down`.
- **Deviation assessments:**
  - **No desktop BottomNav (`md:hidden`)** — **accept**. Plan explicitly says "`BottomNav` mounts on mobile via Tailwind `md:hidden`; desktop gets a slimmer side-nav or repositioned header." DS3 implements the mobile path; desktop-side-nav polish is deferred to DS7 per the implementation comment in `AppLayout.tsx`. TopNav still provides desktop-viable brand + actions chrome, so the app is navigable at wider breakpoints. Sensible order-of-operations.
  - **Suchen icon routes to `/groups` (not a command palette)** — **accept**. Real search lives inside Group pages today (`RecipeFilterPanel`), so landing there is functional; DS7 will upgrade the icon to a command-palette modal per the TopNav header comment. No hollow `onClick={() => {}}` or stub toast — the link actually takes the user somewhere useful.
  - **Chip preset URL params (DS4 consumes)** — **accept**. Producer side is idiomatic (`?preset=quick`); encoding via `encodeURIComponent` is defensive. DS4's Group Detail slice can parse this cleanly with `useSearchParams`. The alternative (inventing a preset-catalog package now) would be premature abstraction for the 6 single-use filters. If DS4 discovers the mapping needs richer shape (e.g. multiple chip params composing), refactor then.
  - **Fractional Portionen shown as-is (e.g. "2.5 Portionen")** — **accept**. `defaultServings` is a `number` in the shared type (`packages/shared/src/types/groups.ts:15`) and `EditGroupDialog` already `Number.parseFloat`s user input (with an existing test asserting `defaultServings: 2.5` round-trips through the server). Rounding on display would *hide* information the user consciously entered — a 2.5-portion default often reflects a "2 big adults + 1 small kid" household, and silently showing "3 Portionen" would be misleading. German plural form ("Portion" vs. "Portionen") is already correctly handled (singular only when exactly `=== 1`, so 0.5 → "0.5 Portionen" reads naturally). Keep as-is.
- **Cleanup:** `git status` clean after docker teardown, `git log origin/main..HEAD` empty at review start.

**Verdict:** STATUS=pass. DS3 flipped to `done`, Completed 2026-04-18.

### DS4 — Review (2026-04-18) → pass

- **Commit count:** `git log --oneline 6684efb..HEAD | wc -l` → 18. Range matches the plan (18 implementation commits since the orchestrator dispatch commit `6684efb`; no orchestrator commit inside the range).
- **TDD pairs verified (strict ordering — test-commit precedes feat-commit in every case):**
  - `getGroupAvatarGradient` — test `0b99c18` → feat `5d4ba37` ✓
  - `applyFilterPreset` + `currentSeasonTagName` — test `b922fbb` → feat `4a079da` ✓
  - `GroupDetailHeader` — test `6b1e8a9` → feat `52d0868` ✓
  - `GroupFilterBar` — test `a074b84` → feat `43157ef` ✓
  - `RecipeGridCard` — test `268d295` → feat `1f095df` ✓
  - `RecipeFilterPanel` restyle — test `3afefec` → feat `054a6c8` ✓
  - `GroupDetailPage` restyle — test `ca2cb7c` → feat `7307927` ✓
  - Follow-ups: `0a81835` (`usePresetConsumer` extraction), `3e3a73e` (initial-mount guard on debounced search effect), `43c3639` (`ActiveFilterChips` extraction) — each pushes behaviour already covered by preceding tests (preset consumption, active-chip rendering) and is a pure extraction/hardening, so no additional failing-test commit required.
  - Chore: `fc35c56` (remove accidental playwright screenshots from repo root) — one-off hygiene, no tests.
- **Static checks:** zero `Assert.True(true)`/`Assert.True(false)`, zero `[Skip]`/`.Skip(`, zero `it.skip`/`it.todo`/`describe.skip`/`.only(`/`xit`/`xdescribe` in production tests, zero new `TODO`/`FIXME`/`HACK`/`XXX` across apps + packages, zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`.
- **`eslint-disable` additions (2 new, both justified):**
  - `apps/web/src/features/search/usePresetConsumer.ts:45` — `react-hooks/exhaustive-deps` suppressed on an effect keyed only on `[presetParam, options.tagsReady]`. Comment: "run once per preset+tags ready". Including `params` or `setParams` (both change on every `setParams(...)` call the effect itself performs) would create an infinite-loop: preset is consumed → `setParams` strips it → effect re-fires → reads stale state. The design intent is explicit: the effect is a one-shot consumer per (preset, tags-ready) tuple. **Accept.**
  - `apps/web/src/features/groups/GroupDetailPage.tsx:82` — `react-hooks/exhaustive-deps` suppressed on the debounced search effect keyed on `[searchInput, hasUserTyped]`. Comment: "only searchInput/hasUserTyped drive the debounce". Including `searchParams` or `setSearchParams` would force a resync on every URL change (including the ones this very effect pushes via `setSearchParams(nextParams, { replace: true })`), collapsing the 300 ms debounce window. The `hasUserTyped` flag elsewhere in the file is the explicit guard that prevents the initial mount from clobbering an inbound `?preset=…` param. **Accept.**
  - Neither disable could be cleanly fixed with `useCallback`/`useRef` wrapping because the dependency that lint wants included (`params`/`setParams` / `searchParams`/`setSearchParams`) is itself the reactive value whose reactivity would defeat the intended semantics. Both are single-line opt-outs with explicit WHY comments. Existing baseline (`useSession.ts` + `RecipeFilterPanel.tsx` from DS1-era + 5 EF migrations) unchanged.
- **Deliverables verified:** `apps/web/src/features/groups/{GroupDetailHeader,GroupFilterBar,GroupDetailPage}.tsx` (+ co-located test files); `apps/web/src/features/groups/groupAvatarGradient.{ts,test.ts}`; `apps/web/src/features/recipes/RecipeGridCard.{tsx,test.tsx}`; `apps/web/src/features/search/{presets,urlState}.ts` + `{presets,ActiveFilterChips,RecipeFilterPanel}.test.{ts,tsx}`; `apps/web/src/features/search/{usePresetConsumer,ActiveFilterChips}.tsx`. `GroupDetailPage.tsx` composition grep confirms imports and usage of `GroupDetailHeader`, `GroupFilterBar`, `RecipeGridCard`, `ActiveFilterChips`, and `usePresetConsumer`.
- **Component deep-dive:**
  - **GroupDetailHeader** — cover banner (3-layer gradient: linear base + 2 radial warm-amber spots, `#fef3c7` fallback color); overlapping avatar wrapper uses `relative z-10 -mt-[36px]` for deterministic stacking above the cover; avatar itself is 72×72 rounded-[20px] with `border-4 border-background` and amber shadow. Members stack truncates at 3 via `group.members.slice(0, 3)` + `+N` chip for `max(0, memberCount - shown.length)`. Stats row renders three spans: recipe count (`BookOpen` icon), members stack + total + singular/plural, `Standard {defaultServings} Portion(en)`. Cover is gradient-only — no `coverImageUrl` branch, because the shared `GroupDetail` type doesn't expose one yet.
  - **GroupFilterBar** — `<input type="search">` wrapped in a `flex flex-1` label with leading `Search` icon; toggle button shows "Filter" + optional count-badge pill (`bg-primary px-[7px] py-[1px]`) when `activeFilterCount > 0`; Zufall button uses `bg-destructive` + red shadow + `active:scale-[0.98]`. `aria-expanded` on the toggle exposes panel open state. Disabled state + "Würfle…" copy while `isRandomPending`.
  - **RecipeFilterPanel** — 7 tag categories in `CATEGORY_ORDER = ['Mahlzeit','Saison','Typ','Aufwand','Diaet','Kueche','Custom']`; each category section renders chip buttons with `aria-pressed` toggle semantics and hover/focus rings. Min-rating slider 0–5 step 1, accent-primary; max-prep slider 10–240 step 5 with a `n <= 10 ? undefined : n` floor-clear so dragging to the minimum removes the filter. Creator + sort selects on a shared row. `usePresetConsumer` is ALSO wired here (as a safety net for standalone panel usage), not just at the page level — this is deliberate redundancy documented in the file comment.
  - **RecipeGridCard** — 4:3 `aspect-[4/3]` photo area; `recipe.photo` when set, otherwise `recipePhotoGradient(recipe.id)` (DS3 hashed-gradient helper); rating pill overlays top-right with `Star` + German decimal comma (`.toFixed(1).replace('.', ',')`) only when `avgRating != null`; title in `font-serif text-[17px]`; meta line shows `{prepTimeMinutes} Min · {createdByDisplayName}` with graceful dividers; up to 2 mini-tag chips (amber bg `hsl(48_96%_89%)`, 10.5 px) resolved from the passed-in `tags` pool. `<Link to={`/groups/${recipe.groupId}/recipes/${recipe.id}`}>` wraps the whole card.
  - **GroupDetailPage** — composition grep confirms all 5 imports. Sticky sub-top-nav at `top-[56px] z-[9]` (below global `TopNav` at `top-0 z-20`) with back button, group name, meta line, settings gear. `usePresetConsumer` mounted at page level (before the `filterPanelOpen` toggle gate) so chip arrivals fire regardless of panel state. FAB is a 56×56 primary-amber circle fixed `right-4` + `style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}` — clears the 88 px BottomNav height + a 8 px gap + the iOS home-indicator inset; no overlap with the BottomNav's centre FAB (which is positioned by the nav container, not `position: fixed`). Empty states: "Noch keine Rezepte · Leg gleich eines an …" CTA and "Kein Treffer · Filter zurücksetzen" — both rendered via the `EmptyState` sub-component based on `hasFiltersOrQuery`.
- **Runtime:**
  - `dotnet test apps/api/FamilienKochbuch.sln` → 427 passed (176 Domain + 72 Infrastructure + 179 API), 0 failed, 0 skipped. Note: the first run flaked one Infrastructure test (`Argon2idPasswordHasherTests.VerifyHashedPassword_Fails_On_Tampered_Hash`) under parallel CPU pressure — a deliberately-slow KDF's known sensitivity to concurrent-test load. The same test passed cleanly in isolation (1/1) and on a repeat full-suite run (427/427). No real defect.
  - `pnpm -C apps/web test --run` → **342 passed** across 67 files. Delta versus DS3's 282 is **+60** (agent self-reported 336-342; reality is the upper bound). Growth covers the 4 new helpers/hooks, 4 new components with extensive prop matrices (filter-count rendering, preset consumption flow, empty-state branching, rating pill, members-stack truncation, and the 300 ms debounced-search guard), plus the restyled panel/page test rewrites.
  - `pnpm -C packages/shared test --run` → 32/32.
  - `pnpm lint` → clean (ESLint passes with zero errors; pre-existing baseline warnings unchanged).
  - `pnpm -C apps/web build` → succeeds in 213 ms; 65 PWA precache entries, 468 kB JS / 71 kB CSS, self-hosted fonts, no Google Fonts references.
- **Docker smoke:** `docker compose up --build -d` brought all 6 services up; 22 s after boot `docker compose ps` shows api / postgres / redis healthy, caddy / web / seaweedfs up (no healthcheck by design). `curl http://localhost/api/health` → `{"status":"ok","timestamp":"2026-04-18T17:49:44.0101468+00:00"}`. Full E2E `bash scripts/smoke-test.sh` → all 13 steps green (login, app-invite, signup, re-login, group create, recipe create with 5 ingredients + 3 steps + 2 tags, rating, search, fork, revision log, recipe delete, group delete), exit 0. Stack cleanly torn down via `docker compose down`.
- **Preset consumption flow covered:** `RecipeFilterPanel.test.tsx` verifies the URL contract explicitly — `preset=quick` preselects the "schnell" tag and sets `maxPrepTime=30`, `preset=warm` preselects "warm", `preset=veggie` preselects "vegetarisch", and in each case the post-consumption URL no longer contains `preset=…`. The flow from Home quick-chip → `/groups/:id?preset=quick` → `applyFilterPreset('quick')` → `/groups/:id?tags=…&maxPrepTime=30` is end-to-end tested.
- **BottomNav + FAB co-existence:** BottomNav's centre `+`-FAB is positioned by the nav's inline flex layout (not `position: fixed`), and the GroupDetailPage's context FAB is `position: fixed; right: 1rem; bottom: calc(96px + env(safe-area-inset-bottom, 0px))`. The 96 px vertical offset clears the BottomNav's 88 px visual height + an 8 px gap and respects iOS home-indicator safe-area. No overlap on 375 px viewport — verified by math (BottomNav sits at `bottom: 0` with height ≤ 88 px; context FAB starts at `bottom: 96px+env(…)` ≥ 96 px). Visually the two FABs occupy different regions (centre vs. bottom-right) and different z-stacks.
- **Deviation assessments (all 6):**
  - **`prepTimeMinutes` optional on `RecipeGridCard`** — **accept**. The `RecipeSummaryDto` type from `@familien-kochbuch/shared` does not carry `prepTimeMinutes`; only the full `RecipeDto` does. `GroupDetailPage` passes `prepTimeMinutes={null}` per row rather than issuing 20 extra GETs just to display "• 45 Min" on each card. The prop is typed `number | null` so callers with richer data (future: when the search endpoint includes it) can wire it without changing the card's API. The meta-line renders gracefully without it (just "{creator}" with no leading dot). Correct trade-off: keep the card pure-render, surface the degradation in the UI (meta row stays readable), and keep the network contract honest. If DS5 later extends the search payload, the card already supports the full variant.
  - **Prep-time slider floor clears filter (`n <= 10 ? undefined : n`)** — **accept**. The mockup's slider visually starts at 10 minutes, but intuitively a user dragging back to the leftmost position means "I don't care about prep time any more", not "show me only recipes under 10 minutes". Mapping the floor value to `undefined` clears the filter cleanly rather than locking the user into a permanent 10-min ceiling once they move the slider. The active-chip row's `Max ≤ X Min` chip disappears accordingly. The min-rating slider follows the same pattern at 0. Both behaviours are documented with dedicated tests in `RecipeFilterPanel.test.tsx` (presets + active chips).
  - **Contextual FAB position above BottomNav (`bottom: calc(96px + env(safe-area-inset-bottom, 0px))`)** — **accept**. Mobile-FAB + mobile-BottomNav co-existence verified: BottomNav container height ≈ 88 px (10 px top + 52 px FAB + 26 px safe-area) positioned at `bottom: 0`; context FAB sits at `bottom ≥ 96 px`. No overlap at 375 px viewport. The safe-area-inset addition handles iPhone home-indicator correctly. Alternative (hiding the BottomNav on GroupDetailPage) would cost the user quick access to Home/Profil/Wochenplan; alternative (routing the BottomNav centre FAB to `/groups/:id/recipes/new` contextually) would overload the BottomNav semantics. Keeping two distinct FABs — global "create group/pick group" vs. contextual "add recipe here" — is the correct IA.
  - **Cover banner gradient only (no `coverImageUrl` branch)** — **accept**. The `GroupDetail` type in `packages/shared` does not currently expose a cover-image URL (domain model has `avatarColor` + the implicit amber gradient; S1/S2 scoped covers out). Adding a branch now would be speculative: the agent would have to invent a storage path format that Phase-3 may or may not match. The current implementation pins a deterministic 3-layer gradient into the section so every group gets a warm banner regardless of data shape. When a future slice lights up `coverImageUrl`, adding a conditional `backgroundImage` override is a one-line change. Correct YAGNI.
  - **`usePresetConsumer` extraction + search-mount guard (`hasUserTyped`)** — **accept**. Two-part fix for a real bug: initially the debounced-search effect fired on mount, which wrote `writeFiltersToSearchParams(filtersWithoutQ)` and wiped the `?preset=…` param before `usePresetConsumer` got to read it. The fix extracts the preset consumer into a reusable hook mounted at the page level (before the filter panel), and guards the debounce effect with a `hasUserTyped` flag flipped only on real `onSearchChange` callbacks. Clean separation of concerns, documented in the file comments, and tested via the `preset=quick/warm/veggie` RecipeFilterPanel tests. Good engineering response to a TDD-discovered regression.
  - **`ActiveFilterChips` extraction** — **accept**. The chip row used to live inside `RecipeFilterPanel`, but DS4 needs the chips visible whenever filters are applied — even when the panel body is collapsed. Extracting the chip row to a standalone component (`apps/web/src/features/search/ActiveFilterChips.tsx`) lets `GroupDetailPage` mount it always-when-`activeFilterCount > 0`, while `RecipeFilterPanel` mounts the expanded body only when toggled open. Both consumers share the exact same URL-driven state via `useSearchParams` + `readFiltersFromSearchParams`, so no duplication. Co-located test file exists. Clean extraction, no functional regression.
- **Cleanup:** `git status` clean after docker teardown, `git log origin/main..HEAD` empty at review start (0 unpushed commits).

**Verdict:** STATUS=pass. DS4 flipped to `done`, Completed 2026-04-18.

### DS5 — Review (2026-04-18) → pass

- **Commit count:** `git log --oneline a4fc31e..HEAD | wc -l` → 21. Range matches the plan (21 DS5 implementation commits since the orchestrator dispatch commit `a4fc31e`; no orchestrator commit inside the range).
- **TDD pairs verified (strict ordering — test-commit precedes feat-commit in every case):**
  - Cook endpoint (API) — test `7333b90` → feat `ab83473` ✓
  - Client cook plumbing (API wrapper + hook) — test `ab6ca17` → feat `56bde8c` ✓
  - RecipeForkBanner — test `70c2afd` → feat `3773626` ✓
  - PortionStepperCard — test `957a058` → feat `cce95f3` ✓
  - IngredientChecklist — test `1a100ad` → feat `f08f644` ✓
  - StepList — test `d25e10d` → feat `81d43d9` ✓
  - RecipeActionBar — test `1e756da` → feat `b72669b` ✓
  - RecipeDetailHeader — test `bd6b3a5` → feat `b1356f3` ✓
  - RatingWidget restyle — `69d5218` (refactor; 4 existing S4 tests stay green) ✓
  - RecipeHistoryPanel restyle — `e87248e` (refactor; 3 existing S6 tests stay green) ✓
  - RecipeDetailPage compose — `f68f091` (updates 9 existing tests to the new DOM + adds 1 new test for the sticky "Jetzt gekocht" button → 10 green) ✓
  - Lint fixes — `b6cf822` ✓
  - TopNav suppression + AppLayout — `085c2a9` (two new AppLayout tests pin the detail-route hide + edit-route keep contract) ✓
- **Static checks:** zero `Assert.True(true)`/`Assert.True(false)`, zero `[Skip]`/`.Skip(`, zero `it.skip`/`it.todo`/`describe.skip`/`.only(`/`xit`/`xdescribe` in production tests, zero new `TODO`/`FIXME`/`HACK`/`XXX` across `apps/` + `packages/`, zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`.
- **`eslint-disable` / `pragma warning disable` baseline unchanged (no DS5 additions):** 5 EF migrations + `useSession.ts` (S2) + `usePresetConsumer.ts` (DS4) + `GroupDetailPage.tsx` (DS4). Zero new disables introduced by DS5.
- **Deliverables verified:** `apps/web/src/features/recipes/` contains `RecipeDetailHeader.tsx`, `PortionStepperCard.tsx`, `IngredientChecklist.tsx`, `StepList.tsx`, `RecipeActionBar.tsx`, `RecipeForkBanner.tsx` (each with a co-located `*.test.tsx`), plus the restyled `RatingWidget.tsx` (S4) and `RecipeHistoryPanel.tsx` (S6). `markRecipeAsCooked` and `useMarkAsCooked` live in `recipesApi.ts` + `hooks.ts`. `POST /api/recipes/{id}/cook` is wired in `RecipeEndpoints.cs:164`. `Recipe.MarkCooked(DateTimeOffset)` is implemented in `Recipe.cs:142`. `ProjectDetailAsync` carries `LastCookedAt` into the detail DTO (`RecipeEndpoints.cs:122,243`).
- **Cook endpoint deep-dive (`RecipeEndpoints.cs:819-839`):**
  - Uses `TimeProvider` injected as `clock` (no `DateTimeOffset.UtcNow` direct call).
  - Auth gate: `TryGetUserId` → 401 if unauth; `IsGroupMemberAsync` → 403 if non-member; `LoadRecipeWithChildrenAsync` → 404 if not found.
  - Persists via `await db.SaveChangesAsync(ct)` after `recipe.MarkCooked(clock.GetUtcNow())`.
  - Returns `Results.Ok(detail)` with the refreshed `ProjectDetailAsync` DTO.
  - Does NOT touch `RecipeRevision` anywhere in the handler — purely stamps `LastCookedAt` and persists.
  - 5 integration tests in `RecipeEndpointsTests.cs:972-1080`: 200 + updated timestamp (member), 403 (non-member), 404 (unknown id), 401 (unauthenticated), `MarkCooked_Does_Not_Append_Revision` (count-before == count-after).
- **RecipeDetailPage composition (`RecipeDetailPage.tsx`):** mounts `<RecipeDetailHeader />`, `<PortionStepperCard />`, "Zutaten" heading + `<IngredientChecklist />`, "Zubereitung" heading + `<StepList />`, optional source-URL link, "Bewertungen" heading + `<RatingWidget />`, `<RecipeHistoryPanel />`, and `<RecipeActionBar />` (plus the existing `<ForkRecipeDialog />`). `servings` state lives on the page (initialized to `null`, falls back to `recipe.defaultServings`) and flows into `PortionStepperCard` + `IngredientChecklist` via props — no shared store needed. Loading branch renders 5 `<Skeleton>` placeholders from S7 matching the section rhythm. Error branch renders a `role="alert"` "Rezept konnte nicht geladen werden." + "Zur Gruppe" back button. 404 from the API lands in the same error branch via `detail.isError`.
- **TopNav suppression (`AppLayout.tsx:22-41`):** two `useMatch` checks — `'/groups/:groupId/recipes/:recipeId'` and `'/groups/:groupId/recipes/:recipeId/edit'`. `hideTopNav` is true only when the detail route matches and the edit route does NOT. Two new `AppLayout.test.tsx` tests (lines 84-96) cover both branches: detail route hides the banner, edit route renders it plus the edit child. Existing TopNav mount + BottomNav tests unaffected.
- **RecipeDetailHeader (`RecipeDetailHeader.tsx`):** `useEffect` attaches a passive `window.scroll` listener; threshold = `heroRef.current.offsetHeight - 56`; cleanup returns `removeEventListener` on unmount. Hero branch uses `recipe.photos[0]` when present, otherwise inline `backgroundImage` style via `recipePhotoGradient(recipe.id)` with a two-stop shadow overlay. Camera + "Foto 1 / N" counter rendered bottom-right when `totalPhotos > 0`. Title card overlaps the hero via `-mt-10` (equivalent to `-40px`) with `rounded-[24px]` + amber shadow. Tag row uses `<Badge variant="mini">` per assigned tag. Stat row shows rating pill (hidden when `avgRating == null`) + prep time + difficulty label + creator via `User` icon. Fork banner only renders when `recipe.forkOfRecipeId != null`. Overflow menu exposes fork / edit / delete via parent callbacks (`aria-haspopup="menu"` + `aria-expanded`).
- **IngredientChecklist (`IngredientChecklist.tsx`):** each row is a `<button role="checkbox" aria-checked>`. Scaling is delegated to `scaleIngredients()` from `@familien-kochbuch/shared` inside a `useMemo` keyed on `[ingredients, defaultServings, servings]`. `AmountText` splitter renders "nach Geschmack" / "eine Prise" inside an `<em>`, and splits "`N Stück`" so the "Stück" / "Stk" / "Stueck" unit word gets italic treatment while the number keeps tabular-nums. Session state is `useState<Set<string>>` keyed on ingredient id (with `pos-N-i` fallback when the DTO id is undefined).
- **StepList (`StepList.tsx`):** numbered step cards sorted by `position`. 32×32 amber avatar on the left with `font-serif` step number; right column runs text through `renderInlineMarkdown`. Header comment documents the scope and notes "swap to react-markdown is a 1-file change". Bold-then-italic precedence (no triple-asterisk support). Test suite covers bold, italic, plain text, shuffled ordering, and empty array.
- **RecipeActionBar (`RecipeActionBar.tsx`):** two buttons — ghost "In Wochenplan" (Calendar icon) + primary "Jetzt gekocht" (Check icon). "In Wochenplan" fires `handleWochenplanClick` which sets a status "Wochenplan kommt in Phase 3." (surfaced via `role="status"`). "Jetzt gekocht" calls the parent-supplied `onMarkCooked` promise, disables during `markCookedPending`, and surfaces success via `role="status"` + errors via `role="alert"`. Both messages also render into `sr-only` `aria-live` regions (polite + assertive). Zero toast library imports — the header comment explicitly justifies this.
- **Runtime:**
  - `dotnet test apps/api/FamilienKochbuch.sln` → 432 passed (176 Domain + 72 Infrastructure + 184 API; +5 from DS4's 427 = the 5 new cook-endpoint tests).
  - `pnpm -C apps/web test --run` → **392 passed** across 73 files (+50 vs. DS4's 342 — matches the agent's 392 claim exactly).
  - `pnpm -C packages/shared test --run` → 32/32.
  - `pnpm lint` → clean.
  - `pnpm -C apps/web build` → succeeds in 229 ms (65 PWA precache entries, 485 kB JS / 78 kB CSS, self-hosted fonts).
  - Total: 432 + 392 + 32 = 856 green (matches the claimed total).
- **Docker smoke:** `docker compose up --build -d` brought all 6 services up (api / postgres / redis healthy; caddy, web, seaweedfs Up without healthcheck by design). `curl -s http://localhost/api/health` → `{"status":"ok","timestamp":"2026-04-18T18:28:36.7271985+00:00"}`. Full E2E `bash scripts/smoke-test.sh` → all 13 steps green (login, app-invite, signup, re-login, group create, recipe create with 5 ingredients + 3 steps + 2 tags, rating, search, fork, revision log, recipe delete, group delete), exit 0. Stack cleanly torn down via `docker compose down`.
- **E2E cook flow (manual curl sequence):**
  - Step 33: `GET /api/recipes/{R1}` → `lastCookedAt: null` (pre-cook).
  - Step 34: `POST /api/recipes/{R1}/cook` → `200` + body with `lastCookedAt: 2026-04-18T18:30:08.6866065+00:00` (ISO-8601).
  - Step 35: `GET /api/recipes/{R1}` → `lastCookedAt: 2026-04-18T18:30:08.686606+00:00` (persisted).
  - Step 36: `GET /api/recipes/{R1}/revisions` → count = 1 (the `Created` entry from step 32; cook did NOT append a revision — contract pinned).
  - Step 37: fresh non-member user (signup via invite, not added to admin's Private Sammlung) `POST /api/recipes/{R1}/cook` → `403`.
  - Step 38: `POST /api/recipes/00000000-0000-0000-0000-000000000000/cook` → `404`.
- **Two FABs don't conflict:** the GroupDetailPage contextual FAB is offset via `bottom: calc(96px + env(safe-area-inset-bottom, 0px))` (DS4 convention, unchanged). The RecipeActionBar is a full-width sticky bar at `fixed bottom-[calc(env(safe-area-inset-bottom,0px)+72px)]` on mobile / `md:bottom-[env(safe-area-inset-bottom,0px)]` on desktop. The recipe detail route doesn't render the GroupDetailPage at all (different `path`), so there is no geometric overlap — only one action surface per page.
- **ServingStepper ↔ IngredientChecklist coupling:** `servings` lives on `RecipeDetailPage` (`useState<number | null>(null)`) and is passed as a prop to both children. `IngredientChecklist.test.tsx` includes "quantity display re-scales when servings prop changes" — exercises the live recomputation end-to-end.
- **Scroll listener cleanup:** `RecipeDetailHeader.tsx:73-83` returns `window.removeEventListener('scroll', onScroll)` from the `useEffect` cleanup function. No test pins this explicitly, but the pattern is React-idiomatic and the function identity is stable across renders (closed over the ref). Readthrough confirmed.
- **Deviation assessments (all 5):**
  - **No toast library (inline aria-live)** — **accept**. The app has no existing toast system; pulling one in for one component would add a provider + dep for zero reuse value. The `sr-only` aria-live wrappers (polite for status, assertive for errors) plus a visible floating pill above the action bar deliver the same UX with first-class screen-reader support. When a future slice adopts a global toast, the notifier is a 10-line removal.
  - **Fork-banner title = current recipe's title** — **accept**. The `RecipeDetailDto` exposes `forkOfRecipeId` but not the original's title; fetching it would require an extra GET + an access check (forks can outlive their sources). Fork creation copies the original's title into the new recipe, so on first render the two are identical. Using the current title is accurate at fork time and a reasonable stand-in afterwards; the link still resolves to `/recipes/{originalRecipeId}`. If the stand-in proves misleading in practice, `forkOfRecipeTitle` is a one-field DTO extension.
  - **TopNav suppression on detail route only** — **accept**. Detail page owns a scroll-aware floating top bar overlaid on the hero; stacking the shared `TopNav` above it would produce two chrome strips. Scope is precise — edit route keeps the shared nav because it has no hero. Two AppLayout tests pin both branches.
  - **Hand-rolled Markdown in StepList** — **accept**. Mockup + existing step corpus only use `**bold**` and `*italic*`. A ~30-line pure-function renderer with exhaustive tests beats pulling `react-markdown` + its remark/unified tree for that scope. Header comment flags the swap-to-react-markdown path as a one-file change. Triple-asterisk (bold+italic) is intentionally not supported — no corpus entry needs it.
  - **`MarkCooked` does not append a revision** — **accept**. The revision log tracks content changes (`Created`, `Edited`, `Forked`). Cooking is an activity signal for the recency sort + "Zuletzt gekocht" grid — writing a revision per tap would flood the history panel with noise. The `MarkCooked_Does_Not_Append_Revision` integration test pins the contract; the E2E cook flow reviewer-ran today confirmed the revision count stays at 1 through a cook call.
- **Cleanup:** `git status` clean after docker teardown, `git log origin/main..HEAD` empty at review start (0 unpushed commits).

**Verdict:** STATUS=pass. DS5 flipped to `done`, Completed 2026-04-18.

### DS6 — Review (2026-04-18) → pass

- **Commit count:** `git log --oneline bc507fa..HEAD | wc -l` → 16. Range matches the plan (16 DS6 implementation commits since the orchestrator dispatch commit `bc507fa`; no orchestrator commit inside the range — 16 impl + 1 orchestrator prefix = 17 total touching DS6 scope).
- **TDD pairs verified (strict ordering — test-commit precedes feat-commit in every case):**
  - CharCounter — test `c2d5e48` → feat `6798ab8` ✓
  - DifficultyPills — test `b117c63` → feat `055e5dd` ✓
  - RecipeFormTopNav — test `4a29e71` → feat `dbcd9ac` ✓
  - AppLayout suppression on form routes — test `72584ec` → feat `0ad9360` ✓
  - FormIntro — test `7db7d89` → feat `ed6967b` ✓
  - PhotoUploadGrid — test `246012d` → feat `4d40b4a` ✓
  - FormActionBar — test `acb37cb` → feat `4c915ef` ✓
  - RecipeFormPage restyle — `8bda427` (single `refactor(web)` commit that composes the 6 new blocks into the existing page; 9 pre-existing behavioural tests, including the S3-fix-pass keyboard-reorder pair for ingredients + steps, stay green unchanged — TDD-exempt per plan rules since no new behaviour is being added, only layout + composition) ✓
  - Integration coverage — `7186414` adds 8 wired tests on top of the composed page (form top bar draft tagline, italic intro tagline, live CharCounter, difficulty-pill round-trip, tag-chip toggle + submit, `nach Geschmack` unit forces `quantity=null` + `scalable=false`, Portionen clamp-to-1). The pattern here (feat-first then add-integration-tests-on-top) is correct because each newly-composed behaviour is an emergent property of already-tested primitives, not new logic — the 8 new cases pin the wiring, and every pinning case exercises a code path that the primitive tests do not already cover. ✓
- **Static checks:** zero `Assert.True(true)`/`Assert.True(false)`, zero `[Skip]`/`.Skip(`, zero `it.skip`/`it.todo`/`describe.skip`/`.only(`/`xit`/`xdescribe` in production tests, zero new `TODO`/`FIXME`/`HACK`/`XXX` across `apps/` + `packages/`, zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`.
- **`eslint-disable` / `pragma warning disable` baseline unchanged (no DS6 additions):** 5 EF migrations + `useSession.ts` (S2) + `usePresetConsumer.ts` (DS4) + `GroupDetailPage.tsx` (DS4). Zero new disables introduced by DS6.
- **Deliverables verified:** `apps/web/src/features/recipes/` contains the 6 new DS6 components (`CharCounter.tsx`, `DifficultyPills.tsx`, `RecipeFormTopNav.tsx`, `FormIntro.tsx`, `PhotoUploadGrid.tsx`, `FormActionBar.tsx`) each with co-located test files, plus the restyled `RecipeFormPage.tsx` + `RecipeFormPage.test.tsx`. The legacy `PhotoUploader.tsx` is deleted (confirmed: not present in the features/recipes listing; deletion occurred in `8bda427`). `AppLayout.tsx` has the updated `useMatch` logic distinguishing `:recipeId !== 'new'` from real detail routes.
- **Component deep-dive:**
  - **CharCounter** — renders `{count} / {max}` with `aria-live="polite"`; tone gradient is neutral → `text-amber-700` at ≥ 80% ratio → `text-[hsl(var(--destructive))]` at hard limit. Pure projection; does not enforce the limit (the native `maxLength` does). Character count uses `[...value].length` so surrogate pairs count as one unit.
  - **DifficultyPills** — three flex-1 pills with `role="group"` + `aria-label="Schwierigkeit"`. Each pill is a `<button aria-pressed={selected}>` with level-count dot glyphs (1/2/3 filled circles via `Array.from({length: level})`). Selecting the already-active pill is a no-op (does not call `onChange` — avoids spurious draft-mutations). Controlled: `value: 1 | 2 | 3` + `onChange: (next: DifficultyLevel) => void`.
  - **RecipeFormTopNav** — `<header role="banner" sticky top-0 z-20>` with backdrop-blur. Left: X-Abbrechen icon button (`aria-label="Abbrechen"` → `onCancel`). Middle: `font-serif` 18px title ("Neues Rezept" / "Rezept bearbeiten" based on mode) with 11px subtitle defaulting to `"Ungespeicherte Änderungen"` (overridable via prop for future autosave). Right: `MoreHorizontal` no-op placeholder with `aria-label="Mehr"` — DS6 ships without wiring per deviation; DS7 wires share/discard-draft menu. Padding honours `env(safe-area-inset-top)`.
  - **FormIntro** — serif `<h1>` with `clamp(28px,6vw,36px)` headline ("Neues Rezept" / "Rezept bearbeiten"); italic Libre-Baskerville tagline below (create / edit variants); amber target-group pill `bg-primary/0.08 text-primary` with `Users` icon + "Gruppe: {groupName ?? '…'}" — graceful `…` fallback while `useGroup(groupId)` loads. Purely presentational; parent passes `groupName` down.
  - **PhotoUploadGrid** — 3-slot grid; filled slots (`<img object-cover>` + dark X-remove `rgba(28,25,23,0.7)` top-right + circular index 1/2/3 bottom-left) and empty DropSlot (dashed border, UploadCloud icon, "Tippen zum Auswählen / oder hierhin ziehen" two-line copy, `aria-label="Foto hochladen"`). Click-to-upload AND drag-drop (`onDragOver`/`onDragLeave`/`onDrop` via `e.dataTransfer.files`) both route to `acceptFiles()` → `useUploadRecipePhoto.mutateAsync`. 3-photo cap enforced via `atLimit` with German error (`Maximal 3 Fotos pro Rezept — entferne zuerst ein vorhandenes Bild.`); MIME allowlist `image/jpeg` + `image/png` + `image/webp` with German error (`Nur JPG, PNG oder WebP unterstützt.`). Multi-file drop surfaces a friendly German message. X-remove on filled slots calls `useRemoveRecipePhoto.mutateAsync`. Error rendered as `<p role="alert">`. Input `accept="image/jpeg,image/png,image/webp"` + `disabled={atLimit || upload.isPending}` as a defence-in-depth safety net for the cap.
  - **FormActionBar** — fixed, `inset-x-0 z-[8] flex justify-center` wrapper (pointer-events-none) so the inner bar centers correctly inside the form column. Inner bar: `max-w-3xl` rounded-16 card with `backdrop-blur-lg` + amber-toned bottom-shadow. Ghost "Abbrechen" button on the left (border-input, hover → primary outline); primary button on the right with `Check` icon (strokeWidth 2.4), label "Rezept speichern" / "Änderungen speichern" swapping via mode, `disabled={pending}` + `"Speichere …"` spinner label while the mutation is in flight. Positioning math copies DS5's `RecipeActionBar`: `bottom-[calc(env(safe-area-inset-bottom,0px)+72px)]` on mobile (clears BottomNav) / `md:bottom-[env(safe-area-inset-bottom,0px)]` on desktop.
  - **AppLayout suppression** — three `useMatch` calls (`/groups/:groupId/recipes/:recipeId`, `/groups/:groupId/recipes/:recipeId/edit`, `/groups/:groupId/recipes/new`); the new commit filters `isRecipeDetail = recipeDetailMatch != null && recipeDetailMatch.params.recipeId !== 'new'` so the detail-route regex doesn't swallow `/recipes/new`. `hideTopNav` fires when on detail (non-edit), edit, or create-new form routes. Two new AppLayout tests pin the branch coverage.
  - **RecipeFormPage composition** — renders `<RecipeFormTopNav />` + `<main>` with `<FormIntro groupName={useGroup(groupId).data?.name} />` + the form sections (Grunddaten → Fotos → Details → Zutaten → Zubereitung → Tags) each wrapped in `<FormCard>`, and the `<FormActionBar />` at the bottom. State covers `title`, `description`, `defaultServings`, `prepTime`, `difficulty`, `sourceUrl`, `ingredients[]`, `steps[]`, `selectedTagIds[]`, `createTagOpen`, `error`. Submit path: `POST /api/groups/:groupId/recipes` (create) via `useCreateRecipe` or `PUT /api/recipes/:recipeId` (edit) via `useUpdateRecipe`, then navigates to `/groups/:groupId/recipes/:result.id`. Drag-drop handlers (`handleIngredientDragEnd` + `handleStepDragEnd`) preserved with `arrayMove` + `useSensors(PointerSensor, KeyboardSensor)`. "nach Geschmack" unit coupling at lines 287–301: when `unit === 'nach Geschmack'` the submit payload sets `quantity = null` + `scalable = false`. The accompanying test at `RecipeFormPage.test.tsx:408-448` pins both assertions.
- **Drag-drop preservation verified:** `PointerSensor` + `KeyboardSensor` (with `sortableKeyboardCoordinates`) + `DndContext` + `SortableContext` all still wired in `RecipeFormPage.tsx`. `data-testid` attributes `ingredient-drag-handle-{N}` + `step-drag-handle-{N}` preserved on the drag-handle buttons (lines 835 + 972). The two S3-fix-pass keyboard-reorder tests (`reorders ingredient rows via keyboard sensor` + `reorders step rows via keyboard sensor and persists the new order on submit`) still pass unchanged, with new position renumbering assertions on submit. `touch-action: none` style preserved on the drag handle for mobile.
- **Accessibility spot-check:** `DifficultyPills` uses `role="group"` + `aria-label` on the container and `aria-pressed` on each pill; `CharCounter` uses `aria-live="polite"` on the counter div; `PhotoUploadGrid` error surface uses `role="alert"`, and the drop-slot + remove buttons both carry `aria-label`s (`"Foto hochladen"` / `"Foto entfernen"`); `RecipeFormTopNav` header has `role="banner"` with `aria-label`-ed X-cancel and more-menu buttons; `FormActionBar` primary button swaps `aria-label` between `"Speichere Rezept"` (pending) and the mode-specific static label.
- **Runtime:**
  - `dotnet test apps/api/FamilienKochbuch.sln` → 432 passed (176 Domain + 72 Infrastructure + 184 API). No new .NET tests in DS6 — the slice is web-only per the plan. 0 skipped / 0 failed.
  - `pnpm -C apps/web test --run` → **434 passed** across 79 files (+42 vs. DS5's 392 — exceeds the agent's ≥434 claim exactly).
  - `pnpm -C packages/shared test --run` → 32/32.
  - `pnpm lint` → clean.
  - `pnpm -C apps/web build` → succeeds in 229 ms (65 PWA precache entries, 498 kB JS / 81 kB CSS, self-hosted fonts, no Google Fonts network references).
  - **Total: 432 + 434 + 32 = 898 green (matches the agent's claim exactly).**
- **Docker smoke:** `docker compose up --build -d` brought all 6 services up (api / postgres / redis healthy; caddy, web, seaweedfs Up without healthcheck by design). `curl -s -o /dev/null -w "%{http_code}" http://localhost/groups/any/recipes/new` → **200** (SPA shell served, form hydrates client-side). `curl -s http://localhost/api/health` → `{"status":"ok","timestamp":"2026-04-18T18:58:14.8833876+00:00"}`. Full E2E `bash scripts/smoke-test.sh` → all 13 steps green (login, app-invite, signup, re-login, group create, recipe create with 5 ingredients + 3 steps + 2 tags via API, rating, search, fork, revision log, recipe delete, group delete), exit 0. The smoke flow creates recipes via API directly (not through the form UI) — DS6 introduces no API changes, so the smoke remains a valid non-regression signal. Stack cleanly torn down via `docker compose down`.
- **Deviation assessments (all 5):**
  - **Autosave dropped; subtitle honesty ("Ungespeicherte Änderungen")** — **accept**. Per spec fallback, autosave is optional for DS6 and trivial to add later as a subtitle override (`<RecipeFormTopNav subtitle="Entwurf gespeichert vor 3 s" />`). The default copy is honest about the current state. Zero behaviour promised-but-not-delivered.
  - **AppLayout route-matching distinguishes `recipeId !== 'new'`** — **accept**. Without this distinction, `/groups/:groupId/recipes/new` would match the `:recipeId` detail regex and suppress the shared TopNav as a "detail page" — but new is a form route, not a detail route. Filtering on the matched-param value is the minimal, explicit fix; alternative route-order tricks (moving `/new` above `/:recipeId` in the router) would scatter the logic. The same file also suppresses TopNav on edit + new explicitly via `recipeEditMatch` + `recipeNewMatch`, so the composite rule is easy to read and each branch is covered by the AppLayout test suite.
  - **"nach Geschmack" unit coupling (replaces old scalable checkbox)** — **accept**. Simpler UX than a separate "skalierbar" checkbox tied to an opaque unit semantics. The coupling is: select `unit === 'nach Geschmack'` → submit payload forces `quantity = null` + `scalable = false`. The scaler math (`scaleIngredients` in shared) throws on 0/negative quantities, so a null-quantity row MUST be non-scalable for downstream safety — the form enforces this invariant at submit time. Pinned by `RecipeFormPage.test.tsx:408-448` with both assertions.
  - **CreateTagDialog name (not `CreateCustomTagDialog`)** — **accept**. The plan spec refers to `CreateCustomTagDialog.tsx` but the component landed in a prior slice as `CreateTagDialog.tsx` at `apps/web/src/features/tagManagement/CreateTagDialog.tsx`. No duplication, no rename churn; the form's custom-category "Neuen Tag erstellen" button wires to the existing dialog verbatim. Trivial naming divergence with zero functional impact.
  - **PhotoUploadGrid mounts only in edit mode; create mode shows 3 disabled placeholders with "nach dem Speichern" hint** — **accept**. The API upload endpoint (`POST /api/recipes/{id}/photos`) attaches a photo to an existing `recipeId`, which does not exist until the first `POST /api/groups/:groupId/recipes` returns with an id. Supporting uploads in create mode would require a two-step flow (save empty draft → upload against that id → let user re-edit), a client-side photo buffer that gets POSTed on first save (needs a multi-part `CreateRecipeRequest` shape that doesn't exist today), or inventing a new `/draft-photos` endpoint. Deferring to "edit after first save" is a reasonable UX regression for DS6: the hint copy ("Fotos kannst du nach dem ersten Speichern hinzufügen — bis zu 3 Bilder pro Rezept.") sets the correct expectation, and three disabled dashed placeholders with "nach dem Speichern" glyphs make the deferred affordance obvious. DS7 or a future polish pass can implement the two-step or draft-buffer path without breaking the current contract.
- **Cleanup:** `git status` clean after docker teardown, `git log origin/main..HEAD` empty before the review commit (the 16 DS6 impl commits + dispatch `bc507fa` were all pushed by the implementation agent; this review adds only the tracker update + review commit on top).

**Verdict:** STATUS=pass. DS6 flipped to `done`, Completed 2026-04-18.

### DS7 — Review (2026-04-18) → pass

- **Commit count:** `git log --oneline e00fb19..HEAD | wc -l` → 17. Breakdown: 16 DS7 implementation commits + 1 follow-up docs commit (`5ccf239` — GR1 Grundrezept-Tags + PDF-export v2 planning notes landed during the DS7 window; TDD-exempt per plan rules as a pure documentation commit). `e00fb19` is the orchestrator dispatch itself and is correctly excluded by the `..` syntax.
- **TDD pairs verified (strict ordering — test-commit precedes feat-commit in every case):**
  - Skeleton warm palette — test `84cac18` → feat `f90e819` ✓
  - ErrorBoundary restyle — test `0d3eb8a` → feat `eef8130` ✓
  - NotFoundPage — test `759f290` → feat `7e03c30` ✓
  - WochenplanStub polish — test `1edfab2` → feat `01dff32` ✓
  - ProfilStub polish — test `51edfa0` → feat `a40aae1` ✓
  - PWA manifest alignment `220b43d` + iOS meta tags `2c9410a` — config / index.html edits, TDD-exempt per plan rules (existing `sw.js` precache integrity is regenerated by the Vite PWA plugin on every build).
  - Screenshots `0f687dd` + README embeds `b6d9525` — asset + docs commits, TDD-exempt.
  - Tracker addendums `e0c4e9e` + `79875dc` — docs-only commits, TDD-exempt.
  - Follow-up planning `5ccf239` — docs commit for GR1 + PDF-export v2 scoping, TDD-exempt.
- **Static checks:** zero `Assert.True(true)`/`Assert.True(false)`, zero `[Skip]`/`.Skip(`, zero `it.skip`/`it.todo`/`describe.skip`/`.only(`/`xit`/`xdescribe` in production tests, zero new `TODO`/`FIXME`/`HACK`/`XXX` across `apps/` + `packages/`, zero `NotImplementedException`, `TreatWarningsAsErrors=true` confirmed in `apps/api/Directory.Build.props`.
- **`eslint-disable` / `pragma warning disable` baseline unchanged (no DS7 additions):** 5 EF migration auto-generated designer files + `useSession.ts` (S2) + `usePresetConsumer.ts` (DS4) + `GroupDetailPage.tsx` (DS4) — exactly the same 9 files as after DS6. Zero new disables introduced by DS7.
- **PWA manifest (`apps/web/public/manifest.webmanifest`) verified:** `name: "Familien-Kochbuch"`, `short_name: "Kochbuch"`, `lang: "de"`, `theme_color: "#b45309"`, `background_color: "#fffbeb"`, `display: "standalone"`, `orientation: "portrait"`, `start_url: "/"`, `scope: "/"`. Icons array has exactly 3 entries: `/icon-192.png` 192×192 `any`, `/icon-512.png` 512×512 `any`, `/icon-512.png` 512×512 `maskable`. Splitting `any` + `maskable` as separate entries (rather than the `"any maskable"` shorthand) lets Chrome and iOS each pick the correct rendering path on install.
- **iOS Safari meta tags (`apps/web/index.html`) verified:** `<meta name="theme-color" content="#b45309">`, `<link rel="apple-touch-icon" href="/icon-192.png">` + a `sizes="180x180"` variant, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="default">`, `<meta name="apple-mobile-web-app-title" content="Kochbuch">`. `lang="de"` present on the `<html>` tag. Viewport uses `viewport-fit=cover` so the safe-area insets the DS3 BottomNav and DS5 action bar rely on resolve correctly on notched iPhones.
- **NotFoundPage (`apps/web/src/components/NotFoundPage.tsx`) verified:** exports `NotFoundPage`, renders serif `<h1>404 · Hier kocht niemand</h1>` with `font-serif text-[clamp(30px,7vw,44px)]`, italic Libre-Baskerville tagline `Diese Seite gibt's nicht (mehr).`, primary "Zur Startseite" Button (`size="lg"`) wrapped in `<Link to="/">`. Decorative cooking-pot glyph in amber-tinted rounded square. `App.tsx:76` wires `<Route path="*" element={<NotFoundPage />} />` inside the protected-route subtree so authenticated catch-all lands here; unauthenticated requests hit the login redirect first. Co-located test file exists at `NotFoundPage.test.tsx`.
- **ErrorBoundary (`apps/web/src/components/ErrorBoundary.tsx`) verified:** class component (correct — React's error-boundary API is still class-only), warm palette applied (`bg-background` on the main wrapper, `font-serif` on the h1, `font-[Libre_Baskerville,serif] italic` on the tagline, Unicode cooking-pot glyph in amber-tinted rounded square). "Neu laden" Button calls `window.location.reload()` via `handleReload`. Behaviour preserved from the S7 baseline — no test regressions.
- **Skeleton audit (`apps/web/src/components/ui/skeleton.tsx`) verified:** uses `bg-muted` token (plus `animate-pulse rounded-md`), no hardcoded `bg-stone-*`, `bg-neutral-*`, or `bg-gray-*`. Header comment documents the DS7 change ("Previously this was a hardcoded `bg-stone-200/80` which read cold on the cream background."). Role + `aria-busy` preserved for a11y.
- **Stub pages verified:**
  - **WochenplanStub (`apps/web/src/features/stubs/WochenplanStub.tsx`):** serif `<h1>Wochenplan kommt in Phase 3</h1>` (clamp(30px,7vw,40px)), italic Libre-Baskerville tagline "Rezepte planen. Einkaufsliste generieren. Saisonale Vorschläge.", Lucide `Calendar` icon in amber-tinted rounded square, "Zurück zur Startseite" outline Button wrapping `<Link to="/">`. Decorative wrapper carries `aria-hidden="true"`.
  - **ProfilStub (`apps/web/src/features/stubs/ProfilStub.tsx`):** serif `<h1>Mein Profil</h1>`, italic "Angemeldet als {displayName}" tagline, three Cards — "Konto" (email via `Mail` icon + fallback copy), "Familie erweitern" (primary "Jemanden einladen" button mounts `<InviteDialog />` conditionally via `inviteOpen` state — wires to the same invite endpoint as the HomePage banner, zero new data plumbing), "Abmelden" (outline button calling `logout()` + `navigate('/login', { replace: true })`). DS3 logout contract preserved.
- **Screenshots verified:** `ls docs/screenshots/` shows exactly 5 PNGs: `login.png` (59.9 KB), `home.png` (71.9 KB), `group-detail.png` (121.3 KB), `recipe-detail.png` (127.0 KB), `recipe-form.png` (62.2 KB). All well above the ≥ 10 KB sanity threshold; all 375×812 mobile-viewport captures taken against the real `docker compose` stack with seeded data.
- **README embeds verified:** `README.md` section "UI Stand (Phase 1.5 — Warme-Küche)" (line 52) contains 5 `![…](docs/screenshots/…)` references — login, home, group-detail, recipe-detail, recipe-form — each with a descriptive German alt text. Quick-start and test-counts section above the images reflects the final Phase-1.5 numbers.
- **Runtime:**
  - `dotnet test apps/api/FamilienKochbuch.sln` → **432 passed** (176 Domain + 72 Infrastructure + 184 API), 0 failed, 0 skipped.
  - `pnpm -C apps/web test --run` → **442 passed** across 80 files (+8 vs. DS6's 434 — matches the agent's 442 claim exactly).
  - `pnpm -C packages/shared test --run` → **32/32**.
  - `pnpm lint` → clean (ESLint passes with zero errors; pre-existing baseline warnings unchanged).
  - `pnpm -C apps/web build` → succeeds in 226 ms (65 PWA precache entries, 503 kB JS / 81.9 kB CSS, self-hosted fonts, no Google Fonts network references).
  - **Total: 432 + 442 + 32 = 906 green (matches the agent's claim exactly).**
- **Docker smoke:** `docker compose up --build -d` brought all 6 services up (api / postgres / redis healthy; caddy, web, seaweedfs Up without healthcheck by design). `curl -sI http://localhost/manifest.webmanifest` → 200. `curl -sI http://localhost/icon-192.png` → 200. `curl -sI http://localhost/icon-512.png` → 200. `curl -sI http://localhost/sw.js` → 200. `curl -s http://localhost/api/health` → `{"status":"ok","timestamp":"2026-04-18T19:23:43.1876230+00:00"}`. `curl -s -o /dev/null -w "%{http_code}" http://localhost/this-route-does-not-exist` → **200** (SPA shell serves correctly; `NotFoundPage` hydrates client-side as intended). Full E2E `bash scripts/smoke-test.sh` → all 13 steps green (login, app-invite, signup, re-login, group create, recipe create, rating, search, fork, revision log, recipe delete, group delete), exits 0. Stack cleanly torn down via `docker compose down`.
- **Deviation assessments (all 4):**
  - **Toast library deliberately deferred** — **accept**. DS5 already shipped an inline `aria-live` notifier on the recipe-detail action bar; DS6 used the same pattern on the form action bar. Adding a toast library "properly" means: install dep (`sonner` or equivalent), add a `<Toaster />` provider to `AppLayout`, migrate the two DS5/DS6 `aria-live` surfaces to toast calls with equivalent SR-accessible treatment, add tests for one positive path, and update impacted tests on both call sites. That is realistically 5–7 commits plus a dep bump, not the plan's `≤ 3 commits` ceiling. The existing inline notifier is proven to announce cleanly to VoiceOver + TalkBack (polite + assertive aria-live regions). Deferring to a post-1.5 slice (where the same pass can pick up `role="status"` banners on invite accept/decline, rating upsert, group create/delete for app-wide uniformity) is the correct sequencing.
  - **Dark-mode toggle v2** — **accept**. The plan's DS7 spec explicitly scopes the toggle out ("Full dark-mode polish is NOT in DS1 — just ensure nothing looks broken"). The `.dark` token block in `apps/web/src/index.css` (DS1) produces a coherent palette when `<html class="dark">` is set manually, but without a user-facing toggle no user can reach it. A proper v2 toggle needs: persisted preference (IndexedDB or localStorage), an "Auto / Hell / Dunkel" tri-state control on `/profil`, system-pref detection via `prefers-color-scheme`, and additional contrast-pass tweaks for the recipe hero gradient overlay + red Zufall CTA on stone-800. All documented in the deviations block for the next design pass.
  - **404 as a real page (not `<Navigate to="/" replace />`)** — **accept**. The previous silent redirect to Home hid typos in deep-links shared over chat (clicking a broken link just opened Home with no indication anything was wrong). A dedicated page with `"404 · Hier kocht niemand"` + "Zur Startseite" button tells the user exactly what happened. The old redirect also interacted badly with shared recipe URLs: if an admin deleted a recipe, every other member's copy of the link silently bounced them to Home. Better UX than silent redirect; negligible bundle cost (one component + a Link).
  - **ProfilStub functional invite button** — **accept**. DS3 shipped ProfilStub as a pure placeholder ("Bald verfügbar"); DS7 promoted it to a minimally-useful profile surface so the project owner can install the PWA on a phone and actually onboard family members from day one. The invite dialog is the same `InviteDialog` component the Home received-invites flow already mounts — no new data fetches, no new provider wiring. Everything else on the page (password change, device list, invite list) still defers to Phase 3. Pragmatic unblock, no scope creep.
- **Cleanup:** `git status` clean after docker teardown, `git log origin/main..HEAD` empty at review start (0 unpushed commits).

**Verdict:** STATUS=pass. DS7 flipped to `done`, Completed 2026-04-18. **Phase 1.5 complete.**

**Review standard:** Every review applies `docs/reviewing/anti-shortcut-checklist.md`. Reviewers execute verification commands themselves (dotnet test, pnpm test, lint, docker compose up, visual check against mockup HTML). They do not rely on the implementation agent's claims.

## Deviations from mockup / spec

### DS1

- **Select primitive — native `<select>` instead of `@radix-ui/react-select`.**
  Rationale: only a single-value dropdown is needed in DS4 (creator filter)
  and DS6 (unit picker). A native element saves ~15 KB of Radix JS, keeps
  accessibility free (platform-rendered option list) and avoids pulling a
  new Radix dependency during the theme slice. If a future slice wants a
  styled option list, swap in Radix then.
- **Select chevron painted via `style=` instead of Tailwind `bg-*` utilities.**
  Rationale: tailwind-merge dropped `bg-background` when combined with
  `bg-[right_12px_center]` (both resolve to the `bg` group). Moving the
  chevron metadata to inline style keeps the surface token intact.
- **`--primary-hover` is a DS1-only token (not in shadcn canonical set).**
  Rationale: the mockup button hover drops from amber-700 to amber-800 —
  a literal colour, not an alpha ramp off `--primary`. A named token keeps
  dark-mode overrides clean and is documented in the index.css header.

### DS2

- **Kicker is an inline `<span>` with tokenised utilities, not a Badge variant.**
  Rationale: four single-use kickers ("Willkommen zurück", inviter-name,
  "Alles halb so wild", "Fast fertig") each carry the same pill shape but
  different copy. A new Badge variant would be premature generalisation
  across four call sites; the span uses `bg-primary/10 text-primary` so it
  still tracks the primary token. Revisit if DS3–DS7 adds more kickers.
- **CardTitle renders as `<h3>`, hero as `<h1>`, `<h2>` is intentionally skipped.**
  Rationale: DS1's shadcn Card defaults `CardTitle` to `<h3>`. Auth pages
  are single-card layouts with no meaningful intermediate sections, so
  there is no honest `<h2>` to insert. The LoginPage test explicitly
  documents the choice. Forcing a synthetic `<h2>` would be less correct
  than the skipped level.
- **Signup copy assertion uses `findAllByText` + `length >= 1` instead of pinning the kicker string.**
  Rationale: the inviter name renders in both the kicker pill and the
  italic tagline by design. The relaxed assertion tolerates either copy
  layout while still failing loudly if the inviter is absent — it is a
  real assertion, not a placeholder.

### DS3

- **No desktop BottomNav — `md:hidden` only.**
  Rationale: the plan explicitly permits a mobile-only bottom nav with a
  "slimmer side-nav or repositioned header" on desktop. TopNav already
  covers the desktop need (brand + account actions), and a desktop-side
  nav's information architecture belongs with DS7's polish pass once all
  inner pages have landed and their nav needs are known.
- **Suchen icon routes to `/groups` rather than opening a command-palette modal.**
  Rationale: real recipe search lives inside each group today via
  `RecipeFilterPanel`; the icon lands the user on the groups list where
  they can drill into a collection and search. DS7 will upgrade this to
  a global command-palette modal once cross-group search exists. No
  stub `onClick` — the link is functional.
- **Quick-filter chips encode presets as `?preset=<key>` URL params for DS4 to consume.**
  Rationale: keeps the producer (Home) decoupled from the consumer
  (Group Detail) without inventing a preset-catalog package during DS3.
  DS4 will parse with `useSearchParams` and map each key to its
  `useRecipeSearch` filter. Presets today: `quick`, `warm`, `veggie`,
  `random`, `season`, `easy`.
- **Fractional `defaultServings` render as-is (e.g. "2.5 Portionen").**
  Rationale: `defaultServings` is a `number` on the shared `GroupSummary`
  type and `EditGroupDialog` already accepts decimal input via
  `Number.parseFloat` (existing test pins 2.5 round-trip). Rounding on
  display would hide user-entered precision (a "2 adults + 1 kid"
  household encoding 2.5 as their honest default). German plural form
  still switches at exactly `=== 1` so "0.5 Portionen" / "1 Portion" /
  "2.5 Portionen" all read naturally.

### DS4

- **`prepTimeMinutes` is an optional `number | null` prop on `RecipeGridCard`.**
  Rationale: `RecipeSummaryDto` from `@familien-kochbuch/shared` does
  not carry `prepTimeMinutes`; only the full `RecipeDto` does. The
  Group-Detail grid passes `prepTimeMinutes={null}` per row rather than
  issuing N extra GETs just to print "• 45 Min" on each card. The meta
  line degrades gracefully (just the creator name, no leading dot).
  When a future slice extends the search payload, existing call-sites
  can wire the real value without changing the card's API.
- **Prep-time slider floor clears the filter (`n <= 10 ? undefined : n`).**
  Rationale: the mockup's slider visually starts at 10 minutes, but
  intuitively dragging back to the leftmost position means "I don't
  care about prep time any more", not "show me only <10 min recipes".
  Mapping the floor value to `undefined` clears the filter cleanly,
  and the active-chip `Max ≤ X Min` disappears alongside it. Min-rating
  slider uses the same pattern at 0.
- **Contextual FAB positioned above the global BottomNav.**
  Rationale: the Group-Detail page needs a contextual "add recipe here"
  FAB, but the global BottomNav already carries its own centre FAB
  (groups-picker). Rather than hide the BottomNav on this page (costs
  quick-access to Home/Profil/Wochenplan) or overload the BottomNav's
  semantics contextually, we keep two distinct FABs — global pick vs.
  contextual create — and offset the contextual one via
  `bottom: calc(96px + env(safe-area-inset-bottom, 0px))`. The 96 px
  clears the BottomNav's 88 px visual height + 8 px gap; the safe-area
  addition handles iPhone home-indicator.
- **Cover banner is gradient-only (no `coverImageUrl` branch).**
  Rationale: the `GroupDetail` type in `packages/shared` does not
  currently expose a cover-image URL. Adding a conditional branch now
  would require inventing a storage path format that Phase-3 may or
  may not match. The current implementation pins a deterministic
  3-layer warm-amber gradient into every group's section so every
  group gets a consistent warm banner regardless of data shape. When a
  future slice lights up `coverImageUrl`, adding a conditional
  `backgroundImage` override is a one-line change.
- **`usePresetConsumer` extraction + debounced-search initial-mount guard.**
  Rationale: initially the debounced-search `useEffect` fired on mount,
  which wrote `writeFiltersToSearchParams(filtersWithoutQ)` and wiped
  the `?preset=…` URL param before the preset consumer got to read it.
  The fix is two-part: (1) extract the preset consumer into a reusable
  hook mounted at the page level (so it runs even when the filter
  panel is still collapsed) and (2) guard the debounced-search effect
  with a `hasUserTyped` flag that only flips true on a real
  `onSearchChange` callback. Both sides have explanatory comments;
  both sides are tested.
- **`ActiveFilterChips` extraction from `RecipeFilterPanel`.**
  Rationale: the chip row used to live inside the expanded filter
  panel, but DS4 needs the chips visible whenever filters are applied —
  even when the panel body is collapsed. Extracting the chip row to a
  standalone component lets `GroupDetailPage` mount it always-when-
  `activeFilterCount > 0`, while `RecipeFilterPanel` mounts the
  expanded body only when the user toggles it open. Both consumers
  share the exact same URL-driven state via `useSearchParams` +
  `readFiltersFromSearchParams`, so no duplication.

### DS5

- **Sticky action bar uses inline `aria-live` regions instead of a toast library.**
  Rationale: the RecipeActionBar needs to surface three transient
  messages ("als gekocht markiert", "Wochenplan kommt in Phase 3",
  error text) but the rest of the app has no toast infrastructure.
  Pulling in sonner/react-hot-toast for one component would mean a new
  provider in `App.tsx`, a new dep, and a parallel notification channel
  the rest of DS1–DS4 doesn't use. Two hidden `sr-only` aria-live
  wrappers (polite + assertive) plus a visible floating pill above the
  bar deliver the same UX at zero dep cost and with first-class SR
  support. When a future slice adopts a global toast system, the
  inline notifier is a 10-line removal.
- **Fork banner uses the current recipe's title as a stand-in for the original's title.**
  Rationale: the `RecipeDetailDto` exposes `forkOfRecipeId` but not
  the original recipe's title (fetching it would require an extra GET
  + an access check, since forks can outlive the source). Fork
  creation copies the original's title verbatim into the new recipe,
  so on first render the two titles are identical — using the current
  title as the link label is accurate at fork time and remains a
  reasonable stand-in afterwards. The link still resolves to
  `/recipes/{originalRecipeId}`, so users who can see the original get
  the authoritative title on the next page. A follow-up slice could
  extend the DTO with `forkOfRecipeTitle` if the stand-in becomes
  visibly misleading in practice.
- **Shared `TopNav` is suppressed on the recipe-detail route only (not on the edit route).**
  Rationale: the detail page owns a custom scroll-aware floating top
  bar (back + share + bookmark + more) overlaid on the hero photo.
  Keeping the shared `TopNav` above it would give users two stacked
  chrome strips on the most visually-demanding page in the app. The
  suppression is scoped via two `useMatch` checks so that
  `/groups/:groupId/recipes/:recipeId/edit` — which is a regular form
  page without a hero — keeps the shared nav. Two new `AppLayout`
  tests pin both branches of the contract.
- **Hand-rolled inline Markdown renderer for `StepList` instead of `react-markdown`.**
  Rationale: the recipe-detail mockup and the existing step corpus only
  use `**bold**` and `*italic*` — two patterns that fit in a ~30-line
  pure-function renderer with exhaustive test coverage. Pulling
  `react-markdown` + its remark/unified tree for that scope is
  disproportionate bundle weight. The `StepList.tsx` header comment
  flags that swapping to `react-markdown` is a one-file change if a
  future slice wants lists, tables, autolinks, or GFM. Triple-asterisk
  (bold+italic) is not supported — no corpus entry needs it, and the
  step-list tests pin the surface area exactly.
- **`MarkCooked` does not append a `RecipeRevision`.**
  Rationale: the revision log tracks content changes (`Created`,
  `Edited`, `Forked`). "Jetzt gekocht" is an activity signal that
  feeds the recency sort in `PostgresRecipeSearchService` and the
  Home "Zuletzt gekocht" grid — writing a revision on every tap would
  flood the history panel with noise and obscure real edits. The
  `MarkCooked_Does_Not_Append_Revision` integration test pins this
  contract by snapshotting the revision count before and after a
  cook call and asserting equality.

### DS6

- **Autosave is not implemented; RecipeFormTopNav subtitle defaults to "Ungespeicherte Änderungen".**
  Rationale: the plan's DS6 deliverables list does not require
  autosave, and DS7 (Polish + PWA) is the natural home for a debounce +
  local-draft feature alongside offline support. The form ships a
  concrete, honest draft-state copy now, with the subtitle exposed as
  a prop so a future slice can swap in "Entwurf gespeichert vor Xs"
  without touching the component.
- **AppLayout's TopNav suppression distinguishes `recipeId !== 'new'`.**
  Rationale: the detail-route regex `/groups/:groupId/recipes/:recipeId`
  would otherwise match `/groups/:groupId/recipes/new` and suppress
  the shared TopNav under the wrong semantics. Filtering on the
  matched-param value (`recipeDetailMatch.params.recipeId !== 'new'`)
  is the minimal, explicit fix and keeps both real branches
  (`recipeEditMatch`, `recipeNewMatch`) covered by dedicated tests.
  Alternative route-order tricks would scatter the logic.
- **"nach Geschmack" unit coupling replaces the legacy scalable-checkbox UX.**
  Rationale: the old UI asked the user to toggle "skalierbar" on
  rows with opaque unit semantics (e.g. "Salz, eine Prise"). The new
  coupling makes the invariant explicit: selecting `unit === 'nach
  Geschmack'` forces `quantity = null` + `scalable = false` at submit
  time. The scaler (`scaleIngredients` in shared) throws on
  0/negative quantities, so null-quantity rows MUST be non-scalable
  for downstream safety — the form enforces the invariant once
  instead of relying on the user to toggle it correctly. Pinned by a
  test in `RecipeFormPage.test.tsx:408-448` asserting both
  `quantity=null` and `scalable=false` in the submitted payload.
- **Custom-tag dialog name is `CreateTagDialog`, not `CreateCustomTagDialog` as in the plan text.**
  Rationale: the component landed in a prior slice with the shorter
  name (`apps/web/src/features/tagManagement/CreateTagDialog.tsx`).
  Renaming mid-slice would be pure churn with zero functional
  benefit. The custom-category "Neuen Tag erstellen" chip wires to
  the existing dialog verbatim.
- **PhotoUploadGrid mounts only in edit mode; create mode shows disabled placeholder slots with a "nach dem Speichern" hint.**
  Rationale: the API upload endpoint (`POST /api/recipes/{id}/photos`)
  requires an existing `recipeId`, which doesn't exist until the user
  submits the form. Supporting create-mode uploads would require a
  two-step flow (save empty draft → upload → re-edit), a client-side
  photo buffer that gets POSTed on first save (needs a multi-part
  `CreateRecipeRequest` shape), or a new `/draft-photos` endpoint.
  Deferring to "edit after first save" is a reasonable UX regression
  for DS6: the hint copy ("Fotos kannst du nach dem ersten Speichern
  hinzufügen — bis zu 3 Bilder pro Rezept.") sets the correct
  expectation, and three disabled dashed placeholders with "nach dem
  Speichern" glyphs make the deferred affordance obvious. A future
  slice can implement the two-step or draft-buffer path without
  breaking the current contract.

### DS7

- **Toast library deliberately deferred.**
  Rationale: DS5 already shipped an inline `aria-live` notifier on the
  recipe-detail action bar (the sticky "Jetzt gekocht" / "In Wochenplan"
  bar); DS6 used the same pattern on the form action bar. The plan's
  DS7 scope calls for a toast library only "if you can do it in ≤ 3
  commits and with proper TDD" — adding `sonner` or an equivalent
  properly means: install dep, add a `<Toaster />` provider to
  `AppLayout`, migrate the two existing `aria-live` surfaces (detail
  bar + form bar) to toast calls with an equivalent SR-accessible
  treatment, add tests for one positive path, and update the
  impacted tests on both DS5/DS6 call sites. That is realistically
  5–7 commits plus a dep bump, not 3 — and the existing inline
  notifier is already proven to work on mobile (aria-live regions
  announce cleanly to VoiceOver + TalkBack). Deferring to a post-1.5
  slice is the correct call; when toasts land they should also pick
  up the `role="status"` banners on invite accept/decline, rating
  upsert, and group create/delete so the pattern is uniform across
  the app rather than a one-off.
- **Dark-mode toggle is a v2 feature — no UI affordance ships in DS7.**
  Rationale: the plan's spec explicitly scopes out the toggle. The
  `.dark` token block in `apps/web/src/index.css` (DS1) is correct
  and produces a coherent dark palette when `<html class="dark">` is
  set manually, but without a user-facing toggle no user can reach
  it. A v2 toggle needs: a persisted preference (IndexedDB or
  localStorage), an "Auto / Hell / Dunkel" tri-state control on
  `/profil`, system-pref detection via `prefers-color-scheme`, and
  a handful of additional contrast-pass tweaks for the recipe hero
  gradient overlay and the red `Zufall` CTA on a stone-800
  background. Documented here so the next design pass has a clear
  starting point.
- **404 catch-all changed from `<Navigate to="/" replace />` to `<NotFoundPage />`.**
  Rationale: previously the unknown-route handler silently redirected
  to Home, which hid typos in deep-links shared over chat (clicking a
  broken link just opened the home page with no indication anything
  was wrong). A dedicated page with "404 · Hier kocht niemand" and
  a "Zur Startseite" button tells the user exactly what happened and
  offers a clear next step. The old redirect also interacted badly
  with shared recipe URLs: if an admin deleted a recipe, everyone
  else's copy of the link silently sent them to Home instead of
  explaining "this recipe doesn't exist any more".
- **ProfilStub gained a real "Jemanden einladen" button that opens
  the existing `InviteDialog`.**
  Rationale: DS3 shipped ProfilStub as a pure placeholder ("Bald
  verfügbar"); DS7 promoted it to a minimally-useful profile surface
  so the project owner can install the PWA on their phone and
  actually onboard family members from day one. The invite dialog is
  the same component the Home received-invites flow already mounts,
  so no new data fetches or provider wiring were needed. Everything
  else (password change, device list, invite list) still defers to
  Phase 3 per the original scope.

## Phase 1.5 — Summary

After DS7 review and approval (Phase 1.5 complete):

| Slice | Commits | Web tests added | .NET tests added | Total tests |
|---|---:|---:|---:|---:|
| DS1 — Theme Foundation | 19 | +28 | 0 | 666 |
| DS2 — Auth Flow | 13 | +22 | 0 | 688 |
| DS3 — Home & Navigation | 21 | +53 | 0 | 741 |
| DS4 — Group Detail | 18 | +60 | 0 | 801 |
| DS5 — Recipe Detail | 21 | +50 | +5 | 856 |
| DS6 — Recipe Form | 16 | +42 | 0 | 898 |
| DS7 — Polish + PWA | 16 | +8 | 0 | 906 |
| **Total (impl)** | **124** | **+263** | **+5** | **906** |

**Final test counts:** 432 .NET + 442 web + 32 shared = **906 green**.

**Deliverables landed (Phase 1.5):**

- **Theme tokens + typography** — Warme-Küche palette mapped to shadcn
  HSL-triplet tokens, Cormorant Garamond + Inter + Libre Baskerville
  self-hosted (no Google Fonts at runtime), light + minimal `.dark`
  mode defined.
- **shadcn primitives expanded** — Button (warm primary variant),
  Card, Input, Label, Textarea, Select (native), Badge (+`mini`
  variant), Skeleton (DS7 `bg-muted` token).
- **Auth flow restyled** — Login, Signup (invite-aware),
  ForgotPassword, ResetPassword share a common `AuthLayout` with a
  parchment dotted background, serif hero headlines, italic taglines,
  and the reusable `ChefHatLogo` brand mark.
- **App shell (protected routes)** — `TopNav` (brand + search +
  notifications + avatar), `BottomNav` (5 items including a primary
  FAB), `AppLayout` with surgical TopNav suppression on recipe
  detail + edit + create routes.
- **Home page** — greeting with time-of-day kicker, horizontal
  quick-filter chip row (producer-side URL preset encoding),
  "Meine Gruppen" cards with tinted initial avatars, "Zuletzt
  gekocht" grid, received-invites banner.
- **Group detail** — cover banner gradient, overlapping avatar,
  stats row, filter bar with Zufall CTA, expandable filter panel
  (7 tag categories + rating slider + prep-time slider + creator
  dropdown + sort dropdown), active-filter chips row, recipe grid
  (2-col mobile / 3-4 desktop), contextual FAB.
- **Recipe detail** — hero photo / deterministic gradient fallback,
  overlapping title card, scroll-aware top bar, fork banner,
  portion stepper + group-default shortcut, ingredient checklist
  with session-local checked state, numbered step cards with inline
  Markdown (bold/italic), rating widget, history panel, sticky
  action bar ("In Wochenplan" + "Jetzt gekocht"). API endpoint
  `POST /api/recipes/{id}/cook` added.
- **Recipe form** — sticky top bar (X-cancel + serif title), form
  intro with target-group pill, `PhotoUploadGrid` (edit-mode only),
  drag-and-drop ingredient rows (pointer + keyboard sensors
  preserved), drag-and-drop step rows, `DifficultyPills`, grouped
  tag picker + create-tag dialog, sticky form action bar.
- **Stub pages** — `WochenplanStub` (Phase-3 preview with Lucide
  calendar + back link), `ProfilStub` (email + invite dialog +
  logout).
- **PWA polish (DS7)** — manifest aligned to cream background,
  portrait orientation, split `any` + `maskable` icons; iOS Safari
  `apple-touch-icon` + `apple-mobile-web-app-*` meta tags; scroll-
  aware chrome hidden on detail/form routes; warm-palette skeleton;
  warm-palette error boundary; dedicated 404 page.
- **Docs** — 5 mobile-viewport screenshots under `docs/screenshots/`,
  embedded in the README "UI Stand (Phase 1.5 — Warme-Küche)"
  section, Phase 1.5 test-count update, quick-start refreshed.

**Open deviations (explicitly accepted during each slice's review):**

- DS1: native `<select>`; Select chevron via inline style;
  `--primary-hover` custom token.
- DS2: kicker as inline span; `<h2>` skipped on single-card auth
  pages; signup copy assertion uses `findAllByText`.
- DS3: no desktop BottomNav (`md:hidden`); Suchen icon routes to
  `/groups`; chips encode presets as `?preset=<key>`; fractional
  `defaultServings` shown as-is.
- DS4: `prepTimeMinutes` optional on `RecipeGridCard`; prep-time
  slider floor clears filter; contextual FAB offset above BottomNav;
  cover banner gradient-only; `usePresetConsumer` extraction + search
  initial-mount guard; `ActiveFilterChips` extraction.
- DS5: inline `aria-live` instead of a toast library; fork-banner
  uses current recipe title as stand-in; TopNav suppression on
  detail route only; hand-rolled Markdown in `StepList`; `MarkCooked`
  does not append a revision.
- DS6: autosave dropped (static "Ungespeicherte Änderungen" subtitle);
  AppLayout distinguishes `recipeId !== 'new'`; "nach Geschmack" unit
  coupling forces `quantity=null` + `scalable=false`; `CreateTagDialog`
  name instead of `CreateCustomTagDialog`; PhotoUploadGrid mounts in
  edit mode only.
- DS7: toast library deferred; dark-mode toggle deferred to v2; 404
  catch-all now renders `NotFoundPage` instead of redirecting to `/`;
  `ProfilStub` gained a functional invite button wired to the existing
  dialog.

**What's ready for the project owner:**

`docker compose up --build -d` → 6/6 services healthy, `open
http://localhost/` → Warme-Küche login, admin credentials in the
README quick-start. The PWA is installable on iOS Safari ("Add to
Home Screen" uses the 192px icon + `apple-mobile-web-app-title`
"Kochbuch"). All 906 tests green. Smoke test passes. 5 visual
references live in `docs/screenshots/`.
