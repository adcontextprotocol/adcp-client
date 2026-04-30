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
        ctx_metadata: {},
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

  it('projects compliance_testing.scenarios onto get_adcp_capabilities', async () => {
    // Round-5 spike (training-agent): framework validates the
    // capability/adapter consistency but doesn't project scenarios onto
    // wire. Adopter sees compliance_testing: {} on get_adcp_capabilities
    // and the comply-track runner emits a warning on every call. Fix:
    // auto-derive scenarios from wired adapters and project via the
    // overrides seam.
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
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const ct = result.structuredContent?.compliance_testing;
    assert.ok(ct, `compliance_testing block missing from wire response: ${JSON.stringify(result.structuredContent)}`);
    assert.ok(Array.isArray(ct.scenarios), 'scenarios must be an array');
    assert.ok(ct.scenarios.includes('force_creative_status'));
    assert.ok(ct.scenarios.includes('force_media_buy_status'));
    assert.ok(ct.scenarios.includes('simulate_delivery'));
    assert.ok(!ct.scenarios.includes('force_account_status'), 'unwired scenario must not appear');
  });

  it('explicit capabilities.compliance_testing.scenarios overrides auto-derivation', async () => {
    const platform = basePlatform({ withComplianceTesting: true });
    // Adopter wires three adapters but only wants to advertise two.
    platform.capabilities.compliance_testing = {
      scenarios: ['force_creative_status', 'simulate_delivery'],
    };
    const server = createAdcpServerFromPlatform(platform, {
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
          // wired but not advertised
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
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    const scenarios = result.structuredContent?.compliance_testing?.scenarios;
    assert.deepStrictEqual(scenarios, ['force_creative_status', 'simulate_delivery']);
  });

  it('does NOT project compliance_testing block when capability + complyTest are both omitted', async () => {
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: false }), {
      name: 'no-comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    assert.strictEqual(result.structuredContent?.compliance_testing, undefined);
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

  it('F10: complyTest.inputSchema extends the canonical TOOL_INPUT_SHAPE', async () => {
    // Round-5 spike (training-agent): adopters routed through
    // createAdcpServerFromPlatform({ complyTest }) couldn't extend the
    // canonical schema with a top-level `account` field — the
    // documented `{ ...TOOL_INPUT_SHAPE, account: ... }` extension
    // pattern was unreachable through the v6 wiring path. The
    // inputSchema option is the seam.
    const { z } = require('zod');
    let receivedAccount = null;
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: true }), {
      name: 'comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest: {
        inputSchema: {
          // Extension: storyboard fixtures send a top-level `account`
          // (rather than `context.account`); the spec-canonical shape
          // strips it but adopters can opt in via this seam.
          account: z.object({ account_id: z.string() }).passthrough().optional(),
        },
        force: {
          creative_status: async params => {
            // The wrapper passes the raw input through; sandbox-gating
            // in the adopter would inspect input.account before this
            // adapter runs. Test asserts the schema accepts the field.
            receivedAccount = params.creative_id;
            return {
              success: true,
              transition: 'forced',
              resource_type: 'creative',
              resource_id: params.creative_id,
              previous_state: 'a',
              current_state: 'b',
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
          // Top-level account — the extension allows this without the
          // schema validator rejecting it as unknown.
          account: { account_id: 'acc_extension_test' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(receivedAccount, 'cr_42', 'force adapter ran with extended schema accepted');
    assert.strictEqual(result.structuredContent.success, true);
  });

  it('F14: complyTest.seed.creative_format slot wires through to seed_creative_format scenario', async () => {
    // Wire enum / scenario constant / TestControllerStore method already
    // existed; the domain-grouped façade just didn't expose a slot for
    // creative-format seeding. Adopters with v5 seed_creative_format
    // wired manually had to drop down to registerTestController; now
    // the v6 complyTest path covers it.
    const seeded = [];
    const server = createAdcpServerFromPlatform(basePlatform({ withComplianceTesting: true }), {
      name: 'comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest: {
        seed: {
          creative_format: async params => {
            seeded.push(params);
            return { success: true, seeded: 'fresh', resource_type: 'creative_format', resource_id: params.format_id };
          },
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'comply_test_controller',
        arguments: {
          scenario: 'seed_creative_format',
          params: {
            format_id: 'fmt_300x250',
            fixture: { width: 300, height: 250, format_type: 'image' },
          },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(seeded.length, 1);
    assert.strictEqual(seeded[0].format_id, 'fmt_300x250');
    assert.deepStrictEqual(seeded[0].fixture, { width: 300, height: 250, format_type: 'image' });
    assert.strictEqual(result.structuredContent.success, true);
  });
});
