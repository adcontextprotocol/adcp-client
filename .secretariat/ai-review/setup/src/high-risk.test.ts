import { describe, expect, test } from 'vitest'
import { evaluateHighRisk } from './high-risk.js'
import { evaluateGatedPaths } from './gated-paths.js'

describe('evaluateHighRisk', () => {
  test('no globs configured → flag false, reasons empty', () => {
    expect(
      evaluateHighRisk({
        files: [{ path: 'src/foo.ts', changeKind: 'modified' }],
        globs: [],
      }),
    ).toEqual({ flag: false, reasons: [] })
  })

  test('no files matching globs → flag false', () => {
    expect(
      evaluateHighRisk({
        files: [{ path: 'src/foo.ts', changeKind: 'modified' }],
        globs: ['terraform/**/*.tf'],
      }),
    ).toEqual({ flag: false, reasons: [] })
  })

  test('single matching file → flag true with one reason', () => {
    expect(
      evaluateHighRisk({
        files: [{ path: 'terraform/prod/main.tf', changeKind: 'modified' }],
        globs: ['terraform/**/*.tf'],
      }),
    ).toEqual({
      flag: true,
      reasons: [
        'terraform/prod/main.tf (modified) matches `terraform/**/*.tf`',
      ],
    })
  })

  test('multiple matching files → multiple reasons', () => {
    const result = evaluateHighRisk({
      files: [
        { path: 'terraform/prod/main.tf', changeKind: 'deleted' },
        { path: 'apps/web/schema.prisma', changeKind: 'modified' },
      ],
      globs: ['terraform/**/*.tf', '**/schema.prisma'],
    })
    expect(result.flag).toBe(true)
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toContain('terraform/prod/main.tf (deleted)')
    expect(result.reasons[1]).toContain('apps/web/schema.prisma (modified)')
  })

  test('deleted files are tagged "deleted"', () => {
    const result = evaluateHighRisk({
      files: [{ path: 'terraform/prod/main.tf', changeKind: 'deleted' }],
      globs: ['terraform/**'],
    })
    expect(result.reasons[0]).toContain('(deleted)')
  })

  test('shares identical core behavior with evaluateGatedPaths', () => {
    const input = {
      files: [
        { path: 'terraform/prod/main.tf', changeKind: 'modified' as const },
        { path: 'src/foo.ts', changeKind: 'modified' as const },
      ],
      globs: ['terraform/**/*.tf'],
    }
    expect(evaluateHighRisk(input)).toEqual(evaluateGatedPaths(input))
  })
})
