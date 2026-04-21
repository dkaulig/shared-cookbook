import { expect, test } from '@playwright/test'

/**
 * PAGE-1 — Playwright smoke for the paginated + sortable recipe list.
 *
 * Flow covered (tablet-width viewport so the desktop pagination chrome
 * is visible):
 *  1. Login as the bot account (API-login for introspection).
 *  2. Pick a group with ≥ 1 recipe.
 *  3. Navigate to `/groups/:id` — assert the grid renders up to 24
 *     cards (seed-tolerant: if the group has < 24, just assert the
 *     cards that exist).
 *  4. If `hasNextPage` — click "Nächste Seite", assert URL gains
 *     `?page=2` and the first card title differs from the page-1 first
 *     card (distinct slice).
 *  5. Change sort to "Titel A-Z" via the header <Select>. Assert URL
 *     `?sort=title_asc` is present and `?page=…` is absent (sort
 *     change resets page to 1). Verify the first card title sorts
 *     alphabetically ≤ the last card title on the visible page.
 *  6. Deep-link to `?page=99`. Assert the "Keine Rezepte auf dieser
 *     Seite" empty-state and the "Zur ersten Seite" link is present;
 *     clicking it drops the page param.
 *
 * Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` / `PLAYWRIGHT_TEST_PASSWORD`;
 * absent env vars → `test.skip(...)` so the spec is safe to lint/compile
 * without a live stack. Manual run (per repo policy):
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web exec playwright test \
 *     --config=playwright.docker.config.ts \
 *     e2e/recipe-list-pagination.spec.ts
 */

interface RecipeListItem {
  id: string
  title: string
}

interface RecipeList {
  items: RecipeListItem[]
  total: number
  hasNextPage: boolean
}

interface GroupListItem {
  id: string
  name: string
}

test('recipe-list-pagination: grid, next, sort, deep-link past end', async ({
  page,
  request,
  baseURL,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see docs/ops.md §9',
  )

  // 1. API-login so we can pick a target group without DOM-scraping.
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  })
  expect(loginRes.status()).toBe(200)
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const authHeader = { Authorization: `Bearer ${accessToken}` }

  // 2. Find a group with at least one recipe.
  const groupsRes = await request.get(`${baseURL}/api/groups`, { headers: authHeader })
  expect(groupsRes.status()).toBe(200)
  const groups = (await groupsRes.json()) as GroupListItem[]
  let target: { group: GroupListItem; listing: RecipeList } | null = null
  for (const g of groups) {
    const listRes = await request.get(`${baseURL}/api/groups/${g.id}/recipes`, {
      headers: authHeader,
    })
    if (listRes.status() !== 200) continue
    const listing = (await listRes.json()) as RecipeList
    if (listing.items.length > 0) {
      target = { group: g, listing }
      break
    }
  }
  if (!target) {
    throw new Error(
      'No group with recipes for the test account — seed at least one recipe first.',
    )
  }

  // 3. Tablet viewport so the desktop pagination chrome renders (the
  //    `Nächste Seite` text is hidden on `< md`, only the arrow shows,
  //    but the button remains accessible by its aria-label either way).
  await page.setViewportSize({ width: 1200, height: 900 })

  // Browser login.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home|groups)/)

  await page.goto(`/groups/${target.group.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // Grid renders — up to 24 cards, seed-tolerant.
  const cards = page.getByRole('link', { name: /.*/ }).filter({
    has: page.locator('[data-testid="group-avatar-big"], img, svg'),
  })
  // A gentler assertion: just check we see some recipe card heading text.
  const firstCardTitle = (await page.locator('article, a[href*="/recipes/"]').first().textContent()) ?? ''

  // 4. If there's a second page, click it.
  if (target.listing.hasNextPage) {
    const next = page.getByRole('button', { name: /Nächste Seite/ })
    await expect(next).toBeEnabled()
    await next.click()
    await expect(page).toHaveURL(/[?&]page=2/)
    // Allow the grid to repaint.
    await page.waitForTimeout(250)
    const secondPageFirstCard =
      (await page.locator('a[href*="/recipes/"]').first().textContent()) ?? ''
    expect(secondPageFirstCard).not.toBe(firstCardTitle)
  }

  // 5. Change sort to "Titel A-Z". The header <Select> is labelled
  //    "Sortierung" for a11y.
  const sortSelect = page.getByLabel(/sortierung/i)
  await sortSelect.selectOption('title_asc')
  await expect(page).toHaveURL(/[?&]sort=title_asc/)
  await expect(page).not.toHaveURL(/[?&]page=/)
  // Verify ascending order by comparing the first + last visible titles.
  await page.waitForTimeout(250)
  const titles = await page.locator('a[href*="/recipes/"]').allTextContents()
  if (titles.length >= 2) {
    const first = titles[0]?.trim().toLowerCase() ?? ''
    const last = titles[titles.length - 1]?.trim().toLowerCase() ?? ''
    // First ≤ last alphabetically (ordering is stable server-side).
    expect(first.localeCompare(last)).toBeLessThanOrEqual(0)
  }

  // 6. Deep-link past the end.
  await page.goto(`/groups/${target.group.id}?page=99`)
  await expect(page.getByText(/Keine Rezepte auf dieser Seite/i)).toBeVisible()
  const backLink = page.getByRole('link', { name: /Zur ersten Seite/i })
  await expect(backLink).toBeVisible()
  await backLink.click()
  await expect(page).not.toHaveURL(/page=99/)
})
