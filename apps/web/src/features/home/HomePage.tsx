import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { InviteDialog } from '@/features/invites/InviteDialog'

/**
 * Placeholder post-login home. Will be replaced by the real groups +
 * recipes UI from S2 onwards — keeps just enough UX for S1 acceptance
 * ('user's display name, Jemanden einladen button, logout').
 */
export function HomePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [showInvite, setShowInvite] = useState(false)

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-amber-900 sm:text-5xl">
        Familien-Kochbuch
      </h1>
      <p className="text-base text-stone-700">
        Angemeldet als <strong>{user?.displayName ?? '...'}</strong>.
      </p>
      <div className="flex gap-3">
        <Button onClick={() => setShowInvite(true)}>Jemanden einladen</Button>
        <Button variant="outline" onClick={handleLogout}>Abmelden</Button>
      </div>

      {showInvite && <InviteDialog onClose={() => setShowInvite(false)} />}
    </main>
  )
}
