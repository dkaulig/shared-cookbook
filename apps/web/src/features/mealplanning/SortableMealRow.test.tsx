import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { MEALPLAN_POINTER_ACTIVATION, SortableMealRow } from './SortableMealRow'
import { SORT_ORDER_STEP } from './constants'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'

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

describe('<SortableMealRow />', () => {
  it('renders slots in the given order with drag handles', () => {
    render(
      <SortableMealRow
        slots={[
          makeSlot('a', { label: 'Alpha', sortOrder: 0 }),
          makeSlot('b', { label: 'Bravo', sortOrder: 10 }),
          makeSlot('c', { label: 'Charlie', sortOrder: 20 }),
        ]}
        onReorder={noop}
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
    const { container } = render(
      <SortableMealRow
        slots={[]}
        onReorder={noop}
        onEdit={noop}
        onDelete={noop}
        onToggleCooked={noop}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('fires onEdit with the clicked slot when the card body is clicked', async () => {
    const onEdit = vi.fn()
    const user = userEvent.setup()
    const slot = makeSlot('s1', { label: 'Linsencurry' })
    render(
      <SortableMealRow
        slots={[slot]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[slot]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[slot]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[slot]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[makeSlot('s1', { label: 'Linsencurry', isCooked: true })]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[slot]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[makeSlot('s1', { parentSlotId: null })]}
        onReorder={noop}
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
    render(
      <SortableMealRow
        slots={[makeSlot('s1', { label: 'Spaghetti' })]}
        onReorder={noop}
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
})
