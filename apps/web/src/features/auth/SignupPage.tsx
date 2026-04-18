import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError, AuthResponse, InvitePreview } from '@familien-kochbuch/shared'
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
import { useAuthStore } from './authStore'
import { isValidEmail } from './validation'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; preview: InvitePreview }
  | { status: 'error'; message: string }

/**
 * /signup?token=... — form backed by a valid AppInvite. Fetches the
 * preview so the recipient sees who invited them before they register.
 *
 * DS2 restyle: matches the Sage Modern visual grammar from `LoginPage`.
 * The kicker pill shows the inviter's display name ("{Name} lädt dich
 * zum Familien-Kochbuch ein"). Form fields: Anzeigename, E-Mail,
 * Passwort. Disabled until the preview is `ok`.
 */
export function SignupPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const setSession = useAuthStore((s) => s.setSession)

  const token = params.get('token') ?? ''

  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' })
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!token) {
        if (!cancelled) setPreview({ status: 'error', message: 'Einladungslink ist ungültig oder fehlt.' })
        return
      }
      try {
        const response = await fetch(`/api/invites/app/${encodeURIComponent(token)}`)
        if (cancelled) return
        if (!response.ok) {
          setPreview({ status: 'error', message: 'Einladung wurde nicht gefunden.' })
          return
        }
        const body = (await response.json()) as InvitePreview
        if (!body.valid) {
          setPreview({ status: 'error', message: 'Einladung ist abgelaufen oder bereits verwendet.' })
          return
        }
        setPreview({ status: 'ok', preview: body })
      } catch {
        if (!cancelled) setPreview({ status: 'error', message: 'Einladung konnte nicht geladen werden.' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!displayName.trim()) {
      setError('Bitte gib einen Anzeigenamen ein.')
      return
    }
    if (!isValidEmail(email.trim())) {
      setError('Bitte gib eine gültige E-Mail-Adresse ein.')
      return
    }
    if (password.length < 8) {
      setError('Passwort muss mindestens 8 Zeichen lang sein.')
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch(`/api/auth/signup?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, displayName: displayName.trim() }),
      })
      if (!response.ok) {
        const apiErr = (await safeJson<ApiError>(response)) ?? { code: 'unknown', message: 'Registrierung fehlgeschlagen.' }
        setError(apiErr.message)
        return
      }
      const body = (await response.json()) as AuthResponse
      setSession(body.accessToken, body.user)
      navigate('/', { replace: true })
    } catch {
      setError('Registrierung fehlgeschlagen. Bitte später erneut versuchen.')
    } finally {
      setSubmitting(false)
    }
  }

  const inviterName = preview.status === 'ok' ? preview.preview.inviterDisplayName ?? 'Jemand' : null

  return (
    <div className="mx-auto mt-10 flex w-full max-w-[440px] flex-col md:mt-16">
      <section className="mb-8 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          {inviterName ? `${inviterName} lädt dich ein` : 'Einladung prüfen'}
        </span>
        <h1 className="font-serif text-[clamp(38px,9vw,52px)] font-semibold leading-none tracking-[-0.015em]">
          Willkommen in der Familie
        </h1>
        <p className="mt-4 font-serif-body text-[17px] italic leading-[1.5] text-muted-foreground">
          {inviterName
            ? `${inviterName} lädt dich zum Familien-Kochbuch ein.`
            : 'Mit deinem Einladungs-Link bist du gleich dabei.'}
          <br />
          Leg ein Konto an und koch mit.
        </p>
      </section>

      <Card className="rounded-[20px] shadow-[0_10px_30px_-12px_rgba(146,64,14,0.18),0_2px_6px_-2px_rgba(28,25,23,0.06)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[26px]">Registrieren</CardTitle>
          <CardDescription>
            Dein Anzeigename erscheint bei deinen Rezepten und Bewertungen in
            der Gruppe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preview.status === 'loading' && (
            <p className="mb-4 text-sm text-muted-foreground">Einladung wird geprüft …</p>
          )}

          {preview.status === 'error' && (
            <p
              role="alert"
              className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              {preview.message}
            </p>
          )}

          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="displayName">Anzeigename</Label>
              <Input
                id="displayName"
                autoComplete="nickname"
                placeholder="z.B. Oma Erna"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={preview.status !== 'ok'}
              />
            </div>

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
                disabled={preview.status !== 'ok'}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Passwort</Label>
              <Input
                id="password"
                type="password"
                placeholder="Mindestens 8 Zeichen"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={preview.status !== 'ok'}
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-2 w-full"
              disabled={submitting || preview.status !== 'ok'}
            >
              Registrieren
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3 text-[12px] uppercase tracking-[0.06em] text-[hsl(24_5%_47%)]">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            oder
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>

          <p className="text-center text-sm leading-[1.5] text-muted-foreground">
            Du hast bereits ein Konto?
            <br />
            <Link to="/login" className="font-semibold text-primary hover:underline">
              Anmelden →
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}
