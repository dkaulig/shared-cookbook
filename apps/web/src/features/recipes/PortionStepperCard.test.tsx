import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortionStepperCard } from './PortionStepperCard'

describe('PortionStepperCard — visual shell', () => {
  it('renders the PORTIONEN label, current value + "Personen" small caption', () => {
    render(
      <PortionStepperCard
        servings={4}
        onServingsChange={() => {}}
        groupDefaultServings={4}
        groupName="Familie"
      />,
    )
    // The word "Portionen" appears twice (label + the shortcut button's
    // copy); the uppercase label element is the one we're asserting here.
    const label = screen
      .getAllByText(/Portionen/i)
      .find((el) => el.className.includes('uppercase'))
    expect(label).toBeTruthy()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText(/Personen/i)).toBeInTheDocument()
  })

  it('renders the group-default ghost button with rounded group count', () => {
    render(
      <PortionStepperCard
        servings={4}
        onServingsChange={() => {}}
        groupDefaultServings={3}
        groupName="Example Family"
      />,
    )
    expect(
      screen.getByRole('button', { name: /Für Example Family umrechnen \(3 Portionen\)/i }),
    ).toBeInTheDocument()
  })
})

describe('PortionStepperCard — stepper behaviour', () => {
  it('calls onServingsChange with +1 when user clicks the increment button', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <PortionStepperCard
        servings={4}
        onServingsChange={handler}
        groupDefaultServings={4}
        groupName="Familie"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    expect(handler).toHaveBeenCalledWith(5)
  })

  it('calls onServingsChange with -1 when user clicks the decrement button', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <PortionStepperCard
        servings={4}
        onServingsChange={handler}
        groupDefaultServings={4}
        groupName="Familie"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Portion verringern/i }))
    expect(handler).toHaveBeenCalledWith(3)
  })

  it('does not go below 1 — clamps the emitted value to MIN=1', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <PortionStepperCard
        servings={1}
        onServingsChange={handler}
        groupDefaultServings={2}
        groupName="Familie"
      />,
    )
    // The button must be disabled at the lower bound so keyboard + screen-
    // reader users see the constraint; click is a no-op anyway.
    const dec = screen.getByRole('button', { name: /Portion verringern/i })
    expect(dec).toBeDisabled()
    await user.click(dec)
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not go above 99 — clamps the emitted value to MAX=99', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <PortionStepperCard
        servings={99}
        onServingsChange={handler}
        groupDefaultServings={2}
        groupName="Familie"
      />,
    )
    const inc = screen.getByRole('button', { name: /Portion erhöhen/i })
    expect(inc).toBeDisabled()
    await user.click(inc)
    expect(handler).not.toHaveBeenCalled()
  })

  it('emits the group default when the ghost button is clicked', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <PortionStepperCard
        servings={5}
        onServingsChange={handler}
        groupDefaultServings={2}
        groupName="Familie"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Für Familie umrechnen/i }))
    expect(handler).toHaveBeenCalledWith(2)
  })

  it('clamps a fractional group default to a safe integer when emitting', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(
      <PortionStepperCard
        servings={4}
        onServingsChange={handler}
        groupDefaultServings={2.5}
        groupName="Sparsam"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Für Sparsam umrechnen/i }))
    // Stepper is integer-only — fractional group defaults round to the
    // nearest integer when they become the servings state.
    expect(handler).toHaveBeenCalledWith(3)
  })
})
