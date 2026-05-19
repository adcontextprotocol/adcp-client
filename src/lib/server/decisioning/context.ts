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
import type { TaskHandoff, TaskHandoffContext, TaskHandoffOptions } from './async-outcome';
import type { CtxMetadataRef, ResourceKind } from '../ctx-metadata';
import type { BuyerAgent } from './buyer-agent';
import type { Recipe } from './proposal';

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
   * Request payload as the platform method sees it. The framework sets
   * this on every v6 platform-method dispatch so methods can read request
   * fields the typed signature doesn't model.
   *
   * **Why it exists.** Several `sync_*` request schemas carry modifier
   * fields (`assignments[]` on `sync_creatives`; `delete_missing`,
   * `dry_run`, `validation_mode` on the same; `delete_missing` on
   * `sync_audiences` and `sync_accounts`) that the platform method's
   * typed signature drops — the framework destructures the payload array
   * and passes only that. Without `ctx.input`, adopters implementing
   * those fields at the wire layer would see them silently disappear on
   * the `/sales/mcp` route while working on `/mcp` — a silent-conformance
   * trap. Read the field from `ctx.input` and the modifier survives to
   * the adapter.
   *
   * **Same reference as the typed payload arg, not a snapshot.** `ctx.input`
   * is set BEFORE the framework's auto-hydrate seams
   * (`hydratePackagesWithProducts`, `hydrateForTool`) run, but those
   * seams mutate the same object in place. By the time the platform
   * method's body executes, `ctx.input` and the first positional arg are
   * the same reference and both reflect framework hydration. Fields the
   * buyer sent are authoritative; framework-injected entities
   * (`pkg.product`, `req.media_buy`) are present too — distinguish by
   * field shape, not by which path you read from.
   *
   * **For methods that hoist a field to a positional arg** (e.g.
   * `updateMediaBuy(media_buy_id, patch, ctx)` hoists `media_buy_id` out
   * of the wire envelope), that field is still present at the top level
   * of `ctx.input`. `ctx.input` is NOT "what the method didn't get" — it
   * is the full envelope, hoist included. Prefer reading any field
   * present on both the positional arg and `ctx.input` from the
   * positional arg; reach for `ctx.input` only for fields the typed
   * signature drops.
   *
   * **Typed as unknown** to match the `comply_test_controller` bridge
   * precedent (`TestControllerBridgeContext.input`) and to avoid coupling
   * adopters to specific schema versions. Cast at the read site:
   *
   * ```ts
   * syncCreatives: async (creatives, ctx) => {
   *   const wire = ctx.input as SyncCreativesRequest;
   *   if (wire.delete_missing) { ... }
   *   for (const assignment of wire.assignments ?? []) { ... }
   * }
   * ```
   *
   * **Security — `ctx.input` is buyer-controlled and may carry secrets.**
   * Mutating-tool envelopes can include `push_notification_config.token`
   * (the buyer's webhook-signature secret); `sync_*` requests can carry
   * `ctx_metadata` blobs the adopter persisted on a prior turn. Do NOT
   * log `ctx.input` wholesale — read named fields. Free-text fields
   * (`brief` on `getProducts`, `message` on `si_send_message`, creative
   * snippets, etc.) are attacker-controlled; when templating into LLM
   * prompts, validate or fence — don't string-interpolate. See
   * `docs/guides/CTX-METADATA-SAFETY.md` for the broader policy on
   * buyer-controlled inputs.
   *
   * **Optional in the type signature** so adopters constructing ad-hoc
   * `RequestContext` for unit tests aren't forced to set it; the
   * framework always sets it on real dispatches.
   *
   * @public
   */
  input?: Readonly<Record<string, unknown>>;

  /**
   * Hydrated typed recipes (`product_id -> Recipe`) for proposal-mode
   * dispatch. Populated by the framework's v1.5 ProposalManager seams:
   *
   *   - `createMediaBuy` with `proposal_id`: framework reserves the
   *     proposal, validates expiry + capability overlap, and writes the
   *     recipe map here BEFORE the adapter runs.
   *   - `updateMediaBuy` / `getMediaBuyDelivery`: framework hydrates
   *     via the `getByMediaBuyId` reverse-index.
   *
   * Adopters read this map to apply per-product internal-config
   * (e.g., `recipe.line_item_template_id` on the matching adapter
   * upstream call). Undefined when no proposal-mode dispatch is wired
   * for the request — the v1 path leaves it untouched.
   *
   * @public
   */
  recipes?: ReadonlyMap<string, Recipe>;

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
   *
   * Pass `options.task_id` when an upstream system or test-controller directive
   * has already issued the task id and the spec contract requires the response
   * to echo it verbatim (e.g. `force_create_media_buy_arm`). The framework uses
   * the supplied id instead of minting a fresh one; `taskCtx.id` reflects it.
   * Constraints: non-empty, ≤ 128 characters. Throws if violated.
   */
  handoffToTask<TResult>(
    fn: (taskCtx: TaskHandoffContext) => Promise<TResult>,
    options?: TaskHandoffOptions
  ): TaskHandoff<TResult>;
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
