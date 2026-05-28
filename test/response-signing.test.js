const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  signResponse,
  signResponseAsync,
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
  signRequest,
  signWebhook,
  computeContentDigest,
} = require('../dist/lib/signing/index.js');

const { InMemorySigningProvider } = require('../dist/lib/signing/testing.js');
const signingClient = require('../dist/lib/signing/client.js');
const signingServer = require('../dist/lib/signing/server.js');

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
const keysByKid = new Map(JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys.map(k => [k.kid, k]));
const STRIP_ADCP_USE = Symbol('strip-adcp-use');

function privateJwkFor(kid, adcpUse = 'response-signing') {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...rest } = k;
  const out = { ...rest, d: _private_d_for_test_only };
  if (adcpUse === STRIP_ADCP_USE) {
    delete out.adcp_use;
  } else {
    out.adcp_use = adcpUse;
  }
  return out;
}

function publicJwkFor(kid) {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...publicPart } = k;
  return { ...publicPart, adcp_use: 'response-signing' };
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

describe('response-signing compatibility exports', () => {
  test('restores response-signing helpers on client and server subpaths', () => {
    for (const subpath of [signingClient, signingServer]) {
      assert.strictEqual(typeof subpath.signResponse, 'function');
      assert.strictEqual(typeof subpath.signResponseAsync, 'function');
      assert.strictEqual(typeof subpath.prepareResponseSignature, 'function');
      assert.strictEqual(typeof subpath.finalizeResponseSignature, 'function');
      assert.strictEqual(typeof subpath.buildResponseSignatureBase, 'function');
      assert.strictEqual(typeof subpath.ResponseSignatureError, 'function');
      assert.strictEqual(subpath.RESPONSE_SIGNING_TAG, RESPONSE_SIGNING_TAG);
    }
  });

  test('signResponse covers status, request binding, type, and digest by default', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);

    const parsed = parseSignatureInput(signed.headers['Signature-Input']);
    assert.deepStrictEqual(parsed.components, [
      '@status',
      '@method;req',
      '@authority;req',
      '@target-uri;req',
      'content-type',
      'content-digest',
    ]);
    assert.strictEqual(parsed.params.tag, RESPONSE_SIGNING_TAG);
    assert.strictEqual(signed.headers['Content-Digest'], computeContentDigest(SAMPLE_RESPONSE.body));
  });

  test('buildResponseSignatureBase round-trips to a valid Ed25519 signature', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
    const parsedSig = parseSignature(signed.headers.Signature, parsedInput.label);

    const base = buildResponseSignatureBase(
      parsedInput.components,
      { ...SAMPLE_RESPONSE, headers: signed.headers },
      parsedInput.params,
      parsedInput.signatureParamsValue
    );

    assert.strictEqual(base, signed.signatureBase);
    assert.strictEqual(
      verifySignature(
        parsedInput.params.alg,
        jwkToPublicKey(publicJwkFor(kid)),
        Buffer.from(base, 'utf8'),
        parsedSig.bytes
      ),
      true
    );
  });

  test('buildResponseSignatureBase round-trips to a valid ECDSA-P256 signature', () => {
    const kid = 'test-es256-2026';
    const key = { keyid: kid, alg: 'ecdsa-p256-sha256', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
    const parsedSig = parseSignature(signed.headers.Signature, parsedInput.label);
    const base = buildResponseSignatureBase(
      parsedInput.components,
      { ...SAMPLE_RESPONSE, headers: signed.headers },
      parsedInput.params,
      parsedInput.signatureParamsValue
    );

    assert.strictEqual(
      verifySignature(
        parsedInput.params.alg,
        jwkToPublicKey(publicJwkFor(kid)),
        Buffer.from(base, 'utf8'),
        parsedSig.bytes
      ),
      true
    );
  });

  test('pins the response signature base byte format', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    const expectedDigest = computeContentDigest(SAMPLE_RESPONSE.body);
    const expectedBase = [
      '"@status": 200',
      '"@method";req: POST',
      '"@authority";req: seller.example.com',
      '"@target-uri";req: https://seller.example.com/adcp/get_products',
      '"content-type": application/json',
      `"content-digest": ${expectedDigest}`,
      `"@signature-params": ("@status" "@method";req "@authority";req "@target-uri";req "content-type" "content-digest");created=${FIXED_OPTIONS.now()};expires=${FIXED_OPTIONS.now() + FIXED_OPTIONS.windowSeconds};nonce="${FIXED_OPTIONS.nonce}";keyid="${kid}";alg="ed25519";tag="${RESPONSE_SIGNING_TAG}"`,
    ].join('\n');

    assert.strictEqual(signed.signatureBase, expectedBase);
  });

  test('changing the originating request method changes the signature base', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const postSigned = signResponse(SAMPLE_RESPONSE, key, FIXED_OPTIONS);
    const getSigned = signResponse(
      { ...SAMPLE_RESPONSE, request: { ...ORIGINATING_REQUEST, method: 'GET' } },
      key,
      FIXED_OPTIONS
    );

    assert.notStrictEqual(postSigned.signatureBase, getSigned.signatureBase);
    assert.match(postSigned.signatureBase, /"@method";req: POST/);
    assert.match(getSigned.signatureBase, /"@method";req: GET/);
  });

  test('omits content components when body is empty', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const signed = signResponse({ status: 204, headers: {}, request: ORIGINATING_REQUEST }, key, FIXED_OPTIONS);
    const parsed = parseSignatureInput(signed.headers['Signature-Input']);
    assert.deepStrictEqual(parsed.components, [...RESPONSE_MANDATORY_COMPONENTS]);
    assert.strictEqual(signed.headers['Content-Digest'], undefined);
  });

  test('prepare/finalize split matches signResponse', () => {
    const kid = 'test-ed25519-2026';
    const privateKey = privateJwkFor(kid);
    const prepared = prepareResponseSignature(SAMPLE_RESPONSE, { keyid: kid, alg: 'ed25519' }, FIXED_OPTIONS);
    const { createPrivateKey, sign } = require('node:crypto');
    const sig = sign(null, Buffer.from(prepared.base, 'utf8'), createPrivateKey({ key: privateKey, format: 'jwk' }));
    const finalized = finalizeResponseSignature(prepared, new Uint8Array(sig));
    const direct = signResponse(SAMPLE_RESPONSE, { keyid: kid, alg: 'ed25519', privateKey }, FIXED_OPTIONS);
    assert.deepStrictEqual(finalized, direct);
  });

  test('signResponseAsync matches signResponse', async () => {
    const kid = 'test-ed25519-2026';
    const privateKey = privateJwkFor(kid);
    const provider = new InMemorySigningProvider({ keyid: kid, algorithm: 'ed25519', privateKey });
    const direct = signResponse(SAMPLE_RESPONSE, { keyid: kid, alg: 'ed25519', privateKey }, FIXED_OPTIONS);
    const asyncSigned = await signResponseAsync(SAMPLE_RESPONSE, provider, FIXED_OPTIONS);
    assert.deepStrictEqual(asyncSigned, direct);
  });

  test('signResponseAsync rejects providers without explicit response-signing purpose', async () => {
    const kid = 'test-ed25519-2026';
    const privateKey = privateJwkFor(kid);
    const provider = {
      keyid: kid,
      algorithm: 'ed25519',
      fingerprint: 'legacy-provider-without-purpose',
      sign: payload =>
        require('node:crypto').sign(
          null,
          Buffer.from(payload),
          require('node:crypto').createPrivateKey({ key: privateKey, format: 'jwk' })
        ),
    };

    await assert.rejects(
      () => signResponseAsync(SAMPLE_RESPONSE, provider, FIXED_OPTIONS),
      err =>
        err instanceof ResponseSignatureError &&
        err.code === 'response_signature_key_purpose_invalid' &&
        /<missing>/.test(err.message)
    );
  });
});

describe('response-signing purpose binding', () => {
  test('signResponse requires a response-signing key', () => {
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

  test('signResponse rejects a missing adcp_use', () => {
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

  test('request and webhook signers still reject response-signing keys', () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid, 'response-signing') };
    assert.throws(
      () => signRequest({ method: 'POST', url: ORIGINATING_REQUEST.url, headers: {}, body: '{}' }, key, FIXED_OPTIONS),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_key_purpose_invalid'
    );
    assert.throws(
      () => signWebhook({ method: 'POST', url: ORIGINATING_REQUEST.url, headers: {}, body: '{}' }, key, FIXED_OPTIONS),
      err => err instanceof WebhookSignatureError && err.code === 'webhook_signature_key_purpose_invalid'
    );
  });
});
