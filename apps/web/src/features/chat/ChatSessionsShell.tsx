import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { MessageSquare, X } from 'lucide-react'
import type { ChatSessionListItem } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/lib/useIsMobile'
import { SplitPane } from '@/components/layout/SplitPane'
import { useConfirmDialog } from '@/features/_shared/ConfirmDialog'
import {
  classifyMutationError,
  toastMutationError,
} from '@/features/_shared/errorSurface'
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
  const { t } = useTranslation()
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
    } catch (err) {
      // REL-5 — surface server failures as a toast. Pre-REL-5 this
      // branch swallowed the error silently; the user tapped "Neu"
      // and nothing happened until they tried again.
      toastMutationError(err)
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
      // REL-3d — route through classifyMutationError so the backend's
      // English Dev-Message (post REL-4) is swapped for the localised
      // `errors.json` entry keyed by the error-code. The helper falls
      // back to the raw message when the code has no translation, and
      // to a generic "actionFailed" copy when there's no message at all.
      setRenameError(classifyMutationError(err).message)
    }
  }

  async function handleDelete(session: ChatSessionListItem) {
    const ok = await confirm({
      title: t('chat.sessions.deleteTitle'),
      description: t('chat.sessions.deleteDescription'),
      confirmLabel: t('chat.sessions.deleteConfirm'),
      cancelLabel: t('common.cancel'),
      confirmVariant: 'destructive',
    })
    if (!ok) return
    try {
      await deleteMutation.mutateAsync({ sessionId: session.id })
    } catch (err) {
      // REL-5 — the hook already rolls back its optimistic splice, but
      // the user still needs to know WHY the delete didn't stick.
      toastMutationError(err)
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
          leftLabel={t('chat.sessions.splitLeftLabel')}
          rightLabel={t('chat.sessions.splitRightLabel')}
          left={
            <aside
              aria-label={t('chat.sessions.drawerLabel')}
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
        aria-label={t('chat.sessions.drawerOpenAria')}
        aria-haspopup="dialog"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        // 2026-04-21 — push below the sticky chat header. The viewport
        // stack on mobile from the top edge is: safe-area inset → the
        // brand/avatar TopNav (~60 px) → the chat screen's own sticky
        // sub-header with back arrow + title + rename (~56 px). The
        // old 72 px offset landed in the middle of the sub-header and
        // covered the title. The calc here clears safe-area + both
        // sticky bars with an 8 px gap so the FAB floats inside the
        // messages area instead of on top of the chat header.
        className="fixed left-4 top-[calc(env(safe-area-inset-top,0px)+128px)] z-30 inline-flex h-10 items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 text-[13px] font-semibold text-foreground shadow-[0_2px_8px_-2px_rgba(28,25,23,0.15)] backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:hidden"
        data-testid="chat-sessions-drawer-trigger"
      >
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
        {t('chat.sessions.drawerToggle')}
      </button>

      {drawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('chat.sessions.drawerLabel')}
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
                aria-label={t('chat.sessions.drawerCloseAria')}
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
