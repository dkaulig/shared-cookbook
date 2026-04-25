# ENGLISH-1: Codebase + Docs Consistency Pass to English

**Date:** 2026-04-25
**Status:** Designed, ready to dispatch
**Scope:** OSS-audience consistency — translate CLAUDE.md + active
docs + code comments + variable/function names + test names + log
messages to English. UI translations stay localised via REL-3 i18n.
Historical records preserved per CLAUDE.md rule.

## Why

The codebase shipped with mixed-language content: CLAUDE.md has
some German sections, code comments occasionally drifted from the
"comments stay English" rule, test names are predominantly German
(Vitest `it()` / xunit `[Fact]` / pytest `def test_*`), and a few
log messages emit in German. After REL-3 + RENAME-1/2/3, the brand
and namespace are consistent at `shared-cookbook` / `SharedCookbook`,
but the language inside the code is not. ENGLISH-1 closes this gap
so OSS contributors land in an English-first codebase.

## Decisions locked (from brainstorm 2026-04-25)

- **CLAUDE.md (Q1-A):** translate fully to English. Maintainer is
  bilingual; no UX loss. OSS contributors and Claude both read
  English fluently.
- **Other docs (Q2-A):** active operating docs and `docs/ops.md`
  translate. Mid-tier docs (audit reports etc.) already English.
  Historical timestamped records (`docs/plans/*.md`,
  `docs/phase-1-progress.md`, `docs/design-implementation-progress.md`,
  `docs/bugs-backlog.md`) preserve as-is per CLAUDE.md
  "don't retro-edit shipped design docs" rule.
- **Code surfaces (Q3-A):** comments drift-audit, variable / function
  names if German identifiers exist, test names (Vitest + xunit +
  pytest), log messages — all translate. Test BODY content (German
  UI string assertions) stays — it verifies the German locale
  renders correctly.

## Architecture

Single sub-agent in an isolated worktree. Seven sequential commits
ordered by stack and risk. Each commit ends with all gates green.

```
Worktree spawn
  │
  ▼ Pre-Audit: grep current state of German content per stack
  │
  ▼ Commit 1: CLAUDE.md → English (semantically translated)
  ▼ Commit 2: docs/ops.md + reviewing/ + known-issues/ → English
  ▼ Commit 3: apps/api comments + tests + logs → English
      verify: dotnet build, dotnet test (1755 / 1756)
  ▼ Commit 4: apps/web comments + tests + logs → English
      verify: pnpm web test (1713) + lint + build
  ▼ Commit 5: apps/python-extractor comments + tests + logs → English
      verify: pytest (625) + ruff check + ruff format + mypy strict
  ▼ Commit 6: packages/shared comments + tests → English
      verify: pnpm shared test (112)
  ▼ Commit 7 (CONDITIONAL): variable / function rename if German
        identifiers exist
      verify: all stacks green, audit JsonPropertyName + Reflection
  │
  ▼ Final Audit: grep + aggregate test runs
  ▼ Worktree → main merge (rebase + ff)
```

Out of scope (preserved):
- `apps/web/src/locales/de/*.json` — German UI translations stay per
  REL-3 maintainer-daily-driver decision
- Historical `docs/plans/*.md`, `docs/phase-1-progress.md`,
  `docs/design-implementation-progress.md`, `docs/bugs-backlog.md`
- Already-English files: REL-1's `README.md`, REL-6's
  `docs/SETUP.md`, REL-0b's `docs/SECURITY.md` and
  `docs/SECURITY-AUDIT-2026-04.md`
- Seed data and DB content
- EF Core migrations and Python migration files (date-stamped class
  names that are wire-protocol with the DB)

## Components / per-commit scope

### Commit 1 — `docs(claude): ENGLISH-1 translate CLAUDE.md to English`

CLAUDE.md fully translated. The file is nuanced (operating-rules
tone, code examples that reference German UI strings, the auto-memory
section). Translation must be semantically accurate, not morphological:
preserve voice, code examples stay verbatim, German strings in
example snippets stay (they're examples of UI content, not
prescriptions).

### Commit 2 — `docs(ops): ENGLISH-1 translate ops.md + reviewing + known-issues to English`

`docs/ops.md`, `docs/reviewing/anti-shortcut-checklist.md`,
`docs/known-issues/*.md`. Single commit because each file is small
and ships as one batch.

### Commit 3 — `chore(api): ENGLISH-1 audit code comments + log messages + tests in apps/api`

- Comments drift-audit across `apps/api/src/` and `apps/api/tests/`.
  CLAUDE.md says comments stay English; this catches drift.
- xunit test METHOD NAMES + `DisplayName` attributes → English.
  Test BODY (assertions on German UI strings) stays.
- Log messages (`_logger.LogInformation`, `LogWarning`, `LogError`,
  etc.) → English. Operational logs aid OSS contributors and ops.
- Verification: `dotnet build apps/api/SharedCookbook.sln` 0/0,
  `dotnet test` 1755 / 1756 (post-FLAKY-2 baseline).

### Commit 4 — `chore(web): ENGLISH-1 audit code comments + log messages + tests in apps/web`

- Comments drift-audit across `apps/web/src/`.
- Vitest `it()`, `describe()`, `test()` strings → English. BODY stays.
- `console.log` / `console.warn` / `console.error` → English.
- Verification: `pnpm --filter web run test` 1713 / 1713, lint clean,
  build green.

### Commit 5 — `chore(extractor): ENGLISH-1 audit code comments + log messages + tests in apps/python-extractor`

- Comments drift-audit across `apps/python-extractor/src/` and
  `tests/`.
- pytest `def test_*` function names → English.
- Python `logger.info`, `logger.warning`, `logger.error` → English.
- Docstrings → English.
- Verification: all four strict gates (pytest 625, ruff check, ruff
  format check, mypy --strict) green.

### Commit 6 — `chore(shared): ENGLISH-1 audit code + tests in packages/shared`

- Comments drift-audit across `packages/shared/src/`.
- Vitest tests analog to Commit 4.
- Verification: `pnpm --filter shared run test` 112 / 112.

### Commit 7 (CONDITIONAL) — `chore(rename): ENGLISH-1 rename German variable / function names where present`

Pre-step: `rg '\b(kochbuch|mahlzeit|zutat|portion|gericht|titel|zutaten|schritte)\w*\b' apps packages --type cs --type ts --type tsx --type py`.

If hits exist: rename. If empty: skip the commit and note in the
return-summary.

For each rename:
- Audit `JsonPropertyName`, reflection-by-string, log-format-strings,
  `Type.GetType("...")` to ensure the identifier isn't part of a
  wire-protocol or runtime contract. If it is, leave the identifier
  + document the wire-compat constraint in the commit body.

## Verification audit (mandatory before ship)

Sub-agent reports the following in the final return-summary as a
`file:line` checklist:

1. CLAUDE.md, docs/ops.md, docs/reviewing/, docs/known-issues/ —
   `rg` for German function-words (`weil`, `damit`, `wenn`, `sondern`,
   `keine`, `nicht`, `sind`, `wird`, `wurde`) returns empty or
   only false-positives in code-block fences.
2. Code comments drift across `apps/api/src/`, `apps/web/src/`,
   `apps/python-extractor/src/`, `packages/shared/src/`,
   `packages/config/src/` — same German function-word grep returns
   empty or only false-positives in i18n-keyed UI string examples.
3. Test names: `rg "(it|describe|test)\(['\"]([^'\"]*)" apps/web/src/ packages/shared/src/`
   filtered for German function-words returns empty.
4. xunit method names + DisplayName: same pattern.
5. pytest function names: `rg 'def test_[a-z_]*' apps/python-extractor/tests/`
   filtered for German morphemes returns empty.
6. Log messages: `rg '_logger\.\w+\([^)]*' apps/api/src/`,
   `rg 'logger\.\w+\([^)]*' apps/python-extractor/src/`,
   `rg 'console\.\w+\([^)]*' apps/web/src/` — German function-word
   grep returns empty.
7. Variable / function names: `rg '\b(kochbuch|mahlzeit|zutat|portion|gericht|titel|zutaten|schritte)\w*\b' apps packages --type cs --type ts --type tsx --type py`
   returns empty (or only test-body content + i18n keys).
8. UI translation files unchanged:
   `git diff main..HEAD -- apps/web/src/locales/de/` empty.
9. Historical docs unchanged:
   `git diff main..HEAD -- docs/plans/ docs/phase-1-progress.md docs/design-implementation-progress.md docs/bugs-backlog.md` empty.
10. All test suites green:
    - `dotnet build apps/api/SharedCookbook.sln` 0/0
    - `dotnet test apps/api/SharedCookbook.sln` 1755-1756
    - `pnpm --filter web run test` 1713
    - `pnpm --filter shared run test` 112
    - `cd apps/python-extractor && uv run pytest` 625 + 4 gates
    - All lint runs clean

## Error handling / risks

- **Test-body content vs. test-name rule:** sub-agent must never
  touch German strings inside test bodies. Those verify German
  locale rendering. The rule is mechanical: test NAMES on the line
  with `it(` / `[Fact(DisplayName = ` / `def test_` rename; lines
  inside the body don't match the renaming pattern.
- **Reflection / wire-protocol:** Variable rename in Commit 7 must
  audit `JsonPropertyName`, `nameof`, `Type.GetType("...")`,
  log-format-strings. Wire-bound names stay; document.
- **CLAUDE.md tone-loss:** translate semantically. The file's
  imperative voice ("you should...", "always...", "never...") and
  CLAUDE-Code idioms must survive translation.
- **Worktree merge conflicts:** ENGLISH-1 is large; no parallel
  slices during the run.
- **Sub-agent reliability drift (lesson from RENAME-3 audit):**
  some prior agents claimed test-suite numbers without running.
  Final audit must run each suite and copy-paste actual output.

## Testing strategy

No new tests — pure text substitution. The existing suite is the
regression guard. Per-commit tests as listed under each commit
plus the aggregate run in the final audit.

## Rollout sequence

Seven commits in an isolated worktree as listed in Architecture.
After merge:

- Operator: `pnpm install --force` (lesson from RENAME-1 stale
  symlinks; defensive even though we don't expect a workspace
  package-name change)
- Operator: any local CI scripts with hard-coded German test-filter
  strings (`--filter "FullyQualifiedName~Login_Mit_..."`) need
  updating; documented in slice body

## Estimated commit sizes

- Commit 1 (CLAUDE.md): ~250 lines, semantic translation
- Commit 2 (ops.md + reviewing + known-issues): ~200 lines
- Commit 3 (api): ~50-150 comments + 100-300 test names + 30-80
  log messages
- Commit 4 (web): ~50-100 comments + 500-800 test names (192 test
  files, average ~3-5 tests each) + 20-50 console-logs
- Commit 5 (python): ~30-80 comments + 50-100 pytest function names
  + 20-50 logger calls
- Commit 6 (shared): ~10-30 comments + 30-50 test names
- Commit 7 (variables): 0-20 hits if any

Total estimated diff: 1000-2000 lines of single-character / single-
word substitutions plus ~500 lines of doc translation.

## Out of scope

- DE UI label `Familien-Kochbuch` in `de/translation.json`
  (REL-3 decision)
- Historical timestamped records (CLAUDE.md rule)
- Wire-protocol / serialization-bound German strings (JsonPropertyName,
  reflection)
- Seed data / DB content
- EF migration class names

## Follow-ups

- (Operator) post-merge `pnpm install --force` if anything seems
  off (defensive, lesson from RENAME-1 stale symlinks)
- (Operator) update any local test-filter scripts with hard-coded
  German names
