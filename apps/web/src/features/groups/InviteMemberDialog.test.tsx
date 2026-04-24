import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { InviteMemberDialog } from './InviteMemberDialog'

function renderDialog(groupId = 'g1', onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(<InviteMemberDialog groupId={groupId} onClose={onClose} />, { wrapper: Wrapper })
}

describe('<InviteMemberDialog />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'x@y.de',
      displayName: 'X',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders German title and search input', () => {
    renderDialog()
    expect(screen.getByRole('heading', { level: 2, name: /mitglied einladen/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/nutzer:in suchen/i)).toBeInTheDocument()
  })

  it('debounces the search and fetches from /api/users/search', async () => {
    let calls = 0
    server.use(
      http.get('/api/users/search', ({ request }) => {
        calls += 1
        const url = new URL(request.url)
        const q = url.searchParams.get('q') ?? ''
        if (!q) return HttpResponse.json([])
        return HttpResponse.json([
          { id: 'u2', displayName: 'Bob Bauer', avatarUrl: null },
          { id: 'u3', displayName: 'Bob Berg', avatarUrl: null },
        ])
      }),
    )
    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByLabelText(/nutzer:in suchen/i), 'Bob')

    await waitFor(() => {
      expect(screen.getByText('Bob Bauer')).toBeInTheDocument()
      expect(screen.getByText('Bob Berg')).toBeInTheDocument()
    })
    // Debounce should collapse the 3 keystrokes into at most a handful of calls.
    expect(calls).toBeLessThanOrEqual(3)
  })

  it('submits an invite when a user is selected and surfaces already_member errors', async () => {
    let inviteBody: unknown
    server.use(
      http.get('/api/users/search', () =>
        HttpResponse.json([{ id: 'u2', displayName: 'Bob Bauer', avatarUrl: null }]),
      ),
      http.post('/api/groups/g1/invites', async ({ request }) => {
        inviteBody = await request.json()
        return HttpResponse.json(
          {
            code: 'already_member',
            message: 'User is already a member.',
            status: 400,
          },
          { status: 400 },
        )
      }),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog('g1', onClose)

    await user.type(screen.getByLabelText(/nutzer:in suchen/i), 'Bob')
    const pick = await screen.findByRole('button', { name: 'Bob Bauer' })
    await user.click(pick)

    // REL-3f — `already_member` is routed through classifyMutationError
    // to the localised `errors.json` copy; the backend's English
    // Dev-Message must NOT leak verbatim.
    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(/Nutzer ist bereits Mitglied/)
      expect(alert).not.toHaveTextContent(/User is already a member/)
    })
    expect(inviteBody).toEqual({ invitedUserId: 'u2' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose after a successful invite', async () => {
    server.use(
      http.get('/api/users/search', () =>
        HttpResponse.json([{ id: 'u2', displayName: 'Bob Bauer', avatarUrl: null }]),
      ),
      http.post('/api/groups/g1/invites', () =>
        HttpResponse.json(
          {
            id: 'i1',
            groupId: 'g1',
            invitedUserId: 'u2',
            status: 'Pending',
            createdAt: new Date().toISOString(),
          },
          { status: 201 },
        ),
      ),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog('g1', onClose)

    await user.type(screen.getByLabelText(/nutzer:in suchen/i), 'Bob')
    const pick = await screen.findByRole('button', { name: 'Bob Bauer' })
    await user.click(pick)

    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
