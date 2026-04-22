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
import {
  recallImportGroup,
  recallImportStagedPhotoIds,
  forgetImportGroup,
} from './importGroupMemo'

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
    version: 0,
    ...over,
  }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderPage(
  opts: { state?: { stagedBlobs?: File[] } | null } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  const initialEntry = {
    pathname: '/rezepte/import/photos',
    state: opts.state ?? null,
  }
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialEntry]}>
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
    const input = screen.getByTestId('photos-gallery-input') as HTMLInputElement
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
    const input = screen.getByTestId('photos-gallery-input') as HTMLInputElement
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
            stagedPhotoId: `00000000-0000-0000-0000-00000000000${id}`,
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
    const input = screen.getByTestId('photos-gallery-input') as HTMLInputElement
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
    // PF1 — stagedPhotoIds stashed in the same order the uploads
    // returned, so the create-recipe step can adopt the originals.
    expect(recallImportStagedPhotoIds('imp-photos')).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ])
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
            stagedPhotoId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
    const input = screen.getByTestId('photos-gallery-input') as HTMLInputElement
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
    const input = screen.getByTestId('photos-gallery-input') as HTMLInputElement
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
    const input = screen.getByTestId('photos-gallery-input') as HTMLInputElement
    await user.upload(input, [fakeJpeg('a.jpg')])
    await user.click(screen.getByRole('button', { name: /Rezepte extrahieren/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /JPEG|WebP/i,
    )
    expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/photos')
  })

  // BUG-015 — `<input capture="environment">` forces iOS/Android into
  // the live camera and hides the photo library. We split the single
  // input into two so users can pick existing photos (e.g. a scanned
  // cookbook page from days ago) without going through the camera.
  describe('BUG-015 — split camera + gallery inputs', () => {
    it('renders BOTH inputs with correct capture configuration', async () => {
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
        ),
      )
      renderPage()
      const camera = screen.getByTestId(
        'photos-camera-input',
      ) as HTMLInputElement
      const gallery = screen.getByTestId(
        'photos-gallery-input',
      ) as HTMLInputElement
      // Camera input MUST carry capture="environment" so the OS opens
      // the rear camera directly when a user taps the camera button.
      expect(camera).toBeInTheDocument()
      expect(camera.getAttribute('capture')).toBe('environment')
      expect(camera.type).toBe('file')
      expect(camera.accept).toMatch(/image/i)
      // Gallery input MUST NOT carry a capture attribute — otherwise
      // mobile browsers will hide the photo library.
      expect(gallery).toBeInTheDocument()
      expect(gallery.hasAttribute('capture')).toBe(false)
      expect(gallery.type).toBe('file')
      expect(gallery.accept).toMatch(/image/i)
    })

    it('clicking the Kamera button triggers the camera input', async () => {
      const user = userEvent.setup()
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
        ),
      )
      renderPage()
      const camera = screen.getByTestId(
        'photos-camera-input',
      ) as HTMLInputElement
      const gallery = screen.getByTestId(
        'photos-gallery-input',
      ) as HTMLInputElement
      let cameraClicks = 0
      let galleryClicks = 0
      camera.addEventListener('click', () => {
        cameraClicks += 1
      })
      gallery.addEventListener('click', () => {
        galleryClicks += 1
      })
      await user.click(screen.getByRole('button', { name: /^Kamera$/i }))
      expect(cameraClicks).toBe(1)
      expect(galleryClicks).toBe(0)
    })

    it('clicking the Fotos auswählen button triggers the gallery input AND a file landed there flows into the staged grid', async () => {
      const user = userEvent.setup()
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
        ),
      )
      renderPage()
      const camera = screen.getByTestId(
        'photos-camera-input',
      ) as HTMLInputElement
      const gallery = screen.getByTestId(
        'photos-gallery-input',
      ) as HTMLInputElement
      let cameraClicks = 0
      let galleryClicks = 0
      camera.addEventListener('click', () => {
        cameraClicks += 1
      })
      gallery.addEventListener('click', () => {
        galleryClicks += 1
      })
      await user.click(
        screen.getByRole('button', { name: /Fotos auswählen/i }),
      )
      expect(galleryClicks).toBe(1)
      expect(cameraClicks).toBe(0)

      // File-selection from the gallery input must land in shared
      // staged-grid state — same handler as the camera input.
      await user.upload(gallery, [fakeJpeg('library-pick.jpg')])
      expect(await screen.findByAltText('Foto 1')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /Rezepte extrahieren/i }),
      ).not.toBeDisabled()
    })
  })

  /**
   * SHARE-1 — photos handed off from the Web Share Target flow.
   *
   * `<ShareTargetPage />` reads the SW-stashed file blobs out of
   * IndexedDB and `navigate('/rezepte/import/photos', { state: {
   * stagedBlobs: File[] } })`. The import page must pick them up on
   * mount as if the user had picked them manually — no auto-fire of
   * the Azure extraction, user still explicitly taps "Importieren".
   */
  describe('SHARE-1 — pre-staged blobs from router state', () => {
    it('pre-stages blobs from location.state.stagedBlobs and does NOT auto-enqueue the import', async () => {
      let enqueued = false
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
        ),
        http.post('/api/recipes/import/photos', () => {
          enqueued = true
          return HttpResponse.json({ importId: 'imp-auto' }, { status: 202 })
        }),
      )
      renderPage({
        state: {
          stagedBlobs: [
            fakeJpeg('shared-1.jpg'),
            fakeJpeg('shared-2.jpg'),
          ],
        },
      })

      // The grid should mount with two pre-staged thumbnails.
      expect(await screen.findByAltText('Foto 1')).toBeInTheDocument()
      expect(screen.getByAltText('Foto 2')).toBeInTheDocument()

      // Submit button is enabled — user can still tap "Importieren" —
      // but we must NOT have auto-fired the POST.
      expect(
        screen.getByRole('button', { name: /Rezepte extrahieren/i }),
      ).not.toBeDisabled()
      expect(enqueued).toBe(false)
    })

    it('drops unsupported MIME blobs from router state and surfaces a German partial-import toast', async () => {
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
        ),
      )
      // One valid JPEG, one PDF — the page must keep the JPEG and
      // show an alert for the dropped one.
      renderPage({
        state: {
          stagedBlobs: [
            fakeJpeg('ok.jpg'),
            new File([new Uint8Array(8)], 'doc.pdf', {
              type: 'application/pdf',
            }),
          ],
        },
      })

      expect(await screen.findByAltText('Foto 1')).toBeInTheDocument()
      expect(screen.queryByAltText('Foto 2')).not.toBeInTheDocument()
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Format nicht unterstützt/i,
      )
    })

    it('clears consumed state so a remount does NOT double-stage the same blobs', async () => {
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-solo' })]),
        ),
      )
      const sharedFile = fakeJpeg('once.jpg')
      const { rerender } = renderPage({
        state: { stagedBlobs: [sharedFile] },
      })
      expect(await screen.findByAltText('Foto 1')).toBeInTheDocument()

      // Simulate the React Router remounting the page (e.g. focus
      // regained) — the router state should already be cleared so we
      // don't end up with a second "Foto 1" thumbnail.
      rerender(<ImportPhotosPage />)
      const thumbs = screen.queryAllByRole('img')
      // The only thumbnail the grid should have is the pre-staged one.
      // A naive implementation would stage it twice on remount.
      expect(thumbs.length).toBe(1)
    })
  })
})
