/**
 * Composable governance helper for AdCP server handlers.
 *
 * Call `checkGovernance()` inside handlers that have financial commitment
 * (create_media_buy, update_media_buy, activate_signal). The seller controls
 * when and how governance is checked — the framework doesn't intercept.
 *
 * ## Where the governance agent URL comes from
 *
 * Buyers register governance agents against their accounts via `sync_governance`.
 * The seller persists each entry (URL + write-only credentials + optional
 * categories) and reads it back on every lifecycle event. Account's public
 * shape (`Account.governance_agents`) carries `{ url, categories? }[]` —
 * credentials are write-only on the wire, so sellers pair each stored URL
 * with its stored auth token from their own storage when calling this helper.
 *
 * Multi-agent semantics for a single lifecycle event are currently
 * under-specified (see adcontextprotocol/adcp#3010). Until the spec
 * resolves, the recommended usage is one governance agent per
 * category/scope per plan — pick the agent whose `categories` matches the
 * lifecycle event and call it directly.
 *
 * @example
 * ```typescript
 * import { createAdcpServer, checkGovernance, governanceDeniedError } from '@adcp/sdk/server/legacy/v5';
 *
 * const server = createAdcpServer({
 *   name: 'My Publisher', version: '1.0.0',
 *   resolveAccount: async (ref) => db.findAccount(ref),
 *   mediaBuy: {
 *     createMediaBuy: async (params, ctx) => {
 *       // Look up the governance agent (url + stored credentials) from your
 *       // storage. The public `ctx.account.governance_agents` readback
 *       // carries URL + categories; auth credentials live in your DB.
 *       const agent = await db.governanceAgentForPlan(ctx.account.id, params.plan_id);
 *       if (agent) {
 *         const gov = await checkGovernance({
 *           agentUrl: agent.url,
 *           authToken: agent.authToken,
 *           planId: params.plan_id!,
 *           caller: 'https://my-publisher.com/mcp',
 *           tool: 'create_media_buy',
 *           payload: params,
 *         });
 *         if (!gov.approved) return governanceDeniedError(gov);
 *         // Thread gov.governanceContext through the media buy lifecycle —
 *         // persist it and forward verbatim on subsequent checks.
 *       }
 *       return { media_buy_id: '...' };
 *     },
 *   },
 * });
 * ```
 */

import { callMCPTool } from '../protocols/mcp';
import type { CheckGovernanceResponse } from '../types/tools.generated';
import type { McpToolResponse } from './responses';
import { adcpError } from './errors';

/**
 * Extract a tool's JSON payload from an MCP `CallToolResult` envelope.
 *
 * Handles the three shapes the SDK might see in the wild:
 *   - `structuredContent` (AdCP convention — preferred, always an object)
 *   - `content[0]` with `type: 'text'` carrying a JSON string
 *   - the payload already spread at top level (legacy / non-conformant)
 *
 * Returns `null` when no payload can be extracted.
 */
function extractMcpPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as Record<string, unknown>;

  // Error envelopes can carry structuredContent with shapes that accidentally
  // include `status` — refuse to mis-type them as a successful response.
  if (envelope.isError === true) return null;

  if (envelope.structuredContent && typeof envelope.structuredContent === 'object') {
    return envelope.structuredContent as Record<string, unknown>;
  }

  const content = envelope.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { type?: string; text?: unknown };
    if (first?.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }

  // Legacy: caller spread the payload at top level.
  if ('status' in envelope || 'check_id' in envelope) return envelope;

  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckGovernanceOptions {
  /** URL of the governance agent's MCP endpoint. */
  agentUrl: string;
  /** Campaign governance plan identifier. */
  planId: string;
  /** URL of the agent making the request (your seller agent). */
  caller: string;
  /** The AdCP tool being governed (e.g., 'create_media_buy'). */
  tool?: string;
  /** The full tool arguments as they would be sent to the seller. */
  payload?: Record<string, unknown>;
  /** Opaque governance context from a prior check_governance response. */
  governanceContext?: string;
  /** Purchase type for the governance check. */
  purchaseType?: string;
  /** Auth token for the governance agent. */
  authToken?: string;
}

export interface GovernanceApproved {
  approved: true;
  checkId: string;
  explanation: string;
  governanceContext?: string;
  expiresAt?: string;
  nextCheck?: string;
  findings?: CheckGovernanceResponse['findings'];
}

export interface GovernanceDenied {
  approved: false;
  checkId: string;
  explanation: string;
  findings?: CheckGovernanceResponse['findings'];
  conditions?: CheckGovernanceResponse['conditions'];
}

export interface GovernanceConditions {
  approved: 'conditions';
  checkId: string;
  explanation: string;
  conditions: NonNullable<CheckGovernanceResponse['conditions']>;
  findings?: CheckGovernanceResponse['findings'];
  governanceContext?: string;
}

export type GovernanceCallResult = GovernanceApproved | GovernanceDenied | GovernanceConditions;

// ---------------------------------------------------------------------------
// checkGovernance
// ---------------------------------------------------------------------------

/**
 * Call a governance agent's `check_governance` tool and return a typed result.
 *
 * Use this inside handlers for tools with financial commitment:
 * - `create_media_buy` — commits budget
 * - `update_media_buy` — modifies budget, adds packages
 * - `activate_signal` — activates paid signals
 *
 * The result includes `governanceContext` which must be threaded through
 * the media buy lifecycle (attach to the response, pass on subsequent checks).
 */
export async function checkGovernance(options: CheckGovernanceOptions): Promise<GovernanceCallResult> {
  const { agentUrl, planId, caller, tool, payload, governanceContext, purchaseType, authToken } = options;

  const args: Record<string, unknown> = {
    plan_id: planId,
    caller,
  };
  if (tool != null) args.tool = tool;
  if (payload != null) args.payload = payload;
  if (governanceContext != null) args.governance_context = governanceContext;
  if (purchaseType != null) args.purchase_type = purchaseType;

  const raw = await callMCPTool(agentUrl, 'check_governance', args, authToken);
  const extracted = extractMcpPayload(raw);

  if (!extracted || !('status' in extracted) || !('check_id' in extracted) || !('explanation' in extracted)) {
    throw new Error(
      `Invalid check_governance response from ${agentUrl}: ` +
        `missing required fields (status, check_id, explanation). Got: ${JSON.stringify(raw)?.slice(0, 200)}`
    );
  }
  const response = extracted as unknown as CheckGovernanceResponse;

  if (response.status === 'approved') {
    return {
      approved: true,
      checkId: response.check_id,
      explanation: response.explanation,
      governanceContext: response.governance_context ?? undefined,
      expiresAt: response.expires_at ?? undefined,
      nextCheck: response.next_check ?? undefined,
      findings: response.findings,
    };
  }

  if (response.status === 'conditions') {
    return {
      approved: 'conditions',
      checkId: response.check_id,
      explanation: response.explanation,
      conditions: response.conditions!,
      findings: response.findings,
      governanceContext: response.governance_context ?? undefined,
    };
  }

  return {
    approved: false,
    checkId: response.check_id,
    explanation: response.explanation,
    findings: response.findings,
    conditions: response.conditions,
  };
}

/**
 * Convert a governance denial into an adcpError response.
 *
 * Convenience for the common pattern:
 * ```typescript
 * const gov = await checkGovernance({ ... });
 * if (!gov.approved) return governanceDeniedError(gov);
 * ```
 */
export function governanceDeniedError(result: GovernanceDenied | GovernanceConditions): McpToolResponse {
  const details: Record<string, unknown> = {
    check_id: result.checkId,
  };
  if (result.findings?.length) {
    details.findings = result.findings;
  }
  if (result.conditions?.length) {
    details.conditions = result.conditions;
  }

  return adcpError('GOVERNANCE_DENIED', {
    message: result.explanation,
    details,
  });
}
