import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { ImportStatus } from '@familien-kochbuch/shared'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useImportStatus } from './hooks'
import { recallImportGroup } from './importGroupMemo'
import { progressLabel } from './progressLabel'

/**
 * `/rezepte/import/:importId` — the "we're extracting …" screen.
 *
 * Polls the import status every 2 s via `useImportStatus` (TanStack
 * Query's refetchInterval returns false once the backend reports
 * `done` or `error`, so polling stops automatically — no extra cleanup
 * needed).
 *
 * On `done` we navigate the user to
 * `/groups/{groupId}/recipes/new?importId={importId}` where the
 * recipe form in P2-7 step 5 reads the importId and prefills.
 *
 * On `error` we render the error message + a fallback CTA to create
 * the recipe manually.
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

  // When the job reaches `done`, hop straight to the RecipeFormPage
  // so the user can review + save. We do this inside an effect rather
  // than during render because `navigate` is a side effect.
  useEffect(() => {
    if (!status.data) return
    if (status.data.status !== 'done') return
    if (!groupId) return
    navigate(
      `/groups/${groupId}/recipes/new?importId=${encodeURIComponent(importId)}`,
      { replace: true },
    )
  }, [status.data, groupId, importId, navigate])

  const data = status.data
  const effectiveStatus: ImportStatus | 'loading' = data?.status ?? 'loading'

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <div className="mb-6 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        <Loader2
          className={cn(
            'h-3.5 w-3.5 text-primary',
            effectiveStatus === 'running' || effectiveStatus === 'queued'
              ? 'animate-spin'
              : effectiveStatus === 'loading'
                ? 'animate-spin'
                : '',
          )}
          aria-hidden="true"
        />
        {effectiveStatus === 'error' ? 'Import fehlgeschlagen' : 'Import läuft'}
      </div>
      <h1 className="font-serif text-[clamp(26px,6vw,34px)] font-semibold leading-[1.1] tracking-[-0.015em]">
        Rezept wird extrahiert
      </h1>

      {effectiveStatus === 'error' ? (
        <ErrorPanel
          message={
            data?.errorMessage ?? 'Der Import ist fehlgeschlagen. Bitte versuche es später erneut.'
          }
          fallbackHref={groupId ? `/groups/${groupId}/recipes/new` : '/groups'}
        />
      ) : (
        <ProgressPanel
          progress={data?.progress ?? 0}
          status={data?.status ?? 'queued'}
        />
      )}

      {effectiveStatus !== 'error' && (
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
    </main>
  )
}

function ProgressPanel({
  progress,
  status,
}: {
  progress: number
  status: ImportStatus
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)))
  const label = progressLabel(status, clamped)
  return (
    <section className="mt-6 rounded-[18px] border border-border bg-card px-6 py-8 shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label="Import-Fortschritt"
        className="h-2 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-4 flex items-baseline justify-between">
        <p className="text-[15px] font-semibold text-foreground">{label}</p>
        <span className="text-[12.5px] font-medium tabular-nums text-[hsl(var(--muted-foreground))]">
          {clamped}%
        </span>
      </div>
    </section>
  )
}

function ErrorPanel({
  message,
  fallbackHref,
}: {
  message: string
  fallbackHref: string
}) {
  return (
    <section
      role="alert"
      className="mt-6 rounded-[18px] border border-[hsl(var(--destructive)/0.25)] bg-[hsl(var(--destructive)/0.08)] px-6 py-6 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 text-[hsl(var(--destructive))]"
          aria-hidden="true"
        />
        <div>
          <p className="font-semibold text-[hsl(var(--destructive))]">
            Import fehlgeschlagen
          </p>
          <p className="mt-1 text-[14px] leading-[1.5] text-foreground">
            {message}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild>
              <Link to={fallbackHref}>Manuell anlegen</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

