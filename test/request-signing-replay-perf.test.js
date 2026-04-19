const { test } = require('node:test');
const assert = require('node:assert');
const { InMemoryReplayStore } = require('../dist/lib/signing/index.js');

// Issue #582: steady-state has()/insert() latency must NOT grow linearly with
// the entries-per-keyid count. The previous naive filter-on-every-call pruner
// was O(N), turning a hot keyid pinned near the cap into a quadratic DoS
// target. The time-bucketed store evicts whole buckets at a time, so
// amortized cost is O(1) per op.
//
// Timing on CI runners is noisy; we cap the growth ratio generously (<4x) and
// take the median of multiple measurement windows.

function timeBatch(fn, iterations) {
  const samples = [];
  for (let run = 0; run < 5; run++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn(i);
    const elapsed = Number(process.hrtime.bigint() - start);
    samples.push(elapsed / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

test('InMemoryReplayStore: has() stays sub-linear as entries-per-keyid grows', () => {
  const now = 1_000_000;
  const keyid = 'hotkey';
  const ttl = 300;

  const smallStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 1_000_000 });
  for (let i = 0; i < 1_000; i++) smallStore.preload(keyid, `nonce-s-${i}`, ttl, now);

  const bigStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 1_000_000 });
  for (let i = 0; i < 50_000; i++) bigStore.preload(keyid, `nonce-b-${i}`, ttl, now);

  // has() at now+10 — well within the window, so no bucket eviction runs.
  const smallNs = timeBatch(i => smallStore.has(keyid, `nonce-s-${i % 1_000}`, now + 10), 10_000);
  const bigNs = timeBatch(i => bigStore.has(keyid, `nonce-b-${i % 50_000}`, now + 10), 10_000);

  // 50x more entries → at most 4x per-op latency. Linear behaviour would be
  // ~50x. The fudge factor absorbs GC + measurement jitter on CI.
  const ratio = bigNs / smallNs;
  assert.ok(
    ratio < 4,
    `has() latency should stay sub-linear as entries grow 50x; measured ratio=${ratio.toFixed(2)} (small=${smallNs.toFixed(0)}ns, big=${bigNs.toFixed(0)}ns)`
  );
});

test('InMemoryReplayStore: insert() stays sub-linear as entries-per-keyid grows', () => {
  const now = 1_000_000;
  const ttl = 300;

  const smallStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 10_000_000 });
  for (let i = 0; i < 1_000; i++) smallStore.preload('k1', `seed-s-${i}`, ttl, now);

  const bigStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 10_000_000 });
  for (let i = 0; i < 50_000; i++) bigStore.preload('k1', `seed-b-${i}`, ttl, now);

  let sCounter = 0;
  const smallNs = timeBatch(() => smallStore.insert('k1', `fresh-s-${sCounter++}`, ttl, now + 10), 2_000);
  let bCounter = 0;
  const bigNs = timeBatch(() => bigStore.insert('k1', `fresh-b-${bCounter++}`, ttl, now + 10), 2_000);

  const ratio = bigNs / smallNs;
  assert.ok(
    ratio < 4,
    `insert() latency should stay sub-linear as entries grow 50x; measured ratio=${ratio.toFixed(2)} (small=${smallNs.toFixed(0)}ns, big=${bigNs.toFixed(0)}ns)`
  );
});

test('InMemoryReplayStore: bucket eviction releases memory when entries expire', async () => {
  const store = new InMemoryReplayStore({ maxEntriesPerKeyid: 1_000_000, bucketSizeSeconds: 60 });
  const keyid = 'k1';

  // Insert 10k entries that all expire at now+60 (single bucket).
  for (let i = 0; i < 10_000; i++) store.preload(keyid, `old-${i}`, 60, 1_000_000);
  assert.strictEqual(await store.isCapHit(keyid, 1_000_000), false);
  assert.strictEqual(await store.has(keyid, 'old-0', 1_000_059), true);

  // Advance past the bucket's latest expiry. The next call prunes the whole
  // bucket; old-0 must be gone.
  assert.strictEqual(await store.has(keyid, 'old-0', 1_000_121), false);
});
