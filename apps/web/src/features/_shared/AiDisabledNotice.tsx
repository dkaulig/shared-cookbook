import { Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/**
 * REL-7 — full-page notice rendered in place of an AI-only surface
 * (ImportPhotosPage, ChatPage) when the operator disabled AI. Also
 * used by the URL-import page as an in-page banner above the raw-text
 * fallback form.
 *
 * REL-3 (i18n): call-sites pass pre-resolved `title` + `description`
 * (so they can pick page-specific copy from `ai.offNotice.*`). The
 * admin-hint + back-CTA are translated here via a <Trans> so the
 * inline <code> styling stays without embedding raw HTML in the JSON.
 */
export function AiDisabledNotice({
  title,
  description,
  backHref = '/',
}: {
  title: string
  description: string
  backHref?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="mx-auto w-full max-w-[720px] px-5 pt-10 md:max-w-[1120px] md:px-8">
      <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 p-8 text-center">
        <Sparkles
          className="mx-auto h-8 w-8 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="mt-3 font-serif text-2xl font-semibold tracking-[-0.005em]">
          {title}
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{description}</p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          {/* Trans maps the placeholder tags to React elements — the
              locale-writer only decides the surrounding copy and the
              tag order. Security: the <code> elements have no
              `children` here; Trans wires the text content from the
              locale string into them, which is plain text — no HTML
              injection surface. */}
          <Trans
            i18nKey="ai.offNotice.adminHintTemplate"
            components={{
              aiFlag: (
                <code className="rounded bg-muted px-1 py-0.5 text-xs" />
              ),
              providerFlag: (
                <code className="rounded bg-muted px-1 py-0.5 text-xs" />
              ),
              ollamaFlag: (
                <code className="rounded bg-muted px-1 py-0.5 text-xs" />
              ),
              envFile: (
                <code className="rounded bg-muted px-1 py-0.5 text-xs" />
              ),
            }}
            defaults={
              'Admin-Hinweis: setze <aiFlag>AI_ENABLED=true</aiFlag> und <providerFlag>LLM_PROVIDER=azure</providerFlag> oder <ollamaFlag>LLM_PROVIDER=ollama</ollamaFlag> in der <envFile>.env</envFile> und starte die Container neu.'
            }
          />
        </p>
        <div className="mt-5">
          <Button asChild variant="outline">
            <Link to={backHref}>
              {t('ai.offNotice.back', {
                defaultValue: 'Zurück zur Startseite',
              })}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
