# P2-5 — Hangfire Orchestration + RecipeImport Entity

**Slice:** P2-5
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-0 (Python scaffold), P2-2 (URL pipeline; Python side ready to receive calls).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

P2-2 / P2-3 / P2-4 Python endpoints are synchronous but long-running (30–120s for video). Instead of making the frontend wait on a single HTTP call, we queue the work via **Hangfire on the .NET side**. The Python service stays dumb; Hangfire holds the connection, retries on failure, exposes a dashboard.

Decision reminder (user-approved, see parent plan §Decisions):
- Queue: Hangfire (.NET) — user knows it from prior work.
- Storage: `Hangfire.PostgreSql` (MIT, free) — Redis provider requires Hangfire Pro.
- Schema: dedicated `hangfire` schema in the existing Postgres DB.

## Scope

### 1. Packages + config

Add to `apps/api/src/FamilienKochbuch.Api/FamilienKochbuch.Api.csproj`:
- `Hangfire.AspNetCore`
- `Hangfire.PostgreSql`

Add to `apps/api/src/FamilienKochbuch.Api/Program.cs`:
```csharp
builder.Services.AddHangfire(cfg => cfg
    .UsePostgreSqlStorage(options => {
        options.UseNpgsqlConnection(connectionString);  // same connection string
    }, new PostgreSqlStorageOptions {
        SchemaName = "hangfire",
        PrepareSchemaIfNecessary = true,       // creates tables idempotently
    }));
builder.Services.AddHangfireServer();
// Dashboard behind admin-only auth
app.UseHangfireDashboard("/api/hangfire", new DashboardOptions {
    Authorization = new[] { new AdminOnlyAuthorizationFilter() },
});
```

Where `AdminOnlyAuthorizationFilter : IDashboardAuthorizationFilter` checks the JWT role claim.

### 2. `RecipeImport` entity

New file: `apps/api/src/FamilienKochbuch.Domain/Entities/RecipeImport.cs`

```csharp
public sealed class RecipeImport
{
    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public Guid GroupId { get; private set; }
    public ImportSource Source { get; private set; }  // Url / Photos / Chat
    public ImportStatus Status { get; private set; }  // Queued / Running / Done / Error
    public int Progress { get; private set; }          // 0..100
    public string? SourceUrl { get; private set; }     // nullable for photos/chat
    public string? ResultJson { get; private set; }    // populated on Done
    public string? ErrorMessage { get; private set; }  // populated on Error
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? CompletedAt { get; private set; }

    // Constructor + status-transition methods (MarkRunning, MarkDone, MarkError)
}

public enum ImportSource { Url = 0, Photos = 1, Chat = 2 }
public enum ImportStatus { Queued = 0, Running = 1, Done = 2, Error = 3 }
```

EF Core migration: `AddRecipeImportTable`.

### 3. Jobs

Folder: `apps/api/src/FamilienKochbuch.Api/Jobs/`

- `ExtractRecipeFromUrlJob(Guid importId)` — reads `RecipeImport`, calls Python `POST /extract/url`, updates progress (10 → 40 → 70 → 95 → 100), sets `Status = Done` + `ResultJson` on success or `Status = Error` + `ErrorMessage` on failure.
- `ExtractRecipeFromPhotosJob(Guid importId)` — same shape.
- (Chat — decision in P2-4: likely NOT a Hangfire job if synchronous < 5s. P2-4 will decide.)

Jobs use typed `IHttpClientFactory` → Python service at `http://python-extractor:8000`.

### 4. Service-to-service HMAC auth

- Shared secret: `EXTRACTOR_SHARED_SECRET` env var (already staged in `.env.example` during P2-0).
- .NET computes `X-Extractor-Signature: HMAC-SHA256(user_id + "|" + timestamp + "|" + body-hash, shared-secret)`.
- Python middleware (added here, since this slice is the first caller) verifies the header. 15-minute clock-drift tolerance.
- Unit tests both sides.

### 5. Retry policy

Hangfire's built-in `AutomaticRetry`:
- Default: 10 attempts with exponential backoff (20s → 40s → 80s → …).
- Override: `[AutomaticRetry(Attempts = 3)]` per job.
- `DisableAutomaticRetry` for hard failures — catch `PythonHardError` (our wrapping type for 4xx from Python that indicates invalid input — invalid URL, private video).

### 6. Status API endpoint

File: `apps/api/src/FamilienKochbuch.Api/Endpoints/ImportEndpoints.cs`

```
GET /api/imports/{importId} → { status, progress, result?, error? }
```

Admin can see any user's import; regular user only their own. Frontend polls every 2s.

### 7. Enqueue endpoints (wired in P2-6)

Don't add the user-facing `POST /api/recipes/import/url` endpoint in P2-5. That's P2-6's scope (the proxy surface). P2-5 ships the jobs, the entity, the status endpoint — and Hangfire is ready to accept `BackgroundJob.Enqueue<ExtractRecipeFromUrlJob>(j => j.RunAsync(importId))` when P2-6 needs it.

### 8. Tests

.NET integration tests (`apps/api/tests/FamilienKochbuch.Api.Tests/Jobs/ExtractRecipeFromUrlJobTests.cs`):
- Uses `Hangfire.InMemory` backend for tests (faster than Postgres spin-up).
- Mocks the Python HTTP call with `Moq` + `HttpMessageHandler` stub.
- Happy path: queues → runs → status transitions → `ResultJson` populated.
- Python 4xx → job fails non-retryable, `Status = Error` + `ErrorMessage`.
- Python 5xx → job retries 3×, eventually succeeds OR errors.
- Admin dashboard endpoint auth: non-admin → 403; admin → 200.

HMAC verification tests in Python (`apps/python-extractor/tests/test_hmac_middleware.py`):
- Valid signature → request passes through.
- Invalid → 401.
- Replayed (>15 min old) → 401.
- Missing header → 401.

## Non-goals

- No user-facing import endpoints yet — P2-6.
- No frontend — P2-7+.
- No chat-as-job — P2-4 decides whether chat needs the queue.
- No persistent chat sessions.

## Acceptance criteria

- `dotnet test` green + new integration tests.
- `pytest` green + new HMAC middleware tests.
- Web (548) unchanged.
- Migration runs cleanly on fresh Postgres.
- Hangfire dashboard loads at `/api/hangfire` for admin, 403 for member.

## Anti-shortcut reminders

- TDD for every job + endpoint.
- HMAC timestamp check must prevent replay — test that.
- Migrate-on-boot is fine; don't require a manual migration step.
- `EXTRACTOR_SHARED_SECRET` must NEVER be logged — add a caplog test.
- Use `IHttpClientFactory`, not `new HttpClient()` — avoids socket exhaustion.
- No broad `catch (Exception)` — catch `HttpRequestException`, `JsonException`, specific LLM wrappers.

## Dispatch notes

**Impl agent:**
- Read parent plan + P2-0 + P2-2 plans first.
- Work order: RecipeImport entity + migration + test → HMAC middleware (Python side) → HMAC signer (C# side) + test → ExtractRecipeFromUrlJob + integration test → ExtractRecipeFromPhotosJob + test → Status API endpoint + test → Dashboard auth + test.
- Commit per step.
- Run both `dotnet test` and Python `pytest` gates after each chunk.

**Reviewer:**
- Confirm HMAC replay-prevention works (timestamp skew).
- Confirm dashboard is admin-only.
- Confirm no `EXTRACTOR_SHARED_SECRET` in logs.
- Confirm migration runs on fresh DB.
- Run all four language gates.
