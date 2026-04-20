import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  ApiError,
  GroupSummary,
} from '@familien-kochbuch/shared'
// CR2 — shared `ChatMessage` has been renamed to `ChatMessageDto`
// (different shape). The pre-CR4 ChatPage still speaks in the legacy
// role/content pair for the send-turn path; CR4 rewrites the page
// against the SSE surface.
import type { LegacyChatMessage as ChatMessage } from './chatApi'
import {
  AlertTriangle,
  ArrowDown,
  ChevronLeft,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Utensils,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { GroupPickerDialog } from '@/features/groups/GroupPickerDialog'
import { useChatTurn, useConvertChatToRecipe } from './hooks'
import { useChatMessages, useChatSessions, useRenameChatSession } from './useChatSessions'
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

/**
 * `/chat/:sessionId` — the CR3 conversational recipe-creation surface.
 *
 * Full-height flex column:
 *   1. Sticky top bar: back button + session title (click to rename).
 *   2. Scrollable message list (flex-1) with user + assistant bubbles.
 *      Once the assistant has sent ≥ 2 replies, the "In Rezept
 *      umwandeln" call-to-action slides in at the top of the list's
 *      footer so the user can convert without scrolling.
 *   3. Sticky bottom input area: textarea + send button.
 *
 * BUG-001 — viewport sizing on mobile. `100dvh` (dynamic viewport
 * height) instead of `100vh` so the chat container shrinks/grows in
 * lock-step with the iOS Safari URL-bar / Chrome-Android address-bar
 * retraction animation. We additionally subtract the height of the
 * AppLayout chrome — TopNav (64px mobile, 72px desktop) AND the mobile
 * BottomNav (88px) plus `env(safe-area-inset-bottom,0px)` for the iOS
 * home-indicator zone — so the input footer stays above both the app
 * BottomNav and the browser bottom-bar. The input footer also keeps
 * its own `pb-[env(safe-area-inset-bottom,0px)]` as defence-in-depth.
 *
 * CR3 session lifecycle:
 * - The session id comes from the URL (`/chat/:sessionId`). The
 *   redirect-at-`/chat` picks the newest session on entry so the URL
 *   is always populated by the time this page mounts.
 * - Message history is pulled from the server via {@link useChatMessages}
 *   so a reload resumes the thread instead of starting fresh.
 * - The optimistic outgoing buffer (user text + pending assistant
 *   reply from the legacy JSON turn endpoint) lives in component state
 *   until the next server refetch; it is layered on top of the
 *   fetched history for display.
 * - Input drafts are keyed by sessionId in `sessionStorage` so
 *   switching sessions preserves half-typed prompts without leaking
 *   them across other tabs / users.
 *
 * NOTE: CR3 keeps the legacy non-streaming `sendChatTurn` path —
 * append the user bubble, POST, append the assistant reply. CR4
 * swaps this block out for the SSE streaming consumer.
 */
const draftKey = (sessionId: string) => `fk-chat-draft:${sessionId}`

export function ChatPage() {
  const { sessionId: routeSessionId } = useParams()
  const navigate = useNavigate()

  // ── Session id (from URL) ──────────────────────────────────────────
  // ChatRouteOutlet guarantees we only mount under `/chat/:sessionId`
  // so routeSessionId should always be defined; fall back to empty
  // string (disables queries + mutations) so component tests can
  // still mount the page outside a real router.
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

  // ── Optimistic layer ───────────────────────────────────────────────
  // The legacy turn endpoint returns a single JSON payload, not a
  // stream; hold the optimistic user bubble + the assistant reply in
  // local state until the next messages refetch syncs them in.
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([])
  // Reset the optimistic buffer when the session id changes (switching
  // conversations must not leak in-flight bubbles across threads). A
  // direct setState in-effect here is intentional — the reset is an
  // external-event handoff (URL param change), not a derived value.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot URL→state reset on session switch
    setOptimistic([])
  }, [sessionId])

  const messages: ChatMessage[] = useMemo(() => {
    const persisted: ChatMessage[] = (messagesQuery.data ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }))
    return [...persisted, ...optimistic]
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
  // The setState-in-effect is intentional: we're reading from an
  // external store (sessionStorage) in response to a route change.
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
  const turnMutation = useChatTurn()
  const convertMutation = useConvertChatToRecipe()
  const sendingRef = useRef(false)
  useEffect(() => {
    sendingRef.current = turnMutation.isPending
  }, [turnMutation.isPending])

  // ── Error state (distinct from the mutation error so we can clear
  //     it when the retry fires without hacking the mutation state) ──
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
        const apiErr = err as Error
        setRenameError(
          apiErr.message ||
            'Umbenennen fehlgeschlagen. Bitte erneut versuchen.',
        )
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

  // ── Send handler ───────────────────────────────────────────────────
  const sendWithContent = useCallback(
    async (content: string) => {
      if (sendingRef.current) return
      if (!sessionIdRef.current) return
      const trimmed = content.trim()
      if (trimmed.length === 0) return
      if (classifyTurnCap(messagesRef.current.length) === 'blocked') return

      const userMsg: ChatMessage = { role: 'user', content: trimmed }
      // Optimistic append (local buffer) + clear input + wipe any
      // previous error in the same render tick.
      const prevOptimistic = optimistic
      const nextMessages = [...messagesRef.current, userMsg]
      setOptimistic((prev) => [...prev, userMsg])
      setInput('')
      setError(null)

      try {
        const res = await turnMutation.mutateAsync({
          sessionId: sessionIdRef.current,
          messages: nextMessages,
        })
        setOptimistic((prev) => [
          ...prev,
          { role: 'assistant', content: res.assistantMessage },
        ])
      } catch (err) {
        const apiErr = err as ApiError
        // Rollback the optimistic bubble + preserve the user's text in
        // the input so "Erneut senden" can resubmit without retyping.
        setOptimistic(prevOptimistic)
        setInput(trimmed)
        setError(
          apiErr.message ||
            'Senden fehlgeschlagen. Bitte versuche es erneut.',
        )
      }
    },
    [turnMutation, optimistic],
  )

  const handleSendClick = useCallback(() => {
    void sendWithContent(input)
  }, [input, sendWithContent])

  const handleRetry = useCallback(() => {
    void sendWithContent(input)
  }, [input, sendWithContent])

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
          messages: messagesRef.current,
        })
        const chatImportId = crypto.randomUUID()
        stashChatImport(chatImportId, { groupId, result })
        navigate(
          `/groups/${groupId}/recipes/new?chatImportId=${encodeURIComponent(
            chatImportId,
          )}`,
        )
      } catch (err) {
        const apiErr = err as ApiError
        setConvertError(
          apiErr.message ||
            'Der Chat konnte nicht in ein Rezept umgewandelt werden.',
        )
      }
    },
    [convertMutation, navigate],
  )

  const handleConvertClick = useCallback(() => {
    const list = groups.data ?? []
    if (list.length === 0) {
      setConvertError(
        'Du brauchst mindestens eine Gruppe, um ein Rezept zu speichern.',
      )
      return
    }
    if (list.length === 1) {
      void convertWithGroup(list[0]!.id)
      return
    }
    setPickerOpen(true)
  }, [convertWithGroup, groups.data])

  const handleGroupPick = useCallback(
    (group: GroupSummary) => {
      setPickerOpen(false)
      void convertWithGroup(group.id)
    },
    [convertWithGroup],
  )

  // ── Render ─────────────────────────────────────────────────────────
  const sendDisabled =
    turnMutation.isPending || input.trim().length === 0 || turnCap === 'blocked'

  return (
    <div className="mx-auto flex h-[calc(100dvh-64px-88px-env(safe-area-inset-bottom,0px))] w-full max-w-3xl flex-col px-4 md:h-[calc(100dvh-72px)] md:px-6">
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
        aria-label="Chat-Verlauf"
      >
        {messages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          <ul className="flex flex-col gap-3 pb-2">
            {messages.map((msg, idx) => (
              <ChatBubble key={idx} message={msg} />
            ))}
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
                  Erneut senden
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
            Neue Nachricht
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
            Nachricht
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Was möchtest du kochen?"
            aria-label="Nachricht"
            disabled={turnCap === 'blocked'}
            className="min-h-[44px] max-h-40 flex-1 resize-none rounded-[14px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-base leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[hsl(var(--muted-foreground))]/80 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            type="button"
            onClick={handleSendClick}
            disabled={sendDisabled}
            aria-label="Senden"
            className="h-11 gap-1.5 px-4"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Senden
          </Button>
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
  const displayTitle = title ?? 'Rezept-Chat'
  const isFallback = !title
  return (
    <header
      role="banner"
      className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/60 bg-[hsl(var(--background)/0.92)] py-3 backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.85)]"
    >
      <button
        type="button"
        onClick={onBack}
        aria-label="Zurück"
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
          aria-label="Unterhaltung umbenennen"
          className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Pencil className="h-[16px] w-[16px]" aria-hidden="true" />
        </button>
      )}
    </header>
  )
}

function ChatEmptyState() {
  return (
    <div className="mx-auto mt-8 max-w-md rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 p-6 text-center">
      <Sparkles className="mx-auto h-5 w-5 text-primary" aria-hidden="true" />
      <p className="mt-2 font-serif text-[20px] font-semibold leading-tight tracking-[-0.005em] text-foreground">
        Was möchtest du heute kochen?
      </p>
      <p className="mt-1 text-[13.5px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
        Erzähl, was du da hast — z.B. „Kartoffeln, Quark, Lauch, 30 Min, vegan“.
        Wir schlagen was vor, du feilst nach, und am Ende wandeln wir es in ein
        Rezept um.
      </p>
    </div>
  )
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <li
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-[18px] px-4 py-2.5 shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
          isUser
            ? 'rounded-tr-[6px] border border-primary bg-primary text-primary-foreground'
            : 'rounded-tl-[6px] border border-border bg-card text-foreground',
        )}
      >
        <p className="whitespace-pre-wrap text-[14.5px] leading-[1.5]">
          {message.content}
        </p>
      </div>
    </li>
  )
}

function TurnCapNotice({ level }: { level: 'warn' | 'blocked' }) {
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
          ? `Dialog ist voll — nutze „In Rezept umwandeln" oder starte eine neue Unterhaltung über die Seitenleiste.`
          : 'Lange Dialoge werden schwächer. Bald bitte in Rezept umwandeln oder eine neue Unterhaltung starten.'}
      </p>
      <span className="sr-only">
        Turn {isBlocked ? CHAT_HARD_CAP : CHAT_WARN_AT}+
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
  return (
    <div className="border-t border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.06)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-foreground">
          <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Passt das Rezept? Dann speichern.
        </p>
        <Button
          type="button"
          size="sm"
          onClick={onConvert}
          disabled={pending}
          className="gap-1.5"
        >
          <Utensils className="h-3.5 w-3.5" aria-hidden="true" />
          {pending ? 'Wandle um …' : 'In Rezept umwandeln'}
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
