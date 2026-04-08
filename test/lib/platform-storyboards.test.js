const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLATFORM_STORYBOARDS,
  getStoryboardIdsForPlatform,
  extractScenariosFromStoryboard,
  filterToKnownScenarios,
} = require('../../dist/lib/testing/compliance/platform-storyboards.js');

const { getAllPlatformTypes } = require('../../dist/lib/testing/compliance/profiles.js');
const { getStoryboardById, loadBundledStoryboards } = require('../../dist/lib/testing/storyboard/loader.js');

describe('PLATFORM_STORYBOARDS', () => {
  it('has an entry for every platform type', () => {
    const allTypes = getAllPlatformTypes();
    for (const type of allTypes) {
      assert.ok(
        Array.isArray(PLATFORM_STORYBOARDS[type]),
        `Missing PLATFORM_STORYBOARDS entry for ${type}`
      );
      assert.ok(
        PLATFORM_STORYBOARDS[type].length > 0,
        `PLATFORM_STORYBOARDS[${type}] is empty`
      );
    }
  });

  it('every storyboard ID resolves to a bundled storyboard', () => {
    const allTypes = getAllPlatformTypes();
    for (const type of allTypes) {
      for (const id of PLATFORM_STORYBOARDS[type]) {
        const sb = getStoryboardById(id);
        assert.ok(sb, `Storyboard "${id}" in PLATFORM_STORYBOARDS[${type}] not found in bundled storyboards`);
      }
    }
  });

  it('all storyboard IDs are unique within each platform type', () => {
    const allTypes = getAllPlatformTypes();
    for (const type of allTypes) {
      const ids = PLATFORM_STORYBOARDS[type];
      const unique = new Set(ids);
      assert.equal(unique.size, ids.length, `Duplicate storyboard IDs in PLATFORM_STORYBOARDS[${type}]`);
    }
  });

  it('sales platforms include schema_validation', () => {
    const salesTypes = [
      'display_ad_server', 'video_ad_server', 'social_platform',
      'search_platform', 'audio_platform', 'linear_tv_platform',
      'dsp', 'retail_media', 'pmax_platform',
    ];
    for (const type of salesTypes) {
      assert.ok(
        PLATFORM_STORYBOARDS[type].includes('schema_validation'),
        `${type} should include schema_validation`
      );
    }
  });

  it('si_platform includes si_session', () => {
    assert.ok(PLATFORM_STORYBOARDS.si_platform.includes('si_session'));
  });

  it('creative platforms include their specific storyboard', () => {
    assert.ok(PLATFORM_STORYBOARDS.creative_transformer.includes('creative_template'));
    assert.ok(PLATFORM_STORYBOARDS.creative_library.includes('creative_template'));
    assert.ok(PLATFORM_STORYBOARDS.creative_ad_server.includes('creative_ad_server'));
  });
});

describe('getStoryboardIdsForPlatform', () => {
  it('returns storyboard IDs for a known platform type', () => {
    const ids = getStoryboardIdsForPlatform('display_ad_server');
    assert.ok(Array.isArray(ids));
    assert.ok(ids.length > 0);
    assert.ok(ids.includes('media_buy_seller'));
  });

  it('returns same result as direct mapping access', () => {
    const allTypes = getAllPlatformTypes();
    for (const type of allTypes) {
      assert.deepEqual(
        getStoryboardIdsForPlatform(type),
        PLATFORM_STORYBOARDS[type]
      );
    }
  });
});

describe('extractScenariosFromStoryboard', () => {
  it('extracts comply_scenario values from storyboard steps', () => {
    const sb = getStoryboardById('deterministic_testing');
    assert.ok(sb, 'deterministic_testing storyboard should exist');
    const scenarios = extractScenariosFromStoryboard(sb);
    assert.ok(Array.isArray(scenarios));
    assert.ok(scenarios.length > 0);
    // deterministic_testing has known comply_scenario values
    assert.ok(scenarios.includes('deterministic_account'));
  });

  it('returns deduplicated scenario names', () => {
    // Create a synthetic storyboard with duplicate comply_scenarios
    const sb = {
      id: 'test',
      version: '1.0.0',
      title: 'Test',
      category: 'test',
      summary: 'Test',
      narrative: 'Test',
      agent: { interaction_model: 'test', capabilities: [] },
      caller: { role: 'test' },
      phases: [{
        id: 'p1',
        title: 'Phase 1',
        steps: [
          { id: 's1', title: 'Step 1', task: 'get_products', comply_scenario: 'discovery' },
          { id: 's2', title: 'Step 2', task: 'get_products', comply_scenario: 'discovery' },
          { id: 's3', title: 'Step 3', task: 'create_media_buy', comply_scenario: 'create_media_buy' },
        ],
      }],
    };
    const scenarios = extractScenariosFromStoryboard(sb);
    assert.deepEqual(scenarios, ['discovery', 'create_media_buy']);
  });

  it('returns empty array for storyboard with no comply_scenario fields', () => {
    const sb = {
      id: 'test',
      version: '1.0.0',
      title: 'Test',
      category: 'test',
      summary: 'Test',
      narrative: 'Test',
      agent: { interaction_model: 'test', capabilities: [] },
      caller: { role: 'test' },
      phases: [{
        id: 'p1',
        title: 'Phase 1',
        steps: [
          { id: 's1', title: 'Step 1', task: 'get_products' },
        ],
      }],
    };
    const scenarios = extractScenariosFromStoryboard(sb);
    assert.deepEqual(scenarios, []);
  });
});

describe('filterToKnownScenarios', () => {
  it('keeps known scenario names', () => {
    const result = filterToKnownScenarios([
      'discovery',
      'creative_sync',
      'health_check',
    ]);
    assert.deepEqual(result, ['discovery', 'creative_sync', 'health_check']);
  });

  it('filters out unknown scenario names', () => {
    const result = filterToKnownScenarios([
      'discovery',
      'typo_scenario',
      'phantom_name',
      'creative_sync',
    ]);
    assert.deepEqual(result, ['discovery', 'creative_sync']);
  });

  it('returns empty array when all names are unknown', () => {
    const result = filterToKnownScenarios(['not_real', 'also_fake']);
    assert.deepEqual(result, []);
  });

  it('returns empty array for empty input', () => {
    const result = filterToKnownScenarios([]);
    assert.deepEqual(result, []);
  });

  it('includes deterministic scenarios', () => {
    const result = filterToKnownScenarios([
      'deterministic_media_buy',
      'deterministic_creative',
      'deterministic_account',
      'deterministic_session',
      'deterministic_delivery',
      'deterministic_budget',
      'controller_validation',
    ]);
    assert.equal(result.length, 7);
  });

  it('includes storyboard-specific comply_scenario values', () => {
    const result = filterToKnownScenarios([
      'account_setup',
      'audience_sync',
      'behavior_analysis',
      'governance_setup',
      'media_buy_flow',
    ]);
    assert.equal(result.length, 5);
  });
});

describe('storyboard option resolution', () => {
  it('all bundled compliance storyboards have a track field', () => {
    const all = loadBundledStoryboards().filter(sb => sb.track);
    assert.ok(all.length >= 20, `Expected at least 20 compliance storyboards, got ${all.length}`);
  });

  it('PLATFORM_STORYBOARDS storyboards are a subset of bundled storyboards', () => {
    const bundledIds = new Set(loadBundledStoryboards().map(sb => sb.id));
    const allTypes = getAllPlatformTypes();
    for (const type of allTypes) {
      for (const id of PLATFORM_STORYBOARDS[type]) {
        assert.ok(bundledIds.has(id), `${id} from PLATFORM_STORYBOARDS[${type}] not in bundled set`);
      }
    }
  });
});
