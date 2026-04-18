import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ReceivedInvitesBanner } from './ReceivedInvitesBanner'

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(<ReceivedInvitesBanner />, { wrapper: Wrapper })
}

describe('<ReceivedInvitesBanner />', () => {
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

  it('renders nothing when there are no pending invites', async () => {
    server.use(
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    const { container } = renderBanner()
    await waitFor(() => {
      expect(container.querySelector('[data-testid="invites-banner"]')).toBeNull()
    })
  })

  it('renders group name and inviter when invites exist and offers German accept/decline buttons', async () => {
    server.use(
      http.get('/api/groups/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Familie Müller',
            inviterDisplayName: 'Alice',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )
    renderBanner()
    expect(await screen.findByText(/Familie Müller/)).toBeInTheDocument()
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /annehmen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ablehnen/i })).toBeInTheDocument()
  })

  it('hides the banner after accept', async () => {
    let acceptedId: string | null = null
    server.use(
      http.get('/api/groups/invites', () => {
        // After accept, return empty list.
        if (acceptedId) return HttpResponse.json([])
        return HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Familie',
            inviterDisplayName: 'Alice',
            createdAt: new Date().toISOString(),
          },
        ])
      }),
      http.post('/api/groups/invites/:id/accept', ({ params }) => {
        acceptedId = params.id as string
        return HttpResponse.json({
          id: acceptedId,
          groupId: 'g1',
          invitedUserId: 'u1',
          status: 'Accepted',
          createdAt: new Date().toISOString(),
        })
      }),
    )

    renderBanner()
    const acceptButton = await screen.findByRole('button', { name: /annehmen/i })
    const user = userEvent.setup()
    await user.click(acceptButton)

    // Wait for banner row to disappear after refetch.
    await waitForElementToBeRemoved(() => screen.queryByText(/Familie/))
  })

  it('hides the invite row after decline', async () => {
    let declinedId: string | null = null
    server.use(
      http.get('/api/groups/invites', () => {
        if (declinedId) return HttpResponse.json([])
        return HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Freunde',
            inviterDisplayName: 'Bob',
            createdAt: new Date().toISOString(),
          },
        ])
      }),
      http.post('/api/groups/invites/:id/decline', ({ params }) => {
        declinedId = params.id as string
        return HttpResponse.json({
          id: declinedId,
          groupId: 'g1',
          invitedUserId: 'u1',
          status: 'Declined',
          createdAt: new Date().toISOString(),
        })
      }),
    )

    renderBanner()
    const declineButton = await screen.findByRole('button', { name: /ablehnen/i })
    const user = userEvent.setup()
    await user.click(declineButton)

    await waitForElementToBeRemoved(() => screen.queryByText(/Freunde/))
  })
})
