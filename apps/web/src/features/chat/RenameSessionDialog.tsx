import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * CR3 — rename-dialog primitive for a chat session.
 *
 * Mirrors the existing in-repo fixed-overlay pattern (`CreateTagDialog`
 * / `ConfirmDialog`): role="dialog" aria-modal, ESC to close, outside-
 * click dismiss. The input autofocuses + selects the current text so
 * the common case (tweak one word) is a single keystroke.
 *
 * Title cap mirrors the backend constraint `ChatSession.TitleMaxLength
 * = 120`. Empty/whitespace input is treated as a no-op submit (the
 * user has to hit Cancel to dismiss without renaming).
 */
export const CHAT_SESSION_TITLE_MAX_LENGTH = 120

export interface RenameSessionDialogProps {
  open: boolean
  initialTitle: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (title: string) => void | Promise<void>
  /** Busy spinner + disable the submit button while the mutation is in flight. */
  isLoading?: boolean
  /** Optional error string rendered below the input. */
  error?: string | null
}

export function RenameSessionDialog({
  open,
  initialTitle,
  onOpenChange,
  onSubmit,
  isLoading = false,
  error = null,
}: RenameSessionDialogProps) {
  const [value, setValue] = useState(initialTitle ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset + select when the dialog re-opens with a new session. The
  // in-effect setValue synchronises our controlled input with an
  // external prop handoff (parent toggles open + hands in a new title).
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prop→state handoff on dialog open
      setValue(initialTitle ?? '')
      // Defer to next tick so the input is mounted before selecting.
      window.setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [open, initialTitle])

  // ESC to close while open (skipped when a mutation is in flight so a
  // stray ESC during the 200ms save doesn't orphan the dialog state).
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isLoading) {
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, isLoading, onOpenChange])

  if (!open) return null

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    if (trimmed.length > CHAT_SESSION_TITLE_MAX_LENGTH) return
    await onSubmit(trimmed)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-chat-session-title"
      data-testid="rename-session-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (isLoading) return
        onOpenChange(false)
      }}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="rename-chat-session-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          Unterhaltung umbenennen
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Gib einen neuen Titel für diese Unterhaltung ein.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="rename-session-title-input">Titel</Label>
            <Input
              id="rename-session-title-input"
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={CHAT_SESSION_TITLE_MAX_LENGTH}
              placeholder="z.B. Kartoffel-Lauch-Auflauf"
              disabled={isLoading}
              aria-describedby="rename-session-helper"
            />
            <p
              id="rename-session-helper"
              className="text-[12px] text-muted-foreground"
            >
              Max. {CHAT_SESSION_TITLE_MAX_LENGTH} Zeichen.
            </p>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              Abbrechen
            </Button>
            <Button
              type="submit"
              disabled={isLoading || value.trim().length === 0}
            >
              {isLoading ? 'Speichere …' : 'Speichern'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
