import { describe, expect, test, vi } from 'vitest'
import { mapOutcomeToReviewEvent, ensureLabel, postReview } from './post.js'

describe('mapOutcomeToReviewEvent', () => {
  test('approve → APPROVE', () => {
    expect(mapOutcomeToReviewEvent('approve')).toBe('APPROVE')
  })
  test('request-changes → REQUEST_CHANGES', () => {
    expect(mapOutcomeToReviewEvent('request-changes')).toBe('REQUEST_CHANGES')
  })
  test('comment → COMMENT', () => {
    expect(mapOutcomeToReviewEvent('comment')).toBe('COMMENT')
  })
  test('escalate → COMMENT (escalation handled separately)', () => {
    expect(mapOutcomeToReviewEvent('escalate')).toBe('COMMENT')
  })
})

describe('ensureLabel', () => {
  test('creates label when not present (404 then create)', async () => {
    const get = vi.fn().mockRejectedValueOnce(Object.assign(new Error('404'), { status: 404 }))
    const create = vi.fn().mockResolvedValueOnce({ data: {} })
    const octokit = { rest: { issues: { getLabel: get, createLabel: create } } } as never
    await ensureLabel({ octokit, owner: 'o', repo: 'r', name: 'aao-secretariat/needs-human-review' })
    expect(create).toHaveBeenCalled()
  })
  test('no-op when label exists', async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: { name: 'aao-secretariat/x' } })
    const create = vi.fn()
    const octokit = { rest: { issues: { getLabel: get, createLabel: create } } } as never
    await ensureLabel({ octokit, owner: 'o', repo: 'r', name: 'aao-secretariat/x' })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('postReview', () => {
  test('falls back to COMMENT on 422 (cannot approve own PR)', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('422'), { status: 422 }))
      .mockResolvedValueOnce({ data: {} })
    const octokit = { rest: { pulls: { createReview } } } as never
    await postReview({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      headSha: 'h',
      event: 'APPROVE',
      body: 'x',
    })
    expect(createReview).toHaveBeenCalledTimes(2)
    expect(createReview.mock.calls[1][0].event).toBe('COMMENT')
  })
})
