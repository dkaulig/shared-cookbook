import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ProfilStub } from './ProfilStub'

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
  return render(<ProfilStub />, { wrapper: Wrapper })
}

describe('<ProfilStub />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'david@kaulig.de',
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
    // The displayName "David" + the email "david@kaulig.de" both match
    // /david/i, so pin each with a distinct matcher.
    expect(screen.getByText('David')).toBeInTheDocument()
    expect(screen.getByText('david@kaulig.de')).toBeInTheDocument()
  })

  it('no longer shows the Phase-3 teaser copy', () => {
    renderPage()
    expect(screen.queryByText(/kommen in Phase 3/i)).not.toBeInTheDocument()
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
            email: 'david@kaulig.de',
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
            email: 'david@kaulig.de',
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
      server.use(
        http.patch('/api/account/display-name', () =>
          HttpResponse.json(
            { code: 'displayname_invalid', message: 'Anzeigename muss zwischen 2 und 50 Zeichen lang sein.' },
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
      expect(alert).toHaveTextContent(/Anzeigename muss zwischen 2 und 50 Zeichen/i)
    })
  })

  // ── Passwort ändern card ─────────────────────────────────────────

  describe('Passwort ändern', () => {
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

    it('wrong-current 401 surfaces as an inline error (not success)', async () => {
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            { code: 'invalid_credentials', message: 'Aktuelles Passwort ist falsch.' },
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

      const alert = await card.findByRole('alert')
      expect(alert).toHaveTextContent(/Aktuelles Passwort ist falsch/i)
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
  })
})
