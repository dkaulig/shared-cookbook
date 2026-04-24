import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { InlineFieldError } from '@/features/_shared/inlineFieldError'

/**
 * /reset-password?token=... — completes the password-reset flow with
 * the composite token the API's password-reset-request email delivers.
 *
 * DS2 restyle: Sage Modern hero + card, two password fields, Speichern
 * CTA. On success we show a Bestätigungs-Hinweis and auto-redirect to
 * /login after ~1.2 s.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
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
      setError(
        t('auth.reset.errors.tokenMissing', {
          defaultValue: 'Kein gültiger Reset-Link.',
        }),
      )
      return
    }
    if (password.length < 8) {
      setError(
        t('auth.reset.errors.passwordTooShort', {
          defaultValue: 'Passwort muss mindestens 8 Zeichen lang sein.',
        }),
      )
      return
    }
    if (password !== confirm) {
      setError(
        t('auth.reset.errors.passwordsMismatch', {
          defaultValue: 'Passwörter stimmen nicht überein.',
        }),
      )
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
        // REL-5f — route the ApiError body through the shared classifier
        // so the rendered copy comes from `errors:<code>` (German). The
        // backend tags `fieldName=resetToken` on invalid-token / reset-
        // failed cases, but the reset-token lives in the URL — no form
        // input to focus, so we render the banner either way. The
        // classifier still picks the right i18n key by code.
        const apiErr = await safeJson<ApiError>(response)
        const classified = classifyMutationError(
          apiErr ?? { code: 'unknown', message: '', status: response.status },
        )
        setError(classified.message)
        return
      }
      setSubmitted(true)
      setTimeout(() => navigate('/login', { replace: true }), 1200)
    } catch {
      setError(
        t('auth.reset.errors.failedRetry', {
          defaultValue: 'Reset fehlgeschlagen. Bitte später erneut versuchen.',
        }),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto mt-10 flex w-full max-w-[440px] flex-col md:mt-16">
      <section className="mb-8 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          {t('auth.reset.kicker', { defaultValue: 'Fast fertig' })}
        </span>
        <h1 className="font-serif text-[clamp(34px,8vw,46px)] font-semibold leading-none tracking-[-0.015em]">
          {t('auth.reset.heroHeadline', {
            defaultValue: 'Neues Passwort wählen',
          })}
        </h1>
        <p className="mt-4 font-serif-body text-[17px] italic leading-[1.5] text-muted-foreground">
          {t('auth.reset.heroTagline', {
            defaultValue:
              'Mindestens acht Zeichen — damit Omas Schnitzel-Rezept nur in Familien-Hände fällt.',
          })}
        </p>
      </section>

      <Card className="rounded-[20px] shadow-[0_10px_30px_-12px_rgba(146,64,14,0.18),0_2px_6px_-2px_rgba(28,25,23,0.06)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[26px]">
            {t('auth.reset.cardTitle', { defaultValue: 'Neues Passwort wählen' })}
          </CardTitle>
          <CardDescription>
            {t('auth.reset.cardDescription', {
              defaultValue:
                "Setz ein frisches Passwort und speichere — danach geht's zurück zur Anmeldung.",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              {t('auth.reset.successNotice', {
                defaultValue:
                  'Passwort geändert. Du wirst gleich zur Anmeldung weitergeleitet …',
              })}
            </p>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="password">
                  {t('auth.newPassword', { defaultValue: 'Neues Passwort' })}
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder={t('auth.passwordMinPlaceholder', {
                    defaultValue: 'Mindestens 8 Zeichen',
                  })}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">
                  {t('auth.passwordConfirm', {
                    defaultValue: 'Passwort bestätigen',
                  })}
                </Label>
                <Input
                  id="confirm"
                  type="password"
                  placeholder={t('auth.passwordConfirmPlaceholder', {
                    defaultValue: 'Nochmal zur Sicherheit',
                  })}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>

              {error && (
                <InlineFieldError
                  id="reset-password-banner"
                  message={error}
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
                />
              )}

              <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
                {t('auth.reset.submitCta', { defaultValue: 'Speichern' })}
              </Button>
            </form>
          )}

          <div className="my-6 flex items-center gap-3 text-[12px] uppercase tracking-[0.06em] text-[hsl(24_5%_47%)]">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            {t('auth.or', { defaultValue: 'oder' })}
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>

          <p className="text-center text-sm leading-[1.5] text-muted-foreground">
            <Link to="/login" className="font-semibold text-primary hover:underline">
              {t('auth.reset.backToLoginCta', {
                defaultValue: '← Zurück zur Anmeldung',
              })}
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
