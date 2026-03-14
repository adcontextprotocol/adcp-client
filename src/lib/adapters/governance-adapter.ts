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
  /** Buyer's campaign reference */
  buyerCampaignRef: string;
  /** The seller's media buy ID */
  mediaBuyId: string;
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

/**
 * Check if a response is a governance adapter error.
 */
export function isGovernanceAdapterError(response: any): boolean {
  return response?.error?.code && Object.values(GovernanceAdapterErrorCodes).includes(response.error.code);
}

/**
 * Default governance adapter that calls a governance agent via AdCP protocol.
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
        buyer_campaign_ref: request.buyerCampaignRef,
        explanation: 'Governance not configured on this server',
      };
    }

    const checkRequest: CheckGovernanceRequest = {
      plan_id: request.planId,
      buyer_campaign_ref: request.buyerCampaignRef,
      binding: 'committed',
      caller: this.agentConfig.callerUrl,
      media_buy_id: request.mediaBuyId,
      planned_delivery: request.plannedDelivery,
      phase: request.phase,
      delivery_metrics: request.deliveryMetrics,
      modification_summary: request.modificationSummary,
    };

    const response = await ProtocolClient.callTool(
      this.agentConfig.agent,
      'check_governance',
      checkRequest as unknown as Record<string, unknown>,
    );

    return response?.structuredContent ?? response?.result ?? response;
  }
}

/** Default (unconfigured) governance adapter instance */
export const defaultGovernanceAdapter = new GovernanceAdapter();
