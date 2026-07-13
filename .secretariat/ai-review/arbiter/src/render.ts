import type { ArbiterDecision } from './anthropic.js'
import type { FindingsPayload } from './findings.js'

const MAX_BODY = 4000

const HEADERS: Record<ArbiterDecision['outcome'], string> = {
  approve: '## AAO-SECRETARIAT verdict: Approve',
  'request-changes': '## AAO-SECRETARIAT verdict: Request changes',
  comment: '## AAO-SECRETARIAT verdict: Comment (human reviewer recommended)',
  escalate: '## AAO-SECRETARIAT verdict: Escalate to human review',
}

export function renderReviewBody(params: {
  decision: ArbiterDecision
  findings: FindingsPayload
  headSha: string
  highRisk: boolean
  highRiskReasons: string[]
}): string {
  const { decision, findings, headSha, highRisk, highRiskReasons } = params
  const parts: string[] = []
  parts.push(HEADERS[decision.outcome])
  parts.push('')
  parts.push(decision.summary)

  if (decision.blocking_findings.length > 0) {
    parts.push('')
    parts.push('### Blocking findings')
    for (const f of decision.blocking_findings) parts.push(`- ${f}`)
  }

  const mediums = findings.findings.filter((f) => f.severity === 'medium')
  if (mediums.length > 0) {
    parts.push('')
    parts.push('### Medium findings')
    if (mediums.length > 5) {
      parts.push('<details>')
      parts.push(`<summary>${mediums.length} medium findings</summary>`)
      parts.push('')
    }
    for (const m of mediums) {
      const loc = m.line ? `${m.file}:${m.line}` : m.file
      parts.push(`- ${loc} — ${m.title}`)
    }
    if (mediums.length > 5) parts.push('</details>')
  }

  if (decision.outcome === 'escalate') {
    parts.push('')
    parts.push('### Why human review')
    const reasons = decision.escalation_reasons.length
      ? decision.escalation_reasons
      : highRiskReasons
    for (const r of reasons) parts.push(`- ${r}`)
  }

  // Truncate if needed (preserve trailer)
  let body = parts.join('\n')
  const markerFindings = findings.findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')
    .map((f) => ({
      severity: f.severity,
      title: f.title,
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
    }))
  const marker = `<!-- aao-secretariat-decision:\n${JSON.stringify({
    head: headSha,
    outcome: decision.outcome,
    high_risk: highRisk,
    reasons:
      decision.outcome === 'escalate'
        ? decision.escalation_reasons.length
          ? decision.escalation_reasons
          : highRiskReasons
        : [],
    findings: markerFindings,
  })}\n-->`

  if (body.length > MAX_BODY) {
    body = body.slice(0, MAX_BODY - 20) + '\n\n…(truncated)…'
  }
  return `${body}\n\n${marker}`
}
