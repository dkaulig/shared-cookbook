# Anti-Shortcut Checklist (Reviewer Enforcement)

**Purpose:** Agents can be tempted to take shortcuts to finish slices faster — skipped tests, TODO stubs, disabled type-checks, fake stubs, unverified "all green" claims. This checklist is applied by every review agent after every slice. **Any single failing item triggers a fix-cycle before the slice can be marked `done`.**

The reviewer must not merely read the diff — they must **execute verification commands themselves** (run tests, boot Docker, curl endpoints) and confirm with their own eyes.

---

## Mandatory post-impl orchestration (added 2026-04-19 per user mandate)

Every implementation-agent completion triggers **two additional passes BEFORE the reviewer agent is dispatched**:

1. **`/simplify`** — plugin-agent `code-simplifier` run against the recently-modified files. Looks for: unnecessary complexity, redundant abstractions, over-engineering, nested ternaries, dense one-liners, obvious-code comments. Produces refactor suggestions; orchestrator applies the safe ones + logs the skipped ones.

2. **`/security-review`** — Claude Code built-in run against the same files. Looks for OWASP top-10 class bugs: command-injection, SQL-injection, XSS, auth-bypass, secret-exposure, insecure defaults, path-traversal, SSRF, CSRF. Produces findings with confidence + severity; orchestrator acts on HIGH/MEDIUM immediately, logs LOW for later triage.

**Flow per slice:**

```
impl-agent completes
  → orchestrator runs /simplify against touched files
  → orchestrator applies safe simplifications (preserving test-green)
  → orchestrator runs /security-review against touched files
  → orchestrator applies high/medium security fixes
  → orchestrator dispatches reviewer-agent (feature-dev:code-reviewer or superpowers:code-reviewer)
  → reviewer-agent enforces this checklist + per-slice plan acceptance
  → fix-cycle if needed
  → tracker update + commit
```

Rationale: reviewer-agents have historically caught deviations-from-plan well but are less strong at proactively spotting over-engineering or subtle security footguns. The two extra passes fill that gap. Applies to ALL slices from PF1 onward.

---

## Test shortcuts (reject on sight)

- [ ] No tests marked `[Skip]`, `[Fact(Skip="...")]`, `[Theory(Skip="...")]`, `it.skip()`, `describe.skip()`, `xit()`, `xdescribe()`, `.skip`, or `.todo`
- [ ] No tests with empty bodies, placeholder assertions (`Assert.True(true)`, `expect(1).toBe(1)`), or `Assert.Null(null)` patterns
- [ ] No tests that only check a stub returns its hardcoded stub value (must exercise real code path)
- [ ] Integration tests boot the real DI graph (WebApplicationFactory with real services, minimally swapped DB to SQLite in-memory is acceptable)
- [ ] API integration tests hit real endpoints via HTTP, not direct controller-method invocation
- [ ] Test count scales with feature count: heuristic ≥ 2 tests per endpoint, ≥ 1 test per domain rule, ≥ 1 test per non-trivial hook/component
- [ ] No `.only()` / `[Fact(Skip)]`-around-all-but-one patterns that accidentally disable the rest of the suite
- [ ] Snapshot tests have meaningful snapshots (not `""` or `null`)

## Implementation shortcuts (reject on sight)

- [ ] No `// TODO`, `// FIXME`, `// HACK`, `// XXX` in code that is part of the slice's scope (exceptions require a note in the slice's Deviations section of the progress tracker, with rationale)
- [ ] No `throw new NotImplementedException()`, `throw new NotSupportedException("not yet")`, `throw new Error("TODO")` in production code paths
- [ ] No placeholder return values: endpoints must query the DB if their contract says so; handlers must persist; factories must validate
- [ ] No `@ts-ignore`, `@ts-expect-error`, `// eslint-disable`, `// eslint-disable-next-line`, `#pragma warning disable`, `[SuppressMessage]` unless paired with an explanatory comment naming the exact reason (and even then, used sparingly — 1 or 2 per slice, not sprinkled)
- [ ] No commented-out code left in the tree
- [ ] No hardcoded secrets / credentials / API keys — environment variables only
- [ ] Real Postgres in `docker compose up` (not SQLite); SQLite only in tests where explicitly allowed
- [ ] `TreatWarningsAsErrors=true` remains active; no project-level opt-outs
- [ ] Typescript `strict: true` remains active

## Scope shortcuts (reject on sight)

- [ ] Every deliverable from the slice's "Deliverables" list is present in the diff
- [ ] Every acceptance criterion from the slice spec is verified by the reviewer (not just claimed by the agent)
- [ ] Commit order shows TDD: for each non-trivial feature, the test-commit precedes the implementation-commit. Verify via `git log --oneline` in the slice's commit range.
- [ ] No silent scope-cuts ("I dropped X because time") without a Deviations entry

## Verification shortcuts (reject on sight)

The reviewer **must run** these themselves:

- [ ] `dotnet test apps/api/FamilienKochbuch.sln` — all tests actually pass locally
- [ ] `pnpm test` (from repo root or filter) — all web + shared tests pass
- [ ] `pnpm lint` — no errors (warnings are OK if justified)
- [ ] If slice involves Docker: `docker compose up --build -d` succeeds; `docker compose ps` shows expected services; the slice's smoke commands succeed (`curl -s http://localhost/api/health`, etc.); `docker compose down` at the end
- [ ] `git status` is clean (no uncommitted changes left over)
- [ ] `git log origin/main..HEAD` is empty (everything is pushed)

If the reviewer cannot run a command (environment issue, missing tool), they must document the gap and flag `needs_environment_fix` rather than silently skip.

## Format of a review report

```
SLICE: Sx — <name>
STATUS: pass | fix_needed | needs_environment_fix

Tests run:
  - dotnet test: <X passed, Y failed>
  - pnpm test: <X passed, Y failed>
  - lint: <clean / N errors>
  - docker compose up: <success / failure description>

Shortcut findings (each item: file:line — what's wrong):
  - <empty if none>

Scope findings:
  - <missing deliverables / unchecked acceptance criteria>

Recommendation:
  - <concrete list of fixes needed, prioritized>
```

---

## Applied to all future slices

This checklist is used for:
- S0 review (after S0 agent returns)
- S1 through S7 reviews
- Fix-agent re-reviews after a `fix_needed` cycle

Each implementation-agent dispatch will include a reminder to expect this checklist, so agents know upfront that shortcuts will be caught and rejected.
