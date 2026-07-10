import { describe, expect, test, vi } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: createMock }
    },
  }
})

import { decideViaAnthropic } from './anthropic.js'

describe('decideViaAnthropic', () => {
  test('returns the tool-use payload', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'thinking…' },
        {
          type: 'tool_use',
          name: 'submit_decision',
          input: {
            outcome: 'request-changes',
            summary: 'One blocker.',
            blocking_findings: ['src/a.ts:12 — broken query'],
            escalation_reasons: [],
          },
        },
      ],
    })

    const result = await decideViaAnthropic({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      prompt: 'hello',
    })
    expect(result.outcome).toBe('request-changes')
    expect(result.summary).toBe('One blocker.')
    expect(result.blocking_findings).toEqual(['src/a.ts:12 — broken query'])
  })

  test('throws if the model fails to call the tool', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I refuse.' }],
    })

    await expect(
      decideViaAnthropic({ apiKey: 'k', model: 'm', prompt: 'p' }),
    ).rejects.toThrowError(/tool/i)
  })
})
