import { defineConfig } from '@playwright/test'

// Local-stack run against the docker-compose caddy on http://localhost.
// Distinct from the default playwright.config.ts (which spins up
// `pnpm preview` on :5173 for offline / SW coverage) — this variant
// assumes `docker compose up -d` is running and routes the whole test
// through the real caddy → api / web containers.
//
// Usage:
//   docker compose up -d
//   PLAYWRIGHT_TEST_EMAIL=… PLAYWRIGHT_TEST_PASSWORD=… \
//     pnpm --filter web exec playwright test --config=playwright.docker.config.ts
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost',
    browserName: 'chromium',
    trace: 'on-first-retry',
  },
})
