/**
 * Governance middleware types for buyer-side campaign governance.
 *
 * The governance middleware intercepts tool calls and checks them against
 * a campaign governance agent before execution. It handles the full lifecycle:
 * check → execute → report outcome.
 */

import type { AgentConfig } from '../types';
import type { CheckGovernanceResponse, EscalationSeverity } from '../types/tools.generated';

/**
 * Campaign governance agent configuration.
 * The campaign governance agent handles check_governance, sync_plans,
 * report_plan_outcome, and get_plan_audit_logs.
 */
export interface CampaignGovernanceConfig {
  /** The governance agent to call */
  agent: AgentConfig;
  /** Plan ID for this advertiser's campaign */
  planId: string;
  /** Caller URL for the check_governance request */
  callerUrl?: string;
  /** Max re-check iterations after auto-applying conditions. Default: 0 (return conditions to caller without re-checking). The initial governance check always fires. */
  maxConditionsIterations?: number;
  /** Opaque governance context string from a prior check_governance response. The middleware passes this through on subsequent checks and outcome reports. */
  governanceContext?: string;
}

/**
 * Governance configuration.
 *
 * Campaign governance handles: check_governance, sync_plans,
 * report_plan_outcome, get_plan_audit_logs.
 */
export interface GovernanceConfig {
  /** Campaign governance agent */
  campaign?: CampaignGovernanceConfig;
  /**
   * Which tools require governance checks.
   * - 'all': every tool including get_adcp_capabilities (governance tools themselves still excluded)
   * - string[]: only listed tools
   * - function: custom predicate
   * - undefined (default): all tools except get_adcp_capabilities and governance tools
   */
  scope?: 'all' | string[] | ((tool: string) => boolean);
}

/** Governance tools that are always excluded (infinite recursion otherwise) */
const GOVERNANCE_SELF_TOOLS = new Set(['sync_plans', 'check_governance', 'report_plan_outcome', 'get_plan_audit_logs']);

/** Tools excluded by default (governance tools + capabilities) */
const DEFAULT_EXCLUDED_TOOLS = new Set([...GOVERNANCE_SELF_TOOLS, 'get_adcp_capabilities']);

/**
 * Determine whether a tool requires a governance check given the config.
 */
export function toolRequiresGovernance(tool: string, config: GovernanceConfig): boolean {
  if (!config.campaign) return false;

  // Governance tools are always excluded to prevent infinite recursion
  if (GOVERNANCE_SELF_TOOLS.has(tool)) return false;

  if (config.scope === 'all') return true;

  if (Array.isArray(config.scope)) return config.scope.includes(tool);

  if (typeof config.scope === 'function') return config.scope(tool);

  // Default: all tools except excluded set
  return !DEFAULT_EXCLUDED_TOOLS.has(tool);
}

/**
 * A single finding from a governance check.
 */
export interface GovernanceFinding {
  categoryId: string;
  policyId?: string;
  severity: EscalationSeverity;
  explanation: string;
  confidence?: number;
  uncertaintyReason?: string;
  details?: Record<string, unknown>;
}

/**
 * A condition that must be met before the action can proceed.
 */
export interface GovernanceCondition {
  /** Dot-path to the field that needs adjustment */
  field: string;
  /** The value the field must have for approval. When present, condition is machine-actionable. */
  requiredValue?: unknown;
  /** Why this condition is required */
  reason: string;
}

/**
 * Escalation details when a governance check requires human review.
 */
export interface GovernanceEscalation {
  reason: string;
  severity: EscalationSeverity;
  requiresHuman: boolean;
  approvalTier?: string;
}

/**
 * Governance check result attached to TaskResult.
 */
export interface GovernanceCheckResult {
  checkId: string;
  status: 'approved' | 'denied' | 'conditions' | 'escalated';
  explanation: string;
  findings?: GovernanceFinding[];
  conditions?: GovernanceCondition[];
  escalation?: GovernanceEscalation;
  expiresAt?: string;
  /** Opaque governance context issued by the governance agent. Callers must thread this to subsequent checks and outcome reports. */
  governanceContext?: string;
  /** Whether conditions were auto-applied by the middleware */
  conditionsApplied?: boolean;
  /** The modified params after conditions were applied */
  modifiedParams?: Record<string, unknown>;
}

/**
 * Outcome metadata from report_plan_outcome, attached to TaskResult after completion.
 */
export interface GovernanceOutcome {
  outcomeId: string;
  status: 'accepted' | 'findings';
  committedBudget?: number;
  findings?: GovernanceFinding[];
  planSummary?: {
    totalCommitted: number;
    budgetRemaining: number;
  };
}

/**
 * Parse a CheckGovernanceResponse into GovernanceCheckResult.
 */
export function parseCheckResponse(response: CheckGovernanceResponse): GovernanceCheckResult {
  return {
    checkId: response.check_id,
    status: response.status,
    explanation: response.explanation,
    findings: response.findings?.map(f => ({
      categoryId: f.category_id,
      policyId: f.policy_id ?? undefined,
      severity: f.severity,
      explanation: f.explanation,
      confidence: f.confidence ?? undefined,
      uncertaintyReason: f.uncertainty_reason ?? undefined,
      details: f.details ?? undefined,
    })),
    conditions: response.conditions?.map(c => ({
      field: c.field,
      requiredValue: c.required_value,
      reason: c.reason,
    })),
    expiresAt: response.expires_at ?? undefined,
    governanceContext: response.governance_context ?? undefined,
  };
}
