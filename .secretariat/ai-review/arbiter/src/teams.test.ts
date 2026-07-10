import { describe, expect, test, vi } from 'vitest'
import { findNoAutoApproveTeams } from './teams.js'

describe('findNoAutoApproveTeams', () => {
  test('returns teams where active membership confirmed', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { state: 'active' } })
      .mockRejectedValueOnce(Object.assign(new Error('404'), { status: 404 }))
    const octokit = {
      rest: { teams: { getMembershipForUserInOrg: get } },
    } as never
    const result = await findNoAutoApproveTeams({
      octokit,
      org: 'org',
      username: 'alice',
      teamSlugs: ['security', 'finance'],
    })
    expect(result).toEqual(['security'])
  })

  test('on unknown error → fail-safe (treats as match)', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('500'), { status: 500 }))
    const octokit = {
      rest: { teams: { getMembershipForUserInOrg: get } },
    } as never
    const result = await findNoAutoApproveTeams({
      octokit,
      org: 'org',
      username: 'alice',
      teamSlugs: ['security'],
    })
    expect(result).toEqual(['security'])
  })

  test('empty teamSlugs → []', async () => {
    const octokit = { rest: { teams: { getMembershipForUserInOrg: vi.fn() } } } as never
    const result = await findNoAutoApproveTeams({
      octokit,
      org: 'org',
      username: 'alice',
      teamSlugs: [],
    })
    expect(result).toEqual([])
  })
})
