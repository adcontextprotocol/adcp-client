import { describe, expect, test, vi } from 'vitest'
import {
  computeChangedFiles,
  computePrSurfaceFiles,
  filterTrivialFiles,
  intersectChangedFiles,
  writeDiffFile,
} from './diff.js'

async function tmpTarget(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'aao-secretariat-test-'))
  return join(dir, 'diff.patch')
}

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

describe('computePrSurfaceFiles', () => {
  test('lists PR files via the API and maps change kinds', async () => {
    const octokit: any = {
      paginate: vi.fn().mockResolvedValue([
        { filename: 'src/a.ts', status: 'added' },
        { filename: 'src/b.ts', status: 'modified' },
        { filename: 'src/c.ts', status: 'removed' },
        { filename: 'src/d.ts', status: 'renamed' },
        { filename: 'src/e.ts', status: 'copied' },
      ]),
      rest: { pulls: { listFiles: vi.fn() } },
    }
    const files = await computePrSurfaceFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
    })
    expect(files).toEqual([
      { path: 'src/a.ts', changeKind: 'added' },
      { path: 'src/b.ts', changeKind: 'modified' },
      { path: 'src/c.ts', changeKind: 'deleted' },
      { path: 'src/d.ts', changeKind: 'renamed' },
      { path: 'src/e.ts', changeKind: 'modified' },
    ])
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.pulls.listFiles,
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        pull_number: 7,
        per_page: 100,
      }),
    )
  })

  test('returns [] on API error', async () => {
    const octokit: any = {
      paginate: vi.fn().mockRejectedValue(new Error('boom')),
      rest: { pulls: { listFiles: vi.fn() } },
    }
    expect(
      await computePrSurfaceFiles({ octokit, owner: 'o', repo: 'r', prNumber: 7 }),
    ).toEqual([])
  })
})

describe('computeChangedFiles', () => {
  test('compares fromSha...toSha via the API and returns filenames', async () => {
    const octokit: any = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi.fn().mockResolvedValue({
            data: {
              files: [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }],
              total_commits: 2,
              commits: [{}, {}],
            },
          }),
        },
      },
    }
    const files = await computeChangedFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      fromSha: 'aaaa',
      toSha: 'bbbb',
    })
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', basehead: 'aaaa...bbbb' }),
    )
  })

  test('returns [] when the API omits files', async () => {
    const octokit: any = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi
            .fn()
            .mockResolvedValue({ data: { total_commits: 0, commits: [] } }),
        },
      },
    }
    expect(
      await computeChangedFiles({
        octokit,
        owner: 'o',
        repo: 'r',
        fromSha: 'a',
        toSha: 'b',
      }),
    ).toEqual([])
  })

  test('returns null on API error', async () => {
    const octokit: any = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi.fn().mockRejectedValue(new Error('boom')),
        },
      },
    }
    expect(
      await computeChangedFiles({
        octokit,
        owner: 'o',
        repo: 'r',
        fromSha: 'a',
        toSha: 'b',
      }),
    ).toBeNull()
  })
})

describe('writeDiffFile', () => {
  test('full PR diff: requests pulls diff media type and writes it', async () => {
    const octokit: any = {
      request: vi.fn().mockResolvedValue({ data: 'diff --git a/x b/x\n' }),
    }
    const target = await tmpTarget()
    const written = await writeDiffFile({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      target,
    })
    expect(written).toBe(target)
    const fs = await import('node:fs/promises')
    expect(await fs.readFile(target, 'utf8')).toContain('diff --git a/x')
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        pull_number: 7,
        mediaType: { format: 'diff' },
      }),
    )
  })

  test('delta diff: requests compare diff media type for from...to', async () => {
    const octokit: any = {
      request: vi.fn().mockResolvedValue({ data: 'diff --git a/y b/y\n' }),
    }
    const target = await tmpTarget()
    const written = await writeDiffFile({
      octokit,
      owner: 'o',
      repo: 'r',
      fromSha: 'p',
      toSha: 'h',
      target,
    })
    expect(written).toBe(target)
    const fs = await import('node:fs/promises')
    expect(await fs.readFile(target, 'utf8')).toContain('diff --git a/y')
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        basehead: 'p...h',
        mediaType: { format: 'diff' },
      }),
    )
  })
})
