import { exec } from '@actions/exec'
import { readFile } from 'node:fs/promises'

import type { DiffStats } from './decision.js'

export type { DiffStats } from './decision.js'

export function parseDiffStats(numstat: string): DiffStats {
  let additions = 0
  let deletions = 0
  const files: string[] = []
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const adds = parts[0] === '-' ? 0 : Number(parts[0])
    const dels = parts[1] === '-' ? 0 : Number(parts[1])
    additions += Number.isFinite(adds) ? adds : 0
    deletions += Number.isFinite(dels) ? dels : 0
    files.push(parts.slice(2).join('\t'))
  }
  return { fileCount: files.length, additions, deletions, files }
}

export async function computeDiffStatsFromFile(diffPath: string): Promise<DiffStats> {
  // Re-derive numstat from the SHAs is cleaner, but we have only the patch file.
  // Easier: run `git apply --numstat` on the patch.
  const patch = await readFile(diffPath, 'utf8')
  if (!patch.trim()) return { fileCount: 0, additions: 0, deletions: 0, files: [] }
  let out = ''
  await exec('git', ['apply', '--numstat', '--no-index', diffPath], {
    listeners: { stdout: (d: Buffer) => { out += d.toString() } },
    silent: true,
    ignoreReturnCode: true,
  })
  return parseDiffStats(out)
}
