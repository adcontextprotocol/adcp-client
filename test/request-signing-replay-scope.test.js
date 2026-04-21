/**
 * Regression test for adcp#2460: the replay cache MUST scope by
 * `(keyid, @target-uri)`, not by `keyid` alone. Prior behavior allowed a
 * signature captured on `/create_media_buy` to be replayed against
 * `/update_media_buy` under the same keyid — the canonical signature base
 * commits to `@target-uri`, so the replay cache must partition by the same
 * dimension.
 *
 * These tests exercise the primitive `InMemoryReplayStore` directly and
 * also the end-to-end verifier pipeline. The verifier test is the load-
 * bearing one: it confirms that a same-nonce request against a different
 * endpoint verifies cleanly, and then is itself rejected on a second
 * delivery to that same endpoint.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  StaticJwksResolver,
  canonicalTargetUri,
  signRequest,
  verifyRequestSignature,
} = require('../dist/lib/signing/index.js');

const KEYS_PATH = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
const ed = keys.find(k => k.kid === 'test-ed25519-2026');
const privateJwk = { ...ed, d: ed._private_d_for_test_only };
delete privateJwk._private_d_for_test_only;
delete privateJwk.key_ops;
delete privateJwk.use;
const publicJwk = { ...ed };
delete publicJwk._private_d_for_test_only;

describe('InMemoryReplayStore: (keyid, @target-uri) scoping (adcp#2460)', () => {
  test('same (keyid, nonce) inserts succeed on two different endpoints', async () => {
    const store = new InMemoryReplayStore();
    const now = 1_776_520_800;
    const keyid = 'test-ed25519-2026';
    const nonce = 'shared-nonce-across-endpoints';
    const create = canonicalTargetUri('https://seller.example.com/adcp/create_media_buy');
    const update = canonicalTargetUri('https://seller.example.com/adcp/update_media_buy');

    assert.strictEqual(await store.insert(keyid, create, nonce, 300, now), 'ok');
    assert.strictEqual(
      await store.insert(keyid, update, nonce, 300, now),
      'ok',
      'a captured /create_media_buy signature must NOT consume the replay budget on /update_media_buy'
    );

    // And the second insert on the SAME endpoint still replays.
    assert.strictEqual(await store.insert(keyid, create, nonce, 300, now), 'replayed');
    assert.strictEqual(await store.insert(keyid, update, nonce, 300, now), 'replayed');
  });

  test('has() is partitioned by scope', async () => {
    const store = new InMemoryReplayStore();
    const now = 1_776_520_800;
    const keyid = 'test-ed25519-2026';
    const nonce = 'partition-probe-nonce';
    const create = canonicalTargetUri('https://seller.example.com/adcp/create_media_buy');
    const update = canonicalTargetUri('https://seller.example.com/adcp/update_media_buy');

    await store.insert(keyid, create, nonce, 300, now);
    assert.strictEqual(await store.has(keyid, create, nonce, now), true);
    assert.strictEqual(await store.has(keyid, update, nonce, now), false);
  });

  test('isCapHit is partitioned by scope (per-pair cap)', async () => {
    const store = new InMemoryReplayStore({ maxEntriesPerKeyid: 2 });
    const now = 1_776_520_800;
    const keyid = 'test-ed25519-2026';
    const create = canonicalTargetUri('https://seller.example.com/adcp/create_media_buy');
    const update = canonicalTargetUri('https://seller.example.com/adcp/update_media_buy');

    await store.insert(keyid, create, 'n1', 300, now);
    await store.insert(keyid, create, 'n2', 300, now);
    assert.strictEqual(await store.isCapHit(keyid, create, now), true);
    // A different endpoint under the same keyid is NOT capped.
    assert.strictEqual(await store.isCapHit(keyid, update, now), false);
  });

  test('setCapHitForTesting without scope caps every scope under the keyid', async () => {
    const store = new InMemoryReplayStore();
    const now = 1_776_520_800;
    const keyid = 'test-ed25519-2026';
    const create = canonicalTargetUri('https://seller.example.com/adcp/create_media_buy');
    const update = canonicalTargetUri('https://seller.example.com/adcp/update_media_buy');

    store.setCapHitForTesting(keyid);
    assert.strictEqual(await store.isCapHit(keyid, create, now), true);
    assert.strictEqual(await store.isCapHit(keyid, update, now), true);
  });

  test('setCapHitForTesting with scope caps only that scope', async () => {
    const store = new InMemoryReplayStore();
    const now = 1_776_520_800;
    const keyid = 'test-ed25519-2026';
    const create = canonicalTargetUri('https://seller.example.com/adcp/create_media_buy');
    const update = canonicalTargetUri('https://seller.example.com/adcp/update_media_buy');

    store.setCapHitForTesting(keyid, create);
    assert.strictEqual(await store.isCapHit(keyid, create, now), true);
    assert.strictEqual(await store.isCapHit(keyid, update, now), false);
  });
});

describe('verifyRequestSignature: cross-endpoint replay rejected (adcp#2460)', () => {
  const capability = { supported: true, covers_content_digest: 'either', required_for: [] };

  test('same nonce on two different endpoints both verify cleanly', async () => {
    const replayStore = new InMemoryReplayStore();
    const revocationStore = new InMemoryRevocationStore();
    const jwks = new StaticJwksResolver([publicJwk]);
    const now = 1_776_520_800;
    const nonce = 'cross-endpoint-replay-probe';

    const createReq = buildSigned({ nonce, url: 'https://seller.example.com/adcp/create_media_buy', now });
    const updateReq = buildSigned({ nonce, url: 'https://seller.example.com/adcp/update_media_buy', now });

    const createResult = await verifyRequestSignature(createReq, {
      capability,
      jwks,
      replayStore,
      revocationStore,
      now: () => now,
      operation: 'create_media_buy',
    });
    assert.strictEqual(createResult.status, 'verified');

    const updateResult = await verifyRequestSignature(updateReq, {
      capability,
      jwks,
      replayStore,
      revocationStore,
      now: () => now,
      operation: 'update_media_buy',
    });
    assert.strictEqual(
      updateResult.status,
      'verified',
      'prior /create_media_buy nonce commit must NOT block an identical nonce on /update_media_buy'
    );
  });

  test('same nonce replayed on the same endpoint is rejected with request_signature_replayed', async () => {
    const replayStore = new InMemoryReplayStore();
    const revocationStore = new InMemoryRevocationStore();
    const jwks = new StaticJwksResolver([publicJwk]);
    const now = 1_776_520_800;
    const nonce = 'same-endpoint-replay-probe';

    const req = buildSigned({ nonce, url: 'https://seller.example.com/adcp/create_media_buy', now });

    await verifyRequestSignature(req, {
      capability,
      jwks,
      replayStore,
      revocationStore,
      now: () => now,
      operation: 'create_media_buy',
    });

    await assert.rejects(
      () =>
        verifyRequestSignature(req, {
          capability,
          jwks,
          replayStore,
          revocationStore,
          now: () => now,
          operation: 'create_media_buy',
        }),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_replayed'
    );
  });
});

function buildSigned({ nonce, url, now }) {
  const body = '{"plan_id":"plan_001"}';
  const signed = signRequest(
    { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
    { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
    { now: () => now, windowSeconds: 300, nonce }
  );
  return { method: 'POST', url, headers: signed.headers, body };
}
