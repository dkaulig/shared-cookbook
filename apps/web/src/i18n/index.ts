import i18n, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import deTranslation from '@/locales/de/translation.json'
import enTranslation from '@/locales/en/translation.json'
import deErrors from '@/locales/de/errors.json'
import enErrors from '@/locales/en/errors.json'

/**
 * REL-3 — i18n foundation.
 *
 * Namespaces:
 *   - `translation` (default) — all UI copy.
 *   - `errors`                — keyed by backend error-code.
 *
 * Language priority on boot (REL-3h):
 *   1. localStorage (`i18nextLng`) — user override via settings.
 *   2. navigator.language          — browser preference.
 *   3. fallback `en`               — for unsupported browser locales.
 *
 * `supportedLngs` restricts the navigator-detector to de/en — a
 * browser reporting `fr-FR` / `zh-CN` therefore lands on `en`. The
 * fallback chain `['en', 'de']` keeps BOTH the unsupported-locale
 * fallback (fr-FR → en) AND the key-level fallback (missing EN key →
 * DE copy) so the product stays usable while the EN catalog is still
 * ~60-80% complete.
 */

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const resources = {
  de: {
    translation: deTranslation,
    errors: deErrors,
  },
  en: {
    translation: enTranslation,
    errors: enErrors,
  },
} as const

export interface CreateI18nOptions {
  /** Force a specific starting language — used by tests that pin DE. */
  initialLng?: SupportedLanguage
  /**
   * Spawn a detached i18n instance instead of mutating the shared
   * singleton. Used by tests that want to exercise the detector chain
   * without leaking state across cases.
   */
  detached?: boolean
}

/**
 * Initialise the default i18n singleton (or a detached instance for
 * tests). Bootstrap calls `createI18n()` once from `main.tsx`; tests
 * pass `initialLng` or `detached: true` for isolation.
 */
export async function createI18n(
  options: CreateI18nOptions = {},
): Promise<I18nInstance> {
  const lng = options.initialLng

  // Detached whenever the caller pins a language OR opts into test
  // isolation — otherwise we mutate the shared default singleton so
  // `import i18n from 'i18next'` elsewhere in the app sees the same
  // resources + detection wiring.
  const instance =
    typeof lng !== 'undefined' || options.detached
      ? i18n.createInstance()
      : i18n

  await instance
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      supportedLngs: [...SUPPORTED_LANGUAGES],
      // `de-AT` / `en-GB` / `de-CH` → strip the region tag so regional
      // variants match our supportedLngs instead of falling all the
      // way through to `fallbackLng`.
      load: 'languageOnly',
      // Fallback chain: EN is the primary fallback (REL-3h — unknown
      // browser locales land here), DE is the secondary so missing-EN
      // keys resolve via the German catalog until EN coverage is full.
      fallbackLng: ['en', 'de'],
      ns: ['translation', 'errors'],
      defaultNS: 'translation',
      lng,
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: 'i18nextLng',
        caches: ['localStorage'],
      },
      interpolation: {
        // React already escapes — i18next's own escape would double-
        // escape HTML-looking content. Still keep it on for safety
        // since values come from localisation JSON we control.
        escapeValue: true,
      },
      returnNull: false,
    })

  return instance
}

export default i18n
