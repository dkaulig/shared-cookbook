import { useCallback, useRef, useState } from 'react'
import type { RefCallback } from 'react'
import { cn } from '@/lib/utils'
import { classifyMutationError } from './errorSurface'

/**
 * REL-5g — shared primitives for inline-field-error rendering + focus
 * routing. Consolidates the boilerplate that REL-5d/e/f/4c/4d sprinkled
 * across ProfilePage, SignupPage, RecipeFormPage + the Sortable rows:
 *
 *   1. a ref-map keyed by the backend-emitted `fieldName`;
 *   2. a `{fieldName, message}` state slice;
 *   3. aria-invalid / aria-describedby / `<p role="alert">` wiring;
 *   4. `classifyMutationError → focus + scrollIntoView + setState`.
 *
 * Two pieces:
 *
 *   - `<InlineFieldError>` — view component. The caller owns the
 *     message and the id; we guarantee the aria + testid shape stays
 *     consistent across every form. Renders nothing when `message` is
 *     null so callers can mount it unconditionally. RecipeFormPage +
 *     its Sortable rows consume this directly because their surrounding
 *     dual-slice state machinery (SUPPORTED_INLINE_FIELDS allowlist +
 *     REL-4d nested-path parser) doesn't fit the hook's single-slice
 *     shape — they keep their own state, re-use our aria contract.
 *
 *   - `useFieldErrorFocus<T>()` — hook for forms with one flat
 *     fieldname → input mapping (ProfilePage's two sections + Signup):
 *       · `registerRef(fieldName)` — RefCallback that stashes the
 *         element under the given key.
 *       · `fieldError` — `{fieldName, message}` or null.
 *       · `applyError(err)` — classifies + focuses + scrolls. Returns
 *         `true` when a field-level match was found. When no match
 *         exists, the classified message still lands in
 *         `fieldError.fieldName === null` so single-slice forms
 *         render one `<InlineFieldError>` at the banner slot without
 *         branching on two state variables.
 *       · `setBanner(message)` — stuff a ready-localised message into
 *         the banner slot without the classifier round-trip. For
 *         client-side validation copy.
 *       · `clear()` — reset state. Call on submit-start / input-change.
 *
 * The hook is generic over the element type so a form can mix input,
 * textarea, select, and `<div tabIndex=-1>` refs under one map. T
 * defaults to HTMLElement — covers every focusable surface — but
 * individual call-sites can pin T tighter (HTMLInputElement) for
 * autocomplete. `scrollIntoView` + `focus()` live in the hook, not
 * the component, so a future `prefers-reduced-motion` gate only
 * needs to land in one place.
 */

// ── InlineFieldError ──────────────────────────────────────────────────

export interface InlineFieldErrorProps {
  /**
   * DOM id of the alert `<p>`. Used as the companion input's
   * `aria-describedby` target. Keep it literal (not user-controlled) —
   * the attribute is machine-readable, not user copy.
   */
  id: string
  /** Message to render. `null` → render nothing. */
  message: string | null
  /** Optional test-id forwarded to the alert node. */
  testId?: string
  /** Optional class override for callers that want custom spacing. */
  className?: string
}

/**
 * Standard inline-error surface. Callers wire the matching input via:
 *   aria-invalid={fieldError?.fieldName === 'x' || undefined}
 *   aria-describedby={fieldError?.fieldName === 'x' ? 'x-error' : undefined}
 * and render <InlineFieldError id="x-error" message={…} /> next to it.
 */
export function InlineFieldError({
  id,
  message,
  testId,
  className,
}: InlineFieldErrorProps): React.ReactElement | null {
  if (message === null) return null
  return (
    <p
      id={id}
      {...(testId ? { 'data-testid': testId } : {})}
      role="alert"
      aria-live="polite"
      className={cn(
        'mt-1 text-sm text-[hsl(var(--destructive))]',
        className,
      )}
    >
      {message}
    </p>
  )
}

// ── useFieldErrorFocus ────────────────────────────────────────────────

export interface FieldErrorState {
  /**
   * Backend-emitted `fieldName` key. `null` when the classifier did not
   * attribute the error to a specific field (network / 5xx / 401) —
   * callers render those as a bottom-of-form banner by checking for
   * `fieldName === null`.
   */
  fieldName: string | null
  message: string
}

export interface UseFieldErrorFocusReturn<T extends HTMLElement> {
  registerRef: (fieldName: string) => RefCallback<T>
  fieldError: FieldErrorState | null
  applyError: (err: unknown) => boolean
  /**
   * Set a bare banner message without routing through the classifier.
   * Used for client-side validation copy (already localised by the
   * caller) that should land in the same state slot as server-side
   * fallback errors. `fieldName` on the resulting state is always
   * `null`.
   */
  setBanner: (message: string) => void
  clear: () => void
}

// eslint-disable-next-line react-refresh/only-export-components
export function useFieldErrorFocus<
  T extends HTMLElement = HTMLElement,
>(): UseFieldErrorFocusReturn<T> {
  const fieldRefs = useRef<Record<string, T | null>>({})
  const [fieldError, setFieldError] = useState<FieldErrorState | null>(null)

  const registerRef = useCallback(
    (fieldName: string): RefCallback<T> =>
      (el) => {
        fieldRefs.current[fieldName] = el
      },
    [],
  )

  const clear = useCallback(() => {
    setFieldError(null)
  }, [])

  const setBanner = useCallback((message: string) => {
    setFieldError({ fieldName: null, message })
  }, [])

  const applyError = useCallback((err: unknown): boolean => {
    const classified = classifyMutationError(err)
    const name = classified.fieldName

    if (name) {
      const target = fieldRefs.current[name]
      if (target) {
        setFieldError({ fieldName: name, message: classified.message })
        target.focus()
        target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
        return true
      }
    }

    // No field match — expose the classified copy as a banner slice so
    // single-state forms can render one `<InlineFieldError>` at the
    // bottom-of-form banner without branching on two state variables.
    setFieldError({ fieldName: null, message: classified.message })
    return false
  }, [])

  return {
    registerRef,
    fieldError,
    applyError,
    setBanner,
    clear,
  }
}
