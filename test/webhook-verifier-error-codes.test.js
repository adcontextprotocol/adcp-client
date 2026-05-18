/**
 * Error-code coverage for the webhook-signing verifier split added in
 * adcp#2467: `webhook_mode_mismatch` (wrong adcp_use for mode) and
 * `webhook_target_uri_malformed` (syntactically invalid @target-uri).
 *
 * Exercises the verifier directly rather than going through the storyboard
 * runner so the step-level semantics — distinct codes for distinct
 * remediation paths — are covered even when no receiver is running.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { verifyWebhookSignature } = require('../dist/lib/signing/webhook-verifier.js');
const { signWebhook, prepareWebhookSignature, finalizeRequestSignature } = require('../dist/lib/signing/signer.js');
const nodeCrypto = require('node:crypto');
const { StaticJwksResolver } = require('../dist/lib/signing/jwks.js');
const { InMemoryReplayStore } = require('../dist/lib/signing/replay.js');
const { InMemoryRevocationStore } = require('../dist/lib/signing/revocation.js');
const { WebhookSignatureError } = require('../dist/lib/signing/errors.js');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'webhook-signing-vectors');
const KEYS = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'keys.json'), 'utf8'));

function keyByKid(kid) {
  const entry = KEYS.keys.find(k => k.kid === kid);
  if (!entry) throw new Error(`Missing test key ${kid}`);
  return entry;
}

/**
 * Strip private material so the verifier sees only the public half — mirrors
 * what a real JWKS endpoint publishes.
 */
function toPublicJwk(jwk, overrides = {}) {
  const { _private_d_for_test_only, d, ...pub } = jwk;
  return { ...pub, ...overrides };
}

function signerKeyFor(kid) {
  const entry = keyByKid(kid);
  return {
    keyid: entry.kid,
    alg: entry.alg === 'EdDSA' ? 'ed25519' : 'ecdsa-p256-sha256',
    privateKey: {
      kid: entry.kid,
      kty: entry.kty,
      crv: entry.crv,
      alg: entry.alg,
      adcp_use: entry.adcp_use,
      x: entry.x,
      y: entry.y,
      d: entry._private_d_for_test_only,
    },
  };
}

/**
 * Sign a webhook while bypassing the signer-side `adcp_use` purpose gate so
 * the negative-vector cross-purpose-rejection test can construct a payload
 * that exercises the *verifier's* step-8 check. The convenience helper
 * `signWebhook` refuses non-webhook-signing keys (the gate's whole point);
 * compose `prepareWebhookSignature` + node:crypto + `finalizeRequestSignature`
 * to author adversarial signatures legitimately. Same pattern the
 * storyboard request-signing builder uses for AdCP negative vector 009.
 */
function signWebhookBypassingPurposeGate(request, signerKey, options) {
  const prepared = prepareWebhookSignature(request, { keyid: signerKey.keyid, alg: signerKey.alg }, options);
  const privateKey = nodeCrypto.createPrivateKey({ key: signerKey.privateKey, format: 'jwk' });
  const sigBytes =
    signerKey.alg === 'ed25519'
      ? nodeCrypto.sign(null, Buffer.from(prepared.base, 'utf8'), privateKey)
      : nodeCrypto.sign('sha256', Buffer.from(prepared.base, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return finalizeRequestSignature(prepared, new Uint8Array(sigBytes));
}

async function verify(requestLike, jwks, opts = {}) {
  return verifyWebhookSignature(requestLike, {
    jwks,
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
    now: () => opts.now ?? Math.floor(Date.now() / 1000),
  });
}

describe('webhook verifier: webhook_mode_mismatch (adcp#2467)', () => {
  test('JWK with adcp_use="request-signing" rejected with webhook_mode_mismatch', async () => {
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-wrong-purpose-2026');
    const request = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/create_media_buy/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_01HW9D3H8FZP2N6R8T0V4X6Z9B","status":"completed"}',
    };
    // Bypass the signer-side adcp_use gate: this test exists precisely to
    // exercise the verifier's step-8 cross-purpose rejection, which requires
    // a wire payload signed with a request-signing key.
    const signed = signWebhookBypassingPurposeGate(request, signerKey, { now: () => now });
    const jwk = toPublicJwk(keyByKid('test-wrong-purpose-2026')); // adcp_use: "request-signing"
    const jwks = new StaticJwksResolver([jwk]);

    let thrown;
    try {
      await verify({ ...request, headers: { ...request.headers, ...signed.headers } }, jwks, { now });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'Expected verifyWebhookSignature to throw');
    assert.ok(
      thrown instanceof WebhookSignatureError,
      `Expected WebhookSignatureError, got ${thrown?.constructor?.name}: ${thrown?.message}`
    );
    assert.strictEqual(thrown.code, 'webhook_mode_mismatch');
    assert.strictEqual(thrown.failedStep, 8);
    assert.match(thrown.message, /request-signing/);
  });

  test('JWK with adcp_use undefined still rejected with webhook_signature_key_purpose_invalid', async () => {
    // Preservation of the legacy code: when adcp_use is NOT declared at all
    // (as opposed to declared-but-wrong), the old error stays so existing
    // conformance expectations for "no purpose" hold.
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const request = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/create_media_buy/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_01HW9D3H8FZP2N6R8T0V4X6Z9B","status":"completed"}',
    };
    const signed = signWebhook(request, signerKey, { now: () => now });
    // Present a JWK that has no adcp_use at all.
    const { adcp_use, ...withoutPurpose } = toPublicJwk(keyByKid('test-ed25519-webhook-2026'));
    const jwks = new StaticJwksResolver([withoutPurpose]);

    let thrown;
    try {
      await verify({ ...request, headers: { ...request.headers, ...signed.headers } }, jwks, { now });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof WebhookSignatureError, `Expected WebhookSignatureError, got ${thrown}`);
    assert.strictEqual(thrown.code, 'webhook_signature_key_purpose_invalid');
    assert.strictEqual(thrown.failedStep, 8);
  });
});

describe('webhook verifier: webhook_target_uri_malformed (adcp#2467)', () => {
  /**
   * For malformed-URI assertions we don't need a real signature — the check
   * fires before step 7 (JWKS resolution). But we do need parseable signature
   * headers so steps 1–6 succeed. Build a minimum signed request against a
   * known-good URL, then swap the URL to the malformed value before
   * verifying. This matches how the check actually runs in production:
   * `request.url` is what the verifier reads to validate `@target-uri`.
   */
  function minimallySignedRequest() {
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const original = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_01HW9D3H8FZP2N6R8T0V4X6Z9B"}',
    };
    const signed = signWebhook(original, signerKey, { now: () => now });
    return {
      now,
      request: { ...original, headers: { ...original.headers, ...signed.headers } },
    };
  }

  const jwks = () => new StaticJwksResolver([toPublicJwk(keyByKid('test-ed25519-webhook-2026'))]);

  test('non-parseable URL rejected with webhook_target_uri_malformed', async () => {
    const { now, request } = minimallySignedRequest();
    request.url = 'not-a-url';

    let thrown;
    try {
      await verify(request, jwks(), { now });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError, `Expected WebhookSignatureError, got ${thrown}`);
    assert.strictEqual(thrown.code, 'webhook_target_uri_malformed');
  });

  test('non-https scheme rejected with webhook_target_uri_malformed', async () => {
    const { now, request } = minimallySignedRequest();
    request.url = 'http://buyer.example.com/adcp/webhook/foo/agent_123/op_abc';

    let thrown;
    try {
      await verify(request, jwks(), { now });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError, `Expected WebhookSignatureError, got ${thrown}`);
    assert.strictEqual(thrown.code, 'webhook_target_uri_malformed');
    assert.match(thrown.message, /https/);
  });

  test('URL with userinfo rejected with webhook_target_uri_malformed', async () => {
    const { now, request } = minimallySignedRequest();
    request.url = 'https://user:pass@buyer.example.com/adcp/webhook/foo/agent_123/op_abc';

    let thrown;
    try {
      await verify(request, jwks(), { now });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError, `Expected WebhookSignatureError, got ${thrown}`);
    assert.strictEqual(thrown.code, 'webhook_target_uri_malformed');
    assert.match(thrown.message, /userinfo/);
  });

  test('URL with fragment rejected with webhook_target_uri_malformed', async () => {
    const { now, request } = minimallySignedRequest();
    request.url = 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc#frag';

    let thrown;
    try {
      await verify(request, jwks(), { now });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError, `Expected WebhookSignatureError, got ${thrown}`);
    assert.strictEqual(thrown.code, 'webhook_target_uri_malformed');
    assert.match(thrown.message, /fragment/);
  });
});

describe('webhook verifier: step 2 params_incomplete', () => {
  function signedRequest() {
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const original = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_step2"}',
    };
    const signed = signWebhook(original, signerKey, { now: () => now });
    return { now, request: { ...original, headers: { ...original.headers, ...signed.headers } } };
  }
  const jwks = () => new StaticJwksResolver([toPublicJwk(keyByKid('test-ed25519-webhook-2026'))]);

  for (const param of ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag']) {
    test(`rejects when ${param} is missing`, async () => {
      const { now, request } = signedRequest();
      request.headers['Signature-Input'] = request.headers['Signature-Input'].replace(
        new RegExp(`;${param}=(?:"[^"]*"|[0-9]+)`),
        ''
      );
      let thrown;
      try {
        await verify(request, jwks(), { now });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof WebhookSignatureError);
      assert.strictEqual(thrown.code, 'webhook_signature_params_incomplete');
      assert.strictEqual(thrown.failedStep, 2);
    });
  }
});

describe('webhook verifier: step 4 alg_not_allowed', () => {
  test('rejects when alg is not in the AdCP allowlist (e.g. hs256)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const original = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_step4"}',
    };
    const signed = signWebhook(original, signerKey, { now: () => now });
    const tampered = signed.headers['Signature-Input'].replace(/alg="[^"]+"/, 'alg="hs256"');
    const request = { ...original, headers: { ...original.headers, ...signed.headers, 'Signature-Input': tampered } };
    const jwks = new StaticJwksResolver([toPublicJwk(keyByKid('test-ed25519-webhook-2026'))]);
    let thrown;
    try {
      await verify(request, jwks, { now });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError);
    assert.strictEqual(thrown.code, 'webhook_signature_alg_not_allowed');
    assert.strictEqual(thrown.failedStep, 4);
  });
});

describe('webhook verifier: step 7 kid mismatch', () => {
  test('rejects when JWKS resolver returns a JWK whose kid disagrees with the requested keyid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const original = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_step7"}',
    };
    const signed = signWebhook(original, signerKey, { now: () => now });
    const request = { ...original, headers: { ...original.headers, ...signed.headers } };
    const mismatched = { ...toPublicJwk(keyByKid('test-ed25519-webhook-2026')), kid: 'some-other-kid' };
    const liarJwks = { resolve: async () => mismatched };
    let thrown;
    try {
      await verify(request, liarJwks, { now });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError);
    assert.strictEqual(thrown.code, 'webhook_signature_key_unknown');
    assert.strictEqual(thrown.failedStep, 7);
  });
});

describe('webhook verifier: step 9 revocation_stale', () => {
  test('re-maps request_signature_revocation_stale → webhook_signature_revocation_stale', async () => {
    const { RequestSignatureError: RequestSignatureErrorClass } = require('../dist/lib/signing/index.js');
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const original = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_stale"}',
    };
    const signed = signWebhook(original, signerKey, { now: () => now });
    const request = { ...original, headers: { ...original.headers, ...signed.headers } };
    const jwks = new StaticJwksResolver([toPublicJwk(keyByKid('test-ed25519-webhook-2026'))]);
    const staleStore = {
      isRevoked: async () => {
        throw new RequestSignatureErrorClass(
          'request_signature_revocation_stale',
          9,
          'revocation snapshot is past grace'
        );
      },
    };
    let thrown;
    try {
      await verifyWebhookSignature(request, {
        jwks,
        replayStore: new InMemoryReplayStore(),
        revocationStore: staleStore,
        now: () => now,
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError);
    assert.strictEqual(thrown.code, 'webhook_signature_revocation_stale');
    assert.strictEqual(thrown.failedStep, 9);
  });
});

describe('webhook verifier: step 9a / 13 rate_abuse', () => {
  function signedRequest() {
    const now = Math.floor(Date.now() / 1000);
    const signerKey = signerKeyFor('test-ed25519-webhook-2026');
    const original = {
      method: 'POST',
      url: 'https://buyer.example.com/adcp/webhook/foo/agent_123/op_abc',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotency_key":"whk_rate"}',
    };
    const signed = signWebhook(original, signerKey, { now: () => now });
    return { now, request: { ...original, headers: { ...original.headers, ...signed.headers } } };
  }
  const jwks = () => new StaticJwksResolver([toPublicJwk(keyByKid('test-ed25519-webhook-2026'))]);

  async function runWithStore(replayStore) {
    const { now, request } = signedRequest();
    return verifyWebhookSignature(request, {
      jwks: jwks(),
      replayStore,
      revocationStore: new InMemoryRevocationStore(),
      now: () => now,
    });
  }

  test('isCapHit pre-check trips rate_abuse', async () => {
    const capStore = {
      has: async () => false,
      isCapHit: async () => true,
      insert: async () => 'ok',
    };
    let thrown;
    try {
      await runWithStore(capStore);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError);
    assert.strictEqual(thrown.code, 'webhook_signature_rate_abuse');
    assert.strictEqual(thrown.failedStep, 9);
  });

  test('insert returns rate_abuse at commit phase', async () => {
    const commitStore = {
      has: async () => false,
      isCapHit: async () => false,
      insert: async () => 'rate_abuse',
    };
    let thrown;
    try {
      await runWithStore(commitStore);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError);
    assert.strictEqual(thrown.code, 'webhook_signature_rate_abuse');
    assert.strictEqual(thrown.failedStep, 13);
  });

  test('insert returns replayed at commit phase', async () => {
    const racyStore = {
      has: async () => false,
      isCapHit: async () => false,
      insert: async () => 'replayed',
    };
    let thrown;
    try {
      await runWithStore(racyStore);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof WebhookSignatureError);
    assert.strictEqual(thrown.code, 'webhook_signature_replayed');
    assert.strictEqual(thrown.failedStep, 13);
  });
});
