# Design Implementation — Progress Tracker

**Last updated:** 2026-04-18 (DS2 reviewed and approved)

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
| DS3 | Home & Navigation Shell | pending | — | — | — | — |
| DS4 | Group Detail | pending | — | — | — | — |
| DS5 | Recipe Detail | pending | — | — | — | — |
| DS6 | Recipe Form | pending | — | — | — | — |
| DS7 | Polish + PWA | pending | — | — | — | — |

## Last orchestrator tick

- **Time:** 2026-04-18 (DS2 review complete — pass)
- **Action:** Independent reviewer verified DS2 Auth Flow end-to-end. Commit range `36b0426..HEAD` contains 13 DS2 commits with strict TDD ordering on every page/component. Every static check, runtime suite, Docker smoke and mockup fidelity assertion passed.
- **Next:** dispatch DS3 (Home & Navigation Shell) implementation agent.

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
