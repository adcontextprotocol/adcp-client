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
  test('validates and normalizes the closed matcher DSL', () => {
    const clauses = normalizeFixtureMatchExpression(
      {
        delivery_type: { equals: 'non_guaranteed' },
        channels: { contains_all: ['display'] },
        pricing_options: { any_match: { currency: { equals: 'USD' } } },
      },
      'match'
    );
    assert.equal(clauses.length, 3);
    assert.equal(
      matchesFixtureRequirements(
        {
          delivery_type: 'non_guaranteed',
          channels: ['video', 'display'],
          pricing_options: [{ currency: 'EUR' }, { currency: 'USD' }],
        },
        clauses
      ),
      true
    );
    assert.throws(
      () => normalizeFixtureMatchExpression([{ path: 'currency', regex: 'USD' }], 'match'),
      /match DSL is closed/
    );
  });

  test('rejects malformed or orphaned declarations as authoring errors', () => {
    const value = storyboard([{ product_id: 'handle' }], [], {
      products: { missing: { strategies: ['discover'], match: { currency: { equals: 'USD' } } } },
    });
    assert.throws(() => validateFixtureResolutionDeclarations(value), /no matching fixtures\.products handle/);
  });

  test('rejects malformed canonical-format selectors and does not fall back from an explicit missing path', () => {
    assert.throws(
      () => normalizeFixtureMatchExpression([{ canonical_format_satisfies: { params: { width: 300 } } }], 'match'),
      /format_kind/
    );
    const clauses = normalizeFixtureMatchExpression(
      [{ path: 'missing', canonical_format_satisfies: { format_kind: 'display' } }],
      'match'
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
});

describe('discover strategy state machine', () => {
  const product = (id, currency = 'USD') =>
    createTestProduct({
      product_id: id,
      delivery_type: 'non_guaranteed',
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', floor_price: 2, currency, is_fixed: false }],
    });

  const discoverRoot = handles => ({
    products: Object.fromEntries(
      handles.map(handle => [
        handle,
        { strategies: ['discover'], match: { delivery_type: { equals: 'non_guaranteed' } } },
      ])
    ),
  });

  test('selects deterministically by UTF-8 bytes independent of response order', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const first = discoveryClient([product('z-product'), product('a-product')]);
    const second = discoveryClient([product('a-product'), product('z-product')]);
    const a = await runControllerSeeding(first.client, sb, { agentTools: ['get_products'] }, {});
    const b = await runControllerSeeding(second.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(a.resolutionRecords[0].bound_seller_ids.product_id, 'a-product');
    assert.deepEqual(a.resolutionRecords, b.resolutionRecords);
  });

  test('non-reusable handles do not collide; explicit reuse permits it', async () => {
    const products = [{ product_id: 'one' }, { product_id: 'two' }];
    const noReuse = storyboard(products, [], discoverRoot(['one', 'two']));
    const first = discoveryClient([product('only')]);
    const result = await runControllerSeeding(first.client, noReuse, { agentTools: ['get_products'] }, {});
    assert.deepEqual(
      result.resolutionRecords.map(record => record.disposition),
      ['bound', 'unsatisfied']
    );
    assert.equal(result.fixtureUnsatisfied, true);

    const reuseRoot = discoverRoot(['one', 'two']);
    reuseRoot.products.one.allow_reuse = true;
    reuseRoot.products.two.allow_reuse = true;
    const reuse = discoveryClient([product('only')]);
    const reused = await runControllerSeeding(
      reuse.client,
      storyboard(products, [], reuseRoot),
      { agentTools: ['get_products'] },
      {}
    );
    assert.deepEqual(
      reused.resolutionRecords.map(record => record.bound_seller_ids.product_id),
      ['only', 'only']
    );

    for (const flags of [
      [true, false],
      [false, true],
    ]) {
      const asymmetricRoot = discoverRoot(['one', 'two']);
      asymmetricRoot.products.one.allow_reuse = flags[0];
      asymmetricRoot.products.two.allow_reuse = flags[1];
      const asymmetric = discoveryClient([product('only')]);
      const asymmetricResult = await runControllerSeeding(
        asymmetric.client,
        storyboard(products, [], asymmetricRoot),
        { agentTools: ['get_products'] },
        {}
      );
      assert.deepEqual(
        asymmetricResult.resolutionRecords.map(record => record.disposition),
        ['bound', 'unsatisfied']
      );
    }
  });

  test('runs a declared discovery ladder without the legacy controller_seeding prerequisite', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    sb.prerequisites.controller_seeding = false;
    const discovered = discoveryClient([product('seller-product')]);
    const result = await runControllerSeeding(discovered.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.resolutionRecords[0].bound_seller_ids.product_id, 'seller-product');
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
    assert.equal(unavailable.resolutionRecords[0].disposition, 'unsatisfied');

    const malformed = discoveryClient([{ product_id: 'broken' }]);
    const failed = await runControllerSeeding(malformed.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(failed.fixtureUnsatisfied, false);
    assert.equal(failed.failedCount, 1);
    assert.equal(failed.resolutionRecords[0].disposition, 'failed');
  });

  test('marks dependent pricing unavailable when its parent product is unsatisfied', async () => {
    const sb = storyboard(
      [{ product_id: 'product-handle' }],
      [{ product_id: 'product-handle', pricing_option_id: 'price-handle' }],
      {
        products: {
          'product-handle': {
            strategies: ['discover'],
            match: { delivery_type: { equals: 'non_guaranteed' } },
            pricing_options: {
              'price-handle': { strategies: ['discover'], match: { currency: { equals: 'USD' } } },
            },
          },
        },
      }
    );
    const empty = discoveryClient([]);
    const result = await runControllerSeeding(empty.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 0);
    assert.equal(result.fixtureUnsatisfied, true);
    assert.deepEqual(
      result.resolutionRecords.map(record => record.disposition),
      ['unsatisfied', 'unsatisfied']
    );
    assert.match(result.resolutionRecords[1].evidence[0].detail, /parent product handle/);
  });

  test('resolves the same pricing_option_id independently under two bound products', async () => {
    const sb = storyboard(
      [{ product_id: 'left' }, { product_id: 'right' }],
      [
        { product_id: 'left', pricing_option_id: 'shared-price' },
        { product_id: 'right', pricing_option_id: 'shared-price' },
      ],
      {
        products: {
          left: {
            strategies: ['discover'],
            match: { product_id: { equals: 'seller-left' } },
            pricing_options: {
              'shared-price': { strategies: ['discover'], match: { currency: { equals: 'USD' } } },
            },
          },
          right: {
            strategies: ['discover'],
            match: { product_id: { equals: 'seller-right' } },
            pricing_options: {
              'shared-price': { strategies: ['discover'], match: { currency: { equals: 'USD' } } },
            },
          },
        },
      }
    );
    const discovered = discoveryClient([product('seller-right'), product('seller-left')]);
    const result = await runControllerSeeding(discovered.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 0);
    assert.deepEqual(
      result.resolutionRecords.map(record => record.bound_seller_ids),
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
    assert.match(result.resolutionRecords[0].evidence[0].detail, /rejected.*ACCOUNT_NOT_FOUND/);
  });

  test('duplicate seller identities fail instead of using response order as a tie-breaker', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], discoverRoot(['handle']));
    const duplicate = discoveryClient([product('same'), product('same')]);
    const result = await runControllerSeeding(duplicate.client, sb, { agentTools: ['get_products'] }, {});
    assert.equal(result.failedCount, 1);
    assert.match(result.resolutionRecords[0].evidence[0].detail, /duplicate product_id/);
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
    assert.equal(result.resolutionRecords[0].bound_seller_ids.product_id, 'a-product');

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
    assert.match(broken.resolutionRecords[0].evidence[0].detail, /has_more=true without cursor/);
  });

  test('an advertised seed failure is terminal and does not fall back to discovery', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], {
      products: {
        handle: {
          strategies: ['seed', 'discover'],
          match: { delivery_type: { equals: 'non_guaranteed' } },
        },
      },
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
    assert.equal(result.resolutionRecords[0].disposition, 'failed');
    assert.deepEqual(result.resolutionRecords[0].strategies_attempted, ['seed']);
    assert.equal(
      calls.some(call => call.name === 'get_products'),
      false
    );
  });

  test('an unadvertised seed is unavailable and advances to discovery', async () => {
    const sb = storyboard([{ product_id: 'handle' }], [], {
      products: {
        handle: {
          strategies: ['seed', 'discover'],
          match: { delivery_type: { equals: 'non_guaranteed' } },
        },
      },
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
    assert.deepEqual(result.resolutionRecords[0].strategies_attempted, ['seed', 'discover']);
    assert.deepEqual(
      result.resolutionRecords[0].evidence.map(item => item.outcome),
      ['unavailable', 'bound']
    );
    assert.equal(result.resolutionRecords[0].bound_seller_ids.product_id, 'derived');
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
        products: {
          'product-handle': {
            strategies: ['discover'],
            match: { delivery_type: { equals: 'non_guaranteed' } },
            pricing_options: {
              'price-handle': { strategies: ['discover'], match: { currency: { equals: 'USD' } } },
            },
          },
        },
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
      result.fixture_resolution.map(record => record.disposition),
      ['bound', 'bound']
    );
  });

  test('fixture_unsatisfied stops ordinary phases without failing the storyboard', async () => {
    const sb = storyboard([{ product_id: 'usd-product' }], [], {
      products: {
        'usd-product': { strategies: ['discover'], match: { currency: { equals: 'USD' } } },
      },
    });
    sb.phases = [
      {
        id: 'ordinary',
        title: 'Ordinary',
        steps: [{ id: 'buy', title: 'Buy', task: 'create_media_buy', sample_request: {}, validations: [] }],
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
    assert.equal(
      result.phases.find(phase => phase.phase_id === 'ordinary').steps[0].skip_reason,
      'fixture_unsatisfied'
    );
    assert.deepEqual(result.fixture_resolution[0].requirements, [{ path: 'currency', equals: 'USD' }]);
  });

  test('a terminal resolution failure wins over another handle exhausting its ladder', async () => {
    const sb = storyboard([{ product_id: 'unavailable' }, { product_id: 'broken' }], [], {
      products: {
        unavailable: {
          strategies: ['discover'],
          match: { delivery_type: { equals: 'non_guaranteed' } },
        },
        broken: {
          strategies: ['seed'],
          match: { delivery_type: { equals: 'non_guaranteed' } },
        },
      },
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
    assert.equal(
      result.phases.find(phase => phase.phase_id === 'ordinary').steps[0].skip_reason,
      'controller_seeding_failed'
    );
  });
});
