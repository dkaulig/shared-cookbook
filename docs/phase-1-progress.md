# Phase 1 — Progress Tracker

**Last updated:** 2026-04-18 (S0 fix pass #1 complete → in_review)

This file is the **source of truth** for Phase 1 slice state. Updated by the orchestrator on each heartbeat and by sub-agents upon completion.

## State legend

- `pending` — not yet started
- `in_progress` — implementation agent is running
- `in_review` — implementation done, awaiting review agent
- `fix_needed` — review found issues, fix agent needed
- `done` — reviewed and accepted, merged to main
- `blocked` — awaiting user decision (orchestrator loop paused)

## Slices

| # | Slice | State | Agent ID | Started | Completed | Notes |
|---|---|---|---|---|---|---|
| S0 | Monorepo Skeleton & Tooling | in_review | general-purpose (fix agent) | 2026-04-18 | — | Fix pass #1 landed: real Domain/Infrastructure smoke assertions, shadcn/ui initialized (components.json + Button primitive), HealthEndpoints aligned to hoppr convention. Awaiting re-review. |
| S1 | Auth Foundation | pending | — | — | — | — |
| S2 | Groups & Memberships | pending | — | — | — | — |
| S3 | Recipes (Core CRUD) | pending | — | — | — | — |
| S4 | Tags + Ratings + Search | pending | — | — | — | — |
| S5 | Portions + Fork + Group Defaults | pending | — | — | — | — |
| S6 | Version History (light) | pending | — | — | — | — |
| S7 | Polish & Local Deploy Readiness | pending | — | — | — | — |

## S0 — completion notes

- All 10 illustrative commits landed in order (TDD: failing tests always precede implementation).
- Acceptance criteria verified on 2026-04-18:
  - `docker compose up --build` brings up postgres, redis, seaweedfs, api, web, caddy — api container becomes `healthy` within ~15 s.
  - `curl http://localhost/api/health` → `{"status":"ok","timestamp":"2026-04-18T08:15:42.85…+00:00"}`
  - `curl http://localhost/` returns the compiled SPA HTML with `<title>Familien-Kochbuch</title>`.
  - `cd apps/web && pnpm test` → 3/3 pass.
  - `dotnet test apps/api/FamilienKochbuch.sln` → 6/6 pass (1 Domain smoke, 1 Infrastructure smoke, 1 Api smoke, 3 Health endpoint contract tests).
  - `pnpm lint` at the root → clean (web lint via `eslint .`).
- **Deviation logged, trivial:** PRD/plan prescribe `.NET 10 preview` package versions (mirroring hoppr). The local toolchain already has GA `.NET 10.0.101` and NuGet GA 10.0.0 packages, so the skeleton targets `net10.0` with stable package versions. No user decision required; this is a straight upgrade.
- **Minor pin for CI/build hygiene:** explicitly reference `System.Security.Cryptography.Xml 10.0.6` in `FamilienKochbuch.Infrastructure.csproj` to silence NU1903 (GHSA-37gx-xxp4-5rgx, GHSA-w3x6-4m5h-cxqf) against the transitive dependency brought in by `Microsoft.EntityFrameworkCore.Design 10.0.0`. Remove once EF Core ships a newer design package that consumes the patched version.

## Last orchestrator tick

- **Wake-up time:** 2026-04-18 (S0 fix pass #1 complete)
- **Action taken:** S0 fix agent resolved all three blocking review findings plus the documented convention deviation. All commits pushed to `origin/main` in TDD order (failing test → implementation). State flipped `fix_needed` → `in_review`.
- **Next action:** dispatch review agent (general-purpose, has Bash) against commits `be4ecbc..HEAD` to re-verify the fixes and the full S0 acceptance criteria.

## Blockers / pauses

_(none)_

## Review outcomes

**S0 — Review #1 (2026-04-18) → fix_needed**

Independent static review performed (reviewer agent-type `feature-dev:code-reviewer` lacks a Bash tool, so runtime verification was deferred — orchestrator will use `general-purpose` for all future reviews to guarantee shell execution). TDD ordering, security properties, warning-as-errors, and overall code hygiene all verified clean. The review caught three real issues:

Blocking:
1. `apps/api/tests/FamilienKochbuch.Domain.Tests/SmokeTests.cs:14` — `Assert.True(true)` placeholder (anti-shortcut checklist violation).
2. `apps/api/tests/FamilienKochbuch.Infrastructure.Tests/SmokeTests.cs:14` — same `Assert.True(true)` violation.
3. `apps/web/` — **shadcn/ui not initialized**; S0 spec explicitly requires `components.json` + base-components placeholder. Missing deliverable.

Non-blocking (documentation):
4. `apps/api/src/FamilienKochbuch.Api/Endpoints/HealthEndpoints.cs:9` — uses `this IEndpointRouteBuilder` + returns `IEndpointRouteBuilder`; hoppr convention is `this WebApplication app` with void return. Either revert or log as a documented deviation (reviewer's preference: document, since the chosen signature supports route groups and is testable).

**Review standard:** Every review applies `docs/reviewing/anti-shortcut-checklist.md`. Reviewers execute verification commands themselves; they do not rely on the agent's claims. Going forward the orchestrator dispatches `general-purpose` for reviews (has Bash).

**S0 — Fix pass #1 (2026-04-18) → in_review**

All three review findings addressed via 6 commits on `origin/main` (`00f6470..6e9e9c1`):

1. **Domain smoke test** — `Assert.True(true)` replaced with a marker-assertion that verifies both `DomainMarker.Name` and `typeof(DomainMarker).Assembly.GetName().Name` equal `"FamilienKochbuch.Domain"`. Breaks if the project reference, assembly name, or marker constant drift. TDD: `test(domain): replace hollow Assert.True smoke test with marker assertion` (red) → `feat(domain): add DomainMarker assembly anchor type` (green).
2. **Infrastructure smoke test** — same pattern, asserted against `InfrastructureMarker`. TDD: `test(infrastructure): replace hollow Assert.True smoke test with marker assertion` → `feat(infrastructure): add InfrastructureMarker assembly anchor type`.
3. **shadcn/ui** — initialized via hand-written `components.json` (New York style, neutral base, CSS variables, no RSC, Lucide icons, full path alias map). Added `src/lib/utils.ts` (canonical `cn()` helper), `src/components/ui/button.tsx` + sibling `button-variants.ts` (New-York Button as "base components placeholder"), neutral theme tokens in `src/index.css` via Tailwind 4's `@theme inline` directive. CLI init (`pnpm dlx shadcn@latest init`) was skipped in favour of the hand-written approach because the CLI lacks non-interactive flags for style/baseColor/path-aliases and the prompt blocks in agent shells — the hand-rolled config matches the spec verbatim. Deps added: `class-variance-authority`, `@radix-ui/react-slot`, `lucide-react`. TDD: `test(web): add failing tests for cn() helper and shadcn Button primitive` (7 + 4 new tests, red because files don't exist) → `feat(web): initialize shadcn/ui (components.json, cn helper, Button primitive)` (green).
4. **HealthEndpoints convention** (non-blocking) — Option A chosen: reverted to the hoppr pattern `public static void MapHealthEndpoints(this WebApplication app)` with `AllowAnonymous()` and `WithTags("Health")`. Rationale: convention > creativity per hard rule 7; the testability argument for the previous `IEndpointRouteBuilder` signature is already satisfied by `WebApplicationFactory<Program>` in `HealthEndpointTests`. Commit: `refactor(api): align MapHealthEndpoints signature with hoppr convention`.

**Post-fix validation executed locally (2026-04-18):**

- `dotnet test apps/api/FamilienKochbuch.sln` → 6/6 pass (1 Domain marker, 1 Infrastructure marker, 4 Api contract).
- `pnpm -C apps/web test --run` → 14/14 pass (3 App + 4 cn + 7 Button).
- `pnpm lint` → clean (0 errors, 0 warnings after splitting `buttonVariants` into its own file to satisfy `react-refresh/only-export-components` without `eslint-disable`).
- `docker compose up --build -d` → all 6 services up; `curl http://localhost/api/health` → `{"status":"ok","timestamp":"2026-04-18T08:30:18.2457566+00:00"}`; `curl http://localhost/` → SPA HTML with `<title>Familien-Kochbuch</title>`. Stack torn down cleanly with `docker compose down`.
- `git status` → clean.
- `git log origin/main..HEAD` → empty (everything pushed).

## Deviations from PRD

- **Trivial (S0):** `.NET 10` pinned to GA (10.0.0 packages) instead of the preview strings referenced by the hoppr pattern repo. Same major version, no API surface difference.
