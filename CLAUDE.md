# Claude operating guide — Familien-Kochbuch

This file is loaded on every Claude session in this repo. It documents
how we work together, not what the code does.

## Stack at a glance

Monorepo (pnpm workspace) with three deployables + one shared package:

- `apps/api` — .NET 10 ASP.NET Core Minimal API + EF Core + Postgres 17.
- `apps/web` — React 19 + Vite 6 + Tailwind 4 + shadcn/ui (New York,
  neutral) + Lucide icons. German UI throughout.
- `apps/python-extractor` — Python 3.13 FastAPI + yt-dlp + faster-whisper
  + Azure OpenAI. Called by the API for URL/video/photo imports.
- `packages/shared` — TypeScript DTOs shared between web + (future) other
  frontends.

Local stack runs via `docker compose up -d` (Postgres + Redis +
SeaweedFS + all three services + Caddy on `:80`). Bot account seeded at
`orchestrator@EXAMPLE_HOST` when `ORCHESTRATOR_PASSWORD` is set
in `.env` (dev password is already there).

## How we work

### 4-stage flow per non-trivial slice

Every non-trivial code slice goes through this sequence:

1. **Implementation** — TDD (see below).
2. **/simplify review** — scan the diff for YAGNI, dead abstractions,
   speculative generality. If you extracted a helper that's used once,
   inline it.
3. **/security review** — who's the attacker, what's the blast radius?
   For dual-use changes (auth, SSRF, URL handling), list the threat
   model explicitly.
4. **fix-commit** — apply the findings from stages 2–3 as additional
   commits, not amendments.
5. **Final reviewer pass** — verdict: ship / ship with caveats / block.
   Cite `file:line` for anything flagged.

The first four stages happen inline inside the implementing sub-agent.
The fifth can be the same sub-agent's self-review at the end.

### TDD is the default

Red → Green → Refactor. For every non-trivial behaviour change:

1. Write a test that captures the intended behaviour. Run it — it
   MUST fail with an assertion that clearly demonstrates the missing
   behaviour ("genuinely red"). If it passes immediately, the test
   isn't exercising what you think it is.
2. Write the minimum code to make it pass.
3. Refactor with the test still green.

Mechanical edits (renames, import moves, pure doc-sweeps) don't need
TDD. When in doubt: write the test first.

### Sub-agents in background

When the orchestrator (the main Claude session) dispatches
implementation work, it uses `run_in_background: true` by default. The
orchestrator stays reactive to the user while sub-agents churn. Don't
spawn foreground sub-agents unless the result blocks the very next
decision.

### Autonomous mandate

Stop only if truly blocked (missing secret, ambiguous product
decision, destructive action that warrants confirmation). Otherwise:
decide, act, document the deviation in the commit body or report.
Don't ask a question the code can answer.

### No deprecation shims

This is a single-user app. When replacing old code with new, hard-
delete the old. No `// @deprecated` comments, no re-exports, no
backwards-compat flags. The exception is a DB-migration window where
old and new rows must coexist — and even then, the window is bounded
and planned.

### Test bugs with provided links first

When the user reports a bug with a URL ("import this video and you'll
see"), reproduce the bug live before hypothesising root cause. Don't
armchair-diagnose — the user's reproduction is usually the shortest
path to the actual problem.

### Local E2E for UI-heavy slices

Playwright E2E lives in `apps/web/e2e/`. Run with
`PLAYWRIGHT_TEST_EMAIL=orchestrator@EXAMPLE_HOST
PLAYWRIGHT_TEST_PASSWORD=<value-from-.env> pnpm --filter web exec
playwright test --config=playwright.docker.config.ts <spec-file>`.

- Use the **bot account** (`Role=User`) not admin. Admin bypasses
  group-membership gates on several endpoints and hides authz
  regressions.
- UI-heavy slices (full user flow spanning ≥ 3 pages, service-worker
  / offline / caching, PWA-install-only behaviour) should ship with a
  Playwright spec.
- The `playwright.docker.config.ts` runs against the full docker
  stack on `http://localhost`. The default `playwright.config.ts`
  uses `pnpm preview` for SW/offline specs.
- Specs that need creds should `test.skip(!email || !password, …)` so
  they silently skip when env vars are missing.

### Test commands

```bash
# Backend
dotnet test apps/api/FamilienKochbuch.sln

# Web unit + integration
pnpm --filter web run test

# Shared
pnpm --filter shared run test

# Python extractor — match CI gates locally (it runs `--strict`)
cd apps/python-extractor && uv run pytest
cd apps/python-extractor && uv run ruff check .
cd apps/python-extractor && uv run ruff format --check .
cd apps/python-extractor && uv run mypy --strict src tests

# Full lint / build
pnpm --filter web run lint
pnpm --filter web run build
dotnet build apps/api/FamilienKochbuch.sln
```

### Pre-tag checklist

A `v*` tag push burns CI minutes AND is the slowest feedback loop in
the repo. Before tagging, run the Python four-gate (pytest + ruff
check + ruff format + `mypy --strict`) AND the .NET + web suites
locally. v0.12.x burned three tags to catch:

- Unused `# type: ignore` comments (permissive local mypy hides them;
  `--strict` in CI flags them).
- `with TestClient(app)` in a test fixture kicking off the Whisper-
  prefetch lifespan task — trivial locally where the HF cache is warm,
  multi-minute hang on fresh CI runners.

Guard the pattern by checking `PYTEST_CURRENT_TEST` in expensive
lifespan / startup hooks, and by running the same commands CI runs
before you tag.

### Known-flaky tests

- `FamilienKochbuch.Api.Tests.ChatEndpointsTests.Turn_AutoTitle_Triggered_On_First_Turn`
  — occasional SQLite "database is locked" under high test-parallelism
  on GHA runners. Re-run the failed job (`gh run rerun <id> --failed`)
  before assuming a real regression; fix-commit only after a second
  failure.

## Deploy

- GitHub Actions `Deploy` workflow triggers on any `v*` tag push:
  builds three Docker images (api, web, python-extractor), pushes to
  GHCR, deploys to VPS via compose.
- **Tag sparingly** — each tag push burns ~10 min of Actions minutes.
  Don't tag after every slice. Bundle multiple slices and tag once
  when you actually intend to deploy.
- Commit freely to `main` without tagging. A tag is a deliberate
  release gate.
- When bundling, write the tag annotation as a changelog: what
  features + bugs are in this release. Example: look at `git show v0.9.3`.

## Commits

Conventional-commit style with one-line subject + optional body. Scope
in parens matches the feature area:

- `feat(web)` / `feat(api)` / `fix(reimport)` / `docs(plans)` etc.
- Body explains the "why" when non-obvious. Reference bug / slice IDs
  (BUG-047, TABLET-3, PAGE-0) when relevant.
- Always include the co-authored-by trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Never amend pushed commits. Create new ones.
- Never commit `.env` or other secrets.

## Brainstorming + design docs

When the user wants a non-trivial new feature:

1. Run the brainstorming skill — **one question at a time**, multiple
   choice when possible.
2. Once decisions are locked, write a design doc to
   `docs/plans/YYYY-MM-DD-<topic>-design.md` and commit it.
3. Dispatch implementation sub-agents with the design doc as the
   authoritative reference.

Existing design docs live in `docs/plans/` — skim them before
proposing anything that overlaps with an in-flight initiative.

## CSS + layout

The app uses the **hoppr-style** root pattern to keep the BottomNav
docked correctly when the browser chrome animates in/out (BUG-039):

```
<div class="fixed inset-0 flex flex-col overflow-hidden">
  <header>…</header>         {/* sticky at top */}
  <main class="overflow-y-auto">…</main>   {/* the only scroller */}
  <footer>…</footer>         {/* sticky at bottom */}
</div>
```

CSS variables carry layout invariants:
- `--bottom-nav-height` — BottomNav height at `< md`.
- `--side-rail-width` — SideRail width at `md:`–`xl:`.
- `--desktop-topnav-height` — Desktop TopNav height at `≥ xl`.
- `--split-left-width` — SplitPane left column width.
- `--topnav-height` — the sticky avatar banner (all viewports).

Don't touch these root invariants without a test that would catch
a regression.

## German UI copy

All user-facing strings are German. When dispatching sub-agents,
remind them explicitly. Labels / placeholders / toasts / empty-states
/ error-messages all in German. Exception: technical code comments
stay English.

## Repo docs we keep current

These files describe the project to outside readers. They drift from
reality if nobody maintains them. When you change code, check whether
any of these need a parallel edit:

- **`README.md`** — landing page. Update when: new feature surfaces
  on the 30-second pitch (e.g. share-target lands), new headline
  screenshot is worth showing, the 30-sec quick-start commands
  change, a badge is obsolete.
- **`docs/SETUP.md`** — runbook. Update when: new env var added,
  docker-compose profile added or changed, migration requires an
  operator action, a new "common gotcha" is found in practice, the
  Whisper/Ollama/Azure setup diverges from what's documented.
- **`CLAUDE.md`** (this file) — operating rules. Update when: a
  process rule changes (e.g. test command renamed), a new
  constraint is enforced (e.g. a new hook), a stack component is
  added/removed, a new CLAUDE-assisted workflow is adopted.
- **`docs/CONTRIBUTING.md`** — PR guide. Update when: commit
  convention evolves, new lint rule, test requirement, or review
  gate lands.
- **`docs/SECURITY.md`** — disclosure channel. Update when:
  contact / scope / response SLA changes.
- **`docs/plans/*.md`** — design docs of shipped slices. Don't
  retro-edit shipped design docs; start a new dated one for
  amendments.
- **`docs/bugs-backlog.md`** — bug history. Append a `[x] fixed` row
  when a bug bundle ships.

**Rule of thumb:** if your code-change would surprise someone reading
only the docs, the docs need an edit in the same PR. No separate
"docs follow-up" tickets.

## Scope of memory vs. CLAUDE.md

This file is the shared, checked-in operating guide. It should stay
stable and repo-wide. Anything session-specific or personal goes into
the per-user memory (`/Users/<you>/.claude/projects/…/memory/`). The
memory system's rules about what to save and what not to save still
apply.
