import { FileQuestion } from 'lucide-react'
import type { EmptyReason, ExtractionSignals } from '@shared-cookbook/shared'
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
   * BUG-034 (signal-aware follow-up) — which source signals the
   * extractor actually observed. Used to compose variant German copy
   * telling the user WHICH sources were empty (no caption URL, no
   * blog text, no transcript) rather than a generic "no recipe found".
   *
   * All three false → "we had nothing to chew on" copy.
   * Any true with `reason === 'no_recipe_detected'` → "we had {list}
   * but Azure couldn't extract".
   */
  signals: ExtractionSignals
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
 * German noun phrases for each of the three signals. Used by the
 * mixed-signal copy template to build a natural-sounding list
 * ("eine Sprachspur und ein Blog-Link"). Gendered noun phrases chosen
 * so they can share an article ("kein/e") across the three branches:
 *
 * - caption URL → "ein Blog-Link in der Beschreibung" (masc, akk "einen")
 * - blog source → "eine Blog-Webseite" (fem)
 * - transcript → "eine Sprachspur" (fem)
 *
 * The function joins the present signals with a comma-separated list
 * and a final "und" per German convention.
 */
function signalPhrases(signals: ExtractionSignals): string[] {
  const parts: string[] = []
  if (signals.had_transcript) parts.push('eine Sprachspur')
  if (signals.had_blog_source) parts.push('eine Blog-Webseite')
  if (signals.had_caption_url) parts.push('ein Blog-Link in der Beschreibung')
  return parts
}

function joinGerman(parts: string[]): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} und ${parts[1]}`
  // 3 items: "a, b und c"
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`
}

/**
 * Copy for "we had nothing to chew on". Shared between
 * `no_usable_source` (the explicit server classification) and the
 * `no_recipe_detected` fallback when the server omitted the `signals`
 * field (legacy wire shape, chat imports, …). Keeping it as one string
 * means the UX is identical for both cases and the spec's copy is
 * documented once.
 */
const NO_USABLE_SOURCE_COPY =
  'Wir konnten dieses Video nicht automatisch als Rezept auswerten: ' +
  'kein Beschreibungstext mit Link, keine Caption und keine Sprachspur ' +
  'gefunden. Du kannst das Rezept manuell ausfüllen oder ein anderes ' +
  'Video ausprobieren.'

/**
 * Reason + signals → German body copy. Kept as a switch (not a map) so
 * the exhaustiveness check catches new reasons on the `EmptyReason`
 * union. The `no_recipe_detected` branch chooses between the
 * all-false ("no_usable_source" fallback) and mixed-signal copy based
 * on the signal flags — keeps the legacy reason compatible with the
 * richer signal-aware explanation.
 *
 * A `null` reason gets the same copy as `no_recipe_detected` because
 * that's the typical "extractor worked but the video wasn't a recipe"
 * case; we'd rather show a helpful explainer than "unbekannter Fehler".
 */
function reasonCopy(
  reason: EmptyReason | null,
  signals: ExtractionSignals,
): string {
  switch (reason) {
    case 'empty_transcript':
      return 'Das Video enthielt keinen verwertbaren Audio-Inhalt (nur Musik oder stumm).'
    case 'extractor_error':
      return 'Bei der Analyse ist ein Fehler aufgetreten. Versuche es erneut oder melde es als Bug.'
    case 'no_usable_source':
      return NO_USABLE_SOURCE_COPY
    case 'no_recipe_detected':
    case null: {
      const phrases = signalPhrases(signals)
      if (phrases.length === 0) {
        // Legacy callers (pre-signals server) hit this branch — fall
        // back to the same "we had nothing" copy so the user at least
        // gets an explanation, not silence.
        return NO_USABLE_SOURCE_COPY
      }
      // Mixed-signal copy: sources were there, AI just didn't find a
      // recipe.
      const signalList = joinGerman(phrases)
      return (
        `Wir konnten dieses Video nicht zu einem Rezept zusammenbauen, ` +
        `obwohl ${signalList} gefunden wurden. Azure hat keine Zutaten oder ` +
        `Schritte erkannt. Du kannst die Felder manuell ausfüllen.`
      )
    }
  }
}

/**
 * BUG-034 — rendered by `RecipeFormPage` when the import's extracted
 * result was empty (no ingredients AND no steps). Replaces the silent
 * empty-form UX with a dedicated explainer + escape hatches so the
 * user can tell whether Azure said "not a recipe" vs the extractor
 * actually broke.
 *
 * BUG-034 follow-up — the copy is signal-aware: the `signals` prop
 * drives variant German text telling the user WHICH sources came up
 * empty (no audio, no blog text, no caption link) vs WHICH were
 * available-but-Azure-still-blank. That's the difference between
 * "your video is not a recipe video" and "Azure is having a bad day".
 *
 * Visual shell matches the rest of the form surface: rounded-[12px]
 * card, muted foreground copy, shadcn `Button` variants for the two
 * actions. No colour signals (this is an expected outcome, not an
 * error) — we only use the muted surface + the neutral icon.
 */
export function EmptyExtractionExplainer({
  reason,
  sourceUrl,
  signals,
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
          {reasonCopy(reason, signals)}
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
