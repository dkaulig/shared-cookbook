import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquare, X } from 'lucide-react'
import type { ChatSessionListItem } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/lib/useIsMobile'
import { SplitPane } from '@/components/layout/SplitPane'
import { useConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { ChatSessionsList } from './ChatSessionsList'
import { RenameSessionDialog } from './RenameSessionDialog'
import {
  useChatSessions,
  useCreateChatSession,
  useDeleteChatSession,
  useRenameChatSession,
} from './useChatSessions'

/**
 * CR3 — layout wrapper around {@link ChatSessionsList}.
 *
 * Desktop (`md+`): fixed left sidebar, ~280px wide, sitting above the
 * chat message area.
 * Mobile: a bottom-sheet drawer that slides up from the bottom when the
 * user taps the floating "Unterhaltungen" button; dismissed by tapping
 * the backdrop, the X, or selecting a session.
 *
 * All mutation flows — create / rename / delete — are owned here so the
 * sessions list stays purely presentational. Deleting the currently-
 * active session navigates back to `/chat`, which redirects to the
 * next-most-recent session (or mints a new one if no sessions remain).
 */
export interface ChatSessionsShellProps {
  /** The session currently rendered in the chat area; gets the active highlight. */
  activeSessionId?: string
  /**
   * Renderer for the chat area to the right of the sidebar on desktop.
   * On mobile the children still render; the sessions drawer mounts
   * on top as an overlay when opened.
   */
  children: React.ReactNode
}

export function ChatSessionsShell({
  activeSessionId,
  children,
}: ChatSessionsShellProps) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [renameTarget, setRenameTarget] =
    useState<ChatSessionListItem | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)

  const sessionsQuery = useChatSessions()
  const createMutation = useCreateChatSession()
  const renameMutation = useRenameChatSession()
  const deleteMutation = useDeleteChatSession()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()

  // Close the drawer whenever the viewport grows past `md` — avoids a
  // zombie overlay lingering after a tablet rotation. Responding to a
  // platform-level event (matchMedia flip) is a legitimate state-sync
  // surface, hence the in-effect setState.
  useEffect(() => {
    if (!isMobile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- matchMedia change → dismiss mobile overlay
      setDrawerOpen(false)
    }
  }, [isMobile])

  async function handleCreateNew() {
    try {
      const res = await createMutation.mutateAsync()
      setDrawerOpen(false)
      navigate(`/chat/${res.sessionId}`)
    } catch {
      /* Surface errors via mutation state; caller doesn't need to react. */
    }
  }

  function handleSelect(sessionId: string) {
    setDrawerOpen(false)
    if (sessionId === activeSessionId) return
    navigate(`/chat/${sessionId}`)
  }

  function handleRename(session: ChatSessionListItem) {
    setRenameError(null)
    setRenameTarget(session)
  }

  async function handleRenameSubmit(title: string) {
    if (!renameTarget) return
    setRenameError(null)
    try {
      await renameMutation.mutateAsync({
        sessionId: renameTarget.id,
        title,
      })
      setRenameTarget(null)
    } catch (err) {
      const apiErr = err as Error
      setRenameError(
        apiErr.message || 'Umbenennen fehlgeschlagen. Bitte erneut versuchen.',
      )
    }
  }

  async function handleDelete(session: ChatSessionListItem) {
    const ok = await confirm({
      title: 'Unterhaltung löschen?',
      description:
        'Die gesamte Unterhaltung wird entfernt. Das kann nicht rückgängig gemacht werden.',
      confirmLabel: 'Löschen',
      cancelLabel: 'Abbrechen',
      confirmVariant: 'destructive',
    })
    if (!ok) return
    try {
      await deleteMutation.mutateAsync({ sessionId: session.id })
    } catch {
      /* Optimistic rollback already triggered in the hook. */
      return
    }
    // If the user just deleted the active session, bounce back to the
    // /chat redirect so it picks the next-most-recent (or creates one).
    if (session.id === activeSessionId) {
      navigate('/chat')
    }
  }

  const sessions = sessionsQuery.data ?? []

  // ── Desktop layout (md+): shared <SplitPane /> primitive ───────────
  //
  // TABLET-2 — the sessions sidebar + conversation pane migrated off
  // the local `flex h-full w-full` scaffold onto <SplitPane /> so any
  // future tweak to `--split-left-width` or the divider styling lands
  // on every md:+ two-column page at once. The outer `<aside>` landmark
  // is retained (nested inside the left pane) so assistive tech still
  // sees the "Unterhaltungen" complementary region, and the left-
  // slot's "Sitzungen-Liste" landmark from SplitPane augments it.
  if (!isMobile) {
    return (
      <>
        <SplitPane
          leftLabel="Sitzungen-Liste"
          rightLabel="Aktuelle Unterhaltung"
          left={
            <aside
              aria-label="Unterhaltungen"
              className="flex h-full flex-col bg-card/30"
            >
              <ChatSessionsList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={handleSelect}
                onRename={handleRename}
                onDelete={handleDelete}
                onCreateNew={handleCreateNew}
                isCreating={createMutation.isPending}
              />
            </aside>
          }
          right={<div className="min-w-0 h-full">{children}</div>}
          className="h-full"
        />

        {/* Portal-like dialogs live at the root so they aren't clipped. */}
        <RenameSessionDialog
          open={renameTarget !== null}
          initialTitle={renameTarget?.title ?? null}
          onOpenChange={(next) => {
            if (!next) {
              setRenameTarget(null)
              setRenameError(null)
            }
          }}
          onSubmit={handleRenameSubmit}
          isLoading={renameMutation.isPending}
          error={renameError}
        />
        {ConfirmDialogElement}
      </>
    )
  }

  // ── Mobile layout: content + FAB that opens a bottom-sheet drawer ──
  return (
    <div className="relative h-full w-full">
      {children}

      <button
        type="button"
        aria-label="Unterhaltungen öffnen"
        aria-haspopup="dialog"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="fixed left-4 top-[72px] z-30 inline-flex h-10 items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 text-[13px] font-semibold text-foreground shadow-[0_2px_8px_-2px_rgba(28,25,23,0.15)] backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:hidden"
        data-testid="chat-sessions-drawer-trigger"
      >
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
        Unterhaltungen
      </button>

      {drawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Unterhaltungen"
          className="fixed inset-0 z-40 flex items-end bg-black/40 md:hidden"
          onClick={() => setDrawerOpen(false)}
          data-testid="chat-sessions-drawer"
        >
          <div
            className={cn(
              'flex max-h-[85dvh] w-full flex-col rounded-t-[18px] bg-background shadow-[0_-8px_32px_-4px_rgba(0,0,0,0.25)]',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative">
              <button
                type="button"
                aria-label="Schließen"
                onClick={() => setDrawerOpen(false)}
                className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.1)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom,0px)]">
              <ChatSessionsList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={handleSelect}
                onRename={handleRename}
                onDelete={handleDelete}
                onCreateNew={handleCreateNew}
                isCreating={createMutation.isPending}
              />
            </div>
          </div>
        </div>
      )}

      <RenameSessionDialog
        open={renameTarget !== null}
        initialTitle={renameTarget?.title ?? null}
        onOpenChange={(next) => {
          if (!next) {
            setRenameTarget(null)
            setRenameError(null)
          }
        }}
        onSubmit={handleRenameSubmit}
        isLoading={renameMutation.isPending}
        error={renameError}
      />
      {ConfirmDialogElement}
    </div>
  )
}
