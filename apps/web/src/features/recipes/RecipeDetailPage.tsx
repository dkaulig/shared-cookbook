import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { RatingWidget } from '@/features/ratings/RatingWidget'
import { useDeleteRecipe, useRecipe } from './hooks'

const DIFFICULTY_LABEL: Record<number, string> = {
  1: 'einfach',
  2: 'mittel',
  3: 'aufwendig',
}

/**
 * /groups/:groupId/recipes/:recipeId — detail view. Renders hero photo,
 * title, description, portion placeholder (live scaling is S5),
 * ingredient list, ordered steps, tag chips, and the source-URL link if
 * present.
 */
export function RecipeDetailPage() {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const navigate = useNavigate()
  const recipeId = params.recipeId ?? ''
  const groupId = params.groupId ?? ''
  const detail = useRecipe(recipeId)
  const deleteMutation = useDeleteRecipe(groupId)

  const [portions, setPortions] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!recipeId) return <Navigate to={`/groups/${groupId}`} replace />

  if (detail.isLoading) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-stone-500">Lade Rezept …</main>
  }

  if (detail.isError || !detail.data) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          Rezept konnte nicht geladen werden.
        </p>
        <Link to={`/groups/${groupId}`} className="mt-4 inline-block text-sm underline">
          ← Zur Gruppe
        </Link>
      </main>
    )
  }

  const recipe = detail.data
  const shownPortions = portions ?? recipe.defaultServings

  async function handleDelete() {
    setError(null)
    if (!confirm('Rezept wirklich löschen?')) return
    try {
      await deleteMutation.mutateAsync(recipeId)
      navigate(`/groups/${groupId}`)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Rezept konnte nicht gelöscht werden.')
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <nav className="mb-4 text-sm text-stone-500">
        <Link to={`/groups/${groupId}`} className="underline">
          ← Zurück zur Gruppe
        </Link>
      </nav>

      {recipe.photos.length > 0 && (
        <img
          src={recipe.photos[0]}
          alt={recipe.title}
          className="mb-6 h-64 w-full rounded-md object-cover ring-1 ring-border"
        />
      )}

      <header className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-stone-900">{recipe.title}</h1>
          <p className="mt-1 text-sm text-stone-500">
            von {recipe.createdByDisplayName} · {DIFFICULTY_LABEL[recipe.difficulty]}
            {recipe.prepTimeMinutes != null && ` · ${recipe.prepTimeMinutes} Min`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => navigate(`/groups/${groupId}/recipes/${recipe.id}/edit`)}>
            Bearbeiten
          </Button>
          <Button type="button" variant="ghost" onClick={handleDelete}>
            Löschen
          </Button>
        </div>
      </header>

      {recipe.description && <p className="mb-4 text-stone-700">{recipe.description}</p>}

      {error && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}

      {recipe.tags.length > 0 && (
        <ul className="mb-6 flex flex-wrap gap-2">
          {recipe.tags.map((tag) => (
            <li
              key={tag.id}
              className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-700"
            >
              {tag.name}
            </li>
          ))}
        </ul>
      )}

      <section className="mb-8 rounded-md bg-background p-4 ring-1 ring-border">
        <h2 className="mb-3 text-lg font-semibold text-stone-900">Zutaten</h2>
        <label className="mb-3 flex items-center gap-2 text-sm text-stone-600">
          Portionen
          <input
            type="number"
            min={1}
            value={shownPortions}
            onChange={(e) => setPortions(Math.max(1, Number(e.target.value) || 1))}
            className="h-8 w-20 rounded-md border border-input bg-transparent px-2 text-sm"
          />
          <span className="text-xs text-stone-400">(Live-Skalierung kommt in Phase 1 S5)</span>
        </label>
        <ul className="divide-y">
          {recipe.ingredients.map((i) => (
            <li key={i.id ?? `${i.position}-${i.name}`} className="flex gap-3 py-2 text-sm">
              <span className="w-28 shrink-0 text-stone-700">
                {i.quantity != null ? `${i.quantity} ${i.unit}`.trim() : 'nach Geschmack'}
              </span>
              <span className="text-stone-900">
                {i.name}
                {i.note && <span className="text-stone-500"> — {i.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-8 rounded-md bg-background p-4 ring-1 ring-border">
        <h2 className="mb-3 text-lg font-semibold text-stone-900">Schritte</h2>
        <ol className="space-y-3">
          {recipe.steps.map((s, idx) => (
            <li key={s.id ?? s.position} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-900 text-xs font-semibold text-white">
                {idx + 1}
              </span>
              <p className="whitespace-pre-wrap text-sm text-stone-900">{s.content}</p>
            </li>
          ))}
        </ol>
      </section>

      {recipe.sourceUrl && (
        <p className="mb-4 text-sm">
          <a
            href={recipe.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-700 underline"
          >
            Zur Original-Quelle ↗
          </a>
        </p>
      )}

      <RatingWidget recipeId={recipe.id} />
    </main>
  )
}
