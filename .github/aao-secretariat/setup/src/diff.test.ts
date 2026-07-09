import { describe, expect, test, vi } from 'vitest'
import { filterTrivialFiles, intersectChangedFiles } from './diff.js'

import { computeChangedFiles, computePrSurfaceFiles, writeDiffFile } from './diff.js'

vi.mock('@actions/exec', () => {
  return {
    exec: vi.fn(),
  }
})

import { exec } from '@actions/exec'

describe('intersectChangedFiles', () => {
  test('returns files present in both lists', () => {
    expect(
      intersectChangedFiles({
        changedSincePrior: ['a.ts', 'b.ts', 'c.ts'],
        currentPrSurface: ['b.ts', 'c.ts', 'd.ts'],
      }),
    ).toEqual(['b.ts', 'c.ts'])
  })

  test('preserves order from currentPrSurface', () => {
    expect(
      intersectChangedFiles({
        changedSincePrior: ['c.ts', 'a.ts'],
        currentPrSurface: ['a.ts', 'b.ts', 'c.ts'],
      }),
    ).toEqual(['a.ts', 'c.ts'])
  })

  test('returns [] when no overlap', () => {
    expect(
      intersectChangedFiles({
        changedSincePrior: ['a.ts'],
        currentPrSurface: ['b.ts'],
      }),
    ).toEqual([])
  })
})

describe('filterTrivialFiles', () => {
  test('removes files matching trivial globs', () => {
    expect(
      filterTrivialFiles({
        files: ['src/index.ts', 'README.md', '.changeset/foo.md', '__generated__/x.ts'],
        trivialGlobs: ['**/*.md', '.changeset/**', '**/__generated__/**'],
      }),
    ).toEqual(['src/index.ts'])
  })

  test('empty trivialGlobs returns input unchanged', () => {
    expect(
      filterTrivialFiles({
        files: ['a.md', 'b.ts'],
        trivialGlobs: [],
      }),
    ).toEqual(['a.md', 'b.ts'])
  })
})

describe('computeChangedFiles', () => {
  test('runs `git diff --name-only A B` and returns file list', async () => {
    vi.mocked(exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('src/a.ts\nsrc/b.ts\n'))
      return 0
    })

    const files = await computeChangedFiles({ fromSha: 'aaaa', toSha: 'bbbb' })
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', 'aaaa', 'bbbb'],
      expect.objectContaining({ silent: true }),
    )
  })

  test('returns null on git failure', async () => {
    vi.mocked(exec).mockRejectedValueOnce(new Error('boom'))
    const files = await computeChangedFiles({ fromSha: 'a', toSha: 'b' })
    expect(files).toBeNull()
  })
})

describe('computePrSurfaceFiles', () => {
  test('runs `git diff --name-only base...head` (three-dot)', async () => {
    vi.mocked(exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('src/x.ts\n'))
      return 0
    })
    const files = await computePrSurfaceFiles({ baseSha: 'base', headSha: 'head' })
    expect(files).toEqual(['src/x.ts'])
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', 'base...head'],
      expect.objectContaining({ silent: true }),
    )
  })
})

describe('writeDiffFile', () => {
  test('writes `git diff base...head` output to the target path and returns it', async () => {
    vi.mocked(exec).mockImplementation(async (_cmd, _args, opts) => {
      opts?.listeners?.stdout?.(Buffer.from('diff --git a/x b/x\n'))
      return 0
    })
    const { mkdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = join(tmpdir(), `aao-secretariat-test-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const target = join(dir, 'diff.patch')

    const written = await writeDiffFile({ baseSha: 'base', headSha: 'head', target })
    expect(written).toBe(target)
    const fs = await import('node:fs/promises')
    expect(await fs.readFile(target, 'utf8')).toContain('diff --git')
  })
})
