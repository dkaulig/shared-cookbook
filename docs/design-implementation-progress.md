# Design Implementation — Progress Tracker

**Last updated:** 2026-04-18 (DS5 reviewed and approved)

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
| DS6 | Recipe Form | pending | — | — | — | — |
| DS7 | Polish + PWA | pending | — | — | — | — |

## Last orchestrator tick

- **Time:** 2026-04-18 (DS5 review complete — pass)
- **Action:** Independent reviewer verified DS5 Recipe Detail end-to-end. Commit range `a4fc31e..HEAD` contains exactly 21 DS5 commits with strict TDD ordering on every component, hook, API wrapper, and the new cook endpoint. Every static check, runtime suite (432 .NET + 392 web + 32 shared = 856 green), Docker smoke, end-to-end smoke, cook-endpoint E2E (200 / 403 / 404 / no-revision), and mockup fidelity assertion passed.
- **Next:** dispatch DS6 (Recipe Form) implementation agent.

## Blockers / pauses

_(none)_

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
