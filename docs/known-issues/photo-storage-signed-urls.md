# Known Issue — Photo Storage uses Public S3 URLs Instead of Signed Backend-Proxied URLs

**Filed:** 2026-04-18 (after S3 completion)
**Reported by:** Project owner
**Severity:** Medium (privacy + operational fragility)
**Target fix slot:** Dedicated fix agent between S4 and S5 (or earliest available)

## Current implementation (shipped in S3)

- `apps/api/src/FamilienKochbuch.Infrastructure/Services/SeaweedFsPhotoStorage.cs` uses `Amazon.S3` SDK against SeaweedFS's S3-compatible gateway.
- `EnsureBucketAsync` idempotently creates the `recipe-photos` bucket on startup.
- Public URLs have the shape `{PhotoStorage:PublicBaseUrl}/{Bucket}/{guid}.{ext}` — derived from `PhotoStorageOptions`.
- `docker-compose.yml` runs SeaweedFS with `server -s3` so port 8333 speaks the S3 protocol.
- `infra/Caddyfile` proxies `/photos/*` → `seaweedfs:8333`, which means the S3 gateway is reachable from the public internet through Caddy.
- Authentication only happens on **upload** (`POST /api/recipes/{id}/photos` requires group membership). Once the URL exists, it is permanent and world-accessible.
- The upload path already contains S3-API workarounds: the payload is fully buffered into a `MemoryStream` before the SDK call, and `UseChunkEncoding=false` is required because SeaweedFS rejects chunked transfer encoding in some versions. See inline comments in `SeaweedFsPhotoStorage.UploadAsync`.

## Why this is a problem

1. **Privacy leak risk.** URLs are unguessable (GUID keys, 128 bit) but permanent. Anyone who gets the URL — a copy-paste into a chat, a browser-history export, a leaked log line — can fetch the photo forever. For a private family recipe book, this is misaligned with the "invite-only, Gruppen-gated" promise in the PRD.
2. **Public attack surface.** SeaweedFS's S3 gateway is currently exposed through Caddy (`/photos/*`). The S3 gateway has its own auth layer that we don't configure (so it's effectively unauthenticated), and its attack surface is bigger than a backend-proxied download endpoint.
3. **S3-protocol brittleness.** The S3 SDK already required two workarounds in S3; future SeaweedFS upgrades could break payload signing, chunked encoding, or bucket-auto-create again. Each break is a production incident.
4. **Historical precedent.** The hoppr project hit exactly this set of issues and migrated to a signed-URL + backend-proxy pattern. We are about to relearn the same lesson if we don't switch first.

## Target design (mirrored from hoppr)

See the hoppr project for the exact working implementation:

- `apps/api/src/Hoppr.Api/Services/SeaweedFsService.cs` — talks directly to the SeaweedFS **filer** (port 8333 speaking plain HTTP REST, not S3) using `HttpClient.PutAsync($"/{path}", content)` and `DeleteAsync($"/{path}")`. Zero S3 SDK.
- `apps/api/src/Hoppr.Api/Services/ImageSigningService.cs` — HMAC-SHA256 signature over `{path}:{exp}` using a key derived from the JWT signing secret (`SHA256("img-sign:" + jwtKey)`). Default validity 2 h, configurable via `Images:SignatureValidityHours`. Signatures are URL-safe base64 (`+` → `-`, `/` → `_`, stripped `=`).
- `apps/api/src/Hoppr.Api/Endpoints/ImageEndpoints.cs` — `GET /api/images/{**path}` is anonymous, validates the `sig` + `exp` query parameters, then proxies the content from SeaweedFS filer via an internal docker-network `HttpClient`. Sets `Cache-Control: private, max-age=3600`.

Upload endpoints (`POST /api/journal/{entryId}/images` etc.) store the bare path (e.g. `journal/{entryId}/{imageId}.jpg`), call `SeaweedFsService.UploadAsync(stream, path, contentType)`, and return the signed URL by calling `seaweed.GetPublicUrl(path)` which internally does `signing.SignUrl($"/api/images/{path}", path)`.

## Migration plan for Familien-Kochbuch

### Step 1 — Introduce the signing service

- Create `apps/api/src/FamilienKochbuch.Api/Services/ImageSigningService.cs` mirroring hoppr.
- Config section `Images:SignatureValidityHours` (default `2`). Use the existing `Jwt:SigningKey` as the root secret — same composition pattern (`SHA256("img-sign:" + jwtKey)`).
- Wire via `builder.Services.AddSingleton<ImageSigningService>()`.
- Tests: `ImageSigningServiceTests` covering roundtrip sign → validate, expiry rejection, tamper rejection (FixedTimeEquals).

### Step 2 — Add the proxy endpoint

- Create `apps/api/src/FamilienKochbuch.Api/Endpoints/PhotoProxyEndpoints.cs` (or reuse `RecipeEndpoints` with a `MapPhotoProxyEndpoints`). Route: `GET /api/photos/{**path}`. `.AllowAnonymous()`.
- Behaviour: parse `sig` + `exp` from query, validate against path, return `Results.StatusCode(403)` on failure. On success, proxy the file from SeaweedFS filer via `IHttpClientFactory`. Cache-Control `private, max-age=3600`.
- Tests: integration tests covering valid signed URL → 200, missing `sig` → 403, expired → 403, tampered `sig` → 403, path not found → 404.

### Step 3 — Switch `SeaweedFsPhotoStorage` to the filer (plain HTTP)

- Refactor `SeaweedFsPhotoStorage` to drop `Amazon.S3` and use `IHttpClientFactory` against `SeaweedFS:FilerUrl` (default `http://seaweedfs:8333`).
- `UploadAsync(Stream, contentType, originalFileName, ct)` → PUTs the stream to a path like `recipes/{guid}.{ext}`, returns **the raw path** (not the URL).
- Introduce a second method `string GetPublicUrl(string path)` on `IPhotoStorage` that returns the signed proxy URL via `ImageSigningService`.
- Update `RecipeEndpoints` upload handler to:
  1. Call `UploadAsync` → get `path`
  2. Store `path` (not the full URL) in `Recipe.Photos` — **breaking change to the stored representation**. Handle migration.
  3. Call `GetPublicUrl(path)` when composing responses.
- `DeleteAsync(string pathOrUrl)` should accept either the raw path or a previously-issued signed URL (parse the path segment before `?`).
- Tests: `FakePhotoStorage` also implements the same two-method surface.

### Step 4 — Docker compose changes

- Change `seaweedfs` command from `server -s3 -dir /data` to `server -dir /data` (no S3 gateway needed). Still exposes port 8333 for the filer REST API — **but only on the internal docker network**, no Caddy route.
- Drop the `seaweedfs` port publish from `docker-compose.yml` (it's already only exposed internally via `expose`).
- `infra/Caddyfile`: remove the `/photos/*` reverse-proxy block.
- `appsettings.*.json`: replace `PhotoStorage:Endpoint` / `PhotoStorage:PublicBaseUrl` with a single `SeaweedFS:FilerUrl`. Add `Images:SignatureValidityHours`.
- `.env.example`: document any new env-var overrides.

### Step 5 — Data migration for existing recipes

- If the docker volume already carries `Recipes.Photos` rows holding full `http://localhost/photos/recipe-photos/{guid}.ext` URLs from S3, a migration pass must:
  1. Parse the path segment out of each URL.
  2. Update the row to store the path (`recipe-photos/{guid}.ext`) instead.
- Ship as an EF Core migration that runs a `migrationBuilder.Sql(...)` string-replace against `Recipes.Photos`, OR as a one-off startup fixup similar to `SeedDataService.BackfillPrivateCollectionsAsync` from S2.

### Step 6 — Re-run the S3 E2E curl flow

- Upload a PNG → get a signed URL (`/api/photos/recipes/{guid}.png?sig=...&exp=...`).
- Fetch the URL → 200.
- Wait past expiry (configurable; lower `SignatureValidityHours` to `0.001` for the test) → 403.
- Delete the photo → subsequent fetch → 404.
- Non-member upload attempt → 403 (unchanged).

### Acceptance criteria

- SeaweedFS port 8333 no longer reachable from outside the docker network (verify via `curl -I http://localhost:8333/` fails).
- No `Amazon.S3` references remain in the codebase outside of test scaffolding.
- Photo URLs returned by the API contain `?sig=...&exp=...`.
- Any existing photo rows still resolve after the migration.
- All prior S3 tests (dotnet + web) still green.

## Priority

**Medium.** Not blocking Phase 1, but should land before any non-family user sees the app. Target: dedicated fix agent dispatched between S4 and S5, timeboxed to roughly the same effort as a small fix-pass (~1 h of agent work). If the fix agent hits unexpected complexity (e.g. content-type negotiation with the filer or caching edge cases), the orchestrator should pause and consult before expanding scope.
