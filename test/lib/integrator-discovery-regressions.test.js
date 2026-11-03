const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding');

function exclude(data, validation = {}) {
  return runValidations(
    [
      {
        check: 'field_excludes',
        path: 'products[*].product_id',
        value: 'negative',
        description: 'Negative control excluded',
        ...validation,
      },
    ],
    {
      taskName: 'get_products',
      agentUrl: 'https://seller.example/mcp',
      contributions: new Set(),
      taskResult: { success: true, data },
    }
  )[0];
}

test('exclusion accepts any number/order of valid products, and rejects the negative control at every position', () => {
  assert.equal(exclude({ products: [] }).passed, true);
  assert.equal(exclude({ products: [{ product_id: 'a' }, { product_id: 'b' }] }).passed, true);
  for (const products of [
    [{ product_id: 'negative' }, { product_id: 'a' }],
    [{ product_id: 'a' }, { product_id: 'negative' }],
  ]) {
    const failed = exclude({ products });
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.expected, { excludes: 'negative' });
    assert.deepEqual(failed.actual, ['negative']);
  }
  assert.equal(
    exclude(
      { products: [{ id: 'negative', channels: ['display'], extra: true }] },
      { path: 'products[*]', value: { id: 'negative', channels: ['display'] } }
    ).passed,
    false
  );
  assert.equal(exclude({ products: [] }, { value: undefined }).passed, false);
  assert.equal(exclude({}, { path: undefined }).passed, false);
});

const scenarios = ['seed_account', 'seed_product', 'seed_pricing_option'];
function board(unit, floor) {
  const account = {
    brand: { domain: 'acmeoutdoor.example', countries: ['US', 'CA'] },
    operator: 'pinnacle-agency.example',
    operator_unit: { id: unit },
    currency: 'USD',
    timezone: 'America/New_York',
    sandbox: true,
  };
  return {
    id: unit,
    title: unit,
    version: '1',
    prerequisites: { controller_seeding: true },
    fixtures: {
      accounts: [{ account_id: `account-${unit}`, fixture: { ...account, status: 'active', billing: 'operator' } }],
      products: [{ product_id: 'shared-handle', channels: ['olv'] }],
      pricing_options: [
        {
          product_id: 'shared-handle',
          pricing_option_id: 'cpm',
          pricing_model: 'cpm',
          currency: 'USD',
          floor_price: floor,
        },
      ],
    },
    phases: [{ id: 'discovery', steps: [{ id: 'discover', task: 'get_products', sample_request: { account } }] }],
  };
}

test('automatic seeds preserve the public request account across consecutive storyboards in one process', async () => {
  const stores = new Map();
  const requests = [];
  const client = {
    async executeTask(tool, request) {
      requests.push(request);
      if (request.scenario === 'list_scenarios') return { success: true, data: { scenarios } };
      if (!['seed_product', 'seed_pricing_option'].includes(request.scenario))
        return { success: true, data: { success: true } };
      const key = JSON.stringify(request.account);
      if (!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key);
      if (request.scenario === 'seed_product') store.set(request.params.product_id, { ...request.params.fixture });
      if (request.scenario === 'seed_pricing_option')
        store.get(request.params.product_id).price = request.params.fixture.floor_price;
      return { success: true, data: { success: true } };
    },
  };
  const options = { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } };
  for (const [unit, floor] of [
    ['first', 5],
    ['second', 15],
  ]) {
    const storyboard = board(unit, floor);
    const result = await runControllerSeeding(client, storyboard, options, {});
    assert.equal(result.allPassed, true, JSON.stringify(result));
    for (const request of requests
      .filter(request => ['seed_product', 'seed_pricing_option'].includes(request.scenario))
      .slice(-2)) {
      assert.deepEqual(request.account, storyboard.phases[0].steps[0].sample_request.account);
    }
  }
  assert.equal(stores.size, 2);
  assert.deepEqual(
    [...stores.values()].map(store => store.get('shared-handle').price),
    [5, 15]
  );
});

test('routed and fixture-resolution seed calls retain the explicit context account', async () => {
  const storyboard = board('routed', 8);
  const context = { account: storyboard.phases[0].steps[0].sample_request.account };
  const requests = [];
  const client = {
    async executeTask(tool, request) {
      requests.push(request);
      return { success: true, data: { success: true, scenarios } };
    },
  };
  const options = { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } };
  const routed = await runControllerSeeding(client, storyboard, options, context, client, () => ({ client, options }));
  assert.equal(routed.allPassed, true);
  assert.ok(
    requests
      .filter(request => ['seed_product', 'seed_pricing_option'].includes(request.scenario))
      .every(request => JSON.stringify(request.account) === JSON.stringify(context.account))
  );
  requests.length = 0;
  storyboard.fixture_resolution = {
    products: [{ handle: 'shared-handle', strategies: ['seed'] }],
    pricing_options: [{ product_handle: 'shared-handle', handle: 'cpm', strategies: ['seed'] }],
  };
  const resolved = await runControllerSeeding(client, storyboard, options, context);
  assert.equal(resolved.allPassed, true, JSON.stringify(resolved));
  assert.ok(
    requests
      .filter(request => ['seed_product', 'seed_pricing_option'].includes(request.scenario))
      .every(request => JSON.stringify(request.account) === JSON.stringify(context.account))
  );
});

test('exclusion observes every wildcard terminal past the diagnostic collection cap', () => {
  const products = Array.from({ length: 10_001 }, (_, i) => ({ product_id: `allowed-${i}` }));
  products[10_000].product_id = 'negative';
  const failed = exclude({ products });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.actual, ['negative']);
  assert.deepEqual(failed.expected, { excludes: 'negative' });
  products[10_000].product_id = 'allowed';
  assert.equal(exclude({ products }).passed, true);
  assert.equal(exclude({ groups: [{ products }] }, { path: 'groups[].products[*].product_id' }).passed, true);
});

test('exclusion uses contains matcher semantics for falsy values, subsets and allowed candidates', () => {
  for (const value of [null, false, 0, '']) {
    assert.equal(exclude({ products: [{ product_id: value }] }, { value }).passed, false);
  }
  assert.equal(
    exclude({ products: [{ product_id: 'blocked' }] }, { value: undefined, allowed_values: ['negative', 'blocked'] })
      .passed,
    false
  );
  assert.equal(
    exclude({ products: [{ product_id: 'safe' }] }, { allowed_values: ['negative', 'blocked'] }).passed,
    true
  );
  for (const validation of [
    { path: 3 },
    { path: 'products[nope]' },
    { path: 'products..id' },
    { path: 'x'.repeat(1025) },
    { path: '__proto__.id' },
    { value: undefined },
    { allowed_values: 'negative' },
  ])
    assert.equal(exclude({ products: [] }, validation).passed, false, JSON.stringify(validation));
});

test('seed account scope resolves dynamic complete references and does not mutate source identity', async () => {
  const storyboard = board('dynamic', 8);
  const account = structuredClone(storyboard.phases[0].steps[0].sample_request.account);
  storyboard.phases[0].steps[0].sample_request.account = '$context.seed_scope';
  const requests = [];
  const client = {
    async executeTask(tool, request) {
      requests.push(request);
      return { success: true, data: { success: true } };
    },
  };
  const options = { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } };
  const result = await runControllerSeeding(client, storyboard, options, { seed_scope: account });
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.ok(requests.length > 0);
  for (const request of requests.filter(request => ['seed_product', 'seed_pricing_option'].includes(request.scenario)))
    assert.deepEqual(request.account, account);
  assert.equal(storyboard.phases[0].steps[0].sample_request.account, '$context.seed_scope');
  assert.deepEqual(account, board('dynamic', 8).phases[0].steps[0].sample_request.account);

  requests.length = 0;
  const failed = await runControllerSeeding(client, storyboard, options, {});
  assert.equal(failed.allPassed, false);
  assert.equal(
    requests.filter(request => ['seed_product', 'seed_pricing_option'].includes(request.scenario)).length,
    0,
    'unresolved identity must not seed products in a default account'
  );
});

test('seeding preserves opaque account references and refuses ambiguous or live scopes', async () => {
  const options = { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } };
  for (const context of [{ account: { account_id: 'opaque-account' } }, {}]) {
    const storyboard = board('opaque', 8);
    storyboard.phases[0].steps[0].sample_request.account = { account_id: 'opaque-account' };
    const requests = [];
    const client = {
      async executeTask(tool, request) {
        requests.push(request);
        return { success: true, data: { success: true } };
      },
    };
    const result = await runControllerSeeding(client, storyboard, options, context);
    assert.equal(result.allPassed, true);
    for (const request of requests.filter(request =>
      ['seed_product', 'seed_pricing_option'].includes(request.scenario)
    ))
      assert.deepEqual(request.account, { account_id: 'opaque-account' });
  }
  for (const live of [false, true]) {
    const storyboard = board('unsafe', 8);
    const first = storyboard.phases[0].steps[0];
    if (live) first.sample_request.account.sandbox = false;
    else
      storyboard.phases[0].steps.push({
        ...first,
        id: 'another-account',
        sample_request: { account: { ...first.sample_request.account, operator: 'other.example' } },
      });
    let calls = 0;
    const client = {
      async executeTask(tool, request) {
        if (['seed_product', 'seed_pricing_option'].includes(request.scenario)) calls++;
        return { success: true, data: { success: true } };
      },
    };
    const result = await runControllerSeeding(client, storyboard, options, {});
    assert.equal(result.allPassed, false);
    assert.equal(calls, 0, 'ambiguous or live identity must fail before seed writes');
  }
});

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard');
function exclusionStoryboard() {
  return {
    id: 'native-exclusion',
    title: 'Native exclusion',
    version: '1.0',
    requires: ['field_excludes_runner'],
    context: { blocked_id: 'negative' },
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        steps: [
          {
            id: 'filter',
            title: 'Filter',
            task: 'get_products',
            stateful: true,
            contributes_to: 'discovered',
            sample_request: { buying_mode: 'brief', brief: 'Find inventory' },
            context_outputs: [{ key: 'blocked_id', path: 'override' }],
            validations: [
              {
                check: 'field_excludes',
                path: 'products[*].product_id',
                value: '$context.blocked_id',
                description: 'Exclude prior context value',
              },
            ],
          },
        ],
      },
      {
        id: 'dependent',
        title: 'Dependent',
        depends_on: ['discovery'],
        steps: [
          {
            id: 'consume',
            title: 'Consume',
            task: 'get_products',
            stateful: true,
            sample_request: { buying_mode: 'brief', brief: 'Use discovery' },
            validations: [{ check: 'field_present', path: 'products' }],
          },
        ],
      },
    ],
  };
}
function exclusionSeller(products) {
  const calls = [];
  const data = { products, override: 'seller-overridden-id' };
  return {
    calls,
    data,
    options: {
      protocol: 'mcp',
      agentTools: ['get_products'],
      _profile: { tools: ['get_products'] },
      _client: {
        resetContext() {},
        async getProducts(request) {
          calls.push(request);
          return { success: true, data: structuredClone(data) };
        },
      },
    },
  };
}

test('intrinsic exclusion gate executes and fails before context adoption or dependent phases', async () => {
  const source = exclusionStoryboard();
  const seller = exclusionSeller([{ product_id: 'allowed' }, { product_id: 'negative' }]);
  const result = await runStoryboard('https://seller.example/mcp', source, seller.options);
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 1);
  assert.equal(result.passed_count, 0);
  assert.equal(seller.calls.length, 1, 'failed exclusion gates dependent dispatch');
  const step = result.phases[0].steps[0];
  assert.equal(step.validations[0].check, 'field_excludes');
  assert.equal(step.validations[0].passed, false);
  assert.equal(step.validations[0].not_applicable, undefined);
  assert.deepEqual(step.validations[0].expected, { excludes: 'negative' });
  assert.equal(result.context.blocked_id, 'negative', 'current seller capture cannot rebind prior comparator');
  assert.equal(result.contributions?.includes('discovered') ?? false, false);
  assert.deepEqual(step.response, seller.data, 'validation preserves seller evidence');
  assert.deepEqual(source.requires, ['field_excludes_runner']);
});

test('native exclusions gate standalone steps and accept additional matching products', async () => {
  const source = exclusionStoryboard();
  const seller = exclusionSeller([{ product_id: 'allowed' }, { product_id: 'negative' }]);
  const failed = await runStoryboardStep('https://seller.example/mcp', source, 'filter', seller.options);
  assert.equal(failed.passed, false);
  assert.equal(failed.contributions?.includes('discovered') ?? false, false);
  assert.deepEqual(failed.validations[0].expected, { excludes: 'negative' });
  assert.deepEqual(failed.response, seller.data);
  const good = exclusionSeller([
    { product_id: 'extra', channels: ['display', 'olv'] },
    { product_id: 'allowed', channels: ['olv'] },
  ]);
  const result = await runStoryboard('https://seller.example/mcp', source, good.options);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.passed_count, 2);
  assert.equal(result.failed_count, 0);
  assert.equal(result.validations_not_applicable ?? 0, 0);
});

test('unresolved native exclusion comparators fail closed in full and standalone execution', async () => {
  for (const standalone of [false, true]) {
    const source = exclusionStoryboard();
    delete source.context.blocked_id;
    const seller = exclusionSeller([{ product_id: 'negative' }]);
    const result = standalone
      ? await runStoryboardStep('https://seller.example/mcp', source, 'filter', seller.options)
      : await runStoryboard('https://seller.example/mcp', source, seller.options);
    const step = standalone ? result : result.phases[0].steps[0];
    assert.equal(step.passed, false);
    assert.match(step.validations[0].error, /unresolved context reference/);
    assert.equal(seller.calls.length, 1);
  }
  assert.equal(exclude({}, { value: { id: '$context.missing' } }).passed, false);
});

test('seed scope uses a lone complete account fixture and ignores intentionally malformed negative requests', async () => {
  const source = board('fixture-scope', 8);
  const account = structuredClone(source.phases[0].steps[0].sample_request.account);
  source.phases[0].steps = [
    { id: 'missing-account', task: 'get_products', expect_error: true, sample_request: { account: null } },
  ];
  const calls = [];
  const client = {
    async executeTask(tool, request) {
      calls.push(request);
      return { success: true, data: { success: true } };
    },
  };
  const result = await runControllerSeeding(
    client,
    source,
    { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } },
    {}
  );
  assert.equal(result.allPassed, true);
  assert.ok(calls.length > 0);
  for (const call of calls.filter(call => ['seed_product', 'seed_pricing_option'].includes(call.scenario)))
    assert.deepEqual(call.account, { ...account, sandbox: true });
});

test('published AdCP 3.1 audience fixtures distinguish sandbox routing metadata from account identity', async () => {
  const path = require('node:path');
  const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader');
  const source = loadStoryboardFile(
    path.join(__dirname, '../../compliance/cache/3.1.31/protocols/media-buy/scenarios/audience_buy_flow.yaml')
  );
  const account = source.phases
    .flatMap(phase => phase.steps)
    .map(step => step.sample_request?.account)
    .find(value => value?.brand && value?.operator);
  assert.ok(account, 'real published scenario supplies a complete buyer account');
  const calls = [];
  const client = {
    async executeTask(tool, request) {
      calls.push(request);
      return { success: true, data: { success: true } };
    },
  };
  const result = await runControllerSeeding(
    client,
    source,
    { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } },
    {}
  );
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.ok(calls.length > 0);
  for (const call of calls.filter(call => ['seed_product', 'seed_pricing_option'].includes(call.scenario)))
    assert.deepEqual(call.account, { ...account, sandbox: true });
});

test('seed account enrichment can follow a resolved reference without rebinding its identity', async () => {
  const source = board('enriched', 8);
  const original = source.phases[0].steps[0].sample_request.account;
  source.phases[0].steps.push({
    id: 'timezone-echo',
    task: 'get_products',
    sample_request: { account: { ...original, timezone: '$context.account_timezone' } },
  });
  const calls = [];
  const client = {
    async executeTask(tool, request) {
      calls.push(request);
      return { success: true, data: { success: true } };
    },
  };
  const options = { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } };
  const result = await runControllerSeeding(client, source, options, {});
  assert.equal(result.allPassed, true, JSON.stringify(result));
  for (const call of calls.filter(call => ['seed_product', 'seed_pricing_option'].includes(call.scenario)))
    assert.deepEqual(call.account, original, 'resolved optional identity dimensions remain intact');
  calls.length = 0;
  source.phases[0].steps.shift();
  const failed = await runControllerSeeding(client, source, options, {});
  assert.equal(failed.allPassed, false, 'a future timezone alone cannot establish seed account scope');
  assert.equal(calls.filter(call => ['seed_product', 'seed_pricing_option'].includes(call.scenario)).length, 0);
});

test('current published core seller can seed before its later timezone capture', async () => {
  const path = require('node:path');
  const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader');
  const source = loadStoryboardFile(
    path.join(
      __dirname,
      '../../compliance/cache/' + require('../../dist/lib/version').ADCP_VERSION + '/protocols/media-buy/index.yaml'
    )
  );
  const calls = [];
  const client = {
    async executeTask(tool, request) {
      calls.push(request);
      return { success: true, data: { success: true } };
    },
  };
  const result = await runControllerSeeding(
    client,
    source,
    {
      agentTools: ['comply_test_controller'],
      _controllerCapabilities: {
        detected: true,
        scenarios: [
          ...scenarios,
          'seed_creative',
          'seed_creative_format',
          'seed_plan',
          'seed_media_buy',
          'seed_buyer_agent',
        ],
      },
    },
    {}
  );
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.ok(calls.length > 0);
  const scopes = new Set(
    calls
      .filter(call => ['seed_product', 'seed_pricing_option'].includes(call.scenario))
      .map(call => JSON.stringify(call.account))
  );
  assert.equal(scopes.size, 1);
});

test('product seeds follow the effective run brand and context input account used for discovery', async () => {
  for (const useContextInput of [false, true]) {
    const source = board('run-brand', 8);
    const sample = source.phases[0].steps[0];
    const intended = { ...sample.sample_request.account, operator_unit: { id: 'context-input' } };
    if (useContextInput) sample.context_inputs = [{ key: 'selected_account', inject_at: 'account' }];
    const calls = [];
    const result = await runStoryboard('https://seller.example/mcp', source, {
      brand: { domain: 'run-brand.example', countries: ['CA'] },
      context: { selected_account: intended },
      agentTools: ['comply_test_controller', 'get_products'],
      _profile: { tools: ['comply_test_controller', 'get_products'] },
      _controllerCapabilities: { detected: true, scenarios },
      _client: {
        resetContext() {},
        async executeTask(tool, request) {
          calls.push({ tool, request });
          return { success: true, data: { success: true } };
        },
        async getProducts(request) {
          calls.push({ tool: 'get_products', request });
          return { success: true, data: { products: [] } };
        },
      },
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    const discovery = calls.find(call => call.tool === 'get_products');
    assert.ok(discovery);
    assert.deepEqual(discovery.request.account.brand, { domain: 'run-brand.example', countries: ['CA'] });
    if (useContextInput) assert.deepEqual(discovery.request.account.operator_unit, { id: 'context-input' });
    for (const call of calls.filter(call => ['seed_product', 'seed_pricing_option'].includes(call.request.scenario))) {
      assert.deepEqual(call.request.account, discovery.request.account);
    }
    assert.equal(source.phases[0].steps[0].sample_request.account.brand.domain, 'acmeoutdoor.example');
  }
});

test('independent account provisioning seeds do not require a single catalog account scope', async () => {
  const source = board('many-accounts', 8);
  source.fixtures.accounts.push({
    account_id: 'second-account',
    fixture: { ...source.fixtures.accounts[0].fixture, operator: 'another-operator.example' },
  });
  delete source.fixtures.products;
  delete source.fixtures.pricing_options;
  source.phases = [{ id: 'accounts', steps: [{ id: 'list', task: 'list_accounts' }] }];
  const calls = [];
  const result = await runControllerSeeding(
    {
      async executeTask(tool, request) {
        calls.push(request);
        return { success: true, data: { success: true } };
      },
    },
    source,
    { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } },
    {}
  );
  assert.equal(result.allPassed, true);
  assert.deepEqual(
    calls.map(call => call.params.account_id),
    ['account-many-accounts', 'second-account']
  );
});

test('published frequency cap flow seeds its known natural key before capturing its seller account ID', async () => {
  const path = require('node:path');
  const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader');
  const source = loadStoryboardFile(
    path.join(
      __dirname,
      '../../compliance/cache/3.2.8/protocols/media-buy/scenarios/media_buy_frequency_cap_readback.yaml'
    )
  );
  const calls = [];
  const result = await runControllerSeeding(
    {
      async executeTask(tool, request) {
        calls.push(request);
        return { success: true, data: { success: true } };
      },
    },
    source,
    { agentTools: ['comply_test_controller'], _controllerCapabilities: { detected: true, scenarios } },
    {}
  );
  assert.equal(result.allPassed, true, JSON.stringify(result));
  assert.ok(calls.length > 0);
  for (const call of calls)
    assert.deepEqual(call.account, {
      brand: { domain: 'acmeoutdoor.example' },
      operator: 'pinnacle-agency.example',
      sandbox: true,
    });
});

test('an explicit seed account conflicting with the effective run brand fails before catalog writes or discovery', async () => {
  const source = board('explicit-context', 8);
  const calls = [];
  const result = await runStoryboard('https://seller.example/mcp', source, {
    brand: { domain: 'different-run-brand.example' },
    context: { account: source.phases[0].steps[0].sample_request.account },
    agentTools: ['comply_test_controller', 'get_products'],
    _profile: { tools: ['comply_test_controller', 'get_products'] },
    _controllerCapabilities: { detected: true, scenarios },
    _client: {
      resetContext() {},
      async executeTask(tool, request) {
        calls.push({ tool, request });
        return { success: true, data: { success: true } };
      },
      async getProducts(request) {
        calls.push({ tool: 'get_products', request });
        return { success: true, data: { products: [] } };
      },
    },
  });
  assert.equal(result.overall_passed, false);
  assert.equal(
    calls.filter(
      call => call.tool === 'get_products' || ['seed_product', 'seed_pricing_option'].includes(call.request.scenario)
    ).length,
    0
  );
  assert.ok(result.phases[0].steps.some(step => /conflicts with the run-scoped brand/.test(step.error ?? '')));
});
