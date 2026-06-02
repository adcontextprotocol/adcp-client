const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  signRequestAsync,
  signWebhookAsync,
  RequestSignatureError,
  WebhookSignatureError,
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
const keysByKid = new Map(JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys.map(k => [k.kid, k]));

function privateJwk(kid, overrides = {}) {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...rest } = k;
  return { ...rest, d: _private_d_for_test_only, ...overrides };
}

const SAMPLE_REQUEST = {
  method: 'POST',
  url: 'https://seller.example.com/adcp/create_media_buy',
  headers: { 'Content-Type': 'application/json' },
  body: '{"plan_id":"p_1"}',
};

const SIGN_OPTIONS = { now: () => 1776520800, nonce: 'KXYnfEfJ0PBRZXQyVXfVQA', windowSeconds: 300 };
const KID = 'test-ed25519-2026';

describe('SigningProvider.adcpUse — purpose gate, async path', () => {
  describe('signRequestAsync', () => {
    test('accepts a provider with adcpUse="request-signing"', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'request-signing' }),
      });
      const signed = await signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS);
      assert.ok(signed.headers.Signature);
    });

    test('rejects a provider with adcpUse="webhook-signing"', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'webhook-signing' }),
      });
      await assert.rejects(
        () => signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
        err =>
          err instanceof RequestSignatureError &&
          err.code === 'request_signature_key_purpose_invalid' &&
          err.failedStep === 8 &&
          /webhook-signing/.test(err.message)
      );
    });

    test('rejects a response-signing provider key', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'response-signing' }),
      });
      await assert.rejects(
        () => signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
        err =>
          err instanceof RequestSignatureError &&
          err.code === 'request_signature_key_purpose_invalid' &&
          err.failedStep === 8 &&
          /response-signing/.test(err.message)
      );
    });

    test('rejects a provider key with unknown adcpUse', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'totally-unknown' }),
      });
      await assert.rejects(
        () => signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
        err =>
          err instanceof RequestSignatureError &&
          err.code === 'request_signature_key_purpose_invalid' &&
          err.failedStep === 8 &&
          /totally-unknown/.test(err.message)
      );
    });

    test('legacy provider without adcpUse skips the gate (backward-compat)', async () => {
      // Hand-built provider that omits adcpUse — simulates a pre-existing
      // adapter that pre-dates this field. Gate must be a no-op.
      const provider = {
        keyid: KID,
        algorithm: 'ed25519',
        fingerprint: 'test-fp',
        sign: payload =>
          require('node:crypto').sign(
            null,
            Buffer.from(payload),
            require('node:crypto').createPrivateKey({ key: privateJwk(KID), format: 'jwk' })
          ),
      };
      const signed = await signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS);
      assert.ok(signed.headers.Signature);
    });
  });

  describe('signWebhookAsync', () => {
    test('accepts a provider with adcpUse="webhook-signing"', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'webhook-signing' }),
      });
      const signed = await signWebhookAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS);
      assert.ok(signed.headers.Signature);
    });

    test('rejects a provider with adcpUse="request-signing"', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'request-signing' }),
      });
      await assert.rejects(
        () => signWebhookAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
        err =>
          err instanceof WebhookSignatureError &&
          err.code === 'webhook_signature_key_purpose_invalid' &&
          /request-signing/.test(err.message)
      );
    });

    test('rejects a response-signing provider key', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'response-signing' }),
      });
      await assert.rejects(
        () => signWebhookAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
        err =>
          err instanceof WebhookSignatureError &&
          err.code === 'webhook_signature_key_purpose_invalid' &&
          err.failedStep === 8 &&
          /response-signing/.test(err.message)
      );
    });

    test('rejects a provider key with unknown adcpUse', async () => {
      const provider = new InMemorySigningProvider({
        keyid: KID,
        algorithm: 'ed25519',
        privateKey: privateJwk(KID, { adcp_use: 'totally-unknown' }),
      });
      await assert.rejects(
        () => signWebhookAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
        err =>
          err instanceof WebhookSignatureError &&
          err.code === 'webhook_signature_key_purpose_invalid' &&
          err.failedStep === 8 &&
          /totally-unknown/.test(err.message)
      );
    });
  });
});

describe('SigningProvider.adcpUse — explicit option overrides JWK metadata', () => {
  test('options.adcpUse takes precedence over privateKey.adcp_use', async () => {
    // JWK says webhook-signing but caller asserts request-signing.
    const provider = new InMemorySigningProvider({
      keyid: KID,
      algorithm: 'ed25519',
      privateKey: privateJwk(KID, { adcp_use: 'webhook-signing' }),
      adcpUse: 'request-signing',
    });
    const signed = await signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS);
    assert.ok(signed.headers.Signature);
  });

  test('explicit response-signing adcpUse fails closed for request signing even when JWK metadata is valid', async () => {
    const provider = new InMemorySigningProvider({
      keyid: KID,
      algorithm: 'ed25519',
      privateKey: privateJwk(KID, { adcp_use: 'request-signing' }),
      adcpUse: 'response-signing',
    });
    await assert.rejects(
      () => signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_key_purpose_invalid' &&
        err.failedStep === 8 &&
        /response-signing/.test(err.message)
    );
  });

  test('explicit unknown adcpUse fails closed even when JWK metadata is valid', async () => {
    const provider = new InMemorySigningProvider({
      keyid: KID,
      algorithm: 'ed25519',
      privateKey: privateJwk(KID, { adcp_use: 'request-signing' }),
      adcpUse: 'totally-unknown',
    });
    await assert.rejects(
      () => signRequestAsync(SAMPLE_REQUEST, provider, SIGN_OPTIONS),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_key_purpose_invalid' &&
        err.failedStep === 8 &&
        /totally-unknown/.test(err.message)
    );
  });
});
