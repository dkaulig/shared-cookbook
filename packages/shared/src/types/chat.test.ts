import { describe, expect, it } from 'vitest'
import type {
  ChatMessageDto,
  ChatRole,
  ChatRoleWire,
  ChatSessionListItem,
  CreateSessionResponse,
  RenameSessionRequest,
  SseChunk,
  SseDoneData,
  SseErrorData,
  SseMessageStartedData,
  SseTokenData,
  SseUsageData,
  TurnRequest,
} from './chat.ts'

/**
 * Type-level regression tests for the CR2 chat DTOs. A breaking rename
 * on the .NET side (ChatEndpoints.cs) flushes out here first.
 */

describe('chat.ts DTOs (CR2)', () => {
  it('ChatRole covers user + assistant (UI-side emissions)', () => {
    const roles: ChatRole[] = ['user', 'assistant']
    expect(roles).toHaveLength(2)
  })

  it('ChatRoleWire also covers system (history reads include the priming row)', () => {
    const roles: ChatRoleWire[] = ['user', 'assistant', 'system']
    expect(roles).toHaveLength(3)
  })

  it('ChatSessionListItem carries the sessions-list row shape', () => {
    const row: ChatSessionListItem = {
      id: '5f7c7d4c-6c3d-4a5e-9e2a-4a5e3c4d5e6f',
      title: 'Pasta-Abend',
      messageCount: 4,
      createdAt: '2026-04-20T10:00:00.000Z',
      updatedAt: '2026-04-20T10:02:00.000Z',
    }
    expect(row.title).toContain('Pasta')
    expect(row.messageCount).toBe(4)
  })

  it('ChatSessionListItem.title can be null (pre-auto-title state)', () => {
    const row: ChatSessionListItem = {
      id: '5f7c7d4c-6c3d-4a5e-9e2a-4a5e3c4d5e6f',
      title: null,
      messageCount: 0,
      createdAt: '2026-04-20T10:00:00.000Z',
      updatedAt: '2026-04-20T10:00:00.000Z',
    }
    expect(row.title).toBeNull()
  })

  it('ChatMessageDto mirrors the /messages row shape', () => {
    const msg: ChatMessageDto = {
      id: 'ab3b6a9e-1234-5678-9abc-def012345678',
      role: 'assistant',
      content: 'Wie viele Portionen?',
      createdAt: '2026-04-20T10:01:00.000Z',
    }
    expect(msg.role).toBe('assistant')
    expect(msg.content).toContain('Portionen')
  })

  it('TurnRequest carries only content (the session id lives on the URL)', () => {
    const req: TurnRequest = { content: 'Ich hab Kartoffeln übrig.' }
    expect(req.content).toContain('Kartoffeln')
  })

  it('CreateSessionResponse wraps the new session id', () => {
    const res: CreateSessionResponse = { sessionId: 'deadbeef-0000-0000-0000-000000000000' }
    expect(res.sessionId).toContain('-')
  })

  it('RenameSessionRequest carries a single title field', () => {
    const req: RenameSessionRequest = { title: 'Spätzle-Tag' }
    expect(req.title).toContain('Spätzle')
  })

  it('SseChunk event names cover the documented SSE schema', () => {
    const events: SseChunk['event'][] = [
      'message-started', 'token', 'usage', 'done', 'heartbeat', 'error',
    ]
    expect(events).toHaveLength(6)
  })

  it('Per-event SSE payload shapes match the .NET contract', () => {
    const started: SseMessageStartedData = { messageId: 'x', role: 'assistant' }
    const token: SseTokenData = { text: 'Hallo' }
    const usage: SseUsageData = { promptTokens: 42, completionTokens: 9, cachedPromptTokens: 0 }
    const done: SseDoneData = { messageId: 'x' }
    const err: SseErrorData = { code: 'azure_unavailable', message: 'Dienst offline.' }

    expect(started.role).toBe('assistant')
    expect(token.text).toBe('Hallo')
    expect(usage.promptTokens + usage.completionTokens).toBe(51)
    expect(done.messageId).toBe('x')
    expect(err.code).toBe('azure_unavailable')
  })
})
