/**
 * Tests for `pemToAdcpJwk` — the public-key PEM → AdCP JWK helper.
 *
 * The helper exists because the JOSE/AdCP alg-name vocabulary mismatch
 * (`EdDSA`/`ES256` on the JWK vs `ed25519`/`ecdsa-p256-sha256` on the wire)
 * is the most common footgun for KMS adopters publishing JWKS. These tests
 * lock the mapping + the validation guards.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { generateKeyPairSync } = require('node:crypto');

const { pemToAdcpJwk } = require('../../dist/lib/signing/index.js');

function spkiPem(keyPair) {
  return keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
}
function pkcs8Pem(keyPair) {
  return keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('pemToAdcpJwk', () => {
  test('Ed25519 SPKI → JWK with alg "EdDSA" + AdCP fields', () => {
    const kp = generateKeyPairSync('ed25519');
    const jwk = pemToAdcpJwk(spkiPem(kp), {
      kid: 'addie-2026-04',
      algorithm: 'ed25519',
      adcp_use: 'request-signing',
    });
    assert.strictEqual(jwk.kty, 'OKP');
    assert.strictEqual(jwk.crv, 'Ed25519');
    assert.strictEqual(jwk.alg, 'EdDSA'); // JOSE name, not the wire name
    assert.strictEqual(jwk.kid, 'addie-2026-04');
    assert.strictEqual(jwk.use, 'sig');
    assert.strictEqual(jwk.adcp_use, 'request-signing');
    assert.deepStrictEqual(jwk.key_ops, ['verify']);
    assert.strictEqual(typeof jwk.x, 'string');
    assert.strictEqual(jwk.d, undefined, 'must NEVER carry private scalar');
  });

  test('ECDSA-P256 SPKI → JWK with alg "ES256"', () => {
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = pemToAdcpJwk(spkiPem(kp), {
      kid: 'addie-es256-2026-04',
      algorithm: 'ecdsa-p256-sha256',
      adcp_use: 'request-signing',
    });
    assert.strictEqual(jwk.kty, 'EC');
    assert.strictEqual(jwk.crv, 'P-256');
    assert.strictEqual(jwk.alg, 'ES256'); // JOSE name, not the wire name
    assert.strictEqual(jwk.kid, 'addie-es256-2026-04');
    assert.strictEqual(jwk.adcp_use, 'request-signing');
    assert.deepStrictEqual(jwk.key_ops, ['verify']);
    assert.strictEqual(typeof jwk.x, 'string');
    assert.strictEqual(typeof jwk.y, 'string');
    assert.strictEqual(jwk.d, undefined, 'must NEVER carry private scalar');
  });

  test('webhook-signing adcp_use is preserved verbatim', () => {
    const kp = generateKeyPairSync('ed25519');
    const jwk = pemToAdcpJwk(spkiPem(kp), {
      kid: 'addie-webhook-2026-04',
      algorithm: 'ed25519',
      adcp_use: 'webhook-signing',
    });
    assert.strictEqual(jwk.adcp_use, 'webhook-signing');
  });

  test('private-key PEM (PKCS#8) → TypeError, no JWK leaked', () => {
    const kp = generateKeyPairSync('ed25519');
    assert.throws(
      () =>
        pemToAdcpJwk(pkcs8Pem(kp), {
          kid: 'addie',
          algorithm: 'ed25519',
          adcp_use: 'request-signing',
        }),
      err => err instanceof TypeError && /private-key PEM|credential leak/i.test(err.message)
    );
  });

  test('private-key PEM (PKCS#1 RSA) → TypeError', () => {
    // RSA private key has its own header. We don't sign with RSA in AdCP, but
    // the guard should still catch it before the algorithm check.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    assert.throws(
      () =>
        pemToAdcpJwk(rsaPem, {
          kid: 'addie',
          algorithm: 'ed25519',
          adcp_use: 'request-signing',
        }),
      err => err instanceof TypeError && /private-key PEM|credential leak/i.test(err.message)
    );
  });

  test('public-key PEM with "PRIVATE KEY" mentioned in surrounding metadata is NOT false-positive', () => {
    // A public PEM with comment-like surrounding text mentioning "PRIVATE
    // KEY" must still be accepted — the guard anchors to the BEGIN line
    // header itself (RFC 7468 mandates exact uppercase between dashes).
    const kp = generateKeyPairSync('ed25519');
    const noisy = `# Note: do not confuse with the PRIVATE KEY at /etc/keys/old.pem\n${spkiPem(kp)}`;
    const jwk = pemToAdcpJwk(noisy, {
      kid: 'addie',
      algorithm: 'ed25519',
      adcp_use: 'request-signing',
    });
    assert.strictEqual(jwk.kty, 'OKP');
    assert.strictEqual(jwk.alg, 'EdDSA');
  });

  test('garbage input → TypeError with parse-failure context', () => {
    assert.throws(
      () =>
        pemToAdcpJwk('not a pem at all', {
          kid: 'addie',
          algorithm: 'ed25519',
          adcp_use: 'request-signing',
        }),
      err => err instanceof TypeError && /failed to parse|expected SPKI/i.test(err.message)
    );
  });

  test('unsupported algorithm → TypeError listing supported set', () => {
    const kp = generateKeyPairSync('ed25519');
    assert.throws(
      () =>
        pemToAdcpJwk(spkiPem(kp), {
          kid: 'addie',
          // @ts-expect-error — runtime guard for invalid alg
          algorithm: 'rsa-pss-sha256',
          adcp_use: 'request-signing',
        }),
      err => err instanceof TypeError && /unsupported algorithm/i.test(err.message)
    );
  });
});
