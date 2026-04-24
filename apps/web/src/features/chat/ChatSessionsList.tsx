import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquarePlus, Pencil, Sparkles, Trash2 } from 'lucide-react'
import type { ChatSessionListItem } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/features/imports/relativeTime'

/**
 * CR3 — presentational sessions-list.
 *
 * Renders a newest-first list of the caller's chat sessions. Row
 * content: title (fallback to "Neue Unterhaltung" in muted italic),
 * relative-time ("vor 2 Minuten"), and two hover-revealed actions
 * (rename pencil + delete trash).
 *
 * Active session gets a ring + primary-tinted background so the
 * current thread is obvious at a glance.
 *
 * Mobile/a11y notes:
 * - On mobile (`md:hidden` breakpoint) the action buttons are always
 *   visible (no hover available); at `md+` they fade in on hover / keyboard
 *   focus-within.
 * - The row itself is a `<button>` so Enter/Space activate select;
 *   the two inline action buttons stop propagation so clicking the
 *   pencil / trash doesn't also select the row.
 */
export interface ChatSessionsListProps {
  sessions: ChatSessionListItem[]
  activeSessionId?: string
  onSelect: (sessionId: string) => void
  onRename: (session: ChatSessionListItem) => void
  onDelete: (session: ChatSessionListItem) => void
  onCreateNew: () => void
  /** `true` while a `createChatSession` mutation is in flight. */
  isCreating?: boolean
  /**
   * Optional heading override. Defaults to the translated
   * `chat.sessions.heading` (German: "Unterhaltungen"). Callers that
   * already own the label (e.g. a mobile drawer title) pass it in.
   */
  heading?: string
}

export function ChatSessionsList({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onDelete,
  onCreateNew,
  isCreating = false,
  heading,
}: ChatSessionsListProps) {
  const { t } = useTranslation()
  const resolvedHeading = heading ?? t('chat.sessions.heading')
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <h2 className="font-serif text-[16px] font-semibold tracking-[-0.005em] text-foreground">
          {resolvedHeading}
        </h2>
        <Button
          type="button"
          size="sm"
          onClick={onCreateNew}
          disabled={isCreating}
          className="gap-1.5"
          aria-label={t('chat.sessions.newAria')}
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          {isCreating
            ? t('chat.sessions.creating')
            : t('chat.sessions.newShort')}
        </Button>
      </div>

      <div
        className="flex-1 overflow-y-auto"
        data-testid="chat-sessions-list-scroll"
      >
        {sessions.length === 0 ? (
          <EmptySessions />
        ) : (
          <ul className="flex flex-col gap-1 p-2">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={() => onSelect(session.id)}
                onRename={() => onRename(session)}
                onDelete={() => onDelete(session)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function EmptySessions() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto mt-8 max-w-xs rounded-[14px] border border-dashed border-[hsl(var(--input))] bg-card/60 p-4 text-center">
      <Sparkles
        className="mx-auto h-4 w-4 text-primary"
        aria-hidden="true"
      />
      <p className="mt-1.5 text-[13.5px] leading-[1.4] text-[hsl(var(--muted-foreground))]">
        {t('chat.sessions.emptyHint')}
      </p>
    </div>
  )
}

function SessionRow({
  session,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  session: ChatSessionListItem
  isActive: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const title = session.title ?? ''
  const fallback = !title
  const displayTitle = title || t('chat.sessions.fallbackTitle')
  const when = formatRelativeTime(session.updatedAt)

  function handleRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  return (
    <li>
      {/*
        A real <button> would be ideal, but nesting <button>s inside is
        invalid HTML. Fall back to a role="button" div + explicit
        keyboard handler; the pencil and trash remain real <button>s.
      */}
      <div
        role="button"
        tabIndex={0}
        aria-label={t('chat.sessions.openAriaTemplate', { title: displayTitle })}
        aria-current={isActive ? 'true' : undefined}
        onClick={onSelect}
        onKeyDown={handleRowKeyDown}
        data-testid="chat-session-row"
        data-session-id={session.id}
        className={cn(
          'group flex cursor-pointer items-start justify-between gap-2 rounded-[12px] px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          isActive
            ? 'bg-[hsl(var(--primary)/0.12)] ring-1 ring-primary/60'
            : 'hover:bg-[hsl(var(--primary)/0.06)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate text-[14px] font-medium leading-[1.35]',
              fallback
                ? 'italic text-[hsl(var(--muted-foreground))]'
                : 'text-foreground',
            )}
          >
            {displayTitle}
          </p>
          {when && (
            <p className="mt-0.5 text-[12px] leading-[1.35] text-[hsl(var(--muted-foreground))]">
              {when}
            </p>
          )}
        </div>
        <div
          className={cn(
            'flex flex-shrink-0 items-center gap-0.5',
            // Mobile (< md): always visible. md+: reveal on row hover
            // / focus-within to keep the resting state uncluttered.
            'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
          )}
        >
          <button
            type="button"
            aria-label={t('chat.sessions.renameAriaTemplate', {
              title: displayTitle,
            })}
            onClick={(e) => {
              e.stopPropagation()
              onRename()
            }}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.1)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('chat.sessions.deleteAriaTemplate', {
              title: displayTitle,
            })}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="grid h-8 w-8 place-items-center rounded-[8px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  )
}
