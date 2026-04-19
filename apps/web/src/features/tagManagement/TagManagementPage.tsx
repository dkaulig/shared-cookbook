import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import type { ApiError, TagDto } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { useGroup } from '@/features/groups/hooks'
import { useGroupTags } from '@/features/recipes/hooks'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { CreateTagDialog } from './CreateTagDialog'
import { useDeleteGroupTag } from './hooks'

/**
 * /groups/:groupId/tags — per-group tag management surface. Lists the
 * global catalog (read-only, clearly badged) and the group's own custom
 * tags, with admin-only delete buttons. Non-admin members see a German
 * explanation instead of interactive controls.
 */
export function TagManagementPage() {
  const params = useParams<{ groupId: string }>()
  const groupId = params.groupId ?? ''

  const groupQuery = useGroup(groupId)
  const tagsQuery = useGroupTags(groupId)
  const deleteMutation = useDeleteGroupTag(groupId)

  const [showDialog, setShowDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // BUG-004 — replaces the native `confirm(...)` that used to block the
  // delete flow. The pending tag is held here so the ConfirmDialog has a
  // target when the user hits "Löschen".
  const [pendingDelete, setPendingDelete] = useState<TagDto | null>(null)

  if (!groupId) return <Navigate to="/groups" replace />

  if (groupQuery.isLoading || tagsQuery.isLoading) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-stone-500">Lade …</main>
  }

  if (groupQuery.isError || !groupQuery.data || tagsQuery.isError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          Tags konnten nicht geladen werden.
        </p>
      </main>
    )
  }

  const group = groupQuery.data
  const isAdmin = group.myRole === 'Admin'
  const tags = tagsQuery.data ?? []
  const globalTags = tags.filter((t) => t.isGlobal)
  const customTags = tags.filter((t) => !t.isGlobal)

  async function handleConfirmDelete() {
    if (!pendingDelete) return
    setError(null)
    const tag = pendingDelete
    try {
      await deleteMutation.mutateAsync(tag.id)
      setPendingDelete(null)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Tag konnte nicht gelöscht werden.')
      setPendingDelete(null)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <nav className="mb-4 text-sm text-stone-500">
        <Link to={`/groups/${groupId}`} className="underline">
          ← Zur Gruppe
        </Link>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-stone-900">Tags verwalten</h1>
          <p className="mt-1 text-sm text-stone-600">{group.name}</p>
        </div>
        {isAdmin && (
          <Button type="button" onClick={() => setShowDialog(true)}>
            + Eigenen Tag erstellen
          </Button>
        )}
      </header>

      {!isAdmin && (
        <p className="mb-6 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700 ring-1 ring-stone-200">
          Nur Admins können Tags verwalten.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}

      <section className="mb-8 rounded-md bg-background p-4 ring-1 ring-border">
        <h2 className="mb-3 text-lg font-semibold text-stone-900">Eigene Tags</h2>
        {customTags.length === 0 ? (
          <p className="text-sm text-stone-500">Noch keine eigenen Tags angelegt.</p>
        ) : (
          <ul className="divide-y">
            {customTags.map((tag) => (
              <li key={tag.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-medium text-stone-900">{tag.name}</span>{' '}
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                    {tag.category}
                  </span>
                </span>
                {isAdmin && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Tag ${tag.name} löschen`}
                    onClick={() => setPendingDelete(tag)}
                    disabled={deleteMutation.isPending}
                  >
                    Löschen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md bg-background p-4 ring-1 ring-border">
        <h2 className="mb-3 text-lg font-semibold text-stone-900">Globale Tags</h2>
        <ul className="divide-y">
          {globalTags.map((tag) => (
            <li key={tag.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="font-medium text-stone-900">{tag.name}</span>{' '}
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                  {tag.category}
                </span>
              </span>
              <span className="text-xs text-stone-400">Global, nicht löschbar</span>
            </li>
          ))}
        </ul>
      </section>

      {showDialog && (
        <CreateTagDialog groupId={groupId} onClose={() => setShowDialog(false)} />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        title="Tag wirklich löschen?"
        description={
          pendingDelete
            ? `"${pendingDelete.name}" wird entfernt. Vorhandene Rezept-Verknüpfungen bleiben erhalten.`
            : ''
        }
        confirmLabel="Löschen"
        onConfirm={handleConfirmDelete}
        isLoading={deleteMutation.isPending}
      />
    </main>
  )
}
