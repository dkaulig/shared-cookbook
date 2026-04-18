import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupsPage } from './GroupsPage'

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/groups']}>
          <Routes>
            <Route path="/groups" element={children} />
            <Route path="/groups/:id" element={<div data-testid="group-detail">detail</div>} />
            <Route path="/login" element={<div data-testid="login">login</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<GroupsPage />, { wrapper: Wrapper })
}

describe('<GroupsPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'x@y.de',
      displayName: 'X',
      role: 'User',
    })
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('shows skeleton placeholders while the groups query is loading', async () => {
    // Block the response so the query stays in-flight long enough to
    // assert on the skeleton row.
    let resolveRequest: ((value: GroupSummary[]) => void) | undefined
    server.use(
      http.get('/api/groups', () => new Promise<Response>((resolve) => {
        resolveRequest = (body) => resolve(HttpResponse.json(body))
      })),
    )

    renderPage()

    const skeletons = await screen.findAllByRole('status')
    expect(skeletons.length).toBeGreaterThan(0)

    resolveRequest?.([])
    await waitFor(() => {
      expect(screen.getByText(/noch in keiner gruppe/i)).toBeInTheDocument()
    })
  })

  it('renders the German heading and empty state when API returns []', async () => {
    server.use(http.get('/api/groups', () => HttpResponse.json([])))

    renderPage()

    expect(screen.getByRole('heading', { level: 1, name: /meine gruppen/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText(/noch in keiner gruppe/i)).toBeInTheDocument()
    })
  })

  it('renders the Private Sammlung and a collaborative group as cards', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          {
            id: 'priv',
            name: 'Private Sammlung',
            description: null,
            coverImageUrl: null,
            defaultServings: 2,
            isPrivateCollection: true,
            memberCount: 1,
            myRole: 'Admin',
          },
          {
            id: 'fam',
            name: 'Familie Müller',
            description: 'Unsere Lieblinge',
            coverImageUrl: null,
            defaultServings: 4,
            isPrivateCollection: false,
            memberCount: 2,
            myRole: 'Admin',
          },
        ]),
      ),
    )

    renderPage()

    expect(await screen.findByText('Private Sammlung')).toBeInTheDocument()
    expect(screen.getByText('Familie Müller')).toBeInTheDocument()
    expect(screen.getByText('Unsere Lieblinge')).toBeInTheDocument()
    // Private-flag badge uses short 'Privat' — assert presence.
    expect(screen.getAllByText(/Privat/i).length).toBeGreaterThan(0)
  })

  it('creating a group via the dialog updates the list after the mutation succeeds', async () => {
    let current: GroupSummary[] = []
    server.use(
      http.get('/api/groups', () => HttpResponse.json(current)),
      http.post('/api/groups', async ({ request }) => {
        const body = (await request.json()) as { name: string }
        const newGroup: GroupSummary = {
          id: 'g1',
          name: body.name,
          description: null,
          coverImageUrl: null,
          defaultServings: 2,
          isPrivateCollection: false,
          memberCount: 1,
          myRole: 'Admin',
        }
        current = [...current, newGroup]
        return HttpResponse.json(newGroup, { status: 201 })
      }),
    )

    const user = userEvent.setup()
    renderPage()

    // Initial empty list
    expect(await screen.findByText(/noch in keiner gruppe/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /\+ gruppe erstellen/i }))
    const dialog = await screen.findByRole('dialog')
    await user.type(screen.getByLabelText(/name/i), 'Neue Runde')
    const submitButton = Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Erstellen')
    expect(submitButton).toBeDefined()
    await user.click(submitButton!)

    await waitFor(() => {
      expect(screen.getByText('Neue Runde')).toBeInTheDocument()
    })
  })
})
