const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Also permits the exact same behavioral checks against an installed release.
const compiledRoot = process.env.ADCP_TEST_COMPILED_ROOT || path.resolve(__dirname, '../../dist');
const { runControllerSeeding } = require(path.join(compiledRoot, 'lib/testing/storyboard/seeding.js'));
const { parseStoryboard } = require(path.join(compiledRoot, 'lib/testing/storyboard/loader.js'));
const { buildRequest } = require(path.join(compiledRoot, 'lib/testing/storyboard/request-builder.js'));
const { applyBrandInvariant } = require(path.join(compiledRoot, 'lib/testing/storyboard/account-policy.js'));

const account = {
  brand: { domain: 'acmeoutdoor.example' },
  operator: 'pinnacle-agency.example',
  sandbox: true,
};
const scenarios = ['seed_product', 'seed_pricing_option'];

function storyboard(steps) {
  return {
    id: 'virtual-seed-scope',
    title: 'Virtual seed scope',
    version: '1.0.0',
    prerequisites: { controller_seeding: true },
    fixtures: {
      products: [{ product_id: 'scoped-product', channels: ['display'] }],
      pricing_options: [
        { product_id: 'scoped-product', pricing_option_id: 'auction', pricing_model: 'cpm', currency: 'USD' },
      ],
    },
    phases: [{ id: 'exercise', title: 'Exercise', steps }],
  };
}

const realStep = (scope = account) => ({
  id: 'seller-request',
  title: 'Seller request',
  task: 'create_media_buy',
  sample_request: { account: scope },
});

function rateLimitStep(scope) {
  return {
    id: 'rate-limit',
    title: 'Rate-limit assertion',
    task: 'expect_rate_limit_not_replayed',
    ...(scope && {
      rate_limit_trip: {
        trip_target_task: 'create_media_buy',
        trip_target_sample_request: { account: scope },
        max_attempts: 50,
      },
    }),
  };
}

async function seed(source, context = {}) {
  const calls = [];
  const result = await runControllerSeeding(
    {
      async executeTask(task, input) {
        assert.equal(task, 'comply_test_controller');
        calls.push(structuredClone(input));
        return { success: true, data: { success: true } };
      },
    },
    source,
    {
      brand: account.brand,
      sandbox: true,
      adcpVersion: '3.0.25',
      agentTools: ['comply_test_controller'],
      _controllerCapabilities: { detected: true, scenarios },
    },
    context
  );
  return { result, calls };
}

test('a pure rate-limit assertion cannot synthesize a second catalog account from the run brand', async () => {
  const source = storyboard([realStep(), rateLimitStep()]);
  const before = structuredClone(source);
  const { result, calls } = await seed(source);
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.account, account);
  assert.deepEqual(source, before);
});

test('runner-only webhook metadata is not a seller account reference', async () => {
  const { result, calls } = await seed(
    storyboard([
      realStep(),
      {
        id: 'observe',
        title: 'Observe',
        task: 'expect_webhook',
        sample_request: { account: { ...account, operator: 'receiver.example' } },
      },
    ])
  );
  assert.equal(result.allPassed, true, JSON.stringify(result));
  for (const call of calls) assert.deepEqual(call.account, account);
});

test('accountless real validation and controller requests do not invent fixture ownership', async () => {
  const source = storyboard([
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `format-${i}`,
      title: 'Validate a format manifest',
      task: 'validate_input',
      sample_request: { targets: [{ kind: 'canonical', id: 'display_static' }] },
    })),
    {
      id: 'controller',
      title: 'Controller metadata',
      task: 'comply_test_controller',
      sample_request: { scenario: 'list_scenarios' },
    },
    {
      id: 'routing',
      title: 'Sandbox routing',
      task: 'comply_test_controller',
      sample_request: { account: { sandbox: true } },
    },
    realStep(),
  ]);
  const { result, calls } = await seed(source);
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.account, account);
});

test('mixed default buyer or product-validation accounts and authored scopes fail before catalog writes', async () => {
  for (const step of [
    { ...realStep(), sample_request: { packages: [{ product_id: 'scoped-product' }] } },
    {
      id: 'product-validation',
      title: 'Validate inventory',
      task: 'validate_input',
      sample_request: { targets: [{ kind: 'product', id: 'scoped-product' }] },
    },
    {
      id: 'custom-default',
      title: 'Unknown seller request',
      task: 'custom_seller_operation',
      sample_request: {},
    },
  ]) {
    const { result, calls } = await seed(storyboard([realStep(), step]));
    assert.equal(result.allPassed, false, JSON.stringify(result));
    assert.equal(calls.length, 0, 'a real default namespace must not seed a different authored account');
    assert.match(JSON.stringify(result), /multiple accounts/);
  }
});

test('context inputs selecting product validation preserve default-account ambiguity', async () => {
  const validation = {
    id: 'context-validation',
    title: 'Validate selected target',
    task: 'validate_input',
    sample_request: { targets: [{ kind: 'canonical', id: 'image' }] },
    context_inputs: [{ key: 'selected_targets', inject_at: 'targets' }],
  };
  const { result, calls } = await seed(storyboard([realStep(), validation]), {
    selected_targets: [{ kind: 'product', id: 'scoped-product' }],
  });
  assert.equal(result.allPassed, false, JSON.stringify(result));
  assert.equal(calls.length, 0);
  assert.match(JSON.stringify(result), /multiple accounts/);
});

test('mutating or unknown controller scenarios and context-selected seeds retain default-account ambiguity', async () => {
  for (const scenario of [
    'seed_product',
    'seed_pricing_option',
    'force_create_media_buy_arm',
    'simulate_delivery',
    'reset',
    'vendor_operation',
    undefined,
    '$context.unresolved_scenario',
  ]) {
    const controller = {
      id: 'authored-seed',
      title: 'Seed a catalog fixture',
      task: 'comply_test_controller',
      sample_request: { scenario },
    };
    const { result, calls } = await seed(storyboard([realStep(), controller]));
    assert.equal(result.allPassed, false, JSON.stringify(result));
    assert.equal(calls.length, 0);
    assert.match(JSON.stringify(result), /multiple accounts/);
  }
  const controller = {
    id: 'context-seed',
    title: 'Selected controller scenario',
    task: 'comply_test_controller',
    sample_request: { scenario: 'list_scenarios' },
    context_inputs: [{ key: 'selected_scenario', inject_at: 'scenario' }],
  };
  const { result, calls } = await seed(storyboard([realStep(), controller]), {
    selected_scenario: 'seed_product',
  });
  assert.equal(result.allPassed, false, JSON.stringify(result));
  assert.equal(calls.length, 0);
  assert.match(JSON.stringify(result), /multiple accounts/);
});

test('all-accountless real creation preserves the existing SDK default account for controller seeds', async () => {
  const step = {
    ...realStep(),
    sample_request: { packages: [{ product_id: 'scoped-product', pricing_option_id: 'auction', budget: 5000 }] },
  };
  const options = { brand: account.brand, sandbox: true };
  const built = applyBrandInvariant(buildRequest(step, {}, options), options, step.task);
  const { result, calls } = await seed(storyboard([step]));
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.deepEqual(built.account, { brand: account.brand, operator: account.brand.domain, sandbox: true });
  for (const call of calls) assert.deepEqual(call.account, built.account);
});

test('virtual-only metadata cannot override the existing empty-storyboard controller default', async () => {
  const empty = await seed(storyboard([]));
  const virtual = await seed(
    storyboard([
      {
        id: 'observe',
        title: 'Observe',
        task: 'expect_webhook',
        sample_request: { account: { ...account, operator: 'receiver.example' } },
      },
    ])
  );
  assert.equal(empty.result.allPassed, true);
  assert.equal(virtual.result.allPassed, true, JSON.stringify(virtual.result));
  assert.equal(virtual.calls.length, 2);
  for (const call of virtual.calls) assert.deepEqual(call.account, empty.calls[0].account);
  assert.deepEqual(virtual.calls[0].account, { brand: account.brand, operator: account.brand.domain, sandbox: true });
});

test('a rate-limit assertion contributes its actual nested seller account when it is the only request', async () => {
  const source = storyboard([rateLimitStep(account)]);
  const before = structuredClone(source);
  const { result, calls } = await seed(source);
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.account, account);
  assert.deepEqual(source, before);
});

test('conflicting actual rate-limit target and custom seller accounts still fail before catalog writes', async () => {
  const other = { ...account, operator: 'another-operator.example' };
  for (const second of [
    rateLimitStep(other),
    {
      id: 'custom',
      title: 'Custom seller request',
      task: 'expect_custom_seller_operation',
      sample_request: { account: other },
    },
  ]) {
    const { result, calls } = await seed(storyboard([realStep(), second]));
    assert.equal(result.allPassed, false, JSON.stringify(result));
    assert.equal(calls.length, 0, 'true account ambiguity must stop both product and pricing writes');
    assert.match(JSON.stringify(result), /multiple accounts/);
  }
});

test('the unmodified published frozen 3.0 idempotency corpus seeds one account with a run brand', async () => {
  const sourceBytes = readFileSync(path.resolve(compiledRoot, '../compliance/cache/3.0.25/universal/idempotency.yaml'));
  // The frozen 3.0.26 matrix uses these exact same authored bytes.
  assert.equal(
    createHash('sha256').update(sourceBytes).digest('hex'),
    '785bba2c398fa5f59ade18ec5c03056ba9f412141961a0b59b0e78f46647bd73',
    'this regression must exercise the untouched frozen 3.0.25/3.0.26 idempotency source'
  );
  const source = parseStoryboard(sourceBytes.toString('utf8'));
  assert.ok(source.phases.some(phase => phase.steps.some(step => step.task === 'expect_rate_limit_not_replayed')));
  const { result, calls } = await seed(source);
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.account, account);
});
