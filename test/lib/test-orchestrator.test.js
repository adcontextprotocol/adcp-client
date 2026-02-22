/**
 * Unit tests for the test suite orchestrator
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  getApplicableScenarios,
  testAllScenarios,
  SCENARIO_REQUIREMENTS,
  DEFAULT_SCENARIOS,
  formatSuiteResults,
  formatSuiteResultsJSON,
} = require('../../dist/lib/testing/index.js');

describe('SCENARIO_REQUIREMENTS', () => {
  test('is exported from /testing', () => {
    assert.ok(SCENARIO_REQUIREMENTS, 'should be exported');
    assert.strictEqual(typeof SCENARIO_REQUIREMENTS, 'object');
  });

  test('all values are arrays of strings', () => {
    for (const [scenario, tools] of Object.entries(SCENARIO_REQUIREMENTS)) {
      assert.ok(Array.isArray(tools), `${scenario} requirements should be an array`);
      for (const tool of tools) {
        assert.strictEqual(typeof tool, 'string', `${scenario}: tool name should be a string`);
      }
    }
  });

  test('does not include creative_reference (unimplemented)', () => {
    assert.ok(!('creative_reference' in SCENARIO_REQUIREMENTS), 'creative_reference should be omitted');
  });

  test('does not include sync_audiences (not wired into testAgent)', () => {
    assert.ok(!('sync_audiences' in SCENARIO_REQUIREMENTS), 'sync_audiences should be omitted');
  });

  test('health_check, discovery, capability_discovery require no tools', () => {
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['health_check'], []);
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['discovery'], []);
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['capability_discovery'], []);
  });

  test('create_media_buy requires get_products and create_media_buy', () => {
    assert.ok(SCENARIO_REQUIREMENTS['create_media_buy'].includes('get_products'));
    assert.ok(SCENARIO_REQUIREMENTS['create_media_buy'].includes('create_media_buy'));
  });

  test('creative_sync requires sync_creatives', () => {
    assert.ok(SCENARIO_REQUIREMENTS['creative_sync'].includes('sync_creatives'));
  });

  test('creative_flow requires build_creative', () => {
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['creative_flow'], ['build_creative']);
  });

  test('signals_flow requires get_signals', () => {
    assert.deepStrictEqual(SCENARIO_REQUIREMENTS['signals_flow'], ['get_signals']);
  });

  test('governance_property_lists requires create_property_list', () => {
    assert.ok(SCENARIO_REQUIREMENTS['governance_property_lists'].includes('create_property_list'));
  });

  test('governance_content_standards requires list_content_standards', () => {
    assert.ok(SCENARIO_REQUIREMENTS['governance_content_standards'].includes('list_content_standards'));
  });

  test('si_session_lifecycle requires si_initiate_session', () => {
    assert.ok(SCENARIO_REQUIREMENTS['si_session_lifecycle'].includes('si_initiate_session'));
  });

  test('si_availability requires si_get_offering', () => {
    assert.ok(SCENARIO_REQUIREMENTS['si_availability'].includes('si_get_offering'));
  });
});

describe('DEFAULT_SCENARIOS', () => {
  test('is exported from /testing', () => {
    assert.ok(DEFAULT_SCENARIOS, 'should be exported');
    assert.ok(Array.isArray(DEFAULT_SCENARIOS));
  });

  test('does not include creative_reference', () => {
    assert.ok(!DEFAULT_SCENARIOS.includes('creative_reference'));
  });

  test('does not include sync_audiences', () => {
    assert.ok(!DEFAULT_SCENARIOS.includes('sync_audiences'));
  });

  test('pricing_models is in SCENARIO_REQUIREMENTS but excluded from DEFAULT_SCENARIOS (deduplication)', () => {
    assert.ok('pricing_models' in SCENARIO_REQUIREMENTS, 'pricing_models should be in SCENARIO_REQUIREMENTS');
    assert.ok(!DEFAULT_SCENARIOS.includes('pricing_models'), 'pricing_models should not be in DEFAULT_SCENARIOS');
  });

  test('includes all always-applicable scenarios', () => {
    assert.ok(DEFAULT_SCENARIOS.includes('health_check'));
    assert.ok(DEFAULT_SCENARIOS.includes('discovery'));
    assert.ok(DEFAULT_SCENARIOS.includes('capability_discovery'));
  });

  test('includes governance and SI scenarios', () => {
    assert.ok(DEFAULT_SCENARIOS.includes('governance_property_lists'));
    assert.ok(DEFAULT_SCENARIOS.includes('governance_content_standards'));
    assert.ok(DEFAULT_SCENARIOS.includes('si_session_lifecycle'));
    assert.ok(DEFAULT_SCENARIOS.includes('si_availability'));
  });

  test('all DEFAULT_SCENARIOS have entries in SCENARIO_REQUIREMENTS', () => {
    for (const scenario of DEFAULT_SCENARIOS) {
      assert.ok(scenario in SCENARIO_REQUIREMENTS, `${scenario} should be in SCENARIO_REQUIREMENTS`);
    }
  });
});

describe('getApplicableScenarios', () => {
  test('is exported from /testing', () => {
    assert.strictEqual(typeof getApplicableScenarios, 'function');
  });

  test('with empty tools returns only always-applicable scenarios', () => {
    const applicable = getApplicableScenarios([]);
    assert.ok(applicable.includes('health_check'));
    assert.ok(applicable.includes('discovery'));
    assert.ok(applicable.includes('capability_discovery'));

    // Media buy scenarios should NOT be applicable
    assert.ok(!applicable.includes('create_media_buy'));
    assert.ok(!applicable.includes('full_sales_flow'));
    assert.ok(!applicable.includes('governance_property_lists'));
  });

  test('with get_products includes product-based scenarios', () => {
    const applicable = getApplicableScenarios(['get_products']);
    assert.ok(applicable.includes('pricing_edge_cases'));
    assert.ok(applicable.includes('error_handling'));
    assert.ok(applicable.includes('validation'));
    assert.ok(applicable.includes('behavior_analysis'));
    assert.ok(applicable.includes('response_consistency'));

    // create_media_buy still requires create_media_buy tool
    assert.ok(!applicable.includes('create_media_buy'));
  });

  test('with get_products + create_media_buy includes media buy scenarios', () => {
    const applicable = getApplicableScenarios(['get_products', 'create_media_buy']);
    assert.ok(applicable.includes('create_media_buy'));
    assert.ok(applicable.includes('full_sales_flow'));
    assert.ok(applicable.includes('creative_inline'));
    assert.ok(applicable.includes('temporal_validation'));

    // creative_sync still requires sync_creatives
    assert.ok(!applicable.includes('creative_sync'));
  });

  test('with sync_creatives also enables creative_sync', () => {
    const applicable = getApplicableScenarios(['get_products', 'create_media_buy', 'sync_creatives']);
    assert.ok(applicable.includes('creative_sync'));
  });

  test('with governance tools enables governance scenarios', () => {
    const applicable = getApplicableScenarios(['create_property_list', 'list_content_standards']);
    assert.ok(applicable.includes('governance_property_lists'));
    assert.ok(applicable.includes('governance_content_standards'));
  });

  test('with only create_property_list enables governance_property_lists but not content_standards', () => {
    const applicable = getApplicableScenarios(['create_property_list']);
    assert.ok(applicable.includes('governance_property_lists'));
    assert.ok(!applicable.includes('governance_content_standards'));
  });

  test('with SI tools enables SI scenarios', () => {
    const applicable = getApplicableScenarios(['si_get_offering', 'si_initiate_session']);
    assert.ok(applicable.includes('si_session_lifecycle'));
    assert.ok(applicable.includes('si_availability'));
  });

  test('with build_creative enables creative_flow', () => {
    const applicable = getApplicableScenarios(['build_creative']);
    assert.ok(applicable.includes('creative_flow'));
  });

  test('with get_signals enables signals_flow', () => {
    const applicable = getApplicableScenarios(['get_signals']);
    assert.ok(applicable.includes('signals_flow'));
  });

  test('scenario filter restricts which scenarios are considered', () => {
    const applicable = getApplicableScenarios(
      ['get_products', 'create_media_buy', 'get_signals'],
      ['health_check', 'signals_flow', 'create_media_buy']
    );
    assert.ok(applicable.includes('health_check'));
    assert.ok(applicable.includes('signals_flow'));
    assert.ok(applicable.includes('create_media_buy'));
    // Not in filter, even though tools present
    assert.ok(!applicable.includes('pricing_edge_cases'));
  });

  test('never returns creative_reference', () => {
    // Even with a full tool set
    const allTools = [
      'get_products', 'create_media_buy', 'update_media_buy', 'sync_creatives',
      'build_creative', 'preview_creative', 'get_signals', 'activate_signal',
      'create_property_list', 'list_content_standards', 'si_get_offering', 'si_initiate_session',
    ];
    const applicable = getApplicableScenarios(allTools);
    assert.ok(!applicable.includes('creative_reference'));
  });

  test('returns empty array when filter specifies only unimplemented scenarios', () => {
    const applicable = getApplicableScenarios(['get_products'], ['creative_reference']);
    assert.strictEqual(applicable.length, 0);
  });
});

describe('testAllScenarios', () => {
  test('is exported from /testing', () => {
    assert.strictEqual(typeof testAllScenarios, 'function');
  });
});

describe('formatSuiteResults', () => {
  test('is exported from /testing', () => {
    assert.strictEqual(typeof formatSuiteResults, 'function');
  });

  test('formats a passed suite correctly', () => {
    const suite = {
      agent_url: 'https://example.com/mcp/',
      agent_profile: { name: 'Test Agent', tools: ['get_products'] },
      scenarios_run: ['health_check', 'discovery'],
      scenarios_skipped: ['create_media_buy'],
      results: [
        { scenario: 'health_check', overall_passed: true, summary: '1 passed', total_duration_ms: 100 },
        { scenario: 'discovery', overall_passed: true, summary: '2 passed', total_duration_ms: 200 },
      ],
      overall_passed: true,
      passed_count: 2,
      failed_count: 0,
      total_duration_ms: 300,
      tested_at: '2025-01-01T00:00:00.000Z',
      dry_run: true,
    };

    const output = formatSuiteResults(suite);
    assert.ok(output.includes('✅'), 'should show pass emoji');
    assert.ok(output.includes('https://example.com/mcp/'), 'should include agent URL');
    assert.ok(output.includes('Test Agent'), 'should include agent name');
    assert.ok(output.includes('2 passed'), 'should show pass count');
    assert.ok(output.includes('create_media_buy'), 'should list skipped scenarios');
    assert.ok(output.includes('health_check'), 'should list run scenarios');
    assert.ok(output.includes('Dry Run'), 'should indicate dry run mode');
  });

  test('formats a failed suite correctly', () => {
    const suite = {
      agent_url: 'https://example.com/mcp/',
      agent_profile: { name: 'Test Agent', tools: [] },
      scenarios_run: ['health_check'],
      scenarios_skipped: [],
      results: [
        { scenario: 'health_check', overall_passed: false, summary: '1 failed', total_duration_ms: 50 },
      ],
      overall_passed: false,
      passed_count: 0,
      failed_count: 1,
      total_duration_ms: 50,
      tested_at: '2025-01-01T00:00:00.000Z',
      dry_run: true,
    };

    const output = formatSuiteResults(suite);
    assert.ok(output.includes('❌'), 'should show fail emoji');
    assert.ok(output.includes('0 passed, 1 failed'), 'should show counts');
  });

  test('formats a no-scenarios suite with distinct message', () => {
    const suite = {
      agent_url: 'https://example.com/mcp/',
      agent_profile: { name: 'Unknown', tools: [] },
      scenarios_run: [],
      scenarios_skipped: [],
      results: [],
      overall_passed: false,
      passed_count: 0,
      failed_count: 0,
      total_duration_ms: 100,
      tested_at: '2025-01-01T00:00:00.000Z',
      dry_run: true,
    };

    const output = formatSuiteResults(suite);
    assert.ok(output.includes('No applicable scenarios'), 'should distinguish from failure');
    assert.ok(!output.includes('0 passed, 0 failed'), 'should not show misleading counts');
  });
});

describe('formatSuiteResultsJSON', () => {
  test('is exported from /testing', () => {
    assert.strictEqual(typeof formatSuiteResultsJSON, 'function');
  });

  test('returns valid JSON', () => {
    const suite = {
      agent_url: 'https://example.com',
      agent_profile: { name: 'Agent', tools: [] },
      scenarios_run: [],
      scenarios_skipped: [],
      results: [],
      overall_passed: false,
      passed_count: 0,
      failed_count: 0,
      total_duration_ms: 0,
      tested_at: '2025-01-01T00:00:00.000Z',
      dry_run: true,
    };
    const json = formatSuiteResultsJSON(suite);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.agent_url, 'https://example.com');
    assert.deepStrictEqual(parsed.results, []);
  });
});
