/**
 * RequestContext — what the framework passes to every decision-point method.
 *
 *   - `account` — resolved tenant for this request (from `accounts.resolve()`)
 *   - `state.*` — sync state reads (workflow steps, governance context, proposal lookups)
 *   - `resolve.*` — async framework-mediated fetches (property lists, formats)
 *
 * Async patterns:
 *   - **Sync**: adopter implements `xxx(req, ctx) => Promise<T>`. Framework
 *     awaits in foreground; projects to wire success arm.
 *   - **HITL**: adopter implements `xxxTask(taskId, req, ctx) => Promise<T>`.
 *     Framework returns submitted envelope to buyer first, then runs the
 *     task method in background; return value becomes terminal task state.
 *   - **Status changes**: adopter calls `publishStatusChange(...)` (event bus)
 *     from anywhere — webhook handler, cron, in-process worker. Framework
 *     records the change and projects to subscribers / per-resource reads.
 *
 * Platform reads only; framework writes only. Adopters never mutate the context.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from './account';
import type { Format, FormatID, PropertyList, CollectionList } from '../../types/tools.generated';

export interface RequestContext<TAccount extends Account = Account> {
  /** Resolved account for this request. */
  account: TAccount;

  /** Sync reads of in-flight state. */
  state: WorkflowStateReader;

  /** Async framework-mediated resolvers. */
  resolve: ResourceResolver;
}

// ---------------------------------------------------------------------------
// State (sync) — what the framework knows about this request and prior steps
// ---------------------------------------------------------------------------

export interface WorkflowStateReader {
  /**
   * Workflow steps that touched a given object. Object types: 'media_buy',
   * 'creative', 'product', 'plan', 'audience', 'rights_grant', 'task'.
   * Returns chronological steps. Used for "what's happened to this buy?"
   * queries without re-fetching from the platform.
   */
  findByObject(type: WorkflowObjectType, id: string): readonly WorkflowStep[];

  /**
   * Resolve a proposal_id to its proposal context. Threaded by the framework
   * across get_products → refine → create_media_buy without platform code.
   * Returns null if the framework doesn't recognize the id.
   */
  findProposalById(proposalId: string): Proposal | null;

  /**
   * Currently in-flight verified governance context for the call. Returns
   * the JWS string for downstream checks (or null for non-governance flows).
   * Framework verifies signature, plan-binding, seller-binding, and
   * phase-binding before exposing — platform can trust the value.
   */
  governanceContext(): GovernanceContextJWS | null;

  /** Chronological steps for this request's account. Useful for audit reads. */
  workflowSteps(): readonly WorkflowStep[];
}

// ---------------------------------------------------------------------------
// Resolve (async) — framework-mediated fetches with cache + validation
// ---------------------------------------------------------------------------

export interface ResourceResolver {
  /**
   * Fetch a property list by id. Framework validates the id exists in the
   * seller's declared lists before returning; consumers can trust the result.
   */
  propertyList(listId: string): Promise<PropertyList>;

  /** Same for collection lists. */
  collectionList(listId: string): Promise<CollectionList>;

  /**
   * Fetch a creative format definition. Framework routes through the
   * `capabilities.creative_agents` declaration with a 1h cache; self-hosted
   * formats hit the local CreativePlatform.listFormats(). Returns the
   * resolved Format with full asset slot definitions.
   */
  creativeFormat(formatId: FormatID): Promise<Format>;
}

// ---------------------------------------------------------------------------
// Workflow object model
// ---------------------------------------------------------------------------

export type WorkflowObjectType = 'media_buy' | 'creative' | 'product' | 'plan' | 'audience' | 'rights_grant' | 'task';

export interface WorkflowStep {
  /** Stable step identifier. */
  id: string;
  /** Object that this step touched. */
  object: { type: WorkflowObjectType; id: string };
  /** Tool that was called (wire verb). */
  tool: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Caller principal. */
  actor: { agent_url?: string; principal?: string };
  /** Outcome: 'submitted' / 'completed' / 'failed' / 'progress'. */
  status: 'submitted' | 'completed' | 'failed' | 'progress';
}

export interface Proposal {
  proposal_id: string;
  /** Products in this proposal. */
  product_ids: string[];
  /** When the proposal was generated. */
  issued_at: string;
  /** When the proposal expires. */
  expires_at?: string;
  /** Account this proposal was issued to. */
  account_id: string;
}

/**
 * JWS-signed governance context. The framework returns the verified token;
 * platform can re-pass to downstream calls (e.g., report_usage) and the
 * framework will validate consistency. Don't unwrap or modify.
 */
export type GovernanceContextJWS = string;
