// The seller wholesale catalogue service (adcp-client#3630): paging, versions, `unchanged`, scope isolation
// between accounts, change events delivered through the persistent notification runtime, and capabilities.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform');
const { buildProduct } = require('../../dist/lib/server/decisioning');
const {
  createPersistentNotificationRuntime,
  createWebhookEmitter,
  memoryNotificationSubscriptionStore,
} = require('../../dist/lib/server/index.js');
const {
  createWholesaleCatalogService,
  memoryCatalogSnapshotStore,
} = require('../../dist/lib/wholesale-catalog/index.js');
const {
  InMemoryWholesaleFeedMirrorStore,
  refreshWholesaleFeed,
  applyWholesaleFeedWebhook,
} = require('../../dist/lib/wholesale-feed-sync/index.js');
const { AgentClient } = require('../../dist/lib/index.js');

const TENANT = 'tenant-1';
const ALL_EVENTS = [
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'wholesale_feed.bulk_change',
];

function product(id, floor = 5, extra = {}) {
  return buildProduct({
    id,
    name: `Product ${id}`,
    publisher_domain: 'pub.example',
    format_options: [{ format_option_id: 'banner', format_kind: 'image', params: { width: 300, height: 250 } }],
    delivery_type: 'non_guaranteed',
    pricing: { model: 'cpm', floor, currency: 'USD', pricing_option_id: `po_${id}` },
    ...extra,
  });
}

/** A mutable catalogue per scope, standing in for the seller's database. */
function fakeSource({ extra = 0 } = {}) {
  const source = {
    public: [product('p1'), product('p2'), product('p3'), ...Array.from({ length: extra }, (_, i) => product(`x${i}`))],
    accounts: new Map(),
    reads: [],
    adapter: {
      readCatalog: async scope => {
        source.reads.push(scope);
        if (scope.cacheScope === 'public') return structuredClone(source.public);
        const own = source.accounts.get(scope.accountId);
        return own === undefined ? null : structuredClone(own);
      },
    },
  };
  return source;
}

const accounts = {
  resolution: 'explicit',
  resolve: async ref => ({
    id: ref?.account_id ?? 'acct_default',
    operator: 'op.example',
    ctx_metadata: {},
    authInfo: { kind: 'api_key' },
  }),
};

function sellerPlatform(service, extra = {}) {
  return service.install({
    capabilities: { specialisms: [], creative_agents: [], channels: ['display'], pricingModels: ['cpm'], config: {} },
    statusMappers: {},
    accounts,
    ...extra,
  });
}

function serverFor(platform) {
  return createAdcpServerFromPlatform(platform, {
    name: 'wholesale-catalog-test',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'strict' },
  });
}

async function call(server, name, args) {
  const result = await server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } });
  return result;
}

async function ok(server, name, args) {
  const result = await call(server, name, args);
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

const listProducts = (server, args = {}) => ok(server, 'list_products', args);
const getWholesale = (server, args = {}) => ok(server, 'get_products', { buying_mode: 'wholesale', ...args });

async function errorCode(server, name, args) {
  const result = await call(server, name, args);
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent?.adcp_error?.code ?? result.structuredContent?.errors?.[0]?.code;
}

async function walk(server, args = {}) {
  const pages = [];
  let cursor;
  do {
    const page = await listProducts(server, { ...args, ...(cursor && { cursor }) });
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);
  return pages;
}

// -- notification runtime with a recording fetch ----------------------------------------------------------

function signerKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    keyid: 'wholesale-catalog-test',
    alg: 'ed25519',
    privateKey: {
      ...jwk,
      kid: 'wholesale-catalog-test',
      alg: 'ed25519',
      adcp_use: 'request-signing',
      key_ops: ['sign'],
    },
  };
}

function notificationRuntime({ statuses = [] } = {}) {
  const queue = [...statuses];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: queue.shift() ?? 204, headers: { get: () => undefined } };
  };
  const runtime = createPersistentNotificationRuntime({
    store: memoryNotificationSubscriptionStore(),
    proofAdapter: { prove: async () => ({ proved: true }) },
    authorizeDelivery: async () => ({ authorized: true }),
    validateDestination: async () => ({ allowed: true }),
    createEmitter: authorizeAttempt =>
      createWebhookEmitter({
        signerKey: signerKey(),
        fetch,
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        sleep: async () => {},
        authorizeAttempt,
      }),
  });
  return { runtime, calls, notifications: { runtime, tenantId: TENANT } };
}

async function subscribe(runtime, accountId, subscriberId, view = 'legacy', eventTypes = ALL_EVENTS) {
  const result = await runtime.replace(
    { kind: 'account', tenantId: TENANT, principalId: `buyer-${accountId}`, accountId },
    [
      {
        subscriber_id: subscriberId,
        url: `https://hooks.example/${subscriberId}`,
        event_types: eventTypes,
        product_payload_view: view,
      },
    ]
  );
  assert.equal(result.outcome, 'applied', JSON.stringify(result));
}

const sentTo = (calls, subscriberId) => calls.filter(c => c.url.endsWith(`/${subscriberId}`)).map(c => c.body);

function build({ overlays = false, extra = 0, ...rest } = {}) {
  const source = fakeSource({ extra });
  const service = createWholesaleCatalogService({
    adapter: source.adapter,
    accountOverlays: overlays,
    ...rest,
  });
  const server = serverFor(sellerPlatform(service));
  return { source, service, server };
}

describe('serving the catalogue', () => {
  it('answers list_products and wholesale get_products from one snapshot', async () => {
    const { server } = build();
    const listed = await listProducts(server);
    assert.equal(listed.outcome, 'listed');
    assert.deepEqual(
      listed.products.map(p => p.product_id),
      ['p1', 'p2', 'p3']
    );
    assert.equal(listed.cache_scope, 'public');
    assert.match(listed.feed_version, /^sha256:[0-9a-f]{64}$/);

    const wholesale = await getWholesale(server);
    assert.deepEqual(
      wholesale.products.map(p => p.product_id),
      ['p1', 'p2', 'p3']
    );
    assert.equal(wholesale.wholesale_feed_version, listed.feed_version);
    assert.equal(wholesale.cache_scope, 'public');
    assert.equal(wholesale.pagination.has_more, false);
  });

  it('pages without repeating or skipping a product, with one version on every page', async () => {
    const { server, source } = build();
    source.public = Array.from({ length: 120 }, (_, i) => product(`p${String(i).padStart(3, '0')}`));
    const pages = await walk(server, { max_results: 50 });
    assert.equal(pages.length, 3);
    assert.deepEqual(
      pages.map(p => p.products.length),
      [50, 50, 20]
    );
    assert.equal(new Set(pages.map(p => p.feed_version)).size, 1);
    assert.equal(pages.at(-1).next_cursor, undefined);
    const ids = pages.flatMap(p => p.products.map(x => x.product_id));
    assert.deepEqual(
      ids,
      source.public.map(p => p.product_id)
    );
    // The same walk twice returns the same pages.
    assert.deepEqual(
      (await walk(server, { max_results: 50 })).map(p => p.next_cursor),
      pages.map(p => p.next_cursor)
    );
  });

  it('pages wholesale get_products with pagination.cursor and a total', async () => {
    const { server, source } = build();
    source.public = Array.from({ length: 5 }, (_, i) => product(`w${i}`));
    const first = await getWholesale(server, { pagination: { max_results: 2 } });
    assert.equal(first.pagination.has_more, true);
    assert.equal(first.pagination.total_count, 5);
    const second = await getWholesale(server, { pagination: { max_results: 2, cursor: first.pagination.cursor } });
    const third = await getWholesale(server, { pagination: { max_results: 2, cursor: second.pagination.cursor } });
    assert.deepEqual(
      [...first.products, ...second.products, ...third.products].map(p => p.product_id),
      ['w0', 'w1', 'w2', 'w3', 'w4']
    );
    assert.equal(third.pagination.has_more, false);
  });

  it('refuses a cursor it did not issue, and one issued for another scope', async () => {
    const { server, source, service } = build({ overlays: true });
    source.public = Array.from({ length: 4 }, (_, i) => product(`c${i}`));
    source.accounts.set('acct_a', [product('a1'), product('a2'), product('a3')]);
    assert.equal(await errorCode(server, 'list_products', { cursor: 'nonsense' }), 'INVALID_REQUEST');
    const publicPage = await listProducts(server, { max_results: 2 });
    assert.equal(
      await errorCode(server, 'list_products', { account: { account_id: 'acct_a' }, cursor: publicPage.next_cursor }),
      'INVALID_REQUEST'
    );
    void service;
  });

  it('refuses a selection it cannot apply, and applies criteria.product_ids', async () => {
    const { server } = build();
    assert.equal(await errorCode(server, 'list_products', { criteria: { policy_ids: ['x'] } }), 'INVALID_REQUEST');
    assert.equal(
      await errorCode(server, 'get_products', { buying_mode: 'wholesale', filters: { channels: ['display'] } }),
      'INVALID_REQUEST'
    );
    const picked = await listProducts(server, { criteria: { product_ids: ['p2'] } });
    assert.deepEqual(
      picked.products.map(p => p.product_id),
      ['p2']
    );
  });

  it('hands a selection to adapter.selectProducts', async () => {
    const source = fakeSource();
    const service = createWholesaleCatalogService({
      adapter: {
        ...source.adapter,
        selectProducts: (products, request) => {
          assert.equal(request.task, 'get_products');
          return products.filter(p => p.product_id !== 'p1');
        },
      },
    });
    const server = serverFor(sellerPlatform(service));
    const result = await getWholesale(server, { filters: { channels: ['display'] } });
    assert.deepEqual(
      result.products.map(p => p.product_id),
      ['p2', 'p3']
    );
  });

  it('keeps the seller internal ctx_metadata out of what a buyer sees and keeps it in the snapshot', async () => {
    const source = fakeSource();
    source.public = [product('m1', 5, { ctx_metadata: { upstream_id: 'u-1' } })];
    const snapshots = memoryCatalogSnapshotStore();
    const service = createWholesaleCatalogService({ adapter: source.adapter, snapshots });
    const server = serverFor(sellerPlatform(service));
    const first = await listProducts(server);
    assert.equal(first.products[0].ctx_metadata, undefined);
    await listProducts(server);
    assert.equal((await snapshots.get({ cacheScope: 'public' })).products[0].ctx_metadata.upstream_id, 'u-1');
  });
});

describe('versions and conditional reads', () => {
  it('keeps the version for unchanged content and moves it when the content moves', async () => {
    const { server, source, service } = build();
    const before = (await listProducts(server)).feed_version;
    const noChange = await service.update({ cacheScope: 'public' });
    assert.equal(noChange.changed, false);
    assert.equal((await listProducts(server)).feed_version, before);

    source.public[1] = product('p2', 9);
    const changed = await service.update({ cacheScope: 'public' });
    assert.equal(changed.changed, true);
    assert.equal(changed.previousVersion, before);
    const after = (await listProducts(server)).feed_version;
    assert.notEqual(after, before);
    assert.equal(changed.version, after);
  });

  it('serves a snapshot until update, so a forgotten update delays a change and the reconcile timer repairs it', async () => {
    const { server, source, service } = build();
    const before = (await listProducts(server)).feed_version;
    source.public.push(product('p4'));
    assert.equal((await listProducts(server)).feed_version, before);
    await service.reconcile();
    assert.notEqual((await listProducts(server)).feed_version, before);
  });

  it('answers a matching if_feed_version with unchanged and no products, and a stale one with the list', async () => {
    const { server, source, service } = build();
    const { feed_version } = await listProducts(server);
    const unchanged = await listProducts(server, { if_feed_version: feed_version });
    assert.equal(unchanged.outcome, 'unchanged');
    assert.equal(unchanged.feed_version, feed_version);
    assert.equal(unchanged.cache_scope, 'public');
    assert.equal(unchanged.products, undefined);

    source.public[0] = product('p1', 11);
    await service.update({ cacheScope: 'public' });
    const stale = await listProducts(server, { if_feed_version: feed_version });
    assert.equal(stale.outcome, 'listed');
    assert.equal(stale.products.length, 3);
  });

  it('answers a matching if_wholesale_feed_version with unchanged: true', async () => {
    const { server } = build();
    const { wholesale_feed_version } = await getWholesale(server);
    const unchanged = await getWholesale(server, { if_wholesale_feed_version: wholesale_feed_version });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.wholesale_feed_version, wholesale_feed_version);
    assert.equal(unchanged.cache_scope, 'public');
    assert.equal(unchanged.products, undefined);
    const stale = await getWholesale(server, { if_wholesale_feed_version: 'sha256:stale' });
    assert.equal(stale.unchanged, undefined);
    assert.equal(stale.products.length, 3);
  });

  it('refuses if_pricing_version alone and never answers a forecast read unchanged', async () => {
    const { server } = build();
    assert.equal(await errorCode(server, 'list_products', { if_pricing_version: 'x' }), 'INVALID_REQUEST');
    assert.equal(
      await errorCode(server, 'get_products', { buying_mode: 'wholesale', if_pricing_version: 'x' }),
      'INVALID_REQUEST'
    );
    const { feed_version } = await listProducts(server);
    const forecast = await listProducts(server, { if_feed_version: feed_version, fields: ['product_id', 'forecast'] });
    assert.equal(forecast.outcome, 'listed');
  });

  it('isCurrent and assertCurrent check a feed_version for booking', async () => {
    const { server, source, service } = build();
    const { feed_version } = await listProducts(server);
    const scope = { cacheScope: 'public' };
    assert.equal(await service.isCurrent(scope, feed_version), true);
    await service.assertCurrent(scope, feed_version);
    source.public[0] = product('p1', 12);
    await service.update(scope);
    assert.equal(await service.isCurrent(scope, feed_version), false);
    await assert.rejects(service.assertCurrent(scope, feed_version), error => error.code === 'CONFLICT');
  });
});

describe('two-account isolation', () => {
  function overlayBuild(extra = {}) {
    const built = build({ overlays: true, ...extra });
    built.source.accounts.set('acct_a', [product('p1', 3), product('p2', 3), product('a_only', 3)]);
    built.source.accounts.set('acct_b', [product('p1', 4), product('b_only', 4)]);
    return built;
  }
  const as = id => ({ account: { account_id: id } });

  it('serves each account its own products and scope, and the public catalogue to a request with no account', async () => {
    const { server } = overlayBuild();
    const a = await listProducts(server, as('acct_a'));
    const b = await listProducts(server, as('acct_b'));
    const anonymous = await listProducts(server);
    assert.deepEqual(
      a.products.map(p => p.product_id),
      ['p1', 'p2', 'a_only']
    );
    assert.deepEqual(
      b.products.map(p => p.product_id),
      ['p1', 'b_only']
    );
    assert.deepEqual(
      anonymous.products.map(p => p.product_id),
      ['p1', 'p2', 'p3']
    );
    assert.deepEqual([a.cache_scope, b.cache_scope, anonymous.cache_scope], ['account', 'account', 'public']);
    assert.equal(new Set([a.feed_version, b.feed_version, anonymous.feed_version]).size, 3);
  });

  it('never calls readCatalog for an account the server did not resolve', async () => {
    const { server, source } = overlayBuild();
    await listProducts(server, as('acct_a'));
    await listProducts(server);
    const accountReads = source.reads.filter(r => r.cacheScope === 'account').map(r => r.accountId);
    assert.deepEqual(accountReads, ['acct_a']);
  });

  it('never lets one account token, or the public one, make another read unchanged', async () => {
    const { server, source, service } = overlayBuild();
    const a = await listProducts(server, as('acct_a'));
    const b = await listProducts(server, as('acct_b'));
    const pub = await listProducts(server);
    for (const [who, token] of [
      ['acct_b', a.feed_version],
      ['acct_a', b.feed_version],
      ['acct_a', pub.feed_version],
      ['acct_b', pub.feed_version],
    ]) {
      const result = await listProducts(server, { ...as(who), if_feed_version: token });
      assert.equal(result.outcome, 'listed', `${who} must not accept ${token}`);
    }
    // Account tokens do not make the public read unchanged either.
    assert.equal((await listProducts(server, { if_feed_version: a.feed_version })).outcome, 'listed');
    // A's own token still works until A changes; then neither the old nor a copy of it works for A or B.
    assert.equal(
      (await listProducts(server, { ...as('acct_a'), if_feed_version: a.feed_version })).outcome,
      'unchanged'
    );
    source.accounts.get('acct_a')[0] = product('p1', 99);
    await service.update({ cacheScope: 'account', accountId: 'acct_a' });
    assert.equal((await listProducts(server, { ...as('acct_a'), if_feed_version: a.feed_version })).outcome, 'listed');
    assert.equal((await listProducts(server, { ...as('acct_b'), if_feed_version: a.feed_version })).outcome, 'listed');
    assert.equal(
      (await listProducts(server, { ...as('acct_b'), if_feed_version: b.feed_version })).outcome,
      'unchanged'
    );
  });

  it('serves the public catalogue to an account that has none of its own', async () => {
    const { server } = overlayBuild();
    const c = await listProducts(server, as('acct_c'));
    assert.equal(c.cache_scope, 'public');
    assert.deepEqual(
      c.products.map(p => p.product_id),
      ['p1', 'p2', 'p3']
    );
  });

  it('a change to account A reaches no subscriber of account B, and B version does not move', async () => {
    const { runtime, calls, notifications } = notificationRuntime();
    const { server, source, service } = overlayBuild({ notifications });
    await subscribe(runtime, 'acct_a', 'sub-a');
    await subscribe(runtime, 'acct_b', 'sub-b');
    await listProducts(server, as('acct_a'));
    const b = await listProducts(server, as('acct_b'));

    source.accounts.get('acct_a')[0] = product('p1', 77);
    await service.update({ cacheScope: 'account', accountId: 'acct_a' });

    assert.equal(sentTo(calls, 'sub-b').length, 0);
    const toA = sentTo(calls, 'sub-a');
    assert.equal(toA.length, 1);
    assert.equal(toA[0].account_id, 'acct_a');
    assert.equal(toA[0].cache_scope, 'account');
    assert.deepEqual(toA[0].event.payload.applies_to, { scope: 'account', account_ids: ['acct_a'] });
    assert.equal(
      (await listProducts(server, { ...as('acct_b'), if_feed_version: b.feed_version })).outcome,
      'unchanged'
    );
  });

  it('an account that gains or loses its own catalogue is told to re-read', async () => {
    const { runtime, calls, notifications } = notificationRuntime();
    const { server, source, service } = overlayBuild({ notifications });
    await subscribe(runtime, 'acct_c', 'sub-c');
    const before = await listProducts(server, as('acct_c'));
    assert.equal(before.cache_scope, 'public');
    source.accounts.set('acct_c', [product('c1', 2)]);
    await service.update({ cacheScope: 'account', accountId: 'acct_c' });
    const [gained] = sentTo(calls, 'sub-c');
    assert.equal(gained.notification_type, 'wholesale_feed.bulk_change');
    assert.equal(gained.cache_scope, 'account');
    assert.equal((await listProducts(server, as('acct_c'))).cache_scope, 'account');

    source.accounts.delete('acct_c');
    await service.update({ cacheScope: 'account', accountId: 'acct_c' });
    const lost = sentTo(calls, 'sub-c').at(-1);
    assert.equal(lost.notification_type, 'wholesale_feed.bulk_change');
    assert.equal((await listProducts(server, as('acct_c'))).cache_scope, 'public');
  });
});

describe('change events', () => {
  async function withSubscribers(extra = {}) {
    const rt = notificationRuntime(extra.runtime);
    const built = build({ notifications: rt.notifications, extra: 97, ...extra.options });
    await subscribe(rt.runtime, 'acct_a', 'sub-a', 'legacy');
    await subscribe(rt.runtime, 'acct_b', 'sub-b', 'canonical');
    // Both accounts read the public catalogue, so the service knows them.
    await listProducts(built.server, { account: { account_id: 'acct_a' } });
    await listProducts(built.server, { account: { account_id: 'acct_b' } });
    return { ...rt, ...built };
  }

  it('sends nothing until the seller signals a change, and nothing for a change that moves nothing', async () => {
    const { calls, service, source } = await withSubscribers();
    assert.equal(calls.length, 0);
    await service.update({ cacheScope: 'public' });
    assert.equal(calls.length, 0);
    source.public.push(product('p4'));
    assert.equal(calls.length, 0);
  });

  it('delivers a price change, an added product and a removed product, each with its version chained', async () => {
    const { calls, service, source, server } = await withSubscribers();
    const v0 = (await listProducts(server)).feed_version;
    source.public[0] = product('p1', 8); // priced
    source.public.push(product('p4')); // created
    source.public = source.public.filter(p => p.product_id !== 'p3'); // removed
    const result = await service.update({ cacheScope: 'public' });
    assert.equal(result.events, 3);
    const v1 = (await listProducts(server)).feed_version;

    const toA = sentTo(calls, 'sub-a');
    assert.deepEqual(
      toA.map(b => b.notification_type),
      ['product.priced', 'product.created', 'product.removed']
    );
    assert.equal(toA[0].previous_wholesale_feed_version, v0);
    assert.equal(toA[0].wholesale_feed_version, toA[1].previous_wholesale_feed_version);
    assert.equal(toA[1].wholesale_feed_version, toA[2].previous_wholesale_feed_version);
    assert.equal(toA[2].wholesale_feed_version, v1);
    for (const body of toA) {
      assert.equal(body.cache_scope, 'public');
      assert.equal(body.account_id, 'acct_a');
      assert.equal(body.subscriber_id, 'sub-a');
      assert.equal(body.notification_id, body.event.event_id);
      assert.equal(body.product_payload_view, 'legacy');
      assert.deepEqual(body.event.payload.applies_to, { scope: 'public' });
    }
    // Event ids are UUIDv7 and ascend, so a receiver can order them.
    const ids = toA.map(b => b.event.event_id);
    assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual([...ids].sort(), ids);
    assert.equal(toA[0].event.payload.pricing_options[0].floor_price, 8);
    assert.equal(toA[1].event.payload.product.product_id, 'p4');
    assert.equal(toA[2].event.payload.product_id, 'p3');
  });

  it('sends each subscriber the product view it registered, and only that one', async () => {
    const { calls, service, source } = await withSubscribers();
    source.public[0] = product('p1', 8);
    source.public.push(product('p4'));
    await service.update({ cacheScope: 'public' });
    const legacy = sentTo(calls, 'sub-a');
    const canonical = sentTo(calls, 'sub-b');
    assert.equal(legacy.length, 2);
    assert.equal(canonical.length, 2);
    assert.equal(legacy[0].event.payload.canonical_pricing_options, undefined);
    assert.ok(legacy[0].event.payload.pricing_options);
    assert.equal(legacy[1].event.payload.canonical_product, undefined);
    assert.ok(legacy[1].event.payload.product.format_ids.length > 0);
    assert.equal(canonical[0].product_payload_view, 'canonical');
    assert.equal(canonical[0].event.payload.pricing_options, undefined);
    assert.ok(canonical[0].event.payload.canonical_pricing_options);
    assert.equal(canonical[1].event.payload.product, undefined);
    assert.ok(canonical[1].event.payload.canonical_product.format_options);
  });

  it('sends one bulk change when more products moved than the threshold allows', async () => {
    const { calls, service, source } = await withSubscribers({ options: { bulkChange: { maxProducts: 2 } } });
    source.public = source.public.map(p => product(p.product_id, 50));
    const result = await service.update({ cacheScope: 'public' });
    assert.equal(result.events, 1);
    const [bulk] = sentTo(calls, 'sub-a');
    assert.equal(bulk.notification_type, 'wholesale_feed.bulk_change');
    assert.equal(bulk.event.payload.affected_count, 100);
    assert.equal(bulk.event.payload.affected_entity_type, 'product');
    assert.equal(bulk.product_payload_view, undefined);
    assert.equal(sentTo(calls, 'sub-b').length, 1);
  });

  it('a change to the public catalogue reaches the subscribers of every account that has read it', async () => {
    const { calls, service, source } = await withSubscribers();
    source.public.push(product('p9'));
    await service.update({ cacheScope: 'public' });
    assert.equal(sentTo(calls, 'sub-a').length, 1);
    assert.equal(sentTo(calls, 'sub-b').length, 1);
    assert.equal(sentTo(calls, 'sub-a')[0].account_id, 'acct_a');
    assert.equal(sentTo(calls, 'sub-b')[0].account_id, 'acct_b');
  });

  it('keeps an undelivered change and sends it again, with the same ids, on the next reconcile', async () => {
    const { calls, service, source } = await withSubscribers({ runtime: { statuses: [500] } });
    source.public.push(product('p9'));
    await service.update({ cacheScope: 'public' });
    const firstTry = [...calls];
    assert.ok(firstTry.length > 0);
    // One delivery failed; a reconcile retries what is still owed.
    await service.reconcile();
    const toA = sentTo(calls, 'sub-a');
    const toB = sentTo(calls, 'sub-b');
    assert.equal(new Set([...toA, ...toB].map(b => b.event.event_id)).size, 1);
    assert.ok(toA.length >= 1 && toB.length >= 1);
    // Delivered now: another reconcile sends nothing more.
    const total = calls.length;
    await service.reconcile();
    assert.equal(calls.length, total);
  });

  it('survives a crash between storing a change and telling subscribers', async () => {
    const snapshots = memoryCatalogSnapshotStore();
    const rt = notificationRuntime();
    const source = fakeSource();
    const failing = {
      runtime: {
        ...rt.runtime,
        emit: async () => {
          throw new Error('process died');
        },
        store: rt.runtime.store,
      },
      tenantId: TENANT,
    };
    const errors = [];
    const first = createWholesaleCatalogService({
      adapter: source.adapter,
      snapshots,
      notifications: failing,
      onError: e => errors.push(e),
    });
    const server = serverFor(sellerPlatform(first));
    await subscribe(rt.runtime, 'acct_a', 'sub-a');
    await listProducts(server, { account: { account_id: 'acct_a' } });
    source.public.push(product('p9'));
    await first.update({ cacheScope: 'public' });
    assert.ok(errors.length > 0);
    assert.equal(rt.calls.length, 0);
    // A new process over the same store picks the change up.
    const second = createWholesaleCatalogService({
      adapter: source.adapter,
      snapshots,
      notifications: rt.notifications,
    });
    await second.reconcile();
    assert.equal(sentTo(rt.calls, 'sub-a').length, 1);
  });

  it('declares no webhooks without a notification runtime', async () => {
    const { server } = build();
    const capabilities = await ok(server, 'get_adcp_capabilities', {});
    assert.equal(capabilities.wholesale_feed_webhooks, undefined);
    assert.deepEqual(capabilities.wholesale_feed_versioning, {
      supported: true,
      pricing_version_separate: false,
      cache_scope_account: false,
    });
  });
});

describe('capabilities', () => {
  it('declares wholesale, versioning and webhooks without the adopter setting them', async () => {
    const { notifications } = notificationRuntime();
    const { server } = build({ overlays: true, notifications });
    const capabilities = await ok(server, 'get_adcp_capabilities', {});
    assert.deepEqual(capabilities.media_buy.buying_modes, ['wholesale']);
    assert.deepEqual(capabilities.wholesale_feed_versioning, {
      supported: true,
      pricing_version_separate: false,
      cache_scope_account: true,
    });
    assert.deepEqual(capabilities.wholesale_feed_webhooks, { supported: true, event_types: ALL_EVENTS });
    assert.ok(capabilities.media_buy.lifecycle_tools?.includes?.('list_products') ?? true);
  });

  it('wraps an existing sales.getProducts, which keeps answering the other buying modes', async () => {
    const source = fakeSource();
    const service = createWholesaleCatalogService({ adapter: source.adapter });
    const server = serverFor(
      sellerPlatform(service, {
        sales: { getProducts: async () => ({ products: [product('brief_hit')], cache_scope: 'public' }) },
      })
    );
    const brief = await ok(server, 'get_products', { buying_mode: 'brief', brief: 'anything' });
    assert.deepEqual(
      brief.products.map(p => p.product_id),
      ['brief_hit']
    );
    const wholesale = await getWholesale(server);
    assert.equal(wholesale.products.length, 3);
  });

  it('refuses to be installed twice or over its own list_products', () => {
    const source = fakeSource();
    const service = createWholesaleCatalogService({ adapter: source.adapter });
    const platform = sellerPlatform(service);
    assert.throws(() => service.install(platform), /already installed/);
    const other = createWholesaleCatalogService({ adapter: source.adapter });
    assert.throws(
      () => other.install({ ...platform, mediaBuyLifecycle: { listProducts: async () => ({}) } }),
      /answers list_products itself/
    );
  });
});

describe('configuration and lifecycle', () => {
  it('refuses process-local snapshots in production', () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () => createWholesaleCatalogService({ adapter: fakeSource().adapter }),
        error => error.code === 'WHOLESALE_CATALOG_STORAGE_NOT_DURABLE'
      );
      createWholesaleCatalogService({
        adapter: fakeSource().adapter,
        snapshots: { ...memoryCatalogSnapshotStore(), durability: 'durable' },
      });
    } finally {
      process.env.NODE_ENV = was;
    }
  });

  it('refuses a catalogue it cannot key, and an account update without overlays', async () => {
    const service = createWholesaleCatalogService({
      adapter: { readCatalog: async () => [product('dup'), product('dup')] },
    });
    await assert.rejects(service.update({ cacheScope: 'public' }), /more than once/);
    const none = createWholesaleCatalogService({ adapter: { readCatalog: async () => null } });
    await assert.rejects(none.update({ cacheScope: 'public' }), /only for an account scope/);
    const plain = createWholesaleCatalogService({ adapter: fakeSource().adapter });
    await assert.rejects(plain.update({ cacheScope: 'account', accountId: 'x' }), /accountOverlays/);
    await assert.rejects(plain.update({ cacheScope: 'account' }), /catalogue scope is/);
  });

  it('start runs the reconcile timer and stop ends it', async () => {
    const source = fakeSource();
    const errors = [];
    const service = createWholesaleCatalogService({ adapter: source.adapter, onError: e => errors.push(e) });
    const server = serverFor(sellerPlatform(service));
    const before = (await listProducts(server)).feed_version;
    service.start({ reconcileEvery: 20 });
    assert.equal(service.running, true);
    assert.throws(() => service.start({ reconcileEvery: 20 }), /already running/);
    source.public.push(product('timer'));
    const deadline = Date.now() + 3000;
    while ((await listProducts(server)).feed_version === before && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.notEqual((await listProducts(server)).feed_version, before);
    await service.stop();
    assert.equal(service.running, false);
    assert.deepEqual(errors, []);
    assert.throws(() => service.start({ reconcileEvery: 'soon' }), /reconcileEvery/);
  });
});

describe('the SDK buyer mirror against this seller', () => {
  async function connect(server, t) {
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'Wholesale buyer', version: '1.0.0' });
    await server.connect(sellerTransport);
    await mcp.connect(buyerTransport);
    t.after(async () => {
      await mcp.close();
      await server.close();
    });
    return AgentClient.fromMCPClient(mcp, { validation: { requests: 'off', responses: 'off' } });
  }

  it('bootstraps over pages, applies every webhook in order, and ends current and unchanged', async t => {
    const { runtime, calls, notifications } = notificationRuntime();
    const { source, service, server } = build({ notifications });
    source.public = Array.from({ length: 100 }, (_, i) => product(`m${i}`));
    await subscribe(runtime, 'acct_m', 'mirror', 'legacy');
    const client = await connect(server, t);
    const store = new InMemoryWholesaleFeedMirrorStore();
    const scope = { agentUrl: 'https://seller.example/mcp', accountKey: 'acct_m', entity: 'product' };
    const account = { account_id: 'acct_m' };

    const boot = await refreshWholesaleFeed({ client, store, scope, account });
    assert.equal(boot.outcome, 'applied', JSON.stringify(boot));
    assert.equal(boot.snapshot.items.length, 100);

    const again = await refreshWholesaleFeed({ client, store, scope, account });
    assert.equal(again.outcome, 'unchanged');

    source.public[0] = product('m0', 42);
    source.public.push(product('m100'));
    source.public = source.public.filter(p => p.product_id !== 'm3');
    await service.update({ cacheScope: 'public' });
    assert.equal(calls.length, 3);

    for (const { body } of calls) {
      const outcome = await applyWholesaleFeedWebhook({
        client,
        store,
        scope,
        account,
        webhook: body,
        webhookScope: { accountId: 'acct_m', subscriberId: 'mirror' },
      });
      assert.equal(outcome.outcome, 'applied', JSON.stringify(outcome));
    }
    const mirrored = (await store.read(scope)).items.map(p => p.product_id).sort();
    const expected = source.public.map(p => p.product_id).sort();
    assert.deepEqual(mirrored, expected);
    assert.equal(mirrored.length, 100);
    assert.ok(!mirrored.includes('m3') && mirrored.includes('m100'));
    const current = (await listProducts(server)).feed_version;
    assert.equal((await store.read(scope)).wholesaleFeedVersion, current);
    assert.equal((await refreshWholesaleFeed({ client, store, scope, account })).outcome, 'unchanged');
  });
});
