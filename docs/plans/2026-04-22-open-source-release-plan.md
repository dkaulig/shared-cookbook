# Open-Source Release Plan

**Date:** 2026-04-22
**Target:** public GitHub release under MIT license, some time after
the pre-release cleanup below lands. No hard deadline.

## Positioning

This is NOT "another recipe app". The unique angle is:

- **Full modern stack as a reference codebase** — React 19 + Tailwind 4
  + shadcn/ui + TanStack Query-persist + Workbox (offline-first PWA)
  on the frontend; .NET 10 Minimal APIs + EF Core 10 + SignalR on the
  backend; Python 3.13 FastAPI + yt-dlp + faster-whisper + Azure
  OpenAI on the extractor; everything docker-composed with a Caddy
  edge.
- **AI-orchestrated development case study** — the entire codebase
  was built using Claude Code with sub-agent dispatch, 4-stage review
  per slice, TDD discipline, design docs under `docs/plans/`, rolling
  bug backlog, session-persistent memory. The git history literally
  shows the workflow as commits. That's the educational value people
  would come for.

Tagline candidates:
- "Family-cookbook PWA built entirely with AI-orchestrated dev"
- "End-to-end recipe app + AI import pipeline, as a full-stack OSS
  reference"

## Before we release — pre-flight checklist

### P0 — blockers (must ship with v1 public)

1. **Secrets audit.**
   - Grep git history for accidental commits of keys, tokens,
     passwords (`git log -p | grep -iE 'sk-|key|secret|password|
     apikey|bearer' | less`).
   - Rotate any leaked secret before going public. Fresh JWT signing
     key, Azure OpenAI key, SMTP password, Caddy ACME email, SeaweedFS
     access keys — if ANY appeared in git, rotate.
   - `.env` stays in `.gitignore`. `.env.example` gets scrubbed: only
     placeholder values (`CHANGE_ME`), with comments explaining each
     key + how to generate.
   - Check `docker-compose*.yml` for hard-coded defaults that look
     secret-ish; replace with `${VAR}` lookups.
   - Scrub migration seeds + test fixtures for real email addresses /
     names — `david.kaulig@ranger.de`, `Familie Müller` etc. Replace
     with neutral example values.

2. **`LICENSE` file.**
   - **MIT** — maximum permissive, simple two-paragraph license.
     Copyright holder is the project owner. Year = 2026.
   - Alternative AGPL if we specifically want to prevent closed-source
     SaaS forks. Not our concern for a hobby project → MIT.

3. **`README.md` rewrite for external audience.**
   - Remove family-specific framing. Short project description +
     "Why does this exist" + screenshots.
   - Architecture section: one diagram of the 3 services + their
     boundaries. Key decisions called out (PWA offline, AI extraction,
     single-user-per-group vs family-sharing).
   - Quick-start: `docker compose up -d` + admin credentials in
     `.env.example` + `http://localhost`.
   - "How to try the AI import": needs Azure OpenAI credentials, here's
     how to wire them, here's the alternative via LiteLLM / Ollama /
     Groq for self-hosted inference.
   - Dev setup: `pnpm install`, `pnpm --filter web dev`, `dotnet
     watch`, `uv run uvicorn ...` per app.
   - Test run: `pnpm --filter web run test`, `dotnet test`, `uv run
     pytest`, `pnpm --filter shared run test`.
   - Link to `docs/` for plans + bug-backlog + CLAUDE.md for
     contributors.

4. **Rebrand.** Search-and-replace `kochbuch.kaulig.dev` and personal
   email addresses; replace with `EXAMPLE_HOST` / `admin@example.com`
   in public-visible config. Keep project name "Familien-Kochbuch" if
   it's already in SEO; otherwise rename to something neutral like
   "open-cookbook".

5. **`.github/workflows/` clean-up.** The `deploy.yml` references
   private Dockerfiles pushed to `ghcr.io/kay-solutions/...` — that
   stays but gets called out in README as "this deploys to MY VPS;
   you'd need to fork + redirect the image paths + secrets to your
   own". CI could be re-enabled as a separate public-friendly workflow
   (tests only, no deploy) — nice-to-have.

### P1 — strongly recommended (better first impression)

6. **English as 2nd UI language.** Today's UI is German-first throughout.
   External audience is English-first. Options:
   - **Add i18n layer (preferred):** react-i18next or vue-i18n-
     equivalent. Extract all user-visible German strings into
     `locales/de/*.json`. Add `locales/en/*.json`. Default to English
     in production, user-toggleable. German stays as the maintainer's
     daily language.
   - **Quick-and-dirty:** just translate the top ~30 most-visible
     strings for the public demo. Skip the rest. Cheap but permanent
     debt.
   - Recommendation: i18n layer, even if only ~60% translated at
     release time. Opens PRs for community to fill gaps.

7. **Backend errors in English + machine-codes.** Today's 400/404/409
   bodies carry German `message` + machine `code`. Switch `message`
   to English; keep `code` as the authoritative identifier. Frontend
   consumes `code` → translates via i18n table (German + English).
   Benefits:
   - Open-source contributors can debug errors without knowing German.
   - Frontend can display the right language per user preference.
   - API consumers (future mobile app, integrations) get
     machine-readable codes + English fallback.
   - Concrete work: grep every `FamilienResults.BadRequest(...,
     "German message")` call, swap the literal to English. ~30
     locations.

8. **Frontend error-UX gap — save failures are invisible.** Concrete
   example: BUG-044 (0,25 with comma-decimal) surfaced as a silent
   400 from the backend; the form showed no feedback to the user.
   Needs:
   - Every mutation hook (`useCreateRecipe`, `useUpdateRecipe`,
     `useSaveMealPlanSlot`, …) must plumb an `error` state to its
     caller.
   - Every form page must render error toasts + inline field errors
     when the mutation fails. Use the shadcn/ui `<Toast />` or a
     small inline `<ErrorBanner />` primitive.
   - Systematic audit: list every mutation, list every form, ensure
     every `mutateAsync()` call has a `.catch()` with user-facing
     surface. Today many have `console.error` only.
   - Validation-error mapping: 400 `invalid_value` → inline error
     under the offending field. 409 version-mismatch → banner with
     "someone else edited this; reload". 500 → generic toast
     "Unknown error, try again".
   - This alone is probably 1-2 days of audit + patch work across
     ~15 mutation sites. Worth doing before release — silent failures
     are THE most common new-user complaint in OSS apps.

### P2 — nice to have (can follow up after release)

9. **`CONTRIBUTING.md`** — setup, PR conventions (Conventional
   Commits + Co-Authored-By trailer), test requirements, the 4-stage
   review + TDD discipline from `CLAUDE.md`, design-doc flow.

10. **`SECURITY.md`** — how to report vulnerabilities (GitHub Security
    Advisory private disclosure). Scope: everything in `apps/` + the
    Docker compose files. Out-of-scope: third-party dependencies (use
    their disclosure channels).

11. **Demo deployment.** Either keep the existing `kochbuch.kaulig.dev`
    behind a read-only demo account ("demo@..." / "demo"), or spin up
    a fresh demo on a throwaway subdomain. Show the UI without
    requiring Azure credentials (stub the extractor with a
    pre-recorded response). Nice for README link.

12. **Demo video / GIF.** 30-60 s screen-capture of:
    - Importing a Facebook reel URL.
    - The multi-component detail page.
    - Adjusting portions.
    - Cook-Now mode.
    Embed at the top of the README.

13. **Architecture decision records (ADRs).** We have design-docs per
    slice already. Extract the top 5-10 decisions as ADRs:
    - Why PWA over native mobile.
    - Why .NET + Python + React tri-stack instead of one language.
    - Why docker-compose over k8s.
    - Why Whisper local-CPU over cloud STT.
    - Why components as a separate entity over recipe-fork for
      sub-recipes.

14. **LiteLLM adapter / Ollama support doc.** Show external users how
    to run without Azure OpenAI. Worst-case: they need to edit the
    `AZURE_OPENAI_ENDPOINT` env-var to point at a LiteLLM-proxy in
    front of Ollama. Simple.

15. **Legal disclaimer** for social-video import: "This project uses
    yt-dlp to fetch publicly-available video metadata + audio for
    personal use. It is the USER's responsibility to comply with the
    source platform's Terms of Service. The project does not
    encourage redistribution of extracted content." In README + form
    page.

## Proposed release sequence

- **Week 1:** P0 blockers 1-5 (secrets, license, README, rebrand,
  workflow-cleanup).
- **Week 2:** P1 item 8 (frontend error-UX audit + patch). This is the
  highest-impact UX improvement.
- **Week 3:** P1 items 6-7 (i18n + English backend errors). This is
  the biggest chunk — can slip.
- **Week 4 (optional):** P2 items 9-15 to polish.
- **Release as `v1.0.0` or `v0.12.0`:** user's call on versioning.
  `v0.x` signals "still iterating, no SemVer commitment"; `v1.0`
  signals "ready for adoption". Either works.

## Dispatched as slices

Each section above fits a focused sub-agent slice:

1. **REL-0 secrets-audit** — grep, rotate if needed, scrub
   `.env.example`, replace fixtures.
2. **REL-1 readme + license + rebrand** — LICENSE, README, scrub
   personal references.
3. **REL-2 workflow cleanup** — deploy.yml comments, optional public
   CI.
4. **REL-3 i18n foundation** — install library, extract top-40 strings
   into locale files, wire toggle, ship German + English.
5. **REL-4 backend errors English + codes audit** — grep every
   `FamilienResults.BadRequest`, `ErrorResponse`, etc.; English
   messages; frontend translation table.
6. **REL-5 frontend error-UX audit** — list every mutation, add user-
   visible error surface, inline field errors, toast primitive.

Order: REL-0 first (security), then REL-5 (biggest UX win), then
REL-3 + REL-4 in parallel (i18n needs backend codes to be stable),
then REL-1 + REL-2 (polish).

Target tag: `v0.12.0` (signals "moving toward 1.0 but still iterating").

## Scope cuts / follow-ups

- **No native mobile app.** PWA stays the only mobile surface. A real
  React Native client is a 3-month slice nobody's asking for.
- **No multi-tenant hosting.** Still a single-family app per instance;
  forks self-host.
- **No translation-quality QA.** English will be rough at v0.12.0.
  Native-speaker PRs welcome.
- **No monetisation.** The open-source release is the goal; no
  premium tier, no sponsorship tiers, no "buy me a coffee". If
  someone wants to commercialise, MIT allows it.

## Open questions — LOCKED 2026-04-22

- **Repo name:** `kay-solutions/open-cookbook` (the `open-cookbook`
  GitHub org is taken, but the repo slug under the existing
  `kay-solutions` org is free). Local package name + docker-image
  names migrate to `open-cookbook-*` over time but not blocking.
- **Release version:** `v0.12.0` — **beta vibe, explicitly far from
  1.0**. README calls out "early / iterating / SemVer starts at 1.0"
  so no accidental breaking-change-expectation from integrators.
- **Demo deployment:** none. Setup is "git clone + `.env` + docker
  compose up -d" — the HOWTO (see REL-6 below) is the entry point.
- **HOWTO doc:** explicit first-class deliverable (REL-6). Covers
  every env var, minimum required Azure credentials (with alternatives
  via LiteLLM/Ollama), common gotchas (Whisper first-boot download,
  SeaweedFS retention, orchestrator-bot-seeding), troubleshooting.
  Lives at `docs/SETUP.md`, linked from README. Aim: anyone with Docker
  + a text editor can boot the stack in < 15 minutes.

## Dispatched as slices — sequence confirmed

1. **REL-0 secrets-audit** — git history grep, rotate, scrub
   `.env.example`, neutralise migration seeds + fixtures.
2. **REL-5 frontend error-UX audit** — silent save-fails are the
   worst first-impression. Fix before the public sees them.
3. **REL-3 i18n foundation + German/English string extraction**.
4. **REL-4 backend errors → English + code-based frontend translation**.
   Parallel to REL-3 where file-disjoint, otherwise sequential.
5. **REL-1 LICENSE + README + rebrand to `open-cookbook`** — final
   polish once the code is public-ready.
6. **REL-6 SETUP.md HOWTO** — step-by-step, env-by-env, with LiteLLM
   alternative documented.
7. **REL-2 workflow cleanup** (optional, can follow the first public
   release).

Target tag for the public-ready state: **`v0.12.0`**. Cut it after
REL-5 + REL-1 + REL-6 at minimum. i18n + error-code audit can slip
into `v0.12.x` patches.
