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
     apikey|bearer' | less`). Consider running `gitleaks detect` for
     a systematic scan.
   - Rotate any leaked secret before going public. Fresh JWT signing
     key, Azure OpenAI key, SMTP password, Caddy ACME email, SeaweedFS
     access keys — if ANY appeared in git, rotate.
   - `.env` stays in `.gitignore`. `.env.example` gets scrubbed: only
     placeholder values (`CHANGE_ME`), with comments explaining each
     key + how to generate.
   - Check `docker-compose*.yml` for hard-coded defaults that look
     secret-ish; replace with `${VAR}` lookups.
   - Scrub migration seeds + test fixtures for real email addresses /
     names — `maintainer@example.com`, `Example Family` etc. Replace
     with neutral example values.

1b. **Workflow + deployment visibility audit.** The repo becomes
    public but the deploy workflow should keep working unchanged —
    GitHub only exposes the workflow CODE (not secret values), and
    only tag-pushes (which external contributors can't do) trigger
    deploy. Things to verify before flipping repo-visibility to
    public:
    - Every `${{ secrets.XXX }}` reference in `.github/workflows/
      deploy.yml` stays as-is (names visible, values hidden). No
      change needed.
    - `deploy.yml` contains no HARD-CODED sensitive values —
      hostnames, email addresses, API URLs. Anything not
      `${{ secrets.XXX }}` is public. Grep for `.com`, `.dev`,
      `kaulig`, `@` inside the workflow + fail-fix any personal
      references. Keep generic names like container-names (`familien-
      kochbuch-api`) — those are fine to be public.
    - Past workflow run logs go public too. Spot-check a handful of
      recent runs in the GitHub UI — expand the log view, confirm all
      `${{ secrets.XXX }}` values show as `***`. If any secret ever
      leaked into a log line (e.g. `echo $AZURE_OPENAI_API_KEY` for
      debugging) that run log is public when the repo is public. **You
      can delete specific runs or clear run history entirely** in repo
      settings before flipping to public — recommended as a final
      safety step.
    - GHCR package visibility: by default, packages inherit repo
      visibility. If you flip the repo to public, the three packages
      (`familien-kochbuch-api/web/python-extractor`) become public-
      pullable unless you manually set `visibility: private` on each
      at `github.com/orgs/kay-solutions/packages/container/<name>/
      settings`. **Recommendation: make them public.** Easier for
      external users to do `docker compose pull` without a GHCR
      login, the image contents are just the OSS code anyway, and it
      signals "this project is meant to be run by others".
    - The `kay-solutions` org name appears in image paths
      (`ghcr.io/kay-solutions/...`). That's fine to be public — just
      be aware it's visible in the Compose files forever.
    - Fork-PR secret isolation is GitHub's default behaviour —
      external PRs cannot access secrets. No config needed to enable
      that, but verify the `permissions:` block at the top of each
      workflow isn't overly permissive (should be `contents: read` +
      `packages: write` only where actually needed).
    - Consider enabling "Require approval for all outside
      contributors" in Actions settings so PRs from strangers need
      maintainer approval to run CI. Prevents abuse of GitHub-hosted
      runner minutes.
    - Nice-to-have: enable GitHub's **Secret Scanning** + **Push
      Protection** under Settings → Code security. Free for public
      repos; catches future accidental secret commits before they
      land.

    **Ops architecture decision:** single public repo. No split into
    "public code + private deploy-dispatcher" needed — the tag-only
    trigger + fork-PR secret isolation are sufficient for a hobby
    project. If paranoia-level later demands it, the escape-hatch is
    to move `deploy.yml` into a separate private repo that receives
    `repository_dispatch` from the public one. Documented as
    follow-up, not a release-tag gate.

1c. **Code-level security audit** (REL-0b). Going public means every
    curious eyeball can read the code looking for bugs. Systematic
    sweep beforehand closes the obvious holes before they become
    public CVEs. Runs parallel to REL-0 (different files).

    **Automated tooling (run all, triage findings):**
    - **Dependency audits** across all three stacks: `pnpm audit`,
      `dotnet list package --vulnerable --include-transitive`,
      `uv run pip-audit`. High/Critical → fix before release.
      Medium → triage + fix or file issue + accept. Low → track.
    - **Enable GitHub CodeQL** (free for public repos). Analyses
      .NET + TypeScript + Python on every push. Activate at
      repo-visibility-flip time, triage initial findings within a
      week. Expect ~10-30 findings; most informational, few real.
    - **`gitleaks detect`** full-history scan right before going
      public. Bigger ruleset than the REL-0 ad-hoc grep.
    - **`trivy fs .`** against each built Docker image post-build.
      Catches OS-package CVEs in the base images; informs base-tag
      bumps.
    - **Dependabot** enabled for weekly security-only PRs against
      `pnpm-lock.yaml`, `.csproj`, `uv.lock`, + GitHub Actions
      versions.
    - **Secret Scanning + Push Protection** (also mentioned in 1b —
      restated here as part of the security surface).

    **Manual OWASP-Top-10 walkthrough.** Walk file-by-file, capture
    findings in `docs/SECURITY-AUDIT-2026-04.md` as "observed +
    severity + fix-or-accept":
    - **A01 Broken Access Control** — every data-accessing endpoint
      has `[Authorize]` + group-membership or admin-role gate.
      Spot-check by listing all endpoints from Program.cs + endpoint
      files.
    - **A02 Cryptographic Failures** — JWT HS256 + signing-key
      entropy ≥ 256 bit via env. Refresh-token cookie flags:
      HttpOnly / Secure / SameSite. Password hash (Argon2id).
      SeaweedFS signed-URL TTL reasonable.
    - **A03 Injection** — grep for `FromSqlRaw` / `ExecuteSqlRaw`
      (must be parameterised); `Process.Start` / `subprocess` (no
      user input); unsafe-HTML React sinks (should be 0 hits);
      prompt injection via `<untrusted_blog>`-delimiter pattern —
      verify captions + transcripts get the same wrapping.
    - **A04 Insecure Design** — business-logic edges: recipe-scale
      math with negatives/overflow, meal-plan slot double-booking,
      shopping-list dedupe-merge, portion-slider clamps.
    - **A05 Security Misconfiguration** — Caddyfile security headers
      (CSP, HSTS, X-Frame-Options, X-Content-Type-Options). CORS on
      the .NET API (same-origin only, not `*`). ASP.NET prod error
      pages (no `UseDeveloperExceptionPage`, no stack-trace leaks).
      Docker containers run as non-root.
    - **A06 Vulnerable Components** — automated-tooling block above.
    - **A07 Auth Failures** — password policy (length/complexity),
      login rate-limit threshold, session timeout, no-2FA-yet
      documented as follow-up not blocker.
    - **A08 Supply Chain** — all three lockfiles committed,
      reproducible builds, signed container images? (optional for
      the first public release).
    - **A09 Logging + Monitoring** — grep log statements for PII
      (emails, tokens, full URLs). `_redact_host()` covers URLs in
      Python; verify no untreated URL → log path. Audit-log
      retention in ExtractorConfigHistory.
    - **A10 SSRF** — ThumbnailAttacher eTLD+1 + DNS-public-IP guard
      from BUG-047. Python `_assert_safe_http_target`. Every
      outbound HTTP path goes through one of those two guards.

    **AI-specific threats (not in classic OWASP):**
    - **Prompt injection.** Untrusted caption/transcript/blog-text
      must reach Azure only inside a trust-delimiter the system
      prompt knows about. We have `<untrusted_blog>` for blog text;
      verify captions + transcripts wrap similarly.
    - **Azure training opt-out.** Azure OpenAI does NOT use customer
      data for model training by default, but abuse-monitoring logs
      retain inputs for 30 days. Document the data-flow in
      SETUP.md so self-hosters know what Azure sees.
    - **Cost amplification.** Rate-limiting on import endpoints —
      check if present; if not, add a TODO + document so
      self-hosters can add their own. `max_completion_tokens`
      capped at 8192 already.
    - **Model jailbreaks.** Azure's safety layer is the backstop;
      nothing more we can do beyond that.

    **Deliverables:**
    - `docs/SECURITY-AUDIT-2026-04.md` with findings, severity, and
      fix-or-accept per finding.
    - `docs/SECURITY.md` (GitHub-standard file) with private-
      disclosure contact (GitHub Security Advisory link).
    - Fix-commits for P0 + high findings, before the public-release tag.
    - Repo-level automation enabled at visibility-flip time
      (CodeQL, Dependabot, Secret Scanning, Push Protection).

    **Out of scope for the public-release:**
    - External penetration test (expensive, overkill for hobby).
    - 2FA / WebAuthn (follow-up feature).
    - Formal threat-model document (audit doc + bug backlog serve
      that role).
    - Signed-image supply-chain (sigstore / cosign).
    - Continuous security-scanning SLA (community-driven).

2. **`LICENSE` file.**
   - **MIT** — maximum permissive, simple two-paragraph license.
     Copyright holder is the project owner. Year = 2026.
   - Alternative AGPL if we specifically want to prevent closed-source
     SaaS forks. Not our concern for a hobby project → MIT.

3. **`README.md` rewrite for external audience.**
   > Detail brief lives in `docs/plans/archive/2026-04-22-readme-and-setup-content-plan.md` — REL-1 sub-agent reads it as the authoritative section-by-section outline.
   - Remove family-specific framing. Short project description +
     "Why does this exist" + screenshots.
   - Architecture section: one diagram of the 3 services + their
     boundaries. Key decisions called out (PWA offline, AI extraction,
     single-user-per-group vs family-sharing).
   - Quick-start: `docker compose up -d` + admin credentials in
     `.env.example` + `http://localhost`.
   - "How to try the AI import": needs Azure OpenAI credentials, here's
     how to wire them, plus a native Ollama backend for self-hosted
     inference.
   - Dev setup: `pnpm install`, `pnpm --filter web dev`, `dotnet
     watch`, `uv run uvicorn ...` per app.
   - Test run: `pnpm --filter web run test`, `dotnet test`, `uv run
     pytest`, `pnpm --filter shared run test`.
   - Link to `docs/` for plans + bug-backlog + CLAUDE.md for
     contributors.

4. **Rebrand.** Search-and-replace `EXAMPLE_HOST` and personal
   email addresses; replace with `EXAMPLE_HOST` / `admin@example.com`
   in public-visible config. Public project name is `shared-cookbook`
   — connotes the multi-user / groups feature without pinning a
   specific demographic ("family"), and the slug is clean across
   GitHub, npm, PyPI, crates.io, and the major TLDs (verified
   2026-04-25). Internal German UI label "Familien-Kochbuch" can
   stay as a localised label inside the app if desired, but every
   public-facing surface (repo, README title, image names, package
   names) uses `shared-cookbook`.

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

### P2 — polish (all land before release too, not post-public)

9. **`CONTRIBUTING.md`** — setup, PR conventions (Conventional
   Commits + Co-Authored-By trailer), test requirements, the 4-stage
   review + TDD discipline from `CLAUDE.md`, design-doc flow.

10. **`SECURITY.md`** — how to report vulnerabilities (GitHub Security
    Advisory private disclosure). Scope: everything in `apps/` + the
    Docker compose files. Out-of-scope: third-party dependencies (use
    their disclosure channels).

11. **Demo deployment.** Either keep the existing `EXAMPLE_HOST`
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

14. **Ollama provider** (covered in REL-7's sub-slice plus REL-6's
    SETUP.md section). Native integration in
    `apps/python-extractor/src/extractor/llm/ollama.py`, sibling to
    the existing `azure_openai.py`. Routed via a new config key
    `llm.provider = azure | ollama`. Uses Ollama's `/api/chat` with
    `format: { /* JSON-schema */ }` for structured output; streaming
    + vision all natively supported. No third-party proxy
    dependency — keeps the runtime surface + REL-0b audit scope
    tight.

15. **Legal disclaimer** for social-video import: "This project uses
    yt-dlp to fetch publicly-available video metadata + audio for
    personal use. It is the USER's responsibility to comply with the
    source platform's Terms of Service. The project does not
    encourage redistribution of extracted content." In README + form
    page.

## Proposed release sequence

All REL slices land before the repo flips to public — nothing is
deferred. Rough ordering + parallelism (file-disjoint slices can run
simultaneously):

- **Round 1:** REL-0 secrets + REL-0b security + REL-5 frontend
  error-UX, all in parallel. Highest-priority cleanup, different
  files.
- **Round 2:** REL-7 AI-optional + REL-8 JSON-LD parser. Lands the
  "usable without AI" promise. Mostly file-disjoint (REL-7 crosses
  frontend + compose, REL-8 is python-only).
- **Round 3:** REL-3 i18n foundation + REL-4 English backend-errors.
  Coordinated via a shared error-code contract.
- **Round 4:** REL-2 workflow cleanup → REL-1 LICENSE + README +
  rebrand → REL-6 SETUP.md. Sequential because each references the
  final shape of everything above.
- **P2 polish** (CONTRIBUTING.md, SECURITY.md, ADRs, Ollama
  how-to, legal disclaimer, demo video, screenshots) lands
  opportunistically between rounds or as final cleanup. Still
  release-gating — nothing deferred.

Flip repo → public only after EVERYTHING is green. Tag-number at
that moment is whatever semver we're at + one bump. Stays `v0.x`
to signal "still iterating, no SemVer commitment" — `v1.0.0` is
reserved for a real stable-API promise.

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

Target tag: not nailed. Whatever semver-number we're at when the
REL slices all land. The important thing: stay on `v0.x` (beta
vibe, no SemVer commitment), push `v1.0.0` only when we have a
real stable-api promise.

## Scope cuts / follow-ups

- **No native mobile app.** PWA stays the only mobile surface. A real
  React Native client is a 3-month slice nobody's asking for.
- **No multi-tenant hosting.** Still a single-family app per instance;
  forks self-host.
- **No translation-quality QA.** English will be rough at initial
  release. Native-speaker PRs welcome.
- **No monetisation.** The open-source release is the goal; no
  premium tier, no sponsorship tiers, no "buy me a coffee". If
  someone wants to commercialise, MIT allows it.

## Open questions — LOCKED 2026-04-22

- **Repo name:** `kay-solutions/shared-cookbook` (revised
  2026-04-25; previous candidate `open-cookbook` was rejected as too
  generic and didn't capture the multi-user / groups angle). Slug
  verified clean across GitHub, npm, PyPI, crates.io, and major
  TLDs. Local package name + docker-image names migrate to
  `shared-cookbook-*` over time but not blocking.
- **Release version:** not pre-committed — whatever tag-number we
  land on at release time. **Stays `v0.x`** to signal "beta,
  iterating, no SemVer commitment". `v1.0.0` is reserved for when
  we have a stable-API promise.
- **Demo deployment:** none. Setup is "git clone + `.env` + docker
  compose up -d" — the HOWTO (see REL-6 below) is the entry point.
- **HOWTO doc:** explicit first-class deliverable (REL-6). Covers
  every env var, minimum required Azure credentials (with alternatives
  via native Ollama backend), common gotchas (Whisper first-boot
  download,
  SeaweedFS retention, orchestrator-bot-seeding), troubleshooting.
  Lives at `docs/SETUP.md`, linked from README. Aim: anyone with Docker
  + a text editor can boot the stack in < 15 minutes.

## Runs-without-AI: what actually breaks

Inventory of the import pipeline, to inform REL-7 + REL-8 design:

| Pipeline step | Needs AI? | Notes |
|---|---|---|
| yt-dlp video download + metadata | ❌ | Local library. |
| Whisper audio transcription | ❌ | `faster-whisper` runs CPU-locally. |
| Blog HTML fetch + sanitise | ❌ | Plain httpx + HTML stripping. |
| Thumbnail download + SeaweedFS stage | ❌ | No LLM involved. |
| **LLM structuring (unstructured text → ingredients+steps JSON)** | ✅ | gpt-4.1-mini. |
| **Photo/vision analysis** | ✅ | Vision model. |
| **Chat + chat-to-recipe** | ✅ | gpt-5.1-chat + structured extraction. |

So without Azure OpenAI configured, the app is still useful for:
- **Manual recipe CRUD + meal-plan + shopping + ratings + fork +
  Cook-Now + portions + search + PWA offline** (the bulk of the
  product).
- **Blog-URL imports via JSON-LD** (see REL-8 below — most food
  blogs expose Schema.org Recipe in `<script type="application/ld+
  json">`; direct-mappable without any LLM call).
- **Video-URL imports with raw-text pre-fill**: the pipeline still
  downloads, transcribes, grabs title + thumbnail, and returns the
  concatenated raw text into a textarea on the form for the user
  to structure manually. Not as smooth as LLM auto-extract, but
  saves 100 % of the typing the user would otherwise do.

Disabled without AI:
- Photo import (no vision fallback — just a clean 503 + UI hides
  the CTA).
- Chat + chat-to-recipe (same: hidden + 503).

## Dispatched as slices — sequence confirmed

1. **REL-0 secrets-audit** — git history grep, rotate, scrub
   `.env.example`, neutralise migration seeds + fixtures.
1b. **REL-0b security audit** — OWASP Top-10 walkthrough, automated
    scans (pnpm audit / dotnet vulnerable / uv pip-audit / gitleaks /
    trivy), CodeQL + Dependabot enablement, findings doc, fix P0s.
    Parallel to REL-0 since they touch different files but the same
    overall "cleanup before public" mindset.
2. **REL-5 frontend error-UX audit** — silent save-fails are the
   worst first-impression. Fix before the public sees them.
3. **REL-7 AI-optional architecture** — compose profile `ai`,
   `/api/meta/features` endpoint, frontend feature-gate wrapper that
   hides Import-from-Photo / Chat CTAs when disabled + switches
   Import-from-URL to raw-text-pre-fill-only mode. No-AI boot skips
   the Whisper prefetch entirely (save 3 GB download when the user
   isn't going to run video imports). Home-page layout collapses
   the "Import from Video/Photo/Chat" card row when AI is off.
   Includes a **native Ollama backend** as a peer to the existing
   Azure provider: new `apps/python-extractor/src/extractor/llm/
   ollama.py`, sibling to `azure_openai.py`. Routed via new
   config-key `llm.provider = azure | ollama`. Uses Ollama's
   `/api/chat` with `format: { /* JSON-schema */ }` for structured
   output; streaming + vision natively supported. No third-party
   proxy dependency.
4. **REL-8 JSON-LD Recipe parser** — new Python-pipeline branch that,
   before falling through to the LLM, scans the fetched blog HTML for
   `<script type="application/ld+json">` blocks and looks for
   `@type: Recipe`. If found, direct-map to our schema:
   - `name` → title
   - `description` → description
   - `recipeIngredient[]` → ingredients (regex-parse each line into
     quantity + unit + name)
   - `recipeInstructions[]` (string OR `{@type: HowToStep, text}`)
     → steps
   - `recipeYield` → defaultServings (numeric-parse)
   - `prepTime` / `cookTime` (ISO 8601 duration) → minutes
   - `image` → thumbnail_url
   - `recipeCategory` / `keywords` → tag candidates
   - `nutrition.calories` / protein / carb / fat → nutrition_estimate
   Works **with or without AI**. When AI is on: JSON-LD takes
   precedence when present → more accurate than LLM, saves tokens.
   When AI is off: this is the ONLY structured-import path for blog
   URLs. FB/IG reels have no JSON-LD so they still fall back to LLM
   (with-AI) or raw-text (without-AI).
5. **REL-3 i18n foundation + German/English string extraction**.
6. **REL-4 backend errors → English + code-based frontend translation**.
   Parallel to REL-3 where file-disjoint, otherwise sequential.
7. **REL-1 LICENSE + README + rebrand to `familycookbook`** — final
   polish once the code is public-ready.
8. **REL-6 SETUP.md HOWTO** — detail brief in
   `docs/plans/archive/2026-04-22-readme-and-setup-content-plan.md`. Three
   clear paths:
   - **Path 1 — Minimal** (default): `docker compose up -d`. No AI.
     ~1 GB disk, boots in < 2 min. Full app including JSON-LD blog
     imports + manual recipes + meal plan + shopping. Recommended
     starting point.
   - **Path 2 — Full + Azure OpenAI**: `docker compose --profile ai
     up -d` + Azure credentials in `.env`. ~5 GB disk (Whisper
     volume), first-boot downloads `large-v3` once. Max quality for
     AI-structured imports + photo + chat. Cloud-dependent + usage
     costs apply.
   - **Path 3 — Full + self-hosted Ollama**: `docker compose
     --profile ai --profile ollama up -d`. Ollama container + our
     python-extractor connected via `llm.provider=ollama`. Realistic
     model pick for 12 GB VRAM: Gemma 3 12B or Qwen 2.5 14B. CPU-only
     works too (2-3 min per import with 12B-class, ~30 s with 4B).
     ~80 % of Azure quality — structured-JSON accuracy lower,
     occasional manual correction needed. Completely private +
     offline + no cost.
9. **REL-2 workflow cleanup** (part of the release gate — deploy.yml
   comments scrubbed for public audience).

Release-gate: **every REL slice listed above** green (REL-0 + REL-0b
+ REL-1 + REL-2 + REL-3 + REL-4 + REL-5 + REL-6 + REL-7 + REL-8).
Nothing gets deferred into post-public patch releases — when we flip
visibility to public, the project is "complete" for what we've
scoped. Tag-number at that moment is whatever semver we're at — the
plan doesn't nail it because other features might land in between
and push the number elsewhere. What matters: stay `v0.x` for the
public release, reserve `v1.0.0` for a real stable-API commitment.
