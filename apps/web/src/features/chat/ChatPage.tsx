import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type {
  ApiError,
  ChatMessage,
  GroupSummary,
} from '@familien-kochbuch/shared'
import {
  AlertTriangle,
  ArrowDown,
  ChevronLeft,
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
import {
  SCROLL_STICKY_THRESHOLD_PX,
  isPinnedToBottom,
} from './scrollStickiness'
import { CHAT_HARD_CAP, CHAT_WARN_AT, classifyTurnCap } from './turnCap'
import { stashChatImport } from './chatImportMemo'

/**
 * `/chat` — the P2-9 conversational recipe-creation surface.
 *
 * Full-height flex column:
 *   1. Sticky top bar: back button + "Rezept-Chat" title.
 *   2. Scrollable message list (flex-1) with user + assistant bubbles.
 *      Once the assistant has sent ≥ 2 replies, the "In Rezept
 *      umwandeln" call-to-action slides in at the top of the list's
 *      footer so the user can convert without scrolling.
 *   3. Sticky bottom input area: textarea + send button.
 *
 * The session id is generated on mount (or picked up from
 * `?session=<uuid>` if the user pasted a URL) and written back into
 * the URL via history.replace so a page reload keeps the same chat
 * thread alive. Messages themselves are NOT persisted — privacy call-
 * out in the P2-9 plan + PRD §5.4. Closing the tab drops the dialogue.
 *
 * hoppr reference lessons applied (see commit of step 2 for detail):
 *   - Clear input + append user bubble synchronously on send, before
 *     awaiting the network, so the UI feels instant.
 *   - Ref-mirror for the "sending" flag + messages so async handlers
 *     never operate on stale closures.
 *   - On error: roll back the optimistic user bubble AND preserve the
 *     user's text in the input so "Erneut senden" can resubmit
 *     verbatim — no retype required.
 */
export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // ── Session id ─────────────────────────────────────────────────────
  // The URL is the source of truth. If the user lands on /chat without
  // a ?session=… param we mint one on mount + sync it back so a refresh
  // keeps the thread alive. If a session id is already in the URL we
  // keep it verbatim — never overwrite what the user pasted.
  const [sessionId, setSessionId] = useState<string>(() => {
    const urlSession = searchParams.get('session')
    if (urlSession && urlSession.length > 0) return urlSession
    return crypto.randomUUID()
  })
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Write the session id back to the URL once on mount (or whenever it
  // changes via "Neu starten"). `replace: true` so the user doesn't get
  // a dead back-button entry pointing at the empty `/chat` URL.
  useEffect(() => {
    const urlSession = searchParams.get('session')
    if (urlSession !== sessionId) {
      const next = new URLSearchParams(searchParams)
      next.set('session', sessionId)
      setSearchParams(next, { replace: true })
    }
    // We intentionally depend only on sessionId — `setSearchParams` is
    // referentially stable from react-router, and `searchParams` being
    // in the dep array would create a loop (our own update would
    // trigger another run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ── Messages state + ref mirror ───────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // ── Input state (controlled) ──────────────────────────────────────
  const [input, setInput] = useState('')

  // ── Network mutations ─────────────────────────────────────────────
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

  // ── Scroll stickiness ─────────────────────────────────────────────
  // We deliberately don't mirror the `isPinnedToBottom` result into
  // state — the value is read once per messages-changed effect and
  // once on user-driven scroll, directly off the DOM metrics. Keeping
  // just `hasUnseenBelow` in state means we don't re-render the list
  // on every scroll tick.
  const listRef = useRef<HTMLDivElement | null>(null)
  const [hasUnseenBelow, setHasUnseenBelow] = useState(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = listRef.current
    if (!el) return
    // JSDOM (our test env) doesn't implement scrollTo, so guard the
    // smooth variant and fall back to a plain scrollTop write — which
    // JSDOM does support and which is enough for the real code path
    // too when the browser lacks smooth-scroll support.
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

  // When messages change: auto-scroll to bottom IF we were already
  // pinned, otherwise raise the "Neue Nachricht ↓" pill. Ref-reads the
  // latest atBottom so the effect reacts to the correct window.
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

  // ── Turn-cap status ───────────────────────────────────────────────
  const turnCap = classifyTurnCap(messages.length)
  const assistantTurns = useMemo(
    () => messages.filter((m) => m.role === 'assistant').length,
    [messages],
  )
  const showConvertCta = assistantTurns >= 2

  // ── Groups (for the convert → picker → navigate flow) ─────────────
  const groups = useMyGroups()
  const [pickerOpen, setPickerOpen] = useState(false)

  // ── Send handler ──────────────────────────────────────────────────
  const sendWithContent = useCallback(
    async (content: string) => {
      if (sendingRef.current) return
      const trimmed = content.trim()
      if (trimmed.length === 0) return
      if (classifyTurnCap(messagesRef.current.length) === 'blocked') return

      const userMsg: ChatMessage = { role: 'user', content: trimmed }
      // Optimistic append + clear input + wipe any previous error in
      // the same render tick. The mutation fires right after this.
      const prevMessages = messagesRef.current
      const nextMessages = [...prevMessages, userMsg]
      setMessages(nextMessages)
      setInput('')
      setError(null)

      try {
        const res = await turnMutation.mutateAsync({
          sessionId: sessionIdRef.current,
          messages: nextMessages,
        })
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: res.assistantMessage },
        ])
      } catch (err) {
        const apiErr = err as ApiError
        // Rollback the optimistic bubble + preserve the user's text in
        // the input so "Erneut senden" can resubmit without retyping.
        setMessages(prevMessages)
        setInput(trimmed)
        setError(
          apiErr.message || 'Senden fehlgeschlagen. Bitte versuche es erneut.',
        )
      }
    },
    [turnMutation],
  )

  const handleSendClick = useCallback(() => {
    void sendWithContent(input)
  }, [input, sendWithContent])

  const handleRetry = useCallback(() => {
    void sendWithContent(input)
  }, [input, sendWithContent])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter submits, Shift+Enter inserts a newline — textarea-in-chat
      // convention matches hoppr + most chat surfaces.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void sendWithContent(input)
      }
    },
    [input, sendWithContent],
  )

  const handleReset = useCallback(() => {
    const fresh = crypto.randomUUID()
    setMessages([])
    setInput('')
    setError(null)
    setConvertError(null)
    setSessionId(fresh)
  }, [])

  // ── Convert to recipe ─────────────────────────────────────────────
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

  // ── Render ────────────────────────────────────────────────────────

  const sendDisabled =
    turnMutation.isPending || input.trim().length === 0 || turnCap === 'blocked'

  return (
    <div className="mx-auto flex h-[calc(100dvh-64px)] w-full max-w-3xl flex-col px-4 md:h-[calc(100dvh-72px)] md:px-6">
      <ChatTopBar onBack={() => navigate(-1)} />

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
              // Stick above the threshold so the pill is always visible
              // even when the content height is still growing.
              bottom: `${SCROLL_STICKY_THRESHOLD_PX}px`,
            }}
          >
            Neue Nachricht
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Turn-cap banner (warn + blocked have different copy) */}
      {turnCap !== 'ok' && (
        <TurnCapNotice level={turnCap} onReset={handleReset} />
      )}

      {/* "In Rezept umwandeln" CTA — only after 2+ assistant replies */}
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
            className="min-h-[44px] max-h-40 flex-1 resize-none rounded-[14px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-[15px] leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[hsl(var(--muted-foreground))]/80 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
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
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────

function ChatTopBar({ onBack }: { onBack: () => void }) {
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
        <Sparkles className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
        <h1 className="font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground">
          Rezept-Chat
        </h1>
      </div>
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

function TurnCapNotice({
  level,
  onReset,
}: {
  level: 'warn' | 'blocked'
  onReset: () => void
}) {
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
          ? `Dialog ist voll — nutze „In Rezept umwandeln" oder starte neu.`
          : 'Lange Dialoge werden schwächer. Bald bitte in Rezept umwandeln oder neu starten.'}{' '}
        <button
          type="button"
          onClick={onReset}
          className="ml-1 inline-flex items-center gap-1 align-baseline font-semibold text-primary hover:underline"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Neu starten
        </button>
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
