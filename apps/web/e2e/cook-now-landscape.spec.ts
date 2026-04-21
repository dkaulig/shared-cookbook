import { expect, test } from '@playwright/test'

/**
 * TABLET-4 — Playwright smoke for the Cook-Now landscape two-pane
 * layout. On iPad landscape (1024×768) both the mise-en-place
 * ingredient list AND the current step card must be visible
 * simultaneously; stepping forward updates only the right pane while
 * the left (mise) stays mounted. Resizing back to portrait (768×1024)
 * returns to the v0.9.0 single-pane tab flow.
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so
 * the spec is safe to lint/compile without a live stack. Manual run:
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web exec playwright test \
 *     --config=playwright.docker.config.ts e2e/cook-now-landscape.spec.ts
 *
 * Seeds: any recipe with ≥ 1 step works — the test just needs to reach
 * step 1 to assert the two-pane visibility.
 */

interface RecipeListItem {
  id: string
  title: string
}

interface RecipeList {
  items: RecipeListItem[]
}

interface GroupListItem {
  id: string
  name: string
}

test('cook-now landscape: mise + step render side-by-side on iPad landscape', async ({
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

  // 1. API-login + scan for any recipe (same pattern as recipe-reimport.spec.ts).
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  })
  expect(loginRes.status()).toBe(200)
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const authHeader = { Authorization: `Bearer ${accessToken}` }

  const groupsRes = await request.get(`${baseURL}/api/groups`, {
    headers: authHeader,
  })
  expect(groupsRes.status()).toBe(200)
  const groups = (await groupsRes.json()) as GroupListItem[]

  let target: { groupId: string; recipeId: string } | null = null
  outer: for (const g of groups) {
    const res = await request.get(`${baseURL}/api/groups/${g.id}/recipes`, {
      headers: authHeader,
    })
    if (res.status() !== 200) continue
    const list = (await res.json()) as RecipeList
    for (const r of list.items) {
      target = { groupId: g.id, recipeId: r.id }
      break outer
    }
  }
  if (!target) {
    throw new Error(
      'No recipe found in any group for the test account. Seed at least one recipe with ≥ 1 step before running this spec.',
    )
  }

  // 2. Start at iPad-landscape viewport so the landscape breakpoint
  //    matches the FIRST render of the cook page, not a post-mount resize.
  await page.setViewportSize({ width: 1024, height: 768 })

  // 3. Login in the browser session + navigate straight to cook mode.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home|groups)/)
  await page.goto(`/groups/${target.groupId}/recipes/${target.recipeId}/cook`)

  // 4. Portions picker → mise-en-place (step 0).
  await expect(page.getByTestId('cook-portions-picker')).toBeVisible()
  await page.getByRole('button', { name: /^weiter$/i }).click()
  await expect(page.getByTestId('cook-mise-en-place')).toBeVisible()

  // 5. Advance to step 1 — on landscape the BOTH panes must now be
  //    visible. In the two-pane layout they live in `cook-pane-mise`
  //    and `cook-pane-step` wrappers.
  await page.getByRole('button', { name: /^weiter$/i }).click()
  await expect(page.getByTestId('cook-step-card')).toBeVisible()
  await expect(page.getByTestId('cook-mise-en-place')).toBeVisible()
  await expect(page.getByText(/Schritt 1 von/i)).toBeVisible()

  // 6. Advance to step 2 (if the recipe has one) — right pane flips,
  //    left pane stays. Skip gracefully if the recipe only has 1 step.
  const weiter = page.getByRole('button', { name: /^weiter$/i })
  if ((await weiter.count()) > 0) {
    await weiter.first().click()
    await expect(page.getByTestId('cook-mise-en-place')).toBeVisible()
  }

  // 7. Rotate to portrait — the layout must fall back to single-pane
  //    tab flow. Right pane (step card) stays visible; left pane
  //    (mise-en-place) must no longer be mounted simultaneously.
  await page.setViewportSize({ width: 768, height: 1024 })
  await expect(page.getByTestId('cook-step-card')).toBeVisible()
  await expect(page.getByTestId('cook-mise-en-place')).toHaveCount(0)
})
