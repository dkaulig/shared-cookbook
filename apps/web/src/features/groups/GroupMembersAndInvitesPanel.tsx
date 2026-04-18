import { useMemo, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import type { ApiError, GroupDetail, GroupMember, GroupRole } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { InviteMemberDialog } from './InviteMemberDialog'
import {
  useChangeMemberRole,
  useGroupInvites,
  useRemoveMember,
  useRevokeInvite,
} from './hooks'

/**
 * GM1 — Members & Invites panel.
 *
 * Inline (non-routed) section of `GroupDetailPage` that:
 *   - lists every member with a role badge,
 *   - lets an admin change a member's role or remove them,
 *   - protects the last remaining admin (no dropdown, no remove, info tag),
 *   - shows outstanding invites (admin-only) with a revoke control,
 *   - exposes an "Mitglied einladen" button that opens the existing
 *     `InviteMemberDialog`.
 *
 * The panel reuses existing hooks (`useChangeMemberRole`,
 * `useRemoveMember`) and the orphaned `InviteMemberDialog` rather than
 * reimplementing them — that was the main finding in the GM1 plan.
 *
 * Confirmation pattern: we use `window.confirm()` to match
 * `TagManagementPage`, which is the only other destructive surface in
 * the app today. A full shadcn modal would add friction without
 * material benefit for a two-line prompt.
 */
export function GroupMembersAndInvitesPanel({ group }: { group: GroupDetail }) {
  const isAdmin = group.myRole === 'Admin'
  const groupId = group.id
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const invitesQuery = useGroupInvites(isAdmin ? groupId : undefined)
  const changeRole = useChangeMemberRole(groupId)
  const removeMember = useRemoveMember(groupId)
  const revokeInvite = useRevokeInvite(groupId)

  // Last-admin detection — computed client-side from the member list so
  // the affordance can hide before the user even tries.
  const adminCount = useMemo(
    () => group.members.filter((m) => m.role === 'Admin').length,
    [group.members],
  )

  async function handleRoleChange(member: GroupMember, next: GroupRole) {
    if (next === member.role) return
    setActionError(null)
    try {
      await changeRole.mutateAsync({ userId: member.userId, role: next })
    } catch (err) {
      const apiErr = err as ApiError
      setActionError(apiErr.message || 'Rolle konnte nicht geändert werden.')
    }
  }

  async function handleRemove(member: GroupMember) {
    setActionError(null)
    // window.confirm matches the pattern used in TagManagementPage; no custom
    // modal framework in the app yet.
    if (!window.confirm(`${member.displayName} aus ${group.name} entfernen?`)) return
    try {
      await removeMember.mutateAsync(member.userId)
    } catch (err) {
      const apiErr = err as ApiError
      setActionError(apiErr.message || 'Mitglied konnte nicht entfernt werden.')
    }
  }

  async function handleRevoke(inviteId: string, displayName: string) {
    setActionError(null)
    if (!window.confirm(`Einladung für ${displayName} zurückziehen?`)) return
    try {
      await revokeInvite.mutateAsync(inviteId)
    } catch (err) {
      const apiErr = err as ApiError
      setActionError(apiErr.message || 'Einladung konnte nicht zurückgezogen werden.')
    }
  }

  return (
    <section
      aria-labelledby="members-and-invites-heading"
      className="rounded-[18px] border border-border/60 bg-card/60 px-5 py-5 md:px-6 md:py-6"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <h2
          id="members-and-invites-heading"
          className="font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground"
        >
          Mitglieder & Einladungen
        </h2>
        {isAdmin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowInviteDialog(true)}
          >
            <UserPlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Mitglied einladen
          </Button>
        )}
      </header>

      {actionError && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          {actionError}
        </p>
      )}

      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        Mitglieder ({group.memberCount})
      </h3>
      <ul aria-label="Mitglieder" className="divide-y divide-border/50 rounded-md bg-background ring-1 ring-border/50">
        {group.members.map((m) => {
          const isLastAdmin = adminCount === 1 && m.role === 'Admin'
          return (
            <li
              key={m.userId}
              className="flex flex-wrap items-center gap-3 px-3 py-2.5"
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-[hsl(var(--primary)/0.1)] text-sm font-semibold text-primary"
              >
                {m.displayName.trim().charAt(0).toUpperCase() || '·'}
              </span>
              <span className="flex-1 truncate text-sm font-medium text-foreground">
                {m.displayName}
              </span>

              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                  m.role === 'Admin'
                    ? 'bg-[hsl(var(--primary)/0.12)] text-primary'
                    : 'bg-muted text-[hsl(var(--muted-foreground))]',
                )}
              >
                {m.role === 'Admin' ? 'Admin' : 'Mitglied'}
              </span>

              {isAdmin && !isLastAdmin && (
                <div className="flex items-center gap-2">
                  <Select
                    aria-label={`Rolle von ${m.displayName}`}
                    value={m.role}
                    onChange={(e) =>
                      void handleRoleChange(m, e.target.value as GroupRole)
                    }
                    disabled={changeRole.isPending}
                    className="h-9 w-[130px] py-1 text-sm"
                  >
                    <option value="Admin">Admin</option>
                    <option value="Member">Mitglied</option>
                  </Select>
                  <button
                    type="button"
                    onClick={() => void handleRemove(m)}
                    disabled={removeMember.isPending}
                    aria-label={`${m.displayName} entfernen`}
                    className="grid h-9 w-9 place-items-center rounded-md text-[hsl(var(--destructive))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              )}
              {isAdmin && isLastAdmin && (
                <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                  Letzter Admin — Rolle kann nicht geändert werden.
                </span>
              )}
            </li>
          )
        })}
      </ul>

      {isAdmin && (
        <div className="mt-6">
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Offene Einladungen
          </h3>
          {invitesQuery.isLoading && (
            <div className="space-y-2" aria-label="Einladungen werden geladen">
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          )}
          {invitesQuery.isError && (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              Einladungen konnten nicht geladen werden.
            </p>
          )}
          {invitesQuery.isSuccess && invitesQuery.data.length === 0 && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-sm text-[hsl(var(--muted-foreground))]">
              Keine offenen Einladungen.
            </p>
          )}
          {invitesQuery.isSuccess && invitesQuery.data.length > 0 && (
            <ul className="divide-y divide-border/50 rounded-md bg-background ring-1 ring-border/50">
              {invitesQuery.data.map((invite) => (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-[hsl(var(--muted-foreground))]"
                  >
                    {invite.invitedUserDisplayName.trim().charAt(0).toUpperCase() || '·'}
                  </span>
                  <span className="flex-1 truncate text-sm font-medium text-foreground">
                    {invite.invitedUserDisplayName}
                  </span>
                  <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                    eingeladen am {new Date(invite.createdAt).toLocaleDateString('de-DE')}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void handleRevoke(invite.id, invite.invitedUserDisplayName)
                    }
                    disabled={revokeInvite.isPending}
                    aria-label={`Einladung für ${invite.invitedUserDisplayName} zurückziehen`}
                    className="grid h-9 w-9 place-items-center rounded-md text-[hsl(var(--destructive))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showInviteDialog && (
        <InviteMemberDialog
          groupId={groupId}
          onClose={() => setShowInviteDialog(false)}
        />
      )}
    </section>
  )
}
