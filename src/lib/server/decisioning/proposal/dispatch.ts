/**
 * Proposal-dispatch — the v1.5 framework intercept seams.
 *
 * Pure functions that the runtime calls from the wire-handler shims
 * (`getProducts`, `createMediaBuy`, `updateMediaBuy`,
 * `getMediaBuyDelivery`). Each helper short-circuits when no manager /
 * store is wired for the request, so the v1 path is preserved
 * byte-for-byte.
 *
 * Five integration points (parity with `adcp-client-python.src/adcp/decisioning/proposal_dispatch.py`):
 *
 *   - {@link maybeInterceptFinalize} — `getProducts` shim. Detects
 *     `refine[i].action: 'finalize'`, calls the manager's
 *     `finalizeProposal`, commits the proposal, returns the wire
 *     response. Returns `null` when no finalize entry / no
 *     finalize-capable manager.
 *   - {@link maybePersistDraftAfterGetProducts} — `getProducts` shim
 *     (post-call). Walks the response's `proposals[]`, validates
 *     `overlap ⊆ wire`, persists each as a draft.
 *   - {@link maybeReserveProposalForCreateMediaBuy} — `createMediaBuy`
 *     shim. When `proposal_id` is set, validates expiry + capability
 *     overlap, reserves the proposal (`COMMITTED → CONSUMING`), returns
 *     the recipes map for `ctx.recipes` hydration.
 *   - {@link finalizeProposalConsumption} — `createMediaBuy` shim
 *     (post-success). Promotes `CONSUMING → CONSUMED` and records the
 *     `mediaBuyId` back-reference.
 *   - {@link releaseProposalReservation} — `createMediaBuy` shim
 *     (failure rollback). Restores `CONSUMING → COMMITTED`.
 *   - {@link maybeHydrateRecipesForMediaBuyId} —
 *     `updateMediaBuy` / `getMediaBuyDelivery` shims. Reverse-index
 *     hydration via `getByMediaBuyId`. Re-runs capability-overlap
 *     validation per Resolutions §5.
 *
 * @public
 * @packageDocumentation
 */

import { AdcpError, isTaskHandoff, type TaskHandoff } from '../async-outcome';
import type { GetProductsRequest, Product, Proposal } from '../../../types/tools.generated';
import {
  detectFinalizeAction,
  enforceProposalExpiry,
  logConsumed,
  logDraftPersisted,
  logFinalizeSucceeded,
  validateCapabilityOverlap,
  validateOverlapSubsetOfWire,
} from './lifecycle';
import type { ProposalRecord, ProposalStore } from './store';
import type {
  FinalizeProposalRequest,
  FinalizeProposalSuccess,
  ProposalGetProductsPayload,
  ProposalManager,
  Recipe,
} from './types';

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/**
 * Per Resolutions §7: framework detects finalize via method-presence +
 * `capabilities.finalize` flag. Adopters opt in by both implementing
 * AND declaring; flipping only one half is an adopter bug.
 */
function hasFinalizeCapability<TRecipe extends Recipe, TCtxMeta>(
  manager: ProposalManager<TRecipe, TCtxMeta> | undefined
): boolean {
  if (!manager) return false;
  if (!manager.capabilities.finalize) return false;
  return typeof manager.finalizeProposal === 'function';
}

// ---------------------------------------------------------------------------
// getProducts — finalize interception
// ---------------------------------------------------------------------------

/**
 * Result of {@link maybeInterceptFinalize}.
 *
 *   - `kind: 'intercepted'` — adopter's `finalizeProposal` was called.
 *     Caller threads `result` and `project` through the framework's
 *     standard `routeIfHandoff` so the projection callback fires
 *     synchronously for sync `FinalizeProposalSuccess` returns AND
 *     inside the background task for `TaskHandoff<FinalizeProposalSuccess>`
 *     returns. The projection commits the proposal store, emits the
 *     `proposal.finalized` log, and shapes the wire response.
 *   - `kind: 'pass'` — no finalize entry / no finalize-capable manager;
 *     caller continues with the standard `getProducts` dispatch.
 *
 * No special-case handling: finalize HITL inherits the framework's
 * task-lifecycle posture (cancellation, restart-via-durable-store,
 * deadline, webhook delivery) from `routeIfHandoff`, the same machinery
 * that drives `createMediaBuy` HITL and `syncCreatives` HITL.
 *
 * @public
 */
export type FinalizeInterceptResult<TRecipe extends Recipe = Recipe> =
  | {
      kind: 'intercepted';
      result: FinalizeProposalSuccess<TRecipe> | TaskHandoff<FinalizeProposalSuccess<TRecipe>>;
      project: (success: FinalizeProposalSuccess<TRecipe>) => Promise<ProposalGetProductsPayload>;
    }
  | { kind: 'pass' };

/**
 * Intercept `buying_mode: 'refine'` requests carrying a
 * `refine[i].action: 'finalize'` entry. Hydrates the draft, calls the
 * manager's `finalizeProposal`, and returns the raw adopter result + a
 * projection callback. The runtime threads them through the framework's
 * standard `routeIfHandoff` so:
 *
 *   - Sync `FinalizeProposalSuccess` returns: projection runs inline,
 *     buyer sees the committed proposal in the response.
 *   - HITL `TaskHandoff<FinalizeProposalSuccess>` returns: framework
 *     returns the Submitted envelope to the buyer, runs the adopter's
 *     handoff fn in background; projection runs when the handoff
 *     resolves, commits the proposal, projects the terminal task
 *     artifact.
 *
 * Same machinery as `createMediaBuy` HITL — finalize inherits whatever
 * cancellation, restart-via-durable-store, deadline, and webhook
 * delivery semantics the framework's task lifecycle provides for every
 * other unified-hybrid tool. No special-case wrapper.
 *
 * @public
 */
export async function maybeInterceptFinalize<TRecipe extends Recipe, TCtxMeta>(args: {
  request: GetProductsRequest;
  manager: ProposalManager<TRecipe, TCtxMeta> | undefined;
  store: ProposalStore<TRecipe> | undefined;
  ctx: { account: { id: string } } & Record<string, unknown>;
}): Promise<FinalizeInterceptResult<TRecipe>> {
  const { request, manager, store, ctx } = args;
  const finalizeEntry = detectFinalizeAction(request);
  if (!finalizeEntry) return { kind: 'pass' };
  if (!hasFinalizeCapability(manager) || !store) return { kind: 'pass' };

  const fieldPath = `refine[${finalizeEntry.index}].proposal_id`;
  const accountId = ctx.account.id;
  const record = await store.get(finalizeEntry.proposalId, { expectedAccountId: accountId });
  if (!record) {
    throw new AdcpError('PROPOSAL_NOT_FOUND', {
      recovery: 'terminal',
      message:
        `Proposal ${JSON.stringify(finalizeEntry.proposalId)} not found. The buyer must call ` +
        `get_products with buying_mode='brief' or 'refine' to obtain a draft proposal_id ` +
        `before finalizing it.`,
      field: fieldPath,
    });
  }
  if (record.state !== 'draft') {
    throw new AdcpError('PROPOSAL_NOT_COMMITTED', {
      recovery: 'correctable',
      message:
        `Proposal ${JSON.stringify(finalizeEntry.proposalId)} is in state ` +
        `${JSON.stringify(record.state)}; only draft proposals can be finalized. ` +
        `Already-committed proposals should be accepted via create_media_buy(proposal_id=...) ` +
        `directly.`,
      field: fieldPath,
    });
  }

  const finalizeReq: FinalizeProposalRequest<TRecipe> = {
    proposalId: finalizeEntry.proposalId,
    recipes: record.recipes,
    proposalPayload: record.proposalPayload,
    parentRequest: request,
    ...(finalizeEntry.ask !== undefined && { ask: finalizeEntry.ask }),
  };

  // manager + finalizeProposal are non-undefined per hasFinalizeCapability.
  const result = await manager!.finalizeProposal!(finalizeReq, ctx as never);
  // Pre-determine the path label by checking whether the adopter
  // returned a TaskHandoff up-front. `routeIfHandoff` runs `project`
  // synchronously for the sync arm and inside the background task for
  // the handoff arm; either way, we want the log to reflect which arm
  // the adopter chose.
  const path: 'inline' | 'handoff' = isTaskHandoff(result) ? 'handoff' : 'inline';
  const finalizeProposalId = finalizeEntry.proposalId;

  const project = async (success: FinalizeProposalSuccess<TRecipe>): Promise<ProposalGetProductsPayload> => {
    if (!isFinalizeSuccess<TRecipe>(success)) {
      throw new AdcpError('INTERNAL_ERROR', {
        recovery: 'terminal',
        message:
          `finalizeProposal resolved to an unexpected shape; expected FinalizeProposalSuccess ` +
          `with 'proposal' and 'expiresAt' fields.`,
      });
    }
    await store.commit(finalizeProposalId, {
      expiresAt: success.expiresAt,
      proposalPayload: success.proposal,
    });
    logFinalizeSucceeded({
      proposalId: finalizeProposalId,
      accountId,
      expiresAt: success.expiresAt,
      path,
    });
    return projectFinalizeResponse({
      request,
      committedProposal: success.proposal,
      finalizeProposalId,
    });
  };

  return { kind: 'intercepted', result, project };
}

function isFinalizeSuccess<TRecipe extends Recipe>(v: unknown): v is FinalizeProposalSuccess<TRecipe> {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.proposal != null && r.expiresAt instanceof Date;
}

function projectFinalizeResponse(args: {
  request: GetProductsRequest;
  committedProposal: Record<string, unknown>;
  finalizeProposalId: string;
}): ProposalGetProductsPayload {
  const refineEntries = (args.request as { refine?: ReadonlyArray<Record<string, unknown>> }).refine;
  const refinementApplied: Array<Record<string, unknown>> = [];
  if (refineEntries) {
    for (const entry of refineEntries) {
      const scope = entry.scope;
      if (scope === 'proposal') {
        refinementApplied.push({
          scope: 'proposal',
          proposal_id: typeof entry.proposal_id === 'string' ? entry.proposal_id : args.finalizeProposalId,
          status: 'applied',
        });
      } else if (scope === 'product') {
        refinementApplied.push({
          scope: 'product',
          product_id: typeof entry.product_id === 'string' ? entry.product_id : '',
          status: 'applied',
        });
      } else {
        refinementApplied.push({ scope: 'request', status: 'applied' });
      }
    }
  }
  // **Decision: `products: []` on the finalize response by design.** The
  // committed proposal carries `allocations[]` keyed by `product_id`;
  // the buyer either has the products from the prior `brief_with_proposals`
  // step (the natural flow) or fetches by id. Echoing the products here
  // would require the framework to either re-emit from the persisted
  // draft (extra wire bytes the buyer already has) or call back into the
  // adopter (extra round-trip to upstream). Buyers who explicitly want
  // products on the finalize response can fetch them via a follow-up
  // `get_products({ product_ids: [...] })` keyed off
  // `proposals[0].allocations[].product_id`.
  return {
    cache_scope: 'account',
    products: [],
    proposals: [args.committedProposal as unknown as Proposal],
    refinement_applied: refinementApplied,
  } as unknown as ProposalGetProductsPayload;
}

// ---------------------------------------------------------------------------
// getProducts / refineProducts — post-call draft persistence
// ---------------------------------------------------------------------------

/**
 * Persist proposals returned by `getProducts` / `refineProducts` as
 * drafts in the wired {@link ProposalStore}. Validates `overlap ⊆ wire`
 * for any returned recipes before persisting.
 *
 * Quietly returns when no store is wired, no `proposals[]` in the
 * response, or no typed recipes attached to products.
 *
 * @public
 */
export async function maybePersistDraftAfterGetProducts<TRecipe extends Recipe>(args: {
  response: ProposalGetProductsPayload;
  store: ProposalStore<TRecipe> | undefined;
  ctx: { account: { id: string } };
}): Promise<void> {
  const { response, store, ctx } = args;
  if (!store) return;
  const proposals = (response as { proposals?: ReadonlyArray<Proposal> }).proposals;
  if (!proposals || proposals.length === 0) return;
  const products = (response as { products?: ReadonlyArray<Product> }).products ?? [];

  for (const proposal of proposals) {
    const proposalId = (proposal as { proposal_id?: string }).proposal_id;
    if (!proposalId) continue;
    const proposalPayload = toPlainObject(proposal);
    const recipes = collectRecipesFromProducts<TRecipe>(products, proposalPayload);
    if (recipes.size > 0) {
      validateOverlapSubsetOfWire({ recipes, products });
    }
    await store.putDraft({
      proposalId,
      accountId: ctx.account.id,
      recipes,
      proposalPayload,
    });
    logDraftPersisted({
      proposalId,
      accountId: ctx.account.id,
      recipesCount: recipes.size,
    });
  }
}

function collectRecipesFromProducts<TRecipe extends Recipe>(
  products: readonly Product[],
  proposalPayload: Record<string, unknown>
): Map<string, TRecipe> {
  // Filter to products referenced by the proposal's allocations[] (per
  // spec) or legacy products[] string array when present.
  let referenced: Set<string> | null = null;
  const allocations = proposalPayload.allocations;
  if (Array.isArray(allocations)) {
    referenced = new Set(
      allocations
        .map((a: unknown) => (a as { product_id?: string }).product_id)
        .filter((id): id is string => typeof id === 'string')
    );
  } else if (Array.isArray(proposalPayload.products)) {
    referenced = new Set((proposalPayload.products as unknown[]).filter((p): p is string => typeof p === 'string'));
  }

  const recipes = new Map<string, TRecipe>();
  for (const product of products) {
    const productId = product.product_id;
    if (!productId) continue;
    if (referenced && !referenced.has(productId)) continue;
    const implConfig = (product as { implementation_config?: unknown }).implementation_config;
    if (isRecipe(implConfig)) {
      recipes.set(productId, implConfig as TRecipe);
    }
  }
  return recipes;
}

function isRecipe(v: unknown): boolean {
  return v != null && typeof v === 'object' && typeof (v as { recipe_kind?: unknown }).recipe_kind === 'string';
}

function toPlainObject(v: unknown): Record<string, unknown> {
  if (v == null || typeof v !== 'object') return {};
  // Deep clone via JSON to drop class-instance prototypes — the stored
  // payload must round-trip through a durable backing.
  return JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// createMediaBuy — recipe hydration on proposal_id
// ---------------------------------------------------------------------------

/**
 * Result of {@link maybeReserveProposalForCreateMediaBuy}.
 *
 *   - `record` — the reserved {@link ProposalRecord}. Caller threads
 *     `recipes` onto `ctx.recipes` and calls
 *     {@link finalizeProposalConsumption} on adapter success or
 *     {@link releaseProposalReservation} on failure.
 *   - `null` — request has no `proposal_id`, no store wired, or the
 *     framework didn't intercept (v1 path).
 *
 * @public
 */
export type ReservedProposal<TRecipe extends Recipe> = ProposalRecord<TRecipe>;

/**
 * Reserve the proposal for consumption and hydrate `ctx.recipes`.
 *
 * Atomic CAS via {@link ProposalStore.tryReserveConsumption} — the
 * proposal transitions `COMMITTED → CONSUMING` before the adapter runs.
 * Two parallel `createMediaBuy(proposal_id=X)` calls cannot both
 * reserve; the loser raises `PROPOSAL_NOT_COMMITTED`.
 *
 * Validates per § D7 (expiry) BEFORE reserving — an expired proposal
 * surfaces `PROPOSAL_EXPIRED` without flipping the state.
 *
 * @public
 */
export async function maybeReserveProposalForCreateMediaBuy<TRecipe extends Recipe, TCtxMeta>(args: {
  request: { proposal_id?: string; packages?: ReadonlyArray<unknown> } & Record<string, unknown>;
  manager: ProposalManager<TRecipe, TCtxMeta> | undefined;
  store: ProposalStore<TRecipe> | undefined;
  ctx: { account: { id: string } };
  now?: Date;
}): Promise<ReservedProposal<TRecipe> | null> {
  const { request, manager, store, ctx, now } = args;
  const proposalId = request.proposal_id;
  if (!proposalId || !store) return null;
  const graceSeconds = manager?.capabilities.expiresAtGraceSeconds ?? 0;

  // Expiry check BEFORE reserving — keep the buyer's slot uncommitted
  // when telling them they're expired.
  await enforceProposalExpiry(proposalId, {
    proposalStore: store,
    expectedAccountId: ctx.account.id,
    graceSeconds,
    ...(now && { now }),
  });

  const reserved = await store.tryReserveConsumption(proposalId, {
    expectedAccountId: ctx.account.id,
  });

  // Capability-overlap gate per D4. Buyer's packages may be empty when
  // proposal_id is set (the spec allows the seller to derive packages
  // from allocations); skip the gate in that case.
  const packages = request.packages;
  if (packages && Array.isArray(packages) && packages.length > 0) {
    validateCapabilityOverlap({
      packages: packages as never,
      recipes: reserved.recipes,
    });
  }

  return reserved;
}

/**
 * Promote `CONSUMING → CONSUMED` after the adapter's `createMediaBuy`
 * succeeded.
 *
 * @public
 */
export async function finalizeProposalConsumption<TRecipe extends Recipe>(args: {
  store: ProposalStore<TRecipe> | undefined;
  record: ReservedProposal<TRecipe>;
  mediaBuyId: string;
}): Promise<void> {
  const { store, record, mediaBuyId } = args;
  if (!store) return;
  await store.finalizeConsumption(record.proposalId, {
    mediaBuyId,
    expectedAccountId: record.accountId,
  });
  logConsumed({
    proposalId: record.proposalId,
    accountId: record.accountId,
    mediaBuyId,
  });
}

/**
 * Roll back the reservation: `CONSUMING → COMMITTED`. Best-effort.
 *
 * @public
 */
export async function releaseProposalReservation<TRecipe extends Recipe>(args: {
  store: ProposalStore<TRecipe> | undefined;
  record: ReservedProposal<TRecipe>;
  logger?: { warn(message: string): void };
}): Promise<void> {
  const { store, record, logger } = args;
  if (!store) return;
  try {
    await store.releaseConsumption(record.proposalId, {
      expectedAccountId: record.accountId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(
      `[adcp/decisioning] failed to release consumption reservation for proposal ` +
        `${record.proposalId}: ${message}. The record may stay in CONSUMING until eviction.`
    );
  }
}

// ---------------------------------------------------------------------------
// updateMediaBuy / getMediaBuyDelivery — reverse-index recipe hydration
// ---------------------------------------------------------------------------

/**
 * Hydrate `ctx.recipes` for post-acceptance buy operations via the
 * `getByMediaBuyId` reverse-index. Returns the record (so the caller
 * can re-validate overlap if a packages-shaped patch is provided);
 * returns `null` when no proposal backs this buy.
 *
 * Per Resolutions §5: re-validates capability overlap on every call
 * with packages.
 *
 * @public
 */
export async function maybeHydrateRecipesForMediaBuyId<TRecipe extends Recipe>(args: {
  mediaBuyId: string | undefined;
  store: ProposalStore<TRecipe> | undefined;
  ctx: { account: { id: string } };
  packages?: ReadonlyArray<unknown>;
}): Promise<ProposalRecord<TRecipe> | null> {
  const { mediaBuyId, store, ctx, packages } = args;
  if (!mediaBuyId || !store) return null;
  const record = await store.getByMediaBuyId(mediaBuyId, {
    expectedAccountId: ctx.account.id,
  });
  if (!record) return null;
  if (packages && Array.isArray(packages) && packages.length > 0) {
    validateCapabilityOverlap({
      packages: packages as never,
      recipes: record.recipes,
    });
  }
  return record;
}
