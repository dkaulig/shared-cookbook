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

/**
 * /reset-password?token=... — completes the password-reset flow with
 * the composite token the API's password-reset-request email delivers.
 *
 * DS2 restyle: Warme-Küche hero + card, two password fields, Speichern
 * CTA. On success we show a Bestätigungs-Hinweis and auto-redirect to
 * /login after ~1.2 s.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!token) {
      setError('Kein gültiger Reset-Link.')
      return
    }
    if (password.length < 8) {
      setError('Passwort muss mindestens 8 Zeichen lang sein.')
      return
    }
    if (password !== confirm) {
      setError('Passwörter stimmen nicht überein.')
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch('/api/auth/password-reset', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      })
      if (!response.ok) {
        const apiErr = (await safeJson<ApiError>(response)) ?? { code: 'unknown', message: 'Reset fehlgeschlagen.' }
        setError(apiErr.message)
        return
      }
      setSubmitted(true)
      setTimeout(() => navigate('/login', { replace: true }), 1200)
    } catch {
      setError('Reset fehlgeschlagen. Bitte später erneut versuchen.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto mt-10 flex w-full max-w-[440px] flex-col md:mt-16">
      <section className="mb-8 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Fast fertig
        </span>
        <h1 className="font-serif text-[clamp(34px,8vw,46px)] font-semibold leading-none tracking-[-0.015em]">
          Neues Passwort wählen
        </h1>
        <p className="mt-4 font-serif-body text-[17px] italic leading-[1.5] text-muted-foreground">
          Mindestens acht Zeichen — damit Omas Schnitzel-Rezept nur in
          Familien-Hände fällt.
        </p>
      </section>

      <Card className="rounded-[20px] shadow-[0_10px_30px_-12px_rgba(146,64,14,0.18),0_2px_6px_-2px_rgba(28,25,23,0.06)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[26px]">Neues Passwort wählen</CardTitle>
          <CardDescription>
            Setz ein frisches Passwort und speichere — danach geht's zurück
            zur Anmeldung.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              Passwort geändert. Du wirst gleich zur Anmeldung weitergeleitet …
            </p>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="password">Neues Passwort</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Mindestens 8 Zeichen"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">Passwort bestätigen</Label>
                <Input
                  id="confirm"
                  type="password"
                  placeholder="Nochmal zur Sicherheit"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
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

              <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
                Speichern
              </Button>
            </form>
          )}

          <div className="my-6 flex items-center gap-3 text-[12px] uppercase tracking-[0.06em] text-[hsl(24_5%_47%)]">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            oder
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>

          <p className="text-center text-sm leading-[1.5] text-muted-foreground">
            <Link to="/login" className="font-semibold text-primary hover:underline">
              ← Zurück zur Anmeldung
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
