import { describe, expect, test } from 'vitest'
import { parseFindings } from './findings.js'

const VALID = JSON.stringify({
  summary: 'one finding',
  findings: [
    {
      severity: 'medium',
      title: 'Missing timeout on fetch',
      rationale: 'No `signal` option set on the fetch call; risk of hung connections.',
      file: 'src/api.ts',
      line: 42,
      category: 'operability',
      posted_inline: true,
    },
  ],
})

describe('parseFindings', () => {
  test('parses a valid payload', () => {
    const result = parseFindings(VALID)
    expect(result.summary).toBe('one finding')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].severity).toBe('medium')
  })

  test('throws on malformed JSON', () => {
    expect(() => parseFindings('not json')).toThrowError(/parse/i)
  })

  test('throws when required fields are missing', () => {
    expect(() => parseFindings('{}')).toThrowError(/findings/)
  })

  test('throws on invalid severity', () => {
    const bad = JSON.stringify({
      summary: 'x',
      findings: [
        {
          severity: 'fatal',
          title: 't',
          rationale: 'r',
          file: 'f',
          category: 'other',
          posted_inline: false,
        },
      ],
    })
    expect(() => parseFindings(bad)).toThrowError(/severity/)
  })

  test('coerces null line to undefined', () => {
    const payload = JSON.parse(VALID)
    payload.findings[0].line = null
    const result = parseFindings(JSON.stringify(payload))
    expect(result.findings[0].line).toBeUndefined()
  })

  test('empty findings array is allowed', () => {
    const empty = JSON.stringify({ summary: 'clean', findings: [] })
    expect(parseFindings(empty).findings).toEqual([])
  })
})
