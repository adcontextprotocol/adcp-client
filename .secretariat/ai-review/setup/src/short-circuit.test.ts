import { describe, expect, test } from 'vitest'
import { evaluateShortCircuit, type ShortCircuitContext } from './short-circuit.js'

function ctx(overrides: Partial<ShortCircuitContext> = {}): ShortCircuitContext {
  return {
    prState: 'open',
    isDraft: false,
    hasForceReviewLabel: false,
    authorLogin: 'alice',
    triggeringActor: 'alice',
    aaoSecretariatBotLogin: 'aao-secretariat-the-approver[bot]',
    skipBotAuthors: ['dependabot[bot]', 'example-bot[bot]'],
    mergeable: true,
    headRef: 'feature/foo',
    releaseStackBranches: ['release/next'],
    eventName: 'pull_request',
    eventAction: 'opened',
    deltaFiles: ['src/foo.ts'],
    deltaFilesAfterTrivialFilter: ['src/foo.ts'],
    isPureRebase: false,
    ...overrides,
  }
}

describe('evaluateShortCircuit', () => {
  test('open PR with diff → should-run=true', () => {
    expect(evaluateShortCircuit(ctx())).toEqual({ shouldRun: true, skipReason: null })
  })

  test('closed PR → skip with pr-closed', () => {
    expect(evaluateShortCircuit(ctx({ prState: 'closed' }))).toEqual({
      shouldRun: false,
      skipReason: 'pr-closed',
    })
  })

  test('draft without force-review label → skip with pr-draft', () => {
    expect(evaluateShortCircuit(ctx({ isDraft: true }))).toEqual({
      shouldRun: false,
      skipReason: 'pr-draft',
    })
  })

  test('draft WITH force-review label → should-run=true', () => {
    expect(
      evaluateShortCircuit(ctx({ isDraft: true, hasForceReviewLabel: true })),
    ).toEqual({ shouldRun: true, skipReason: null })
  })

  test('bot author → skip with bot-author', () => {
    expect(evaluateShortCircuit(ctx({ authorLogin: 'dependabot[bot]' }))).toEqual({
      shouldRun: false,
      skipReason: 'bot-author',
    })
  })

  test('bot author (example-bot) → skip', () => {
    expect(
      evaluateShortCircuit(ctx({ authorLogin: 'example-bot[bot]' })),
    ).toEqual({ shouldRun: false, skipReason: 'bot-author' })
  })

  test('merge conflicts → skip with merge-conflicts', () => {
    expect(evaluateShortCircuit(ctx({ mergeable: false }))).toEqual({
      shouldRun: false,
      skipReason: 'merge-conflicts',
    })
  })

  test('head ref in release-stack-branches → skip with release-stack-branch', () => {
    expect(evaluateShortCircuit(ctx({ headRef: 'release/next' }))).toEqual({
      shouldRun: false,
      skipReason: 'release-stack-branch',
    })
  })

  test('pure rebase on synchronize → skip with pure-rebase', () => {
    expect(
      evaluateShortCircuit(ctx({ eventAction: 'synchronize', isPureRebase: true })),
    ).toEqual({ shouldRun: false, skipReason: 'pure-rebase' })
  })

  test('empty delta on synchronize → skip with empty-delta', () => {
    expect(
      evaluateShortCircuit(
        ctx({
          eventAction: 'synchronize',
          deltaFiles: [],
          deltaFilesAfterTrivialFilter: [],
        }),
      ),
    ).toEqual({ shouldRun: false, skipReason: 'empty-delta' })
  })

  test('all-trivial delta on synchronize → skip with empty-delta', () => {
    expect(
      evaluateShortCircuit(
        ctx({
          eventAction: 'synchronize',
          deltaFiles: ['README.md'],
          deltaFilesAfterTrivialFilter: [],
        }),
      ),
    ).toEqual({ shouldRun: false, skipReason: 'empty-delta' })
  })

  test('empty delta on opened → should still run (full review)', () => {
    expect(
      evaluateShortCircuit(
        ctx({
          eventAction: 'opened',
          deltaFiles: [],
          deltaFilesAfterTrivialFilter: [],
        }),
      ),
    ).toEqual({ shouldRun: true, skipReason: null })
  })

  test('triggeringActor matches aaoSecretariatBotLogin → skip with self-triggered', () => {
    expect(
      evaluateShortCircuit(
        ctx({
          triggeringActor: 'aao-secretariat-the-approver[bot]',
          aaoSecretariatBotLogin: 'aao-secretariat-the-approver[bot]',
        }),
      ),
    ).toEqual({ shouldRun: false, skipReason: 'self-triggered' })
  })

  test('triggeringActor matches but aaoSecretariatBotLogin empty → still runs', () => {
    expect(
      evaluateShortCircuit(
        ctx({
          triggeringActor: 'aao-secretariat-the-approver[bot]',
          aaoSecretariatBotLogin: '',
        }),
      ),
    ).toEqual({ shouldRun: true, skipReason: null })
  })

  test('precedence: closed beats every other condition', () => {
    expect(
      evaluateShortCircuit(
        ctx({
          prState: 'closed',
          isDraft: true,
          mergeable: false,
          authorLogin: 'dependabot[bot]',
        }),
      ),
    ).toEqual({ shouldRun: false, skipReason: 'pr-closed' })
  })
})
