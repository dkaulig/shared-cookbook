import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { toMondayIso } from '@/features/mealplanning/weekGrid'
import { WochenplanStub } from './WochenplanStub'

const TODAY_MONDAY = toMondayIso(new Date().toISOString().slice(0, 10))

function PathTracker() {
  const loc = useLocation()
  return <div data-testid="current-path">{loc.pathname}</div>
}

function withProviders(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/wochenplan']}>
        <Routes>
          <Route
            path="/wochenplan"
            element={
              <>
                <PathTracker />
                {node}
              </>
            }
          />
          <Route
            path="/groups/:groupId/mealplan/:weekStart"
            element={
              <>
                <PathTracker />
                <div>mealplan-page</div>
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

afterEach(() => {
  server.resetHandlers()
})

function makeGroup(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    coverImageUrl: null,
    defaultServings: 2,
    isPrivateCollection: false,
    memberCount: 1,
    myRole: 'Admin' as const,
  }
}

describe('<WochenplanStub />', () => {
  it('redirects to the single group\'s mealplan when the user has exactly one group', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json([makeGroup('g1', 'Familie')]),
      ),
    )

    render(withProviders(<WochenplanStub />))

    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent(
        `/groups/g1/mealplan/${TODAY_MONDAY}`,
      )
    })
    expect(screen.getByText('mealplan-page')).toBeInTheDocument()
  })

  it('renders a picker linking to each group\'s mealplan when the user has multiple groups', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json([
          makeGroup('g1', 'Familie'),
          makeGroup('g2', 'Bürokollegen'),
        ]),
      ),
    )

    render(withProviders(<WochenplanStub />))

    await screen.findByRole('heading', {
      level: 1,
      name: /Wähle eine Gruppe für den Wochenplan/i,
    })
    const familieLink = screen.getByRole('link', { name: /Familie/i })
    const buroLink = screen.getByRole('link', { name: /Bürokollegen/i })
    expect(familieLink).toHaveAttribute('href', `/groups/g1/mealplan/${TODAY_MONDAY}`)
    expect(buroLink).toHaveAttribute('href', `/groups/g2/mealplan/${TODAY_MONDAY}`)
    // Multi-group picker stays on /wochenplan — no auto-redirect.
    expect(screen.getByTestId('current-path')).toHaveTextContent('/wochenplan')
  })

  it('renders the "Noch keine Gruppe" CTA when the user has no groups', async () => {
    server.use(http.get('/api/groups', () => HttpResponse.json([])))

    render(withProviders(<WochenplanStub />))

    await screen.findByRole('heading', { level: 1, name: /Noch keine Gruppe/i })
    expect(
      screen.getByText(/Du bist noch in keiner Gruppe/i),
    ).toBeInTheDocument()
    const groupsLink = screen.getByRole('link', { name: /Zu den Gruppen/i })
    expect(groupsLink).toHaveAttribute('href', '/groups')
  })

  it('does not render the legacy "Phase 3" placeholder copy', async () => {
    server.use(http.get('/api/groups', () => HttpResponse.json([])))

    render(withProviders(<WochenplanStub />))

    await screen.findByRole('heading', { level: 1, name: /Noch keine Gruppe/i })
    expect(
      screen.queryByText(/Wochenplan kommt in Phase 3/i),
    ).not.toBeInTheDocument()
  })
})
