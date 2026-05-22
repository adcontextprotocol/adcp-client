const { test, describe } = require('node:test');
const assert = require('node:assert');

const { CatalogSync } = require('../../dist/lib/catalog-sync/index.js');

function makeCapabilitiesResult(stanza) {
  return { data: stanza };
}

function makeProductsResult(
  products,
  { wholesale_feed_version, pricing_version, cache_scope = 'public', pagination } = {}
) {
  return {
    data: {
      products,
      cache_scope,
      ...(wholesale_feed_version && { wholesale_feed_version }),
      ...(pricing_version && { pricing_version }),
      ...(pagination && { pagination }),
    },
  };
}

function makeSignalsResult(
  signals,
  { wholesale_feed_version, pricing_version, cache_scope = 'public', pagination } = {}
) {
  return {
    data: {
      signals,
      cache_scope,
      ...(wholesale_feed_version && { wholesale_feed_version }),
      ...(pricing_version && { pricing_version }),
      ...(pagination && { pagination }),
    },
  };
}

function makeUnchangedResult({ wholesale_feed_version, pricing_version, cache_scope = 'public' }) {
  return {
    data: {
      unchanged: true,
      wholesale_feed_version,
      ...(pricing_version && { pricing_version }),
      cache_scope,
    },
  };
}

function makeProduct(product_id, overrides = {}) {
  return {
    product_id,
    name: `Product ${product_id}`,
    description: `Description for ${product_id}`,
    delivery_type: 'guaranteed',
    format_ids: [{ id: 'video_ctv_1080p_30s' }],
    pricing_options: [{ pricing_option_id: 'po_cpm_v1', pricing_model: 'cpm', currency: 'USD', fixed_price: 18.5 }],
    ...overrides,
  };
}

function makeSignal(signal_agent_segment_id, overrides = {}) {
  return {
    signal_id: {
      source: 'catalog',
      data_provider_domain: 'acme-data.com',
      id: signal_agent_segment_id,
    },
    signal_agent_segment_id,
    name: `Signal ${signal_agent_segment_id}`,
    description: `Description for ${signal_agent_segment_id}`,
    signal_type: 'marketplace',
    data_provider: 'Acme Data',
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_1', model: 'cpm', cpm: 2.5, currency: 'USD' }],
    ...overrides,
  };
}

function makeWebhook(event, { version = 'v2', previous = 'v1', cache_scope = 'public' } = {}) {
  return {
    idempotency_key: `idem-${event.event_id}`,
    notification_id: event.event_id,
    notification_type: event.event_type,
    fired_at: '2026-05-22T12:00:00Z',
    subscriber_id: 'catalog-sync',
    account_id: 'acc_acme',
    wholesale_feed_version: version,
    previous_wholesale_feed_version: previous,
    cache_scope,
    event,
  };
}

function makeEvent(event_type, entity_type, entity_id, payload) {
  return {
    event_id: `018f-${entity_id}-${event_type}`,
    event_type,
    entity_type,
    entity_id,
    created_at: '2026-05-22T12:00:00Z',
    payload,
  };
}

function makeStubClient(opts = {}) {
  const calls = { capabilities: 0, getProducts: [], getSignals: [] };
  const client = {
    async getAdcpCapabilities() {
      calls.capabilities++;
      return makeCapabilitiesResult(opts.capabilities ?? {});
    },
    async getProducts(params) {
      calls.getProducts.push(params);
      if (typeof opts.getProducts === 'function') return opts.getProducts(params, calls.getProducts.length);
      return makeProductsResult([]);
    },
    async getSignals(params) {
      calls.getSignals.push(params);
      if (typeof opts.getSignals === 'function') return opts.getSignals(params, calls.getSignals.length);
      return makeSignalsResult([]);
    },
  };
  return { client, calls };
}

describe('CatalogSync beta 3 wholesale feed flow', () => {
  test('resolves auto-poll from wholesale_feed_versioning and records webhook event types', async () => {
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['product.updated', 'wholesale_feed.bulk_change'] },
      },
    });
    const sync = new CatalogSync({ client });

    await sync.start();

    assert.strictEqual(sync.mode, 'auto-poll');
    assert.strictEqual(sync.capabilities.wholesaleFeedVersioning, true);
    assert.strictEqual(sync.capabilities.catalogVersioning, true, 'legacy alias remains true');
    assert.strictEqual(sync.capabilities.webhooks, true);
    assert.deepStrictEqual([...sync.capabilities.eventTypes], ['product.updated', 'wholesale_feed.bulk_change']);
    sync.stop();
  });

  test('bootstraps wholesale products and signals, then preserves mirrors on unchanged probes', async () => {
    const product = makeProduct('p1');
    const signal = makeSignal('s1');
    const { client, calls } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        signals: { discovery_modes: ['wholesale'] },
      },
      getProducts: (params, callNumber) => {
        if (callNumber === 1) {
          return makeProductsResult([product], {
            wholesale_feed_version: 'products-v1',
            pricing_version: 'products-price-v1',
          });
        }
        assert.strictEqual(params.if_wholesale_feed_version, 'products-v1');
        assert.strictEqual(params.if_pricing_version, 'products-price-v1');
        return makeUnchangedResult({
          wholesale_feed_version: 'products-v1',
          pricing_version: 'products-price-v1',
        });
      },
      getSignals: (params, callNumber) => {
        if (callNumber === 1) {
          return makeSignalsResult([signal], {
            wholesale_feed_version: 'signals-v1',
            pricing_version: 'signals-price-v1',
          });
        }
        assert.strictEqual(params.if_wholesale_feed_version, 'signals-v1');
        assert.strictEqual(params.if_pricing_version, 'signals-price-v1');
        return makeUnchangedResult({
          wholesale_feed_version: 'signals-v1',
          pricing_version: 'signals-price-v1',
        });
      },
    });
    const sync = new CatalogSync({ client });

    await sync.start();
    await sync.refresh();

    assert.strictEqual(sync.products.count, 1);
    assert.strictEqual(sync.products.get('p1').name, 'Product p1');
    assert.strictEqual(sync.signals.count, 1);
    assert.strictEqual(sync.signals.get('s1').name, 'Signal s1');
    assert.strictEqual(calls.getProducts.length, 2);
    assert.strictEqual(calls.getSignals.length, 2);
    sync.stop();
  });

  test('applyWebhook applies product and signal deltas and emits typed events', async () => {
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['product.updated', 'signal.priced'] },
        signals: { discovery_modes: ['wholesale'] },
      },
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' }),
      getSignals: () => makeSignalsResult([makeSignal('s1')], { wholesale_feed_version: 'sv1' }),
    });
    const sync = new CatalogSync({ client });
    const typed = [];
    const wildcard = [];
    sync.on('product.updated', ({ event }) => typed.push(event.event_type));
    sync.on('signal.priced', ({ event }) => typed.push(event.event_type));
    sync.on('event', ({ event }) => wildcard.push(event.event_type));

    await sync.start();
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('product.updated', 'product', 'p1', {
          product_id: 'p1',
          product: makeProduct('p1', { name: 'Updated Product' }),
          applies_to: { scope: 'public' },
        }),
        { version: 'v2', previous: 'v1' }
      )
    );
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('signal.priced', 'signal', 's1', {
          signal_agent_segment_id: 's1',
          pricing_options: [{ pricing_option_id: 'po_new', model: 'cpm', cpm: 4, currency: 'USD' }],
          applies_to: { scope: 'public' },
        }),
        { version: 'sv2', previous: 'sv1' }
      )
    );

    assert.strictEqual(sync.products.get('p1').name, 'Updated Product');
    assert.deepStrictEqual(sync.signals.get('s1').pricing_options, [
      { pricing_option_id: 'po_new', model: 'cpm', cpm: 4, currency: 'USD' },
    ]);
    assert.deepStrictEqual(typed, ['product.updated', 'signal.priced']);
    assert.deepStrictEqual(wildcard, ['product.updated', 'signal.priced']);
    sync.stop();
  });

  test('wholesale_feed.bulk_change repairs by re-reading the affected wholesale mirror', async () => {
    let phase = 'initial';
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['wholesale_feed.bulk_change'] },
      },
      getProducts: () => {
        if (phase === 'initial') return makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' });
        return makeProductsResult([makeProduct('p1'), makeProduct('p2')], { wholesale_feed_version: 'v2' });
      },
    });
    const sync = new CatalogSync({ client });
    const reasons = [];
    sync.on('resyncing', ({ reason }) => reasons.push(reason));

    await sync.start();
    phase = 'bulk';
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('wholesale_feed.bulk_change', 'feed', 'bulk-1', {
          summary: 'Q3 rate-card refresh',
          affected_count: 2,
          affected_entity_type: 'product',
          applies_to: { scope: 'public' },
        }),
        { version: 'v2', previous: 'v1' }
      )
    );

    assert.deepStrictEqual(reasons, ['bulk_change']);
    assert.strictEqual(sync.products.count, 2);
    assert.ok(sync.products.get('p2'));
    sync.stop();
  });

  test('out-of-order webhook version repairs instead of applying stale delta', async () => {
    let phase = 'initial';
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['product.updated'] },
      },
      getProducts: () => {
        if (phase === 'initial') return makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v5' });
        return makeProductsResult([makeProduct('p1', { name: 'Repaired Product' })], { wholesale_feed_version: 'v6' });
      },
    });
    const sync = new CatalogSync({ client });
    const reasons = [];
    sync.on('resyncing', ({ reason }) => reasons.push(reason));

    await sync.start();
    phase = 'repair';
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('product.updated', 'product', 'p1', {
          product_id: 'p1',
          product: makeProduct('p1', { name: 'Stale Webhook Product' }),
          applies_to: { scope: 'public' },
        }),
        { version: 'v6', previous: 'v4' }
      )
    );

    assert.deepStrictEqual(reasons, ['version_mismatch']);
    assert.strictEqual(sync.products.get('p1').name, 'Repaired Product');
    sync.stop();
  });

  test('rejects malformed webhook envelopes before mutating the mirror', async () => {
    const { client } = makeStubClient({
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' }),
    });
    const sync = new CatalogSync({ client });
    await sync.start();

    await assert.rejects(
      () =>
        sync.applyWebhook({
          ...makeWebhook(
            makeEvent('product.updated', 'product', 'p1', {
              product_id: 'p1',
              product: makeProduct('p1', { name: 'Bad Update' }),
              applies_to: { scope: 'public' },
            })
          ),
          notification_type: 'signal.updated',
        }),
      /notification_type/
    );
    assert.strictEqual(sync.products.get('p1').name, 'Product p1');
    sync.stop();
  });
});
