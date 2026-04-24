import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { useAuthStore } from './authStore'
import { __resetApiClient } from './apiClient'
import { changeDisplayName, changePassword } from './accountClient'

function seedSession() {
  useAuthStore.getState().setSession('memory-access-token', {
    id: 'u1',
    email: 'test@example.com',
    displayName: 'David',
    role: 'User',
  })
}

describe('accountClient', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    __resetApiClient()
    seedSession()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  describe('changePassword', () => {
    it('posts the request body to /api/account/change-password and resolves on 204', async () => {
      let capturedBody: unknown = null
      let capturedAuth: string | null = null
      server.use(
        http.post('/api/account/change-password', async ({ request }) => {
          capturedBody = await request.json()
          capturedAuth = request.headers.get('Authorization')
          return new HttpResponse(null, { status: 204 })
        }),
      )

      await expect(
        changePassword({
          currentPassword: 'old',
          newPassword: 'new',
          newPasswordConfirm: 'new',
        }),
      ).resolves.toBeUndefined()

      expect(capturedBody).toEqual({
        currentPassword: 'old',
        newPassword: 'new',
        newPasswordConfirm: 'new',
      })
      expect(capturedAuth).toBe('Bearer memory-access-token')
    })

    it('throws an ApiError-shaped Error when the server responds with 401', async () => {
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            { code: 'invalid_credentials', message: 'Aktuelles Passwort ist falsch.' },
            { status: 401 },
          ),
        ),
      )

      await expect(
        changePassword({
          currentPassword: 'wrong',
          newPassword: 'new',
          newPasswordConfirm: 'new',
        }),
      ).rejects.toMatchObject({
        code: 'invalid_credentials',
        message: 'Aktuelles Passwort ist falsch.',
      })
    })

    it('throws a password_rejected error when the server responds with 400', async () => {
      server.use(
        http.post('/api/account/change-password', () =>
          HttpResponse.json(
            { code: 'password_rejected', message: 'Passwort ist zu kurz (mindestens 8 Zeichen).' },
            { status: 400 },
          ),
        ),
      )

      await expect(
        changePassword({
          currentPassword: 'old',
          newPassword: 'short',
          newPasswordConfirm: 'short',
        }),
      ).rejects.toMatchObject({ code: 'password_rejected' })
    })
  })

  describe('changeDisplayName', () => {
    it('patches /api/account/display-name and resolves with the updated AuthUser', async () => {
      let capturedBody: unknown = null
      server.use(
        http.patch('/api/account/display-name', async ({ request }) => {
          capturedBody = await request.json()
          return HttpResponse.json({
            id: 'u1',
            email: 'test@example.com',
            displayName: 'Neuer Name',
            role: 'User',
          })
        }),
      )

      const user = await changeDisplayName({ displayName: 'Neuer Name' })

      expect(capturedBody).toEqual({ displayName: 'Neuer Name' })
      expect(user.displayName).toBe('Neuer Name')
    })

    it('throws a displayname_invalid error when the server responds with 400', async () => {
      server.use(
        http.patch('/api/account/display-name', () =>
          HttpResponse.json(
            { code: 'displayname_invalid', message: 'Anzeigename muss zwischen 2 und 50 Zeichen lang sein.' },
            { status: 400 },
          ),
        ),
      )

      await expect(changeDisplayName({ displayName: 'A' })).rejects.toMatchObject({
        code: 'displayname_invalid',
      })
    })
  })
})
