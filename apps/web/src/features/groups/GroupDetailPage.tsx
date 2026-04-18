import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { EditGroupDialog } from './EditGroupDialog'
import { InviteMemberDialog } from './InviteMemberDialog'
import {
  useChangeMemberRole,
  useDeleteGroup,
  useGroup,
  useRemoveMember,
} from './hooks'

/**
 * /groups/:id — detail view. Renders name, description, members, and
 * admin-only controls (edit, delete, role-change, remove). Recipes list
 * is a placeholder until S3.
 */
export function GroupDetailPage() {
  const params = useParams<{ id: string }>()
  const groupId = params.id ?? ''
  const detail = useGroup(groupId)
  const changeRole = useChangeMemberRole(groupId)
  const removeMember = useRemoveMember(groupId)
  const deleteGroup = useDeleteGroup()

  const [showEdit, setShowEdit] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (!groupId) return <Navigate to="/groups" replace />

  if (detail.isLoading) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10 text-stone-500">Lade …</main>
    )
  }

  if (detail.isError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          Gruppe konnte nicht geladen werden.
        </p>
        <Link to="/groups" className="mt-4 inline-block text-sm underline">
          Zurück zu den Gruppen
        </Link>
      </main>
    )
  }

  if (!detail.isSuccess) return null

  const group = detail.data
  const isAdmin = group.myRole === 'Admin'

  async function handleDelete() {
    setActionError(null)
    try {
      await deleteGroup.mutateAsync(groupId)
    } catch (err) {
      const apiErr = err as ApiError
      setActionError(apiErr.message || 'Gruppe konnte nicht gelöscht werden.')
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <nav className="mb-4 text-sm text-stone-500">
        <Link to="/groups" className="underline">
          ← Meine Gruppen
        </Link>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-stone-900">{group.name}</h1>
          {group.description && (
            <p className="mt-2 text-stone-700">{group.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={() => setShowInvite(true)}>
            Mitglied einladen
          </Button>
          {isAdmin && !group.isPrivateCollection && (
            <>
              <Button type="button" variant="outline" onClick={() => setShowEdit(true)}>
                Bearbeiten
              </Button>
              <Button type="button" variant="ghost" onClick={handleDelete}>
                Löschen
              </Button>
            </>
          )}
        </div>
      </header>

      {actionError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {actionError}
        </p>
      )}

      <section className="mb-8 rounded-md bg-background p-4 ring-1 ring-border">
        <h2 className="mb-3 text-lg font-semibold text-stone-900">
          Mitglieder ({group.members.length})
        </h2>
        <ul className="divide-y">
          {group.members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-medium text-stone-900">{member.displayName}</span>{' '}
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                  {member.role === 'Admin' ? 'Admin' : 'Mitglied'}
                </span>
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      changeRole.mutate({
                        userId: member.userId,
                        role: member.role === 'Admin' ? 'Member' : 'Admin',
                      })
                    }
                  >
                    {member.role === 'Admin' ? 'Zu Mitglied' : 'Zu Admin'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => removeMember.mutate(member.userId)}
                  >
                    Entfernen
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">
        Rezepte erscheinen hier, sobald Phase 1 S3 fertig ist.
      </section>

      {showEdit && (
        <EditGroupDialog
          groupId={groupId}
          initialName={group.name}
          initialDescription={group.description ?? ''}
          initialDefaultServings={group.defaultServings}
          initialCoverImageUrl={group.coverImageUrl ?? ''}
          onClose={() => setShowEdit(false)}
        />
      )}

      {showInvite && (
        <InviteMemberDialog groupId={groupId} onClose={() => setShowInvite(false)} />
      )}
    </main>
  )
}
