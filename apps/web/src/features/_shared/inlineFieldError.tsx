import { useCallback, useRef, useState } from 'react'
import type { RefCallback } from 'react'
import { cn } from '@/lib/utils'
import { classifyMutationError } from './errorSurface'

/**
 * REL-5g — shared primitives for inline-field-error rendering + focus
 * routing. Consolidates the boilerplate that REL-5d/e/f/4c/4d sprinkled
 * across ProfilStub, SignupPage, RecipeFormPage + the Sortable rows:
 *
 *   1. a ref-map keyed by the backend-emitted `fieldName`;
 *   2. a `{fieldName, message}` state slice;
 *   3. aria-invalid / aria-describedby / `<p role="alert">` wiring;
 *   4. `classifyMutationError → focus + scrollIntoView + setState`.
 *
 * Split into:
 *
 *   - `<InlineFieldError>` — a view component. The caller owns the
 *     message and the id; we guarantee the aria + testid shape stays
 *     consistent across every form. Renders nothing when `message` is
 *     null so callers can mount it unconditionally.
 *
 *   - `useFieldErrorFocus<T>()` — a hook for forms that want the full
 *     focus-routing pipeline. Exposes:
 *       · `registerRef(fieldName)` — returns a RefCallback that stashes
 *         the element under the given key.
 *       · `registerNestedRef(section, index, prop)` — variant for the
 *         REL-4d nested-path pattern (`ingredients[i].amount`).
 *       · `fieldError` + `rowError` — state slices for top-level vs
 *         nested matches. Either may be non-null; the caller renders
 *         the matching `<InlineFieldError>` next to the right input.
 *       · `applyError(err)` — classify + route. Returns `true` when a
 *         field-level match was found (focus + state set) so the caller
 *         can short-circuit its fallback banner. When no match exists,
 *         the classified message still lands in `fieldError.fieldName
 *         === null` so single-slice forms (PasswordCard / Signup) keep
 *         one state shape for both surfaces.
 *       · `clear()` — reset both slices. Call on submit-start / input-
 *         change.
 *
 * The hook is generic over the element type so a form can mix input,
 * textarea, select, and `<div tabIndex=-1>` refs under one map without
 * losing the type narrow at the call-sites. T defaults to HTMLElement —
 * which covers every focusable surface — but individual rows can pin T
 * tighter (HTMLInputElement) for autocomplete.
 *
 * Design trade-offs:
 *   - We call `classifyMutationError` inside `applyError` rather than
 *     asking the caller to pre-classify. This keeps the hook a drop-in
 *     replacement for the hand-rolled `onError` path and means we don't
 *     leak the classifier's imports into components that don't use it.
 *   - `scrollIntoView` + `focus()` live in the hook, not the component.
 *     Motion prefers-reduced-motion is not checked — every existing
 *     call-site already scrolled. If we ever honour `prefers-reduced-
 *     motion`, the change lands here in one place.
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

export interface NestedFieldPath {
  section: string
  index: number
  prop: string
}

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

export interface RowErrorState extends NestedFieldPath {
  message: string
}

export interface UseFieldErrorFocusOptions {
  /**
   * REL-4d — optional parser for nested `fieldName` strings like
   * `ingredients[2].amount`. When provided, `applyError` first tries
   * the nested path; if the parser returns non-null AND a ref was
   * registered via `registerNestedRef`, we route there. If the parser
   * returns null (bare top-level name) we fall back to the flat
   * ref-map. Passing nothing means nested names never match.
   */
  parsePath?: (fieldName: string) => NestedFieldPath | null
}

export interface UseFieldErrorFocusReturn<T extends HTMLElement> {
  registerRef: (fieldName: string) => RefCallback<T>
  registerNestedRef: (
    section: string,
    index: number,
    prop: string,
  ) => RefCallback<T>
  fieldError: FieldErrorState | null
  rowError: RowErrorState | null
  applyError: (err: unknown) => boolean
  clear: () => void
}

export function useFieldErrorFocus<
  T extends HTMLElement = HTMLElement,
>(
  options: UseFieldErrorFocusOptions = {},
): UseFieldErrorFocusReturn<T> {
  const { parsePath } = options
  const fieldRefs = useRef<Record<string, T | null>>({})
  // Nested refs: keyed first by section ("ingredients"/"steps"), then
  // by row index, then by prop name. Three levels mirror the REL-4d
  // nested-path parser so lookup + path-parse stay symmetric.
  const nestedRefs = useRef<
    Record<string, Record<number, Record<string, T | null | undefined>>>
  >({})

  const [fieldError, setFieldError] = useState<FieldErrorState | null>(null)
  const [rowError, setRowError] = useState<RowErrorState | null>(null)

  const registerRef = useCallback(
    (fieldName: string): RefCallback<T> =>
      (el) => {
        fieldRefs.current[fieldName] = el
      },
    [],
  )

  const registerNestedRef = useCallback(
    (section: string, index: number, prop: string): RefCallback<T> =>
      (el) => {
        const bySection = (nestedRefs.current[section] ??= {})
        const byIndex = (bySection[index] ??= {})
        byIndex[prop] = el
      },
    [],
  )

  const clear = useCallback(() => {
    setFieldError(null)
    setRowError(null)
  }, [])

  const applyError = useCallback(
    (err: unknown): boolean => {
      const classified = classifyMutationError(err)
      const name = classified.fieldName

      // Nested path first — the backend addresses the exact row, and an
      // out-of-range row silently falls through to the flat map / banner.
      if (name && parsePath) {
        const parsed = parsePath(name)
        if (parsed) {
          const target =
            nestedRefs.current[parsed.section]?.[parsed.index]?.[parsed.prop]
          if (target) {
            setRowError({ ...parsed, message: classified.message })
            setFieldError(null)
            target.focus()
            target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
            return true
          }
        }
      }

      // Flat top-level match.
      if (name) {
        const target = fieldRefs.current[name]
        if (target) {
          setFieldError({ fieldName: name, message: classified.message })
          setRowError(null)
          target.focus()
          target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
          return true
        }
      }

      // No field match — expose the classified copy as a banner slice so
      // single-state forms can render one `<InlineFieldError>` without
      // branching on two state variables. The caller can still check
      // `fieldError.fieldName === null` to render a full-width banner.
      setFieldError({ fieldName: null, message: classified.message })
      setRowError(null)
      return false
    },
    [parsePath],
  )

  return {
    registerRef,
    registerNestedRef,
    fieldError,
    rowError,
    applyError,
    clear,
  }
}
