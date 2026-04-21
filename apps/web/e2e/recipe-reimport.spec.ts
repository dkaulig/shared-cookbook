import { expect, test } from '@playwright/test'

/**
 * REIMPORT-1 — Playwright happy-path smoke for the "Neu importieren"
 * flow.
 *
 * Plan requirement (`docs/plans/2026-04-21-recipe-reimport-draft.md`
 * §MVP Frontend): from the recipe detail page's 3-dots menu, the user
 * can reimport a URL-sourced recipe; the existing `ImportProgressPage`
 * owns the progress UI and on Done navigates back to the recipe detail
 * page thanks to the `targetRecipeId` branch added in this slice.
 *
 * Flow covered:
 *   1. Login via the inline-home form (same as `offline.spec.ts`).
 *   2. Navigate to the first group → first recipe — ASSUMES the first
 *      recipe in the first group was URL-imported. If the account
 *      under test has a manually-created recipe first, the spec fails
 *      early at step 3 (3-dots menu missing "Neu importieren"). TODO:
 *      make the scan loop through recipes until it finds a URL-sourced
 *      one, once the detail page exposes a stable test-id for the
 *      sourceUrl presence. For now the credential-gated nature of this
 *      spec keeps it honest with the seeded account in docs/ops.md §9.
 *   3. Open 3-dots menu; click "Neu importieren".
 *   4. Confirm-dialog appears; click "Reimport starten".
 *   5. Assert navigation to /rezepte/import/:id + banner visible.
 *   6. Poll for `status=done` (bounded 120 s — Whisper transcription
 *      on a fresh Azure call can take up to ~90 s; the cache short-
 *      circuit may land in <1 s).
 *   7. Assert navigation back to the recipe detail page.
 *   8. Visually acknowledge the "Rezept erfolgreich aktualisiert" toast
 *      if it lands (the toast is transient so the assertion is
 *      lenient — the navigation back to the detail page is the real
 *      load-bearing assertion).
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so the
 * spec stays safe to lint/compile without a live stack. Manual run:
 *
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web test:e2e
 */

test('recipe-reimport happy path: detail → confirm → progress → back to detail', async ({
  page,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see docs/ops.md §9',
  )

  // 1. Login — identical flow to offline.spec.ts.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home)/)

  // 2. Into the first group's first recipe — mirrors offline + cook-now
  //    specs. TODO(see top-of-file): scan for a URL-sourced recipe once
  //    a stable test-id exists.
  await page
    .getByRole('link', { name: /gruppen|rezepte/i })
    .first()
    .click()
  const firstGroupLink = page.getByRole('link').filter({ hasText: /.+/ }).first()
  await firstGroupLink.click()
  const firstRecipe = page.getByRole('link').filter({ hasText: /.+/ }).first()
  await firstRecipe.click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const detailUrl = page.url()

  // 3. Open the 3-dots menu → "Neu importieren".
  await page.getByRole('button', { name: /^Mehr$/i }).click()
  const reimportEntry = page.getByRole('menuitem', { name: /Neu importieren/i })
  await expect(reimportEntry).toBeVisible()
  await reimportEntry.click()

  // 4. Confirm dialog.
  await expect(
    page.getByRole('heading', { name: /Rezept neu importieren\?/i }),
  ).toBeVisible()
  await page.getByRole('button', { name: /Reimport starten/i }).click()

  // 5. Landed on the progress page + reimport banner visible.
  await page.waitForURL(/\/rezepte\/import\//, { timeout: 10_000 })
  await expect(
    page.getByTestId('reimport-running-banner'),
  ).toBeVisible({ timeout: 10_000 })

  // 6. Poll for status=done — the page auto-redirects back to the detail
  //    page via the REIMPORT-1 branch once the wire lands `status=Done`
  //    with targetRecipeId set. Bound at 120 s per plan §5.
  await page.waitForURL(
    (url) =>
      url.pathname.includes('/recipes/') && !url.pathname.endsWith('/cook'),
    { timeout: 120_000 },
  )

  // 7. Back on a recipe detail page — URL pathname matches the original
  //    detail route (same recipe id, since reimport updates in place).
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(new URL(detailUrl).pathname).toBe(new URL(page.url()).pathname)

  // 8. Optional success-toast check — tolerated if it already faded.
  const toast = page.getByRole('status').filter({
    hasText: /rezept erfolgreich aktualisiert/i,
  })
  // Soft-check — the toast is transient. If it's gone by the time this
  // runs, the navigation assertion above already proves the flow
  // completed end-to-end.
  if ((await toast.count()) > 0) {
    await expect(toast.first()).toBeVisible()
  }
})
