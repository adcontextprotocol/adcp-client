import Anthropic from '@anthropic-ai/sdk'

export type Outcome = 'approve' | 'request-changes' | 'comment' | 'escalate'

export interface ArbiterDecision {
  outcome: Outcome
  summary: string
  blocking_findings: string[]
  escalation_reasons: string[]
}

const TOOL = {
  name: 'submit_decision',
  description: 'Submit the arbiter verdict for this PR.',
  input_schema: {
    type: 'object',
    required: ['outcome', 'summary', 'blocking_findings', 'escalation_reasons'],
    additionalProperties: false,
    properties: {
      outcome: { enum: ['approve', 'request-changes', 'comment', 'escalate'] },
      summary: { type: 'string', maxLength: 4000 },
      blocking_findings: { type: 'array', items: { type: 'string' } },
      escalation_reasons: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

export async function decideViaAnthropic(params: {
  apiKey: string
  model: string
  prompt: string
  maxTokens?: number
}): Promise<ArbiterDecision> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'submit_decision' },
    messages: [{ role: 'user', content: params.prompt }],
  })

  const toolUse = (response.content ?? []).find(
    (block: { type?: string }) => block.type === 'tool_use',
  ) as { type: 'tool_use'; name: string; input: unknown } | undefined

  if (!toolUse) {
    throw new Error(
      `arbiter: model did not call the submit_decision tool (stop_reason=${response.stop_reason})`,
    )
  }

  return toolUse.input as ArbiterDecision
}
