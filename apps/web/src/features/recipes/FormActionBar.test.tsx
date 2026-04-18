import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormActionBar } from './FormActionBar'

describe('<FormActionBar />', () => {
  it('renders the ghost Abbrechen + primary Rezept-speichern buttons', () => {
    render(
      <FormActionBar
        mode="create"
        pending={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /Abbrechen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Rezept speichern/i })).toBeInTheDocument()
  })

  it('fires onCancel when the ghost button is tapped', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(
      <FormActionBar
        mode="create"
        pending={false}
        onCancel={onCancel}
        onSubmit={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Abbrechen/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onSubmit when the primary button is tapped', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <FormActionBar
        mode="create"
        pending={false}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('disables the primary button and swaps the label when pending', () => {
    render(
      <FormActionBar
        mode="create"
        pending={true}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    )
    const primary = screen.getByRole('button', { name: /Speichere/i })
    expect(primary).toBeDisabled()
  })

  it('uses "Änderungen speichern" as the primary label in edit mode', () => {
    render(
      <FormActionBar
        mode="edit"
        pending={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /Änderungen speichern/i })).toBeInTheDocument()
  })
})
