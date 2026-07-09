import { describe, expect, test } from 'vitest'
import { resolveConfig } from './resolve-config.js'

describe('resolveConfig', () => {
  test('action input overrides AAO-SECRETARIAT.md for high-risk-paths', () => {
    const result = resolveConfig({
      aaoSecretariatMd: {
        repoContext: null,
        highRiskPaths: ['from-md/**'],
        gatedPaths: [],
        escalationReviewers: [],
        noAutoApproveTeams: [],
        protectedBranches: [],
        trivialPaths: [],
        releaseStackBranches: [],
        skipBotAuthors: [],
      },
      actionInputs: { highRiskPaths: ['from-input/**'] },
    })
    expect(result.highRiskPaths).toEqual(['from-input/**'])
  })

  test('falls back to AAO-SECRETARIAT.md when input is empty', () => {
    const result = resolveConfig({
      aaoSecretariatMd: {
        repoContext: null,
        highRiskPaths: ['from-md/**'],
        gatedPaths: [],
        escalationReviewers: [],
        noAutoApproveTeams: [],
        protectedBranches: [],
        trivialPaths: [],
        releaseStackBranches: [],
        skipBotAuthors: [],
      },
      actionInputs: { highRiskPaths: [] },
    })
    expect(result.highRiskPaths).toEqual(['from-md/**'])
  })

  test('falls back to defaults when both empty', () => {
    const result = resolveConfig({
      aaoSecretariatMd: null,
      actionInputs: { releaseStackBranches: [] },
    })
    expect(result.releaseStackBranches).toEqual(['release/next'])
    expect(result.skipBotAuthors).toContain('dependabot[bot]')
    expect(result.skipBotAuthors).toContain('github-actions[bot]')
  })

  test('repoContext only comes from AAO-SECRETARIAT.md', () => {
    const result = resolveConfig({
      aaoSecretariatMd: {
        repoContext: 'hello',
        highRiskPaths: [],
        gatedPaths: [],
        escalationReviewers: [],
        noAutoApproveTeams: [],
        protectedBranches: [],
        trivialPaths: [],
        releaseStackBranches: [],
        skipBotAuthors: [],
      },
      actionInputs: {},
    })
    expect(result.repoContext).toBe('hello')
  })

  test('gatedPaths resolves via the same override chain as highRiskPaths', () => {
    const md = {
      repoContext: null,
      highRiskPaths: [],
      gatedPaths: ['from-md/**'],
      escalationReviewers: [],
      noAutoApproveTeams: [],
      protectedBranches: [],
      trivialPaths: [],
      releaseStackBranches: [],
      skipBotAuthors: [],
    }

    expect(
      resolveConfig({
        aaoSecretariatMd: md,
        actionInputs: { gatedPaths: ['from-input/**'] },
      }).gatedPaths,
    ).toEqual(['from-input/**'])
    expect(
      resolveConfig({ aaoSecretariatMd: md, actionInputs: { gatedPaths: [] } })
        .gatedPaths,
    ).toEqual(['from-md/**'])
    expect(
      resolveConfig({ aaoSecretariatMd: null, actionInputs: {} }).gatedPaths,
    ).toEqual([])
  })
})
