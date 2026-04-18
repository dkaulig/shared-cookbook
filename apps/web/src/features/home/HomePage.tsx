import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { GroupSwitcher } from '@/features/groups/GroupSwitcher'
import { ReceivedInvitesBanner } from '@/features/groups/ReceivedInvitesBanner'
import { InviteDialog } from '@/features/invites/InviteDialog'

/**
 * Post-login dashboard. Shows the user's groups banner, received
 * invites, and quick links. Real recipes UI lands in S3.
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
    <main className="mx-auto min-h-dvh max-w-3xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-amber-900">Familien-Kochbuch</h1>
        <div className="flex gap-2">
          <Button onClick={() => setShowInvite(true)}>Jemanden einladen</Button>
          <Button variant="outline" onClick={handleLogout}>Abmelden</Button>
        </div>
      </header>

      <p className="mb-4 text-stone-700">
        Angemeldet als <strong>{user?.displayName ?? '...'}</strong>.
      </p>

      <ReceivedInvitesBanner />

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900">Meine Gruppen</h2>
          <Link to="/groups" className="text-sm text-stone-600 underline">
            Alle anzeigen
          </Link>
        </div>
        <GroupSwitcher />
      </section>

      {showInvite && <InviteDialog onClose={() => setShowInvite(false)} />}
    </main>
  )
}
