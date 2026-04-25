# CONTRIB-1: CONTRIBUTING.md + PR/Issue Templates

**Date:** 2026-04-25
**Status:** Designed, ready to dispatch
**Scope:** Single slice. Closes the OSS-hygiene gap that REL-1's
README left flagged ("CONTRIBUTING.md referenced but doesn't exist").

## Why

`README.md` (REL-1) and `docs/SETUP.md` (REL-6) reference a
`CONTRIBUTING.md` that does not exist yet. Public-flip without one
would break the documentation links and signal an unfinished repo.
CONTRIB-1 fills that gap with a tiered, accessible, AI-friendly
contribution guide plus PR / issue templates that lower friction
for first-time contributors.

## Decisions locked (from brainstorm 2026-04-25)

- **Scope (Q1-A):** CONTRIBUTING.md + 5 ADRs as one atomic slice.
  ~~ADRs~~ struck mid-brainstorm — historical `docs/plans/*.md`
  cover the architectural rationale, ADRs are overkill for a
  single-family hobby OSS app. Slice is now CONTRIBUTING.md +
  templates.
- **Tone (Q3-C):** Tiered. Small PRs (typo fixes, locale
  contributions, single-file bugfixes) require only tests + lint +
  conventional commits. Larger PRs (features, multi-file refactors)
  require issue-first discussion, simple plan, TDD encouraged.
- **Companions (Q4-C):** PR template + bug + feature issue templates
  + config.yml. AI-attribution guidance lives in CONTRIBUTING.md.
  No CODE_OF_CONDUCT.md (no real community forum yet — empty
  promise). Optional later if community grows.

## Components

### `CONTRIBUTING.md` (Root)

GitHub-standard root path. Sections:

1. **Introduction** — what `shared-cookbook` is, hobby OSS context,
   honest expectations (response in days–weeks, not 24h).
2. **Getting started** — link to `docs/SETUP.md`. No duplication.
3. **Types of contributions:**
   - Locale translations (entry point: `apps/web/src/locales/`)
   - Bug fixes (small → direct PR; larger → issue first)
   - Documentation
   - Feature requests (issue first for direction alignment)
4. **Tiered PR expectations:**
   - **Small PRs:** `pnpm install`, relevant tests green, lint clean,
     Conventional Commits. No issue-first.
   - **Larger PRs:** issue-first, simple plan, TDD encouraged but
     not enforced for community contributions.
5. **Coding standards (concise):**
   - Conventional Commits (`feat(scope): ...`)
   - Tests + lint green pre-PR
   - Code comments in English
   - User-facing strings via i18n (`apps/web/src/locales/`)
6. **AI-assisted contributions** — explicitly welcome. Reference the
   project's own AI-orchestrated build (README "AI-orchestrated dev
   case study"). Add `Co-Authored-By: <Model> <noreply@anthropic.com>`
   trailer when AI-assisted. Contributor reviews + owns the change.
7. **Test commands** — quick reference (Web/Shared/.NET/Python),
   pointing to SETUP.md for details.
8. **License** — MIT, all contributions licensed under MIT, see
   `LICENSE`.
9. **Maintainer + response time** — honest hobby-OSS expectations,
   GitHub Issues + Discussions as primary channel.

### `.github/PULL_REQUEST_TEMPLATE.md`

Auto-inserted into new PR descriptions. Sections:
- Summary (1-3 bullets)
- Related issue (`Closes #N` or "no issue (small change)")
- Test plan (markdown checklist of verifications run locally)
- AI-assisted? (confirm review + Co-Authored-By trailer)

### `.github/ISSUE_TEMPLATE/bug-report.yml`

GitHub-native YAML form. Title-prefix `[Bug]`. Fields:
- Summary (required)
- Steps to reproduce (required)
- Expected vs. actual behaviour
- Environment (browser / OS / stack component)
- Console / log output
- Screenshots
- Auto-label: `bug`

### `.github/ISSUE_TEMPLATE/feature-request.yml`

YAML form. Title-prefix `[Feature]`. Fields:
- Use case (required, "describe the user problem")
- Proposed solution (optional)
- Alternatives considered
- Scope estimate (small / medium / large)
- Auto-label: `feature`
- Body note: "For larger features, please discuss in the issue
  before opening a PR — see CONTRIBUTING.md tiered-PR-expectations"

### `.github/ISSUE_TEMPLATE/config.yml`

- `blank_issues_enabled: false` — forces structured triage
- `contact_links`:
  - Setup help → `docs/SETUP.md`
  - Security issues → GitHub Security Advisories link
    (path documented in `docs/SECURITY.md` per REL-0b)

## Out of scope

- `CODE_OF_CONDUCT.md` (no community forum yet)
- DCO / sign-off-required (overkill for hobby OSS)
- ADRs (deferred / struck — historical design-docs cover the same
  ground)
- `docs/CONTRIBUTING.md` path — we use root path. README + SETUP.md
  references will be updated to point at root.

## Architecture / rollout

Three commits direct on main (no worktree — pure docs, zero code
risk):

1. `docs(contrib): CONTRIB-1 add CONTRIBUTING.md with tiered PR expectations`
   - New: `CONTRIBUTING.md` (root, ~250 lines, English)
   - Update: `README.md` / `docs/SETUP.md` if they reference
     `docs/CONTRIBUTING.md` — point to root
2. `docs(contrib): CONTRIB-1 add PR + issue templates`
   - New: `.github/PULL_REQUEST_TEMPLATE.md`
   - New: `.github/ISSUE_TEMPLATE/bug-report.yml`
   - New: `.github/ISSUE_TEMPLATE/feature-request.yml`
   - New: `.github/ISSUE_TEMPLATE/config.yml`
3. (conditional) `docs(readme): CONTRIB-1 link CONTRIBUTING.md from README`
   — only if README has no link or wrong path

## Verification

- Markdown render: visual spot-check using GitHub's PR-preview after
  push (pure markdown, low risk)
- YAML syntax: `python3 -c "import yaml; yaml.safe_load(open(path))"`
  for each `.yml` template
- Link check: `rg '(SETUP|SECURITY|LICENSE|CONTRIBUTING)\.md' README.md docs/`
  — all referenced files exist
- No test-suite implications (pure docs)

## Risks

- **PR / issue template friction:** YAML forms can feel rigid for
  experienced contributors. Mitigation: keep field count small, mark
  most as optional, allow "no issue (small change)" in PR template.
- **Tiered expectations confusion:** new contributors might pick the
  wrong tier. Mitigation: explicit examples in each tier ("typo fix",
  "locale add", "feature request").
- **AI-attribution awkwardness:** some contributors don't want to
  disclose AI use. Mitigation: phrase as "encouraged" not "required",
  point to project's own use as precedent.

## Slice position

CONTRIB-1 is the last documentation gap before public-flip. After
this slice the docs structure is complete: README + LICENSE + SETUP +
SECURITY + CONTRIBUTING + ISSUE/PR templates.

Operator's pre-flip checklist (FOLLOWUPS-1 D-block) follows. Then
visibility flip.
