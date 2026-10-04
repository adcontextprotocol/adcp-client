const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  refreshWholesaleFeed,
  applyWholesaleFeedWebhook,
  InMemoryWholesaleFeedMirrorStore,
} = require('../../dist/lib/wholesale-feed-sync');
const scope = { agentUrl: 'https://seller.example/mcp', accountKey: 'principal:account', entity: 'product' };
const account = { account_id: 'acc' };
const product = { product_id: 'p1', name: 'Original', pricing_options: [] };
const result = (items, version = 'v1', price = 'price1') => ({
  success: true,
  status: 'completed',
  data: { products: items, wholesale_feed_version: version, pricing_version: price, cache_scope: 'account' },
});
function options(store, getProducts) {
  return { store, scope, account, client: { getProducts } };
}
function webhook(overrides = {}) {
  const event = {
    event_id: '01900000-0000-7000-8000-000000000001',
    event_type: 'product.updated',
    entity_type: 'product',
    entity_id: 'p1',
    created_at: new Date().toISOString(),
    payload: {
      product_id: 'p1',
      product: { ...product, name: 'Updated' },
      applies_to: { scope: 'account', account_ids: ['acc'] },
    },
  };
  return {
    event,
    notification_type: event.event_type,
    notification_id: event.event_id,
    fired_at: new Date().toISOString(),
    idempotency_key: 'delivery1',
    account_id: 'acc',
    subscriber_id: 'sub',
    wholesale_feed_version: 'v2',
    previous_wholesale_feed_version: 'v1',
    cache_scope: 'account',
    ...overrides,
  };
}
test('stateless refresh commits row deltas and matching conditional tokens', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  const first = await refreshWholesaleFeed(options(store, async () => result([product])));
  assert.equal(first.outcome, 'applied');
  assert.equal(first.diff[0].event_type, 'product.created');
  const same = await refreshWholesaleFeed(
    options(store, async params => {
      assert.equal(params.if_wholesale_feed_version, 'v1');
      assert.equal(params.if_pricing_version, 'price1');
      return {
        success: true,
        status: 'completed',
        data: { unchanged: true, wholesale_feed_version: 'v1', pricing_version: 'price1', cache_scope: 'account' },
      };
    })
  );
  assert.equal(same.outcome, 'unchanged');
  assert.deepEqual(same.snapshot.items, [product]);
  const changed = await refreshWholesaleFeed(
    options(store, async () => result([{ ...product, product_id: 'p2' }], 'v2'))
  );
  assert.deepEqual(
    changed.diff.map(event => event.event_type),
    ['product.created', 'product.removed']
  );
  assert.deepEqual(
    (await store.read(scope)).items.map(item => item.product_id),
    ['p2']
  );
});
test('errors and inconsistent unchanged replies preserve the last good mirror', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  for (const getProducts of [
    async () => ({
      success: false,
      status: 'failed',
      adcpError: { code: 'RATE_LIMITED', recovery: 'transient', message: 'busy' },
    }),
    async () => ({ data: { unchanged: true, wholesale_feed_version: 'v1', pricing_version: 'different' } }),
  ]) {
    const outcome = await refreshWholesaleFeed(options(store, getProducts));
    assert.equal(outcome.outcome, 'degraded');
    assert.deepEqual((await store.read(scope)).items, [product]);
    assert.equal((await store.read(scope)).pricingVersion, 'price1');
  }
});
test('slow success and slow failure cannot overwrite a newer refresh', async () => {
  for (const staleResult of [result([product], 'old'), { success: false, status: 'failed', error: 'busy' }]) {
    const store = new InMemoryWholesaleFeedMirrorStore();
    let release;
    const stale = refreshWholesaleFeed(
      options(
        store,
        () =>
          new Promise(resolve => {
            release = resolve;
          })
      )
    );
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await refreshWholesaleFeed(options(store, async () => result([{ ...product, name: 'Newer' }], 'new')));
    release(staleResult);
    assert.equal((await stale).outcome, 'superseded');
    assert.equal((await store.read(scope)).wholesaleFeedVersion, 'new');
    assert.equal((await store.read(scope)).error, undefined);
  }
});
test('continuation pages can omit tokens without losing the first page metadata', async () => {
  for (const entity of ['product', 'signal']) {
    const store = new InMemoryWholesaleFeedMirrorStore();
    const feedScope = { ...scope, entity };
    const rowsKey = entity === 'product' ? 'products' : 'signals';
    const idKey = entity === 'product' ? 'product_id' : 'signal_agent_segment_id';
    let page = 0;
    const client = {
      [entity === 'product' ? 'getProducts' : 'getSignals']: async params => {
        if (page === 3) {
          assert.equal(params.if_wholesale_feed_version, 'v1');
          assert.equal(params.if_pricing_version, 'price1');
          return {
            data: { unchanged: true, wholesale_feed_version: 'v1', pricing_version: 'price1' },
          };
        }
        page++;
        assert.equal(params.pagination.cursor, page === 1 ? undefined : `page${page}`);
        return {
          data: {
            [rowsKey]: [{ [idKey]: `row${page}`, name: `Row ${page}`, pricing_options: [] }],
            ...(page === 1 && {
              wholesale_feed_version: 'v1',
              pricing_version: 'price1',
              cache_scope: 'account',
            }),
            pagination: { has_more: page < 3, ...(page < 3 && { cursor: `page${page + 1}` }) },
          },
        };
      },
    };
    const opts = { store, scope: feedScope, account, client };
    const first = await refreshWholesaleFeed(opts);
    assert.equal(first.outcome, 'applied');
    assert.equal(first.snapshot.items.length, 3);
    assert.equal(first.snapshot.wholesaleFeedVersion, 'v1');
    assert.equal(first.snapshot.pricingVersion, 'price1');
    assert.equal(first.snapshot.cacheScope, 'account');
    assert.equal((await refreshWholesaleFeed(opts)).outcome, 'unchanged');
  }
});
test('present but conflicting pagination metadata preserves the prior snapshot', async () => {
  for (const changed of [{ wholesale_feed_version: 'v3' }, { pricing_version: 'price3' }, { cache_scope: 'public' }]) {
    const store = new InMemoryWholesaleFeedMirrorStore();
    await refreshWholesaleFeed(options(store, async () => result([product])));
    let page = 0;
    const outcome = await refreshWholesaleFeed(
      options(store, async () => {
        const response = result([{ ...product, product_id: `p${++page}` }], 'v2');
        if (page === 1) response.data.pagination = { has_more: true, cursor: 'next' };
        else Object.assign(response.data, changed);
        return response;
      })
    );
    assert.equal(outcome.outcome, 'degraded');
    const preserved = await store.read(scope);
    assert.deepEqual(preserved.items, [product]);
    assert.equal(preserved.wholesaleFeedVersion, 'v1');
    assert.equal(preserved.pricingVersion, 'price1');
  }
});
test('webhook deltas use CAS and version mismatch repairs instead of applying stale data', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  let reads = 0;
  const opts = options(store, async () => {
    reads++;
    return result([product], 'v3');
  });
  await refreshWholesaleFeed(options(store, async () => result([product])));
  const applied = await applyWholesaleFeedWebhook({ ...opts, webhook: webhook() });
  assert.equal(applied.outcome, 'applied');
  assert.equal((await store.read(scope)).items[0].name, 'Updated');
  assert.equal((await applyWholesaleFeedWebhook({ ...opts, webhook: webhook() })).outcome, 'unchanged');
  assert.equal(reads, 0);
  await applyWholesaleFeedWebhook({
    ...opts,
    webhook: webhook({
      idempotency_key: 'other',
      event: { ...webhook().event, event_id: '01900000-0000-7000-8000-000000000002' },
      notification_id: '01900000-0000-7000-8000-000000000002',
    }),
  });
  assert.equal(reads, 1);
  assert.equal((await store.read(scope)).wholesaleFeedVersion, 'v3');
  await assert.rejects(
    applyWholesaleFeedWebhook({ ...opts, webhook: webhook({ account_id: 'other-account' }) }),
    /subscription/
  );
  assert.equal(reads, 1);
});
test('scope keys isolate sellers, accounts, and entity tracks', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  for (const isolated of [
    { ...scope, agentUrl: 'other' },
    { ...scope, accountKey: 'other' },
    { ...scope, entity: 'signal' },
  ])
    assert.deepEqual((await store.read(isolated)).items, []);
});

test('bulk repair records the watermark and receipt, then deduplicates redelivery', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  const event = {
    ...webhook().event,
    event_type: 'wholesale_feed.bulk_change',
    entity_type: 'feed',
    entity_id: 'products',
    payload: {
      affected_entity_type: 'product',
      affected_count: 1,
      summary: 'catalog changed',
      applies_to: { scope: 'account', account_ids: ['acc'] },
    },
  };
  const delivery = webhook({ event, notification_type: event.event_type });
  let reads = 0;
  const opts = {
    ...options(store, async () => {
      reads++;
      return result([product], 'v2');
    }),
    webhook: delivery,
  };
  await applyWholesaleFeedWebhook(opts);
  assert.equal(await store.hasWebhookReceipt(scope, delivery.idempotency_key), true);
  assert.equal((await store.read(scope)).lastWebhookEventId, event.event_id);
  await applyWholesaleFeedWebhook(opts);
  assert.equal(reads, 1);
});
test('malformed identity cannot be mistaken for a duplicate on an empty store', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await assert.rejects(
    applyWholesaleFeedWebhook({
      ...options(store, async () => assert.fail('no read')),
      webhook: webhook({ idempotency_key: undefined }),
    }),
    /idempotency_key/
  );
  assert.equal((await store.read(scope)).revision, 0);
});
test('a lost webhook CAS retries against the new revision without dropping the event', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  const commit = store.commit.bind(store);
  let collided = false;
  store.commit = async (...args) => {
    if (!collided) {
      collided = true;
      await store.recordError(scope, args[1], { code: 'SERVICE_UNAVAILABLE', recovery: 'transient' });
      return false;
    }
    return commit(...args);
  };
  const applied = await applyWholesaleFeedWebhook({
    ...options(store, async () => assert.fail('matching version needs no fetch')),
    webhook: webhook(),
  });
  assert.equal(applied.outcome, 'applied');
  assert.equal((await store.read(scope)).items[0].name, 'Updated');
});
test('caller mutation cannot change an in-flight storage scope', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  const mutable = { ...scope };
  let finish;
  const pending = refreshWholesaleFeed({
    ...options(
      store,
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    ),
    scope: mutable,
  });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  mutable.accountKey = 'other-tenant';
  finish(result([product]));
  await pending;
  assert.equal((await store.read(scope)).items.length, 1);
  assert.equal((await store.read(mutable)).items.length, 0);
});
test('conditional checks only require a pricing echo when that token was sent', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product], 'v1', undefined)));
  // Seed an older seller snapshot that did not advertise independent pricing.
  const snapshot = await store.read(scope);
  store.restore(scope, { ...snapshot, pricingVersion: undefined });
  const outcome = await refreshWholesaleFeed(
    options(store, async params => {
      assert.equal(params.if_pricing_version, undefined);
      return {
        data: { unchanged: true, wholesale_feed_version: 'v1', pricing_version: 'new-price', cache_scope: 'account' },
      };
    })
  );
  assert.equal(outcome.outcome, 'unchanged');
  assert.equal(outcome.snapshot.pricingVersion, 'new-price');
});

test('transport error messages remain local rather than entering persisted error envelopes', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  const cause = new Error('connect failed at private.internal with secret-token');
  const outcome = await refreshWholesaleFeed(
    options(store, async () => {
      throw cause;
    })
  );
  assert.equal(outcome.outcome, 'degraded');
  assert.equal(outcome.cause, cause);
  assert.equal(outcome.error.message, 'Wholesale feed refresh failed.');
  assert.equal(JSON.stringify(await store.read(scope)).includes('secret-token'), false);
});

test('receipt capacity rejects new delivery atomically without evicting prior receipts', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore(1);
  await refreshWholesaleFeed(options(store, async () => result([product])));
  const opts = options(store, async () => result([product], 'v3'));
  await applyWholesaleFeedWebhook({ ...opts, webhook: webhook() });
  const before = await store.read(scope);
  const eventId = '01900000-0000-7000-8000-000000000002';
  await assert.rejects(
    applyWholesaleFeedWebhook({
      ...opts,
      webhook: webhook({
        idempotency_key: 'delivery2',
        notification_id: eventId,
        event: { ...webhook().event, event_id: eventId },
        previous_wholesale_feed_version: 'v2',
        wholesale_feed_version: 'v3',
      }),
    }),
    /receipt capacity/
  );
  assert.deepEqual(await store.read(scope), before);
  assert.equal(await store.hasWebhookReceipt(scope, 'delivery1'), true);
  assert.equal(await store.hasWebhookReceipt(scope, 'delivery2'), false);
});

test('cache overlay changes repair unconditionally without retaining rows from the old overlay', async () => {
  for (const [before, after] of [
    ['public', 'account'],
    ['account', 'public'],
  ]) {
    const store = new InMemoryWholesaleFeedMirrorStore();
    const initial = result([{ ...product, product_id: 'old-only' }]);
    initial.data.cache_scope = before;
    await refreshWholesaleFeed(options(store, async () => initial));
    const delivery = webhook({ cache_scope: after });
    delivery.event.payload.applies_to = after === 'account' ? { scope: after, account_ids: ['acc'] } : { scope: after };
    const repaired = await applyWholesaleFeedWebhook({
      ...options(store, async params => {
        assert.equal(params.if_wholesale_feed_version, undefined);
        const fresh = result([{ ...product, product_id: 'new-only' }], 'v3');
        fresh.data.cache_scope = after;
        return fresh;
      }),
      webhook: delivery,
    });
    assert.equal(repaired.outcome, 'applied');
    assert.deepEqual(
      repaired.snapshot.items.map(item => item.product_id),
      ['new-only']
    );
    assert.equal(repaired.snapshot.cacheScope, after);
  }
});

test('a delta without its predecessor token repairs instead of assuming seller continuity', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  let reads = 0;
  await applyWholesaleFeedWebhook({
    ...options(store, async () => {
      reads++;
      return result([], 'v3');
    }),
    webhook: webhook({ previous_wholesale_feed_version: undefined }),
  });
  assert.equal(reads, 1);
  assert.deepEqual((await store.read(scope)).items, []);
  assert.equal((await store.read(scope)).wholesaleFeedVersion, 'v3');
});

test('a lagging repair cannot acknowledge or record a delivery it has not observed', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  let caughtUp = false;
  const opts = {
    ...options(store, async () =>
      caughtUp
        ? result([], 'v2')
        : {
            data: { unchanged: true, wholesale_feed_version: 'v1', pricing_version: 'price1', cache_scope: 'account' },
          }
    ),
    webhook: webhook({ previous_wholesale_feed_version: 'older' }),
  };
  const lagging = await applyWholesaleFeedWebhook(opts);
  assert.equal(lagging.outcome, 'degraded');
  assert.equal(await store.hasWebhookReceipt(scope, 'delivery1'), false);
  assert.deepEqual((await store.read(scope)).items, [product]);
  caughtUp = true;
  assert.equal((await applyWholesaleFeedWebhook(opts)).outcome, 'applied');
  assert.equal(await store.hasWebhookReceipt(scope, 'delivery1'), true);
});

test('a known stale UUIDv7 delivery can acknowledge an authoritative unchanged repair', async () => {
  const store = new InMemoryWholesaleFeedMirrorStore();
  await refreshWholesaleFeed(options(store, async () => result([product])));
  const later = '01900000-0000-7000-8000-000000000002';
  await applyWholesaleFeedWebhook({
    ...options(store, async () => assert.fail()),
    webhook: webhook({
      event: { ...webhook().event, event_id: later },
      notification_id: later,
    }),
  });
  const repaired = await applyWholesaleFeedWebhook({
    ...options(store, async () => ({
      data: { unchanged: true, wholesale_feed_version: 'v2', pricing_version: 'price1', cache_scope: 'account' },
    })),
    webhook: webhook({ idempotency_key: 'old-event', wholesale_feed_version: 'v1' }),
  });
  assert.equal(repaired.outcome, 'unchanged');
  assert.equal(await store.hasWebhookReceipt(scope, 'old-event'), true);
  assert.equal((await store.read(scope)).lastWebhookEventId, later);
});
