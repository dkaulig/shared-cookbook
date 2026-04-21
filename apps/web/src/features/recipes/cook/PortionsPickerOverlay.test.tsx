import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortionsPickerOverlay } from './PortionsPickerOverlay'

/**
 * Tiny stateful wrapper so the tests can drive the stepper through the
 * same controlled-value API the CookModePage uses, without having to
 * reach into the component's internals.
 */
function Harness({
  initial = 4,
  defaultServings = 4,
  onConfirm,
  onCancel,
}: {
  initial?: number
  defaultServings?: number
  onConfirm?: () => void
  onCancel?: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <PortionsPickerOverlay
      value={value}
      onChange={setValue}
      onConfirm={() => onConfirm?.()}
      onCancel={() => onCancel?.()}
      recipeDefaultServings={defaultServings}
    />
  )
}

describe('PortionsPickerOverlay', () => {
  it('renders the passed default servings value', () => {
    render(<Harness initial={6} defaultServings={4} />)
    // The large numeric display should read "6".
    expect(screen.getByText('6')).toBeInTheDocument()
    // The hint mentions the recipe's own default servings.
    expect(
      screen.getByText(/ursprünglich für 4 Portionen angelegt/i),
    ).toBeInTheDocument()
  })

  it('increments the value via the plus button', async () => {
    const user = userEvent.setup()
    render(<Harness initial={2} defaultServings={2} />)
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('decrements the value via the minus button', async () => {
    const user = userEvent.setup()
    render(<Harness initial={4} defaultServings={4} />)
    await user.click(screen.getByRole('button', { name: /Portion verringern/i }))
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('disables the minus button at the minimum (1)', () => {
    render(<Harness initial={1} defaultServings={1} />)
    const minus = screen.getByRole('button', { name: /Portion verringern/i })
    expect(minus).toBeDisabled()
  })

  it('fires the confirm callback when "Weiter" is pressed', async () => {
    const user = userEvent.setup()
    const confirm = vi.fn()
    render(<Harness initial={3} defaultServings={3} onConfirm={confirm} />)
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('fires the cancel callback when "Abbrechen" is pressed', async () => {
    const user = userEvent.setup()
    const cancel = vi.fn()
    render(<Harness initial={2} defaultServings={2} onCancel={cancel} />)
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
