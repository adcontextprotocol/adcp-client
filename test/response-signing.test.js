const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  signResponse,
  signResponseAsync,
  signRequest,
  signWebhook,
  prepareResponseSignature,
  finalizeResponseSignature,
  buildResponseSignatureBase,
  parseSignatureInput,
  parseSignature,
  jwkToPublicKey,
  verifySignature,
  RESPONSE_SIGNING_TAG,
  RESPONSE_MANDATORY_COMPONENTS,
  ResponseSignatureError,
  RequestSignatureError,
  WebhookSignatureError,
  computeContentDigest,
} = require('../dist/lib/signing/index.js');

const { InMemorySigningProvider } = require('../dist/lib/signing/testing.js');

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
const keysData = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
const keysByKid = new Map(keysData.keys.map(k => [k.kid, k]));

function publicJwkFor(kid) {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...publicPart } = k;
  return publicPart;
}

// Use a sentinel for "strip adcp_use entirely" so JS default-param semantics
// don't quietly substitute 'response-signing' when callers pass undefined.
const STRIP_ADCP_USE = Symbol('strip-adcp-use');

function privateJwkFor(kid, adcpUse = 'response-signing') {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...rest } = k;
  // Vectors carry adcp_use='request-signing'; override so the response-signing
  // purpose-binding gate in signResponse accepts the same key material.
  const out = { ...rest, d: _private_d_for_test_only };
  if (adcpUse === STRIP_ADCP_USE) {
    delete out.adcp_use;
  } else {
    out.adcp_use = adcpUse;
  }
  return out;
}

const ORIGINATING_REQUEST = {
  method: 'POST',
  url: 'https://seller.example.com/adcp/get_products',
};

const SAMPLE_RESPONSE = {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ products: [{ id: 'prod_001' }] }),
  request: ORIGINATING_REQUEST,
};

const FIXED_OPTIONS = {
  now: () => 1776520800,
  nonce: 'KXYnfEfJ0PBRZXQyVXfVQA',
  windowSeconds: 300,
};

describe('signResponse — default covered components', () => {
  test('covers @status, @authority, @target-uri, content-type, content-digest when body present', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const parsed = parseSignatureInput(signed.headers['Signature-Input']);
    assert.deepStrictEqual(parsed.components, [
      '@status',
      '@authority',
      '@target-uri',
      'content-type',
      'content-digest',
    ]);
    assert.strictEqual(parsed.params.tag, RESPONSE_SIGNING_TAG);
    assert.strictEqual(parsed.params.keyid, kid);
    assert.strictEqual(parsed.params.alg, 'ed25519');
  });

  test('omits content-digest and content-type when body is empty', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse({ status: 204, headers: {}, request: ORIGINATING_REQUEST }, key, FIXED_OPTIONS);
    const parsed = parseSignatureInput(signed.headers['Signature-Input']);
    assert.deepStrictEqual(parsed.components, [...RESPONSE_MANDATORY_COMPONENTS]);
    assert.strictEqual(signed.headers['Content-Digest'], undefined);
  });

  test('stamps Content-Digest matching the body', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    assert.strictEqual(signed.headers['Content-Digest'], computeContentDigest(SAMPLE_RESPONSE.body));
  });

  test('respects additionalComponents to add @method', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, {
      ...FIXED_OPTIONS,
      additionalComponents: ['@method'],
    });
    const parsed = parseSignatureInput(signed.headers['Signature-Input']);
    assert.ok(parsed.components.includes('@method'));
  });

  test('additionalComponents is idempotent for components already in defaults', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    // Passing @target-uri (already in defaults) must not duplicate it.
    const signed = signResponse(SAMPLE_RESPONSE, key, {
      ...FIXED_OPTIONS,
      additionalComponents: ['@target-uri'],
    });
    const parsed = parseSignatureInput(signed.headers['Signature-Input']);
    const occurrences = parsed.components.filter(c => c === '@target-uri').length;
    assert.strictEqual(occurrences, 1);
  });
});

describe('signResponse — round-trip verification', () => {
  test('Ed25519 signature verifies against the originating-request-bound base', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
    const parsedSig = parseSignature(signed.headers.Signature, parsedInput.label);

    // Rebuild the base from the response + headers + originating request,
    // using the verbatim signatureParamsValue so re-ordering can't drift.
    const responseForVerify = {
      status: SAMPLE_RESPONSE.status,
      headers: signed.headers,
      body: SAMPLE_RESPONSE.body,
      request: ORIGINATING_REQUEST,
    };
    const base = buildResponseSignatureBase(
      parsedInput.components,
      responseForVerify,
      parsedInput.params,
      parsedInput.signatureParamsValue
    );
    assert.strictEqual(base, signed.signatureBase);

    const publicKey = jwkToPublicKey(publicJwkFor(kid));
    const ok = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
    assert.strictEqual(ok, true);
  });

  test('ECDSA-P256 signature verifies', () => {
    const kid = 'test-es256-2026';
    const key = { keyid: kid, alg: 'ecdsa-p256-sha256', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
    const parsedSig = parseSignature(signed.headers.Signature, parsedInput.label);
    const responseForVerify = { ...SAMPLE_RESPONSE, headers: signed.headers };
    const base = buildResponseSignatureBase(
      parsedInput.components,
      responseForVerify,
      parsedInput.params,
      parsedInput.signatureParamsValue
    );
    const publicKey = jwkToPublicKey(publicJwkFor(kid));
    const ok = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
    assert.strictEqual(ok, true);
  });

  test('tampering with the body invalidates the signature', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
    const parsedSig = parseSignature(signed.headers.Signature, parsedInput.label);
    // Different body — content-digest in headers no longer matches what the
    // verifier-side caller would recompute. We rebuild the base against the
    // tampered body's content-digest to force a real mismatch.
    const tamperedBody = JSON.stringify({ products: [{ id: 'tampered' }] });
    const tamperedHeaders = { ...signed.headers, 'Content-Digest': computeContentDigest(tamperedBody) };
    const base = buildResponseSignatureBase(
      parsedInput.components,
      { ...SAMPLE_RESPONSE, body: tamperedBody, headers: tamperedHeaders },
      parsedInput.params,
      parsedInput.signatureParamsValue
    );
    const publicKey = jwkToPublicKey(publicJwkFor(kid));
    const ok = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
    assert.strictEqual(ok, false);
  });

  test('tampering with the status invalidates the signature', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
    const parsedSig = parseSignature(signed.headers.Signature, parsedInput.label);
    const base = buildResponseSignatureBase(
      parsedInput.components,
      { ...SAMPLE_RESPONSE, status: 500, headers: signed.headers },
      parsedInput.params,
      parsedInput.signatureParamsValue
    );
    const publicKey = jwkToPublicKey(publicJwkFor(kid));
    const ok = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
    assert.strictEqual(ok, false);
  });
});

describe('signResponse — wire-format fixture (RFC 9421 §2.5)', () => {
  // Pin the signature base byte-by-byte against an independently constructed
  // expected value. Without this fixture, all round-trip tests above would
  // pass even if `buildResponseSignatureBase` silently changed canonicalization
  // (since they both sign AND verify through the same builder). The fixture
  // is the only thing protecting wire-format compatibility from refactors.
  test('Ed25519 signature base matches RFC 9421 §2.5 prose for a known response', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const expectedDigest = computeContentDigest(SAMPLE_RESPONSE.body);
    // RFC 9421 §2.5: signature base is `"<component>": <value>\n` lines
    // followed by `"@signature-params": <params>`. Components in covered
    // order; params in the order this SDK canonicalizes (created, expires,
    // nonce, keyid, alg, tag).
    const expectedBase = [
      '"@status": 200',
      '"@authority": seller.example.com',
      '"@target-uri": https://seller.example.com/adcp/get_products',
      '"content-type": application/json',
      `"content-digest": ${expectedDigest}`,
      `"@signature-params": ("@status" "@authority" "@target-uri" "content-type" "content-digest");created=${FIXED_OPTIONS.now()};expires=${FIXED_OPTIONS.now() + FIXED_OPTIONS.windowSeconds};nonce="${FIXED_OPTIONS.nonce}";keyid="${kid}";alg="ed25519";tag="${RESPONSE_SIGNING_TAG}"`,
    ].join('\n');

    assert.strictEqual(signed.signatureBase, expectedBase);
  });

  test('Signature-Input header is canonical for the same response', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    const expected =
      `sig1=("@status" "@authority" "@target-uri" "content-type" "content-digest");` +
      `created=${FIXED_OPTIONS.now()};expires=${FIXED_OPTIONS.now() + FIXED_OPTIONS.windowSeconds};` +
      `nonce="${FIXED_OPTIONS.nonce}";keyid="${kid}";alg="ed25519";tag="${RESPONSE_SIGNING_TAG}"`;
    assert.strictEqual(signed.headers['Signature-Input'], expected);
  });
});

describe('signResponseAsync', () => {
  test('produces byte-identical output to signResponse for Ed25519', async () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    const sync = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    const asyncSig = await signResponseAsync(SAMPLE_RESPONSE, provider, FIXED_OPTIONS);
    assert.strictEqual(asyncSig.headers.Signature, sync.headers.Signature);
    assert.strictEqual(asyncSig.headers['Signature-Input'], sync.headers['Signature-Input']);
    assert.strictEqual(asyncSig.signatureBase, sync.signatureBase);
    assert.strictEqual(asyncSig.status, sync.status);
  });
});

describe('signResponse — adcp_use purpose binding', () => {
  test('rejects a webhook-signing key with response_signature_key_purpose_invalid', () => {
    const kid = 'test-ed25519-2026';
    const wrongPurpose = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid, 'webhook-signing') };
    assert.throws(
      () => signResponse(SAMPLE_RESPONSE, wrongPurpose, FIXED_OPTIONS),
      err =>
        err instanceof ResponseSignatureError &&
        err.code === 'response_signature_key_purpose_invalid' &&
        err.failedStep === 8 &&
        /webhook-signing/.test(err.message) &&
        /response-signing/.test(err.message)
    );
  });

  test('rejects a key with missing adcp_use', () => {
    const kid = 'test-ed25519-2026';
    const missingPurpose = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid, STRIP_ADCP_USE) };
    assert.throws(
      () => signResponse(SAMPLE_RESPONSE, missingPurpose, FIXED_OPTIONS),
      err =>
        err instanceof ResponseSignatureError &&
        err.code === 'response_signature_key_purpose_invalid' &&
        /<missing>/.test(err.message)
    );
  });
});

describe('signRequest / signWebhook — adcp_use purpose binding (regression)', () => {
  test('signRequest rejects a response-signing key', () => {
    const kid = 'test-ed25519-2026';
    const wrongPurpose = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid, 'response-signing') };
    assert.throws(
      () =>
        signRequest(
          {
            method: 'POST',
            url: 'https://seller.example.com/adcp/get_products',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
          wrongPurpose,
          FIXED_OPTIONS
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_key_purpose_invalid'
    );
  });

  test('signWebhook rejects a request-signing key', () => {
    const kid = 'test-ed25519-2026';
    const wrongPurpose = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid, 'request-signing') };
    assert.throws(
      () =>
        signWebhook(
          {
            method: 'POST',
            url: 'https://buyer.example.com/webhook',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
          wrongPurpose,
          FIXED_OPTIONS
        ),
      err => err instanceof WebhookSignatureError && err.code === 'webhook_signature_key_purpose_invalid'
    );
  });
});

describe('prepare/finalize split (KMS-shaped path)', () => {
  test('manual signer can stamp the same headers signResponse produces', () => {
    const kid = 'test-ed25519-2026';
    const privateKey = privateJwkFor(kid);
    const prepared = prepareResponseSignature(SAMPLE_RESPONSE, { keyid: kid, alg: 'ed25519' }, FIXED_OPTIONS);

    const { createPrivateKey, sign } = require('node:crypto');
    const pk = createPrivateKey({ key: privateKey, format: 'jwk' });
    const sig = sign(null, Buffer.from(prepared.base, 'utf8'), pk);
    const out = finalizeResponseSignature(prepared, new Uint8Array(sig));

    const expected = signResponse(SAMPLE_RESPONSE, { keyid: kid, alg: 'ed25519', privateKey }, FIXED_OPTIONS);
    assert.strictEqual(out.headers.Signature, expected.headers.Signature);
    assert.strictEqual(out.headers['Signature-Input'], expected.headers['Signature-Input']);
    assert.strictEqual(out.status, expected.status);
  });
});
