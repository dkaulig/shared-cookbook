import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { MEALPLAN_POINTER_ACTIVATION, SortableMealRow } from './SortableMealRow'
import { SORT_ORDER_STEP } from './constants'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const GROUP_ID = '22222222-2222-2222-2222-222222222222'

function makeSlot(
  id: string,
  overrides: Partial<MealPlanSlotDto> = {},
): MealPlanSlotDto {
  return {
    id,
    mealPlanId: PLAN_ID,
    recipeId: null,
    recipeTitle: null,
    label: `Slot ${id}`,
    date: '2026-04-20',
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

function noop() {}

/**
 * SortableSlotCard uses `useNavigate` for the open-recipe icon button
 * (Bug 3 in v0.15.0), so every render needs a Router context. The
 * `MemoryRouter` wrapper here is the lightest possible thing that
 * satisfies that — child rendering inside the `Routes` is still the
 * SortableMealRow itself, untouched.
 */
function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

function PathProbe() {
  const location = useLocation()
  return <div data-testid="current-path">{location.pathname}</div>
}

describe('<SortableMealRow />', () => {
  it('renders slots in the given order with drag handles', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[
          makeSlot('a', { label: 'Alpha', sortOrder: 0 }),
          makeSlot('b', { label: 'Bravo', sortOrder: 10 }),
          makeSlot('c', { label: 'Charlie', sortOrder: 20 }),
        ]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    const cards = screen.getAllByTestId('mealplan-slot')
    expect(cards).toHaveLength(3)
    expect(cards[0]).toHaveTextContent('Alpha')
    expect(cards[1]).toHaveTextContent('Bravo')
    expect(cards[2]).toHaveTextContent('Charlie')
    expect(screen.getByTestId('mealplan-slot-drag-a')).toBeInTheDocument()
    expect(screen.getByTestId('mealplan-slot-drag-b')).toBeInTheDocument()
  })

  it('renders nothing when slots is empty', () => {
    const { container } = renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )
    // MemoryRouter renders nothing at the DOM layer when its child
    // returns null, so container is still empty.
    expect(container.firstChild).toBeNull()
  })

  it('fires onEdit with the clicked slot when the card body is clicked', async () => {
    const onEdit = vi.fn()
    const user = userEvent.setup()
    const slot = makeSlot('s1', { label: 'Linsencurry' })
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[slot]}
        onEdit={onEdit}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    await user.click(screen.getByTestId('mealplan-slot-edit-s1'))
    expect(onEdit).toHaveBeenCalledWith(slot)
  })

  it('fires onToggleCooked when the Gekocht checkbox is toggled', async () => {
    const onToggleCooked = vi.fn()
    const user = userEvent.setup()
    const slot = makeSlot('s1', { isCooked: false })
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[slot]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={onToggleCooked}
      />,
    )

    await user.click(screen.getByTestId('mealplan-slot-cooked-toggle-s1'))
    expect(onToggleCooked).toHaveBeenCalledWith(slot, true)
  })

  it('opens the overflow menu and fires onDelete when "Löschen" is clicked', async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    const slot = makeSlot('s1', { label: 'Alpha' })
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[slot]}
        onEdit={noop}
        onDelete={onDelete}
        onToggleCooked={noop}
      />,
    )

    await user.click(screen.getByTestId('mealplan-slot-menu-s1'))
    const deleteItem = await screen.findByRole('menuitem', { name: /Löschen/i })
    await user.click(deleteItem)

    expect(onDelete).toHaveBeenCalledWith(slot)
  })

  it('fires onEdit from the overflow menu "Bearbeiten" item', async () => {
    const onEdit = vi.fn()
    const user = userEvent.setup()
    const slot = makeSlot('s1', { label: 'Alpha' })
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[slot]}
        onEdit={onEdit}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    await user.click(screen.getByTestId('mealplan-slot-menu-s1'))
    const editItem = await screen.findByRole('menuitem', { name: /Bearbeiten/i })
    await user.click(editItem)

    expect(onEdit).toHaveBeenCalledWith(slot)
  })

  it('renders the cooked slot with a strikethrough title when isCooked is true', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[makeSlot('s1', { label: 'Linsencurry', isCooked: true })]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    const title = screen.getByText('Linsencurry')
    expect(title.className).toMatch(/line-through/)
    // Cooked icon + checked toggle both present.
    expect(screen.getByTestId('mealplan-slot-cooked')).toBeInTheDocument()
    expect(screen.getByTestId('mealplan-slot-cooked-toggle-s1')).toBeChecked()
  })

  it('exposes SORT_ORDER_STEP = 10 for the gap-between-slots scheme', () => {
    // Locked so future refactors don't silently shrink the gap to 1
    // and break the "drop between" optimisation P3-10 will rely on.
    expect(SORT_ORDER_STEP).toBe(10)
  })

  it('renders the "Rest von …" badge when getParentLabel returns a label', () => {
    const slot = makeSlot('s1', {
      label: 'Rest vom Sonntag',
      parentSlotId: 'parent-slot',
    })
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[slot]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
        getParentLabel={(s) =>
          s.parentSlotId === 'parent-slot' ? 'So Mittag' : null
        }
      />,
    )
    const badge = screen.getByTestId('mealplan-slot-parent-badge-s1')
    expect(badge).toHaveTextContent(/Rest von So Mittag/i)
  })

  it('omits the parent badge when the slot has no parent reference', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[makeSlot('s1', { parentSlotId: null })]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
        getParentLabel={() => null}
      />,
    )
    expect(
      screen.queryByTestId('mealplan-slot-parent-badge-s1'),
    ).not.toBeInTheDocument()
  })

  // ── P3-10 mobile polish ──────────────────────────────────────────

  it('configures the PointerSensor with a 5-px / 200-ms activation constraint', () => {
    // The exported constant is what `useSensor(PointerSensor, { … })`
    // wires up — keeping it discoverable means future tweaks have to
    // update tests deliberately. Per §P3-10: stop accidental taps from
    // triggering drag on mobile by raising distance + adding a delay.
    expect(MEALPLAN_POINTER_ACTIVATION).toEqual({
      distance: 5,
      delay: 200,
      tolerance: 5,
    })
  })

  it('renders the overflow-menu trigger with a ≥44-px tap target on mobile', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[makeSlot('s1', { label: 'Spaghetti' })]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )
    const menuButton = screen.getByTestId('mealplan-slot-menu-s1')
    // 44x44 hit-area enforced via Tailwind min-w/min-h utilities
    // (no class-name regex per se: we assert the resolved class string
    // includes the breakpoint utilities so a future visual refactor
    // doesn't silently shrink the tap area below the WCAG threshold).
    expect(menuButton.className).toMatch(/min-h-\[44px\]/)
    expect(menuButton.className).toMatch(/min-w-\[44px\]/)
  })

  // ── v0.15.0 Bug 1: recipe title fallback ─────────────────────────

  it('renders slot.recipeTitle when label is empty and a recipe is linked', () => {
    // Pre-v0.15.0 the card showed the literal string "Rezept" because
    // the recipe title was never resolved. Now the BE includes
    // `recipeTitle` in the DTO; the card prefers it over the literal.
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[
          makeSlot('s1', {
            label: null,
            recipeId: 'recipe-uuid',
            recipeTitle: 'Pasta Bolognese',
          }),
        ]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    expect(screen.getByText('Pasta Bolognese')).toBeInTheDocument()
    expect(screen.queryByText('Rezept')).not.toBeInTheDocument()
  })

  it('still falls back to "Rezept" when a recipe is linked but recipeTitle is null (e.g. soft-deleted)', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[
          makeSlot('s1', {
            label: null,
            recipeId: 'recipe-uuid',
            recipeTitle: null,
          }),
        ]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    expect(screen.getByText('Rezept')).toBeInTheDocument()
  })

  // ── v0.15.0 Bug 3: open-recipe icon button ───────────────────────

  it('renders an open-recipe icon button when slot.recipeId is set', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[
          makeSlot('s1', {
            label: 'Pasta',
            recipeId: 'recipe-uuid',
            recipeTitle: 'Pasta Bolognese',
          }),
        ]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    // Icon button discoverable by aria-label per design doc 2026-04-26.
    const button = screen.getByRole('button', {
      name: /Rezept öffnen/i,
    })
    expect(button).toBeInTheDocument()
  })

  it('does not render the open-recipe icon when slot.recipeId is null', () => {
    renderWithRouter(
      <SortableMealRow
        groupId={GROUP_ID}
        slots={[
          makeSlot('s1', {
            label: 'Restaurant',
            recipeId: null,
            recipeTitle: null,
          }),
        ]}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )

    expect(
      screen.queryByRole('button', { name: /Rezept öffnen/i }),
    ).not.toBeInTheDocument()
  })

  it('navigates to /groups/{groupId}/recipes/{recipeId} when the open-recipe icon is clicked', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/start']}>
        <Routes>
          <Route
            path="/start"
            element={
              <SortableMealRow
                groupId={GROUP_ID}
                slots={[
                  makeSlot('s1', {
                    label: 'Pasta',
                    recipeId: 'recipe-uuid',
                    recipeTitle: 'Pasta Bolognese',
                  }),
                ]}
                onEdit={noop}
                onDelete={noop}
                onToggleCooked={noop}
              />
            }
          />
          <Route path="*" element={<PathProbe />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: /Rezept öffnen/i }))
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      `/groups/${GROUP_ID}/recipes/recipe-uuid`,
    )
  })
})
