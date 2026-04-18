import { Link } from 'react-router-dom'
import { useGroupRecipes } from './hooks'

/**
 * Inline recipe list embedded on GroupDetailPage. Renders cards with the
 * first photo, title, truncated description. Empty state + error state
 * handled in German.
 */
export function RecipeList({ groupId }: { groupId: string }) {
  const list = useGroupRecipes(groupId)

  if (list.isLoading) {
    return <p className="text-sm text-stone-500">Lade Rezepte …</p>
  }

  if (list.isError) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
        Rezepte konnten nicht geladen werden.
      </p>
    )
  }

  const items = list.data?.items ?? []
  if (items.length === 0) {
    return <p className="text-sm text-stone-500">Noch keine Rezepte angelegt.</p>
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {items.map((recipe) => (
        <li key={recipe.id}>
          <Link
            to={`/groups/${groupId}/recipes/${recipe.id}`}
            className="block overflow-hidden rounded-md bg-background ring-1 ring-border transition-shadow hover:shadow-md"
          >
            {recipe.photo ? (
              <img src={recipe.photo} alt={recipe.title} className="h-36 w-full object-cover" />
            ) : (
              <div className="flex h-36 items-center justify-center bg-stone-100 text-xs text-stone-400">
                Kein Foto
              </div>
            )}
            <div className="p-3">
              <h3 className="font-semibold text-stone-900">{recipe.title}</h3>
              {recipe.description && (
                <p className="mt-1 line-clamp-2 text-sm text-stone-600">{recipe.description}</p>
              )}
              <p className="mt-2 text-xs text-stone-400">
                von {recipe.createdByDisplayName}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
