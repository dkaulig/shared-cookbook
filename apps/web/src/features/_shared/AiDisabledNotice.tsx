import { Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

/**
 * REL-7 — full-page notice rendered in place of an AI-only surface
 * (ImportPhotosPage, ChatPage) when the operator disabled AI. Also
 * used by the URL-import page as an in-page banner above the raw-text
 * fallback form.
 *
 * Copy is German-first — REL-3 (i18n foundation) extracts these later;
 * for now they're hardcoded alongside the rest of the app's German UI
 * strings.
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
          Admin-Hinweis: setze <code className="rounded bg-muted px-1 py-0.5 text-xs">AI_ENABLED=true</code>{' '}
          und <code className="rounded bg-muted px-1 py-0.5 text-xs">LLM_PROVIDER=azure</code>{' '}
          oder <code className="rounded bg-muted px-1 py-0.5 text-xs">LLM_PROVIDER=ollama</code>{' '}
          in der <code className="rounded bg-muted px-1 py-0.5 text-xs">.env</code>{' '}
          und starte die Container neu.
        </p>
        <div className="mt-5">
          <Button asChild variant="outline">
            <Link to={backHref}>Zurück zur Startseite</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
