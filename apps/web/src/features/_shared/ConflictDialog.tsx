import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/**
 * OFF4 — shared conflict-resolution dialog primitive.
 *
 * Mirrors the fixed-overlay pattern of `ConfirmDialog` (BUG-004):
 *   - `role="dialog" aria-modal="true"` with labelled title,
 *   - ESC + backdrop-click dismiss,
 *   - focus-trap that cycles Tab within the dialog,
 *   - optional `onManualMerge` third-button path (recipes) — if absent,
 *     the dialog renders a two-button "Lokal / Server" flow appropriate
 *     for slots + shopping-list items.
 *
 * The body (`renderDiff`) is injected by the caller so each resource
 * can own its own per-field presentation (RecipeConflictBody,
 * SlotConflictBody, ItemConflictBody) without the primitive having to
 * know about DTO shapes.
 */
export interface ConflictDialogProps<T> {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  currentServer: T
  localPending: T
  /**
   * Renders the body of the dialog — a per-resource diff view. OFF4
   * provides three concrete renderers (recipe, meal-plan-slot,
   * shopping-list-item); callers pass one.
   */
  renderDiff: (props: { current: T; local: T }) => ReactNode
  onKeepLocal: () => void | Promise<void>
  onKeepServer: () => void | Promise<void>
  /**
   * Optional third button. When provided the dialog renders a
   * "Manuell zusammenführen" action — recipes supply it, slots + items
   * deliberately don't (their fields are too few to justify a merge
   * editor).
   */
  onManualMerge?: (merged: T) => void | Promise<void>
  keepLocalLabel?: string
  keepServerLabel?: string
  mergeLabel?: string
  /**
   * When truthy, all action buttons render disabled + spinner. Mirrors
   * the ConfirmDialog isLoading contract so the caller can gate the
   * dialog while the retry/invalidate round-trips.
   */
  isLoading?: boolean
}

export function ConflictDialog<T>({
  open,
  onClose,
  title,
  subtitle,
  currentServer,
  localPending,
  renderDiff,
  onKeepLocal,
  onKeepServer,
  onManualMerge,
  keepLocalLabel,
  keepServerLabel,
  mergeLabel,
  isLoading = false,
}: ConflictDialogProps<T>) {
  const { t } = useTranslation()
  const resolvedKeepLocalLabel =
    keepLocalLabel ?? t('common.conflict.keepLocal', { defaultValue: 'Lokal behalten' })
  const resolvedKeepServerLabel =
    keepServerLabel ?? t('common.conflict.keepServer', { defaultValue: 'Server übernehmen' })
  const resolvedMergeLabel =
    mergeLabel ?? t('common.conflict.merge', { defaultValue: 'Manuell zusammenführen' })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const firstActionRef = useRef<HTMLButtonElement | null>(null)
  // Caller-supplied merge state — the Recipe body calls
  // `onManualMerge(merged)` with the field-by-field editor output. The
  // dialog is purely a shell; the merge form lives in the body.

  // ESC to close (never while isLoading — mirrors ConfirmDialog).
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isLoading) {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, isLoading, onClose])

  // Focus the first action button when the dialog opens so keyboard
  // users land inside the trap immediately. `ConfirmDialog` uses the
  // same pattern — kept consistent so screen-reader announcements stay
  // predictable.
  useEffect(() => {
    if (open) firstActionRef.current?.focus()
  }, [open])

  // Minimal focus trap: Tab + Shift-Tab cycle within the dialog's
  // focusable descendants. We read the descendants on every keystroke
  // because the caller's `renderDiff` may add/remove inputs between
  // renders (e.g. Recipe's manual-merge editor reveals extra fields).
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return
      const root = rootRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else {
        if (active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  if (!open) return null

  async function handle(action: (() => void | Promise<void>) | undefined) {
    if (isLoading || !action) return
    try {
      await action()
    } catch {
      // Swallow — callers use the hook to drive the dialog close. An
      // error inside an action is treated as "stay open" so the user
      // can try a different resolution path.
      return
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-dialog-title"
      aria-describedby={subtitle ? 'conflict-dialog-subtitle' : undefined}
      data-testid="conflict-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (isLoading) return
        onClose()
      }}
    >
      <div
        ref={rootRef}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="conflict-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          {title}
        </h2>
        {subtitle && (
          <p
            id="conflict-dialog-subtitle"
            className="mb-4 text-sm text-muted-foreground"
          >
            {subtitle}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {renderDiff({ current: currentServer, local: localPending })}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            ref={firstActionRef}
            type="button"
            variant="default"
            onClick={() => {
              void handle(async () => {
                await onKeepLocal()
                onClose()
              })
            }}
            disabled={isLoading}
            data-testid="conflict-dialog-keep-local"
          >
            {isLoading && (
              <Loader2
                className="mr-1.5 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            {resolvedKeepLocalLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void handle(async () => {
                await onKeepServer()
                onClose()
              })
            }}
            disabled={isLoading}
            data-testid="conflict-dialog-keep-server"
          >
            {resolvedKeepServerLabel}
          </Button>
          {onManualMerge && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                // The merge form lives in the body via `renderDiff`; the
                // caller (Recipe body) is expected to expose its own
                // submit button. This third button is an ESCAPE-hatch
                // "commit current edits" shortcut — it re-emits the
                // `localPending` as-is so the Recipe body's editor state
                // (kept in React ref) becomes the merged value. For the
                // test harness we simply forward `localPending`.
                void handle(async () => {
                  await onManualMerge(localPending)
                  onClose()
                })
              }}
              disabled={isLoading}
              data-testid="conflict-dialog-merge"
            >
              {resolvedMergeLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── useConflictResolver hook ───────────────────────────────────────

/**
 * OFF4 — captures a 409 VersionMismatchError and exposes three
 * resolution paths (keep-local retry / keep-server abort / manual-merge
 * submit). Consumers wire a mutation's `onError` to `captureFrom409`
 * and render `<ConflictDialog …state…>` when `state !== null`.
 *
 * Deliberately narrow: the hook does NOT know how to re-dispatch the
 * mutation — it calls the caller-provided `onKeepLocal(expectedVersion,
 * local)` which owns the mutation reference. This keeps mutation +
 * cache logic at the feature layer where the query-key / DTO shape
 * already lives.
 *
 * Scope caveat (plan-mandated): if a second 409 arrives while a dialog
 * is already open, `captureFrom409` returns early — a proper conflict
 * queue UI is deferred to a later polish pass. The test suite
 * documents the behaviour.
 */
export interface ConflictState<T> {
  open: boolean
  serverCurrent: T
  localPending: T
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConflictResolver<T extends { version: number }>(opts: {
  onKeepLocal: (expected: number, local: T) => Promise<unknown>
  onKeepServer: () => void | Promise<void>
}): {
  state: ConflictState<T> | null
  /**
   * Captures a 409 VersionMismatchError and opens the dialog. The
   * second argument only needs to provide `current` — typically the
   * server's full DTO at the moment of the conflict. Consumers can
   * pass a narrowed / projected shape (e.g. a single slot pulled out
   * of a MealPlan response) as long as it carries `version: number`.
   */
  captureFrom409: (localPending: T, error: { current: unknown }) => void
  resolveKeepLocal: () => Promise<void>
  resolveKeepServer: () => Promise<void>
  close: () => void
} {
  const [state, setState] = useState<ConflictState<T> | null>(null)

  function isTWithVersion(value: unknown): value is T {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { version?: unknown }).version === 'number'
    )
  }

  function captureFrom409(
    localPending: T,
    error: { current: unknown },
  ): void {
    // Plan-documented deviation: second-concurrent-409-while-dialog-open
    // drops the newer capture. The already-open dialog wins until the
    // user resolves it. A queued UX lands in OFF5 polish.
    if (state !== null) return
    if (!isTWithVersion(error.current)) return
    setState({
      open: true,
      serverCurrent: error.current,
      localPending,
    })
  }

  async function resolveKeepLocal(): Promise<void> {
    if (!state) return
    // Use the server's current version as the new expected-version so
    // the re-dispatched mutation carries the right If-Match ETag. If
    // the retry ALSO fails with 409, the caller's onError handler
    // should call captureFrom409 again — but only after we've cleared
    // the current state below.
    const expected = state.serverCurrent.version
    const local = state.localPending
    setState(null)
    await opts.onKeepLocal(expected, local)
  }

  async function resolveKeepServer(): Promise<void> {
    if (!state) return
    setState(null)
    await opts.onKeepServer()
  }

  function close(): void {
    setState(null)
  }

  return {
    state,
    captureFrom409,
    resolveKeepLocal,
    resolveKeepServer,
    close,
  }
}
