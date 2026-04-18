import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LoginPage } from './LoginPage'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div data-testid="home">Zuhause</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('<LoginPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('renders the German headline and submit button', () => {
    renderLogin()
    expect(screen.getByRole('heading', { level: 1, name: /anmelden/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /anmelden/i })).toBeInTheDocument()
  })

  it('shows a German error when submitted with an empty email', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /anmelden/i }))

    expect(await screen.findByText(/e-mail/i)).toBeInTheDocument()
  })

  it('shows a German error when submitted with an invalid email format', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'not-an-email')
    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /anmelden/i }))

    expect(
      await screen.findByText(/gültige e-mail/i),
    ).toBeInTheDocument()
  })

  it('on 401 surfaces the server German error message', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({ code: 'invalid_credentials', message: 'E-Mail oder Passwort ungültig.' }, { status: 401 }),
      ),
    )

    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
    await user.type(screen.getByLabelText(/passwort/i), 'wrong')
    await user.click(screen.getByRole('button', { name: /anmelden/i }))

    expect(await screen.findByText(/E-Mail oder Passwort ungültig/i)).toBeInTheDocument()
  })

  it('on 200 redirects to "/" and populates the auth store', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Nutzer', role: 'User' },
        }),
      ),
    )

    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /anmelden/i }))

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument()
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })
})
