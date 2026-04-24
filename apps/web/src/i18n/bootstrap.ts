import { createI18n } from './index'

/**
 * REL-3 — Side-effect bootstrap.
 *
 * Imported once from `main.tsx` before the React tree mounts so the
 * default i18n singleton is initialised with resources + detection
 * wired before the first render. `createI18n()` without an explicit
 * `initialLng` mutates the shared singleton directly — tests that
 * want isolation pass `initialLng` to get a detached instance.
 */
void createI18n()
