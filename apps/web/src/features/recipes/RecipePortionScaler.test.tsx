import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IngredientDto } from '@familien-kochbuch/shared'
import { RecipePortionScaler } from './RecipePortionScaler'

const INGREDIENTS: IngredientDto[] = [
  { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
  { id: 'i2', position: 1, quantity: 3, unit: 'Stück', name: 'Eier', note: null, scalable: true },
  { id: 'i3', position: 2, quantity: null, unit: '', name: 'Pfeffer', note: null, scalable: false },
  { id: 'i4', position: 3, quantity: 1, unit: 'Prise', name: 'Salz', note: null, scalable: false },
]

describe('RecipePortionScaler — initial render', () => {
  it('renders ingredient rows at the default servings count unchanged', () => {
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    expect(screen.getByText('500 g')).toBeInTheDocument()
    expect(screen.getByText('3 Stück')).toBeInTheDocument()
    expect(screen.getByText('nach Geschmack')).toBeInTheDocument()
    expect(screen.getByText('1 Prise')).toBeInTheDocument()
  })

  it('shows the default portion count in the input', () => {
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(4)
  })

  it('renders the group-default button with the target portion count', () => {
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    expect(
      screen.getByRole('button', { name: /Für Familie umrechnen \(2 Portionen\)/i }),
    ).toBeInTheDocument()
  })
})

describe('RecipePortionScaler — +/- buttons', () => {
  it('increments the servings count and rescales ingredients', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(5)
    // 500 g at 4 → 625 g at 5
    expect(screen.getByText('625 g')).toBeInTheDocument()
  })

  it('decrements the servings count and marks Stück rounding', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion verringern/i }))
    // At 3 servings, 3 Eier → 2.25 rounds to 2 with ~
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(3)
    expect(screen.getByText('~2 Stück')).toBeInTheDocument()
  })

  it('does not go below 1 portion via the decrement button', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={1}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion verringern/i }))
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(1)
  })
})

describe('RecipePortionScaler — direct input', () => {
  it('halves quantities when user types 2 with default 4', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={4}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    const input = screen.getByLabelText(/Portionen/i)
    await user.clear(input)
    await user.type(input, '2')
    expect(screen.getByText('250 g')).toBeInTheDocument()
  })

  it('rejects 0 and clamps to 1', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={4}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    const input = screen.getByLabelText(/Portionen/i)
    await user.clear(input)
    await user.type(input, '0')
    expect(input).toHaveValue(1)
  })

  it('clamps to max 99 when user types 150', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={4}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    const input = screen.getByLabelText(/Portionen/i)
    await user.clear(input)
    await user.type(input, '150')
    expect(input).toHaveValue(99)
  })
})

describe('RecipePortionScaler — group default button', () => {
  it('sets servings to group default and rescales', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Für Familie umrechnen/i }))
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(2)
    expect(screen.getByText('250 g')).toBeInTheDocument()
  })

  it('handles fractional group default servings for rendering but passes through scaling math', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2.5}
        groupName="Sparsame Familie"
        ingredients={INGREDIENTS}
      />,
    )
    // Button label shows rounded number for readability
    const button = screen.getByRole('button', { name: /Für Sparsame Familie umrechnen/i })
    await user.click(button)
    // 500 g at 4 → 312.5 g at 2.5
    expect(screen.getByText('312.5 g')).toBeInTheDocument()
  })
})

describe('RecipePortionScaler — non-scalable handling', () => {
  it('keeps "nach Geschmack" label regardless of slider position', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    expect(screen.getByText('nach Geschmack')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    expect(screen.getByText('nach Geschmack')).toBeInTheDocument()
  })

  it('keeps static Prise label for scalable:false entries', async () => {
    const user = userEvent.setup()
    render(
      <RecipePortionScaler
        defaultServings={4}
        groupDefaultServings={2}
        groupName="Familie"
        ingredients={INGREDIENTS}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    expect(screen.getByText('1 Prise')).toBeInTheDocument()
  })
})
