export function wrapWithMarker(params: { body: string; marker: string }): string {
  return `${params.body}\n\n<!-- aao-secretariat-marker:${params.marker} -->`
}

export function containsMarker(body: string, marker: string): boolean {
  return body.includes(`<!-- aao-secretariat-marker:${marker} -->`)
}

export type Outcome = 'approve' | 'request-changes' | 'comment' | 'escalate'

export interface PriorFinding {
  severity: 'critical' | 'high' | 'medium'
  title: string
  file: string
  line?: number
}

export interface PriorDecision {
  head: string
  outcome: Outcome
  high_risk: boolean
  reasons: string[]
  findings?: PriorFinding[]
}

const DECISION_RE = /<!--\s*aao-secretariat-decision:\s*([\s\S]*?)\s*-->/

export function parseDecisionMarker(body: string): PriorDecision | null {
  const m = DECISION_RE.exec(body)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[1])
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.head === 'string' &&
      ['approve', 'request-changes', 'comment', 'escalate'].includes(parsed.outcome) &&
      typeof parsed.high_risk === 'boolean' &&
      Array.isArray(parsed.reasons)
    ) {
      const findings: PriorFinding[] | undefined = Array.isArray(parsed.findings)
        ? (parsed.findings as unknown[]).filter(
            (f): f is PriorFinding =>
              typeof f === 'object' &&
              f !== null &&
              ['critical', 'high', 'medium'].includes((f as Record<string, unknown>).severity as string) &&
              typeof (f as Record<string, unknown>).title === 'string' &&
              typeof (f as Record<string, unknown>).file === 'string',
          )
        : undefined
      return { ...parsed, findings } as PriorDecision
    }
    return null
  } catch {
    return null
  }
}

export function buildDecisionMarker(decision: PriorDecision): string {
  return `<!-- aao-secretariat-decision:\n${JSON.stringify(decision)}\n-->`
}
