import { describe, expect, test } from 'vitest'
import { parseDiffStats } from './diff-stats.js'

describe('parseDiffStats', () => {
  test('extracts file count and add/delete totals from numstat output', () => {
    const numstat = '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n0\t3\tREADME.md\n'
    expect(parseDiffStats(numstat)).toEqual({
      fileCount: 3,
      additions: 15,
      deletions: 5,
      files: ['src/a.ts', 'src/b.ts', 'README.md'],
    })
  })

  test('handles binary files (- and -)', () => {
    const numstat = '-\t-\tassets/logo.png\n2\t1\tsrc/a.ts\n'
    const result = parseDiffStats(numstat)
    expect(result.fileCount).toBe(2)
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(1)
    expect(result.files).toEqual(['assets/logo.png', 'src/a.ts'])
  })

  test('empty input → zeros', () => {
    expect(parseDiffStats('')).toEqual({
      fileCount: 0,
      additions: 0,
      deletions: 0,
      files: [],
    })
  })
})
