import { Users } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FormIntroProps {
  mode: 'create' | 'edit'
  /** Target group name. Undefined while useGroup is still loading. */
  groupName: string | undefined
  className?: string
}

/**
 * DS6 form intro block: serif headline + italic Libre-Baskerville tagline
 * + amber target-group pill. Mirrors `.form-intro` in the recipe-form
 * mockup. Purely presentational — the parent page owns `useGroup()` and
 * passes the name down.
 */
export function FormIntro({ mode, groupName, className }: FormIntroProps) {
  const heading = mode === 'create' ? 'Neues Rezept' : 'Rezept bearbeiten'
  const tagline =
    mode === 'create'
      ? 'Leg ein Rezept an — Zutaten und Schritte kannst du später jederzeit anpassen.'
      : 'Ergänze Zutaten und Schritte, ohne die bisherige Version zu verlieren.'

  return (
    <div className={cn('mb-2', className)}>
      <h1 className="mb-1 font-serif text-[clamp(28px,6vw,36px)] font-semibold leading-[1.05] tracking-[-0.015em] text-foreground">
        {heading}
      </h1>
      <p className="font-serif-body text-[15px] italic text-[hsl(var(--muted-foreground))]">
        <em>{tagline}</em>
      </p>
      <div
        className={cn(
          'mt-3.5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold',
          'bg-[hsl(var(--primary)/0.08)] text-primary',
        )}
      >
        <Users className="h-[13px] w-[13px]" aria-hidden="true" />
        Gruppe: {groupName ?? '…'}
      </div>
    </div>
  )
}
