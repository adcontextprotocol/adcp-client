const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createPrivateKey, sign } = require('node:crypto');

const {
  createWebhookVerifier,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  verifyWebhookSignature,
  WebhookSignatureError,
} = require('../dist/lib/signing/server.js');
const { signWebhook } = require('../dist/lib/signing/client.js');
const { keys } = require('./fixtures/webhook-signing-vectors/keys.json');

const NOW = 1776520800;
const BODY = '{"operation_id":"op-123","status":"completed"}';
const TARGET_URL = 'https://RECEIVER.example.:443/webhooks/%7e?route=%7e&encoded=%2f&space=+';

// Construct the signature base independently of SDK signing/canonicalization.
// AdCP 3.2 removes the host's trailing dot and preserves raw query bytes,
// regardless of webhook Signature encoding.
function signedWebhook(encoding, alg = 'ed25519') {
  const key = keys.find(
    key => key.adcp_use === 'webhook-signing' && key.alg === (alg === 'ed25519' ? 'EdDSA' : 'ES256')
  );
  assert.ok(key);
  const { _private_d_for_test_only: d, ...publicKey } = key;
  const digest = `sha-256=:${createHash('sha256').update(BODY).digest('base64')}:`;
  const params =
    '("@method" "@target-uri" "@authority" "content-type" "content-digest")' +
    `;created=${NOW};expires=${NOW + 300};nonce="MDEyMzQ1Njc4OWFiY2RlZg"` +
    `;keyid="${key.kid}";alg="${alg}";tag="adcp/webhook-signing/v1"`;
  const base = [
    '"@method": POST',
    '"@target-uri": https://receiver.example/webhooks/~?route=%7e&encoded=%2f&space=+',
    '"@authority": receiver.example',
    '"content-type": application/json',
    `"content-digest": ${digest}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const privateKey = createPrivateKey({ key: { ...publicKey, d }, format: 'jwk' });
  const signature =
    alg === 'ed25519'
      ? sign(null, Buffer.from(base), privateKey)
      : sign('sha256', Buffer.from(base), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    publicKey,
    signerKey: { keyid: key.kid, alg, privateKey: { ...publicKey, d } },
    request: {
      method: 'POST',
      url: TARGET_URL,
      body: BODY,
      headers: {
        'content-type': 'application/json',
        'content-digest': digest,
        'signature-input': `sig1=${params}`,
        signature: `sig1=:${signature.toString(encoding === 'rfc8941-base64' ? 'base64' : 'base64url')}:`,
      },
    },
  };
}

function options(publicKey, signatureEncoding) {
  return {
    jwks: new StaticJwksResolver([publicKey]),
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
    now: () => NOW,
    ...(signatureEncoding !== undefined && { signatureEncoding }),
  };
}

function failsAt(code, step) {
  return error => error instanceof WebhookSignatureError && error.code === code && error.failedStep === step;
}

describe('webhook Signature encoding is trusted configuration, independent of URL canonicalization (#3319)', () => {
  test('invalid encoding configuration fails at factory creation and on the direct path', async () => {
    const { request, publicKey } = signedWebhook('legacy-base64url');
    const opts = options(publicKey, 'base64');
    opts.jwks = { resolve: () => assert.fail('invalid configuration must not resolve keys') };
    assert.throws(() => createWebhookVerifier(opts), { name: 'TypeError', message: /signatureEncoding/ });
    await assert.rejects(verifyWebhookSignature(request, opts), { name: 'TypeError', message: /signatureEncoding/ });
  });

  test('Python 8.1.3 generic request signatures and dedicated webhook signatures interoperate', async () => {
    const fixture = require('./fixtures/webhook-signature-encoding-python-8.1.3.json');
    for (const { kind, request } of fixture.requests) {
      const encoding = kind === 'generic-request' ? 'rfc8941-base64' : undefined;
      const result = await verifyWebhookSignature(request, {
        ...options(fixture.jwk, encoding),
        now: () => fixture.reference_now,
      });
      assert.equal(result.status, 'verified', kind);
      assert.equal(result.keyid, fixture.jwk.kid);
    }
  });

  for (const alg of ['ed25519', 'ecdsa-p256-sha256']) {
    test(`${alg}: webhook-v1 Base64URL verifies by default and with an explicit encoding`, async () => {
      const { request, publicKey } = signedWebhook('legacy-base64url', alg);
      for (const encoding of [undefined, 'legacy-base64url']) {
        const result = await verifyWebhookSignature(request, options(publicKey, encoding));
        assert.equal(result.status, 'verified');
        assert.equal(result.keyid, publicKey.kid);
      }
    });

    test(`${alg}: explicitly configured RFC 8941 signatures verify`, async () => {
      const { request, publicKey } = signedWebhook('rfc8941-base64', alg);
      assert.match(request.headers.signature, /=:.*=+:/);
      const result = await verifyWebhookSignature(request, options(publicKey, 'rfc8941-base64'));
      assert.equal(result.status, 'verified');
      assert.equal(result.keyid, publicKey.kid);
    });
  }

  test('the default webhook-v1 profile rejects RFC 8941 Signature encoding', async () => {
    const { request, publicKey } = signedWebhook('rfc8941-base64');
    for (const encoding of [undefined, 'legacy-base64url']) {
      await assert.rejects(verifyWebhookSignature(request, options(publicKey, encoding)), error => {
        assert.match(error.message, /Base64URL for the selected signing profile/);
        return failsAt('webhook_signature_header_malformed', 1)(error);
      });
    }
  });

  test('the RFC 8941 route does not retry a Base64URL signature', async () => {
    const { request, publicKey } = signedWebhook('legacy-base64url');
    await assert.rejects(
      verifyWebhookSignature(request, options(publicKey, 'rfc8941-base64')),
      failsAt('webhook_signature_header_malformed', 1)
    );
  });

  test('re-encoding a valid signature cannot bypass a shared replay store', async () => {
    for (const encoding of ['legacy-base64url', 'rfc8941-base64']) {
      const { request, publicKey } = signedWebhook(encoding);
      const opts = options(publicKey, encoding);
      assert.equal((await verifyWebhookSignature(request, opts)).status, 'verified');
      const otherEncoding = encoding === 'legacy-base64url' ? 'rfc8941-base64' : 'legacy-base64url';
      const reencoded = signedWebhook(otherEncoding).request;
      await assert.rejects(
        verifyWebhookSignature(reencoded, { ...opts, signatureEncoding: otherEncoding }),
        failsAt('webhook_signature_replayed', 12)
      );
    }
  });

  for (const encoding of ['legacy-base64url', 'rfc8941-base64']) {
    test(`${encoding}: raw query mutations invalidate the signature`, async () => {
      const { request, publicKey } = signedWebhook(encoding);
      request.url = request.url.replace('route=%7e', 'route=~');
      await assert.rejects(
        verifyWebhookSignature(request, options(publicKey, encoding)),
        failsAt('webhook_signature_invalid', 10)
      );
    });

    test(`${encoding}: malformed mixed alphabets fail before key resolution`, async () => {
      const { request, publicKey } = signedWebhook(encoding);
      request.headers.signature = 'sig1=:AA-_+/==:';
      const opts = options(publicKey, encoding);
      opts.jwks = { resolve: () => assert.fail('malformed signatures must not resolve keys') };
      await assert.rejects(verifyWebhookSignature(request, opts), failsAt('webhook_signature_header_malformed', 1));
    });

    test(`${encoding}: body tampering fails without consuming the nonce`, async () => {
      const { request, publicKey } = signedWebhook(encoding);
      const opts = options(publicKey, encoding);
      await assert.rejects(
        verifyWebhookSignature({ ...request, body: `${BODY} ` }, opts),
        failsAt('webhook_signature_digest_mismatch', 11)
      );
      assert.equal((await verifyWebhookSignature(request, opts)).status, 'verified');
    });
  }

  test('the factory passes RFC 8941 configuration through and preserves replay protection', async () => {
    const { request, publicKey } = signedWebhook('rfc8941-base64');
    const verifier = createWebhookVerifier({
      jwks: new StaticJwksResolver([publicKey]),
      signatureEncoding: 'rfc8941-base64',
      now: () => NOW,
    });
    assert.equal((await verifier({ ...request, body: Buffer.from(BODY) })).status, 'verified');
    await assert.rejects(verifier(request), failsAt('webhook_signature_replayed', 12));
  });

  test('the SDK webhook signer still round-trips with the default profile and 3.2 URLs', async () => {
    const { request, publicKey, signerKey } = signedWebhook('legacy-base64url');
    const original = { ...request, headers: { 'content-type': 'application/json' } };
    const signed = signWebhook(original, signerKey, { now: () => NOW });
    assert.match(signed.headers.Signature, /^sig1=:[A-Za-z0-9_-]+:$/);
    assert.equal(
      (await verifyWebhookSignature({ ...original, headers: signed.headers }, options(publicKey))).status,
      'verified'
    );
  });
});
