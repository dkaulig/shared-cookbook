import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { SlotConflictBody } from './SlotConflictBody'

function makeSlot(overrides: Partial<MealPlanSlotDto> = {}): MealPlanSlotDto {
  return {
    id: 's1',
    mealPlanId: 'p1',
    recipeId: null,
    recipeTitle: null,
    label: 'Nudeln',
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

describe('<SlotConflictBody />', () => {
  it('renders both sides for a meal change (Mittag vs Abend)', () => {
    const server = makeSlot({ meal: 'Abend' })
    const local = makeSlot({ meal: 'Mittag' })
    render(<SlotConflictBody current={server} local={local} />)

    expect(screen.getByText('Abend')).toBeInTheDocument()
    expect(screen.getByText('Mittag')).toBeInTheDocument()
    // Side-by-side sections
    expect(screen.getAllByTestId('conflict-side-server').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('conflict-side-local').length).toBeGreaterThan(0)
  })

  it('renders a servings change (2 vs 5) on both sides', () => {
    const server = makeSlot({ servings: 2 })
    const local = makeSlot({ servings: 5 })
    render(<SlotConflictBody current={server} local={local} />)

    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })
})
