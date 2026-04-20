/**
 * Conformance test: run every vector from
 * `test-vectors/webhook-signing/{positive,negative}/` against our verifier.
 *
 * Vectors are vendored at `test/fixtures/webhook-signing-vectors/` pending
 * the next AdCP tarball release (PR adcontextprotocol/adcp#2445 merged
 * post-rc.2). Swap to `compliance/cache/latest/test-vectors/webhook-signing/`
 * once the tarball ships them.
 *
 * Semantics:
 *   - Positive vectors MUST verify cleanly under the published keys.
 *   - Negative vectors MUST throw a `WebhookSignatureError` whose `code`
 *     byte-matches `expected_outcome.error_code`. Checklist step numbering
 *     is informational per the spec ("grading is on the stable error code
 *     only") so this test does not compare `failed_step`.
 *   - State-dependent vectors (replayed, key_revoked, rate_abuse,
 *     revocation_stale) install their `test_harness_state` into a fresh
 *     replay / revocation store before calling the verifier.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  verifyWebhookSignature,
} = require('../../dist/lib/signing/webhook-verifier.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay.js');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation.js');
const { RequestSignatureError, WebhookSignatureError } = require('../../dist/lib/signing/errors.js');

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'webhook-signing-vectors');

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, rel), 'utf8'));
}

function listVectors(kind) {
  return fs
    .readdirSync(path.join(FIXTURE_ROOT, kind))
    .filter(n => n.endsWith('.json'))
    .sort();
}

/**
 * Build the JWK set the vector expects the verifier to see: start from
 * `keys.json`, filter to `jwks_ref`, and apply any per-vector
 * `jwks_override` (e.g. vector 020 flips key_ops to `["sign"]`). Strips
 * `_private_d_for_test_only` since the verifier only needs the public half.
 */
function buildJwksResolver(keys, vector) {
  const byKid = new Map(keys.keys.map(k => [k.kid, k]));
  const overrides = vector.jwks_override ?? {};
  const selected = vector.jwks_ref.map(kid => {
    const override = overrides[kid];
    const base = override ?? byKid.get(kid);
    if (!base) return undefined;
    const { _private_d_for_test_only, ...publicJwk } = base;
    return publicJwk;
  });
  return new StaticJwksResolver(selected.filter(Boolean));
}

/**
 * Mock revocation store that unconditionally throws the shared
 * `request_signature_revocation_stale` error the verifier re-maps to
 * `webhook_signature_revocation_stale`. Used for vector 019.
 */
class StaleRevocationStore {
  async isRevoked() {
    throw new RequestSignatureError(
      'request_signature_revocation_stale',
      9,
      'Simulated stale revocation list for vector 019.'
    );
  }
}

function buildStores(vector) {
  const replay = new InMemoryReplayStore();
  const revocation = new InMemoryRevocationStore();
  let revocationStore = revocation;

  const state = vector.test_harness_state;
  if (state?.replay_cache_entries) {
    for (const { keyid, nonce } of state.replay_cache_entries) {
      // TTL well past reference_now so the entry is still in-window.
      replay.preload(keyid, nonce, 600, vector.reference_now);
    }
  }
  if (state?.revoked_kids) {
    revocation.load({
      issuer: 'test',
      updated: new Date(vector.reference_now * 1000).toISOString(),
      next_update: new Date((vector.reference_now + 86400) * 1000).toISOString(),
      revoked_kids: state.revoked_kids,
      revoked_jtis: [],
    });
  }
  if (state?.revocation_list_stale_seconds !== undefined) {
    revocationStore = new StaleRevocationStore();
  }
  if (vector.expected_outcome.error_code === 'webhook_signature_rate_abuse' && !state?.revoked_kids) {
    // Vector 018: pre-arm the per-keyid cap.
    replay.setCapHitForTesting(vector.jwks_ref[0]);
  }

  return { replay, revocation: revocationStore };
}

// ────────────────────────────────────────────────────────────
// Shared fixture load
// ────────────────────────────────────────────────────────────

const keys = loadJson('keys.json');

// ────────────────────────────────────────────────────────────
// Positive vectors
// ────────────────────────────────────────────────────────────

describe('webhook-signing conformance: positive vectors', () => {
  for (const name of listVectors('positive')) {
    const vector = loadJson(path.join('positive', name));
    test(`${name} — ${vector.name}`, async () => {
      const jwks = buildJwksResolver(keys, vector);
      const { replay, revocation } = buildStores(vector);
      const result = await verifyWebhookSignature(vector.request, {
        jwks,
        replayStore: replay,
        revocationStore: revocation,
        now: () => vector.reference_now,
      });
      assert.strictEqual(result.status, 'verified');
      assert.strictEqual(result.keyid, vector.jwks_ref[0]);
    });
  }
});

// ────────────────────────────────────────────────────────────
// Negative vectors
// ────────────────────────────────────────────────────────────

describe('webhook-signing conformance: negative vectors', () => {
  for (const name of listVectors('negative')) {
    const vector = loadJson(path.join('negative', name));
    const expected = vector.expected_outcome.error_code;
    test(`${name} — ${vector.name}`, async () => {
      const jwks = buildJwksResolver(keys, vector);
      const { replay, revocation } = buildStores(vector);
      let thrown;
      try {
        await verifyWebhookSignature(vector.request, {
          jwks,
          replayStore: replay,
          revocationStore: revocation,
          now: () => vector.reference_now,
        });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, `Expected verifyWebhookSignature to throw ${expected}, but it returned cleanly.`);
      assert.ok(
        thrown instanceof WebhookSignatureError,
        `Expected WebhookSignatureError, got ${thrown?.constructor?.name}: ${thrown?.message}`
      );
      assert.strictEqual(
        thrown.code,
        expected,
        `Expected code "${expected}", got "${thrown.code}" (${thrown.message})`
      );
    });
  }
});
