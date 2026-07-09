import type { AaoSecretariatConfig } from './aao-secretariat-md.js'

export interface ActionInputs {
  highRiskPaths?: string[]
  gatedPaths?: string[]
  trivialPaths?: string[]
  releaseStackBranches?: string[]
  skipBotAuthors?: string[]
  protectedBranches?: string[]
  noAutoApproveTeams?: string[]
  escalationReviewers?: string[]
}

export interface ResolvedConfig {
  repoContext: string | null
  highRiskPaths: string[]
  gatedPaths: string[]
  escalationReviewers: string[]
  noAutoApproveTeams: string[]
  protectedBranches: string[]
  trivialPaths: string[]
  releaseStackBranches: string[]
  skipBotAuthors: string[]
}

const DEFAULTS = {
  trivialPaths: [
    '.changeset/**',
    '**/*.md',
    '**/__generated__/**',
    '**/dist/**',
    '**/*.snap',
  ],
  releaseStackBranches: ['release/next'],
  skipBotAuthors: [
    'dependabot[bot]',
    'renovate[bot]',
    'github-actions[bot]',
  ],
  protectedBranches: [] as string[],
  noAutoApproveTeams: [] as string[],
  highRiskPaths: [] as string[],
  gatedPaths: [] as string[],
}

function pick<T>(input: T[] | undefined, md: T[], fallback: T[]): T[] {
  if (input && input.length > 0) return input
  if (md.length > 0) return md
  return fallback
}

export function resolveConfig(params: {
  aaoSecretariatMd: AaoSecretariatConfig | null
  actionInputs: ActionInputs
}): ResolvedConfig {
  const md = params.aaoSecretariatMd ?? {
    repoContext: null,
    highRiskPaths: [],
    gatedPaths: [],
    escalationReviewers: [],
    noAutoApproveTeams: [],
    protectedBranches: [],
    trivialPaths: [],
    releaseStackBranches: [],
    skipBotAuthors: [],
  }
  const i = params.actionInputs

  return {
    repoContext: md.repoContext,
    highRiskPaths: pick(
      i.highRiskPaths,
      md.highRiskPaths,
      DEFAULTS.highRiskPaths,
    ),
    gatedPaths: pick(i.gatedPaths, md.gatedPaths, DEFAULTS.gatedPaths),
    escalationReviewers: pick(
      i.escalationReviewers,
      md.escalationReviewers,
      [],
    ),
    noAutoApproveTeams: pick(
      i.noAutoApproveTeams,
      md.noAutoApproveTeams,
      DEFAULTS.noAutoApproveTeams,
    ),
    protectedBranches: pick(
      i.protectedBranches,
      md.protectedBranches,
      DEFAULTS.protectedBranches,
    ),
    trivialPaths: pick(i.trivialPaths, md.trivialPaths, DEFAULTS.trivialPaths),
    releaseStackBranches: pick(
      i.releaseStackBranches,
      md.releaseStackBranches,
      DEFAULTS.releaseStackBranches,
    ),
    skipBotAuthors: pick(
      i.skipBotAuthors,
      md.skipBotAuthors,
      DEFAULTS.skipBotAuthors,
    ),
  }
}
