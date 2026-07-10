export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type Category =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'data-loss'
  | 'schema'
  | 'infra'
  | 'tests'
  | 'operability'
  | 'style'
  | 'other'

export interface Finding {
  severity: Severity
  title: string
  rationale: string
  file: string
  line?: number
  category: Category
  posted_inline: boolean
}

export interface FindingsPayload {
  summary: string
  findings: Finding[]
}

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low'])
const CATEGORIES: ReadonlySet<string> = new Set([
  'correctness',
  'security',
  'performance',
  'data-loss',
  'schema',
  'infra',
  'tests',
  'operability',
  'style',
  'other',
])

export function parseFindings(raw: string): FindingsPayload {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `findings: failed to parse JSON — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof json !== 'object' || json === null) {
    throw new Error('findings: payload is not an object')
  }
  const obj = json as Record<string, unknown>
  if (typeof obj.summary !== 'string') throw new Error('findings: missing summary')
  if (!Array.isArray(obj.findings)) throw new Error('findings: findings is not an array')

  const findings: Finding[] = obj.findings.map((f, i) => {
    if (typeof f !== 'object' || f === null) throw new Error(`findings[${i}]: not an object`)
    const item = f as Record<string, unknown>
    if (typeof item.severity !== 'string' || !SEVERITIES.has(item.severity)) {
      throw new Error(`findings[${i}]: invalid severity ${String(item.severity)}`)
    }
    if (typeof item.category !== 'string' || !CATEGORIES.has(item.category)) {
      throw new Error(`findings[${i}]: invalid category ${String(item.category)}`)
    }
    if (typeof item.title !== 'string') throw new Error(`findings[${i}]: title missing`)
    if (typeof item.rationale !== 'string') throw new Error(`findings[${i}]: rationale missing`)
    if (typeof item.file !== 'string') throw new Error(`findings[${i}]: file missing`)
    if (typeof item.posted_inline !== 'boolean')
      throw new Error(`findings[${i}]: posted_inline missing`)
    const line =
      typeof item.line === 'number' && Number.isFinite(item.line)
        ? Math.trunc(item.line)
        : undefined
    return {
      severity: item.severity as Severity,
      category: item.category as Category,
      title: item.title,
      rationale: item.rationale,
      file: item.file,
      line,
      posted_inline: item.posted_inline,
    }
  })
  return { summary: obj.summary, findings }
}
