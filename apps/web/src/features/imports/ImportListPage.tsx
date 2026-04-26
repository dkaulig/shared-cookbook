import { Link, useNavigate } from 'react-router-dom'
import type { ImportSummaryDto } from '@shared-cookbook/shared'
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMyImports, useRetryImport } from './hooks'
import { formatRelativeTime } from './relativeTime'

/**
 * BUG-010 — dashboard route at `/rezepte/import`.
 *
 * Shows two stacked sections:
 *   1. "Neu importieren" — three create-CTAs (URL / Fotos / Chat) so the
 *      user lands here from the BottomNav "Imports"-shortcut and can
 *      pick a flow without a second hop.
 *   2. "Meine Imports" — the caller's 20 most-recent imports, newest
 *      first. Each row shows a source-icon, status chip, progress bar
 *      (when Running/Queued), source URL (truncated) and a relative
 *      "vor N Minuten"-timestamp. Clicking a row:
 *        - Done → `/groups/{groupId}/recipes/new?importId=…`
 *          (ImportProgressPage's own redirect target; lets the user
 *          jump straight into the form prefill)
 *        - else → `/rezepte/import/{importId}` (shared progress page)
 *
 * The list polls at the same cadence as the per-id status hook, but
 * only while any row is non-terminal (see {@link useMyImports}).
 *
 * German copy throughout. The empty state offers the same three CTAs
 * as the header — keeping the affordances visible even when the list
 * is blank means a first-time user doesn't have to hunt.
 */
export function ImportListPage() {
  const imports = useMyImports(20)
  const rows = imports.data ?? []
  const isLoading = imports.isLoading
  const errored = imports.isError

  return (
    <main className="mx-auto w-full max-w-2xl overflow-hidden px-5 py-8 md:px-8 md:py-12">
      <div className="mb-6 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        KI-Import
      </div>
      <h1 className="font-serif text-[clamp(28px,6vw,36px)] font-semibold leading-[1.1] tracking-[-0.015em]">
        Meine Imports
      </h1>
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-[hsl(var(--muted-foreground))]">
        Hier findest du deine laufenden und abgeschlossenen Rezept-Importe.
        Tippe einen Eintrag an, um den Status zu sehen oder die Vorschau
        zu öffnen.
      </p>

      <CreateImportCTAs />

      <section className="mt-8">
        <h2 className="font-serif text-[20px] font-semibold tracking-[-0.01em]">
          Letzte Imports
        </h2>
        {isLoading && (
          <p
            data-testid="import-list-loading"
            className="mt-4 text-[13.5px] text-[hsl(var(--muted-foreground))]"
          >
            Imports werden geladen …
          </p>
        )}
        {errored && (
          <p
            role="alert"
            data-testid="import-list-error"
            className="mt-4 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            Deine Imports konnten nicht geladen werden. Bitte später erneut
            versuchen.
          </p>
        )}
        {!isLoading && !errored && rows.length === 0 && (
          <EmptyImportsState />
        )}
        {rows.length > 0 && (
          <ul
            data-testid="import-list"
            className="mt-4 flex flex-col gap-3"
          >
            {rows.map((row) => (
              <li key={row.id}>
                <ImportListRow row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

// ── Create-CTAs ─────────────────────────────────────────────────────

interface CtaConfig {
  key: string
  label: string
  description: string
  icon: LucideIcon
  to: string
}

const CTA_CONFIGS: readonly CtaConfig[] = [
  {
    key: 'url',
    label: 'Aus Video / URL',
    description: 'YouTube, Reel, Blog',
    icon: Video,
    to: '/rezepte/import/url',
  },
  {
    key: 'photos',
    label: 'Aus Fotos',
    description: 'Kochbuch-Scan oder Notiz',
    icon: Camera,
    to: '/rezepte/import/photos',
  },
  {
    key: 'chat',
    label: 'Im Chat erfinden',
    description: 'Mit der KI generieren',
    icon: MessageSquare,
    to: '/chat',
  },
] as const

function CreateImportCTAs() {
  return (
    <section className="mt-8">
      <h2 className="font-serif text-[20px] font-semibold tracking-[-0.01em]">
        Neu importieren
      </h2>
      <ul
        data-testid="import-cta-list"
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {CTA_CONFIGS.map((cta) => {
          const Icon = cta.icon
          return (
            <li key={cta.key}>
              <Link
                to={cta.to}
                data-testid={`import-cta-${cta.key}`}
                className="flex h-full w-full flex-col gap-2 rounded-[14px] border border-border bg-card px-4 py-4 text-left transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span
                  aria-hidden="true"
                  className="grid h-10 w-10 place-items-center rounded-full bg-[hsl(var(--primary)/0.1)] text-primary"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-[14px] font-semibold text-foreground">
                  {cta.label}
                </span>
                <span className="text-[12.5px] text-[hsl(var(--muted-foreground))]">
                  {cta.description}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function EmptyImportsState() {
  return (
    <section
      role="status"
      data-testid="import-list-empty"
      className="mt-4 rounded-[14px] border border-dashed border-border bg-card px-5 py-6 text-center"
    >
      <p className="font-semibold text-foreground">
        Noch keine Imports
      </p>
      <p className="mt-1 text-[14px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
        Starte oben mit einem Video, Fotos oder im Chat — deine Imports
        landen anschließend hier.
      </p>
    </section>
  )
}

// ── Row ─────────────────────────────────────────────────────────────

interface ImportListRowProps {
  row: ImportSummaryDto
}

function ImportListRow({ row }: ImportListRowProps) {
  const navigate = useNavigate()
  const retry = useRetryImport()
  const isTerminal = row.status === 'done' || row.status === 'error'
  const showProgress = !isTerminal

  const handleClick = () => {
    if (row.status === 'done') {
      // Mirror ImportProgressPage's redirect target — the user lands on
      // the form prefill rather than the already-satisfied progress page.
      navigate(
        `/groups/${row.groupId}/recipes/new?importId=${encodeURIComponent(row.id)}`,
      )
      return
    }
    navigate(`/rezepte/import/${row.id}`, {
      state: { groupId: row.groupId },
    })
  }

  const label =
    row.progressLabel ??
    (row.status === 'done'
      ? 'Abgeschlossen'
      : row.status === 'error'
        ? 'Fehlgeschlagen'
        : 'Wird verarbeitet')

  function handleRetry(event: React.MouseEvent<HTMLButtonElement>) {
    // The retry button lives inside the row-level <button>, so a click
    // would otherwise bubble up to handleClick and trigger a route push.
    // Stop propagation so the user stays on the list while the mutation
    // resolves.
    event.stopPropagation()
    retry.mutate(row.id)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        data-testid={`import-row-${row.id}`}
        data-status={row.status}
        className="flex w-full flex-col gap-2 rounded-[14px] border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[hsl(var(--primary)/0.1)] text-primary"
          >
            <SourceGlyph source={row.source} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={row.status} />
              <span className="text-[12px] text-[hsl(var(--muted-foreground))]">
                {formatRelativeTime(row.createdAt)}
              </span>
            </div>
            <p className="mt-1 truncate text-[14px] font-medium text-foreground">
              {shortenSource(row.sourceUrl, row.source)}
            </p>
            <p className="text-[12.5px] text-[hsl(var(--muted-foreground))]">
              {label}
            </p>
          </div>
        </div>
        {showProgress && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.max(0, Math.min(100, Math.round(row.progress)))}
            aria-label="Import-Fortschritt"
            data-testid={`import-row-progress-${row.id}`}
            className="h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{
                width: `${Math.max(0, Math.min(100, Math.round(row.progress)))}%`,
              }}
            />
          </div>
        )}
      </button>
      {/*
       * Retry button is rendered as an absolute-positioned sibling of
       * the row-level button so we keep the row clickable as one unit
       * (BUG-010 navigation contract) without violating the no-nested-
       * buttons HTML rule. Only visible on Failed rows; click triggers
       * the in-place retry mutation and onSuccess patches the cache so
       * the row's status chip flips to Queued without a page reload.
       */}
      {row.status === 'error' && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={retry.isPending}
          data-testid={`import-row-retry-${row.id}`}
          className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-background px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Erneut versuchen
        </button>
      )}
    </div>
  )
}

function StatusChip({ status }: { status: ImportSummaryDto['status'] }) {
  const cfg = statusChipConfig(status)
  return (
    <span
      data-testid={`import-status-chip-${status}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em]',
        cfg.className,
      )}
    >
      <StatusChipIcon status={status} />
      {cfg.label}
    </span>
  )
}

/**
 * Renders the lucide glyph for a status chip. Switching inside JSX
 * rather than hoisting the icon component into a local `const Icon =
 * cfg.icon` binding keeps the `react-hooks/static-components` lint
 * happy (it objects to dynamic component aliases created during
 * render).
 */
function StatusChipIcon({
  status,
}: {
  status: ImportSummaryDto['status']
}) {
  const className = cn(
    'h-3 w-3',
    (status === 'queued' || status === 'running') && 'animate-spin',
  )
  switch (status) {
    case 'queued':
    case 'running':
      return <Loader2 className={className} aria-hidden="true" />
    case 'done':
      return <CheckCircle2 className={className} aria-hidden="true" />
    case 'error':
      return <AlertCircle className={className} aria-hidden="true" />
  }
}

/**
 * Source-glyph in the row-header circle. Same "inline switch" pattern
 * as {@link StatusChipIcon} — avoids a dynamic component alias that
 * the lint rule would flag.
 */
function SourceGlyph({ source }: { source: ImportSummaryDto['source'] }) {
  const className = 'h-4 w-4'
  switch (source) {
    case 'url':
      return <Video className={className} />
    case 'photos':
      return <ImageIcon className={className} />
    case 'chat':
      return <MessageSquare className={className} />
  }
}

type StatusChipConfig = {
  label: string
  className: string
}

const STATUS_CHIP_CONFIG: Record<ImportSummaryDto['status'], StatusChipConfig> = {
  queued: {
    label: 'Warteschlange',
    className: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
  },
  running: {
    label: 'Läuft',
    className: 'bg-[hsl(var(--primary)/0.12)] text-primary',
  },
  done: {
    label: 'Fertig',
    className: 'bg-emerald-100 text-emerald-900',
  },
  error: {
    label: 'Fehler',
    className:
      'bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]',
  },
}

function statusChipConfig(status: ImportSummaryDto['status']): StatusChipConfig {
  return STATUS_CHIP_CONFIG[status]
}


/**
 * Keeps list rows scannable on mobile: domain + first path segment only
 * for URL sources ("example.com/rezept"); a canned label for the
 * photo/chat paths where `sourceUrl` is null. `try/catch` around
 * `new URL` so a malformed stored URL can't break the list.
 */
function shortenSource(
  sourceUrl: string | null,
  source: ImportSummaryDto['source'],
): string {
  if (sourceUrl && sourceUrl.trim().length > 0) {
    try {
      const parsed = new URL(sourceUrl)
      const host = parsed.host.replace(/^www\./, '')
      const path = parsed.pathname
      if (path === '' || path === '/') return host
      // Keep the full URL short: host + up to ~40 chars of path.
      const pathClip = path.length > 40 ? `${path.slice(0, 40)}…` : path
      return `${host}${pathClip}`
    } catch {
      return sourceUrl
    }
  }
  return sourceLabel(source)
}

const SOURCE_LABEL: Record<ImportSummaryDto['source'], string> = {
  url: 'URL-Import',
  photos: 'Foto-Import',
  chat: 'Chat-Import',
}

function sourceLabel(source: ImportSummaryDto['source']): string {
  // Synchronous labeller that mirrors the per-source copy used
  // elsewhere in the app so the language stays consistent on rows
  // without a URL.
  return SOURCE_LABEL[source]
}

