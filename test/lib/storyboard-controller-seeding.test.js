/**
 * Pre-flight `comply_test_controller` seeding (adcp-client#778).
 *
 * Covers the runner glue between the spec's `fixtures:` block +
 * `prerequisites.controller_seeding: true` (adcontextprotocol/adcp#2585,
 * #2743) and the SDK's `seed_*` scenarios (adcontextprotocol/adcp#2584).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { buildSeedCalls, runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

// ────────────────────────────────────────────────────────────
// buildSeedCalls — pure translation from fixtures block to seed calls
// ────────────────────────────────────────────────────────────

describe('buildSeedCalls', () => {
  test('returns empty array for missing or empty fixtures', () => {
    assert.deepStrictEqual(buildSeedCalls(undefined), []);
    assert.deepStrictEqual(buildSeedCalls({}), []);
    assert.deepStrictEqual(buildSeedCalls({ products: [] }), []);
  });

  test('products → seed_product with product_id lifted into params and rest in fixture', () => {
    const calls = buildSeedCalls({
      products: [
        { product_id: 'sports_display_auction', delivery_type: 'non_guaranteed', channels: ['display'] },
        { product_id: 'outdoor_video_auction', delivery_type: 'non_guaranteed', channels: ['video'] },
      ],
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].scenario, 'seed_product');
    assert.deepStrictEqual(calls[0].params, {
      product_id: 'sports_display_auction',
      fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
    });
    assert.strictEqual(calls[1].params.product_id, 'outdoor_video_auction');
  });

  test('pricing_options → seed_pricing_option with product_id + pricing_option_id lifted', () => {
    const calls = buildSeedCalls({
      pricing_options: [
        {
          product_id: 'sports_display_auction',
          pricing_option_id: 'cpm_auction',
          pricing_model: 'cpm',
          floor_price: 5.0,
        },
      ],
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].scenario, 'seed_pricing_option');
    assert.deepStrictEqual(calls[0].params, {
      product_id: 'sports_display_auction',
      pricing_option_id: 'cpm_auction',
      fixture: { pricing_model: 'cpm', floor_price: 5.0 },
    });
  });

  test('creatives → seed_creative, plans → seed_plan, media_buys → seed_media_buy', () => {
    const calls = buildSeedCalls({
      creatives: [{ creative_id: 'cr-1', format_id: 'display_300x250' }],
      plans: [{ plan_id: 'plan-1', brand_domain: 'acme.example' }],
      media_buys: [{ media_buy_id: 'mb-1', status: 'pending_approval' }],
    });
    assert.strictEqual(calls.length, 3);
    const byScenario = Object.fromEntries(calls.map(c => [c.scenario, c]));
    assert.deepStrictEqual(byScenario.seed_creative.params, {
      creative_id: 'cr-1',
      fixture: { format_id: 'display_300x250' },
    });
    assert.deepStrictEqual(byScenario.seed_plan.params, {
      plan_id: 'plan-1',
      fixture: { brand_domain: 'acme.example' },
    });
    assert.deepStrictEqual(byScenario.seed_media_buy.params, {
      media_buy_id: 'mb-1',
      fixture: { status: 'pending_approval' },
    });
  });

  test('emits ordering: products → pricing_options → creatives → plans → media_buys', () => {
    const calls = buildSeedCalls({
      media_buys: [{ media_buy_id: 'mb-1' }],
      products: [{ product_id: 'p-1' }],
      creatives: [{ creative_id: 'c-1' }],
      plans: [{ plan_id: 'pl-1' }],
      pricing_options: [{ product_id: 'p-1', pricing_option_id: 'po-1' }],
    });
    assert.deepStrictEqual(
      calls.map(c => c.scenario),
      ['seed_product', 'seed_pricing_option', 'seed_creative', 'seed_plan', 'seed_media_buy']
    );
  });

  test('flags authoring error when a required id field is missing — seed is not issued', () => {
    const calls = buildSeedCalls({
      products: [{ delivery_type: 'non_guaranteed' }],
      pricing_options: [{ product_id: 'p-1' }],
      creatives: [{ format_id: 'x' }],
    });
    assert.strictEqual(calls.length, 3);
    assert.match(calls[0].authoring_error, /product_id/);
    assert.match(calls[1].authoring_error, /pricing_option_id/);
    assert.match(calls[2].authoring_error, /creative_id/);
  });
});

// ────────────────────────────────────────────────────────────
// runControllerSeeding — opt-out, no-op, success, failure
// ────────────────────────────────────────────────────────────

function makeMockClient(responder) {
  const calls = [];
  const client = {
    async executeTask(name, params) {
      calls.push({ name, params });
      return responder({ name, params });
    },
  };
  return { client, calls };
}

function successResponse() {
  return {
    success: true,
    data: {
      content: [
        { type: 'text', text: JSON.stringify({ success: true, previous_state: 'none', current_state: 'seeded' }) },
      ],
    },
  };
}

describe('runControllerSeeding', () => {
  const storyboardWithFixtures = {
    id: 'test_sb',
    version: '1.0',
    title: '',
    category: '',
    summary: '',
    narrative: '',
    agent: { interaction_model: '', capabilities: [] },
    caller: { role: '' },
    prerequisites: { description: '', controller_seeding: true },
    fixtures: {
      products: [{ product_id: 'p-1', delivery_type: 'guaranteed' }],
    },
    phases: [],
  };

  test('returns null when skip_controller_seeding opt-out is set', async () => {
    const { client, calls } = makeMockClient(successResponse);
    const result = await runControllerSeeding(client, storyboardWithFixtures, { skip_controller_seeding: true }, {});
    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 0);
  });

  test('returns null when prerequisites.controller_seeding is not true', async () => {
    const { client, calls } = makeMockClient(successResponse);
    const noDecl = { ...storyboardWithFixtures, prerequisites: { description: '' } };
    const result = await runControllerSeeding(client, noDecl, {}, {});
    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 0);
  });

  test('returns null when fixtures block is empty or absent', async () => {
    const { client, calls } = makeMockClient(successResponse);
    const noFixtures = { ...storyboardWithFixtures, fixtures: undefined };
    assert.strictEqual(await runControllerSeeding(client, noFixtures, {}, {}), null);
    const emptyFixtures = { ...storyboardWithFixtures, fixtures: {} };
    assert.strictEqual(await runControllerSeeding(client, emptyFixtures, {}, {}), null);
    assert.strictEqual(calls.length, 0);
  });

  test('happy path: issues one comply_test_controller call per fixture entry, all pass', async () => {
    const storyboard = {
      ...storyboardWithFixtures,
      fixtures: {
        products: [{ product_id: 'p-1' }, { product_id: 'p-2' }],
        creatives: [{ creative_id: 'cr-1' }],
      },
    };
    const { client, calls } = makeMockClient(successResponse);
    const result = await runControllerSeeding(client, storyboard, {}, {});
    assert.ok(result, 'seeding result should exist');
    assert.strictEqual(calls.length, 3);
    for (const call of calls) {
      assert.strictEqual(call.name, 'comply_test_controller');
      assert.match(String(call.params.scenario), /seed_/);
    }
    assert.strictEqual(result.allPassed, true);
    assert.strictEqual(result.passedCount, 3);
    assert.strictEqual(result.failedCount, 0);
    assert.strictEqual(result.phase.phase_id, '__controller_seeding__');
    assert.strictEqual(result.phase.steps.length, 3);
    for (const step of result.phase.steps) {
      assert.strictEqual(step.passed, true);
      assert.strictEqual(step.task, 'comply_test_controller');
    }
  });

  test('failure path: controller returns an error for one seed — phase fails, allPassed is false', async () => {
    const storyboard = {
      ...storyboardWithFixtures,
      fixtures: {
        products: [{ product_id: 'p-1' }, { product_id: 'p-broken' }],
      },
    };
    const { client } = makeMockClient(({ params }) => {
      if (params.params?.product_id === 'p-broken') {
        return {
          success: true,
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: 'INVALID_PARAMS', error_detail: 'bad fixture' }),
              },
            ],
          },
        };
      }
      return successResponse();
    });
    const result = await runControllerSeeding(client, storyboard, {}, {});
    assert.ok(result);
    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.passedCount, 1);
    assert.strictEqual(result.failedCount, 1);
    const failed = result.phase.steps.find(s => !s.passed);
    assert.ok(failed, 'one step must be failed');
    assert.match(failed.error, /INVALID_PARAMS/);
  });

  test('authoring errors (missing id) produce a failed step without issuing a controller call', async () => {
    const storyboard = {
      ...storyboardWithFixtures,
      fixtures: {
        products: [{ delivery_type: 'guaranteed' /* missing product_id */ }],
      },
    };
    const { client, calls } = makeMockClient(successResponse);
    const result = await runControllerSeeding(client, storyboard, {}, {});
    assert.strictEqual(calls.length, 0, 'no controller call when id is missing');
    assert.strictEqual(result.allPassed, false);
    assert.match(result.phase.steps[0].error, /product_id/);
  });
});

// ────────────────────────────────────────────────────────────
// runStoryboard — runner integration
// ────────────────────────────────────────────────────────────

describe('runStoryboard: controller seeding integration', () => {
  function makeRunnerClient(responder) {
    const calls = [];
    return {
      calls,
      client: {
        async executeTask(name, params) {
          calls.push({ name, params });
          return responder({ name, params });
        },
        async getAgentInfo() {
          return { name: 'Test', tools: [{ name: 'comply_test_controller' }, { name: 'get_products' }] };
        },
      },
    };
  }

  const baseStoryboard = {
    id: 'seed_runner_sb',
    version: '1.0.0',
    title: 'Seeding runner',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    prerequisites: { description: 'needs seeds', controller_seeding: true },
    fixtures: {
      products: [{ product_id: 'sports_display', delivery_type: 'non_guaranteed' }],
    },
    phases: [
      {
        id: 'discovery',
        title: 'discovery',
        steps: [
          {
            id: 'get_caps',
            title: 'get caps',
            task: 'get_products',
            sample_request: { brief: 'test' },
            validations: [],
          },
        ],
      },
    ],
  };

  test('fires seed_* calls before the first phase and prepends the seeding phase to phaseResults', async () => {
    const { client, calls } = makeRunnerClient(successResponse);
    const result = await runStoryboard('https://example.invalid/mcp', baseStoryboard, {
      protocol: 'mcp',
      allow_http: false,
      agentTools: ['comply_test_controller', 'get_products'],
      _profile: { name: 'Test', tools: ['comply_test_controller', 'get_products'] },
      _client: client,
    });

    const seedCalls = calls.filter(c => c.name === 'comply_test_controller');
    const productCalls = calls.filter(c => c.name === 'get_products');
    assert.strictEqual(seedCalls.length, 1, 'exactly one seed_product call');
    assert.strictEqual(seedCalls[0].params.scenario, 'seed_product');
    assert.strictEqual(seedCalls[0].params.params.product_id, 'sports_display');
    assert.ok(productCalls.length >= 1, 'real phase should run after seeding');

    const seedPhase = result.phases.find(p => p.phase_id === '__controller_seeding__');
    assert.ok(seedPhase, 'seeding phase must be in phaseResults');
    assert.strictEqual(result.phases[0].phase_id, '__controller_seeding__', 'seeding phase must be first');
  });

  test('seed failure cascade-skips every real phase with controller_seeding_failed', async () => {
    const { client, calls } = makeRunnerClient(({ name }) => {
      if (name === 'comply_test_controller') {
        return {
          success: true,
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: 'UNKNOWN_SCENARIO', error_detail: 'no seedProduct' }),
              },
            ],
          },
        };
      }
      return successResponse();
    });
    const result = await runStoryboard('https://example.invalid/mcp', baseStoryboard, {
      protocol: 'mcp',
      agentTools: ['comply_test_controller', 'get_products'],
      _profile: { name: 'Test', tools: ['comply_test_controller', 'get_products'] },
      _client: client,
    });

    assert.strictEqual(result.overall_passed, false);
    assert.ok(result.failed_count >= 1, 'seed failure must count as failed');
    const realPhaseCalls = calls.filter(c => c.name === 'get_products');
    assert.strictEqual(realPhaseCalls.length, 0, 'real phases must not run after seed failure');

    const realPhase = result.phases.find(p => p.phase_id === 'discovery');
    assert.ok(realPhase);
    for (const step of realPhase.steps) {
      assert.strictEqual(step.skipped, true, `step ${step.step_id} should be skipped`);
      // Detailed skip reason stays on the legacy field so report consumers
      // can distinguish setup break from stateful chain break.
      assert.strictEqual(step.skip_reason, 'controller_seeding_failed');
      // Canonical skip reason must be one of the six spec-required values —
      // controller_seeding_failed collapses to prerequisite_failed per
      // DETAILED_SKIP_TO_CANONICAL.
      assert.strictEqual(step.skip.reason, 'prerequisite_failed');
    }
  });

  test('agent missing comply_test_controller grades as not_applicable via missing_test_controller cascade', async () => {
    const { client, calls } = makeRunnerClient(successResponse);
    const result = await runStoryboard('https://example.invalid/mcp', baseStoryboard, {
      protocol: 'mcp',
      // agentTools does NOT include comply_test_controller — spec says
      // fixture_seed_unsupported grades not_applicable, not setup-failed.
      agentTools: ['get_products'],
      _profile: { name: 'Test', tools: ['get_products'] },
      _client: client,
    });

    // No MCP calls should be issued — the runner detected the missing tool
    // before firing any seed.
    const seedCalls = calls.filter(c => c.name === 'comply_test_controller');
    assert.strictEqual(seedCalls.length, 0, 'no seed calls when controller is missing');

    const seedPhase = result.phases.find(p => p.phase_id === '__controller_seeding__');
    assert.ok(seedPhase);
    for (const step of seedPhase.steps) {
      assert.strictEqual(step.skipped, true);
      assert.strictEqual(step.skip_reason, 'missing_test_controller');
      assert.strictEqual(step.skip.reason, 'missing_test_controller');
    }

    const realPhase = result.phases.find(p => p.phase_id === 'discovery');
    assert.ok(realPhase);
    for (const step of realPhase.steps) {
      assert.strictEqual(step.skipped, true);
      assert.strictEqual(step.skip_reason, 'missing_test_controller');
      assert.strictEqual(step.skip.reason, 'missing_test_controller');
    }
    // No failures — missing controller is a coverage gap, not a setup break.
    assert.strictEqual(result.failed_count, 0);
  });

  test('skip_controller_seeding opt-out bypasses seeding entirely — real phase still runs', async () => {
    const { client, calls } = makeRunnerClient(successResponse);
    const result = await runStoryboard('https://example.invalid/mcp', baseStoryboard, {
      protocol: 'mcp',
      agentTools: ['comply_test_controller', 'get_products'],
      _profile: { name: 'Test', tools: ['comply_test_controller', 'get_products'] },
      _client: client,
      skip_controller_seeding: true,
    });

    const seedCalls = calls.filter(c => c.name === 'comply_test_controller');
    assert.strictEqual(seedCalls.length, 0, 'opt-out must suppress seed calls');
    const seedPhase = result.phases.find(p => p.phase_id === '__controller_seeding__');
    assert.strictEqual(seedPhase, undefined, 'no seeding phase when opted out');
  });

  test('no-op when storyboard omits controller_seeding declaration', async () => {
    const storyboardNoDecl = {
      ...baseStoryboard,
      prerequisites: { description: 'no seeding needed' },
    };
    const { client, calls } = makeRunnerClient(successResponse);
    await runStoryboard('https://example.invalid/mcp', storyboardNoDecl, {
      protocol: 'mcp',
      agentTools: ['comply_test_controller', 'get_products'],
      _profile: { name: 'Test', tools: ['comply_test_controller', 'get_products'] },
      _client: client,
    });
    const seedCalls = calls.filter(c => c.name === 'comply_test_controller');
    assert.strictEqual(seedCalls.length, 0);
  });
});
