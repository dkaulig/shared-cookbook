import { expect, test } from '@playwright/test'

/**
 * REL-5 — Playwright E2E guard against silent save-failures.
 *
 * Plan: docs/plans/2026-04-22-open-source-release-plan.md §8
 * "Frontend error-UX gap — save failures are invisible".
 *
 * Concrete BUG-044-style regression: an invalid-payload mutation
 * (here: a shopping-list item patched to an invalid quantity value, or
 * intercepted at the network layer to 500) must surface a user-visible
 * error — NOT a phantom success where the UI reverts without
 * explanation.
 *
 * Flow covered:
 *   1. Login via the home-page form using the bot account.
 *   2. Navigate directly into the Rezept-Erstellen form.
 *   3. Force the POST /api/groups/:g/recipes mutation to return a 500
 *      via `page.route(...)`.
 *   4. Fill the form with a minimum-valid payload + submit.
 *   5. Assert that an error surface (inline <p role="alert"> banner OR
 *      the global error-toast host) shows up with the German copy.
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so the
 * spec stays safe to lint/compile without a live stack. Manual run:
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=orchestrator@EXAMPLE_HOST
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web exec playwright test \
 *     --config=playwright.docker.config.ts \
 *     e2e/error-ux-silent-failure.spec.ts
 */

interface GroupListItem {
  id: string
  name: string
}

test('recipe-create 500 surfaces a user-visible error (REL-5 silent-failure guard)', async ({
  page,
  request,
  baseURL,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see CLAUDE.md Local-E2E section',
  )

  // 1. API-login so we can deterministically pick the first group the
  //    account sees.
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  })
  expect(loginRes.status()).toBe(200)
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const groupsRes = await request.get(`${baseURL}/api/groups`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  expect(groupsRes.status()).toBe(200)
  const groups = (await groupsRes.json()) as GroupListItem[]
  if (groups.length === 0) {
    throw new Error(
      'Bot account has no groups — seed at least one group before running this spec.',
    )
  }
  const groupId = groups[0]!.id

  // 2. Browser login.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home|groups)/)

  // 3. Hijack the create-recipe POST so it 500s. We match on method +
  //    URL so only the create-mutation is affected; loads of the form
  //    (GET group / tags) go through untouched.
  await page.route(
    (url) =>
      url.pathname === `/api/groups/${groupId}/recipes` &&
      url.hostname !== '' /* allow any host */,
    (route, req) => {
      if (req.method() === 'POST') {
        return route.fulfill({
          status: 500,
          contentType: 'text/plain',
          body: 'Internal Server Error',
        })
      }
      return route.continue()
    },
  )

  // 4. Navigate straight to the create form.
  await page.goto(`/groups/${groupId}/recipes/new`)

  // Fill the minimum fields the form validates before POSTing. The
  // RecipeFormPage's client-side guard demands title + >=1 ingredient
  // name + >=1 step content; anything less short-circuits with an
  // inline "Titel ist erforderlich" / "Mindestens eine Zutat" message
  // and never reaches the network. We satisfy the guard so the POST
  // actually fires and the 500 route handler kicks in.
  await page
    .getByRole('textbox', { name: /titel|name/i })
    .first()
    .fill('Silent-failure E2E probe')

  // First ingredient row — the form ships with one blank row; fill
  // its name field. The row's inputs don't carry aria-labels so we
  // hit them positionally from the ingredient grid.
  const ingredientNameInput = page
    .getByPlaceholder(/zutat|name/i)
    .filter({ hasNot: page.locator('[disabled]') })
    .first()
  if (await ingredientNameInput.count()) {
    await ingredientNameInput.fill('Salz')
  }
  // First step row.
  const stepInput = page
    .getByPlaceholder(/schritt|zubereitung/i)
    .filter({ hasNot: page.locator('[disabled]') })
    .first()
  if (await stepInput.count()) {
    await stepInput.fill('Alles vermengen.')
  }

  // Submit. The form's action-bar Speichern button lives in the shared
  // bottom-zone slot. The visible submit button carries "Speichern" /
  // "Rezept speichern" — pick the first match that's enabled.
  await page.getByRole('button', { name: /speichern/i }).first().click()

  // 5. Either the inline form banner (role=alert inside the form) or
  //    the global toast host must carry the error. Previous behaviour:
  //    the POST 500'd, the page silently stayed on the form with no
  //    feedback. Post-REL-5: the inline banner OR the toast host
  //    surfaces "Unbekannter Fehler" (toast copy) OR "konnte nicht
  //    gespeichert" (inline copy).
  const alertLocator = page
    .getByRole('alert')
    .filter({ hasText: /unbekannter fehler|konnte nicht gespeichert/i })
  await expect(alertLocator.first()).toBeVisible({ timeout: 10_000 })
})
