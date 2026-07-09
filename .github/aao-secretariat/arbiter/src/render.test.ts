import { describe, expect, test } from 'vitest'
import { renderReviewBody } from './render.js'

describe('renderReviewBody', () => {
  test('approve: clean body with summary', () => {
    const body = renderReviewBody({
      decision: {
        outcome: 'approve',
        summary: 'No issues found.',
        blocking_findings: [],
        escalation_reasons: [],
      },
      findings: { summary: 'ok', findings: [] },
      headSha: 'abc',
      highRisk: false,
      highRiskReasons: [],
    })
    expect(body).toContain('## AAO-SECRETARIAT verdict: Approve')
    expect(body).toContain('No issues found.')
    expect(body).toContain('<!-- aao-secretariat-decision:')
  })

  test('request-changes lists blockers', () => {
    const body = renderReviewBody({
      decision: {
        outcome: 'request-changes',
        summary: 'Blocking issues present.',
        blocking_findings: ['src/a.ts:12 — broken query'],
        escalation_reasons: [],
      },
      findings: {
        summary: 'one',
        findings: [
          {
            severity: 'high',
            title: 'broken query',
            rationale: 'x',
            file: 'src/a.ts',
            line: 12,
            category: 'correctness',
            posted_inline: true,
          },
        ],
      },
      headSha: 'abc',
      highRisk: false,
      highRiskReasons: [],
    })
    expect(body).toContain('Request changes')
    expect(body).toContain('src/a.ts:12 — broken query')
  })

  test('escalate body lists reasons', () => {
    const body = renderReviewBody({
      decision: {
        outcome: 'escalate',
        summary: 'Needs human review.',
        blocking_findings: [],
        escalation_reasons: ['terraform/prod deletion'],
      },
      findings: { summary: 'x', findings: [] },
      headSha: 'abc',
      highRisk: true,
      highRiskReasons: ['terraform/prod/main.tf (deleted)'],
    })
    expect(body).toContain('## AAO-SECRETARIAT verdict: Escalate to human review')
    expect(body).toContain('terraform/prod deletion')
  })

  test('body length capped near 4000 chars', () => {
    const big = 'x'.repeat(20_000)
    const body = renderReviewBody({
      decision: {
        outcome: 'comment',
        summary: big,
        blocking_findings: [],
        escalation_reasons: [],
      },
      findings: { summary: 'x', findings: [] },
      headSha: 'abc',
      highRisk: false,
      highRiskReasons: [],
    })
    expect(body.length).toBeLessThanOrEqual(4500)
  })

  test('embeds sticky decision marker with parsable JSON', () => {
    const body = renderReviewBody({
      decision: {
        outcome: 'escalate',
        summary: 's',
        blocking_findings: [],
        escalation_reasons: ['why'],
      },
      findings: { summary: '', findings: [] },
      headSha: 'sha-xyz',
      highRisk: true,
      highRiskReasons: ['x'],
    })
    const match = /<!-- aao-secretariat-decision:\s*([\s\S]*?)\s*-->/.exec(body)
    expect(match).not.toBeNull()
    const decoded = JSON.parse(match![1])
    expect(decoded).toEqual({
      head: 'sha-xyz',
      outcome: 'escalate',
      high_risk: true,
      reasons: ['why'],
      findings: [],
    })
  })
})
