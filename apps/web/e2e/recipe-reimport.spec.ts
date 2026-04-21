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
 *   1. Login via the home-page form.
 *   2. API-scan the test account's groups + recipes to pick the first
 *      URL-sourced recipe (deterministic, no brittle DOM-first-link
 *      logic). Fails fast with a clear message if none is seeded.
 *   3. Navigate straight to the recipe detail URL.
 *   4. Open 3-dots menu; click "Neu importieren".
 *   5. Confirm-dialog appears; click "Reimport starten".
 *   6. Assert navigation to `/rezepte/import/:id` + reimport banner.
 *   7. Poll for `status=Done` — the page auto-redirects back to the
 *      recipe detail thanks to the REIMPORT-1 `targetRecipeId` branch.
 *   8. Optional success-toast check.
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so the
 * spec stays safe to lint/compile without a live stack. Manual run:
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web exec playwright test --config=playwright.docker.config.ts e2e/recipe-reimport.spec.ts
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

test('recipe-reimport happy path: detail → confirm → progress → back to detail', async ({
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

  // 1. API-login so we can scan groups + recipes without fighting DOM
  //    first-link semantics. The browser session logs in separately in
  //    step 2 — the two sessions don't share cookies but both auth
  //    against the same seeded account.
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  })
  expect(loginRes.status()).toBe(200)
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const authHeader = { Authorization: `Bearer ${accessToken}` }

  // 2. Scan groups → pick the first recipe that has a `sourceUrl` set.
  //    Fails fast if none — tells the caller exactly what to seed.
  const groupsRes = await request.get(`${baseURL}/api/groups`, { headers: authHeader })
  expect(groupsRes.status()).toBe(200)
  const groups = (await groupsRes.json()) as GroupListItem[]
  // The list endpoint doesn't expose `sourceUrl`; we have to fetch each
  // recipe's detail to check it. First match wins. 1 extra HTTP call per
  // recipe but the test seed is small (≤1–2 recipes).
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

  // 3. Pin the viewport to a mobile width so the TABLET-1 split-view
  //    doesn't render two h1s (group name left, recipe title right) —
  //    the reimport menu is primarily a mobile affordance anyway.
  await page.setViewportSize({ width: 390, height: 844 })

  // 4. Login in the browser session, then navigate straight to the
  //    recipe detail URL.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home|groups)/)
  await page.goto(`/groups/${target.groupId}/recipes/${target.recipeId}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const detailUrl = page.url()

  // 4. Open the 3-dots menu → "Neu importieren".
  await page.getByRole('button', { name: /^Mehr$/i }).click()
  const reimportEntry = page.getByRole('menuitem', { name: /Neu importieren/i })
  await expect(reimportEntry).toBeVisible()
  await reimportEntry.click()

  // 5. Confirm dialog.
  await expect(
    page.getByRole('heading', { name: /Rezept neu importieren\?/i }),
  ).toBeVisible()
  await page.getByRole('button', { name: /Reimport starten/i }).click()

  // 6. Landed on the progress page + reimport banner visible.
  await page.waitForURL(/\/rezepte\/import\//, { timeout: 10_000 })
  await expect(page.getByTestId('reimport-running-banner')).toBeVisible({
    timeout: 10_000,
  })

  // 7. Poll for status=done — the page auto-redirects back to the detail
  //    page via the REIMPORT-1 branch once the wire lands `status=Done`
  //    with targetRecipeId set. Bound at 120 s per plan §5.
  await page.waitForURL(
    (url) => url.pathname.includes('/recipes/') && !url.pathname.endsWith('/cook'),
    { timeout: 120_000 },
  )

  // 8. Back on a recipe detail page — URL pathname matches the original
  //    detail route (same recipe id, since reimport updates in place).
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(new URL(detailUrl).pathname).toBe(new URL(page.url()).pathname)

  // 9. Optional success-toast check — tolerated if it already faded.
  const toast = page.getByRole('status').filter({
    hasText: /rezept erfolgreich aktualisiert/i,
  })
  if ((await toast.count()) > 0) {
    await expect(toast.first()).toBeVisible()
  }
})
