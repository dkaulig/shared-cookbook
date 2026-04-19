import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  IngredientCategory,
  MealPlanDto,
  PatchShoppingListItemRequest,
  ShoppingListDto,
  ShoppingListItemDto,
  ShoppingListItemSource,
} from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ShoppingListPage } from './ShoppingListPage'

const GROUP_ID = 'g1'
const WEEK_START = '2026-04-20' // Monday of KW 17/2026
const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const LIST_ID = '22222222-2222-2222-2222-222222222222'

function makeItem(
  overrides: Partial<ShoppingListItemDto> & { id: string; name: string; category?: IngredientCategory },
): ShoppingListItemDto {
  return {
    id: overrides.id,
    shoppingListId: LIST_ID,
    name: overrides.name,
    quantity: null,
    unit: null,
    note: null,
    isChecked: false,
    category: overrides.category ?? 'Sonstiges',
    source: 'FromPlan',
    sortOrder: 0,
    carriedOverFromPreviousWeek: false,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
    ...overrides,
  }
}

function makeList(items: ShoppingListItemDto[]): ShoppingListDto {
  return {
    id: LIST_ID,
    mealPlanId: PLAN_ID,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
    lastGeneratedAt: '2026-04-19T00:00:00Z',
    items,
  }
}

function makePlan(): MealPlanDto {
  return {
    id: PLAN_ID,
    groupId: GROUP_ID,
    weekStart: WEEK_START,
    version: 1,
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    slots: [],
  }
}

function withProviders(): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[`/groups/${GROUP_ID}/mealplan/${WEEK_START}/shopping-list`]}
      >
        <Routes>
          <Route
            path="/groups/:groupId/mealplan/:weekStart/shopping-list"
            element={<ShoppingListPage />}
          />
          <Route
            path="/groups/:groupId/mealplan/:weekStart"
            element={<div data-testid="mealplan-page">mealplan</div>}
          />
          <Route path="/groups" element={<div>groups</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function respondWithPlan() {
  return http.get(
    `/api/groups/${GROUP_ID}/mealplans/${WEEK_START}`,
    () => HttpResponse.json<MealPlanDto>(makePlan()),
  )
}

function respondWithList(items: ShoppingListItemDto[]) {
  return http.get(
    `/api/mealplans/${PLAN_ID}/shopping-list`,
    () => HttpResponse.json<ShoppingListDto>(makeList(items)),
  )
}

function respondListNotFound() {
  return http.get(
    `/api/mealplans/${PLAN_ID}/shopping-list`,
    () =>
      HttpResponse.json(
        { code: 'shopping_list.not_found', message: 'Noch keine Liste.' },
        { status: 404 },
      ),
  )
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  window.sessionStorage.clear()
})

afterEach(() => {
  window.sessionStorage.clear()
})

describe('<ShoppingListPage />', () => {
  it('renders the week header (KW + date range)', async () => {
    server.use(respondWithPlan(), respondWithList([]))
    render(withProviders())

    expect(await screen.findByRole('heading', { level: 1, name: /KW 17/i })).toBeInTheDocument()
    expect(screen.getByText(/20\.04\.2026 – 26\.04\.2026/)).toBeInTheDocument()
  })

  it('renders category sections in CATEGORY_ORDER with German labels', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'Milch', category: 'Molkerei' }),
        makeItem({ id: '2', name: 'Tomate', category: 'ObstGemuese' }),
        makeItem({ id: '3', name: 'Spülmittel', category: 'Haushalt' }),
      ]),
    )
    render(withProviders())

    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Obst & Gemüse',
      'Molkerei',
      'Haushalt',
    ])
  })

  it('shows the progress header with N/M and percentage', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'A', isChecked: true }),
        makeItem({ id: '2', name: 'B', isChecked: false }),
        makeItem({ id: '3', name: 'C', isChecked: true }),
      ]),
    )
    render(withProviders())

    expect(await screen.findByText(/2 von 3 abgehakt/i)).toBeInTheDocument()
    const progress = screen.getByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuenow', '2')
    expect(progress).toHaveAttribute('aria-valuemax', '3')
  })

  it('shows the "Einkauf komplett!" celebration when all items are checked', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'A', isChecked: true }),
        makeItem({ id: '2', name: 'B', isChecked: true }),
      ]),
    )
    render(withProviders())

    expect(await screen.findByText(/Einkauf komplett/i)).toBeInTheDocument()
  })

  it('sends a PATCH with the flipped isChecked flag when an item row is clicked', async () => {
    const ITEM_ID = 'item-1'
    let captured: PatchShoppingListItemRequest | null = null
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: ITEM_ID, name: 'Tomate', category: 'ObstGemuese' }),
      ]),
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        async ({ request }) => {
          captured = (await request.json()) as PatchShoppingListItemRequest
          return HttpResponse.json(
            makeItem({
              id: ITEM_ID,
              name: 'Tomate',
              category: 'ObstGemuese',
              isChecked: true,
            }),
          )
        },
      ),
    )
    render(withProviders())

    const checkbox = await screen.findByRole('checkbox', {
      name: /Tomate abhaken$/i,
    })
    await userEvent.setup().click(checkbox)

    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured).toEqual({ isChecked: true })
  })

  it('flips to alphabetic view when the "Alphabetisch" toggle is clicked', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'Zwiebel', category: 'ObstGemuese' }),
        makeItem({ id: '2', name: 'Apfel', category: 'ObstGemuese' }),
        makeItem({ id: '3', name: 'Milch', category: 'Molkerei' }),
      ]),
    )
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('radio', { name: /Alphabetisch/i }),
    )

    // Category headings are gone; all items live in one flat list.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2 })).toBeNull(),
    )
    // Items render alphabetically: Apfel, Milch, Zwiebel.
    const rows = screen.getAllByRole('checkbox')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveAccessibleName(/Apfel/)
    expect(rows[1]).toHaveAccessibleName(/Milch/)
    expect(rows[2]).toHaveAccessibleName(/Zwiebel/)
  })

  it('shows the "Liste erzeugen" CTA when the list is 404 (not generated yet)', async () => {
    server.use(respondWithPlan(), respondListNotFound())
    render(withProviders())

    expect(
      await screen.findByRole('button', { name: /Liste erzeugen/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Noch keine Einkaufsliste/i)).toBeInTheDocument()
  })

  it('POSTs to /shopping-list/generate when "Liste erzeugen" is clicked', async () => {
    let generated = false
    server.use(
      respondWithPlan(),
      respondListNotFound(),
      http.post(
        `/api/mealplans/${PLAN_ID}/shopping-list/generate`,
        () => {
          generated = true
          return HttpResponse.json<ShoppingListDto>(makeList([]), { status: 201 })
        },
      ),
    )
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: /Liste erzeugen/i }),
    )
    await waitFor(() => expect(generated).toBe(true))
  })

  it('surfaces a 429-specific German message on generate rate-limit', async () => {
    server.use(
      respondWithPlan(),
      respondListNotFound(),
      http.post(
        `/api/mealplans/${PLAN_ID}/shopping-list/generate`,
        () =>
          HttpResponse.json(
            { code: 'shopping_list.rate_limited', message: 'Zu oft.' },
            { status: 429 },
          ),
      ),
    )
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: /Liste erzeugen/i }),
    )

    expect(
      await screen.findByText(/Zu viele Anfragen/i),
    ).toBeInTheDocument()
    // Defensive: the generic copy must *not* appear for 429.
    expect(
      screen.queryByText(/Liste konnte nicht erzeugt werden\./i),
    ).toBeNull()
  })

  it('renders the carryover badge (Repeat icon) for carried-over items', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({
          id: '1',
          name: 'Avocado',
          category: 'ObstGemuese',
          carriedOverFromPreviousWeek: true,
        }),
      ]),
    )
    render(withProviders())

    expect(
      await screen.findByLabelText(/Aus letzter Woche übernommen/i),
    ).toBeInTheDocument()
  })

  it('confirms before deleting a non-manual item and cancels when the user declines', async () => {
    const ITEM_ID = 'item-1'
    let called = false
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({
          id: ITEM_ID,
          name: 'Reis',
          category: 'Trockenwaren',
          source: 'FromPlan' satisfies ShoppingListItemSource,
        }),
      ]),
      http.delete(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        () => {
          called = true
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(withProviders())

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Reis entfernen/i }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(called).toBe(false)
    confirmSpy.mockRestore()
  })

  it('also confirms before deleting a manual item (user-typed = more precious)', async () => {
    const ITEM_ID = 'item-manual'
    let called = false
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({
          id: ITEM_ID,
          name: 'Toilettenpapier',
          category: 'Haushalt',
          source: 'Manual',
        }),
      ]),
      http.delete(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        () => {
          called = true
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: /Toilettenpapier entfernen/i }),
    )
    await waitFor(() => expect(called).toBe(true))
    expect(confirmSpy).toHaveBeenCalled()
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/wirklich löschen/i)
    confirmSpy.mockRestore()
  })

  it('opens the AddItemDialog when the "Eintrag" button is clicked', async () => {
    server.use(respondWithPlan(), respondWithList([]))
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: /Eintrag$/i }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: /Eintrag hinzufügen/i,
    })
    expect(within(dialog).getByLabelText(/^Name$/)).toBeInTheDocument()
  })

  it('persists the alphabetic sort mode to sessionStorage', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'Apfel', category: 'ObstGemuese' }),
      ]),
    )
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('radio', { name: /Alphabetisch/i }),
    )

    expect(
      window.sessionStorage.getItem(
        `shopping-sort-${GROUP_ID}-${WEEK_START}`,
      ),
    ).toBe('name')
  })

  it('renders the "Einträge hinzufügen" empty-state when the list has zero items', async () => {
    server.use(respondWithPlan(), respondWithList([]))
    render(withProviders())

    expect(
      await screen.findByText(/Noch keine Einträge/i),
    ).toBeInTheDocument()
  })
})
