import picomatch from 'picomatch'
import { writeFile } from 'node:fs/promises'
import * as core from '@actions/core'
import type * as github from '@actions/github'
import type { ChangeKind, ChangedFile } from './high-risk.js'

type Octokit = ReturnType<typeof github.getOctokit>

/**
 * Maps a GitHub file `status` (added|removed|modified|renamed|copied|changed|
 * unchanged) onto the SDK's ChangeKind contract.
 */
function mapStatus(status: string): ChangeKind {
  switch (status) {
    case 'added':
      return 'added'
    case 'removed':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

export function intersectChangedFiles(params: {
  changedSincePrior: string[]
  currentPrSurface: string[]
}): string[] {
  const { changedSincePrior, currentPrSurface } = params
  const set = new Set(changedSincePrior)
  return currentPrSurface.filter((f) => set.has(f))
}

export function filterTrivialFiles(params: {
  files: string[]
  trivialGlobs: string[]
}): string[] {
  const { files, trivialGlobs } = params
  if (trivialGlobs.length === 0) return [...files]
  const isTrivial = picomatch(trivialGlobs)
  return files.filter((f) => !isTrivial(f))
}

/**
 * Delta since the prior review: files changed between two commits, derived from
 * the GitHub compare API (never fetches the PR head). Returns null on error so
 * callers can fall back to the tree-SHA comparison for unreachable commits.
 */
export async function computeChangedFiles(params: {
  octokit: Octokit
  owner: string
  repo: string
  fromSha: string
  toSha: string
}): Promise<string[] | null> {
  const { octokit, owner, repo, fromSha, toSha } = params
  const basehead = `${fromSha}...${toSha}`
  try {
    const res = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
    })
    const returnedCommits = res.data.commits?.length ?? 0
    if (
      typeof res.data.total_commits === 'number' &&
      res.data.total_commits > returnedCommits
    ) {
      core.info(
        `compare ${basehead}: ${res.data.total_commits} commits total but only ${returnedCommits} returned — delta file list may be truncated.`,
      )
    }
    const files = res.data.files ?? []
    if (files.length >= 300) {
      core.info(
        `compare ${basehead} returned ${files.length} files — GitHub caps the compare file list at 300; delta may be truncated.`,
      )
    }
    return files.map((f) => f.filename)
  } catch (err) {
    core.warning(
      `compare ${basehead} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

/**
 * The PR's changed-file surface (equivalent to `base...head`), sourced from the
 * pulls.listFiles API — never fetches or checks out the PR head. Each file
 * carries its ChangeKind so high-risk / gated-path evaluation needs no extra
 * API call.
 */
export async function computePrSurfaceFiles(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
}): Promise<ChangedFile[]> {
  const { octokit, owner, repo, prNumber } = params
  try {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })
    return files.map((f) => ({
      path: f.filename,
      changeKind: mapStatus(f.status),
    }))
  } catch (err) {
    core.info(
      `pulls.listFiles for #${prNumber} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
}

/**
 * Writes a unified diff to `target`, fetched entirely from the GitHub API — the
 * PR head is never fetched or checked out. Pass `prNumber` for the whole-PR
 * diff, or `fromSha`+`toSha` for the delta (prior review → head) diff. Returns
 * `target`.
 */
export async function writeDiffFile(params: {
  octokit: Octokit
  owner: string
  repo: string
  target: string
  prNumber?: number
  fromSha?: string
  toSha?: string
}): Promise<string> {
  const { octokit, owner, repo, target, prNumber, fromSha, toSha } = params
  let diff: string
  if (fromSha !== undefined && toSha !== undefined) {
    const res = await octokit.request(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      {
        owner,
        repo,
        basehead: `${fromSha}...${toSha}`,
        mediaType: { format: 'diff' },
      },
    )
    diff = res.data as unknown as string
  } else if (prNumber !== undefined) {
    const res = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
      },
    )
    diff = res.data as unknown as string
  } else {
    throw new Error(
      'writeDiffFile requires either prNumber (full PR diff) or fromSha+toSha (delta diff)',
    )
  }
  await writeFile(target, diff)
  return target
}
