import { defineConfig } from '@playwright/test'

/**
 * OFF5 — Playwright E2E config for the offline-smoke spec.
 *
 * This is NOT wired into CI. The spec boots `pnpm preview` (which uses
 * the real built service worker) and exercises the offline pipeline
 * end-to-end. Run locally with:
 *
 *   pnpm -C apps/web test:e2e:install    # one-time browser download
 *   PLAYWRIGHT_TEST_EMAIL=… \
 *   PLAYWRIGHT_TEST_PASSWORD=… \
 *   pnpm -C apps/web test:e2e
 *
 * Chromium is the only target — Firefox and WebKit have known quirks
 * with the `setOffline` + service-worker path that would require per-
 * browser hacks without adding coverage (SW code is identical across
 * them). Keeping the smoke chromium-only mirrors the CR3/CR4 unit-
 * coverage philosophy: one browser for the flow, jsdom elsewhere.
 */
export default defineConfig({
  testDir: 'e2e',
  // The preview server boots the built SW, which needs a second or
  // two to register + claim clients before the page is fully offline-
  // capable. Allow 30s total per test.
  timeout: 30_000,
  fullyParallel: false,
  // CI-safe defaults; a local dev run won't hit retries.
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    browserName: 'chromium',
    trace: 'on-first-retry',
  },
  webServer: {
    // `pnpm preview` serves the vite-build output (including the real
    // SW emitted by vite-plugin-pwa). `pnpm dev` would NOT exercise
    // the SW because devOptions.enabled is false in vite.config.ts.
    command: 'pnpm preview --host --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
