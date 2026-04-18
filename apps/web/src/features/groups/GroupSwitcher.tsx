import { Link, useLocation } from 'react-router-dom'
import { useMyGroups } from './useMyGroups'

/**
 * Dropdown-ish list of the user's groups for the top navigation.
 * Highlights the active group by matching `/groups/:id` in the current
 * location. Kept as a simple focusable list until we introduce a
 * dropdown primitive; the user can tab through the links.
 */
export function GroupSwitcher() {
  const groups = useMyGroups()
  const location = useLocation()

  if (!groups.data || groups.data.length === 0) return null

  return (
    <nav aria-label="Gruppen wechseln" className="flex flex-wrap gap-2">
      {groups.data.map((group) => {
        const active = location.pathname === `/groups/${group.id}`
        return (
          <Link
            key={group.id}
            to={`/groups/${group.id}`}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1 text-sm ring-1 ring-border transition ${
              active ? 'bg-secondary text-secondary-foreground' : 'bg-background text-stone-700 hover:bg-muted'
            }`}
          >
            {group.name}
          </Link>
        )
      })}
    </nav>
  )
}
