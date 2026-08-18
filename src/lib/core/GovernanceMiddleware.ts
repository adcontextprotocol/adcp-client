/**
 * Buyer-side governance middleware.
 *
 * Intercepts tool calls in the execution path and checks them against
 * a campaign governance agent before allowing execution. Handles:
 * - approved: proceed with execution
 * - denied: return denial to caller
 * - conditions: auto-apply machine-actionable conditions and re-check
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
import { generateIdempotencyKey } from '../utils/idempotency';
import { createAbortError } from '../protocols/abort';
import type { AdcpCapabilities } from '../utils/capabilities';
import { canonicalize } from '../utils/jcs';
import {
  buildGovernanceIntentRequest,
  governancePurchaseTypeForTask,
  targetDeclaresGovernanceEnforcement,
  targetDeclaresLegacyGovernanceAwareness,
} from '../governance';

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
const MAX_CONDITION_PATH_DEPTH = 32;
const MAX_CONDITION_ARRAY_INDEX = 10_000;

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
  if (parts.length > MAX_CONDITION_PATH_DEPTH) {
    throw new Error(`Condition path exceeds maximum depth of ${MAX_CONDITION_PATH_DEPTH}`);
  }
  for (const part of parts) {
    // Explicit inline block for prototype-pollution vectors. The
    // FORBIDDEN_PATH_SEGMENTS set covers the same cases but CodeQL's
    // `js/prototype-pollution-utility` pattern matcher only recognizes
    // inline string comparisons as a valid guard.
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new Error(`Invalid path segment: ${part}`);
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new Error(`Invalid path segment: ${part}`);
    }
    if (!SAFE_PATH_SEGMENT.test(part)) {
      throw new Error(`Invalid path segment: ${part}`);
    }
    if (/^\d+$/.test(part) && Number(part) > MAX_CONDITION_ARRAY_INDEX) {
      throw new Error(`Condition array index exceeds maximum of ${MAX_CONDITION_ARRAY_INDEX}`);
    }
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nextKey = parts[i + 1]!;
    // Belt-and-suspenders: even with the segment allowlist, traverse only
    // own properties so a malicious prototype-chained value can't be
    // followed.
    const hasOwn = Object.prototype.hasOwnProperty.call(current, key);
    if (!hasOwn || current[key] == null || typeof current[key] !== 'object') {
      // Create array if next key is numeric, else object
      current[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    current = current[key];
  }
  const finalKey = parts[parts.length - 1]!;
  if (finalKey === '__proto__' || finalKey === 'constructor' || finalKey === 'prototype') {
    throw new Error(`Invalid path segment: ${finalKey}`);
  }
  current[finalKey] = value;
}

/**
 * Upper bound on cached `(checkId, outcome)` idempotency keys. Chosen to
 * cover a full day of outcome reporting at ~100/minute without unbounded
 * growth for long-lived buyers. Each entry is ~100 bytes, so the cap
 * caps memory at ~1MB.
 */
const OUTCOME_KEY_CACHE_MAX = 10_000;

export class GovernanceMiddleware {
  /**
   * Cache of idempotency keys per `(checkId, outcome)` tuple. The
   * governance agent dedups on this tuple already, but the SDK keeps its
   * own cache so retries of `reportOutcome` with the same logical intent
   * reuse the same idempotency_key — re-generating on each call defeats
   * the whole retry-safety point of the envelope. Bounded LRU: once full,
   * inserting a new key evicts the oldest. Retries of evicted
   * (checkId, outcome) tuples will mint a fresh key — still functional
   * because the governance agent's own dedup takes over — but won't get
   * the SDK-level retry guarantee.
   */
  private outcomeKeys = new Map<string, string>();

  constructor(
    private governanceConfig: GovernanceConfig,
    private onActivity?: (activity: Activity) => void | Promise<void>,
    /**
     * Buyer's per-instance AdCP version pin. Forwarded to the governance
     * agent's `ProtocolClient.callTool` so a buyer pinned to e.g.
     * `'4.0.0-beta.1'` doesn't silently fall back to the SDK default
     * `ADCP_MAJOR_VERSION` constant when calling the governance agent.
     * Defaults to `undefined`, which `ProtocolClient.callTool` resolves
     * to the SDK constant — same shape as a no-pin call.
     */
    private adcpVersion?: string,
    private versionEnvelope?: import('../protocols').VersionEnvelopeMode,
    private onTransportActivity?: import('../protocols').TransportActivityHandler
  ) {}

  /**
   * Get or mint the idempotency key for a `(checkId, outcome)` tuple.
   * Uses the Map's insertion-order semantics for LRU eviction.
   */
  getOutcomeIdempotencyKey(checkId: string, outcome: OutcomeType): string {
    const tupleKey = `${checkId}\u001f${outcome}`;
    const cached = this.outcomeKeys.get(tupleKey);
    if (cached !== undefined) {
      // Touch: move to end so it becomes most-recently-used.
      this.outcomeKeys.delete(tupleKey);
      this.outcomeKeys.set(tupleKey, cached);
      return cached;
    }
    const fresh = generateIdempotencyKey();
    if (this.outcomeKeys.size >= OUTCOME_KEY_CACHE_MAX) {
      // Evict oldest (first inserted) entry.
      const oldest = this.outcomeKeys.keys().next().value;
      if (oldest !== undefined) this.outcomeKeys.delete(oldest);
    }
    this.outcomeKeys.set(tupleKey, fresh);
    return fresh;
  }

  /**
   * Check whether this tool requires a governance check.
   */
  requiresCheck(tool: string, targetCapabilities?: AdcpCapabilities): boolean {
    if (!toolRequiresGovernance(tool, this.governanceConfig)) return false;
    // Preserve the published scope-only predicate for direct callers. The
    // execution path uses shouldCheck(), which requires discovered target
    // capabilities and fails closed when they are absent.
    if (!targetCapabilities) return true;
    return (
      targetDeclaresGovernanceEnforcement(targetCapabilities, tool) ||
      targetDeclaresLegacyGovernanceAwareness(targetCapabilities, tool)
    );
  }

  /** Resolve request-level triggers and exemptions after the capability gate. */
  async shouldCheck(
    tool: string,
    params: Readonly<Record<string, unknown>>,
    targetCapabilities?: AdcpCapabilities
  ): Promise<boolean> {
    if (!toolRequiresGovernance(tool, this.governanceConfig)) return false;
    if (!targetCapabilities) {
      throw new Error(
        `Target capabilities are required before applying configured governance to ${tool}; refusing to bypass governance`
      );
    }
    if (!this.requiresCheck(tool, targetCapabilities)) return false;
    // The legacy 3.0/3.1 declaration had no conditional-commitment contract.
    if (!targetDeclaresGovernanceEnforcement(targetCapabilities, tool)) return true;

    const stateless = statelessGovernanceApplicability(tool, params);
    if (stateless !== undefined) return stateless;
    const resolver = this.governanceConfig.campaign?.resolveApplicability;
    return resolver ? resolver(tool, params) : true;
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
   *
   * When conditions are returned with required_value, this method auto-applies
   * them and re-checks, up to maxConditionsIterations.
   */
  async checkProposed(
    tool: string,
    params: Record<string, unknown>,
    debugLogs?: GovernanceDebugEntry[],
    signal?: AbortSignal
  ): Promise<{ result: GovernanceCheckResult; params: Record<string, unknown> }>;
  async checkProposed(
    targetAgent: AgentConfig,
    targetCapabilities: AdcpCapabilities,
    tool: string,
    params: Record<string, unknown>,
    debugLogs?: GovernanceDebugEntry[],
    signal?: AbortSignal
  ): Promise<{ result: GovernanceCheckResult; params: Record<string, unknown> }>;
  async checkProposed(
    targetAgentOrTool: AgentConfig | string,
    targetCapabilitiesOrParams: AdcpCapabilities | Record<string, unknown>,
    toolOrDebugLogs: string | GovernanceDebugEntry[] = [],
    paramsOrSignal?: Record<string, unknown> | AbortSignal,
    debugLogs: GovernanceDebugEntry[] = [],
    signal?: AbortSignal
  ): Promise<{ result: GovernanceCheckResult; params: Record<string, unknown> }> {
    const config = this.governanceConfig.campaign;
    if (!config) {
      throw new Error('Campaign governance not configured');
    }

    const legacyDirectCall = typeof targetAgentOrTool === 'string';
    const targetAgent = typeof targetAgentOrTool === 'string' ? config.agent : targetAgentOrTool;
    const targetCapabilities = legacyDirectCall ? undefined : (targetCapabilitiesOrParams as AdcpCapabilities);
    const tool = typeof targetAgentOrTool === 'string' ? targetAgentOrTool : (toolOrDebugLogs as string);
    const params = legacyDirectCall
      ? (targetCapabilitiesOrParams as Record<string, unknown>)
      : (paramsOrSignal as Record<string, unknown>);
    if (legacyDirectCall) {
      debugLogs = Array.isArray(toolOrDebugLogs) ? toolOrDebugLogs : [];
      signal = paramsOrSignal instanceof AbortSignal ? paramsOrSignal : undefined;
    }

    const maxReChecks = config.maxConditionsIterations ?? 0;
    let currentParams = structuredClone(params);
    let iteration = 0;
    let consultationContext: string | undefined;
    let legacyGovernanceContext = config.governanceContext;
    let proposedCommitmentOverride: import('../governance').GovernanceCommitment | undefined;
    let proposalOverride: CheckGovernanceRequest['proposal'] | undefined;
    let purchaseTypeOverride: CheckGovernanceRequest['purchase_type'] | undefined;
    let runtimeAttestationsOverride: CheckGovernanceRequest['runtime_attestations'] | undefined;
    let invoiceRecipientOverride: CheckGovernanceRequest['invoice_recipient'] | undefined;
    let conditionsApplied = false;

    // Always make the initial governance check. maxConditionsIterations only
    // controls how many times we re-apply conditions and re-check.
    do {
      const modernEnforcement = !legacyDirectCall && targetDeclaresGovernanceEnforcement(targetCapabilities, tool);
      const legacyAwareness = legacyDirectCall || targetDeclaresLegacyGovernanceAwareness(targetCapabilities, tool);
      if (!modernEnforcement && !legacyAwareness) {
        throw new Error(`Target service does not declare governance enforcement for ${tool}`);
      }
      if (modernEnforcement && !config.callerUrl) {
        throw new Error(
          'CampaignGovernanceConfig.callerUrl is required when the target declares AdCP 3.2 governance enforcement'
        );
      }
      const details = modernEnforcement ? ((await config.resolveIntentDetails?.(tool, currentParams)) ?? {}) : {};
      const request: CheckGovernanceRequest = modernEnforcement
        ? buildGovernanceIntentRequest({
            planId: config.planId,
            caller: config.callerUrl ?? '',
            targetAgent,
            tool,
            payload: currentParams,
            purchaseType: purchaseTypeOverride ?? details.purchaseType ?? governancePurchaseTypeForTask(tool),
            proposedCommitment: proposedCommitmentOverride ?? details.proposedCommitment,
            consultationContext,
            proposal: proposalOverride ?? details.proposal,
            runtimeAttestations: runtimeAttestationsOverride ?? details.runtimeAttestations,
            invoiceRecipient: invoiceRecipientOverride ?? details.invoiceRecipient,
          })
        : ({
            plan_id: config.planId,
            caller: config.callerUrl ?? '',
            tool,
            payload: structuredClone(currentParams),
            ...(legacyGovernanceContext !== undefined ? { governance_context: legacyGovernanceContext } : {}),
          } as CheckGovernanceRequest);

      debugLogs.push({
        type: 'governance_check',
        iteration,
        tool,
        plan_id: config.planId,
      });

      const response = await ProtocolClient.callTool(config.agent, 'check_governance', request as Record<string, any>, {
        debugLogs,
        adcpVersion: this.adcpVersion,
        ...(this.versionEnvelope !== undefined && { versionEnvelope: this.versionEnvelope }),
        signal,
        onTransportActivity: this.onTransportActivity,
      });

      // Unwrap protocol response (MCP text content, structuredContent, A2A artifacts)
      const responseData = unwrapProtocolResponse(response);

      await this.emitGovernanceActivity('governance_check', {
        tool,
        binding: 'proposed',
        iteration,
        response: redactGovernanceContexts(responseData),
      });

      const checkResult = parseCheckResponse(responseData as unknown as CheckGovernanceResponse);

      if (modernEnforcement && checkResult.checkType !== 'intent') {
        throw new Error('Modern governance intent returned a legacy or execution verdict');
      }

      if (checkResult.status === 'approved') {
        if (conditionsApplied) {
          checkResult.conditionsApplied = true;
          checkResult.modifiedParams = structuredClone(currentParams);
        }
        if (modernEnforcement && !checkResult.governanceContext) {
          throw new Error('Approved governance intent did not return a signed governance_context');
        }
        if (!modernEnforcement) {
          if (checkResult.governanceContext) config.governanceContext = checkResult.governanceContext;
          return { result: checkResult, params: currentParams };
        }
        return {
          result: checkResult,
          params: { ...currentParams, governance_context: checkResult.governanceContext },
        };
      }

      if (checkResult.status === 'denied') {
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

      if (modernEnforcement) {
        // Conditions are rooted at the complete check_governance arguments,
        // not just the downstream payload. They are a non-authorizing
        // counterproposal and must be re-checked with consultation_context.
        const adjustedRequest = structuredClone(request) as unknown as Record<string, any>;
        const originalImmutableFields = snapshotImmutablePayloadFields(adjustedRequest.payload);
        for (const condition of checkResult.conditions) {
          const root = condition.field.split('.')[0];
          if (!SUPPORTED_INTENT_CONDITION_ROOTS.has(root!)) {
            throw new Error(`Governance condition cannot modify unsupported intent field: ${root}`);
          }
          setAtPath(adjustedRequest, condition.field, condition.requiredValue);
        }

        // A condition may replace the entire payload rather than naming the
        // immutable routing, identity, and protocol-owned fields directly.
        // Compare effective values after every condition so nested paths and
        // whole-payload replacement cannot redirect the authorized request.
        const adjustedImmutableFields = snapshotImmutablePayloadFields(adjustedRequest.payload);
        for (const field of GOVERNANCE_IMMUTABLE_PAYLOAD_FIELDS) {
          if (!jsonValuesEqual(originalImmutableFields[field], adjustedImmutableFields[field])) {
            throw new Error(`Governance conditions cannot modify protected payload field ${field}`);
          }
        }

        currentParams = structuredClone((adjustedRequest.payload ?? {}) as Record<string, unknown>);
        proposedCommitmentOverride = adjustedRequest.proposed_commitment as
          | import('../governance').GovernanceCommitment
          | undefined;
        proposalOverride = adjustedRequest.proposal as CheckGovernanceRequest['proposal'] | undefined;
        purchaseTypeOverride = adjustedRequest.purchase_type as CheckGovernanceRequest['purchase_type'] | undefined;
        runtimeAttestationsOverride = adjustedRequest.runtime_attestations as
          | CheckGovernanceRequest['runtime_attestations']
          | undefined;
        invoiceRecipientOverride = adjustedRequest.invoice_recipient as
          | CheckGovernanceRequest['invoice_recipient']
          | undefined;
        consultationContext = checkResult.consultationContext;
        if (!consultationContext) {
          throw new Error('Governance conditions response omitted consultation_context');
        }
      } else {
        // Legacy conditions were rooted directly at the downstream payload.
        for (const condition of checkResult.conditions) {
          setAtPath(currentParams, condition.field, condition.requiredValue);
        }
        if (checkResult.governanceContext) {
          legacyGovernanceContext = checkResult.governanceContext;
          config.governanceContext = checkResult.governanceContext;
        }
      }

      checkResult.conditionsApplied = true;
      checkResult.modifiedParams = currentParams;
      conditionsApplied = true;

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
        checkType: 'intent',
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
    governanceContext?: string,
    signal?: AbortSignal,
    outcomeIdempotencyKey?: string
  ): Promise<GovernanceOutcome | undefined> {
    const config = this.governanceConfig.campaign;
    if (!config) return undefined;

    const gc = governanceContext ?? config.governanceContext ?? '';

    // Reuse the same idempotency_key for retries of the same
    // (checkId, outcome) intent so the governance agent treats them as
    // one logical outcome report rather than distinct submissions.
    const idempotencyKey = outcomeIdempotencyKey || this.getOutcomeIdempotencyKey(checkId, outcome);

    const request: ReportPlanOutcomeRequest = {
      idempotency_key: idempotencyKey,
      plan_id: config.planId,
      check_id: checkId,
      outcome,
      governance_context: gc,
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
        {
          debugLogs,
          adcpVersion: this.adcpVersion,
          ...(this.versionEnvelope !== undefined && { versionEnvelope: this.versionEnvelope }),
          signal,
          onTransportActivity: this.onTransportActivity,
          transportActivityContext: {
            operationId: checkId,
            taskId: checkId,
            idempotencyKey,
          },
        }
      );

      const responseData = unwrapProtocolResponse(response) as unknown as ReportPlanOutcomeResponse;

      await this.emitGovernanceActivity('governance_outcome', {
        check_id: checkId,
        outcome,
      });

      return {
        outcomeId: responseData.outcome_id,
        status: responseData.outcome_state as GovernanceOutcome['status'],
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
      if (signal?.aborted) throw createAbortError(signal.reason);
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

const CONDITIONAL_OPERATIONAL_KEYS = new Set([
  'account',
  'adcp_major_version',
  'adcp_version',
  'context',
  'governance_context',
  'idempotency_key',
  'media_buy_id',
  'push_notification_config',
  'revision',
  'rights_id',
]);

const SUPPORTED_INTENT_CONDITION_ROOTS = new Set([
  'payload',
  'proposed_commitment',
  'proposal',
  'purchase_type',
  'runtime_attestations',
  'invoice_recipient',
]);

const GOVERNANCE_IMMUTABLE_PAYLOAD_FIELDS = [
  'account',
  'media_buy_id',
  'rights_id',
  'revision',
  'idempotency_key',
  'context',
  'adcp_major_version',
  'adcp_version',
  'push_notification_config',
] as const;

function snapshotImmutablePayloadFields(
  payload: unknown
): Record<(typeof GOVERNANCE_IMMUTABLE_PAYLOAD_FIELDS)[number], unknown> {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const snapshot = {} as Record<(typeof GOVERNANCE_IMMUTABLE_PAYLOAD_FIELDS)[number], unknown>;
  for (const field of GOVERNANCE_IMMUTABLE_PAYLOAD_FIELDS) {
    snapshot[field] = record[field] === undefined ? undefined : structuredClone(record[field]);
  }
  return snapshot;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalize(left) === canonicalize(right);
}

/**
 * Return a request-local applicability answer when the schema exemption is
 * decidable without reading seller state. `undefined` delegates ambiguous
 * delta/price/term comparisons to the adopter callback (or conservatively
 * governs when no callback is installed).
 */
function statelessGovernanceApplicability(
  tool: string,
  params: Readonly<Record<string, unknown>>
): boolean | undefined {
  if (tool === 'activate_signal') return params.action !== 'deactivate';
  if (tool === 'build_creative' && params.mode === 'estimate') return false;

  if (tool === 'update_rights') {
    if (params.paused === false) return true;
    if (params.paused === true && hasOnlyOperationalAnd(params, ['paused'])) return false;
    return undefined;
  }

  if (tool === 'update_media_buy' || tool === 'control_media_buy') {
    if (params.paused === false) return true;
    if (params.canceled === true && hasOnlyOperationalAnd(params, ['canceled', 'cancellation_reason'])) return false;
    if (params.paused === true && hasOnlyOperationalAnd(params, ['paused'])) return false;
    return undefined;
  }

  return undefined;
}

function hasOnlyOperationalAnd(params: Readonly<Record<string, unknown>>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(params).every(key => CONDITIONAL_OPERATIONAL_KEYS.has(key) || allowedKeys.has(key));
}

function redactGovernanceContexts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactGovernanceContexts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'governance_context' || key === 'consultation_context' ? '[redacted]' : redactGovernanceContexts(child),
    ])
  );
}
