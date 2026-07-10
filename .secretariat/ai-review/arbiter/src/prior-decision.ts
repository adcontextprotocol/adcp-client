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

export function parsePriorDecisionInput(input: string): PriorDecision | null {
  if (!input.trim()) return null
  try {
    const parsed = JSON.parse(input)
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
