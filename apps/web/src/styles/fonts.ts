/**
 * Font-bundling entrypoint for the DS8 Sage Modern theme.
 *
 * Importing `@fontsource/*` CSS files causes Vite to bundle the
 * corresponding WOFF2 files into the production output, removing the
 * need for a runtime fetch from Google Fonts (which would fail in
 * offline / PWA installs and would leak analytics).
 *
 * DS8 moves to Inter-only: the `--font-serif*` CSS tokens now resolve
 * to Inter too, so no additional display or body faces are needed.
 * We keep four Inter weights (400/500/600/700) to cover body, UI,
 * headlines, and emphasis.
 */

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
