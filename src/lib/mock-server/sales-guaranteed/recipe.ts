/**
 * `GAMLikeRecipe` — canonical {@link Recipe} shape for hello adapters
 * wrapping the `sales-guaranteed` mock-server upstream.
 *
 * The recipe is the contract between the {@link ProposalManager} and the
 * {@link DecisioningPlatform}: the manager emits products with this
 * recipe attached to `Product.implementation_config`; the framework
 * persists the recipe through the proposal lifecycle; at
 * `create_media_buy` time, `ctx.recipes` carries the recipe back to the
 * adapter's `sales` methods, where it drives the upstream line-item
 * creation call.
 *
 * **Why "GAM-like"?** This shape mirrors the canonical fields a Google
 * Ad Manager-style upstream needs: ad units to target, line-item
 * priority, frequency capping, fixed pricing. Adopters wrapping GAM,
 * FreeWheel, Operative, Xandr Monetize, or any direct-sold guaranteed
 * inventory platform map their native fields onto this shape with
 * minimal translation. Adopters wrapping a different platform family
 * declare their own `recipe_kind` literal; the multi-decisioning
 * framework dispatches by `recipe_kind`.
 *
 * **The recipe is NOT on the buyer's wire surface.** It rides inside
 * `Product.implementation_config` (an opaque-to-buyer dict). Buyers
 * treat it as a black box.
 *
 * @public
 * @packageDocumentation
 */

import type { CapabilityOverlap, Recipe } from '../../server/decisioning/proposal';
import type { MockProduct } from './seed-data';

/**
 * Canonical recipe for hello adapters wrapping a GAM-style guaranteed
 * sales upstream. Adopters subclass / extend this if their backend
 * needs additional fields (e.g. `roadblock_settings`, `creative_rotation_mode`).
 *
 * @public
 */
export interface GAMLikeRecipe extends Recipe {
  recipe_kind: 'gam';

  /** Upstream tenant — the publisher's GAM network code. */
  network_code: string;

  /**
   * Ad units this product targets in the upstream. Mirrors GAM
   * `LineItem.targeting.inventoryTargeting.targetedAdUnitIds`.
   */
  ad_unit_ids: readonly string[];

  /**
   * Line-item priority in the upstream's auction graph. GAM convention:
   *
   *   - `4`–`6`: sponsorship / unsold-house
   *   - `7`–`9`: standard guaranteed (default for `'guaranteed'` delivery)
   *   - `10`–`12`: standard non-guaranteed / network
   *   - `13`–`16`: bulk / price-priority
   *
   * Hello adapter defaults: `8` for guaranteed, `12` for non-guaranteed.
   */
  line_item_priority: number;

  /**
   * Pricing the upstream will book at. Adopter's `finalizeProposal`
   * locks these values; pre-finalize they're indicative. Lowercase
   * values match the AdCP wire `pricing_model` enum so the framework's
   * `overlap ⊆ wire` validation accepts the recipe.
   */
  pricing: {
    pricing_model: 'cpm' | 'cpv' | 'cpcv' | 'cpc';
    rate: number;
    currency: string;
  };

  delivery_type: 'guaranteed' | 'non_guaranteed';

  /**
   * Inventory hold window the upstream reserved at finalize time. Empty
   * pre-finalize (draft proposals don't reserve inventory).
   */
  availability_window?: {
    start_date: string;
    end_date: string;
    /** Reserved impressions count from the upstream's getAvailabilityForecast. */
    reserved_impressions?: number;
  };

  /** Optional minimum spend threshold the upstream enforces. */
  min_spend?: number;

  /**
   * Native upstream identifiers populated post-finalize. Empty pre-
   * finalize (the upstream allocates these on commit).
   */
  upstream_ids?: {
    /** Upstream proposal id (the seller's bookable plan). */
    proposal_id?: string;
    /** Per-package line-item template id; the adapter uses this to
     * create the bookable line item at `create_media_buy` time. */
    line_item_template_id?: string;
  };

  /**
   * Adopter-extension slot for upstream-specific fields the canonical
   * shape doesn't enumerate — `creative_placeholders` (size + companion
   * bundles), `custom_targeting` (key-values, dayparting), GAM
   * `roadblock_settings`, FreeWheel `placement_types`, Operative
   * `revenue_type`, etc. Adopters carrying richer payloads use this
   * slot rather than forking `recipe_kind: 'gam'` into N variants.
   * Opaque to the framework; sharper-typed adopters can declare a
   * subtype literal `recipe_kind: 'gam-myco'` with a typed `extensions`.
   */
  extensions?: Record<string, unknown>;
}

/**
 * Maximum capability set a GAM-style upstream supports across its
 * product mix. Per-product `capability_overlap` is derived from this
 * intersected with the product's actual offering — see
 * {@link buildGAMLikeRecipe}'s overlap computation. Use this constant
 * directly only when you know the product accepts every axis.
 *
 * @public
 */
export const GAM_LIKE_OVERLAP: CapabilityOverlap = {
  pricingModels: new Set(['cpm', 'cpv', 'cpcv']),
  deliveryTypes: new Set(['guaranteed', 'non_guaranteed']),
  targetingDimensions: new Set(['geo', 'device_type', 'language', 'placement', 'audience']),
};

/**
 * Build a {@link GAMLikeRecipe} from a {@link MockProduct} returned by
 * the `sales-guaranteed` mock-server's `/v1/products` endpoint.
 *
 * Hello adapters call this inside `proposalManager.getProducts` to
 * project the upstream's native shape onto the recipe contract. The
 * recipe rides on `Product.implementation_config`; the framework
 * persists it; the adapter's `sales.createMediaBuy` later reads it from
 * `ctx.recipes`.
 *
 * @public
 */
export function buildGAMLikeRecipe(
  product: MockProduct,
  options: {
    /**
     * Override the line-item priority. Defaults to `8` for guaranteed,
     * `12` for non-guaranteed (GAM's standard tiers).
     */
    line_item_priority?: number;
    /**
     * When set, projects to the recipe's `availability_window`. Hello
     * adapters compute this from the buyer's brief OR from the
     * upstream's availability response after finalize.
     */
    availability_window?: GAMLikeRecipe['availability_window'];
    /**
     * Set post-finalize. Empty pre-finalize.
     */
    upstream_ids?: GAMLikeRecipe['upstream_ids'];
    /** Adopter-supplied extension blob. */
    extensions?: Record<string, unknown>;
  } = {}
): GAMLikeRecipe {
  const priority = options.line_item_priority ?? (product.delivery_type === 'guaranteed' ? 8 : 12);
  // Per-product overlap: intersect the platform's full capability set
  // with what THIS product actually advertises on the wire. Catches
  // adopter drift where the recipe claims capabilities the product
  // doesn't expose. Mirrors the AdCP wire pricing_model values
  // (lowercase) so `validateOverlapSubsetOfWire` accepts the recipe.
  const productPricingModels = new Set([product.pricing.model]);
  const productDeliveryTypes = new Set([product.delivery_type]);
  const recipe: GAMLikeRecipe = {
    recipe_kind: 'gam',
    network_code: product.network_code,
    ad_unit_ids: product.ad_unit_ids,
    line_item_priority: priority,
    pricing: {
      pricing_model: product.pricing.model === 'cpm' ? 'cpm' : 'cpv',
      rate: product.pricing.cpm,
      currency: product.pricing.currency,
    },
    delivery_type: product.delivery_type,
    capability_overlap: {
      pricingModels: productPricingModels,
      deliveryTypes: productDeliveryTypes,
      // Targeting dimensions are platform-wide (every product accepts
      // them); leave the wide set since validateOverlapSubsetOfWire
      // doesn't check targeting against per-product wire shape.
      targetingDimensions: GAM_LIKE_OVERLAP.targetingDimensions,
    },
  };
  if (options.availability_window) recipe.availability_window = options.availability_window;
  else if (product.availability?.start_date && product.availability?.end_date) {
    recipe.availability_window = {
      start_date: product.availability.start_date,
      end_date: product.availability.end_date,
      ...(product.availability.available_impressions !== undefined && {
        reserved_impressions: product.availability.available_impressions,
      }),
    };
  }
  if (product.pricing.min_spend !== undefined) recipe.min_spend = product.pricing.min_spend;
  if (options.upstream_ids) recipe.upstream_ids = options.upstream_ids;
  if (options.extensions) recipe.extensions = options.extensions;
  return recipe;
}
