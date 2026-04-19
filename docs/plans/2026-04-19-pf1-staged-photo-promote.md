# PF1 — Staged-Photo Auto-Attach (promote flow)

**Slice:** PF1 (Post-Phase-2 Follow-up 1)
**Status:** planned
**Date:** 2026-04-19
**Depends on:** P2-8 (staged endpoint), Phase 2 complete.
**User request:** 2026-04-19 — "ja wäre sinnvoll die ans rezept automatisch zu hängen".

## Why

P2-8 shipped the photo-import flow but staged photos never land on the saved recipe — the text-extraction result gets persisted, but the uploaded images stay in the `recipes/staged/` bucket and are disconnected from the recipe record. The user has to re-upload them manually via the Edit form if they want the original photos attached. That's a broken UX.

## Scope

### 1. `StagedPhoto` domain entity + migration

New entity tracking which staged blobs belong to which user + when they can be reaped:

```csharp
public sealed class StagedPhoto
{
    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public string PhotoId { get; private set; }     // the blob key suffix
    public string SignedUrl { get; private set; }   // last-known signed URL
    public string ContentType { get; private set; } // image/jpeg etc.
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? PromotedAt { get; private set; } // null until attached
    public Guid? PromotedToRecipeId { get; private set; }   // null until attached
}
```

Migration: `AddStagedPhotoTable`, indices on `(UserId, CreatedAt)` for the sweep job.

`POST /api/recipes/photos/staged` (existing from P2-8) now ALSO inserts a `StagedPhoto` row alongside the SeaweedFS upload, returns `{ stagedPhotoId, signedUrl }` (add `stagedPhotoId`, keep `photoId` for backward-compat if needed).

### 2. Promote flow

Two options for "promote":

**Option A (adopted): `/api/recipes` create-recipe endpoint accepts `stagedPhotoIds`.**
- `CreateRecipeRequest` gets optional `stagedPhotoIds: Guid[]`.
- On handler: after creating the recipe, for each stagedPhotoId: verify ownership (UserId match) + not-already-promoted, copy blob from `recipes/staged/{userId}/{photoId}` to `recipes/{recipeId}/{newGuid}`, insert `RecipePhoto` row, mark `StagedPhoto.PromotedAt + PromotedToRecipeId`. Delete staged blob after successful RecipePhoto insert.
- Sequential, failure-at-photo-N → recipe still exists, N-1 photos attached; return response including `partialPhotoFailures` list for the frontend banner.

**Option B (rejected): separate `POST /api/recipes/{id}/photos/promote` endpoint.**
Two calls = more round-trips + orphan-state window between create + promote. Option A is tighter.

### 3. Sweep job (Hangfire)

Recurring job, runs hourly:
- Find `StagedPhoto` rows with `CreatedAt < now - 24h` AND `PromotedAt == null`.
- For each: delete the SeaweedFS blob + delete the DB row.
- Log count.

Registered via `RecurringJob.AddOrUpdate` in `Program.cs`.

### 4. Web wiring

`ImportPhotosPage.tsx`:
- Collect `stagedPhotoIds[]` alongside the currently-collected signed URLs.
- Pass to the import-enqueue endpoint's hint metadata? OR better: stash in sessionStorage along with the import, so the `RecipeFormPage` prefill can pull them.

`RecipeFormPage.tsx`:
- When coming from photo-import (`isPhotoImport && stagedPhotoIds.length > 0`):
  - Include `stagedPhotoIds` in the `CreateRecipeRequest` payload.
  - Show a small info badge: "{N} Fotos werden beim Speichern angehängt."
- Partial-failure response → banner "Rezept gespeichert, aber X von Y Fotos konnten nicht angehängt werden — bitte manuell hochladen."

### 5. Tests

.NET:
- `StagedPhotoTests.cs`: domain invariants + state transitions.
- `CreateRecipe_With_StagedPhotos_Attaches_Them` integration test.
- `CreateRecipe_With_StagedPhotos_Wrong_Owner_Rejects` (403 or filtered out — decide; recommend filter + log).
- `CreateRecipe_With_StagedPhotos_Already_Promoted_Skips_Gracefully` (idempotent).
- `SweepStagedPhotosJob` unit test with `Hangfire.InMemory` + frozen clock.

Python: untouched.

Web: update `ImportPhotosPage.test.tsx` + `RecipeFormPage.test.tsx` for the new stagedPhotoIds plumbing + partial-failure banner.

## Non-goals

- No delete-from-detail-page UI (user confirmed Edit-mode suffices).
- No re-order of attached photos during promote (sequence = client-collected order).
- No client-side compression pre-upload.
- No HEIC support (already rejected in P2-8).

## Acceptance criteria

- `dotnet test`, `pytest`, `pnpm test`, `pnpm build`, `pnpm lint` all green.
- Flow: user uploads 3 photos → text-extraction → saves recipe → detail page shows the 3 photos attached, no manual re-upload.
- Partial failure: if 1 of 3 photos fails to promote, recipe still saved with 2 photos + banner explains.
- Sweep job reaps > 24h-old staged photos cleanly, no data loss to promoted photos.
- Migration applies cleanly.

## Anti-shortcut reminders

- TDD per domain change + endpoint change.
- Sweep job has a dry-run mode for testing (parameter).
- `StagedPhoto.UserId` ownership check is server-side only — never trust client-reported ownership.
- Don't delete the SeaweedFS blob before the `RecipePhoto` insert succeeds — order matters for failure recovery.
- `PromotedAt + PromotedToRecipeId` must be set atomically with the blob-copy + RecipePhoto-insert (transaction).

## Dispatch notes

**Impl agent:** commit-per-step (StagedPhoto entity + migration → staged endpoint update → promote logic on create-recipe → sweep job → web plumbing → partial-failure banner). Every step has a test commit precede the code commit where applicable. All four language gates must be green at the end.
