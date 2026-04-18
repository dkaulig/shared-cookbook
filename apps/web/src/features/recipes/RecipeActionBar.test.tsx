import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecipeActionBar } from './RecipeActionBar'

describe('RecipeActionBar', () => {
  it('renders the ghost "In Wochenplan" + primary "Jetzt gekocht" buttons', () => {
    render(
      <RecipeActionBar
        onMarkCooked={() => {}}
        markCookedPending={false}
      />,
    )
    expect(screen.getByRole('button', { name: /In Wochenplan/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Jetzt gekocht/i })).toBeInTheDocument()
  })

  it('fires onMarkCooked when the primary button is clicked', async () => {
    const user = userEvent.setup()
    const handler = vi.fn().mockResolvedValue(undefined)
    render(
      <RecipeActionBar onMarkCooked={handler} markCookedPending={false} />,
    )
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('disables the Jetzt-gekocht button while a mutation is pending', () => {
    render(
      <RecipeActionBar onMarkCooked={() => {}} markCookedPending={true} />,
    )
    expect(screen.getByRole('button', { name: /Jetzt gekocht/i })).toBeDisabled()
  })

  it('shows a transient "wurde als gekocht markiert" message on success', async () => {
    const user = userEvent.setup()
    const handler = vi.fn().mockResolvedValue(undefined)
    render(
      <RecipeActionBar onMarkCooked={handler} markCookedPending={false} />,
    )
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/als gekocht markiert/i)
    })
  })

  it('shows the "Wochenplan kommt in Phase 3" message when the ghost button is clicked', async () => {
    const user = userEvent.setup()
    render(
      <RecipeActionBar onMarkCooked={() => {}} markCookedPending={false} />,
    )
    await user.click(screen.getByRole('button', { name: /In Wochenplan/i }))
    expect(screen.getByRole('status')).toHaveTextContent(/Phase 3/i)
  })

  it('surfaces an error message when the mark-cooked mutation rejects', async () => {
    const user = userEvent.setup()
    const handler = vi.fn().mockRejectedValue(new Error('api_down: offline'))
    render(
      <RecipeActionBar onMarkCooked={handler} markCookedPending={false} />,
    )
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/offline/i)
    })
  })
})
