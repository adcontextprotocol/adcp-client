/**
 * Composable governance helper for AdCP server handlers.
 *
 * Call `checkGovernance()` inside handlers that have financial commitment
 * (create_media_buy, update_media_buy, activate_signal). The seller controls
 * when and how governance is checked — the framework doesn't intercept.
 *
 * @example
 * ```typescript
 * import { createAdcpServer, checkGovernance, adcpError } from '@adcp/client/server';
 *
 * const server = createAdcpServer({
 *   name: 'My Publisher', version: '1.0.0',
 *   resolveAccount: async (ref) => db.findAccount(ref),
 *   mediaBuy: {
 *     createMediaBuy: async (params, ctx) => {
 *       // Check governance before committing spend
 *       const gov = await checkGovernance({
 *         agentUrl: ctx.account.governanceAgentUrl,
 *         planId: params.plan_id,
 *         caller: 'https://my-publisher.com/mcp',
 *         tool: 'create_media_buy',
 *         payload: params,
 *       });
 *       if (!gov.approved) {
 *         return adcpError('COMPLIANCE_UNSATISFIED', { message: gov.explanation });
 *       }
 *       // governance_context threads through the media buy lifecycle
 *       return { media_buy_id: '...', governance_context: gov.governanceContext };
 *     },
 *   },
 * });
 * ```
 */

import { callMCPTool } from '../protocols/mcp';
import type { CheckGovernanceResponse } from '../types/tools.generated';
import type { McpToolResponse } from './responses';
import { adcpError } from './errors';

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
  const response = raw as CheckGovernanceResponse;

  if (response.status === 'approved') {
    return {
      approved: true,
      checkId: response.check_id,
      explanation: response.explanation,
      governanceContext: response.governance_context,
      expiresAt: response.expires_at,
      nextCheck: response.next_check,
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
      governanceContext: response.governance_context,
    };
  }

  // denied
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
export function governanceDeniedError(
  result: GovernanceDenied | GovernanceConditions,
): McpToolResponse {
  const details: Record<string, unknown> = {
    check_id: result.checkId,
  };
  if (result.findings?.length) {
    details.findings = result.findings;
  }
  if (result.conditions?.length) {
    details.conditions = result.conditions;
  }

  return adcpError('COMPLIANCE_UNSATISFIED', {
    message: result.explanation,
    details,
  });
}
