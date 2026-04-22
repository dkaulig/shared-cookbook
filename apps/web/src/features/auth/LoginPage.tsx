import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from './useAuth'
import { isValidEmail } from './validation'

/**
 * /login — email + password form. Server-side rate-limited to 5/min/IP.
 *
 * DS2 restyle: matches `docs/mockups/warme-kueche-login.html` —
 *   1. Hero block: amber kicker pill, serif headline, italic Baskerville
 *      tagline.
 *   2. Surface card with German copy, 16 px inputs, remember-me +
 *      forgot-password row, primary "Anmelden" button, "oder" divider,
 *      invite footer linking to /signup.
 *
 * Behaviour preserved: validation rules, auth-store wiring, post-login
 * redirect.
 */
/**
 * SHARE-0b — same-origin allowlist for the post-login `?next=` redirect.
 *
 * The `next` param is attacker-controlled (anyone who can craft a
 * `/login?next=…` link — share-sheet payload, phishing email — can
 * steer post-login navigation). Gate it to a relative same-origin path
 * so a malicious value can't turn the login flow into an open redirect:
 *
 *   ✓ `/share-target?url=…` — starts with a single `/`, no scheme.
 *   ✗ `//evil.com/steal`   — protocol-relative, the browser resolves
 *                            it against the current scheme and jumps
 *                            to an external origin.
 *   ✗ `https://evil.com`   — explicit cross-origin.
 *   ✗ `javascript:alert(1)` — scheme payload; no URL parser needed to
 *                            spot this — any non-`/` first char fails.
 *
 * A value that fails the allowlist falls back to `'/'` so the user
 * still lands somewhere sensible.
 */
export function safeNextPath(raw: string | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/')) return '/'
  // Protocol-relative `//host/path` — URL#pathname would keep the `//`
  // and React Router would treat it as a relative nav, but the browser
  // address bar interprets `//evil.com` as a new origin on navigation.
  if (raw.startsWith('//')) return '/'
  return raw
}

export function LoginPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [searchParams] = useSearchParams()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!email.trim()) {
      setError('Bitte gib deine E-Mail-Adresse ein.')
      return
    }
    if (!isValidEmail(email.trim())) {
      setError('Bitte gib eine gültige E-Mail-Adresse ein.')
      return
    }
    if (!password) {
      setError('Bitte gib dein Passwort ein.')
      return
    }

    setSubmitting(true)
    try {
      await login(email.trim(), password)
      navigate(safeNextPath(searchParams.get('next')), { replace: true })
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Anmeldung fehlgeschlagen.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto mt-10 flex w-full max-w-[440px] flex-col md:mt-16">
      <section className="mb-8 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Willkommen zurück
        </span>
        <h1 className="font-serif text-[clamp(38px,9vw,52px)] font-semibold leading-none tracking-[-0.015em]">
          Was kochen wir heute?
        </h1>
        <p className="mt-4 font-serif-body text-[17px] italic leading-[1.5] text-muted-foreground">
          Rezepte aus der Familie. Videos vom Handy. Omas Schnitzel.
          <br />
          Alles an einem Ort.
        </p>
      </section>

      <Card className="rounded-[20px] shadow-[0_10px_30px_-12px_rgba(146,64,14,0.18),0_2px_6px_-2px_rgba(28,25,23,0.06)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[26px]">Anmelden</CardTitle>
          <CardDescription>
            Schön, dass du wieder da bist. Mit deiner E-Mail und deinem Passwort
            geht's los.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-Mail-Adresse</Label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                placeholder="du@familie.de"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Passwort</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between gap-3 text-[13px]">
              <label className="inline-flex cursor-pointer items-center gap-2 text-muted-foreground select-none">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-primary"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                30 Tage angemeldet bleiben
              </label>
              <Link to="/forgot-password" className="font-medium text-primary hover:underline">
                Passwort vergessen?
              </Link>
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
              >
                {error}
              </p>
            )}

            <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
              Anmelden
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3 text-[12px] uppercase tracking-[0.06em] text-[hsl(24_5%_47%)]">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            oder
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>

          <p className="text-center text-sm leading-[1.5] text-muted-foreground">
            Du hast einen Einladungs-Link bekommen?
            <br />
            <Link to="/signup" className="font-semibold text-primary hover:underline">
              Jetzt registrieren →
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
