import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
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
