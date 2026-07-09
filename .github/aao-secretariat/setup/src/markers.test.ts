import { describe, expect, test } from 'vitest'
import { containsMarker, parseDecisionMarker, type PriorDecision, wrapWithMarker } from './markers.js'

describe('wrapWithMarker', () => {
  test('appends an HTML comment marker', () => {
    const body = wrapWithMarker({
      body: 'AAO-SECRETARIAT does not review bot PRs.',
      marker: 'aao-secretariat/bot-skip-noted',
    })
    expect(body).toContain('AAO-SECRETARIAT does not review bot PRs.')
    expect(body).toContain('<!-- aao-secretariat-marker:aao-secretariat/bot-skip-noted -->')
  })
})

describe('containsMarker', () => {
  test('finds marker in a wrapped body', () => {
    const body = wrapWithMarker({ body: 'x', marker: 'aao-secretariat/test' })
    expect(containsMarker(body, 'aao-secretariat/test')).toBe(true)
  })
  test('returns false when marker absent', () => {
    expect(containsMarker('just a comment', 'aao-secretariat/test')).toBe(false)
  })
})

describe('parseDecisionMarker', () => {
  test('extracts JSON from the marker in a body', () => {
    const body =
      'Approve.\n\n<!-- aao-secretariat-decision:\n{"head":"abc","outcome":"escalate","high_risk":true,"reasons":["x"]}\n-->'
    const expected: PriorDecision = {
      head: 'abc',
      outcome: 'escalate',
      high_risk: true,
      reasons: ['x'],
    }
    expect(parseDecisionMarker(body)).toEqual(expected)
  })

  test('returns null when no marker present', () => {
    expect(parseDecisionMarker('plain body')).toBeNull()
  })

  test('returns null on malformed JSON inside marker', () => {
    expect(parseDecisionMarker('<!-- aao-secretariat-decision:\nnot-json\n-->')).toBeNull()
  })
})
