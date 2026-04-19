import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MealPlanDto, MealPlanSlotDto, PatchSlotRequest } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { MealPlanPage } from './MealPlanPage'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const GROUP_ID = 'g1'
const WEEK_START = '2026-04-20' // Monday of KW 17/2026

function makeSlot(
  id: string,
  overrides: Partial<MealPlanSlotDto> = {},
): MealPlanSlotDto {
  return {
    id,
    mealPlanId: PLAN_ID,
    recipeId: null,
    label: 'Spaghetti',
    date: WEEK_START,
    meal: 'Mittag',
    servings: 2,
    sortOrder: 0,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...overrides,
  }
}

function PathTracker() {
  const location = useLocation()
  return <div data-testid="current-path">{location.pathname}</div>
}

function withProviders(path: string): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/groups/:groupId/mealplan/:weekStart"
            element={
              <>
                <PathTracker />
                <MealPlanPage />
              </>
            }
          />
          <Route
            path="/groups/:groupId/mealplan"
            element={
              <>
                <PathTracker />
                <MealPlanPage />
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

describe('<MealPlanPage />', () => {
  it('shows the week header with ISO week number and formatted date range', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    expect(await screen.findByRole('heading', { level: 1, name: /KW 17/i })).toBeInTheDocument()
    expect(screen.getByText(/20\.04\.2026 – 26\.04\.2026/)).toBeInTheDocument()
  })

  it('renders the "Kein Plan" CTA when the API responds 404', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json(
          { code: 'mealplan.not_found', message: 'kein plan' },
          { status: 404 },
        ),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    expect(
      await screen.findByRole('heading', { name: /Kein Plan für diese Woche/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Wochenplan anlegen/i })).toBeInTheDocument()
  })

  it('POSTs to create the plan when the CTA is clicked and then refetches', async () => {
    let getCount = 0
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () => {
        getCount += 1
        if (getCount === 1) {
          return HttpResponse.json(
            { code: 'mealplan.not_found', message: 'kein plan' },
            { status: 404 },
          )
        }
        return HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        })
      }),
      http.post('/api/groups/g1/mealplans', () =>
        HttpResponse.json<MealPlanDto>(
          {
            id: PLAN_ID,
            groupId: GROUP_ID,
            weekStart: WEEK_START,
            version: 1,
            createdAt: '2026-04-20T00:00:00Z',
            updatedAt: '2026-04-20T00:00:00Z',
            slots: [],
          },
          { status: 201 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(await screen.findByRole('button', { name: /Wochenplan anlegen/i }))

    await waitFor(() => expect(getCount).toBeGreaterThanOrEqual(2))
    // After refetch succeeds, the page shows the day grid with German
    // weekday labels, so the empty-state CTA must be gone.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Wochenplan anlegen/i }),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getAllByText('Montag').length).toBeGreaterThan(0)
  })

  it('renders a slot card for each slot returned by the API', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [
            makeSlot('s1', { label: 'Spaghetti Bolognese', servings: 4 }),
            makeSlot('s2', {
              date: '2026-04-22',
              meal: 'Abend',
              label: 'Linsencurry',
              servings: 3,
              isCooked: true,
            }),
          ],
        }),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    expect(await screen.findByText('Spaghetti Bolognese')).toBeInTheDocument()
    expect(screen.getByText('Linsencurry')).toBeInTheDocument()
    expect(screen.getByText(/4 Portionen/)).toBeInTheDocument()
    expect(screen.getByText(/3 Portionen/)).toBeInTheDocument()
    // P3-2 renders a read-only cooked badge; marking happens in P3-3.
    expect(screen.getByTestId('mealplan-slot-cooked')).toBeInTheDocument()
  })

  it('renders the "Noch keine Gerichte" empty message in cells with no slots', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('s1')],
        }),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    const emptyCells = await screen.findAllByText(/Noch keine Gerichte für diesen Tag/i)
    // 7 days × 4 meals = 28 cells; minus 1 filled (Monday Mittag) = 27.
    expect(emptyCells).toHaveLength(27)
  })

  it('navigates +7 days when "Nächste Woche" is clicked', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.get('/api/groups/g1/mealplans/2026-04-27', () =>
        HttpResponse.json(
          { code: 'mealplan.not_found', message: 'kein plan' },
          { status: 404 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await screen.findByRole('heading', { level: 1, name: /KW 17/i })
    await user.click(screen.getByRole('button', { name: /Nächste Woche/i }))

    await waitFor(() =>
      expect(screen.getByTestId('current-path').textContent).toBe(
        '/groups/g1/mealplan/2026-04-27',
      ),
    )
  })

  it('navigates -7 days when "Vorherige Woche" is clicked', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.get('/api/groups/g1/mealplans/2026-04-13', () =>
        HttpResponse.json(
          { code: 'mealplan.not_found', message: 'kein plan' },
          { status: 404 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await screen.findByRole('heading', { level: 1, name: /KW 17/i })
    await user.click(screen.getByRole('button', { name: /Vorherige Woche/i }))

    await waitFor(() =>
      expect(screen.getByTestId('current-path').textContent).toBe(
        '/groups/g1/mealplan/2026-04-13',
      ),
    )
  })

  it('redirects a mid-week URL to the Monday of that week', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
    )

    // Wed 2026-04-22 → Mon 2026-04-20
    render(withProviders(`/groups/${GROUP_ID}/mealplan/2026-04-22`))

    await waitFor(() =>
      expect(screen.getByTestId('current-path').textContent).toBe(
        '/groups/g1/mealplan/2026-04-20',
      ),
    )
  })

  it('opens the EditSlotDialog when a slot card is clicked', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('s1', { label: 'Spaghetti Bolognese' })],
        }),
      ),
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(await screen.findByTestId('mealplan-slot-edit-s1'))
    expect(
      await screen.findByRole('dialog', { name: /Gericht bearbeiten/i }),
    ).toBeInTheDocument()
  })

  it('renders the cooked slot with a line-through title + checked toggle', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('s1', { label: 'Linsencurry', isCooked: true })],
        }),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    const title = await screen.findByText('Linsencurry')
    expect(title.className).toMatch(/line-through/)
    expect(screen.getByTestId('mealplan-slot-cooked-toggle-s1')).toBeChecked()
  })

  it('fires a PATCH with isCooked: true when the Gekocht toggle is ticked', async () => {
    let capturedBody: PatchSlotRequest | null = null
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('s1', { label: 'Spaghetti', isCooked: false })],
        }),
      ),
      http.patch(`/api/mealplans/${PLAN_ID}/slots/s1`, async ({ request }) => {
        capturedBody = (await request.json()) as PatchSlotRequest
        return HttpResponse.json(makeSlot('s1', { label: 'Spaghetti', isCooked: true }))
      }),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(await screen.findByTestId('mealplan-slot-cooked-toggle-s1'))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody).toEqual({ isCooked: true })
  })

  it('opens the DeleteSlotDialog from the slot overflow menu', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('s1', { label: 'Spaghetti' })],
        }),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(await screen.findByTestId('mealplan-slot-menu-s1'))
    const deleteItem = await screen.findByRole('menuitem', { name: /Löschen/i })
    await user.click(deleteItem)

    expect(
      await screen.findByRole('dialog', { name: /Gericht wirklich löschen\?/i }),
    ).toBeInTheDocument()
  })

  it('opens the AddSlotDialog when an empty cell button is clicked', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    // Click the first "Gericht hinzufügen" button — belongs to Mon Frühstück.
    const addButtons = await screen.findAllByRole('button', {
      name: /Gericht hinzufügen/i,
    })
    await user.click(addButtons[0])

    expect(
      await screen.findByRole('dialog', { name: /Gericht hinzufügen/i }),
    ).toBeInTheDocument()
  })
})
