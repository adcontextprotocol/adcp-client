'use strict';

// `createRosterAccountStore` reference adapter — Shape C for `resolution:
// 'explicit'` publisher-curated platforms. Covers point-lookup dispatch,
// the brand-arm and ref-less null fallthrough, optional list pagination,
// and the wrap-resolve composition patterns (singleton fallback +
// auth-derived lookup) for ref-less calls. The auto-attach of authInfo
// is the framework's job, not asserted here — `Account.authInfo` is
// omittable from the toAccount return.

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

    it('returns null when ref is absent (no resolveWithoutRef set)', async () => {
      const store = createRosterAccountStore({
        lookup: () => undefined,
        toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
      });
      assert.equal(await store.resolve(undefined), null);
    });

    describe('resolveWithoutRef', () => {
      it('calls resolveWithoutRef for ref-less calls and threads result through toAccount', async () => {
        const store = createRosterAccountStore({
          lookup: () => undefined,
          toAccount: row => ({ id: row.id, name: row.label, status: 'active', ctx_metadata: { pub: true } }),
          resolveWithoutRef: () => ({ id: '__pub__', label: 'Publisher' }),
        });
        const account = await store.resolve(undefined);
        assert.ok(account);
        assert.equal(account.id, '__pub__');
        assert.equal(account.name, 'Publisher');
        assert.deepEqual(account.ctx_metadata, { pub: true });
      });

      it('returns null when resolveWithoutRef returns undefined', async () => {
        const store = createRosterAccountStore({
          lookup: () => undefined,
          toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
          resolveWithoutRef: () => undefined,
        });
        assert.equal(await store.resolve(undefined), null);
      });

      it('does NOT call resolveWithoutRef for brand+operator refs', async () => {
        let resolveWithoutRefCalled = false;
        const store = createRosterAccountStore({
          lookup: () => undefined,
          toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
          resolveWithoutRef: () => {
            resolveWithoutRefCalled = true;
            return { id: '__pub__', label: 'Publisher' };
          },
        });
        const result = await store.resolve({ brand: { domain: 'acme.com' }, operator: 'agency.com' });
        assert.equal(result, null);
        assert.equal(resolveWithoutRefCalled, false, 'resolveWithoutRef must not be called for brand+operator refs');
      });

      it('passes undefined ref and ctx through to resolveWithoutRef and toAccount', async () => {
        let seenRef = 'NOT_SET';
        let seenResolveCtx;
        let seenToAccountCtx;
        const ctx = { authInfo: { kind: 'public' } };
        const store = createRosterAccountStore({
          lookup: () => undefined,
          toAccount: (row, c) => {
            seenToAccountCtx = c;
            return { id: row.id, name: row.id, status: 'active', ctx_metadata: {} };
          },
          resolveWithoutRef: (ref, c) => {
            seenRef = ref;
            seenResolveCtx = c;
            return { id: '__pub__' };
          },
        });
        await store.resolve(undefined, ctx);
        assert.equal(seenRef, undefined);
        assert.equal(seenResolveCtx, ctx);
        assert.equal(seenToAccountCtx, ctx);
      });

      it('propagates resolveWithoutRef throws (framework projects to SERVICE_UNAVAILABLE)', async () => {
        const store = createRosterAccountStore({
          lookup: () => undefined,
          toAccount: () => ({ id: 'x', name: 'x', status: 'active', ctx_metadata: {} }),
          resolveWithoutRef: () => {
            throw new Error('upstream is down');
          },
        });
        await assert.rejects(() => store.resolve(undefined), /upstream is down/);
      });

      it('supports async resolveWithoutRef', async () => {
        const store = createRosterAccountStore({
          lookup: () => undefined,
          toAccount: row => ({ id: row.id, name: row.id, status: 'active', ctx_metadata: {} }),
          resolveWithoutRef: async () => {
            await new Promise(r => setImmediate(r));
            return { id: '__pub__' };
          },
        });
        const account = await store.resolve(undefined);
        assert.ok(account);
        assert.equal(account.id, '__pub__');
      });
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

    it('singleton fallback for ref-less calls — wrap resolve', async () => {
      const base = createRosterAccountStore({
        lookup: id => ({ id, label: id.toUpperCase() }),
        toAccount: row => ({ id: row.id, name: row.label, status: 'active', ctx_metadata: { real: true } }),
      });

      const synth = { id: '__publisher__', name: 'Publisher', status: 'active', ctx_metadata: { synthetic: true } };
      const accounts = {
        ...base,
        resolve: async (ref, ctx) => {
          if (ref === undefined) return synth;
          return base.resolve(ref, ctx);
        },
      };

      const refLess = await accounts.resolve(undefined);
      assert.equal(refLess.id, '__publisher__');
      assert.deepEqual(refLess.ctx_metadata, { synthetic: true });

      const real = await accounts.resolve({ account_id: 'a1' });
      assert.equal(real.id, 'a1');
      assert.equal(real.name, 'A1');
      assert.deepEqual(real.ctx_metadata, { real: true });
    });

    it('auth-derived fallback for ref-less calls — wrap resolve and reuse base.resolve', async () => {
      const base = createRosterAccountStore({
        lookup: id => (id === 'tenant-of-buyer-7' ? { id, label: 'Buyer 7' } : undefined),
        toAccount: row => ({ id: row.id, name: row.label, status: 'active', ctx_metadata: {} }),
      });

      const accounts = {
        ...base,
        resolve: async (ref, ctx) => {
          if (ref === undefined) {
            const cred = ctx?.authInfo?.credential;
            const derivedId = cred?.kind === 'oauth' ? `tenant-of-${cred.client_id}` : undefined;
            return derivedId ? base.resolve({ account_id: derivedId }, ctx) : null;
          }
          return base.resolve(ref, ctx);
        },
      };

      const ctx = { authInfo: { kind: 'oauth', credential: { kind: 'oauth', client_id: 'buyer-7', scopes: [] } } };
      const account = await accounts.resolve(undefined, ctx);
      assert.ok(account);
      assert.equal(account.id, 'tenant-of-buyer-7');
      assert.equal(account.name, 'Buyer 7');
    });
  });
});
