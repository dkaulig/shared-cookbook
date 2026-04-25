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
    // REL-3e — the classifier prefers the `errors.json` translation
    // over the raw backend message when the code is known. The rawest
    // backend copy is only a fallback when no translation exists
    // (covered in the separate test below).
    expect(result.message).toBe('Ungültiger Wert.')
  })

  it('falls back to the raw backend message on inline 400 when the code has no errors.json entry', () => {
    // Mirror of the test above, but with a code the errors.json
    // catalog does not contain. The rawMessage is then preserved so
    // the user still sees something actionable.
    const result = classifyMutationError({
      code: 'zz_no_such_code_in_catalog',
      message: 'Backend-spezifischer Hinweis.',
      status: 400,
    })
    expect(result.surface).toBe('inline')
    expect(result.message).toBe('Backend-spezifischer Hinweis.')
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

  it('surfaces the REL-4 fieldName on 400 validation errors (inline path)', () => {
    // REL-4: BadRequest() now serialises `{ code, message, status: 400,
    // fieldName: "servings" }`. The classifier must expose the field
    // name so form call-sites can place the inline error directly under
    // the affected input instead of as a page-level banner.
    const result = classifyMutationError({
      code: 'invalid_value',
      message: 'Portionen müssen > 0 sein.',
      status: 400,
      fieldName: 'servings',
    })
    expect(result.surface).toBe('inline')
    expect(result.fieldName).toBe('servings')
  })

  it('omits fieldName when the backend did not tag a specific field', () => {
    const result = classifyMutationError({
      code: 'invalid_value',
      message: 'Irgendwas ist ungültig.',
      status: 400,
    })
    expect(result.surface).toBe('inline')
    expect(result.fieldName).toBeUndefined()
  })

  it('reads HTTP status directly from the body status field (no code heuristic)', () => {
    // REL-4 always emits `status` in the body. The classifier must
    // route based on that number, not reverse-engineer it from a
    // code string like "server_error" / "internal_error". Here we
    // pass a non-matching code WITH status=500 and expect the 500
    // path (toast).
    const result = classifyMutationError({
      code: 'some_future_code_we_cannot_predict',
      message: 'Backend explodiert.',
      status: 500,
    })
    expect(result.surface).toBe('toast')
    expect(result.message).toMatch(/unbekannt/i)
  })

  it('does NOT classify a bare "server_error" / "internal_error" code string as 500', () => {
    // REL-5's defensive heuristic assumed a missing status but the
    // code string "server_error" still meant 5xx. REL-4 makes `status`
    // authoritative — a 400 body with a weird code must stay a 400
    // (inline), not bump up to a 500 toast via the string match.
    const result = classifyMutationError({
      code: 'server_error',
      message: 'Irgendwas ist ungültig.',
      status: 400,
    })
    expect(result.surface).toBe('inline')
  })

  it('treats a missing status as unknown — no reverse-engineering from code', () => {
    // REL-4 guarantees `status` in every ApiError body. If we see an
    // error without it, something's wrong at a lower layer and we
    // must NOT guess a status from the `code` string (the removed
    // parseHttpStatusFromCode heuristic). The classifier falls
    // through to the inline branch and looks up the `errors.json`
    // translation; the key assertion is that the surface is NOT the
    // 5xx `toast` bucket (the "status must drive routing, not code
    // string" invariant).
    const result = classifyMutationError({
      code: 'server_error',
      message: 'No status field.',
    })
    expect(result.surface).toBe('inline')
    // Route by `status`, not by code heuristic — a missing status
    // with a 5xx-ish code must NOT land on the toast surface.
    expect(result.surface).not.toBe('toast')
  })

  it('still routes a native Error (no body, no status) to the toast surface', () => {
    // Networks errors never carry a status. They must stay in the
    // "unknown / network" bucket, not be heuristically bumped to 500.
    const result = classifyMutationError(new Error('Failed to fetch'))
    expect(result.surface).toBe('toast')
    expect(result.fieldName).toBeUndefined()
  })

  it('SMALL-1b prioritises errors:<code> translation over the generic 401-forbidden copy', () => {
    // A 401 with a known code (e.g. `invalid_credentials` from /auth/login)
    // must surface the localised `errors:<code>` copy, not the generic
    // "Fehlende Berechtigung. Bitte neu anmelden …" forbidden text. This
    // lets call-sites use `classifyMutationError` directly without a
    // bespoke 401 fall-through (the bespoke LoginPage path from REL-3f
    // becomes unnecessary once this priority lands).
    const result = classifyMutationError({
      code: 'invalid_credentials',
      message: 'Invalid credentials.',
      status: 401,
    })
    expect(result.message).toMatch(/E-Mail oder Passwort/i)
    expect(result.message).not.toMatch(/Fehlende Berechtigung/i)
  })

  it('SMALL-1b 403 with a known code surfaces the errors:<code> copy too', () => {
    // Symmetry with the 401 path — if the backend tagged a 403 with a
    // user-actionable code (e.g. a future `quota_exceeded`), the
    // localised translation wins over the generic forbidden text.
    const result = classifyMutationError({
      code: 'invalid_credentials',
      message: 'Invalid credentials.',
      status: 403,
    })
    expect(result.message).toMatch(/E-Mail oder Passwort/i)
  })

  it('SMALL-1b unknown 401 codes still fall back to the generic forbidden toast', () => {
    // Defensive: an unknown code on 401 must NOT crash the classifier —
    // it falls back to the generic forbidden copy on the toast surface,
    // which is the safe default for an authn race / auth-layer redirect
    // miss.
    const result = classifyMutationError({
      code: 'zz_no_such_code',
      message: 'whatever',
      status: 401,
    })
    expect(result.surface).toBe('toast')
    expect(result.message).toMatch(/Fehlende Berechtigung/i)
  })

  it('SMALL-1b 401 without a code stays on the generic forbidden toast', () => {
    const result = classifyMutationError({
      message: 'no code',
      status: 401,
    })
    expect(result.surface).toBe('toast')
    expect(result.message).toMatch(/Fehlende Berechtigung/i)
  })
})
