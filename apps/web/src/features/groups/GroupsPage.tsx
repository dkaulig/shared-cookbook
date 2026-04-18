import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CreateGroupDialog } from './CreateGroupDialog'
import { useMyGroups } from './useMyGroups'

/**
 * /groups — overview of the signed-in user's groups. Lists Private
 * Sammlung + any additional collaborative groups as shadcn-styled cards.
 * Primary action is "+ Gruppe erstellen" which opens the create dialog.
 *
 * DS3 moved the Abmelden affordance to `/profil` (ProfilStub) and the
 * pending-invite banner to the Home page — both previously lived here
 * but were redundant once the AppLayout's TopNav + BottomNav shell
 * landed.
 */
export function GroupsPage() {
  const groups = useMyGroups()
  const [showCreate, setShowCreate] = useState(false)

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight text-stone-900">Meine Gruppen</h1>
        <Button type="button" onClick={() => setShowCreate(true)}>
          + Gruppe erstellen
        </Button>
      </header>

      {groups.isLoading && (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Gruppen werden geladen">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="h-28 w-full" />
            </li>
          ))}
        </ul>
      )}
      {groups.isError && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          Gruppen konnten nicht geladen werden.
        </p>
      )}

      {groups.isSuccess && groups.data.length === 0 && (
        <p className="text-stone-500">Du bist noch in keiner Gruppe.</p>
      )}

      {groups.isSuccess && groups.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {groups.data.map((group) => (
            <li key={group.id}>
              <Link
                to={`/groups/${group.id}`}
                className="block rounded-lg border border-border bg-background p-4 shadow-sm transition hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-lg font-semibold text-stone-900">{group.name}</h2>
                  {group.isPrivateCollection && (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                      Privat
                    </span>
                  )}
                </div>
                {group.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-stone-600">{group.description}</p>
                )}
                <p className="mt-3 text-xs text-stone-500">
                  {group.memberCount} {group.memberCount === 1 ? 'Mitglied' : 'Mitglieder'} ·{' '}
                  Rolle: {group.myRole === 'Admin' ? 'Admin' : 'Mitglied'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {showCreate && <CreateGroupDialog onClose={() => setShowCreate(false)} />}
    </main>
  )
}
