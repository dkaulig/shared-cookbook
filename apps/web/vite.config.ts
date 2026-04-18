import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
        // Warme-Küche cream background shown on the PWA splash screen —
        // matches the `--background` token (#FFFBEB amber-50) so the
        // transition from splash to app has no visible seam.
        background_color: '#fffbeb',
        // Matches the Tailwind `amber-700` accent used on the UI shell.
        theme_color: '#b45309',
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
