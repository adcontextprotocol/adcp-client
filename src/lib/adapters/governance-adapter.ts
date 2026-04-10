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

/**
 * Configuration for the seller-side governance adapter.
 */
export interface GovernanceAdapterConfig {
  /** The governance agent to call for committed checks */
  agent: AgentConfig;
  /** The seller's caller URL for governance checks */
  callerUrl: string;
}

/**
 * Committed governance check request from the seller's perspective.
 */
export interface CommittedCheckRequest {
  /** Campaign governance plan ID */
  planId: string;
  /** The seller's media buy ID */
  mediaBuyId: string;
  /** Opaque governance context from the buyer's protocol envelope. Pass through verbatim. */
  governanceContext?: string;
  /** What the seller will actually deliver */
  plannedDelivery: PlannedDelivery;
  /** Lifecycle phase of the check */
  phase?: GovernancePhase;
  /** Delivery metrics for delivery-phase checks */
  deliveryMetrics?: CheckGovernanceRequest['delivery_metrics'];
  /** Summary of changes for modification-phase checks */
  modificationSummary?: string;
}

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

/**
 * Type guard: check if a response is a governance adapter error.
 */
export function isGovernanceAdapterError(
  response: unknown
): response is { error: { code: GovernanceAdapterErrorCode; message?: string } } {
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
      return {
        check_id: '',
        status: 'denied',
        binding: 'committed',
        plan_id: request.planId,
        explanation: 'Governance not configured on this server',
        error_code: GovernanceAdapterErrorCodes.NOT_SUPPORTED,
      } as CheckGovernanceResponse;
    }

    const checkRequest: CheckGovernanceRequest = {
      plan_id: request.planId,
      caller: this.agentConfig.callerUrl,
      governance_context: request.governanceContext,
      planned_delivery: request.plannedDelivery,
      phase: request.phase,
      delivery_metrics: request.deliveryMetrics,
      ...(request.mediaBuyId && { payload: { media_buy_id: request.mediaBuyId } }),
      ...(request.modificationSummary && { payload: { modification_summary: request.modificationSummary } }),
    };

    try {
      const response = await ProtocolClient.callTool(
        this.agentConfig.agent,
        'check_governance',
        checkRequest as Record<string, any>
      );

      return unwrapProtocolResponse(response) as unknown as CheckGovernanceResponse;
    } catch (err) {
      return {
        check_id: '',
        status: 'denied',
        binding: 'committed',
        plan_id: request.planId,
        explanation: `Governance agent unreachable: ${(err as Error).message}`,
        error_code: GovernanceAdapterErrorCodes.AGENT_UNREACHABLE,
      } as CheckGovernanceResponse;
    }
  }
}

/**
 * Pre-configured governance adapter with no agent.
 * isSupported() returns false and checkCommitted() returns a denial.
 * Replace with a configured instance when connecting to a governance agent.
 */
export const defaultGovernanceAdapter = new GovernanceAdapter();
