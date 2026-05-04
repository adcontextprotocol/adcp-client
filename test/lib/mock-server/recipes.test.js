/**
 * Recipe-builder tests for the mock-server canonical Recipe shapes.
 * These shapes are the public contract hello adapters consume — both
 * the typed shape (`GAMLikeRecipe`, `KevelLikeRecipe`) and the builder
 * helpers that project upstream native products onto the recipes.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  buildGAMLikeRecipe,
  GAM_LIKE_OVERLAP,
  buildKevelLikeRecipe,
  KEVEL_LIKE_OVERLAP,
} = require('../../../dist/lib/mock-server/index.js');

// ---------------------------------------------------------------------------
// GAM-like recipe (sales-guaranteed)
// ---------------------------------------------------------------------------

test('buildGAMLikeRecipe: guaranteed product → recipe with priority 8 + locked-pricing slots', () => {
  const product = {
    product_id: 'sports_preroll_q2_guaranteed',
    name: 'Sports Preroll Q2',
    network_code: 'net_premium_us',
    delivery_type: 'guaranteed',
    channel: 'video',
    format_ids: ['video_30s'],
    ad_unit_ids: ['au_us_video_preroll'],
    pricing: { model: 'cpm', cpm: 35.0, currency: 'USD', min_spend: 25_000 },
    availability: {
      start_date: '2026-04-01',
      end_date: '2026-06-30',
      available_impressions: 50_000_000,
    },
  };
  const recipe = buildGAMLikeRecipe(product);
  assert.equal(recipe.recipe_kind, 'gam');
  assert.equal(recipe.network_code, 'net_premium_us');
  assert.deepStrictEqual(recipe.ad_unit_ids, ['au_us_video_preroll']);
  assert.equal(recipe.line_item_priority, 8, 'guaranteed default priority');
  assert.equal(recipe.delivery_type, 'guaranteed');
  assert.equal(recipe.pricing.pricing_model, 'CPM');
  assert.equal(recipe.pricing.rate, 35.0);
  assert.equal(recipe.pricing.currency, 'USD');
  assert.equal(recipe.min_spend, 25_000);
  assert.deepStrictEqual(recipe.availability_window, {
    start_date: '2026-04-01',
    end_date: '2026-06-30',
    reserved_impressions: 50_000_000,
  });
  assert.strictEqual(recipe.upstream_ids, undefined, 'pre-finalize: no upstream_ids');
  assert.equal(recipe.capability_overlap, GAM_LIKE_OVERLAP);
});

test('buildGAMLikeRecipe: non-guaranteed product → priority 12', () => {
  const product = {
    product_id: 'display_run_of_site',
    name: 'Display ROS',
    network_code: 'net_premium_us',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_300x250'],
    ad_unit_ids: ['au_us_display_300x250'],
    pricing: { model: 'cpm', cpm: 4.5, currency: 'USD' },
  };
  const recipe = buildGAMLikeRecipe(product);
  assert.equal(recipe.line_item_priority, 12);
  assert.equal(recipe.delivery_type, 'non_guaranteed');
  assert.strictEqual(recipe.availability_window, undefined, 'no inventory window without availability data');
  assert.strictEqual(recipe.min_spend, undefined);
});

test('buildGAMLikeRecipe: post-finalize population via upstream_ids option', () => {
  const product = {
    product_id: 'p1',
    name: 'P1',
    network_code: 'net_x',
    delivery_type: 'guaranteed',
    channel: 'video',
    format_ids: ['video_30s'],
    ad_unit_ids: ['au_x'],
    pricing: { model: 'cpm', cpm: 20, currency: 'USD' },
  };
  const recipe = buildGAMLikeRecipe(product, {
    upstream_ids: { proposal_id: 'prop_abc', line_item_template_id: 'lit_xyz' },
  });
  assert.deepStrictEqual(recipe.upstream_ids, {
    proposal_id: 'prop_abc',
    line_item_template_id: 'lit_xyz',
  });
});

test('GAM_LIKE_OVERLAP advertises the guaranteed-friendly capability set', () => {
  assert.ok(GAM_LIKE_OVERLAP.pricingModels.has('CPM'));
  assert.ok(GAM_LIKE_OVERLAP.pricingModels.has('CPV'));
  assert.ok(GAM_LIKE_OVERLAP.deliveryTypes.has('guaranteed'));
  assert.ok(GAM_LIKE_OVERLAP.deliveryTypes.has('non_guaranteed'));
  assert.ok(GAM_LIKE_OVERLAP.targetingDimensions.has('audience'));
});

// ---------------------------------------------------------------------------
// Kevel-like recipe (sales-non-guaranteed)
// ---------------------------------------------------------------------------

test('buildKevelLikeRecipe: floor-priced product → recipe with weight 5 + impressions goal', () => {
  const product = {
    product_id: 'display_medrec_remnant',
    name: 'Display Medrec Remnant',
    network_code: 'net_remnant_us',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_300x250'],
    ad_unit_ids: ['au_us_display_medrec'],
    pricing: { min_cpm: 1.5, target_cpm: 2.25, currency: 'USD' },
  };
  const recipe = buildKevelLikeRecipe(product);
  assert.equal(recipe.recipe_kind, 'kevel');
  assert.equal(recipe.network_code, 'net_remnant_us');
  assert.deepStrictEqual(recipe.zone_ids, ['au_us_display_medrec']);
  assert.equal(recipe.weight, 5, 'default weight');
  assert.equal(recipe.goal_type, 'impressions', 'default goal');
  assert.equal(recipe.pricing.floor_cpm, 1.5);
  assert.equal(recipe.pricing.target_cpm, 2.25);
  assert.equal(recipe.pricing.currency, 'USD');
  assert.equal(recipe.capability_overlap, KEVEL_LIKE_OVERLAP);
  assert.strictEqual(recipe.upstream_ids, undefined);
});

test('buildKevelLikeRecipe: omits target_cpm when absent + threads min_spend', () => {
  const product = {
    product_id: 'p',
    name: 'P',
    network_code: 'net',
    delivery_type: 'non_guaranteed',
    channel: 'video',
    format_ids: ['video_15s'],
    ad_unit_ids: ['au_x'],
    pricing: { min_cpm: 8, currency: 'USD', min_spend: 1000 },
  };
  const recipe = buildKevelLikeRecipe(product, { weight: 9, goal_type: 'spend' });
  assert.strictEqual(recipe.pricing.target_cpm, undefined);
  assert.equal(recipe.weight, 9);
  assert.equal(recipe.goal_type, 'spend');
  assert.equal(recipe.min_spend, 1000);
});

test('KEVEL_LIKE_OVERLAP advertises the auction-remnant capability set', () => {
  assert.ok(KEVEL_LIKE_OVERLAP.pricingModels.has('CPM'));
  assert.ok(!KEVEL_LIKE_OVERLAP.pricingModels.has('CPV'), 'auction remnant is CPM-only');
  assert.ok(KEVEL_LIKE_OVERLAP.deliveryTypes.has('non_guaranteed'));
  assert.ok(!KEVEL_LIKE_OVERLAP.deliveryTypes.has('guaranteed'));
  assert.ok(!KEVEL_LIKE_OVERLAP.targetingDimensions.has('audience'), 'no audience axis on remnant');
});
