import { useEffect, useRef, useState, type RefObject } from 'react'
import { Bold, Eye, Italic, List, ListOrdered, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  prefixLinesSelection,
  wrapSelection,
  type SelectionResult,
} from './markdownToolbarHelpers'

export interface StepMarkdownToolbarProps {
  value: string
  onChange: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  previewMode: boolean
  onTogglePreview: () => void
}

/**
 * UX1-RT Markdown toolbar. Five icon buttons + a preview toggle sitting
 * above the step textarea. Clicking any formatting button computes the
 * next `(value, selection)` via the pure helpers, then applies it:
 *   1. `onChange(nextValue)` so the parent state catches up
 *   2. In an effect keyed on the pending selection, re-focus the
 *      textarea and `setSelectionRange` so the user's caret lands on
 *      the expected span (the placeholder "Text", or around the wrapped
 *      selection).
 *
 * Buttons are `type="button"` — critical inside a <form>. Aria-labels
 * are in German. The preview button's accessible name and aria-pressed
 * reflect the current mode.
 */
export function StepMarkdownToolbar({
  value,
  onChange,
  textareaRef,
  previewMode,
  onTogglePreview,
}: StepMarkdownToolbarProps) {
  // We can't set the textarea selection immediately after `onChange`
  // because React hasn't rendered the new value yet. Queue the selection
  // in a ref + bump a "pending" counter; an effect applies it after the
  // parent's re-render committed the new value.
  const pendingSelection = useRef<{ start: number; end: number; token: number } | null>(null)
  const applyTokenRef = useRef(0)

  useEffect(() => {
    const pending = pendingSelection.current
    if (!pending) return
    const ta = textareaRef.current
    if (!ta) return
    // Only apply if the textarea's current value matches what we just
    // asked for — guards against a stale selection landing on unrelated
    // content after an external edit.
    ta.focus()
    ta.setSelectionRange(pending.start, pending.end)
    pendingSelection.current = null
    // Intentionally run on every render; the early-return above keeps
    // it cheap when no selection is pending.
  })

  function applyResult(result: SelectionResult) {
    applyTokenRef.current += 1
    pendingSelection.current = {
      start: result.nextSelectionStart,
      end: result.nextSelectionEnd,
      token: applyTokenRef.current,
    }
    onChange(result.nextValue)
  }

  function currentRange(): { start: number; end: number } {
    const ta = textareaRef.current
    if (!ta) return { start: value.length, end: value.length }
    return { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 }
  }

  function handleBold() {
    const { start, end } = currentRange()
    applyResult(wrapSelection(value, start, end, '**', '**'))
  }

  function handleItalic() {
    const { start, end } = currentRange()
    applyResult(wrapSelection(value, start, end, '*', '*'))
  }

  function handleUnordered() {
    const { start, end } = currentRange()
    applyResult(
      prefixLinesSelection(value, start, end, '- ', { kind: 'unordered' }),
    )
  }

  function handleOrdered() {
    const { start, end } = currentRange()
    applyResult(
      prefixLinesSelection(value, start, end, '', { kind: 'ordered' }),
    )
  }

  const previewLabel = previewMode ? 'Bearbeiten' : 'Vorschau'
  const PreviewIcon = previewMode ? Pencil : Eye

  // UX1-RT plan §5 — announce preview-mode changes via a polite
  // live-region. aria-pressed on the button covers the state for
  // focused-toggle interactions, but some screen readers only narrate
  // the label change; the live-region reads the new mode regardless.
  // Empty on initial mount so a page full of step rows doesn't narrate
  // "Bearbeiten aktiviert" once per row.
  const [liveMessage, setLiveMessage] = useState('')
  const firstRenderRef = useRef(true)
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    setLiveMessage(previewMode ? 'Vorschau aktiviert' : 'Bearbeiten aktiviert')
  }, [previewMode])

  return (
    <div
      role="toolbar"
      aria-label="Formatierung"
      className="flex flex-wrap items-center gap-1 rounded-[10px] border border-[hsl(var(--input))] bg-card px-1.5 py-1"
    >
      <ToolbarButton
        label="Fett"
        onClick={handleBold}
        disabled={previewMode}
      >
        <Bold className="h-3.5 w-3.5" aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Kursiv"
        onClick={handleItalic}
        disabled={previewMode}
      >
        <Italic className="h-3.5 w-3.5" aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Aufzählung"
        onClick={handleUnordered}
        disabled={previewMode}
      >
        <List className="h-3.5 w-3.5" aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Nummerierte Liste"
        onClick={handleOrdered}
        disabled={previewMode}
      >
        <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
      </ToolbarButton>
      <div className="ml-auto">
        <ToolbarButton
          label={previewLabel}
          onClick={onTogglePreview}
          pressed={previewMode}
        >
          <PreviewIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </ToolbarButton>
      </div>
      <span
        data-testid="step-toolbar-live"
        aria-live="polite"
        className="sr-only"
      >
        {liveMessage}
      </span>
    </div>
  )
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 min-w-[28px] items-center justify-center gap-1 rounded-md px-1.5 text-[hsl(var(--muted-foreground))] transition-colors',
        'hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[hsl(var(--muted-foreground))]',
        pressed && 'bg-[hsl(var(--primary)/0.12)] text-primary',
      )}
    >
      {children}
    </button>
  )
}
