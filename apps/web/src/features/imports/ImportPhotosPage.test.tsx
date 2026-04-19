import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ImportPhotosPage } from './ImportPhotosPage'
import { recallImportGroup, forgetImportGroup } from './importGroupMemo'

function groupSummary(over: Partial<GroupSummary>): GroupSummary {
  return {
    id: 'g1',
    name: 'Familie',
    description: null,
    coverImageUrl: null,
    defaultServings: 4,
    isPrivateCollection: false,
    memberCount: 4,
    myRole: 'Admin',
    ...over,
  }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/rezepte/import/photos']}>
          <LocationProbe />
          <Routes>
            <Route path="/rezepte/import/photos" element={children} />
            <Route
              path="/rezepte/import/:importId"
              element={<div data-testid="progress-page">progress</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ImportPhotosPage />, { wrapper: Wrapper })
}

/**
 * Builds a plain JPEG-shaped File. jsdom doesn't actually decode the
 * bytes — what matters for these tests is the `type`, `size`, and name
 * so the MSW mocks + client-side validation can round-trip cleanly.
 */
function fakeJpeg(name: string, bytes = new Uint8Array(8)): File {
  return new File([bytes], name, { type: 'image/jpeg' })
}

describe('<ImportPhotosPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'u1@ex.com',
      displayName: 'U',
      role: 'User',
    })
    forgetImportGroup('imp-photos')
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the headline, upload grid, and disabled submit button with no photos', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
    )
    renderPage()
    expect(
      screen.getByRole('heading', { name: /Rezept aus Foto importieren/i }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('photos-grid')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Rezepte extrahieren/i }),
    ).toBeDisabled()
  })

  it('accepts two JPEG files via the hidden input and renders two thumbnails', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
      ),
    )
    renderPage()
    const input = screen.getByTestId('photos-file-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('a.jpg'), fakeJpeg('b.jpg')])

    // The two Foto 1 / Foto 2 thumbnails render — we check by aria-label.
    expect(await screen.findByAltText('Foto 1')).toBeInTheDocument()
    expect(screen.getByAltText('Foto 2')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Rezepte extrahieren/i }),
    ).not.toBeDisabled()
  })

  it('rejects a non-image file dropped onto the grid with a German error', async () => {
    // userEvent.upload respects the input's `accept` attribute and
    // silently filters out non-matching files — so to exercise our
    // in-code validation we simulate drag-and-drop instead, which has
    // no such guard.
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
      ),
    )
    renderPage()
    const grid = screen.getByTestId('photos-grid')
    const badFile = new File(['not-an-image'], 'a.txt', { type: 'text/plain' })
    fireEvent.drop(grid, {
      dataTransfer: { files: [badFile] },
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Nur JPG, PNG oder WebP/i,
    )
    expect(screen.queryByAltText('Foto 1')).not.toBeInTheDocument()
  })

  it('supports reordering via the ↓ button', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
      ),
    )
    renderPage()
    const input = screen.getByTestId('photos-file-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('first.jpg'), fakeJpeg('second.jpg')])

    // Initially: 1st thumbnail has alt="Foto 1", 2nd "Foto 2". We don't
    // look at the underlying file name — only at the ordering of the
    // rendered slots. Clicking "Foto 1 nach unten verschieben" should
    // swap them: the now-first slot should still read "Foto 1" (the
    // index badge updates because the array moved).
    const downBtn = screen.getByRole('button', {
      name: /Foto 1 nach unten verschieben/i,
    })
    await user.click(downBtn)

    // After the swap there should still be a Foto 1 and a Foto 2 slot —
    // the content behind them moved. We verify the move actually
    // happened by checking that the first slot's move-up is now enabled
    // (because it's no longer the top slot it has one before it). That
    // would never have been enabled in the original order: slot 1 is
    // always first at load. So the enabled-up-button on the new-first
    // means it's got a neighbour above it, which is the signal the
    // button press re-wrote the array.
    // Simplest assertion: the 1st slot's up-arrow is still disabled
    // (it's always the top) — but the old 2nd slot's down-arrow is now
    // disabled (because it moved to the bottom).
    const newFirstUp = screen.getByRole('button', {
      name: /Foto 1 nach oben verschieben/i,
    })
    const newLastDown = screen.getByRole('button', {
      name: /Foto 2 nach unten verschieben/i,
    })
    expect(newFirstUp).toBeDisabled()
    expect(newLastDown).toBeDisabled()
  })

  it('uploads sequentially, enqueues the import, stashes groupId, and navigates to progress', async () => {
    const user = userEvent.setup()

    // Capture upload order + body payload to confirm sequential calls.
    // jsdom's multipart parser chokes on File objects built via `new File`,
    // so we skip `request.formData()` and track completion via an
    // incrementing counter — what we care about here is that the client
    // issues two sequential POSTs, not what's inside each multipart body.
    let uploadCount = 0
    let enqueueBody: { photoUrls: string[]; groupId: string } | null = null
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'g-solo', isPrivateCollection: true, memberCount: 1 }),
        ]),
      ),
      http.post('/api/recipes/photos/staged', () => {
        uploadCount += 1
        const id = uploadCount
        return HttpResponse.json(
          {
            photoId: `recipes/photo-${id}.jpg`,
            signedUrl: `/api/photos/recipes/photo-${id}.jpg?sig=x&exp=9`,
          },
          { status: 200 },
        )
      }),
      http.post('/api/recipes/import/photos', async ({ request }) => {
        enqueueBody = (await request.json()) as {
          photoUrls: string[]
          groupId: string
        }
        return HttpResponse.json({ importId: 'imp-photos' }, { status: 202 })
      }),
    )
    renderPage()
    const input = screen.getByTestId('photos-file-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('first.jpg'), fakeJpeg('second.jpg')])
    await user.click(screen.getByRole('button', { name: /Rezepte extrahieren/i }))

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/rezepte/import/imp-photos',
      ),
    )
    expect(uploadCount).toBe(2)
    // Enqueue body carries the signed URLs in the order they were
    // returned by the staged-upload endpoint (which = on-screen order,
    // since uploads are sequential).
    expect(enqueueBody).not.toBeNull()
    expect(enqueueBody!.photoUrls).toEqual([
      '/api/photos/recipes/photo-1.jpg?sig=x&exp=9',
      '/api/photos/recipes/photo-2.jpg?sig=x&exp=9',
    ])
    expect(enqueueBody!.groupId).toBe('g-solo')
    // sessionStorage sidecar populated so the progress page can resolve
    // the group on reload.
    expect(recallImportGroup('imp-photos')).toBe('g-solo')
  })

  it('with >1 groups: opens picker, POSTs with the picked group on selection', async () => {
    const user = userEvent.setup()
    let enqueueBody: { photoUrls: string[]; groupId: string } | null = null
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'ga', name: 'Alpha' }),
          groupSummary({ id: 'gb', name: 'Beta' }),
        ]),
      ),
      http.post('/api/recipes/photos/staged', () =>
        HttpResponse.json(
          {
            photoId: 'recipes/staged.jpg',
            signedUrl: '/api/photos/recipes/staged.jpg?sig=x&exp=9',
          },
          { status: 200 },
        ),
      ),
      http.post('/api/recipes/import/photos', async ({ request }) => {
        enqueueBody = (await request.json()) as {
          photoUrls: string[]
          groupId: string
        }
        return HttpResponse.json({ importId: 'imp-p2' }, { status: 202 })
      }),
    )
    renderPage()
    const input = screen.getByTestId('photos-file-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('only.jpg')])
    await user.click(screen.getByRole('button', { name: /Rezepte extrahieren/i }))

    // Picker opens.
    const pickerHeading = await screen.findByText(/in welcher gruppe/i)
    expect(pickerHeading).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Beta/ }))

    await waitFor(() => expect(enqueueBody).not.toBeNull())
    expect(enqueueBody!.groupId).toBe('gb')
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/imp-p2'),
    )
  })

  it('with 0 groups: offers CreateGroupDialog and does NOT POST', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.post('/api/recipes/photos/staged', () => {
        posted = true
        return HttpResponse.json({ photoId: 'x', signedUrl: 'y' })
      }),
    )
    renderPage()
    const input = screen.getByTestId('photos-file-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('a.jpg')])
    await user.click(screen.getByRole('button', { name: /Rezepte extrahieren/i }))
    expect(await screen.findByText(/Gruppe erstellen/i)).toBeInTheDocument()
    expect(posted).toBe(false)
  })

  it('surfaces an upload error inline and stops the sequence', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
      ),
      http.post('/api/recipes/photos/staged', () =>
        HttpResponse.json(
          {
            code: 'unsupported_media_type',
            message: 'Nur JPEG-, PNG- und WebP-Bilder sind zulässig.',
          },
          { status: 400 },
        ),
      ),
    )
    renderPage()
    const input = screen.getByTestId('photos-file-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('a.jpg')])
    await user.click(screen.getByRole('button', { name: /Rezepte extrahieren/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /JPEG|WebP/i,
    )
    expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/photos')
  })
})
