/**
 * Proposal-lifecycle framework helpers — the v1.5 intercept seam.
 *
 * Sits parallel to existing dispatch helpers in `runtime/from-platform.ts`.
 * Framework intercepts at a seam, does its work, dispatches.
 *
 * Public surface (the dispatch path imports these):
 *
 *   - {@link enforceProposalExpiry} — D7. Look up the committed proposal,
 *     validate `state === 'committed'` and `now <= expires_at + grace`,
 *     return the record.
 *   - {@link validateCapabilityOverlap} — D4. Walk a buyer's
 *     `create_media_buy` / `update_media_buy` request packages against
 *     each recipe's `capability_overlap` and reject mismatches with
 *     `INVALID_REQUEST`.
 *   - {@link validateOverlapSubsetOfWire} — D4 round-4. Validate at
 *     `putDraft` time that each recipe's `capability_overlap` axis is a
 *     subset of the corresponding wire-declared product capabilities.
 *     Mismatches throw `INTERNAL_ERROR` (adopter bug, not buyer bug).
 *   - {@link detectFinalizeAction} — pull out the first finalize-action
 *     refine entry from a `GetProductsRequest`.
 *   - structured-log helpers per § Observability.
 *
 * Ports `adcp-client-python.src/adcp/decisioning/proposal_lifecycle.py`.
 *
 * @public
 * @packageDocumentation
 */

import { AdcpError } from '../async-outcome';
import type { GetProductsRequest, Product } from '../../../types/tools.generated';
import type { ProposalRecord, ProposalStore } from './store';
import type { Recipe } from './types';

// ---------------------------------------------------------------------------
// D7 — expires_at enforcement
// ---------------------------------------------------------------------------

/**
 * Validate a proposal is committed and within its hold window.
 *
 * Three failure modes mapped to spec error codes:
 *
 *   - Record not found OR cross-tenant → `PROPOSAL_NOT_FOUND` (correctable).
 *     Cross-tenant probes return the same error as missing IDs (no
 *     principal-enumeration via id probing).
 *   - State !== `'committed'` → `PROPOSAL_NOT_COMMITTED` (correctable).
 *     The buyer needs to call `getProducts({ buying_mode: 'refine',
 *     refine: [{ action: 'finalize' }] })` first.
 *   - Committed but `now > expires_at + grace` → `PROPOSAL_EXPIRED`
 *     (correctable per AdCP 3.0.6 — the buyer re-discovers via
 *     `get_products` to obtain a fresh proposal).
 *
 * @public
 */
export async function enforceProposalExpiry<TRecipe extends Recipe>(
  proposalId: string,
  args: {
    proposalStore: ProposalStore<TRecipe>;
    expectedAccountId: string;
    graceSeconds?: number;
    now?: Date;
  }
): Promise<ProposalRecord<TRecipe>> {
  const { proposalStore, expectedAccountId, graceSeconds = 0, now } = args;
  const record = await proposalStore.get(proposalId, { expectedAccountId });
  if (!record) {
    throw new AdcpError('PROPOSAL_NOT_FOUND', {
      recovery: 'correctable',
      message:
        `Proposal ${JSON.stringify(proposalId)} not found. The buyer must call get_products ` +
        `with buying_mode='refine' and refine=[{action:'finalize',...}] to obtain a ` +
        `committed proposal_id before referencing it on create_media_buy.`,
      field: 'proposal_id',
    });
  }
  if (record.state !== 'committed') {
    throw new AdcpError('PROPOSAL_NOT_COMMITTED', {
      recovery: 'correctable',
      message:
        `Proposal ${JSON.stringify(proposalId)} is in state ${JSON.stringify(record.state)}; ` +
        `only committed proposals can be accepted via create_media_buy. Call get_products ` +
        `with buying_mode='refine' and action='finalize' first.`,
      field: 'proposal_id',
    });
  }
  if (record.expiresAt) {
    const current = now ?? new Date();
    const deadline = record.expiresAt.getTime() + graceSeconds * 1000;
    if (current.getTime() > deadline) {
      logExpired({
        proposalId,
        accountId: record.accountId,
        now: current,
        expiresAt: record.expiresAt,
        graceSeconds,
      });
      throw new AdcpError('PROPOSAL_EXPIRED', {
        // Per AdCP 3.0.6 schemas/cache/3.0.6/enums/error-code.json,
        // PROPOSAL_EXPIRED is `correctable` — the buyer re-discovers
        // via `get_products` to obtain a fresh proposal (the hold
        // window has lapsed but the buyer can re-request).
        recovery: 'correctable',
        message:
          `Proposal ${JSON.stringify(proposalId)} expired at ${record.expiresAt.toISOString()}; ` +
          `create_media_buy must be called within the inventory hold window. Call get_products ` +
          `with buying_mode='refine' and action='finalize' to request a fresh hold.`,
        field: 'proposal_id',
      });
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// D4 — capability-overlap validation
// ---------------------------------------------------------------------------

interface PackageLike {
  product_id?: string;
  pricing_option_id?: string;
  pricing_model?: string;
  delivery_type?: string;
  signal_type?: string;
  targeting_overlay?: Record<string, unknown>;
  /**
   * Adopter-resolved pricing model — the validation reads this when
   * present. Set by the framework when it has resolved
   * `pricing_option_id` against the product's pricing options.
   */
  _resolved_pricing_model?: string;
  _resolved_delivery_type?: string;
  [k: string]: unknown;
}

/**
 * Pre-adapter validation seam: walk buyer's packages against each recipe's
 * `capability_overlap` and reject mismatches.
 *
 * Called from the framework's `create_media_buy` and `update_media_buy`
 * dispatch paths after recipes are hydrated from the {@link ProposalStore}.
 * Per D4, the framework owns this gate so every adopter doesn't write the
 * same intersection logic.
 *
 * Validation axes (per {@link CapabilityOverlap}):
 *
 *   - `pricingModels` — checked against `package._resolved_pricing_model`
 *     or `package.pricing_model`.
 *   - `targetingDimensions` — checked against `package.targeting_overlay` keys.
 *   - `deliveryTypes` — checked against `package._resolved_delivery_type`
 *     or `package.delivery_type`.
 *   - `signalTypes` — checked against `package.signal_type`.
 *
 * Per the design's undefined-vs-empty-set semantics: `undefined` skips the
 * gate; an explicit `Set` (including the empty set) is enforced.
 *
 * @public
 */
export function validateCapabilityOverlap<TRecipe extends Recipe>(args: {
  packages: readonly PackageLike[];
  recipes: ReadonlyMap<string, TRecipe>;
  fieldPathPrefix?: string;
}): void {
  const { packages, recipes, fieldPathPrefix = 'packages' } = args;
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i]!;
    const productId = pkg.product_id;
    if (!productId) continue;
    const recipe = recipes.get(productId);
    if (!recipe || !recipe.capability_overlap) continue;
    const overlap = recipe.capability_overlap;

    if (overlap.pricingModels) {
      const requested = pkg._resolved_pricing_model ?? pkg.pricing_model;
      if (requested !== undefined && !overlap.pricingModels.has(String(requested))) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'terminal',
          message:
            `Buyer requested pricing_model=${JSON.stringify(requested)} on package ` +
            `${JSON.stringify(productId)}, but this product's recipe declares ` +
            `capability_overlap.pricingModels=${JSON.stringify([...overlap.pricingModels].sort())}. ` +
            `The seller did not enable that pricing model for this product.`,
          field: `${fieldPathPrefix}[${i}].pricing_option_id`,
        });
      }
    }

    if (overlap.targetingDimensions) {
      const overlay = pkg.targeting_overlay;
      const keys = overlay && typeof overlay === 'object' ? Object.keys(overlay) : [];
      const disallowed = keys.filter(k => !overlap.targetingDimensions!.has(k));
      if (disallowed.length > 0) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'terminal',
          message:
            `Buyer requested targeting dimensions ${JSON.stringify(disallowed.sort())} on ` +
            `package ${JSON.stringify(productId)}, but this product's recipe declares ` +
            `capability_overlap.targetingDimensions=` +
            `${JSON.stringify([...overlap.targetingDimensions].sort())}. The seller did not ` +
            `enable those targeting dimensions for this product.`,
          field: `${fieldPathPrefix}[${i}].targeting_overlay`,
        });
      }
    }

    if (overlap.deliveryTypes) {
      const delivery = pkg._resolved_delivery_type ?? pkg.delivery_type;
      if (delivery !== undefined && !overlap.deliveryTypes.has(String(delivery))) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'terminal',
          message:
            `Buyer requested delivery_type=${JSON.stringify(delivery)} on package ` +
            `${JSON.stringify(productId)}, but this product's recipe declares ` +
            `capability_overlap.deliveryTypes=${JSON.stringify([...overlap.deliveryTypes].sort())}.`,
          field: `${fieldPathPrefix}[${i}].delivery_type`,
        });
      }
    }

    if (overlap.signalTypes) {
      const signalType = pkg.signal_type;
      if (signalType !== undefined && !overlap.signalTypes.has(String(signalType))) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'terminal',
          message:
            `Buyer requested signal_type=${JSON.stringify(signalType)} on package ` +
            `${JSON.stringify(productId)}, but this product's recipe declares ` +
            `capability_overlap.signalTypes=${JSON.stringify([...overlap.signalTypes].sort())}.`,
          field: `${fieldPathPrefix}[${i}].signal_type`,
        });
      }
    }
  }
}

/**
 * Validate `recipe.capability_overlap` is a subset of the matching product's
 * wire-declared capabilities.
 *
 * Called at `putDraft` time. Mismatches throw `INTERNAL_ERROR` — this is
 * an adopter bug (the manager declared an overlap claiming capabilities the
 * wire shape doesn't advertise), not a buyer bug.
 *
 * @public
 */
export function validateOverlapSubsetOfWire<TRecipe extends Recipe>(args: {
  recipes: ReadonlyMap<string, TRecipe>;
  products: readonly Product[];
}): void {
  const productsById = new Map<string, Product>();
  for (const p of args.products) {
    if (p.product_id) productsById.set(p.product_id, p);
  }
  for (const [productId, recipe] of args.recipes) {
    if (!recipe.capability_overlap) continue;
    const product = productsById.get(productId);
    if (!product) continue; // missing-product is caught elsewhere
    const overlap = recipe.capability_overlap;

    if (overlap.pricingModels) {
      const wirePricing = wirePricingModels(product);
      const extras = [...overlap.pricingModels].filter(p => !wirePricing.has(p));
      if (extras.length > 0) {
        throw new AdcpError('INTERNAL_ERROR', {
          recovery: 'terminal',
          message:
            `Recipe for product ${JSON.stringify(productId)} declares ` +
            `capability_overlap.pricingModels=${JSON.stringify([...overlap.pricingModels].sort())} ` +
            `including ${JSON.stringify(extras.sort())}, but the wire product only advertises ` +
            `${JSON.stringify([...wirePricing].sort())}. The recipe's overlap must be a subset ` +
            `of the wire-declared capabilities; adopter declaration is inconsistent with the ` +
            `product shape.`,
        });
      }
    }

    if (overlap.deliveryTypes) {
      const wireDelivery = wireDeliveryTypes(product);
      const extras = [...overlap.deliveryTypes].filter(p => !wireDelivery.has(p));
      // Only enforce when the wire declares something — products lacking a
      // delivery_type field shouldn't trip the gate.
      if (extras.length > 0 && wireDelivery.size > 0) {
        throw new AdcpError('INTERNAL_ERROR', {
          recovery: 'terminal',
          message:
            `Recipe for product ${JSON.stringify(productId)} declares ` +
            `capability_overlap.deliveryTypes=${JSON.stringify([...overlap.deliveryTypes].sort())} ` +
            `including ${JSON.stringify(extras.sort())}, but the wire product only advertises ` +
            `${JSON.stringify([...wireDelivery].sort())}.`,
        });
      }
    }
  }
}

function wirePricingModels(product: Product): Set<string> {
  const out = new Set<string>();
  const pricing = (product as { pricing_options?: ReadonlyArray<{ pricing_model?: string }> }).pricing_options;
  if (!pricing) return out;
  for (const opt of pricing) {
    if (opt.pricing_model) out.add(String(opt.pricing_model));
  }
  return out;
}

function wireDeliveryTypes(product: Product): Set<string> {
  const dt = (product as { delivery_type?: string }).delivery_type;
  return dt ? new Set([String(dt)]) : new Set();
}

// ---------------------------------------------------------------------------
// Finalize action detection
// ---------------------------------------------------------------------------

/**
 * Result of {@link detectFinalizeAction}: the index, proposal_id, and
 * optional ask of the first finalize-action refine entry.
 *
 * @public
 */
export interface FinalizeActionRef {
  index: number;
  proposalId: string;
  ask?: string;
}

/**
 * Return the first finalize-action refine entry from a
 * `GetProductsRequest`, or `null` if no finalize entry exists.
 *
 * The index points at the entry's position in `refine[]` so the framework
 * can produce indexed wire field paths (`refine[3].proposal_id`) on
 * rejection — buyers parsing the error get a precise pointer.
 *
 * Per the spec, `buying_mode: 'refine'` carries a `refine[]` array of
 * entries. Each entry has a `scope` (`request` / `product` / `proposal`)
 * and an optional `action` (`include` / `omit` / `finalize`). v1.5 only
 * intercepts `proposal`-scoped entries with `action: 'finalize'`.
 *
 * The framework processes ONE finalize entry per request; if the buyer
 * sends multiple finalize entries, only the first is processed (rest fall
 * through to the standard refine path).
 *
 * @public
 */
export function detectFinalizeAction(req: GetProductsRequest): FinalizeActionRef | null {
  const refine = (req as { refine?: ReadonlyArray<Record<string, unknown>> }).refine;
  if (!refine || refine.length === 0) return null;
  for (let index = 0; index < refine.length; index++) {
    const entry = refine[index]!;
    if (entry.scope === 'proposal' && entry.action === 'finalize') {
      const proposalId = entry.proposal_id;
      if (typeof proposalId === 'string' && proposalId.length > 0) {
        const ask = typeof entry.ask === 'string' ? entry.ask : undefined;
        return ask !== undefined ? { index, proposalId, ask } : { index, proposalId };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Structured logging — § Observability
// ---------------------------------------------------------------------------

/**
 * Logger-shaped sink for structured proposal-lifecycle events. Defaults to
 * `console.info`-style emission; the dispatch path can pass a typed logger
 * to route through the rest of the framework's logging.
 *
 * @public
 */
export interface ProposalLifecycleLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

let logger: ProposalLifecycleLogger = {
  info: (message, fields) => {
    if (fields) {
      console.log(JSON.stringify({ message, ...fields }));
    } else {
      console.log(message);
    }
  },
};

/**
 * Replace the module-level logger that proposal-lifecycle structured
 * events (`proposal.draft_persisted`, `proposal.finalized`, `proposal.expired`,
 * `proposal.consumed`) emit through. Adopters wire this to their existing
 * logger (pino, bunyan, etc.) so lifecycle events route through the same
 * pipeline as the rest of their server logs. Tests use it to capture
 * structured emissions for assertion.
 *
 * @public
 */
export function setProposalLifecycleLogger(next: ProposalLifecycleLogger): void {
  logger = next;
}

/** `proposal.draft_persisted` event. */
export function logDraftPersisted(args: { proposalId: string; accountId: string; recipesCount: number }): void {
  logger.info('proposal.draft_persisted', {
    event: 'proposal.draft_persisted',
    proposal_id: args.proposalId,
    account_id: args.accountId,
    recipes_count: args.recipesCount,
  });
}

/**
 * `proposal.finalized` event. `path` is `'inline'` or `'handoff'`.
 */
export function logFinalizeSucceeded(args: {
  proposalId: string;
  accountId: string;
  expiresAt: Date;
  path: 'inline' | 'handoff';
}): void {
  logger.info('proposal.finalized', {
    event: 'proposal.finalized',
    proposal_id: args.proposalId,
    account_id: args.accountId,
    expires_at: args.expiresAt.toISOString(),
    path: args.path,
  });
}

/** `proposal.expired` event. */
export function logExpired(args: {
  proposalId: string;
  accountId: string;
  now: Date;
  expiresAt: Date;
  graceSeconds: number;
}): void {
  logger.info('proposal.expired', {
    event: 'proposal.expired',
    proposal_id: args.proposalId,
    account_id: args.accountId,
    now: args.now.toISOString(),
    expires_at: args.expiresAt.toISOString(),
    grace_seconds: args.graceSeconds,
  });
}

/** `proposal.consumed` event. */
export function logConsumed(args: { proposalId: string; accountId: string; mediaBuyId: string }): void {
  logger.info('proposal.consumed', {
    event: 'proposal.consumed',
    proposal_id: args.proposalId,
    account_id: args.accountId,
    media_buy_id: args.mediaBuyId,
  });
}
