# P2-7 — Web UI: URL Import Flow

**Slice:** P2-7
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-6 (bridge endpoints) + existing DS6 `RecipeFormPage` (prefill target).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

First user-facing AI path. Turn a URL into an editable recipe in one screen transition.

## Scope

### 1. Entry points

- "+ Rezept aus Video importieren" button — added to:
  - `HomePage.tsx` next to "+ Neue Gruppe" (or as a secondary action on the hero chip row)
  - `GroupDetailPage.tsx` next to the existing "+ Rezept anlegen" FAB
- Opens a modal or inline route. Decision: **new route `/rezepte/import/url`** — bookmarkable, survives refresh, can be linked from external notifications.

### 2. `/rezepte/import/url` route

Form:
- URL input (single-line, autofocus, placeholder "https://…")
- Optional group picker if the user has > 1 group (reuse `GroupPickerDialog` from BF1)
- Submit button "Rezept importieren"

On submit: `POST /api/recipes/import/url` → receive `{ importId }` → navigate to `/rezepte/import/{importId}`.

### 3. Progress screen `/rezepte/import/:importId`

- Polls `GET /api/imports/:importId` every 2s via TanStack Query `refetchInterval`.
- Shows progress bar (0–100) + current step label based on `progress` value:
  - 0–30: "Video wird geladen …"
  - 30–60: "Transkribieren …"
  - 60–90: "Rezept strukturieren …"
  - 90–100: "Abschluss …"
- Cancel button: does NOT abort the backend job (Hangfire keeps running) but navigates away. User can come back via `/rezepte/import/:importId`.
- On `Status=Done`: navigate to `/groups/:groupId/recipes/new?importId=…`. `RecipeFormPage` in create mode reads the `importId`, fetches the result, and prefills.
- On `Status=Error`: show the error message + "Manuell anlegen" link to `/groups/:groupId/recipes/new`.

### 4. `RecipeFormPage` prefill hook

When `searchParams.get('importId')` is present in create mode:
- Fetch the `RecipeImport.ResultJson`.
- Map its shape into the form's initial state (title, description, servings, ingredients[], steps[], tags[]).
- Ingredients with `confidence="missing"` get an additional yellow "Menge fehlt"-badge + row highlight.
- The source URL gets stored as the recipe's `sourceUrl` on save.
- A banner at the top: "AI-Vorschlag aus <url>. Bitte durchsehen, bevor du speicherst." with an option to discard and start blank.

### 5. New hook + API client

- `useImportFromUrl()` mutation → POST to `/api/recipes/import/url`.
- `useImport(importId)` query with `refetchInterval: 2000` → GET status.
- `fetchImportResult(importId)` → GET status (one-shot) used inside the form prefill.

### 6. Shared types

`packages/shared/src/types/imports.ts`:

```ts
export type ImportStatus = 'queued' | 'running' | 'done' | 'error'
export interface RecipeImportDto {
  id: string
  status: ImportStatus
  progress: number
  resultJson: ExtractedRecipe | null  // shape from P2-2/P2-3
  errorMessage: string | null
  sourceUrl: string | null
  createdAt: string
  completedAt: string | null
}
```

Matching the .NET DTO.

### 7. Tests

Web:
- `ImportUrlPage.test.tsx`: form submits → mutation called → navigates to progress page.
- `ImportProgressPage.test.tsx`: polls status, shows progress bar, navigates on Done, shows error on Error.
- `RecipeFormPage.test.tsx` additions: `importId` search param prefills the form, missing-quantity badges render.

## Non-goals

- No cancel-import-backend (Hangfire keeps running; UX accepts this).
- No offline recovery flow (if user closes tab during extraction, comes back, they have to go to the correct URL or find it via history — future polish).
- No in-progress edit (user must wait for extraction to complete before reviewing).
- No multi-URL batch import.

## Acceptance criteria

- Web tests green + new tests.
- `pnpm build` clean.
- Manual smoke: paste a YouTube short URL → progress screen shows movement → lands on prefilled form → save → recipe on detail page.

## Anti-shortcut reminders

- TDD every page + hook.
- The progress polling must stop when `Status=Done` or `Status=Error` (don't keep polling forever).
- Don't hard-code the progress labels at specific % values without fuzz: `progress >= 30` not `progress === 30`.
- Missing-quantity badges use a token-level accent (not a hard-coded color hex).
- The "AI-Vorschlag"-banner is dismissible but dismissal doesn't lose the prefilled data — just removes the banner.

## Dispatch notes

**Impl agent:**
- Read P2-6 shapes + ExtractionResult shape in P2-2 before writing the form prefill mapper.
- Work order: shared types → API client + hook → ImportUrlPage → ImportProgressPage → RecipeFormPage prefill → integration tests.

**Reviewer:**
- Confirm polling stops on Done/Error.
- Confirm missing-quantity badges render.
- Confirm source URL is persisted when user saves.
