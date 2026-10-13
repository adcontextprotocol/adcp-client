/**
 * Experimental AdCP 3.3 Web Bot Auth draft vectors (adcp#7894 @ 656bd080),
 * vendored byte-for-byte in test/fixtures/wba-profile-vectors.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, sign } = require('node:crypto');
const {
  InMemoryReplayStore,
  StaticWebBotAuthKeys,
  verifyKeyDirectoryResponse,
  verifyWebBotAuthRequest,
  WebBotAuthError,
  WebBotAuthAuthorizationError,
} = require('../dist/lib/signing/server.js');
const { signWebBotAuthRequest } = require('../dist/lib/signing/client.js');
const { wbaSignatureBase, parseStrictDictionary } = require('../dist/lib/signing/wba/structured.js');

const ROOT = path.join(__dirname, 'fixtures', 'wba-profile-vectors');
const KEYS = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8')).keys;
const KEY_BY_KID = new Map(KEYS.map(key => [key.kid, key]));
const load = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const vectors = dir =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => [`${dir}/${name}`, load(`${dir}/${name}`)]);

function harness(vector) {
  const directories = {};
  for (const [origin, entry] of Object.entries(vector.directories ?? {})) {
    directories[origin] = entry.keys_ref.map(kid => KEY_BY_KID.get(kid));
  }
  const replayStore = new InMemoryReplayStore();
  for (const entry of vector.test_harness_state?.replay_cache_entries ?? []) {
    replayStore.preload(entry.identity, 'web-bot-auth', entry.nonce, entry.ttl_seconds, vector.reference_now);
  }
  return () =>
    verifyWebBotAuthRequest(vector.request, {
      keys: new StaticWebBotAuthKeys(directories),
      replayStore,
      revocation: async () => false,
      now: () => vector.reference_now,
    });
}

function privateKeyFor(key) {
  return createPrivateKey({
    key: { kty: key.kty, crv: key.crv, x: key.x, d: key._private_d_for_test_only },
    format: 'jwk',
  });
}

describe('WBA draft vectors', () => {
  for (const [name, vector] of vectors('positive')) {
    it(`${name} verifies`, async () => {
      if (vector.response) {
        const keys = verifyKeyDirectoryResponse(vector.request.url, vector.response, { now: vector.reference_now });
        assert.deepEqual(
          [...keys.keys()],
          Object.keys(vector.expected_outcome.identities).map(() => KEYS[0].kid)
        );
        return;
      }
      const signers = await harness(vector)();
      assert.deepEqual(
        Object.fromEntries(signers.map(signer => [signer.label, signer.origin])),
        vector.expected_outcome.identities
      );
      for (const signer of signers) {
        assert.equal(signer.profile, 'web-bot-auth');
        assert.equal(signer.verified_at, vector.reference_now);
        assert.equal(signer.body_authenticated, true);
      }
    });
  }

  for (const [name, vector] of vectors('negative')) {
    it(`${name} answers ${vector.expected_outcome.status}`, async () => {
      await assert.rejects(harness(vector), error => {
        assert.ok(error instanceof WebBotAuthError, `unexpected ${error}`);
        assert.ok(!(error instanceof WebBotAuthAuthorizationError));
        assert.equal(error.status, vector.expected_outcome.status);
        if (error.status === 403) {
          const accept = error.headers['Accept-Signature'];
          assert.ok(accept, 'a 403 carries Accept-Signature');
          const expected = vector.expected_outcome.accept_signature;
          assert.ok(accept.includes(`${expected.label}=${expected.components};`), accept);
          for (const parameter of expected.parameters) assert.match(accept, new RegExp(`;${parameter}(=|;|$)`));
          assert.match(accept, /tag="web-bot-auth"/);
          if (expected.nonce === 'verifier-chosen') assert.match(accept, /;nonce="[A-Za-z0-9_-]{43}"/);
        } else {
          assert.deepEqual(error.headers, {});
        }
        // The wire body is the generic authentication error, never the reason.
        assert.equal(JSON.stringify(error.responseBody()).includes(error.reason), false);
        return true;
      });
    });
  }

  it('computes the expected signature base for every parseable vector', () => {
    for (const [name, vector] of [...vectors('positive'), ...vectors('negative')]) {
      if (!vector.expected_signature_base) continue;
      const message = vector.response
        ? { method: 'GET', url: vector.request.url, headers: vector.response.headers }
        : vector.request;
      const inputs = parseStrictDictionary(
        (vector.response ?? vector.request).headers['Signature-Input'],
        'Signature-Input'
      );
      for (const [label, base] of Object.entries(vector.expected_signature_base)) {
        assert.equal(
          wbaSignatureBase(message, inputs.get(label), { directoryResponse: Boolean(vector.response) }),
          base,
          `${name} ${label}`
        );
      }
    }
  });

  it('reproduces the independent request vector byte for byte (Ed25519 is deterministic)', () => {
    const vector = load('positive/001-single-signer-request.json');
    const key = KEYS.find(k => k.identity === 'https://buyer-7k3q.com');
    const signed = signWebBotAuthRequest(
      {
        method: 'POST',
        url: vector.request.url,
        headers: { 'Content-Type': 'application/json' },
        body: vector.request.body,
      },
      { privateKey: privateKeyFor(key), keyid: key.kid },
      {
        agentOrigin: key.identity,
        created: 1790841600,
        nonce: 'Mn-ZM8SnGESx0-rmyYMuTkJFerfbwEii2C0qNkDP8ugpcuv0pcrt6Da2ifr-6MTmfVeZhnFymLeAofeXJbFaxA',
      }
    );
    for (const [name, value] of Object.entries(vector.request.headers)) assert.equal(signed.headers[name], value, name);
    assert.equal(signed.signatureBase, vector.expected_signature_base.sig1);
  });

  it('reproduces the signed directory response signature from its base', () => {
    const vector = load('positive/003-signed-directory-response.json');
    const key = KEY_BY_KID.get('6WsKMCObba49V3uN0vIENnk1BKAk7c9zjBJcWKyQ9_I');
    const signature = sign(null, Buffer.from(vector.expected_signature_base.key1, 'utf8'), privateKeyFor(key));
    assert.equal(vector.response.headers.Signature, `key1=:${signature.toString('base64')}:`);
  });
});
