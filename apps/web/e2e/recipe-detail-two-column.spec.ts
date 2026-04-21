import { expect, test } from '@playwright/test'

/**
 * TABLET-3 — Playwright smoke for the Recipe-Detail two-column layout.
 *
 * Plan requirement (`docs/plans/2026-04-21-tablet-layout-draft.md` §2.4):
 * auf Tablet im Landscape sind Zutaten + Nährwerte links sticky, Steps
 * rechts scrollbar. Dann ist die Zutaten-Liste beim Lesen des letzten
 * Schrittes IMMER noch sichtbar.
 *
 * Flow covered:
 *   1. Login via the home-page form.
 *   2. API-scan the test account's groups + recipes to pick the first
 *      URL-sourced recipe (copy the pattern from `recipe-reimport.spec.ts`
 *      so the test doesn't depend on brittle DOM-first-link semantics).
 *   3. Resize to iPad-portrait (1024×1366) and navigate to the recipe
 *      detail URL.
 *   4. Assert BOTH `data-testid="recipe-detail-left"` and
 *      `recipe-detail-right` are visible — the md:grid kicks in.
 *   5. Scroll the right column by 500 px and assert the "Zutaten"
 *      heading is still visible in the viewport (sticky works).
 *   6. Resize to mobile (390×844) and assert ingredients appear before
 *      steps in DOM order (mobile flow unchanged).
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so the
 * spec stays safe to lint/compile without a live stack. Manual run:
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web exec playwright test --config=playwright.docker.config.ts e2e/recipe-detail-two-column.spec.ts
 */

interface RecipeListItem {
  id: string
  title: string
}

interface RecipeList {
  items: RecipeListItem[]
}

interface RecipeDetail {
  id: string
  sourceUrl: string | null
}

interface GroupListItem {
  id: string
  name: string
}

test('recipe-detail two-column: md:+ sticky-left ingredients, mobile keeps single flow', async ({
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

  // 1. API-login + scan — copy-paste from recipe-reimport.spec.ts. We
  //    prefer a URL-sourced recipe because those tend to carry longer
  //    step lists, which makes the sticky-scroll assertion meaningful.
  //    Any recipe with at least a couple of steps would work in theory.
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  })
  expect(loginRes.status()).toBe(200)
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const authHeader = { Authorization: `Bearer ${accessToken}` }

  const groupsRes = await request.get(`${baseURL}/api/groups`, { headers: authHeader })
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
      const detailRes = await request.get(`${baseURL}/api/recipes/${r.id}`, {
        headers: authHeader,
      })
      if (detailRes.status() !== 200) continue
      const detail = (await detailRes.json()) as RecipeDetail
      if (detail.sourceUrl) {
        target = { groupId: g.id, recipeId: r.id }
        break outer
      }
    }
  }
  if (!target) {
    throw new Error(
      'No URL-sourced recipe found in any group for the test account. ' +
        'Seed one first via POST /api/recipes/import/url followed by a ' +
        'recipe-create from the import result, or POST /api/groups/{id}/recipes ' +
        'with a non-null `sourceUrl` field.',
    )
  }

  // 2. iPad-portrait viewport — 1024×1366 is the primary tablet target
  //    from the draft §Zielgeräte.
  await page.setViewportSize({ width: 1024, height: 1366 })

  // 3. Login in the browser session + navigate straight to the detail.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home|groups)/)
  await page.goto(`/groups/${target.groupId}/recipes/${target.recipeId}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // 4. Both columns are in the DOM and visible at iPad-portrait.
  const leftCol = page.getByTestId('recipe-detail-left')
  const rightCol = page.getByTestId('recipe-detail-right')
  await expect(leftCol).toBeVisible()
  await expect(rightCol).toBeVisible()

  // 5. Zutaten + Zubereitung headings both render.
  const ingredientsHeading = page.getByRole('heading', { name: /^Zutaten/i })
  const stepsHeading = page.getByRole('heading', { name: /^Zubereitung$/i })
  await expect(ingredientsHeading).toBeVisible()
  await expect(stepsHeading).toBeVisible()

  // 6. Scroll the <main> scroll container (AppLayout ships `<main>` as
  //    the sole scroll root — see BUG-039) by 500 px and confirm the
  //    Zutaten heading is still visible in the viewport. Because the
  //    left column is `position: sticky; top: 20px`, the heading stays
  //    pinned at ~20 px from the top of `<main>` regardless of scroll.
  await page.evaluate(() => {
    const main = document.querySelector('main[data-app-shell="true"]')
    if (main) main.scrollTop = 500
  })
  await expect(ingredientsHeading).toBeInViewport()

  // 7. Resize to mobile — single-column flow returns; the md:grid is
  //    inactive (`md:` breakpoint = 768 px in Tailwind defaults). The
  //    ingredients-before-steps invariant still holds because the same
  //    DOM order is used in both zones — the md:+ styles only change
  //    layout, not document position.
  await page.setViewportSize({ width: 390, height: 844 })
  const leftBox = await leftCol.boundingBox()
  const rightBox = await rightCol.boundingBox()
  expect(leftBox).not.toBeNull()
  expect(rightBox).not.toBeNull()
  // At mobile the columns stack (left above right → left.y < right.y).
  if (leftBox && rightBox) {
    expect(leftBox.y).toBeLessThan(rightBox.y)
  }
})
