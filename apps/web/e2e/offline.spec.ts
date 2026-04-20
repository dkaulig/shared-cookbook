import { expect, test } from '@playwright/test'

/**
 * OFF5 — offline coverage integration smoke.
 *
 * What this covers:
 *   - Service-worker registration under `pnpm preview` (the built SW).
 *   - OFF1: TanStack Query IndexedDB persister serves a recipe detail
 *     page from the hydrated cache after the browser goes offline.
 *   - OFF2: `NetworkIndicator` flips to "Offline" when the browser
 *     reports `offline`.
 *   - Recovery: flipping back online hides the offline pill.
 *
 * What this DOES NOT cover (intentional, documented):
 *   - Mutation replay. The Workbox `fk-mutation-queue` is tricky to
 *     script reliably in Playwright: `setOffline` at the browser-
 *     context level doesn't intercept requests already in SW's NetworkOnly
 *     handler the way offline-first handlers do. Unit tests in
 *     `apps/web/src/features/offline/useNetworkStatus.test.tsx` +
 *     `useBackgroundSyncMessage.test.tsx` (OFF2) own the mutation-
 *     replay contract via `fk-mutation-queued` / `fk-mutation-replayed`
 *     SW-message stubs.
 *   - 409 conflict UX. Unit-tested in OFF4
 *     (`ConflictDialog.test.tsx` + per-resource body tests).
 *
 * Prereqs (read the README / docs/ops.md §9):
 *   - `pnpm build` ran first so `dist/sw.js` exists.
 *   - Backend is reachable at the `baseURL` origin (via the compose
 *     stack OR the `pnpm preview` proxy). Playwright skips the spec if
 *     the credentials env vars are absent.
 *
 * NOT wired into CI — `pnpm test:e2e` is manual-only.
 */

test('offline smoke: read cache survives + network indicator reflects state', async ({
  page,
  context,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — see apps/web/e2e/README-less docs/ops.md §9',
  )

  // 1. Login path — mirrors `scripts/smoke-live.sh` + the manual QA
  //    flow. Tolerates either the inline-login on `/` or a redirect
  //    to `/login`.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  // Landing on either the home URL or a home-like path is acceptable.
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home)/)

  // 2. Navigate to a recipe — assumption: the account has at least one
  //    group with at least one recipe. Don't hard-code IDs.
  await page
    .getByRole('link', { name: /gruppen|rezepte/i })
    .first()
    .click()
  // First group
  const firstGroupLink = page.getByRole('link').filter({ hasText: /.+/ }).first()
  await firstGroupLink.click()
  // First recipe within the group
  const firstRecipe = page
    .getByRole('link')
    .filter({ hasText: /.+/ })
    .first()
  await firstRecipe.click()
  // Recipe detail renders an h1.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // 3. Warm the SW + persister cache. vite-plugin-pwa registers the SW
  //    on first load; we wait for `navigator.serviceWorker.ready` + a
  //    short settle delay for the persister to flush to IDB.
  await page.waitForFunction(() => navigator.serviceWorker?.ready !== undefined)
  await page.waitForTimeout(1500)

  // 4. Go offline at the browser-context level. All outgoing requests
  //    are now network-errored at the layer ABOVE the SW; GET handlers
  //    with cache/persister fallback still render.
  await context.setOffline(true)

  // 5. Reload. The recipe detail page should still render, served from
  //    the persister cache + Workbox runtime cache.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // 6. `NetworkIndicator` flips to "Offline" after the `offline` window
  //    event fires. `getByRole('status')` finds the live region; the
  //    filter narrows to the user-visible pill (not the sr-only idle
  //    host).
  await expect(
    page.getByRole('status').filter({ hasText: /offline/i }),
  ).toBeVisible()

  // 7. (Mutation-queue check is intentionally skipped — see top-of-
  //     file comment. OFF2 owns the mutation-replay contract via unit
  //     tests with the SW-message stub.)

  // 8. Go online. The NetworkIndicator hides the offline pill within
  //    a few hundred ms of the `online` window event.
  await context.setOffline(false)
  await expect(
    page.getByRole('status').filter({ hasText: /offline/i }),
  ).not.toBeVisible({ timeout: 2_000 })
})
