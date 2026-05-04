// Tests for #1531 — createDynamicRegistry.
//
// Pins five hard-won lessons from PR scope3data/agentic-adapters#248:
//   1. Single-pointer atomic swap (concurrent reader sees consistent
//      snapshot across `await`)
//   2. In-flight refresh guard (concurrent refreshes coalesce)
//   3. Pinned-carry-forward (pin always wins; refresh cannot
//      overwrite)
//   4. Lock-step unregister (clears across all registries)
//   5. Per-registry typed `get` (TS-side; not exercised at runtime)
//
// Plus the two design refinements the issue's pinned-flag comment
// raised: duplicate registration throws by default, pinned + refresh
// has well-defined semantics.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createDynamicRegistry } = require('../dist/lib/server/dynamic-registry');

const NAMES = ['adapters', 'v6', 'operational'];

function buildRegistry(refresh) {
  return createDynamicRegistry({ registries: NAMES, refresh });
}

describe('createDynamicRegistry — basic registration', () => {
  it('registers and reads back', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { id: 'snap', kind: 'adapter' });
    assert.deepStrictEqual(r.get('adapters', 'snap'), { id: 'snap', kind: 'adapter' });
  });

  it('returns undefined for unknown ids', () => {
    const r = buildRegistry();
    assert.strictEqual(r.get('adapters', 'unknown'), undefined);
  });

  it('throws on unknown registry name', () => {
    const r = buildRegistry();
    assert.throws(() => r.get('not-a-registry', 'snap'), /unknown registry name/);
    assert.throws(() => r.register('not-a-registry', 'snap', {}), /unknown registry name/);
  });

  it('exposes registryNames as a frozen array', () => {
    const r = buildRegistry();
    assert.deepStrictEqual([...r.registryNames], NAMES);
    assert.throws(() => r.registryNames.push('x'));
  });

  it('lists ids per registry via .ids()', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { id: 'snap' });
    r.register('adapters', 'reddit', { id: 'reddit' });
    r.register('v6', 'snap', { id: 'snap-v6' });
    assert.deepStrictEqual(r.ids('adapters').sort(), ['reddit', 'snap']);
    assert.deepStrictEqual(r.ids('v6'), ['snap']);
    assert.deepStrictEqual(r.ids('operational'), []);
  });

  it('has() returns true for present entries, false for absent', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { id: 'snap' });
    assert.strictEqual(r.has('adapters', 'snap'), true);
    assert.strictEqual(r.has('adapters', 'missing'), false);
    assert.throws(() => r.has('not-a-registry', 'snap'), /unknown registry name/);
  });
});

describe('createDynamicRegistry — duplicate registration', () => {
  it('throws on duplicate by default', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { v: 1 });
    assert.throws(() => r.register('adapters', 'snap', { v: 2 }), /duplicate registration/);
  });

  it('overwrites with { overwrite: true }', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { v: 1 });
    r.register('adapters', 'snap', { v: 2 }, { overwrite: true });
    assert.deepStrictEqual(r.get('adapters', 'snap'), { v: 2 });
  });

  it('overwrite without pinned:true clears a stale pin', async () => {
    const r = buildRegistry(async () => {});
    r.register('adapters', 'snap', { v: 1 }, { pinned: true });
    // Overwrite with new value but drop the pin
    r.register('adapters', 'snap', { v: 2 }, { overwrite: true });
    assert.deepStrictEqual(r.get('adapters', 'snap'), { v: 2 }, 'overwrite value visible immediately');
    // Refresh wipes all non-pinned entries; 'snap' is no longer pinned
    await r.refresh();
    assert.strictEqual(r.get('adapters', 'snap'), undefined, 'stale pin must not carry forward');
  });

  it('same id under different registries is not a duplicate', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { kind: 'adapter' });
    r.register('v6', 'snap', { kind: 'platform' });
    assert.deepStrictEqual(r.get('adapters', 'snap'), { kind: 'adapter' });
    assert.deepStrictEqual(r.get('v6', 'snap'), { kind: 'platform' });
  });
});

describe('createDynamicRegistry — lock-step unregister', () => {
  it('removes from every registry in one operation', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { kind: 'adapter' });
    r.register('v6', 'snap', { kind: 'platform' });
    r.register('operational', 'snap', { kind: 'op' });
    r.unregister('snap');
    assert.strictEqual(r.get('adapters', 'snap'), undefined);
    assert.strictEqual(r.get('v6', 'snap'), undefined);
    assert.strictEqual(r.get('operational', 'snap'), undefined);
  });

  it('unregister removes pin too', async () => {
    const r = buildRegistry(async () => {
      // empty refresh; pinned should survive unless unregistered first
    });
    r.register('adapters', 'snap', { kind: 'adapter' }, { pinned: true });
    r.unregister('snap');
    assert.strictEqual(r.get('adapters', 'snap'), undefined);
    // refresh shouldn't bring it back
    await r.refresh();
    assert.strictEqual(r.get('adapters', 'snap'), undefined);
  });

  it('unregister of unknown id is a no-op', () => {
    const r = buildRegistry();
    r.register('adapters', 'snap', { kind: 'adapter' });
    r.unregister('not-here');
    assert.deepStrictEqual(r.get('adapters', 'snap'), { kind: 'adapter' });
  });
});

describe('createDynamicRegistry — pinned-carry-forward', () => {
  it('pinned entries survive a no-op refresh', async () => {
    const r = buildRegistry(async () => {
      // empty pending — only pinned should remain after swap
    });
    r.register('adapters', 'snap', { kind: 'adapter' }, { pinned: true });
    r.register('v6', 'snap', { kind: 'platform' }, { pinned: true });
    await r.refresh();
    assert.deepStrictEqual(r.get('adapters', 'snap'), { kind: 'adapter' });
    assert.deepStrictEqual(r.get('v6', 'snap'), { kind: 'platform' });
  });

  it('non-pinned entries are wiped by refresh', async () => {
    const r = buildRegistry(async () => {});
    r.register('adapters', 'ephemeral', { kind: 'adapter' }); // no pin
    await r.refresh();
    assert.strictEqual(r.get('adapters', 'ephemeral'), undefined);
  });

  it('refresh adds new entries to pending; pinned coexist', async () => {
    const r = buildRegistry(async pending => {
      pending.adapters.set('dynamic-1', { kind: 'dynamic' });
      pending.adapters.set('dynamic-2', { kind: 'dynamic' });
    });
    r.register('adapters', 'static', { kind: 'static' }, { pinned: true });
    await r.refresh();
    assert.deepStrictEqual(r.ids('adapters').sort(), ['dynamic-1', 'dynamic-2', 'static']);
    assert.deepStrictEqual(r.get('adapters', 'static'), { kind: 'static' });
    assert.deepStrictEqual(r.get('adapters', 'dynamic-1'), { kind: 'dynamic' });
  });

  it('pin always wins: callback writing a pinned id is silently overridden', async () => {
    const r = buildRegistry(async pending => {
      // Try to overwrite the pinned 'snap' entry. Pin wins; the
      // callback's value is discarded at swap time.
      pending.adapters.set('snap', { kind: 'attacker' });
    });
    r.register('adapters', 'snap', { kind: 'pinned-original' }, { pinned: true });
    await r.refresh();
    assert.deepStrictEqual(r.get('adapters', 'snap'), { kind: 'pinned-original' });
  });
});

describe('createDynamicRegistry — atomic swap across await', () => {
  // Tests in this block use a `started` sentinel promise the refresh
  // callback resolves as its first synchronous statement, instead of
  // `await new Promise(setImmediate)`. The sentinel is deterministic
  // — the test resumes only after the callback has reached its
  // pause point, regardless of how many microtask hops the runtime
  // schedules between `refresh()` and the callback body.

  it('concurrent reader during refresh sees old bundle until swap', async () => {
    let resolveBlock, resolveStarted;
    const block = new Promise(r => {
      resolveBlock = r;
    });
    const started = new Promise(r => {
      resolveStarted = r;
    });
    const r = buildRegistry(async pending => {
      pending.adapters.set('new', { kind: 'fresh' });
      resolveStarted();
      await block; // refresh is paused mid-callback
      pending.adapters.set('new2', { kind: 'fresher' });
    });

    // Start a refresh and wait for the callback to reach its pause
    const refreshPromise = r.refresh();
    await started;

    // Concurrent reader during the paused refresh sees the OLD bundle
    assert.strictEqual(r.get('adapters', 'new'), undefined, 'reader must not see new entries until refresh completes');
    assert.strictEqual(r.get('adapters', 'new2'), undefined);

    // Unblock and complete the refresh
    resolveBlock();
    await refreshPromise;

    // After swap, both entries are visible
    assert.deepStrictEqual(r.get('adapters', 'new'), { kind: 'fresh' });
    assert.deepStrictEqual(r.get('adapters', 'new2'), { kind: 'fresher' });
  });

  it('swap is all-or-nothing across multiple registries', async () => {
    let resolveBlock, resolveStarted;
    const block = new Promise(r => {
      resolveBlock = r;
    });
    const started = new Promise(r => {
      resolveStarted = r;
    });
    const r = buildRegistry(async pending => {
      pending.adapters.set('multi', 'a-value');
      resolveStarted();
      await block;
      pending.v6.set('multi', 'v6-value');
      pending.operational.set('multi', 'op-value');
    });

    const refreshPromise = r.refresh();
    await started;

    // No registry sees `multi` until the swap completes — reader
    // can't observe a half-bundle where `adapters` has `multi` but
    // the others don't.
    assert.strictEqual(r.get('adapters', 'multi'), undefined);
    assert.strictEqual(r.get('v6', 'multi'), undefined);
    assert.strictEqual(r.get('operational', 'multi'), undefined);

    resolveBlock();
    await refreshPromise;

    // Now ALL three are populated together.
    assert.strictEqual(r.get('adapters', 'multi'), 'a-value');
    assert.strictEqual(r.get('v6', 'multi'), 'v6-value');
    assert.strictEqual(r.get('operational', 'multi'), 'op-value');
  });
});

describe('createDynamicRegistry — in-flight refresh guard', () => {
  it('concurrent refresh() calls coalesce onto one callback invocation', async () => {
    let calls = 0;
    let resolveBlock;
    const block = new Promise(r => {
      resolveBlock = r;
    });
    const r = buildRegistry(async pending => {
      calls++;
      await block;
      pending.adapters.set(`call-${calls}`, calls);
    });

    const a = r.refresh();
    const b = r.refresh();
    const c = r.refresh();

    // Same Promise — coalesced
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);

    resolveBlock();
    await a;
    assert.strictEqual(calls, 1, 'callback runs exactly once for three concurrent refresh() calls');
    assert.strictEqual(r.get('adapters', 'call-1'), 1);
  });

  it('sequential refresh() calls each get a fresh callback invocation', async () => {
    let calls = 0;
    const r = buildRegistry(async pending => {
      calls++;
      pending.adapters.set(`call-${calls}`, calls);
    });

    await r.refresh();
    assert.strictEqual(calls, 1);
    assert.strictEqual(r.get('adapters', 'call-1'), 1);

    await r.refresh();
    assert.strictEqual(calls, 2);
    // Previous dynamic entry wiped by the second refresh
    assert.strictEqual(r.get('adapters', 'call-1'), undefined);
    assert.strictEqual(r.get('adapters', 'call-2'), 2);
  });

  it('inflight is cleared even when callback throws', async () => {
    let calls = 0;
    const r = buildRegistry(async () => {
      calls++;
      throw new Error('boom');
    });

    await assert.rejects(() => r.refresh(), /boom/);
    // Sequential call after a failure gets a fresh invocation
    await assert.rejects(() => r.refresh(), /boom/);
    assert.strictEqual(calls, 2);
  });
});

describe('createDynamicRegistry — refresh callback absent', () => {
  it('rejects if refresh() is called with no callback configured', async () => {
    const r = createDynamicRegistry({ registries: NAMES });
    await assert.rejects(() => r.refresh(), /no `refresh` callback was supplied/);
  });

  it('static-only adopters can register and read without ever calling refresh', () => {
    const r = createDynamicRegistry({ registries: NAMES });
    r.register('adapters', 'snap', { kind: 'adapter' }, { pinned: true });
    assert.deepStrictEqual(r.get('adapters', 'snap'), { kind: 'adapter' });
  });
});

describe('createDynamicRegistry — race semantics during refresh', () => {
  // These tests pin documented behavior for register/unregister calls
  // that land between refresh-start and the swap. The semantics are
  // load-bearing: the JSDoc on `register` calls them out and adopters
  // serialize when the dropped-write behavior would surprise them.

  it('non-pinned register() during in-flight refresh is dropped at swap', async () => {
    let resolveBlock, resolveStarted;
    const block = new Promise(r => {
      resolveBlock = r;
    });
    const started = new Promise(r => {
      resolveStarted = r;
    });
    const r = buildRegistry(async () => {
      resolveStarted();
      await block;
    });

    const refreshPromise = r.refresh();
    await started;

    // Register a non-pinned tenant while refresh is paused
    r.register('adapters', 'race', { kind: 'unpinned' });
    // Visible on the live bundle until swap
    assert.deepStrictEqual(r.get('adapters', 'race'), { kind: 'unpinned' });

    resolveBlock();
    await refreshPromise;

    // After swap: the non-pinned register is gone — it wasn't in
    // `pending` and wasn't pinned, so the swap's new bundle didn't
    // include it.
    assert.strictEqual(r.get('adapters', 'race'), undefined);
  });

  it('pinned register() during in-flight refresh survives the swap', async () => {
    let resolveBlock, resolveStarted;
    const block = new Promise(r => {
      resolveBlock = r;
    });
    const started = new Promise(r => {
      resolveStarted = r;
    });
    const r = buildRegistry(async () => {
      resolveStarted();
      await block;
    });

    const refreshPromise = r.refresh();
    await started;

    // Register a pinned tenant while refresh is paused — pin is added
    // to the live bundle, which is also the snapshot the swap reads.
    r.register('adapters', 'race-pinned', { kind: 'pinned' }, { pinned: true });

    resolveBlock();
    await refreshPromise;

    assert.deepStrictEqual(r.get('adapters', 'race-pinned'), { kind: 'pinned' });
  });

  it('unregister() during in-flight refresh removes the entry post-swap', async () => {
    let resolveBlock, resolveStarted;
    const block = new Promise(r => {
      resolveBlock = r;
    });
    const started = new Promise(r => {
      resolveStarted = r;
    });
    const r = buildRegistry(async () => {
      resolveStarted();
      await block;
    });
    r.register('adapters', 'doomed', { kind: 'pinned' }, { pinned: true });
    r.register('v6', 'doomed', { kind: 'platform' }, { pinned: true });

    const refreshPromise = r.refresh();
    await started;

    // Unregister mutates the live bundle (and its pinned set).
    // The refresh closure reads from the same live bundle — the
    // unregister IS visible at swap time.
    r.unregister('doomed');

    resolveBlock();
    await refreshPromise;

    assert.strictEqual(r.get('adapters', 'doomed'), undefined);
    assert.strictEqual(r.get('v6', 'doomed'), undefined);
  });
});

describe('createDynamicRegistry — construction-time validation', () => {
  it('throws on empty registries array', () => {
    assert.throws(() => createDynamicRegistry({ registries: [] }), /must contain at least one name/);
  });

  it('throws on duplicate registry names', () => {
    assert.throws(() => createDynamicRegistry({ registries: ['adapters', 'adapters'] }), /duplicate registry name/);
    assert.throws(() => createDynamicRegistry({ registries: ['a', 'b', 'a', 'c'] }), /duplicate registry name/);
  });
});
