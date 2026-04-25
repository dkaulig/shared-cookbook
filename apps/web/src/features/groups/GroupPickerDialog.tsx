import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupSummary } from '@shared-cookbook/shared'
import { Button } from '@/components/ui/button'

/**
 * Modal that asks "In welcher Gruppe suchen?" when a Home filter chip is
 * pressed and the user is in more than one group. Picking a group fires
 * `onPick(group)` and closes the dialog; the parent is responsible for
 * the actual navigation (so the preset query string can be appended at
 * the call site).
 *
 * Visual + interaction shape mirrors `<CreateGroupDialog>`: a centred
 * card on a black/40 backdrop, click-outside-to-close, focus trapped
 * via the autoFocus on the first action, and Escape closes via the
 * keydown handler. Each group is listed as a full-width button so the
 * tap target is generous on mobile.
 */
export function GroupPickerDialog({
  groups,
  onPick,
  onClose,
}: {
  groups: GroupSummary[]
  onPick: (group: GroupSummary) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null)

  // Move focus to the first group choice on mount so keyboard users can
  // immediately Tab through the list and Enter to pick.
  useEffect(() => {
    firstChoiceRef.current?.focus()
  }, [])

  // Escape closes the dialog without picking — matches the click-outside
  // backdrop semantics below.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-labelledby="group-picker-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="group-picker-dialog-title"
          className="mb-1 text-xl font-semibold text-stone-900"
        >
          {t('groups.picker.title')}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('groups.picker.subtitle')}
        </p>

        <ul className="flex flex-col gap-2">
          {groups.map((group, index) => (
            <li key={group.id}>
              <button
                type="button"
                ref={index === 0 ? firstChoiceRef : undefined}
                onClick={() => onPick(group)}
                className="flex w-full flex-col items-start gap-0.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="text-sm font-semibold text-foreground">
                  {group.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {group.memberCount === 1 && group.isPrivateCollection
                    ? t('groups.picker.privateOnlyYou')
                    : t('groups.list.memberCount', {
                        count: group.memberCount,
                      })}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
