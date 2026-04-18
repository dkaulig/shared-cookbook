import { describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { PhotoUploadGrid } from './PhotoUploadGrid'

function withProviders(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('<PhotoUploadGrid />', () => {
  it('renders three slots when the recipe has no photos yet', () => {
    render(
      withProviders(
        <PhotoUploadGrid recipeId="r1" photos={[]} />,
      ),
    )
    // All three are drop-zones (empty) in this state.
    const dropZones = screen.getAllByRole('button', { name: /Foto hochladen/i })
    expect(dropZones).toHaveLength(3)
  })

  it('renders filled thumbnails with remove buttons when photos are present', () => {
    render(
      withProviders(
        <PhotoUploadGrid recipeId="r1" photos={['fake://a.jpg', 'fake://b.jpg']} />,
      ),
    )
    // 2 filled + 1 drop-zone.
    expect(screen.getAllByAltText(/Rezept-Foto/i)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Foto entfernen/i })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Foto hochladen/i })).toHaveLength(1)
  })

  it('renders no drop zones when the recipe is at the 3-photo cap', () => {
    render(
      withProviders(
        <PhotoUploadGrid recipeId="r1" photos={['a', 'b', 'c']} />,
      ),
    )
    expect(screen.queryAllByRole('button', { name: /Foto hochladen/i })).toHaveLength(0)
    expect(screen.getAllByAltText(/Rezept-Foto/i)).toHaveLength(3)
  })

  it('surfaces a German error when a file is dropped while at the 3-photo cap', async () => {
    render(
      withProviders(
        <PhotoUploadGrid recipeId="r1" photos={['a', 'b', 'c']} />,
      ),
    )
    // When at cap, no drop-zone slot is rendered — but the outer grid
    // still accepts drops so the user gets feedback instead of silence.
    const dropTarget = screen.getByTestId('photo-upload-grid')
    const file = new File(['x'], 'x.jpg', { type: 'image/jpeg' })
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: 'image/jpeg', getAsFile: () => file }],
      types: ['Files'],
    }
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.drop(dropTarget, { dataTransfer })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Maximal 3 Fotos/i)
    })
  })

  it('calls the upload endpoint when a file is selected and the recipe has headroom', async () => {
    let uploaded = false
    server.use(
      http.post('/api/recipes/r1/photos', () => {
        uploaded = true
        return HttpResponse.json({ url: 'fake://new.jpg' }, { status: 201 })
      }),
    )
    render(
      withProviders(
        <PhotoUploadGrid recipeId="r1" photos={[]} />,
      ),
    )
    const input = screen.getAllByTestId('photo-upload-input')[0] as HTMLInputElement
    const file = new File(['x'], 'x.jpg', { type: 'image/jpeg' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(uploaded).toBe(true))
  })

  it('calls the remove endpoint when the X on a filled slot is tapped', async () => {
    let removed = false
    server.use(
      http.delete('/api/recipes/r1/photos', async ({ request }) => {
        const body = (await request.json()) as { url: string }
        if (body.url === 'fake://a.jpg') removed = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    render(
      withProviders(
        <PhotoUploadGrid recipeId="r1" photos={['fake://a.jpg']} />,
      ),
    )
    await user.click(screen.getAllByRole('button', { name: /Foto entfernen/i })[0])
    await waitFor(() => expect(removed).toBe(true))
  })
})

// ── UX1-PU staged mode ───────────────────────────────────────────────
//
// In create mode the recipe doesn't exist yet, so there's no recipeId to
// attach uploads to. The staged mode keeps File objects in parent state,
// renders blob-URL previews, enforces the same MIME + 3-photo caps as
// live mode, and revokes object URLs on unmount / remove to keep the
// browser's blob-URL registry clean.

describe('<PhotoUploadGrid mode="staged" />', () => {
  function StagedHarness({ initial = [] as File[] }: { initial?: File[] }) {
    const [files, setFiles] = useState<File[]>(initial)
    return (
      <>
        <div data-testid="staged-count">{files.length}</div>
        <PhotoUploadGrid mode="staged" files={files} onFilesChange={setFiles} />
      </>
    )
  }

  it('renders three drop-zone slots when no files are staged yet', () => {
    render(withProviders(<StagedHarness />))
    expect(
      screen.getAllByRole('button', { name: /Foto hochladen/i }),
    ).toHaveLength(3)
  })

  it('appends a selected file to the staged list and shows a preview thumbnail', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock/1')
    const user = userEvent.setup()
    render(withProviders(<StagedHarness />))
    const input = screen.getAllByTestId('photo-upload-input')[0] as HTMLInputElement
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await user.upload(input, file)
    expect(screen.getByTestId('staged-count')).toHaveTextContent('1')
    expect(screen.getAllByAltText(/Rezept-Foto/i)).toHaveLength(1)
    expect(createSpy).toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('removes a staged file and revokes its blob URL when the X is tapped', async () => {
    const createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:mock/remove-me')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const initial = [new File(['x'], 'a.jpg', { type: 'image/jpeg' })]
    const user = userEvent.setup()
    render(withProviders(<StagedHarness initial={initial} />))
    expect(screen.getByTestId('staged-count')).toHaveTextContent('1')
    await user.click(screen.getByRole('button', { name: /Foto entfernen/i }))
    expect(screen.getByTestId('staged-count')).toHaveTextContent('0')
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock/remove-me')
    createSpy.mockRestore()
    revokeSpy.mockRestore()
  })

  it('rejects files whose MIME type is not an image with a German error', async () => {
    render(withProviders(<StagedHarness />))
    // Simulate a drag-drop of a non-image file — userEvent.upload would
    // pre-filter by the <input accept=""> attribute, which hides the
    // client-side guard this test is meant to verify.
    const dropTarget = screen.getByTestId('photo-upload-grid')
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => file }],
      types: ['Files'],
    }
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.drop(dropTarget, { dataTransfer })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/JPG, PNG oder WebP/i)
    })
    expect(screen.getByTestId('staged-count')).toHaveTextContent('0')
  })

  it('blocks a 4th staged file and surfaces the 3-photo cap error', async () => {
    const initial = [
      new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'c.jpg', { type: 'image/jpeg' }),
    ]
    render(withProviders(<StagedHarness initial={initial} />))
    // No drop-zone visible at cap — but the outer grid still accepts drops.
    expect(
      screen.queryAllByRole('button', { name: /Foto hochladen/i }),
    ).toHaveLength(0)
    const dropTarget = screen.getByTestId('photo-upload-grid')
    const file = new File(['d'], 'd.jpg', { type: 'image/jpeg' })
    const dataTransfer = {
      files: [file],
      items: [{ kind: 'file', type: 'image/jpeg', getAsFile: () => file }],
      types: ['Files'],
    }
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.drop(dropTarget, { dataTransfer })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Maximal 3 Fotos/i)
    })
    expect(screen.getByTestId('staged-count')).toHaveTextContent('3')
  })

  it('revokes all staged blob URLs on unmount to avoid leaking them', () => {
    const createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:mock/u1')
      .mockReturnValueOnce('blob:mock/u2')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const initial = [
      new File(['a'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
    ]
    const { unmount } = render(withProviders(<StagedHarness initial={initial} />))
    unmount()
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock/u1')
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock/u2')
    createSpy.mockRestore()
    revokeSpy.mockRestore()
  })
})
