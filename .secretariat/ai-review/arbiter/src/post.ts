import * as core from '@actions/core'
import type * as github from '@actions/github'
import type { Outcome } from './anthropic.js'

type Octokit = ReturnType<typeof github.getOctokit>

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export function mapOutcomeToReviewEvent(outcome: Outcome): ReviewEvent {
  switch (outcome) {
    case 'approve': return 'APPROVE'
    case 'request-changes': return 'REQUEST_CHANGES'
    case 'comment': return 'COMMENT'
    case 'escalate': return 'COMMENT'
  }
}

export async function ensureLabel(params: {
  octokit: Octokit
  owner: string
  repo: string
  name: string
}): Promise<void> {
  const { octokit, owner, repo, name } = params
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name })
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err
        ? (err as { status: number }).status
        : undefined
    if (status === 404) {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name,
        color: 'fbca04',
        description: 'AAO-SECRETARIAT has escalated this PR for human review.',
      })
    } else {
      throw err
    }
  }
}

export async function addLabel(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  label: string
}): Promise<void> {
  await params.octokit.rest.issues.addLabels({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    labels: [params.label],
  })
}

export async function postReview(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  headSha: string
  event: ReviewEvent
  body: string
}): Promise<void> {
  const { octokit, owner, repo, prNumber, headSha, event, body } = params
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event,
      body,
    })
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err
        ? (err as { status: number }).status
        : undefined
    if (event === 'APPROVE' && status === 422) {
      core.warning('Approve rejected (likely own PR); falling back to COMMENT')
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body,
      })
    } else {
      throw err
    }
  }
}

export async function requestReviewers(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  reviewers: string[]
}): Promise<void> {
  const { octokit, owner, repo, prNumber, reviewers } = params
  const users = reviewers.filter((r) => !r.includes('/'))
  const teamSlugs = reviewers
    .filter((r) => r.includes('/'))
    .map((r) => r.split('/').pop()!)
  if (users.length === 0 && teamSlugs.length === 0) return
  try {
    await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
      {
        owner,
        repo,
        pull_number: prNumber,
        ...(users.length > 0 ? { reviewers: users } : {}),
        ...(teamSlugs.length > 0 ? { team_reviewers: teamSlugs } : {}),
      },
    )
  } catch (err) {
    core.warning(
      `Failed to request reviewers (${reviewers.join(', ')}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
