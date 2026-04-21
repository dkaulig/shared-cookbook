import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CookFinishCard } from './CookFinishCard'

describe('CookFinishCard', () => {
  it('renders the celebration heading', () => {
    render(
      <CookFinishCard
        onMarkCooked={() => Promise.resolve()}
        markCookedPending={false}
        onClose={vi.fn()}
        onMarkedCooked={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: /Geschafft!/i })).toBeInTheDocument()
  })

  it('fires the mark-cooked mutation on primary button click', async () => {
    const user = userEvent.setup()
    const mutation = vi.fn().mockResolvedValue(undefined)
    render(
      <CookFinishCard
        onMarkCooked={mutation}
        markCookedPending={false}
        onClose={vi.fn()}
        onMarkedCooked={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it('invokes onMarkedCooked after the mutation resolves', async () => {
    const user = userEvent.setup()
    const onMarkedCooked = vi.fn()
    render(
      <CookFinishCard
        onMarkCooked={() => Promise.resolve()}
        markCookedPending={false}
        onClose={vi.fn()}
        onMarkedCooked={onMarkedCooked}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => expect(onMarkedCooked).toHaveBeenCalledTimes(1))
  })

  it('shows an inline error when the mutation rejects', async () => {
    const user = userEvent.setup()
    render(
      <CookFinishCard
        onMarkCooked={() => Promise.reject(new Error('api_down: offline'))}
        markCookedPending={false}
        onClose={vi.fn()}
        onMarkedCooked={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/offline/i)
    })
  })

  it('disables the primary button while markCookedPending is true', () => {
    render(
      <CookFinishCard
        onMarkCooked={() => Promise.resolve()}
        markCookedPending={true}
        onClose={vi.fn()}
        onMarkedCooked={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Speichere/i })).toBeDisabled()
  })

  it('fires onClose when the ghost "Schliessen" button is pressed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <CookFinishCard
        onMarkCooked={() => Promise.resolve()}
        markCookedPending={false}
        onClose={onClose}
        onMarkedCooked={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^Schliessen$/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
