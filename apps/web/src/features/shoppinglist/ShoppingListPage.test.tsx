import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    version: 0,
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

  // BUG-004 — deletion now flows through the shared ConfirmDialog
  // primitive instead of the native `window.confirm`. Both the plan-
  // derived ("FromPlan") and manual rows use the same guardrail.
  it('opens ConfirmDialog when deleting a non-manual item and does NOT fire DELETE on cancel', async () => {
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
    render(withProviders())

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Reis entfernen/i }))
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    expect(called).toBe(false)
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    expect(called).toBe(false)
  })

  it('opens ConfirmDialog for a manual item too and fires DELETE on confirm', async () => {
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
    render(withProviders())

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: /Toilettenpapier entfernen/i }),
    )
    expect(
      await screen.findByRole('heading', { name: /Zutat wirklich löschen\?/i }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Löschen$/i }))
    await waitFor(() => expect(called).toBe(true))
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

  // ── P3-10 mobile polish ────────────────────────────────────────

  it('renders the per-row delete button with a ≥44-px tap target', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'Milch', category: 'Molkerei' }),
      ]),
    )
    render(withProviders())

    const deleteButton = await screen.findByLabelText('Milch entfernen')
    // WCAG 2.1 §2.5.5 / Apple HIG: minimum 44×44 CSS-pixel tap target.
    // Asserting the Tailwind utility classes keeps the contract visible
    // — a layout refactor that drops them will fail this test.
    expect(deleteButton.className).toMatch(/min-h-\[44px\]/)
    expect(deleteButton.className).toMatch(/min-w-\[44px\]/)
  })

  it('renders the check-off control with a ≥44-px tap target', async () => {
    server.use(
      respondWithPlan(),
      respondWithList([
        makeItem({ id: '1', name: 'Milch', category: 'Molkerei' }),
      ]),
    )
    render(withProviders())

    const checkbox = await screen.findByRole('checkbox', { name: /Milch/i })
    expect(checkbox.className).toMatch(/min-h-\[44px\]/)
    expect(checkbox.className).toMatch(/min-w-\[44px\]/)
  })

  it('OFF4 — opens the conflict dialog when PATCH returns 409; Keep-Local retries with new If-Match', async () => {
    const ITEM_ID = 'item-42'
    const item = makeItem({
      id: ITEM_ID,
      name: 'Milch',
      category: 'Molkerei',
    })
    let patchCallCount = 0
    const ifMatchHeaders: Array<string | null> = []

    server.use(
      respondWithPlan(),
      respondWithList([item]),
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        async ({ request }) => {
          patchCallCount++
          ifMatchHeaders.push(request.headers.get('If-Match'))
          if (patchCallCount === 1) {
            // First call → 409 with the updated server list (version 7).
            const serverList = makeList([
              { ...item, isChecked: false },
            ])
            serverList.version = 7
            return HttpResponse.json(
              {
                code: 'version_mismatch',
                message: 'Der Eintrag wurde zwischenzeitlich geändert.',
                current: serverList,
              },
              { status: 409 },
            )
          }
          // Retry succeeds.
          return HttpResponse.json({ ...item, isChecked: true })
        },
      ),
    )
    render(withProviders())

    const user = userEvent.setup()
    const checkbox = await screen.findByRole('checkbox', {
      name: /Milch abhaken$/i,
    })
    await user.click(checkbox)

    // Dialog opens.
    const dialog = await screen.findByRole('dialog', {
      name: /Konflikt in der Einkaufsliste/,
    })
    expect(dialog).toBeInTheDocument()

    // Keep-Local retries.
    await user.click(
      within(dialog).getByRole('button', { name: /Lokal behalten/i }),
    )

    await waitFor(() => expect(patchCallCount).toBe(2))
    // Second call must carry an If-Match against the new server version 7.
    expect(ifMatchHeaders[1]).toMatch(/W\/"[^"]+-7"/)
  })
})

// BUG-032 — source-level grep gate. See MealPlanPage.test.tsx for the
// full rationale; the ShoppingList sub-nav shares the same anchor and
// z-index pattern.
describe('ShoppingListPage sticky sub-nav (BUG-032)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const SOURCE = readFileSync(resolve(HERE, 'ShoppingListPage.tsx'), 'utf8')

  it('uses sticky top-[var(--topnav-height)] — no hard-coded sticky top-[56px]', () => {
    expect(SOURCE).toContain('sticky top-[var(--topnav-height)]')
    // See MealPlanPage's gate test for why we match the sticky-classname
    // pattern rather than substring-search for `top-[56px]` alone.
    expect(SOURCE).not.toMatch(/sticky\s+top-\[56px\]/)
  })

  it('sub-nav nav element sits below TopNav (z-10, not z-20)', () => {
    expect(SOURCE).toMatch(/sticky top-\[var\(--topnav-height\)\] z-10/)
  })
})
