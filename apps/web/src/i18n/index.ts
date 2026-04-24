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
 * Language priority on boot:
 *   1. localStorage (`i18nextLng`) — user override.
 *   2. navigator.language          — browser preference.
 *   3. fallback (`de` in dev, `en` in prod).
 *
 * Missing EN keys fall through to DE so the product stays usable even
 * while the EN catalog is ~60-80% complete. Community PRs will fill
 * the gaps over time.
 */

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

// Dev default is DE (maintainer daily-driver). Prod default is EN
// (external OSS audience is English-first). Vite replaces `import.meta
// .env.DEV` at build time; in tests both branches are reachable and
// the `initialLng` override lets specs pin the starting language.
const PROD_DEFAULT: SupportedLanguage = 'en'
const DEV_DEFAULT: SupportedLanguage = 'de'

function getDefaultLanguage(): SupportedLanguage {
  return import.meta.env.DEV ? DEV_DEFAULT : PROD_DEFAULT
}

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
  /** Force a specific starting language — used by tests. */
  initialLng?: SupportedLanguage
}

/**
 * Initialise a dedicated i18n instance. The default export uses the
 * singleton from `i18next`; tests call `createI18n()` to get an
 * isolated instance so they don't leak state between cases.
 */
export async function createI18n(
  options: CreateI18nOptions = {},
): Promise<I18nInstance> {
  const lng = options.initialLng

  // Fresh instance per call so tests stay isolated. Production shares
  // the default singleton via `i18n` (see bottom of this file).
  const instance =
    typeof options.initialLng !== 'undefined'
      ? i18n.createInstance()
      : i18n

  await instance
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      supportedLngs: [...SUPPORTED_LANGUAGES],
      fallbackLng: 'de',
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
      // If no language was forced and no cached pick exists, steer to
      // the env-appropriate default (dev: de, prod: en). The detector
      // runs first, so this is only the last-resort fallback.
      ...(lng
        ? {}
        : { load: 'currentOnly' as const, lng: deriveInitialLng() }),
    })

  return instance
}

function deriveInitialLng(): SupportedLanguage {
  try {
    const stored = window.localStorage.getItem('i18nextLng')
    if (stored === 'de' || stored === 'en') return stored
  } catch {
    /* noop — SSR / private-mode / quota */
  }
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language?.slice(0, 2).toLowerCase()
    if (lang === 'de' || lang === 'en') return lang
  }
  return getDefaultLanguage()
}

export default i18n
