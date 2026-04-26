// Tests for the TenantRegistry admin router. Uses a minimal RouterLike
// fake so no Express runtime dependency is needed in the test.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  createTenantRegistry,
  createTenantAdminHandlers,
  mountTenantAdmin,
} = require('../dist/lib/server/decisioning');

const SAMPLE_KEY = {
  keyId: 'k1',
  publicJwk: { kty: 'RSA', n: 'aaa', e: 'AQAB' },
  privateJwk: { kty: 'RSA', n: 'aaa', e: 'AQAB', d: 'priv' },
};

const DEFAULT_SERVER_OPTIONS = {
  name: 'admin-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

function basePlatform() {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.body = undefined;
      return this;
    },
  };
}

function fakeReq(params = {}) {
  return { params };
}

describe('TenantAdminHandlers', () => {
  function makeRegistry() {
    return createTenantRegistry({
      jwksValidator: { validate: async () => ({ ok: true }) },
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
  }

  it('listTenants returns the registry list', async () => {
    const registry = makeRegistry();
    registry.register('t1', {
      agentUrl: 'https://t1.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('t1');

    const handlers = createTenantAdminHandlers(registry);
    const res = fakeRes();
    handlers.listTenants(fakeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.tenants.length, 1);
    assert.strictEqual(res.body.tenants[0].tenantId, 't1');
    assert.strictEqual(res.body.tenants[0].health, 'healthy');
  });

  it('getTenant returns 404 for unknown tenant', () => {
    const registry = makeRegistry();
    const handlers = createTenantAdminHandlers(registry);
    const res = fakeRes();
    handlers.getTenant(fakeReq({ id: 'nonexistent' }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'tenant_not_found');
  });

  it('getTenant returns the status for a known tenant', async () => {
    const registry = makeRegistry();
    registry.register('t1', {
      agentUrl: 'https://t1.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('t1');

    const handlers = createTenantAdminHandlers(registry);
    const res = fakeRes();
    handlers.getTenant(fakeReq({ id: 't1' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.tenantId, 't1');
    assert.strictEqual(res.body.health, 'healthy');
  });

  it('recheckTenant transitions disabled → healthy after fix', async () => {
    let attempts = 0;
    const registry = createTenantRegistry({
      jwksValidator: {
        validate: async () => {
          attempts++;
          if (attempts === 1) return { ok: false, recovery: 'permanent', reason: 'bad key' };
          return { ok: true };
        },
      },
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('t1', {
      agentUrl: 'https://t1.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    const handlers = createTenantAdminHandlers(registry);

    const res1 = fakeRes();
    await handlers.recheckTenant(fakeReq({ id: 't1' }), res1);
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.health, 'disabled');

    const res2 = fakeRes();
    await handlers.recheckTenant(fakeReq({ id: 't1' }), res2);
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.health, 'healthy');
  });

  it('recheckTenant returns 404 for unknown tenant', async () => {
    const registry = makeRegistry();
    const handlers = createTenantAdminHandlers(registry);
    const res = fakeRes();
    await handlers.recheckTenant(fakeReq({ id: 'nope' }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'tenant_not_found');
  });

  it('unregisterTenant returns 204 and removes the tenant', async () => {
    const registry = makeRegistry();
    registry.register('t1', {
      agentUrl: 'https://t1.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('t1');

    const handlers = createTenantAdminHandlers(registry);
    const res = fakeRes();
    handlers.unregisterTenant(fakeReq({ id: 't1' }), res);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(registry.getStatus('t1'), null);
  });

  it('unregisterTenant is idempotent (no error on missing tenant)', () => {
    const registry = makeRegistry();
    const handlers = createTenantAdminHandlers(registry);
    const res = fakeRes();
    handlers.unregisterTenant(fakeReq({ id: 'never_existed' }), res);
    assert.strictEqual(res.statusCode, 204);
  });
});

describe('mountTenantAdmin', () => {
  it('registers the four standard endpoints on a RouterLike', () => {
    const calls = [];
    const fakeRouter = {
      get: (path, _h) => calls.push(['GET', path]),
      post: (path, _h) => calls.push(['POST', path]),
      delete: (path, _h) => calls.push(['DELETE', path]),
    };
    const registry = createTenantRegistry({
      jwksValidator: { validate: async () => ({ ok: true }) },
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    mountTenantAdmin(fakeRouter, registry);

    assert.deepStrictEqual(calls, [
      ['GET', '/tenants'],
      ['GET', '/tenants/:id'],
      ['POST', '/tenants/:id/recheck'],
      ['DELETE', '/tenants/:id'],
    ]);
  });
});
