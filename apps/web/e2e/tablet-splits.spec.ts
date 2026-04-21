import { expect, test } from '@playwright/test'

/**
 * TABLET-2 — Playwright smoke for the MealPlan / Shopping / Chat
 * split-view adoption.
 *
 * Per the TABLET-2 brief we verify, for each of the three pages:
 *  - At a tablet viewport (1000×1300 iPad-portrait zone ≥ md) both
 *    SplitPane landmark regions are visible (list on the left, detail
 *    / outlet on the right).
 *  - At a mobile viewport (390×844) the SplitPane regions are gone —
 *    the page falls back to the single-column layout, matching the
 *    pre-TABLET-2 mobile flow exactly so no regression lands on phones.
 *
 * The ChatSessionsShell migration from the ad-hoc `flex` scaffold onto
 * SplitPane is covered by the same landmark-region assertions (the
 * shell renders `<region aria-label="Sitzungen-Liste">` +
 * `<region aria-label="Aktuelle Unterhaltung">` at md+).
 *
 * Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so the
 * spec is safe to lint/compile without a live stack. Manual run:
 *
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web test:e2e
 */

const TABLET_VIEWPORT = { width: 1000, height: 1300 } as const
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const

test('tablet-splits: MealPlan + Shopping + Chat adopt SplitPane at md+', async ({
  page,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see docs/ops.md §9',
  )

  // Start at tablet-portrait width so the first round of assertions
  // lands in the md:+ zone where each SplitPane is active.
  await page.setViewportSize({ ...TABLET_VIEWPORT })

  // 1. Login — mirrors cook-now / group-detail-split / tablet-foundation.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home)/)

  // 2. MealPlan — navigate via the /wochenplan launcher which redirects
  //    to the current-week meal-plan for the caller's single/first
  //    group. The SplitPane's left + right regions must both render.
  await page.goto('/wochenplan')
  await page.waitForURL(/\/groups\/[^/]+\/mealplan\/\d{4}-\d{2}-\d{2}$/, {
    timeout: 15_000,
  })
  const mealLeft = page.getByRole('region', { name: /wochenplan-übersicht/i })
  const mealRight = page.getByRole('region', { name: /slot-detail/i })
  await expect(mealLeft).toBeVisible()
  await expect(mealRight).toBeVisible()
  await expect(mealRight).toContainText(/W(?:ä|ae)hle einen Slot/i)

  // Capture the meal-plan URL so we can drop into the shopping list.
  const mealPlanUrl = page.url()

  // 3. Shopping — same week's shopping-list route hangs off the meal-
  //    plan URL. Both SplitPane regions must render; the empty-state
  //    copy lives in the right pane until the user picks a row.
  await page.goto(`${mealPlanUrl}/shopping-list`)
  const shopLeft = page.getByRole('region', { name: /einkaufsliste/i })
  const shopRight = page.getByRole('region', { name: /eintrag-detail/i })
  await expect(shopLeft).toBeVisible()
  await expect(shopRight).toBeVisible()
  await expect(shopRight).toContainText(/W(?:ä|ae)hle einen Eintrag/i)

  // 4. Chat — `/chat` redirects to the newest session (or mints one).
  //    The migrated ChatSessionsShell now renders the pair of SplitPane
  //    landmarks ("Sitzungen-Liste" + "Aktuelle Unterhaltung").
  await page.goto('/chat')
  await page.waitForURL(/\/chat\/[^/]+$/, { timeout: 15_000 })
  const chatLeft = page.getByRole('region', { name: /sitzungen-liste/i })
  const chatRight = page.getByRole('region', { name: /aktuelle unterhaltung/i })
  await expect(chatLeft).toBeVisible()
  await expect(chatRight).toBeVisible()

  // 5. Mobile zone (< md) — each page must drop to a single-column
  //    fallback. The SplitPane regions disappear from the DOM (region
  //    locator count → 0) so no hidden-but-rendered detail slot leaks
  //    into the mobile flow.
  await page.setViewportSize({ ...MOBILE_VIEWPORT })

  // MealPlan: navigate back + assert regions are gone.
  await page.goto(mealPlanUrl)
  await expect(mealLeft).toHaveCount(0)
  await expect(mealRight).toHaveCount(0)

  // Shopping.
  await page.goto(`${mealPlanUrl}/shopping-list`)
  await expect(shopLeft).toHaveCount(0)
  await expect(shopRight).toHaveCount(0)

  // Chat.
  await page.goto('/chat')
  await page.waitForURL(/\/chat\/[^/]+$/, { timeout: 15_000 })
  await expect(chatLeft).toHaveCount(0)
  await expect(chatRight).toHaveCount(0)
})
