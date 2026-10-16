// Web Bot Auth interoperability with Cloudflare's reference packages
// (web-bot-auth@0.2.0, http-message-sig@0.3.0), both directions, plus the
// shared JSON fixtures in test/fixtures/wba-interop/ for the Go and Python
// SDKs. Regenerate with: UPDATE_WBA_INTEROP_FIXTURES=1 node --test test/lib/wba-interop.test.js
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wba = require('../../dist/lib/signing/web-bot-auth');
const { parseSignatureInput } = require('../../dist/lib/signing/parser');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');
const { computeContentDigest } = require('../../dist/lib/signing/content-digest');
const cloudflare = require('web-bot-auth');
const cloudflareCrypto = require('web-bot-auth/crypto');
const httpMessageSig = require('http-message-sig');

const FIXTURES = path.join(__dirname, '../fixtures/wba-interop');
const KEYS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8')).keys;
const NOW = 1790841610;
const ORIGIN = 'https://buyer.agency.com';
const DIRECTORY_URL = ORIGIN + wba.SIGNATURE_DIRECTORY_PATH;
const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_products","arguments":{}}}';
const TARGETS = {
  'body-request': 'https://seller.example.com/mcp',
  'percent-encoded-path': 'https://seller.example.com/a%7Eb/mcp/',
};
// Fixed nonces keep Ed25519 fixtures byte-stable (64 bytes, draft §4.2).
const NONCE_OURS = Buffer.alloc(64, 7).toString('base64url');
const NONCE_THEIRS = Buffer.alloc(64, 9).toString('base64');

function privateJwk(entry) {
  const { _private_jwk_for_test_only: secret, ...publicPart } = entry;
  return { ...publicPart, ...secret };
}
function publicJwk(entry) {
  const { _private_jwk_for_test_only: _secret, ...publicPart } = entry;
  return publicPart;
}
const ED25519 = KEYS.find(key => key.kty === 'OKP');
const RSA = KEYS.find(key => key.kty === 'RSA');

async function ourDirectory(entries) {
  const response = await wba.createSignedSignatureDirectory(
    ORIGIN,
    entries.map(entry => ({ privateKey: privateJwk(entry) })),
    { now: () => NOW }
  );
  return { url: response.request.url, status: response.status, headers: response.headers, body: response.body };
}
async function theirDirectory(entry) {
  const body = JSON.stringify({ keys: [publicJwk(entry)] });
  const fields = [
    { name: 'content-type', value: wba.SIGNATURE_DIRECTORY_MEDIA_TYPE },
    { name: 'content-digest', value: computeContentDigest(body, 'rfc8941-base64') },
  ];
  const signature = await httpMessageSig.createSignature(
    {
      kind: 'response',
      status: 200,
      fields,
      request: { kind: 'request', method: 'GET', targetUri: DIRECTORY_URL, fields: [] },
    },
    {
      label: 'key1',
      components: [httpMessageSig.component('@authority', { req: true }), 'content-digest'],
      parameters: {
        created: NOW - 60,
        expires: NOW + 86_400,
        keyid: entry.kid,
        alg: 'ed25519',
        tag: 'http-message-signatures-directory',
      },
      signer: await cloudflareCrypto.signerFromJWK(privateJwk(entry)),
    }
  );
  return {
    url: DIRECTORY_URL,
    status: 200,
    headers: {
      ...Object.fromEntries(fields.map(field => [field.name, field.value])),
      'signature-input': signature.signatureInput,
      signature: signature.signature,
    },
    body,
  };
}
async function ourRequest(entry, url) {
  const request = { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: BODY };
  const headers = await wba.signWebBotAuth(
    request,
    { privateKey: privateJwk(entry) },
    { origin: ORIGIN, now: () => NOW, nonce: NONCE_OURS }
  );
  return { ...request, headers };
}
async function theirRequest(entry, url) {
  const headers = {
    'content-type': 'application/json',
    'content-digest': computeContentDigest(BODY, 'rfc8941-base64'),
    'signature-agent': `sig1="${ORIGIN}"`,
  };
  const signature = await cloudflare.sign(
    {
      kind: 'request',
      method: 'POST',
      targetUri: url,
      fields: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
    {
      signer: await cloudflareCrypto.signerFromJWK(privateJwk(entry)),
      created: new Date(NOW * 1000),
      expires: new Date((NOW + 300) * 1000),
      nonce: NONCE_THEIRS,
      additionalComponents: ['@method', '@target-uri', 'content-type', 'content-digest'],
    }
  );
  return {
    method: 'POST',
    url,
    headers: { ...headers, 'signature-input': signature.signatureInput, signature: signature.signature },
    body: BODY,
  };
}

async function buildFixtures() {
  const fixtures = {};
  for (const [name, url] of Object.entries(TARGETS)) {
    fixtures[`adcp-client-signed-${name}`] = {
      signer: 'adcp-client',
      request: await ourRequest(ED25519, url),
      directory: await ourDirectory([ED25519]),
    };
    fixtures[`cloudflare-signed-${name}`] = {
      signer: 'cloudflare/web-bot-auth@0.2.0',
      request: await theirRequest(ED25519, url),
      directory: await theirDirectory(ED25519),
    };
  }
  for (const fixture of Object.values(fixtures)) {
    const input = parseSignatureInput(fixture.request.headers['signature-input'], 'sig1');
    fixture.reference_now = NOW;
    fixture.expected = {
      verifies: true,
      identity: ORIGIN,
      keyid: ED25519.kid,
      signature_base: wba.buildWebBotAuthSignatureBase(input, fixture.request),
    };
  }
  return fixtures;
}

function directoryResolver(directory) {
  return new wba.SignatureDirectoryResolver({
    now: () => NOW,
    fetchOptions: {
      trustedFetchFn: async url => {
        assert.equal(url, directory.url);
        return new Response(directory.body, { status: directory.status, headers: directory.headers });
      },
    },
  });
}
async function oursVerify(fixture) {
  return wba.verifyWebBotAuth(fixture.request, {
    directory: directoryResolver(fixture.directory),
    replayStore: new InMemoryReplayStore(),
    now: () => NOW,
  });
}
async function theirsVerify(request, entry) {
  return cloudflare.verify(
    {
      kind: 'request',
      method: request.method,
      targetUri: request.url,
      fields: Object.entries(request.headers).map(([name, value]) => ({ name, value })),
    },
    {
      resolver: async candidate => {
        assert.equal(candidate.keyid, entry.kid);
        return cloudflareCrypto.verifierFromJWK(publicJwk(entry));
      },
      now: new Date(NOW * 1000),
    }
  );
}

test('interop fixtures are current and byte-stable', async () => {
  const fixtures = await buildFixtures();
  for (const [name, fixture] of Object.entries(fixtures)) {
    const file = path.join(FIXTURES, `${name}.json`);
    const serialized = JSON.stringify(fixture, null, 2) + '\n';
    if (process.env.UPDATE_WBA_INTEROP_FIXTURES === '1') fs.writeFileSync(file, serialized);
    assert.equal(fs.readFileSync(file, 'utf8'), serialized, `${name}.json is stale; regenerate the fixtures`);
  }
});

for (const name of Object.keys(TARGETS)) {
  test(`adcp-client signs, Cloudflare verifies: ${name}`, async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `adcp-client-signed-${name}.json`), 'utf8'));
    const verified = await theirsVerify(fixture.request, ED25519);
    assert.equal(verified.keyid, ED25519.kid);
    assert.equal(verified.signatureAgent.uri, ORIGIN);
    // Our own verifier agrees.
    assert.equal((await oursVerify(fixture))[0].origin, ORIGIN);
  });
  test(`Cloudflare signs, adcp-client verifies: ${name}`, async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, `cloudflare-signed-${name}.json`), 'utf8'));
    const [signer] = await oursVerify(fixture);
    assert.equal(signer.origin, ORIGIN);
    assert.equal(signer.keyid, ED25519.kid);
    assert.equal(
      wba.buildWebBotAuthSignatureBase(
        parseSignatureInput(fixture.request.headers['signature-input'], 'sig1'),
        fixture.request
      ),
      fixture.expected.signature_base
    );
  });
}

test('percent-encoded target URIs are signed and verified as received', async () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'cloudflare-signed-percent-encoded-path.json'), 'utf8')
  );
  assert.match(fixture.expected.signature_base, /"@target-uri": https:\/\/seller\.example\.com\/a%7Eb\/mcp\//);
  // Decoding %7E would change the base and break the signature.
  await assert.rejects(
    oursVerify({ ...fixture, request: { ...fixture.request, url: 'https://seller.example.com/a~b/mcp/' } }),
    e => e.reason === 'signature_invalid'
  );
});

test('directories: Cloudflare verifies ours and we verify theirs', async () => {
  const ours = await ourDirectory([ED25519]);
  const verified = await httpMessageSig.verifySignature(
    {
      kind: 'response',
      status: ours.status,
      fields: Object.entries(ours.headers).map(([name, value]) => ({ name, value })),
      request: { kind: 'request', method: 'GET', targetUri: ours.url, fields: [] },
    },
    {
      label: 'key1',
      policy: {
        algorithms: ['ed25519'],
        requiredComponents: [],
        requiredParameters: ['created', 'expires', 'keyid', 'tag'],
        maxAge: 2 * 86_400,
        clockSkew: 0,
        now: NOW,
      },
      resolveVerifier: async () => cloudflareCrypto.verifierFromJWK(publicJwk(ED25519)),
    }
  );
  assert.ok(verified);
  const theirs = await theirDirectory(ED25519);
  const checked = await wba.verifyKeyDirectory({ ...theirs, request: { method: 'GET', url: theirs.url } }, NOW);
  assert.equal(checked.signed, true);
  assert.deepEqual(
    checked.keys.map(key => key.kid),
    [ED25519.kid]
  );
});

test('RSA-PSS-SHA512 keys interoperate in both directions', async () => {
  const url = TARGETS['body-request'];
  const ours = await ourRequest(RSA, url);
  assert.match(ours.headers['signature-input'], /alg="rsa-pss-sha512"/);
  assert.equal((await theirsVerify(ours, RSA)).keyid, RSA.kid);
  const theirs = await theirRequest(RSA, url);
  const [signer] = await oursVerify({ request: theirs, directory: await ourDirectory([RSA]) });
  assert.equal(signer.keyid, RSA.kid);
});

test('default nonces are 64 bytes and accepted by Cloudflare', async () => {
  const request = { method: 'GET', url: TARGETS['body-request'], headers: {} };
  const headers = await wba.signWebBotAuth(
    request,
    { privateKey: privateJwk(ED25519) },
    { origin: ORIGIN, now: () => NOW }
  );
  const nonce = parseSignatureInput(headers['signature-input'], 'sig1').params.nonce;
  assert.equal(Buffer.from(nonce, 'base64url').length, 64);
  assert.ok(cloudflare.validateNonce(nonce));
  assert.equal((await theirsVerify({ ...request, headers }, ED25519)).keyid, ED25519.kid);
});

test('jwkThumbprint matches jose calculateJwkThumbprint for OKP, EC and RSA keys', async () => {
  const { calculateJwkThumbprint } = await import('jose');
  const { generateKeyPairSync } = require('crypto');
  for (const jwk of [
    publicJwk(ED25519),
    publicJwk(RSA),
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }),
  ])
    assert.equal(wba.jwkThumbprint(jwk), await calculateJwkThumbprint(jwk, 'sha256'));
});
