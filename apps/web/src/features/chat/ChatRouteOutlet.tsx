import { Outlet, useParams } from 'react-router-dom'
import { AiDisabledNotice } from '@/features/_shared/AiDisabledNotice'
import { useFeatures } from '@/features/_shared/useFeatures'
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
 *
 * REL-7 — the whole `/chat/*` subtree is an AI feature. When the
 * operator disabled AI we short-circuit to an
 * {@link AiDisabledNotice} before mounting the shell / SessionsList so
 * no chat-history fetch runs on an instance that has no chat surface.
 */
export function ChatRouteOutlet() {
  const { sessionId } = useParams()
  const features = useFeatures()
  if (!features.ai.features.chat) {
    return (
      <AiDisabledNotice
        title="Rezept-Chat benötigt KI"
        description="Diese Instanz läuft ohne KI-Anbieter. Rezepte im Chat zu erfinden braucht ein Sprachmodell im Hintergrund."
      />
    )
  }
  return (
    <ChatSessionsShell activeSessionId={sessionId}>
      <Outlet />
    </ChatSessionsShell>
  )
}
