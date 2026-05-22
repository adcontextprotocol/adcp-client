const { test, describe } = require('node:test');
const assert = require('node:assert');

const { WholesaleFeedSync } = require('../../dist/lib/wholesale-feed-sync/index.js');

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
    subscriber_id: 'wholesale-feed-sync',
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

describe('WholesaleFeedSync beta 3 wholesale feed flow', () => {
  const account = { account_id: 'acc_acme' };

  test('resolves auto-poll from wholesale_feed_versioning and records webhook event types', async () => {
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['product.updated', 'wholesale_feed.bulk_change'] },
      },
    });
    const sync = new WholesaleFeedSync({ client });

    await sync.start();

    assert.strictEqual(sync.mode, 'auto-poll');
    assert.strictEqual(sync.capabilities.wholesaleFeedVersioning, true);
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
        assert.deepStrictEqual(params.account, account);
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
        assert.deepStrictEqual(params.account, account);
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
    const sync = new WholesaleFeedSync({ client, account });

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
    const sync = new WholesaleFeedSync({
      client,
      account,
      webhookScope: { accountId: 'acc_acme', subscriberId: 'wholesale-feed-sync' },
    });
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

  test('applyWebhook applies signal created, updated, and removed deltas', async () => {
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: {
          supported: true,
          event_types: ['signal.created', 'signal.updated', 'signal.removed'],
        },
        signals: { discovery_modes: ['wholesale'] },
      },
      getProducts: () => makeProductsResult([], { wholesale_feed_version: 'products-v1' }),
      getSignals: () => makeSignalsResult([makeSignal('s1')], { wholesale_feed_version: 'sv1' }),
    });
    const sync = new WholesaleFeedSync({
      client,
      account,
      webhookScope: { accountId: 'acc_acme', subscriberId: 'wholesale-feed-sync' },
    });
    const typed = [];
    sync.on('signal.created', ({ event }) => typed.push(event.event_type));
    sync.on('signal.updated', ({ event }) => typed.push(event.event_type));
    sync.on('signal.removed', ({ event }) => typed.push(event.event_type));

    await sync.start();
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('signal.created', 'signal', 's2', {
          signal_agent_segment_id: 's2',
          signal: makeSignal('s2'),
          applies_to: { scope: 'public' },
        }),
        { version: 'sv2', previous: 'sv1' }
      )
    );
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('signal.updated', 'signal', 's2', {
          signal_agent_segment_id: 's2',
          signal: makeSignal('s2', { name: 'Updated Signal' }),
          applies_to: { scope: 'public' },
        }),
        { version: 'sv3', previous: 'sv2' }
      )
    );
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('signal.removed', 'signal', 's1', {
          signal_agent_segment_id: 's1',
          applies_to: { scope: 'public' },
        }),
        { version: 'sv4', previous: 'sv3' }
      )
    );

    assert.strictEqual(sync.signals.get('s2').name, 'Updated Signal');
    assert.strictEqual(sync.signals.get('s1'), undefined);
    assert.deepStrictEqual(typed, ['signal.created', 'signal.updated', 'signal.removed']);
    sync.stop();
  });

  test('wholesale_feed.bulk_change repairs by re-reading the affected wholesale mirror', async () => {
    let phase = 'initial';
    const { client, calls } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['wholesale_feed.bulk_change'] },
      },
      getProducts: () => {
        if (phase === 'initial') return makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' });
        return makeProductsResult([makeProduct('p1'), makeProduct('p2')], { wholesale_feed_version: 'v2' });
      },
    });
    const sync = new WholesaleFeedSync({ client, account, webhookScope: { accountId: 'acc_acme' } });
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
    assert.deepStrictEqual(calls.getProducts.at(-1).account, account);
    sync.stop();
  });

  test('signal wholesale_feed.bulk_change repairs only the signal mirror', async () => {
    let phase = 'initial';
    const { client, calls } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['wholesale_feed.bulk_change'] },
        signals: { discovery_modes: ['wholesale'] },
      },
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'products-v1' }),
      getSignals: () => {
        if (phase === 'initial') return makeSignalsResult([makeSignal('s1')], { wholesale_feed_version: 'sv1' });
        return makeSignalsResult([makeSignal('s1'), makeSignal('s2')], { wholesale_feed_version: 'sv2' });
      },
    });
    const sync = new WholesaleFeedSync({ client, account, webhookScope: { accountId: 'acc_acme' } });
    const reasons = [];
    const productEvents = [];
    sync.on('resyncing', ({ reason }) => reasons.push(reason));
    sync.on('event', ({ event }) => {
      if (event.entity_type === 'product') productEvents.push(event);
    });

    await sync.start();
    phase = 'bulk';
    await sync.applyWebhook(
      makeWebhook(
        makeEvent('wholesale_feed.bulk_change', 'feed', 'bulk-signals-1', {
          summary: 'Signal taxonomy refresh',
          affected_count: 2,
          affected_entity_type: 'signal',
          applies_to: { scope: 'public' },
        }),
        { version: 'sv2', previous: 'sv1' }
      )
    );

    assert.deepStrictEqual(reasons, ['bulk_change']);
    assert.strictEqual(sync.products.count, 1);
    assert.strictEqual(sync.signals.count, 2);
    assert.ok(sync.signals.get('s2'));
    assert.strictEqual(calls.getProducts.length, 1);
    assert.strictEqual(calls.getSignals.length, 2);
    assert.strictEqual(productEvents.length, 0);
    sync.stop();
  });

  test('malformed bulk_change deliveries are deduped after terminal rejection', async () => {
    const { client } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
        wholesale_feed_webhooks: { supported: true, event_types: ['wholesale_feed.bulk_change'] },
      },
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' }),
    });
    const sync = new WholesaleFeedSync({ client, account, webhookScope: { accountId: 'acc_acme' } });
    const webhook = makeWebhook(
      makeEvent('wholesale_feed.bulk_change', 'feed', 'bulk-bad', {
        summary: 'Malformed feed refresh',
        affected_count: 1,
        applies_to: { scope: 'public' },
      }),
      { version: 'v2', previous: 'v1' }
    );

    await sync.start();
    await assert.rejects(() => sync.applyWebhook(webhook), /affected_entity_type/);
    await sync.applyWebhook(webhook);

    assert.strictEqual(sync.products.count, 1);
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
    const sync = new WholesaleFeedSync({ client, account });
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
    const sync = new WholesaleFeedSync({ client });
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

  test('account-scoped webhook rejects misrouted subscribers before mutating the mirror', async () => {
    const { client } = makeStubClient({
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' }),
    });
    const sync = new WholesaleFeedSync({
      client,
      account,
      webhookScope: { accountId: 'acc_acme', subscriberId: 'wholesale-feed-sync' },
    });
    await sync.start();

    await assert.rejects(
      () =>
        sync.applyWebhook(
          makeWebhook(
            makeEvent('product.updated', 'product', 'p1', {
              product_id: 'p1',
              product: makeProduct('p1', { name: 'Wrong Account' }),
              applies_to: { scope: 'account', account_ids: ['acc_other'] },
            }),
            { version: 'v2', previous: 'v1', cache_scope: 'account' }
          )
        ),
      /account overlay/
    );

    await assert.rejects(
      () =>
        sync.applyWebhook({
          ...makeWebhook(
            makeEvent('product.updated', 'product', 'p1', {
              product_id: 'p1',
              product: makeProduct('p1', { name: 'Wrong Subscriber' }),
              applies_to: { scope: 'account', account_ids: ['acc_acme'] },
            }),
            { version: 'v2', previous: 'v1', cache_scope: 'account' }
          ),
          subscriber_id: 'other-subscriber',
        }),
      /subscriber_id/
    );

    assert.strictEqual(sync.products.get('p1').name, 'Product p1');
    sync.stop();
  });

  test('dedupes retry and logical re-emission webhooks before emitting duplicate events', async () => {
    const { client } = makeStubClient({
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' }),
    });
    const sync = new WholesaleFeedSync({ client, account, webhookScope: { accountId: 'acc_acme' } });
    const seen = [];
    sync.on('product.updated', ({ event }) => seen.push(event.event_id));

    await sync.start();
    const event = makeEvent('product.updated', 'product', 'p1', {
      product_id: 'p1',
      product: makeProduct('p1', { name: 'Updated Once' }),
      applies_to: { scope: 'public' },
    });
    await sync.applyWebhook(makeWebhook(event, { version: 'v2', previous: 'v1' }));
    await sync.applyWebhook(makeWebhook(event, { version: 'v2', previous: 'v1' }));
    await sync.applyWebhook({
      ...makeWebhook(event, { version: 'v2', previous: 'v1' }),
      idempotency_key: 'new-delivery-same-event',
    });

    assert.deepStrictEqual(seen, [event.event_id]);
    assert.strictEqual(sync.products.get('p1').name, 'Updated Once');
    sync.stop();
  });

  test('wildcard webhook listeners observe the post-mutation mirror state', async () => {
    const { client } = makeStubClient({
      getProducts: () => makeProductsResult([makeProduct('p1')], { wholesale_feed_version: 'v1' }),
    });
    const sync = new WholesaleFeedSync({ client, account });
    const observedNames = [];
    sync.on('event', () => observedNames.push(sync.products.get('p1').name));

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

    assert.deepStrictEqual(observedNames, ['Updated Product']);
    sync.stop();
  });

  test('webhook structural updates preserve pricing_version for the next conditional repair read', async () => {
    let phase = 'initial';
    const { client, calls } = makeStubClient({
      capabilities: {
        wholesale_feed_versioning: { supported: true },
      },
      getProducts: (params, callNumber) => {
        if (callNumber === 1) {
          return makeProductsResult([makeProduct('p1')], {
            wholesale_feed_version: 'v1',
            pricing_version: 'price-v1',
          });
        }
        assert.strictEqual(phase, 'refresh');
        return makeUnchangedResult({
          wholesale_feed_version: 'v2',
          pricing_version: 'price-v1',
        });
      },
    });
    const sync = new WholesaleFeedSync({ client, account });

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
    phase = 'refresh';
    await sync.refresh();

    assert.strictEqual(calls.getProducts.at(-1).if_wholesale_feed_version, 'v2');
    assert.strictEqual(calls.getProducts.at(-1).if_pricing_version, 'price-v1');
    sync.stop();
  });
});
