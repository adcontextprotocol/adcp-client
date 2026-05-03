'use strict';

// `createRosterAccountStore` reference adapter — Shape C for `resolution:
// 'explicit'` publisher-curated platforms. Covers point-lookup dispatch,
// the brand-arm and ref-less fallthrough behaviors, optional list
// pagination, the resolveWithoutRef escape hatch, and the auto-attach
// of authInfo by the framework (left to the framework, not asserted here —
// `Account.authInfo` is omittable from the toAccount return).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRosterAccountStore } = require('../dist/lib/adapters');

describe('createRosterAccountStore', () => {
  it('declares resolution: explicit', () => {
    const store = createRosterAccountStore({
      lookup: () => undefined,
      toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
    });
    assert.equal(store.resolution, 'explicit');
  });

  it('omits list when no list option is provided', () => {
    const store = createRosterAccountStore({
      lookup: () => undefined,
      toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
    });
    assert.equal(store.list, undefined);
  });

  it('omits write/refresh paths the helper does not own', () => {
    const store = createRosterAccountStore({
      lookup: () => undefined,
      toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
    });
    assert.equal(store.upsert, undefined);
    assert.equal(store.reportUsage, undefined);
    assert.equal(store.getAccountFinancials, undefined);
    assert.equal(store.refreshToken, undefined);
  });

  describe('resolve', () => {
    it('looks up by account_id and threads the result through toAccount', async () => {
      const roster = new Map([['acct-1', { id: 'acct-1', display: 'Acme', upstream: 'u-100' }]]);
      const store = createRosterAccountStore({
        lookup: id => roster.get(id),
        toAccount: row => ({
          id: row.id,
          name: row.display,
          status: 'active',
          ctx_metadata: { upstreamId: row.upstream },
        }),
      });

      const account = await store.resolve({ account_id: 'acct-1' }, { authInfo: { kind: 'public' } });
      assert.ok(account);
      assert.equal(account.id, 'acct-1');
      assert.equal(account.name, 'Acme');
      assert.deepEqual(account.ctx_metadata, { upstreamId: 'u-100' });
    });

    it('returns null for unknown account_id', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      assert.equal(await store.resolve({ account_id: 'missing' }), null);
    });

    it('returns null for brand+operator-shaped refs (no account_id)', async () => {
      let lookupCalled = false;
      const store = createRosterAccountStore({
        lookup: () => {
          lookupCalled = true;
          return undefined;
        },
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });

      const result = await store.resolve({ brand: { domain: 'acme.com' }, operator: 'agency.com' });
      assert.equal(result, null);
      assert.equal(lookupCalled, false, 'lookup should not be called for brand-arm refs');
    });

    it('returns null when ref is absent and no resolveWithoutRef is configured', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      assert.equal(await store.resolve(undefined), null);
    });

    it('uses resolveWithoutRef when ref is absent (returns Account directly, bypasses toAccount)', async () => {
      let toAccountCalled = false;
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => {
          toAccountCalled = true;
          return { id: row.id, name: row.id, status: 'active', ctx_metadata: {} };
        },
        resolveWithoutRef: () => ({
          id: '__publisher__',
          name: 'Publisher',
          status: 'active',
          ctx_metadata: { synthetic: true },
        }),
      });

      const account = await store.resolve(undefined, { authInfo: { kind: 'public' } });
      assert.ok(account);
      assert.equal(account.id, '__publisher__');
      assert.equal(account.name, 'Publisher');
      assert.deepEqual(account.ctx_metadata, { synthetic: true });
      assert.equal(toAccountCalled, false, 'toAccount must not be called for resolveWithoutRef');
    });

    it('returns null when resolveWithoutRef returns undefined', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
        resolveWithoutRef: () => undefined,
      });
      assert.equal(await store.resolve(undefined), null);
    });

    it('passes ctx through to resolveWithoutRef', async () => {
      let seenCtx;
      const ctx = { authInfo: { kind: 'public' }, toolName: 'list_creative_formats' };
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
        resolveWithoutRef: c => {
          seenCtx = c;
          return { id: 'singleton', name: 'Singleton', status: 'active', ctx_metadata: {} };
        },
      });

      await store.resolve(undefined, ctx);
      assert.equal(seenCtx, ctx);
    });

    it('passes ctx through to lookup and toAccount', async () => {
      let seenLookupCtx;
      let seenToAccountCtx;
      const ctx = { authInfo: { kind: 'oauth', credential: { kind: 'oauth', client_id: 'b1', scopes: [] } } };
      const store = createRosterAccountStore({
        lookup: (id, c) => {
          seenLookupCtx = c;
          return { id };
        },
        toAccount: (row, c) => {
          seenToAccountCtx = c;
          return { id: row.id, name: row.id, status: 'active', ctx_metadata: {} };
        },
      });

      await store.resolve({ account_id: 'a1' }, ctx);
      assert.equal(seenLookupCtx, ctx);
      assert.equal(seenToAccountCtx, ctx);
    });

    it('supports async lookup', async () => {
      const store = createRosterAccountStore({
        lookup: async id => {
          await new Promise(r => setImmediate(r));
          return id === 'a1' ? { id: 'a1' } : undefined;
        },
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
      });

      const hit = await store.resolve({ account_id: 'a1' });
      assert.ok(hit);
      assert.equal(hit.id, 'a1');

      const miss = await store.resolve({ account_id: 'a2' });
      assert.equal(miss, null);
    });

    it('propagates lookup throws (framework projects to SERVICE_UNAVAILABLE)', async () => {
      const store = createRosterAccountStore({
        lookup: () => {
          throw new Error('upstream is down');
        },
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });

      await assert.rejects(() => store.resolve({ account_id: 'a1' }), /upstream is down/);
    });
  });

  describe('list', () => {
    it('threads adopter-paged entries through toAccount', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => ({
          id: row.id,
          name: row.name,
          status: 'active',
          ctx_metadata: { upstream: row.id },
        }),
        list: () => ({
          items: [
            { id: 'a1', name: 'A1' },
            { id: 'a2', name: 'A2' },
          ],
          nextCursor: 'cur-2',
        }),
      });

      const page = await store.list({ limit: 2 });
      assert.equal(page.items.length, 2);
      assert.equal(page.items[0].id, 'a1');
      assert.equal(page.items[0].name, 'A1');
      assert.deepEqual(page.items[0].ctx_metadata, { upstream: 'a1' });
      assert.equal(page.nextCursor, 'cur-2');
    });

    it('omits nextCursor when adopter does not return one (last page)', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
        list: () => ({ items: [{ id: 'only' }] }),
      });

      const page = await store.list({});
      assert.equal(page.items.length, 1);
      assert.equal(page.nextCursor, undefined);
      assert.equal('nextCursor' in page, false, 'nextCursor key must not be present');
    });

    it('passes filter and ctx through to adopter list', async () => {
      let seenFilter;
      let seenCtx;
      const ctx = { authInfo: { kind: 'public' } };
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
        list: (filter, c) => {
          seenFilter = filter;
          seenCtx = c;
          return { items: [] };
        },
      });

      const filter = { brand_domain: 'acme.com', limit: 50, cursor: 'c1' };
      await store.list(filter, ctx);
      assert.deepEqual(seenFilter, filter);
      assert.equal(seenCtx, ctx);
    });

    it('supports async list', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
        list: async () => {
          await new Promise(r => setImmediate(r));
          return { items: [{ id: 'a1' }] };
        },
      });

      const page = await store.list({});
      assert.equal(page.items[0].id, 'a1');
    });

    it('propagates list throws (framework projects to SERVICE_UNAVAILABLE)', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
        list: () => {
          throw new Error('roster query failed');
        },
      });

      await assert.rejects(() => store.list({}), /roster query failed/);
    });
  });

  describe('extension via spread', () => {
    it('adopters compose extra AccountStore methods on top of the helper output', async () => {
      const base = createRosterAccountStore({
        lookup: id => ({ id }),
        toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
      });

      const refreshCalls = [];
      const accounts = {
        ...base,
        refreshToken: async account => {
          refreshCalls.push(account.id);
          return { token: 'fresh' };
        },
      };

      assert.equal(accounts.resolution, 'explicit');
      assert.equal(typeof accounts.refreshToken, 'function');

      const account = await accounts.resolve({ account_id: 'a1' });
      assert.ok(account);

      const refreshed = await accounts.refreshToken(account, 'auth_required');
      assert.equal(refreshed.token, 'fresh');
      assert.deepEqual(refreshCalls, ['a1']);
    });
  });
});
