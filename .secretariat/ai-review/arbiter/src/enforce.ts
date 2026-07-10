import type { ArbiterDecision } from './anthropic.js'

export interface EnforcementContext {
  authorTeamMatches: string[]
  gatedPaths?: boolean
  gatedPathsReasons?: string[]
  reviewDecision?: string
}

export interface EnforcementResult {
  decision: ArbiterDecision
  overrides: string[]
}

const NO_AUTO_APPROVE_OVERRIDE_PREFIX =
  '> **[Override: forced from `approve` to `comment` by post-LLM enforcement]**'
const GATED_PATH_OVERRIDE_PREFIX =
  '> **[Override: forced from `approve` to `escalate` by post-LLM enforcement]**'

export function enforceDecisionGuards(
  decision: ArbiterDecision,
  ctx: EnforcementContext,
): EnforcementResult {
  const overrides: string[] = []
  let result = decision

  // Gated-paths mirrors the decision table's row 2 (see arbiter-decision.md):
  // the LLM is expected to apply that row directly and choose `escalate`
  // itself, exactly like the author-team HARD RULE below. This block is the
  // same dual-layer code-level backstop that HARD RULE already documents for
  // author-team gates — not the sole place the gate is evaluated.
  //
  // It runs BEFORE the author-team check: it is the stronger, more
  // restrictive outcome (escalate implies request-reviewers + label, which
  // comment does not trigger). If both gates fail on the same PR, escalate
  // must win — checking author-team first would downgrade to comment and
  // the author-team block's own `outcome === 'approve'` guard would then
  // no-op, silently dropping the gated-paths signal.
  const gateUnsatisfied = Boolean(ctx.gatedPaths) && ctx.reviewDecision !== 'APPROVED'
  if (gateUnsatisfied) {
    const reason = `This PR touches a path under a hard, non-overridable approval gate (${ctx.gatedPathsReasons?.join('; ') || 'gated path matched'}) and the current GitHub review decision is '${ctx.reviewDecision || 'unknown'}', not APPROVED. This is a hard gate enforced in code — AAO-SECRETARIAT cannot auto-approve until a human/CODEOWNERS approval is recorded, regardless of how clean the diff is.`

    if (result.outcome === 'approve') {
      overrides.push(reason)
      result = {
        ...result,
        outcome: 'escalate',
        escalation_reasons: [...result.escalation_reasons, reason],
        summary: `${GATED_PATH_OVERRIDE_PREFIX}\n>\n> ${reason}\n\n${result.summary}`,
      }
    } else if (result.outcome === 'escalate' && !result.escalation_reasons.includes(reason)) {
      // The LLM already escalated — for this row or an unrelated one (rows
      // 1, 3-6 in the decision table all also produce `escalate`). Ensure
      // the gated-paths reason is visible regardless: a human reading only
      // the LLM's own reasons should never conclude the PR is clear to merge
      // once whatever else triggered the escalation is resolved, when the
      // approval gate is independently still unsatisfied.
      overrides.push(reason)
      result = {
        ...result,
        escalation_reasons: [...result.escalation_reasons, reason],
      }
    }
  }

  if (result.outcome === 'approve' && ctx.authorTeamMatches.length > 0) {
    const reason = `PR author belongs to no-auto-approve team(s): ${ctx.authorTeamMatches.join(', ')}. This is a hard gate enforced in code — AAO-SECRETARIAT cannot auto-approve PRs from these teams regardless of how clean the diff is.`
    overrides.push(reason)
    result = {
      ...result,
      outcome: 'comment',
      summary: `${NO_AUTO_APPROVE_OVERRIDE_PREFIX}\n>\n> ${reason}\n\n${result.summary}`,
    }
  }

  return { decision: result, overrides }
}
