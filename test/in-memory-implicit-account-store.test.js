'use strict';

// Issue #1340 — `InMemoryImplicitAccountStore` reference adapter.
// Covers default keyFn, the upsert/resolve round-trip, re-sync idempotency
// on the (brand, operator, sandbox) natural key, tenant isolation, TTL
// eviction, and the framework-wired storyboard (sync_accounts → get_products
// resolves the principal's account through dispatchTestRequest).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { InMemoryImplicitAccountStore, defaultImplicitKeyFn } = require('../dist/lib/adapters');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

const VALID_UUID_1 = '11111111-1111-1111-1111-111111111111';

const oauth = clientId => ({
  kind: 'oauth',
  credential: { kind: 'oauth', client_id: clientId, scopes: [] },
});
const apiKey = keyId => ({
  kind: 'api_key',
  credential: { kind: 'api_key', key_id: keyId },
});

describe('defaultImplicitKeyFn', () => {
  it('namespaces oauth client_id', () => {
    assert.equal(defaultImplicitKeyFn(oauth('buyer-xyz')), 'oauth:buyer-xyz');
  });

  it('namespaces api_key key_id', () => {
    assert.equal(defaultImplicitKeyFn(apiKey('hash123')), 'api_key:hash123');
  });

  it('namespaces http_sig agent_url', () => {
    const authInfo = {
      kind: 'signature',
      credential: { kind: 'http_sig', keyid: 'k', agent_url: 'https://buyer.example.com', verified_at: 1 },
    };
    assert.equal(defaultImplicitKeyFn(authInfo), 'http_sig:https://buyer.example.com');
  });

  it('returns undefined when credential is absent', () => {
    assert.equal(defaultImplicitKeyFn({ kind: 'public' }), undefined);
    assert.equal(defaultImplicitKeyFn({}), undefined);
  });
});

describe('InMemoryImplicitAccountStore — direct unit', () => {
  it('declares resolution: implicit', () => {
    const store = new InMemoryImplicitAccountStore();
    assert.equal(store.resolution, 'implicit');
  });

  it('upsert assigns account_id and persists under principal key', async () => {
    const store = new InMemoryImplicitAccountStore();
    const ctx = { authInfo: oauth('buyer-1') };
    const rows = await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], ctx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'created');
    assert.ok(rows[0].account_id);

    const resolved = await store.resolve(undefined, ctx);
    assert.ok(resolved);
    assert.equal(resolved.id, rows[0].account_id);
    assert.equal(store.size, 1);
  });

  it('re-syncing the same (brand, operator, sandbox) returns unchanged with the same account_id', async () => {
    let counter = 0;
    const store = new InMemoryImplicitAccountStore({
      // Non-deterministic buildAccount simulates an adopter calling an upstream
      // API or DB. The adapter must NOT mint a new id on replay.
      buildAccount: async ref => ({
        id: `acct_${++counter}`,
        name: ref.brand?.domain ?? 'x',
        status: 'active',
        brand: ref.brand,
        operator: ref.operator,
        ctx_metadata: {},
      }),
    });
    const ctx = { authInfo: oauth('buyer-1') };
    const ref = { brand: { domain: 'acme.com' }, operator: 'agency.com' };
    const [first] = await store.upsert([ref], ctx);
    const [second] = await store.upsert([ref], ctx);
    const [third] = await store.upsert([ref], ctx);
    assert.equal(first.action, 'created');
    assert.equal(second.action, 'unchanged');
    assert.equal(third.action, 'unchanged');
    assert.equal(second.account_id, first.account_id);
    assert.equal(third.account_id, first.account_id);
    assert.equal(counter, 1, 'buildAccount should be called only on first sync of a given natural key');
  });

  it('sandbox vs production are separate accounts under the same principal', async () => {
    const store = new InMemoryImplicitAccountStore();
    const ctx = { authInfo: oauth('buyer-1') };
    const rows = await store.upsert(
      [
        { brand: { domain: 'acme.com' }, operator: 'agency.com' },
        { brand: { domain: 'acme.com' }, operator: 'agency.com', sandbox: true },
      ],
      ctx
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'created');
    assert.equal(rows[1].action, 'created');
    assert.notEqual(rows[0].account_id, rows[1].account_id);
  });

  it('isolates accounts per principal — buyer-2 cannot resolve buyer-1 accounts', async () => {
    const store = new InMemoryImplicitAccountStore();
    await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], { authInfo: oauth('buyer-1') });
    const otherCtx = { authInfo: oauth('buyer-2') };
    assert.equal(await store.resolve(undefined, otherCtx), null);
  });

  it('resolve with no auth returns null (does not leak)', async () => {
    const store = new InMemoryImplicitAccountStore();
    await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], { authInfo: oauth('buyer-1') });
    assert.equal(await store.resolve(undefined, undefined), null);
    assert.equal(await store.resolve(undefined, { authInfo: undefined }), null);
  });

  it('upsert without auth fails all rows with SYNC_FAILED', async () => {
    const store = new InMemoryImplicitAccountStore();
    const rows = await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], undefined);
    assert.equal(rows[0].action, 'failed');
    assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[0].errors[0].code, 'SYNC_FAILED');
  });

  it('upsert with auth but unrecognized credential kind fails with SYNC_FAILED, not a silent success', async () => {
    const store = new InMemoryImplicitAccountStore();
    const ctx = { authInfo: { kind: 'public' } }; // no credential — defaultImplicitKeyFn returns undefined
    const rows = await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], ctx);
    assert.equal(rows[0].action, 'failed');
    assert.equal(rows[0].errors[0].code, 'SYNC_FAILED');
    assert.equal(store.size, 0, 'no entry should be created when key cannot be derived');
  });

  it('TTL eviction returns null after expiry and clears the entry', async () => {
    const store = new InMemoryImplicitAccountStore({ ttlMs: 5 });
    const ctx = { authInfo: oauth('buyer-1') };
    await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], ctx);
    assert.equal(store.size, 1);
    await new Promise(r => setTimeout(r, 15));
    assert.equal(await store.resolve(undefined, ctx), null);
    assert.equal(store.size, 0, 'expired entry should be evicted on resolve');
  });

  it('custom keyFn overrides the default credential-based keying', async () => {
    const store = new InMemoryImplicitAccountStore({
      keyFn: authInfo => {
        const orgId = authInfo?.claims?.org_id;
        return typeof orgId === 'string' ? `org:${orgId}` : undefined;
      },
    });
    const ctx1 = { authInfo: { kind: 'oauth', claims: { org_id: 'org-7' } } };
    const ctx2 = { authInfo: { kind: 'oauth', claims: { org_id: 'org-7' } } };
    await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], ctx1);
    const resolved = await store.resolve(undefined, ctx2);
    assert.ok(resolved, 'second auth with same org_id should hit the same bucket');
  });

  it('clear() resets all stored linkages', async () => {
    const store = new InMemoryImplicitAccountStore();
    await store.upsert([{ brand: { domain: 'acme.com' }, operator: 'agency.com' }], { authInfo: oauth('buyer-1') });
    await store.upsert([{ brand: { domain: 'beta.com' }, operator: 'agency.com' }], { authInfo: oauth('buyer-2') });
    assert.equal(store.size, 2);
    store.clear();
    assert.equal(store.size, 0);
  });

  it('authKey() exposes the derived storage key for assertions', () => {
    const store = new InMemoryImplicitAccountStore();
    assert.equal(store.authKey(oauth('buyer-1')), 'oauth:buyer-1');
    assert.equal(store.authKey(apiKey('hash')), 'api_key:hash');
  });
});

describe('InMemoryImplicitAccountStore — wired into a server', () => {
  function build(store) {
    return createAdcpServerFromPlatform(
      {
        capabilities: {
          specialisms: ['sales-non-guaranteed'],
          creative_agents: [],
          channels: ['display'],
          pricingModels: ['cpm'],
          config: {},
        },
        accounts: store,
        statusMappers: {},
        sales: {
          getProducts: async (_req, ctx) => ({
            products: [{ product_id: `p:${ctx?.account?.id ?? 'none'}`, name: 'p', formats: [] }],
          }),
          createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
          updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
          syncCreatives: async () => [],
          getMediaBuyDelivery: async () => ({ media_buys: [] }),
        },
      },
      { name: 'gap-1340', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
  }

  it("sync_accounts → get_products round-trip resolves the principal's account", async () => {
    const store = new InMemoryImplicitAccountStore();
    const server = build(store);

    const sync = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'sync_accounts',
          arguments: {
            accounts: [{ brand: { domain: 'acme.com' }, operator: 'agency.com' }],
            idempotency_key: VALID_UUID_1,
          },
        },
      },
      { authInfo: oauth('buyer-implicit-1') }
    );
    assert.notStrictEqual(sync.isError, true, JSON.stringify(sync.structuredContent));
    const accountId = sync.structuredContent.accounts[0].account_id;

    const products = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: { name: 'get_products', arguments: { promoted_offering: 'shoes' } },
      },
      { authInfo: oauth('buyer-implicit-1') }
    );
    assert.notStrictEqual(products.isError, true, JSON.stringify(products.structuredContent));
    assert.equal(products.structuredContent.products[0].product_id, `p:${accountId}`);
  });

  it('cross-tenant — buyer-B cannot resolve buyer-A accounts via the server', async () => {
    const store = new InMemoryImplicitAccountStore();
    const server = build(store);

    await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'sync_accounts',
          arguments: {
            accounts: [{ brand: { domain: 'acme.com' }, operator: 'agency.com' }],
            idempotency_key: VALID_UUID_1,
          },
        },
      },
      { authInfo: oauth('buyer-A') }
    );

    const probe = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: { name: 'get_products', arguments: { promoted_offering: 'shoes' } },
      },
      { authInfo: oauth('buyer-B') }
    );

    if (!probe.isError) {
      assert.equal(probe.structuredContent.products[0].product_id, 'p:none');
    } else {
      assert.equal(probe.structuredContent?.error?.code, 'ACCOUNT_NOT_FOUND');
    }
  });
});
