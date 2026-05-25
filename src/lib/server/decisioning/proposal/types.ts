/**
 * ProposalManager — primitives for the two-platform composition.
 *
 * The existing `DecisioningPlatform` conflates two concerns: assembling
 * proposals from briefs (`get_products`, refine) vs. executing media buys
 * against an upstream (`create_media_buy`, `update_media_buy`,
 * `get_media_buy_delivery`). The two-platform composition splits them: a
 * separate {@link ProposalManager} handles the proposal side; the
 * `DecisioningPlatform` keeps the execution side. Either platform can be
 * mock-backed independently.
 *
 * Ports the Python primitives shipped in `adcp-client-python` PRs #504
 * (v1) and #550 (v1.5):
 *
 *   - {@link ProposalManager} — interface with `getProducts` (required)
 *     plus optional `refineProducts` and `finalizeProposal`.
 *   - {@link ProposalCapabilities} — sales-axis-scoped capability flags.
 *   - {@link Recipe} — typed `recipe_kind`-discriminated base; adopters
 *     subclass with their internal-config schema. Rides on
 *     `Product.implementation_config` (opaque to the buyer).
 *   - {@link CapabilityOverlap} — typed declaration of which wire
 *     capabilities the buyer can configure on a product. The framework
 *     validates buyer requests against the overlap pre-adapter.
 *   - {@link FinalizeProposalRequest} / {@link FinalizeProposalSuccess} —
 *     framework-internal shapes for the finalize lifecycle (wired in the
 *     v1.5 dispatch helpers).
 *
 * @public
 * @packageDocumentation
 */

import type { MaybePromise } from '../../create-adcp-server';
import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { GetProductsRequest, GetProductsResponse } from '../../../types/tools.generated';
import type { ServerPayload } from '../../../types/server-payload';
import type { TaskHandoff } from '../async-outcome';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Sales specialisms a {@link ProposalManager} can serve. Mirrors the
 * `sales-*` slugs in the spec's specialism enum.
 *
 * v1 scopes to the two `ProposalManager`-relevant flavours; broader
 * coverage (broadcast-tv, social, proposal-mode, catalog-driven) lands
 * as adopter signal grows.
 *
 * @public
 */
export type ProposalSalesSpecialism = 'sales-guaranteed' | 'sales-non-guaranteed';

/**
 * Capability declaration for a {@link ProposalManager}.
 *
 * Sales-axis-scoped: proposal handling is a sales-specialism concern,
 * not a generic platform-wide concept. The `salesSpecialism` field
 * declares which AdCP sales specialism this manager serves; capability
 * flags declare which optional behaviours it supports.
 *
 * The framework reads this declaration at server-construction time to
 * decide which dispatch paths apply (e.g. `refineProducts` is only
 * invoked when `refine` is true; `finalizeProposal` is only invoked
 * when `finalize` is true).
 *
 * @public
 */
export interface ProposalCapabilities {
  /**
   * Which AdCP sales specialism this manager serves.
   *
   * `sales-guaranteed` for guaranteed-direct flows with proposal
   * lifecycle (finalize → committed proposal → media buy).
   *
   * `sales-non-guaranteed` for catalog-style flows where `getProducts`
   * returns a static catalog and buyers reference products directly at
   * `create_media_buy`.
   */
  salesSpecialism: ProposalSalesSpecialism;

  /**
   * When true, the manager implements {@link ProposalManager.refineProducts}
   * and the framework routes `get_products` requests with
   * `buying_mode: 'refine'` to that method. When false, refine requests
   * fall through to `getProducts` (or surface `UNSUPPORTED_FEATURE` if
   * the manager rejects them).
   */
  refine?: boolean;

  /**
   * When true, the manager implements {@link ProposalManager.finalizeProposal}
   * and the framework intercepts `refine[i].action: 'finalize'` entries to
   * commit drafts via the lifecycle helpers. When false, finalize entries
   * pass through to the underlying `getProducts` / `refineProducts` method
   * unchanged.
   */
  finalize?: boolean;

  /**
   * Grace window (in seconds) added to a committed proposal's `expires_at`
   * before the framework rejects `create_media_buy` calls referencing the
   * proposal with `PROPOSAL_EXPIRED`. Default 0 (strict).
   */
  expiresAtGraceSeconds?: number;

  /**
   * Signal-driven product assembly — the manager constructs products from
   * buyer signals at request time rather than enumerating a static
   * catalogue. Informational in v1.5; future PRs may validate that
   * inventory / signal stores are wired when this flag is set.
   */
  dynamicProducts?: boolean;

  /**
   * The manager consults rate cards (per buyer relationship per product)
   * when emitting prices. Informational in v1.5.
   */
  rateCardPricing?: boolean;

  /**
   * The manager reserves capacity at proposal time (typical for
   * guaranteed). Informational in v1.5; the `finalize` transition that
   * drives the actual hold is wired via the lifecycle helpers.
   */
  availabilityReservations?: boolean;
}

/**
 * Validate a {@link ProposalCapabilities} object. Throws when the declaration
 * is malformed (unknown `salesSpecialism`, negative `expiresAtGraceSeconds`).
 * The framework calls this at boot; adopters can call it from their own
 * config-validation code paths to fail fast on misconfiguration.
 *
 * Kept as a plain function rather than a class constructor to match the
 * codebase's preference for plain TS interfaces over runtime classes
 * for adopter-facing types.
 *
 * @public
 */
export function validateProposalCapabilities(caps: ProposalCapabilities): void {
  const valid: readonly ProposalSalesSpecialism[] = ['sales-guaranteed', 'sales-non-guaranteed'];
  if (!valid.includes(caps.salesSpecialism)) {
    throw new Error(
      `ProposalCapabilities.salesSpecialism must be one of ${JSON.stringify(valid)}. ` +
        `Got ${JSON.stringify(caps.salesSpecialism)}. v1.5 scopes ProposalManager to the two ` +
        `core sales specialisms; broader specialism support lands in subsequent releases.`
    );
  }
  if (caps.expiresAtGraceSeconds != null && caps.expiresAtGraceSeconds < 0) {
    throw new Error(
      `ProposalCapabilities.expiresAtGraceSeconds must be >= 0; got ${caps.expiresAtGraceSeconds}. ` +
        `The grace window extends the inventory hold past expires_at; negative values would shrink it.`
    );
  }
}

// ---------------------------------------------------------------------------
// Recipe + CapabilityOverlap
// ---------------------------------------------------------------------------

/**
 * Per-product subset of wire capability flags that the buyer can
 * configure on this product.
 *
 * Buyer requests asking for capabilities outside this overlap are
 * rejected by the framework before the adapter sees them (validated by
 * the lifecycle helpers — see `proposal/lifecycle.ts`).
 *
 * Each field is `ReadonlySet<string> | undefined`:
 *
 *   - `undefined` → framework does not gate this axis (open).
 *   - `ReadonlySet` → buyer choices must be subsets of this set.
 *     An empty set means deny-all on this axis.
 *
 * The undefined vs. empty-set distinction matches set intuition:
 * "no constraint" is `undefined`; "allowed set is empty" is `new Set()`.
 *
 * **Why no extras dict?** v1.5 deliberately omits an `extras` escape
 * hatch (per Python design § D4). Adopters with novel gating needs
 * extend the interface with typed fields; a dict bag leaves no paper
 * trail. If a new axis turns out to be widely useful, it lands as a
 * typed field on `CapabilityOverlap` upstream.
 *
 * @public
 */
export interface CapabilityOverlap {
  /**
   * Subset of wire `pricing_models` the buyer can choose. Validated
   * against the matching `PricingOption.pricing_model` on the buyer's
   * package.
   */
  pricingModels?: ReadonlySet<string>;

  /**
   * Subset of wire targeting dimensions (`geo`, `device_type`,
   * `language`, etc.). Validated against the keys present on the
   * buyer's `targeting_overlay`.
   */
  targetingDimensions?: ReadonlySet<string>;

  /**
   * Subset of `{ guaranteed, non_guaranteed }` the product offers.
   */
  deliveryTypes?: ReadonlySet<string>;

  /**
   * If the seller integrates signals, which signal types this product
   * accepts. An empty set means the seller explicitly refuses all
   * signals on this product; `undefined` means no framework gate.
   */
  signalTypes?: ReadonlySet<string>;
}

/**
 * Base type for typed product `implementation_config` payloads.
 *
 * Adopters declare a discriminated subtype with a literal `recipe_kind`:
 *
 * ```ts
 * interface GAMRecipe extends Recipe {
 *   recipe_kind: 'gam';
 *   line_item_template_id: string;
 *   ad_unit_ids: readonly string[];
 *   capability_overlap?: CapabilityOverlap;
 * }
 * ```
 *
 * The kind tag enables router-by-recipe-kind dispatch in the
 * multi-decisioning case (one ProposalManager + many DecisioningPlatforms,
 * each handling a subset of recipe kinds). v1.5 doesn't yet wire that
 * routing — adopters using a single DecisioningPlatform attach recipes
 * freely without registry validation.
 *
 * **The recipe is never on the buyer's wire surface.** It rides inside
 * `Product.implementation_config` (an opaque-to-buyer dict). Buyers treat
 * it as a black box; the framework persists it through the proposal
 * lifecycle so the executing DecisioningPlatform sees a stable view.
 *
 * `capability_overlap` is optional. When present, the framework activates
 * the v1.5 buyer-request validation seam against the declared subsets.
 *
 * @public
 */
export interface Recipe {
  /** Adapter-family discriminator. Subtypes narrow with a literal type. */
  recipe_kind: string;

  /**
   * Optional typed declaration of which wire capabilities the buyer can
   * configure on this product. `undefined` means no framework gating.
   * An explicit {@link CapabilityOverlap} activates the v1.5 validation.
   */
  capability_overlap?: CapabilityOverlap;
}

// ---------------------------------------------------------------------------
// Finalize lifecycle shapes
// ---------------------------------------------------------------------------

/**
 * Framework-internal request shape passed to {@link ProposalManager.finalizeProposal}.
 *
 * Constructed by the framework dispatcher when a buyer's `get_products`
 * request with `buying_mode: 'refine'` carries a `refine[i].action: 'finalize'`
 * entry. Adopters don't parse the wire envelope; the framework projects.
 *
 * @public
 */
export interface FinalizeProposalRequest<TRecipe extends Recipe = Recipe> {
  /**
   * The draft proposal the buyer is asking to finalize. Hydrated from
   * the wire's `refine[i].proposal_id` field.
   */
  proposalId: string;

  /**
   * `product_id -> Recipe` mapping pulled from the {@link ProposalStore}
   * draft. The adopter's finalize logic typically lock-prices these and
   * emits the committed proposal.
   */
  recipes: ReadonlyMap<string, TRecipe>;

  /**
   * The draft's wire `Proposal` shape (the same payload the adopter
   * returned on the prior `getProducts` / `refineProducts` call).
   * Adopter typically modifies this with locked pricing and returns it
   * on {@link FinalizeProposalSuccess}.
   */
  proposalPayload: Record<string, unknown>;

  /**
   * The buyer's per-entry refine `ask` text — what they want finalized.
   * Free-form; adopter consumes.
   */
  ask?: string;

  /**
   * The parent {@link GetProductsRequest} so the adopter sees the full
   * envelope (account, etc.) without the framework projecting fields
   * one-by-one.
   */
  parentRequest: GetProductsRequest;
}

/**
 * Adopter-returned shape from {@link ProposalManager.finalizeProposal} —
 * inline commit.
 *
 * Framework calls `ProposalStore.commit` with these fields before
 * projecting the wire response. The buyer sees the committed `Proposal`
 * with `proposal_status: 'committed'` + `expires_at` populated on the
 * next `get_products` response payload.
 *
 * @public
 */
export interface FinalizeProposalSuccess<TRecipe extends Recipe = Recipe> {
  /**
   * The wire `Proposal` shape with locked pricing and
   * `proposal_status: 'committed'`. Adopter typically derives this from
   * {@link FinalizeProposalRequest.proposalPayload} with modifications.
   *
   * **Must be JSON-serializable end-to-end** — non-JSON values won't
   * survive a process restart through a durable {@link ProposalStore}.
   */
  proposal: Record<string, unknown>;

  /**
   * Inventory hold deadline. After this (plus the adopter's
   * {@link ProposalCapabilities.expiresAtGraceSeconds} window), the
   * framework rejects `create_media_buy` calls referencing the proposal
   * with `PROPOSAL_EXPIRED`.
   */
  expiresAt: Date;

  /**
   * Optional refreshed recipe mapping. Omitting preserves the draft's
   * recipes verbatim. Adopters whose finalize logic mutates recipe
   * fields (e.g. locking a line-item template id) supply a fresh
   * mapping.
   */
  recipes?: ReadonlyMap<string, TRecipe>;
}

// ---------------------------------------------------------------------------
// ProposalManager interface
// ---------------------------------------------------------------------------

type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

/**
 * Assembles proposals from buyer briefs.
 *
 * Reads inventory, signals, rate cards, availability. Produces proposals
 * where each `Product` carries a typed `implementation_config` (a recipe;
 * see {@link Recipe}) that the bound `DecisioningPlatform` consumes at
 * `create_media_buy` time.
 *
 * Methods may be sync or async; the framework awaits whatever is
 * returned. Same convention as `SalesPlatform`.
 *
 * **Required surface:** {@link getProducts}.
 *
 * **Optional surfaces (capability-gated):**
 *
 *   - {@link refineProducts} — only invoked when
 *     {@link ProposalCapabilities.refine} is true.
 *   - {@link finalizeProposal} — only invoked when
 *     {@link ProposalCapabilities.finalize} is true. Wired by the
 *     framework's lifecycle helpers; intercepts `refine[i].action: 'finalize'`
 *     entries before the underlying `getProducts` / `refineProducts` runs.
 *
 * Throw `AdcpError` for buyer-fixable rejection (`BUDGET_TOO_LOW`,
 * `POLICY_VIOLATION`, `UNSUPPORTED_FEATURE`); the framework projects to
 * the wire structured-error envelope.
 *
 * Adopter typing tip: parameterize on your concrete `Recipe` subtype to
 * get end-to-end recipe typing through `ctx.recipes` in the bound
 * `DecisioningPlatform`'s methods:
 *
 * ```ts
 * type MyRecipe = GAMRecipe | KevelRecipe;
 * const manager: ProposalManager<MyRecipe, MyTenantMeta> = { ... };
 * ```
 *
 * @public
 */
export interface ProposalManager<TRecipe extends Recipe = Recipe, TCtxMeta = unknown> {
  /**
   * What this ProposalManager can do — sales specialism + capability flags.
   */
  capabilities: ProposalCapabilities;

  /**
   * Initial product discovery from a buyer brief.
   *
   * Each returned `Product` SHOULD carry an `implementation_config`
   * matching the bound `DecisioningPlatform`'s recipe schema (see
   * {@link Recipe}). The framework treats `implementation_config` as
   * opaque on the wire; recipe typing is enforced through the
   * `TRecipe` type parameter on the adopter side.
   *
   * For non-guaranteed flows: typically a static catalogue, possibly
   * filtered by buyer brief / signals.
   *
   * For guaranteed flows: typically a brief-driven assembly consulting
   * rate cards + availability. Adopters return draft proposals; the
   * buyer drives the finalize transition via subsequent refine calls
   * with `action: 'finalize'`.
   */
  getProducts(req: GetProductsRequest, ctx: Ctx<TCtxMeta>): MaybePromise<ServerPayload<GetProductsResponse>>;

  /**
   * Refine-mode iteration on a previous `getProducts` response.
   *
   * Per the spec, refine is a `buying_mode` value on `get_products` —
   * the wire envelope is the same. The framework routes refine requests
   * to this method when:
   *
   * 1. The wired ProposalManager declares `capabilities.refine` = true,
   * 2. The request has `buying_mode === 'refine'`, AND
   * 3. The manager implements this method.
   *
   * Otherwise refine requests fall through to {@link getProducts}.
   *
   * Adopters implementing `refineProducts` without `finalize` support
   * should treat `action: 'finalize'` entries as `UNSUPPORTED_FEATURE`
   * and return a structured error. Adopters with `finalize` support
   * see those entries intercepted by the framework before this method
   * is called.
   */
  refineProducts?(req: GetProductsRequest, ctx: Ctx<TCtxMeta>): MaybePromise<ServerPayload<GetProductsResponse>>;

  /**
   * Commit a draft proposal to firm pricing + inventory hold.
   *
   * Wired by the framework's lifecycle helpers when:
   *
   * 1. `capabilities.finalize === true`,
   * 2. The buyer's request has `buying_mode === 'refine'` with a
   *    `refine[i]` entry of `{ scope: 'proposal', action: 'finalize',
   *    proposal_id }`, AND
   * 3. The proposal_id resolves to a DRAFT entry in the
   *    {@link ProposalStore}.
   *
   * Return a {@link FinalizeProposalSuccess} for inline commit (the
   * spec-default route), or a `TaskHandoff<FinalizeProposalSuccess>` to
   * promote to a HITL background task. The HITL commit hook is wired
   * in v1.6+; v1.5 inline-only.
   */
  finalizeProposal?(
    req: FinalizeProposalRequest<TRecipe>,
    ctx: Ctx<TCtxMeta>
  ): MaybePromise<FinalizeProposalSuccess<TRecipe> | TaskHandoff<FinalizeProposalSuccess<TRecipe>>>;
}
