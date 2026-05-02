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
import type {
  Format,
  FormatReferenceStructuredObject,
  PropertyList,
  CollectionList,
} from '../../types/tools.generated';
import type { TaskHandoff, TaskHandoffContext } from './async-outcome';
import type { CtxMetadataRef, ResourceKind } from '../ctx-metadata';
import type { BuyerAgent } from './buyer-agent';

// Unconstrained `TAccount` (no `extends Account`) so adopters with metadata
// types that don't extend `Record<string, unknown>` (interfaces without index
// signatures, type aliases pointing to unions, etc.) can still parameterize.
// The framework only ever passes the resolved `Account<TCtxMeta>` here; constraint
// is implicit through the generic flow from `DecisioningPlatform<_, TCtxMeta>`.
export interface RequestContext<TAccount = Account> {
  /** Resolved account for this request. */
  account: TAccount;

  /**
   * Resolved buyer agent for this request, when an `agentRegistry` is
   * configured on the platform (Phase 1 of #1269). Carries the durable
   * commercial relationship — status, billing capabilities, default
   * account terms — distinct from the per-request credential. Undefined
   * when no registry is configured OR when the registry returned null
   * for the request's credential. Phase 2 (#1292) wires framework-level
   * billing-capability enforcement to the AdCP-3.1 error codes.
   */
  agent?: BuyerAgent;

  /** Sync reads of in-flight state. */
  state: WorkflowStateReader;

  /** Async framework-mediated resolvers. */
  resolve: ResourceResolver;

  /**
   * Ctx-metadata accessor — opaque-blob round-trip cache for adapter-internal
   * state (GAM `ad_unit_ids` per product, `gam_order_id` per media buy, etc.).
   *
   * **Present only when `createAdcpServerFromPlatform({ ctxMetadata })` was
   * wired with a `CtxMetadataStore`.** Adopters who don't wire a store see
   * `undefined` here — branch defensively.
   *
   * The accessor is account-scoped automatically (uses `ctx.account.id` as
   * the tenant boundary). Pass `kind + id`, get an opaque blob the publisher
   * stashed during a prior call's response. Returns `undefined` on miss —
   * fall through to your own DB.
   *
   * @example Read a product's ctx_metadata in createMediaBuy
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   for (const pkg of req.packages) {
   *     const meta = await ctx.ctxMetadata?.product(pkg.product_id);
   *     if (meta?.gam?.ad_unit_ids) {
   *       await this.gam.createLineItem(pkg, meta.gam.ad_unit_ids);
   *     }
   *   }
   * }
   * ```
   *
   * @example Persist platform IDs from createMediaBuy
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   const order = await this.gam.createOrder(req);
   *   await ctx.ctxMetadata?.set('media_buy', order.id, { gam_order_id: order.id });
   *   for (const li of order.lineItems) {
   *     await ctx.ctxMetadata?.set('package', li.id, { gam_line_item_id: li.id });
   *   }
   *   return { media_buy_id: order.id, status: 'pending_creatives', packages: ... };
   * }
   * ```
   *
   * @public
   */
  ctxMetadata?: CtxMetadataAccessor;

  /**
   * Hand off the call to a background task. Returns a `TaskHandoff<T>`
   * marker — return that from your method to signal the framework should
   * project the spec-defined `Submitted` envelope to the buyer and run
   * `fn` asynchronously. `fn` receives a `TaskHandoffContext` with the
   * framework-issued `id` plus `update`/`heartbeat` affordances; its
   * return value becomes the task's terminal artifact.
   *
   * Use this for hybrid sellers — the same tool serves both fast
   * (programmatic remnant, instant `media_buy_id`) and slow (guaranteed
   * inventory, trafficker review) inventory. Branch in your method body
   * on whatever signal determines the path (product type, buyer
   * pre-approval, etc.). Buyers pattern-match on the wire response shape
   * (`media_buy_id` → sync; `task_id` → submitted) — predictable per
   * request, dynamic per call.
   *
   * @example
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   if (this.requiresHITL(req)) {
   *     return ctx.handoffToTask(async (taskCtx) => {
   *       await taskCtx.update({ message: 'Awaiting trafficker' });
   *       return await this.runHITL(req);
   *     });
   *   }
   *   return await this.commitSync(req);
   * }
   * ```
   */
  handoffToTask<TResult>(fn: (taskCtx: TaskHandoffContext) => Promise<TResult>): TaskHandoff<TResult>;
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
  creativeFormat(formatId: FormatReferenceStructuredObject): Promise<Format>;
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

// ---------------------------------------------------------------------------
// Ctx-metadata accessor (6.1)
// ---------------------------------------------------------------------------

/**
 * Account-scoped ctx-metadata accessor. The framework binds this to the
 * resolved `ctx.account.id` per request — adopters never pass account.
 *
 * Generic `get`/`set`/`bulkGet` carry a `ResourceKind` discriminator;
 * per-kind shorthand methods (`product(id)`, `mediaBuy(id)`, etc.) map to
 * `get(kind, id)` for ergonomic call sites.
 */
export interface CtxMetadataAccessor {
  /** Look up by kind + id. Returns `undefined` on miss. */
  get(kind: ResourceKind, id: string): Promise<unknown | undefined>;
  /** Bulk lookup. Result Map keyed by `${kind}:${id}`. Misses absent from Map. */
  bulkGet(refs: readonly CtxMetadataRef[]): Promise<ReadonlyMap<string, unknown>>;
  /**
   * Persist a blob under (account, kind, id). Throws `CTX_METADATA_TOO_LARGE`
   * if serialized size exceeds the configured cap (16KB default).
   */
  set(kind: ResourceKind, id: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** Delete a single entry. */
  delete(kind: ResourceKind, id: string): Promise<void>;

  // Per-kind shorthand readers — purely ergonomic; map to `get(kind, id)`.
  // Note: ctx.account.ctx_metadata is the canonical reader for the current
  // request's account — `account(id)` here is for the rare cross-account
  // lookup case (e.g., listing context for an account other than ctx.account).
  account(id: string): Promise<unknown | undefined>;
  product(id: string): Promise<unknown | undefined>;
  mediaBuy(id: string): Promise<unknown | undefined>;
  package(id: string): Promise<unknown | undefined>;
  creative(id: string): Promise<unknown | undefined>;
  audience(id: string): Promise<unknown | undefined>;
  signal(id: string): Promise<unknown | undefined>;
}
