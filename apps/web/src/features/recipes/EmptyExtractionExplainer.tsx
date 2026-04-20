import { FileQuestion } from 'lucide-react'
import type { EmptyReason } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'

export interface EmptyExtractionExplainerProps {
  /**
   * Reason code from the Python extractor's quality gate. `null` means
   * the server didn't set one (legacy payload, odd codepath) — we fall
   * back to the same copy as `'no_recipe_detected'` because that's the
   * by-far-most-common empty-extraction case.
   */
  reason: EmptyReason | null
  /**
   * URL the user originally submitted, surfaced as a small read-only
   * chip so they know what was analysed. `null` on chat-imports / paths
   * without a URL context — the chip is omitted in that case.
   */
  sourceUrl: string | null
  /**
   * Fires when the user clicks "Trotzdem leer anlegen" — wrapper flips
   * a `proceedAnyway` state so the normal inner form renders with the
   * (mostly empty) prefill. The extractor's fallback title + any
   * auto-attached thumbnail still flow through.
   */
  onProceedEmpty: () => void
  /**
   * Fires when the user clicks "Anderes Video probieren". Wrapper
   * navigates back to `/rezepte/import` so they can paste a different
   * URL. Keeping this as a callback (rather than a hard-coded `<Link>`)
   * keeps the component route-system-agnostic for tests / storybook.
   */
  onTryAnother: () => void
}

/**
 * Reason → German body copy. Kept as a switch (not a map) so the
 * exhaustiveness check catches new reasons on the `EmptyReason` union.
 *
 * A `null` reason gets the same copy as `no_recipe_detected` because
 * that's the typical "extractor worked but the video wasn't a recipe"
 * case; we'd rather show a helpful explainer than "unbekannter Fehler".
 */
function reasonCopy(reason: EmptyReason | null): string {
  switch (reason) {
    case 'empty_transcript':
      return 'Das Video enthielt keinen verwertbaren Audio-Inhalt (nur Musik oder stumm).'
    case 'extractor_error':
      return 'Bei der Analyse ist ein Fehler aufgetreten. Versuche es erneut oder melde es als Bug.'
    case 'no_recipe_detected':
    case null:
      return (
        'Aus diesem Video konnte kein Rezept extrahiert werden. ' +
        'Möglicherweise enthält das Video kein Kochrezept, oder der ' +
        'gesprochene Inhalt reicht nicht aus, um Zutaten und Schritte ' +
        'zu erkennen.'
      )
  }
}

/**
 * BUG-034 — rendered by `RecipeFormPage` when the import's extracted
 * result was empty (no ingredients AND no steps). Replaces the silent
 * empty-form UX with a dedicated explainer + escape hatches so the
 * user can tell whether Azure said "not a recipe" vs the extractor
 * actually broke.
 *
 * Visual shell matches the rest of the form surface: rounded-[12px]
 * card, muted foreground copy, shadcn `Button` variants for the two
 * actions. No colour signals (this is an expected outcome, not an
 * error) — we only use the muted surface + the neutral icon.
 */
export function EmptyExtractionExplainer({
  reason,
  sourceUrl,
  onProceedEmpty,
  onTryAnother,
}: EmptyExtractionExplainerProps) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div
        role="region"
        aria-labelledby="empty-extraction-heading"
        className="flex flex-col items-center gap-4 rounded-[12px] border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-6 py-10 text-center"
      >
        <span
          aria-hidden="true"
          className="grid h-14 w-14 place-items-center rounded-full bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"
        >
          <FileQuestion className="h-7 w-7" strokeWidth={1.75} />
        </span>
        <h2
          id="empty-extraction-heading"
          className="text-lg font-semibold text-[hsl(var(--foreground))]"
        >
          Kein Rezept erkannt
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
          {reasonCopy(reason)}
        </p>
        {sourceUrl != null && sourceUrl !== '' && (
          <span
            className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-[hsl(var(--muted))] px-3 py-1 text-[11px] text-[hsl(var(--muted-foreground))]"
            title={sourceUrl}
          >
            <span className="shrink-0 font-medium">Analysiert:</span>
            <span className="truncate" aria-label="Analysierte Quelle">
              {sourceUrl}
            </span>
          </span>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="default" onClick={onTryAnother}>
            Anderes Video probieren
          </Button>
          <Button type="button" variant="secondary" onClick={onProceedEmpty}>
            Trotzdem leer anlegen
          </Button>
        </div>
      </div>
    </main>
  )
}
