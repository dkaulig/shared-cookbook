import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * BUG-004 — shadcn-style ConfirmDialog primitive.
 *
 * Replaces `window.confirm(...)` for destructive actions across the app.
 * The dialog mirrors the fixed-overlay pattern already used by
 * `DeleteSlotDialog` + `CreateTagDialog`:
 *   - `role="dialog" aria-modal="true"` with a labelled title,
 *   - ESC key + outside-click dismiss via `onOpenChange(false)`,
 *   - destructive-styled confirm button by default (safety-first),
 *   - optional isLoading state that disables the confirm action and
 *     swaps in a spinner.
 *
 * Two usage shapes are supported:
 *   1. Controlled component — callsite owns the `open` state and wires
 *      `onOpenChange` / `onConfirm` itself.
 *   2. `useConfirmDialog()` hook — returns a declarative
 *      `{ confirm, ConfirmDialogElement }` pair for async flows
 *      (`const ok = await confirm({ title, description })`).
 */
export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /**
   * Dialog body. Accepts either a plain string (rendered inside the
   * standard muted `<p>` paragraph) or a {@link ReactNode} for richer
   * layouts (e.g. REIMPORT-1's two-paragraph body with an amber hint
   * box below). ReactNode callers own their own spacing/typography.
   */
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
  onConfirm: () => void | Promise<void>
  isLoading?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
  confirmVariant = 'destructive',
  onConfirm,
  isLoading = false,
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)

  // ESC to close. Listener only runs while the dialog is open so we
  // don't swallow escape keys meant for other pages.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isLoading) {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, isLoading, onOpenChange])

  // Autofocus the confirm button when the dialog opens — keeps the
  // destructive action behind an explicit keystroke (Enter/Space) rather
  // than the user's last-focused outer control.
  useEffect(() => {
    if (open) confirmButtonRef.current?.focus()
  }, [open])

  if (!open) return null

  async function handleConfirm() {
    if (isLoading) return
    await onConfirm()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      data-testid="confirm-dialog"
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
          id="confirm-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          {title}
        </h2>
        {typeof description === 'string' ? (
          <p
            id="confirm-dialog-description"
            className="mb-4 text-sm text-muted-foreground"
          >
            {description}
          </p>
        ) : (
          <div
            id="confirm-dialog-description"
            className="mb-4 text-sm text-muted-foreground"
          >
            {description}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={isLoading}
          >
            {isLoading && (
              <Loader2
                className="mr-1.5 h-4 w-4 animate-spin"
                aria-hidden="true"
                data-testid="confirm-dialog-spinner"
              />
            )}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Declarative hook-based variant for async flows.
 *
 * ```tsx
 * const { confirm, ConfirmDialogElement } = useConfirmDialog()
 * const onDelete = async () => {
 *   const ok = await confirm({
 *     title: 'Rezept löschen?',
 *     description: 'Das kann nicht rückgängig gemacht werden.',
 *   })
 *   if (!ok) return
 *   await deleteRecipe.mutateAsync(id)
 * }
 *
 * return (
 *   <>
 *     <Button onClick={onDelete}>Löschen</Button>
 *     {ConfirmDialogElement}
 *   </>
 * )
 * ```
 */
export interface ConfirmOptions {
  title: string
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
}

// Hook co-located with the component it renders. Disabling
// react-refresh/only-export-components here keeps the primitive and
// its declarative wrapper shipped from one entry file — no real
// HMR cost since both exports update together.
// eslint-disable-next-line react-refresh/only-export-components
export function useConfirmDialog(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  ConfirmDialogElement: ReactNode
} {
  const [state, setState] = useState<{
    options: ConfirmOptions
    resolve: (value: boolean) => void
  } | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ options, resolve })
      }),
    [],
  )

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && state) {
        state.resolve(false)
        setState(null)
      }
    },
    [state],
  )

  const handleConfirm = useCallback(() => {
    if (!state) return
    state.resolve(true)
    setState(null)
  }, [state])

  const ConfirmDialogElement = state ? (
    <ConfirmDialog
      open={true}
      onOpenChange={handleOpenChange}
      title={state.options.title}
      description={state.options.description}
      confirmLabel={state.options.confirmLabel}
      cancelLabel={state.options.cancelLabel}
      confirmVariant={state.options.confirmVariant}
      onConfirm={handleConfirm}
    />
  ) : null

  return { confirm, ConfirmDialogElement }
}
