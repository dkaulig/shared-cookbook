import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// OFF1 — the TanStack Query persister uses this as its cache `buster`.
// Production builds pin it to `npm_package_version` so a deploy auto-
// invalidates the IDB cache whenever the app version changes. Dev
// builds fall back to `'dev'` so HMR reloads can reuse the cache.
const APP_VERSION =
  process.env.VITE_APP_VERSION ?? process.env.npm_package_version ?? 'dev'

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Familien-Kochbuch',
        short_name: 'Kochbuch',
        description: 'Private Rezept-Sammlung für Familie und Freunde.',
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Sage Modern neutral background shown on the PWA splash screen —
        // matches the `--background` token (#f7f7f6) so the transition
        // from splash to app has no visible seam.
        background_color: '#f7f7f6',
        // Matches the sage `--primary` (#4f7961) used on the UI shell.
        theme_color: '#4f7961',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Keep the cache under ~3 MiB to leave room for the full recipe
        // collection's cover photos.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            // Signed photo URLs — cache-first so previously-viewed recipe
            // photos survive going offline.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/photos/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'fk-photos',
              expiration: { maxEntries: 50, maxAgeSeconds: 14 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Recipe + group metadata — network-first with a short timeout
            // so cached data is served instantly when the network drops.
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/recipes/') || url.pathname.startsWith('/api/groups/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fk-recipes',
              networkTimeoutSeconds: 2,
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Auth calls — never cached; always hit the network.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/auth/'),
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: true,
  },
})
