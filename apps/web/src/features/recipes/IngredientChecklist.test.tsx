import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IngredientDto } from '@shared-cookbook/shared'
import { IngredientChecklist } from './IngredientChecklist'

const INGREDIENTS: IngredientDto[] = [
  { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
  { id: 'i2', position: 1, quantity: 2, unit: 'Stück', name: 'Eier', note: null, scalable: true },
  {
    id: 'i3',
    position: 2,
    quantity: 60,
    unit: 'g',
    name: 'Butter',
    note: 'zum Ausbraten',
    scalable: true,
  },
  {
    id: 'i4',
    position: 3,
    quantity: null,
    unit: '',
    name: 'Salz & Pfeffer · Muskatnuss',
    note: null,
    scalable: false,
  },
]

describe('IngredientChecklist — initial render', () => {
  it('renders every ingredient name as a distinct row', () => {
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    expect(screen.getByText('Mehl')).toBeInTheDocument()
    expect(screen.getByText('Eier')).toBeInTheDocument()
    expect(screen.getByText('Butter')).toBeInTheDocument()
    expect(screen.getByText('Salz & Pfeffer · Muskatnuss')).toBeInTheDocument()
  })

  it('renders ingredient rows as role="checkbox" with aria-checked=false by default', () => {
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    const rows = screen.getAllByRole('checkbox')
    expect(rows).toHaveLength(4)
    rows.forEach((row) => expect(row).toHaveAttribute('aria-checked', 'false'))
  })

  it('renders an explicit "nach Geschmack" italic for null-quantity rows', () => {
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    const italic = screen.getByText(/nach Geschmack/i)
    expect(italic.tagName.toLowerCase()).toBe('em')
  })

  it('renders the "Stück" unit label in italic per mockup', () => {
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    const italicStueck = screen.getByText('Stück')
    expect(italicStueck.tagName.toLowerCase()).toBe('em')
  })

  it('renders ingredient notes as a small sub-line under the name', () => {
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    expect(screen.getByText('zum Ausbraten')).toBeInTheDocument()
  })
})

describe('IngredientChecklist — live scaling', () => {
  it('re-computes displayed quantities when servings prop changes', () => {
    const { rerender } = render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    expect(screen.getByText('500 g')).toBeInTheDocument()

    rerender(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={2}
      />,
    )
    expect(screen.getByText('250 g')).toBeInTheDocument()
  })
})

describe('IngredientChecklist — check toggle', () => {
  it('toggles aria-checked on click and back to unchecked on second click', async () => {
    const user = userEvent.setup()
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    const first = screen.getAllByRole('checkbox')[0]!
    expect(first).toHaveAttribute('aria-checked', 'false')
    await user.click(first)
    expect(first).toHaveAttribute('aria-checked', 'true')
    await user.click(first)
    expect(first).toHaveAttribute('aria-checked', 'false')
  })

  it('tracks independent check states per ingredient', async () => {
    const user = userEvent.setup()
    render(
      <IngredientChecklist
        ingredients={INGREDIENTS}
        defaultServings={4}
        servings={4}
      />,
    )
    const rows = screen.getAllByRole('checkbox')
    await user.click(rows[0]!)
    await user.click(rows[2]!)
    expect(rows[0]).toHaveAttribute('aria-checked', 'true')
    expect(rows[1]).toHaveAttribute('aria-checked', 'false')
    expect(rows[2]).toHaveAttribute('aria-checked', 'true')
    expect(rows[3]).toHaveAttribute('aria-checked', 'false')
  })

  it('falls back to a position-based key when the ingredient has no id', () => {
    const ingredientsNoIds: IngredientDto[] = [
      { position: 0, quantity: 1, unit: 'kg', name: 'Kartoffeln', note: null, scalable: true },
      { position: 1, quantity: 200, unit: 'g', name: 'Zwiebeln', note: null, scalable: true },
    ]
    render(
      <IngredientChecklist
        ingredients={ingredientsNoIds}
        defaultServings={2}
        servings={2}
      />,
    )
    const rows = screen.getAllByRole('checkbox')
    expect(rows).toHaveLength(2)
  })
})
