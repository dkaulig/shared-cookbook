import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/useAuth'

/**
 * Placeholder page behind the `/profil` route until Phase 3 ships the
 * full profile — app-invite creation, password-change, device-list, etc.
 *
 * DS3 preserves the S1 logout affordance here (it used to live on the
 * Home and Groups pages) so users still have a one-tap way to sign out
 * after the Home page restyle moves the action off the hero.
 */
export function ProfilStub() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <h1 className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]">
        Mein Profil
      </h1>
      <p className="mt-2 font-[Libre_Baskerville,serif] text-[15px] italic leading-[1.5] text-muted-foreground">
        Angemeldet als <span className="not-italic font-semibold text-foreground">{user?.displayName ?? '…'}</span>.
      </p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Bald verfügbar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground">
          <p>
            Hier landen App-Einladungen, Passwort-Änderung und Geräteverwaltung.
          </p>
          <p className="text-muted-foreground">
            Aktuell kannst du dich hier abmelden:
          </p>
          <Button type="button" variant="outline" onClick={handleLogout}>
            Abmelden
          </Button>
        </CardContent>
      </Card>
    </section>
  )
}
