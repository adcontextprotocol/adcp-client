import * as core from '@actions/core'
import type * as github from '@actions/github'

type Octokit = ReturnType<typeof github.getOctokit>

export async function findNoAutoApproveTeams(params: {
  octokit: Octokit
  org: string
  username: string
  teamSlugs: string[]
}): Promise<string[]> {
  const { octokit, org, username, teamSlugs } = params
  if (teamSlugs.length === 0 || !username) return []

  const checks = await Promise.all(
    teamSlugs.map(async (teamSlug) => {
      const slug = teamSlug.includes('/') ? teamSlug.split('/').pop()! : teamSlug
      try {
        const { data } = await octokit.rest.teams.getMembershipForUserInOrg({
          org,
          team_slug: slug,
          username,
        })
        return data.state === 'active' ? teamSlug : null
      } catch (err) {
        const status =
          err instanceof Error && 'status' in err
            ? (err as { status: number }).status
            : undefined
        if (status === 404) return null
        core.warning(
          `Could not verify membership of '${username}' in team '${teamSlug}': ${
            err instanceof Error ? err.message : String(err)
          } — holding for human review`,
        )
        return teamSlug
      }
    }),
  )

  return checks.filter((t): t is string => t !== null)
}
