/**
 * Regression tests for `createWebhookVerifier` factory (issue #926).
 *
 * Verifies that the factory defaults replayStore and revocationStore once at
 * creation time, so replay protection works even when the caller doesn't
 * supply explicit stores.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createWebhookVerifier, verifyWebhookSignature } = require('../dist/lib/signing/server.js');
const { WebhookSignatureError } = require('../dist/lib/signing');
const { StaticJwksResolver } = require('../dist/lib/signing/jwks.js');

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'webhook-signing-vectors');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'keys.json'), 'utf8'));
const vector = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'positive', '001-basic-post.json'), 'utf8'));

function buildJwks() {
  const byKid = new Map(keys.keys.map(k => [k.kid, k]));
  const selected = vector.jwks_ref.map(kid => {
    const key = byKid.get(kid);
    if (!key) throw new Error(`Fixture key not found: ${kid}`);
    const { _private_d_for_test_only, ...pub } = key;
    return pub;
  });
  return new StaticJwksResolver(selected);
}

describe('createWebhookVerifier factory — replay protection with default stores', () => {
  it('accepts a valid webhook on first delivery', async () => {
    const verifier = createWebhookVerifier({
      jwks: buildJwks(),
      now: () => vector.reference_now,
    });
    const result = await verifier(vector.request);
    assert.strictEqual(result.status, 'verified');
  });

  it('rejects a replayed nonce when no explicit store is passed', async () => {
    // The factory must default replayStore once at creation time. If it
    // constructed a fresh store on every call instead, the second call would
    // always accept the nonce — replay detection would be silently broken.
    const verifier = createWebhookVerifier({
      jwks: buildJwks(),
      now: () => vector.reference_now,
    });

    // First delivery — must succeed.
    const first = await verifier(vector.request);
    assert.strictEqual(first.status, 'verified');

    // Second delivery with the same nonce — must be rejected as a replay.
    await assert.rejects(
      () => verifier(vector.request),
      err => {
        assert.ok(
          err instanceof WebhookSignatureError,
          `Expected WebhookSignatureError, got ${err?.constructor?.name}`
        );
        assert.strictEqual(err.code, 'webhook_signature_replayed');
        return true;
      }
    );
  });

  it('passes explicit stores through to verifyWebhookSignature unchanged', async () => {
    // Callers who supply their own stores should see identical behavior to
    // calling verifyWebhookSignature directly.
    const { InMemoryReplayStore } = require('../dist/lib/signing/replay.js');
    const { InMemoryRevocationStore } = require('../dist/lib/signing/revocation.js');
    const replay = new InMemoryReplayStore();
    const revocation = new InMemoryRevocationStore();

    const verifier = createWebhookVerifier({
      jwks: buildJwks(),
      replayStore: replay,
      revocationStore: revocation,
      now: () => vector.reference_now,
    });

    const result = await verifier(vector.request);
    assert.strictEqual(result.status, 'verified');

    // The explicit replay store should have captured the nonce.
    await assert.rejects(
      () => verifier(vector.request),
      err => {
        assert.ok(err instanceof WebhookSignatureError);
        assert.strictEqual(err.code, 'webhook_signature_replayed');
        return true;
      }
    );
  });
});
