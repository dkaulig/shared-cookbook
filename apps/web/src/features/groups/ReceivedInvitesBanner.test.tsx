import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  ErrorToastHost,
  clearAllErrorToasts,
} from '@/features/_shared/errorSurface'
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
            groupName: 'Example Family',
            inviterDisplayName: 'Alice',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )
    renderBanner()
    expect(await screen.findByText(/Example Family/)).toBeInTheDocument()
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

    await waitFor(() => {
      expect(screen.queryByText(/Familie/)).toBeNull()
    })
  })

  it('renders each pending invite as its own accent-lined banner card', async () => {
    server.use(
      http.get('/api/groups/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Backkurs-Crew',
            inviterDisplayName: 'Maren',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'i2',
            groupId: 'g2',
            groupName: 'Sonntags-Brunch',
            inviterDisplayName: 'Bo',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )

    const { container } = renderBanner()
    await waitFor(() => {
      const articles = container.querySelectorAll('article')
      expect(articles).toHaveLength(2)
      // DS3 mockup: left amber accent border.
      articles.forEach((a) => {
        expect(a.className).toMatch(/border-l-primary/)
      })
    })
    expect(screen.getByText(/Backkurs-Crew/)).toBeInTheDocument()
    expect(screen.getByText(/Sonntags-Brunch/)).toBeInTheDocument()
  })

  it('surfaces a toast when accept fails with 500 (REL-5 silent-failure guard)', async () => {
    clearAllErrorToasts()
    server.use(
      http.get('/api/groups/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Familie',
            inviterDisplayName: 'Alice',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
      http.post('/api/groups/invites/:id/accept', () =>
        // Return a non-ApiError body so `throwApiError` synthesises a
        // `http_500` code — simulates the realistic path where the
        // server 500s from an unhandled exception (no ApiError DTO).
        // If the backend starts shipping structured 5xx bodies later,
        // REL-4 will add `status` to the thrown Error uniformly across
        // every feature api-helper; see the inventory in the REL-5
        // report for the open flag.
        HttpResponse.text('Internal Server Error', { status: 500 }),
      ),
    )

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
    render(
      <>
        <ErrorToastHost />
        <ReceivedInvitesBanner />
      </>,
      { wrapper: Wrapper },
    )

    const acceptButton = await screen.findByRole('button', { name: /annehmen/i })
    const user = userEvent.setup()
    await user.click(acceptButton)

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert')
      expect(
        alerts.some((el) =>
          /unbekannter fehler/i.test(el.textContent ?? ''),
        ),
      ).toBe(true)
    })
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

    await waitFor(() => {
      expect(screen.queryByText(/Freunde/)).toBeNull()
    })
  })
})
