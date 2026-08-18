/**
 * Governance middleware types for buyer-side campaign governance.
 *
 * The governance middleware intercepts tool calls and checks them against
 * a campaign governance agent before execution. It handles the full lifecycle:
 * check → execute → report outcome.
 */

import type { AgentConfig } from '../types';
import type { CheckGovernanceRequest, CheckGovernanceResponse, EscalationSeverity } from '../types/tools.generated';
import type { GovernanceCommitment } from '../governance';

export interface GovernanceIntentDetails {
  /** Required for tasks whose commitment is not directly derivable from payload. */
  proposedCommitment?: GovernanceCommitment;
  /** Required for accept_proposal so governance can verify commercial terms. */
  proposal?: CheckGovernanceRequest['proposal'];
  /** Overrides the task-derived purchase type when a future task needs one. */
  purchaseType?: CheckGovernanceRequest['purchase_type'];
  /** Runtime evidence used by signal-activation intent checks. */
  runtimeAttestations?: CheckGovernanceRequest['runtime_attestations'];
  /** Billing override that governance must evaluate with the commitment. */
  invoiceRecipient?: CheckGovernanceRequest['invoice_recipient'];
}

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
  /** @deprecated Intent checks never reuse authorization; retained only as an outcome-report fallback. */
  governanceContext?: string;
  /**
   * Resolve intent-only fields that cannot be inferred safely from downstream
   * task arguments (for example an update's positive commitment delta).
   */
  resolveIntentDetails?: (
    tool: string,
    payload: Readonly<Record<string, unknown>>
  ) => GovernanceIntentDetails | Promise<GovernanceIntentDetails>;
  /**
   * Resolve conditional `x-governed-commitment` requests that require
   * authoritative current state (for example, whether a budget change is
   * decrease-only). Return `true` for a trigger and `false` for an exemption.
   * Obvious stateless exemptions such as pause, cancel, deactivate, and
   * creative estimates are handled by the SDK before this callback runs.
   */
  resolveApplicability?: (tool: string, payload: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>;
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
  status: 'approved' | 'denied' | 'conditions';
  /** Modern 3.2 response shape, or `legacy` for the deprecated 3.x arm. */
  checkType?: 'intent' | 'execution' | 'legacy';
  explanation: string;
  findings?: GovernanceFinding[];
  conditions?: GovernanceCondition[];
  escalation?: GovernanceEscalation;
  expiresAt?: string;
  /** Opaque governance context issued by the governance agent. Callers must thread this to subsequent checks and outcome reports. */
  governanceContext?: string;
  /** Non-authorizing handle used only to re-check an adjusted intent. */
  consultationContext?: string;
  /** Whether conditions were auto-applied by the middleware */
  conditionsApplied?: boolean;
  /** The modified params after conditions were applied */
  modifiedParams?: Record<string, unknown>;
}

interface NormalizedGovernanceVerdictBase {
  checkId: string;
  explanation: string;
  raw: CheckGovernanceResponse;
}

export interface NormalizedGovernanceApproved extends NormalizedGovernanceVerdictBase {
  verdict: 'approved';
  checkType: 'intent' | 'execution' | 'legacy';
  governanceContext?: string;
  expiresAt?: string;
}

export interface NormalizedGovernanceDenied extends NormalizedGovernanceVerdictBase {
  verdict: 'denied';
  checkType: 'intent' | 'execution' | 'legacy';
}

/**
 * Compatibility surface for callers that consumed the pre-3.2 normalized
 * conditions type. Runtime normalization returns one of the stricter arms
 * below, but this broad interface remains source-compatible.
 */
export interface NormalizedGovernanceConditions extends NormalizedGovernanceVerdictBase {
  verdict: 'conditions';
  checkType: 'intent' | 'execution' | 'legacy';
  governanceContext?: string;
  consultationContext?: string;
}

export interface NormalizedGovernanceLegacyConditions extends NormalizedGovernanceConditions {
  checkType: 'legacy';
  /** Deprecated legacy 3.x continuation token. Modern conditions use consultationContext instead. */
  governanceContext?: string;
  consultationContext?: never;
}

export interface NormalizedGovernanceIntentConditions extends NormalizedGovernanceConditions {
  checkType: 'intent';
  /** Non-authorizing handle that must be threaded only to the adjusted intent re-check. */
  consultationContext: string;
  governanceContext?: never;
}

export type NormalizedGovernanceStrictConditions =
  | NormalizedGovernanceLegacyConditions
  | NormalizedGovernanceIntentConditions;

export type NormalizedGovernanceVerdict =
  | NormalizedGovernanceApproved
  | NormalizedGovernanceDenied
  | NormalizedGovernanceConditions;

type NormalizedGovernanceStrictVerdict =
  | NormalizedGovernanceApproved
  | NormalizedGovernanceDenied
  | NormalizedGovernanceStrictConditions;

/**
 * Normalize modern `verdict` responses and the deprecated legacy `status`
 * response arm into one discriminated shape. Invalid modern combinations
 * fail closed instead of leaking an authorization token from conditions or
 * denied responses.
 */
function normalizeGovernanceVerdictStrict(response: unknown): NormalizedGovernanceStrictVerdict | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const raw = response as Record<string, unknown>;
  if ('check_type' in raw && raw.check_type !== 'intent' && raw.check_type !== 'execution') return null;
  const checkType = raw.check_type === 'intent' || raw.check_type === 'execution' ? raw.check_type : 'legacy';
  const verdict =
    checkType !== 'legacy'
      ? isGovernanceDecision(raw.verdict)
        ? raw.verdict
        : null
      : isGovernanceDecision(raw.verdict)
        ? raw.verdict
        : isGovernanceDecision(raw.status)
          ? raw.status
          : null;
  if (!verdict || typeof raw.check_id !== 'string' || typeof raw.explanation !== 'string') return null;

  const isModern = checkType !== 'legacy';
  const governanceContext = typeof raw.governance_context === 'string' ? raw.governance_context : undefined;
  const consultationContext = typeof raw.consultation_context === 'string' ? raw.consultation_context : undefined;
  const expiresAt = typeof raw.expires_at === 'string' ? raw.expires_at : undefined;

  if (isModern) {
    if (verdict === 'approved' && (!governanceContext || !expiresAt)) return null;
    if (verdict === 'conditions') {
      if (checkType !== 'intent' || !consultationContext || 'governance_context' in raw || 'expires_at' in raw)
        return null;
      if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) return null;
    }
    if (verdict !== 'conditions' && (raw.conditions !== undefined || 'consultation_context' in raw)) return null;
    if (verdict !== 'approved' && ('governance_context' in raw || 'expires_at' in raw)) return null;
    if (verdict === 'denied' && (!Array.isArray(raw.findings) || raw.findings.length === 0)) return null;
    if (checkType === 'execution' && verdict === 'conditions') return null;
  }

  const base: NormalizedGovernanceVerdictBase = {
    checkId: raw.check_id,
    explanation: raw.explanation,
    raw: response as CheckGovernanceResponse,
  };
  if (verdict === 'approved') {
    return { ...base, verdict, checkType, governanceContext, expiresAt };
  }
  if (verdict === 'conditions') {
    if (checkType === 'legacy') return { ...base, verdict, checkType, governanceContext };
    return { ...base, verdict, checkType: 'intent', consultationContext: consultationContext! };
  }
  return { ...base, verdict, checkType };
}

/** Normalize a wire response while retaining the pre-3.2 public union for source compatibility. */
export function normalizeGovernanceVerdict(response: unknown): NormalizedGovernanceVerdict | null {
  return normalizeGovernanceVerdictStrict(response);
}

export function isGovernanceApproved(response: unknown): response is CheckGovernanceResponse {
  return normalizeGovernanceVerdictStrict(response)?.verdict === 'approved';
}

export function isGovernanceDenied(response: unknown): response is CheckGovernanceResponse {
  return normalizeGovernanceVerdictStrict(response)?.verdict === 'denied';
}

export function isGovernanceConditions(response: unknown): response is CheckGovernanceResponse {
  return normalizeGovernanceVerdictStrict(response)?.verdict === 'conditions';
}

function isGovernanceDecision(value: unknown): value is 'approved' | 'denied' | 'conditions' {
  return value === 'approved' || value === 'denied' || value === 'conditions';
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
  const normalized = normalizeGovernanceVerdictStrict(response);
  if (!normalized) {
    throw new TypeError('Invalid check_governance verdict response');
  }
  return {
    checkId: normalized.checkId,
    status: normalized.verdict,
    checkType: normalized.checkType,
    explanation: normalized.explanation,
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
    governanceContext:
      normalized.verdict === 'approved' || (normalized.verdict === 'conditions' && normalized.checkType === 'legacy')
        ? normalized.governanceContext
        : undefined,
    consultationContext: normalized.verdict === 'conditions' ? normalized.consultationContext : undefined,
  };
}
