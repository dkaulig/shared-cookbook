import { expect, test } from '@playwright/test'

/**
 * AI-Normalize Toggle — Playwright E2E for the URL-import "Mit AI verfeinern"
 * checkbox (`docs/plans/2026-04-27-ai-normalize-toggle-design.md`).
 *
 * Three scenarios in this spec:
 *
 *   Scenario 1 — Cred-gated. URL-import page renders the checkbox,
 *     unchecked by default, with the German hint text. Skips the
 *     enabled-state assertion if the dev stack reports
 *     `features.ai.enabled === false`.
 *   Scenario 2 — Cred + AZURE_OPENAI_API_KEY-gated. Toggle ON, import
 *     a known English food blog (pinchofyum gochujang noodles), wait
 *     for the import to settle, assert the prefilled recipe-form has
 *     German ingredient names + metric units and no English residue.
 *   Scenario 3 — Cred-gated, no Azure key needed. Toggle OFF (default),
 *     same URL → English ingredient name preserved, metric quantities
 *     via the `_translate_unit` BUG-030 safety net, AND no per-row
 *     `note` carrying the original imperial line (regression guard for
 *     bcebc99).
 *
 * After import completes the production flow redirects to the
 * RecipeFormPage at `/groups/:groupId/recipes/new?importId=...` where
 * the extracted ingredients are pre-filled into editable rows. We
 * assert against those input values rather than the saved-recipe
 * detail page — saving + navigating to detail would add work outside
 * the toggle's contract and slow the test down.
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so
 * the spec stays safe to lint/compile without a live stack. Per
 * CLAUDE.md "E2E auth via bot account" we login as the orchestrator
 * bot (`Role=User`) — admin would bypass the AI-feature gate's
 * group-membership permissions and hide regressions.
 *
 * Manual run (requires `docker compose up -d`):
 *
 *   PLAYWRIGHT_TEST_EMAIL=orchestrator@example.com \
 *   PLAYWRIGHT_TEST_PASSWORD=<value-from-.env> \
 *   AZURE_OPENAI_API_KEY=<from-apps/python-extractor/.env> \
 *   pnpm --filter web exec playwright test \
 *     --config=playwright.docker.config.ts \
 *     e2e/url-import-ai-normalize.spec.ts
 *
 * If `AZURE_OPENAI_API_KEY` is missing scenarios 1 + 3 still run;
 * scenario 2 skips cleanly with a reason string.
 */

// pinchofyum URL the user provided when reporting the bcebc99
// duplicate-note bug. Reused here so scenario 2 + 3 share the same
// JSON-LD source-of-truth — toggle ON vs. toggle OFF should produce
// observably different rendered ingredients.
const PINCHOFYUM_URL = 'https://pinchofyum.com/saucy-gochujang-noodles-with-chicken'

const EMAIL = process.env.PLAYWRIGHT_TEST_EMAIL
const PASSWORD = process.env.PLAYWRIGHT_TEST_PASSWORD

interface GroupListItem {
  id: string
  name: string
}

interface FeaturesProbe {
  ai: { enabled: boolean }
}

interface ImportEnqueueResponse {
  importId: string
}

interface ImportStatusResponse {
  id: string
  groupId: string
  status: string
}

/**
 * Pin the i18next locale to German for the whole spec.
 *
 * The bundle resolves locale via i18next-browser-languagedetector,
 * which reads `localStorage.i18nextLng` first. A fresh Chromium
 * profile under Playwright has no entry there → it falls through to
 * `navigator.language` (often `en-US` on the test runner). Pinning
 * to `de` keeps every i18n-bound surface — login labels, form
 * aria-labels we assert against — in the canonical UI state CLAUDE.md
 * declares ("All user-facing strings are German").
 */
async function pinGermanLocale(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('i18nextLng', 'de')
    } catch {
      /* private-mode storage refusal — i18next falls back to navigator */
    }
  })
}

/**
 * Login the browser via the on-page form. Mirrors the pattern in
 * `recipe-reimport.spec.ts` so reviewers don't have to learn a new
 * helper for one-off use across two specs.
 */
async function loginUI(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
) {
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email)
  await page.getByLabel(/passwort/i).fill(password)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home|groups)/)
}

/**
 * Enqueue an import via the same `POST /api/recipes/import/url`
 * endpoint the URL-import page hits. Going API-first instead of
 * driving the form keeps the toggle the only variable across
 * scenarios — the UI surface itself is exercised in scenario 1.
 */
async function enqueueImport(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
  authHeader: Record<string, string>,
  groupId: string,
  body: { url: string; aiNormalize: boolean },
): Promise<{ importId: string }> {
  // Always send `force: true` so the 7-day URL-cache cannot serve a
  // result from a previous run with a different toggle state. Without
  // this guard the second scenario would re-render the first scenario's
  // cached extraction and fail the per-scenario contract.
  //
  // Accept-Language: de mirrors what the German UI sends. The .NET
  // import row stores it as `RequestedLanguage` and forwards it to the
  // Python extractor, where `apply_language_directive(prompt, "de")`
  // tells the LLM to emit German strings. Without this header the
  // default is "en" and the AI-normalize toggle would translate to
  // English (a real bug we'd otherwise miss).
  const res = await request.post(`${baseURL}/api/recipes/import/url`, {
    headers: { ...authHeader, 'Accept-Language': 'de' },
    data: { ...body, groupId, force: true },
  })
  expect(res.status()).toBe(202)
  const { importId } = (await res.json()) as ImportEnqueueResponse
  return { importId }
}

async function waitForImportDone(
  request: import('@playwright/test').APIRequestContext,
  baseURL: string,
  authHeader: Record<string, string>,
  importId: string,
  timeoutMs: number,
): Promise<ImportStatusResponse> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 'unknown'
  while (Date.now() < deadline) {
    const res = await request.get(
      `${baseURL}/api/imports/${encodeURIComponent(importId)}`,
      { headers: authHeader },
    )
    if (res.status() === 200) {
      const body = (await res.json()) as ImportStatusResponse
      lastStatus = body.status.toLowerCase()
      if (lastStatus === 'done') return body
      if (lastStatus === 'error') {
        throw new Error(
          `Import ${importId} ended in error state — see api logs. ` +
            `Last status: ${body.status}`,
        )
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(
    `Import ${importId} did not reach status=done within ${timeoutMs} ms ` +
      `(last seen: ${lastStatus}).`,
  )
}

test.describe('AI-Normalize toggle on URL-import', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see CLAUDE.md Local-E2E section',
  )

  test('Scenario 1 — checkbox visible, default-off, hint text rendered', async ({
    page,
    request,
    baseURL,
  }) => {
    await pinGermanLocale(page)
    await loginUI(page, EMAIL!, PASSWORD!)
    await page.goto('/rezepte/import/url')

    const checkbox = page.getByRole('checkbox', {
      name: /Mit AI verfeinern \(für englische Blogs\)/i,
    })
    await expect(checkbox).toBeVisible()
    await expect(checkbox).not.toBeChecked()

    const hint = page.getByTestId('import-url-ai-normalize-hint')
    await expect(hint).toBeVisible()

    // The hint text branches on `features.ai.enabled`. Probe the same
    // endpoint the page does so we assert against whichever copy
    // *should* render — without re-implementing the gate logic.
    const featuresRes = await request.get(`${baseURL}/api/meta/features`)
    expect(featuresRes.status()).toBe(200)
    const features = (await featuresRes.json()) as FeaturesProbe

    if (features.ai.enabled) {
      await expect(hint).toContainText(
        'Übersetzt das Rezept und normalisiert Mengen. Kostet AI-Tokens und dauert ~10 s länger.',
      )
      await expect(checkbox).toBeEnabled()
    } else {
      await expect(hint).toContainText(
        'Nicht verfügbar — kein AI-Provider konfiguriert.',
      )
      await expect(checkbox).toBeDisabled()
    }
  })

  test('Scenario 2 — toggle ON yields German ingredients + metric quantities', async ({
    page,
    request,
    baseURL,
  }) => {
    test.skip(
      !process.env.AZURE_OPENAI_API_KEY,
      'AZURE_OPENAI_API_KEY not set — toggle-on scenario requires a live LLM provider',
    )

    // The Azure key in the runner's env is necessary but not sufficient —
    // the dev compose-stack only routes through Azure when the API+
    // extractor were started with `LLM_PROVIDER=azure` + `AI_ENABLED=true`
    // in `.env`. The features endpoint is the canonical truth of what
    // the running services believe. If it reports `ai.enabled === false`
    // the strict-normalize prompt path is unreachable end-to-end and
    // there's nothing to assert.
    const featuresRes = await request.get(`${baseURL}/api/meta/features`)
    expect(featuresRes.status()).toBe(200)
    const features = (await featuresRes.json()) as FeaturesProbe
    test.skip(
      !features.ai.enabled,
      'Server reports ai.enabled=false — set AI_ENABLED=true + LLM_PROVIDER=azure in .env and restart api+python-extractor before running scenario 2',
    )

    // 1. API-login so we can pick a group + drive the import directly
    //    (see `enqueueImport`'s why-API-not-UI rationale).
    const loginRes = await request.post(`${baseURL}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    })
    expect(loginRes.status()).toBe(200)
    const { accessToken } = (await loginRes.json()) as { accessToken: string }
    const authHeader = { Authorization: `Bearer ${accessToken}` }

    // 2. First group for the bot — the orchestrator-seed creates at
    //    least one (the private collection), so taking [0] is safe.
    const groupsRes = await request.get(`${baseURL}/api/groups`, {
      headers: authHeader,
    })
    expect(groupsRes.status()).toBe(200)
    const groups = (await groupsRes.json()) as GroupListItem[]
    expect(groups.length).toBeGreaterThan(0)
    const groupId = groups[0]!.id

    // 3. Enqueue with the toggle ON. The strict-normalize prompt + LLM
    //    call adds ~10 s on top of the JSON-LD-direct path; budget 90 s
    //    so a slow Azure region doesn't flake.
    const { importId } = await enqueueImport(request, baseURL, authHeader, groupId, {
      url: PINCHOFYUM_URL,
      aiNormalize: true,
    })
    const done = await waitForImportDone(request, baseURL, authHeader, importId, 90_000)

    // 4. Login the browser session and navigate to the same redirect
    //    target the production progress-page would take the user to.
    await pinGermanLocale(page)
    await loginUI(page, EMAIL!, PASSWORD!)
    await page.goto(
      `/groups/${done.groupId}/recipes/new?importId=${encodeURIComponent(importId)}`,
    )
    await expect(page.getByLabel(/Zutat 1 Name/i)).toBeVisible({ timeout: 10_000 })

    // 5. At least one ingredient name should be a German food term.
    //    The prompt is lenient about exact wording so we widen the
    //    regex across plausible normalisations.
    const allIngredientInputs = page.locator(
      'input[aria-label^="Zutat "][aria-label$=" Name"]',
    )
    const ingredientCount = await allIngredientInputs.count()
    expect(ingredientCount).toBeGreaterThan(0)
    const ingredientValues = await allIngredientInputs.evaluateAll((els) =>
      (els as HTMLInputElement[]).map((el) => el.value),
    )
    const germanTerms =
      /Hähnchen|Hackfleisch|Sojasauce|Knoblauch|Sesamöl|Tomatenmark|Erdnussbutter|Frühlingszwiebel|Ingwer|Reisessig|Zucker|Salz|Pfeffer|Nudeln|Öl/i
    const hasGerman = ingredientValues.some((v) => germanTerms.test(v))
    expect(
      hasGerman,
      `Expected at least one German ingredient name, got: ${ingredientValues.join(' | ')}`,
    ).toBe(true)

    // 6. No English residue. "ground chicken" is the canonical pinchofyum
    //    headline ingredient that should be translated away.
    const englishResidue = ingredientValues.filter((v) => /ground chicken/i.test(v))
    expect(
      englishResidue,
      `Found English residue in ingredient names after AI-normalize: ${englishResidue.join(' | ')}`,
    ).toEqual([])

    // 7. Quantities are metric. The unit-select options are German
    //    canonical (`g`, `ml`, `EL`, `TL`, `Stück`); imperial labels
    //    aren't in the option list at all, so we assert no row's
    //    selected unit string contains an imperial token.
    const unitSelects = page.locator(
      'select[aria-label^="Zutat "][aria-label$=" Einheit"]',
    )
    const unitValues = await unitSelects.evaluateAll((els) =>
      (els as HTMLSelectElement[]).map((el) => el.value),
    )
    const imperialUnits = unitValues.filter((u) =>
      /pound|cup|tbsp|tsp|ounce/i.test(u),
    )
    expect(imperialUnits, `Imperial units leaked through: ${imperialUnits.join(', ')}`).toEqual(
      [],
    )
  })

  test('Scenario 3 — toggle OFF keeps English names + metric units, no note duplication', async ({
    page,
    request,
    baseURL,
  }) => {
    // No Azure key gate — JSON-LD-direct path runs locally.
    const loginRes = await request.post(`${baseURL}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    })
    expect(loginRes.status()).toBe(200)
    const { accessToken } = (await loginRes.json()) as { accessToken: string }
    const authHeader = { Authorization: `Bearer ${accessToken}` }

    const groupsRes = await request.get(`${baseURL}/api/groups`, {
      headers: authHeader,
    })
    expect(groupsRes.status()).toBe(200)
    const groups = (await groupsRes.json()) as GroupListItem[]
    expect(groups.length).toBeGreaterThan(0)
    const groupId = groups[0]!.id

    const { importId } = await enqueueImport(request, baseURL, authHeader, groupId, {
      url: PINCHOFYUM_URL,
      aiNormalize: false,
    })
    const done = await waitForImportDone(request, baseURL, authHeader, importId, 60_000)

    await pinGermanLocale(page)
    await loginUI(page, EMAIL!, PASSWORD!)
    await page.goto(
      `/groups/${done.groupId}/recipes/new?importId=${encodeURIComponent(importId)}`,
    )
    await expect(page.getByLabel(/Zutat 1 Name/i)).toBeVisible({ timeout: 10_000 })

    const nameInputs = page.locator(
      'input[aria-label^="Zutat "][aria-label$=" Name"]',
    )
    const ingredientValues = await nameInputs.evaluateAll((els) =>
      (els as HTMLInputElement[]).map((el) => el.value),
    )
    expect(ingredientValues.length).toBeGreaterThan(0)

    // English name is preserved on the JSON-LD-direct path — only
    // units/quantities go through `_translate_unit`.
    const hasGroundChicken = ingredientValues.some((v) => /ground chicken/i.test(v))
    expect(
      hasGroundChicken,
      `Expected "ground chicken" preserved in OFF mode, got: ${ingredientValues.join(' | ')}`,
    ).toBe(true)

    // Metric units survive even on the JSON-LD-direct path because
    // BUG-030's `_translate_unit` runs as a second-stage normaliser
    // regardless of whether the LLM ran. 1 pound → ~454 g.
    const groundChickenIndex = ingredientValues.findIndex((v) =>
      /ground chicken/i.test(v),
    )
    expect(groundChickenIndex).toBeGreaterThanOrEqual(0)
    const rowQuantity = await page
      .getByLabel(new RegExp(`Zutat ${groundChickenIndex + 1} Menge`, 'i'))
      .inputValue()
    const rowUnit = await page
      .getByLabel(new RegExp(`Zutat ${groundChickenIndex + 1} Einheit`, 'i'))
      .inputValue()
    expect(rowUnit, `Expected metric unit on ground-chicken row, got "${rowUnit}"`).toBe('g')
    // Allow some rounding wobble (453, 454) but not the imperial 1.
    expect(Number(rowQuantity)).toBeGreaterThan(100)

    // Regression guard for bcebc99 — the original imperial line
    // "1 pound ground chicken (could also use pork)" must NOT survive
    // as a per-ingredient note. We assert no ingredient row's note
    // input contains the imperial unit string for this URL.
    const noteInputs = page.locator(
      'input[aria-label^="Zutat "][aria-label$=" Notiz"]',
    )
    const noteValues = await noteInputs.evaluateAll((els) =>
      (els as HTMLInputElement[]).map((el) => el.value),
    )
    const noteRegression = noteValues.filter((n) => /1 pound ground chicken/i.test(n))
    expect(
      noteRegression,
      `bcebc99 regression — imperial line leaked into note: ${noteRegression.join(' | ')}`,
    ).toEqual([])
  })
})
