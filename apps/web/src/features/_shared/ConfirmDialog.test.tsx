import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmDialog, useConfirmDialog } from './ConfirmDialog'

/**
 * BUG-004 regression tests for the shared ConfirmDialog primitive.
 *
 * Covers both the controlled-component shape (explicit `open` +
 * `onOpenChange`) and the async hook-based variant (`useConfirmDialog`)
 * so every destructive sweep-site downstream has a working contract.
 */
describe('<ConfirmDialog />', () => {
  it('renders the title, description and both action labels', () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="Rezept wirklich löschen?"
        description="Diese Aktion kann nicht rückgängig gemacht werden."
        onConfirm={() => {}}
      />,
    )

    expect(
      screen.getByRole('heading', { name: /Rezept wirklich löschen\?/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Diese Aktion kann nicht rückgängig/i),
    ).toBeInTheDocument()
    // Defaults: Bestätigen + Abbrechen.
    expect(screen.getByRole('button', { name: /^Bestätigen$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Abbrechen$/i })).toBeInTheDocument()
  })

  it('uses destructive variant by default (safety-first)', () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="Delete?"
        description="Bang."
        onConfirm={() => {}}
      />,
    )
    const confirmButton = screen.getByRole('button', { name: /^Bestätigen$/i })
    // The shadcn `destructive` variant tokens include a destructive-bg
    // class — assert its presence so a future variant-default swap trips
    // this test instead of silently flipping the safety default.
    expect(confirmButton.className).toMatch(/bg-destructive|destructive/)
  })

  it('respects custom labels and the non-destructive variant', () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="Fortfahren?"
        description="…"
        confirmLabel="Weiter"
        cancelLabel="Zurück"
        confirmVariant="default"
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /^Weiter$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Zurück$/i })).toBeInTheDocument()
  })

  it('does not render when open=false', () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title="Hidden"
        description="Hidden"
        onConfirm={() => {}}
      />,
    )
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('calls onConfirm when the confirm button is clicked', async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Bang."
        onConfirm={onConfirm}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Bestätigen$/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenChange(false) and NOT onConfirm when Cancel is clicked', async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Bang."
        onConfirm={onConfirm}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('closes via ESC (onOpenChange(false)) without calling onConfirm', async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Bang."
        onConfirm={onConfirm}
      />,
    )
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('closes via outside (backdrop) click', async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Bang."
        onConfirm={onConfirm}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('confirm-dialog'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables both buttons + renders spinner when isLoading=true', () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={() => {}}
        title="Delete?"
        description="Bang."
        onConfirm={() => {}}
        isLoading={true}
      />,
    )
    const confirmButton = screen.getByRole('button', { name: /Bestätigen/i })
    const cancelButton = screen.getByRole('button', { name: /^Abbrechen$/i })
    expect(confirmButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()
    expect(screen.getByTestId('confirm-dialog-spinner')).toBeInTheDocument()
  })

  it('does not dismiss on backdrop click while isLoading', async () => {
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete?"
        description="Bang."
        onConfirm={() => {}}
        isLoading={true}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('confirm-dialog'))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('useConfirmDialog()', () => {
  function HookHarness({
    onResult,
  }: {
    onResult: (value: boolean) => void
  }) {
    const { confirm, ConfirmDialogElement } = useConfirmDialog()
    const [busy, setBusy] = useState(false)
    return (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const ok = await confirm({
              title: 'Fortfahren?',
              description: 'Async-Variante.',
            })
            onResult(ok)
            setBusy(false)
          }}
        >
          Trigger
        </button>
        {ConfirmDialogElement}
      </>
    )
  }

  it('resolves true when the user confirms', async () => {
    const onResult = vi.fn()
    render(<HookHarness onResult={onResult} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Trigger/i }))
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Bestätigen$/i }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    // Dialog tears itself down after confirm.
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('resolves false when the user cancels', async () => {
    const onResult = vi.fn()
    render(<HookHarness onResult={onResult} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Trigger/i }))
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
  })
})
