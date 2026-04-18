# GM1 — Group Management (Rename + Invites + Members)

**Slice:** GM1
**Status:** planned
**Date:** 2026-04-18
**Depends on:** BF1 + AP1 (both landed).

## Why

User reported that a group admin has no way to:
1. Rename a group
2. See / revoke outstanding invite links
3. Manage members (change role, remove)

Surprise finding during planning: most of the **backend + hooks already exist** — `EditGroupDialog` and `InviteMemberDialog` are fully built and tested but never wired into `GroupDetailPage`. `useGroupMembers`, `useChangeMemberRole`, `useRemoveMember` all exist. The actual work is three narrow increments:

- **UI integration** of the orphaned dialogs
- **New Members-panel UI** (hooks exist, UI doesn't)
- **New Invites endpoint + panel** (no way to list outgoing invites exists today)

## Scope

### 1. Backend — single new endpoint

`GET /api/groups/{id}/invites` → list all UNconsumed, non-expired invite links for a group, admin-only.

File: `apps/api/src/FamilienKochbuch.Api/Endpoints/GroupEndpoints.cs` — add next to the existing `CreateGroupInviteAsync`.

Response DTO (reuse existing `GroupInviteDto` if one exists; otherwise add a minimal one):
```json
[
  { "id": "...", "invitedEmail": "david@...", "createdAt": "...", "expiresAt": "...", "consumedAt": null }
]
```

Admin-only: if the caller's membership role is `Member`, return `403`.

Reuse `DELETE /api/invites/{id}` (exists in `InviteEndpoints.cs`) for revoke. Confirm it's properly admin-scoped on read.

Integration tests in `GroupEndpointsTests.cs`:
- Admin lists invites → 200 with all outstanding invites for the group
- Member lists invites → 403
- Anonymous → 401
- Consumed/expired invites are filtered out
- Revoke flow still works end-to-end (sanity)

### 2. Shared types

If `GroupInviteDto` doesn't already exist in `packages/shared/src/types/`, add it. Check first — don't duplicate.

### 3. Frontend — wire existing dialogs into GroupDetailPage

`GroupDetailHeader.tsx` is currently 151 lines and has no admin actions. Add:

- **"Gruppe bearbeiten" button** (admin-only, pencil icon next to the group name) → opens `EditGroupDialog`
- **"Mitglieder & Einladungen" button** (visible to all; admin vs. member determines the panel's affordances) → navigates to / opens a new `GroupMembersAndInvitesPanel`

Keep the existing group metadata (name, avatar, description, cover image) unchanged. The buttons sit in a small row below the group name, right-aligned.

### 4. Frontend — `GroupMembersAndInvitesPanel`

New component `apps/web/src/features/groups/GroupMembersAndInvitesPanel.tsx`. Shown as either:
- Inline expandable section on `GroupDetailPage` (simpler, one navigation), OR
- A separate route `/groups/:id/mitglieder`

**Decision rule:** inline expandable section. Fewer routes, less navigation friction, matches mobile-first UX. If it gets too tall, we can split later.

Content:

#### Members list
- Each row: avatar initial + displayname + role badge (`Admin` or `Mitglied`) + (admin-only) role dropdown + (admin-only) remove button.
- Role dropdown: "Mitglied" ↔ "Admin".
- Remove button: opens confirmation ("Max aus Familie Kaulig entfernen?") → calls `useRemoveMember`.
- Safety: if the member is the **last admin**, hide the role dropdown + hide the remove button and show a small ℹ️ "Letzter Admin — Rolle kann nicht geändert werden."
- Loading state: skeleton rows.
- Empty state: impossible for a member to see (they're in it), but handle gracefully just in case.

#### Invites list (admin-only — hidden for members)
- Each row: invited email + created-at + "Läuft ab in X Tagen" + revoke (trash icon) button.
- Revoke click → confirmation modal → calls `useRevokeInvite` (new hook).
- Empty state: "Keine offenen Einladungen."
- Loading state: skeleton rows.

#### Add-member button (admin-only)
- Opens `InviteMemberDialog` (already exists).
- On success, invalidates both `useGroupInvites` and `useGroupMembers` caches.

### 5. New hooks

`apps/web/src/features/groups/hooks.ts`:
- `useGroupInvites(groupId: string | undefined)` — fetches `GET /api/groups/{id}/invites`.
- `useRevokeInvite(groupId: string)` — mutation wrapping `DELETE /api/invites/{id}`, invalidates `useGroupInvites(groupId)`.

Both follow the existing TanStack-Query patterns in the same file.

### 6. Tests

**Web:**
- `GroupMembersAndInvitesPanel.test.tsx` — covers: members list renders, role badges correct, admin sees role dropdown + remove, member does not, last admin has dropdown/remove hidden, invite list visible for admin only, revoke flow opens confirmation + calls mutation, add-member button opens dialog.
- `GroupDetailHeader.test.tsx` — updated: admin sees "Gruppe bearbeiten" button (opens EditGroupDialog), member does not.
- `hooks.test.tsx` — new tests for `useGroupInvites` + `useRevokeInvite`.

**.NET:**
- `GroupEndpointsTests.cs` — the new `GET /{id}/invites` tests listed above.

## Non-goals (explicitly)

- No ability to transfer group ownership / demote the last admin while there's only one. (UI hides the affordance.)
- No bulk operations (remove many at once, bulk-revoke). Each action is per-row.
- No audit log of who-did-what-when. Revision history already exists for recipes; member-management history is out of scope.
- No email notification to the removed member. The invite-revoke email is handled by backend if the existing invite system sends one; don't add new email flows.

## Acceptance criteria

- All 473 web + 463 .NET + 32 shared tests stay green (plus new GM1 tests).
- `pnpm test`, `pnpm build`, `pnpm lint`, `dotnet test` all clean.
- From a group detail page, an admin can:
  - Click "Gruppe bearbeiten" → rename the group → see new name reflected.
  - See the members list with role badges.
  - Change a member's role → see badge update.
  - Remove a member (with confirmation) → see them disappear from the list.
  - See outstanding invite links with expiry info.
  - Revoke an invite link (with confirmation) → see it disappear.
  - Add a new member via the existing invite dialog.
- A regular member sees the same metadata but NO admin affordances (no edit button, no role dropdown, no remove, no invite list, no add-member button).
- Last-admin protection is enforced in the UI (affordances hidden) AND on the backend (endpoints already enforce it — sanity-check with a test).

## Anti-shortcut reminders

- TDD every logic change. Test-commit precedes feat/fix-commit.
- No hollow `expect(true).toBe(true)` or `Assert.True(true)`.
- No `it.skip` / `[Fact(Skip)]` without a tracked reason.
- Do NOT re-implement existing hooks (`useUpdateGroup`, `useChangeMemberRole`, `useRemoveMember`, `useInviteToGroup`) — wire the existing ones.
- Do NOT skip last-admin protection UI just because the backend enforces it; both layers must protect.
- Last-admin detection must use `.filter(m => m.role === 'Admin').length === 1 && m.role === 'Admin'` (or equivalent) — don't just check `group.memberCount === 1`.

## Dispatch notes

**Impl agent:**
- Read all existing dialogs (`EditGroupDialog`, `InviteMemberDialog`) and existing hooks before writing new code. Reuse everything possible.
- Work order:
  1. Backend: `GET /{id}/invites` endpoint + tests.
  2. Shared types if needed.
  3. New hooks (`useGroupInvites`, `useRevokeInvite`) + tests.
  4. `GroupMembersAndInvitesPanel` + tests.
  5. Wire into `GroupDetailHeader` + `GroupDetailPage`.
- Run `dotnet test && pnpm test --run && pnpm build && pnpm lint` after each chunk.
- Commit per step, Co-Authored-By footer.

**Reviewer agent:**
- Verify TDD order.
- Check last-admin protection is enforced in both layers.
- Confirm `EditGroupDialog` and `InviteMemberDialog` are REUSED (not duplicated).
- Read `GroupMembersAndInvitesPanel` for accessibility (dropdown keyboard-nav, confirmation modals have focus-trap).
- Run all four gates.

**Smoke:** orchestrator rebuilds web + api containers, opens localhost, confirms admin can rename + manage members + revoke invites, member cannot see admin affordances.
