import { describe, expect, it, vi } from 'vitest'
import { createRef, useRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StepMarkdownToolbar } from './StepMarkdownToolbar'

/**
 * Harness component: pairs a real <textarea> with the toolbar so user
 * interactions produce realistic selection state in jsdom. We expose
 * `captured` via a spy prop so each test can inspect the emitted value.
 */
function Harness({
  initial = '',
  onValueChange,
  initialPreview = false,
  onTogglePreview,
}: {
  initial?: string
  onValueChange?: (v: string) => void
  initialPreview?: boolean
  onTogglePreview?: () => void
}) {
  const [value, setValue] = useState(initial)
  const [previewMode, setPreviewMode] = useState(initialPreview)
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <div>
      <StepMarkdownToolbar
        value={value}
        onChange={(v) => {
          setValue(v)
          onValueChange?.(v)
        }}
        textareaRef={ref}
        previewMode={previewMode}
        onTogglePreview={() => {
          setPreviewMode((p) => !p)
          onTogglePreview?.()
        }}
      />
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          onValueChange?.(e.target.value)
        }}
        aria-label="Schritt-Editor"
      />
    </div>
  )
}

describe('StepMarkdownToolbar', () => {
  it('renders buttons with German aria-labels', () => {
    render(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={false}
        onTogglePreview={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Fett' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kursiv' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aufzählung' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Nummerierte Liste' }),
    ).toBeInTheDocument()
    // Preview toggle's accessible name depends on mode; in edit mode it
    // says "Vorschau".
    expect(screen.getByRole('button', { name: 'Vorschau' })).toBeInTheDocument()
  })

  it('uses type="button" on every button (critical inside <form>)', () => {
    render(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={false}
        onTogglePreview={() => {}}
      />,
    )
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toHaveAttribute('type', 'button')
    }
  })

  it('clicking "Fett" wraps the current textarea selection in **…**', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial="Hello world" onValueChange={onChange} />)
    const ta = screen.getByLabelText('Schritt-Editor') as HTMLTextAreaElement
    // Select "world".
    ta.focus()
    ta.setSelectionRange(6, 11)
    await user.click(screen.getByRole('button', { name: 'Fett' }))
    expect(ta.value).toBe('Hello **world**')
    expect(onChange).toHaveBeenLastCalledWith('Hello **world**')
  })

  it('clicking "Kursiv" with no selection inserts *Text* with "Text" pre-selected', async () => {
    const user = userEvent.setup()
    render(<Harness initial="abc" />)
    const ta = screen.getByLabelText('Schritt-Editor') as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(3, 3)
    await user.click(screen.getByRole('button', { name: 'Kursiv' }))
    expect(ta.value).toBe('abc*Text*')
    // "Text" starts at index 4 (after "abc*") and ends at 8.
    expect(ta.selectionStart).toBe(4)
    expect(ta.selectionEnd).toBe(8)
  })

  it('clicking "Aufzählung" prefixes the current line with "- "', async () => {
    const user = userEvent.setup()
    render(<Harness initial="Milch holen" />)
    const ta = screen.getByLabelText('Schritt-Editor') as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(3, 3)
    await user.click(screen.getByRole('button', { name: 'Aufzählung' }))
    expect(ta.value).toBe('- Milch holen')
  })

  it('clicking "Nummerierte Liste" with a multi-line selection inserts 1. 2. 3.', async () => {
    const user = userEvent.setup()
    render(<Harness initial={'Eins\nZwei\nDrei'} />)
    const ta = screen.getByLabelText('Schritt-Editor') as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(0, ta.value.length)
    await user.click(screen.getByRole('button', { name: 'Nummerierte Liste' }))
    expect(ta.value).toBe('1. Eins\n2. Zwei\n3. Drei')
  })

  it('fires onTogglePreview when the preview button is clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<Harness onTogglePreview={onToggle} />)
    await user.click(screen.getByRole('button', { name: 'Vorschau' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('preview button uses aria-pressed to reflect mode', () => {
    const { rerender } = render(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={false}
        onTogglePreview={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Vorschau' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    rerender(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={true}
        onTogglePreview={() => {}}
      />,
    )
    // In preview mode the accessible name flips to "Bearbeiten".
    expect(screen.getByRole('button', { name: 'Bearbeiten' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  // UX1-RT plan §5 — announce the mode change via a polite live-region
  // in addition to aria-pressed. Screen readers then read the status
  // string at the next quiet moment rather than relying purely on the
  // button-label change.
  it('announces the preview-mode change via a polite live-region', async () => {
    const { rerender } = render(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={false}
        onTogglePreview={() => {}}
      />,
    )
    const live = screen.getByTestId('step-toolbar-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    // Initial mount has no message yet — the live-region stays empty
    // until the user actually toggles, so screen readers don't narrate
    // the initial state on every step-row mount.
    expect(live.textContent ?? '').toBe('')

    rerender(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={true}
        onTogglePreview={() => {}}
      />,
    )
    expect(live.textContent).toBe('Vorschau aktiviert')

    rerender(
      <StepMarkdownToolbar
        value=""
        onChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        previewMode={false}
        onTogglePreview={() => {}}
      />,
    )
    expect(live.textContent).toBe('Bearbeiten aktiviert')
  })
})
