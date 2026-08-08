const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  applyFixtureBindingsToRequest,
  FixtureBindingRegistry,
  matchesFixtureRequirements,
  normalizeFixtureMatchExpression,
  validateFixtureResolutionDeclarations,
} = require('../../dist/lib/testing/storyboard/fixture-resolution');
const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');
const { getRequestSchemaEntityPaths } = require('../../dist/lib/validation/schema-loader');
const { createTestProduct } = require('./test-fixtures');

function storyboard(products, pricingOptions, fixtureResolution) {
  return {
    id: 'fixture-resolution',
    version: '3.2.0',
    title: 'Fixture resolution',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    prerequisites: { description: '', controller_seeding: true },
    fixtures: { products, pricing_options: pricingOptions },
    fixture_resolution: fixtureResolution,
    phases: [],
  };
}

function discoveryClient(products) {
  const calls = [];
  return {
    calls,
    client: {
      async executeTask(name, params) {
        calls.push({ name, params });
        if (name === 'get_products') return { success: true, data: { products, cache_scope: 'public' } };
        throw new Error(`unexpected ${name}`);
      },
    },
  };
}

describe('fixture resolution declarations and matching', () => {
  test('parses and resolves the 3.2 pilot match declarations', async () => {
    const parsed = parseStoryboard(`
id: fixture-resolution-pilot
version: 3.2.0
title: Fixture resolution pilot
category: sales_non_guaranteed
summary: Resolve seller-owned identifiers
narrative: Resolve authored handles before running the storyboard.
agent:
  interaction_model: transactional
  capabilities: []
caller:
  role: buyer_agent
prerequisites:
  description: Seller catalog is discoverable.
  controller_seeding: false
fixtures:
  products:
    - product_id: usd-display
  pricing_options:
    - product_id: usd-display
      pricing_option_id: usd-cpm
fixture_resolution:
  products:
    - handle: usd-display
      strategies: [discover]
      match:
        - path: /delivery_type
          operator: equals
          value: non_guaranteed
        - path: /inventory/source
          operator: present
  pricing_options:
    - handle: usd-cpm
      product_handle: usd-display
      strategies: [discover]
      match:
        - path: /currency
          operator: equals
          value: USD
phases:
  - id: buy
    title: Create a media buy
    steps:
      - id: create
        title: Create
        task: create_media_buy
        sample_request:
          account:
            brand: { domain: buyer.example }
            operator: operator.example
          brand: { domain: buyer.example }
          start_time: asap
          end_time: 2099-01-01T00:00:00Z
          packages:
            - product_id: usd-display
              pricing_option_id: usd-cpm
              budget: 100
        validations: []
`);
    assert.equal(parsed.fixture_resolution.products[0].handle, 'usd-display');
    assert.equal(parsed.fixture_resolution.products[0].match[0].path, '/delivery_type');
    assert.deepEqual(parsed.fixture_resolution.products[0].match[1], {
      path: '/inventory/source',
      operator: 'present',
    });
    assert.equal(parsed.fixture_resolution.pricing_options[0].match[0].path, '/currency');

    const pilotCalls = [];
    const pilotProduct = createTestProduct({
      product_id: 'seller-display',
      delivery_type: 'non_guaranteed',
      inventory: { source: 'publisher' },
      pricing_options: [
        { pricing_option_id: 'seller-cpm', pricing_model: 'cpm', floor_price: 2, currency: 'USD', is_fixed: false },
      ],
    });
    const pilotResult = await runStoryboard('https://example.invalid/mcp', parsed, {
      protocol: 'mcp',
      agentTools: ['get_products', 'create_media_buy'],
      _profile: { name: 'Pilot seller', tools: ['get_products', 'create_media_buy'] },
      _client: {
        async executeTask(name, params) {
          pilotCalls.push({ name, params });
          if (name === 'get_products') {
            return { success: true, data: { products: [pilotProduct], cache_scope: 'public' } };
          }
          if (name === 'create_media_buy') return { success: true, data: {} };
          throw new Error(`unexpected ${name}`);
        },
      },
    });
    assert.deepEqual(
      pilotResult.fixture_resolutions.map(record => record.status),
      ['resolved', 'resolved']
    );
    const pilotBuy = pilotCalls.find(call => call.name === 'create_media_buy');
    assert.equal(pilotBuy.params.packages[0].product_id, 'seller-display');
    assert.equal(pilotBuy.params.packages[0].pricing_option_id, 'seller-cpm');

    const clauses = normalizeFixtureMatchExpression(
      [
        { path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' },
        { path: '/channels', operator: 'contains_all', value: ['display'] },
        {
          path: '/pricing_options',
          operator: 'any_match',
          where: [{ path: '/currency', operator: 'equals', value: 'USD' }],
        },
        { path: '/source', operator: 'present' },
        { path: '/escaped~1key/~0value', operator: 'equals', value: 42 },
        { path: '/items/0/id', operator: 'equals', value: 'first' },
      ],
      'where'
    );
    assert.equal(clauses.length, 6);
    assert.equal(
      matchesFixtureRequirements(
        {
          delivery_type: 'non_guaranteed',
          channels: ['video', 'display'],
          pricing_options: [{ currency: 'EUR' }, { currency: 'USD' }],
          source: 'publisher',
          'escaped/key': { '~value': 42 },
          items: [{ id: 'first' }],
        },
        clauses
      ),
      true
    );
    assert.equal(matchesFixtureRequirements({ nullable: null }, [{ path: '/nullable', operator: 'present' }]), false);
    assert.equal(matchesFixtureRequirements({}, [{ path: '/missing', operator: 'present' }]), false);
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: 'currency', operator: 'equals', value: 'USD' }], 'where'),
      /RFC 6901/
    );
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: '/currency', operator: 'regex', value: 'USD' }], 'where'),
      /operator: must be one of/
    );
    for (const path of ['/bad~2escape', '/trailing~']) {
      assert.throws(
        () => normalizeFixtureMatchExpression([{ path, operator: 'equals', value: true }], 'where'),
        /invalid RFC 6901 escape/
      );
    }
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: '/currency', operator: 'present', value: true }], 'match'),
      /not allowed for present/
    );
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: '/currency', operator: 'present', where: [] }], 'match'),
      /only allowed for any_match/
    );
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: '/pricing_options', operator: 'any_match', match: [] }], 'match'),
      /unknown key\(s\): match/
    );
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: '/pricing_options', operator: 'any_match' }], 'match'),
      /where: is required/
    );
    assert.throws(
      () =>
        normalizeFixtureMatchExpression(
          [{ path: '/pricing_options', operator: 'any_match', value: [], where: [] }],
          'match'
        ),
      /value: is not allowed/
    );
  });

  test('rejects declaration-level where because nested any_match owns that key', () => {
    const value = storyboard([{ product_id: 'handle' }], [], {
      products: [
        {
          handle: 'handle',
          strategies: ['discover'],
          where: [{ path: '/currency', operator: 'equals', value: 'USD' }],
        },
      ],
    });
    assert.throws(() => validateFixtureResolutionDeclarations(value), /unknown key\(s\): where/);
  });

  test('rejects malformed or orphaned declarations as authoring errors', () => {
    const value = storyboard([{ product_id: 'handle' }], [], {
      products: [
        {
          handle: 'missing',
          strategies: ['discover'],
          match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
        },
      ],
    });
    assert.throws(() => validateFixtureResolutionDeclarations(value), /no matching fixtures\.products handle/);
  });

  test('rejects duplicate product and same-parent pricing declarations', () => {
    const value = storyboard([{ product_id: 'product' }], [{ product_id: 'product', pricing_option_id: 'price' }], {
      products: [
        { handle: 'product', strategies: ['seed'] },
        { handle: 'product', strategies: ['seed'] },
      ],
      pricing_options: [
        { handle: 'price', product_handle: 'product', strategies: ['seed'] },
        { handle: 'price', product_handle: 'product', strategies: ['seed'] },
      ],
    });
    assert.throws(() => validateFixtureResolutionDeclarations(value), /duplicate product handle/);
    value.fixture_resolution.products.pop();
    assert.throws(() => validateFixtureResolutionDeclarations(value), /duplicate pricing-option handle/);
  });

  test('rejects malformed canonical-format selectors and does not fall back from an explicit missing path', () => {
    assert.throws(
      () =>
        normalizeFixtureMatchExpression(
          [{ path: '', operator: 'canonical_format_satisfies', value: { params: { width: 300 } } }],
          'where'
        ),
      /format_kind/
    );
    const clauses = normalizeFixtureMatchExpression(
      [{ path: '/missing', operator: 'canonical_format_satisfies', value: { format_kind: 'display' } }],
      'where'
    );
    assert.equal(matchesFixtureRequirements({ format_kind: 'display' }, clauses), false);
  });
});

describe('schema-annotated handle substitution', () => {
  test('substitutes exact create_media_buy product/pricing handles and not substrings', () => {
    const bindings = new FixtureBindingRegistry();
    bindings.bindProduct('product-handle', 'seller-product');
    bindings.bindPricingOption('product-handle', 'price-handle', 'seller-price');
    const request = {
      packages: [
        { product_id: 'product-handle', pricing_option_id: 'price-handle' },
        { product_id: 'prefix-product-handle', pricing_option_id: 'price-handle-suffix' },
      ],
    };
    const result = applyFixtureBindingsToRequest(request, 'create_media_buy', bindings);
    assert.deepEqual(result.packages[0], { product_id: 'seller-product', pricing_option_id: 'seller-price' });
    assert.deepEqual(result.packages[1], request.packages[1]);
    assert.notStrictEqual(result, request);
    assert.ok(
      getRequestSchemaEntityPaths('create_media_buy').some(
        item => item.xEntity === 'product' && item.path.join('.') === 'packages.*.product_id'
      )
    );
  });

  test('scopes identical pricing handles by parent product and rejects ambiguity without a scope', () => {
    const bindings = new FixtureBindingRegistry();
    bindings.bindProduct('left', 'seller-left');
    bindings.bindProduct('right', 'seller-right');
    bindings.bindPricingOption('left', 'cpm', 'left-cpm');
    bindings.bindPricingOption('right', 'cpm', 'right-cpm');
    const result = applyFixtureBindingsToRequest(
      {
        packages: [
          { product_id: 'left', pricing_option_id: 'cpm' },
          { product_id: 'right', pricing_option_id: 'cpm' },
        ],
      },
      'synthetic',
      bindings,
      '3.2.0',
      [
        { path: ['packages', '*', 'pricing_option_id'], xEntity: 'product_pricing_option' },
        { path: ['packages', '*', 'product_id'], xEntity: 'product' },
      ]
    );
    assert.deepEqual(result.packages, [
      { product_id: 'seller-left', pricing_option_id: 'left-cpm' },
      { product_id: 'seller-right', pricing_option_id: 'right-cpm' },
    ]);
    assert.throws(
      () =>
        applyFixtureBindingsToRequest({ pricing_option_id: 'cpm' }, 'synthetic', bindings, '3.2.0', [
          { path: ['pricing_option_id'], xEntity: 'product_pricing_option' },
        ]),
      /ambiguous unscoped pricing-option fixture handle/
    );
  });

  test('substitutes schema-annotated controller force/simulate params without guessing field names', () => {
    const bindings = new FixtureBindingRegistry();
    bindings.bindProduct('authored-product', 'seller-product');
    const request = {
      scenario: 'force_status',
      params: { product_id: 'authored-product', unrelated_product_id: 'authored-product' },
    };
    const result = applyFixtureBindingsToRequest(request, 'comply_test_controller', bindings, '3.2.0', [
      { path: ['params', 'product_id'], xEntity: 'product' },
    ]);
    assert.equal(result.params.product_id, 'seller-product');
    assert.equal(result.params.unrelated_product_id, 'authored-product');
  });

  test('grades an ambiguous unscoped pricing handle without aborting the storyboard run', async () => {
    const products = ['left', 'right'].map(handle =>
      createTestProduct({
        product_id: `seller-${handle}`,
        delivery_type: 'non_guaranteed',
        pricing_options: [
          {
            pricing_option_id: `${handle}-cpm`,
            pricing_model: 'cpm',
            floor_price: 2,
            currency: 'USD',
            is_fixed: false,
          },
        ],
      })
    );
    const sb = storyboard(
      [{ product_id: 'left' }, { product_id: 'right' }],
      [
        { product_id: 'left', pricing_option_id: 'shared' },
        { product_id: 'right', pricing_option_id: 'shared' },
      ],
      {
        products: ['left', 'right'].map(handle => ({
          handle,
          strategies: ['discover'],
          match: [{ path: '/product_id', operator: 'equals', value: `seller-${handle}` }],
        })),
        pricing_options: ['left', 'right'].map(handle => ({
          handle: 'shared',
          product_handle: handle,
          strategies: ['discover'],
          match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
        })),
      }
    );
    sb.phases = [
      {
        id: 'ambiguous',
        title: 'Ambiguous request',
        steps: [
          {
            id: 'create',
            title: 'Create without product scope',
            task: 'create_media_buy',
            expect_error: true,
            sample_request: {
              account: { brand: { domain: 'buyer.example' }, operator: 'operator.example' },
              brand: { domain: 'buyer.example' },
              start_time: 'asap',
              end_time: '2099-01-01T00:00:00Z',
              packages: [{ pricing_option_id: 'shared', budget: 100 }],
            },
            validations: [],
          },
        ],
      },
    ];
    const calls = [];
    const result = await runStoryboard('https://example.invalid/mcp', sb, {
      protocol: 'mcp',
      agentTools: ['get_products', 'create_media_buy'],
      _profile: { name: 'Derived seller', tools: ['get_products', 'create_media_buy'] },
      _client: {
        async executeTask(name) {
          calls.push(name);
          if (name === 'get_products') return { success: true, data: { products, cache_scope: 'public' } };
          throw new Error(`unexpected dispatch: ${name}`);
        },
      },
    });
    const step = result.phases.find(phase => phase.phase_id === 'ambiguous').steps[0];
    assert.equal(step.passed, false);
    assert.equal(step.validations[0].check, 'unresolved_substitution');
    assert.match(step.error, /ambiguous unscoped pricing-option fixture handle/);
    assert.equal(calls.includes('create_media_buy'), false);
  });
});

describe('discover strategy state machine', () => {
  const product = (id, currency = 'USD') =>
    createTestProduct({
      product_id: id,
      delivery_type: 'non_guaranteed',
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', floor_price: 2, currency, is_fixed: false }],
    });

  const discoverRoot = handles => ({
    products: handles.map(handle => ({
      handle,
      strategies: ['discover'],
      match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
    })),
  });

  test('selects deterministically by UTF-8 bytes independent of response order', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const first = discoveryClient([product('z-product'), product('a-product')]);
    const second = discoveryClient([product('a-product'), product('z-product')]);
    const a = await runControllerSeeding(first.client, sb, { agentTools: ['get_products'] }, {});
    const b = await runControllerSeeding(second.client, sb, { agentTools: ['get_products'] }, {});
    assert.deepEqual(first.calls[0].params.ext, { adcp: { creative_wire: 'canonical' } });
    assert.equal(a.resolutionRecords[0].seller_ids.product_id, 'a-product');
    assert.deepEqual(a.resolutionRecords, b.resolutionRecords);
  });

  test('non-reusable handles do not collide; explicit reuse permits it', async () => {
    const products = [{ product_id: 'one' }, { product_id: 'two' }];
    const noReuse = storyboard(products, [], discoverRoot(['one', 'two']));
    const first = discoveryClient([product('only')]);
    const result = await runControllerSeeding(first.client, noReuse, { agentTools: ['get_products'] }, {});
    assert.deepEqual(
      result.resolutionRecords.map(record => record.status),
      ['resolved', 'unsatisfied']
    );
    assert.equal(result.fixtureUnsatisfied, true);

    const reuseRoot = discoverRoot(['one', 'two']);
    reuseRoot.products[0].allow_reuse = true;
    reuseRoot.products[1].allow_reuse = true;
    const reuse = discoveryClient([product('only')]);
    const reused = await runControllerSeeding(
      reuse.client,
      storyboard(products, [], reuseRoot),
      { agentTools: ['get_products'] },
      {}
    );
    assert.deepEqual(
      reused.resolutionRecords.map(record => record.seller_ids.product_id),
      ['only', 'only']
    );

    for (const flags of [
      [true, false],
      [false, true],
    ]) {
      const asymmetricRoot = discoverRoot(['one', 'two']);
      asymmetricRoot.products[0].allow_reuse = flags[0];
      asymmetricRoot.products[1].allow_reuse = flags[1];
      const asymmetric = discoveryClient([product('only')]);
      const asymmetricResult = await runControllerSeeding(
        asymmetric.client,
        storyboard(products, [], asymmetricRoot),
        { agentTools: ['get_products'] },
        {}
      );
      assert.deepEqual(
        asymmetricResult.resolutionRecords.map(record => record.status),
        ['resolved', 'unsatisfied']
      );
    }
  });

  test('authored declaration order controls selection when fixture row order differs', async () => {
    const root = discoverRoot(['second', 'first']);
    const sb = storyboard([{ product_id: 'first' }, { product_id: 'second' }], [], root);
    const discovered = discoveryClient([product('only')]);
    const result = await runControllerSeeding(discovered.client, sb, { agentTools: ['get_products'] }, {});
    assert.deepEqual(
      result.resolutionRecords.map(record => [record.handle, record.status]),
      [
        ['second', 'resolved'],
        ['first', 'unsatisfied'],
      ]
    );
  });

  test('reused seller products resolve a shared scoped pricing binding only when it is unambiguous', () => {
    const bindings = new FixtureBindingRegistry();
    bindings.bindProduct('left', 'seller-shared');
    bindings.bindProduct('right', 'seller-shared');
    bindings.bindPricingOption('left', 'cpm', 'seller-cpm');
    bindings.bindPricingOption('right', 'cpm', 'seller-cpm');
    assert.equal(bindings.pricingOptionId('cpm', 'seller-shared'), 'seller-cpm');

    bindings.bindPricingOption('right', 'other', 'right-other');
    bindings.bindPricingOption('left', 'other', 'left-other');
    assert.throws(() => bindings.pricingOptionId('other', 'seller-shared'), /ambiguous pricing-option fixture handle/);
  });

  test('runs a declared discovery ladder without the legacy controller_seeding prerequisite', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    sb.prerequisites.controller_seeding = false;
    const discovered = discoveryClient([product('seller-product')]);
    const result = await runControllerSeeding(discovered.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.resolutionRecords[0].seller_ids.product_id, 'seller-product');
  });

  test('preserves legacy fixture_seed_unsupported grading in a hybrid storyboard', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    sb.fixtures.accounts = [{ account_id: 'legacy-account' }];
    const client = {
      async executeTask(name, params) {
        if (name === 'get_products') {
          return { success: true, data: { products: [product('seller-product')], cache_scope: 'public' } };
        }
        if (name === 'comply_test_controller' && params.scenario === 'list_scenarios') {
          return { success: true, data: { success: false, error: 'UNKNOWN_SCENARIO' } };
        }
        if (name === 'comply_test_controller' && params.scenario === 'seed_account') {
          return { success: true, data: { success: false, error: 'UNKNOWN_SCENARIO' } };
        }
        throw new Error(`unexpected ${name}/${params.scenario}`);
      },
    };
    const result = await runControllerSeeding(
      client,
      sb,
      { agentTools: ['comply_test_controller', 'get_products'] },
      {},
      client
    );
    assert.equal(result.seedUnsupported, true);
    assert.equal(result.fixtureUnsatisfied, undefined);
    assert.equal(result.phase.steps[0].skip_reason, 'fixture_seed_unsupported');
  });

  test('uses the run account for discovery and defaults its natural-key scope to sandbox', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const discovered = discoveryClient([product('seller-product')]);
    await runControllerSeeding(
      discovered.client,
      sb,
      { agentTools: ['get_products'] },
      {
        account: { brand: { domain: 'context.example' }, operator: 'operator.example' },
      }
    );
    const request = discovered.calls.find(call => call.name === 'get_products').params;
    assert.deepEqual(request.brand, { domain: 'context.example' });
    assert.equal(request.account.operator, 'operator.example');
    assert.equal(request.account.sandbox, true);
  });

  test('empty valid discovery is fixture_unsatisfied while malformed discovery fails', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const empty = discoveryClient([]);
    const unavailable = await runControllerSeeding(empty.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(unavailable.fixtureUnsatisfied, true);
    assert.equal(unavailable.failedCount, 0);
    assert.equal(unavailable.resolutionRecords[0].status, 'unsatisfied');

    const malformed = discoveryClient([{ product_id: 'broken' }]);
    const failed = await runControllerSeeding(malformed.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(failed.fixtureUnsatisfied, false);
    assert.equal(failed.failedCount, 1);
    assert.equal(failed.resolutionRecords[0].status, 'failed');
  });

  test('marks dependent pricing unavailable when its parent product is unsatisfied', async () => {
    const sb = storyboard(
      [{ product_id: 'product-handle' }],
      [{ product_id: 'product-handle', pricing_option_id: 'price-handle' }],
      {
        products: [
          {
            handle: 'product-handle',
            strategies: ['discover'],
            match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
          },
        ],
        pricing_options: [
          {
            handle: 'price-handle',
            product_handle: 'product-handle',
            strategies: ['discover'],
            match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
          },
        ],
      }
    );
    const empty = discoveryClient([]);
    const result = await runControllerSeeding(empty.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 0);
    assert.equal(result.fixtureUnsatisfied, true);
    assert.deepEqual(
      result.resolutionRecords.map(record => record.status),
      ['unsatisfied', 'unsatisfied']
    );
    assert.match(result.resolutionRecords[1].strategies_attempted[0].detail, /parent product handle/);
  });

  test('resolves the same pricing_option_id independently under two bound products', async () => {
    const sb = storyboard(
      [{ product_id: 'left' }, { product_id: 'right' }],
      [
        { product_id: 'left', pricing_option_id: 'shared-price' },
        { product_id: 'right', pricing_option_id: 'shared-price' },
      ],
      {
        products: [
          {
            handle: 'left',
            strategies: ['discover'],
            match: [{ path: '/product_id', operator: 'equals', value: 'seller-left' }],
          },
          {
            handle: 'right',
            strategies: ['discover'],
            match: [{ path: '/product_id', operator: 'equals', value: 'seller-right' }],
          },
        ],
        pricing_options: [
          {
            handle: 'shared-price',
            product_handle: 'left',
            strategies: ['discover'],
            match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
          },
          {
            handle: 'shared-price',
            product_handle: 'right',
            strategies: ['discover'],
            match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
          },
        ],
      }
    );
    const discovered = discoveryClient([product('seller-right'), product('seller-left')]);
    const result = await runControllerSeeding(discovered.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 0);
    assert.deepEqual(
      result.resolutionRecords.map(record => record.seller_ids),
      [
        { product_id: 'seller-left' },
        { product_id: 'seller-right' },
        { product_id: 'seller-left', pricing_option_id: 'cpm' },
        { product_id: 'seller-right', pricing_option_id: 'cpm' },
      ]
    );
  });

  test('a rejected discovery response is a conformance failure', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const rejectedClient = {
      async executeTask() {
        return { success: false, error: 'ACCOUNT_NOT_FOUND' };
      },
    };
    const result = await runControllerSeeding(rejectedClient, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 1);
    assert.equal(result.fixtureUnsatisfied, false);
    assert.match(result.resolutionRecords[0].strategies_attempted[0].detail, /rejected.*ACCOUNT_NOT_FOUND/);
  });

  test('duplicate seller identities fail instead of using response order as a tie-breaker', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const duplicate = discoveryClient([product('same'), product('same')]);
    const result = await runControllerSeeding(duplicate.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 1);
    assert.match(result.resolutionRecords[0].strategies_attempted[0].detail, /duplicate product_id/);
  });

  test('follows discovery pagination to completion and rejects a broken cursor contract', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const requests = [];
    const pagedClient = {
      async executeTask(name, params) {
        requests.push(params);
        if (!params.pagination.cursor) {
          return {
            success: true,
            data: {
              products: [product('z-product')],
              cache_scope: 'public',
              pagination: { has_more: true, cursor: 'next' },
            },
          };
        }
        return {
          success: true,
          data: { products: [product('a-product')], cache_scope: 'public', pagination: { has_more: false } },
        };
      },
    };
    const result = await runControllerSeeding(pagedClient, sb, { agentTools: ['get_products'] }, {});
    assert.equal(requests.length, 2);
    assert.equal(requests[1].pagination.cursor, 'next');
    assert.equal(result.resolutionRecords[0].seller_ids.product_id, 'a-product');

    const brokenClient = {
      async executeTask() {
        return {
          success: true,
          data: { products: [], cache_scope: 'public', pagination: { has_more: true } },
        };
      },
    };
    const broken = await runControllerSeeding(brokenClient, sb, { agentTools: ['get_products'] }, {});
    assert.equal(broken.failedCount, 1);
    assert.match(broken.resolutionRecords[0].strategies_attempted[0].detail, /has_more=true without cursor/);
  });

  test('an advertised seed failure is terminal and does not fall back to discovery', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], {
      products: [
        {
          handle: 'handle',
          strategies: ['seed', 'discover'],
          match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
        },
      ],
    });
    const calls = [];
    const client = {
      async executeTask(name, params) {
        calls.push({ name, params });
        return {
          success: true,
          data: {
            content: [
              { type: 'text', text: JSON.stringify({ success: false, error: 'INVALID_PARAMS', error_detail: 'boom' }) },
            ],
          },
        };
      },
    };
    const result = await runControllerSeeding(
      client,
      sb,
      {
        agentTools: ['comply_test_controller', 'get_products'],
        _controllerCapabilities: { detected: true, scenarios: ['seed_product'] },
      },
      {}
    );
    assert.equal(result.resolutionRecords[0].status, 'failed');
    assert.deepEqual(
      result.resolutionRecords[0].strategies_attempted.map(attempt => ({
        strategy: attempt.strategy,
        disposition: attempt.disposition,
      })),
      [{ strategy: 'seed', disposition: 'failed' }]
    );
    assert.equal(
      calls.some(call => call.name === 'get_products'),
      false
    );
  });

  test('an unadvertised seed is unavailable and advances to discovery', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], {
      products: [
        {
          handle: 'handle',
          strategies: ['seed', 'discover'],
          match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
        },
      ],
    });
    const discovered = discoveryClient([product('derived')]);
    const result = await runControllerSeeding(
      discovered.client,
      sb,
      {
        agentTools: ['comply_test_controller', 'get_products'],
        _controllerCapabilities: { detected: true, scenarios: [] },
      },
      {}
    );
    assert.deepEqual(
      result.resolutionRecords[0].strategies_attempted.map(attempt => ({
        strategy: attempt.strategy,
        disposition: attempt.disposition,
      })),
      [
        { strategy: 'seed', disposition: 'unavailable' },
        { strategy: 'discover', disposition: 'resolved' },
      ]
    );
    assert.equal(result.resolutionRecords[0].seller_ids.product_id, 'derived');
    assert.equal(
      discovered.calls.some(call => call.name === 'comply_test_controller'),
      false
    );
  });

  test('pins discovered product/pricing ids into a later create_media_buy request', async () => {
    const sb = storyboard(
      [{ product_id: 'product-handle' }],
      [{ product_id: 'product-handle', pricing_option_id: 'price-handle' }],
      {
        products: [
          {
            handle: 'product-handle',
            strategies: ['discover'],
            match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
          },
        ],
        pricing_options: [
          {
            handle: 'price-handle',
            product_handle: 'product-handle',
            strategies: ['discover'],
            match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
          },
        ],
      }
    );
    sb.phases = [
      {
        id: 'buy',
        title: 'Buy',
        steps: [
          {
            id: 'create',
            title: 'Create buy',
            task: 'create_media_buy',
            sample_request: {
              account: { brand: { domain: 'buyer.example' }, operator: 'operator.example' },
              brand: { domain: 'buyer.example' },
              start_time: 'asap',
              end_time: '2099-01-01T00:00:00Z',
              packages: [{ product_id: 'product-handle', pricing_option_id: 'price-handle', budget: 100 }],
            },
            validations: [],
          },
        ],
      },
    ];
    const calls = [];
    const client = {
      async executeTask(name, params) {
        calls.push({ name, params });
        if (name === 'get_products') {
          return { success: true, data: { products: [product('derived-product')], cache_scope: 'public' } };
        }
        if (name === 'create_media_buy') return { success: true, data: {} };
        throw new Error(`unexpected ${name}`);
      },
    };
    const result = await runStoryboard('https://example.invalid/mcp', sb, {
      protocol: 'mcp',
      agentTools: ['get_products', 'create_media_buy'],
      _profile: { name: 'Derived seller', tools: ['get_products', 'create_media_buy'] },
      _client: client,
    });
    const create = calls.find(call => call.name === 'create_media_buy');
    assert.ok(create);
    assert.equal(create.params.packages[0].product_id, 'derived-product');
    assert.equal(create.params.packages[0].pricing_option_id, 'cpm');
    assert.deepEqual(
      result.fixture_resolutions.map(record => record.status),
      ['resolved', 'resolved']
    );
    assert.deepEqual(
      {
        fixture_type: result.fixture_resolutions[0].fixture_type,
        handle: result.fixture_resolutions[0].handle,
        status: result.fixture_resolutions[0].status,
        strategy: result.fixture_resolutions[0].strategy,
        seller_ids: result.fixture_resolutions[0].seller_ids,
      },
      {
        fixture_type: 'product',
        handle: 'product-handle',
        status: 'resolved',
        strategy: 'discover',
        seller_ids: { product_id: 'derived-product' },
      }
    );
    assert.deepEqual(
      {
        fixture_type: result.fixture_resolutions[1].fixture_type,
        handle: result.fixture_resolutions[1].handle,
        product_handle: result.fixture_resolutions[1].product_handle,
        status: result.fixture_resolutions[1].status,
        strategy: result.fixture_resolutions[1].strategy,
        seller_ids: result.fixture_resolutions[1].seller_ids,
      },
      {
        fixture_type: 'pricing_option',
        handle: 'price-handle',
        product_handle: 'product-handle',
        status: 'resolved',
        strategy: 'discover',
        seller_ids: { product_id: 'derived-product', pricing_option_id: 'cpm' },
      }
    );
    assert.equal(Object.hasOwn(result, 'fixture_resolution'), false);
    for (const record of result.fixture_resolutions) {
      assert.equal(Object.hasOwn(record, 'entity_type'), false);
      assert.equal(Object.hasOwn(record, 'disposition'), false);
      assert.equal(Object.hasOwn(record, 'chosen_strategy'), false);
      assert.equal(Object.hasOwn(record, 'bound_seller_ids'), false);
      assert.equal(Object.hasOwn(record, 'evidence'), false);
      assert.equal(Object.hasOwn(record.strategies_attempted[0], 'outcome'), false);
      assert.deepEqual(
        record.strategies_attempted.map(attempt => ({
          strategy: attempt.strategy,
          disposition: attempt.disposition,
        })),
        [{ strategy: 'discover', disposition: 'resolved' }]
      );
      assert.deepEqual(Object.keys(record.strategies_attempted[0]).sort(), [
        'detail',
        'disposition',
        'response',
        'strategy',
      ]);
    }
    assert.equal(Object.hasOwn(result.fixture_resolutions[1], 'parent_product_handle'), false);
  });

  test('reports one storyboard-level fixture_unsatisfied gap naming every unresolved handle', async () => {
    const sb = storyboard([{ product_id: 'usd-product' }, { product_id: 'eur-product' }], [], {
      products: [
        {
          handle: 'usd-product',
          strategies: ['discover'],
          match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
        },
        {
          handle: 'eur-product',
          strategies: ['discover'],
          match: [{ path: '/currency', operator: 'equals', value: 'EUR' }],
        },
      ],
    });
    sb.phases = [
      {
        id: 'capability-gated',
        title: 'Capability gated',
        requires_capability: { path: 'supported_protocols', contains: 'sponsored_intelligence' },
        steps: [{ id: 'gated', title: 'Gated', task: 'si_initiate_session', sample_request: {}, validations: [] }],
      },
      {
        id: 'ordinary',
        title: 'Ordinary',
        steps: [
          { id: 'buy-1', title: 'Buy one', task: 'create_media_buy', sample_request: {}, validations: [] },
          { id: 'buy-2', title: 'Buy two', task: 'create_media_buy', sample_request: {}, validations: [] },
          { id: 'buy-3', title: 'Buy three', task: 'create_media_buy', sample_request: {}, validations: [] },
        ],
      },
    ];
    const calls = [];
    const client = {
      async executeTask(name, params) {
        calls.push({ name, params });
        if (name === 'get_products') return { success: true, data: { products: [], cache_scope: 'public' } };
        throw new Error(`ordinary phase unexpectedly executed ${name}`);
      },
    };
    const result = await runStoryboard('https://example.invalid/mcp', sb, {
      protocol: 'mcp',
      agentTools: ['get_products', 'create_media_buy'],
      _profile: { name: 'No USD seller', tools: ['get_products', 'create_media_buy'] },
      _client: client,
    });
    assert.equal(result.overall_passed, true);
    assert.equal(result.failed_count, 0);
    assert.equal(
      calls.some(call => call.name === 'create_media_buy'),
      false
    );
    const gaps = result.coverage_gaps.filter(gap => gap.reason === 'fixture_unsatisfied');
    assert.equal(result.coverage_gaps.length, 1);
    assert.equal(gaps.length, 1);
    assert.deepEqual(
      gaps[0].fixtures.map(fixture => fixture.handle),
      ['usd-product', 'eur-product']
    );
    assert.match(gaps[0].detail, /usd-product/);
    assert.match(gaps[0].detail, /eur-product/);
    assert.equal(
      result.phases.every(phase => phase.steps.length === 0),
      true
    );
    assert.equal(result.passed_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.deepEqual(result.fixture_resolutions[0].requirements, [
      { path: '/currency', operator: 'equals', value: 'USD' },
    ]);
  });

  test('fixture_unsatisfied supersedes the no_phases sentinel without double-counting', async () => {
    const sb = storyboard([{ product_id: 'usd-product' }], [], {
      products: [
        {
          handle: 'usd-product',
          strategies: ['discover'],
          match: [{ path: '/currency', operator: 'equals', value: 'USD' }],
        },
      ],
    });
    const result = await runStoryboard('https://example.invalid/mcp', sb, {
      protocol: 'mcp',
      agentTools: ['get_products'],
      _profile: { name: 'No USD seller', tools: ['get_products'] },
      _client: discoveryClient([]).client,
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.passed_count, 0);
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.coverage_gaps.length, 1);
    assert.equal(result.coverage_gaps[0].reason, 'fixture_unsatisfied');
    assert.equal(
      result.phases.some(phase => phase.phase_id === 'no_phases'),
      false
    );
    assert.equal(
      result.phases.every(phase => phase.steps.length === 0),
      true
    );
  });

  test('a terminal resolution failure wins over another handle exhausting its ladder', async () => {
    const sb = storyboard([{ product_id: 'unavailable' }, { product_id: 'broken' }], [], {
      products: [
        {
          handle: 'unavailable',
          strategies: ['discover'],
          match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
        },
        {
          handle: 'broken',
          strategies: ['seed'],
          match: [{ path: '/delivery_type', operator: 'equals', value: 'non_guaranteed' }],
        },
      ],
    });
    sb.phases = [
      {
        id: 'ordinary',
        title: 'Ordinary',
        steps: [{ id: 'buy', title: 'Buy', task: 'create_media_buy', sample_request: {}, validations: [] }],
      },
    ];
    const client = {
      async executeTask(name) {
        if (name === 'get_products') {
          return { success: true, data: { products: [], cache_scope: 'public' } };
        }
        if (name === 'comply_test_controller') {
          return {
            success: true,
            data: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: false, error: 'INVALID_PARAMS', error_detail: 'seed rejected' }),
                },
              ],
            },
          };
        }
        throw new Error(`ordinary phase unexpectedly executed ${name}`);
      },
    };
    const result = await runStoryboard('https://example.invalid/mcp', sb, {
      protocol: 'mcp',
      agentTools: ['comply_test_controller', 'get_products', 'create_media_buy'],
      _controllerCapabilities: { detected: true, scenarios: ['seed_product'] },
      _profile: {
        name: 'Mixed result seller',
        tools: ['comply_test_controller', 'get_products', 'create_media_buy'],
      },
      _client: client,
    });
    assert.equal(result.overall_passed, false);
    assert.equal(result.failed_count, 1);
    assert.deepEqual(
      result.fixture_resolutions.map(record => record.status),
      ['unsatisfied', 'failed']
    );
    const gaps = result.coverage_gaps.filter(gap => gap.reason === 'fixture_unsatisfied');
    assert.equal(gaps.length, 1);
    assert.deepEqual(
      gaps[0].fixtures.map(fixture => fixture.handle),
      ['unavailable']
    );
    for (const record of result.fixture_resolutions) {
      for (const legacyKey of ['entity_type', 'disposition', 'chosen_strategy', 'bound_seller_ids']) {
        assert.equal(Object.hasOwn(record, legacyKey), false);
      }
      assert.equal(Object.hasOwn(record, 'seller_ids'), false);
      assert.equal(Object.hasOwn(record, 'strategy'), false);
    }
    assert.equal(
      result.phases.find(phase => phase.phase_id === 'ordinary').steps[0].skip_reason,
      'controller_seeding_failed'
    );
  });
});
