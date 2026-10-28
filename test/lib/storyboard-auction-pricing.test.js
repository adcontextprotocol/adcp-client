const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { validateStoryboardShape } = require('../../dist/lib/testing/storyboard/loader');

const options = { brand: { domain: 'acmeoutdoor.example' } };
const auction = { pricing_option_id: 'auction', pricing_model: 'cpm', currency: 'USD', floor_price: 8 };
const fixed = { pricing_option_id: 'fixed', pricing_model: 'cpm', currency: 'USD', fixed_price: 20 };
const context = {
  products: [{ product_id: 'display', pricing_options: [auction, fixed] }],
  product_id: 'display',
  pricing_option_id: 'auction',
};
const pkg = pricing_option_id => ({ product_id: 'display', pricing_option_id, budget: 5000 });
const step = overrides => ({
  id: 'create',
  title: 'Create',
  task: 'create_media_buy',
  sample_request: {
    start_time: 'asap',
    end_time: '2099-09-30T23:59:59Z',
    packages: [pkg('auction'), pkg('auction')],
  },
  ...overrides,
});

test('each package uses its own discovered pricing option and authored bid policy', () => {
  const authored = step();
  authored.sample_request.packages = [
    pkg('fixed'),
    pkg('auction'),
    { ...pkg('auction'), bid_price: 1 },
    { ...pkg('auction'), bidding: { max_bid: 9 } },
    pkg('unknown'),
  ];
  const before = structuredClone(authored);
  const result = buildRequest(authored, context, options);
  assert.deepEqual(
    result.packages.map(p => p.bid_price),
    [undefined, 12, 1, undefined, undefined]
  );
  assert.deepEqual(result.packages[3].bidding, { max_bid: 9 });
  assert.deepEqual(authored, before, 'request preparation must not mutate the storyboard');
  assert.equal(auction.bid_price, undefined, 'request preparation must not mutate discovered offers');
});

test('both auction packages receive bids and media-buy bidding suppresses every legacy bid', () => {
  const authored = step();
  assert.deepEqual(
    buildRequest(authored, context, options).packages.map(p => p.bid_price),
    [12, 12]
  );
  authored.sample_request.bidding = { max_bid: 10 };
  assert.deepEqual(
    buildRequest(authored, context, options).packages.map(p => p.bid_price),
    [undefined, undefined]
  );
});

test('semantic negative probes enrich only by explicit opt-in', async () => {
  const authored = step({ expect_error: true, negative_path: 'payload_well_formed' });
  authored.sample_request.packages = [
    {
      product_id: '$context.product_id',
      pricing_option_id: '$context.pricing_option_id',
      budget: 5000,
      measurement_terms: { billing_measurement: { measurement_window: 'c28', max_variance_percent: 0 } },
    },
  ];
  async function prepare(probe, overrides = {}) {
    let captured;
    const storyboard = {
      id: 'auction_semantic_probe',
      version: '1.0',
      title: 'Auction semantic probe',
      category: 'media_buy',
      summary: '',
      narrative: '',
      agent: { interaction_model: 'media_buy_seller', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [{ id: 'main', title: 'Main', steps: [probe] }],
    };
    const tools = ['create_media_buy'];
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      ...options,
      context,
      _profile: { tools },
      agentTools: tools,
      ...overrides,
      _client: {
        resetContext() {},
        async createMediaBuy(request) {
          captured = structuredClone(request);
          return { success: false, error: 'Unsupported terms' };
        },
      },
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result.phases));
    assert.ok(captured);
    return captured;
  }
  const raw = await prepare(authored);
  assert.equal(raw.packages[0].bid_price, undefined, 'default preserves intentional omission');
  const opted = { ...authored, enrich_request: true };
  const prepared = await prepare(opted);
  assert.equal(prepared.packages[0].bid_price, 12);
  assert.deepEqual(prepared.packages[0].measurement_terms, authored.sample_request.packages[0].measurement_terms);
  const override = await prepare(opted, { request: authored.sample_request });
  assert.equal(override.packages[0].bid_price, undefined, 'caller request override remains authoritative');
});

test('enrichment is rejected for malformed-input probes and non-negative steps', () => {
  for (const overrides of [{ expect_error: true }, { expect_error: true, negative_path: 'schema_invalid' }, {}]) {
    const authored = step({ ...overrides, enrich_request: true });
    assert.throws(
      () => validateStoryboardShape({ id: 'pricing', phases: [{ id: 'main', steps: [authored] }] }),
      /enrich_request requires/
    );
  }
  const authored = step({ expect_error: true, negative_path: 'payload_well_formed', enrich_request: true });
  assert.doesNotThrow(() => validateStoryboardShape({ id: 'pricing', phases: [{ id: 'main', steps: [authored] }] }));
});

for (const account of [
  { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: false },
  { account_id: 'seller-cache-account', sandbox: false },
]) {
  test(`stale-cache forcing preserves authored account scope: ${JSON.stringify(account)}`, () => {
    const authored = {
      id: 'force',
      title: 'Force outage',
      task: 'comply_test_controller',
      sample_request: { scenario: 'force_upstream_unavailable', account, params: { tool: 'get_products' } },
    };
    const before = structuredClone(authored);
    const result = buildRequest(authored, { account: { account_id: 'harness-account' } }, options);
    assert.deepEqual(result.account, { ...account, sandbox: true });
    assert.deepEqual(authored, before);
  });
}

test('sandbox-only stale hints and seed-account directives use the harness account', () => {
  for (const [scenario, account] of [
    ['force_upstream_unavailable', { sandbox: true }],
    ['seed_account', { account_id: 'account-being-seeded', sandbox: false }],
  ]) {
    const result = buildRequest(
      {
        id: 'controller',
        title: 'Controller',
        task: 'comply_test_controller',
        sample_request: { scenario, account },
      },
      { account: { account_id: 'harness-account' } },
      options
    );
    assert.deepEqual(result.account, { account_id: 'harness-account', sandbox: true });
  }
});
