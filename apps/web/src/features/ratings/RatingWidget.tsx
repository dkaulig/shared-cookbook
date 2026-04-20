import { useState } from 'react'
import type { FormEvent } from 'react'
import { Star } from 'lucide-react'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useDeleteRating, useRatings, useUpsertRating } from './hooks'

/**
 * DS5 rating card (restyled from the S4 functional widget). Retinted
 * for DS8 Sage Modern:
 *
 *   - Display `font-serif` "Deine Bewertung" headline + muted sub-line
 *   - Aggregate star pill in the top-right (Star + 4,8)
 *   - 5-star picker with 28 px icons
 *   - Textarea with sage focus ring (via the --primary token)
 *   - Ghost "Löschen" + primary "Speichern" footer buttons
 *
 * Behavioural contract (preserved verbatim from the S4 tests):
 *   - Starts on 1..5 toggle; clicking the same star keeps the value.
 *   - Submit upserts (create-or-update) with the selected stars + comment.
 *   - Delete removes the current user's rating (idempotent server-side).
 */
export function RatingWidget({ recipeId }: { recipeId: string }) {
  const ratings = useRatings(recipeId)
  const aggregate = ratings.data?.aggregate

  if (ratings.isLoading || !aggregate) {
    return (
      <div className="rounded-[18px] border border-border bg-card px-5 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
        <header className="flex items-baseline justify-between gap-3">
          <h3 className="font-serif text-[20px] font-semibold leading-tight text-foreground">
            Deine Bewertung
          </h3>
          <span className="text-[13px] text-[hsl(var(--muted-foreground))]">Lade …</span>
        </header>
      </div>
    )
  }

  // Keyed so the inner form re-mounts whenever the caller's own rating
  // changes — simpler than an effect-driven sync, and avoids the
  // "setState-in-effect" anti-pattern.
  return (
    <RatingForm
      key={`${aggregate.myStars ?? 'none'}|${aggregate.myComment ?? ''}`}
      recipeId={recipeId}
      initialStars={aggregate.myStars ?? 0}
      initialComment={aggregate.myComment ?? ''}
      aggregateAvg={aggregate.avg}
      aggregateCount={aggregate.count}
      hasRated={aggregate.myStars != null}
    />
  )
}

function RatingForm({
  recipeId,
  initialStars,
  initialComment,
  aggregateAvg,
  aggregateCount,
  hasRated,
}: {
  recipeId: string
  initialStars: number
  initialComment: string
  aggregateAvg: number | null
  aggregateCount: number
  hasRated: boolean
}) {
  const upsert = useUpsertRating(recipeId)
  const deleteMutation = useDeleteRating(recipeId)
  const [stars, setStars] = useState<number>(initialStars)
  const [comment, setComment] = useState<string>(initialComment)
  const [error, setError] = useState<string | null>(null)

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

  const countSuffix = aggregateCount === 1 ? 'Person' : 'Personen'

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[18px] border border-border bg-card px-5 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
      noValidate
    >
      <header className="mb-3.5 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-serif text-[20px] font-semibold leading-tight text-foreground">
            Deine Bewertung
          </h3>
          {aggregateCount > 0 ? (
            <p className="text-[12.5px] text-[hsl(var(--muted-foreground))]">
              Wie war's? {aggregateCount} {countSuffix} aus der Familie haben schon bewertet.
            </p>
          ) : (
            <p className="text-[12.5px] text-[hsl(var(--muted-foreground))]">
              Noch keine Bewertung. Sei die erste Person mit einem Eindruck.
            </p>
          )}
        </div>
        {aggregateCount > 0 && aggregateAvg != null && (
          <span className="flex items-baseline gap-1 font-bold text-[hsl(var(--star,var(--primary)))] [font-variant-numeric:tabular-nums]">
            <Star className="h-[18px] w-[18px] fill-current" aria-hidden="true" />
            <span className="text-[22px]">{formatAvg(aggregateAvg)}</span>
            <span className="text-[13px] font-medium text-[hsl(var(--muted-foreground))]">
              ({aggregateCount})
            </span>
          </span>
        )}
      </header>

      <div className="mb-3 flex gap-1" role="group" aria-label="Sterne-Auswahl">
        {[1, 2, 3, 4, 5].map((value) => {
          const active = stars >= value
          return (
            <button
              key={value}
              type="button"
              onClick={() => setStars(value)}
              aria-pressed={stars === value}
              aria-label={`${value} Sterne`}
              className={cn(
                'p-1 transition-colors active:scale-[1.15]',
                active
                  ? 'text-[hsl(var(--star,var(--primary)))]'
                  : 'text-[hsl(var(--input))] hover:text-[hsl(var(--star,var(--primary)))]',
              )}
            >
              <Star className="h-7 w-7 fill-current" aria-hidden="true" />
            </button>
          )
        })}
      </div>

      <Label htmlFor="rating-comment" className="sr-only">
        Kommentar
      </Label>
      <textarea
        id="rating-comment"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={2000}
        placeholder="Optional: Notiz für beim nächsten Mal — was hat besonders gut geklappt?"
        className={cn(
          'w-full min-h-[64px] resize-y rounded-[10px] border border-[hsl(var(--input))] bg-background px-3 py-2.5',
          'text-base leading-[1.5] text-foreground',
          'focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-4 focus:ring-[hsl(var(--primary)/0.25)]',
        )}
      />

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-[10px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-[13px] text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          {error}
        </p>
      )}

      <footer className="mt-2.5 flex items-center justify-end gap-2">
        {hasRated && (
          <Button
            type="button"
            variant="ghost"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            Löschen
          </Button>
        )}
        <Button type="submit" disabled={upsert.isPending || stars < 1}>
          {upsert.isPending ? 'Speichern…' : 'Speichern'}
        </Button>
      </footer>
    </form>
  )
}

function formatAvg(avg: number | null): string {
  if (avg == null) return '—'
  return avg.toFixed(1).replace('.', ',')
}
