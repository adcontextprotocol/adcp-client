import { describe, expect, test } from 'vitest'

import { isPullRequestEvent } from './event.js'

describe('isPullRequestEvent', () => {
  test.each(['pull_request', 'pull_request_target'])(
    'accepts %s events',
    (eventName) => {
      expect(isPullRequestEvent(eventName)).toBe(true)
    },
  )

  test('rejects unrelated events', () => {
    expect(isPullRequestEvent('push')).toBe(false)
  })
})
