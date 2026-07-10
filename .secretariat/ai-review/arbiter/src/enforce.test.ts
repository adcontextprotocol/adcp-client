import { describe, expect, test } from 'vitest'
import { enforceDecisionGuards } from './enforce.js'

const baseDecision = {
  outcome: 'approve' as const,
  summary: 'Clean review.',
  blocking_findings: [],
  escalation_reasons: [],
}

describe('enforceDecisionGuards', () => {
  test('no overrides when authorTeamMatches is empty', () => {
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: [],
    })
    expect(result.decision).toEqual(baseDecision)
    expect(result.overrides).toEqual([])
  })

  test('overrides approve → comment when authorTeamMatches has entries', () => {
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: ['example-org/security'],
    })
    expect(result.decision.outcome).toBe('comment')
    expect(result.overrides).toHaveLength(1)
    expect(result.overrides[0]).toContain('example-org/security')
  })

  test('does not override request-changes', () => {
    const decision = { ...baseDecision, outcome: 'request-changes' as const }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: ['some/team'],
    })
    expect(result.decision.outcome).toBe('request-changes')
    expect(result.overrides).toEqual([])
  })

  test('does not override escalate', () => {
    const decision = { ...baseDecision, outcome: 'escalate' as const }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: ['some/team'],
    })
    expect(result.decision.outcome).toBe('escalate')
    expect(result.overrides).toEqual([])
  })

  test('no-op when LLM already chose comment', () => {
    const decision = { ...baseDecision, outcome: 'comment' as const }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: ['some/team'],
    })
    expect(result.decision.outcome).toBe('comment')
    expect(result.overrides).toEqual([])
  })

  test('prepends override notice to summary', () => {
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: ['org/team'],
    })
    expect(result.decision.summary).toContain('Override')
    expect(result.decision.summary).toContain('org/team')
    expect(result.decision.summary).toContain(baseDecision.summary)
  })

  test('lists multiple matching teams in the override reason', () => {
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: ['org/security', 'org/finance'],
    })
    expect(result.overrides[0]).toContain('org/security')
    expect(result.overrides[0]).toContain('org/finance')
  })

  test('preserves blocking_findings and escalation_reasons untouched', () => {
    const decision = {
      ...baseDecision,
      blocking_findings: ['x'],
      escalation_reasons: ['y'],
    }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: ['some/team'],
    })
    expect(result.decision.blocking_findings).toEqual(['x'])
    expect(result.decision.escalation_reasons).toEqual(['y'])
  })

  test('no override when gatedPaths is false', () => {
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: [],
      gatedPaths: false,
      reviewDecision: '',
    })
    expect(result.decision).toEqual(baseDecision)
    expect(result.overrides).toEqual([])
  })

  test('no override when gatedPaths is true and reviewDecision is APPROVED', () => {
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: [],
      gatedPaths: true,
      gatedPathsReasons: [
        '.github/workflows/deploy.yml (modified) matches `.github/workflows/deploy.yml`',
      ],
      reviewDecision: 'APPROVED',
    })
    expect(result.decision).toEqual(baseDecision)
    expect(result.overrides).toEqual([])
  })

  test.each(['CHANGES_REQUESTED', 'REVIEW_REQUIRED', ''])(
    'overrides approve → escalate when gatedPaths is true and reviewDecision is %s',
    (reviewDecision) => {
      const result = enforceDecisionGuards(baseDecision, {
        authorTeamMatches: [],
        gatedPaths: true,
        gatedPathsReasons: [
          '.github/workflows/deploy.yml (modified) matches `.github/workflows/deploy.yml`',
        ],
        reviewDecision,
      })
      expect(result.decision.outcome).toBe('escalate')
      expect(result.overrides).toHaveLength(1)
      expect(result.overrides[0]).toContain('.github/workflows/deploy.yml')
    },
  )

  test('does not change outcome for request-changes / escalate / comment when gatedPaths is unsatisfied', () => {
    for (const outcome of ['request-changes', 'escalate', 'comment'] as const) {
      const decision = { ...baseDecision, outcome }
      const result = enforceDecisionGuards(decision, {
        authorTeamMatches: [],
        gatedPaths: true,
        reviewDecision: 'REVIEW_REQUIRED',
      })
      expect(result.decision.outcome).toBe(outcome)
    }
  })

  test('no-op for request-changes / comment when gatedPaths is unsatisfied (reason only merges into escalate)', () => {
    for (const outcome of ['request-changes', 'comment'] as const) {
      const decision = { ...baseDecision, outcome }
      const result = enforceDecisionGuards(decision, {
        authorTeamMatches: [],
        gatedPaths: true,
        reviewDecision: 'REVIEW_REQUIRED',
      })
      expect(result.overrides).toEqual([])
      expect(result.decision.escalation_reasons).toEqual([])
    }
  })

  test('merges gated-paths reason into escalation_reasons when the LLM already escalated for an unrelated reason', () => {
    // The LLM chose `escalate` on its own (e.g. row 4/5: high-risk modified +
    // medium finding) while the gated-paths gate is independently
    // unsatisfied. A human reading escalation_reasons must see BOTH triggers
    // — not just whichever one the LLM happened to cite.
    const decision = {
      ...baseDecision,
      outcome: 'escalate' as const,
      escalation_reasons: ['unrelated high-risk finding'],
    }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: [],
      gatedPaths: true,
      gatedPathsReasons: ['.github/workflows/deploy.yml (modified) matches `.github/workflows/deploy.yml`'],
      reviewDecision: 'REVIEW_REQUIRED',
    })
    expect(result.decision.outcome).toBe('escalate')
    expect(result.decision.escalation_reasons).toEqual([
      'unrelated high-risk finding',
      result.overrides[0],
    ])
    expect(result.overrides).toHaveLength(1)
    expect(result.overrides[0]).toContain('.github/workflows/deploy.yml')
    // Summary is untouched — only escalation_reasons gains the entry; no
    // "[Override: forced from approve...]" banner applies since the outcome
    // didn't change.
    expect(result.decision.summary).toBe(baseDecision.summary)
  })

  test('does not duplicate the gated-paths reason if the LLM already cited it verbatim', () => {
    const gatedPathsReasons = ['.github/workflows/deploy.yml (modified) matches `.github/workflows/deploy.yml`']
    const reason = `This PR touches a path under a hard, non-overridable approval gate (${gatedPathsReasons.join('; ')}) and the current GitHub review decision is 'REVIEW_REQUIRED', not APPROVED. This is a hard gate enforced in code — AAO-SECRETARIAT cannot auto-approve until a human/CODEOWNERS approval is recorded, regardless of how clean the diff is.`
    const decision = {
      ...baseDecision,
      outcome: 'escalate' as const,
      escalation_reasons: [reason],
    }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: [],
      gatedPaths: true,
      gatedPathsReasons,
      reviewDecision: 'REVIEW_REQUIRED',
    })
    expect(result.decision.escalation_reasons).toEqual([reason])
    expect(result.overrides).toEqual([])
  })

  test('gatedPaths override prepends override notice to summary and appends to escalation_reasons', () => {
    const decision = {
      ...baseDecision,
      escalation_reasons: ['pre-existing reason'],
    }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: [],
      gatedPaths: true,
      gatedPathsReasons: ['deploy.yml (modified) matches `deploy.yml`'],
      reviewDecision: 'CHANGES_REQUESTED',
    })
    expect(result.decision.summary).toContain('Override')
    expect(result.decision.summary).toContain(baseDecision.summary)
    expect(result.decision.escalation_reasons).toEqual([
      'pre-existing reason',
      result.overrides[0],
    ])
  })

  test('gatedPaths override preserves blocking_findings untouched', () => {
    const decision = { ...baseDecision, blocking_findings: ['x'] }
    const result = enforceDecisionGuards(decision, {
      authorTeamMatches: [],
      gatedPaths: true,
      reviewDecision: '',
    })
    expect(result.decision.blocking_findings).toEqual(['x'])
  })

  test('combined: both authorTeamMatches and unsatisfied gatedPaths → escalate wins, not comment', () => {
    // Gated-paths is checked first and moves the outcome off `approve`, so
    // the author-team block's `outcome === 'approve'` guard no longer fires.
    // This is the intentional ordering fix — escalate is the stronger,
    // more restrictive outcome and must not be silently downgraded to
    // comment just because an author-team gate also applies.
    const result = enforceDecisionGuards(baseDecision, {
      authorTeamMatches: ['example-org/security'],
      gatedPaths: true,
      gatedPathsReasons: ['deploy.yml (modified) matches `deploy.yml`'],
      reviewDecision: 'REVIEW_REQUIRED',
    })
    expect(result.decision.outcome).toBe('escalate')
    expect(result.overrides).toHaveLength(1)
    expect(result.overrides[0]).toContain('deploy.yml')
    expect(result.overrides[0]).not.toContain('example-org/security')
  })
})
