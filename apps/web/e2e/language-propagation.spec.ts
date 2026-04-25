import { expect, test } from '@playwright/test'

/**
 * POLISH-1 / LANG-1 — language-toggle propagation smoke.
 *
 * The language directive on the extractor side is only as good as the
 * web side actually telling the backend which language was picked.
 * The API client reads `i18n.language` and sets ``Accept-Language``
 * on every fetch (`apps/web/src/features/auth/apiClient.ts`); the
 * .NET API forwards it onto the python-extractor; the extractor's
 * `normalize_accept_language` boils the header down to ``"de"`` or
 * ``"en"`` and routes through `apply_language_directive`.
 *
 * This spec covers the FRONT half of that chain end-to-end against
 * the real docker stack:
 *
 *   1. Login as the bot account.
 *   2. Visit /profil where the LanguageToggle lives.
 *   3. Pick "English" → assert UI flips (DE "Sprache" → EN "Language")
 *      AND localStorage["i18nextLng"] now reads "en".
 *   4. Trigger any authenticated GET (navigate to /gruppen) and
 *      assert the network request carries `Accept-Language: en*`.
 *   5. Toggle back to "Deutsch" → assert UI + localStorage flip
 *      back AND the next API call carries `Accept-Language: de*`.
 *
 * Why no full URL-import + LLM-response assertion? The full chain
 * lives behind Azure / Ollama costs + non-determinism, so an E2E
 * assertion against the LLM output is flaky AND expensive. The
 * unit-tests at `apps/python-extractor/tests/test_language_directive.py`
 * cover the deterministic prompt-shape contract; this spec only
 * needs to prove the WEB side ships the right header so the LLM ever
 * sees a non-DE request to begin with. That gap is the regression
 * window the user actually hits in the field.
 *
 * Credentials-gated via PLAYWRIGHT_TEST_EMAIL / _PASSWORD; absent env
 * vars → `test.skip` so the spec is safe to lint/compile without a
 * live stack. Manual run:
 *
 *   docker compose up -d
 *   PLAYWRIGHT_TEST_EMAIL=orchestrator@EXAMPLE_HOST
 *   PLAYWRIGHT_TEST_PASSWORD=<value-from-.env>
 *   pnpm --filter web exec playwright test \
 *     --config=playwright.docker.config.ts language-propagation.spec.ts
 */

test('language toggle propagates to UI + localStorage + Accept-Language header', async ({
  page,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only',
  )

  // 1. Login flow — same shape as cook-now.spec.ts, no shortcuts.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home)/)

  // Pin DE first so the test runs deterministically regardless of
  // whatever localStorage persisted from a previous session.
  await page.evaluate(() => {
    window.localStorage.setItem('i18nextLng', 'de')
  })
  await page.reload()
  await page.waitForLoadState('networkidle')

  // 2. Navigate to /profil where LanguageToggle is mounted.
  await page.goto('/profil')
  await page.waitForLoadState('networkidle')

  // 3. Open the toggle and pick English.
  const toggle = page.getByRole('button', { name: /sprache/i }).first()
  await toggle.click()
  await page
    .getByRole('menuitemradio', { name: /english/i })
    .click()

  // UI re-renders; the heading copy should now read "Language" instead
  // of "Sprache". Use a flexible regex because the same word lives in
  // a few card headings + the menu trigger's aria-label.
  await expect(
    page.getByRole('heading', { name: /^language$/i }).first(),
  ).toBeVisible({ timeout: 5_000 })

  // localStorage carries the persisted choice — that's how the API
  // client will see `i18n.language === 'en'` on the very next mount.
  const persistedAfterEn = await page.evaluate(() =>
    window.localStorage.getItem('i18nextLng'),
  )
  expect(persistedAfterEn).toMatch(/^en/i)

  // 4. Trigger an authenticated GET and snoop the request header.
  // We use waitForRequest BEFORE the navigation so the listener is
  // installed in time; /api/groups/mine fires from the GroupsList page.
  const apiAfterEn = page.waitForRequest(
    (req) => req.url().includes('/api/') && req.method() === 'GET',
  )
  await page.goto('/gruppen')
  const reqAfterEn = await apiAfterEn
  expect(reqAfterEn.headers()['accept-language'] ?? '').toMatch(/^en/i)

  // 5. Toggle back to DE and re-verify.
  await page.goto('/profil')
  await page.waitForLoadState('networkidle')
  // The button's aria-label is now in EN (`Language`) — match either.
  const toggleEn = page
    .getByRole('button', { name: /^language$/i })
    .first()
  await toggleEn.click()
  await page.getByRole('menuitemradio', { name: /deutsch/i }).click()

  await expect(
    page.getByRole('heading', { name: /^sprache$/i }).first(),
  ).toBeVisible({ timeout: 5_000 })

  const persistedAfterDe = await page.evaluate(() =>
    window.localStorage.getItem('i18nextLng'),
  )
  expect(persistedAfterDe).toMatch(/^de/i)

  const apiAfterDe = page.waitForRequest(
    (req) => req.url().includes('/api/') && req.method() === 'GET',
  )
  await page.goto('/gruppen')
  const reqAfterDe = await apiAfterDe
  expect(reqAfterDe.headers()['accept-language'] ?? '').toMatch(/^de/i)
})
