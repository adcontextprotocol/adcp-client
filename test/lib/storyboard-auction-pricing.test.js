const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder');
const { buildStepRequest } = require('../../dist/lib/testing/storyboard/runner');
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

test('semantic negative probes enrich only by explicit opt-in', () => {
  const authored = step({ expect_error: true, negative_path: 'payload_well_formed' });
  authored.sample_request.packages = [
    {
      product_id: '$context.product_id',
      pricing_option_id: '$context.pricing_option_id',
      budget: 5000,
      measurement_terms: { billing_measurement: { measurement_window: 'c28', max_variance_percent: 0 } },
    },
  ];
  const raw = buildStepRequest(authored, authored, context, options);
  assert.equal(raw.packages[0].bid_price, undefined, 'default preserves intentional omission');
  const opted = { ...authored, enrich_request: true };
  const prepared = buildStepRequest(opted, opted, context, options);
  assert.equal(prepared.packages[0].bid_price, 12);
  assert.deepEqual(prepared.packages[0].measurement_terms, authored.sample_request.packages[0].measurement_terms);
  const override = buildStepRequest(opted, opted, context, { ...options, request: authored.sample_request });
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

test('runner prepares the second product CPC bid from its own discovered floor', () => {
  const discovered = {
    products: [
      { product_id: 'sports', pricing_options: [{ ...auction, pricing_option_id: 'sports-cpm', floor_price: 10 }] },
      {
        product_id: 'shop',
        pricing_options: [{ ...auction, pricing_option_id: 'shop-cpc', pricing_model: 'cpc', floor_price: 0.8 }],
      },
    ],
  };
  const authored = step();
  authored.sample_request.packages = [
    { product_id: 'sports', pricing_option_id: 'sports-cpm', budget: 5000 },
    { product_id: 'shop', pricing_option_id: 'shop-cpc', budget: 5000 },
  ];
  const before = structuredClone({ authored, discovered });
  const request = buildStepRequest(authored, authored, discovered, options);
  assert.deepEqual(
    request.packages.map(p => p.bid_price),
    [15, 1.2]
  );
  assert.deepEqual(
    request.packages.map(p => p.product_id),
    ['sports', 'shop']
  );
  assert.deepEqual({ authored, discovered }, before);
});

test('all schema auction models receive bids while fixed and non-bid models do not', () => {
  const models = ['cpm', 'vcpm', 'cpc', 'cpcv', 'cpv', 'cpp', 'flat_rate', 'time'];
  const prices = models.map(pricing_model => ({ ...auction, pricing_option_id: pricing_model, pricing_model }));
  prices.push(
    { ...fixed, pricing_option_id: 'fixed-cpc', pricing_model: 'cpc', fixed_price: 0 },
    { ...auction, pricing_option_id: 'legacy-fixed', is_fixed: true },
    { ...auction, pricing_option_id: 'legacy-rate', rate: 1 },
    { pricing_option_id: 'cpa', pricing_model: 'cpa', currency: 'USD', event_type: 'purchase', fixed_price: 1 },
    { pricing_option_id: 'revenue', pricing_model: 'revenue_share', currency: 'USD', commission_rate: 0.1 },
    { pricing_option_id: 'unknown', pricing_model: 'future_model', currency: 'USD' }
  );
  const authored = step();
  authored.sample_request.packages = prices.map(price => pkg(price.pricing_option_id));
  const result = buildRequest(authored, { products: [{ product_id: 'display', pricing_options: prices }] }, options);
  assert.deepEqual(
    result.packages.map(p => p.bid_price),
    [...models.map(() => 12), ...Array(6).fill(undefined)]
  );
});

test('zero, absent and sub-cent auction floors yield valid bids without masking invalid floors', () => {
  const floors = [0, undefined, 0.001, 0.004, 0.008, Number.MAX_VALUE, -1, null, '0.8', Infinity];
  const prices = floors.map((floor_price, i) => ({
    ...auction,
    pricing_option_id: `floor-${i}`,
    pricing_model: 'cpc',
    floor_price,
  }));
  const authored = step();
  authored.sample_request.packages = prices.map(price => pkg(price.pricing_option_id));
  const result = buildRequest(authored, { products: [{ product_id: 'display', pricing_options: prices }] }, options);
  assert.deepEqual(
    result.packages.map(p => p.bid_price),
    [0, 7.5, 0.001, 0.01, 0.01, Number.MAX_VALUE, undefined, undefined, undefined, undefined]
  );
  for (let i = 0; i < 6; i++) {
    assert.equal(Number.isFinite(result.packages[i].bid_price), true);
    assert.ok(result.packages[i].bid_price >= (floors[i] ?? 0));
  }
});

test('CPC explicit bids, package bidding, buy bidding and caller overrides remain authoritative', () => {
  const cpcContext = {
    products: [{ product_id: 'display', pricing_options: [{ ...auction, pricing_model: 'cpc', floor_price: 0.8 }] }],
  };
  const authored = step();
  authored.sample_request.packages = [
    { ...pkg('auction'), bid_price: 0 },
    { ...pkg('auction'), bidding: { automatic: true } },
    pkg('auction'),
  ];
  assert.deepEqual(
    buildStepRequest(authored, authored, cpcContext, options).packages.map(p => p.bid_price),
    [0, undefined, 1.2]
  );
  authored.sample_request.bidding = { automatic: true };
  assert.deepEqual(
    buildStepRequest(authored, authored, cpcContext, options).packages.map(p => p.bid_price),
    [0, undefined, undefined]
  );
  delete authored.sample_request.bidding;
  const override = { ...authored.sample_request, packages: [pkg('auction')] };
  assert.equal(
    buildStepRequest(authored, authored, cpcContext, { ...options, request: override }).packages[0].bid_price,
    undefined
  );
});
