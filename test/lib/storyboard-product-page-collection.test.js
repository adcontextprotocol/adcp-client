const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
const { validateStoryboardShape, parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');
const { createTestProduct } = require('./test-fixtures');
require('../../dist/lib/testing/storyboard/default-invariants');

const product = id =>
  createTestProduct({
    product_id: id,
    delivery_type: 'non_guaranteed',
    pricing_options: [{ pricing_option_id: `${id}-cpm`, pricing_model: 'cpm', currency: 'USD', floor_price: 8 }],
  });
const page = (ids, cursor, version = 'feed-v1', extras = {}) => ({
  status: 'completed',
  cache_scope: 'account',
  wholesale_feed_version: version,
  products: ids.map(id => (typeof id === 'string' ? product(id) : id)),
  ...(cursor !== undefined && { pagination: { has_more: true, cursor } }),
  ...extras,
});

function storyboard({ collect = true, request = {}, validations, contextOutputs, steps = [] } = {}) {
  return {
    id: 'collected-wholesale',
    version: '1.0.0',
    title: 'Collected wholesale products',
    category: 'media_buy_seller',
    summary: '',
    narrative: '',
    requires: ['collect_product_pages_runner'],
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        steps: [
          {
            id: 'discover',
            title: 'Read the complete wholesale view',
            task: 'get_products',
            ...(collect && { collect_product_pages: true }),
            sample_request: {
              buying_mode: 'wholesale',
              account: { brand: { domain: 'buyer.example' }, operator: 'operator.example', sandbox: true },
              filters: { pricing_currencies: ['USD'] },
              pagination: { max_results: 2 },
              idempotency_key: 'caller-product-read-key',
              context: { correlation_id: 'same-authored-context' },
              ...request,
            },
            context_outputs: contextOutputs ?? [{ path: 'products', key: 'all_products' }],
            validations: validations ?? [{ check: 'field_contains', path: 'products[*].product_id', value: 'target' }],
          },
          ...steps,
        ],
      },
    ],
  };
}

async function run(pages, args = {}) {
  const calls = [];
  const source = storyboard(args);
  let index = 0;
  const options = {
    protocol: 'mcp',
    agentTools: ['get_products'],
    _profile: { tools: ['get_products'] },
    _client: {
      resetContext() {},
      async getProducts(request) {
        calls.push(structuredClone(request));
        const response = typeof pages === 'function' ? await pages(request, index++) : pages[index++];
        if (response instanceof Error) throw response;
        return response?.success === false ? response : { success: true, data: response };
      },
    },
  };
  const result = args.standalone
    ? await runStoryboardStep('https://seller.example/mcp', source, 'discover', options)
    : await runStoryboard('https://seller.example/mcp', source, options);
  const step = args.standalone ? result : result.phases[0].steps[0];
  return { result, step, calls, source };
}

test('collection follows every page with the actual authored query and separates logical data from receipts', async () => {
  const fields = ['product_id', 'name', 'pricing_options', 'reporting_capabilities'];
  const { result, step, calls, source } = await run([page(['first'], 'page-2'), page(['target'])], {
    request: { fields, ext: { seller: { fixture: 'preserved' } } },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(step));
  assert.equal(calls.length, 2);
  for (const request of calls) {
    assert.deepEqual(request.account, source.phases[0].steps[0].sample_request.account);
    assert.deepEqual(request.filters, { pricing_currencies: ['USD'] });
    assert.deepEqual(request.fields, fields);
    assert.deepEqual(request.context, { correlation_id: 'same-authored-context' });
    assert.equal(request.idempotency_key, 'caller-product-read-key');
    assert.deepEqual(request.ext, { seller: { fixture: 'preserved' } });
    assert.equal(request.pagination.max_results, 2);
  }
  assert.equal(calls[0].pagination.cursor, undefined);
  assert.equal(calls[1].pagination.cursor, 'page-2');
  assert.deepEqual(
    step.context.all_products.map(product => product.product_id),
    ['first', 'target']
  );
  assert.deepEqual(
    step.response.products.map(product => product.product_id),
    ['first']
  );
  assert.deepEqual(
    step.response_record.payload.products.map(product => product.product_id),
    ['first']
  );
  const evidence = step.product_page_collection;
  assert.equal(evidence.complete, true);
  assert.equal(evidence.page_count, 2);
  assert.deepEqual(
    evidence.logical_response.products.map(product => product.product_id),
    ['first', 'target']
  );
  assert.equal(evidence.logical_response.pagination, undefined);
  assert.deepEqual(
    evidence.pages.map(record => record.response.payload.products[0].product_id),
    ['first', 'target']
  );
  assert.ok(evidence.pages.every(record => record.schema_validated));
  assert.match(step.extraction.note, /logical_response/);
});

test('ordinary get_products remains a single physical page', async () => {
  const { result, step, calls } = await run([page(['first'], 'page-2'), page(['target'])], { collect: false });
  assert.equal(calls.length, 1);
  assert.equal(result.overall_passed, false, 'the target really is beyond the first page');
  assert.equal(step.product_page_collection, undefined);
});

test('standalone collected steps expose the same logical captures and physical receipts', async () => {
  const { step, calls } = await run([page(['first'], 'next'), page(['target'])], { standalone: true });
  assert.equal(step.passed, true, JSON.stringify(step));
  assert.equal(calls.length, 2);
  assert.deepEqual(
    step.context.all_products.map(product => product.product_id),
    ['first', 'target']
  );
  assert.equal(step.product_page_collection.complete, true);
});

for (const [name, second] of [
  ['a repeated cursor', page(['target'], 'next')],
  ['a missing continuation cursor', page(['target'], undefined, 'feed-v1', { pagination: { has_more: true } })],
  ['a duplicate product ID', page(['first'])],
  ['a malformed second page', page(['target'], undefined, 'feed-v1', { products: [{ product_id: 'invalid' }] })],
  ['a rejected second page', { success: false, error: 'Deliberate seller rejection' }],
  ['a transport failure', new Error('Deliberate connection failure')],
]) {
  test(`collection rejects ${name} without publishing a partial logical snapshot`, async () => {
    const { result, step, calls } = await run([page(['first'], 'next'), second]);
    assert.equal(result.overall_passed, false, JSON.stringify(step));
    assert.equal(calls.length, 2);
    assert.equal(step.product_page_collection.complete, false);
    assert.equal(step.product_page_collection.logical_response, undefined);
    assert.equal(step.context.all_products, undefined);
    assert.ok(step.validations.some(validation => !validation.passed));
    assert.equal(step.product_page_collection.pages.length, 2);
    assert.equal(step.product_page_collection.pages[1].request.payload.pagination.cursor, 'next');
  });
}

test('a changed feed restarts the same query and discards stale products while retaining actual exchanges', async () => {
  const { result, step, calls } = await run([
    page(['stale'], 'old-next', 'feed-old'),
    page(['discarded'], undefined, 'feed-new'),
    page(['fresh'], 'fresh-next', 'feed-new'),
    page(['target'], undefined, 'feed-new'),
  ]);
  assert.equal(result.overall_passed, true, JSON.stringify(step));
  assert.deepEqual(
    calls.map(request => request.pagination.cursor),
    [undefined, 'old-next', undefined, 'fresh-next']
  );
  assert.deepEqual(
    step.context.all_products.map(product => product.product_id),
    ['fresh', 'target']
  );
  assert.equal(step.product_page_collection.restart_count, 1);
  assert.equal(step.product_page_collection.pages.length, 4);
  assert.deepEqual(
    step.response_record.payload.products.map(product => product.product_id),
    ['fresh']
  );
});

test('feed churn exhausts a bounded restart budget and cannot masquerade as completion', async () => {
  const { result, step, calls } = await run((_request, index) => page([`row-${index}`], 'next', `feed-${index}`));
  assert.equal(result.overall_passed, false, JSON.stringify(step));
  assert.equal(calls.length, 8);
  assert.equal(step.product_page_collection.complete, false);
  assert.match(step.error, /restart budget/);
});

test('default currency invariants inspect later pages even when authored checks only look at product IDs', async () => {
  const invalid = product('target');
  invalid.pricing_options[0].currency = 'EUR';
  for (const standalone of [false, true]) {
    const { result, step } = await run([page(['first'], 'next'), page([invalid])], { standalone });
    assert.equal(standalone ? step.passed : result.overall_passed, false, JSON.stringify(step));
    const finding = step.validations.find(
      validation => !validation.passed && /pricing_currency_filter/.test(validation.description)
    );
    assert.ok(finding, JSON.stringify({ validations: step.validations, assertions: result.assertions }));
    assert.equal(finding.request.payload.pagination.cursor, 'next');
    assert.equal(finding.response.payload.products[0].pricing_options[0].currency, 'EUR');
  }
});

test('a bad page cannot conceal its invariant failure by changing feed identity and restarting', async () => {
  const invalid = product('discarded');
  invalid.pricing_options[0].currency = 'EUR';
  const { result, step } = await run([
    page(['stale'], 'next', 'old'),
    page([invalid], undefined, 'new'),
    page(['target'], undefined, 'new'),
  ]);
  assert.equal(result.overall_passed, false, JSON.stringify(step));
  assert.equal(step.product_page_collection.complete, true);
  assert.ok(step.validations.some(validation => !validation.passed && /physical page 2/.test(validation.description)));
});

test('every physical page is checked even beyond bounded response evidence retention', async () => {
  const { result, step } = await run((_request, index) => {
    const item = product(index === 17 ? 'target' : `row-${index}`);
    if (index === 16) item.pricing_options[0].currency = 'EUR';
    return page([item], index < 17 ? `cursor-${index}` : undefined);
  });
  assert.equal(result.overall_passed, false, JSON.stringify(step));
  assert.equal(step.product_page_collection.pages.length, 18);
  assert.ok(step.product_page_collection.pages[16].response.payload.response_not_retained);
  const failure = step.validations.find(
    validation => !validation.passed && /physical page 17/.test(validation.description)
  );
  assert.equal(failure.response.payload.products[0].pricing_options[0].currency, 'EUR');
});

test('the all-pages safety budget is bounded and never returns a successful partial catalog', async () => {
  const { result, step, calls } = await run((_request, index) => page([`row-${index}`], `cursor-${index}`));
  assert.equal(result.overall_passed, false);
  assert.equal(calls.length, 1000);
  assert.equal(step.product_page_collection.complete, false);
  assert.equal(step.context.all_products, undefined);
  assert.match(step.error, /safety limit/);
});

test('authoring and intrinsic runtime gates prevent accidental partial-read compatibility', () => {
  assert.doesNotThrow(() => validateStoryboardShape(storyboard()));
  for (const mutate of [
    source => {
      source.requires = ['real_wire'];
    },
    source => {
      source.phases[0].steps[0].task = 'get_signals';
    },
    source => {
      source.phases[0].steps[0].sample_request.buying_mode = 'brief';
    },
    source => {
      source.phases[0].steps[0].sample_request.pagination.cursor = 'already-started';
    },
    source => {
      source.phases[0].steps[0].sample_request.if_wholesale_feed_version = 'cached';
    },
    source => {
      source.phases[0].steps[0].expect_error = true;
    },
  ]) {
    const source = storyboard();
    mutate(source);
    assert.throws(() => validateStoryboardShape(source), /collect_product_pages/);
  }
  assert.doesNotThrow(() =>
    parseStoryboard(
      `id: parsed\nrequires: [collect_product_pages_runner]\nphases:\n  - id: read\n    steps:\n      - id: catalog\n        task: get_products\n        collect_product_pages: true\n        sample_request:\n          buying_mode: wholesale\n`
    )
  );
});

test('later pages apply required metric filters and per-step invariant exemptions', async () => {
  const wrong = product('target');
  const request = { filters: { pricing_currencies: ['USD'], required_metrics: ['completed_views'] } };
  const { step } = await run([page(['first'], 'next'), page([wrong])], { request });
  assert.ok(
    step.validations.some(
      validation =>
        !validation.passed &&
        /required_metric/.test(validation.description) &&
        /physical page 2/.test(validation.description)
    )
  );

  const source = storyboard({ request });
  source.phases[0].steps[0].invariants = { disable: ['discovery.required_metric_filters'] };
  let index = 0;
  const result = await runStoryboard('https://seller.example/mcp', source, {
    protocol: 'mcp',
    agentTools: ['get_products'],
    _profile: { tools: ['get_products'] },
    _client: {
      resetContext() {},
      async getProducts() {
        return { success: true, data: [page(['first'], 'next'), page(['target'])][index++] };
      },
    },
  });
  assert.equal(result.overall_passed, true);
});

test('a seller-reported rejection cannot be mistaken for a terminal successful collection', async () => {
  const { step, calls } = await run([page(['first'], 'next'), { status: 'rejected', products: [] }]);
  assert.equal(calls.length, 2);
  assert.equal(step.passed, false);
  assert.equal(step.product_page_collection.complete, false);
  assert.equal(step.product_page_collection.logical_response, undefined);
  assert.equal(step.response_record.payload.status, 'rejected');
});

test('a cursor supplied through runtime request overrides is rejected before dispatch', async () => {
  let calls = 0;
  const result = await runStoryboardStep('https://seller.example/mcp', storyboard(), 'discover', {
    protocol: 'mcp',
    agentTools: ['get_products'],
    request: { buying_mode: 'wholesale', pagination: { cursor: 'unsafe' } },
    _profile: { tools: ['get_products'] },
    _client: {
      resetContext() {},
      async getProducts() {
        calls++;
        return { success: true, data: page(['target']) };
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.passed, false);
  assert.ok(
    result.validations.some(validation => validation.check === 'product_page_collection' && !validation.passed)
  );
});

test('future runtime requirements degrade to coverage gaps before fixture mutations', async () => {
  const source = storyboard();
  source.requires = ['future_collect_product_pages_runner'];
  delete source.phases[0].steps[0].collect_product_pages;
  source.fixtures = { products: [{ product_id: 'must-not-seed' }] };
  let calls = 0;
  const result = await runStoryboard('https://seller.example/mcp', source, {
    protocol: 'mcp',
    agentTools: ['get_products', 'comply_test_controller'],
    _profile: { tools: ['get_products', 'comply_test_controller'] },
    _client: {
      resetContext() {},
      async getProducts() {
        calls++;
      },
      async complyTestController() {
        calls++;
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.phases[0].steps[0].skip_reason, 'requirement_unmet');
});

test('complete product captures can drive the following authored step', async () => {
  const { result, calls } = await run([page(['first'], 'next'), page(['target']), page(['target'])], {
    contextOutputs: [{ path: 'products[1].product_id', key: 'selected_product' }],
    steps: [
      {
        id: 'use_selected',
        title: 'Use the discovered target',
        task: 'get_products',
        sample_request: {
          buying_mode: 'wholesale',
          account: { account_id: 'isolated-account' },
          context: { selected_product: '$context.selected_product' },
        },
        validations: [{ check: 'field_contains', path: 'products[*].product_id', value: 'target' }],
      },
    ],
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(calls[2].context.selected_product, 'target');
});

test('official MCP client collects and records the actual second-page exchange', async t => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = require('zod');
  const { AgentClient } = require('../../dist/lib/index.js');
  const server = new McpServer({ name: 'paginated-seller', version: '1' });
  const seen = [];
  server.registerTool('get_adcp_capabilities', { inputSchema: z.object({}).passthrough() }, async () => {
    const data = {
      status: 'completed',
      adcp: { major_versions: [3], supported_versions: ['3.2'] },
      supported_protocols: ['media_buy'],
    };
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
  server.registerTool('get_products', { inputSchema: z.object({}).passthrough() }, async request => {
    seen.push(structuredClone(request));
    const data = request.pagination?.cursor ? page(['target']) : page(['first'], 'official-next');
    for (const item of data.products) {
      delete item.format_ids;
      item.format_options = [
        { format_option_id: 'image-300x250', format_kind: 'image', params: { width: 300, height: 250 } },
      ];
    }
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'paginated-buyer', version: '1' });
  await mcp.connect(clientTransport);
  t.after(async () => {
    await mcp.close();
    await server.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  const source = storyboard();
  const result = await runStoryboard('https://seller.example/mcp', source, {
    protocol: 'mcp',
    agentTools: ['get_products'],
    _profile: { tools: ['get_products'] },
    _client: {
      resetContext: () => buyer.resetContext(),
      getProducts: (...args) => buyer.getProducts(...args),
      executeTask: (...args) => buyer.executeTask(...args),
    },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  const step = result.phases[0].steps[0];
  assert.deepEqual(
    seen.map(request => request.pagination.cursor),
    [undefined, 'official-next']
  );
  assert.deepEqual(seen[1].account, source.phases[0].steps[0].sample_request.account);
  assert.deepEqual(
    step.context.all_products.map(product => product.product_id),
    ['first', 'target']
  );
  assert.equal(step.product_page_collection.pages[1].request.payload.pagination.cursor, 'official-next');
  assert.equal(step.product_page_collection.pages[1].schema_validated, true);
  assert.match(JSON.stringify(step.product_page_collection.pages[1].response.payload), /target/);
  assert.doesNotMatch(JSON.stringify(step.response_record.payload), /target/);
});

for (const field of ['if_wholesale_feed_version', 'if_pricing_version']) {
  test(`${field} is an unsupported conditional collection in source and runtime overrides`, async () => {
    const source = storyboard({ request: { [field]: 'cached-version' } });
    assert.throws(() => validateStoryboardShape(source), /unconditional/);
    let calls = 0;
    const result = await runStoryboardStep('https://seller.example/mcp', storyboard(), 'discover', {
      protocol: 'mcp',
      agentTools: ['get_products'],
      request: { buying_mode: 'wholesale', [field]: 'cached-version' },
      _profile: { tools: ['get_products'] },
      _client: {
        resetContext() {},
        async getProducts() {
          calls++;
          return { success: true, data: { unchanged: true, products: [] } };
        },
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.passed, false);
    assert.ok(
      result.validations.some(validation => validation.check === 'product_page_collection' && !validation.passed)
    );
  });
}
