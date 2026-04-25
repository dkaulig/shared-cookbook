import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TranslationBannerProps {
  /**
   * The recipe's content language (e.g. `'de'`). The banner copy reads
   * "Automatisch aus dem Deutschen übersetzt." when this is `'de'`.
   * Anything outside the LANG-1 whitelist falls back to the German
   * variant.
   */
  sourceLanguage: string
  /** True when the cached translation was flagged stale by a recipe edit. */
  isStale: boolean
  /**
   * Fired when the user clicks "Original anzeigen". The parent owns the
   * viewState toggle.
   */
  onShowOriginal: () => void
  /**
   * Fired when the user clicks the stale-banner's "Aktualisieren" link.
   * Should kick off the translate mutation with `force: true`. Only
   * present when `isStale` is true.
   */
  onRefresh?: () => void
  /** True while a refresh mutation is in flight (disables the link). */
  refreshPending?: boolean
}

/**
 * LANG-2 — inline banner that surfaces above the recipe content when
 * the user is reading a translated payload. Two states:
 *
 * - Fresh (default): "Automatisch aus dem Deutschen übersetzt." +
 *   "Original anzeigen" link.
 * - Stale: same copy + "Übersetzung könnte veraltet sein, [Aktualisieren]"
 *   line. The user decides whether to pay the LLM cost.
 *
 * The banner is rendered in the source-language regardless of the
 * recipe's view-state — its purpose is to inform the user that what
 * they're seeing is machine-translated, so it has to be in their UI
 * language. Copy lives in `recipes.translation.*`.
 */
export function TranslationBanner({
  sourceLanguage,
  isStale,
  onShowOriginal,
  onRefresh,
  refreshPending,
}: TranslationBannerProps) {
  const { t } = useTranslation()

  const fromKey = sourceLanguage === 'en'
    ? 'recipes.translation.translatedFromEn'
    : 'recipes.translation.translatedFromDe'
  const fromCopy = sourceLanguage === 'en'
    ? t(fromKey, { defaultValue: 'Automatically translated from English.' })
    : t(fromKey, { defaultValue: 'Automatisch aus dem Deutschen übersetzt.' })

  return (
    <div
      data-testid="recipe-translation-banner"
      className={cn(
        'mt-4 flex flex-col gap-2 rounded-[12px] px-3 py-2 text-[13px]',
        'bg-[hsl(var(--primary)/0.08)] ring-1 ring-[hsl(var(--primary)/0.25)] text-foreground',
      )}
      role="status"
    >
      <div className="flex items-start gap-2">
        <Languages className="mt-0.5 h-[16px] w-[16px] shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />
        <div className="flex-1">
          <p className="leading-[1.4]">{fromCopy}</p>
          {isStale && (
            <p className="mt-1 leading-[1.4] text-[hsl(var(--muted-foreground))]">
              {t('recipes.translation.staleHint', {
                defaultValue:
                  'Das Rezept wurde geändert; die Übersetzung könnte veraltet sein.',
              })}
              {onRefresh && (
                <>
                  {' '}
                  <button
                    type="button"
                    disabled={refreshPending}
                    onClick={onRefresh}
                    className={cn(
                      'inline-block underline text-[hsl(var(--primary))]',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  >
                    {refreshPending
                      ? t('recipes.translation.translatingPending', {
                          defaultValue: 'Übersetze…',
                        })
                      : t('recipes.translation.refreshCta', {
                          defaultValue: 'Aktualisieren',
                        })}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onShowOriginal}
          className="shrink-0 text-[12px] font-medium text-[hsl(var(--primary))] underline"
        >
          {t('recipes.translation.showOriginal', {
            defaultValue: 'Original anzeigen',
          })}
        </button>
      </div>
    </div>
  )
}
