import { expect, test } from '@playwright/test'

/**
 * COMP-2 — Playwright smoke for the multi-component import flow.
 *
 * Plan: docs/plans/2026-04-21-recipe-components-design.md — flipside of
 * the COMP-2 frontend slice. Exercises the full stack end-to-end:
 *
 *   1. Login via the home-page form.
 *   2. Pick the caller's first group (API scan).
 *   3. Navigate to the URL-import page and submit the Honey Chipotle
 *      Chicken Quesadilla reel from FB.
 *   4. Wait for the import to complete (status=Done).
 *   5. On the auto-redirect to the recipe-form review page, confirm
 *      that the form flipped to multi-component mode (the extractor
 *      emitted ≥2 components with labels).
 *   6. Save → land on the detail page with per-component <h2> sections
 *      (we expect "Chipotle Sauce" + "Hauptgericht" or similar two-
 *      block copy).
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`. Absent env vars → `test.skip(...)` so the
 * spec stays safe to lint/compile without a live stack. Manual run:
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web exec playwright test --config=playwright.docker.config.ts e2e/recipe-components.spec.ts
 */

interface GroupListItem {
  id: string
  name: string
}

const QUESADILLA_URL = 'https://www.facebook.com/share/r/18eryHkneZ/'

test('recipe-components happy path: import Quesadilla reel → review with 2 components → save → detail grouped render', async ({
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

  // 1. API-login so we can deterministically pick the first group the
  //    account can see.
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  })
  expect(loginRes.status()).toBe(200)
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const authHeader = { Authorization: `Bearer ${accessToken}` }

  const groupsRes = await request.get(`${baseURL}/api/groups`, { headers: authHeader })
  expect(groupsRes.status()).toBe(200)
  const groups = (await groupsRes.json()) as GroupListItem[]
  if (groups.length === 0) {
    throw new Error(
      'Test account has no groups — seed at least one group before running this spec.',
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

  // 3. Kick off the URL import. The URL-import page lives under
  //    `/rezepte/import/url`; we hit it directly instead of clicking
  //    through the nav so the smoke stays deterministic.
  await page.goto(`/rezepte/import/url?groupId=${groupId}`)
  await page
    .getByLabel(/rezept-url|link zum rezept/i)
    .fill(QUESADILLA_URL)
  await page.getByRole('button', { name: /import starten|extrahieren/i }).click()

  // 4. Progress page redirects to a review form on Done. Bound at
  //    120 s per pipeline SLA.
  await page.waitForURL(/\/(rezepte|recipes)\/(new|neu)/, { timeout: 120_000 })

  // 5. Confirm the form is in multi-component mode — the extractor's
  //    two-block Quesadilla caption should surface as two cards. We
  //    assert on the presence of ≥2 `component-label-input-N` inputs.
  const labelInputs = page.getByTestId(/^component-label-input-\d+$/)
  await expect(labelInputs).toHaveCount(2, { timeout: 10_000 })
  // The first component should carry a sauce-y label — the LLM has
  // wiggle room on exact German wording, so we match on "sauce" /
  // "chipotle" substring (case-insensitive).
  const firstLabel = labelInputs.first()
  await expect(firstLabel).toHaveValue(/sauce|chipotle/i)

  // 6. Save → land on the detail page with two grouped sections.
  await page.getByRole('button', { name: /rezept speichern|speichern/i }).click()

  // 7. Detail page loads; per-component <h2>/<h3>s surface. We
  //    assert the component-heading test-id ≥2 times (once per section
  //    × per pane — ingredients + steps each render the heading).
  await page.waitForURL(/\/groups\/.*\/recipes\/[0-9a-f-]+$/, {
    timeout: 10_000,
  })
  const componentHeadings = page.getByTestId('recipe-detail-component-heading')
  // At least 2 distinct component sections render — the exact count
  // depends on whether the detail page renders the heading in both
  // the ingredients pane and the steps pane (4) or just once (2).
  const headingCount = await componentHeadings.count()
  expect(headingCount).toBeGreaterThanOrEqual(2)
})
