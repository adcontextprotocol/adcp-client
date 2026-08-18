/**
 * Governance Adapter
 *
 * Server-side adapter for implementing committed governance checks.
 * Sellers use this to check governance before executing media buys.
 *
 * The committed check verifies that the seller's planned delivery
 * parameters comply with the buyer's campaign governance plan.
 */

import type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  PlannedDelivery,
  GovernancePhase,
} from '../types/tools.generated';
import { ProtocolClient } from '../protocols';
import type { AgentConfig } from '../types';
import { unwrapProtocolResponse } from '../utils/response-unwrapper';
import type { GovernanceCommitment } from '../governance';
import { buildGovernanceExecutionCommitment, buildGovernanceExecutionRequest } from '../governance';
import { normalizeGovernanceVerdict } from '../core/GovernanceTypes';

/**
 * Configuration for the seller-side governance adapter.
 */
export interface GovernanceAdapterConfig {
  /** The governance agent to call for committed checks */
  agent: AgentConfig;
  /** The seller's caller URL for governance checks */
  callerUrl: string;
  /**
   * AdCP version pin sent to the governance agent. Should match the
   * seller's `createAdcpServer({ adcpVersion })` value so the wire-level
   * `adcp_major_version` field is consistent across the seller's
   * inbound (buyer-facing) and outbound (governance-agent-facing) traffic.
   *
   * Defaults to `undefined`, which `ProtocolClient.callTool` resolves to
   * the SDK-pinned `ADCP_VERSION`. Pass an explicit value when the seller
   * pins a non-default version.
   */
  adcpVersion?: string;
}

/**
 * Committed governance check request from the seller's perspective.
 */
interface CommittedCheckRequestBase {
  /** @deprecated Put the durable ID on plannedDelivery.media_buy_id. */
  mediaBuyId?: string;
  /** What the seller will actually deliver */
  plannedDelivery: PlannedDelivery;
  /** Lifecycle phase of the check */
  phase?: GovernancePhase;
  /** Delivery metrics for delivery-phase checks */
  deliveryMetrics?: CheckGovernanceRequest['delivery_metrics'];
  /** Summary of changes for modification-phase checks */
  modificationSummary?: string;
}

/** Deprecated plan-addressed request retained for existing seller adopters. */
export interface LegacyCommittedCheckRequest extends CommittedCheckRequestBase {
  planId: string;
  governanceContext?: string;
  executionCommitment?: GovernanceCommitment;
}

/** AdCP 3.2 context-addressed execution request. */
export interface ModernCommittedCheckRequest extends CommittedCheckRequestBase {
  /** Opaque governance context from the buyer's protocol envelope. */
  governanceContext: string;
  /** Required authoritative positive delta for modification checks. */
  executionCommitment?: GovernanceCommitment;
}

export type CommittedCheckRequest = LegacyCommittedCheckRequest | ModernCommittedCheckRequest;

/**
 * Interface for seller-side governance adapters.
 * Sellers implement this to integrate governance checks into their execution path.
 */
export interface IGovernanceAdapter {
  /** Whether governance is supported by this server */
  isSupported(): boolean;
  /** Run a committed governance check before executing a media buy */
  checkCommitted(request: CommittedCheckRequest): Promise<CheckGovernanceResponse>;
}

/**
 * Error codes for governance adapter responses.
 */
export const GovernanceAdapterErrorCodes = {
  NOT_SUPPORTED: 'governance_not_supported',
  CHECK_FAILED: 'governance_check_failed',
  AGENT_UNREACHABLE: 'governance_agent_unreachable',
} as const;

export type GovernanceAdapterErrorCode = (typeof GovernanceAdapterErrorCodes)[keyof typeof GovernanceAdapterErrorCodes];

export class GovernanceAdapterError extends Error {
  constructor(
    readonly code: GovernanceAdapterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'GovernanceAdapterError';
  }
}

/**
 * Type guard: check if a response is a governance adapter error.
 */
export function isGovernanceAdapterError(
  response: unknown
): response is GovernanceAdapterError | { error: { code: GovernanceAdapterErrorCode; message?: string } } {
  if (response instanceof GovernanceAdapterError) return true;
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, any>;
  return r.error?.code && Object.values(GovernanceAdapterErrorCodes).includes(r.error.code);
}

/**
 * Governance adapter that calls a governance agent via AdCP protocol.
 *
 * Sellers configure this with their governance agent and caller URL,
 * then call checkCommitted() before executing media buys.
 *
 * For custom governance logic, extend this class and override checkCommitted().
 */
export class GovernanceAdapter implements IGovernanceAdapter {
  private agentConfig?: GovernanceAdapterConfig;

  constructor(config?: GovernanceAdapterConfig) {
    this.agentConfig = config;
  }

  isSupported(): boolean {
    return !!this.agentConfig;
  }

  async checkCommitted(request: CommittedCheckRequest): Promise<CheckGovernanceResponse> {
    if (!this.agentConfig) {
      return adapterDenial('Governance not configured on this server', GovernanceAdapterErrorCodes.NOT_SUPPORTED);
    }

    const plannedDelivery =
      request.mediaBuyId && !request.plannedDelivery.media_buy_id
        ? { ...request.plannedDelivery, media_buy_id: request.mediaBuyId }
        : request.plannedDelivery;
    // `planId` identifies the published pre-3.2 request arm. Legacy callers
    // commonly supplied both it and governanceContext, so plan addressing
    // must take precedence; otherwise an SDK upgrade silently drops plan_id.
    const planId = 'planId' in request ? request.planId : undefined;
    const legacy = typeof planId === 'string' && planId.length > 0;
    const modern = !legacy && typeof request.governanceContext === 'string' && request.governanceContext.length > 0;
    const phase = request.phase ?? 'purchase';
    let checkRequest: CheckGovernanceRequest;
    if (modern) {
      let executionCommitment = request.executionCommitment;
      if (phase === 'modification' && !executionCommitment) {
        throw new TypeError('Modern modification governance checks require an authoritative executionCommitment');
      }
      if (
        phase === 'purchase' &&
        !executionCommitment &&
        typeof plannedDelivery.total_budget === 'number' &&
        typeof plannedDelivery.currency === 'string'
      ) {
        executionCommitment = buildGovernanceExecutionCommitment(
          plannedDelivery.total_budget,
          plannedDelivery.currency
        );
      }
      checkRequest = buildGovernanceExecutionRequest({
        caller: this.agentConfig.callerUrl,
        governanceContext: request.governanceContext!,
        plannedDelivery,
        phase,
        executionCommitment,
        deliveryMetrics: request.deliveryMetrics,
        modificationSummary: request.modificationSummary,
      });
    } else {
      // Preserve the published pre-3.2 plan-addressed request shape.
      checkRequest = {
        plan_id: planId,
        caller: this.agentConfig.callerUrl,
        governance_context: request.governanceContext,
        planned_delivery: plannedDelivery,
        phase: request.phase,
        delivery_metrics: request.deliveryMetrics,
        ...(request.mediaBuyId && { payload: { media_buy_id: request.mediaBuyId } }),
        ...(request.modificationSummary && { payload: { modification_summary: request.modificationSummary } }),
      } as CheckGovernanceRequest;
    }

    try {
      const response = await ProtocolClient.callTool(
        this.agentConfig.agent,
        'check_governance',
        checkRequest as Record<string, any>,
        { adcpVersion: this.agentConfig.adcpVersion }
      );

      const unwrapped = unwrapProtocolResponse(response) as unknown as CheckGovernanceResponse;
      if (!modern) return unwrapped;
      const verdict = normalizeGovernanceVerdict(unwrapped);
      if (!verdict || verdict.verdict === 'conditions' || verdict.checkType !== 'execution') {
        throw new GovernanceAdapterError(
          GovernanceAdapterErrorCodes.CHECK_FAILED,
          'Governance execution check returned an invalid non-binary verdict'
        );
      }
      return unwrapped;
    } catch (err) {
      if (err instanceof GovernanceAdapterError) throw err;
      throw new GovernanceAdapterError(
        GovernanceAdapterErrorCodes.AGENT_UNREACHABLE,
        `Governance agent unavailable: ${(err as Error).message}`,
        { cause: err }
      );
    }
  }
}

function adapterDenial(message: string, code: GovernanceAdapterErrorCode): CheckGovernanceResponse {
  return {
    check_id: '',
    verdict: 'denied',
    check_type: 'execution',
    explanation: message,
    findings: [
      {
        category_id: 'governance_execution',
        severity: 'critical',
        explanation: message,
        details: { adapter_error_code: code },
      },
    ],
    error_code: code,
  } as unknown as CheckGovernanceResponse;
}

/**
 * Pre-configured governance adapter with no agent.
 * isSupported() returns false and checkCommitted() returns a denial.
 * Replace with a configured instance when connecting to a governance agent.
 */
export const defaultGovernanceAdapter = new GovernanceAdapter();
