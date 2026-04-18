# AP1 — User-Profil (Passwort + Displayname ändern)

**Slice:** AP1
**Status:** planned
**Date:** 2026-04-18
**Depends on:** BF1 (landed).

## Why

After BF1 shipped, the only missing piece on the profile surface is self-service account management. Users currently cannot:
1. Change their password (they can only request a reset email — unnecessary friction for a logged-in user).
2. Change their displayname (shown in the revision history, next to chip greetings, in invite emails).

The existing `ProfilStub.tsx` literally says "Passwort-Änderung … kommen in Phase 3". This slice removes that promise and wires both up.

## Scope

### Backend — new endpoints under `/api/account/*`

New file: `apps/api/src/FamilienKochbuch.Api/Endpoints/AccountEndpoints.cs` (mirrors `AuthEndpoints.cs` style). All endpoints `RequireAuthorization()` — these are self-service for the current user only, no admin targeting another user.

#### 1. `POST /api/account/change-password`

Request body:
```json
{
  "currentPassword": "...",
  "newPassword": "...",
  "newPasswordConfirm": "..."
}
```

Validation:
- `currentPassword`: non-empty.
- `newPassword`: non-empty, matches the existing ASP.NET Identity password policy (already configured in `Program.cs`). Must differ from `currentPassword`.
- `newPasswordConfirm`: must equal `newPassword`.

Response: `204 No Content` on success. `400 Bad Request` with `{ "error": "...", "code": "..." }` on validation failure. `401` if the `currentPassword` check fails.

Implementation: call `UserManager<ApplicationUser>.ChangePasswordAsync(user, current, new)`. Log failure reasons (without leaking the password itself).

**Side-effects:** the JWT access token continues working until it expires naturally (do NOT revoke — that would force an immediate re-login which is annoying). Refresh tokens are NOT revoked either; the user implicitly stays logged in on the current device.

#### 2. `PATCH /api/account/display-name`

Request body:
```json
{ "displayName": "David" }
```

Validation:
- Trim whitespace.
- Length 2–50 after trim.
- Reject if empty after trim.

Response: `200 OK` with the updated `AuthUserDto` (so the frontend can swap in the new value without a separate fetch). `400` on validation failure.

Implementation: update `ApplicationUser.DisplayName`, `_db.SaveChangesAsync()`. Return `AuthUserDto.FromUser(user)` or equivalent mapper.

**Side-effect:** all NEW revisions from now on show the new name. OLD revisions keep whatever name the user had at the time the revision was created (revision history stores `RecipeRevision.ChangedByUserId`, not a denormalised displayname — the name is joined at read time, so changing it updates past displays too). This is acceptable; users who change their name want it reflected everywhere.

#### 3. Tests (`apps/api/tests/FamilienKochbuch.Api.Tests/Endpoints/AccountEndpointsTests.cs`)

Integration tests covering:
- Change password with correct current → 204, new password works on subsequent login.
- Change password with wrong current → 401.
- Change password with mismatched confirm → 400.
- Change password with new == current → 400.
- Change displayname happy path → 200, value updated in DB, AuthUserDto reflects the new name.
- Change displayname to empty string / 1-char / 51-char → 400 each.
- Both endpoints: anonymous request → 401.

### Shared — DTO types

`packages/shared/src/types/account.ts`:
```ts
export interface ChangePasswordRequest { currentPassword: string; newPassword: string; newPasswordConfirm: string }
export interface ChangeDisplayNameRequest { displayName: string }
```

Export via the shared package barrel.

### Frontend — `ProfilStub.tsx`

Three additions (keep existing Konto / Familie erweitern / Abmelden cards):

#### A. Inline-edit for displayname

Right below the "Angemeldet als" line, add a small pencil button that toggles the name into an edit state:

- **View mode:** "Angemeldet als David. [✎]"
- **Edit mode:** single `<input>` + Save/Cancel buttons. Save calls `PATCH /api/account/display-name`.
- On success: update the `authStore` with the new user DTO, exit edit mode.
- On error: inline error message below the input.
- Validation mirrors the backend (2–50 chars after trim). Save button disabled if invalid.

#### B. "Passwort ändern" card

New `<Card>` between Konto and Familie erweitern. Three `<Input type="password">` fields:
- Aktuelles Passwort
- Neues Passwort
- Neues Passwort bestätigen

Submit button disabled until:
- all three fields non-empty
- new === confirm
- new !== current (client-side check, server re-validates)

On success: show a green confirmation ("Passwort aktualisiert.") and clear all three fields. On failure: inline error (red) with the server's message (translated if needed).

#### C. Type-safe API client

Add methods to `apps/web/src/features/auth/apiClient.ts` (or wherever account API calls belong):
- `changePassword(req: ChangePasswordRequest): Promise<void>`
- `changeDisplayName(req: ChangeDisplayNameRequest): Promise<AuthUserDto>`

#### D. Tests (`ProfilStub.test.tsx`)

Using MSW:
- Renders displayname + email from `useAuth()`.
- Click pencil → input appears with current name prefilled.
- Save with new name → PATCH called with trimmed value, authStore updated, edit mode exits.
- Save with 1-char name → submit disabled, error hint shown.
- Open password card: submit disabled until all fields + match + diff-to-current.
- Submit password happy path → POST called, success banner, fields cleared.
- Submit password wrong-current → 401 error surfaces inline.
- Submit password mismatched confirm → client-side error before the network call.

Plus an auth-api-client test file if one doesn't exist: `apiClient.test.ts` for the two new methods.

### Stub copy removal

Remove the line `Passwort-Änderung, Geräte-Verwaltung und App-Einstellungen kommen in Phase 3.` — no longer true. Replace with something neutral like "Weitere Einstellungen folgen in einer späteren Version." or delete outright.

## Non-goals (explicitly)

- No device-list, no session-management.
- No 2FA.
- No email-change endpoint (defer — more complex: needs re-verification).
- No admin-can-change-another-user endpoints (out of scope; GM1 covers group-admin actions but not account-level).
- No forced logout after password change. The user stays on the current device.

## Acceptance criteria

- All 455 web + 448 .NET + 32 shared tests stay green (plus new AP1 tests).
- `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`, `dotnet test` all clean.
- From the Profil page, a logged-in user can:
  - Edit their displayname inline and see it reflected in the TopNav avatar / greeting.
  - Change their password, stay logged in, and log in with the new password after a logout.
- Manual smoke: no console errors, no accessibility regressions on the Profil page.

## Anti-shortcut reminders

- TDD for every logic change: `test(...)` commit precedes `fix(...)` / `feat(...)` commit for the same item.
- No `expect(true).toBe(true)`, no `it.skip`, no `// TODO: later`.
- Password check must go through `UserManager.ChangePasswordAsync` — do NOT hand-hash and compare.
- Do NOT leak whether the current password was wrong vs. the user not existing; both return 401 with a generic message.
- The displayname endpoint returns the updated DTO so the frontend doesn't need a second round-trip. Don't add one "for symmetry".

## Dispatch notes

**Impl agent:**
- Work backend first (endpoints + tests), then shared types, then frontend — dependencies flow that way.
- Commit per sub-step: `test(api): …`, `feat(api): …`, `feat(shared): …`, `test(web): …`, `feat(web): …`.
- Run full `dotnet test` + `pnpm test --run` + `pnpm build` + `pnpm lint` before declaring done.
- Report any deviation from this plan with a reason.

**Reviewer agent:**
- Verify TDD ordering via `git log`.
- Run both test suites.
- Spot-read each endpoint implementation for Identity-correctness (UserManager, no hand-hashing).
- Spot-read the ProfilStub for the pencil button accessibility (aria-label, keyboard-reachable).
- Confirm no token revocation side-effect was accidentally added.

**Smoke:** after review-accept, orchestrator rebuilds web + api containers, opens localhost, clicks through the two flows, confirms no regression before handing off to user.

**Commit policy:** one commit per logical step, Co-Authored-By footer on each.
