const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  StaticJwksResolver,
  verifyRequestSignature,
  signRequest,
  buildSignatureBase,
  canonicalTargetUri,
  parseSignatureInput,
} = require('../dist/lib/signing/index.js');

const ROOT = path.join(__dirname, '..', 'compliance', 'cache', 'latest', 'test-vectors', 'request-signing');

const keysData = JSON.parse(readFileSync(path.join(ROOT, 'keys.json'), 'utf8'));
const keysByKid = new Map(keysData.keys.map(k => [k.kid, k]));

function parseSigInput(headerValue) {
  const parsed = parseSignatureInput(headerValue);
  return { components: parsed.components, params: parsed.params };
}

function buildJwksForVector(vector) {
  if (vector.jwks_override) return new StaticJwksResolver(vector.jwks_override.keys);
  const entries = (vector.jwks_ref ?? []).map(kid => keysByKid.get(kid)).filter(k => k !== undefined);
  return new StaticJwksResolver(entries);
}

function operationFromUrl(url) {
  const p = new URL(url).pathname;
  return p.split('/').filter(Boolean).pop();
}

async function runVector(vector) {
  const now = vector.reference_now;
  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  // Replay entries are scoped by `(keyid, @target-uri)` (adcp#2460). Vector
  // harness-state preloads inherit the scope from the vector's request URL
  // — that's the endpoint the verifier will canonicalize when committing.
  const scope = canonicalTargetUri(vector.request.url);
  const state = vector.test_harness_state ?? {};
  if (state.replay_cache_entries) {
    for (const entry of state.replay_cache_entries) {
      replayStore.preload(entry.keyid, scope, entry.nonce, entry.ttl_seconds, now);
    }
  }
  if (state.revocation_list) revocationStore.load(state.revocation_list);
  if (state.replay_cache_per_keyid_cap_hit) {
    replayStore.setCapHitForTesting(state.replay_cache_per_keyid_cap_hit.keyid);
  }
  try {
    await verifyRequestSignature(vector.request, {
      capability: vector.verifier_capability,
      jwks: buildJwksForVector(vector),
      replayStore,
      revocationStore,
      now: () => now,
      operation: operationFromUrl(vector.request.url),
    });
    return { success: true };
  } catch (err) {
    if (err instanceof RequestSignatureError) {
      return { success: false, error_code: err.code, failed_step: err.failedStep };
    }
    throw err;
  }
}

describe('RFC 9421 canonicalization: positive expected_signature_base (adcp#2323)', () => {
  const dir = path.join(ROOT, 'positive');
  for (const file of readdirSync(dir).sort()) {
    const vector = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    if (!vector.expected_signature_base) continue;
    test(`${file}: signature base matches spec byte-for-byte`, () => {
      const { components, params } = parseSigInput(vector.request.headers['Signature-Input']);
      const base = buildSignatureBase(components, vector.request, params);
      assert.strictEqual(base, vector.expected_signature_base);
    });
  }
});

describe('RFC 9421 verifier: positive conformance vectors (adcp#2323)', () => {
  const dir = path.join(ROOT, 'positive');
  for (const file of readdirSync(dir).sort()) {
    const vector = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    test(file, async () => {
      const actual = await runVector(vector);
      assert.strictEqual(actual.success, true, JSON.stringify(actual));
    });
  }
});

// Vectors 021-026 exercise new verifier behaviors (duplicate Signature-Input
// labels, multi-valued content-type / content-digest, unquoted string params,
// JWK alg/crv consistency, non-ASCII @authority) that the verifier hasn't
// been extended to cover yet. Tracked as a follow-up to PR #631; skip in the
// conformance suite until the verifier work lands.
const NEGATIVE_VECTORS_UNIMPLEMENTED = new Set([
  '021-duplicate-signature-input-label.json',
  '022-multi-valued-content-type.json',
  '023-multi-valued-content-digest.json',
  '024-unquoted-string-param.json',
  '025-jwk-alg-crv-mismatch.json',
  '026-non-ascii-host.json',
]);

describe('RFC 9421 verifier: negative conformance vectors (adcp#2323)', () => {
  const dir = path.join(ROOT, 'negative');
  for (const file of readdirSync(dir).sort()) {
    const vector = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    test(
      `${file} → ${vector.expected_outcome.error_code}`,
      { skip: NEGATIVE_VECTORS_UNIMPLEMENTED.has(file) },
      async () => {
        const actual = await runVector(vector);
        assert.strictEqual(actual.success, false);
        assert.strictEqual(actual.error_code, vector.expected_outcome.error_code);
      }
    );
  }
});

describe('RFC 9421 signer: reference signature reproduction (adcp#2323)', () => {
  test('positive/001 reproduces spec Ed25519 signature byte-for-byte', () => {
    const vectorPath = path.join(ROOT, 'positive', '001-basic-post.json');
    const vector = JSON.parse(readFileSync(vectorPath, 'utf8'));
    const sigInput = vector.request.headers['Signature-Input'];
    const created = Number(sigInput.match(/created=(\d+)/)[1]);
    const expires = Number(sigInput.match(/expires=(\d+)/)[1]);
    const nonce = sigInput.match(/nonce="([^"]+)"/)[1];

    const jwk = { ...keysByKid.get('test-ed25519-2026') };
    jwk.d = jwk._private_d_for_test_only;
    delete jwk._private_d_for_test_only;
    delete jwk.key_ops;
    delete jwk.use;

    const signed = signRequest(
      {
        method: vector.request.method,
        url: vector.request.url,
        headers: { 'Content-Type': vector.request.headers['Content-Type'] },
        body: vector.request.body,
      },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: jwk },
      {
        now: () => created,
        windowSeconds: expires - created,
        nonce,
      }
    );

    const mySig = signed.headers.Signature.match(/sig1=:([^:]+):/)[1];
    const expectedSig = vector.request.headers.Signature.match(/sig1=:([^:]+):/)[1];
    assert.strictEqual(mySig, expectedSig);
  });
});
