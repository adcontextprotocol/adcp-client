// Tests for the dedicated reporting_flow scenario

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('reporting_flow scenario wiring', () => {
  test('testReportingFlow is exported', () => {
    const { testReportingFlow } = require('../../dist/lib/testing/index.js');
    assert.strictEqual(typeof testReportingFlow, 'function');
  });

  test('reporting_flow is in SCENARIO_REQUIREMENTS', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    assert.ok('reporting_flow' in SCENARIO_REQUIREMENTS);
  });

  test('reporting_flow requires get_products, create_media_buy, and get_media_buy_delivery', () => {
    const { SCENARIO_REQUIREMENTS } = require('../../dist/lib/testing/index.js');
    const reqs = SCENARIO_REQUIREMENTS['reporting_flow'];
    assert.ok(Array.isArray(reqs), 'requirements should be an array');
    assert.ok(reqs.includes('get_products'), 'should require get_products');
    assert.ok(reqs.includes('create_media_buy'), 'should require create_media_buy');
    assert.ok(reqs.includes('get_media_buy_delivery'), 'should require get_media_buy_delivery');
  });

  test('reporting_flow is applicable when agent has required tools', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_products', 'create_media_buy', 'get_media_buy_delivery'];
    const applicable = getApplicableScenarios(tools, ['reporting_flow']);
    assert.ok(applicable.includes('reporting_flow'), 'reporting_flow should be applicable');
  });

  test('reporting_flow is not applicable without get_media_buy_delivery', () => {
    const { getApplicableScenarios } = require('../../dist/lib/testing/index.js');
    const tools = ['get_products', 'create_media_buy'];
    const applicable = getApplicableScenarios(tools, ['reporting_flow']);
    assert.ok(!applicable.includes('reporting_flow'), 'reporting_flow should not be applicable without delivery tool');
  });
});

describe('reporting track uses reporting_flow', () => {
  test('comply module exports comply function', () => {
    const { comply } = require('../../dist/lib/testing/compliance/index.js');
    assert.strictEqual(typeof comply, 'function');
  });
});
