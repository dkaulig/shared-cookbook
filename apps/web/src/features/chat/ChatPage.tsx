import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { GroupSummary } from '@shared-cookbook/shared'
import {
  AlertTriangle,
  ArrowDown,
  ChevronLeft,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Utensils,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { GroupPickerDialog } from '@/features/groups/GroupPickerDialog'
import { useConvertChatToRecipe } from './hooks'
import {
  CHAT_SESSIONS_DEFAULT_LIMIT,
  chatQueryKeys,
  useChatMessages,
  useChatSessions,
  useRenameChatSession,
} from './useChatSessions'
import { RenameSessionDialog } from './RenameSessionDialog'
import {
  SCROLL_STICKY_THRESHOLD_PX,
  isPinnedToBottom,
} from './scrollStickiness'
import { CHAT_HARD_CAP, CHAT_WARN_AT, classifyTurnCap } from './turnCap'
import { stashChatImport } from './chatImportMemo'
import {
  safeGetItem,
  safeRemoveItem,
  safeSetItem,
} from '@/features/_shared/safeStorage'
import { streamChatTurn } from './sseChatStream'
import { TypingIndicator } from './TypingIndicator'

/**
 * `/chat/:sessionId` — the CR4 conversational recipe-creation surface.
 *
 * Full-height flex column:
 *   1. Sticky top bar: back button + session title (click to rename).
 *   2. Scrollable message list (flex-1) with user + assistant bubbles.
 *      The active assistant bubble is filled token-by-token via SSE
 *      while a three-dot typing indicator sits below it. Once the
 *      assistant has sent ≥ 2 replies, the "In Rezept umwandeln"
 *      call-to-action slides in.
 *   3. Sticky bottom input area: textarea + send/abort button.
 *
 * BUG-001 + BUG-039 — viewport sizing on mobile. Under the hoppr-style
 * flex-column layout in `AppLayout`, `<main>` is `flex-1 min-h-0
 * overflow-y-auto` — it already has the right height for us to live
 * inside. The chat shell just fills its parent with `h-full`; no more
 * dynamic-viewport-unit math subtracting TopNav + BottomNav + safe-
 * area. The input footer keeps `pb-[calc(16px+env(safe-area-inset-
 * bottom,0px))]` as a defence-in-depth safe-area clearance, which
 * also shields against keyboard overlap when the on-screen keyboard
 * opens.
 *
 * 2026-04-21 chat bug sweep — the prior `visualViewport.height` → `el
 * .style.height` imperative pin is GONE. It fought the flex-column
 * parent (`<main class="flex-1 min-h-0 overflow-y-auto">`), caused
 * the messages area to overflow past the viewport, pushed the
 * composer below the fold on load, and on input focus it briefly
 * mis-sized the shell so Safari's scroll-focused-element-into-view
 * landed the composer almost underneath the sticky TopBar. The flex
 * parent already gives the chat shell the correct height on every
 * device; the CSS `min-h-0` on `<main>` is all the iOS keyboard
 * accommodation we need once the rest of the layout is honest flex.
 *
 * CR4 streaming model:
 * - The session id comes from the URL (`/chat/:sessionId`); the
 *   redirect-at-`/chat` picks the newest session on entry.
 * - Persisted message history is the source-of-truth via
 *   {@link useChatMessages}.
 * - On submit we optimistically append a user bubble + an empty
 *   assistant bubble flagged `streaming: true`, then iterate
 *   {@link streamChatTurn}. Each `token` event appends to the
 *   assistant bubble; `done` flips the streaming flag and we
 *   invalidate the messages query so the server-side row replaces
 *   the optimistic one on the next refetch.
 * - The send button morphs into "Abbrechen" while streaming. Aborting
 *   triggers the AbortController on the fetch; the backend persists
 *   whatever was streamed so far, and we refetch to surface that
 *   partial as the canonical row.
 * - On stream error we keep the partial bubble visible with a red
 *   outline + "Antwort unterbrochen" label and an "Erneut versuchen"
 *   button. The retry deletes the partial bubble locally and
 *   re-submits the same user text — note this creates a SECOND user
 *   message in the DB history. That's intentional for v1 (a
 *   server-side "retry" endpoint would be scope-creep); the user
 *   sees one duplicated user bubble after the partial succeeds.
 * - Unmount + session-switch abort the in-flight stream.
 */
const draftKey = (sessionId: string) => `fk-chat-draft:${sessionId}`

/**
 * Local mirror of {@link ChatMessageDto} with two transient flags the
 * UI uses while a turn is mid-flight. Stripped before persistence —
 * the server-side row is canonical once `done` lands.
 */
interface LocalMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  streaming?: boolean
  errored?: boolean
}

const localId = () => `local-${crypto.randomUUID()}`

export function ChatPage() {
  const { t } = useTranslation()
  const { sessionId: routeSessionId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // ── Session id (from URL) ──────────────────────────────────────────
  const sessionId = routeSessionId ?? ''
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // ── Persisted history (DB-side) ────────────────────────────────────
  const messagesQuery = useChatMessages(sessionId || undefined)

  // ── Session title (for the top bar) ────────────────────────────────
  const sessionsQuery = useChatSessions()
  const session = useMemo(
    () => sessionsQuery.data?.find((s) => s.id === sessionId) ?? null,
    [sessionsQuery.data, sessionId],
  )

  // If the sessions list has loaded and the current URL sessionId is
  // not in it (stale link / someone else's id / deleted session),
  // bounce back to `/chat` so the redirect picks a fresh target.
  useEffect(() => {
    if (!sessionId) return
    if (!sessionsQuery.isSuccess) return
    const found = (sessionsQuery.data ?? []).some((s) => s.id === sessionId)
    if (!found) {
      navigate('/chat', { replace: true })
    }
  }, [sessionId, sessionsQuery.isSuccess, sessionsQuery.data, navigate])

  // ── Optimistic / streaming layer ───────────────────────────────────
  // While a turn is in flight we hold (a) the user bubble we just
  // appended and (b) the assistant bubble being filled token-by-
  // token. After `done`, we invalidate the messages query and clear
  // the local layer so the server copy renders.
  const [optimistic, setOptimistic] = useState<LocalMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const lastSubmittedRef = useRef<string>('')
  // Reset the optimistic buffer + abort any in-flight stream when the
  // session id changes (switching conversations must not leak in-
  // flight bubbles or zombie connections across threads).
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot URL→state reset on session switch
    setOptimistic([])
    setIsStreaming(false)
  }, [sessionId])

  // Abort on unmount — guarantees no zombie SSE connections survive a
  // navigation away from /chat.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const messages: LocalMessage[] = useMemo(() => {
    const persisted: LocalMessage[] = (messagesQuery.data ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
        createdAt: m.createdAt,
      }))
    // Dedupe: if a server message and a local optimistic message share
    // an id (assistant bubble id is rewritten to the server-issued
    // messageId on `message-started`), prefer the persisted copy.
    const persistedIds = new Set(persisted.map((m) => m.id))
    const merged = [
      ...persisted,
      ...optimistic.filter((m) => !persistedIds.has(m.id)),
    ]
    return merged
  }, [messagesQuery.data, optimistic])

  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // ── Input state (controlled; draft persisted per-session) ──────────
  const [input, setInput] = useState<string>(() =>
    sessionId ? safeGetItem(draftKey(sessionId)) ?? '' : '',
  )
  // Re-hydrate whenever the sessionId changes (draft-per-session).
  useEffect(() => {
    if (!sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot URL→state reset when session id is cleared
      setInput('')
      return
    }
    setInput(safeGetItem(draftKey(sessionId)) ?? '')
  }, [sessionId])
  // Persist input drafts. `safeSetItem` is a no-op in private-mode
  // Safari / jsdom, so callers don't have to branch.
  useEffect(() => {
    if (!sessionId) return
    if (input.length === 0) {
      safeRemoveItem(draftKey(sessionId))
      return
    }
    safeSetItem(draftKey(sessionId), input)
  }, [sessionId, input])

  // ── Network mutations ──────────────────────────────────────────────
  const convertMutation = useConvertChatToRecipe()

  // ── Error state (distinct so the retry can clear it) ───────────────
  const [error, setError] = useState<string | null>(null)
  const [convertError, setConvertError] = useState<string | null>(null)

  // ── Rename (top-bar pencil) ────────────────────────────────────────
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameMutation = useRenameChatSession()

  const handleRenameSubmit = useCallback(
    async (title: string) => {
      if (!sessionId) return
      setRenameError(null)
      try {
        await renameMutation.mutateAsync({ sessionId, title })
        setRenameOpen(false)
      } catch (err) {
        // REL-3d — translate backend error-codes via classifyMutation
        // Error so the user sees the German `errors.json` copy instead
        // of the English Dev-Message the backend emits post REL-4.
        setRenameError(classifyMutationError(err).message)
      }
    },
    [renameMutation, sessionId],
  )

  // ── Scroll stickiness ──────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement | null>(null)
  const [hasUnseenBelow, setHasUnseenBelow] = useState(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = listRef.current
    if (!el) return
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior })
    } else {
      el.scrollTop = el.scrollHeight
    }
    setHasUnseenBelow(false)
  }, [])

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const pinned = isPinnedToBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
    if (pinned) setHasUnseenBelow(false)
  }, [])

  useEffect(() => {
    if (messages.length === 0) return
    const el = listRef.current
    if (!el) return
    const pinned = isPinnedToBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
    if (pinned) {
      scrollToBottom('smooth')
    } else {
      setHasUnseenBelow(true)
    }
  }, [messages, scrollToBottom])

  // ── Turn-cap status ────────────────────────────────────────────────
  const turnCap = classifyTurnCap(messages.length)
  const assistantTurns = useMemo(
    () => messages.filter((m) => m.role === 'assistant').length,
    [messages],
  )
  const showConvertCta = assistantTurns >= 2

  // ── Groups (for the convert → picker → navigate flow) ──────────────
  const groups = useMyGroups()
  const [pickerOpen, setPickerOpen] = useState(false)

  // ── Send handler — full SSE streaming ──────────────────────────────
  const sendWithContent = useCallback(
    async (content: string) => {
      if (isStreaming) return
      const sid = sessionIdRef.current
      if (!sid) return
      const trimmed = content.trim()
      if (trimmed.length === 0) return
      if (classifyTurnCap(messagesRef.current.length) === 'blocked') return

      const userMsg: LocalMessage = {
        id: localId(),
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      }
      const assistantMsgId = localId()
      const assistantMsg: LocalMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        streaming: true,
      }
      setOptimistic((prev) => [...prev, userMsg, assistantMsg])
      setInput('')
      setError(null)
      setIsStreaming(true)
      lastSubmittedRef.current = trimmed

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const stream = streamChatTurn(sid, trimmed, controller.signal)
        while (true) {
          const next = await stream.next()
          if (next.done) {
            break
          }
          const ev = next.value
          if (ev.type === 'message-started') {
            const data = ev.data as { messageId?: string }
            if (data?.messageId) {
              setOptimistic((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, id: data.messageId! } : m,
                ),
              )
            }
          } else if (ev.type === 'token') {
            const data = ev.data as { text?: string }
            if (data?.text) {
              setOptimistic((prev) =>
                prev.map((m) =>
                  m.role === 'assistant' && m.streaming
                    ? { ...m, content: m.content + data.text }
                    : m,
                ),
              )
            }
          }
          // 'usage' / 'heartbeat' ignored; 'done' arrives via `next.done`.
          // 'error' surfaces via the generator throwing; handled below.
        }

        // Finalise streaming locally — drop the streaming flag so the
        // typing indicator hides.
        setOptimistic((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        )
        await queryClient.invalidateQueries({
          queryKey: chatQueryKeys.messages(sid),
        })
        // Bump the sessions list too so updatedAt + messageCount refresh.
        await queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(CHAT_SESSIONS_DEFAULT_LIMIT),
        })
        // Drop the optimistic USER bubble once the refetch lands.
        // Reason: the server-issued user row has its own UUID, which
        // never matches our `local-<uuid>` placeholder → the id-based
        // dedupe in the merge memo leaves BOTH visible (the reported
        // doubled-messages symptom). The assistant bubble's id was
        // already patched to the server id on `message-started`, so
        // the merge memo drops it via id-match when the persisted
        // assistant row arrives.
        setOptimistic((prev) => prev.filter((m) => m.role === 'assistant'))
      } catch (err) {
        // Distinguish abort vs server-side error; either way keep the
        // partial assistant content visible with the "interrupted"
        // affordance. AbortError + SseChatStreamError both land here.
        const isAbort =
          (err as { name?: string })?.name === 'AbortError' ||
          controller.signal.aborted
        // Mark the in-flight assistant bubble errored AND drop the
        // optimistic user bubble in the same pass — the persisted
        // user row will arrive via the refetch below and we don't
        // want a local-id + server-id pair rendering twice. Keep the
        // errored assistant bubble so the inline "Erneut versuchen"
        // button stays reachable until the refetch-plus-retry loop
        // resolves.
        setOptimistic((prev) =>
          prev
            .filter((m) => m.role !== 'user')
            .map((m) =>
              m.role === 'assistant' && m.streaming
                ? { ...m, streaming: false, errored: true }
                : m,
            ),
        )
        if (isAbort) {
          // The backend persisted whatever it streamed before our
          // disconnect — refetch so the canonical partial replaces our
          // optimistic copy via the id-match dedupe in the merge memo.
          await queryClient.invalidateQueries({
            queryKey: chatQueryKeys.messages(sid),
          })
          setError(null)
        } else {
          // REL-3e — translate backend / SSE error-codes through
          // `classifyMutationError`. `SseChatStreamError` carries the
          // code but no `status`, so the classifier takes the
          // `errors.json`-lookup branch and surfaces the German copy
          // (e.g. `turn_failed` → "Chat-Antwort fehlgeschlagen.").
          setError(classifyMutationError(err).message)
        }
      } finally {
        abortRef.current = null
        setIsStreaming(false)
      }
    },
    [isStreaming, queryClient],
  )

  const handleSendClick = useCallback(() => {
    void sendWithContent(input)
  }, [input, sendWithContent])

  const handleAbortClick = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /**
   * Retry after a stream error: drop the errored partial assistant
   * bubble locally + the user bubble paired with it, then re-submit
   * the same user content. The server-side history grows by one
   * additional user+assistant pair (the partial stays in the DB so
   * future refetches still show it next to the retry — documented in
   * the page-header comment).
   */
  const handleRetry = useCallback(() => {
    setOptimistic((prev) =>
      prev.filter((m) => !(m.role === 'assistant' && m.errored)),
    )
    setError(null)
    void sendWithContent(lastSubmittedRef.current)
  }, [sendWithContent])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void sendWithContent(input)
      }
    },
    [input, sendWithContent],
  )

  // ── Convert to recipe ──────────────────────────────────────────────
  const convertWithGroup = useCallback(
    async (groupId: string) => {
      setConvertError(null)
      try {
        const result = await convertMutation.mutateAsync({
          sessionId: sessionIdRef.current,
        })
        const chatImportId = crypto.randomUUID()
        stashChatImport(chatImportId, { groupId, result })
        navigate(
          `/groups/${groupId}/recipes/new?chatImportId=${encodeURIComponent(
            chatImportId,
          )}`,
        )
      } catch (err) {
        // REL-3e — route through `classifyMutationError` so the user
        // sees the translated `errors.json` copy (or the generic 5xx
        // toast-style fallback) instead of the English backend message.
        setConvertError(classifyMutationError(err).message)
      }
    },
    [convertMutation, navigate],
  )

  const handleConvertClick = useCallback(() => {
    const list = groups.data ?? []
    if (list.length === 0) {
      setConvertError(t('chat.page.convertNoGroup'))
      return
    }
    if (list.length === 1) {
      void convertWithGroup(list[0]!.id)
      return
    }
    setPickerOpen(true)
  }, [convertWithGroup, groups.data, t])

  const handleGroupPick = useCallback(
    (group: GroupSummary) => {
      setPickerOpen(false)
      void convertWithGroup(group.id)
    },
    [convertWithGroup],
  )

  // ── Render ─────────────────────────────────────────────────────────
  const sendDisabled =
    isStreaming || input.trim().length === 0 || turnCap === 'blocked'

  return (
    <div
      className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 md:px-6"
    >
      <ChatTopBar
        title={session?.title ?? null}
        onBack={() => navigate(-1)}
        onRename={() => {
          setRenameError(null)
          setRenameOpen(true)
        }}
        canRename={!!sessionId}
      />

      <div
        ref={listRef}
        onScroll={onScroll}
        data-testid="chat-message-list"
        className="relative flex-1 overflow-y-auto px-1 py-3"
        aria-live="polite"
        aria-label={t('chat.page.historyAria')}
      >
        {messages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          <ul className="flex flex-col gap-3 pb-2">
            {messages.map((msg) => (
              <ChatBubble key={msg.id} message={msg} onRetry={handleRetry} />
            ))}
            {isStreaming && (
              <li className="flex w-full justify-start">
                <TypingIndicator />
              </li>
            )}
          </ul>
        )}

        {error && (
          <div className="sticky bottom-0 left-0 right-0 mt-3">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[12px] border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-[13px] text-foreground"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[hsl(var(--destructive))]"
                aria-hidden="true"
              />
              <div className="flex-1">
                <p>{error}</p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  {t('chat.page.retryCta')}
                </button>
              </div>
            </div>
          </div>
        )}

        {hasUnseenBelow && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="sticky bottom-4 left-1/2 z-10 mx-auto flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-primary bg-primary/95 px-3 py-1.5 text-[12px] font-semibold text-primary-foreground shadow-[0_4px_12px_-2px_rgba(79,121,97,0.35)] backdrop-blur"
            style={{
              bottom: `${SCROLL_STICKY_THRESHOLD_PX}px`,
            }}
          >
            {t('chat.page.newMessage')}
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Turn-cap banner (warn + blocked have different copy). */}
      {turnCap !== 'ok' && <TurnCapNotice level={turnCap} />}

      {/* "In Rezept umwandeln" CTA — only after 2+ assistant replies. */}
      {showConvertCta && (
        <ConvertToRecipeBar
          pending={convertMutation.isPending}
          error={convertError}
          onConvert={handleConvertClick}
        />
      )}

      {/* Sticky input */}
      <div className="border-t border-border bg-background px-2 pb-[calc(16px+env(safe-area-inset-bottom,0px))] pt-3">
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            {t('chat.page.messageLabel')}
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={t('chat.page.inputPlaceholder')}
            aria-label={t('chat.page.messageLabel')}
            disabled={turnCap === 'blocked' || isStreaming}
            className="min-h-[44px] max-h-40 flex-1 resize-none rounded-[14px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-base leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[hsl(var(--muted-foreground))]/80 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {isStreaming ? (
            <Button
              type="button"
              onClick={handleAbortClick}
              variant="outline"
              aria-label={t('chat.page.abortAria')}
              className="h-11 gap-1.5 px-4"
            >
              <Square className="h-4 w-4" aria-hidden="true" />
              {t('chat.page.abortLabel')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSendClick}
              disabled={sendDisabled}
              aria-label={t('chat.page.sendAria')}
              className="h-11 gap-1.5 px-4"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              {t('chat.page.sendLabel')}
            </Button>
          )}
        </div>
      </div>

      {pickerOpen && groups.data && groups.data.length > 1 && (
        <GroupPickerDialog
          groups={groups.data}
          onPick={handleGroupPick}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <RenameSessionDialog
        open={renameOpen}
        initialTitle={session?.title ?? null}
        onOpenChange={(next) => {
          if (!next) {
            setRenameOpen(false)
            setRenameError(null)
          }
        }}
        onSubmit={handleRenameSubmit}
        isLoading={renameMutation.isPending}
        error={renameError}
      />
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────

function ChatTopBar({
  title,
  onBack,
  onRename,
  canRename,
}: {
  title: string | null
  onBack: () => void
  onRename: () => void
  canRename: boolean
}) {
  const { t } = useTranslation()
  const displayTitle = title ?? t('chat.page.defaultTitle')
  const isFallback = !title
  return (
    <header
      role="banner"
      className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/60 bg-[hsl(var(--background)/0.92)] py-3 backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.85)]"
    >
      <button
        type="button"
        onClick={onBack}
        aria-label={t('chat.page.backAria')}
        className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
      >
        <ChevronLeft className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Sparkles
          className="h-4 w-4 flex-shrink-0 text-primary"
          aria-hidden="true"
        />
        <h1
          className={cn(
            'truncate font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground',
            isFallback && title === null && 'italic',
          )}
        >
          {displayTitle}
        </h1>
      </div>
      {canRename && (
        <button
          type="button"
          onClick={onRename}
          aria-label={t('chat.page.renameAria')}
          className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Pencil className="h-[16px] w-[16px]" aria-hidden="true" />
        </button>
      )}
    </header>
  )
}

function ChatEmptyState() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto mt-8 max-w-md rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 p-6 text-center">
      <Sparkles className="mx-auto h-5 w-5 text-primary" aria-hidden="true" />
      <p className="mt-2 font-serif text-[20px] font-semibold leading-tight tracking-[-0.005em] text-foreground">
        {t('chat.page.emptyTitle')}
      </p>
      <p className="mt-1 text-[13.5px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
        {t('chat.page.emptyBody')}
      </p>
    </div>
  )
}

function ChatBubble({
  message,
  onRetry,
}: {
  message: LocalMessage
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const isErrored = !!message.errored
  // Don't render an empty pre-stream assistant bubble — the typing
  // indicator below carries the "thinking" affordance until the first
  // token lands. This avoids an empty white box flickering above the
  // dots in the < 100 ms window before the first token.
  if (!isUser && message.content.length === 0 && message.streaming) {
    return null
  }
  return (
    <li
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <div className="flex max-w-[80%] flex-col gap-1">
        <div
          className={cn(
            'rounded-[18px] px-4 py-2.5 shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
            isUser
              ? 'rounded-tr-[6px] border border-primary bg-primary text-primary-foreground'
              : cn(
                  'rounded-tl-[6px] bg-card text-foreground',
                  isErrored
                    ? 'border-2 border-[hsl(var(--destructive))]'
                    : 'border border-border',
                ),
          )}
        >
          <p className="whitespace-pre-wrap text-[14.5px] leading-[1.5]">
            {message.content}
          </p>
        </div>
        {isErrored && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-[hsl(var(--destructive))]">
            <span className="font-semibold">{t('chat.page.interrupted')}</span>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {t('chat.page.retryCta')}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

function TurnCapNotice({ level }: { level: 'warn' | 'blocked' }) {
  const { t } = useTranslation()
  const isBlocked = level === 'blocked'
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 border-t px-3 py-2 text-[13px]',
        isBlocked
          ? 'border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)]'
          : 'border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.14)]',
      )}
    >
      <AlertTriangle
        className={cn(
          'mt-0.5 h-3.5 w-3.5 flex-shrink-0',
          isBlocked
            ? 'text-[hsl(var(--destructive))]'
            : 'text-[hsl(var(--warning-foreground))]',
        )}
        aria-hidden="true"
      />
      <p className="flex-1 leading-[1.4] text-foreground">
        {isBlocked
          ? t('chat.page.turnCapBlocked')
          : t('chat.page.turnCapWarn')}
      </p>
      <span className="sr-only">
        {t('chat.page.turnLabelTemplate', {
          n: isBlocked ? CHAT_HARD_CAP : CHAT_WARN_AT,
        })}
      </span>
    </div>
  )
}

function ConvertToRecipeBar({
  pending,
  error,
  onConvert,
}: {
  pending: boolean
  error: string | null
  onConvert: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="border-t border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.06)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-foreground">
          <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden="true" />
          {t('chat.page.convertPrompt')}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={onConvert}
          disabled={pending}
          className="gap-1.5"
        >
          <Utensils className="h-3.5 w-3.5" aria-hidden="true" />
          {pending ? t('chat.page.convertPending') : t('chat.page.convertCta')}
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-1 text-[12.5px] text-[hsl(var(--destructive))]"
        >
          {error}
        </p>
      )}
    </div>
  )
}

