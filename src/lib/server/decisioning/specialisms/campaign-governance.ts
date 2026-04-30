/**
 * CampaignGovernancePlatform — runtime governance decisioning for advertiser
 * campaigns (v6.0).
 *
 * Today's AdCP 3.0 GA enum splits this role across two specialism values:
 *
 *   - `governance-spend-authority` — agent gates spending decisions
 *   - `governance-delivery-monitor` — agent monitors delivery actuals
 *
 * Both describe one role (a governance agent that makes runtime decisions
 * for advertiser campaigns), differing only by capability. This single
 * interface covers both. When `adcontextprotocol/adcp#3329` lands and the
 * spec consolidates to `campaign-governance`, we rename the type without
 * shape changes.
 *
 * Shape: a decision API. The agent inspects a proposed action (or running
 * delivery) and returns `approved`, `denied`, or `conditions` (approved-if).
 * Status changes (plan moving from `pending_approval` → `active` → `closed`)
 * flow via `publishStatusChange({ resource_type: 'plan', ... })`.
 *
 * Sync at the wire level — `CheckGovernanceResponse` has no `Submitted`
 * arm. Slow approval pipelines (operator review) return current state
 * (e.g., `pending`) and emit status changes when the human decision lands.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  SyncPlansRequest,
  SyncPlansResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
} from '../../../types/tools.generated';

type Ctx<TMeta> = RequestContext<Account<TMeta>>;

export interface CampaignGovernancePlatform<TMeta = Record<string, unknown>> {
  /**
   * Runtime governance decision. Buyer (or seller, on the seller's behalf)
   * sends a proposed action; the agent inspects it against the plan and
   * returns approved / denied / conditions.
   *
   * The `phase` field discriminates the context: `'intent'` (pre-action),
   * `'delivery'` (running campaign with actuals), `'reconciliation'`
   * (post-flight). The agent's logic varies by phase.
   *
   * Throw `AdcpError` for buyer-fixable rejection
   * (`'PLAN_NOT_FOUND'`, `'INVALID_REQUEST'`, etc.). Use the response
   * `status: 'denied'` for governance decisions that ARE the answer
   * (the plan exists and the agent is rejecting the action).
   */
  checkGovernance(req: CheckGovernanceRequest, ctx: Ctx<TMeta>): Promise<CheckGovernanceResponse>;

  /**
   * Plan CRUD. Buyers sync their campaign plans into the governance
   * agent so the agent can maintain spend authority + delivery context.
   */
  syncPlans(req: SyncPlansRequest, ctx: Ctx<TMeta>): Promise<SyncPlansResponse>;

  /**
   * Outcome reporting. Sellers report what actually happened (impressions
   * delivered, spend incurred, status transitions) so the agent can
   * calibrate future decisions.
   */
  reportPlanOutcome(req: ReportPlanOutcomeRequest, ctx: Ctx<TMeta>): Promise<ReportPlanOutcomeResponse>;

  /**
   * Audit log read. Returns the chronological history of governance
   * decisions + outcome reports for a plan.
   */
  getPlanAuditLogs(req: GetPlanAuditLogsRequest, ctx: Ctx<TMeta>): Promise<GetPlanAuditLogsResponse>;
}
