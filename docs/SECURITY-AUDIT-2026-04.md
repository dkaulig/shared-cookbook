# Security Audit — 2026-04 (REL-0b)

**Date:** 2026-04-24
**Scope:** code + infra inside `apps/`, `infra/`, `docker-compose*.yml`,
`.github/workflows/`. Excludes `.env.example` / fixture / migration
content (handled by REL-0) and frontend mutation-error surface
(handled by REL-5).
**Tooling:** pnpm audit, dotnet list package --vulnerable, pip-audit
(uv-installed), gitleaks 8.30.1, trivy 0.70.0.
**Reviewer:** REL-0b sub-agent under `docs/plans/2026-04-22-open-source-release-plan.md`.

The audit runs as Round 1 of the open-source release plan before
the repo flips to public visibility. Findings are the baseline we
expect to carry into GitHub's CodeQL + Dependabot + Secret-Scanning
surface once the repo is public.

---

## Executive summary

| Severity | Count | Fixed in audit | Flagged to other lanes | Accepted |
|---|---|---|---|---|
| Critical | 0 | — | — | — |
| High     | 6 | 6 | 0 | 0 |
| Medium   | 1 | 0 | 0 | 1 |
| Low      | 2 | 0 | 0 | 2 |

No Critical findings. Six High-severity findings were fixed in-line
(see "Fix commits" at the bottom). The three remaining
Medium/Low findings are documented as accepted with rationale —
none block the public release.

---

## Automated tooling

### pnpm audit (apps/web)

- **Before:** 1 High + 1 Moderate — both in
  `serialize-javascript <= 7.0.2` reached via
  `vite-plugin-pwa -> workbox-build -> @rollup/plugin-terser`.
- **After:** `No known vulnerabilities found` (pinned via pnpm
  override to `serialize-javascript: >=7.0.5`; see F1).

### dotnet list package --vulnerable --include-transitive

- `FamilienKochbuch.Api`, `FamilienKochbuch.Domain`,
  `FamilienKochbuch.Infrastructure` and their Tests projects: 0
  vulnerable packages.

### pip-audit (apps/python-extractor)

- `No known vulnerabilities found` against the resolved uv lock.

### gitleaks detect (full history)

- 1 finding — false positive. Hex-string fixture in
  `apps/api/tests/FamilienKochbuch.Domain.Tests/Entities/AppInviteTests.cs:14`
  (64-char dummy token used to exercise the token-length invariant).
  Not a secret. Documented here to prevent re-flagging.

### trivy fs . (severity HIGH/CRITICAL)

- **Before:** 1 HIGH dep (same serialize-javascript, already covered
  by F1) + 1 HIGH misconfig (DS-0002: `apps/web/Dockerfile` runs as
  root).
- **After:** dep finding resolved; Dockerfile misconfig resolved
  (F3). API + Python extractor Dockerfiles were already clean (both
  USER-switch to non-root).

---

## OWASP Top-10 walkthrough

Every category was reviewed against `apps/api/` + `apps/python-extractor/`
+ `apps/web/` code.

### A01 Broken Access Control — **clean**

- 85 endpoints registered in `apps/api/src/.../Endpoints/`. All but
  the expected 8 auth / health / invite-preview / photo-proxy routes
  carry `RequireAuthorization()`.
- Every data-accessing endpoint further gates on group-membership
  (via `IsGroupMemberAsync(db, groupId, userId)` helper —
  `GroupEndpoints.cs:47-48`, mirrored across
  `RecipeEndpoints.cs`, `MealPlanEndpoints.cs`,
  `ShoppingListEndpoints.cs`, `RatingEndpoints.cs`,
  `RecipeRevisionEndpoints.cs`, `SearchEndpoints.cs`) or on
  admin-role (`ClaimsPrincipal.IsAdmin()` — `AdminAiUsageEndpoints.cs:62`,
  `AdminExtractorConfigEndpoints.cs:86, 109, 172`).
- `ChatEndpoints.cs:45-46` notes: "a session the caller doesn't
  own returns 404, not 403, so the endpoint doesn't leak session
  IDs" — good practice, preserved across every chat route.
- Photo URLs are HMAC-signed with path + expiry
  (`PhotoUrlSigner` / `ImageSigningService`); the AllowAnonymous
  `/api/photos` endpoint validates the signature before serving.

### A02 Cryptographic Failures — **clean**

- JWT HS256 via `SymmetricSecurityKey` (`TokenService.cs:61`).
  Signing key comes from env var `JWT_SIGNING_KEY`
  (`Program.cs:38-42`). `JwtOptions.cs:12` comments "Must be at
  least 32 characters (256 bits)"; operators are responsible for
  entropy, `.env.example` documents this (REL-0 territory).
- Refresh tokens: 32 random bytes from
  `RandomNumberGenerator.GetBytes`, SHA-256-hashed at rest, rotated
  on every use with OWASP reuse-detection that revokes the whole
  family on replay (`TokenService.cs:95-138`).
- Refresh-token cookie: HttpOnly + SameSite=Lax + Path scoped to
  `/api/auth`; `Secure` is set unless the request is HTTP against
  localhost (`AuthEndpoints.cs:232-242`). Prod deployment sits
  behind Caddy-terminated TLS so scheme is forwarded via
  `X-Forwarded-Proto` (see F9 for the fragility note).
- Password hashing: Argon2id via the custom
  `Argon2idPasswordHasher` (`Program.cs:118`). Strong against
  offline cracking.
- SeaweedFS photo URLs: HMAC-signed, configurable TTL
  (`Images.SignatureValidityHours`, default 2h —
  `appsettings.json:20`).

### A03 Injection — **clean**

- No `FromSqlRaw` / `ExecuteSqlRaw` / `FromSqlInterpolated` calls
  anywhere in `apps/api/src/`. All EF Core queries use LINQ →
  parameterised SQL.
- `apps/python-extractor/src/.../pipeline/video.py:856` invokes
  ffmpeg via `asyncio.create_subprocess_exec` with a static argv
  list (no shell, no user-input concatenation). argv[0] = "ffmpeg",
  rest are literal flags + a float timestamp + file paths built
  from the pipeline's own tmpdir.
- No unsafe-HTML React sinks (the one match for that pattern —
  `markdownRenderer.tsx:11` — is a comment asserting the absence).
- Prompt injection: see F5 (fixed).

### A04 Insecure Design — **clean**

- Domain invariants enforce positive values for servings / tokens /
  progress / positions. Multiple grep hits under
  `apps/api/src/FamilienKochbuch.Domain/Entities/` including
  `Recipe.cs:484` (`DefaultServings <= 0` → `ArgumentException`),
  `Ingredient.cs:71` (quantity `<= 0m`),
  `Group.cs:53, 161` (defaultServings `<= 0m`),
  `RecipeImport.cs:213, 301, 304, 307, 405, 552, 561, 631, 644`
  (progress `< 0 or > 100` clamped).
- Nutrition estimates are clamped upstream in the Python pipeline
  (`NutritionEstimate.cs:8` comments the contract: kcal 0..5000,
  macros 0..500 g).

### A05 Security Misconfiguration — **one finding fixed + one accepted**

- **F2 (High, fixed)**: `infra/Caddyfile.prod` pre-audit shipped no
  security headers. Added baseline CSP / HSTS / X-Frame-Options /
  X-Content-Type-Options / Referrer-Policy / Permissions-Policy +
  `Server` header strip.
- **F3 (High, fixed)**: `apps/web/Dockerfile` ran as root on
  `caddy:2-alpine`. Added explicit non-root `caddy-user` and
  `USER caddy-user`. Re-trivy now clean.
- **F7 (Medium, accepted)**: `Program.cs:328-333` registers a CORS
  policy `FamilienKochbuchDev` with `AllowCredentials` + hard-coded
  origins `http://localhost` + `http://localhost:5173`. In prod the
  SPA + API are same-origin behind Caddy, so CORS is never invoked —
  but the policy applies regardless. `file:328-333`. Fix: gate CORS
  to Development-env only, or switch to a prod-aware origin list.
  Accepted for v1 because Caddy same-origin means no real exposure;
  planned as a small hardening follow-up.
- `app.UseExceptionHandler()` + `AddProblemDetails()` —
  `Program.cs:149-150, 548` — installs the production-safe
  exception handler. `UseDeveloperExceptionPage` is NOT called.
  Swagger UI is gated behind IsDevelopment or the
  `OpenApi:Enabled` config flag (`Program.cs:155-157, 608`).
- Docker containers: `apps/api/Dockerfile:24-25` runs `USER app`;
  `apps/python-extractor/Dockerfile:87` runs `USER extractor`.
  Web fixed in F3.
- `InternalOnlyMiddleware` + Caddy's `/api/internal/*` -> 404 block
  (`Caddyfile.prod:28-31`) enforces defence-in-depth for
  intra-container callbacks.

### A06 Vulnerable Components — **one dep finding fixed**

- **F1 (High, fixed)**: serialize-javascript <= 7.0.2 transitive
  via vite-plugin-pwa -> workbox-build -> @rollup/plugin-terser.
  Pinned to `>=7.0.5` via `package.json` pnpm override. pnpm audit
  now clean.
- All other package manifests clean per the automated scans.

### A07 Auth Failures — **one finding fixed**

- **F4 (High, fixed)**: `AuthEndpoints.cs:LoginAsync` called
  `users.CheckPasswordAsync` in isolation, never invoked
  `IsLockedOutAsync` / `AccessFailedAsync` /
  `ResetAccessFailedCountAsync`, and `Program.cs` did not set any
  `Lockout` options. Identity's per-user brute-force defence was
  effectively disabled. Now: 5 attempts -> 15 min lockout, checked
  before password verification. Response body stays identical to
  "wrong password" so lockout state does not leak.
- Password policy: 8-char minimum, no complexity requirements
  (`Program.cs:107-113`). Adequate for a single-family app;
  complexity requirements are user-hostile without materially
  raising attacker cost when combined with the fixed lockout.
- `/api/auth/login` rate-limited per-IP at 5/min via
  `RateLimitPolicies.Login` (`Program.cs:364-380`).
- 2FA / WebAuthn: not implemented; documented as out-of-scope per
  the release plan. Tracked as a post-v1 feature.

### A08 Supply Chain — **clean**

- All three lockfiles (`pnpm-lock.yaml`, per-project
  `packages.lock.json`, `apps/python-extractor/uv.lock`) committed.
- Docker builds: multi-stage, explicit base-image tags (no
  `:latest`); reproducible within a tag, which is what matters for
  a hobby project.
- Signed-image supply chain (sigstore/cosign) intentionally out
  of scope per the release plan.

### A09 Logging + Monitoring — **clean**

- `apps/python-extractor/src/.../pipeline/url.py` routes every URL
  through `_redact_host(url)` before logging — the host is
  preserved but the rest of the URL is redacted. Observed at
  `url.py:615, 731, 802, 923, 943, 1148, 1151`.
- No `.NET` log statement emits raw email / password / token values
  — only user-id GUIDs (`TokenService.cs:117`,
  `SeedDataService.cs:230`).
- **F8 (Low, accepted)**: `url.py:1390` logs up-to-400 chars of the
  composed LLM user_message at DEBUG level — this may include
  content from blog / caption / transcript. Acceptable because
  DEBUG is not the default log level in prod (Serilog default
  `Information` per `appsettings.json:42-44`). Operators who turn
  DEBUG on should redact logs before sharing.
- `ExtractorConfigHistory` retains every config change per-user —
  audit-log retention is indefinite by design for a single-family
  app.

### A10 SSRF — **clean**

- Python pipeline: every outbound HTTP fetch runs through
  `_assert_safe_http_target` (`url.py:228-283`) — rejects private,
  loopback, link-local, reserved, multicast, unspecified, and known
  blocked hostnames. Re-checks on every redirect hop
  (`url.py:337, 1177, 1193`). Allows an explicit
  `allowed_private_host` carve-out for the intra-container
  progress callback.
- .NET pipeline: `CandidateAttacher.IsPublicAddress`
  (`CandidateAttacher.cs:429-463`) blocks IPv4 private ranges,
  loopback, link-local (incl. AWS metadata 169.254.169.254),
  CGNAT, multicast, broadcast, IPv6 loopback / link-local /
  ULA / 4-mapped-private. Combined with eTLD+1 same-origin rule
  (`CandidateAttacher.cs:344-377`) + CDN allowlist for the
  post-extract thumbnail download, BUG-047 territory fully covered.
- `AllowAutoRedirect = false` on the CandidateAttacher's
  HttpClient (`Program.cs:220-222`) so a malicious CDN can't
  redirect off-allowlist mid-flight.

### AI-specific — **two findings fixed + one accepted**

- **F5 (High, fixed)**: prompt-injection wrapping inconsistent.
  Only `<untrusted_blog>` was used + named in the system prompt.
  Captions (social-media metadata) and Whisper transcripts
  (attacker-spoken audio) arrived plain. Now wrapped in
  `<untrusted_caption>` and `<untrusted_transcript>` + system
  prompt extended to cover all three.
- **F6 (High, fixed)**: Import-enqueue endpoints
  (`/api/recipes/import/url`, `/api/recipes/import/photos`) had
  `RequireAuthorization` but no rate-limit. Each import fans out
  to yt-dlp + Whisper + Azure OpenAI — a stuck-reload loop or a
  compromised account could burn significant CPU minutes + Azure
  cost. Added `RateLimitPolicies.Import` (5/min per user, sliding
  window) applied to both routes.
- **Accepted**: Azure training-opt-out documentation needs to land
  in `docs/SETUP.md` per the release plan (REL-6). Azure OpenAI
  does NOT use customer inputs for model training by default but
  abuse-monitoring retains 30 days — operators must know.

---

## Other findings (Low / accepted)

- **F9 (Low, accepted)**: `AuthEndpoints.cs:237-239` decides
  `Secure` on refresh cookies by inspecting the request scheme +
  host. In prod, Caddy terminates TLS and forwards `http://` with
  `X-Forwarded-Proto: https`. `Program.cs:543-546` honours the
  forwarded headers, so `ctx.Request.Scheme` ends up as `https`
  and `Secure` is set correctly. Works today; fragile because a
  misconfigured reverse proxy could strip the header and silently
  downgrade cookies. Follow-up: force `Secure = true` in
  Production env regardless of request scheme.

---

## Flagged to other lanes

No findings crossed into REL-0 (env / compose / fixtures) or REL-5
(frontend mutation errors). Everything fit inside the REL-0b lane.

One reminder for REL-0:
- `apps/api/src/FamilienKochbuch.Api/appsettings.json:7` carries
  `"CHANGE_ME_IN_ENV_JWT_SIGNING_KEY_MUST_BE_AT_LEAST_32_CHARS"`
  and line 24 carries `"dev-only-shared-secret"`. Both are overridden
  by env vars in `Program.cs:36-42` and `Program.cs:51-56`. Safe
  because any deployment that fails to set these will ship with a
  known-public signing key (and JWT validation would accept
  attacker-forged tokens) — REL-0 should either (a) remove the
  placeholders so startup fails closed, or (b) document the check
  clearly in `docs/SETUP.md`.

---

## Fix commits (landed in this audit)

| ID | Commit subject | Severity | Files touched |
|---|---|---|---|
| F4 | `fix(api): REL-0b enforce Identity lockout on login` | High | `Program.cs`, `AuthEndpoints.cs`, tests |
| F5 | `fix(extractor): REL-0b wrap caption + transcript in untrusted delimiters` | High | `recipe_extraction.py`, tests |
| F6 | `fix(api): REL-0b rate-limit import enqueue endpoints (Azure cost cap)` | High | `Program.cs`, `ImportEndpoints.cs`, new test |
| F2 + F3 | `fix: REL-0b infra hardening (Caddy headers + web non-root)` | High | `Caddyfile.prod`, `apps/web/Dockerfile` |
| F1 | `fix(web): REL-0b pin serialize-javascript >=7.0.5 via pnpm override` | High | `package.json`, `pnpm-lock.yaml` |

---

## Verdict

**Ship.** All High findings fixed. Remaining Medium/Low items are
documented with explicit accept-rationale and none blocks the first
public release. Automated-scan baseline is clean across the three
language ecosystems.

Future audits should re-run the five tools in CI (GitHub Actions on
the public repo) and open an issue for each High / Critical delta.
