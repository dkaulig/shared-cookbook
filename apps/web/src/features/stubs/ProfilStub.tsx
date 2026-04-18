import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mail, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/useAuth'
import { InviteDialog } from '@/features/invites/InviteDialog'

/**
 * Placeholder page behind the `/profil` route until Phase 3 ships the
 * full profile — app-invite creation, password-change, device-list, etc.
 *
 * DS3 preserved the S1 logout affordance here so users still have a
 * one-tap way to sign out after the Home page restyle moved the action
 * off the hero.
 *
 * DS7 upgrades this from a pure stub to a minimally-useful profile
 * surface: the displayName + email from `useAuth()` are surfaced on
 * the page, "Jemanden einladen" opens the existing `InviteDialog`, and
 * the Abmelden button stays as the escape hatch. No new data fetches —
 * the dialog reuses the `/api/invites/app/` POST endpoint that landed
 * in S2 and that the HomePage's "Jemanden einladen" banner already
 * wires up.
 */
export function ProfilStub() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [inviteOpen, setInviteOpen] = useState(false)

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <h1 className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]">
        Mein Profil
      </h1>
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-muted-foreground">
        Angemeldet als{' '}
        <span className="not-italic font-semibold text-foreground">
          {user?.displayName ?? '…'}
        </span>
        .
      </p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Konto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate text-foreground">
              {user?.email ?? '…'}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Passwort-Änderung, Geräte-Verwaltung und App-Einstellungen kommen in Phase 3.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Familie erweitern</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-foreground">
            Hol jemanden in die App. Einladungs-Links sind 14 Tage gültig und einmalig verwendbar.
          </p>
          <Button type="button" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
            Jemanden einladen
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Abmelden</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Melde dich ab, wenn du die App auf einem fremden Gerät benutzt hast.
          </p>
          <Button type="button" variant="outline" onClick={handleLogout}>
            Abmelden
          </Button>
        </CardContent>
      </Card>

      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
    </section>
  )
}
