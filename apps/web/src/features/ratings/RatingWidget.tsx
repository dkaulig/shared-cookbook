import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useDeleteRating, useRatings, useUpsertRating } from './hooks'

/**
 * Star + comment widget shown on the recipe detail page. Displays the
 * group-wide aggregate (avg + count) plus the current user's own entry
 * with edit/delete affordances. German labels per PRD §4.8 / §4.3.
 *
 * Semantics:
 *  - Stars are a 1..5 toggle group. Clicking the same star keeps the
 *    value; clicking a different star replaces it.
 *  - Submit upserts (create-or-update) with the selected stars + comment.
 *  - Delete removes the current user's rating (idempotent server-side).
 */
export function RatingWidget({ recipeId }: { recipeId: string }) {
  const ratings = useRatings(recipeId)
  const upsert = useUpsertRating(recipeId)
  const deleteMutation = useDeleteRating(recipeId)

  const aggregate = ratings.data?.aggregate
  const [stars, setStars] = useState<number>(0)
  const [comment, setComment] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // Initialise form state from the server response once loaded, so the
  // user sees their existing rating without re-typing.
  useEffect(() => {
    if (!aggregate) return
    setStars(aggregate.myStars ?? 0)
    setComment(aggregate.myComment ?? '')
  }, [aggregate?.myStars, aggregate?.myComment])

  const hasRated = (aggregate?.myStars ?? null) != null

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (stars < 1 || stars > 5) {
      setError('Bitte wähle zwischen 1 und 5 Sternen.')
      return
    }
    try {
      await upsert.mutateAsync({
        stars,
        comment: comment.trim() === '' ? undefined : comment.trim(),
      })
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Bewertung konnte nicht gespeichert werden.')
    }
  }

  async function handleDelete() {
    setError(null)
    try {
      await deleteMutation.mutateAsync()
      setStars(0)
      setComment('')
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Bewertung konnte nicht gelöscht werden.')
    }
  }

  return (
    <section className="space-y-3 rounded-md bg-background p-4 ring-1 ring-border">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-900">Bewertungen</h2>
        {ratings.isLoading ? (
          <span className="text-sm text-stone-500">Lade …</span>
        ) : aggregate && aggregate.count > 0 ? (
          <p className="text-sm text-stone-700">
            Ø <span className="font-semibold">{formatAvg(aggregate.avg)}</span>{' '}
            ({aggregate.count} {aggregate.count === 1 ? 'Bewertung' : 'Bewertungen'})
          </p>
        ) : (
          <p className="text-sm text-stone-500">Noch keine Bewertung.</p>
        )}
      </header>

      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div className="space-y-1.5">
          <Label>Deine Bewertung</Label>
          <div className="flex gap-1" role="group" aria-label="Sterne-Auswahl">
            {[1, 2, 3, 4, 5].map((value) => {
              const active = stars >= value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStars(value)}
                  aria-pressed={stars === value}
                  aria-label={`${value} Sterne`}
                  className={
                    'text-2xl leading-none transition-transform hover:scale-110 ' +
                    (active ? 'text-amber-500' : 'text-stone-300')
                  }
                >
                  ★
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rating-comment">Kommentar (optional)</Label>
          <textarea
            id="rating-comment"
            className="min-h-[70px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          {hasRated && (
            <Button type="button" variant="ghost" onClick={handleDelete} disabled={deleteMutation.isPending}>
              Löschen
            </Button>
          )}
          <Button type="submit" disabled={upsert.isPending || stars < 1}>
            {upsert.isPending ? 'Speichern…' : 'Speichern'}
          </Button>
        </div>
      </form>
    </section>
  )
}

function formatAvg(avg: number | null): string {
  if (avg == null) return '—'
  return avg.toFixed(1).replace('.', ',')
}
