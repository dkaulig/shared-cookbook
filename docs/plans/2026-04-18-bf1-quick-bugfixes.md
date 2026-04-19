# BF1 — Quick Bugfixes

**Slice:** BF1
**Status:** planned
**Date:** 2026-04-18
**Plan source:** user-reported bug list in chat 2026-04-18; items inventoried in `docs/design-implementation-progress.md` "Planned follow-ups" section.

## Why

User live-tested the app on their phone after DS7/DS8 landed and reported a batch of small bugs + missing polish. None block the core experience but all show up immediately when someone uses the app for real. Fix them in one sweep before adding new features (AP1/GM1).

## Scope — 7 items

### 1. Ingredient amount input — placeholder cut off

**Symptom:** In the recipe form ingredient rows, the "Menge"-field placeholder is truncated (user cannot see the full hint).

**Investigation hint:** Search for the ingredient row component (`IngredientRow.tsx`, `IngredientRowEditor.tsx`, or similar under `apps/web/src/features/recipes/`). Likely a `w-[…]` / `max-w-[…]` constraint on the amount `<input>` that's too narrow vs. the German placeholder ("z.B. 250 g" or similar).

**Fix:** Increase input width OR shorten the placeholder. Prefer widening because German units need the space.

**Test:** Add a snapshot/DOM assertion that the amount-input has a minimum width (Tailwind class) that fits a 10-char placeholder without overflow.

### 2. "Zuletzt geändert" shows role ("Admin") instead of displayname

**Symptom:** In the recipe revision history panel, the author of a change is labelled "Admin" (the role) instead of the user's displayname ("David" etc.).

**Investigation hint:** Search `UpdatedByName|RevisionAuthor|LastEditedBy|AuditLog` in both `apps/api` and `apps/web/src`. Likely a backend DTO projection that pulls `user.Role` instead of `user.DisplayName`, or a frontend mapping that falls back to role.

**Fix:** Correct the projection / mapping. Ensure the API returns `displayName` for the author, and the `<RecipeHistoryPanel>` renders that.

**Test:** Integration test on the endpoint that returns revision history — assert `items[].authorDisplayName` equals the user's `DisplayName`, not their role.

### 3. Umlauts rendered as `ae`/`oe`/`ue` instead of `ä`/`ö`/`ü`

**Symptom:** Some strings display `fuer` / `Suesskartoffel` / `Groesse` instead of the correct umlaut chars.

**Investigation hint:** Known hit: `apps/web/public/manifest.webmanifest` line 4 — `"Private Rezept-Sammlung fuer Familie und Freunde."`. Search both repos for `fuer|Fuer|ae[ln]|oe[rns]|ue[bcr]|oessel|aeg|uebe|uber.*[Uu]ber` — but careful, English words legitimately have these letter combos. Prefer searching for specific known misspellings: `fuer|Fuer|Suesskartoffel|Gruesse|Groesse|Schluessel|Kaese|Stueck|Kaesekuchen`. Also check `apps/api/src/**/SeedDataService.cs` for seeded recipe names.

**Fix:** Replace with proper umlaut characters. Likely pure text edits, no logic change. If a `normalize`/`slugify` helper is being accidentally applied to display strings, also audit usage sites.

**Test:** Grep-based CI assertion OR spot tests on the seeded recipe names if any are baked into tests.

### 4. Header search icon — route to groups is wrong

**Symptom:** The magnifier-icon button in `TopNav` routes to `/groups` overview, which isn't useful.

**Investigation hint:** `apps/web/src/components/layout/TopNav.tsx` — find the search button + its `onClick` / `<NavLink to=…>`.

**Fix:** Change the button to `disabled` with `aria-label="Suche (bald verfügbar)"` and a visible tooltip (`title="Suche kommt bald"`) and `cursor-not-allowed`. Keep the icon visible so the user has a hint that search is planned.

**Test:** Update the existing `TopNav.test.tsx` — assert the button renders as disabled + has the tooltip text.

### 5. Header notification bell — remove icon entirely

**Symptom:** Bell icon has no function; distracts the user.

**Investigation hint:** `apps/web/src/components/layout/TopNav.tsx` — find the bell button + badge.

**Fix:** Remove the bell button + badge entirely. Preserve the avatar + (now-disabled) search button. The icon will come back in Phase 2 when the notification backend exists.

**Test:** Update `TopNav.test.tsx` — assert no element with `aria-label="Benachrichtigungen"` (or whatever label exists today) is rendered.

### 6. Home filter chips route to a seemingly random group

**Symptom:** Clicking `Schnell` / `Warm` / `Zufall` on the Home chip row routes into "biggest group by member count" — confusing UX, user has no idea which group they'll land in.

**Investigation hint:** `apps/web/src/features/home/HomePage.tsx:58-66` — function `goToBiggestGroup(filterPreset)`.

**Decision rule for the fix:**
- If the user has exactly **one group** (their Private Collection or any single collab group): route directly to that group with the preset query. Works like today but deterministic.
- If the user has **more than one group**: open a small "In welcher Gruppe suchen?" modal listing their groups; the user picks; navigate with preset.

**Fix:** Add a new `<GroupPickerDialog>` component (or reuse `CreateGroupDialog` patterns). Rename `goToBiggestGroup` → `handlePresetChip`. Keep tests on the chip row green.

**Test:** `HomePage.test.tsx` — mock single-group user → chip click navigates directly. Mock multi-group user → chip click opens the picker. Picker click → navigates.

### 7. Signup page — missing password confirmation

**Symptom:** `SignupPage.tsx` has one password input. If the user mistypes, they're locked out of an invite.

**Investigation hint:** `apps/web/src/features/auth/SignupPage.tsx` — the `password` state + the `<Input type="password">`. Mirror the pattern already present in `apps/web/src/features/auth/ResetPasswordPage.tsx` (which does the double-entry correctly).

**Fix:** Add a second `confirmPassword` state + input labelled "Passwort bestätigen". Client-side validation: if `password !== confirmPassword`, block submit and show inline error. Keep server-side validation untouched (the API doesn't need changes).

**Test:** `SignupPage.test.tsx` — mismatched passwords → error surfaces, submit button disabled; matching passwords → form submits normally.

## Non-goals (explicitly)

- No backend schema changes unless strictly needed (#2 is the only candidate — scope it to a DTO/projection fix, not a new column).
- No Phase-2 notification infrastructure (item 5 removes the placeholder; notifications come later).
- No search backend (item 4 disables the button; real search comes later).

## Acceptance criteria

- All 446 web tests + 447 .NET tests + 32 shared tests stay green (plus new tests added per item).
- `pnpm typecheck` + `pnpm lint` clean.
- For each of the 7 items, reviewer can open the affected page and confirm the fix visually.
- Commit granularity: one logical commit per item (~7 feature commits + 1 progress-tracker commit at the end).

## Anti-shortcut reminders

- No hollow `expect(true).toBe(true)` stubs.
- No `it.skip` to avoid hard tests.
- For item 3 (umlauts): do NOT just edit the known offender — grep systematically so the sweep is complete.
- For item 6: the modal must be keyboard-accessible and respect the existing dialog patterns.
- For item 2: root-cause the projection, don't hardcode a displayname fallback.

## Dispatch notes

Impl agent should work items in any order but commit one-per-item so the reviewer can review them independently. Reviewer should spot-check each item, not just run greps.
