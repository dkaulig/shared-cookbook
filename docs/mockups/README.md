# Mockups — Familien-Kochbuch

Static HTML mockups produced during the Phase-1 design session. These are **design specs**, not production code. They define the visual language (Warme Küche palette: amber-700 primary on cream background, Cormorant Garamond + Inter + Libre Baskerville typography, soft shadows, mobile-first) that gets ported into `apps/web/` during the Design-Implementation phase.

## Start the preview server

From this directory:

```bash
python3 -m http.server 8765 --bind 0.0.0.0
```

Then open `http://<your-lan-ip>:8765/` from any device on the same WiFi (phone, tablet, laptop). The `index.html` is a picker that links to every mockup page.

## Pages

| # | Page | File |
|---|------|------|
| 01 | Login | `warme-kueche-login.html` |
| 02 | Home / Dashboard | `warme-kueche-home.html` |
| 03 | Recipe Detail | `warme-kueche-recipe-detail.html` |
| 04 | Group Detail | `warme-kueche-group-detail.html` |
| 05 | Recipe Form | `warme-kueche-recipe-form.html` |

Plus the original A/B variant comparison (Warme Küche vs. Dunkler Foodie) that informed the palette decision:

- `dunkler-foodie-login.html` — dark-foodie alternative (rejected in favour of Warme Küche)

## Design tokens (source of truth)

```
Primary        #B45309  amber-700
Primary hover  #92400E  amber-800
Accent / CTA   #DC2626  red-600
Background     #FFFBEB  amber-50 (cream)
Surface        #FFFFFF
Text           #1C1917  stone-900
Text muted     #57534E  stone-600
Text soft      #78716C  stone-500
Border         #E7E5E4  stone-200
Ring           rgba(180,83,9,0.25)
Star           #D97706  amber-600
Success        #15803D  green-700
```

Fonts:
- **Display / headings:** Cormorant Garamond (500–700)
- **Body / UI:** Inter (400–700)
- **Italic accents:** Libre Baskerville italic

Shadow scale (from `docs/mockups/*.html`):

```
--shadow-xs: 0 1px 2px rgba(28, 25, 23, 0.04)
--shadow-sm: 0 2px 6px rgba(28, 25, 23, 0.05), 0 1px 2px rgba(28, 25, 23, 0.04)
--shadow-md: 0 8px 24px -8px rgba(146, 64, 14, 0.14), 0 2px 6px -2px rgba(28, 25, 23, 0.04)
```

## Why standalone HTML

These mockups are intentionally not React / Vite / Tailwind-compiled. They are:

- **Isolated** from the real app so broken mockups never break production.
- **Serveable** from any simple HTTP server without a build step.
- **Viewable** on any phone on the same WiFi immediately.
- **Stable** as a spec — the files don't shift when the app's dependencies upgrade.

The Design-Implementation phase (DS1–DS7) is where the tokens, fonts and layouts from these files get faithfully reproduced in real React components inside `apps/web/`.
