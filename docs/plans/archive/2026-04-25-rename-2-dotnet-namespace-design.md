# RENAME-2: .NET Namespace + JWT Rename to SharedCookbook

**Date:** 2026-04-25
**Status:** Designed, ready to dispatch
**Scope:** Tier-3 follow-up to RENAME-1. Renames the .NET namespace
`FamilienKochbuch.*` → `SharedCookbook.*` across all source, tests,
config files, and project metadata; rotates JWT issuer/audience
strings to match.

## Why

RENAME-1 finished tier-1+2 (compose, GHCR images, npm workspace
packages, Python pyproject). 2980 references to `FamilienKochbuch.*`
and 5 `familien-kochbuch-*` JWT strings remain across 333 files in
`apps/api/`. The user wants full brand consistency. RENAME-2 closes
the gap.

## Decisions locked (from brainstorm 2026-04-25)

- **Scope (Q1-A):** .NET namespaces + JWT strings only. The German
  UI label "Familien-Kochbuch" in `apps/web/src/locales/de/translation.json`
  stays — REL-3 maintainer-daily-driver decision. Historical
  `docs/plans/*.md` and `docs/phase-1-progress.md` stay — CLAUDE.md
  "don't retro-edit time-stamped records".
- **JWT impact (Q1-A):** Hard cut. All current sessions invalidated
  on deploy; user re-logs-in once. Operator-action documented in
  slice docs.
- **Sequencing (Q2-B):** Three atomic commits, each leaves the build
  green:
  1. namespace + assembly + directories + sln + csproj
  2. JWT strings (appsettings + JwtOptions + tests)
  3. docs + scripts referencing the old sln path
- **Worktree:** isolated, per `superpowers:using-git-worktrees`. A
  333-file refactor is exactly what worktrees are for.

## Architecture / scope inventory

```
apps/api/
├── FamilienKochbuch.sln                          → SharedCookbook.sln
├── src/
│   ├── FamilienKochbuch.Api/                     → SharedCookbook.Api/
│   │   ├── FamilienKochbuch.Api.csproj           → SharedCookbook.Api.csproj
│   │   ├── Program.cs                            (namespace stays inside, gets renamed)
│   │   ├── Services/...                          (all .cs)
│   │   ├── Endpoints/...                         (all .cs)
│   │   ├── appsettings.json                      (JWT Audience string)
│   │   └── appsettings.Development.json          (JWT Audience string)
│   ├── FamilienKochbuch.Domain/                  → SharedCookbook.Domain/
│   │   ├── FamilienKochbuch.Domain.csproj        → SharedCookbook.Domain.csproj
│   │   └── ...
│   └── FamilienKochbuch.Infrastructure/          → SharedCookbook.Infrastructure/
│       ├── FamilienKochbuch.Infrastructure.csproj → SharedCookbook.Infrastructure.csproj
│       ├── Services/JwtOptions.cs                (default audience string)
│       └── Persistence/Migrations/...            (partial classes, namespace prefix)
└── tests/
    ├── FamilienKochbuch.Api.Tests/                → SharedCookbook.Api.Tests/
    │   ├── FamilienKochbuch.Api.Tests.csproj     → SharedCookbook.Api.Tests.csproj
    │   └── Infrastructure/FamilienKochbuchWebApplicationFactory.cs
    │       → Infrastructure/SharedCookbookWebApplicationFactory.cs
    │       (class name renamed too, JWT strings inside)
    ├── FamilienKochbuch.Domain.Tests/             → SharedCookbook.Domain.Tests/
    └── FamilienKochbuch.Infrastructure.Tests/     → SharedCookbook.Infrastructure.Tests/
        └── Services/TokenServiceTests.cs         (JWT strings)
```

**Affected counts (verified 2026-04-25):**
- 2980 references to `FamilienKochbuch.` across 333 files
- 5 `familien-kochbuch-*` JWT strings across 5 files
- 6 directory renames
- 1 sln file rename
- 6 csproj file renames

**Active files outside `apps/api/`:**
- `CLAUDE.md` — `dotnet test apps/api/FamilienKochbuch.sln` (multiple)
- `.github/workflows/ci.yml` — `apps/api/FamilienKochbuch.sln`
- `.github/workflows/deploy.yml` — same
- Possibly `scripts/*.sh` — to verify
- `docs/SETUP.md` — references `dotnet test apps/api/FamilienKochbuch.sln`
- `apps/api/.gitignore` — unlikely; verify

## Components / per-commit scope

### Commit 1 — `refactor(api): RENAME-2 .NET namespace FamilienKochbuch → SharedCookbook`

Goal: every .cs / .csproj / .sln file references `SharedCookbook.*`.
After this commit `dotnet build apps/api/SharedCookbook.sln` succeeds
0/0 and `dotnet test` passes (1756 tests).

- `git mv apps/api/FamilienKochbuch.sln apps/api/SharedCookbook.sln`
- `git mv` 6 directories:
  - `apps/api/src/FamilienKochbuch.Api` → `SharedCookbook.Api`
  - `apps/api/src/FamilienKochbuch.Domain` → `SharedCookbook.Domain`
  - `apps/api/src/FamilienKochbuch.Infrastructure` → `SharedCookbook.Infrastructure`
  - `apps/api/tests/FamilienKochbuch.Api.Tests` → `SharedCookbook.Api.Tests`
  - `apps/api/tests/FamilienKochbuch.Domain.Tests` → `SharedCookbook.Domain.Tests`
  - `apps/api/tests/FamilienKochbuch.Infrastructure.Tests` → `SharedCookbook.Infrastructure.Tests`
- `git mv` 6 csproj files:
  - `SharedCookbook.Api/FamilienKochbuch.Api.csproj` → `SharedCookbook.Api/SharedCookbook.Api.csproj`
  - … analog für die anderen 5 Projekte
- `git mv apps/api/tests/SharedCookbook.Api.Tests/Infrastructure/FamilienKochbuchWebApplicationFactory.cs`
  → `apps/api/tests/SharedCookbook.Api.Tests/Infrastructure/SharedCookbookWebApplicationFactory.cs`
  (class name + filename together)
- Find-and-replace `FamilienKochbuch` → `SharedCookbook` across ALL files in `apps/api/`:
  - `*.cs` (namespace declarations, using statements, type references, attribute strings, fully-qualified names)
  - `*.csproj` (ProjectReference paths, AssemblyName implicit via project name)
  - `*.sln` (project entries, GUID-keyed paths)
  - `*.json` (anything that references the assembly)
  - `*.md` if any inside apps/api (e.g. `apps/api/README.md` if exists)
- Build verification: `dotnet build apps/api/SharedCookbook.sln` → 0 warnings, 0 errors
- Test verification: `dotnet test apps/api/SharedCookbook.sln` → 1756 passed (Domain 488 + Infrastructure 123 + Api 1145 — adjusted from RENAME-1 baseline)

**Sed strategy (atomic):**
```bash
# Inside apps/api worktree:
fd -e cs -e csproj -e sln -e json -e md . apps/api \
  --no-ignore-vcs \
  --exec sed -i '' 's/FamilienKochbuch\./SharedCookbook./g' {} \;
# Plus the directory + file renames via git mv.
```

After this single sed pass + 13 `git mv` operations (1 sln + 6 dirs +
6 csprojs + 1 WebApplicationFactory), the codebase compiles and
tests pass. The find-and-replace is namespace-only — JWT strings
contain `familien-kochbuch-` (lowercase), which doesn't match the
PascalCase pattern.

### Commit 2 — `refactor(api): RENAME-2 JWT issuer + audience strings`

- `apps/api/src/SharedCookbook.Api/appsettings.json` — `Audience: "familien-kochbuch-web"` → `"shared-cookbook-web"`
- `apps/api/src/SharedCookbook.Api/appsettings.Development.json` — analog
- `apps/api/src/SharedCookbook.Infrastructure/Services/JwtOptions.cs` —
  `Audience { get; set; } = "familien-kochbuch-web"` → `"shared-cookbook-web"`
- `apps/api/tests/SharedCookbook.Infrastructure.Tests/Services/TokenServiceTests.cs` —
  `Issuer = "familien-kochbuch-test"` → `"shared-cookbook-test"`,
  `Audience = "familien-kochbuch-web-test"` → `"shared-cookbook-web-test"`
- `apps/api/tests/SharedCookbook.Api.Tests/Infrastructure/SharedCookbookWebApplicationFactory.cs` —
  same two `UseSetting(...)` calls

Verification:
- `rg 'familien-kochbuch-' apps/api` → empty
- `dotnet test` green (TokenServiceTests + auth flow tests must adapt to new strings)
- Tests likely already use the constants from JwtOptions / WebApplicationFactory, so updating the source string flows through. Where tests assert specific issuer/audience strings explicitly, those need updating in the same commit.

### Commit 3 — `chore(rename): RENAME-2 update sln paths in docs + workflows`

- `CLAUDE.md` — every `apps/api/FamilienKochbuch.sln` → `apps/api/SharedCookbook.sln`
- `.github/workflows/ci.yml` — same
- `.github/workflows/deploy.yml` — same
- `docs/SETUP.md` — same
- `scripts/*.sh` — verify and update if any reference the sln
- Anything else surfaced by `rg 'FamilienKochbuch\.sln' --type-not cs --type-not csproj`
- Historical `docs/plans/*.md` and `docs/phase-1-progress.md` —
  do **not** retro-edit (CLAUDE.md rule)

Verification:
- `rg 'FamilienKochbuch\.' --type-not cs --type-not csproj` returns
  only historical-context references (in `docs/plans/*.md` and the
  bug backlog). Sub-agent enumerates each remaining hit and confirms
  intentional.
- `rg 'FamilienKochbuch\.' apps/api | wc -l` → 0 (active code)

## Verification audit (mandatory before ship verdict)

Sub-agent runs the following before claiming ship. Report results
in the final return-summary as a checklist with `file:line` refs:

1. `rg 'FamilienKochbuch\.' apps/api` → empty
2. `rg 'familien-kochbuch-' apps/api` → empty
3. `rg 'FamilienKochbuch' apps packages docker-compose*.yml .github docs README.md CLAUDE.md`
   — only historical-context hits remain in `docs/plans/*.md`,
   `docs/phase-1-progress.md`, `docs/design-implementation-progress.md`,
   `docs/bugs-backlog.md`. Each enumerated + confirmed historical.
4. `dotnet build apps/api/SharedCookbook.sln` → 0/0
5. `dotnet test apps/api/SharedCookbook.sln` → 1756 passed
6. `pnpm --filter web run test` → 1713 (sanity, untouched)
7. `pnpm --filter shared run test` → 112 (sanity)
8. `cd apps/python-extractor && uv run pytest` → 625 (sanity)
9. EF migration list intact: `dotnet ef migrations list --project apps/api/src/SharedCookbook.Infrastructure --startup-project apps/api/src/SharedCookbook.Api` lists every migration including `AddRecipeSourceLanguage` and `AddRecipeTranslationsTable` from LANG-2. Confirms `__EFMigrationsHistory` doesn't depend on namespace.

## Error handling

- **EF migration loading:** `__EFMigrationsHistory` table tracks
  migrations by `MigrationId` (timestamp + class name), not by
  fully-qualified namespace. Renaming the namespace does NOT
  invalidate existing rows. `Migration.GetType().FullName` changes,
  but EF doesn't store that.
- **Assembly name change:** `.csproj` default `AssemblyName` matches
  the project name. `FamilienKochbuch.Api.dll` → `SharedCookbook.Api.dll`.
  Anything that references the assembly by string (extremely rare)
  could break — verify with the audit.
- **DbContext registration:** `services.AddDbContext<AppDbContext>()`
  references the type by C# type, not by string — namespace rename
  is transparent.
- **Build mid-state:** the find-and-replace + git mv in Commit 1 is
  atomic per the developer's perspective (single commit), but the
  filesystem briefly has a half-renamed state during the operation.
  Sub-agent runs the operations as a single shell pipeline, then
  builds + tests.
- **JWT impact (Commit 2 deploy):** all JWT tokens issued before
  the deploy are invalid. Operator must re-login on first
  post-deploy session. Refresh tokens also invalidated. Documented
  in slice docs as operator-action.
- **Worktree rollback:** if a commit unexpectedly breaks, reset to
  last green commit, retry. Worktree is isolated; `main` unaffected.

## Testing strategy

Per-commit verification as listed under each commit. No new tests
needed — RENAME-2 is text-substitution. The existing 1756-test .NET
suite is the regression guard.

After all 3 commits land in main:
- Aggregate: `dotnet build` 0/0, `dotnet test` 1756/1756, web suite
  1713 / shared 112 / python 625 untouched, all four python gates
  green.

## Rollout sequence

Three commits in an isolated worktree:

1. `refactor(api): RENAME-2 .NET namespace FamilienKochbuch → SharedCookbook`
2. `refactor(api): RENAME-2 JWT issuer + audience strings`
3. `chore(rename): RENAME-2 update sln paths in docs + workflows`

After merge to main:
1. Operator: `git pull && docker compose down && docker compose up -d`
   (which rebuilds the .NET image with new assembly names and
   reads the new JWT audience).
2. Operator: re-login on the web (old JWTs invalid).
3. CI workflow + deploy.yml continue to work — the sln path is
   updated inside Commit 3.

## Out of scope

- DE UI label "Familien-Kochbuch" in `de/translation.json` (REL-3
  decision; legitimate German brand for the German locale)
- Historical `docs/plans/*.md`, `docs/phase-1-progress.md` (CLAUDE.md
  rule)
- Local checkout directory rename (`MyReciepes` → `shared-cookbook`,
  operator-side)
- VPS deploy directory rename (`/srv/familien-kochbuch` → operator
  decision)
- Old GHCR images cleanup (operator, post-RENAME-1)

## Risks

- **EF tooling assumption:** assumes EF Core's migration tracking is
  by `MigrationId` only, not by namespace. Verified in audit step 9.
  If wrong, migrations re-apply on next deploy — not catastrophic
  (idempotent), but should be confirmed before claiming ship.
- **Implicit type-string usage:** if any code uses
  `Type.GetType("FamilienKochbuch.Foo.Bar")` or reflection-by-string,
  it breaks silently. The audit's `rg 'FamilienKochbuch\\.'`
  catches it; the test-suite catches the runtime impact.
- **Test-fixture string-assertions:** if any test asserts a specific
  fully-qualified type name string, it breaks. Caught by
  `dotnet test`.

## Follow-ups

- (Operator) post-deploy verify: `__EFMigrationsHistory` rows intact,
  next migration adds with new namespace prefix without complaint.
- (Operator) old JWT tokens cleanup — none needed, they expire on
  their own (15-min access-token lifetime, refresh-token max 30d
  per design).
