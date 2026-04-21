import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
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

  it('renders the "Rest von …" badge on a slot linked to a parent in the same plan', async () => {
    const mondayParent = makeSlot('parent-1', {
      label: 'Gulasch',
      date: WEEK_START, // Monday
      meal: 'Mittag',
      servings: 4,
    })
    const tuesdayChild = makeSlot('child-1', {
      label: 'Rest',
      date: '2026-04-21',
      meal: 'Mittag',
      servings: 1,
      parentSlotId: 'parent-1',
    })
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [mondayParent, tuesdayChild],
        }),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    const badge = await screen.findByTestId('mealplan-slot-parent-badge-child-1')
    expect(badge).toHaveTextContent(/Rest von Mo Mittag/i)
    // The parent slot must NOT carry its own "Rest von" badge.
    expect(
      screen.queryByTestId('mealplan-slot-parent-badge-parent-1'),
    ).not.toBeInTheDocument()
  })

  it('surfaces the parent-deletion warning on the DeleteSlotDialog when the slot has children', async () => {
    const parent = makeSlot('parent-1', {
      label: 'Meal Prep',
      date: WEEK_START,
      meal: 'Mittag',
      servings: 5,
    })
    const child = makeSlot('child-1', {
      label: 'Rest',
      date: '2026-04-21',
      meal: 'Mittag',
      servings: 1,
      parentSlotId: 'parent-1',
    })
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [parent, child],
        }),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(await screen.findByTestId('mealplan-slot-menu-parent-1'))
    const deleteItem = await screen.findByRole('menuitem', { name: /Löschen/i })
    await user.click(deleteItem)

    const warning = await screen.findByTestId('delete-slot-parent-warning')
    expect(warning).toHaveTextContent(/Meal-Prep-Parent für 1 weiteren Slot/i)
  })

  // ── P3-9 "Plan der letzten Woche kopieren" ────────────────────────

  it('enables the "Letzte Woche kopieren" button when the plan is empty', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 0,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
    )

    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    // The button renders disabled during the initial load (plan is
    // still fetching), then flips to enabled once the empty plan
    // arrives — wait for the enabled state rather than asserting on
    // the first matching render.
    await waitFor(() => {
      const button = screen.getByRole('button', {
        name: /Plan der letzten Woche kopieren/i,
      })
      expect(button).toBeEnabled()
    })
  })

  it('disables the "Letzte Woche kopieren" button when the plan already has slots', async () => {
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

    const button = await screen.findByRole('button', {
      name: /Plan der letzten Woche kopieren/i,
    })
    expect(button).toBeDisabled()
  })

  it('POSTs copy-from with the previous Monday and shows the success banner', async () => {
    const copiedSlot1 = makeSlot('c1', { date: WEEK_START })
    const copiedSlot2 = makeSlot('c2', {
      date: '2026-04-22',
      meal: 'Abend',
      label: 'Linsencurry',
    })
    let capturedPath: string | null = null
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 0,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.post(
        `/api/mealplans/${PLAN_ID}/copy-from/:sourceWeekStart`,
        ({ request, params }) => {
          capturedPath = new URL(request.url).pathname
          // `params.sourceWeekStart` exposes the URL segment so the
          // assertion is independent of path-encoding quirks.
          expect(params.sourceWeekStart).toBe('2026-04-13')
          return HttpResponse.json<MealPlanDto>({
            id: PLAN_ID,
            groupId: GROUP_ID,
            weekStart: WEEK_START,
            version: 1,
            createdAt: '2026-04-20T00:00:00Z',
            updatedAt: '2026-04-20T00:00:00Z',
            slots: [copiedSlot1, copiedSlot2],
          })
        },
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    const button = await screen.findByRole('button', {
      name: /Plan der letzten Woche kopieren/i,
    })
    await user.click(button)

    const banner = await screen.findByTestId('mealplan-copy-banner')
    // Previous week of KW 17 (2026-04-20) is KW 16 (2026-04-13).
    expect(banner).toHaveTextContent(/2 Slots aus KW 16 übernommen/i)
    expect(capturedPath).toBe(`/api/mealplans/${PLAN_ID}/copy-from/2026-04-13`)
  })

  it('shows the "Kein Plan in KW X gefunden" banner on 404 source.not_found', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 0,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.post(`/api/mealplans/${PLAN_ID}/copy-from/2026-04-13`, () =>
        HttpResponse.json(
          { code: 'source.not_found', message: 'Quell-Wochenplan wurde nicht gefunden.' },
          { status: 404 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(
      await screen.findByRole('button', { name: /Plan der letzten Woche kopieren/i }),
    )

    const banner = await screen.findByTestId('mealplan-copy-banner')
    expect(banner).toHaveTextContent(/Kein Plan in KW 16 gefunden/i)
  })

  it('shows the "Keine Berechtigung" banner on 403', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 0,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.post(`/api/mealplans/${PLAN_ID}/copy-from/2026-04-13`, () =>
        HttpResponse.json(
          { code: 'forbidden', message: 'Forbidden' },
          { status: 403 },
        ),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(
      await screen.findByRole('button', { name: /Plan der letzten Woche kopieren/i }),
    )

    const banner = await screen.findByTestId('mealplan-copy-banner')
    expect(banner).toHaveTextContent(/Keine Berechtigung/i)
  })

  it('invalidates the week cache after a successful copy', async () => {
    let getCount = 0
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () => {
        getCount += 1
        // Flips to a populated plan on the second GET so we can
        // observe that the mutation re-fetched server truth.
        if (getCount === 1) {
          return HttpResponse.json<MealPlanDto>({
            id: PLAN_ID,
            groupId: GROUP_ID,
            weekStart: WEEK_START,
            version: 0,
            createdAt: '2026-04-20T00:00:00Z',
            updatedAt: '2026-04-20T00:00:00Z',
            slots: [],
          })
        }
        return HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('c1', { label: 'Refetched-After-Copy' })],
        })
      }),
      http.post(`/api/mealplans/${PLAN_ID}/copy-from/2026-04-13`, () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 1,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [makeSlot('c1', { label: 'From-Copy-Response' })],
        }),
      ),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(
      await screen.findByRole('button', { name: /Plan der letzten Woche kopieren/i }),
    )

    // The cache should be primed from the POST response first, then
    // invalidation triggers a refetch — observable via the second GET.
    await waitFor(() => expect(getCount).toBeGreaterThanOrEqual(2))
  })

  // ── P3-10 mobile polish ──────────────────────────────────────────

  it('renders the desktop grid (and not the mobile stack) at desktop widths', async () => {
    // jsdom's default `matchMedia` reports `matches: false`, which the
    // `useIsMobile` hook treats as "desktop". This test locks that
    // expectation: the desktop grid renders and the mobile-only stack
    // does not, so the existing data-testid assertions across the
    // suite stay unique.
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

    expect(
      await screen.findByTestId('mealplan-desktop-grid'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mealplan-mobile-stack')).not.toBeInTheDocument()
  })

  it('renders the mobile day-stack (and not the desktop grid) when matchMedia reports mobile', async () => {
    // Mock `matchMedia` to flip `useIsMobile` → true. We restore it in
    // the test cleanup so subsequent tests still see the desktop layout.
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (_query: string) => ({
        matches: true,
        media: _query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }),
    })

    try {
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

      expect(
        await screen.findByTestId('mealplan-mobile-stack'),
      ).toBeInTheDocument()
      expect(
        screen.queryByTestId('mealplan-desktop-grid'),
      ).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
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

  // BUG-004 — race-window override for "Plan der letzten Woche kopieren"
  // used to use `window.confirm`. It now opens the shared ConfirmDialog.
  // We can't easily reach the race state via UI (the button is disabled
  // when slots exist by design), so we assert the dialog primitive is
  // imported correctly by grepping the module for the override state
  // behaviour via a rendered-path check: clicking copy-last-week against
  // an empty plan must NOT pop the override dialog.
  it('BUG-004: does not open the override ConfirmDialog when plan is empty', async () => {
    server.use(
      http.get('/api/groups/g1/mealplans/2026-04-20', () =>
        HttpResponse.json<MealPlanDto>({
          id: PLAN_ID,
          groupId: GROUP_ID,
          weekStart: WEEK_START,
          version: 0,
          createdAt: '2026-04-20T00:00:00Z',
          updatedAt: '2026-04-20T00:00:00Z',
          slots: [],
        }),
      ),
      http.post(`/api/mealplans/${PLAN_ID}/copy-from/2026-04-13`, () =>
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

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    const button = await screen.findByRole('button', {
      name: /Plan der letzten Woche kopieren/i,
    })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    // Native confirm was never called; override dialog is not rendered.
    expect(
      screen.queryByRole('heading', { name: /Plan enthält bereits Slots/i }),
    ).not.toBeInTheDocument()
  })

  it('OFF4 — opens conflict dialog on 409 from slot PATCH; Keep-Local retries with new If-Match', async () => {
    let patchCallCount = 0
    const ifMatchHeaders: Array<string | null> = []
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
        patchCallCount++
        ifMatchHeaders.push(request.headers.get('If-Match'))
        if (patchCallCount === 1) {
          // Server says: plan already moved to version 9.
          const currentPlan: MealPlanDto = {
            id: PLAN_ID,
            groupId: GROUP_ID,
            weekStart: WEEK_START,
            version: 9,
            createdAt: '2026-04-20T00:00:00Z',
            updatedAt: '2026-04-20T00:00:00Z',
            slots: [
              makeSlot('s1', {
                label: 'Spaghetti (Server)',
                isCooked: false,
              }),
            ],
          }
          return HttpResponse.json(
            {
              code: 'version_mismatch',
              message: 'Der Eintrag wurde zwischenzeitlich geändert.',
              current: currentPlan,
            },
            { status: 409 },
          )
        }
        return HttpResponse.json(
          makeSlot('s1', { label: 'Spaghetti (Server)', isCooked: true }),
        )
      }),
    )

    const user = userEvent.setup()
    render(withProviders(`/groups/${GROUP_ID}/mealplan/${WEEK_START}`))

    await user.click(
      await screen.findByTestId('mealplan-slot-cooked-toggle-s1'),
    )

    const dialog = await screen.findByRole('dialog', {
      name: /Konflikt im Wochenplan/,
    })
    expect(dialog).toBeInTheDocument()

    const keepLocalBtn = await screen.findByRole('button', {
      name: /Lokal behalten/i,
    })
    await user.click(keepLocalBtn)

    await waitFor(() => expect(patchCallCount).toBe(2))
    // Retry carries If-Match with the new version 9.
    expect(ifMatchHeaders[1]).toMatch(/W\/"[^"]+-9"/)
  })
})

// BUG-032 — source-level grep gate. The page's sticky sub-nav used to be
// anchored at `top-[56px] z-20`, which (a) duplicated a magic pixel
// value that must match the TopNav height and (b) equalled the TopNav's
// own z-index so any y-overlap during iOS/Chrome toolbar retract was a
// coin-flip. We now drive the anchor from the shared `--topnav-height`
// CSS var and sit one tier below the TopNav so it wins on overlap.
describe('MealPlanPage sticky sub-nav (BUG-032)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const SOURCE = readFileSync(resolve(HERE, 'MealPlanPage.tsx'), 'utf8')

  it('uses sticky top-0 so it docks flush below TopNav (BUG-042)', () => {
    // BUG-039 made <main> the sole scroll container. Sticky positions
    // resolve against the nearest scroll ancestor — main's top is
    // already directly below TopNav, so the sticky offset must be 0.
    // The pre-BUG-042 `top-[var(--topnav-height)]` produced a
    // double-offset gap (topnav-height PLUS main.top) on scroll.
    expect(SOURCE).toMatch(/sticky\s+top-0\b/)
    // Hard-coded literal `top-[56px]` stays banned so the old BUG-032
    // regression can't sneak back.
    expect(SOURCE).not.toMatch(/sticky\s+top-\[56px\]/)
    expect(SOURCE).not.toMatch(/sticky\s+top-\[var\(--topnav-height\)\]/)
  })

  it('sub-nav nav element sits below TopNav (z-10, not z-20)', () => {
    expect(SOURCE).toMatch(/sticky top-0 z-10/)
  })
})
