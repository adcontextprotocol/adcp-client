const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  InMemoryStateStore,
  StateError,
  PatchConflictError,
  createSessionedStore,
  patchWithRetry,
} = require('../dist/lib/server/state-store');

// ---------------------------------------------------------------------------
// getWithVersion
// ---------------------------------------------------------------------------

describe('getWithVersion', () => {
  it('returns null for missing documents', async () => {
    const store = new InMemoryStateStore();
    assert.strictEqual(await store.getWithVersion('col', 'missing'), null);
  });

  it('returns data and version=1 after first put', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { v: 1 });
    const result = await store.getWithVersion('col', 'x');
    assert.deepStrictEqual(result.data, { v: 1 });
    assert.strictEqual(result.version, 1);
  });

  it('version increments on each put and patch', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { v: 1 });
    await store.put('col', 'x', { v: 2 });
    await store.patch('col', 'x', { extra: true });
    const result = await store.getWithVersion('col', 'x');
    assert.strictEqual(result.version, 3);
  });

  it('returns a defensive copy (mutation does not affect store)', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { v: 1 });
    const first = await store.getWithVersion('col', 'x');
    first.data.v = 99;
    const second = await store.getWithVersion('col', 'x');
    assert.strictEqual(second.data.v, 1);
  });
});

// ---------------------------------------------------------------------------
// putIfMatch
// ---------------------------------------------------------------------------

describe('putIfMatch', () => {
  it('inserts when expectedVersion is null and row is missing', async () => {
    const store = new InMemoryStateStore();
    const result = await store.putIfMatch('col', 'x', { v: 1 }, null);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.version, 1);
  });

  it('conflicts when expectedVersion is null but row exists', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { v: 1 });
    const result = await store.putIfMatch('col', 'x', { v: 2 }, null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.currentVersion, 1);
  });

  it('succeeds when expectedVersion matches', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { v: 1 });
    const result = await store.putIfMatch('col', 'x', { v: 2 }, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.version, 2);
    assert.deepStrictEqual(await store.get('col', 'x'), { v: 2 });
  });

  it('conflicts when expectedVersion is stale', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { v: 1 });
    await store.put('col', 'x', { v: 2 });
    const result = await store.putIfMatch('col', 'x', { v: 999 }, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.currentVersion, 2);
    assert.deepStrictEqual(await store.get('col', 'x'), { v: 2 });
  });

  it('exactly one of two concurrent null-expected inserts wins', async () => {
    const store = new InMemoryStateStore();
    const [r1, r2] = await Promise.all([
      store.putIfMatch('col', 'x', { winner: 'A' }, null),
      store.putIfMatch('col', 'x', { winner: 'B' }, null),
    ]);
    const wins = [r1, r2].filter(r => r.ok);
    const losses = [r1, r2].filter(r => !r.ok);
    assert.strictEqual(wins.length, 1, 'exactly one inserter should win');
    assert.strictEqual(losses.length, 1);
    assert.strictEqual(losses[0].currentVersion, 1, 'loser sees version=1');
  });

  it('conflicts with currentVersion=null when expected matches a nonexistent row', async () => {
    const store = new InMemoryStateStore();
    const result = await store.putIfMatch('col', 'x', { v: 1 }, 5);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.currentVersion, null);
  });

  it('validates payload size and charset', async () => {
    const store = new InMemoryStateStore({ maxDocumentBytes: 50 });
    await assert.rejects(
      () => store.putIfMatch('col', 'x', { blob: 'x'.repeat(200) }, null),
      err => err instanceof StateError && err.code === 'PAYLOAD_TOO_LARGE'
    );
  });
});

// ---------------------------------------------------------------------------
// patchWithRetry
// ---------------------------------------------------------------------------

describe('patchWithRetry', () => {
  it('creates a new row when none exists', async () => {
    const store = new InMemoryStateStore();
    const result = await patchWithRetry(store, 'col', 'x', current => ({
      count: (current?.count ?? 0) + 1,
    }));
    assert.deepStrictEqual(result, { count: 1 });
    assert.deepStrictEqual(await store.get('col', 'x'), { count: 1 });
  });

  it('updates an existing row atomically', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { count: 10, label: 'hi' });
    await patchWithRetry(store, 'col', 'x', current => ({
      ...current,
      count: current.count + 1,
    }));
    assert.deepStrictEqual(await store.get('col', 'x'), { count: 11, label: 'hi' });
  });

  it('returns null and does not write when update returns null', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { count: 10 });
    const result = await patchWithRetry(store, 'col', 'x', () => null);
    assert.strictEqual(result, null);
    assert.deepStrictEqual(await store.get('col', 'x'), { count: 10 });
  });

  it('retries on intervening writes and eventually succeeds', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { count: 0 });

    let callCount = 0;
    await patchWithRetry(store, 'col', 'x', current => {
      callCount += 1;
      if (callCount === 1) {
        // Intervening writer bumps the row — the next putIfMatch will conflict
        // and the closure will be retried against the new pre-state.
        store.put('col', 'x', { count: (current?.count ?? 0) + 5 });
      }
      return { count: (current?.count ?? 0) + 1 };
    });

    assert.ok(callCount >= 2, 'update closure should have been retried');
  });

  it('propagates exceptions from update without retrying', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { count: 0 });
    let callCount = 0;
    await assert.rejects(
      () =>
        patchWithRetry(store, 'col', 'x', () => {
          callCount += 1;
          throw new Error('kaboom');
        }),
      /kaboom/
    );
    assert.strictEqual(callCount, 1);
  });

  it('throws PatchConflictError after maxAttempts', async () => {
    const store = new InMemoryStateStore();
    await store.put('col', 'x', { count: 0 });

    await assert.rejects(
      () =>
        patchWithRetry(
          store,
          'col',
          'x',
          current => {
            // Force an intervening write on every attempt — always conflict.
            store.put('col', 'x', { count: (current?.count ?? 0) + 1 });
            return { count: (current?.count ?? 0) + 100 };
          },
          { maxAttempts: 3 }
        ),
      err => err instanceof PatchConflictError && err.attempts === 3
    );
  });

  it('errors clearly when store lacks getWithVersion / putIfMatch', async () => {
    const minimalStore = {
      get: async () => null,
      put: async () => {},
      patch: async () => {},
      delete: async () => false,
      list: async () => ({ items: [] }),
    };
    await assert.rejects(
      () => patchWithRetry(minimalStore, 'col', 'x', () => ({ v: 1 })),
      err => err instanceof StateError && err.code === 'BACKEND_ERROR'
    );
  });
});

// ---------------------------------------------------------------------------
// Sessioned-store proxying
// ---------------------------------------------------------------------------

describe('sessioned store + putIfMatch', () => {
  it('getWithVersion strips _session_key and preserves version', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await alice.put('col', 'x', { v: 1 });
    const result = await alice.getWithVersion('col', 'x');
    assert.deepStrictEqual(result.data, { v: 1 });
    assert.strictEqual(result.version, 1);
  });

  it('putIfMatch isolates between sessions', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    const bob = inner.scoped('bob');

    await alice.put('col', 'x', { owner: 'alice' });
    // Bob's version namespace is independent — null expected because his row doesn't exist.
    const bobResult = await bob.putIfMatch('col', 'x', { owner: 'bob' }, null);
    assert.strictEqual(bobResult.ok, true);

    assert.deepStrictEqual(await alice.get('col', 'x'), { owner: 'alice' });
    assert.deepStrictEqual(await bob.get('col', 'x'), { owner: 'bob' });
  });

  it('patchWithRetry works through a scoped store', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await alice.put('col', 'x', { count: 10 });
    await patchWithRetry(alice, 'col', 'x', current => ({ count: current.count + 5 }));
    assert.deepStrictEqual(await alice.get('col', 'x'), { count: 15 });
  });

  it('rejects _session_key in putIfMatch payload', async () => {
    const inner = new InMemoryStateStore();
    const alice = inner.scoped('alice');
    await assert.rejects(
      () => alice.putIfMatch('col', 'x', { _session_key: 'bob', v: 1 }, null),
      err => err instanceof StateError && err.code === 'INVALID_ID'
    );
  });

  it('falls through cleanly when inner store lacks the methods', () => {
    const minimal = {
      get: async () => null,
      put: async () => {},
      patch: async () => {},
      delete: async () => false,
      list: async () => ({ items: [] }),
    };
    const scoped = createSessionedStore(minimal, 'alice');
    // Methods are not proxied — patchWithRetry on this store will BACKEND_ERROR.
    assert.strictEqual(scoped.getWithVersion, undefined);
    assert.strictEqual(scoped.putIfMatch, undefined);
  });
});
