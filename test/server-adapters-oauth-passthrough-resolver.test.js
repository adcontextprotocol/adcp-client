// Tests for #1363 — createOAuthPassthroughResolver, the canonical
// "Shape B" accounts.resolve factory.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createOAuthPassthroughResolver } = require('../dist/lib/adapters/oauth-passthrough-resolver');

function fakeHttpClient(rows, opts = {}) {
  let callCount = 0;
  let lastPath;
  let lastAuthContext;
  return {
    callCount: () => callCount,
    lastPath: () => lastPath,
    lastAuthContext: () => lastAuthContext,
    get: async (path, _params, _headers, options) => {
      callCount += 1;
      lastPath = path;
      lastAuthContext = options?.authContext;
      if (opts.throw) throw opts.throw;
      if (opts.body !== undefined) return { status: 200, body: opts.body };
      return { status: 200, body: { data: rows } };
    },
    post: async () => ({ status: 200, body: null }),
    put: async () => ({ status: 200, body: null }),
    delete: async () => ({ status: 200, body: null }),
  };
}

describe('createOAuthPassthroughResolver (#1363)', () => {
  describe('ref shape handling', () => {
    it('returns null for the brand+operator union arm without calling upstream', async () => {
      const http = fakeHttpClient([]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me/adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve({ brand: { domain: 'acme.com' }, operator: 'pinnacle.com' }, {});
      assert.strictEqual(result, null);
      assert.strictEqual(http.callCount(), 0, 'must not call upstream when ref lacks account_id');
    });

    it('returns null when ref is undefined without calling upstream', async () => {
      const http = fakeHttpClient([]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me/adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve(undefined, {});
      assert.strictEqual(result, null);
      assert.strictEqual(http.callCount(), 0);
    });
  });

  describe('upstream lookup + match', () => {
    it('returns the mapped account when account_id matches an upstream row', async () => {
      const http = fakeHttpClient([
        { id: 'acc_1', name: 'Acme', advertiser: 'acme.com' },
        { id: 'acc_2', name: 'Nike', advertiser: 'nike.com' },
      ]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me/adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          advertiser: row.advertiser,
          ctx_metadata: { upstreamId: row.id },
        }),
      });
      const result = await resolve({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', token: 't_buyer_1' } });
      assert.deepStrictEqual(result, {
        id: 'acc_1',
        name: 'Acme',
        status: 'active',
        advertiser: 'acme.com',
        ctx_metadata: { upstreamId: 'acc_1' },
      });
      assert.strictEqual(http.lastPath(), '/v1/me/adaccounts');
      assert.deepStrictEqual(http.lastAuthContext(), { kind: 'oauth', token: 't_buyer_1' });
    });

    it('returns null when no upstream row matches the requested account_id', async () => {
      const http = fakeHttpClient([{ id: 'acc_1', name: 'Acme' }]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me/adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve({ account_id: 'acc_unknown' }, {});
      assert.strictEqual(result, null);
    });

    it('returns null when upstream body is empty', async () => {
      const http = fakeHttpClient(null, { body: null });
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me/adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve({ account_id: 'acc_1' }, {});
      assert.strictEqual(result, null);
    });

    it('propagates upstream errors verbatim (4xx/5xx other than 404)', async () => {
      const http = fakeHttpClient([], {
        throw: new Error('Upstream GET /me/adaccounts failed: 500 Internal Server Error'),
      });
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me/adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      await assert.rejects(() => resolve({ account_id: 'acc_1' }, {}), /500 Internal Server Error/);
    });
  });

  describe('configurable extraction', () => {
    it('uses a custom idField', async () => {
      const http = fakeHttpClient([
        { account_ref: 'snap_act_42', name: 'Acme' },
        { account_ref: 'snap_act_43', name: 'Nike' },
      ]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/adaccounts',
        idField: 'account_ref',
        toAccount: row => ({
          id: row.account_ref,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve({ account_id: 'snap_act_43' }, {});
      assert.strictEqual(result?.id, 'snap_act_43');
      assert.strictEqual(result?.name, 'Nike');
    });

    it('uses a custom rowsPath', async () => {
      const http = fakeHttpClient(null, {
        body: { adaccounts: [{ id: 'a1', name: 'Acme' }] },
      });
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/v1/me',
        rowsPath: 'adaccounts',
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve({ account_id: 'a1' }, {});
      assert.strictEqual(result?.id, 'a1');
    });

    it('rowsPath: null treats body as a flat array', async () => {
      const http = fakeHttpClient(null, {
        body: [
          { id: 'a1', name: 'Acme' },
          { id: 'a2', name: 'Nike' },
        ],
      });
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/customers',
        rowsPath: null,
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const result = await resolve({ account_id: 'a2' }, {});
      assert.strictEqual(result?.name, 'Nike');
    });

    it('threads a custom getAuthContext output to the http client', async () => {
      const http = fakeHttpClient([{ id: 'a1', name: 'Acme' }]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/me',
        getAuthContext: ctx => ({ tenantId: ctx?.agent?.id, principal: ctx?.authInfo?.principal }),
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      await resolve({ account_id: 'a1' }, { agent: { id: 'agent_1' }, authInfo: { kind: 'oauth', principal: 'p1' } });
      assert.deepStrictEqual(http.lastAuthContext(), { tenantId: 'agent_1', principal: 'p1' });
    });
  });

  describe('caching', () => {
    it('skips upstream on cache hit within TTL', async () => {
      const http = fakeHttpClient([{ id: 'acc_1', name: 'Acme' }]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/me',
        cache: { ttlMs: 60_000 },
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: { fetchedAt: Date.now() },
        }),
      });
      const ctx = { authInfo: { kind: 'oauth', token: 't_a' } };
      const r1 = await resolve({ account_id: 'acc_1' }, ctx);
      const r2 = await resolve({ account_id: 'acc_1' }, ctx);
      assert.strictEqual(http.callCount(), 1, 'second call should hit cache, not upstream');
      assert.deepStrictEqual(r1, r2);
    });

    it('refetches upstream after TTL expires', async () => {
      const http = fakeHttpClient([{ id: 'acc_1', name: 'Acme' }]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/me',
        cache: { ttlMs: 1 },
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const ctx = { authInfo: { kind: 'oauth', token: 't_a' } };
      await resolve({ account_id: 'acc_1' }, ctx);
      await new Promise(resolve => setTimeout(resolve, 5));
      await resolve({ account_id: 'acc_1' }, ctx);
      assert.strictEqual(http.callCount(), 2);
    });

    it('keys cache on auth-context so different buyers do not share entries', async () => {
      const http = fakeHttpClient([{ id: 'acc_1', name: 'Acme' }]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/me',
        cache: { ttlMs: 60_000 },
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      await resolve({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', token: 't_buyer_a' } });
      await resolve({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', token: 't_buyer_b' } });
      assert.strictEqual(http.callCount(), 2, 'different buyers must not share cache entries');
    });

    it('honors a custom getCacheKey to narrow the auth-context dimension', async () => {
      const http = fakeHttpClient([{ id: 'acc_1', name: 'Acme' }]);
      const resolve = createOAuthPassthroughResolver({
        httpClient: http,
        listEndpoint: '/me',
        cache: {
          ttlMs: 60_000,
          getCacheKey: authContext => authContext?.principal ?? '<anon>',
        },
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: {},
        }),
      });
      // Same principal, different request id → must hit cache.
      await resolve({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', principal: 'p1', token: 't_req_1' } });
      await resolve({ account_id: 'acc_1' }, { authInfo: { kind: 'oauth', principal: 'p1', token: 't_req_2' } });
      assert.strictEqual(http.callCount(), 1);
    });
  });

  describe('public re-export', () => {
    it("exports from '@adcp/sdk' top-level barrel", () => {
      // Sanity check that the public surface includes the factory.
      const top = require('../dist/lib/index');
      assert.strictEqual(typeof top.createOAuthPassthroughResolver, 'function');
    });
  });
});
