import { useState } from 'react'
import type { TagDto } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { useGroup } from '@/features/groups/hooks'
import { useGroupTags } from '@/features/recipes/hooks'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { CreateTagDialog } from './CreateTagDialog'
import { useDeleteGroupTag } from './hooks'

/**
 * BUG-020 — reusable tag-management panel.
 *
 * Extracted from the previous `TagManagementPage` so the same CRUD UI
 * (custom-tag list with admin-only delete + global-tag list + create
 * dialog) can be embedded as the last section of `GroupSettingsPage`.
 * The route `/groups/:groupId/tags` is now a redirect into the
 * settings page (`#tags` anchor), so this panel is the single place
 * that owns the surface.
 *
 * The panel takes only `{ groupId }` and runs its own queries +
 * mutations — drop-in section, no other props required.
 */
export function GroupTagsPanel({ groupId }: { groupId: string }) {
  const groupQuery = useGroup(groupId)
  const tagsQuery = useGroupTags(groupId)
  const deleteMutation = useDeleteGroupTag(groupId)

  const [showDialog, setShowDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // BUG-004 — replaces the native `confirm(...)` that used to block the
  // delete flow. The pending tag is held here so the ConfirmDialog has a
  // target when the user hits "Löschen".
  const [pendingDelete, setPendingDelete] = useState<TagDto | null>(null)

  if (groupQuery.isLoading || tagsQuery.isLoading) {
    return <p className="text-sm text-stone-500">Lade …</p>
  }

  if (groupQuery.isError || !groupQuery.data || tagsQuery.isError) {
    return (
      <p
        role="alert"
        className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
      >
        Tags konnten nicht geladen werden.
      </p>
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
      // REL-3f — localise via errors.json + drop 5xx leaks.
      setError(classifyMutationError(err).message)
      setPendingDelete(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13px] text-[hsl(var(--muted-foreground))]">
          Eigene Tags pflegen und globale Tags ansehen.
        </p>
        {isAdmin && (
          <Button type="button" size="sm" onClick={() => setShowDialog(true)}>
            + Eigenen Tag erstellen
          </Button>
        )}
      </div>

      {!isAdmin && (
        <p className="rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700 ring-1 ring-stone-200">
          Nur Admins können Tags verwalten.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          {error}
        </p>
      )}

      <section className="rounded-md bg-background p-4 ring-1 ring-border">
        <h3 className="mb-3 text-base font-semibold text-stone-900">Eigene Tags</h3>
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
        <h3 className="mb-3 text-base font-semibold text-stone-900">Globale Tags</h3>
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
    </div>
  )
}
