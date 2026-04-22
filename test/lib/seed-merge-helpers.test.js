const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  mergeSeed,
  mergeSeedProduct,
  mergeSeedPricingOption,
  mergeSeedCreative,
  mergeSeedPlan,
  mergeSeedMediaBuy,
} = require('../../dist/lib/testing');

describe('mergeSeed — permissive defaults + storyboard overlay', () => {
  it('keeps base fields untouched when seed omits them', () => {
    const base = { delivery_type: 'guaranteed', channels: ['display'] };
    const merged = mergeSeed(base, { name: 'Test' });
    assert.strictEqual(merged.delivery_type, 'guaranteed');
    assert.deepStrictEqual(merged.channels, ['display']);
    assert.strictEqual(merged.name, 'Test');
  });

  it('treats undefined seed fields as do-not-override', () => {
    const base = { delivery_type: 'guaranteed', name: 'Base Name' };
    const merged = mergeSeed(base, { name: undefined, description: 'from seed' });
    assert.strictEqual(merged.name, 'Base Name');
    assert.strictEqual(merged.description, 'from seed');
  });

  it('treats null seed fields as do-not-override', () => {
    const base = { delivery_type: 'guaranteed', name: 'Base Name' };
    const merged = mergeSeed(base, { name: null, description: 'from seed' });
    assert.strictEqual(merged.name, 'Base Name');
    assert.strictEqual(merged.description, 'from seed');
  });

  it('deep-merges nested plain objects', () => {
    const base = { reporting_capabilities: { metrics: ['impressions'], cadence: 'daily' } };
    const merged = mergeSeed(base, { reporting_capabilities: { cadence: 'hourly' } });
    assert.deepStrictEqual(merged.reporting_capabilities.metrics, ['impressions']);
    assert.strictEqual(merged.reporting_capabilities.cadence, 'hourly');
  });

  it('replaces arrays rather than concatenating', () => {
    const base = { channels: ['display', 'ctv'] };
    const merged = mergeSeed(base, { channels: ['social'] });
    assert.deepStrictEqual(merged.channels, ['social']);
  });

  it('returns the base unchanged when seed is undefined', () => {
    const base = { a: 1, b: 2 };
    const merged = mergeSeed(base, undefined);
    assert.deepStrictEqual(merged, base);
  });

  it('returns the base unchanged when seed is null', () => {
    const base = { a: 1, b: 2 };
    const merged = mergeSeed(base, null);
    assert.deepStrictEqual(merged, base);
  });

  it('does not mutate the base object', () => {
    const base = { nested: { inner: 'base' } };
    const seed = { nested: { inner: 'seed' } };
    const merged = mergeSeed(base, seed);
    assert.strictEqual(base.nested.inner, 'base');
    assert.strictEqual(merged.nested.inner, 'seed');
  });

  it('throws when a seed field carries a Map', () => {
    const base = { meta: {} };
    const seed = { meta: new Map() };
    assert.throws(() => mergeSeed(base, seed), /Map is not supported/);
  });

  it('throws when a seed field carries a Set', () => {
    const base = { tags: [] };
    const seed = { tags: new Set(['a']) };
    assert.throws(() => mergeSeed(base, seed), /Set is not supported/);
  });
});

describe('mergeSeedProduct', () => {
  it('fills in product defaults from base', () => {
    const base = {
      delivery_type: 'guaranteed',
      channels: ['display'],
      pricing_options: [{ pricing_option_id: 'default', pricing_model: 'cpm', currency: 'USD', rate: 10 }],
      reporting_capabilities: { metrics: ['impressions'] },
    };
    const seed = { product_id: 'prd-1', name: 'Homepage Takeover', description: 'Above the fold' };
    const merged = mergeSeedProduct(base, seed);
    assert.strictEqual(merged.product_id, 'prd-1');
    assert.strictEqual(merged.name, 'Homepage Takeover');
    assert.strictEqual(merged.delivery_type, 'guaranteed');
    assert.deepStrictEqual(merged.channels, ['display']);
    assert.strictEqual(merged.pricing_options.length, 1);
  });

  it('lets seed override scalar base fields', () => {
    const base = { delivery_type: 'guaranteed', channels: ['display'] };
    const seed = { delivery_type: 'non_guaranteed' };
    const merged = mergeSeedProduct(base, seed);
    assert.strictEqual(merged.delivery_type, 'non_guaranteed');
  });
});

describe('mergeSeedPricingOption', () => {
  it('overrides rate while keeping base pricing model', () => {
    const base = { pricing_option_id: 'default', pricing_model: 'cpm', currency: 'USD', rate: 10 };
    const merged = mergeSeedPricingOption(base, { rate: 25 });
    assert.strictEqual(merged.pricing_model, 'cpm');
    assert.strictEqual(merged.rate, 25);
  });
});

describe('mergeSeedCreative', () => {
  it('deep-merges creative manifest fields', () => {
    const base = { creative_id: 'cr-1', manifest: { format_id: { id: 'display_300x250' }, assets: {} } };
    const seed = { manifest: { assets: { image: 'https://cdn/img.jpg' } } };
    const merged = mergeSeedCreative(base, seed);
    assert.strictEqual(merged.creative_id, 'cr-1');
    assert.strictEqual(merged.manifest.format_id.id, 'display_300x250');
    assert.strictEqual(merged.manifest.assets.image, 'https://cdn/img.jpg');
  });
});

describe('mergeSeedPlan', () => {
  it('merges plan fields with array-replace semantics', () => {
    const base = { plan_id: 'pln-1', accounts: ['a'], config: { approval: 'manual' } };
    const seed = { accounts: ['b', 'c'] };
    const merged = mergeSeedPlan(base, seed);
    assert.strictEqual(merged.plan_id, 'pln-1');
    assert.deepStrictEqual(merged.accounts, ['b', 'c']);
    assert.strictEqual(merged.config.approval, 'manual');
  });
});

describe('mergeSeedMediaBuy', () => {
  it('applies status transition while preserving package list', () => {
    const base = {
      media_buy_id: 'mb-1',
      status: 'pending',
      packages: [{ package_id: 'pk-1' }],
    };
    const seed = { status: 'active' };
    const merged = mergeSeedMediaBuy(base, seed);
    assert.strictEqual(merged.status, 'active');
    assert.deepStrictEqual(merged.packages, [{ package_id: 'pk-1' }]);
  });
});
