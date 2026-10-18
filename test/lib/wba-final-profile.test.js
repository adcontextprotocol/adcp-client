// Web Bot Auth profile rules from adcontextprotocol/adcp#7894 at f311e1b5
// (docs/building/by-layer/L1/wba-profile.mdx) that the vendored vectors do
// not isolate: one signature per request, the 64-byte nonce, the algorithm
// set, the replay challenge, signed directories, and unsigned requests to
// `required_for` operations.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync, createPrivateKey, sign: nodeSign, constants } = require('crypto');
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
async function verifierOptions(keys, { origin = ORIGIN, replayStore = new InMemoryReplayStore(), fetched = [] } = {}) {
  const proof = await wba.createSignedSignatureDirectory(
    origin,
    keys.map(privateKey => ({ privateKey })),
    { now: () => T }
  );
  return {
    directory: new wba.SignatureDirectoryResolver({
      now: () => T,
      fetchOptions: {
        trustedFetchFn: async url => {
          fetched.push(url);
          return new URL(url).origin === origin
            ? new Response(proof.body, { status: 200, headers: proof.headers })
            : new Response('', { status: 404 });
        },
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
async function rawSign(
  key,
  { parameters = {}, label = 'sig1', agentKey = label, agent = `${agentKey}="${ORIGIN}"` } = {}
) {
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
        httpMessageSig.component('signature-agent', { key: agentKey }),
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

test('Signature-Agent: the member is exactly the canonical https origin string, refused before any fetch', async () => {
  const key = newKey();
  // Every value below names buyer.agency.com, so a verifier that normalized it
  // first would fetch the directory the test serves.
  for (const value of [
    'http://buyer.agency.com',
    `${ORIGIN}/`,
    `${ORIGIN}/agents/a`,
    `${ORIGIN}${wba.SIGNATURE_DIRECTORY_PATH}`,
    `${ORIGIN}?v=1`,
    `${ORIGIN}#keys`,
    'https://user@buyer.agency.com',
    'https://BUYER.agency.com',
    'https://buyer.agency.com:443',
  ]) {
    const fetched = [];
    await assert.rejects(
      wba.verifyWebBotAuth(await rawSign(key, { agent: `sig1="${value}"` }), await verifierOptions([key], { fetched })),
      rejectedWith(403, 'agent_origin'),
      value
    );
    assert.deepEqual(fetched, [], value);
  }
  // type is a Token (WBA -00 section 5.2.1), and Cloudflare's reference also takes
  // the String: directory is accepted either way, and any other type is ignored,
  // which leaves no member to resolve.
  for (const type of ['directory', '"directory"']) {
    const typed = await rawSign(key, { agent: `sig1="${ORIGIN}";type=${type}` });
    assert.equal((await wba.verifyWebBotAuth(typed, await verifierOptions([key])))[0].origin, ORIGIN, type);
  }
  for (const type of ['jwks_uri', 'cimd', '"jwks_uri"'])
    await assert.rejects(
      wba.verifyWebBotAuth(
        await rawSign(key, { agent: `sig1="${ORIGIN}";type=${type}` }),
        await verifierOptions([key])
      ),
      rejectedWith(403, 'agent_type'),
      type
    );
  // Rule 4: the covered member must be the one keyed to the signature's label (R19).
  await assert.rejects(
    wba.verifyWebBotAuth(await rawSign(key, { agentKey: 'agent1' }), await verifierOptions([key])),
    rejectedWith(403, 'agent_not_covered')
  );
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

test('parameters: alg is required and must be ed25519', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  await assert.rejects(
    wba.verifyWebBotAuth(await rawSign(key, { parameters: { alg: undefined } }), options),
    rejectedWith(403, 'parameters_missing')
  );
  for (const alg of ['ecdsa-p256-sha256', 'rsa-pss-sha512'])
    await assert.rejects(
      wba.verifyWebBotAuth(await rawSign(key, { parameters: { alg } }), options),
      rejectedWith(403, 'parameters'),
      alg
    );
  // A wrongly typed parameter parses, so it is a profile failure (403), not 400.
  const signed = await rawSign(key);
  const typo = signed.headers['signature-input'].replace(`created=${T}`, 'created="yesterday"');
  await assert.rejects(
    wba.verifyWebBotAuth({ ...signed, headers: { ...signed.headers, 'signature-input': typo } }, options),
    rejectedWith(403, 'parameters')
  );
});

test('one signature: only the web-bot-auth member is read; a second one, or a second Signature-Agent member, is a 403', async () => {
  const key = newKey();
  const signed = await rawSign(key);
  const other = await rawSign(key, { label: 'other', agent: `other="${ORIGIN}"` });
  const withSecond = (tag, first = true) => {
    const second = {
      'signature-input': other.headers['signature-input'].replace('web-bot-auth', tag),
      signature: other.headers.signature,
    };
    const join = name =>
      (first ? [signed.headers[name], second[name]] : [second[name], signed.headers[name]]).join(', ');
    return {
      ...signed,
      headers: { ...signed.headers, 'signature-input': join('signature-input'), signature: join('signature') },
    };
  };
  // A member with another tag (a CDN's own signature, say) is not read, in either position.
  for (const first of [true, false]) {
    const [signer] = await wba.verifyWebBotAuth(withSecond('cdn-edge', first), await verifierOptions([key]));
    assert.equal(signer.label, 'sig1');
  }
  const options = await verifierOptions([key]);
  await assert.rejects(wba.verifyWebBotAuth(withSecond('web-bot-auth'), options), rejectedWith(403, 'signature_count'));
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
  // Member shapes belong to the field definitions: a non-string Signature-Agent
  // member or a non-byte Signature member does not parse (400).
  await assert.rejects(
    wba.verifyWebBotAuth({ ...signed, headers: { ...signed.headers, 'signature-agent': 'sig1=42' } }, options),
    rejectedWith(400, 'signature_agent')
  );
  await assert.rejects(
    wba.verifyWebBotAuth({ ...signed, headers: { ...signed.headers, signature: 'sig1=token' } }, options),
    rejectedWith(400, 'signature')
  );
});

test('one signature: member shapes are checked under every label, as Cloudflare http-message-sig checks them', async () => {
  const key = newKey();
  const signed = await rawSign(key);
  const withOther = (input, signature) => ({
    ...signed,
    headers: {
      ...signed.headers,
      'signature-input': `${signed.headers['signature-input']}, ${input}`,
      signature: `${signed.headers.signature}, ${signature}`,
    },
  });
  // A well-formed member with another tag is not read.
  const [signer] = await wba.verifyWebBotAuth(
    withOther('cdn=("@method");tag="cdn-edge"', 'cdn=:AAAA:'),
    await verifierOptions([key])
  );
  assert.equal(signer.label, 'sig1');
  // A member of the wrong shape under another label is a field that does not
  // parse: 400, as the reference's strict parser answers (MalformedField).
  const options = await verifierOptions([key]);
  for (const [input, signature, reason] of [
    ['cdn=("@method");tag="cdn-edge"', 'cdn=token', 'signature'],
    ['cdn=("@method");tag="cdn-edge"', 'cdn=(1 2)', 'signature'],
    ['cdn=token;tag="cdn-edge"', 'cdn=:AAAA:', 'signature_input'],
  ])
    await assert.rejects(
      wba.verifyWebBotAuth(withOther(input, signature), options),
      rejectedWith(400, reason),
      `${input}, ${signature}`
    );
  // The web-bot-auth member's own shape is checked too.
  const notInnerList = signed.headers['signature-input'].replace(/^sig1=\([^)]*\)/, 'sig1=token');
  await assert.rejects(
    wba.verifyWebBotAuth({ ...signed, headers: { ...signed.headers, 'signature-input': notInnerList } }, options),
    rejectedWith(400, 'signature_input')
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

/**
 * A key directory that publishes `published` (private JWKs, served public) and
 * carries one WBA Appendix B.1 signature per key in `signers`, so a test can
 * add keys the SDK would never publish or sign with. Keys in `leaked` are
 * served with their private members.
 */
async function directoryResponse(published, signers, { leaked = [] } = {}) {
  const publicJwk = ({ d, p, q, dp, dq, qi, ...rest }) => rest;
  const body = JSON.stringify({ keys: published.map(key => (leaked.includes(key) ? key : publicJwk(key))) });
  const url = ORIGIN + wba.SIGNATURE_DIRECTORY_PATH;
  const headers = {
    'content-type': wba.SIGNATURE_DIRECTORY_MEDIA_TYPE,
    'content-digest': computeContentDigest(body, 'rfc8941-base64'),
  };
  const inputs = [];
  const signatures = [];
  for (const [i, key] of signers.entries()) {
    const [algorithm, digest, options] = {
      EC: ['ecdsa-p256-sha256', 'sha256', { dsaEncoding: 'ieee-p1363' }],
      RSA: ['rsa-pss-sha512', 'sha512', { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }],
      OKP: ['ed25519', null, {}],
    }[key.kty];
    const signed = await httpMessageSig.createSignature(
      {
        kind: 'response',
        status: 200,
        fields: [{ name: 'content-digest', value: headers['content-digest'] }],
        request: { kind: 'request', method: 'GET', targetUri: url, fields: [] },
      },
      {
        label: `key${i + 1}`,
        components: [httpMessageSig.component('@authority', { req: true }), 'content-digest'],
        parameters: {
          created: T - 60,
          expires: T + 3600,
          keyid: wba.jwkThumbprint(key),
          alg: algorithm,
          tag: 'http-message-signatures-directory',
        },
        signer: {
          algorithm,
          sign: data =>
            nodeSign(digest, Buffer.from(data), { key: createPrivateKey({ key, format: 'jwk' }), ...options }),
        },
      }
    );
    inputs.push(signed.signatureInput);
    signatures.push(signed.signature);
  }
  if (signers.length)
    Object.assign(headers, { 'signature-input': inputs.join(', '), signature: signatures.join(', ') });
  return { status: 200, headers, body, request: { method: 'GET', url } };
}

test('directories: keys the profile cannot use are ignored with their signatures; every usable key signs', async () => {
  const key = newKey();
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const kids = async response => (await wba.verifyKeyDirectory(response, T)).keys.map(k => k.kid);
  // RFC 7517 section 5: a key of a type the verifier does not use is ignored,
  // whether or not it signed the directory (WBA Appendix B.1 asks every key to).
  assert.deepEqual(await kids(await directoryResponse([key, ec], [key])), [key.kid]);
  assert.deepEqual(await kids(await directoryResponse([key, ec], [key, ec])), [key.kid]);
  assert.deepEqual(await kids(await directoryResponse([ec, key], [ec, key])), [key.kid]);
  // Web Bot Auth is Ed25519 only, so an RSA key is ignored the same way.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  assert.deepEqual(await kids(await directoryResponse([key, rsa], [key, rsa])), [key.kid]);
  // A directory with no usable key, or with a usable key that did not sign, is a discovery failure.
  for (const unusable of [ec, rsa])
    await assert.rejects(
      wba.verifyKeyDirectory(await directoryResponse([unusable], [unusable]), T),
      e => e.status === 403 && e.reason === 'directory_keys'
    );
  await assert.rejects(
    wba.verifyKeyDirectory(await directoryResponse([key, newKey()], [key]), T),
    e => e.status === 403 && e.reason === 'directory_proof'
  );
  // A request signed by the usable key verifies through a directory that also lists the P-256 key.
  const response = await directoryResponse([key, ec], [key, ec]);
  const options = {
    directory: new wba.SignatureDirectoryResolver({
      now: () => T,
      fetchOptions: { trustedFetchFn: async () => new Response(response.body, { headers: response.headers }) },
    }),
    replayStore: new InMemoryReplayStore(),
    now: () => T,
  };
  assert.equal((await wba.verifyWebBotAuth(await rawSign(key), options))[0].keyid, key.kid);
});

test('directories: a key that carries private material is refused, whether or not the profile can use it', async () => {
  const key = newKey();
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  // A published private key is a leak, so the directory is refused rather than
  // the key ignored, signed or not. Each RSA private member and an oct `k`
  // (RFC 7518 section 6) leaks on its own, as does an OKP `d` (RFC 8037).
  const rsaPublic = { kty: rsa.kty, n: rsa.n, e: rsa.e };
  for (const [name, published, signers] of [
    ['Ed25519', [key], [key]],
    ['P-256', [key, ec], [key]],
    ['P-256, signed', [key, ec], [key, ec]],
    ['RSA', [key, rsa], [key]],
    ...['p', 'q', 'dp', 'dq', 'qi'].map(member => [
      `RSA ${member} only`,
      [key, { ...rsaPublic, [member]: rsa[member] }],
      [key],
    ]),
    ['RSA oth only', [key, { ...rsaPublic, oth: [{ r: rsa.p, d: rsa.dp, t: rsa.qi }] }], [key]],
    ['oct k', [key, { kty: 'oct', k: 'c2VjcmV0' }], [key]],
    // Member names are matched case-insensitively, as the Go and Python SDKs match them.
    ['Ed25519 D', [(({ d, ...rest }) => ({ ...rest, D: d }))(key)], [key]],
    ['P-256 D', [key, (({ d, ...rest }) => ({ ...rest, D: d }))(ec)], [key]],
    ['RSA P only', [key, { ...rsaPublic, P: rsa.p }], [key]],
    ['oct K', [key, { kty: 'oct', K: 'c2VjcmV0' }], [key]],
  ])
    await assert.rejects(
      wba.verifyKeyDirectory(await directoryResponse(published, signers, { leaked: [published.at(-1)] }), T),
      e => e.status === 403 && e.reason === 'directory_key',
      name
    );
});

test('directories: only the WBA directory media type is accepted (WBA section 5.5.1)', async () => {
  const key = newKey();
  const served = async contentType => {
    const response = await directoryResponse([key], [key]);
    return { ...response, headers: { ...response.headers, 'content-type': contentType } };
  };
  const accepted = [wba.SIGNATURE_DIRECTORY_MEDIA_TYPE, `${wba.SIGNATURE_DIRECTORY_MEDIA_TYPE}; charset=utf-8`];
  for (const contentType of accepted)
    assert.equal((await wba.verifyKeyDirectory(await served(contentType), T)).keys[0].kid, key.kid, contentType);
  for (const contentType of ['application/json', 'application/jwk-set+json', 'text/plain'])
    await assert.rejects(
      wba.verifyKeyDirectory(await served(contentType), T),
      e => e.status === 403 && e.reason === 'directory_response',
      contentType
    );
});

test('revocation lists are signed with EdDSA by an Ed25519 directory key only', async () => {
  const snapshot = {
    issuer: ORIGIN,
    updated: new Date(Date.now() - 1000).toISOString(),
    next_update: new Date(Date.now() + 300_000).toISOString(),
    revoked_kids: [],
  };
  const list = await createSignedOriginRevocationList(snapshot, newKey());
  assert.equal(JSON.parse(Buffer.from(list.split('.')[0], 'base64url')).alg, 'EdDSA');
  for (const [type, options] of [
    ['ec', { namedCurve: 'prime256v1' }],
    ['rsa', { modulusLength: 2048 }],
  ])
    await assert.rejects(
      createSignedOriginRevocationList(
        snapshot,
        generateKeyPairSync(type, options).privateKey.export({ format: 'jwk' })
      ),
      /Ed25519/,
      type
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
    headers: { 'Accept-Signature': 'x', 'www-authenticate': 'Bearer spoofed', 'content-type': 'text/plain' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers['Accept-Signature'], 'x');
  assert.match(res.headers['WWW-Authenticate'], /^Signature .*error="request_signature_required"/);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(res.headers).sort(), ['Accept-Signature', 'Content-Type', 'WWW-Authenticate']);
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

test('a directory proof may cover more than the Appendix B.1 minimum', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(ORIGIN, [{ privateKey: key }], { now: () => T });
  const value = `key1=("@authority";req "content-digest" "content-type");created=${T - 60};expires=${T + 3600};keyid="${key.kid}";alg="ed25519";tag="http-message-signatures-directory"`;
  const signed = await httpMessageSig.createSignature(
    {
      kind: 'response',
      status: 200,
      fields: [
        { name: 'content-digest', value: proof.headers['content-digest'] },
        { name: 'content-type', value: proof.headers['content-type'] },
      ],
      request: { kind: 'request', method: 'GET', targetUri: proof.request.url, fields: [] },
    },
    {
      label: 'key1',
      components: [httpMessageSig.component('@authority', { req: true }), 'content-digest', 'content-type'],
      parameters: {
        created: T - 60,
        expires: T + 3600,
        keyid: key.kid,
        alg: 'ed25519',
        tag: 'http-message-signatures-directory',
      },
      signer: {
        algorithm: 'ed25519',
        sign: data => nodeSign(null, Buffer.from(data), createPrivateKey({ key, format: 'jwk' })),
      },
    }
  );
  assert.equal(signed.signatureInput, value);
  const response = { ...proof, headers: { ...proof.headers, 'signature-input': value, signature: signed.signature } };
  assert.equal((await wba.verifyKeyDirectory(response, T)).keys[0].kid, key.kid);
});

test('many Signature or Signature-Input members are rejected without per-member reparsing', async () => {
  const key = newKey();
  const options = await verifierOptions([key]);
  const many = Array.from({ length: 2000 }, (_, i) => `a${i}=:AA==:`).join(', ');
  const manyInputs = Array.from({ length: 2000 }, (_, i) => `a${i}=();tag="web-bot-auth"`).join(', ');
  const started = process.hrtime.bigint();
  await assert.rejects(
    wba.verifyWebBotAuth(
      {
        ...REQUEST,
        headers: {
          ...REQUEST.headers,
          'signature-agent': 'a="b"',
          'signature-input': 'sig1=();tag="web-bot-auth"',
          signature: many,
        },
      },
      options
    ),
    // Signature members other than the web-bot-auth label are not read.
    rejectedWith(403, 'signature_label')
  );
  await assert.rejects(
    wba.verifyWebBotAuth(
      {
        ...REQUEST,
        headers: { ...REQUEST.headers, 'signature-agent': 'a="b"', 'signature-input': manyInputs, signature: many },
      },
      options
    ),
    rejectedWith(403, 'signature_count')
  );
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000, 'linear in the header size');
});
