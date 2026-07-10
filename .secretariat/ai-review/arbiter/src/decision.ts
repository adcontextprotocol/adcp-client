import type { FindingsPayload } from './findings.js'
import type { PriorDecision } from './prior-decision.js'

export interface DiffStats {
  fileCount: number
  additions: number
  deletions: number
  files: string[]
}

export interface ArbiterContext {
  repoSlug: string
  prNumber: number
  baseRef: string
  headSha: string
  baseSha: string
  findings: FindingsPayload
  diffStats: DiffStats
  highRisk: boolean
  highRiskReasons: string[]
  gatedPaths: boolean
  gatedPathsReasons: string[]
  reviewDecision: string
  protectedBranches: string[]
  noAutoApproveTeams: string[]
  authorTeamMatches: string[]
  priorDecision: PriorDecision | null
  repoContext: string | null
  severityRules: string
  decisionRules: string
}

const FILE_LIST_CAP = 50

function fileList(files: string[]): string {
  if (files.length <= FILE_LIST_CAP)
    return files.map((f) => `- ${f}`).join('\n')
  const head = files
    .slice(0, FILE_LIST_CAP)
    .map((f) => `- ${f}`)
    .join('\n')
  return `${head}\n- ...+${files.length - FILE_LIST_CAP} more`
}

function findingsList(f: FindingsPayload): string {
  if (f.findings.length === 0) return '(none)'
  return f.findings
    .map(
      (x) =>
        `[${x.severity}] ${x.file}${x.line ? `:${x.line}` : ''} — ${x.title}`,
    )
    .join('\n')
}

export function buildArbiterPrompt(ctx: ArbiterContext): string {
  const parts: string[] = []

  parts.push('# Arbiter')
  parts.push(
    'You are the AAO-SECRETARIAT arbiter. Read the rules, the context, and the reviewer findings. Then call the `submit_decision` tool exactly once.',
  )
  parts.push('\n## Severity model\n')
  parts.push(ctx.severityRules)
  parts.push('\n## Decision rules\n')
  parts.push(ctx.decisionRules)

  parts.push('\n## PR context')
  parts.push(`- Repo: ${ctx.repoSlug}`)
  parts.push(`- PR: #${ctx.prNumber}`)
  parts.push(`- Base ref: ${ctx.baseRef}`)
  parts.push(`- Base SHA: ${ctx.baseSha}`)
  parts.push(`- Head SHA: ${ctx.headSha}`)

  parts.push('\n## Diff stats')
  parts.push(`- Files changed: ${ctx.diffStats.fileCount}`)
  parts.push(`- Additions: ${ctx.diffStats.additions}`)
  parts.push(`- Deletions: ${ctx.diffStats.deletions}`)
  parts.push('- Files:')
  parts.push(fileList(ctx.diffStats.files))

  parts.push('\n## High-risk flag')
  parts.push(`- high_risk: ${ctx.highRisk ? 'true' : 'false'}`)
  if (ctx.highRiskReasons.length > 0) {
    parts.push('- Reasons:')
    for (const r of ctx.highRiskReasons) parts.push(`  - ${r}`)
  }

  parts.push(
    '\n## Gated paths (hard approval gate — deterministic) and Required Review Status',
  )
  parts.push(`- gated_paths: ${ctx.gatedPaths ? 'true' : 'false'}`)
  if (ctx.gatedPathsReasons.length > 0) {
    parts.push('- Reasons:')
    for (const r of ctx.gatedPathsReasons) parts.push(`  - ${r}`)
  }
  parts.push(`- review_decision: ${ctx.reviewDecision || '(unknown/none)'}`)

  parts.push('\n## Author team gates')
  if (ctx.authorTeamMatches.length > 0) {
    parts.push('- Author is a member of (no-auto-approve):')
    for (const t of ctx.authorTeamMatches) parts.push(`  - ${t}`)
  } else {
    parts.push('- No no-auto-approve team match.')
  }

  parts.push('\n## Prior decision')
  if (ctx.priorDecision) {
    parts.push(`- Outcome: ${ctx.priorDecision.outcome}`)
    parts.push(`- For head: ${ctx.priorDecision.head}`)
    parts.push(`- High-risk: ${ctx.priorDecision.high_risk}`)
    if (ctx.priorDecision.reasons.length > 0) {
      parts.push('- Reasons:')
      for (const r of ctx.priorDecision.reasons) parts.push(`  - ${r}`)
    }
    if (ctx.priorDecision.findings && ctx.priorDecision.findings.length > 0) {
      parts.push('- Previous findings (what was flagged in that run):')
      for (const f of ctx.priorDecision.findings) {
        const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file
        parts.push(`  - [${f.severity}] ${loc} — ${f.title}`)
      }
    } else if (ctx.priorDecision.findings !== undefined) {
      parts.push(
        '- Previous findings: none (no critical/high/medium findings in that run).',
      )
    } else {
      parts.push('- Previous findings: none recorded (older marker format).')
    }
  } else {
    parts.push('- None (first review of this PR).')
  }

  parts.push('\n## Reviewer findings summary')
  parts.push(ctx.findings.summary)
  parts.push('\n### Findings list')
  parts.push(findingsList(ctx.findings))

  if (ctx.repoContext) {
    parts.push('\n## Repo-specific context\n')
    parts.push(ctx.repoContext)
  }

  parts.push(
    '\nApply the decision rules top-down. Choose ONE outcome. Call `submit_decision` with the JSON payload and STOP.',
  )

  return parts.join('\n')
}
