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

import { randomUUID } from 'crypto';

import type { AgentConfig } from '../types';
import type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
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
  | { type: 'governance_outcome_error'; check_id: string; error: string };

/** Safe pattern for path segments: identifiers or numeric indices */
const SAFE_PATH_SEGMENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$|^\d+$/;

/** Path segments that would cause prototype pollution even though they match the safe pattern. */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Set a value at a dot-path in an object. Creates intermediate objects as needed.
 * e.g., setAtPath(obj, 'packages.0.budget', 25000)
 *
 * Path segments are validated against a safe allowlist pattern and a forbidden
 * set to prevent prototype pollution from external governance agent responses.
 */
export function setAtPath(obj: Record<string, any>, path: string, value: unknown): void {
  if (!path || path.trim() === '') {
    throw new Error('Empty path is not allowed');
  }
  const parts = path.split('.');
  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new Error(`Invalid path segment: ${part}`);
    }
    if (!SAFE_PATH_SEGMENT.test(part)) {
      throw new Error(`Invalid path segment: ${part}`);
    }
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nextKey = parts[i + 1]!;
    if (current[key] == null || typeof current[key] !== 'object') {
      // Create array if next key is numeric, else object
      current[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    current = current[key];
  }
  current[parts[parts.length - 1]!] = value;
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

    const maxReChecks = config.maxConditionsIterations ?? 0;
    let currentParams = structuredClone(params);
    let iteration = 0;

    // Always make the initial governance check. maxConditionsIterations only
    // controls how many times we re-apply conditions and re-check.
    do {
      const request: CheckGovernanceRequest = {
        plan_id: config.planId,
        caller: config.callerUrl ?? '',
        tool,
        payload: currentParams,
        governance_context: config.governanceContext,
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
        request as Record<string, any>,
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

      // Thread governance_context from response to subsequent checks
      if (checkResult.governanceContext) {
        config.governanceContext = checkResult.governanceContext;
      }

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

      // If we've exhausted re-check iterations, return conditions to caller
      if (iteration >= maxReChecks) {
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
    } while (iteration <= maxReChecks);

    // Defensive: the early return at `iteration >= maxReChecks` inside the loop
    // should always fire before this point. If we somehow reach here, treat it
    // as an unresolvable condition so we fail closed.
    return {
      result: {
        checkId: '',
        status: 'denied',
        explanation: `Governance conditions could not be resolved after ${maxReChecks} iterations`,
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
    debugLogs: GovernanceDebugEntry[] = [],
    governanceContext?: string
  ): Promise<GovernanceOutcome | undefined> {
    const config = this.governanceConfig.campaign;
    if (!config) return undefined;

    const gc = governanceContext ?? config.governanceContext ?? '';

    const request: ReportPlanOutcomeRequest = {
      plan_id: config.planId,
      check_id: checkId,
      outcome,
      governance_context: gc,
      idempotency_key: randomUUID(),
    };

    if (outcome === 'completed' && sellerResponse) {
      request.seller_response = sellerResponse as ReportPlanOutcomeRequest['seller_response'];
    }

    if (outcome === 'failed' && error) {
      request.error = error;
    }

    try {
      const response = await ProtocolClient.callTool(
        config.agent,
        'report_plan_outcome',
        request as Record<string, any>,
        debugLogs
      );

      const responseData = unwrapProtocolResponse(response) as unknown as ReportPlanOutcomeResponse;

      await this.emitGovernanceActivity('governance_outcome', {
        check_id: checkId,
        outcome,
      });

      return {
        outcomeId: responseData.outcome_id,
        status: responseData.status as GovernanceOutcome['status'],
        committedBudget: responseData.committed_budget ?? undefined,
        findings: responseData.findings?.map(f => ({
          categoryId: f.category_id,
          severity: f.severity,
          explanation: f.explanation,
          details: f.details ?? undefined,
        })),
        planSummary:
          responseData.plan_summary?.total_committed != null && responseData.plan_summary?.budget_remaining != null
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
      await this.emitGovernanceActivity(
        'governance_outcome',
        {
          check_id: checkId,
          outcome,
          error: (err as Error).message,
          warning: 'Outcome reporting failed — governance agent may have stale state',
        },
        'failed'
      );
      return undefined;
    }
  }

  private async emitGovernanceActivity(
    type: Activity['type'],
    payload: Record<string, unknown>,
    status: string = 'completed'
  ): Promise<void> {
    await this.onActivity?.({
      type,
      operation_id: '',
      agent_id: this.governanceConfig.campaign?.agent.id ?? '',
      task_type: 'governance',
      status,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}
