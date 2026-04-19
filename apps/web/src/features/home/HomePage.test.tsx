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

  it('renders the six quick-filter chips with the sage-primary "Schnell" first', async () => {
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
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'gA', name: 'Example Family' })]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    const add = await screen.findByRole('button', { name: /neue gruppe anlegen/i })
    const user = userEvent.setup()
    await user.click(add)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /gruppe erstellen/i })).toBeInTheDocument()
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

  // BF1 #6 — single-group users should land directly on their one
  // collection so the chip behaves deterministically (no surprise jump
  // into "the biggest group"). The preset query string is preserved so
  // the Group page can apply the matching filter.
  it('navigates the single-group user directly to their group when a chip is clicked', async () => {
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

  // BF1 #6 — multi-group users get a picker so they consciously choose
  // which collection to filter; the chip no longer routes them blindly
  // into "the biggest group". Picking a group navigates with the preset.
  it('opens a group-picker dialog when a chip is clicked and the user has multiple groups', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'gA', name: 'Example Family', memberCount: 4 }),
          groupSummary({ id: 'gB', name: 'WG-Donnerstage', memberCount: 3 }),
        ]),
      ),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    const chip = await screen.findByRole('button', { name: /^warm$/i })
    const user = userEvent.setup()
    await user.click(chip)

    // The picker should show both groups as choices and not auto-navigate.
    const dialog = await screen.findByRole('dialog', { name: /in welcher gruppe suchen/i })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /familie kaulig/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /wg-donnerstage/i })).toBeInTheDocument()
    expect(screen.queryByTestId('group-detail')).toBeNull()

    // Picking a group navigates with the preset preserved.
    await user.click(within(dialog).getByRole('button', { name: /wg-donnerstage/i }))
    await waitFor(() => {
      expect(screen.getByTestId('group-detail')).toBeInTheDocument()
    })
  })

  // BF1 #6 — zero-group branch: when the user has no collections yet, a
  // chip press should open the create-group dialog instead of navigating
  // somewhere broken. Mirrors the "+ Neue Gruppe anlegen" card behaviour
  // so the chip row stays useful before the user has any groups.
  it('opens the create-group dialog when a chip is clicked and the user has zero groups', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
      http.get('/api/groups/:groupId/recipes/search', () => HttpResponse.json(emptySearch)),
    )
    renderHome()

    const chip = await screen.findByRole('button', { name: /^schnell/i })
    const user = userEvent.setup()
    await user.click(chip)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /gruppe erstellen/i })).toBeInTheDocument()
    // No navigation should have occurred.
    expect(screen.queryByTestId('group-detail')).toBeNull()
    expect(screen.queryByTestId('groups-page')).toBeNull()
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
    // The tagline is rendered in italic `font-serif-body` (Inter, per DS8).
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

  // P2-7 — the discreet "Rezept aus Video importieren" affordance under
  // the hero chip row kicks off the URL-import flow. It must link to the
  // new `/rezepte/import/url` route so deep-linking + reload behaviour
  // matches the plan.
  it('renders the "Rezept aus Video importieren" entry point linking to /rezepte/import/url', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()
    const link = await screen.findByRole('link', {
      name: /Rezept aus Video importieren/i,
    })
    expect(link).toHaveAttribute('href', '/rezepte/import/url')
  })

  // P2-8 — the companion photo-import link sits next to the video-import
  // one, same visual treatment, different route + icon. Both entry
  // points deliberately share the dashed-border chip style so they read
  // as sibling AI affordances.
  it('renders the "Rezept aus Foto importieren" entry point linking to /rezepte/import/photos', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()
    const link = await screen.findByRole('link', {
      name: /Rezept aus Foto importieren/i,
    })
    expect(link).toHaveAttribute('href', '/rezepte/import/photos')
  })

  // P2-9 — the third AI entry point: conversational recipe creation.
  // Sibling of Video + Foto, different route + icon, same dashed chip
  // visual treatment so it reads as an equal-weight alternative.
  it('renders the "Rezept im Chat erfinden" entry point linking to /chat', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )
    renderHome()
    const link = await screen.findByRole('link', {
      name: /Rezept im Chat erfinden/i,
    })
    expect(link).toHaveAttribute('href', '/chat')
  })
})
