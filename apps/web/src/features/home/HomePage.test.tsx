import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupSummary, RecipeSearchResult } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { HomePage } from './HomePage'

function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={children} />
            <Route path="/groups" element={<div data-testid="groups-page">Groups</div>} />
            <Route path="/groups/:id" element={<div data-testid="group-detail">detail</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<HomePage />, { wrapper: Wrapper })
}

function groupSummary(over: Partial<GroupSummary>): GroupSummary {
  return {
    id: 'g1',
    name: 'Example Family',
    description: null,
    coverImageUrl: null,
    defaultServings: 3,
    isPrivateCollection: false,
    memberCount: 4,
    myRole: 'Admin',
    ...over,
  }
}

const emptySearch: RecipeSearchResult = { items: [], page: 1, pageSize: 4, total: 0 }

describe('<HomePage />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'maintainer@example.com',
      displayName: 'David',
      role: 'User',
    })
    // Lock wall-clock at 2026-04-17 20:00 local → "Guten Abend" + non-winter.
    vi.setSystemTime(new Date('2026-04-17T20:00:00'))
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
    vi.useRealTimers()
  })

  it('renders the time-of-day greeting with the user display name', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()

    expect(await screen.findByText(/guten abend/i)).toBeInTheDocument()
    const kicker = screen.getByText(/guten abend/i)
    expect(kicker).toHaveTextContent(/david/i)
  })

  it('renders the serif hero headline "Was kochen wir heute?"', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()

    const h1 = await screen.findByRole('heading', { level: 1, name: /was kochen wir heute\?/i })
    expect(h1).toBeInTheDocument()
    expect(h1.className).toMatch(/font-serif/)
  })

  it('renders the six quick-filter chips with the amber-primary "Schnell" first', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()

    expect(await screen.findByRole('button', { name: /schnell .*30 min/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^warm$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /vegetarisch/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /zufall/i })).toBeInTheDocument()
    // Spring/summer run → Sommer-Abend (Winter-Abend only Nov-Feb).
    expect(screen.getByRole('button', { name: /sommer-abend/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /wenig aufwand/i })).toBeInTheDocument()
  })

  it('shows the received-invite banner when an invite is pending', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'gA',
            groupName: 'Backkurs-Crew',
            inviterDisplayName: 'Maren',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )
    renderHome()

    expect(await screen.findByText(/backkurs-crew/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /annehmen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ablehnen/i })).toBeInTheDocument()
  })

  it('lists the user\'s groups with initial avatar + meta + role badge', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family', memberCount: 4, myRole: 'Admin' }),
          groupSummary({
            id: 'gB',
            name: 'WG-Donnerstage',
            memberCount: 3,
            myRole: 'Member',
            isPrivateCollection: false,
          }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    expect(await screen.findByText('Example Family')).toBeInTheDocument()
    expect(screen.getByText('WG-Donnerstage')).toBeInTheDocument()
    // Role chips.
    expect(screen.getByText(/^admin$/i)).toBeInTheDocument()
    expect(screen.getByText(/^mitglied$/i)).toBeInTheDocument()
  })

  it('renders the "+ Neue Gruppe anlegen" card and opens the create dialog when clicked', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()

    const add = await screen.findByRole('button', { name: /neue gruppe anlegen/i })
    const user = userEvent.setup()
    await user.click(add)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/gruppe erstellen/i)).toBeInTheDocument()
  })

  it('renders the "Zuletzt gekocht" section with recipes from the biggest group', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family', memberCount: 4 }),
          groupSummary({ id: 'gB', name: 'WG', memberCount: 2 }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/gA/recipes/search', () =>
        HttpResponse.json<RecipeSearchResult>({
          items: [
            {
              id: 'r1',
              groupId: 'gA',
              title: 'Omas Schnitzel',
              description: null,
              photo: null,
              tagIds: [],
              createdByDisplayName: 'Oma',
              updatedAt: new Date().toISOString(),
              avgRating: 4.8,
              ratingCount: 3,
              myStars: null,
            },
          ],
          page: 1,
          pageSize: 4,
          total: 1,
        }),
      ),
      http.get('/api/groups/gB/recipes/search', () => HttpResponse.json(emptySearch)),
    )

    renderHome()

    expect(await screen.findByText(/zuletzt gekocht/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Omas Schnitzel')).toBeInTheDocument()
    })
  })

  it('shows a friendly empty state when no recipes have been cooked yet', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family' }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/gA/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    await waitFor(() => {
      expect(screen.getByText(/noch nichts gekocht/i)).toBeInTheDocument()
    })
  })

  it('clicking a quick-filter chip navigates to /groups (hand-off to Group list)', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family' }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    const chip = await screen.findByRole('button', { name: /schnell .*30 min/i })
    const user = userEvent.setup()
    await user.click(chip)

    await waitFor(() => {
      expect(screen.getByTestId('group-detail')).toBeInTheDocument()
    })
  })

  it('renders the "Alle ansehen →" link under the groups section pointing to /groups', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'gA' })]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    const link = await screen.findByRole('link', { name: /alle ansehen/i })
    expect(link).toHaveAttribute('href', '/groups')
  })

  it('navigates to a group when clicking on its card', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family' }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    const card = await screen.findByRole('link', { name: /familie kaulig/i })
    const user = userEvent.setup()
    await user.click(card)

    await waitFor(() => {
      expect(screen.getByTestId('group-detail')).toBeInTheDocument()
    })
  })

  it('renders the hero-section subheading in italic serif-body', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()
    // The tagline is italic Libre-Baskerville per mockup.
    const subtitle = await screen.findByText(/hunger beruhigt/i)
    expect(subtitle).toBeInTheDocument()
    expect(subtitle.className).toMatch(/italic/)
  })

  it('exposes "Meine Gruppen" as an accessible heading', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'gA' })]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    await waitFor(() => {
      const heading = screen.getByRole('heading', { level: 2, name: /meine gruppen/i })
      expect(heading).toBeInTheDocument()
      expect(heading.className).toMatch(/font-serif/)
    })
  })

  it('shows a rating pill on recipe cards when avgRating is set', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family' }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/gA/recipes/search', () =>
        HttpResponse.json<RecipeSearchResult>({
          items: [
            {
              id: 'r1',
              groupId: 'gA',
              title: 'Omas Schnitzel',
              description: null,
              photo: null,
              tagIds: [],
              createdByDisplayName: 'Oma',
              updatedAt: new Date().toISOString(),
              avgRating: 4.8,
              ratingCount: 3,
              myStars: null,
            },
          ],
          page: 1,
          pageSize: 4,
          total: 1,
        }),
      ),
    )
    renderHome()

    const card = await screen.findByRole('link', { name: /omas schnitzel/i })
    expect(within(card).getByText('4.8')).toBeInTheDocument()
  })
})
