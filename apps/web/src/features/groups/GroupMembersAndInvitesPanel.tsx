import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, UserPlus } from 'lucide-react'
import type { GroupDetail, GroupMember, GroupRole } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { useConfirmDialog } from '@/features/_shared/ConfirmDialog'
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
 * Confirmation pattern: BUG-004 moved this panel's two destructive
 * actions (member-remove + invite-revoke) from `window.confirm()` to
 * the shared `useConfirmDialog()` hook so they match the app-wide
 * shadcn modal aesthetic.
 */
export function GroupMembersAndInvitesPanel({ group }: { group: GroupDetail }) {
  const { t } = useTranslation()
  const isAdmin = group.myRole === 'Admin'
  const groupId = group.id
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const { confirm, ConfirmDialogElement } = useConfirmDialog()

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
      // REL-3f — localise via errors.json codes + drop 5xx leaks.
      setActionError(classifyMutationError(err).message)
    }
  }

  async function handleRemove(member: GroupMember) {
    setActionError(null)
    // BUG-004 — async-confirm through the shared shadcn-style dialog.
    const ok = await confirm({
      title: t('groups.members.removeTitle'),
      description: t('groups.members.removeDescriptionTemplate', {
        name: member.displayName,
        group: group.name,
      }),
      confirmLabel: t('groups.members.removeConfirm'),
    })
    if (!ok) return
    try {
      await removeMember.mutateAsync(member.userId)
    } catch (err) {
      setActionError(classifyMutationError(err).message)
    }
  }

  async function handleRevoke(inviteId: string, displayName: string) {
    setActionError(null)
    const ok = await confirm({
      title: t('groups.members.revokeTitle'),
      description: t('groups.members.revokeDescriptionTemplate', {
        name: displayName,
      }),
      confirmLabel: t('groups.members.revokeConfirm'),
    })
    if (!ok) return
    try {
      await revokeInvite.mutateAsync(inviteId)
    } catch (err) {
      setActionError(classifyMutationError(err).message)
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
          {t('groups.members.heading')}
        </h2>
        {isAdmin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowInviteDialog(true)}
          >
            <UserPlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('groups.members.inviteCta')}
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
        {t('groups.members.membersCountTemplate', { count: group.memberCount })}
      </h3>
      <ul
        aria-label={t('groups.members.membersListAria')}
        className="divide-y divide-border/50 rounded-md bg-background ring-1 ring-border/50"
      >
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
                {m.role === 'Admin'
                  ? t('groups.members.roleBadgeAdmin')
                  : t('groups.members.roleBadgeMember')}
              </span>

              {isAdmin && !isLastAdmin && (
                <div className="flex items-center gap-2">
                  <Select
                    aria-label={t('groups.members.roleSelectAriaTemplate', {
                      name: m.displayName,
                    })}
                    value={m.role}
                    onChange={(e) =>
                      void handleRoleChange(m, e.target.value as GroupRole)
                    }
                    disabled={changeRole.isPending}
                    className="h-9 w-[130px] py-1 text-sm"
                  >
                    <option value="Admin">
                      {t('groups.members.roleOptionAdmin')}
                    </option>
                    <option value="Member">
                      {t('groups.members.roleOptionMember')}
                    </option>
                  </Select>
                  <button
                    type="button"
                    onClick={() => void handleRemove(m)}
                    disabled={removeMember.isPending}
                    aria-label={t('groups.members.removeAriaTemplate', {
                      name: m.displayName,
                    })}
                    className="grid h-9 w-9 place-items-center rounded-md text-[hsl(var(--destructive))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              )}
              {isAdmin && isLastAdmin && (
                <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                  {t('groups.members.lastAdminHint')}
                </span>
              )}
            </li>
          )
        })}
      </ul>

      {isAdmin && (
        <div className="mt-6">
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            {t('groups.members.invitesHeading')}
          </h3>
          {invitesQuery.isLoading && (
            <div
              className="space-y-2"
              aria-label={t('groups.members.invitesLoadingAria')}
            >
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          )}
          {invitesQuery.isError && (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              {t('groups.members.invitesLoadError')}
            </p>
          )}
          {invitesQuery.isSuccess && invitesQuery.data.length === 0 && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-sm text-[hsl(var(--muted-foreground))]">
              {t('groups.members.invitesEmpty')}
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
                    {t('groups.members.invitedOnTemplate', {
                      date: new Date(invite.createdAt).toLocaleDateString('de-DE'),
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void handleRevoke(invite.id, invite.invitedUserDisplayName)
                    }
                    disabled={revokeInvite.isPending}
                    aria-label={t('groups.members.revokeAriaTemplate', {
                      name: invite.invitedUserDisplayName,
                    })}
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

      {ConfirmDialogElement}
    </section>
  )
}
