const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const crypto = require('node:crypto');
const {
  signRequest,
  signWebhook,
  verifyRequestSignature,
  verifyWebhookSignature,
  resolveRequestOperation,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../dist/lib/signing');

const NOW = 1_792_800_000;
const TARGET_URL = 'https://seller.example/mcp';
const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_products","arguments":{}}}';
const keyPair = generateKeyPairSync('ed25519');
const publicJwk = {
  ...keyPair.publicKey.export({ format: 'jwk' }),
  kid: 'nonce-replay-regression',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['verify'],
  adcp_use: 'request-signing',
};
const key = {
  keyid: publicJwk.kid,
  alg: 'ed25519',
  privateKey: { ...publicJwk, ...keyPair.privateKey.export({ format: 'jwk' }), key_ops: ['sign'] },
};
const nonce = Buffer.alloc(16, 127).toString('base64url');
const profiles = [
  { name: 'request 3.0', adcpVersion: '3.0', sign: signRequest, verify: verifyRequestSignature },
  { name: 'request 3.1', adcpVersion: '3.1', sign: signRequest, verify: verifyRequestSignature },
  {
    name: 'request 3.2',
    adcpVersion: '3.2.6',
    binaryEncoding: 'rfc8941-base64',
    sign: signRequest,
    verify: verifyRequestSignature,
  },
  { name: 'webhook v1', webhook: true, sign: signWebhook, verify: verifyWebhookSignature },
];

function signed(profile, { body = BODY, nonce: suppliedNonce = nonce } = {}) {
  const request = { method: 'POST', url: TARGET_URL, headers: { 'Content-Type': 'application/json' }, body };
  const result = profile.sign(request, key, {
    now: () => NOW,
    nonce: suppliedNonce,
    coverContentDigest: true,
    binaryEncoding: profile.binaryEncoding,
  });
  return { ...request, headers: result.headers };
}

function verifier(profile, extra = {}) {
  const replayStore = new InMemoryReplayStore();
  const jwks = new StaticJwksResolver([publicJwk]);
  const resolve = mock.fn(jwks.resolve.bind(jwks));
  const insert = mock.fn(replayStore.insert.bind(replayStore));
  jwks.resolve = resolve;
  replayStore.insert = insert;
  const options = {
    jwks,
    replayStore,
    revocationStore: new InMemoryRevocationStore(),
    capability: { supported: true, covers_content_digest: 'required', required_for: [] },
    now: () => NOW,
    adcpVersion: profile.adcpVersion,
    ...extra,
  };
  return { run: request => profile.verify(request, options), replayStore, resolve, insert };
}

function errorCode(profile, suffix) {
  return `${profile.webhook ? 'webhook' : 'request'}_${suffix}`;
}

for (const profile of profiles) {
  describe(`${profile.name}: nonce and replay ordering (#3242)`, () => {
    for (const invalid of [
      '',
      'AAAA',
      Buffer.alloc(15).toString('base64url'),
      `${nonce}==`,
      'not a nonce!',
      `${nonce} `,
      'a'.repeat(25),
      `${'a'.repeat(21)}+`,
      `${'a'.repeat(21)}/`,
    ]) {
      it(`rejects nonce ${JSON.stringify(invalid)} before key resolution or replay insertion`, async () => {
        const v = verifier(profile);
        await assert.rejects(v.run(signed(profile, { nonce: invalid })), {
          code: errorCode(profile, 'signature_params_incomplete'),
          failedStep: 2,
        });
        assert.equal(v.resolve.mock.callCount(), 0);
        assert.equal(v.insert.mock.callCount(), 0);
      });
    }

    for (const bytes of [16, 17, 18, 32]) {
      it(`accepts an unpadded ${bytes}-byte nonce and detects replay`, async () => {
        const request = signed(profile, { nonce: Buffer.alloc(bytes, 255).toString('base64url') });
        const v = verifier(profile);
        assert.equal((await v.run(request)).status, 'verified');
        await assert.rejects(v.run(request), { code: errorCode(profile, 'signature_replayed') });
        assert.equal(v.insert.mock.callCount(), 1);
      });
    }

    for (const body of [
      '{"idempotency_key":"a","idempotency_key":"b"}',
      '{"nested":[{"key":"a","\\u006bey":"b"}]}',
      '{"unfinished":',
      '\ufeff{}',
      ...(profile.webhook
        ? [Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]), Buffer.from('\ufeff{}')]
        : []),
    ]) {
      it(`burns a validly signed malformed frame before rejecting it: ${body}`, async t => {
        const request = signed(profile, { body });
        const v = verifier(profile);
        const originalVerify = crypto.verify;
        const verifySpy = t.mock.method(crypto, 'verify', (...args) => originalVerify(...args));
        await assert.rejects(v.run(request), { code: errorCode(profile, 'body_malformed'), failedStep: 14 });
        assert.equal(v.insert.mock.callCount(), 1);
        const firstVerifyCalls = verifySpy.mock.callCount();
        assert.ok(firstVerifyCalls > 0, 'the first frame must authenticate before consuming replay capacity');
        for (let i = 0; i < 3; i++) {
          await assert.rejects(v.run(request), { code: errorCode(profile, 'signature_replayed') });
        }
        assert.equal(verifySpy.mock.callCount(), firstVerifyCalls, 'replayed malformed frames must not repeat crypto');
        assert.equal(v.insert.mock.callCount(), 1);
        // No body bytes or attacker-controlled duplicate key names in public errors.
        const other = verifier(profile);
        await assert.rejects(other.run(request), err => {
          assert.deepEqual(err.details, {
            reason:
              String(body).includes('idempotency_key') || String(body).includes('nested')
                ? 'duplicate_key'
                : 'invalid_json',
          });
          assert.equal(err.cause, undefined);
          assert.equal(err.message.includes('idempotency_key'), false);
          return true;
        });
      });
    }

    for (const body of ['', '  \t\r\n']) {
      it('preserves acceptance of an empty or JSON-whitespace body', async () => {
        assert.equal((await verifier(profile).run(signed(profile, { body }))).status, 'verified');
      });
    }

    it('checks only the selected signature label nonce', async () => {
      const request = signed(profile);
      request.headers['Signature-Input'] += ', proxy=("@method");nonce="bad"';
      request.headers.Signature += ', proxy=:AA==:';
      assert.equal((await verifier(profile).run(request)).status, 'verified');
    });

    it('does not burn a nonce when the signed bytes fail digest verification', async () => {
      const request = signed(profile);
      const v = verifier(profile);
      await assert.rejects(v.run({ ...request, body: `${BODY} ` }), {
        code: errorCode(profile, 'signature_digest_mismatch'),
      });
      assert.equal(v.insert.mock.callCount(), 0);
      assert.equal((await v.run(request)).status, 'verified');
    });

    it('does not burn a nonce for an invalid signature', async () => {
      const request = signed(profile);
      const signature = request.headers.Signature.replace(
        /:([A-Za-z0-9+/_-])/,
        (_, ch) => `:${ch === 'A' ? 'B' : 'A'}`
      );
      const v = verifier(profile);
      await assert.rejects(v.run({ ...request, headers: { ...request.headers, Signature: signature } }), {
        code: errorCode(profile, 'signature_invalid'),
      });
      assert.equal(v.insert.mock.callCount(), 0);
      assert.equal((await v.run(request)).status, 'verified');
    });
  });
}

it('preserves the operation resolver precheck before signature verification and replay insertion', async () => {
  const profile = profiles[2];
  const request = signed(profile, { body: '{"params":{"name":"get_products","name":"create_media_buy"}}' });
  const v = verifier(profile, {
    operation: resolveRequestOperation({ rawBody: request.body, method: request.method, url: request.url }),
  });
  await assert.rejects(v.run(request), { code: 'request_body_malformed', failedStep: 0 });
  assert.equal(v.resolve.mock.callCount(), 0);
  assert.equal(v.insert.mock.callCount(), 0);
});
