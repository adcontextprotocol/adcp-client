// Web Bot Auth profile rules from adcontextprotocol/adcp#7894 at e24eeb09
// (docs/building/by-layer/L1/wba-profile.mdx) that the vendored vectors do
// not isolate: one signature per request, the 64-byte nonce, the algorithm
// set, the replay challenge, signed directories, and unsigned requests to
// `required_for` operations.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync, createPrivateKey, sign: nodeSign } = require('crypto');
const httpMessageSig = require('http-message-sig');
const wba = require('../../dist/lib/signing/web-bot-auth');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation');
const { computeContentDigest } = require('../../dist/lib/signing/content-digest');
const { RequestSignatureError } = require('../../dist/lib/signing/errors');
const {
  requireSignatureWhenPresent,
  verifySignatureAsAuthenticator,
  respondUnauthorized,
  ADCP_PRE_TRANSPORT,
  ADCP_SERVE_REQUEST_CONTEXT,
} = require('../../dist/lib/server');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { createSignedOriginRevocationList } = require('../../dist/lib/identity-3.3');

const T = 1790841610;
const ORIGIN = 'https://buyer.agency.com';
const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_products","arguments":{}}}';
const REQUEST = {
  method: 'POST',
  url: 'https://seller.example.com/mcp',
  headers: { 'content-type': 'application/json' },
  body: BODY,
};

function newKey() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  jwk.kid = wba.jwkThumbprint(jwk);
  return jwk;
}
async function verifierOptions(keys, { origin = ORIGIN, replayStore = new InMemoryReplayStore() } = {}) {
  const proof = await wba.createSignedSignatureDirectory(
    origin,
    keys.map(privateKey => ({ privateKey })),
    { now: () => T }
  );
  return {
    directory: new wba.SignatureDirectoryResolver({
      now: () => T,
      fetchOptions: {
        trustedFetchFn: async url =>
          new URL(url).origin === origin
            ? new Response(proof.body, { status: 200, headers: proof.headers })
            : new Response('', { status: 404 }),
      },
    }),
    replayStore,
    now: () => T,
  };
}
/**
 * Sign with http-message-sig directly, so a test can produce what
 * signWebBotAuth refuses to: other parameters, labels or Signature-Agent members.
 */
async function rawSign(key, { parameters = {}, label = 'sig1', agent = `sig1="${ORIGIN}"` } = {}) {
  const headers = {
    'content-type': 'application/json',
    'content-digest': computeContentDigest(BODY, 'rfc8941-base64'),
    'signature-agent': agent,
  };
  const signed = await httpMessageSig.createSignature(
    {
      kind: 'request',
      method: 'POST',
      targetUri: REQUEST.url,
      fields: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
    {
      label,
      components: [
        '@method',
        '@target-uri',
        '@authority',
        'content-type',
        'content-digest',
        httpMessageSig.component('signature-agent', { key: label }),
      ],
      parameters: {
        created: T,
        expires: T + 300,
        nonce: Buffer.alloc(64, 3).toString('base64url'),
        keyid: key.kid,
        alg: 'ed25519',
        tag: 'web-bot-auth',
        ...parameters,
      },
      signer: {
        // Claim any algorithm; the bytes are always Ed25519.
        algorithm: 'alg' in parameters && parameters.alg !== undefined ? parameters.alg : 'ed25519',
        sign: data => nodeSign(null, Buffer.from(data), createPrivateKey({ key, format: 'jwk' })),
      },
    }
  );
  return { ...REQUEST, headers: { ...headers, 'signature-input': signed.signatureInput, signature: signed.signature } };
}
const rejectedWith = (status, reason) => e =>
  e instanceof wba.WebBotAuthError && e.status === status && (reason === undefined || e.reason === reason);

test('control: a hand-signed request with the profile parameters verifies', async () => {
  const key = newKey();
  const [signer] = await wba.verifyWebBotAuth(await rawSign(key), await verifierOptions([key]));
  assert.equal(signer.origin, ORIGIN);
});

test('nonce: 64 bytes, unpadded Base64URL or canonical Base64; anything shorter or non-canonical is a 403', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  const accepted = [Buffer.alloc(64, 1).toString('base64url'), Buffer.alloc(64, 2).toString('base64')];
  for (const nonce of accepted)
    assert.equal((await wba.verifyWebBotAuth(await rawSign(key, { parameters: { nonce } }), options)).length, 1);
  const rejected = [
    Buffer.alloc(16, 4).toString('base64url'), // the former 16-byte floor
    Buffer.alloc(63, 5).toString('base64url'),
    Buffer.alloc(65, 6).toString('base64url'),
    Buffer.alloc(64, 0xfb).toString('base64url') + '==', // padded Base64URL
    Buffer.alloc(64, 0xfb).toString('base64').slice(0, -2), // unpadded Base64 with '+' and '/'
    'A'.repeat(85) + 'B', // non-canonical trailing bits
  ];
  for (const nonce of rejected)
    await assert.rejects(
      wba.verifyWebBotAuth(await rawSign(key, { parameters: { nonce } }), options),
      e => rejectedWith(403, 'parameters')(e) && /;nonce;/.test(e.headers['Accept-Signature']),
      nonce
    );
  // The signer refuses a short nonce too.
  await assert.rejects(
    wba.signWebBotAuth(REQUEST, { privateKey: key }, { origin: ORIGIN, nonce: 'a'.repeat(22) }),
    TypeError
  );
});

test('parameters: alg is required and must be ed25519 or rsa-pss-sha512', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  await assert.rejects(
    wba.verifyWebBotAuth(await rawSign(key, { parameters: { alg: undefined } }), options),
    rejectedWith(403, 'parameters_missing')
  );
  await assert.rejects(
    wba.verifyWebBotAuth(await rawSign(key, { parameters: { alg: 'ecdsa-p256-sha256' } }), options),
    rejectedWith(403, 'parameters')
  );
  // A wrongly typed parameter parses, so it is a profile failure (403), not 400.
  const signed = await rawSign(key);
  const typo = signed.headers['signature-input'].replace(`created=${T}`, 'created="yesterday"');
  await assert.rejects(
    wba.verifyWebBotAuth({ ...signed, headers: { ...signed.headers, 'signature-input': typo } }, options),
    rejectedWith(403, 'parameters')
  );
});

test('one signature: a second label of any profile, or a second Signature-Agent member, is a 403', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  const signed = await rawSign(key);
  const other = await rawSign(key, { label: 'other', agent: `other="${ORIGIN}"` });
  await assert.rejects(
    wba.verifyWebBotAuth(
      {
        ...signed,
        headers: {
          ...signed.headers,
          'signature-input': `${signed.headers['signature-input']}, ${other.headers['signature-input'].replace('web-bot-auth', 'adcp/request-signing/v1')}`,
          signature: `${signed.headers.signature}, ${other.headers.signature}`,
        },
      },
      options
    ),
    rejectedWith(403, 'signature_count')
  );
  await assert.rejects(
    wba.verifyWebBotAuth(
      {
        ...signed,
        headers: { ...signed.headers, 'signature-agent': `sig1="${ORIGIN}", sig2="https://relay.example.com"` },
      },
      options
    ),
    rejectedWith(403, 'agent_count')
  );
  // A Signature-Agent member that is not a string parses, so it is a 403.
  await assert.rejects(
    wba.verifyWebBotAuth({ ...signed, headers: { ...signed.headers, 'signature-agent': 'sig1=42' } }, options),
    rejectedWith(403)
  );
});

test('replay: 429 with Accept-Signature carrying a fresh 64-byte nonce, never Retry-After', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  const headers = await wba.signWebBotAuth(REQUEST, { privateKey: key }, { origin: ORIGIN, now: () => T });
  await wba.verifyWebBotAuth({ ...REQUEST, headers }, options);
  const nonces = [];
  for (let i = 0; i < 2; i++) {
    const error = await wba.verifyWebBotAuth({ ...REQUEST, headers }, options).catch(e => e);
    assert.ok(rejectedWith(429, 'replayed')(error));
    assert.equal(error.headers['Retry-After'], undefined);
    const nonce = error.headers['Accept-Signature'].match(/;nonce="([A-Za-z0-9_-]{86})";/)?.[1];
    assert.equal(Buffer.from(nonce, 'base64url').length, 64);
    nonces.push(nonce);
    assert.equal(error.body.adcp_error.code, 'AUTH_INVALID');
  }
  assert.notEqual(nonces[0], nonces[1]);
  // The fresh nonce is accepted on the next attempt.
  const again = await wba.signWebBotAuth(
    REQUEST,
    { privateKey: key },
    { origin: ORIGIN, now: () => T, nonce: nonces[0] }
  );
  assert.equal((await wba.verifyWebBotAuth({ ...REQUEST, headers: again }, options)).length, 1);
});

test('replay state is keyed on the nonce bytes, not their encoding', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  const bytes = Buffer.alloc(64, 0xfb);
  await wba.verifyWebBotAuth(await rawSign(key, { parameters: { nonce: bytes.toString('base64url') } }), options);
  await assert.rejects(
    wba.verifyWebBotAuth(await rawSign(key, { parameters: { nonce: bytes.toString('base64') } }), options),
    rejectedWith(429, 'replayed')
  );
});

test('directories with P-256 keys are discovery failures; revocation lists are Ed25519 only', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const body = JSON.stringify({ keys: [ec] });
  await assert.rejects(
    wba.verifyKeyDirectory(
      {
        status: 200,
        headers: {
          'content-type': wba.SIGNATURE_DIRECTORY_MEDIA_TYPE,
          'content-digest': computeContentDigest(body, 'rfc8941-base64'),
          'signature-input': `key1=("@authority";req "content-digest");created=${T};expires=${T + 60};keyid="${wba.jwkThumbprint(ec)}";tag="http-message-signatures-directory"`,
          signature: 'key1=:AAAA:',
        },
        body,
        request: { method: 'GET', url: ORIGIN + wba.SIGNATURE_DIRECTORY_PATH },
      },
      T
    ),
    e => e.status === 403 && e.reason === 'directory_unsupported_key'
  );
  const ecPrivate = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  await assert.rejects(
    createSignedOriginRevocationList(
      {
        issuer: ORIGIN,
        updated: new Date(Date.now() - 1000).toISOString(),
        next_update: new Date(Date.now() + 300_000).toISOString(),
        revoked_kids: [],
      },
      ecPrivate
    ),
    /Ed25519/
  );
});

// ---------------------------------------------------------------------------
// Unsigned requests to `required_for` operations (wba-profile.mdx "Error responses")
// ---------------------------------------------------------------------------

function wbaAuthenticator(profiles, directory) {
  return verifySignatureAsAuthenticator({
    capability: { supported: true, covers_content_digest: 'required', required_for: ['create_media_buy'], profiles },
    jwks: { resolve: async () => null },
    getUrl: () => REQUEST.url,
    now: () => T,
    assertLegacyOriginAllowed: async () => {},
    resolveOperation: () => undefined,
    webBotAuth: { directory, isRevoked: async () => false, resolvePrincipal: async () => ({ principal: 'p' }) },
  });
}
const unsignedCall = name => ({
  method: 'POST',
  url: '/mcp',
  headers: { 'content-type': 'application/json' },
  rawBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
});

test('composer: a WBA-only verifier answers 403 with Accept-Signature; alongside RFC 9421 the 401 adds it', async () => {
  const directory = new wba.SignatureDirectoryResolver({ now: () => T });
  const noCredential = async () => null;
  const only = requireSignatureWhenPresent(wbaAuthenticator(['web-bot-auth'], directory), noCredential, {
    requiredFor: ['create_media_buy'],
  });
  const refused = await only(unsignedCall('create_media_buy')).catch(e => e);
  assert.equal(refused.status, 403);
  assert.match(refused.headers['Accept-Signature'], /^sig1=\("@method" "@target-uri" "@authority" "content-type"/);
  assert.equal(refused.body.adcp_error.code, 'AUTH_INVALID');

  const both = requireSignatureWhenPresent(
    wbaAuthenticator(['adcp/request-signing/v1', 'web-bot-auth'], directory),
    noCredential,
    { requiredFor: ['create_media_buy'] }
  );
  const challenged = await both(unsignedCall('create_media_buy')).catch(e => e);
  assert.equal(challenged.status, undefined);
  assert.ok(challenged.cause instanceof RequestSignatureError);
  assert.equal(challenged.cause.code, 'request_signature_required');
  assert.match(challenged.headers['Accept-Signature'], /tag="web-bot-auth"$/);

  // Operations outside required_for, and valid fallback credentials, are unaffected.
  assert.equal(await only(unsignedCall('get_products')), null);
  const withBearer = requireSignatureWhenPresent(
    wbaAuthenticator(['web-bot-auth'], directory),
    async () => ({ principal: 'bearer' }),
    { requiredFor: ['create_media_buy'] }
  );
  assert.equal((await withBearer(unsignedCall('create_media_buy'))).principal, 'bearer');
});

test('serve() keeps the RFC 9421 challenge and adds the Accept-Signature header', () => {
  const res = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  respondUnauthorized({}, res, {
    signatureError: 'request_signature_required',
    headers: { 'Accept-Signature': 'x', 'WWW-Authenticate': 'Bearer spoofed', 'Content-Type': 'text/plain' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers['Accept-Signature'], 'x');
  assert.match(res.headers['WWW-Authenticate'], /^Signature .*error="request_signature_required"/);
  assert.equal(res.headers['Content-Type'], 'application/json');
});

function preTransportServer(profiles) {
  return createAdcpServer({
    name: 'Unsigned WBA',
    version: '1.0.0',
    identity33: { authorize: async () => {} },
    capabilities: {
      request_signing: {
        supported: true,
        covers_content_digest: 'required',
        required_for: ['create_media_buy'],
        profiles,
      },
    },
    signedRequests: {
      jwks: { resolve: async () => null },
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      assertLegacyOriginAllowed: async () => {},
      webBotAuth: {
        directory: new wba.SignatureDirectoryResolver(),
        isRevoked: async () => false,
        resolvePrincipal: async () => ({ principal: 'p' }),
      },
    },
    mediaBuy: { getProducts: async () => ({ products: [], cache_scope: 'public' }) },
  });
}
async function sendUnsigned(server, name) {
  const req = { ...unsignedCall(name), [ADCP_SERVE_REQUEST_CONTEXT]: { publicUrl: 'https://seller.example.com/mcp' } };
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    removeHeader(name) {
      delete this.headers[name.toLowerCase()];
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
      this.emit('finish');
    },
  });
  const handled = await server[ADCP_PRE_TRANSPORT](req, res);
  return { handled, res };
}

test('createAdcpServer: unsigned required_for calls get the profile-dependent answer', async () => {
  const only = preTransportServer(['web-bot-auth']);
  const both = preTransportServer(['adcp/request-signing/v1', 'web-bot-auth']);
  try {
    const refused = await sendUnsigned(only, 'create_media_buy');
    assert.equal(refused.handled, true);
    assert.equal(refused.res.statusCode, 403);
    assert.equal(refused.res.headers['www-authenticate'], undefined);
    assert.match(refused.res.headers['accept-signature'], /"content-digest" "signature-agent";key="sig1"\)/);
    assert.equal(JSON.parse(refused.res.body).adcp_error.code, 'AUTH_INVALID');

    const challenged = await sendUnsigned(both, 'create_media_buy');
    assert.equal(challenged.res.statusCode, 401);
    assert.equal(challenged.res.headers['www-authenticate'], 'Signature error="request_signature_required"');
    assert.match(challenged.res.headers['accept-signature'], /tag="web-bot-auth"$/);
    assert.equal(JSON.parse(challenged.res.body).error, 'request_signature_required');

    // Not in required_for: passes through to the transport.
    assert.equal((await sendUnsigned(only, 'get_products')).handled, false);
  } finally {
    await only.close();
    await both.close();
  }
});
