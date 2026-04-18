import { Link, useSearchParams } from 'react-router-dom'
import { useRecipeSearch } from '@/features/search/hooks'
import { readFiltersFromSearchParams } from '@/features/search/urlState'

/**
 * Inline recipe list embedded on GroupDetailPage. Drives content off
 * useRecipeSearch so any filter set by <RecipeFilterPanel /> on the same
 * page applies live. Cards show first photo, title, truncated
 * description, rating badge, and creator display name.
 */
export function RecipeList({ groupId }: { groupId: string }) {
  const [params] = useSearchParams()
  const filters = readFiltersFromSearchParams(params)
  const result = useRecipeSearch(groupId, filters)

  if (result.isLoading) {
    return <p className="text-sm text-stone-500">Lade Rezepte …</p>
  }

  if (result.isError) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
        Rezepte konnten nicht geladen werden.
      </p>
    )
  }

  const items = result.data?.items ?? []
  if (items.length === 0) {
    return <p className="text-sm text-stone-500">Keine Rezepte passen zu den aktuellen Filtern.</p>
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
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-stone-900">{recipe.title}</h3>
                {recipe.avgRating != null && recipe.ratingCount > 0 && (
                  <span className="flex items-center gap-1 text-xs text-[hsl(var(--accent))]">
                    <span className="text-sm leading-none">★</span>
                    {recipe.avgRating.toFixed(1).replace('.', ',')}
                    <span className="text-stone-400">({recipe.ratingCount})</span>
                  </span>
                )}
              </div>
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
