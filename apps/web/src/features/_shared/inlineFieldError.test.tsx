/**
 * REL-5g — unit tests for the shared inline-field-error primitives.
 *
 * Two pieces under test:
 *
 *   - `<InlineFieldError>` — renders a `<p role="alert" aria-live>` with
 *     a stable id so the companion input's `aria-describedby` resolves.
 *     The component is a thin view; its job is to keep the aria wiring
 *     consistent across all forms (ProfilStub / Signup / RecipeFormPage
 *     / Sortable rows), not to manage state.
 *
 *   - `useFieldErrorFocus()` — manages (a) a ref-map keyed by
 *     backend-emitted `fieldName`, (b) the current `{fieldName, message}`
 *     state, and (c) an `applyError(err)` call that classifies the error
 *     and — when the backend tagged a known field — focuses the matching
 *     input and scrolls it into view. `applyError` returns `true` when
 *     a field-level match was found so the caller can short-circuit the
 *     fallback banner path.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { InlineFieldError, useFieldErrorFocus } from './inlineFieldError'

describe('<InlineFieldError>', () => {
  it('renders the message inside an alert role', () => {
    render(<InlineFieldError id="x-error" message="Ungültiger Wert." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Ungültiger Wert.')
  })

  it('exposes the provided id so aria-describedby can reference it', () => {
    render(<InlineFieldError id="my-error" message="Nope." />)
    const alert = screen.getByRole('alert')
    expect(alert.id).toBe('my-error')
  })

  it('returns null when message is null (no dangling alert node)', () => {
    const { container } = render(
      <InlineFieldError id="x-error" message={null} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('attaches the optional data-testid when supplied', () => {
    render(
      <InlineFieldError
        id="x-error"
        message="Boom."
        testId="recipe-form-title-error"
      />,
    )
    expect(screen.getByTestId('recipe-form-title-error')).toBeInTheDocument()
  })
})

describe('useFieldErrorFocus', () => {
  it('applyError with a matching field sets fieldError state and focuses the input', () => {
    // Prove the behaviour with a real DOM input so `focus()` actually
    // shifts document.activeElement — otherwise the test would pass even
    // if the hook silently dropped the focus step.
    const input = document.createElement('input')
    input.id = 'display-name'
    // scrollIntoView is unimplemented in jsdom — stub it so the hook's
    // optional call doesn't crash the test.
    input.scrollIntoView = vi.fn()
    document.body.appendChild(input)

    const { result } = renderHook(() => useFieldErrorFocus<HTMLInputElement>())
    act(() => {
      result.current.registerRef('displayName')(input)
    })

    let matched = false
    act(() => {
      matched = result.current.applyError({
        code: 'invalid_value',
        message: 'Name zu kurz.',
        status: 400,
        fieldName: 'displayName',
      })
    })

    expect(matched).toBe(true)
    expect(result.current.fieldError).toEqual({
      fieldName: 'displayName',
      message: expect.any(String),
    })
    expect(document.activeElement).toBe(input)
    document.body.removeChild(input)
  })

  it('applyError without a field match returns false and still stores the banner state', () => {
    const { result } = renderHook(() => useFieldErrorFocus<HTMLInputElement>())

    let matched = true
    act(() => {
      // 500 → classifier emits toast surface, no fieldName. applyError
      // must report "not matched" so the caller routes to the banner.
      matched = result.current.applyError({
        code: 'http_500',
        message: 'Server down.',
        status: 500,
      })
    })

    expect(matched).toBe(false)
    // The hook still exposes the classified message as the banner copy
    // via `fieldError.fieldName === null`, so single-surface call-sites
    // (PasswordCard, Signup) can keep using one state slice.
    expect(result.current.fieldError).toEqual({
      fieldName: null,
      message: expect.any(String),
    })
  })

  it('applyError with a pathParser routes a nested fieldName to the registered sub-ref', () => {
    const input = document.createElement('input')
    input.scrollIntoView = vi.fn()
    document.body.appendChild(input)

    const parsePath = (name: string) => {
      const m = name.match(/^(\w+)\[(\d+)\]\.(\w+)$/)
      if (!m) return null
      return { section: m[1]!, index: Number(m[2]), prop: m[3]! }
    }

    const { result } = renderHook(() =>
      useFieldErrorFocus<HTMLInputElement>({ parsePath }),
    )

    act(() => {
      result.current.registerNestedRef('ingredients', 2, 'amount')(input)
    })

    let matched = false
    act(() => {
      matched = result.current.applyError({
        code: 'invalid_value',
        message: 'Menge ungültig.',
        status: 400,
        fieldName: 'ingredients[2].amount',
      })
    })

    expect(matched).toBe(true)
    expect(result.current.rowError).toEqual({
      section: 'ingredients',
      index: 2,
      prop: 'amount',
      message: expect.any(String),
    })
    expect(document.activeElement).toBe(input)
    document.body.removeChild(input)
  })

  it('setBanner() stores a banner message with fieldName=null bypassing the classifier', () => {
    const { result } = renderHook(() => useFieldErrorFocus<HTMLInputElement>())

    act(() => {
      result.current.setBanner('Bitte E-Mail eingeben.')
    })

    expect(result.current.fieldError).toEqual({
      fieldName: null,
      message: 'Bitte E-Mail eingeben.',
    })
    expect(result.current.rowError).toBeNull()
  })

  it('clear() resets fieldError and rowError', () => {
    const { result } = renderHook(() => useFieldErrorFocus<HTMLInputElement>())

    act(() => {
      result.current.applyError({
        code: 'http_500',
        message: 'Boom.',
        status: 500,
      })
    })
    expect(result.current.fieldError).not.toBeNull()

    act(() => {
      result.current.clear()
    })
    expect(result.current.fieldError).toBeNull()
    expect(result.current.rowError).toBeNull()
  })
})
