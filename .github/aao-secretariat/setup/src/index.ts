import * as core from '@actions/core'
import * as github from '@actions/github'
import { readFile, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseAaoSecretariatMd } from './aao-secretariat-md.js'
import { resolveConfig, type ActionInputs } from './resolve-config.js'
import { evaluateShortCircuit } from './short-circuit.js'
import { evaluateHighRisk } from './high-risk.js'
import { evaluateGatedPaths } from './gated-paths.js'
import {
  computeChangedFiles,
  computePrSurfaceFiles,
  filterTrivialFiles,
  intersectChangedFiles,
  writeDiffFile,
} from './diff.js'
import {
  containsMarker,
  parseDecisionMarker,
  wrapWithMarker,
} from './markers.js'

function csv(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function postBotSkipCommentOnce(params: {
  octokit: ReturnType<typeof github.getOctokit>
  owner: string
  repo: string
  prNumber: number
  marker: string
}) {
  const { octokit, owner, repo, prNumber, marker } = params
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })
  if (comments.some((c) => containsMarker(c.body ?? '', marker))) return
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: wrapWithMarker({
      body: 'AAO-SECRETARIAT does not review bot-authored PRs.',
      marker,
    }),
  })
}

async function postMergeConflictCommentOnce(params: {
  octokit: ReturnType<typeof github.getOctokit>
  owner: string
  repo: string
  prNumber: number
  marker: string
}) {
  const { octokit, owner, repo, prNumber, marker } = params
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })
  if (comments.some((c) => containsMarker(c.body ?? '', marker))) return
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: wrapWithMarker({
      body: 'AAO-SECRETARIAT cannot review this PR until merge conflicts are resolved.',
      marker,
    }),
  })
}

async function readAaoSecretariatMd(): Promise<string | null> {
  const path = join(process.env.GITHUB_WORKSPACE ?? '.', 'AAO-SECRETARIAT.md')
  if (!existsSync(path)) {
    core.info('AAO-SECRETARIAT.md not found at repo root; using defaults.')
    return null
  }
  return await readFile(path, 'utf8')
}

async function fetchPriorDecision(params: {
  octokit: ReturnType<typeof github.getOctokit>
  owner: string
  repo: string
  prNumber: number
  aaoSecretariatBotLogin: string
}): Promise<string> {
  const { octokit, owner, repo, prNumber, aaoSecretariatBotLogin } = params
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })
  const mine = reviews.filter((r) => r.user?.login === aaoSecretariatBotLogin).reverse()
  for (const review of mine) {
    const parsed = parseDecisionMarker(review.body ?? '')
    if (parsed) return JSON.stringify(parsed)
  }
  return ''
}

async function fetchReviewDecision(params: {
  octokit: ReturnType<typeof github.getOctokit>
  owner: string
  repo: string
  prNumber: number
}): Promise<string> {
  const { octokit, owner, repo, prNumber } = params
  try {
    const result = await octokit.graphql<{
      repository: {
        pullRequest: { reviewDecision: string | null } | null
      } | null
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewDecision
          }
        }
      }`,
      { owner, repo, number: prNumber },
    )
    return result.repository?.pullRequest?.reviewDecision ?? ''
  } catch (err) {
    core.warning(
      `Could not fetch reviewDecision via GraphQL: ${err instanceof Error ? err.message : String(err)} — treating as unknown (empty string). Gates that key off review-decision must fail toward holding for human review, not toward auto-approving, when this is empty.`,
    )
    return ''
  }
}

async function main(): Promise<void> {
  const githubToken = core.getInput('github-token', { required: true })
  const inputs: ActionInputs = {
    highRiskPaths: csv(core.getInput('high-risk-paths')),
    gatedPaths: csv(core.getInput('gated-paths')),
    trivialPaths: csv(core.getInput('trivial-paths')),
    releaseStackBranches: csv(core.getInput('release-stack-branches')),
    skipBotAuthors: csv(core.getInput('skip-bot-authors')),
    protectedBranches: csv(core.getInput('protected-branches')),
    noAutoApproveTeams: csv(core.getInput('no-auto-approve-teams')),
    escalationReviewers: csv(core.getInput('escalation-reviewers')),
  }

  const aaoSecretariatMdBody = await readAaoSecretariatMd()
  const aaoSecretariatMd = parseAaoSecretariatMd(aaoSecretariatMdBody)
  const config = resolveConfig({ aaoSecretariatMd, actionInputs: inputs })

  const ctx = github.context
  if (ctx.eventName !== 'pull_request') {
    core.setOutput('should-run', 'false')
    core.setOutput('skip-reason', 'not-a-pull-request')
    return
  }

  const pr = ctx.payload.pull_request
  if (!pr) {
    core.setOutput('should-run', 'false')
    core.setOutput('skip-reason', 'missing-pr-payload')
    return
  }

  const octokit = github.getOctokit(githubToken)
  const { owner, repo } = ctx.repo
  const prNumber = pr.number as number
  const headSha = pr.head.sha as string
  const baseSha = pr.base.sha as string
  const headRef = pr.head.ref as string
  const baseRef = pr.base.ref as string
  const isDraft = Boolean(pr.draft)
  const prState = pr.state === 'closed' ? 'closed' : 'open'
  const authorLogin = (pr.user?.login as string) ?? ''
  const labels = ((pr.labels ?? []) as Array<{ name: string }>).map(
    (l) => l.name,
  )
  const hasForceReviewLabel = labels.includes(
    core.getInput('force-review-label'),
  )
  const eventAction = ctx.payload.action ?? ''

  let mergeable = true
  try {
    const { data: prData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })
    mergeable = prData.mergeable !== false
  } catch {
    mergeable = true
  }

  const surfaceFiles = await computePrSurfaceFiles({
    octokit,
    owner,
    repo,
    prNumber,
  })
  const surfacePaths = surfaceFiles.map((f) => f.path)

  let priorReviewedSha: string | null = null
  let deltaFiles: string[] = surfacePaths
  let isPureRebase = false

  const aaoSecretariatBotLogin = core.getInput('aao-secretariat-bot-login') || 'aao-secretariat[bot]'

  if (eventAction === 'synchronize') {
    try {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      })
      const lastAaoSecretariat = [...reviews]
        .reverse()
        .find((r) => r.user?.login === aaoSecretariatBotLogin)
      priorReviewedSha = lastAaoSecretariat?.commit_id ?? null
    } catch (err) {
      core.warning(
        `Could not read prior AAO-SECRETARIAT review SHA: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (priorReviewedSha && priorReviewedSha !== headSha) {
      const changedSincePrior = await computeChangedFiles({
        octokit,
        owner,
        repo,
        fromSha: priorReviewedSha,
        toSha: headSha,
      })
      if (changedSincePrior !== null) {
        isPureRebase = changedSincePrior.length === 0
        deltaFiles = intersectChangedFiles({
          changedSincePrior,
          currentPrSurface: surfacePaths,
        })
      } else {
        // git diff failed because the prior commit is no longer reachable in
        // the local clone (force-push/rebase). Compare tree SHAs via the
        // GitHub API — commit objects remain accessible there even after a
        // force push. Identical trees mean the file content is unchanged.
        try {
          const [{ data: priorCommit }, { data: currentCommit }] =
            await Promise.all([
              octokit.rest.git.getCommit({
                owner,
                repo,
                commit_sha: priorReviewedSha,
              }),
              octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha }),
            ])
          isPureRebase = priorCommit.tree.sha === currentCommit.tree.sha
        } catch (err) {
          core.warning(
            `Could not compare tree SHAs for ${priorReviewedSha}..${headSha}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    }
  }

  const deltaFilesAfterTrivialFilter = filterTrivialFiles({
    files: deltaFiles,
    trivialGlobs: config.trivialPaths,
  })

  const decision = evaluateShortCircuit({
    prState,
    isDraft,
    hasForceReviewLabel,
    authorLogin,
    triggeringActor: ctx.actor,
    aaoSecretariatBotLogin,
    skipBotAuthors: config.skipBotAuthors,
    mergeable,
    headRef,
    releaseStackBranches: config.releaseStackBranches,
    eventName: ctx.eventName,
    eventAction,
    deltaFiles,
    deltaFilesAfterTrivialFilter,
    isPureRebase,
  })

  if (!decision.shouldRun) {
    if (decision.skipReason === 'bot-author') {
      await postBotSkipCommentOnce({
        octokit,
        owner,
        repo,
        prNumber,
        marker: 'aao-secretariat/bot-skip-noted',
      })
    } else if (decision.skipReason === 'merge-conflicts') {
      await postMergeConflictCommentOnce({
        octokit,
        owner,
        repo,
        prNumber,
        marker: 'aao-secretariat/merge-conflict-noted',
      })
    }
    core.setOutput('should-run', 'false')
    core.setOutput('skip-reason', decision.skipReason ?? '')
    return
  }

  // High-risk / gated-path evaluation runs on the PR surface. Change kinds
  // come from the pulls.listFiles response already fetched above — no extra
  // API call and, crucially, no fetch of the PR head.
  const highRisk = evaluateHighRisk({
    files: surfaceFiles,
    globs: config.highRiskPaths,
  })
  const gatedPaths = evaluateGatedPaths({
    files: surfaceFiles,
    globs: config.gatedPaths,
  })

  // Write diff files. Both diffs are pulled from the GitHub API; the PR head
  // is never fetched or checked out. The full diff is the whole PR; the delta
  // is the compare (prior review → head) diff, written only when a prior review
  // established a narrower surface.
  const tempDir = await mkdtemp(join(tmpdir(), 'aao-secretariat-setup-'))
  const fullPath = join(tempDir, 'diff-full.patch')
  await writeDiffFile({ octokit, owner, repo, prNumber, target: fullPath })
  const deltaPath =
    priorReviewedSha && deltaFiles.length !== surfacePaths.length
      ? await writeDiffFile({
          octokit,
          owner,
          repo,
          fromSha: priorReviewedSha,
          toSha: headSha,
          target: join(tempDir, 'diff-delta.patch'),
        })
      : fullPath

  // Prior decision marker
  let priorDecision = ''
  try {
    priorDecision = await fetchPriorDecision({
      octokit,
      owner,
      repo,
      prNumber,
      aaoSecretariatBotLogin,
    })
  } catch (err) {
    core.warning(
      `Could not fetch prior decision marker: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const reviewDecision = await fetchReviewDecision({
    octokit,
    owner,
    repo,
    prNumber,
  })
  if (gatedPaths.flag && !reviewDecision) {
    core.warning(
      'gated-paths matched but review-decision came back empty — this gate can never be satisfied unless the matched path(s) are also covered by branch protection / CODEOWNERS required reviews. See the Gated Paths documentation for details.',
    )
  }

  core.setOutput('should-run', 'true')
  core.setOutput('skip-reason', '')
  core.setOutput('aao-secretariat-md-body', config.repoContext ?? '')
  core.setOutput('high-risk', highRisk.flag ? 'true' : 'false')
  core.setOutput('high-risk-reasons', JSON.stringify(highRisk.reasons))
  core.setOutput('gated-paths', gatedPaths.flag ? 'true' : 'false')
  core.setOutput('gated-paths-reasons', JSON.stringify(gatedPaths.reasons))
  core.setOutput('review-decision', reviewDecision)
  core.setOutput('escalation-reviewers', config.escalationReviewers.join(','))
  core.setOutput('no-auto-approve-teams', config.noAutoApproveTeams.join(','))
  core.setOutput('protected-branches', config.protectedBranches.join(','))
  core.setOutput('prior-decision', priorDecision)
  core.setOutput('diff-full-path', fullPath)
  core.setOutput('diff-delta-path', deltaPath)
  core.setOutput('pr-number', String(prNumber))
  core.setOutput('head-sha', headSha)
  core.setOutput('base-sha', baseSha)
  // baseRef is informational
  core.info(`Base ref: ${baseRef}`)
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
