import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  ExtractorConfigItem,
  ExtractorConfigListResponse,
} from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ExtractorConfigPage } from './ExtractorConfigPage'

/**
 * CFG-2 — MSW-driven tests for `/admin/extractor`. Covers render, the
 * per-section save flow, 409 version-mismatch recovery, 400 inline
 * error, reset flow, and the string-list chip editor.
 */

function makeItem(
  key: string,
  value: unknown,
  type: ExtractorConfigItem['type'],
  version = 0,
): ExtractorConfigItem {
  return {
    key,
    value,
    type,
    updatedAt: '2026-04-21T12:00:00Z',
    updatedBy: null,
    version,
  }
}

function defaultPayload(): ExtractorConfigListResponse {
  return {
    items: [
      makeItem(
        'llm.structured.system_prompt',
        'Du bist ein Koch.',
        'string',
      ),
      makeItem('llm.structured.temperature', 0, 'float'),
      makeItem('llm.structured.max_completion_tokens', 2048, 'int'),
      makeItem(
        'llm.structured.deployment',
        'gpt-4.1-mini',
        'string',
      ),
      makeItem(
        'llm.chat_to_recipe.system_prompt',
        'Du bist ein Chat-Assistent.',
        'string',
      ),
      makeItem('llm.chat.max_completion_tokens', 2048, 'int'),
      makeItem('llm.chat.deployment', 'gpt-5.1-chat', 'string'),
      makeItem(
        'llm.vision.system_prompt',
        'Analysiere das Foto.',
        'string',
      ),
      makeItem('llm.vision.temperature', 0, 'float'),
      makeItem('llm.vision.deployment', 'gpt-4.1-mini', 'string'),
      makeItem('llm.vision.max_completion_tokens', 2048, 'int'),
      makeItem('feature.video_import_enabled', true, 'bool'),
      makeItem('feature.blog_follow_enabled', true, 'bool'),
      makeItem('feature.nutrition_estimate_enabled', true, 'bool'),
      makeItem('feature.thumbnail_auto_attach_enabled', true, 'bool'),
      makeItem('feature.chat_enabled', true, 'bool'),
      makeItem('pipeline.min_transcript_chars', 20, 'int'),
      makeItem('pipeline.component_label_max', 50, 'int'),
      makeItem(
        'pipeline.generic_label_blacklist',
        ['hauptzutaten', 'zutaten'],
        'string_list',
      ),
      makeItem(
        'pipeline.shortener_hosts',
        ['bit.ly', 'tinyurl.com'],
        'string_list',
      ),
      makeItem('pipeline.shortener_max_redirects', 3, 'int'),
      makeItem('pipeline.shortener_head_timeout_seconds', 5, 'float'),
    ],
  }
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/admin/extractor']}>
          <Routes>
            <Route path="/admin/extractor" element={children} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ExtractorConfigPage />, { wrapper: Wrapper })
}

function seedAdmin() {
  useAuthStore.getState().setSession('tok', {
    id: 'admin-1',
    email: 'admin@test.local',
    displayName: 'Admin',
    role: 'Admin',
  })
}

describe('<ExtractorConfigPage />', () => {
  beforeEach(() => {
    seedAdmin()
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders all four sections with the server values populated', async () => {
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
    )

    renderPage()

    expect(
      screen.getByRole('heading', { name: /Extractor-Konfiguration/i }),
    ).toBeInTheDocument()

    // Wait for the list query to resolve + seed drafts before poking
    // at section-level content.
    await screen.findByLabelText(/Strukturierter System-Prompt/i)

    // All four section headings present.
    expect(screen.getByRole('heading', { level: 2, name: /Prompts/i })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: /Modelle & Parameter/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: /Feature-Flags/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: /Thresholds/i }),
    ).toBeInTheDocument()

    // Prompts — three textareas contain the seeded text. Labels render
    // via admin.extractor.keyLabels (POLISH-2 fix).
    const structuredPrompt = screen.getByLabelText(
      /Strukturierter System-Prompt/i,
    ) as HTMLTextAreaElement
    expect(structuredPrompt.value).toBe('Du bist ein Koch.')

    // Modelle — deployment input carries the server default.
    const structuredDeployment = screen.getByLabelText(
      /Strukturiert: Deployment-Name/i,
    ) as HTMLInputElement
    expect(structuredDeployment.value).toBe('gpt-4.1-mini')

    // Chat row has NO temperature input (design: chat model rejects
    // non-default temperature, so the UI doesn't surface it).
    expect(
      screen.queryByLabelText(/llm\.chat\.temperature/i),
    ).not.toBeInTheDocument()

    // Feature-Flags — switches are all checked (default true).
    const videoFlag = screen.getByLabelText(
      /feature\.video_import_enabled/i,
    ) as HTMLInputElement
    expect(videoFlag.checked).toBe(true)

    // Thresholds — number input populated.
    const minChars = screen.getByLabelText(
      /Min\. Transkript-Zeichen/i,
    ) as HTMLInputElement
    expect(minChars.value).toBe('20')

    // History footer renders the pragmatic "will be backfilled" empty-state.
    expect(
      screen.getByRole('heading', { level: 2, name: /Letzte Änderungen/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Letzte Änderungen werden nachgerüstet\./i),
    ).toBeInTheDocument()
  })

  it('save-flow: editing temperature + pressing "Modelle speichern" PUTs the changed key with the expected version', async () => {
    const user = userEvent.setup()
    const puts: Array<{ url: string; body: unknown }> = []
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
      http.put(
        '/api/admin/extractor-config/:key',
        async ({ request, params }) => {
          const body = await request.json()
          puts.push({ url: String(params.key), body })
          return HttpResponse.json({
            key: String(params.key),
            value: (body as { value: unknown }).value,
            type: 'float',
            updatedAt: '2026-04-21T13:00:00Z',
            updatedBy: { id: 'admin-1', displayName: 'Admin' },
            version: 1,
          })
        },
      ),
    )

    renderPage()

    const tempInput = (await screen.findByLabelText(
      /Strukturiert: Temperatur/i,
    )) as HTMLInputElement
    await user.clear(tempInput)
    await user.type(tempInput, '0.5')

    // Section-level save button — "Modelle & Parameter speichern".
    const saveBtn = screen.getByRole('button', {
      name: /Modelle speichern/i,
    })
    await user.click(saveBtn)

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].url).toBe('llm.structured.temperature')
    expect(puts[0].body).toEqual({ value: 0.5, expectedVersion: 0 })

    // After success, the just-saved indicator is present.
    await waitFor(() =>
      expect(screen.getByText(/Gespeichert vor/i)).toBeInTheDocument(),
    )
  })

  it('409-flow: version mismatch triggers a refetch + shows the "neu geladen" banner', async () => {
    const user = userEvent.setup()
    let getCalls = 0
    server.use(
      http.get('/api/admin/extractor-config/', () => {
        getCalls += 1
        return HttpResponse.json(defaultPayload())
      }),
      http.put('/api/admin/extractor-config/:key', () =>
        HttpResponse.json(
          {
            code: 'version_mismatch',
            message:
              'Die aktuelle Version stimmt nicht überein.',
          },
          { status: 409 },
        ),
      ),
    )

    renderPage()

    const tempInput = (await screen.findByLabelText(
      /Strukturiert: Temperatur/i,
    )) as HTMLInputElement
    await user.clear(tempInput)
    await user.type(tempInput, '0.3')

    const saveBtn = screen.getByRole('button', {
      name: /Modelle speichern/i,
    })
    await user.click(saveBtn)

    await waitFor(() =>
      expect(
        screen.getByText(
          /Ein anderer Admin hat gerade geändert — neu geladen\./i,
        ),
      ).toBeInTheDocument(),
    )
    // GET called at least twice: initial load + refetch after 409.
    expect(getCalls).toBeGreaterThanOrEqual(2)
  })

  it('400-flow: invalid_value surfaces the German server message inline under the field', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
      http.put('/api/admin/extractor-config/:key', () =>
        HttpResponse.json(
          {
            code: 'invalid_value',
            message: 'Temperature muss zwischen 0 und 2 liegen.',
          },
          { status: 400 },
        ),
      ),
    )

    renderPage()

    const tempInput = (await screen.findByLabelText(
      /Strukturiert: Temperatur/i,
    )) as HTMLInputElement
    await user.clear(tempInput)
    await user.type(tempInput, '5')

    const saveBtn = screen.getByRole('button', {
      name: /Modelle speichern/i,
    })
    await user.click(saveBtn)

    await waitFor(() =>
      expect(
        screen.getByText(/Temperature muss zwischen 0 und 2 liegen\./i),
      ).toBeInTheDocument(),
    )
  })

  it('reset-flow: clicking Zurücksetzen on a prompt calls POST /reset and updates the textarea', async () => {
    const user = userEvent.setup()
    const resetCalls: string[] = []
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
      http.post(
        '/api/admin/extractor-config/:key/reset',
        ({ params }) => {
          resetCalls.push(String(params.key))
          return HttpResponse.json({
            key: String(params.key),
            value: 'Default-Prompt nach Reset.',
            type: 'string',
            updatedAt: '2026-04-21T14:00:00Z',
            updatedBy: { id: 'admin-1', displayName: 'Admin' },
            version: 1,
          })
        },
      ),
    )

    renderPage()

    await screen.findByLabelText(/Strukturierter System-Prompt/i)

    // The prompts section has a "Zurücksetzen" button per row — pick
    // the one in the Structured prompt's row group.
    const structuredGroup = screen
      .getByLabelText(/Strukturierter System-Prompt/i)
      .closest('div[data-testid="prompt-row"]') as HTMLDivElement
    const resetBtn = within(structuredGroup).getByRole('button', {
      name: /Zurücksetzen/i,
    })
    await user.click(resetBtn)

    await waitFor(() =>
      expect(resetCalls).toContain('llm.structured.system_prompt'),
    )

    const textarea = (await screen.findByLabelText(
      /Strukturierter System-Prompt/i,
    )) as HTMLTextAreaElement
    await waitFor(() =>
      expect(textarea.value).toBe('Default-Prompt nach Reset.'),
    )
  })

  it('chip editor: adding a host + saving PUTs the full string array', async () => {
    const user = userEvent.setup()
    const puts: Array<{ key: string; body: unknown }> = []
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
      http.put(
        '/api/admin/extractor-config/:key',
        async ({ request, params }) => {
          const body = await request.json()
          puts.push({ key: String(params.key), body })
          return HttpResponse.json({
            key: String(params.key),
            value: (body as { value: unknown }).value,
            type: 'string_list',
            updatedAt: '2026-04-21T13:30:00Z',
            updatedBy: { id: 'admin-1', displayName: 'Admin' },
            version: 1,
          })
        },
      ),
    )

    renderPage()

    await screen.findByLabelText(/pipeline\.shortener_hosts.*hinzufügen/i)

    const chipInput = screen.getByLabelText(
      /pipeline\.shortener_hosts.*hinzufügen/i,
    ) as HTMLInputElement
    await user.type(chipInput, 'rebrand.ly')
    await user.keyboard('{Enter}')

    const saveBtn = screen.getByRole('button', {
      name: /Thresholds speichern/i,
    })
    await user.click(saveBtn)

    await waitFor(() =>
      expect(
        puts.find((p) => p.key === 'pipeline.shortener_hosts'),
      ).toBeTruthy(),
    )
    const sent = puts.find((p) => p.key === 'pipeline.shortener_hosts')!
      .body as { value: string[]; expectedVersion: number }
    expect(sent.value).toEqual(['bit.ly', 'tinyurl.com', 'rebrand.ly'])
    expect(sent.expectedVersion).toBe(0)
  })

  it('chip editor: removing a host strips it from the outgoing PUT payload', async () => {
    const user = userEvent.setup()
    const puts: Array<{ key: string; body: unknown }> = []
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
      http.put(
        '/api/admin/extractor-config/:key',
        async ({ request, params }) => {
          const body = await request.json()
          puts.push({ key: String(params.key), body })
          return HttpResponse.json({
            key: String(params.key),
            value: (body as { value: unknown }).value,
            type: 'string_list',
            updatedAt: '2026-04-21T13:40:00Z',
            updatedBy: { id: 'admin-1', displayName: 'Admin' },
            version: 1,
          })
        },
      ),
    )

    renderPage()

    await screen.findByLabelText(/pipeline\.shortener_hosts.*hinzufügen/i)

    // Remove "bit.ly" via its per-chip delete button.
    const removeBtn = screen.getByRole('button', {
      name: /bit\.ly entfernen/i,
    })
    await user.click(removeBtn)

    const saveBtn = screen.getByRole('button', {
      name: /Thresholds speichern/i,
    })
    await user.click(saveBtn)

    await waitFor(() =>
      expect(
        puts.find((p) => p.key === 'pipeline.shortener_hosts'),
      ).toBeTruthy(),
    )
    const sent = puts.find((p) => p.key === 'pipeline.shortener_hosts')!
      .body as { value: string[] }
    expect(sent.value).toEqual(['tinyurl.com'])
  })

  it('flag list: friendly label is the primary text, raw key is the muted subtitle', async () => {
    server.use(
      http.get('/api/admin/extractor-config/', () =>
        HttpResponse.json(defaultPayload()),
      ),
    )

    renderPage()

    // Wait for the list query to resolve.
    await screen.findByLabelText(/Strukturierter System-Prompt/i)

    // The friendly translation belongs to the primary label slot
    // (font-medium); the raw dotted key belongs to the muted subtitle
    // slot (text-muted-foreground / text-xs). The video-import flag is
    // a representative example — every flag follows the same layout.
    const friendly = screen.getByText('Aktivieren des Video-Imports')
    expect(friendly).toHaveClass('font-medium')
    // Sanity check the friendly label is NOT the muted subtitle.
    expect(friendly).not.toHaveClass('text-muted-foreground')

    const rawKey = screen.getByText('feature.video_import_enabled')
    expect(rawKey).toHaveClass('text-muted-foreground')
    expect(rawKey).toHaveClass('text-xs')
    // And the raw key is NOT the bold primary label.
    expect(rawKey).not.toHaveClass('font-medium')
  })

  it('"Gespeichert vor X Sekunden" label ticks forward as time passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      server.use(
        http.get('/api/admin/extractor-config/', () =>
          HttpResponse.json(defaultPayload()),
        ),
        http.put(
          '/api/admin/extractor-config/:key',
          async ({ request, params }) => {
            const body = await request.json()
            return HttpResponse.json({
              key: String(params.key),
              value: (body as { value: unknown }).value,
              type: 'float',
              updatedAt: '2026-04-21T12:00:00Z',
              updatedBy: { id: 'admin-1', displayName: 'Admin' },
              version: 1,
            })
          },
        ),
      )

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      renderPage()

      const tempInput = (await screen.findByLabelText(
        /Strukturiert: Temperatur/i,
      )) as HTMLInputElement
      await user.clear(tempInput)
      await user.type(tempInput, '0.4')
      const saveBtn = screen.getByRole('button', {
        name: /Modelle speichern/i,
      })
      await user.click(saveBtn)

      await waitFor(() =>
        expect(screen.getByText(/Gespeichert vor 0\s*Sek/i)).toBeInTheDocument(),
      )

      // Advance fake time by 5 real seconds.
      await vi.advanceTimersByTimeAsync(5_000)
      await waitFor(() =>
        expect(screen.getByText(/Gespeichert vor 5\s*Sek/i)).toBeInTheDocument(),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
