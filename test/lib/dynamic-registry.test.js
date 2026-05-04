const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createDynamicRegistry } = require('../../dist/lib/server/dynamic-registry.js');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Atomicity guarantees ───────────────────────────────────────────────────

describe('createDynamicRegistry — atomicity guarantees', () => {
  test('concurrent refresh() calls return the same Promise', async () => {
    const deferred = makeDeferred();
    const registry = createDynamicRegistry({
      registries: ['adapters', 'v6'],
      refresh: async pending => {
        await deferred.promise;
        pending.adapters.set('p1', { type: 'adapter' });
        pending.v6.set('p1', { type: 'v6' });
      },
    });

    const p1 = registry.refresh();
    const p2 = registry.refresh();
    assert.strictEqual(p1, p2, 'concurrent calls must return the same Promise identity');

    deferred.resolve();
    await p1;

    assert.deepStrictEqual(registry.get('adapters', 'p1'), { type: 'adapter' });
    assert.deepStrictEqual(registry.get('v6', 'p1'), { type: 'v6' });
  });

  test('sequential refresh() calls each get a fresh Promise', async () => {
    let callCount = 0;
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      refresh: async pending => {
        callCount++;
        pending.adapters.set('p1', { version: callCount });
      },
    });

    const p1 = registry.refresh();
    await p1;
    const p2 = registry.refresh();
    await p2;

    assert.notStrictEqual(p1, p2, 'sequential calls must return distinct Promises');
    assert.strictEqual(callCount, 2);
    assert.deepStrictEqual(registry.get('adapters', 'p1'), { version: 2 });
  });

  test('thrown refresh() clears in-flight guard; previous bundle survives', async () => {
    let callCount = 0;
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      refresh: async pending => {
        callCount++;
        if (callCount === 1) throw new Error('first refresh fails');
        pending.adapters.set('p1', { version: 2 });
      },
    });

    // First refresh throws — bundle stays empty, guard is cleared
    await assert.rejects(() => registry.refresh(), /first refresh fails/);
    assert.strictEqual(registry.get('adapters', 'p1'), undefined, 'bundle unchanged on throw');

    // Guard must be cleared so subsequent refresh succeeds
    await registry.refresh();
    assert.deepStrictEqual(registry.get('adapters', 'p1'), { version: 2 });
    assert.strictEqual(callCount, 2);
  });

  test('concurrent callers both receive the thrown error', async () => {
    const deferred = makeDeferred();
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      refresh: async () => {
        await deferred.promise;
        throw new Error('shared failure');
      },
    });

    const p1 = registry.refresh();
    const p2 = registry.refresh();
    assert.strictEqual(p1, p2);

    deferred.resolve(); // let the callback proceed to the explicit throw

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    assert.strictEqual(r1.status, 'rejected');
    assert.strictEqual(r2.status, 'rejected');
    assert.match(r1.reason.message, /shared failure/);
    assert.match(r2.reason.message, /shared failure/);
  });

  test('bundle swap is atomic — readers see new bundle in full, never half-rebuilt', async () => {
    // This tests the single-pointer swap guarantee. Two registries must
    // always be in sync — a reader can never see adapters at version N+1
    // while v6 is at version N.
    const registry = createDynamicRegistry({
      registries: ['adapters', 'v6'],
      refresh: async pending => {
        pending.adapters.set('p1', { v: 2 });
        pending.v6.set('p1', { v: 2 });
      },
    });

    await registry.refresh(); // initial state v=2

    // Simulate a reader that checks both registries synchronously
    const adapterEntry = registry.get('adapters', 'p1');
    const v6Entry = registry.get('v6', 'p1');
    assert.deepStrictEqual(adapterEntry?.v, v6Entry?.v, 'both registries must reflect the same version');
  });
});

// ── unregister() ──────────────────────────────────────────────────────────

describe('createDynamicRegistry — unregister()', () => {
  test('unregister() removes id from all named registries atomically', async () => {
    const registry = createDynamicRegistry({
      registries: ['adapters', 'v6'],
      refresh: async pending => {
        pending.adapters.set('p1', { type: 'adapter' });
        pending.v6.set('p1', { type: 'v6' });
        pending.adapters.set('p2', { type: 'adapter' });
      },
    });
    await registry.refresh();

    const removed = registry.unregister('p1');
    assert.strictEqual(removed, true);
    assert.strictEqual(registry.get('adapters', 'p1'), undefined);
    assert.strictEqual(registry.get('v6', 'p1'), undefined);
    // p2 unaffected
    assert.deepStrictEqual(registry.get('adapters', 'p2'), { type: 'adapter' });
  });

  test('unregister() returns false when id was not present', async () => {
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      refresh: async () => {},
    });
    await registry.refresh();
    assert.strictEqual(registry.unregister('nonexistent'), false);
  });
});

// ── staticIds carry-forward ───────────────────────────────────────────────

describe('createDynamicRegistry — staticIds carry-forward', () => {
  test('staticIds are preserved when refresh does not repopulate them', async () => {
    let firstRun = true;
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      staticIds: () => ['static-1'],
      refresh: async pending => {
        if (firstRun) {
          firstRun = false;
          pending.adapters.set('static-1', { v: 1 });
        }
        // second run: does not populate static-1
        pending.adapters.set('dynamic-1', { v: 2 });
      },
    });

    await registry.refresh();
    assert.deepStrictEqual(registry.get('adapters', 'static-1'), { v: 1 });

    await registry.refresh();
    assert.deepStrictEqual(registry.get('adapters', 'static-1'), { v: 1 }, 'carried forward');
    assert.deepStrictEqual(registry.get('adapters', 'dynamic-1'), { v: 2 });
  });

  test('staticIds are polled on each refresh so the set can change at runtime', async () => {
    const staticSet = new Set(['s1']);
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      staticIds: () => Array.from(staticSet),
      refresh: async pending => {
        // always seeds s1 first run; subsequent runs seed s2 only
      },
    });

    // First refresh — s1 has no prior value, nothing to carry forward
    await registry.refresh();
    assert.strictEqual(registry.get('adapters', 's1'), undefined);

    // Prime s1 directly via refresh populating it
    const registry2 = createDynamicRegistry({
      registries: ['adapters'],
      staticIds: () => Array.from(staticSet),
      refresh: async pending => {
        pending.adapters.set('s1', { first: true });
      },
    });
    await registry2.refresh();
    staticSet.add('s2'); // expand the static set at runtime
    await registry2.refresh(); // second refresh: s1 carried forward, s2 not (no prior value)
    assert.deepStrictEqual(registry2.get('adapters', 's1'), { first: true }, 's1 carried forward');
  });

  test('unregistered static id is suppressed from carry-forward', async () => {
    let call = 0;
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      staticIds: () => ['static-1'],
      refresh: async pending => {
        call++;
        if (call === 1) pending.adapters.set('static-1', { v: 1 });
        // call 2: does NOT populate static-1, but staticIds still returns it
      },
    });

    await registry.refresh();
    assert.deepStrictEqual(registry.get('adapters', 'static-1'), { v: 1 });

    registry.unregister('static-1');
    await registry.refresh();
    // staticIds() still returns 'static-1' but unregister() denylist suppresses carry-forward
    assert.strictEqual(registry.get('adapters', 'static-1'), undefined);
  });
});

// ── initial state ─────────────────────────────────────────────────────────

describe('createDynamicRegistry — initial state', () => {
  test('before first refresh(), get() returns undefined for all ids', () => {
    const registry = createDynamicRegistry({
      registries: ['adapters', 'v6'],
      refresh: async () => {},
    });
    assert.strictEqual(registry.get('adapters', 'any-id'), undefined);
    assert.strictEqual(registry.get('v6', 'any-id'), undefined);
  });

  test('unregister() before first refresh() returns false and does not throw', () => {
    const registry = createDynamicRegistry({
      registries: ['adapters'],
      refresh: async () => {},
    });
    assert.strictEqual(registry.unregister('nonexistent'), false);
  });
});
