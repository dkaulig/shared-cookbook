import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isValidEmail } from './validation'

/**
 * /forgot-password — always shows the same success message regardless
 * of whether the server knows the email, so we never leak user
 * enumeration. The endpoint returns 204 in both cases.
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-stone-900">Passwort vergessen</h1>

      {submitted ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
          Falls die E-Mail-Adresse registriert ist, haben wir einen Reset-Link verschickt.
          Bitte prüfe dein Postfach.
        </p>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">E-Mail</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={submitting}>
            Reset-Link anfordern
          </Button>
        </form>
      )}
    </main>
  )
}
