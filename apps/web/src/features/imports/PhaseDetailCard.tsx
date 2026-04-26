import type { ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type {
  RecipeImportDto,
  RecipeImportPhase,
} from '@shared-cookbook/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatBytes, formatEta } from './phaseProgress'

interface PhaseDetailCardProps {
  phase: RecipeImportPhase
  /**
   * Full import payload so the card can render phase-specific detail
   * (bytes, segments, ETA, error message) without the parent having to
   * juggle a prop explosion. The fields we read are all optional on the
   * {@link RecipeImportDto} — defaults are chosen so a pre-first-event
   * render degrades gracefully.
   */
  payload: Pick<
    RecipeImportDto,
    | 'bytesDownloaded'
    | 'bytesTotal'
    | 'segmentsDone'
    | 'segmentsTotal'
    | 'createdAt'
    | 'errorMessage'
    | 'progressLabel'
  >
  /** Callback for the Error phase "Neu starten" CTA. */
  onRetry?: () => void
}

/**
 * PV3 — per-phase contextual detail card. Copy per the design doc
 * §Frontend Components / §PhaseDetailCard content per phase. The card
 * is mostly flavour text; the actual authoritative status comes from
 * the progress bar + stepper that wrap it on the page.
 *
 * Error state exposes a "Neu starten" CTA that the parent wires to a
 * re-navigate (PV3 scope — no backend retry endpoint yet per the
 * design-doc §Stale Progress). Done state shows a success flourish
 * while the parent `useEffect` handles the auto-redirect.
 */
export function PhaseDetailCard({ phase, payload, onRetry }: PhaseDetailCardProps) {
  const content = renderContent(phase, payload)
  return (
    <section
      data-testid={`phase-detail-${phase}`}
      role={phase === 'error' ? 'alert' : 'status'}
      aria-live={phase === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'rounded-[18px] border bg-card px-6 py-5 shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
        phase === 'error'
          ? 'border-[hsl(var(--destructive)/0.25)] bg-[hsl(var(--destructive)/0.08)]'
          : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">{content.icon}</span>
        <div className="flex-1 min-w-0">
          <p
            className={cn(
              'text-[15px] font-semibold leading-snug break-words',
              phase === 'error'
                ? 'text-[hsl(var(--destructive))]'
                : 'text-foreground',
            )}
          >
            {content.primary}
          </p>
          {content.sub && (
            <p className="mt-1 break-all text-[13px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
              {content.sub}
            </p>
          )}
          {phase === 'error' && onRetry && (
            <div className="mt-4">
              <Button type="button" onClick={onRetry} variant="default">
                Neu starten
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

interface DetailContent {
  icon: ReactElement
  primary: string
  sub: string | null
}

function renderContent(
  phase: RecipeImportPhase,
  payload: PhaseDetailCardProps['payload'],
): DetailContent {
  switch (phase) {
    case 'queued':
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />,
        primary: "Warteschlange — gleich geht's los…",
        sub: null,
      }
    case 'downloading': {
      const bytes = bytesSubLine(payload.bytesDownloaded, payload.bytesTotal)
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />,
        primary: 'Video wird heruntergeladen',
        sub: bytes,
      }
    }
    case 'transcribing': {
      const sub = transcribingSubLine(
        payload.segmentsDone ?? null,
        payload.segmentsTotal ?? null,
        payload.createdAt,
      )
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />,
        primary: 'Audio wird transkribiert',
        sub,
      }
    }
    case 'structuring':
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />,
        primary: 'Rezept wird strukturiert (Azure OpenAI)',
        sub: null,
      }
    case 'post_processing':
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />,
        primary: 'Nachverarbeitung…',
        sub: null,
      }
    case 'vision_analysis':
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />,
        primary: 'Fotos werden analysiert (Azure Vision)',
        sub: null,
      }
    case 'done':
      return {
        icon: <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />,
        primary: 'Fertig — leite weiter…',
        sub: null,
      }
    case 'error':
      return {
        icon: (
          <AlertTriangle
            className="h-5 w-5 text-[hsl(var(--destructive))]"
            aria-hidden="true"
          />
        ),
        primary: 'Import fehlgeschlagen',
        sub:
          mapErrorMessage(payload.errorMessage) ??
          'Der Import ist fehlgeschlagen. Bitte versuche es später erneut.',
      }
  }
}

/**
 * Maps a server-supplied <c>errorMessage</c> to the German user-facing
 * copy the Error card should render. Today the only structured detection
 * is the Python extractor's <c>truncated_response</c> code (Azure capped
 * the LLM output at <c>max_output_tokens</c>); future codes get an
 * additional branch here.
 *
 * Detection is substring-based on the wire string instead of a separate
 * code field so legacy <see cref="RecipeImport.ErrorMessage"/> rows from
 * before the Python <c>_http_from_llm_error</c> mapping landed are still
 * rewritten — anything containing <c>truncated_response</c> gets the
 * actionable copy. The accompanying Python-side test
 * (test_http_from_llm_error.py) locks the BE wire prefix so this
 * substring detection can't silently drift.
 */
function mapErrorMessage(rawErrorMessage: string | null | undefined): string | null {
  if (rawErrorMessage == null || rawErrorMessage.trim().length === 0) return null
  if (rawErrorMessage.includes('truncated_response')) {
    return (
      'Antwort zu lang — das Video oder Rezept ist sehr komplex. '
      + 'Versuche eine kürzere Quelle oder eine direkte Rezept-URL.'
    )
  }
  return rawErrorMessage
}

function bytesSubLine(
  bytesDownloaded: number | null | undefined,
  bytesTotal: number | null | undefined,
): string | null {
  if (!bytesDownloaded || !bytesTotal || bytesTotal <= 0) return null
  const pct = Math.round((bytesDownloaded / bytesTotal) * 100)
  return `${formatBytes(bytesDownloaded)} von ${formatBytes(bytesTotal)} (${pct}%)`
}

function transcribingSubLine(
  segmentsDone: number | null,
  segmentsTotal: number | null,
  createdAtIso: string,
): string | null {
  if (segmentsDone == null || segmentsTotal == null) return null
  if (segmentsTotal <= 0) return null
  const base = `Segment ${segmentsDone} von ${segmentsTotal}`
  const eta = formatEta(createdAtIso, segmentsDone, segmentsTotal)
  return eta ? `${base} — ${eta}` : base
}
