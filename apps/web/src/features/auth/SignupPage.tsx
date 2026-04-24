import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
import { classifyMutationError } from '@/features/_shared/errorSurface'

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; preview: InvitePreview }
  | { status: 'error'; message: string }

// REL-5f — backend-emitted `fieldName` → frontend input-id mapping.
// Backend (AuthEndpoints.cs) tags 400 bodies with one of these three
// names; only the ones with a matching DOM input get focus-routed. The
// `inviteToken` case intentionally maps to no input (the value lives in
// the URL query-string) and falls through to the banner.
const FIELD_TO_INPUT_ID: Record<string, string> = {
  email: 'email',
  // Wire-shape vocabulary is shared with ChangePassword / PasswordReset
  // (the canonical "newPassword" name); the signup form's input id is
  // the shorter "password" — this map makes the translation explicit.
  newPassword: 'password',
}

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
  const { t } = useTranslation()

  const token = params.get('token') ?? ''

  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' })
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // BF1 #7 — second password field; must match `password` before submit.
  // Mirrors the pattern already used by ResetPasswordPage so the user
  // sees the same double-entry shape during invite-flow signup.
  const [confirm, setConfirm] = useState('')
  // REL-5f — inline field-error state. `fieldName` is the backend map-
  // key (never rendered as visible copy); null for errors the classifier
  // did not attribute to a specific input — those still render as a
  // banner but don't move focus.
  const [fieldError, setFieldError] = useState<
    { fieldName: string | null; message: string } | null
  >(null)
  const [submitting, setSubmitting] = useState(false)

  // REL-5f — ref-map keyed by the backend `fieldName` (see
  // FIELD_TO_INPUT_ID above for the wire-vs-DOM-id translation).
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!token) {
        if (!cancelled)
          setPreview({
            status: 'error',
            message: t('auth.signup.errors.inviteMissing', {
              defaultValue: 'Einladungslink ist ungültig oder fehlt.',
            }),
          })
        return
      }
      try {
        const response = await fetch(`/api/invites/app/${encodeURIComponent(token)}`)
        if (cancelled) return
        if (!response.ok) {
          setPreview({
            status: 'error',
            message: t('auth.signup.errors.inviteNotFound', {
              defaultValue: 'Einladung wurde nicht gefunden.',
            }),
          })
          return
        }
        const body = (await response.json()) as InvitePreview
        if (!body.valid) {
          setPreview({
            status: 'error',
            message: t('auth.signup.errors.inviteExpired', {
              defaultValue: 'Einladung ist abgelaufen oder bereits verwendet.',
            }),
          })
          return
        }
        setPreview({ status: 'ok', preview: body })
      } catch {
        if (!cancelled)
          setPreview({
            status: 'error',
            message: t('auth.signup.errors.invitePreviewFailed', {
              defaultValue: 'Einladung konnte nicht geladen werden.',
            }),
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, t])

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFieldError(null)

    if (!displayName.trim()) {
      setFieldError({
        fieldName: null,
        message: t('auth.signup.errors.displayNameRequired', {
          defaultValue: 'Bitte gib einen Anzeigenamen ein.',
        }),
      })
      return
    }
    if (!isValidEmail(email.trim())) {
      setFieldError({
        fieldName: null,
        message: t('auth.signup.errors.emailInvalid', {
          defaultValue: 'Bitte gib eine gültige E-Mail-Adresse ein.',
        }),
      })
      return
    }
    if (password.length < 8) {
      setFieldError({
        fieldName: null,
        message: t('auth.signup.errors.passwordTooShort', {
          defaultValue: 'Passwort muss mindestens 8 Zeichen lang sein.',
        }),
      })
      return
    }
    if (password !== confirm) {
      setFieldError({
        fieldName: null,
        message: t('auth.signup.errors.passwordsMismatch', {
          defaultValue: 'Passwörter stimmen nicht überein.',
        }),
      })
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
        // REL-5f — route the ApiError body through the shared classifier
        // so the rendered copy comes from `errors:<code>` (German) and
        // `fieldName` can drive focus. If the body can't be parsed,
        // `classified.message` falls back to the generic "actionFailed"
        // copy so we still show *something*.
        const apiErr = await safeJson<ApiError>(response)
        const classified = classifyMutationError(
          apiErr ?? { code: 'unknown', message: '', status: response.status },
        )
        setFieldError({
          fieldName: classified.fieldName ?? null,
          message: classified.message,
        })
        // Only move focus when the backend-tagged field maps to a DOM
        // input we actually render. `inviteToken` lives in the URL —
        // nothing to focus there, fall through to banner.
        const inputId = classified.fieldName
          ? FIELD_TO_INPUT_ID[classified.fieldName]
          : undefined
        if (inputId) {
          fieldRefs.current[inputId]?.focus()
        }
        return
      }
      const body = (await response.json()) as AuthResponse
      setSession(body.accessToken, body.user)
      navigate('/', { replace: true })
    } catch {
      setFieldError({
        fieldName: null,
        message: t('auth.signup.errors.failedRetry', {
          defaultValue:
            'Registrierung fehlgeschlagen. Bitte später erneut versuchen.',
        }),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const inviterName = preview.status === 'ok' ? preview.preview.inviterDisplayName ?? 'Jemand' : null

  // REL-5f — which input (if any) owns the current inline error. Drives
  // aria-invalid + aria-describedby wiring below.
  const focusedInputId = fieldError?.fieldName
    ? FIELD_TO_INPUT_ID[fieldError.fieldName]
    : undefined

  return (
    <div className="mx-auto mt-10 flex w-full max-w-[440px] flex-col md:mt-16">
      <section className="mb-8 text-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          {inviterName
            ? t('auth.signup.kickerInviterTemplate', {
                name: inviterName,
                defaultValue: `${inviterName} lädt dich ein`,
              })
            : t('auth.signup.kickerDefault', {
                defaultValue: 'Einladung prüfen',
              })}
        </span>
        <h1 className="font-serif text-[clamp(38px,9vw,52px)] font-semibold leading-none tracking-[-0.015em]">
          {t('auth.signup.heroHeadline', {
            defaultValue: 'Willkommen in der Familie',
          })}
        </h1>
        <p className="mt-4 font-serif-body text-[17px] italic leading-[1.5] text-muted-foreground">
          {inviterName
            ? t('auth.signup.heroTaglineInviter', {
                name: inviterName,
                defaultValue: `${inviterName} lädt dich zum Familien-Kochbuch ein.`,
              })
            : t('auth.signup.heroTaglineDefault', {
                defaultValue:
                  'Mit deinem Einladungs-Link bist du gleich dabei.',
              })}
          <br />
          {t('auth.signup.heroTaglineSecond', {
            defaultValue: 'Leg ein Konto an und koch mit.',
          })}
        </p>
      </section>

      <Card className="rounded-[20px] shadow-[0_10px_30px_-12px_rgba(146,64,14,0.18),0_2px_6px_-2px_rgba(28,25,23,0.06)]">
        <CardHeader className="pb-4">
          <CardTitle className="text-[26px]">
            {t('auth.signup.cardTitle', { defaultValue: 'Registrieren' })}
          </CardTitle>
          <CardDescription>
            {t('auth.signup.cardDescription', {
              defaultValue:
                'Dein Anzeigename erscheint bei deinen Rezepten und Bewertungen in der Gruppe.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {preview.status === 'loading' && (
            <p className="mb-4 text-sm text-muted-foreground">
              {t('auth.signup.previewLoading', {
                defaultValue: 'Einladung wird geprüft …',
              })}
            </p>
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
              <Label htmlFor="displayName">
                {t('auth.displayName', { defaultValue: 'Anzeigename' })}
              </Label>
              <Input
                id="displayName"
                autoComplete="nickname"
                placeholder={t('auth.displayNamePlaceholder', {
                  defaultValue: 'z.B. Oma Erna',
                })}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={preview.status !== 'ok'}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">
                {t('auth.emailLabel', { defaultValue: 'E-Mail-Adresse' })}
              </Label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                placeholder={t('auth.emailPlaceholder', {
                  defaultValue: 'du@familie.de',
                })}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={preview.status !== 'ok'}
                ref={(el) => {
                  fieldRefs.current.email = el
                }}
                aria-invalid={focusedInputId === 'email' || undefined}
                aria-describedby={
                  focusedInputId === 'email' ? 'email-error' : undefined
                }
              />
              {focusedInputId === 'email' && fieldError && (
                <p
                  id="email-error"
                  role="alert"
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
                >
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">
                {t('auth.password', { defaultValue: 'Passwort' })}
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
                disabled={preview.status !== 'ok'}
                ref={(el) => {
                  fieldRefs.current.password = el
                }}
                aria-invalid={focusedInputId === 'password' || undefined}
                aria-describedby={
                  focusedInputId === 'password' ? 'password-error' : undefined
                }
              />
              {focusedInputId === 'password' && fieldError && (
                <p
                  id="password-error"
                  role="alert"
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
                >
                  {fieldError.message}
                </p>
              )}
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
                disabled={preview.status !== 'ok'}
              />
            </div>

            {fieldError && !focusedInputId && (
              // Fallback banner — error without a DOM-mapped fieldName
              // (inviteToken lives in the URL; or the classifier had
              // nothing to attribute). Keeps the surface behaviour
              // identical to pre-REL-5f for these cases.
              <p
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
              >
                {fieldError.message}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-2 w-full"
              disabled={submitting || preview.status !== 'ok'}
            >
              {t('auth.signup.submitCta', { defaultValue: 'Registrieren' })}
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3 text-[12px] uppercase tracking-[0.06em] text-[hsl(24_5%_47%)]">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            {t('auth.or', { defaultValue: 'oder' })}
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>

          <p className="text-center text-sm leading-[1.5] text-muted-foreground">
            {t('auth.signup.alreadyAccount', {
              defaultValue: 'Du hast bereits ein Konto?',
            })}
            <br />
            <Link to="/login" className="font-semibold text-primary hover:underline">
              {t('auth.signup.loginCta', { defaultValue: 'Anmelden →' })}
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
