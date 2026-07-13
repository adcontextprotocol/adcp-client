import { describe, expect, test } from 'vitest'
import { buildArbiterPrompt, type ArbiterContext } from './decision.js'

function ctx(overrides: Partial<ArbiterContext> = {}): ArbiterContext {
  return {
    repoSlug: 'example-org/example',
    prNumber: 42,
    baseRef: 'main',
    headSha: 'abc123',
    baseSha: 'def456',
    findings: {
      summary: 'No issues.',
      findings: [],
    },
    diffStats: {
      fileCount: 3,
      additions: 50,
      deletions: 10,
      files: ['a.ts', 'b.ts', 'c.ts'],
    },
    highRisk: false,
    highRiskReasons: [],
    gatedPaths: false,
    gatedPathsReasons: [],
    reviewDecision: '',
    protectedBranches: [],
    noAutoApproveTeams: [],
    authorTeamMatches: [],
    priorDecision: null,
    repoContext: null,
    severityRules: '<<severity.md contents>>',
    decisionRules: '<<arbiter-decision.md contents>>',
    ...overrides,
  }
}

describe('buildArbiterPrompt', () => {
  test('includes the severity and decision rule files verbatim', () => {
    const p = buildArbiterPrompt(ctx())
    expect(p).toContain('<<severity.md contents>>')
    expect(p).toContain('<<arbiter-decision.md contents>>')
  })

  test('serializes findings as compact one-line-per-finding', () => {
    const p = buildArbiterPrompt(
      ctx({
        findings: {
          summary: 'one',
          findings: [
            {
              severity: 'high',
              title: 'broken query',
              rationale: 'x',
              file: 'src/q.ts',
              line: 12,
              category: 'correctness',
              posted_inline: true,
            },
          ],
        },
      }),
    )
    expect(p).toContain('[high] src/q.ts:12 — broken query')
  })

  test('mentions high-risk reasons when flagged', () => {
    const p = buildArbiterPrompt(
      ctx({
        highRisk: true,
        highRiskReasons: ['terraform/prod/main.tf (deleted)'],
      }),
    )
    expect(p).toContain('terraform/prod/main.tf (deleted)')
    expect(p).toMatch(/high[_ -]risk/i)
  })

  test('omits repo context when not provided', () => {
    const p = buildArbiterPrompt(ctx({ repoContext: null }))
    expect(p).not.toContain('Repo-specific context')
  })

  test('includes repo context section when provided', () => {
    const p = buildArbiterPrompt(ctx({ repoContext: 'this repo is special' }))
    expect(p).toContain('Repo-specific context')
    expect(p).toContain('this repo is special')
  })

  test('mentions prior decision when present', () => {
    const p = buildArbiterPrompt(
      ctx({
        priorDecision: {
          head: 'old',
          outcome: 'escalate',
          high_risk: true,
          reasons: ['old reason'],
        },
      }),
    )
    expect(p).toContain('Prior decision')
    expect(p).toContain('old reason')
  })

  test('renders prior findings list when present', () => {
    const p = buildArbiterPrompt(
      ctx({
        priorDecision: {
          head: 'old',
          outcome: 'comment',
          high_risk: false,
          reasons: [],
          findings: [
            {
              severity: 'medium',
              title: 'missing timeout',
              file: 'src/client.ts',
              line: 42,
            },
            { severity: 'high', title: 'broken query', file: 'src/db.ts' },
          ],
        },
      }),
    )
    expect(p).toContain('[medium] src/client.ts:42 — missing timeout')
    expect(p).toContain('[high] src/db.ts — broken query')
    expect(p).toContain('Previous findings (what was flagged in that run)')
  })

  test('renders "none" message when prior findings field is an empty array', () => {
    const p = buildArbiterPrompt(
      ctx({
        priorDecision: {
          head: 'old',
          outcome: 'comment',
          high_risk: false,
          reasons: [],
          findings: [],
        },
      }),
    )
    expect(p).toContain(
      'Previous findings: none (no critical/high/medium findings in that run).',
    )
    expect(p).not.toContain('older marker format')
  })

  test('renders "older marker format" message when prior findings field is absent', () => {
    const p = buildArbiterPrompt(
      ctx({
        priorDecision: {
          head: 'old',
          outcome: 'comment',
          high_risk: false,
          reasons: [],
          // findings intentionally omitted (older marker)
        },
      }),
    )
    expect(p).toContain(
      'Previous findings: none recorded (older marker format).',
    )
    expect(p).not.toContain('no critical/high/medium findings in that run')
  })

  test('does not annotate base ref even when protected_branches matches (rule removed)', () => {
    const p = buildArbiterPrompt(
      ctx({ baseRef: 'main', protectedBranches: ['main'] }),
    )
    expect(p).toContain('- Base ref: main')
    expect(p).not.toContain('(protected)')
  })

  test('mentions gated paths flag and reasons when set', () => {
    const p = buildArbiterPrompt(
      ctx({
        gatedPaths: true,
        gatedPathsReasons: [
          '.github/workflows/deploy.yml (modified) matches `.github/workflows/deploy.yml`',
        ],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    )
    expect(p).toContain('gated_paths: true')
    expect(p).toContain('.github/workflows/deploy.yml (modified) matches')
    expect(p).toContain('review_decision: CHANGES_REQUESTED')
  })

  test('mentions review_decision even when gated_paths is false', () => {
    const p = buildArbiterPrompt(
      ctx({ gatedPaths: false, reviewDecision: 'APPROVED' }),
    )
    expect(p).toContain('gated_paths: false')
    expect(p).toContain('review_decision: APPROVED')
  })

  test('omits gated paths reasons list when gated_paths is false but still renders review_decision', () => {
    const p = buildArbiterPrompt(
      ctx({ gatedPaths: false, gatedPathsReasons: [], reviewDecision: '' }),
    )
    expect(p).toContain('gated_paths: false')
    expect(p).toContain('review_decision: (unknown/none)')
  })

  test('mentions author-team match when set', () => {
    const p = buildArbiterPrompt(
      ctx({ authorTeamMatches: ['example-org/security'] }),
    )
    expect(p).toContain('example-org/security')
  })

  test('caps the file list at 50 with "+N more" footer', () => {
    const files = Array.from({ length: 80 }, (_, i) => `file-${i}.ts`)
    const p = buildArbiterPrompt(
      ctx({ diffStats: { fileCount: 80, additions: 0, deletions: 0, files } }),
    )
    expect(p).toContain('file-0.ts')
    expect(p).toContain('file-49.ts')
    expect(p).not.toContain('file-50.ts')
    expect(p).toContain('+30 more')
  })
})
