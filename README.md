# Familien-Kochbuch

A private, invite-only family recipe collection — Phase 1 of a multi-phase
side project. The UI is German; code, comments, and commit messages are
English.

See the product design document
([`docs/plans/2026-04-17-familien-kochbuch-design.md`](docs/plans/2026-04-17-familien-kochbuch-design.md))
and the Phase 1 implementation plan
([`docs/plans/phase-1-implementation-plan.md`](docs/plans/phase-1-implementation-plan.md))
for scope and architecture decisions.

## Prerequisites

- **Docker** 25+ (Desktop on macOS/Windows, Engine + Compose on Linux)
- **.NET 10 SDK** (for running tests and `dotnet run` outside Docker)
- **Node.js** 22+ (Node 25 works too)
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10 --activate`)

## Quick start

```bash
pnpm install
docker compose up --build
```

Then open http://localhost — Caddy routes `/api/*` to the .NET API and
everything else to the React SPA. The landing page shows the
"Familien-Kochbuch" headline and a badge indicating whether the API is
reachable (**✓ API verbunden** / **✗ API nicht erreichbar**).

Sanity checks from a second shell:

```bash
curl -s http://localhost/api/health   # -> {"status":"ok","timestamp":"..."}
curl -s http://localhost/ | head      # -> <!doctype html> ... <title>Familien-Kochbuch</title>
```

Stop everything with `docker compose down` (add `-v` to also drop the
Postgres/SeaweedFS volumes).

## Running tests

```bash
# Web — Vitest + RTL + MSW
cd apps/web && pnpm test

# API — xUnit smoke tests + WebApplicationFactory integration tests
dotnet test apps/api/FamilienKochbuch.sln

# All web lint (ESLint flat config)
pnpm lint
```

The CI workflow in `.github/workflows/ci.yml` runs the same commands on
every pull request and on push to `main`.

## Repository structure

```
/
├── apps/
│   ├── api/                 # .NET 10 Minimal API (FamilienKochbuch.sln)
│   │   ├── Directory.Build.props
│   │   ├── Dockerfile
│   │   ├── src/
│   │   │   ├── FamilienKochbuch.Api/             # Program.cs, Endpoints/
│   │   │   ├── Familienkochbuch.Domain/          # entities (to arrive in S1)
│   │   │   └── FamilienKochbuch.Infrastructure/  # EF Core + Npgsql
│   │   └── tests/
│   │       ├── FamilienKochbuch.Api.Tests/       # WebApplicationFactory
│   │       ├── FamilienKochbuch.Domain.Tests/
│   │       └── FamilienKochbuch.Infrastructure.Tests/
│   └── web/                 # Vite 8 + React 19 + TS strict + Tailwind 4
│       ├── Dockerfile       # build -> caddy:2-alpine static serve
│       ├── src/
│       │   ├── App.tsx      # headline + /api/health badge
│       │   ├── lib/api.ts   # fetchHealth() with AbortController
│       │   └── test/        # vitest setup + MSW handlers
│       └── vite.config.ts   # proxies /api -> http://localhost:5000 in dev
├── packages/
│   ├── shared/              # @familien-kochbuch/shared — hand-written DTOs
│   └── config/              # @familien-kochbuch/config — tsconfig + eslint base
├── infra/
│   └── Caddyfile            # dev reverse proxy (/api -> api, / -> web)
├── docker-compose.yml       # postgres, redis, seaweedfs, api, web, caddy
├── docs/
│   └── plans/               # PRD + phase-1 implementation plan
└── .github/workflows/ci.yml # path-filtered CI on PR + push to main
```

## Notes for contributors

- **TDD is non-optional.** Failing tests land in their own commit, then the
  implementation commit turns them green. Reviewers inspect commit order.
- **Small commits; push after every logical step.**
- UI strings in German, everything else in English.
- When EF migrations arrive (S1+), always read the generated `.cs`
  file before committing — EF sometimes bundles unintended schema
  changes from other branches.

## Related docs

- [Phase 1 implementation plan](docs/plans/phase-1-implementation-plan.md)
- [Product design document](docs/plans/2026-04-17-familien-kochbuch-design.md)
- [Phase 1 progress tracker](docs/phase-1-progress.md)
