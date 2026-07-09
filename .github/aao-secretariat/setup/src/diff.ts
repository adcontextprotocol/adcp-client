import picomatch from 'picomatch'
import { exec } from '@actions/exec'
import { writeFile } from 'node:fs/promises'
import * as core from '@actions/core'

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

export async function computeChangedFiles(params: {
  fromSha: string
  toSha: string
}): Promise<string[] | null> {
  const { fromSha, toSha } = params
  let out = ''
  try {
    await exec('git', ['diff', '--name-only', fromSha, toSha], {
      listeners: {
        stdout: (data: Buffer) => {
          out += data.toString()
        },
      },
      silent: true,
    })
  } catch (err) {
    core.warning(
      `git diff --name-only ${fromSha} ${toSha} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function computePrSurfaceFiles(params: {
  baseSha: string
  headSha: string
}): Promise<string[]> {
  const { baseSha, headSha } = params
  let out = ''
  try {
    await exec('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      listeners: {
        stdout: (data: Buffer) => {
          out += data.toString()
        },
      },
      silent: true,
    })
  } catch (err) {
    core.info(
      `git diff --name-only ${baseSha}...${headSha} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function writeDiffFile(params: {
  baseSha: string
  headSha: string
  files?: string[]
  target: string
}): Promise<string> {
  const { baseSha, headSha, files, target } = params
  const args = ['diff', `${baseSha}...${headSha}`]
  if (files && files.length > 0) args.push('--', ...files)
  let out = ''
  await exec('git', args, {
    listeners: {
      stdout: (data: Buffer) => {
        out += data.toString()
      },
    },
    silent: true,
  })
  await writeFile(target, out)
  return target
}
