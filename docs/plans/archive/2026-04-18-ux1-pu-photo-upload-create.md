# UX1-PU — Photo Upload im Create-Modus

**Slice:** UX1-PU
**Status:** planned
**Date:** 2026-04-18
**Depends on:** UX1-RT (landed).

## Why

Today the recipe form has two different photo surfaces:
- **Edit mode** (`mode === 'edit' && initial`): full `<PhotoUploadGrid>` — drop-zone, 3 slots, remove button, live upload via `useUploadRecipePhoto`.
- **Create mode**: three dashed placeholder tiles with the copy "Fotos kannst du nach dem ersten Speichern hinzufügen".

User complaint (BF1 backlog): it's awkward to add a recipe without being able to attach its photo immediately. The current flow is: save → navigate to detail → go back to edit → add photo. That's three extra steps that make the app feel half-finished.

## Plan-level decision

Three plausible paths:

1. **Temp-storage API**: backend issues a temporary upload slot; photos land on SeaweedFS keyed by a temp id; at recipe save the temp id is "promoted" to the real recipe id. Clean but lots of backend work + cleanup-on-abandon logic.
2. **Save-first-then-upload (client-orchestrated)**: keep the file objects in browser state during create; on successful create, read the new `recipeId` from the response and fire the existing `useUploadRecipePhoto` for each file sequentially. Zero backend change.
3. **Pre-create on first photo-add**: silently POST a draft recipe when the user drops the first photo, then continue editing. Confusing for the user if they abandon (phantom drafts in their group).

**Adopted: Option 2 (save-first-then-upload).** Simplest, no DB schema or backend endpoints, zero cleanup-job burden. Failure mode is graceful: if photo uploads fail after successful recipe create, the recipe exists (correct outcome — the user's writing isn't lost), photos can be retried from the detail page, and the form surfaces an inline error with a clear message.

## Scope

### 1. Hoist the photo-upload surface into create-mode

Replace the current three-placeholder block in `RecipeFormPage.tsx` around lines 398–415 with a new `<PhotoStageGrid>` component (or extend `PhotoUploadGrid` with a new `mode="staged"` prop — decide based on minimising branching complexity).

Behaviour of the staged grid:
- Same visual shell as `PhotoUploadGrid` (3 slots, drop-zone, dashed tiles).
- Accepts file drops + file-picker picks.
- Instead of calling `useUploadRecipePhoto` (which needs a recipeId), stores the selected `File` objects in local state and shows a client-side preview via `URL.createObjectURL`.
- Same MIME-type + max-photos + max-size guards as the existing grid.
- X-remove simply pops the file from local state.
- Tests: cover add/remove, limit, MIME-reject.

### 2. Hook the staged files into submit

In `RecipeFormPage.tsx` `handleSubmit`:
- After `createRecipe` resolves with a `{ id }` response, iterate the staged files sequentially (`await`, not `Promise.all`, so a single 413 from one doesn't ruin the next).
- Call `uploadRecipePhoto(id, file)` — reuse the same low-level API path that `useUploadRecipePhoto` uses; extract it into a pure `uploadRecipePhoto` function in `recipePhotoApi.ts` so both the hook and the form submit can share it.
- If a photo upload fails, capture the first failure message, continue attempting the remaining files (so partial success is maximised), then surface: "Rezept gespeichert, aber X von Y Fotos konnten nicht hochgeladen werden: [first error]. Du kannst sie auf der Rezept-Seite nachtragen."
- If all succeed: navigate to the detail page as today.
- If all fail: **deviation (2026-04-18, documented by reviewer fix-pass):** the plan's original "still navigate" was pragmatic-but-worse UX. Impl keeps the user on the form regardless of partial-vs-total failure so the banner is actually readable. Detail-page retry path is still mentioned in the banner text and one click reachable via the page's back-nav. Accepted: stay on form for any `failures.length > 0`, test covers both the partial and the total cases.

### 3. Submit-button state during the upload phase

- The submit button label stays "Speichern" pre-submit.
- After the recipe-create network call starts, it becomes disabled + shows a spinner with text "Speichern…"
- After create succeeds + photos begin uploading, it shows "Fotos hochladen…"
- Once everything completes, navigate away (button becomes irrelevant).
- No way for the user to cancel the photo-upload phase for v1 (keep it simple; the data is already saved).

### 4. Shared helper: `uploadRecipePhoto(recipeId, file)`

Currently `useUploadRecipePhoto` owns the POST logic. Extract it to `recipePhotoApi.ts`:

```ts
export async function uploadRecipePhoto(recipeId: string, file: File): Promise<{ photoUrl: string }>
```

Refactor `useUploadRecipePhoto` to wrap the new helper. No behaviour change for the existing edit path. Tests for the helper with MSW.

### 5. Tests

Web tests:
- `PhotoStageGrid.test.tsx` (or `PhotoUploadGrid.test.tsx` extensions if that's the chosen path): staged file add/remove/limit/mime-reject.
- `recipePhotoApi.test.ts`: new helper, happy + 413 + 5xx paths.
- `RecipeFormPage.test.tsx` additions:
  - User drops a photo in create mode → stays staged (no network call yet).
  - User submits → recipe POST fires → then one photo upload fires → then navigation.
  - User submits with 2 photos, second fails → recipe saved, navigates, error banner mentions partial failure.
  - User submits with 0 photos → no upload calls, straight navigation (same as today).

No backend changes, no shared DTO changes.

## Non-goals

- No progress bar per photo. Spinner + text suffice for v1.
- No client-side image compression / resize. The existing backend check handles oversize.
- No drag-reorder of staged photos. They stage in the order they're added.
- No temp-storage backend path.
- No retry button inside the form if upload fails — user retries from detail page.

## Acceptance criteria

- All 474 .NET / 533 web / 32 shared tests stay green + new UX1-PU tests (~8–12 new web tests).
- `pnpm test`, `pnpm build`, `pnpm lint` clean. `dotnet test` unchanged.
- From the recipe form in create mode: drag-drop a photo → preview appears → submit → recipe saved with photo visible on detail page. All within one screen, zero back-navigation.
- If a photo upload fails after a successful recipe save, recipe exists, error clearly mentions partial failure, user lands on detail page.

## Anti-shortcut reminders

- TDD per behaviour change. Test-commit before feat/fix-commit.
- Do not swallow photo-upload errors silently — user must see the partial-failure message.
- Do not leak `URL.createObjectURL` refs — revoke them on unmount / remove.
- Do not fire photo uploads in parallel (`Promise.all`) — sequential so a single transient failure doesn't cascade.
- Do not introduce a new DTO shape on the backend.

## Dispatch notes

**Impl agent:**
- Read `RecipeFormPage.tsx` lines 380–420 (photo section), `PhotoUploadGrid.tsx`, `hooks.ts` for the existing upload mutation.
- Decide upfront: extend `PhotoUploadGrid` with a `mode` prop, OR introduce a new `PhotoStageGrid`. Justify in the first commit message.
- Extract `uploadRecipePhoto` helper first (backend API call); refactor the hook; then do the staged grid; then wire into submit.
- Commit per step, each with TDD pair.

**Reviewer:**
- Verify TDD order via git log.
- Confirm no backend changes (`git diff <base>..HEAD -- apps/api` empty).
- Check `URL.createObjectURL` revokes.
- Read the submit-handler for the sequential (not parallel) upload + error accumulation.
- Run all four gates.
