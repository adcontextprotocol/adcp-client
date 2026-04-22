const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  mergeSeed,
  overlayById,
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

  // Falsy leaves must override base — only `undefined`/`null` are treated
  // as "absent." Most common permissive-merge bug is coercing `0`/`false`/`""`
  // to "missing" and quietly preserving the base value.
  it('lets 0 in seed override a non-zero base', () => {
    const merged = mergeSeed({ rate: 10 }, { rate: 0 });
    assert.strictEqual(merged.rate, 0);
  });

  it('lets false in seed override true in base', () => {
    const merged = mergeSeed({ approved: true }, { approved: false });
    assert.strictEqual(merged.approved, false);
  });

  it('lets empty string in seed override a non-empty base', () => {
    const merged = mergeSeed({ note: 'keep me' }, { note: '' });
    assert.strictEqual(merged.note, '');
  });

  it('lets an empty array in seed override a non-empty base', () => {
    const merged = mergeSeed({ tags: ['a', 'b'] }, { tags: [] });
    assert.deepStrictEqual(merged.tags, []);
  });
});

describe('overlayById', () => {
  it('overlays matched entries and preserves unmatched base entries', () => {
    const base = [
      { id: 'a', rate: 1 },
      { id: 'b', rate: 2 },
      { id: 'c', rate: 3 },
    ];
    const seed = [{ id: 'b', rate: 99, note: 'seeded' }];
    const out = overlayById(base, seed, 'id');
    assert.deepStrictEqual(out, [
      { id: 'a', rate: 1 },
      { id: 'b', rate: 99, note: 'seeded' },
      { id: 'c', rate: 3 },
    ]);
  });

  it('appends seed entries with no base match', () => {
    const base = [{ id: 'a' }];
    const seed = [{ id: 'b' }];
    const out = overlayById(base, seed, 'id');
    assert.deepStrictEqual(out, [{ id: 'a' }, { id: 'b' }]);
  });

  it('returns a copy of base when seed is undefined', () => {
    const base = [{ id: 'a' }];
    const out = overlayById(base, undefined, 'id');
    assert.deepStrictEqual(out, [{ id: 'a' }]);
    assert.notStrictEqual(out, base);
  });

  it('returns seed when base is empty', () => {
    const seed = [{ id: 'a' }];
    const out = overlayById([], seed, 'id');
    assert.deepStrictEqual(out, [{ id: 'a' }]);
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

  it('overlays pricing_options by pricing_option_id, preserving other entries', () => {
    const base = {
      pricing_options: [
        { pricing_option_id: 'default', pricing_model: 'cpm', currency: 'USD', rate: 10 },
        { pricing_option_id: 'premium', pricing_model: 'cpm', currency: 'USD', rate: 25 },
      ],
    };
    // Seed only the 'premium' option with a new rate; 'default' must stay.
    const seed = {
      pricing_options: [{ pricing_option_id: 'premium', rate: 50 }],
    };
    const merged = mergeSeedProduct(base, seed);
    assert.strictEqual(merged.pricing_options.length, 2);
    const byId = Object.fromEntries(merged.pricing_options.map(p => [p.pricing_option_id, p]));
    assert.strictEqual(byId.default.rate, 10, 'untouched entry preserved');
    assert.strictEqual(byId.premium.rate, 50, 'matched entry overlaid');
    assert.strictEqual(byId.premium.pricing_model, 'cpm', 'base fields kept on overlay');
  });

  it('overlays publisher_properties by (publisher_domain, selection_type)', () => {
    const base = {
      publisher_properties: [
        { publisher_domain: 'a.example', selection_type: 'all' },
        { publisher_domain: 'b.example', selection_type: 'by_tag', property_tags: ['news'] },
      ],
    };
    const seed = {
      publisher_properties: [
        { publisher_domain: 'b.example', selection_type: 'by_tag', property_tags: ['news', 'sports'] },
      ],
    };
    const merged = mergeSeedProduct(base, seed);
    assert.strictEqual(merged.publisher_properties.length, 2);
    const bEntry = merged.publisher_properties.find(
      p => p.publisher_domain === 'b.example' && p.selection_type === 'by_tag'
    );
    assert.deepStrictEqual(bEntry.property_tags, ['news', 'sports']);
    // The 'a.example' + 'all' entry should be untouched.
    const aEntry = merged.publisher_properties.find(p => p.publisher_domain === 'a.example');
    assert.strictEqual(aEntry.selection_type, 'all');
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

  it('overlays top-level assets[] by asset_id', () => {
    const base = {
      creative_id: 'cr-1',
      assets: [
        { asset_id: 'hero', url: 'https://cdn/hero.jpg' },
        { asset_id: 'logo', url: 'https://cdn/logo.png' },
      ],
    };
    const seed = { assets: [{ asset_id: 'hero', url: 'https://cdn/hero-v2.jpg' }] };
    const merged = mergeSeedCreative(base, seed);
    assert.strictEqual(merged.assets.length, 2);
    const byId = Object.fromEntries(merged.assets.map(a => [a.asset_id, a.url]));
    assert.strictEqual(byId.hero, 'https://cdn/hero-v2.jpg');
    assert.strictEqual(byId.logo, 'https://cdn/logo.png');
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

  it('overlays findings[] by policy_id', () => {
    const base = {
      plan_id: 'pln-1',
      findings: [
        { policy_id: 'p-1', severity: 'warn' },
        { policy_id: 'p-2', severity: 'warn' },
      ],
    };
    const seed = { findings: [{ policy_id: 'p-2', severity: 'deny', note: 'blocked' }] };
    const merged = mergeSeedPlan(base, seed);
    assert.strictEqual(merged.findings.length, 2);
    const byId = Object.fromEntries(merged.findings.map(f => [f.policy_id, f]));
    assert.strictEqual(byId['p-1'].severity, 'warn');
    assert.strictEqual(byId['p-2'].severity, 'deny');
    assert.strictEqual(byId['p-2'].note, 'blocked');
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

  it('overlays packages[] by package_id without dropping untouched packages', () => {
    const base = {
      media_buy_id: 'mb-1',
      status: 'active',
      packages: [
        { package_id: 'pk-1', impressions: 1000 },
        { package_id: 'pk-2', impressions: 2000 },
        { package_id: 'pk-3', impressions: 3000 },
      ],
    };
    const seed = {
      packages: [{ package_id: 'pk-2', impressions: 2500, note: 'adjusted' }],
    };
    const merged = mergeSeedMediaBuy(base, seed);
    assert.strictEqual(merged.packages.length, 3);
    const byId = Object.fromEntries(merged.packages.map(p => [p.package_id, p]));
    assert.strictEqual(byId['pk-1'].impressions, 1000);
    assert.strictEqual(byId['pk-2'].impressions, 2500);
    assert.strictEqual(byId['pk-2'].note, 'adjusted');
    assert.strictEqual(byId['pk-3'].impressions, 3000);
  });
});
