// Unit tests for v3 protocol testing scenarios
const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('v3 Scenario Exports', () => {
  test('testPropertyListFilters is exported from testing module', () => {
    const { testPropertyListFilters } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testPropertyListFilters, 'function', 'testPropertyListFilters should be a function');
  });

  test('testSIHandoff is exported from testing module', () => {
    const { testSIHandoff } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testSIHandoff, 'function', 'testSIHandoff should be a function');
  });

  test('testSchemaCompliance is exported from testing module', () => {
    const { testSchemaCompliance } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testSchemaCompliance, 'function', 'testSchemaCompliance should be a function');
  });

  test('new TestScenario values are in SCENARIO_REQUIREMENTS', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    assert.ok(
      'property_list_filters' in SCENARIO_REQUIREMENTS,
      'property_list_filters should be in SCENARIO_REQUIREMENTS'
    );
    assert.ok('si_handoff' in SCENARIO_REQUIREMENTS, 'si_handoff should be in SCENARIO_REQUIREMENTS');
    assert.ok('schema_compliance' in SCENARIO_REQUIREMENTS, 'schema_compliance should be in SCENARIO_REQUIREMENTS');
  });

  test('property_list_filters requires create_property_list and get_property_list', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['property_list_filters'];
    assert.ok(Array.isArray(reqs), 'should have requirements array');
    assert.ok(reqs.includes('create_property_list'), 'should require create_property_list');
    assert.ok(reqs.includes('get_property_list'), 'should require get_property_list');
  });

  test('si_handoff requires si_initiate_session and si_terminate_session', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['si_handoff'];
    assert.ok(Array.isArray(reqs), 'should have requirements array');
    assert.ok(reqs.includes('si_initiate_session'), 'should require si_initiate_session');
    assert.ok(reqs.includes('si_terminate_session'), 'should require si_terminate_session');
  });

  test('schema_compliance is protocol-wide (no tool prerequisite)', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['schema_compliance'];
    assert.ok(Array.isArray(reqs), 'should have requirements array');
    assert.strictEqual(reqs.length, 0, 'schema_compliance applies to any agent (branches internally on get_products vs get_signals)');
  });

  test('new scenarios are in DEFAULT_SCENARIOS', () => {
    const { DEFAULT_SCENARIOS } = require('../../dist/lib/testing/index.js');
    assert.ok(
      DEFAULT_SCENARIOS.includes('property_list_filters'),
      'property_list_filters should be in DEFAULT_SCENARIOS'
    );
    assert.ok(DEFAULT_SCENARIOS.includes('si_handoff'), 'si_handoff should be in DEFAULT_SCENARIOS');
    assert.ok(DEFAULT_SCENARIOS.includes('schema_compliance'), 'schema_compliance should be in DEFAULT_SCENARIOS');
  });
});

describe('getApplicableScenarios with v3 scenarios', () => {
  test('property_list_filters is included when both tools present', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['create_property_list', 'get_property_list', 'list_property_lists'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(applicable.includes('property_list_filters'), 'should include property_list_filters');
  });

  test('property_list_filters is excluded when get_property_list is missing', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['create_property_list'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(
      !applicable.includes('property_list_filters'),
      'should not include property_list_filters without get_property_list'
    );
  });

  test('si_handoff is included when both SI tools present', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['si_initiate_session', 'si_send_message', 'si_terminate_session'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(applicable.includes('si_handoff'), 'should include si_handoff');
  });

  test('si_handoff is excluded when si_terminate_session is missing', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['si_initiate_session', 'si_send_message'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(!applicable.includes('si_handoff'), 'should not include si_handoff without si_terminate_session');
  });

  test('schema_compliance is included for product-discovery agents', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_products', 'create_media_buy'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(applicable.includes('schema_compliance'), 'should include schema_compliance');
  });

  test('schema_compliance is included for signals-only agents (protocol-wide)', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_signals', 'activate_signal'];
    const applicable = getApplicableScenarios(tools);
    assert.ok(
      applicable.includes('schema_compliance'),
      'schema_compliance applies to any agent — scenario branches internally on get_products vs get_signals'
    );
  });
});

describe('testAgent routes new scenarios', () => {
  // Verify routing by checking that the compiled agent-tester has switch cases for new scenarios.
  // This avoids making network connections that interfere with --test-force-exit.

  test('compiled agent-tester has case for property_list_filters', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/agent-tester.js'), 'utf8');
    assert.ok(src.includes("'property_list_filters'"), 'agent-tester should route property_list_filters');
    assert.ok(src.includes('testPropertyListFilters'), 'agent-tester should call testPropertyListFilters');
  });

  test('compiled agent-tester has case for si_handoff', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/agent-tester.js'), 'utf8');
    assert.ok(src.includes("'si_handoff'"), 'agent-tester should route si_handoff');
    assert.ok(src.includes('testSIHandoff'), 'agent-tester should call testSIHandoff');
  });

  test('compiled agent-tester has case for schema_compliance', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/agent-tester.js'), 'utf8');
    assert.ok(src.includes("'schema_compliance'"), 'agent-tester should route schema_compliance');
    assert.ok(src.includes('testSchemaCompliance'), 'agent-tester should call testSchemaCompliance');
  });
});

describe('schema_compliance channel validation logic', () => {
  test('compiled schema-compliance module contains all 19 v3 channel enum values', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/schema-compliance.js'), 'utf8');

    // All 19 v3 channels must be present in the compiled module (as bare identifiers)
    const expectedChannels = [
      'display',
      'olv',
      'social',
      'search',
      'ctv',
      'linear_tv',
      'radio',
      'streaming_audio',
      'podcast',
      'dooh',
      'ooh',
      'print',
      'cinema',
      'email',
      'gaming',
      'retail_media',
      'influencer',
      'affiliate',
      'product_placement',
    ];
    for (const ch of expectedChannels) {
      assert.ok(src.includes(ch), `schema-compliance should include channel "${ch}"`);
    }

    // Known non-v3 values should NOT appear as channel names
    // Use word-boundary style check (surrounded by quotes or newlines in the Set literal)
    assert.ok(!src.includes('"native"') && !src.includes("'native'"), '"native" should not be in v3 channel set');
    assert.ok(!src.includes('"video"') && !src.includes("'video'"), '"video" should not be in v3 channel set');
  });

  test('schema_compliance branches on discovery tool', () => {
    // The compiled scenario must contain both discovery branches so it
    // applies to product-discovery and signals-only agents alike.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../../dist/lib/testing/scenarios/schema-compliance.js'), 'utf8');
    assert.ok(src.includes('get_products'), 'schema-compliance should have a get_products branch');
    assert.ok(src.includes('get_signals'), 'schema-compliance should have a get_signals branch');
  });
});

describe('SI termination reason fix', () => {
  test('si_session_lifecycle uses user_exit not user_ended', () => {
    // Verify the fix by reading the compiled source
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../dist/lib/testing/scenarios/sponsored-intelligence.js'),
      'utf8'
    );
    assert.ok(!src.includes('"user_ended"'), 'should not use deprecated "user_ended" reason');
    assert.ok(!src.includes("'user_ended'"), 'should not use deprecated "user_ended" reason (single quotes)');
    assert.ok(src.includes('user_exit'), 'should use correct "user_exit" reason');
  });
});
