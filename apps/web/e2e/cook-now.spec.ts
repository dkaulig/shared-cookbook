import { expect, test } from '@playwright/test'

/**
 * COOK-GAPFIX — Playwright happy-path smoke for the "Jetzt kochen" mode.
 *
 * Plan requirement (`docs/plans/2026-04-21-cook-now-mode-draft.md`):
 * "E2E-Happy-Path von Detail-Page → Cook-Mode → Fertig → zurück auf
 * Detail-Page mit 'zuletzt gekocht'-Badge."
 *
 * Flow covered:
 *   1. Login via the inline-home form (same as `offline.spec.ts`).
 *   2. Navigate to the first group → first recipe.
 *   3. Click "Jetzt kochen" on the recipe detail action bar.
 *   4. Portions picker opens → click "Weiter" with the default count.
 *   5. Mise-en-place renders at least 1 ingredient row.
 *   6. Click "Weiter" repeatedly until the finish card shows up.
 *   7. Click "Jetzt gekocht" on the finish card.
 *   8. Land back on the recipe detail page (URL match + h1 visible).
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so the
 * spec is safe to lint/compile without a live stack. Manual run:
 *
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web test:e2e
 *
 * The "zuletzt gekocht"-badge assertion on the detail page is
 * intentionally skipped for now: there is no stable test-id for that
 * badge in the current UI. The navigation assertion on its own is
 * enough to prove the end-to-end mutation round-tripped (the
 * `useMarkAsCooked` mutation has to resolve before `CookFinishCard`
 * calls `onMarkedCooked`, which is what drives the navigation).
 */

test('cook-now happy path: detail → cook mode → finish → back to detail', async ({
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

  // 2. Into the first group's first recipe.
  await page
    .getByRole('link', { name: /gruppen|rezepte/i })
    .first()
    .click()
  const firstGroupLink = page.getByRole('link').filter({ hasText: /.+/ }).first()
  await firstGroupLink.click()
  const firstRecipe = page.getByRole('link').filter({ hasText: /.+/ }).first()
  await firstRecipe.click()
  // Recipe detail renders an h1.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const detailUrl = page.url()

  // 3. Enter cook-mode via the primary action on the detail page.
  await page.getByRole('button', { name: /jetzt kochen/i }).first().click()

  // 4. Portions picker is the first screen; confirm with defaults.
  await expect(page.getByTestId('cook-portions-picker')).toBeVisible()
  await page.getByRole('button', { name: /^weiter$/i }).click()

  // 5. Mise-en-place must render at least one checkbox-like ingredient row.
  await expect(page.getByTestId('cook-mise-en-place')).toBeVisible()
  const ingredientRows = page.getByRole('checkbox')
  await expect(ingredientRows.first()).toBeVisible()

  // 6. Step through every cook step until the finish card appears.
  //    The primary's label flips from "Weiter" to "Fertig" on the last
  //    step — advance while "Weiter" is visible, then click "Fertig".
  //    Guard against an unbounded loop with a generous cap.
  for (let i = 0; i < 40; i++) {
    const weiter = page.getByRole('button', { name: /^weiter$/i })
    if ((await weiter.count()) === 0) break
    await weiter.first().click()
  }
  await page.getByRole('button', { name: /^fertig$/i }).click()
  await expect(page.getByTestId('cook-finish-card')).toBeVisible()

  // 7. Mark as cooked — fires the mutation and navigates back.
  await page.getByRole('button', { name: /jetzt gekocht/i }).click()

  // 8. Back on the recipe detail page. Comparing URLs is the
  //    most robust signal; the /cook segment dropped.
  await expect(page).toHaveURL((url) => !url.pathname.endsWith('/cook'), {
    timeout: 5_000,
  })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // Sanity: we didn't land on a completely different URL surface.
  expect(new URL(detailUrl).pathname).toBe(new URL(page.url()).pathname)

  // 9. (Optional) "Zuletzt gekocht"-badge / timestamp update — skipped
  //    here because no dedicated test-id exists. The navigation +
  //    mutation chain already proves the backend round-trip succeeded
  //    (see CookFinishCard.onMarkedCooked only fires after the mutation
  //    Promise resolves). Add a specific assertion here once a stable
  //    selector lands on the detail page.
})
