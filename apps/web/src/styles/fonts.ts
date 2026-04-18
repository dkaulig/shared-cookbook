/**
 * Font-bundling entrypoint for the DS1 Warme-Küche theme.
 *
 * Importing `@fontsource/*` CSS files causes Vite to bundle the
 * corresponding WOFF2 files into the production output, removing the
 * need for a runtime fetch from Google Fonts (which would fail in
 * offline / PWA installs and would leak analytics).
 *
 * Weights selected to match the mockups under `docs/mockups/`:
 *   - Inter          — body + UI (400/500/600/700)
 *   - Cormorant      — display / headings (400/500/600/700)
 *   - Libre Baskerville — italic accents (400 italic, 400, 700)
 *
 * Consumed once at `main.tsx` module scope so every route inherits the
 * same @font-face declarations without per-page imports.
 */

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

import '@fontsource/cormorant-garamond/400.css'
import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/cormorant-garamond/600.css'
import '@fontsource/cormorant-garamond/700.css'

import '@fontsource/libre-baskerville/400.css'
import '@fontsource/libre-baskerville/400-italic.css'
import '@fontsource/libre-baskerville/700.css'
