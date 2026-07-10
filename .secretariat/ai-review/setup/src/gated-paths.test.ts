import { describe, expect, test } from 'vitest'
import { evaluateGatedPaths } from './gated-paths.js'

describe('evaluateGatedPaths', () => {
  test('no globs configured → flag false, reasons empty', () => {
    expect(
      evaluateGatedPaths({
        files: [{ path: 'src/foo.ts', changeKind: 'modified' }],
        globs: [],
      }),
    ).toEqual({ flag: false, reasons: [] })
  })

  test('no files matching globs → flag false', () => {
    expect(
      evaluateGatedPaths({
        files: [{ path: 'src/foo.ts', changeKind: 'modified' }],
        globs: ['.github/workflows/deploy.yml'],
      }),
    ).toEqual({ flag: false, reasons: [] })
  })

  test('single matching file → flag true with one reason', () => {
    expect(
      evaluateGatedPaths({
        files: [
          { path: '.github/workflows/deploy.yml', changeKind: 'modified' },
        ],
        globs: ['.github/workflows/deploy.yml'],
      }),
    ).toEqual({
      flag: true,
      reasons: [
        '.github/workflows/deploy.yml (modified) matches `.github/workflows/deploy.yml`',
      ],
    })
  })

  test('multiple matching files → multiple reasons', () => {
    const result = evaluateGatedPaths({
      files: [
        { path: '.github/workflows/deploy.yml', changeKind: 'modified' },
        { path: '.github/workflows/hotfix.yml', changeKind: 'modified' },
      ],
      globs: ['.github/workflows/deploy.yml', '.github/workflows/hotfix.yml'],
    })
    expect(result.flag).toBe(true)
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons[0]).toContain(
      '.github/workflows/deploy.yml (modified)',
    )
    expect(result.reasons[1]).toContain(
      '.github/workflows/hotfix.yml (modified)',
    )
  })

  test('deleted files are tagged "deleted"', () => {
    const result = evaluateGatedPaths({
      files: [{ path: '.github/workflows/deploy.yml', changeKind: 'deleted' }],
      globs: ['.github/workflows/deploy.yml'],
    })
    expect(result.reasons[0]).toContain('(deleted)')
  })
})
