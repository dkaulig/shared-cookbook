import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConflictDialog, useConflictResolver } from './ConflictDialog'

type Dto = { id: string; version: number; title: string }

const server: Dto = { id: 'x', version: 2, title: 'Server-Titel' }
const local: Dto = { id: 'x', version: 1, title: 'Lokaler Titel' }

function DiffStub({ current, local }: { current: Dto; local: Dto }) {
  return (
    <div>
      <p data-testid="diff-server">{current.title}</p>
      <p data-testid="diff-local">{local.title}</p>
    </div>
  )
}

describe('<ConflictDialog />', () => {
  it('renders title, subtitle, body + two buttons (no merge)', () => {
    render(
      <ConflictDialog<Dto>
        open
        onClose={() => {}}
        title="Konflikt im Rezept"
        subtitle="Deine Änderungen konkurrieren mit einer Änderung vom Server."
        currentServer={server}
        localPending={local}
        renderDiff={(p) => <DiffStub {...p} />}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
      />,
    )

    expect(
      screen.getByRole('heading', { name: /Konflikt im Rezept/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Deine Änderungen/)).toBeInTheDocument()
    expect(screen.getByTestId('diff-server')).toHaveTextContent('Server-Titel')
    expect(screen.getByTestId('diff-local')).toHaveTextContent('Lokaler Titel')
    expect(
      screen.getByRole('button', { name: /Lokal behalten/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Server übernehmen/i }),
    ).toBeInTheDocument()
    // No merge button.
    expect(
      screen.queryByRole('button', { name: /Manuell zusammenführen/i }),
    ).not.toBeInTheDocument()
  })

  it('has a11y attributes (role=dialog, aria-modal, aria-labelledby)', () => {
    render(
      <ConflictDialog<Dto>
        open
        onClose={() => {}}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'conflict-dialog-title')
  })

  it('fires onKeepLocal + onClose when the local button is clicked', async () => {
    const onKeepLocal = vi.fn()
    const onKeepServer = vi.fn()
    const onClose = vi.fn()
    render(
      <ConflictDialog<Dto>
        open
        onClose={onClose}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={onKeepLocal}
        onKeepServer={onKeepServer}
      />,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Lokal behalten/i }))
    await waitFor(() => {
      expect(onKeepLocal).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
    expect(onKeepServer).not.toHaveBeenCalled()
  })

  it('fires onKeepServer + onClose when the server button is clicked', async () => {
    const onKeepLocal = vi.fn()
    const onKeepServer = vi.fn()
    const onClose = vi.fn()
    render(
      <ConflictDialog<Dto>
        open
        onClose={onClose}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={onKeepLocal}
        onKeepServer={onKeepServer}
      />,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Server übernehmen/i }))
    await waitFor(() => {
      expect(onKeepServer).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('renders the merge button when onManualMerge is provided', async () => {
    const onManualMerge = vi.fn()
    render(
      <ConflictDialog<Dto>
        open
        onClose={() => {}}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
        onManualMerge={onManualMerge}
      />,
    )
    const mergeButton = screen.getByRole('button', {
      name: /Manuell zusammenführen/i,
    })
    expect(mergeButton).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(mergeButton)
    await waitFor(() => {
      expect(onManualMerge).toHaveBeenCalledTimes(1)
      // Called with the localPending value (as spec'd in the
      // ConflictDialog body).
      expect(onManualMerge).toHaveBeenCalledWith(local)
    })
  })

  it('closes via Escape key', async () => {
    const onClose = vi.fn()
    render(
      <ConflictDialog<Dto>
        open
        onClose={onClose}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
      />,
    )
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via backdrop click', async () => {
    const onClose = vi.fn()
    render(
      <ConflictDialog<Dto>
        open
        onClose={onClose}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('conflict-dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables all buttons while isLoading is true', () => {
    render(
      <ConflictDialog<Dto>
        open
        onClose={() => {}}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
        isLoading
      />,
    )
    expect(screen.getByRole('button', { name: /Lokal behalten/i })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: /Server übernehmen/i }),
    ).toBeDisabled()
  })

  it('traps focus — Tab from last button wraps to the first', async () => {
    const onClose = vi.fn()
    render(
      <ConflictDialog<Dto>
        open
        onClose={onClose}
        title="t"
        currentServer={server}
        localPending={local}
        renderDiff={() => null}
        onKeepLocal={() => {}}
        onKeepServer={() => {}}
      />,
    )
    // Focus lands on the first action button on mount; tabbing from the
    // last focusable back to the first is the smoke-test contract.
    const first = screen.getByTestId('conflict-dialog-keep-local')
    const last = screen.getByTestId('conflict-dialog-keep-server')
    last.focus()
    const user = userEvent.setup()
    await user.tab()
    await waitFor(() => expect(document.activeElement).toBe(first))
  })
})

// ── useConflictResolver ────────────────────────────────────────────

function ResolverHarness({
  onKeepLocal,
  onKeepServer,
}: {
  onKeepLocal: (expected: number, local: Dto) => Promise<unknown>
  onKeepServer: () => void | Promise<void>
}) {
  const r = useConflictResolver<Dto>({ onKeepLocal, onKeepServer })
  return (
    <div>
      <button
        type="button"
        onClick={() => r.captureFrom409(local, { current: server })}
      >
        Trigger-409
      </button>
      {r.state && (
        <div data-testid="dialog-open">
          <p data-testid="server-version">{r.state.serverCurrent.version}</p>
          <button type="button" onClick={() => void r.resolveKeepLocal()}>
            KL
          </button>
          <button type="button" onClick={() => void r.resolveKeepServer()}>
            KS
          </button>
        </div>
      )}
    </div>
  )
}

describe('useConflictResolver()', () => {
  it('capture-then-keep-local invokes onKeepLocal(serverVersion, local)', async () => {
    const onKeepLocal = vi.fn(async () => {})
    const onKeepServer = vi.fn()
    render(
      <ResolverHarness onKeepLocal={onKeepLocal} onKeepServer={onKeepServer} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Trigger-409/ }))
    expect(await screen.findByTestId('dialog-open')).toBeInTheDocument()
    expect(screen.getByTestId('server-version')).toHaveTextContent('2')
    await user.click(screen.getByRole('button', { name: /^KL$/ }))
    await waitFor(() => {
      expect(onKeepLocal).toHaveBeenCalledWith(2, local)
    })
  })

  it('capture-then-keep-server invokes onKeepServer', async () => {
    const onKeepLocal = vi.fn()
    const onKeepServer = vi.fn()
    render(
      <ResolverHarness onKeepLocal={onKeepLocal} onKeepServer={onKeepServer} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Trigger-409/ }))
    await user.click(screen.getByRole('button', { name: /^KS$/ }))
    await waitFor(() => expect(onKeepServer).toHaveBeenCalledTimes(1))
    expect(onKeepLocal).not.toHaveBeenCalled()
  })

  it('resolving clears state so a second 409 can open a fresh dialog', async () => {
    const onKeepLocal = vi.fn(async () => {})
    const onKeepServer = vi.fn()
    render(
      <ResolverHarness onKeepLocal={onKeepLocal} onKeepServer={onKeepServer} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Trigger-409/ }))
    await user.click(screen.getByRole('button', { name: /^KL$/ }))
    await waitFor(() =>
      expect(screen.queryByTestId('dialog-open')).not.toBeInTheDocument(),
    )
    // Re-trigger.
    await user.click(screen.getByRole('button', { name: /Trigger-409/ }))
    expect(await screen.findByTestId('dialog-open')).toBeInTheDocument()
  })
})
