# RENAME-1: Tier-1+2 Brand Consolidation to shared-cookbook

**Date:** 2026-04-25
**Status:** Designed, ready to dispatch
**Scope:** Single focused slice (RENAME-1). Builds on REL-1's
public-facing rebrand. .NET-namespace rename stays out-of-scope.

## Why

REL-1 renamed user-visible surfaces (LICENSE, README, root
package.json `name`, web index.html title, PWA manifest) to
`shared-cookbook`. RENAME-1 closes the gap on developer-visible code
surfaces that REL-1 deliberately deferred: docker-compose container
names, GHCR image paths, npm workspace package names, Python package
name. Goal: anyone reading `docker compose ps`, `pnpm list`, or
`pyproject.toml` sees `shared-cookbook` instead of
`familien-kochbuch`.

## Decisions locked (from brainstorm 2026-04-25)

- **Scope:** Tier-1+2 (Q1-A). Targets 1-4. .NET namespaces
  (`FamilienKochbuch.*`) stay as historical artefact — match the
  German UI label, gigantic refactor with subtle EF-migration risk
  for invisible upside.
- **Repo-owner strategy:** Q2-C — `${{ github.repository_owner }}`
  variable in deploy.yml + `${IMAGE_REGISTRY_OWNER:-dkaulig}`
  env-var in docker-compose.prod.yml. Slice is transfer-agnostic;
  GitHub repo transfer happens around the slice as needed.
- **Container names:** explicit `container_name:` per service stays;
  only the prefix changes from `familien-kochbuch-*` to
  `shared-cookbook-*`. No `name:` at top of compose (overridden by
  `container_name:` anyway).
- **Service names:** unchanged (`postgres`, `redis`, `api`, `web`,
  `python-extractor`, `caddy`, `ollama`, `seaweedfs` — all generic).
- **Sequencing:** Q3-A. One slice, four atomic per-target commits +
  one doc-update commit. Sub-agent runs sequentially. Tests stay
  green per commit.
- **Worktree:** isolated per `superpowers:using-git-worktrees`. Five
  independent text-substitution commits over disparate subsystems —
  worktree-rollback if a commit unexpectedly breaks tests.

## Architecture

Five sequential commits in an isolated worktree, each with its own
verification gate:

```
Worktree spawn
  │
  ▼ Pre-Audit (rg lifecycle + import inventory)
  │
  ▼ Commit 1: docker-compose container_name + image paths
      verify: docker compose config --quiet (both files)
              rg 'familien-kochbuch-' docker-compose*.yml → empty
  │
  ▼ Commit 2: deploy.yml ${{ github.repository_owner }}
      verify: yaml syntax check
              rg 'kay-solutions|familien-kochbuch-' .github/ → empty
  │
  ▼ Commit 3: workspace package names + ~185 imports
      verify: pnpm install (regenerate lock)
              pnpm --filter web run lint / build / test
              pnpm --filter shared run test
              rg '@familien-kochbuch/' apps packages → empty
  │
  ▼ Commit 4: python-extractor pyproject.toml
      verify: uv sync + 4 strict gates
  │
  ▼ Commit 5: doc updates (SETUP.md / README.md / CLAUDE.md)
      verify: rg 'familien-kochbuch-' docs/ README.md CLAUDE.md
              → only historical-context refs remain (bug-backlog,
                old design docs)
  │
  ▼ Final-Audit: full grep across the whole repo for residuals
  ▼ Worktree merge to main (or squash if preferred)
```

## Components / per-target changes

### Target 1 — Compose container names + image paths

**Files:** `docker-compose.yml`, `docker-compose.prod.yml`

- ~16 `container_name: familien-kochbuch-*` → `shared-cookbook-*`
  (postgres, redis, seaweedfs, api, web, python-extractor, caddy,
  ollama — confirmed by `grep -n container_name docker-compose.yml`)
- `docker-compose.prod.yml` `image:` paths:
  `ghcr.io/kay-solutions/familien-kochbuch-{api,web,python-extractor}:latest`
  → `ghcr.io/${IMAGE_REGISTRY_OWNER:-dkaulig}/shared-cookbook-{api,web,python-extractor}:latest`
- Service names (`postgres`, `redis`, `api`, `web`, …) stay generic.

**Verification:**
- `docker compose config --quiet` (both files)
- `docker compose -f docker-compose.prod.yml config --quiet`
- `rg 'familien-kochbuch-' docker-compose*.yml` returns empty
- Optional: `docker compose up -d --no-build` smoke; aggressive,
  skip if `config --quiet` is clean

### Target 2 — deploy.yml

**File:** `.github/workflows/deploy.yml`

- Hard-coded `ghcr.io/kay-solutions/familien-kochbuch-{api,web,python-extractor}` →
  `ghcr.io/${{ github.repository_owner }}/shared-cookbook-{api,web,python-extractor}`
- Image-name suffixes (`-api`, `-web`, `-python-extractor`) keep.
- Any other hard-coded `kay-solutions` or `familien-kochbuch` strings:
  remove (REL-2 already cleaned the workflow body; this slice catches
  what's left).

**Verification:**
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"`
- `rg 'kay-solutions|familien-kochbuch-' .github/workflows/` empty
- Real push test happens at next `v*` tag — out of slice scope.

### Target 3 — Workspace package names

**Files:**
- `package.json` (root) — already updated by REL-1 to `shared-cookbook`
- `apps/web/package.json` — `"name": "@familien-kochbuch/web"` → `"@shared-cookbook/web"`
- `packages/shared/package.json` — analog
- `packages/config/package.json` — analog
- `apps/api/.gitignore`, dotfiles — leave unless they reference the workspace name
- ~185 import statements across `apps/web/src/**`, `packages/**` — `from '@familien-kochbuch/...'` → `from '@shared-cookbook/...'`

**Tooling (a single sub-agent codemod):**
```bash
# Workspace package.json files
fd -e json --no-ignore-vcs --exec sed -i '' 's|@familien-kochbuch/|@shared-cookbook/|g' {} \;
# Source imports
fd -e ts -e tsx -e js -e jsx --no-ignore-vcs apps packages | \
  xargs sed -i '' 's|@familien-kochbuch/|@shared-cookbook/|g'
# pnpm regenerate lock
pnpm install
```

**Verification:**
- `pnpm install` clean
- `pnpm-lock.yaml` regenerated and committed in the same commit
- `pnpm --filter web run lint` 0 errors
- `pnpm --filter web run test` green (1713)
- `pnpm --filter web run build` green
- `pnpm --filter shared run test` green (112)
- `rg '@familien-kochbuch/' apps packages` empty

### Target 4 — Python pyproject.toml

**File:** `apps/python-extractor/pyproject.toml`

- `name = "familien-kochbuch-extractor"` (or whatever it is) →
  `name = "shared-cookbook-extractor"`. Confirm exact existing
  value via `grep '^name' apps/python-extractor/pyproject.toml`.
- `description` field if it carries the old brand: update.
- Authors / maintainers: leave unchanged (personal data is part of the
  package metadata).

**Verification:**
- `cd apps/python-extractor && uv sync` clean
- All four strict gates: `uv run pytest`, `uv run ruff check .`,
  `uv run ruff format --check .`, `uv run mypy --strict src tests`
- `rg 'familien-kochbuch' apps/python-extractor/pyproject.toml` empty

### Target 5 — Doc updates

**Files:** `docs/SETUP.md`, `README.md`, `CLAUDE.md`, anything else
that references the old container names.

- `docker exec familien-kochbuch-ollama` → `docker exec shared-cookbook-ollama`
  (in REL-6's SETUP.md Path-3 ollama-pull step)
- Any other `container_name:`-related strings in operator docs.
- Bug-backlog (`docs/bugs-backlog.md`), historical design-docs in
  `docs/plans/*.md`: leave alone — those are time-stamped historical
  records.

**Verification:**
- `rg 'familien-kochbuch-' docs/ README.md CLAUDE.md` returns only
  historical-context refs (in `docs/bugs-backlog.md`, old design docs
  pre-2026-04-25). The sub-agent enumerates remaining hits in the
  commit body and confirms each is intentional.

## Error handling

- **Existing prod containers** with old names: after the slice merges
  and prod redeploys, old containers stay (`docker ps -a`) until
  manually removed. Operator-side cleanup hint in slice docs:
  `docker rm -f familien-kochbuch-{postgres,redis,seaweedfs,api,web,python-extractor,caddy,ollama}`
- **Existing GHCR images** under `ghcr.io/kay-solutions/familien-kochbuch-*`:
  remain pullable until manually deleted via the GHCR UI / `gh api`.
  After the GitHub repo transfer to dKaulig, those images are
  effectively orphaned (kay-solutions org keeps the package
  ownership). Operator cleanup hint: `gh api -X DELETE
  /orgs/kay-solutions/packages/container/familien-kochbuch-{api,web,python-extractor}`
- **pnpm-lock drift:** `pnpm install` regenerates after package-name
  changes. Sub-agent commits the regenerated lock alongside its
  package.json edits.
- **EF Core migrations:** untouched — .NET namespace stays
  `FamilienKochbuch.*`. No migration history rewrite.
- **Test fixtures referencing container names:** unlikely (tests run
  in-process without docker), but the audit catches them.
- **Worktree rollback:** if a commit breaks tests irrecoverably,
  `git reset --hard <last-green-sha>` in the worktree, abandon the
  worktree, retry. No `main` impact.

## Verification audit (mandatory before ship verdict)

Sub-agent runs the following before claiming `ship`. Report results
in the final return-summary.

1. `rg 'familien-kochbuch-' apps packages docker-compose*.yml .github docs README.md CLAUDE.md` — list every remaining hit and confirm each is intentional historical context (bug backlog, time-stamped design docs).
2. `rg '@familien-kochbuch/' apps packages` — must be empty.
3. `rg 'kay-solutions/familien-kochbuch' apps packages docker-compose*.yml .github docs README.md CLAUDE.md` — must be empty (only `kay-solutions` mentions tolerated are historical narrative in design docs).
4. .NET namespaces stay untouched: `rg 'FamilienKochbuch\\.' apps/api` is non-empty by design (out of scope).
5. German UI label stays: `rg 'Familien-Kochbuch' apps/web/src/locales/de` returns the expected entries.

## Testing strategy

Per-commit, as listed under each target. Final aggregate:

- `dotnet build apps/api/FamilienKochbuch.sln` 0/0 (untouched)
- `dotnet test apps/api/FamilienKochbuch.sln` green (untouched, 1756)
- Web 1713/1713 green
- Shared 112/112 green
- Python all four gates green

No new tests added — the slice is text-substitution. Regression
guard is the existing test suite.

## Rollout sequence

Five commits in an isolated worktree:

1. `chore(infra): RENAME-1 compose container names + prod image registry`
2. `chore(ci): RENAME-1 deploy.yml uses repository_owner variable`
3. `chore(deps): RENAME-1 workspace package names @shared-cookbook/*`
4. `chore(extractor): RENAME-1 pyproject.toml name`
5. `docs(rename): RENAME-1 update operator docs to new container names`

Each commit ends with all gates green. Sub-agent reports per-commit
SHAs and the residual-grep table.

After merge to main:
1. Operator: `git pull && docker compose down && docker compose up -d`
   on the local stack. Old containers self-purge after `docker rm -f`
   one-shot (hint in slice docs).
2. Operator: tag `vN+1` to push new images to
   `ghcr.io/dkaulig/shared-cookbook-*`. Old kay-solutions packages
   remain as historical record; cleanup is operator-optional.
3. Operator: when ready, public-flip via GitHub repo settings. CI
   workflow + secret-scanning + dependabot per the FOLLOWUPS-1 D
   checklist.

## Out of scope

- .NET namespace rename `FamilienKochbuch.*` → `SharedCookbook.*`
  (gigantic, low visibility, EF-migration risk)
- Local repo directory rename (`MyReciepes` → `shared-cookbook`)
  (operator-side, no impact on tools)
- GitHub repo rename + transfer (already executed 2026-04-25 ahead
  of the slice; repo is `dKaulig/shared-cookbook`)
- German UI label "Familien-Kochbuch" in `de/translation.json`
  (REL-3 decision: maintainer-daily-driver label stays)
- Old GHCR image cleanup (operator-side, optional)

## Risks

- **GHCR push permissions after transfer:** `${{ github.repository_owner }}`
  resolves to `dkaulig` in the new namespace. The deploy.yml
  workflow's `permissions: packages: write` covers GHCR pushes for
  the repo's user account. No org-level package permissions needed.
- **docker-compose.prod.yml on existing VPS:** old image paths
  pinned. Operator must `git pull && docker compose pull && docker
  compose up -d`. Documented; not slice-blocking.
- **Workspace import drift during the codemod:** sed substitutes are
  text-blind. Mitigation: run lint + build + tests after the
  rewrite; any miss surfaces immediately.

## Follow-ups

- (Optional, low-priority) .NET namespace rename — separate slice if
  ever wanted. Big effort, low visibility.
- (Operator) GHCR old-image cleanup under `ghcr.io/kay-solutions/...`
- (Operator) Pre-public-flip checklist per FOLLOWUPS-1 D.
