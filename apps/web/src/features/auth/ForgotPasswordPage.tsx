import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
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
import { isValidEmail } from './validation'

/**
 * /forgot-password — single-field variant in the Sage Modern visual
 * grammar. The success copy is intentionally the same regardless of
 * whether the email is registered (no user enumeration). The endpoint
 * always returns 204.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (!isValidEmail(email.trim())) {
      setError('Bitte gib eine gültige E-Mail-Adresse ein.')
      return
    }

    setSubmitting(true)
    try {
      await fetch('/api/auth/password-reset-request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      setSubmitted(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto mt-10 flex w-full max-w-[440px] flex-col md:mt-16">
      <section className="mb-8 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Alles halb so wild
        </span>
        <h1 className="font-serif text-[clamp(34px,8vw,46px)] font-semibold leading-none tracking-[-0.015em]">
          Passwort zurücksetzen
        </h1>
        <p className="mt-4 font-serif-body text-[17px] italic leading-[1.5] text-muted-foreground">
          Passiert den Besten. Gib deine E-Mail ein und du bekommst
          gleich einen Link.
        </p>
      </section>

      <Card className="rounded-[20px] shadow-[0_10px_30px_-12px_rgba(146,64,14,0.18),0_2px_6px_-2px_rgba(28,25,23,0.06)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[26px]">Passwort zurücksetzen</CardTitle>
          <CardDescription>Wir senden dir eine E-Mail mit Link.</CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              Wenn diese E-Mail existiert, haben wir einen Link geschickt. Schau
              in dein Postfach.
            </p>
          ) : (
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

              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
                >
                  {error}
                </p>
              )}

              <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
                Link anfordern
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
