/**
 * `AuctionLikeRecipe` — canonical {@link Recipe} shape for hello adapters
 * wrapping the `sales-non-guaranteed` mock-server upstream.
 *
 * Auction-cleared programmatic remnant: floor pricing per zone (=
 * AdCP `ad_unit`), no inventory hold, no draft→committed lifecycle.
 * The recipe captures *how to flight a bid into the auction* — flight
 * id, zone targeting, priority, floor CPM. Generic across decision-
 * engine backends (Kevel) and exchange backends (OpenRTB DSPs/SSPs,
 * Beeswax, Adelphic) — adopters who want a sharper-typed shape declare
 * their own `recipe_kind: 'kevel' | 'openrtb' | ...` subtype on top.
 *
 * **No proposal lifecycle.** Non-guaranteed sells "right of first refusal
 * at floor"; there's no draft→committed ceremony. The recipe lands on
 * the buyer's first `create_media_buy` (no preceding finalize step).
 *
 * @public
 * @packageDocumentation
 */

import type { CapabilityOverlap, Recipe } from '../../server/decisioning/proposal';
import type { MockProduct } from './seed-data';

/**
 * Canonical recipe for hello adapters wrapping an auction-cleared
 * remnant upstream. Generic across decision-engine and exchange
 * backends — fields map cleanly onto Kevel `Flight`, OpenRTB `imp`
 * + deal, Beeswax `Strategy`, etc. Adopters with platform-specific
 * fields (Kevel `frequency_caps`, Beeswax `bid_modifier_strategies`)
 * either extend in `extensions` or declare a sharper `recipe_kind`
 * subtype.
 *
 * @public
 */
export interface AuctionLikeRecipe extends Recipe {
  recipe_kind: 'auction';

  /** Upstream tenant — the publisher's network/account code. */
  network_code: string;

  /**
   * Zones (= AdCP `ad_unit`s) the bid flights into. Mirrors Kevel
   * `Flight.zone_ids` / OpenRTB `imp.tagid[]`.
   */
  zone_ids: readonly string[];

  /**
   * Auction-priority weight. Kevel default 5 (higher = more
   * aggressive); OpenRTB-flavored adapters typically map to deal
   * priority or `bidfloor` tier.
   */
  weight: number;

  /** Pricing the upstream will bid at. */
  pricing: {
    /** Floor / minimum CPM the upstream accepts. Bids below this are dropped. */
    floor_cpm: number;
    /**
     * Optional historical clearing CPM — typically 1.2-1.5x `floor_cpm`
     * at modest spend, saturating toward 2x at high budgets. Used by
     * the adapter to project effective CPM at the requested budget.
     */
    target_cpm?: number;
    currency: string;
  };

  /** Goal axis the auction's pacing optimizes toward. */
  goal_type: 'impressions' | 'click' | 'spend';

  /** Optional minimum spend threshold the upstream enforces. */
  min_spend?: number;

  /**
   * Native upstream identifier populated post-`create_media_buy`. Empty
   * pre-buy (the upstream allocates this on flight creation).
   */
  upstream_ids?: {
    flight_id?: string;
  };

  /**
   * Adopter-extension slot for platform-specific fields (Kevel
   * `frequency_caps`, OpenRTB `private_auction`, Beeswax
   * `bid_modifier_strategies`, etc.) so adopters carrying richer
   * upstream payloads don't have to fork `recipe_kind`. Opaque to the
   * framework. Subtype the recipe with a literal `recipe_kind` and
   * typed `extensions` if you want stricter shape enforcement.
   *
   * **MUST NOT carry credentials** (auction-house API keys, OAuth
   * tokens, HMAC secrets). The framework strips the entire
   * `implementation_config` envelope from buyer-facing wire responses,
   * so credentials here are protected *by coincidence of strip*, not
   * by a credential scan. Re-derive credentials per request from
   * `ctx.authInfo` + your token cache; embed only non-secret upstream
   * identifiers here. Same hazard class as `ctx_metadata` and `ext` —
   * see `docs/guides/CTX-METADATA-SAFETY.md`.
   */
  extensions?: Record<string, unknown>;
}

/**
 * Maximum capability set the auction-remnant model supports — every
 * product is CPM-only non-guaranteed; targeting axes are the ones
 * exchanges and decision engines commonly enforce. Per-product
 * `capability_overlap` is derived from this in {@link buildAuctionLikeRecipe}
 * intersected with the product's actual offering.
 *
 * @public
 */
export const AUCTION_LIKE_OVERLAP: CapabilityOverlap = {
  // Lowercase matches the AdCP wire `pricing_model` enum so the framework's
  // `overlap ⊆ wire` validation passes.
  pricingModels: new Set(['cpm']),
  deliveryTypes: new Set(['non_guaranteed']),
  targetingDimensions: new Set(['geo', 'device_type', 'language']),
};

/**
 * Build an {@link AuctionLikeRecipe} from a {@link MockProduct} returned
 * by the `sales-non-guaranteed` mock-server's `/v1/products` endpoint.
 *
 * Hello adapters call this inside their `proposalManager.getProducts`
 * (or `sales.getProducts` if no proposal lifecycle is wired) to project
 * the upstream's native shape onto the recipe contract.
 *
 * @public
 */
export function buildAuctionLikeRecipe(
  product: MockProduct,
  options: {
    /** Override the auction-priority weight. Defaults to `5`. */
    weight?: number;
    /**
     * Goal axis. Defaults to `'impressions'` (typical for
     * floor-priced remnant).
     */
    goal_type?: AuctionLikeRecipe['goal_type'];
    /** Set post-`create_media_buy`. */
    upstream_ids?: AuctionLikeRecipe['upstream_ids'];
    /** Adopter-supplied extension blob. */
    extensions?: Record<string, unknown>;
  } = {}
): AuctionLikeRecipe {
  const recipe: AuctionLikeRecipe = {
    recipe_kind: 'auction',
    network_code: product.network_code,
    zone_ids: product.ad_unit_ids,
    weight: options.weight ?? 5,
    pricing: {
      floor_cpm: product.pricing.min_cpm,
      currency: product.pricing.currency,
      ...(product.pricing.target_cpm !== undefined && { target_cpm: product.pricing.target_cpm }),
    },
    goal_type: options.goal_type ?? 'impressions',
    // Per-product overlap: matches the auction-remnant model where
    // every product is CPM-only non-guaranteed. We derive per-product
    // (rather than reusing AUCTION_LIKE_OVERLAP wholesale) to keep the
    // pattern consistent with GAM-like and to surface adopter drift
    // when a product's wire shape doesn't match the recipe overlap.
    capability_overlap: {
      pricingModels: new Set(['cpm']),
      deliveryTypes: new Set(['non_guaranteed']),
      targetingDimensions: AUCTION_LIKE_OVERLAP.targetingDimensions,
    },
  };
  if (product.pricing.min_spend !== undefined) recipe.min_spend = product.pricing.min_spend;
  if (options.upstream_ids) recipe.upstream_ids = options.upstream_ids;
  if (options.extensions) recipe.extensions = options.extensions;
  return recipe;
}
