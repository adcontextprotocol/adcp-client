'use strict';

// `createDerivedAccountStore` reference adapter — Shape D for `resolution:
// 'derived'`, an upstream-managed account-id namespace. Covers the resolution
// declaration, the AUTH_REQUIRED gate, ctx threading, verified resolution of
// buyer-supplied `account_id` (the tenant-isolation contract), singleton
// auto-selection on ref-less calls, and the `list_accounts` surface the mode
// requires. Closes adcp-client#1462; reworked by adcp-client#1647.

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

const account = (id, extra = {}) => ({ id, name: id, status: 'active', ctx_metadata: {}, ...extra });

const singletonStore = (id = 'audiostack', opts = {}) =>
  createDerivedAccountStore({ toAccount: () => account(id), ...opts });

describe('createDerivedAccountStore (#1462, reworked by #1647)', () => {
  it('declares resolution: derived', () => {
    assert.equal(singletonStore().resolution, 'derived');
  });

  it('wires list (required for derived) and omits upsert/refreshToken/getAccountFinancials/reportUsage', () => {
    const store = singletonStore();
    assert.equal(typeof store.list, 'function');
    assert.equal(store.upsert, undefined);
    assert.equal(store.refreshToken, undefined);
    assert.equal(store.getAccountFinancials, undefined);
    assert.equal(store.reportUsage, undefined);
  });

  describe('option validation', () => {
    it('refuses construction with neither toAccount nor listAccounts', () => {
      assert.throws(() => createDerivedAccountStore({}), /toAccount .* or listAccounts/);
    });

    it('refuses construction with both', () => {
      assert.throws(
        () => createDerivedAccountStore({ toAccount: () => account('a'), listAccounts: () => [account('a')] }),
        /not both/
      );
    });

    it('refuses lookupAccount alongside toAccount', () => {
      assert.throws(
        () => createDerivedAccountStore({ toAccount: () => account('a'), lookupAccount: () => account('a') }),
        /lookupAccount applies to listAccounts/
      );
    });
  });

  describe('resolve — singleton (toAccount)', () => {
    it('returns the account for ref-less calls', async () => {
      const store = createDerivedAccountStore({
        toAccount: ctx => account('audiostack', { ctx_metadata: { tenantId: ctx?.authInfo?.credential?.client_id } }),
      });
      const resolved = await store.resolve(undefined, oauthCtx('buyer-xyz'));
      assert.ok(resolved);
      assert.equal(resolved.id, 'audiostack');
      assert.deepEqual(resolved.ctx_metadata, { tenantId: 'buyer-xyz' });
    });

    it('accepts a matching buyer-supplied account_id', async () => {
      const resolved = await singletonStore().resolve({ account_id: 'audiostack' }, oauthCtx('b1'));
      assert.ok(resolved);
      assert.equal(resolved.id, 'audiostack');
    });

    it('fails closed on a non-matching account_id instead of serving the singleton', async () => {
      const resolved = await singletonStore().resolve({ account_id: 'someone-elses-account' }, oauthCtx('b1'));
      assert.equal(resolved, null, 'a mismatched id must not be silently serviced against the one account we have');
    });

    it('passes ctx through to toAccount', async () => {
      let seenCtx;
      const store = createDerivedAccountStore({
        toAccount: ctx => {
          seenCtx = ctx;
          return account('x');
        },
      });
      const ctx = apiKeyCtx('key-1');
      await store.resolve(undefined, ctx);
      assert.equal(seenCtx, ctx);
    });

    it('supports async toAccount', async () => {
      const store = createDerivedAccountStore({
        toAccount: async () => {
          await new Promise(r => setImmediate(r));
          return account('x');
        },
      });
      assert.equal((await store.resolve(undefined, oauthCtx('b1'))).id, 'x');
    });

    it('propagates toAccount throws (framework projects non-AdcpError to SERVICE_UNAVAILABLE)', async () => {
      const store = createDerivedAccountStore({
        toAccount: () => {
          throw new Error('upstream is down');
        },
      });
      await assert.rejects(() => store.resolve(undefined, oauthCtx('b1')), /upstream is down/);
    });

    it('returns null for brand+operator refs (framework refuses them earlier)', async () => {
      const resolved = await singletonStore().resolve(
        { brand: { domain: 'acme.com' }, operator: 'agency.com' },
        oauthCtx('b1')
      );
      assert.equal(resolved, null);
    });
  });

  describe('resolve — roster (listAccounts)', () => {
    const rosterStore = (rows, opts = {}) => createDerivedAccountStore({ listAccounts: () => rows, ...opts });

    it('resolves an account_id that is in the credential-scoped roster', async () => {
      const store = rosterStore([account('act_1'), account('act_2')]);
      assert.equal((await store.resolve({ account_id: 'act_2' }, oauthCtx('b1'))).id, 'act_2');
    });

    it('returns null for an account_id outside the credential-scoped roster', async () => {
      const store = rosterStore([account('act_1')]);
      assert.equal(await store.resolve({ account_id: 'act_99' }, oauthCtx('b1')), null);
    });

    it('scopes the roster per caller — another credential cannot reach the first credential’s accounts', async () => {
      const byCaller = {
        'buyer-a': [account('act_a')],
        'buyer-b': [account('act_b')],
      };
      const store = createDerivedAccountStore({
        listAccounts: ctx => byCaller[ctx?.authInfo?.credential?.client_id] ?? [],
      });
      assert.equal((await store.resolve({ account_id: 'act_a' }, oauthCtx('buyer-a'))).id, 'act_a');
      assert.equal(await store.resolve({ account_id: 'act_a' }, oauthCtx('buyer-b')), null);
    });

    it('auto-selects the account on ref-less calls when the credential reaches exactly one', async () => {
      const store = rosterStore([account('only')]);
      assert.equal((await store.resolve(undefined, oauthCtx('b1'))).id, 'only');
    });

    it('returns null on ref-less calls when the credential reaches several (no arbitrary default)', async () => {
      const store = rosterStore([account('a'), account('b')]);
      assert.equal(await store.resolve(undefined, oauthCtx('b1')), null);
    });

    it('returns null on ref-less calls when the credential reaches none', async () => {
      assert.equal(await rosterStore([]).resolve(undefined, oauthCtx('b1')), null);
    });

    it('uses lookupAccount when supplied', async () => {
      const seen = [];
      const store = rosterStore([account('act_1')], {
        lookupAccount: (id, ctx) => {
          seen.push([id, ctx?.authInfo?.credential?.client_id]);
          return id === 'act_1' ? account('act_1') : null;
        },
      });
      assert.equal((await store.resolve({ account_id: 'act_1' }, oauthCtx('b1'))).id, 'act_1');
      assert.deepEqual(seen, [['act_1', 'b1']]);
      assert.equal(await store.resolve({ account_id: 'nope' }, oauthCtx('b1')), null);
    });

    it('discards a lookupAccount result whose id does not match the request (defense in depth)', async () => {
      const store = rosterStore([account('act_1')], {
        // An adopter lookup that ignores the id — the factory must not let
        // that become a silent cross-account substitution.
        lookupAccount: () => account('some_other_account'),
      });
      assert.equal(await store.resolve({ account_id: 'act_1' }, oauthCtx('b1')), null);
    });
  });

  describe('auth gate', () => {
    it('throws AUTH_REQUIRED when ctx.authInfo is undefined', async () => {
      await assert.rejects(
        () => singletonStore().resolve(undefined, undefined),
        err => {
          assert.equal(err.name, 'AdcpError');
          assert.equal(err.code, 'AUTH_REQUIRED');
          assert.equal(err.recovery, 'correctable');
          return true;
        }
      );
    });

    it('throws AUTH_REQUIRED when ctx.authInfo carries no credential / token / clientId', async () => {
      await assert.rejects(
        () => singletonStore().resolve(undefined, { authInfo: { kind: 'public' } }),
        err => {
          assert.equal(err.code, 'AUTH_REQUIRED');
          return true;
        }
      );
    });

    it('guards list_accounts with the same gate', async () => {
      await assert.rejects(
        () => singletonStore().list({}, undefined),
        err => {
          assert.equal(err.code, 'AUTH_REQUIRED');
          return true;
        }
      );
    });

    it('accepts legacy ResolvedAuthInfo.token shape (pre-#1269 deprecation window)', async () => {
      assert.ok(await singletonStore().resolve(undefined, { authInfo: { token: 'legacy-bearer' } }));
    });

    it('accepts legacy ResolvedAuthInfo.clientId shape', async () => {
      assert.ok(await singletonStore().resolve(undefined, { authInfo: { clientId: 'legacy-oauth-client' } }));
    });

    it('does NOT call the account callback when the auth check fails', async () => {
      let called = false;
      const store = createDerivedAccountStore({
        toAccount: () => {
          called = true;
          return account('x');
        },
      });
      await assert.rejects(() => store.resolve(undefined, undefined));
      assert.equal(called, false);
    });

    it('skips the auth check for public-credential calls when skipAuthCheck: true', async () => {
      const store = singletonStore('public-cat', { skipAuthCheck: true });
      assert.ok(await store.resolve(undefined, { authInfo: { kind: 'public' } }));
    });

    it('only a strict `true` disables the gate (untyped truthy strings must not)', async () => {
      const store = singletonStore('x', { skipAuthCheck: 'false' });
      await assert.rejects(
        () => store.resolve(undefined, undefined),
        err => err.code === 'AUTH_REQUIRED'
      );
    });

    it('skips the auth check when skipAuthCheck: true', async () => {
      const store = singletonStore('public-cat', { skipAuthCheck: true });
      assert.equal((await store.resolve(undefined, undefined)).id, 'public-cat');
      assert.equal((await store.list({}, undefined)).items.length, 1);
    });
  });

  describe('list', () => {
    it('publishes the singleton as one row', async () => {
      const page = await singletonStore('audiostack').list({}, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['audiostack']
      );
      assert.equal(page.totalCount, 1);
    });

    it('publishes the credential-scoped roster', async () => {
      const store = createDerivedAccountStore({ listAccounts: () => [account('a'), account('b')] });
      const page = await store.list({}, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['a', 'b']
      );
    });

    it('honors the account_id filter', async () => {
      const store = createDerivedAccountStore({ listAccounts: () => [account('a'), account('b')] });
      const page = await store.list({ account: { account_id: 'b' } }, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['b']
      );
    });

    it('narrows on a natural-key filter instead of ignoring it', async () => {
      const store = createDerivedAccountStore({
        listAccounts: () => [
          account('a', { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' }),
          account('b', { brand: { domain: 'other.com' }, operator: 'pinnacle.com' }),
          account('c'),
        ],
      });
      const byBrand = await store.list({ account: { brand: { domain: 'acme.com' } } }, oauthCtx('b1'));
      assert.deepEqual(
        byBrand.items.map(a => a.id),
        ['a']
      );
      const byOperator = await store.list({ account: { operator: 'pinnacle.com' } }, oauthCtx('b1'));
      assert.deepEqual(
        byOperator.items.map(a => a.id),
        ['a', 'b']
      );
    });

    it('narrows on brand_id as well as brand.domain', async () => {
      const store = createDerivedAccountStore({
        listAccounts: () => [
          account('a', { brand: { domain: 'acme.com', brand_id: 'spark' } }),
          account('b', { brand: { domain: 'acme.com', brand_id: 'ember' } }),
        ],
      });
      const page = await store.list({ account: { brand: { domain: 'acme.com', brand_id: 'ember' } } }, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['b']
      );
    });

    it('honors the status filter', async () => {
      const store = createDerivedAccountStore({
        listAccounts: () => [account('a'), account('b', { status: 'suspended' })],
      });
      const page = await store.list({ status: 'suspended' }, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['b']
      );
    });

    it('honors the sandbox filter via account mode (incl. the deprecated sandbox flag)', async () => {
      const store = createDerivedAccountStore({
        listAccounts: () => [
          account('live_1'),
          account('sandbox_mode', { mode: 'sandbox' }),
          account('legacy_flag', { sandbox: true }),
        ],
      });
      const sandboxOnly = await store.list({ sandbox: true }, oauthCtx('b1'));
      assert.deepEqual(
        sandboxOnly.items.map(a => a.id),
        ['sandbox_mode', 'legacy_flag']
      );
      const productionOnly = await store.list({ sandbox: false }, oauthCtx('b1'));
      assert.deepEqual(
        productionOnly.items.map(a => a.id),
        ['live_1']
      );
    });
  });

  describe('list pagination', () => {
    const roster = n =>
      createDerivedAccountStore({ listAccounts: () => Array.from({ length: n }, (_v, i) => account(`act_${i}`)) });

    it('caps the page at max_results and emits a continuation cursor', async () => {
      const store = roster(5);
      const first = await store.list({ pagination: { max_results: 2 } }, oauthCtx('b1'));
      assert.deepEqual(
        first.items.map(a => a.id),
        ['act_0', 'act_1']
      );
      assert.equal(first.totalCount, 5);
      assert.ok(first.nextCursor, 'a partial page must carry a cursor');
    });

    it('continues from the cursor and drops it on the last page', async () => {
      const store = roster(5);
      const first = await store.list({ pagination: { max_results: 3 } }, oauthCtx('b1'));
      const second = await store.list({ pagination: { max_results: 3, cursor: first.nextCursor } }, oauthCtx('b1'));
      assert.deepEqual(
        second.items.map(a => a.id),
        ['act_3', 'act_4']
      );
      assert.equal(second.nextCursor, undefined);
    });

    it('clamps max_results into [1, 100] and tolerates junk', async () => {
      const store = roster(150);
      assert.equal((await store.list({ pagination: { max_results: 0 } }, oauthCtx('b1'))).items.length, 1);
      assert.equal((await store.list({ pagination: { max_results: 5000 } }, oauthCtx('b1'))).items.length, 100);
      assert.equal((await store.list({}, oauthCtx('b1'))).items.length, 100);
    });

    it('treats an unparseable cursor as the first page instead of throwing', async () => {
      const store = roster(3);
      const page = await store.list({ pagination: { cursor: 'not-a-cursor' } }, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['act_0', 'act_1', 'act_2']
      );
    });

    it('applies filters before paging', async () => {
      const store = createDerivedAccountStore({
        listAccounts: () => [account('a'), account('b', { status: 'suspended' }), account('c')],
      });
      const page = await store.list({ status: 'active', pagination: { max_results: 1 } }, oauthCtx('b1'));
      assert.deepEqual(
        page.items.map(a => a.id),
        ['a']
      );
      assert.equal(page.totalCount, 2, 'total reflects the filtered set, not the whole roster');
    });
  });

  describe('composition', () => {
    it('supports spreading to add upsert without losing resolution or list', async () => {
      const upsertCalls = [];
      const accounts = {
        ...singletonStore(),
        upsert: async refs => {
          upsertCalls.push(refs);
          return [];
        },
      };
      assert.equal(accounts.resolution, 'derived');
      assert.equal(typeof accounts.list, 'function');
      assert.equal(typeof accounts.upsert, 'function');
      await accounts.upsert([{ account: { account_id: 'act_1' } }]);
      assert.equal(upsertCalls.length, 1);
    });
  });
});
