export type SkipReason =
  | 'pr-closed'
  | 'pr-draft'
  | 'bot-author'
  | 'merge-conflicts'
  | 'release-stack-branch'
  | 'self-triggered'
  | 'pure-rebase'
  | 'empty-delta'

export interface ShortCircuitContext {
  prState: 'open' | 'closed'
  isDraft: boolean
  hasForceReviewLabel: boolean
  authorLogin: string
  triggeringActor: string
  aaoSecretariatBotLogin: string
  skipBotAuthors: string[]
  mergeable: boolean
  headRef: string
  releaseStackBranches: string[]
  eventName: string
  eventAction: string
  deltaFiles: string[]
  deltaFilesAfterTrivialFilter: string[]
  isPureRebase: boolean
}

export interface ShortCircuitDecision {
  shouldRun: boolean
  skipReason: SkipReason | null
}

export function evaluateShortCircuit(ctx: ShortCircuitContext): ShortCircuitDecision {
  if (ctx.prState === 'closed') return { shouldRun: false, skipReason: 'pr-closed' }
  if (ctx.isDraft && !ctx.hasForceReviewLabel)
    return { shouldRun: false, skipReason: 'pr-draft' }
  if (ctx.skipBotAuthors.includes(ctx.authorLogin))
    return { shouldRun: false, skipReason: 'bot-author' }
  if (ctx.triggeringActor && ctx.triggeringActor === ctx.aaoSecretariatBotLogin)
    return { shouldRun: false, skipReason: 'self-triggered' }
  if (!ctx.mergeable) return { shouldRun: false, skipReason: 'merge-conflicts' }
  if (ctx.releaseStackBranches.includes(ctx.headRef))
    return { shouldRun: false, skipReason: 'release-stack-branch' }
  if (ctx.eventAction === 'synchronize') {
    if (ctx.isPureRebase) return { shouldRun: false, skipReason: 'pure-rebase' }
    if (ctx.deltaFiles.length === 0 && ctx.deltaFilesAfterTrivialFilter.length === 0)
      return { shouldRun: false, skipReason: 'empty-delta' }
    if (ctx.deltaFiles.length > 0 && ctx.deltaFilesAfterTrivialFilter.length === 0)
      return { shouldRun: false, skipReason: 'empty-delta' }
  }
  return { shouldRun: true, skipReason: null }
}
