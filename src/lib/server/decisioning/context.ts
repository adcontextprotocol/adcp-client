/**
 * RequestContext — what the framework passes to every decision-point method.
 *
 * Split into two namespaces by semantics:
 *   - ctx.state.*   — sync state reads of what the framework knows about
 *                      this in-flight request and prior workflow steps
 *   - ctx.resolve.* — async resolvers for framework-mediated lookups
 *                      (property lists, collection lists, creative formats)
 *
 * Platform reads only; framework writes only. Adopters never mutate the
 * context.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from './account';
import type { Format, FormatID, PropertyList, CollectionList } from '../../types/tools.generated';
import type { TaskHandle } from './async-outcome';

export interface RequestContext<TAccount extends Account = Account> {
  /** Resolved account for this request. */
  account: TAccount;

  /** Sync reads of in-flight state. */
  state: WorkflowStateReader;

  /** Async framework-mediated resolvers. */
  resolve: ResourceResolver;

  /**
   * Start a framework-managed async task explicitly. Use when async
   * completion happens out-of-process (operator webhook arrives later,
   * possibly in a different request lifecycle): persist the returned
   * `taskHandle.taskId` somewhere durable; the webhook handler later
   * calls `taskHandle.notify(update)` (or `server.completeTask(taskId, ...)`)
   * to push terminal state.
   *
   * For in-process async work — "I'm awaiting a long-running operation
   * inside this request" — use {@link runAsync} instead. It races the
   * work against a configurable timeout, returns the resolved value if
   * fast enough, and projects to the submitted wire envelope (with
   * background completion via the registry) if slow.
   */
  startTask<TResult>(opts?: { partialResult?: TResult }): TaskHandle<TResult>;

  /**
   * Run an in-process async function with auto-defer semantics. The
   * framework races `fn()` against a configurable timeout (default
   * `submittedAfterMs`):
   *
   *   - If `fn()` resolves before the timeout: `runAsync` resolves with
   *     the value; the adopter just returns it normally and the wire
   *     response is the sync success arm.
   *   - If the timeout fires first: `runAsync` throws an internal sentinel
   *     the runtime catches and projects to the submitted wire envelope
   *     (with `task_id`, `message`, and `partial_result`). The original
   *     `fn()` promise keeps running in the background; on resolve the
   *     framework calls `handle.notify({ kind: 'completed', result })`,
   *     on throw it calls `handle.notify({ kind: 'failed', error })` —
   *     `AdcpError` instances project to structured rejection, generic
   *     errors to `SERVICE_UNAVAILABLE`.
   *
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   if (this.requiresApproval(req)) {
   *     return await ctx.runAsync(
   *       { message: 'Awaiting approval', partialResult: this.toPendingBuy(req) },
   *       async () => this.waitForOperatorApproval(req)
   *     );
   *   }
   *   return await this.platform.create(req);
   * };
   * ```
   *
   * Hard cap: the framework cancels in-process await at `maxAutoAwaitMs`
   * (default 10min). After that, the task record stays `submitted` and
   * the adopter must push completion via webhook handler + `notify` from
   * out of process. Long-running work belongs on `startTask`, not
   * `runAsync`.
   */
  runAsync<TResult>(
    opts: { message?: string; partialResult?: TResult; submittedAfterMs?: number; maxAutoAwaitMs?: number },
    fn: () => Promise<TResult>
  ): Promise<TResult>;
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
   * Returns null if the framework doesn't recognize the id (typically because
   * it expired or was never issued by this agent).
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
