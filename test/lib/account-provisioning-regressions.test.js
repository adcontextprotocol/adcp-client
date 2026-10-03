const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryImplicitAccountStore } = require('../../dist/lib/adapters/implicit-account-store.js');
const { WholesaleFeedSync } = require('../../dist/lib/wholesale-feed-sync/index.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');

const ctx = { authInfo: { kind: 'api_key', credential: { kind: 'api_key', key_id: 'principal' } } };
const a = { brand: { domain: 'a.example' }, operator: 'agency.example' };
const b = { brand: { domain: 'b.example' }, operator: 'agency.example' };

test('implicit lookup cannot resolve an unsynced brand to the first account (#3091)', async () => {
  const store = new InMemoryImplicitAccountStore();
  await store.upsert([a, b], ctx);
  assert.equal((await store.resolve(b, ctx)).brand.domain, 'b.example');
  assert.equal(await store.resolve({ ...a, brand: { domain: 'never-synced.example' } }, ctx), null);
  assert.equal(
    await store.resolve(a, { authInfo: { ...ctx.authInfo, credential: { kind: 'api_key', key_id: 'other' } } }),
    null
  );
});
for (const fields of [
  { sandbox: true },
  { currency: 'USD' },
  { timezone: 'UTC' },
  { operator_unit: { id: 'division' } },
]) {
  test(`implicit natural-key isolation includes ${Object.keys(fields)[0]} (#3091)`, async () => {
    const store = new InMemoryImplicitAccountStore();
    await store.upsert([a, { ...a, ...fields }], ctx);
    assert.notEqual(await store.resolve(a, ctx), await store.resolve({ ...a, ...fields }, ctx));
    assert.equal(await store.resolve({ ...b, ...fields }, ctx), null);
  });
}
test('additive sync preserves a second brand and supports explicit revocation (#3091)', async () => {
  const store = new InMemoryImplicitAccountStore({ mergeOnUpsert: true });
  await store.upsert([a], ctx);
  await store.upsert([b], ctx);
  assert.ok(await store.resolve(a, ctx));
  await store.remove(b, ctx);
  assert.equal(await store.resolve(b, ctx), null);
  assert.ok(await store.resolve(a, ctx));
  await store.upsert([b], { ...ctx, input: { delete_missing: true } });
  assert.equal(await store.resolve(a, ctx), null);
});
test('replacement and TTL defaults retain the previous revocation behavior (#3091)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const store = new InMemoryImplicitAccountStore();
  await store.upsert([a], ctx);
  await store.upsert([b], ctx);
  assert.equal(await store.resolve(a, ctx), null);
  t.mock.timers.tick(86_400_001);
  assert.equal(await store.resolve(b, ctx), null);
});

const caps = { data: { wholesale_feed_versioning: { supported: true }, signals: { discovery_modes: ['wholesale'] } } };
const failure = {
  success: false,
  status: 'failed',
  error: 'ACCOUNT_NOT_FOUND: not provisioned',
  adcpError: { code: 'ACCOUNT_NOT_FOUND', message: 'not provisioned', recovery: 'correctable' },
  data: { errors: [] },
};
function feedClient() {
  return {
    getAdcpCapabilities: async () => caps,
    getProducts: async () => ({
      success: true,
      data: { products: [{ product_id: 'p1' }], cache_scope: 'public', wholesale_feed_version: 'v1' },
    }),
    getSignals: async () => ({
      success: true,
      data: { signals: [{ signal_agent_segment_id: 's1' }], cache_scope: 'public', wholesale_feed_version: 's-v1' },
    }),
  };
}
test('initial account failure reports an error without rejecting start (#3092)', async () => {
  const client = feedClient();
  client.getProducts = async () => failure;
  const sync = new WholesaleFeedSync({ client, capabilityRefreshIntervalMs: 0 });
  const errors = [];
  sync.on('error', event => errors.push(event));
  await sync.start();
  assert.equal(sync.state, 'error');
  assert.equal(sync.products.count, 0);
  assert.equal(errors[0].adcpError.code, 'ACCOUNT_NOT_FOUND');
  sync.stop();
});
test('a failed bootstrap without an error listener still resolves start (#3092)', async () => {
  const client = feedClient();
  client.getProducts = async () => failure;
  const sync = new WholesaleFeedSync({ client, capabilityRefreshIntervalMs: 0 });
  await sync.start();
  assert.equal(sync.state, 'error');
  sync.stop();
});
test('additive sync does not extend another brands expiry (#3091)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const store = new InMemoryImplicitAccountStore({ mergeOnUpsert: true, ttlMs: 10 });
  await store.upsert([a], ctx);
  t.mock.timers.tick(8);
  await store.upsert([b], ctx);
  t.mock.timers.tick(3);
  assert.equal(await store.resolve(a, ctx), null);
  assert.ok(await store.resolve(b, ctx));
});
for (const task of ['getProducts', 'getSignals']) {
  test(`failed ${task} refresh preserves both mirrors and recovers (#3092)`, async () => {
    const client = feedClient();
    const sync = new WholesaleFeedSync({ client, capabilityRefreshIntervalMs: 0 });
    const errors = [];
    sync.on('error', event => errors.push(event));
    await sync.start();
    sync.stop();
    const good = client[task];
    client[task] = async () => failure;
    await assert.rejects(sync.refresh(), error => error.adcpError?.code === 'ACCOUNT_NOT_FOUND');
    assert.equal(sync.state, 'degraded');
    assert.equal(sync.products.count, 1);
    assert.equal(sync.signals.count, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].adcpError.code, 'ACCOUNT_NOT_FOUND');
    client[task] = good;
    await sync.refresh();
    assert.equal(sync.state, 'syncing');
    sync.stop();
  });
}
test('background failure keeps the mirror and schedules recovery (#3092)', async t => {
  const client = feedClient();
  const sync = new WholesaleFeedSync({ client, probeIntervalMs: 5, capabilityRefreshIntervalMs: 0 });
  t.after(() => sync.stop());
  await sync.start();
  const good = client.getProducts;
  client.getProducts = async () => failure;
  await new Promise(resolve => sync.once('error', resolve));
  assert.equal(sync.products.count, 1);
  assert.equal(sync.state, 'degraded');
  client.getProducts = good;
  await new Promise(resolve => sync.once('bootstrap', resolve));
  assert.equal(sync.state, 'syncing');
});

async function call(server, name, args) {
  return server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } });
}
function seller(options = {}) {
  return createAdcpServer({
    name: 'account-policy',
    version: '1',
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: { getProducts: async () => ({ products: [], cache_scope: 'public' }) },
    ...options,
  });
}
function captureWarnings(t) {
  const logged = [];
  const emitted = [];
  t.mock.method(process, 'emitWarning', (message, options) => emitted.push({ message, options }));
  const logger = { debug() {}, info() {}, warn: (message, meta) => logged.push({ message, meta }), error() {} };
  return { logged, emitted, logger };
}
test('a supplied reference without resolveAccount passes through with a one-time deprecation warning (#3094)', async t => {
  const { logged, emitted, logger } = captureWarnings(t);
  const seen = [];
  const server = seller({
    logger,
    mediaBuy: {
      getProducts: async (params, ctx) => {
        seen.push({ account: params.account, resolved: ctx.account });
        return { products: [], cache_scope: 'public' };
      },
    },
  });
  for (let i = 0; i < 2; i++) {
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  }
  assert.deepEqual(seen, [
    { account: a, resolved: undefined },
    { account: a, resolved: undefined },
  ]);
  const deprecations = logged.filter(entry => entry.meta?.code === 'ADCP_UNRESOLVED_ACCOUNT_REFERENCE');
  assert.equal(deprecations.length, 1);
  assert.match(deprecations[0].message, /strictAccountReferences: true/);
  const loud = emitted.filter(entry => entry.options?.code === 'ADCP_UNRESOLVED_ACCOUNT_REFERENCE');
  assert.equal(loud.length, 1);
  assert.equal(loud[0].options.type, 'DeprecationWarning');
  await server.close();
});
test('production keeps the pass-through warning on the configured logger only (#3094)', async t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const { logged, emitted, logger } = captureWarnings(t);
  const server = seller({ logger, stateStore: new InMemoryStateStore() });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(logged.filter(entry => entry.meta?.code === 'ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 1);
  assert.equal(emitted.filter(entry => entry.options?.code === 'ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 0);
  await server.close();
});
test('strictAccountReferences refuses a supplied reference without resolveAccount (#3094)', async t => {
  const { logged, logger } = captureWarnings(t);
  let called = false;
  const server = seller({
    logger,
    strictAccountReferences: true,
    resolveAccountFromAuth: async () => ({ id: 'from-auth' }),
    mediaBuy: {
      getProducts: async () => {
        called = true;
        return { products: [], cache_scope: 'public' };
      },
    },
  });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(called, false);
  assert.equal(logged.filter(entry => entry.meta?.code === 'ADCP_UNRESOLVED_ACCOUNT_REFERENCE').length, 0);
  await server.close();
});
test('list_creative_formats still refuses an unresolvable account selector without strict mode', async () => {
  const server = seller({
    creative: { listCreativeFormats: async () => ({ formats: [] }) },
  });
  const response = await call(server, 'list_creative_formats', { account: a });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  await server.close();
});
test('a passed-through reference satisfies the declared product-account requirement (#3094)', async t => {
  const { logger } = captureWarnings(t);
  const server = seller({ logger, capabilities: { account: { requiredForProducts: true } } });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  await server.close();
});
test('required_for_products is enforced by the framework (#3094)', async () => {
  const server = seller({ capabilities: { account: { requiredForProducts: true } } });
  const response = await call(server, 'get_products', { brief: 'catalog' });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_REQUIRED');
  await server.close();
});
test('discovery passes provisioning=false to lookup and never creates an account (#3094)', async () => {
  let created = 0;
  const server = seller({
    resolveAccount: async (_ref, ctx) => {
      if (ctx.provisioning) created++;
      return null;
    },
  });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(created, 0);
  await server.close();
});

test('initial auto-poll failure schedules a successful retry (#3092)', async t => {
  const client = feedClient();
  let fail = true;
  const good = client.getProducts;
  client.getProducts = async params => (fail ? failure : good(params));
  const sync = new WholesaleFeedSync({ client, probeIntervalMs: 5, capabilityRefreshIntervalMs: 0 });
  sync.on('error', () => {});
  t.after(() => sync.stop());
  await sync.start();
  assert.equal(sync.state, 'error');
  fail = false;
  await new Promise(resolve => sync.once('bootstrap', resolve));
  assert.equal(sync.products.count, 1);
  assert.equal(sync.state, 'syncing');
});
test('thrown and non-terminal refreshes preserve a good mirror (#3092)', async () => {
  const client = feedClient();
  const sync = new WholesaleFeedSync({ client, capabilityRefreshIntervalMs: 0 });
  sync.on('error', () => {});
  await sync.start();
  sync.stop();
  client.getProducts = async () => {
    throw Error('transport unavailable');
  };
  await assert.rejects(sync.refresh(), /transport unavailable/);
  assert.equal(sync.state, 'degraded');
  assert.equal(sync.products.count, 1);
  client.getProducts = async () => ({ success: true, status: 'submitted', metadata: {} });
  await assert.rejects(sync.refresh(), /bootstrap/);
  assert.equal(sync.state, 'degraded');
  assert.equal(sync.products.count, 1);
  sync.stop();
});
test('list_accounts account references remain filters even on a server with a resolver (#3094)', async () => {
  let resolved = false;
  const server = seller({
    resolveAccount: async () => {
      resolved = true;
      return null;
    },
    accounts: { listAccounts: async () => ({ accounts: [] }) },
  });
  const result = await call(server, 'list_accounts', { account: { account_id: 'filter' } });
  assert.notEqual(result.isError, true);
  assert.equal(resolved, false);
  await server.close();
});

test('auto-poll retries an initial thrown bootstrap while start still rejects (#3092)', async t => {
  const client = feedClient();
  const good = client.getProducts;
  let first = true;
  client.getProducts = async params => {
    if (first) {
      first = false;
      throw Error('initial transport failure');
    }
    return good(params);
  };
  const sync = new WholesaleFeedSync({ client, probeIntervalMs: 5, capabilityRefreshIntervalMs: 0 });
  sync.on('error', () => {});
  t.after(() => sync.stop());
  await assert.rejects(sync.start(), /initial transport failure/);
  assert.equal(sync.state, 'error');
  await new Promise(resolve => sync.once('bootstrap', resolve));
  assert.equal(sync.state, 'syncing');
  assert.equal(sync.products.count, 1);
});

const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
function implicitPlatform(resolve) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: { resolution: 'implicit', resolve, upsert: async () => [], list: async () => ({ items: [] }) },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ cache_scope: 'account', products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
}
// A custom store that ignores the supplied natural key and returns another brand's account.
const otherBrandAccount = async () => ({ id: 'acct_b', status: 'active', ctx_metadata: {}, ...b });
function implicitServer(logger, extra = {}) {
  return createAdcpServerFromPlatform(implicitPlatform(otherBrandAccount), {
    name: 'implicit-identity',
    version: '1',
    validation: { requests: 'off', responses: 'off' },
    logger,
    ...extra,
  });
}
test('implicit identity mismatch warns and keeps the 14.0 result by default (#3091)', async t => {
  const { logged, emitted, logger } = captureWarnings(t);
  const server = implicitServer(logger);
  for (let i = 0; i < 2; i++) {
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  }
  const mismatches = logged.filter(entry => entry.meta?.code === 'ADCP_IMPLICIT_ACCOUNT_IDENTITY_MISMATCH');
  assert.equal(mismatches.length, 2, 'every mismatch reaches the configured logger');
  assert.equal(mismatches[0].meta.field, 'brand.domain');
  assert.equal(
    emitted.filter(entry => entry.options?.code === 'ADCP_IMPLICIT_ACCOUNT_IDENTITY_MISMATCH').length,
    1,
    'process warning is emitted once per server'
  );
  await server.close();
});
test('strictAccountReferences refuses implicit identity mismatches (#3091)', async t => {
  const { logged, logger } = captureWarnings(t);
  const server = implicitServer(logger, { strictAccountReferences: true });
  const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
  assert.equal(response.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(logged.filter(entry => entry.meta?.code === 'ADCP_IMPLICIT_ACCOUNT_IDENTITY_MISMATCH').length, 0);
  await server.close();
});
test('strict implicit identity accepts matching or omitted metadata (#3091)', async t => {
  const { logged, logger } = captureWarnings(t);
  for (const resolve of [
    async ref => ({ id: 'acct_a', status: 'active', ctx_metadata: {}, ...ref }),
    async () => ({ id: 'acct_a', status: 'active', ctx_metadata: {} }),
  ]) {
    const server = createAdcpServerFromPlatform(implicitPlatform(resolve), {
      name: 'implicit-identity',
      version: '1',
      validation: { requests: 'off', responses: 'off' },
      logger,
      strictAccountReferences: true,
    });
    const response = await call(server, 'get_products', { account: a, brief: 'catalog' });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    await server.close();
  }
  assert.equal(logged.filter(entry => entry.meta?.code === 'ADCP_IMPLICIT_ACCOUNT_IDENTITY_MISMATCH').length, 0);
});
