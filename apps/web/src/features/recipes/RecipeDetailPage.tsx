import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import type { ApiError, RecipeDetailDto, RecipeSnapshot } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { RatingWidget } from '@/features/ratings/RatingWidget'
import { useGroup } from '@/features/groups/hooks'
import { useDeleteRecipe, useRecipe } from './hooks'
import { RecipePortionScaler } from './RecipePortionScaler'
import { ForkRecipeDialog } from './ForkRecipeDialog'
import { RecipeHistoryPanel } from './RecipeHistoryPanel'

const DIFFICULTY_LABEL: Record<number, string> = {
  1: 'einfach',
  2: 'mittel',
  3: 'aufwendig',
}

/**
 * /groups/:groupId/recipes/:recipeId — detail view. Renders hero photo,
 * title, description, live portion-scaler, ingredient list, ordered
 * steps, tag chips, and the source-URL link if present. The scaler
 * (S5) reads the owning group's `defaultServings` so the "umrechnen"
 * shortcut is wired; while the group fetch is in flight we fall back to
 * the recipe's own default to render immediately. When the recipe is a
 * fork (`forkOfRecipeId != null`) a banner links back to the original
 * (resolving to 403 if the user isn't in the origin group — acceptable
 * per PRD §4.7).
 */
export function RecipeDetailPage() {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const navigate = useNavigate()
  const recipeId = params.recipeId ?? ''
  const groupId = params.groupId ?? ''
  const detail = useRecipe(recipeId)
  const group = useGroup(groupId)
  const deleteMutation = useDeleteRecipe(groupId)

  const [error, setError] = useState<string | null>(null)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  // Computed before any conditional return so the hook order stays
  // stable across re-renders (loading → loaded → error transitions).
  const currentSnapshot = useMemo(
    () => (detail.data ? toSnapshot(detail.data) : null),
    [detail.data],
  )

  if (!recipeId) return <Navigate to={`/groups/${groupId}`} replace />

  if (detail.isLoading) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-stone-500">Lade Rezept …</main>
  }

  if (detail.isError || !detail.data || !currentSnapshot) {
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
  const groupDefaultServings = group.data?.defaultServings ?? recipe.defaultServings
  const groupName = group.data?.name ?? 'Gruppe'

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

      {recipe.forkOfRecipeId && (
        <p className="mb-4 rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700 ring-1 ring-stone-200">
          Dieses Rezept wurde aus{' '}
          <Link
            to={`/recipes/${recipe.forkOfRecipeId}`}
            className="underline"
            title="Zum Original (Zugriff hängt von Gruppenmitgliedschaft ab)"
          >
            diesem Original
          </Link>{' '}
          geforkt.
        </p>
      )}

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
          <Button type="button" variant="outline" onClick={() => setForkDialogOpen(true)}>
            In andere Gruppe kopieren
          </Button>
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
        <RecipePortionScaler
          defaultServings={recipe.defaultServings}
          groupDefaultServings={groupDefaultServings}
          groupName={groupName}
          ingredients={recipe.ingredients}
        />
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

      <RecipeHistoryPanel recipeId={recipe.id} current={currentSnapshot} />

      {forkDialogOpen && (
        <ForkRecipeDialog
          recipeId={recipe.id}
          sourceGroupId={recipe.groupId}
          onClose={() => setForkDialogOpen(false)}
        />
      )}
    </main>
  )
}

/**
 * Project a `RecipeDetailDto` onto the snapshot shape the history panel
 * + diff modal consume. Mirrors the .NET `RecipeRevisionService.RecipeSnapshot`
 * contract — keeps the comparison apples-to-apples regardless of how the
 * detail DTO evolves.
 */
function toSnapshot(recipe: RecipeDetailDto): RecipeSnapshot {
  return {
    title: recipe.title,
    description: recipe.description ?? null,
    defaultServings: recipe.defaultServings,
    prepTimeMinutes: recipe.prepTimeMinutes ?? null,
    difficulty: recipe.difficulty as 1 | 2 | 3,
    sourceUrl: recipe.sourceUrl ?? null,
    ingredients: recipe.ingredients
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        position: i.position,
        quantity: i.quantity ?? null,
        unit: i.unit,
        name: i.name,
        note: i.note ?? null,
        scalable: i.scalable,
      })),
    steps: recipe.steps
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ position: s.position, content: s.content })),
    tagIds: recipe.tags
      .map((t) => t.id)
      .slice()
      .sort(),
  }
}
