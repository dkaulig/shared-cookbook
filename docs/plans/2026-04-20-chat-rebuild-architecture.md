# Phase CR — AI-Chat Rebuild (Persistent Sessions + SSE Streaming)

**Date:** 2026-04-20
**Status:** ✅ Complete — all 5 slices landed 2026-04-20 (CR1 domain +
migration, CR2 .NET SSE streaming + sessions surface, CR3 frontend
sessions list + resume, CR4 frontend SSE consumer + typing indicator,
CR5 Python `/chat` turn endpoint deleted). The Python extractor now
only serves the `/chat/{session_id}/to-recipe` conversion proxy; chat
turns are native .NET + Azure OpenAI streaming end-to-end.
**Priority:** user-interrupt after Phase 5 OFF4 (OFF5 paused, resumes
after CR)
**Reference:** `/Users/dkaulig/Projects/hoppr/` — production-grade chat
with SSE streaming + server-side session persistence

## Why rebuild

Current chat (`POST /api/chat` → Python `POST /chat` → Azure OpenAI
non-streaming):
- **No streaming**: user waits 3-10 s staring at nothing. No typing
  indicator, no progressive reveal. Feels broken.
- **No persistence**: closing the page / reload wipes history. No way
  to resume or scroll back.
- **No sessions list**: can't see or jump between past conversations.
- **Two hops**: frontend → .NET → Python → Azure is 3 network legs
  before the first token comes back. Every leg adds latency.

Target (hoppr-inspired):
- Frontend → .NET → Azure streaming, SSE to frontend (token-by-token).
- Server-side `ChatSession` + `ChatMessage` tables. Full history
  survives reload / cross-device.
- Sessions list UI. Auto-titled from first user message.
- Token usage still logged into `ChatUsageLog` (existing table).

## Scope line

**In scope (CR1–CR5):**
- Move chat turn from Python to .NET (native Azure streaming).
- Session + message persistence.
- SSE server → SSE client (plain `text/event-stream`; no SignalR).
- Sessions-list UI + resume + rename + delete.
- Typing indicator + token-by-token bubble.
- Auto-title fire-and-forget.

**NOT in scope:**
- Tool-calling inside chat (hoppr has it — we don't need it yet).
- Image uploads in chat (the recipe-photo flow is separate).
- Cross-device SignalR sync of chat state (SSE is per-client; good
  enough for hobby). Could add later.
- Moving `chat/to-recipe` (the structure-conversion call) — stays on
  Python because it reuses the ExtractionResult schema + post-process
  pipeline; a chat turn that happens to produce a recipe uses the
  existing button in the UI to trigger that call separately.

## Existing surface (what we keep / reuse)

- `ChatUsageLog` table + `UsageHeaders.TryRead` — token accounting
  continues to work. The new endpoint writes into it on each turn.
- `AzureOpenAI` env/config — we re-use `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`, and the deployment
  name pieces. Plus a new `AzureOpenAI__ChatDeployment` if the chat
  model differs from the extraction model (it won't at first — reuse
  the existing deployment).
- The Python `POST /chat/{sessionId}/to-recipe` endpoint stays — the
  new frontend calls it directly once the user decides to finalize a
  chat into a recipe; the chat session's `messages[]` is loaded from
  the .NET session and POSTed to the Python endpoint unchanged.
- `ChatEndpoints.cs` (.NET) — the existing `POST /api/chat` handler is
  the code site we rewrite. `POST /api/chat/{sessionId}/to-recipe`
  stays as a proxy to the Python call.

## Schema (CR1)

New EF entities:

```csharp
public sealed class ChatSession
{
    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }            // FK → AspNetUsers
    public string? Title { get; private set; }          // auto-set after first turn
    public int MessageCount { get; private set; }       // denormalised for list UI
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }  // bumps on every message

    public const int TitleMaxLength = 120;
    // mutation methods: Rename, RecordMessageAdded, RecordDeleted (soft?)
}

public sealed class ChatMessage
{
    public Guid Id { get; private set; }
    public Guid SessionId { get; private set; }        // FK → ChatSessions
    public ChatRole Role { get; private set; }          // enum: User, Assistant, System
    public string Content { get; private set; }        // max 32 KB
    public DateTimeOffset CreatedAt { get; private set; }
    public int? PromptTokens { get; private set; }     // on assistant messages only
    public int? CompletionTokens { get; private set; }
    public int? CachedPromptTokens { get; private set; }

    public const int ContentMaxLength = 32 * 1024;
}

public enum ChatRole { User = 0, Assistant = 1, System = 2 }
```

Migration: `AddChatSessions` creates both tables + indexes on
`(UserId, UpdatedAt DESC)` (sessions list) and `(SessionId, CreatedAt)`
(message loading).

No version column — chat is append-only (assistants can't edit user
messages; users don't edit history). Out of OFF3's ETag scope.

## Endpoints (CR2)

New .NET Minimal-API routes in a rewritten `ChatEndpoints.cs`:

| Route | Method | Purpose |
|---|---|---|
| `/api/chat/sessions` | GET | List caller's sessions, newest-first, `limit=20` |
| `/api/chat/sessions` | POST | Create empty session, return `{ sessionId }` |
| `/api/chat/sessions/{id}` | DELETE | Soft-delete (or hard; decide in CR1) |
| `/api/chat/sessions/{id}` | PATCH | Rename (body `{ title: "..." }`) |
| `/api/chat/sessions/{id}/messages` | GET | Load all messages (paginated, default last 200) |
| `/api/chat/sessions/{id}/turn` | POST | **SSE stream**: body `{ content: "Hi" }` — persist user msg → stream assistant → persist assistant msg → flush |
| `/api/chat/sessions/{id}/to-recipe` | POST | Proxy to Python (unchanged) |

### SSE contract for `/turn`

Request:
```
POST /api/chat/sessions/<guid>/turn
Authorization: Bearer <jwt>
Content-Type: application/json
{ "content": "Zeig mir ein Nudelrezept" }
```

Response (streaming):
```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no            (tell Caddy/nginx not to buffer)

event: message-started
data: {"messageId":"<guid>","role":"assistant"}

event: token
data: {"text":"Klar"}

event: token
data: {"text":", "}

event: token
data: {"text":"wie wäre es"}
...

event: usage
data: {"promptTokens":142,"completionTokens":87,"cachedPromptTokens":100}

event: done
data: {"messageId":"<guid>"}
```

On client abort (disconnect mid-stream): server catches
`OperationCanceledException`, persists whatever was streamed so far
(partial assistant message), logs usage if headers arrived. User
reconnects → GETs messages → sees the partial reply.

### Azure streaming client

New `AzureOpenAIChatClient` in `FamilienKochbuch.Infrastructure/Ai/`:

- Plain `HttpClient` (no SDK wrapper — we want control over streaming).
- POST to `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={version}`.
- Body: `{ messages, stream: true, stream_options: { include_usage: true } }`.
- Parse response as SSE: split on `\n\n`, each chunk is `data: {...}`.
- Skip `data: [DONE]` sentinel.
- Yield `chat.completion.chunk` objects via `IAsyncEnumerable<ChatStreamEvent>`.

Keep-alive heartbeat: every 15 s server sends `event: heartbeat` so
intermediate proxies (Caddy) don't close idle streams. Client ignores
this event.

### Auto-title

After the first user message + first assistant reply:
- Fire-and-forget `ChatTitleService.GenerateAsync(sessionId)` on a
  background `IHostedService`-scoped scope (like hoppr).
- One non-streaming Azure call with system prompt "Gib einen knappen
  Titel (max 6 Wörter, Deutsch) für dieses Gespräch" + the user's
  message + assistant's reply.
- `Session.Rename(result)`; SignalR is OUT OF SCOPE so the client
  refetches on demand.

## Frontend (CR3 + CR4)

### Sessions list (CR3)

- New file `apps/web/src/features/chat/ChatSessionsList.tsx`.
- Loads via `useChatSessions()` → GET /api/chat/sessions.
- Mobile: slides-up drawer from the bottom (existing mobile dialog
  primitive).
- Desktop: left-sidebar at `md+` breakpoint.
- Each row: title (or "Neue Unterhaltung" if null) + relative time +
  delete icon.
- "Neuer Chat" button → POST /api/chat/sessions, navigate to
  `/chat/<id>`.
- Route structure changes: `/chat` (list/latest) + `/chat/<sessionId>`
  (specific session). Backward-compat old `/chat` → redirect to most-
  recent session or new-session create.

### Streaming consumer (CR4)

- `sendChatTurn(sessionId, content, onEvent)` in `chatApi.ts`.
- Uses `fetch()` with `body: JSON.stringify(...)` + `method: 'POST'`.
- Reads `response.body.getReader()` + `TextDecoder`.
- Buffers until `\n\n`, parses each SSE block as `{ event, data }`.
- Calls `onEvent({ type, payload })` for each block; UI mutates:
  - `message-started`: append empty assistant bubble, start typing
    indicator.
  - `token`: append `data.text` to assistant bubble's `content`.
  - `usage`: optional debug display.
  - `done`: stop typing indicator, finalise bubble.
  - `heartbeat`: no-op.
- Abort via `AbortController` on unmount / component-replace.
- Error banner with "Erneut senden" on fetch fail or stream error.

### Typing indicator

Three-dot bouncing animation below the current assistant bubble while
the stream is open. Replace today's silent wait.

## Python side (CR5)

- `POST /chat` endpoint in `apps/python-extractor/src/extractor/main.py`
  becomes deprecated/removed. Handler + `ChatRequest` + `ChatResponse`
  + `chat_turn()` in `pipeline/chat.py` all go away.
- `POST /chat/{session_id}/to-recipe` **stays** — wire contract
  unchanged. Frontend calls .NET `/api/chat/sessions/{id}/to-recipe`
  which proxies the Python call, loading the message list from the DB
  and POSTing it as today.
- `chat_turn` tests removed; `chat_to_recipe` tests stay.
- `ChatUsageLog.ChatUsageKind.ChatTurn` enum value stays for usage
  reporting of the .NET chat turns.

## 4-stage flow per slice

| Slice | impl | simplify | security-review | reviewer |
|---|---|---|---|---|
| CR1 | ✓ | — | — | ✓ |
| CR2 | ✓ | ✓ | ✓ (SSE + Azure streaming = security-sensitive) | ✓ |
| CR3 | ✓ | — | — | ✓ |
| CR4 | ✓ | — | — | ✓ |
| CR5 | ✓ | — | — | ✓ |

## Verification gates (every slice)

```bash
cd apps/api && dotnet test --nologo
cd apps/web && pnpm test --run && pnpm lint && pnpm build
cd apps/python-extractor && uv run pytest && uv run ruff check && uv run mypy src
cd packages/shared && pnpm test --run
```

## Tag

After CR5: `v0.8.0`. Push, watch deploy, smoke — manual E2E test
of the chat (new session → first message → stream visible → reload →
resume → second turn → delete).

## Rollout risk

- **Backward-compat break**: old mobile clients caching the non-
  streaming chat endpoint will 404 after CR5. Acceptable — hobby app,
  no external clients.
- **Migration**: no existing chat data to migrate (no DB backing). The
  new tables start empty; old ephemeral sessions die with the deploy.
- **SSE buffering**: Caddy defaults should allow streaming; verify the
  `X-Accel-Buffering: no` response header passes through. If not, the
  existing `Caddyfile` in the repo may need a chat-path-specific
  config.

## Scope deviation policy

Same as Phase 5: anything documented in the commit + progress-tracker
is acceptable if tests pass and security stays neutral-or-positive.

---

End of architecture doc. Implementation starts with CR1.
