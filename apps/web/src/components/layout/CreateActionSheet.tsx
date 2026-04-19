import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Camera,
  ChefHat,
  MessageSquare,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { useMyGroups } from '@/features/groups/useMyGroups'

/**
 * BUG-008 fix — bottom-sheet picker shown when the user taps the central
 * "Neu" FAB in `<BottomNav>`. Replaces the previous behaviour where the
 * FAB just navigated to `/groups`, which the user reported as confusing
 * (the FAB looks like "create something" but only opened a list).
 *
 * Design notes
 * ─────────────
 * - Reuses the same fixed-overlay + click-outside-to-close + Escape-key
 *   pattern as `<CreateGroupDialog>` and `<GroupPickerDialog>`. Keeping
 *   the visual language identical means the sheet feels native to the
 *   rest of the app without a new primitive.
 * - Renders 5 actions ordered "easiest first" (manual recipe, then the
 *   three KI-assisted import paths, then the create-group sibling).
 * - Lucide-only icons (project-wide rule, no emoji).
 *
 * Active-group resolution
 * ───────────────────────
 * Mirrors the `importGroupMemo` pattern (BUG-008 task description):
 * we deliberately do NOT pre-pick a group when the user is in many. The
 * recipe-create routes already accept an `importId` / chat-import-id +
 * a group id encoded in the URL; for the "manuelles Rezept" path we use
 * the only group when there is exactly one, and otherwise route the
 * user through `/groups` so they land on a list and click-through to a
 * group's "Neues Rezept" affordance themselves. This avoids reinventing
 * a group-picker step here.
 *
 * - 0 groups → only "Neue Gruppe anlegen" is offered (the create-recipe
 *   actions all need a target group, so they would dead-end).
 * - 1 group  → "Neues Rezept" links straight to `/groups/{id}/recipes/
 *   new`; import + chat actions stay enabled and reuse their own group
 *   handoff (importGroupMemo / chatImportMemo) which already covers
 *   single-group cases by construction.
 * - n groups → same as single-group except "Neues Rezept" routes to
 *   `/groups` instead, so the user picks the target group themselves.
 *
 * Wired by `<BottomNav>` via local `createSheetOpen` state.
 */
export function CreateActionSheet({
  onClose,
  onCreateGroup,
}: {
  onClose: () => void
  /**
   * Called when the user taps "Neue Gruppe anlegen". The parent owns the
   * `<CreateGroupDialog>` mount because the dialog has its own backdrop
   * and we want to swap the sheet for the dialog cleanly.
   */
  onCreateGroup: () => void
}) {
  const navigate = useNavigate()
  const groups = useMyGroups()
  const firstActionRef = useRef<HTMLButtonElement | null>(null)

  // Focus the first action so keyboard users can immediately Enter to
  // trigger it. Mirrors `<GroupPickerDialog>`.
  useEffect(() => {
    firstActionRef.current?.focus()
  }, [])

  // Escape closes the sheet — backdrop click already does the same.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const groupCount = groups.data?.length ?? 0
  const hasGroup = groupCount > 0
  // When the user is in exactly one group we can deep-link straight to
  // its recipe-create route; otherwise route through `/groups` so the
  // user picks the target themselves (avoids inventing a 2-step picker
  // here — see component-level docs above).
  const newRecipeHref = hasGroup
    ? groupCount === 1
      ? `/groups/${groups.data![0].id}/recipes/new`
      : '/groups'
    : null

  type Action = {
    key: string
    label: string
    description: string
    icon: LucideIcon
    onClick: () => void
    disabled?: boolean
  }

  const actions: Action[] = []

  // Recipe-creating actions only make sense if the user is in at least
  // one group — otherwise they'd hit the "you have no group" wall on
  // the create-page itself, which is a worse UX than not offering it.
  if (hasGroup && newRecipeHref) {
    actions.push({
      key: 'recipe-manual',
      label: 'Rezept manuell anlegen',
      description: 'Du tippst Zutaten und Schritte selbst',
      icon: ChefHat,
      onClick: () => {
        navigate(newRecipeHref)
        onClose()
      },
    })
    actions.push({
      key: 'import-url',
      label: 'Aus Video / URL importieren',
      description: 'TikTok, Instagram, Blog',
      icon: Video,
      onClick: () => {
        navigate('/rezepte/import/url')
        onClose()
      },
    })
    actions.push({
      key: 'import-photos',
      label: 'Aus Fotos importieren',
      description: 'Kochbuch-Scan oder Notiz',
      icon: Camera,
      onClick: () => {
        navigate('/rezepte/import/photos')
        onClose()
      },
    })
    actions.push({
      key: 'import-chat',
      label: 'Im Chat erfinden',
      description: 'Mit der KI ein Rezept generieren',
      icon: MessageSquare,
      onClick: () => {
        navigate('/chat')
        onClose()
      },
    })
  }

  // Always offered — even users with zero groups can pick this. Listed
  // last so it doesn't visually compete with the recipe actions for
  // users who already have a group.
  actions.push({
    key: 'group-new',
    label: 'Neue Gruppe anlegen',
    description: hasGroup
      ? 'Familie, Freunde, ein Projekt'
      : 'Du brauchst zuerst eine Gruppe',
    icon: Users,
    onClick: () => {
      onCreateGroup()
      onClose()
    },
  })

  return (
    <div
      role="dialog"
      aria-labelledby="create-action-sheet-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-background p-5 shadow-lg ring-1 ring-border sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <h2
          id="create-action-sheet-title"
          className="mb-1 font-serif text-xl font-semibold text-stone-900"
        >
          Was möchtest du anlegen?
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {hasGroup
            ? 'Wähle, wie dein neues Rezept entstehen soll.'
            : 'Du bist in keiner Gruppe. Lege zuerst eine an, um Rezepte zu sammeln.'}
        </p>

        <ul className="flex flex-col gap-2">
          {actions.map((action, index) => {
            const Icon = action.icon
            return (
              <li key={action.key}>
                <button
                  type="button"
                  ref={index === 0 ? firstActionRef : undefined}
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-3 text-left transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    aria-hidden="true"
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[hsl(var(--primary)/0.1)] text-primary"
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="flex flex-1 flex-col">
                    <span className="text-sm font-semibold text-foreground">
                      {action.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {action.description}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
