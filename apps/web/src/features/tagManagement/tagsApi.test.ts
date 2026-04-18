import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { TagDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { createGroupTag, deleteGroupTag } from './tagsApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('tagsApi', () => {
  it('createGroupTag POSTs body to group tag endpoint', async () => {
    let body: unknown = null
    server.use(
      http.post('/api/groups/g1/tags', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json<TagDto>({
          id: 't-new',
          name: 'Kinderfreundlich',
          category: 'Custom',
          isGlobal: false,
          groupId: 'g1',
          createdByUserId: 'u1',
        }, { status: 201 })
      }),
    )
    const result = await createGroupTag('g1', { name: 'Kinderfreundlich', category: 'Custom' })
    expect(body).toEqual({ name: 'Kinderfreundlich', category: 'Custom' })
    expect(result.id).toBe('t-new')
  })

  it('deleteGroupTag issues DELETE', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/g1/tags/t-new', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await deleteGroupTag('g1', 't-new')
    expect(called).toBe(true)
  })

  it('createGroupTag throws ApiError on 400 tag_exists', async () => {
    server.use(
      http.post('/api/groups/g1/tags', () =>
        HttpResponse.json({ code: 'tag_exists', message: 'schon da' }, { status: 400 }),
      ),
    )
    await expect(
      createGroupTag('g1', { name: 'Dup', category: 'Custom' }),
    ).rejects.toMatchObject({ code: 'tag_exists' })
  })
})
