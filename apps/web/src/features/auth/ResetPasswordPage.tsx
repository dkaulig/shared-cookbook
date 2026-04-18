import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * /reset-password?token=... — completes the password-reset flow with
 * the composite token the API's password-reset-request email delivers.
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-stone-900">Neues Passwort</h1>

      {submitted ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
          Passwort geändert. Du wirst gleich zur Anmeldung weitergeleitet …
        </p>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password">Neues Passwort</Label>
            <Input
              id="password"
              type="password"
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
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={submitting}>
            Passwort setzen
          </Button>
        </form>
      )}
    </main>
  )
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}
