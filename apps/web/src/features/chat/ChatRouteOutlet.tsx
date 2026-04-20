import { Outlet, useParams } from 'react-router-dom'
import { ChatSessionsShell } from './ChatSessionsShell'

/**
 * CR3 — layout element for the `/chat` route family.
 *
 * Wraps both the `/chat` index redirect and the `/chat/:sessionId`
 * page in a single {@link ChatSessionsShell}. Reading the sessionId
 * from `useParams()` here means the shell can pass it straight into
 * the sessions-list for the active-row highlight.
 *
 * Mounting the shell at route level (instead of inside ChatPage) keeps
 * TanStack Query's sessions-list cache mounted across the short
 * redirect tick `/chat` → `/chat/<newest>`, so the redirect itself
 * doesn't discard and refetch the list.
 */
export function ChatRouteOutlet() {
  const { sessionId } = useParams()
  return (
    <ChatSessionsShell activeSessionId={sessionId}>
      <Outlet />
    </ChatSessionsShell>
  )
}
