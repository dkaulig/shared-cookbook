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

// OFF2 — onSync handler for the BackgroundSyncPlugin. This function
// body is serialised verbatim into `dist/sw.js` via workbox-build's
// `stringify-object` helper, which calls `.toString()` on functions.
// CRITICAL: the body must reference ONLY service-worker globals
// (`self`, `fetch`) — any closure over vite-config module scope would
// resolve to `undefined` at runtime. The TypeScript types below exist
// only to keep this file type-clean during the build; the actual
// objects at runtime are Workbox's Queue + the SW ClientList.
//
// Drain semantics:
//   - `shiftRequest()` pops FIFO.
//   - A network-layer fetch rejection → `unshiftRequest` + rethrow so
//     the browser retries on the next sync event.
//   - Any server response (2xx/4xx/5xx) counts as "delivered" — we
//     drop the entry. The server is authoritative and the UI will
//     reconcile via invalidation on the `fk-mutation-replayed`
//     message.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function offlineMutationOnSync({ queue }: { queue: any }): Promise<void> {
  let replayedCount = 0
  let entry = await queue.shiftRequest()
  while (entry) {
    try {
      await fetch(entry.request.clone())
      replayedCount++
    } catch (err) {
      await queue.unshiftRequest(entry)
      throw err
    }
    entry = await queue.shiftRequest()
  }
  // Notify every open tab so the UI can invalidate affected caches.
  // `matchAll({ type: 'window' })` excludes popups + shared workers —
  // only real app windows receive the replay signal.
  const clientsList = await (self as any).clients.matchAll({ type: 'window' })
  for (const c of clientsList) {
    c.postMessage({ type: 'fk-mutation-replayed', count: replayedCount })
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'apple-touch-icon.png',
      ],
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
          // Dedicated maskable PNG with a ~20% safe-zone around the K
          // glyph so iOS / Android can crop to a circle without clipping
          // the letterform. Rendered from icon-maskable.svg in
          // scripts/render-pwa-icons.js.
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // SHARE-0 + SHARE-1 — iOS 17.4+ (and Android Chrome) Web Share
        // Target API. A single POST+multipart entry handles both the
        // URL-only share (old SHARE-0 behaviour — URL shows up in the
        // `url`/`text`/`title` form fields) and the file-attachment
        // share (new SHARE-1 behaviour — images land in `files`).
        //
        // The service worker intercepts POST /share-target, stashes
        // any file blobs in IndexedDB, and redirects to the same path
        // as GET so the React `<ShareTargetPage />` can keep a single
        // code path. A URL-only POST falls through the SW to a 303 at
        // `/share-target?url=…` which uses the existing SHARE-0 logic.
        //
        // NOTE: after this manifest lands the user MUST re-install the
        // PWA on iOS (delete from Home Screen, re-add via "Zum
        // Home-Bildschirm") for iOS to re-read the manifest and
        // register the share-target. Documented in the release note.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'],
              },
            ],
          },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Keep the cache under ~3 MiB to leave room for the full recipe
        // collection's cover photos.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // SHARE-1 — side-load the POST /share-target fetch handler into
        // the generated Workbox SW via `importScripts`. The file lives
        // in `public/` so Vite copies it to `dist/` verbatim, and the
        // SW picks it up as a same-origin script at runtime. Keeping
        // the handler out of the main Workbox runtime caching config
        // means we don't have to switch to `injectManifest` just for
        // one POST route — the existing generateSW behaviour is
        // untouched.
        importScripts: ['share-target-sw.js'],
        runtimeCaching: [
          {
            // Signed photo URLs — stale-while-revalidate so previously-
            // viewed recipe photos survive going offline AND get refreshed
            // on every view. CacheFirst + `statuses: [0, 200]` was observed
            // to cache partial/aborted image streams (status 0 includes
            // cross-origin-opaque AND network-interrupted responses); with
            // CacheFirst the garbage then served for 14 days, producing
            // half-rendered images on recipe-list re-entries.
            //
            // SWR returns the cache immediately (offline-safe, instant
            // paint on re-mount after back-nav) and fires a background
            // re-fetch that overwrites the cache entry. `statuses: [200]`
            // refuses to cache status-0 responses so a cancelled fetch
            // never poisons the store in the first place.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/photos/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'fk-photos',
              expiration: { maxEntries: 50, maxAgeSeconds: 14 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
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
          // OFF2 — offline-safe mutations. If the user makes a cook-mark,
          // rating change, slot-edit, or shopping-list check while
          // offline, the SW captures the request in the `fk-mutation-
          // queue` and auto-replays on reconnect. The onSync callback
          // drains the queue in FIFO order and posts a
          // `fk-mutation-replayed` message to every open window so the
          // UI can invalidate affected caches. Backend PATCH/POST
          // endpoints are idempotent on replay for the same
          // (importId, clientMutationId) pair — OFF3 adds the
          // ETag/If-Match handshake that closes the conflict window.
          //
          // Workbox's `method` option takes ONE verb, so we register the
          // same BackgroundSync plugin three times (PATCH / POST /
          // DELETE) sharing the same queue name — Workbox interleaves
          // entries from all three routes correctly because the queue
          // is backed by a single IDB store keyed on `name`.
          //
          // The `urlPattern` matcher is serialised into the SW bundle
          // via `.toString()`, so it MUST NOT reference closure
          // variables that only exist in the vite config's module
          // scope. Inlining the regex + method literal keeps each
          // route self-contained after stringification.
          //
          // SECURITY: replays reuse whatever `Authorization` header was
          // on the queued request. A 4xx response means the server
          // rejected it (e.g. post-logout 401) — the onSync handler
          // treats ANY server response as "delivered" and drops the
          // entry from the queue. Only network-layer failures (fetch
          // rejects) re-unshift and rethrow so the browser retries.
          //
          // FOLLOW-UP (offline v2, post-Phase-5): on shared devices
          // (kitchen tablet, PWA), the SW registration is per-origin,
          // not per-user. A cross-user drift scenario (user A queues,
          // logs out, user B signs in, reconnect) would replay user A's
          // mutations against user B's session. Mitigation = clear the
          // Workbox queue on logout. Documented as a known limitation
          // in docs/ops.md §9 "Offline behavior" until the fix lands.
          {
            urlPattern: ({ url, request }: { url: URL; request: Request }) =>
              request.method === 'PATCH' &&
              (/^\/api\/recipes\/[^/]+/.test(url.pathname) ||
                /^\/api\/mealplans\/[^/]+\/slots/.test(url.pathname) ||
                /^\/api\/shopping-lists\/[^/]+\/items/.test(url.pathname) ||
                /^\/api\/ratings/.test(url.pathname)),
            handler: 'NetworkOnly',
            method: 'PATCH',
            options: {
              backgroundSync: {
                name: 'fk-mutation-queue',
                options: {
                  maxRetentionTime: 24 * 60, // minutes = 24h
                  onSync: offlineMutationOnSync,
                },
              },
            },
          },
          {
            urlPattern: ({ url, request }: { url: URL; request: Request }) =>
              request.method === 'POST' &&
              (/^\/api\/recipes\/[^/]+/.test(url.pathname) ||
                /^\/api\/mealplans\/[^/]+\/slots/.test(url.pathname) ||
                /^\/api\/shopping-lists\/[^/]+\/items/.test(url.pathname) ||
                /^\/api\/ratings/.test(url.pathname)),
            handler: 'NetworkOnly',
            method: 'POST',
            options: {
              backgroundSync: {
                name: 'fk-mutation-queue',
                options: {
                  maxRetentionTime: 24 * 60,
                  onSync: offlineMutationOnSync,
                },
              },
            },
          },
          {
            urlPattern: ({ url, request }: { url: URL; request: Request }) =>
              request.method === 'DELETE' &&
              (/^\/api\/recipes\/[^/]+/.test(url.pathname) ||
                /^\/api\/mealplans\/[^/]+\/slots/.test(url.pathname) ||
                /^\/api\/shopping-lists\/[^/]+\/items/.test(url.pathname) ||
                /^\/api\/ratings/.test(url.pathname)),
            handler: 'NetworkOnly',
            method: 'DELETE',
            options: {
              backgroundSync: {
                name: 'fk-mutation-queue',
                options: {
                  maxRetentionTime: 24 * 60,
                  onSync: offlineMutationOnSync,
                },
              },
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
