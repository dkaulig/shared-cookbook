import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { ImportStatus, RecipeImportPhase } from '@familien-kochbuch/shared'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useImportStatus } from './hooks'
import { recallImportGroup } from './importGroupMemo'
import { derivePhase, resolveLabel } from './phaseProgress'
import { OverallProgressBar } from './OverallProgressBar'
import { PhaseStepper } from './PhaseStepper'
import { PhaseDetailCard } from './PhaseDetailCard'
import { RetryIndicator } from './RetryIndicator'
import { StaleBanner } from './StaleBanner'

/**
 * `/rezepte/import/:importId` — phase-aware "we're extracting …"
 * screen.
 *
 * Primary transport for progress updates is SignalR
 * (`RecipeImportProgressChanged` via `useLiveSync`), which writes the
 * authoritative payload straight into the TanStack-Query cache via
 * `setQueryData`. `useImportStatus` still polls every 3 s as a
 * fallback for disconnected hub / reload / tab-hidden scenarios.
 *
 * On `done` we navigate the user to
 * `/groups/{groupId}/recipes/new?importId={importId}` where the
 * recipe form in P2-7 step 5 reads the importId and prefills.
 *
 * On `error` the {@link PhaseDetailCard} renders a "Neu starten" CTA
 * that sends the user back to `/rezepte/import/url?url=<sourceUrl>`
 * with the original URL pre-filled. A real retry-endpoint is deferred
 * to a future slice per the design doc §Stale Progress.
 *
 * The `groupId` for the redirect is NOT in the P2-6 GET response
 * (the .NET `ImportStatusResponse` intentionally omits it), so we
 * pull it from the navigation state (set by ImportUrlPage on submit)
 * or the sessionStorage sidecar (for reload / deep-link survival).
 * Without a groupId we render an inline fallback that points the
 * user at `/groups` to pick one manually.
 */
export function ImportProgressPage() {
  const params = useParams<{ importId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const importId = params.importId ?? ''
  const locationState = location.state as { groupId?: string } | null
  const [groupId] = useState<string | null>(
    () => locationState?.groupId ?? recallImportGroup(importId),
  )

  const status = useImportStatus(importId)
  const data = status.data
  const effectiveStatus: ImportStatus | 'loading' = data?.status ?? 'loading'
  const phase: RecipeImportPhase = derivePhase(data)

  // When the job reaches `done`, hop straight to the RecipeFormPage so
  // the user can review + save. A 500 ms dwell gives the phase-detail
  // card's success flourish a beat to register before we navigate, per
  // design-doc §PhaseDetailCard Done row ("success checkmark +
  // auto-redirect after 500ms").
  useEffect(() => {
    if (!data) return
    if (data.status !== 'done') return
    if (!groupId) return
    const timer = window.setTimeout(() => {
      navigate(
        `/groups/${groupId}/recipes/new?importId=${encodeURIComponent(importId)}`,
        { replace: true },
      )
    }, 500)
    return () => window.clearTimeout(timer)
  }, [data, groupId, importId, navigate])

  function handleRetry() {
    const sourceUrl = data?.sourceUrl ?? ''
    const target = sourceUrl
      ? `/rezepte/import/url?url=${encodeURIComponent(sourceUrl)}`
      : '/rezepte/import/url'
    navigate(target)
  }

  const attemptNumber = data?.attemptNumber ?? 1
  const headerSpinning =
    effectiveStatus === 'running' ||
    effectiveStatus === 'queued' ||
    effectiveStatus === 'loading'

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <div className="mb-6 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        <Loader2
          className={cn(
            'h-3.5 w-3.5 text-primary',
            headerSpinning && 'animate-spin',
          )}
          aria-hidden="true"
        />
        {effectiveStatus === 'error' ? 'Import fehlgeschlagen' : 'Import läuft'}
      </div>
      <h1 className="font-serif text-[clamp(26px,6vw,34px)] font-semibold leading-[1.1] tracking-[-0.015em]">
        Rezept wird extrahiert
      </h1>

      {effectiveStatus === 'done' && !groupId ? (
        // Edge case: the import completed but we never learned which
        // group the user intended (e.g. they opened the progress URL in
        // a fresh tab). Guide them to a group-picker so the result
        // isn't orphaned.
        <DoneWithoutGroupPanel />
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          {attemptNumber > 1 && <RetryIndicator attemptNumber={attemptNumber} />}
          <OverallProgressBar
            value={data?.progress ?? 0}
            label={resolveLabel(data, effectiveStatus)}
          />
          <PhaseStepper
            currentPhase={phase}
            phaseProgress={data?.phaseProgress ?? 0}
            source={data?.source === 'photos' ? 'photos' : 'url'}
          />
          <PhaseDetailCard
            phase={phase}
            payload={{
              bytesDownloaded: data?.bytesDownloaded ?? null,
              bytesTotal: data?.bytesTotal ?? null,
              segmentsDone: data?.segmentsDone ?? null,
              segmentsTotal: data?.segmentsTotal ?? null,
              createdAt: data?.createdAt ?? new Date().toISOString(),
              errorMessage: data?.errorMessage ?? null,
              progressLabel: data?.progressLabel ?? null,
            }}
            onRetry={effectiveStatus === 'error' ? handleRetry : undefined}
          />
          <StaleBanner
            lastProgressAt={
              effectiveStatus === 'running' ? data?.lastProgressAt : undefined
            }
          />
        </div>
      )}

      {effectiveStatus !== 'error' && !(effectiveStatus === 'done' && !groupId) && (
        <div className="mt-6 flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-[hsl(var(--muted-foreground))]">
            Du kannst die Seite verlassen — wir führen den Import fertig. Öffne
            den gleichen Link später erneut, um die Vorschau zu prüfen.
          </p>
          <Button variant="ghost" type="button" onClick={() => navigate(-1)}>
            Zurück
          </Button>
        </div>
      )}

      {effectiveStatus === 'error' && (
        <div className="mt-6 flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-[hsl(var(--muted-foreground))]">
            Falls der Fehler bleibt, kannst du das Rezept manuell anlegen.
          </p>
          <Button asChild variant="ghost">
            <Link to={groupId ? `/groups/${groupId}/recipes/new` : '/groups'}>
              Manuell anlegen
            </Link>
          </Button>
        </div>
      )}
    </main>
  )
}

function DoneWithoutGroupPanel() {
  return (
    <section
      role="status"
      data-testid="import-done-no-group"
      className="mt-6 rounded-[18px] border border-border bg-card px-6 py-6 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
    >
      <p className="font-semibold text-foreground">Import abgeschlossen</p>
      <p className="mt-1 text-[14px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
        Die Rezept-Vorschau ist bereit, aber die Ziel-Gruppe ist in dieser
        Sitzung nicht bekannt. Wähle eine Gruppe, um die Vorschau zu prüfen
        und zu speichern.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/groups">Gruppe auswählen</Link>
        </Button>
      </div>
    </section>
  )
}
