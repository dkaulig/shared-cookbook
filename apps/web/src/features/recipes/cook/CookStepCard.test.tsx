import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecipeStepDto } from '@familien-kochbuch/shared'
import { CookStepCard } from './CookStepCard'
import { CookBottomBar } from './CookBottomBar'

const STEP: RecipeStepDto = {
  id: 's1',
  position: 0,
  content: 'Mehl in eine Schüssel geben.',
}

describe('CookStepCard', () => {
  it('renders the step number, total + step text', () => {
    render(<CookStepCard step={STEP} stepNumber={2} totalSteps={5} />)
    expect(screen.getByText(/Schritt 2 von 5/i)).toBeInTheDocument()
    expect(screen.getByText('Mehl in eine Schüssel geben.')).toBeInTheDocument()
  })

  it('uses large typography on the step body (≥22px)', () => {
    render(<CookStepCard step={STEP} stepNumber={1} totalSteps={3} />)
    const body = screen.getByTestId('cook-step-content')
    // 22px at md breakpoint and up; we assert the Tailwind class is
    // present rather than parsing computed styles (jsdom has no layout
    // engine).
    expect(body.className).toMatch(/text-\[22px\]/)
  })
})

describe('CookStepCard — bottom-bar integration', () => {
  it('disables the back button on step 1', () => {
    const onBack = vi.fn()
    const onNext = vi.fn()
    render(
      <CookBottomBar
        backDisabled={true}
        nextLabel="Weiter"
        nextIsFinish={false}
        onBack={onBack}
        onNext={onNext}
      />,
    )
    expect(screen.getByRole('button', { name: /Zurück/i })).toBeDisabled()
  })

  it('changes the next-button label to "Fertig" on the last step', () => {
    render(
      <CookBottomBar
        backDisabled={false}
        nextLabel="Fertig"
        nextIsFinish={true}
        onBack={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /^Fertig$/i })).toBeInTheDocument()
  })

  it('fires the next handler on click', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()
    render(
      <CookBottomBar
        backDisabled={false}
        nextLabel="Weiter"
        nextIsFinish={false}
        onBack={vi.fn()}
        onNext={onNext}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})
