import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ShoppingListItemDto } from '@familien-kochbuch/shared'
import { ItemConflictBody } from './ItemConflictBody'

function makeItem(
  overrides: Partial<ShoppingListItemDto> = {},
): ShoppingListItemDto {
  return {
    id: 'i1',
    shoppingListId: 'l1',
    name: 'Äpfel',
    quantity: '5',
    unit: 'Stück',
    note: null,
    isChecked: false,
    category: 'ObstGemuese',
    source: 'FromPlan',
    sortOrder: 0,
    carriedOverFromPreviousWeek: false,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...overrides,
  }
}

describe('<ItemConflictBody />', () => {
  it('renders both sides when isChecked toggled', () => {
    const server = makeItem({ isChecked: true })
    const local = makeItem({ isChecked: false })
    render(<ItemConflictBody current={server} local={local} />)

    // "Ja" + "Nein" side-by-side for the Abgehakt field.
    expect(screen.getByText('Ja')).toBeInTheDocument()
    expect(screen.getByText('Nein')).toBeInTheDocument()
    expect(screen.getAllByTestId('conflict-side-server').length).toBeGreaterThan(0)
  })

  it('renders both sides for a quantity change', () => {
    const server = makeItem({ quantity: '5' })
    const local = makeItem({ quantity: '10' })
    render(<ItemConflictBody current={server} local={local} />)

    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
  })

  it('renders both sides for a name change', () => {
    const server = makeItem({ name: 'Äpfel' })
    const local = makeItem({ name: 'Birnen' })
    render(<ItemConflictBody current={server} local={local} />)

    expect(screen.getByText('Äpfel')).toBeInTheDocument()
    expect(screen.getByText('Birnen')).toBeInTheDocument()
  })
})
