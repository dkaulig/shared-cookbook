import { useEffect, useRef, useState } from 'react'
import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'

/**
 * REL-3 — compact language-toggle dropdown.
 *
 * Sits in the sticky <TopNav /> on every viewport so the user can swap
 * DE ↔ EN from any page. A real <select> would hijack the sage-modern
 * styling; a tiny controlled menu keeps the chrome consistent with the
 * rest of the nav row + avoids a third-party dropdown dependency.
 *
 * Persistence is delegated to `i18next-browser-languagedetector` which
 * writes the pick to `localStorage['i18nextLng']` by default — no
 * manual persistence needed here. Changing the language does NOT reload
 * the page; react-i18next re-renders the subscribed tree.
 */
export function LanguageToggle() {
  const { i18n, t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Click-away / Escape dismiss. Simple listener; no react-focus-lock
  // because the menu only holds 2 items and losing focus to the page
  // background is fine.
  useEffect(() => {
    if (!open) return
    function onDocClick(ev: MouseEvent) {
      if (!containerRef.current?.contains(ev.target as Node)) setOpen(false)
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const currentLanguage = (
    i18n.resolvedLanguage ?? i18n.language ?? 'de'
  ).slice(0, 2)

  async function choose(lang: SupportedLanguage) {
    if (lang !== currentLanguage) {
      await i18n.changeLanguage(lang)
    }
    setOpen(false)
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label={t('account.menu.language', { defaultValue: 'Sprache' })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('account.menu.language', { defaultValue: 'Sprache' })}
        onClick={() => setOpen((v) => !v)}
        className="grid h-10 w-10 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Languages className="h-5 w-5" aria-hidden="true" />
        <span className="sr-only">{currentLanguage.toUpperCase()}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('account.menu.language', { defaultValue: 'Sprache' })}
          className="absolute right-0 z-30 mt-2 w-44 overflow-hidden rounded-[10px] border border-border bg-background shadow-lg"
        >
          {SUPPORTED_LANGUAGES.map((lang) => {
            const active = lang === currentLanguage
            return (
              <button
                key={lang}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => void choose(lang)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm',
                  'transition-colors hover:bg-[hsl(var(--primary)/0.08)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  active
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                <span>
                  {t(`languageNames.${lang}`, {
                    defaultValue: lang === 'de' ? 'Deutsch' : 'English',
                  })}
                </span>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {lang}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
