'use strict';

// `createDerivedAccountStore` reference adapter — Shape D for `resolution:
// 'derived'` single-tenant agents (no account_id on the wire; auth principal
// alone identifies the tenant). Covers the resolution declaration, AUTH_REQUIRED
// gate, ctx-threading into toAccount, ignored buyer-supplied account_id, and
// the omission of write/list paths. Closes adcp-client#1462.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDerivedAccountStore } = require('../dist/lib/adapters');

const oauthCtx = clientId => ({
  authInfo: {
    kind: 'oauth',
    credential: { kind: 'oauth', client_id: clientId, scopes: [] },
  },
});

const apiKeyCtx = keyId => ({
  authInfo: {
    kind: 'api_key',
    credential: { kind: 'api_key', key_id: keyId },
  },
});

describe('createDerivedAccountStore (#1462)', () => {
  it('declares resolution: derived', () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
    });
    assert.equal(store.resolution, 'derived');
  });

  it('omits list/upsert/refreshToken/getAccountFinancials/reportUsage', () => {
    const store = createDerivedAccountStore({
      toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
    });
    assert.equal(store.list, undefined);
    assert.equal(store.upsert, undefined);
    assert.equal(store.refreshToken, undefined);
    assert.equal(store.getAccountFinancials, undefined);
    assert.equal(store.reportUsage, undefined);
  });

  describe('resolve', () => {
    it('returns the singleton account from toAccount on authenticated calls', async () => {
      const store = createDerivedAccountStore({
        toAccount: ctx => ({
          id: 'audiostack',
          name: 'AudioStack',
          status: 'active',
          ctx_metadata: { tenantId: ctx?.authInfo?.credential?.client_id ?? null },
        }),
      });
      const account = await store.resolve(undefined, oauthCtx('buyer-xyz'));
      assert.ok(account);
      assert.equal(account.id, 'audiostack');
      assert.equal(account.name, 'AudioStack');
      assert.deepEqual(account.ctx_metadata, { tenantId: 'buyer-xyz' });
    });

    it('passes ctx through to toAccount', async () => {
      let seenCtx;
      const store = createDerivedAccountStore({
        toAccount: ctx => {
          seenCtx = ctx;
          return { id: 'x', name: 'x', status: 'active', ctx_metadata: {} };
        },
      });
      const ctx = apiKeyCtx('key-1');
      await store.resolve(undefined, ctx);
      assert.equal(seenCtx, ctx);
    });

    it('throws AUTH_REQUIRED when ctx.authInfo is undefined', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      await assert.rejects(
        () => store.resolve(undefined, undefined),
        err => {
          assert.equal(err.name, 'AdcpError');
          assert.equal(err.code, 'AUTH_REQUIRED');
          assert.equal(err.recovery, 'correctable');
          return true;
        }
      );
    });

    it('throws AUTH_REQUIRED when ctx.authInfo carries no credential / token / clientId', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      await assert.rejects(
        () => store.resolve(undefined, { authInfo: { kind: 'public' } }),
        err => {
          assert.equal(err.name, 'AdcpError');
          assert.equal(err.code, 'AUTH_REQUIRED');
          return true;
        }
      );
    });

    it('accepts legacy ResolvedAuthInfo.token shape (pre-#1269 deprecation window)', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      const account = await store.resolve(undefined, { authInfo: { token: 'legacy-bearer' } });
      assert.ok(account, 'must not refuse a request whose authenticator only stamps the deprecated token field');
    });

    it('accepts legacy ResolvedAuthInfo.clientId shape', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      const account = await store.resolve(undefined, { authInfo: { clientId: 'legacy-oauth-client' } });
      assert.ok(account);
    });

    it('does NOT call toAccount when auth check fails', async () => {
      let called = false;
      const store = createDerivedAccountStore({
        toAccount: () => {
          called = true;
          return { id: 'x', name: 'x', status: 'active', ctx_metadata: {} };
        },
      });
      await assert.rejects(() => store.resolve(undefined, undefined));
      assert.equal(called, false);
    });

    it('skips the auth check when skipAuthCheck: true', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'public-cat', name: 'Public Catalog', status: 'active', ctx_metadata: {} }),
        skipAuthCheck: true,
      });
      const account = await store.resolve(undefined, undefined);
      assert.ok(account);
      assert.equal(account.id, 'public-cat');
    });

    it('skips the auth check for public-credential calls when skipAuthCheck: true', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'public-cat', name: 'Public Catalog', status: 'active', ctx_metadata: {} }),
        skipAuthCheck: true,
      });
      const account = await store.resolve(undefined, { authInfo: { kind: 'public' } });
      assert.ok(account);
    });

    it('ignores buyer-supplied account_id (single-tenant by definition)', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({
          id: 'audiostack',
          name: 'AudioStack',
          status: 'active',
          ctx_metadata: {},
        }),
      });
      const account = await store.resolve({ account_id: 'whatever-buyer-sent' }, oauthCtx('buyer-1'));
      assert.ok(account);
      assert.equal(account.id, 'audiostack', 'singleton id wins, not the buyer-supplied account_id');
    });

    it('ignores brand+operator-shaped refs', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => ({ id: 'audiostack', name: 'AudioStack', status: 'active', ctx_metadata: {} }),
      });
      const account = await store.resolve(
        { brand: { domain: 'acme.com' }, operator: 'agency.com' },
        oauthCtx('buyer-1')
      );
      assert.ok(account);
      assert.equal(account.id, 'audiostack');
    });

    it('supports async toAccount', async () => {
      const store = createDerivedAccountStore({
        toAccount: async () => {
          await new Promise(r => setImmediate(r));
          return { id: 'x', name: 'x', status: 'active', ctx_metadata: {} };
        },
      });
      const account = await store.resolve(undefined, oauthCtx('b1'));
      assert.ok(account);
      assert.equal(account.id, 'x');
    });

    it('propagates toAccount throws (framework projects to SERVICE_UNAVAILABLE for non-AdcpError)', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => {
          throw new Error('upstream is down');
        },
      });
      await assert.rejects(() => store.resolve(undefined, oauthCtx('b1')), /upstream is down/);
    });
  });

  describe('composition', () => {
    it('supports spreading to add upsert without losing resolution', async () => {
      const upsertCalls = [];
      const accounts = {
        ...createDerivedAccountStore({
          toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
        }),
        upsert: async refs => {
          upsertCalls.push(refs);
          return [];
        },
      };
      assert.equal(accounts.resolution, 'derived');
      assert.equal(typeof accounts.upsert, 'function');
      await accounts.upsert([{ brand: { domain: 'a.com' }, operator: 'b.com' }]);
      assert.equal(upsertCalls.length, 1);
    });
  });
});
