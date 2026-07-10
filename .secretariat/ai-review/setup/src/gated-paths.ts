import {
  evaluatePathGlobs,
  type ChangedFile,
  type GlobMatchResult,
} from './high-risk.js'

export type GatedPathsResult = GlobMatchResult

export function evaluateGatedPaths(params: {
  files: ChangedFile[]
  globs: string[]
}): GatedPathsResult {
  return evaluatePathGlobs(params)
}
