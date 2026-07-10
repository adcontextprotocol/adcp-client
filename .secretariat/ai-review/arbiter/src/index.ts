import * as core from '@actions/core'
import * as github from '@actions/github'

import { decideViaAnthropic } from './anthropic.js'
import { buildArbiterPrompt } from './decision.js'
import { SEVERITY_RULES, DECISION_RULES } from './_rules.generated.js'
import { computeDiffStatsFromFile } from './diff-stats.js'
import { enforceDecisionGuards } from './enforce.js'
import { parseFindings } from './findings.js'
import {
  addLabel,
  ensureLabel,
  mapOutcomeToReviewEvent,
  postReview,
  requestReviewers,
} from './post.js'
import { parsePriorDecisionInput } from './prior-decision.js'
import { renderReviewBody } from './render.js'
import { findNoAutoApproveTeams } from './teams.js'

function csv(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main(): Promise<void> {
  const anthropicApiKey = core.getInput('anthropic-api-key', { required: true })
  const githubToken = core.getInput('github-token', { required: true })
  const findingsRaw = core.getInput('findings-json', { required: true })
  const repoContextRaw = core.getInput('aao-secretariat-md-body')
  const highRisk = core.getInput('high-risk') === 'true'
  const highRiskReasons = (() => {
    try {
      return JSON.parse(core.getInput('high-risk-reasons') || '[]') as string[]
    } catch {
      return []
    }
  })()
  const gatedPaths = core.getInput('gated-paths') === 'true'
  const gatedPathsReasons = (() => {
    try {
      return JSON.parse(
        core.getInput('gated-paths-reasons') || '[]',
      ) as string[]
    } catch {
      return []
    }
  })()
  const reviewDecision = core.getInput('review-decision')
  const escalationReviewers = csv(core.getInput('escalation-reviewers'))
  const noAutoApproveTeams = csv(core.getInput('no-auto-approve-teams'))
  const protectedBranches = csv(core.getInput('protected-branches'))
  const priorDecisionInput = core.getInput('prior-decision')
  const prNumber = Number(core.getInput('pr-number', { required: true }))
  const headSha = core.getInput('head-sha', { required: true })
  const baseSha = core.getInput('base-sha', { required: true })
  const diffFullPath = core.getInput('diff-full-path', { required: true })
  const model = core.getInput('model') || 'claude-sonnet-4-6'
  const decisionLabel =
    core.getInput('decision-label') || 'aao-secretariat/needs-human-review'

  const findings = parseFindings(findingsRaw)
  const priorDecision = parsePriorDecisionInput(priorDecisionInput)
  const diffStats = await computeDiffStatsFromFile(diffFullPath)

  const ctx = github.context
  const { owner, repo } = ctx.repo
  const octokit = github.getOctokit(githubToken)

  const authorLogin = (ctx.payload.pull_request?.user?.login as string) ?? ''
  const baseRef = (ctx.payload.pull_request?.base?.ref as string) ?? ''

  const authorTeamMatches = await findNoAutoApproveTeams({
    octokit,
    org: owner,
    username: authorLogin,
    teamSlugs: noAutoApproveTeams,
  })

  const prompt = buildArbiterPrompt({
    repoSlug: `${owner}/${repo}`,
    prNumber,
    baseRef,
    headSha,
    baseSha,
    findings,
    diffStats,
    highRisk,
    highRiskReasons,
    gatedPaths,
    gatedPathsReasons,
    reviewDecision,
    protectedBranches,
    noAutoApproveTeams,
    authorTeamMatches,
    priorDecision,
    repoContext: repoContextRaw.trim() ? repoContextRaw : null,
    severityRules: SEVERITY_RULES,
    decisionRules: DECISION_RULES,
  })

  const llmDecision = await decideViaAnthropic({
    apiKey: anthropicApiKey,
    model,
    prompt,
  })

  const { decision, overrides } = enforceDecisionGuards(llmDecision, {
    authorTeamMatches,
    gatedPaths,
    gatedPathsReasons,
    reviewDecision,
  })
  for (const message of overrides) {
    core.warning(`Decision override applied: ${message}`)
  }

  const body = renderReviewBody({
    decision,
    findings,
    headSha,
    highRisk,
    highRiskReasons,
  })

  await postReview({
    octokit,
    owner,
    repo,
    prNumber,
    headSha,
    event: mapOutcomeToReviewEvent(decision.outcome),
    body,
  })

  if (decision.outcome === 'escalate') {
    await ensureLabel({ octokit, owner, repo, name: decisionLabel })
    await addLabel({ octokit, owner, repo, prNumber, label: decisionLabel })
    if (escalationReviewers.length > 0) {
      await requestReviewers({
        octokit,
        owner,
        repo,
        prNumber,
        reviewers: escalationReviewers,
      })
    }
  }

  core.setOutput('outcome', decision.outcome)
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
