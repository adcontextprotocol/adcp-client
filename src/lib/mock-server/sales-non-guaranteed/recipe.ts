/**
 * `KevelLikeRecipe` — canonical {@link Recipe} shape for hello adapters
 * wrapping the `sales-non-guaranteed` mock-server upstream.
 *
 * Auction-cleared programmatic remnant: floor pricing per zone (=
 * AdCP `ad_unit`), no inventory hold, no draft→committed lifecycle.
 * The recipe captures *how to flight a bid into the auction* — flight
 * id, zone targeting, weight, floor CPM. Adopters wrapping Kevel,
 * OpenRTB exchanges, Beeswax, Adelphic, or any auction-cleared remnant
 * platform map their native fields onto this shape.
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
 * Canonical recipe for hello adapters wrapping a Kevel-style auction
 * remnant upstream. Adopters extend with platform-specific fields
 * (e.g. Beeswax `bid_modifier_strategies`, Kevel `frequency_caps`).
 *
 * @public
 */
export interface KevelLikeRecipe extends Recipe {
  recipe_kind: 'kevel';

  /** Upstream tenant — the publisher's network/account code. */
  network_code: string;

  /**
   * Zones (= AdCP `ad_unit`s) the bid flights into. Mirrors Kevel
   * `Flight.zone_ids` / OpenRTB `imp.tagid[]`.
   */
  zone_ids: readonly string[];

  /**
   * Auction-priority weight. Kevel default 5; higher = more aggressive.
   * Adopters with platform-specific priority semantics (OpenRTB
   * `bidfloor` deal vs PMP, Beeswax `priority`) translate at the seam.
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
}

/**
 * Canonical {@link CapabilityOverlap} for `KevelLikeRecipe` products.
 * Auction remnant exposes a narrower target dimension set than
 * guaranteed (no audience/placement axes).
 *
 * @public
 */
export const KEVEL_LIKE_OVERLAP: CapabilityOverlap = {
  pricingModels: new Set(['CPM']),
  deliveryTypes: new Set(['non_guaranteed']),
  targetingDimensions: new Set(['geo', 'device_type', 'language']),
};

/**
 * Build a {@link KevelLikeRecipe} from a {@link MockProduct} returned
 * by the `sales-non-guaranteed` mock-server's `/v1/products` endpoint.
 *
 * Hello adapters call this inside their `proposalManager.getProducts`
 * (or `sales.getProducts` if no proposal lifecycle is wired) to project
 * the upstream's native shape onto the recipe contract.
 *
 * @public
 */
export function buildKevelLikeRecipe(
  product: MockProduct,
  options: {
    /** Override the auction-priority weight. Defaults to `5`. */
    weight?: number;
    /**
     * Goal axis. Defaults to `'impressions'` (Kevel's typical setting
     * for floor-priced remnant).
     */
    goal_type?: KevelLikeRecipe['goal_type'];
    /** Set post-`create_media_buy`. */
    upstream_ids?: KevelLikeRecipe['upstream_ids'];
  } = {}
): KevelLikeRecipe {
  const recipe: KevelLikeRecipe = {
    recipe_kind: 'kevel',
    network_code: product.network_code,
    zone_ids: product.ad_unit_ids,
    weight: options.weight ?? 5,
    pricing: {
      floor_cpm: product.pricing.min_cpm,
      currency: product.pricing.currency,
      ...(product.pricing.target_cpm !== undefined && { target_cpm: product.pricing.target_cpm }),
    },
    goal_type: options.goal_type ?? 'impressions',
    capability_overlap: KEVEL_LIKE_OVERLAP,
  };
  if (product.pricing.min_spend !== undefined) recipe.min_spend = product.pricing.min_spend;
  if (options.upstream_ids) recipe.upstream_ids = options.upstream_ids;
  return recipe;
}
