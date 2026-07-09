import picomatch from 'picomatch'

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ChangedFile {
  path: string
  changeKind: ChangeKind
}

export interface GlobMatchResult {
  flag: boolean
  reasons: string[]
}

export type HighRiskResult = GlobMatchResult

/**
 * Matches changed files against a glob list, producing human-readable
 * reasons ("path (kind) matches `glob`"). Shared core for evaluateHighRisk
 * (## High-Risk Paths) and evaluateGatedPaths (## Gated Paths).
 */
export function evaluatePathGlobs(params: {
  files: ChangedFile[]
  globs: string[]
}): GlobMatchResult {
  const { files, globs } = params
  if (globs.length === 0) return { flag: false, reasons: [] }
  const matchers = globs.map((g) => ({ glob: g, isMatch: picomatch(g) }))
  const reasons: string[] = []
  for (const file of files) {
    for (const { glob, isMatch } of matchers) {
      if (isMatch(file.path)) {
        reasons.push(`${file.path} (${file.changeKind}) matches \`${glob}\``)
        break
      }
    }
  }
  return { flag: reasons.length > 0, reasons }
}

export function evaluateHighRisk(params: {
  files: ChangedFile[]
  globs: string[]
}): HighRiskResult {
  return evaluatePathGlobs(params)
}
