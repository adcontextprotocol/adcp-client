/**
 * Buyer-side governance middleware.
 *
 * Intercepts tool calls in the execution path and checks them against
 * a campaign governance agent before allowing execution. Handles:
 * - approved: proceed with execution
 * - denied: return denial to caller
 * - conditions: auto-apply machine-actionable conditions and re-check
 * - escalated: return escalation continuation to caller
 *
 * After execution, reports the outcome back to the governance agent.
 */

import type { AgentConfig } from '../types';
import type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  ReportPlanOutcomeRequest,
  OutcomeType,
} from '../types/tools.generated';
import { ProtocolClient } from '../protocols';
import type { Activity } from './AsyncHandler';
import type {
  GovernanceConfig,
  CampaignGovernanceConfig,
  GovernanceCheckResult,
  GovernanceOutcome,
  GovernanceFinding,
  GovernanceCondition,
} from './GovernanceTypes';
import { toolRequiresGovernance, parseCheckResponse } from './GovernanceTypes';
import { unwrapProtocolResponse } from '../utils/response-unwrapper';

/**
 * Typed debug log entries for governance operations.
 */
export type GovernanceDebugEntry =
  | { type: 'governance_check'; iteration: number; tool: string; plan_id: string }
  | { type: 'governance_conditions_applied'; iteration: number; conditions: GovernanceCondition[] }
  | { type: 'governance_conditions_exhausted'; iterations: number; tool: string }
  | { type: 'governance_outcome_error'; check_id: string; error: string };

/** Path segments that would cause prototype pollution if used as object keys. */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

/**
 * Set a value at a dot-path in an object. Creates intermediate objects as needed.
 * e.g., setAtPath(obj, 'packages.0.budget', 25000)
 */
export function setAtPath(obj: Record<string, any>, path: string, value: unknown): void {
  if (!path || path.trim() === '') {
    throw new Error('Empty path is not allowed');
  }
  const parts = path.split('.');
  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new Error(`Forbidden path segment: ${part}`);
    }
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === undefined || current[key] === null) {
      // Create array if next key is numeric, else object
      current[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    current = current[key];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Deep clone a plain object (JSON-safe).
 */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export class GovernanceMiddleware {
  constructor(
    private governanceConfig: GovernanceConfig,
    private onActivity?: (activity: Activity) => void | Promise<void>
  ) {}

  /**
   * Check whether this tool requires a governance check.
   */
  requiresCheck(tool: string): boolean {
    return toolRequiresGovernance(tool, this.governanceConfig);
  }

  /**
   * Get the campaign governance config. Returns undefined if not configured.
   */
  get campaign(): CampaignGovernanceConfig | undefined {
    return this.governanceConfig.campaign;
  }

  /**
   * Run a proposed governance check before sending a tool call to a seller.
   *
   * Returns the governance result. The caller decides how to handle each status:
   * - approved: proceed with execution (params may be modified by conditions)
   * - denied: do not execute
   * - escalated: do not execute, return continuation to caller
   *
   * When conditions are returned with required_value, this method auto-applies
   * them and re-checks, up to maxConditionsIterations.
   */
  async checkProposed(
    tool: string,
    params: Record<string, unknown>,
    debugLogs: GovernanceDebugEntry[] = []
  ): Promise<{ result: GovernanceCheckResult; params: Record<string, unknown> }> {
    const config = this.governanceConfig.campaign;
    if (!config) {
      throw new Error('Campaign governance not configured');
    }

    const maxIterations = config.maxConditionsIterations ?? 0;
    let currentParams = deepClone(params);
    let iteration = 0;

    while (iteration < maxIterations) {
      const request: CheckGovernanceRequest = {
        plan_id: config.planId,
        buyer_campaign_ref: config.buyerCampaignRef ?? '',
        binding: 'proposed',
        caller: config.callerUrl ?? '',
        tool,
        payload: currentParams,
      };

      debugLogs.push({
        type: 'governance_check',
        iteration,
        tool,
        plan_id: config.planId,
      });

      const response = await ProtocolClient.callTool(
        config.agent,
        'check_governance',
        request as unknown as Record<string, unknown>,
        debugLogs
      );

      // Unwrap protocol response (MCP text content, structuredContent, A2A artifacts)
      const responseData = unwrapProtocolResponse(response);

      await this.emitGovernanceActivity('governance_check', {
        tool,
        binding: 'proposed',
        iteration,
        response: responseData,
      });

      const checkResult = parseCheckResponse(responseData as unknown as CheckGovernanceResponse);

      if (checkResult.status === 'approved') {
        return { result: checkResult, params: currentParams };
      }

      if (checkResult.status === 'denied' || checkResult.status === 'escalated') {
        return { result: checkResult, params: currentParams };
      }

      // status === 'conditions'
      if (!checkResult.conditions || checkResult.conditions.length === 0) {
        // Conditions status with no conditions — treat as advisory denial
        return { result: checkResult, params: currentParams };
      }

      // Try to auto-apply machine-actionable conditions
      const allApplicable = checkResult.conditions.every(c => c.requiredValue !== undefined);
      if (!allApplicable) {
        // Some conditions are advisory-only (no required_value) — can't auto-apply
        return { result: checkResult, params: currentParams };
      }

      // Apply conditions and re-check
      for (const condition of checkResult.conditions) {
        setAtPath(currentParams, condition.field, condition.requiredValue);
      }

      checkResult.conditionsApplied = true;
      checkResult.modifiedParams = currentParams;

      debugLogs.push({
        type: 'governance_conditions_applied',
        iteration,
        conditions: checkResult.conditions,
      });

      iteration++;
    }

    // Exhausted iterations — return the last result
    debugLogs.push({
      type: 'governance_conditions_exhausted',
      iterations: maxIterations,
      tool,
    });
    return {
      result: {
        checkId: '',
        status: 'denied',
        binding: 'proposed',
        explanation: `Governance conditions could not be resolved after ${maxIterations} iterations`,
      },
      params: currentParams,
    };
  }

  /**
   * Report the outcome of a tool execution to the governance agent.
   * Called after the seller responds (success or failure).
   */
  async reportOutcome(
    checkId: string,
    outcome: OutcomeType,
    sellerResponse?: Record<string, unknown>,
    error?: { code?: string; message: string },
    debugLogs: GovernanceDebugEntry[] = []
  ): Promise<GovernanceOutcome | undefined> {
    const config = this.governanceConfig.campaign;
    if (!config) return undefined;

    const request: ReportPlanOutcomeRequest = {
      plan_id: config.planId,
      check_id: checkId,
      buyer_campaign_ref: config.buyerCampaignRef ?? '',
      outcome,
    };

    if (outcome === 'completed' && sellerResponse) {
      request.seller_response = sellerResponse as any;
    }

    if (outcome === 'failed' && error) {
      request.error = error;
    }

    try {
      const response = await ProtocolClient.callTool(
        config.agent,
        'report_plan_outcome',
        request as unknown as Record<string, unknown>,
        debugLogs
      );

      const responseData = unwrapProtocolResponse(response) as any;

      await this.emitGovernanceActivity('governance_outcome', {
        check_id: checkId,
        outcome,
        response: responseData,
      });

      return {
        outcomeId: responseData.outcome_id,
        status: responseData.status,
        committedBudget: responseData.committed_budget,
        findings: responseData.findings?.map((f: any) => ({
          categoryId: f.category_id,
          severity: f.severity,
          explanation: f.explanation,
          details: f.details,
        })),
        planSummary: responseData.plan_summary
          ? {
              totalCommitted: responseData.plan_summary.total_committed,
              budgetRemaining: responseData.plan_summary.budget_remaining,
            }
          : undefined,
      };
    } catch (err) {
      // Outcome reporting failure shouldn't fail the task
      debugLogs.push({
        type: 'governance_outcome_error',
        check_id: checkId,
        error: (err as Error).message,
      });
      return undefined;
    }
  }

  private async emitGovernanceActivity(type: Activity['type'], payload: Record<string, unknown>): Promise<void> {
    await this.onActivity?.({
      type,
      operation_id: '',
      agent_id: this.governanceConfig.campaign?.agent.id ?? '',
      task_type: 'governance',
      status: 'completed',
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}
