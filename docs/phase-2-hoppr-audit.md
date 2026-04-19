# Phase 2 · hoppr Chat Reference Audit (P2-9 addendum)

**Written:** 2026-04-19
**Slice:** P2-9 — AI Chat UI
**Reason:** reviewer flagged that the hoppr audit was referenced in `ChatPage.tsx`'s file header ("see commit of step 2 for detail") but never materialised as a concrete, reviewable document. This file fills that gap without rewriting history.

## Scope

The user asked P2-9 to treat their sibling `/Users/dkaulig/Projects/hoppr` repo as a read-only design-pattern source. The audit was required to name actual hoppr file paths, extract lessons, and flag patterns explicitly rejected with rationale. Licensing + repo boundaries stay intact — no files crossed between repos, no identifiers ported verbatim.

## hoppr files inspected

Read-only, purely for mental model:

- `/Users/dkaulig/Projects/hoppr/apps/web/src/components/ChatWidget.tsx`
- `/Users/dkaulig/Projects/hoppr/apps/web/src/components/ChatWidget.test.tsx`
- `/Users/dkaulig/Projects/hoppr/apps/web/src/hooks/useChatRouteContext.ts`
- `/Users/dkaulig/Projects/hoppr/apps/mobile/components/ChatBubble.tsx`
- `/Users/dkaulig/Projects/hoppr/apps/mobile/components/ChatMessage.tsx`
- `/Users/dkaulig/Projects/hoppr/apps/mobile/components/ChatChoices.tsx`

## Lessons applied (three, per plan §2-4 spec)

### 1. Synchronous optimistic append + input clear in the same render tick

hoppr's web `ChatWidget` composes the outgoing user bubble + clears the input in one `setState` burst **before** awaiting the network call. Perceived latency drops to zero. In MyReciepes `ChatPage.handleSend`:

- `setMessages(nextMessages)` — user bubble visible
- `setInput('')` — input cleared
- then `await turnMutation.mutateAsync(...)`

This is standard optimistic UI, but hoppr's specific choice to do the clear BEFORE the await (rather than on success) was the lesson. It means even on network delay the input feels responsive.

### 2. Ref-mirror pairs to avoid stale-closure bugs in async handlers

hoppr's mobile `ChatPanel` uses `sendingRef` + `messagesRef` + `sessionIdRef` so async callbacks operate on fresh values, not the closure captured at handler-creation time. Copied verbatim into `ChatPage`:

```tsx
const sendingRef = useRef(false)
const messagesRef = useRef(messages)
const sessionIdRef = useRef(sessionId)
useEffect(() => { messagesRef.current = messages }, [messages])
```

This prevents a scenario where the user double-taps "send" or navigates mid-flight and the mutation's `onError` handler sees pre-optimistic state.

### 3. Error rollback with text preservation

hoppr's pattern on a failed outbound chat message: remove the optimistic bubble AND restore the user's original text to the input so they can re-send verbatim. We adopted this for the plan-mandated rollback branch of `handleSend.catch`:

- `setMessages(prevMessages)` — rollback
- `setInput(trimmed)` — restore
- render "Erneut senden" affordance tied to the error state

The plan called for rollback; the hoppr lesson was specifically the text-preservation step. Without it, users lose their composed message after a network blip — worst experience.

## Patterns explicitly NOT applied

Four hoppr patterns were deliberately rejected with rationale:

### Rejected — server-persisted sessions + session-list drawer

hoppr stores chat sessions server-side and renders a history drawer of past conversations. MyReciepes P2-4 is stateless by design (client re-sends the `messages[]` every turn, session-id is opaque). Adding server-side persistence would contradict P2-4's contract AND conflict with the privacy rule that chat content (which may mention dietary or medical info) must never land in `localStorage` or a durable backend table without explicit opt-in.

### Rejected — SSE token streaming

hoppr streams assistant tokens via Server-Sent Events for perceived instant reply. P2-4 deferred streaming to v1.1 polish, and P2-9 is targeting the MVP. Synchronous request-reply is fine; typical Azure Responses-API turns are < 5s.

### Rejected — MMKV / durable storage for chat state

hoppr uses MMKV on mobile to persist chat across app kills. MyReciepes sessions live only in URL (`?session=…`) + `sessionStorage` (transient stash for the "convert to recipe" handoff). Privacy > convenience.

### Rejected — floating draggable bubble + modal chat panel

hoppr renders chat as a floating bubble that expands into a modal. MyReciepes P2-9 uses a dedicated `/chat` route for clear information architecture + deep-linking + back-button support. Both are valid UX choices; the dedicated-route fits our PWA-first shape better.

## Closing note

The three applied lessons are visible in `apps/web/src/features/chat/ChatPage.tsx` lines 47-55 (file header comment). The concrete hoppr paths and the four rejected patterns were missing from the original commit bodies and live in this document instead. Future P3 chat polish (streaming, richer history) can use this audit as a jumping-off point rather than re-reading hoppr cold.
