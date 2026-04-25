import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ProfilePage } from './ProfilePage'

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/profil']}>
          <Routes>
            <Route path="/profil" element={children} />
            <Route path="/login" element={<div data-testid="login">login</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ProfilePage />, { wrapper: Wrapper })
}

describe('<ProfilePage />', () => {
  // REL-3e — i18n is bootstrapped globally in `src/test/setup.ts`
  // (pinned to `de`), so no per-file init is needed.

  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'test@example.com',
      displayName: 'David',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the serif-typeset heading "Mein Profil"', () => {
    renderPage()
    const heading = screen.getByRole('heading', { level: 1, name: /mein profil/i })
    expect(heading).toBeInTheDocument()
    expect(heading.className).toMatch(/font-serif/)
  })

  it('shows the signed-in display name and email', () => {
    renderPage()
    // The displayName "David" + the email "test@example.com" both match
    // /david/i, so pin each with a distinct matcher.
    expect(screen.getByText('David')).toBeInTheDocument()
    expect(screen.getByText('test@example.com')).toBeInTheDocument()
  })

  it('no longer shows the Phase-3 teaser copy', () => {
    renderPage()
    expect(screen.queryByText(/kommen in Phase 3/i)).not.toBeInTheDocument()
  })

  it('does not show the admin KI-Verbrauch link for regular users', () => {
    renderPage()
    expect(
      screen.queryByRole('link', { name: /KI-Verbrauch einsehen/i }),
    ).toBeNull()
  })

  it('shows the admin KI-Verbrauch link for admins pointing at /admin/ai-usage', () => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'admin@ex.com',
      displayName: 'Admin',
      role: 'Admin',
    })
    renderPage()
    const link = screen.getByRole('link', { name: /KI-Verbrauch einsehen/i })
    expect(link).toHaveAttribute('href', '/admin/ai-usage')
  })

  it('shows the Extractor-Config link for admins pointing at /admin/extractor', () => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'admin@ex.com',
      displayName: 'Admin',
      role: 'Admin',
    })
    renderPage()
    const link = screen.getByRole('link', {
      name: /Extractor-Konfiguration/i,
    })
    expect(link).toHaveAttribute('href', '/admin/extractor')
  })

  it('does not show the Extractor-Config link for regular users', () => {
    renderPage()
    expect(
      screen.queryByRole('link', { name: /Extractor-Konfiguration/i }),
    ).toBeNull()
  })

  it('shows the Abmelden button and clears auth state when clicked', async () => {
    server.use(http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })))
    renderPage()

    const user = userEvent.setup()
    const logout = screen.getByRole('button', { name: /abmelden/i })
    await user.click(logout)

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
    })
  })

  it('opens the InviteDialog when "Jemanden einladen" is clicked', async () => {
    renderPage()
    const user = userEvent.setup()

    expect(screen.queryByRole('dialog', { name: /jemanden einladen/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /jemanden einladen/i }))

    const dialog = await screen.findByRole('dialog', { name: /jemanden einladen/i })
    expect(dialog).toBeInTheDocument()
  })

  // ── REL-3h language section ──────────────────────────────────────

  describe('language section (REL-3h)', () => {
    it('renders a "Sprache"-Card with heading and description on /profil', () => {
      renderPage()
      // Heading: the Card title — exact match, not ambiguous with the
      // toggle's aria-label which is also "Sprache".
      expect(
        screen.getByRole('heading', { level: 3, name: /^sprache$/i }),
      ).toBeInTheDocument()
      expect(
        screen.getByText(/lokal auf diesem gerät gespeichert/i),
      ).toBeInTheDocument()
    })

    it('renders the LanguageToggle trigger inside the section', () => {
      renderPage()
      // The toggle renders a button with aria-label "Sprache" — this is
      // the only button in the Profil-page whose a11y name matches.
      expect(
        screen.getByRole('button', { name: /^sprache$/i }),
      ).toBeInTheDocument()
    })

    it('clicking the toggle opens a DE/EN dropdown menu', async () => {
      renderPage()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: /^sprache$/i }))
      const menu = await screen.findByRole('menu', { name: /sprache/i })
      expect(menu).toBeInTheDocument()
      // Both DE + EN options present as menuitemradio entries.
      expect(
        screen.getByRole('menuitemradio', { name: /deutsch/i }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('menuitemradio', { name: /english/i }),
      ).toBeInTheDocument()
    })
  })

  // ── Displayname inline-edit ─────────────────────────────────────

  describe('displayname inline-edit', () => {
    it('exposes a pencil button with an accessible name', () => {
      renderPage()
      expect(
        screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }),
      ).toBeInTheDocument()
    })

    it('clicking the pencil shows an input prefilled with the current name', async () => {
      renderPage()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }))

      const input = await screen.findByLabelText(/anzeigename/i)
      expect(input).toHaveValue('David')
    })

    it('saves a new name, PATCHes with the trimmed value, updates the store and exits edit mode', async () => {
      let capturedBody: unknown = null
      server.use(
        http.patch('/api/account/display-name', async ({ request }) => {
          capturedBody = await request.json()
          return HttpResponse.json({
            id: 'u1',
            email: 'test@example.com',
            displayName: 'Dave',
            role: 'User',
          })
        }),
      )
      renderPage()
      const user = userEvent.setup()

      await user.click(screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }))

      const input = await screen.findByLabelText(/anzeigename/i)
      await user.clear(input)
      await user.type(input, '  Dave  ')
      await user.click(screen.getByRole('button', { name: /speichern/i }))

      await waitFor(() => {
        expect(capturedBody).toEqual({ displayName: 'Dave' })
      })
      await waitFor(() => {
        expect(useAuthStore.getState().user?.displayName).toBe('Dave')
      })
      // Edit mode exited — the text <input> is gone (pencil-button aria-label
      // also contains "Anzeigename" so we match by role + type instead).
      await waitFor(() => {
        expect(screen.queryByRole('textbox', { name: /anzeigename/i })).not.toBeInTheDocument()
      })
    })

    it('disables Speichern with a 1-char name and shows an inline hint', async () => {
      renderPage()
      const user = userEvent.setup()

      await user.click(screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }))
      const input = await screen.findByLabelText(/anzeigename/i)
      await user.clear(input)
      await user.type(input, 'A')

      const save = screen.getByRole('button', { name: /speichern/i })
      expect(save).toBeDisabled()
      expect(screen.getByText(/2 und 50 Zeichen/i)).toBeInTheDocument()
    })

    it('cancel exits edit mode without PATCHing', async () => {
      let patchCalls = 0
      server.use(
        http.patch('/api/account/display-name', () => {
          patchCalls += 1
          return HttpResponse.json({
            id: 'u1',
            email: 'test@example.com',
            displayName: 'Other',
            role: 'User',
          })
        }),
      )
      renderPage()
      const user = userEvent.setup()

      await user.click(screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }))
      await user.click(screen.getByRole('button', { name: /abbrechen/i }))

      expect(patchCalls).toBe(0)
      expect(screen.queryByRole('textbox', { name: /anzeigename/i })).not.toBeInTheDocument()
      expect(useAuthStore.getState().user?.displayName).toBe('David')
    })

    it('shows an inline error on server 400', async () => {
      // REL-5d: the rendered copy now comes from the `errors:*` i18n
      // namespace keyed by the backend `code`, not the server message.
      // A 400 without `fieldName` stays inline (banner at bottom) but
      // the displayed text is translated to German via i18n.
      server.use(
        http.patch('/api/account/display-name', () =>
          HttpResponse.json(
            {
              code: 'displayname_invalid',
              message: 'Display name is invalid.',
              status: 400,
            },
            { status: 400 },
          ),
        ),
      )
      renderPage()
      const user = userEvent.setup()

      await user.click(screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }))
      const input = await screen.findByLabelText(/anzeigename/i)
      await user.clear(input)
      await user.type(input, 'Gueltig')
      await user.click(screen.getByRole('button', { name: /speichern/i }))

      const alert = await screen.findByRole('alert')
      // Translation from errors:displayname_invalid (de locale).
      expect(alert).toHaveTextContent(/Anzeigename ist ungültig/i)
    })
  })

  // ── Passwort ändern card ─────────────────────────────────────────

  describe('Password change card', () => {
    function passwordCard() {
      const heading = screen.getByRole('heading', { name: /passwort ändern/i })
      const card = heading.closest('[class*="card" i]') ?? heading.parentElement!.parentElement!
      return within(card as HTMLElement)
    }

    it('renders three password fields inside the "Passwort ändern" card', () => {
      renderPage()
      const card = passwordCard()
      expect(card.getByLabelText(/aktuelles passwort/i)).toBeInTheDocument()
      expect(card.getByLabelText(/^neues passwort$/i)).toBeInTheDocument()
      expect(card.getByLabelText(/neues passwort bestätigen/i)).toBeInTheDocument()
    })

    it('keeps the submit button disabled until all fields are filled, match, and differ from current', async () => {
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      const submit = card.getByRole('button', { name: /passwort ändern/i })
      expect(submit).toBeDisabled()

      const current = card.getByLabelText(/aktuelles passwort/i)
      const next = card.getByLabelText(/^neues passwort$/i)
      const confirm = card.getByLabelText(/neues passwort bestätigen/i)

      await user.type(current, 'AltesPasswort1!')
      expect(submit).toBeDisabled()
      await user.type(next, 'NeuesPasswort1!')
      expect(submit).toBeDisabled()
      await user.type(confirm, 'MismatchPasswort1!')
      expect(submit).toBeDisabled()

      await user.clear(confirm)
      await user.type(confirm, 'NeuesPasswort1!')
      expect(submit).toBeEnabled()

      // new == current → disabled
      await user.clear(next)
      await user.clear(confirm)
      await user.type(next, 'AltesPasswort1!')
      await user.type(confirm, 'AltesPasswort1!')
      expect(submit).toBeDisabled()
    })

    it('happy path: POSTs and shows a confirmation, clears fields', async () => {
      let capturedBody: unknown = null
      server.use(
        http.post('/api/account/change-password', async ({ request }) => {
          capturedBody = await request.json()
          return new HttpResponse(null, { status: 204 })
        }),
      )
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      await user.type(card.getByLabelText(/aktuelles passwort/i), 'AltesPasswort1!')
      await user.type(card.getByLabelText(/^neues passwort$/i), 'NeuesPasswort1!')
      await user.type(card.getByLabelText(/neues passwort bestätigen/i), 'NeuesPasswort1!')
      await user.click(card.getByRole('button', { name: /passwort ändern/i }))

      await waitFor(() => {
        expect(capturedBody).toEqual({
          currentPassword: 'AltesPasswort1!',
          newPassword: 'NeuesPasswort1!',
          newPasswordConfirm: 'NeuesPasswort1!',
        })
      })
      expect(await card.findByText(/Passwort aktualisiert/i)).toBeInTheDocument()

      // Fields cleared.
      expect(card.getByLabelText(/aktuelles passwort/i)).toHaveValue('')
      expect(card.getByLabelText(/^neues passwort$/i)).toHaveValue('')
      expect(card.getByLabelText(/neues passwort bestätigen/i)).toHaveValue('')
    })

    it('wrong-current 401 surfaces as an inline fallback banner (not success)', async () => {
      // SMALL-1b: 401 responses go through `classifyMutationError` which
      // now prefers the `errors:<code>` translation over the generic
      // forbidden copy when the backend tagged a known code. For
      // `invalid_credentials` that's "E-Mail oder Passwort ist nicht
      // korrekt." — same surface (banner / toast), more useful copy.
      // The form still shows the fallback banner (fieldName is null —
      // server didn't attribute to a field) so the user sees SOME
      // error even if the toast is missed.
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            {
              code: 'invalid_credentials',
              message: 'Current password is incorrect.',
              status: 401,
            },
            { status: 401 },
          ),
        ),
      )
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      await user.type(card.getByLabelText(/aktuelles passwort/i), 'WrongOld1!')
      await user.type(card.getByLabelText(/^neues passwort$/i), 'NeuesPasswort1!')
      await user.type(card.getByLabelText(/neues passwort bestätigen/i), 'NeuesPasswort1!')
      await user.click(card.getByRole('button', { name: /passwort ändern/i }))

      // Fallback banner shows the localised invalid_credentials copy.
      const alert = await card.findByRole('alert')
      expect(alert).toHaveTextContent(/E-Mail oder Passwort ist nicht korrekt/i)
      expect(card.queryByText(/Passwort aktualisiert/i)).not.toBeInTheDocument()
    })

    it('a client-side confirm mismatch keeps submit disabled and never hits the network', async () => {
      let calls = 0
      server.use(
        http.post('/api/account/change-password', () => {
          calls += 1
          return new HttpResponse(null, { status: 204 })
        }),
      )
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      await user.type(card.getByLabelText(/aktuelles passwort/i), 'AltesPasswort1!')
      await user.type(card.getByLabelText(/^neues passwort$/i), 'NeuesPasswort1!')
      await user.type(card.getByLabelText(/neues passwort bestätigen/i), 'MismatchPasswort1!')

      const submit = card.getByRole('button', { name: /passwort ändern/i })
      expect(submit).toBeDisabled()
      expect(calls).toBe(0)
      expect(
        card.getByText(/stimmen nicht überein/i),
      ).toBeInTheDocument()
    })

    // ── REL-5d inline field-focus ─────────────────────────────────
    it('focuses the newPassword field + renders the inline error under it when backend tags fieldName=newPassword', async () => {
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            {
              code: 'password_rejected',
              message: 'Password does not meet the policy.',
              status: 400,
              fieldName: 'newPassword',
            },
            { status: 400 },
          ),
        ),
      )
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      await user.type(card.getByLabelText(/aktuelles passwort/i), 'AltesPasswort1!')
      await user.type(card.getByLabelText(/^neues passwort$/i), 'Schwach1!')
      await user.type(
        card.getByLabelText(/neues passwort bestätigen/i),
        'Schwach1!',
      )
      await user.click(card.getByRole('button', { name: /passwort ändern/i }))

      const newPwd = card.getByLabelText(/^neues passwort$/i)
      await waitFor(() => expect(newPwd).toHaveFocus())
      // The error sits next to the affected input, aria-linked via
      // aria-describedby so screen-readers announce it when focus lands.
      const describedBy = newPwd.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      const fieldError = card
        .getByText(/Passwort wurde abgelehnt/i)
        .closest('p, div')
      expect(fieldError?.id).toBe(describedBy)
      // REL-3 i18n path: the rendered copy comes from `errors:password_rejected`
      // (German translation), not the server-supplied English text.
      expect(card.queryByText(/does not meet the policy/i)).toBeNull()
    })

    it('focuses the confirm field when backend tags fieldName=newPasswordConfirm', async () => {
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            {
              code: 'password_mismatch',
              message: 'New password and confirmation do not match.',
              status: 400,
              fieldName: 'newPasswordConfirm',
            },
            { status: 400 },
          ),
        ),
      )
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      await user.type(card.getByLabelText(/aktuelles passwort/i), 'AltesPasswort1!')
      await user.type(card.getByLabelText(/^neues passwort$/i), 'NeuesPasswort1!')
      await user.type(
        card.getByLabelText(/neues passwort bestätigen/i),
        'NeuesPasswort1!',
      )
      await user.click(card.getByRole('button', { name: /passwort ändern/i }))

      const confirm = card.getByLabelText(/neues passwort bestätigen/i)
      await waitFor(() => expect(confirm).toHaveFocus())
    })

    it('falls back to a banner when the server emits no fieldName', async () => {
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            {
              code: 'invalid_credentials',
              message: 'Current password is incorrect.',
              status: 401,
            },
            { status: 401 },
          ),
        ),
      )
      renderPage()
      const user = userEvent.setup()
      const card = passwordCard()

      await user.type(card.getByLabelText(/aktuelles passwort/i), 'WrongOld1!')
      await user.type(card.getByLabelText(/^neues passwort$/i), 'NeuesPasswort1!')
      await user.type(
        card.getByLabelText(/neues passwort bestätigen/i),
        'NeuesPasswort1!',
      )
      await user.click(card.getByRole('button', { name: /passwort ändern/i }))

      // No fieldName → neither password input should receive focus.
      const newPwd = card.getByLabelText(/^neues passwort$/i)
      const confirm = card.getByLabelText(/neues passwort bestätigen/i)
      // Wait for any mutation state to settle.
      await card.findByRole('alert')
      expect(newPwd).not.toHaveFocus()
      expect(confirm).not.toHaveFocus()
    })
  })

  // ── REL-5d displayname inline field-focus ─────────────────────
  describe('REL-5d displayname inline field-focus', () => {
    it('focuses the displayName input + shows the translated error under it on fieldName=displayName', async () => {
      server.use(
        http.patch('/api/account/display-name', () =>
          HttpResponse.json(
            {
              code: 'displayname_invalid',
              message: 'Display name is invalid.',
              status: 400,
              fieldName: 'displayName',
            },
            { status: 400 },
          ),
        ),
      )
      renderPage()
      const user = userEvent.setup()

      await user.click(
        screen.getByRole('button', { name: /anzeigenamen bearbeiten/i }),
      )
      const input = await screen.findByLabelText(/anzeigename/i)
      await user.clear(input)
      await user.type(input, 'Gueltig')
      await user.click(screen.getByRole('button', { name: /speichern/i }))

      await waitFor(() => expect(input).toHaveFocus())
      // Translated copy from errors:displayname_invalid, not raw English.
      expect(await screen.findByText(/Anzeigename ist ungültig/i)).toBeInTheDocument()
      expect(screen.queryByText(/is invalid/)).toBeNull()
    })
  })
})
