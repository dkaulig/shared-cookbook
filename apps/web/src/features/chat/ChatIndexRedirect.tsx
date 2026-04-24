import { useEffect, useRef } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toastMutationError } from '@/features/_shared/errorSurface'
import {
  useChatSessions,
  useCreateChatSession,
} from './useChatSessions'

/**
 * CR3 — `/chat` redirect gate.
 *
 * Decides where the bare `/chat` URL lands the user:
 *   1. If the caller has at least one session, bounce to the newest
 *      (sessions come back newest-first from the server).
 *   2. If they have none, create one and bounce to `/chat/<new>`.
 *
 * We use `<Navigate>` for the happy path (most-recent session) because
 * it's declarative — no flicker, no state transitions. The
 * "zero sessions" branch must run a mutation, so it uses a
 * `useEffect`-driven `navigate()` call after the POST resolves.
 */
export function ChatIndexRedirect() {
  const { t } = useTranslation()
  const sessionsQuery = useChatSessions()
  const createMutation = useCreateChatSession()
  const navigate = useNavigate()
  const didMint = useRef(false)

  const sessions = sessionsQuery.data
  const hasNoSessions = sessions !== undefined && sessions.length === 0

  useEffect(() => {
    if (!hasNoSessions) return
    if (didMint.current) return
    didMint.current = true
    createMutation
      .mutateAsync()
      .then((res) => {
        navigate(`/chat/${res.sessionId}`, { replace: true })
      })
      .catch((err) => {
        // Let the user retry via the sidebar "Neu" button. Resetting
        // the mint-guard so a transient 500 doesn't permanently block
        // the fallback mint.
        didMint.current = false
        // REL-5 — surface the failure so the user understands why the
        // page is stuck on the spinner. Previously this path swallowed
        // the error and left a permanent zero-sessions shell.
        toastMutationError(err)
      })
  }, [hasNoSessions, createMutation, navigate])

  if (sessionsQuery.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2
          className="h-6 w-6 animate-spin text-[hsl(var(--muted-foreground))]"
          aria-hidden="true"
        />
        <span className="sr-only">{t('chat.sessions.indexLoadingSr')}</span>
      </div>
    )
  }

  if (sessions && sessions.length > 0) {
    return <Navigate to={`/chat/${sessions[0]!.id}`} replace />
  }

  // Zero-sessions mint path — the effect above handles navigation
  // once the POST resolves. Render a small spinner in the meantime.
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <Loader2
        className="h-6 w-6 animate-spin text-[hsl(var(--muted-foreground))]"
        aria-hidden="true"
      />
      <span className="sr-only">{t('chat.sessions.indexMintingSr')}</span>
    </div>
  )
}
