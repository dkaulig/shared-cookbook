import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError, AuthResponse, InvitePreview } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
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
    if (!token) {
      setPreview({ status: 'error', message: 'Einladungslink ist ungültig oder fehlt.' })
      return
    }
    let cancelled = false
    void (async () => {
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-stone-900">Registrieren</h1>

      {preview.status === 'loading' && (
        <p className="mb-4 text-sm text-stone-600">Einladung wird geprüft …</p>
      )}

      {preview.status === 'error' && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {preview.message}
        </p>
      )}

      {preview.status === 'ok' && (
        <p className="mb-4 text-sm text-stone-700">
          Einladung von <strong>{preview.preview.inviterDisplayName ?? 'jemandem'}</strong>.
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="displayName">Anzeigename</Label>
          <Input
            id="displayName"
            autoComplete="nickname"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={preview.status !== 'ok'}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">E-Mail</Label>
          <Input
            id="email"
            type="email"
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={preview.status !== 'ok'}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting || preview.status !== 'ok'}>
          Registrieren
        </Button>
      </form>
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
