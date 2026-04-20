import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CHAT_SESSION_TITLE_MAX_LENGTH,
  RenameSessionDialog,
} from './RenameSessionDialog'

describe('<RenameSessionDialog />', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <RenameSessionDialog
        open={false}
        initialTitle={null}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('prefills the input with the existing title and selects it', async () => {
    render(
      <RenameSessionDialog
        open={true}
        initialTitle="Omelette"
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )
    const input = screen.getByLabelText(/Titel/) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('Omelette'))
  })

  it('submits the trimmed title and closes the dialog on success', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(t: string) => void>()
    render(
      <RenameSessionDialog
        open={true}
        initialTitle="Altes"
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByLabelText(/Titel/)
    await user.clear(input)
    await user.type(input, '  Neuer Titel  ')
    await user.click(screen.getByRole('button', { name: /Speichern/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Neuer Titel'))
  })

  it('keeps the submit button disabled on an empty / whitespace-only input', async () => {
    const user = userEvent.setup()
    render(
      <RenameSessionDialog
        open={true}
        initialTitle=""
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )
    const submit = screen.getByRole('button', { name: /Speichern/ })
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText(/Titel/), '   ')
    expect(submit).toBeDisabled()
  })

  it('caps the title at the backend max length', async () => {
    render(
      <RenameSessionDialog
        open={true}
        initialTitle=""
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    )
    const input = screen.getByLabelText(/Titel/) as HTMLInputElement
    expect(input.maxLength).toBe(CHAT_SESSION_TITLE_MAX_LENGTH)
  })

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <RenameSessionDialog
        open={true}
        initialTitle=""
        onOpenChange={onOpenChange}
        onSubmit={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Abbrechen/ }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('surfaces an error string via role="alert"', () => {
    render(
      <RenameSessionDialog
        open={true}
        initialTitle="X"
        onOpenChange={() => {}}
        onSubmit={() => {}}
        error="Serverfehler."
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Serverfehler/)
  })
})
