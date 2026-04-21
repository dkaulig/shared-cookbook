import { expect, test } from '@playwright/test'

/**
 * TABLET-1 — Playwright smoke for the GroupDetail split-view.
 *
 * Verifies the tablet/desktop two-column behaviour wired by the new
 * `<SplitPane />` primitive plus the nested `/groups/:id/recipes/:recipeId`
 * route:
 *
 *  - At ≥ md (1000 px tablet zone): both `<section aria-label="Rezept-Liste">`
 *    and `<section aria-label="Rezept-Detail">` are visible. Before a
 *    recipe is selected, the detail slot shows the German empty-state
 *    prompt. Clicking a recipe card in the list updates the URL to
 *    `/groups/:id/recipes/:recipeId` and swaps the empty state for the
 *    actual recipe-detail surface.
 *
 *  - At < md (400 px mobile): the split collapses; the recipe list is
 *    the only visible surface at `/groups/:id`, and navigating to a
 *    recipe URL (`/groups/:id/recipes/:recipeId`) replaces `<main>`
 *    with the detail page as in the pre-TABLET-1 flow.
 *
 * Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` / `PLAYWRIGHT_TEST_PASSWORD`;
 * absent env vars → `test.skip(...)` so the spec is safe to lint/compile
 * without a live stack. Manual run:
 *
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web test:e2e
 */

test('group-detail-split: SplitPane renders at md+, collapses at < md', async ({
  page,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see docs/ops.md §9',
  )

  // Start at tablet-landscape width (1000 px) so the first assertion
  // lands in the `md:+` zone where the SplitPane is active.
  await page.setViewportSize({ width: 1000, height: 1200 })

  // 1. Login — mirrors cook-now / offline / tablet-foundation flow.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home)/)

  // 2. Land on the Groups index and open the first group.
  await page.goto('/groups')
  const firstGroupCard = page
    .getByRole('link', { name: /öffnen|gruppe|gruppen-karte/i })
    .first()
  await firstGroupCard.click()
  await page.waitForURL(/\/groups\/[^/]+$/)

  const listPane = page.getByRole('region', { name: /rezept-liste/i })
  const detailPane = page.getByRole('region', { name: /rezept-detail/i })

  // 3. Tablet zone (1000 px) — both panes visible, detail slot shows
  //    the German empty-state prompt.
  await expect(listPane).toBeVisible()
  await expect(detailPane).toBeVisible()
  await expect(detailPane).toContainText(/Wähle ein Rezept/i)

  // 4. Click the first recipe card in the list pane. URL should move
  //    to the nested variant and the detail slot should lose the
  //    empty-state prompt.
  const firstRecipeLink = listPane.locator('a[href*="/recipes/"]').first()
  await firstRecipeLink.click()
  await page.waitForURL(/\/groups\/[^/]+\/recipes\/[^/]+$/)
  await expect(detailPane).not.toContainText(/Wähle ein Rezept/i)

  // 5. Mobile zone (400 px) — SplitPane collapses. Back-navigate to the
  //    group index so we're not in the middle of a detail view when
  //    the resize fires.
  const [groupUrl] = page.url().match(/^[^?]+\/groups\/[^/]+/) ?? []
  if (groupUrl) await page.goto(groupUrl)
  await page.setViewportSize({ width: 400, height: 900 })
  await expect(listPane).toBeHidden({ timeout: 2000 }).catch(() => {
    // At < md the SplitPane regions are removed from the DOM entirely
    // (useIsMobile → mobile branch), so `toBeHidden` may fail. Fallback
    // assertion: the region locator has no matches.
  })
  // Region locators resolve to zero elements when the mobile branch
  // replaces the SplitPane.
  await expect(listPane).toHaveCount(0)
  await expect(detailPane).toHaveCount(0)
})
