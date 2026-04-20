// Regenerate the app's PWA icons from inline SVG sources. Run when the
// brand colour changes (Sage --primary) or the logo glyph is updated.
//
// Usage:
//   pnpm dlx @resvg/resvg-js-cli || npm i @resvg/resvg-js
//   node scripts/render-pwa-icons.js
//
// Outputs (apps/web/public/):
//   - icon-192.png           — PWA manifest, purpose "any"
//   - icon-512.png           — PWA manifest, purpose "any"
//   - icon-maskable-512.png  — PWA manifest, purpose "maskable" (~20 % safe-zone)
//   - apple-touch-icon.png   — iOS home-screen tile (180×180)

const fs = require('node:fs')
const path = require('node:path')
const { Resvg } = require('@resvg/resvg-js')

const OUT_DIR = path.resolve(__dirname, '../apps/web/public')

// Rounded-square logo — foreground K, sage background. Matches the
// --primary token (#4f7961) and --primary-foreground (#ffffff) in
// apps/web/src/index.css.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#4f7961"/><text x="256" y="346" font-family="Inter, system-ui, sans-serif" font-size="320" font-weight="600" text-anchor="middle" fill="#ffffff">K</text></svg>`

// Maskable variant: full-bleed background (no rounding — the launcher
// applies the mask) and a smaller glyph so the letterform sits fully
// inside the 80 % safe-zone regardless of mask shape.
const MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#4f7961"/><text x="256" y="340" font-family="Inter, system-ui, sans-serif" font-size="240" font-weight="600" text-anchor="middle" fill="#ffffff">K</text></svg>`

function render(svg, outName, size) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
    .render()
    .asPng()
  const outPath = path.join(OUT_DIR, outName)
  fs.writeFileSync(outPath, png)
  console.log(`${outPath}  (${png.length} bytes, ${size}×${size})`)
}

render(ICON_SVG, 'icon-192.png', 192)
render(ICON_SVG, 'icon-512.png', 512)
render(MASKABLE_SVG, 'icon-maskable-512.png', 512)
render(ICON_SVG, 'apple-touch-icon.png', 180)
