/**
 * Tests for brand rights protocol scenarios and compliance track
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { SCENARIO_REQUIREMENTS, DEFAULT_SCENARIOS, getApplicableScenarios } = require('../../dist/lib/testing/index.js');

const { hasBrandRightsTools } = require('../../dist/lib/testing/scenarios/brand-rights.js');

const { TRACK_LABELS } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

// ============================================================
// SCENARIO_REQUIREMENTS for brand scenarios
// ============================================================

describe('brand scenario requirements', () => {
  test('brand_identity requires get_brand_identity', () => {
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['brand_identity'], ['get_brand_identity']);
  });

  test('brand_rights_flow requires get_rights and acquire_rights', () => {
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['brand_rights_flow'], ['get_rights', 'acquire_rights']);
  });

  test('creative_approval requires creative_approval', () => {
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['creative_approval'], ['creative_approval']);
  });
});

// ============================================================
// DEFAULT_SCENARIOS includes brand scenarios
// ============================================================

describe('brand scenarios in DEFAULT_SCENARIOS', () => {
  test('includes brand_identity', () => {
    assert.ok(DEFAULT_SCENARIOS.includes('brand_identity'));
  });

  test('includes brand_rights_flow', () => {
    assert.ok(DEFAULT_SCENARIOS.includes('brand_rights_flow'));
  });

  test('includes creative_approval', () => {
    assert.ok(DEFAULT_SCENARIOS.includes('creative_approval'));
  });
});

// ============================================================
// getApplicableScenarios with brand tools
// ============================================================

describe('getApplicableScenarios with brand tools', () => {
  test('get_brand_identity enables brand_identity', () => {
    const applicable = getApplicableScenarios(['get_brand_identity']);
    assert.ok(applicable.includes('brand_identity'));
    assert.ok(!applicable.includes('brand_rights_flow'));
    assert.ok(!applicable.includes('creative_approval'));
  });

  test('get_rights + acquire_rights enables brand_rights_flow', () => {
    const applicable = getApplicableScenarios(['get_rights', 'acquire_rights']);
    assert.ok(applicable.includes('brand_rights_flow'));
    assert.ok(!applicable.includes('brand_identity'));
  });

  test('creative_approval tool enables creative_approval scenario', () => {
    const applicable = getApplicableScenarios(['creative_approval']);
    assert.ok(applicable.includes('creative_approval'));
    assert.ok(!applicable.includes('brand_identity'));
    assert.ok(!applicable.includes('brand_rights_flow'));
  });

  test('all brand tools enables all brand scenarios', () => {
    const applicable = getApplicableScenarios([
      'get_brand_identity',
      'get_rights',
      'acquire_rights',
      'creative_approval',
    ]);
    assert.ok(applicable.includes('brand_identity'));
    assert.ok(applicable.includes('brand_rights_flow'));
    assert.ok(applicable.includes('creative_approval'));
  });

  test('empty tools does not enable any brand scenarios', () => {
    const applicable = getApplicableScenarios([]);
    assert.ok(!applicable.includes('brand_identity'));
    assert.ok(!applicable.includes('brand_rights_flow'));
    assert.ok(!applicable.includes('creative_approval'));
  });
});

// ============================================================
// hasBrandRightsTools
// ============================================================

describe('hasBrandRightsTools', () => {
  test('returns true when agent has get_brand_identity', () => {
    assert.strictEqual(hasBrandRightsTools(['get_brand_identity', 'get_products']), true);
  });

  test('returns true when agent has acquire_rights', () => {
    assert.strictEqual(hasBrandRightsTools(['acquire_rights']), true);
  });

  test('returns true when agent has get_rights', () => {
    assert.strictEqual(hasBrandRightsTools(['get_rights']), true);
  });

  test('returns false when agent has no brand tools', () => {
    assert.strictEqual(hasBrandRightsTools(['get_products', 'create_media_buy']), false);
  });

  test('returns false for empty tool list', () => {
    assert.strictEqual(hasBrandRightsTools([]), false);
  });
});

// ============================================================
// Brand compliance track
// ============================================================

describe('brand compliance track', () => {
  test('TRACK_LABELS includes brand', () => {
    assert.strictEqual(TRACK_LABELS['brand'], 'Brand Rights');
  });
});
