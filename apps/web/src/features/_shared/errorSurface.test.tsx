/**
 * REL-5 — unit tests for the cross-app error-surface primitives.
 *
 * Three orthogonal surfaces, one module:
 *
 *   - `showErrorToast(message)` — enqueues a transient toast string on a
 *     process-wide singleton store. `<ErrorToastHost />` is mounted once
 *     at the app root and renders the current queue as dismissible
 *     toasts. The toast store is deliberately framework-agnostic (plain
 *     subscribe/getSnapshot) so any mutation hook can poke it from a
 *     non-component context — avoids the "must-be-inside-provider"
 *     headache that bit us during BUG-044.
 *
 *   - `<ErrorBanner message onDismiss />` — inline primitive for the
 *     stay-on-the-page error surface (version-mismatch / partial-save /
 *     revalidation-required). Not a singleton; each page owns its own
 *     instance near the affected content.
 *
 *   - `classifyMutationError(err)` — pure helper; feeds the above two.
 *     Decides whether an `ApiError`-shaped throwable should turn into a
 *     toast, a banner, or an inline field error (when the backend
 *     tagged a specific field via the `code` conventions in
 *     REL-4-preparation).
 *
 * Co-located with the primitives. MSW isn't touched here — every test
 * in this file runs against a pure React + jsdom tree. The E2E spec
 * lives in `apps/web/e2e/error-surface.spec.ts`.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ErrorBanner,
  ErrorToastHost,
  classifyMutationError,
  clearAllErrorToasts,
  showErrorToast,
} from './errorSurface'

beforeEach(() => {
  // The store is a module-level singleton so tests must reset it
  // between cases. Otherwise the queue from the previous test would
  // leak into the next render.
  clearAllErrorToasts()
})

describe('showErrorToast + ErrorToastHost', () => {
  it('renders the toast message when showErrorToast is called', () => {
    render(<ErrorToastHost />)
    act(() => {
      showErrorToast('Speichern fehlgeschlagen.')
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Speichern fehlgeschlagen.',
    )
  })

  it('removes the toast when the user hits the close button', async () => {
    const user = userEvent.setup()
    render(<ErrorToastHost />)
    act(() => {
      showErrorToast('Fehler beim Speichern.')
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toBeInTheDocument()
    const close = screen.getByRole('button', { name: /schließen/i })
    await user.click(close)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('positions the toast container above the BottomNav safe-area on mobile', () => {
    // BUG-039 / layout-token regression guard — the toast must live above
    // the `--bottom-nav-height` variable and the home-indicator safe
    // area, not below. The simplest way to assert this without a
    // headless-browser layout check is to look for the tailwind-
    // generated class with `env(safe-area-inset-bottom` in the className.
    // Good enough as a regression signal — if someone accidentally
    // drops the safe-area token the class disappears and this fails.
    render(<ErrorToastHost />)
    act(() => {
      showErrorToast('Position-Check.')
    })
    const container = screen.getByTestId('error-toast-host')
    // Look for the safe-area-inset-bottom reference — className on the
    // fixed overlay pins the toast above BOTH the BottomNav and the
    // home-indicator area.
    expect(container.className).toContain('safe-area-inset-bottom')
  })
})

describe('ErrorBanner', () => {
  it('renders the message inside an alert role', () => {
    render(<ErrorBanner message="Jemand anderes hat das bearbeitet." />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Jemand anderes hat das bearbeitet.',
    )
  })

  it('calls onDismiss when the close button is clicked', async () => {
    const user = userEvent.setup()
    let dismissed = false
    render(
      <ErrorBanner
        message="Konflikt."
        onDismiss={() => {
          dismissed = true
        }}
      />,
    )
    const close = screen.getByRole('button', { name: /schließen/i })
    await user.click(close)
    expect(dismissed).toBe(true)
  })

  it('omits the close button when onDismiss is not provided', () => {
    render(<ErrorBanner message="Nicht dismissbar." />)
    expect(screen.queryByRole('button', { name: /schließen/i })).toBeNull()
  })
})

describe('classifyMutationError', () => {
  it('routes server-validation 400 codes to the inline surface', () => {
    const result = classifyMutationError({
      code: 'invalid_value',
      message: 'Portionen müssen > 0 sein.',
      status: 400,
    })
    expect(result.surface).toBe('inline')
    expect(result.message).toBe('Portionen müssen > 0 sein.')
  })

  it('routes 409 version_mismatch to the banner surface with reload copy', () => {
    const result = classifyMutationError({
      code: 'version_mismatch',
      message: 'Version conflict.',
      status: 409,
    })
    expect(result.surface).toBe('banner')
    // German copy replaces the English backend message — the backend
    // returns a machine identifier we translate here into something the
    // user can action.
    expect(result.message).toMatch(/bearbeitet/i)
    expect(result.message).toMatch(/laden/i)
  })

  it('routes 500 / network / unknown errors to the toast surface', () => {
    const result = classifyMutationError({
      code: 'http_500',
      message: 'Internal Server Error',
      status: 500,
    })
    expect(result.surface).toBe('toast')
    expect(result.message).toMatch(/unbekannt/i)
  })

  it('routes a thrown native Error (network-layer) to the toast surface', () => {
    const result = classifyMutationError(new Error('NetworkError when attempting to fetch'))
    expect(result.surface).toBe('toast')
    expect(result.message).toMatch(/verbindung|netzwerk|unbekannt/i)
  })

  it('does NOT leak raw backend messages into the 500 toast copy', () => {
    // Security: a 500 body might contain stack-traces / SQL fragments.
    // The toast must show a generic German string, not the raw backend
    // message.
    const result = classifyMutationError({
      code: 'http_500',
      message: "SqlException: syntax error at 'DROP TABLE users'",
      status: 500,
    })
    expect(result.surface).toBe('toast')
    expect(result.message).not.toMatch(/SqlException|DROP TABLE|users/)
  })
})
