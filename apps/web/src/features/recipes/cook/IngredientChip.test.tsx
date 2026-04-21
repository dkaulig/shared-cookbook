import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IngredientChip } from './IngredientChip'

describe('IngredientChip', () => {
  it('renders the matched text', () => {
    render(
      <IngredientChip text="Butter" ingredientId="i1" onActivate={vi.fn()} />,
    )
    expect(screen.getByText('Butter')).toBeInTheDocument()
  })

  it('fires onActivate with the ingredientId on click', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <IngredientChip text="Butter" ingredientId="i1" onActivate={handler} />,
    )
    await user.click(screen.getByRole('button', { name: /Butter/ }))
    expect(handler).toHaveBeenCalledWith('i1')
  })

  it('fires onActivate on Enter and Space keyboard activation', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <IngredientChip text="Butter" ingredientId="i1" onActivate={handler} />,
    )
    const chip = screen.getByRole('button', { name: /Butter/ })
    chip.focus()
    await user.keyboard('{Enter}')
    expect(handler).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenLastCalledWith('i1')
  })

  it('exposes a German aria-label including the ingredient text', () => {
    render(
      <IngredientChip text="Butter" ingredientId="i1" onActivate={vi.fn()} />,
    )
    expect(
      screen.getByLabelText(/Zutat Butter hervorheben/i),
    ).toBeInTheDocument()
  })
})
