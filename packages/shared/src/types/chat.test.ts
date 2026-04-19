import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRole,
  ChatTurnRequest,
  ChatTurnResponse,
} from './chat.ts'

/**
 * Type-level regression tests — mirror the shape contract with the .NET
 * bridge (`ChatEndpoints.cs`) + the Python chat pipeline
 * (`apps/python-extractor/src/extractor/pipeline/chat.py`). A breaking
 * rename on either side flushes out here.
 */

describe('chat.ts DTOs', () => {
  it('ChatRole covers user + assistant (the two roles emitted by the web surface)', () => {
    const roles: ChatRole[] = ['user', 'assistant']
    expect(roles).toHaveLength(2)
  })

  it('ChatMessage has role + content fields', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: 'Ich hab Kartoffeln, Quark und Lauch.',
    }
    expect(msg.role).toBe('user')
    expect(msg.content).toContain('Kartoffeln')
  })

  it('ChatTurnRequest bundles sessionId + the full message history', () => {
    const req: ChatTurnRequest = {
      sessionId: 'ab3b6a9e-1234-5678-9abc-def012345678',
      messages: [
        { role: 'user', content: 'Was kann ich kochen?' },
        { role: 'assistant', content: 'Wie viele Portionen?' },
        { role: 'user', content: '4 Portionen.' },
      ],
    }
    expect(req.sessionId).toContain('-')
    expect(req.messages).toHaveLength(3)
  })

  it('ChatTurnResponse returns the assistant reply string (camelCase)', () => {
    const res: ChatTurnResponse = {
      assistantMessage: 'Probier Kartoffel-Lauch-Auflauf.',
    }
    expect(res.assistantMessage).toContain('Kartoffel')
  })
})
