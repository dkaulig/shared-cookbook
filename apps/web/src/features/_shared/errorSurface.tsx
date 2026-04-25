import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ApiError } from '@shared-cookbook/shared'
import i18n from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * REL-5 — cross-app error-surface primitives.
 *
 * Three orthogonal surfaces, one module:
 *
 *   - `showErrorToast(message)` pushes a transient toast onto a module-
 *     level singleton queue. `<ErrorToastHost />` (mounted once near the
 *     app root) subscribes via `useSyncExternalStore` and renders the
 *     queue.
 *
 *   - `<ErrorBanner />` — inline, closable, destructive-tinted alert
 *     primitive. Not a singleton; each page owns its own instance near
 *     the affected content (e.g. above a form, inside a detail header).
 *
 *   - `classifyMutationError(err)` — pure helper. Converts an
 *     `ApiError`-shaped throwable or a native `Error` into
 *     `{ surface, message }` so call-sites route the error to the right
 *     primitive without having to know the HTTP status codes.
 *
 * Design notes:
 *
 *   - The toast host is framework-agnostic on the WRITE side: any
 *     non-component code (a fetch helper, a mutation hook's onError)
 *     can call `showErrorToast()` without a hook-context. The READ side
 *     uses React's standard external-store hook.
 *
 *   - No third-party toast library (sonner, radix-toast). Keeps the
 *     dependency graph small + matches the existing inline-notifier
 *     style in `RecipeActionBar.tsx` (which pre-dates this module).
 *     The `RecipeActionBar` pattern stays local because it couples
 *     success + error for a single button; the global host is for the
 *     un-owned 500/network/unknown case.
 *
 *   - Error messages must not leak sensitive backend text (stack
 *     traces, SQL fragments). `classifyMutationError` returns a
 *     generic German string for 500+ and network failures; only 4xx
 *     codes carry the backend's message through.
 *
 *   - All user-facing copy is German; REL-3 i18n is a separate slice.
 */

// ── Toast store (module-level singleton) ──────────────────────────────

interface Toast {
  id: string
  message: string
}

const listeners = new Set<() => void>()
let snapshot: readonly Toast[] = []

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): readonly Toast[] {
  return snapshot
}

/**
 * Enqueue a toast. Safe to call from anywhere — no hook context
 * required. The message should be human-readable German; callers that
 * need to localise later swap to the i18n key in REL-3.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function showErrorToast(message: string): string {
  const id = crypto.randomUUID()
  snapshot = [...snapshot, { id, message }]
  emit()
  return id
}

// eslint-disable-next-line react-refresh/only-export-components
export function dismissErrorToast(id: string): void {
  const next = snapshot.filter((t) => t.id !== id)
  if (next.length === snapshot.length) return
  snapshot = next
  emit()
}

/** Test helper — resets the singleton between test cases. */
// eslint-disable-next-line react-refresh/only-export-components
export function clearAllErrorToasts(): void {
  if (snapshot.length === 0) return
  snapshot = []
  emit()
}

// ── ErrorToastHost ───────────────────────────────────────────────────

/**
 * Global toast host. Mount once near the app root so the module-level
 * store has exactly one consumer. Multiple hosts would render the same
 * toast queue in multiple places — harmless but wasteful.
 *
 * Positioning (CLAUDE.md layout-invariants):
 *   - Fixed to the viewport bottom with a `safe-area-inset-bottom`
 *     offset + an 88 px buffer. That matches the offset used by the
 *     existing `RecipeActionBar` notifier, which sits above both the
 *     BottomNav and the home-indicator safe area.
 *   - `z-50` to clear BottomNav (z-30) + shadcn dialogs (z-50). Dialogs
 *     trap focus; the toast host does not, so z-tie is visually fine.
 */
export function ErrorToastHost(): React.ReactElement {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const { t } = useTranslation()
  return (
    <div
      data-testid="error-toast-host"
      className={cn(
        'pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-3',
        // BUG-039 / CLAUDE.md layout-invariants — above BottomNav safe
        // area, 88px buffer mirroring `RecipeActionBar`'s existing
        // inline notifier. The `safe-area-inset-bottom` reference is
        // asserted in the unit test to catch accidental regressions.
        'bottom-[calc(env(safe-area-inset-bottom,0px)+88px)]',
      )}
      aria-live="assertive"
      aria-atomic="true"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className={cn(
            'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-[12px]',
            'bg-[hsl(var(--destructive))] px-4 py-2.5 text-[13px] font-medium text-white shadow-lg',
          )}
        >
          <span className="flex-1 break-words">{toast.message}</span>
          <button
            type="button"
            aria-label={t('common.close', { defaultValue: 'Schließen' })}
            onClick={() => dismissErrorToast(toast.id)}
            className={cn(
              '-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded',
              'text-white/80 transition-colors hover:bg-white/10 hover:text-white',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── ErrorBanner ──────────────────────────────────────────────────────

export interface ErrorBannerProps {
  message: string
  onDismiss?: () => void
  className?: string
}

/**
 * Inline, destructive-tinted alert for "stay on the page" surfaces.
 * Typical uses:
 *   - 409 version-mismatch banner above a form ("Jemand anderes hat
 *     das bearbeitet. Bitte neu laden.")
 *   - Partial-save notifications ("Rezept gespeichert, aber 2 Fotos
 *     konnten nicht hochgeladen werden.")
 *
 * Visual style matches the existing inline-error pattern used across
 * the form dialogs (bg-destructive/0.1 + ring + destructive text) so
 * this primitive is a drop-in replacement for the ~12 duplicated
 * `<p role="alert">` blocks in RecipeFormPage / AddSlotDialog / etc.
 */
export function ErrorBanner({
  message,
  onDismiss,
  className,
}: ErrorBannerProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2',
        'text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]',
        className,
      )}
    >
      <span className="flex-1 break-words">{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label={t('common.close', { defaultValue: 'Schließen' })}
          onClick={onDismiss}
          className={cn(
            '-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded',
            'text-[hsl(var(--destructive))]/70 transition-colors',
            'hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--destructive)/0.4)]',
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

// ── classifyMutationError ────────────────────────────────────────────

export type ErrorSurface = 'inline' | 'banner' | 'toast'

/**
 * REL-4 emits `status` + optional `fieldName` in every ApiError body;
 * the classifier exposes `fieldName` so forms that want inline
 * placement can look up the matching input by name. See
 * `apps/api/src/FamilienKochbuch.Api/Services/ErrorCodes.cs`.
 */
export interface ClassifiedError {
  surface: ErrorSurface
  message: string
  /**
   * Pass-through of the original code so call-sites can branch on
   * specific validation codes (e.g. map `invalid_value` to a specific
   * form field). Null for native Error instances (network layer).
   */
  code: string | null
  /**
   * REL-4 — backend-tagged field name on 400 validation errors. Set
   * only when `surface === 'inline'` and the server attributed the
   * failure to a single request field. Forms may use this to place
   * the inline error next to the affected input; must NOT be rendered
   * as visible text (it's a machine identifier, not copy).
   */
  fieldName?: string
}

/**
 * Routes an error to the appropriate user-visible surface.
 *
 *   - 400 + validation-ish code → inline surface (use the backend
 *     message directly — it's already user-actionable German today;
 *     REL-4 migrates to English + code-based translation).
 *   - 409 (regardless of code) → banner surface with a reload hint.
 *   - 5xx, native Errors, unknowns → toast surface with a generic copy.
 *     The raw message is discarded so server stack traces / SQL
 *     fragments never land in front of the user.
 *   - 401/403 → toast fallback; the auth layer redirects to login
 *     on 401 already, so this path only fires when the redirect race
 *     loses (rare) or the backend returns 403 on a call a user
 *     shouldn't have been able to make (authz bug).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function classifyMutationError(err: unknown): ClassifiedError {
  // Resolve via the default singleton so non-hook call-sites work. If
  // the singleton hasn't initialised yet (e.g. an error during boot,
  // or a unit test that imports this module directly without the i18n
  // bootstrap) we fall back to the `defaultValue` verbatim. Using a
  // wrapper guarantees the return is always a string even when
  // `i18n.t` would have been `undefined`.
  const t = (key: string, opts: { defaultValue: string; ns?: string }): string =>
    (i18n.isInitialized
      ? (i18n.t(key, opts) as string | undefined)
      : undefined) ?? opts.defaultValue

  // Native Error without a code/status — treat as network / unknown.
  if (err instanceof Error && !isApiErrorShaped(err)) {
    return {
      surface: 'toast',
      message: t('common.networkError', {
        defaultValue:
          'Unbekannter Fehler. Bitte Verbindung prüfen und erneut versuchen.',
      }),
      code: null,
    }
  }
  const apiErr = err as Partial<ApiError>
  const code = apiErr.code ?? null
  const rawMessage = apiErr.message ?? ''
  // REL-4: `status` is authoritative and mandatory in every ApiError
  // body. If it's missing, treat as unknown — do NOT reverse-engineer
  // a number from the `code` string. Network errors + bodyless failures
  // fall through to the generic "actionFailed" inline copy below.
  const status = typeof apiErr.status === 'number' ? apiErr.status : undefined
  const fieldName =
    typeof apiErr.fieldName === 'string' && apiErr.fieldName.length > 0
      ? apiErr.fieldName
      : undefined

  // 409 — version conflict. Always banner; copy is generic.
  if (status === 409 || code === 'version_mismatch') {
    return {
      surface: 'banner',
      message: t('common.versionConflict', {
        defaultValue:
          'Jemand anderes hat das inzwischen bearbeitet. Bitte neu laden.',
      }),
      code,
    }
  }

  // 5xx, auth failures, unknown → generic localised toast. We
  // explicitly drop the backend message so stack traces / SQL
  // fragments never reach the user. REL-0b security audit flagged
  // this.
  if (typeof status === 'number' && status >= 500) {
    return {
      surface: 'toast',
      message: t('common.unknownError', {
        defaultValue: 'Unbekannter Fehler, bitte erneut versuchen.',
      }),
      code,
    }
  }

  // 401/403 — auth surface handles 401 via apiClient refresh path. If
  // we land here, the refresh failed or this is a 403. Toast is the
  // lowest-friction nudge.
  //
  // SMALL-1b: when the backend tagged the failure with a user-
  // actionable code (e.g. `invalid_credentials` on /auth/login), prefer
  // the localised `errors:<code>` copy over the generic forbidden
  // string. The previous order routed every 401 to "Fehlende
  // Berechtigung. Bitte neu anmelden …" which is nonsensical during a
  // failed login attempt, forcing LoginPage to wear a bespoke 4xx
  // fall-through. With the priority flipped, a known code wins; only
  // unknown / missing codes keep the generic toast.
  if (status === 401 || status === 403) {
    const codeLocalised = code
      ? t(code, { ns: 'errors', defaultValue: '' })
      : ''
    return {
      surface: 'toast',
      message:
        codeLocalised ||
        t('common.forbidden', {
          defaultValue:
            'Fehlende Berechtigung. Bitte neu anmelden oder Admin kontaktieren.',
        }),
      code,
    }
  }

  // Everything else (400, 404, 422, …, or a status-less body) — inline
  // surface. Prefer a localised translation keyed by the backend
  // error-code; fall back to the raw message (English post-REL-4) and
  // finally to a generic "action failed" copy. Empty rawMessage is NOT
  // passed to `t()` as defaultValue because i18next would then return
  // the key itself ("action.failed" etc.).
  const codeLocalised = code
    ? t(code, { ns: 'errors', defaultValue: '' })
    : ''
  const message =
    codeLocalised ||
    rawMessage ||
    t('common.actionFailed', { defaultValue: 'Aktion fehlgeschlagen.' })
  return {
    surface: 'inline',
    message,
    code,
    ...(fieldName ? { fieldName } : {}),
  }
}

function isApiErrorShaped(err: Error): boolean {
  // Our `request()` helper in recipesApi.ts (and siblings) attaches
  // `code` + `message` to the thrown Error instance. Native fetch
  // errors have neither. Use the presence of `code` as the duck-type.
  return typeof (err as unknown as { code?: unknown }).code === 'string'
}

/**
 * Convenience shortcut for the most common REL-5 call-site pattern:
 * "I don't care which surface routes this — just show me something."
 * Identical to `showErrorToast(classifyMutationError(err).message)` but
 * lets mutation `onError` handlers stay one line.
 *
 * Use this when you do NOT need to branch on `surface` (e.g. an inline
 * field-error path that handles 400s separately); use the full
 * `classifyMutationError` return value when you do.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function toastMutationError(err: unknown): void {
  showErrorToast(classifyMutationError(err).message)
}

