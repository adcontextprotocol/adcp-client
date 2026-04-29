// Integration tests for first-class `comply_test_controller` wiring on
// `createAdcpServerFromPlatform`. Adopters declare `complyTest`
// adapters; the framework auto-registers the wire tool and projects
// `compliance_testing.scenarios` onto get_adcp_capabilities.

process.env.NODE_ENV = 'test';
process.env.ADCP_SANDBOX = '1'; // suppress the ungated-warning

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { PlatformConfigError } = require('../dist/lib/server/decisioning/runtime/validate-platform');

function basePlatform({ withComplianceTesting = false } = {}) {
  const capabilities = {
    specialisms: ['sales-non-guaranteed'],
    creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
    channels: ['display'],
    pricingModels: ['cpm'],
    config: {},
  };
  if (withComplianceTesting) capabilities.compliance_testing = {};

  return {
    capabilities,
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'comply_acc_1',
        operator: 'comply.example.com',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

describe('createAdcpServerFromPlatform — comply_test_controller wiring', () => {
  it('registers comply_test_controller when complyTest adapters are supplied', async () => {
    let forcedCreativeId = null;
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: true }), {
      name: 'comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest: {
        force: {
          creative_status: async params => {
            forcedCreativeId = params.creative_id;
            return {
              success: true,
              transition: 'forced',
              resource_type: 'creative',
              resource_id: params.creative_id,
              previous_state: 'pending_review',
              current_state: params.status,
            };
          },
        },
      },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: {
          scenario: 'force_creative_status',
          params: { creative_id: 'cr_42', status: 'approved' },
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(forcedCreativeId, 'cr_42');
    assert.strictEqual(result.structuredContent.success, true);
    assert.strictEqual(result.structuredContent.current_state, 'approved');
  });

  it('list_scenarios returns the auto-derived scenarios from supplied adapters', async () => {
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: true }), {
      name: 'comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest: {
        force: {
          creative_status: async () => ({
            success: true,
            transition: 'forced',
            resource_type: 'creative',
            resource_id: 'x',
            previous_state: 'a',
            current_state: 'b',
          }),
          media_buy_status: async () => ({
            success: true,
            transition: 'forced',
            resource_type: 'media_buy',
            resource_id: 'x',
            previous_state: 'a',
            current_state: 'b',
          }),
        },
        simulate: {
          delivery: async () => ({
            success: true,
            simulation: 'delivery',
            resource_type: 'media_buy',
            resource_id: 'mb_1',
          }),
        },
      },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: { scenario: 'list_scenarios' },
      },
    });

    assert.notStrictEqual(result.isError, true);
    const scenarios = result.structuredContent.scenarios;
    assert.ok(Array.isArray(scenarios), 'scenarios should be an array');
    assert.ok(scenarios.includes('force_creative_status'));
    assert.ok(scenarios.includes('force_media_buy_status'));
    assert.ok(scenarios.includes('simulate_delivery'));
    assert.ok(!scenarios.includes('force_account_status'), 'force_account_status was not declared');
    assert.ok(!scenarios.includes('seed_product'), 'seeds are intentionally not advertised per spec');
  });

  it('does not register comply_test_controller when complyTest is omitted', async () => {
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: false }), {
      name: 'no-comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    // Tool is not registered → dispatch throws synchronously.
    await assert.rejects(
      () =>
        server.dispatchTestRequest({
          method: 'tools/call',
          params: {
            name: 'comply_test_controller',
            arguments: { scenario: 'list_scenarios' },
          },
        }),
      /tool "comply_test_controller" is not registered/
    );
  });

  it('throws PlatformConfigError when capability is declared but complyTest adapters are missing', () => {
    assert.throws(
      () =>
        createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: true }), {
          name: 'broken-host',
          version: '0.0.1',
          validation: { requests: 'off', responses: 'off' },
          // complyTest deliberately omitted
        }),
      err =>
        err instanceof PlatformConfigError &&
        /compliance_testing is declared but opts.complyTest is missing/.test(err.message)
    );
  });

  it('throws PlatformConfigError when complyTest adapters are supplied but capability is undeclared', () => {
    assert.throws(
      () =>
        createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: false }), {
          name: 'broken-host',
          version: '0.0.1',
          validation: { requests: 'off', responses: 'off' },
          complyTest: {
            force: {
              creative_status: async () => ({
                success: true,
                transition: 'forced',
                resource_type: 'creative',
                resource_id: 'x',
                previous_state: 'a',
                current_state: 'b',
              }),
            },
          },
        }),
      err =>
        err instanceof PlatformConfigError &&
        /opts.complyTest is supplied but capabilities.compliance_testing is not declared/.test(err.message)
    );
  });

  it('sandboxGate denial returns FORBIDDEN', async () => {
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: true }), {
      name: 'gated-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest: {
        sandboxGate: () => false,
        force: {
          creative_status: async () => ({
            success: true,
            transition: 'forced',
            resource_type: 'creative',
            resource_id: 'x',
            previous_state: 'a',
            current_state: 'b',
          }),
        },
      },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: {
          scenario: 'force_creative_status',
          params: { creative_id: 'cr_42', status: 'approved' },
        },
      },
    });

    assert.strictEqual(result.structuredContent.success, false);
    assert.strictEqual(result.structuredContent.error, 'FORBIDDEN');
  });
});
