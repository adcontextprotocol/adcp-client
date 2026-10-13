// Regression tests for Web Bot Auth verifier/signer follow-ups to #3244 (refs #3233).
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign: nodeSign, createPrivateKey } = require('crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const wba = require('../../dist/lib/signing/web-bot-auth');
const { parseSignatureInput } = require('../../dist/lib/signing/parser');
const { computeContentDigest } = require('../../dist/lib/signing/content-digest');
const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  signRequest,
  verifyRequestSignature,
} = require('../../dist/lib/signing/index.js');

const T = 1790841610;
const origin = 'https://buyer.example.com';

function newKey() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  jwk.kid = wba.jwkThumbprint(jwk);
  return jwk;
}
function serving(proof, extra = {}) {
  return async () => new Response(proof.body, { status: 200, headers: { ...proof.headers, ...extra } });
}
function directoryFor(proof, clock) {
  return new wba.SignatureDirectoryResolver({ now: clock, fetchOptions: { trustedFetchFn: serving(proof) } });
}
const request = {
  method: 'POST',
  url: 'https://seller.example.com/mcp',
  headers: { 'content-type': 'application/json' },
  body: '{"a":1}',
};

test('D3: a WBA nonce cannot be replayed at exactly expires + 60', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T, windowSeconds: 300 });
  let clock = T;
  const options = {
    directory: directoryFor(proof, () => clock),
    replayStore: new InMemoryReplayStore(),
    isRevoked: async () => false,
    now: () => clock,
  };
  await wba.verifyWebBotAuth({ ...request, headers }, options);
  clock = T + 300 + 60; // last instant the window check accepts
  await assert.rejects(wba.verifyWebBotAuth({ ...request, headers }, options), e => e.status === 429);
});

test('D3: an RFC 9421 nonce first seen at created cannot be replayed at expires + skew', async () => {
  const keys = JSON.parse(
    readFileSync(path.join(__dirname, '../../compliance/cache/latest/test-vectors/request-signing/keys.json'), 'utf8')
  ).keys;
  const ed = keys.find(k => k.kid === 'test-ed25519-2026');
  const privateJwk = { ...ed, d: ed._private_d_for_test_only };
  for (const field of ['_private_d_for_test_only', 'key_ops', 'use']) delete privateJwk[field];
  const publicJwk = { ...ed };
  delete publicJwk._private_d_for_test_only;
  const url = 'https://seller.example.com/adcp/create_media_buy';
  const body = '{"plan_id":"plan_001"}';
  const created = 1_776_520_800;
  const signed = signRequest(
    { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
    { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
    { now: () => created, windowSeconds: 300, nonce: 'boundary-replay-probe' }
  );
  const replayStore = new InMemoryReplayStore();
  const verify = at =>
    verifyRequestSignature(
      { method: 'POST', url, headers: signed.headers, body },
      {
        adcpVersion: '3.1',
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore,
        revocationStore: new InMemoryRevocationStore(),
        now: () => at,
        operation: 'create_media_buy',
      }
    );
  assert.equal((await verify(created)).status, 'verified');
  await assert.rejects(verify(created + 300 + 60), e => e.code === 'request_signature_replayed');
});

test('D4: directory digests cover the exact bytes, including a UTF-8 BOM', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  // BOM bytes on the wire with a digest over the BOM-less body: the digest does not cover what was served.
  const mismatched = new wba.SignatureDirectoryResolver({
    now: () => T,
    fetchOptions: {
      trustedFetchFn: async () =>
        new Response(Buffer.concat([bom, Buffer.from(proof.body)]), { status: 200, headers: proof.headers }),
    },
  });
  await assert.rejects(mismatched.resolve(key.kid, origin), e => e.reason === 'content_digest');
});

test('D4: the WBA signing fetch signs and sends the caller bytes unchanged', async () => {
  const key = newKey();
  let sent;
  const signingFetch = wba.createWebBotAuthFetch(
    async (_url, init) => {
      sent = init;
      return new Response('');
    },
    { privateKey: key },
    { origin, now: () => T }
  );
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}')]);
  await signingFetch('https://seller.example.com/mcp', {
    method: 'POST',
    body: bytes,
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(Buffer.from(sent.body, 'utf8'), Buffer.from(bytes));
  assert.equal(sent.headers['content-digest'], computeContentDigest(sent.body, 'rfc8941-base64'));
});

test('D5: directory proofs are backdated and tolerate a verifier clock slightly behind', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const input = parseSignatureInput(proof.headers['signature-input'], 'key1');
  assert.ok(input.params.created < T, 'created is backdated');
  assert.equal(input.params.expires, T + 86_400);
  assert.equal(wba.verifySignatureDirectory(proof, T - 30).keys[0].kid, key.kid);
});

test('D6: a web-bot-auth tagged request without Signature-Agent is a 403 verification failure', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  delete headers['signature-agent'];
  await assert.rejects(
    wba.verifyWebBotAuth(
      { ...request, headers },
      {
        directory: directoryFor(proof, () => T),
        replayStore: new InMemoryReplayStore(),
        isRevoked: async () => false,
        now: () => T,
      }
    ),
    e => e.status === 403 && !!e.headers['Accept-Signature']
  );
  // A present but unparseable field remains malformed (400).
  await assert.rejects(
    wba.verifyWebBotAuth(
      { ...request, headers: { ...headers, 'signature-agent': 'sig1=(' } },
      {
        directory: directoryFor(proof, () => T),
        replayStore: new InMemoryReplayStore(),
        isRevoked: async () => false,
        now: () => T,
      }
    ),
    e => e.status === 400
  );
});

test("D7: signing never silently drops another party's signature fields", async () => {
  const key = newKey();
  const foreign = {
    ...request,
    headers: {
      ...request.headers,
      'signature-input': 'other=("@method");created=1;keyid="x";tag="adcp/request-signing/v1"',
      signature: 'other=:AAAA:',
    },
  };
  await assert.rejects(
    wba.signWebBotAuth(foreign, { privateKey: key }, { origin, now: () => T }),
    /already carries signature fields/
  );
  // Relays still append a covering signature and keep the earlier fields.
  const inner = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  const relayKey = newKey();
  const relayed = await wba.signWebBotAuth(
    { ...request, headers: inner },
    { privateKey: relayKey },
    {
      origin: 'https://relay.example.com',
      label: 'sig2',
      relay: true,
      now: () => T,
    }
  );
  assert.ok(relayed['signature-input'].startsWith(inner['signature-input']));
  assert.ok(relayed.signature.startsWith(inner.signature));
});

test('D1: a synchronously throwing fetcher cannot poison the directory resolver', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  let clock = T,
    broken = true;
  const resolver = new wba.SignatureDirectoryResolver({
    now: () => clock,
    fetchOptions: {
      trustedFetchFn: (...args) => {
        if (broken) throw new Error('synchronous failure');
        return serving(proof)(...args);
      },
    },
  });
  await assert.rejects(resolver.resolve(key.kid, origin));
  broken = false;
  clock = T + 61; // past the 60 s negative cache
  assert.equal((await resolver.resolve(key.kid, origin)).kid, key.kid);
});

test('D2: directory proofs must cover the exact "content-digest" component', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  // Cover only the sha-512 member of Content-Digest; the body check reads sha-256.
  const headers = {
    ...proof.headers,
    'content-digest': `${proof.headers['content-digest']}, sha-512=:${Buffer.alloc(64).toString('base64')}:`,
  };
  const signedWith = components => {
    const value = `key1=(${components});created=${T - 60};expires=${T + 3600};keyid="${key.kid}";alg="ed25519";tag="http-message-signatures-directory"`;
    const response = { ...proof, headers: { ...headers, 'signature-input': value } };
    const base = wba.buildWebBotAuthSignatureBase(
      parseSignatureInput(value, 'key1'),
      { method: 'GET', url: proof.request.url, headers: {} },
      response
    );
    const signature = nodeSign(null, Buffer.from(base), createPrivateKey({ key, format: 'jwk' }));
    response.headers.signature = `key1=:${signature.toString('base64')}:`;
    return response;
  };
  // Control: the same construction with exact coverage verifies.
  assert.equal(wba.verifySignatureDirectory(signedWith('"@authority";req "content-digest"'), T).keys[0].kid, key.kid);
  assert.throws(
    () => wba.verifySignatureDirectory(signedWith('"@authority";req "content-digest";key="sha-512"'), T),
    e => e.reason === 'directory_proof'
  );
});
