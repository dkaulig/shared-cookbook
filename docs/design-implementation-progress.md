# Design Implementation — Progress Tracker

**Last updated:** 2026-04-18 (DS1 reviewed and approved)

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
| DS2 | Auth Flow (Login, Signup, Forgot, Reset) | in_progress | general-purpose (bg) | 2026-04-18 | — | dispatched after DS1 pass |
| DS3 | Home & Navigation Shell | pending | — | — | — | — |
| DS4 | Group Detail | pending | — | — | — | — |
| DS5 | Recipe Detail | pending | — | — | — | — |
| DS6 | Recipe Form | pending | — | — | — | — |
| DS7 | Polish + PWA | pending | — | — | — | — |

## Last orchestrator tick

- **Time:** 2026-04-18 (DS1 review complete — pass)
- **Action:** Independent reviewer verified DS1 Theme Foundation end-to-end. Commit range `5d778b1..HEAD` (excluding `31c1d6a` orchestrator CI-fix) contains 19 DS1 commits with strict TDD ordering on every primitive. Every static check, runtime suite, Docker smoke and token-correctness assertion passed.
- **Next:** dispatch DS2 (Auth Flow) implementation agent.

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
