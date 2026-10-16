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
const origin = 'https://buyer.agency.com';

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
  await assert.rejects(mismatched.resolve(key.kid, origin), e => e.reason === 'directory_digest' && e.unverified);
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

test('D3: an RFC 9421 webhook nonce cannot be replayed at expires + skew', async () => {
  const { verifyWebhookSignature } = require('../../dist/lib/signing/webhook-verifier.js');
  const { signWebhook } = require('../../dist/lib/signing/signer.js');
  const fixtures = path.join(__dirname, '../fixtures/webhook-signing-vectors/keys.json');
  const entry = JSON.parse(readFileSync(fixtures, 'utf8')).keys.find(k => k.kid === 'test-ed25519-webhook-2026');
  const { _private_d_for_test_only, ...publicJwk } = entry;
  const key = {
    keyid: entry.kid,
    alg: 'ed25519',
    privateKey: { ...publicJwk, d: _private_d_for_test_only },
  };
  const created = 1_776_520_800;
  const webhook = {
    method: 'POST',
    url: 'https://buyer.example.com/adcp/webhook/create_media_buy/agent_123/op_abc',
    headers: { 'Content-Type': 'application/json' },
    body: '{"idempotency_key":"whk_01HW9D3H8FZP2N6R8T0V4X6Z9B","status":"completed"}',
  };
  const signed = signWebhook(webhook, key, { now: () => created, windowSeconds: 300 });
  const replayStore = new InMemoryReplayStore();
  const verify = at =>
    verifyWebhookSignature(
      { ...webhook, headers: { ...webhook.headers, ...signed.headers } },
      {
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore,
        revocationStore: new InMemoryRevocationStore(),
        now: () => at,
      }
    );
  assert.equal((await verify(created)).status, 'verified');
  await assert.rejects(verify(created + 300 + 60), e => /replayed/.test(e.code));
});

test('D4: the RFC 9421 signing fetch digests the exact bytes it sends', async () => {
  const { createSigningFetch } = require('../../dist/lib/signing/fetch.js');
  const { createHash } = require('crypto');
  const keys = JSON.parse(
    readFileSync(path.join(__dirname, '../../compliance/cache/latest/test-vectors/request-signing/keys.json'), 'utf8')
  ).keys;
  const ed = keys.find(k => k.kid === 'test-ed25519-2026');
  const privateKey = { ...ed, d: ed._private_d_for_test_only };
  for (const field of ['_private_d_for_test_only', 'key_ops', 'use']) delete privateKey[field];
  let sent;
  const signingFetch = createSigningFetch(
    async (_url, init) => {
      sent = init;
      return new Response('');
    },
    { keyid: ed.kid, alg: 'ed25519', privateKey },
    { coverContentDigest: true }
  );
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}')]);
  await signingFetch('https://seller.example.com/mcp', {
    method: 'POST',
    body: bytes,
    headers: { 'content-type': 'application/json' },
  });
  const wire = typeof sent.body === 'string' ? Buffer.from(sent.body, 'utf8') : Buffer.from(sent.body);
  assert.deepEqual(wire, Buffer.from(bytes));
  const digest = Object.entries(sent.headers).find(([name]) => name.toLowerCase() === 'content-digest')[1];
  assert.ok(digest.includes(createHash('sha256').update(wire).digest('base64')));
});

test('D6: missing Signature or Signature-Input is a 403 with a body-aware challenge', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const options = {
    directory: directoryFor(proof, () => T),
    replayStore: new InMemoryReplayStore(),
    isRevoked: async () => false,
    now: () => T,
  };
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  const { signature: _omit, ...unsigned } = headers;
  await assert.rejects(wba.verifyWebBotAuth({ ...request, headers: unsigned }, options), e => e.status === 403);
  // A bodyless request carrying only Signature-Agent is challenged without body components.
  await assert.rejects(
    wba.verifyWebBotAuth(
      { method: 'GET', url: request.url, headers: { 'signature-agent': `sig1="${origin}"` } },
      options
    ),
    e =>
      e.status === 403 &&
      e.headers['Accept-Signature'].startsWith('sig1=("@method" "@target-uri" "@authority" "signature-agent"')
  );
});

test('D7: relay signing without existing fields is a caller error', async () => {
  await assert.rejects(
    wba.signWebBotAuth(request, { privateKey: newKey() }, { origin, relay: true, label: 'sig2', now: () => T }),
    e => e instanceof TypeError && /Relay requires/.test(e.message)
  );
});

test('DR-0023: verifier infrastructure failures are not signature outcomes', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  const base = { directory: directoryFor(proof, () => T), replayStore: new InMemoryReplayStore(), now: () => T };
  // Replay state unknown: an infrastructure outage for the application layer, never a challenge.
  await assert.rejects(
    wba.verifyWebBotAuth(
      { ...request, headers },
      {
        ...base,
        replayStore: {
          insert: async () => {
            throw new Error('redis offline');
          },
        },
      }
    ),
    e => e instanceof wba.WebBotAuthUnavailableError && e.reason === 'replay_unavailable'
  );
  // Verification needs nothing but key discovery and replay state.
  assert.equal((await wba.verifyWebBotAuth({ ...request, headers }, base))[0].origin, origin);
});

test('DR-0023: signature-path errors carry the generic authentication error and no detail', () => {
  for (const [status, reason] of [
    [400, 'structured_field'],
    [403, 'signature_invalid'],
    [429, 'nonce_replayed'],
    [403, 'key_revoked'],
  ]) {
    const error = new wba.WebBotAuthError(status, reason);
    assert.deepEqual(error.body, {
      adcp_error: { code: 'AUTH_INVALID', message: error.message, recovery: 'terminal' },
    });
    assert.ok(!JSON.stringify(error.body).includes(reason));
  }
  assert.equal(new wba.WebBotAuthError(403, 'key_revoked').headers['Accept-Signature'], undefined);
  assert.ok(new wba.WebBotAuthError(403, 'signature_invalid').headers['Accept-Signature']);
});

test('§6.10: discovery failures leave the request unverified and never evict cached keys', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  let clock = T;
  let serve = serving(proof);
  const directory = new wba.SignatureDirectoryResolver({
    now: () => clock,
    fetchOptions: { trustedFetchFn: (...args) => serve(...args) },
  });
  const verify = async () => {
    const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => clock });
    return wba.verifyWebBotAuth(
      { ...request, headers },
      { directory, replayStore: new InMemoryReplayStore(), now: () => clock }
    );
  };
  assert.equal((await verify()).length, 1);
  for (const failure of [
    async () => new Response('', { status: 404 }),
    async () => new Response('', { status: 410 }),
    async () => new Response('', { status: 503 }),
    async () => {
      throw new Error('connect ETIMEDOUT');
    },
  ]) {
    serve = failure;
    clock += 400; // past HTTP freshness, inside the signed proof's lifetime
    assert.equal((await verify()).length, 1, 'cached keys keep verifying');
  }
  // With nothing cached, a discovery failure is unverified: 403 with a challenge, never a 503.
  for (const failure of [
    async () => new Response('', { status: 404 }),
    async () => new Response('', { status: 503 }),
    async () => {
      throw new Error('down');
    },
  ]) {
    const cold = new wba.SignatureDirectoryResolver({ now: () => T, fetchOptions: { trustedFetchFn: failure } });
    const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
    await assert.rejects(
      wba.verifyWebBotAuth(
        { ...request, headers },
        { directory: cold, replayStore: new InMemoryReplayStore(), now: () => T }
      ),
      e => e.status === 403 && e.unverified && !!e.headers['Accept-Signature']
    );
  }
  // A fetched directory without the key is a signature failure, not a discovery failure.
  const other = await wba.createSignedSignatureDirectory(origin, [{ privateKey: newKey() }], { now: () => T });
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  await assert.rejects(
    wba.verifyWebBotAuth(
      { ...request, headers },
      { directory: directoryFor(other, () => T), replayStore: new InMemoryReplayStore(), now: () => T }
    ),
    e => e.status === 403 && e.reason === 'key' && !e.unverified
  );
});

test('unsigned key directories: plain JWKS is accepted by thumbprint unless signatures are required', async () => {
  const key = newKey();
  const { d: _d, kid: _kid, ...publicJwk } = key;
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  const plain = (body, contentType = 'application/jwk-set+json') =>
    new wba.SignatureDirectoryResolver({
      now: () => T,
      fetchOptions: {
        trustedFetchFn: async () =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': contentType } }),
      },
    });
  for (const body of [{ keys: [publicJwk] }, { keys: [{ ...publicJwk, kid: key.kid }] }])
    assert.equal(
      (
        await wba.verifyWebBotAuth(
          { ...request, headers },
          { directory: plain(body), replayStore: new InMemoryReplayStore(), now: () => T }
        )
      ).length,
      1
    );
  // A kid that is not the thumbprint is refused.
  await assert.rejects(
    wba.verifyWebBotAuth(
      { ...request, headers },
      {
        directory: plain({ keys: [{ ...publicJwk, kid: 'x'.repeat(43) }] }),
        replayStore: new InMemoryReplayStore(),
        now: () => T,
      }
    ),
    e => e.status === 403 && e.unverified
  );
  // Operators can still require Appendix B signatures.
  const strict = new wba.SignatureDirectoryResolver({
    now: () => T,
    requireSignedDirectories: true,
    fetchOptions: {
      trustedFetchFn: async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/jwk-set+json' },
        }),
    },
  });
  await assert.rejects(strict.resolve(key.kid, origin), e => e.reason === 'directory_unsigned' && e.status === 403);
});

test('identity layer: revoked, unknown, absent and store failures are decided after verification', async () => {
  const identity = require('../../dist/lib/identity-3.3');
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  const signers = await wba.verifyWebBotAuth(
    { ...request, headers },
    { directory: directoryFor(proof, () => T), replayStore: new InMemoryReplayStore(), now: () => T }
  );
  const trust = new identity.TrustEvaluator({
    now: () => T,
    fetchOptions: {
      trustedFetchFn: async () =>
        new Response(JSON.stringify({ agents: [{ url: origin, roles: ['adcp:buying'] }] }), { status: 200 }),
    },
  });
  const lifecycle = new identity.OriginIdentityLifecycle({
    store: new identity.InMemoryOriginIdentityStore(),
    trust,
    now: () => T,
  });
  await lifecycle.bindPrincipal({ origin, principalId: 'principal-1', approvedBy: 'admin', reason: 'approved' });
  const resolverWith = status => identity.createIdentity33PrincipalResolver({ lifecycle, revocation: { status } });
  // Revoked: the generic authentication error, without a challenge (stop using the key).
  await assert.rejects(
    resolverWith(async () => 'revoked')(signers, 'get_products'),
    e =>
      e.status === 403 &&
      e.reason === 'key_revoked' &&
      !e.headers['Accept-Signature'] &&
      e.body.adcp_error.code === 'AUTH_INVALID'
  );
  // Unknown (stale past grace, or never verifiable): identity not established.
  await assert.rejects(
    resolverWith(async () => 'unknown')(signers, 'get_products'),
    e => e.status === 403 && e.reason === 'identity_unverified' && e.unverified && !!e.headers['Accept-Signature']
  );
  // History-store failure: an infrastructure outage, not an identity outcome.
  await assert.rejects(
    resolverWith(async () => {
      throw new Error('disk offline');
    })(signers, 'get_products'),
    e => e instanceof wba.WebBotAuthUnavailableError
  );
  // Current: the binding applies.
  assert.equal((await resolverWith(async () => 'current')(signers, 'get_products')).principal, 'principal-1');
  // Absent (no list served): identity-established even though bound, and cannot be bound for spend.
  const absent = await resolverWith(async () => 'absent')(signers, 'get_products');
  assert.notEqual(absent.principal, 'principal-1');
  assert.equal(absent.extra.identity33.state, 'identity-established');
  assert.equal(absent.credential, undefined);
  const authorize = identity.createIdentity33Authorization({
    lifecycle,
    grants: { evaluator: trust },
    resolveClaims: async () => [],
  });
  const ctx = { authInfo: { token: '', clientId: absent.principal, scopes: [], extra: absent.extra } };
  await assert.rejects(authorize(ctx, 'sync_principal', {}), e => e.code === 'PERMISSION_DENIED');
  await authorize(ctx, 'get_products', { buying_mode: 'brief', brief: 'x' });
});

test('server integrations require revocation in the identity layer and answer verifier outages as 503', async () => {
  const identity = require('../../dist/lib/identity-3.3');
  const { verifySignatureAsAuthenticator } = require('../../dist/lib/server/auth-signature');
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const lifecycle = new identity.OriginIdentityLifecycle({
    store: new identity.InMemoryOriginIdentityStore(),
    trust: new identity.TrustEvaluator({ now: () => T }),
    now: () => T,
  });
  const base = {
    capability: { supported: true, covers_content_digest: 'required', required_for: [], profiles: ['web-bot-auth'] },
    jwks: { resolve: async () => null },
    getUrl: () => request.url,
    now: () => T,
    resolveOperation: () => 'get_products',
  };
  assert.throws(
    () =>
      verifySignatureAsAuthenticator({
        ...base,
        webBotAuth: {
          directory: directoryFor(proof, () => T),
          resolvePrincipal: identity.createIdentity33PrincipalResolver({ lifecycle }),
        },
      }),
    /requires origin revocation/
  );
  const authenticate = verifySignatureAsAuthenticator({
    ...base,
    replayStore: {
      insert: async () => {
        throw new Error('redis offline');
      },
    },
    webBotAuth: {
      directory: directoryFor(proof, () => T),
      resolvePrincipal: identity.createIdentity33PrincipalResolver({
        lifecycle,
        revocation: { status: async () => 'current' },
      }),
    },
  });
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  await assert.rejects(
    authenticate({ method: 'POST', url: '/mcp', headers, rawBody: request.body }),
    e =>
      e.status === 503 &&
      e.headers['Retry-After'] === '60' &&
      !e.headers['Accept-Signature'] &&
      e.body.adcp_error.code === 'SERVICE_UNAVAILABLE'
  );
});

test('review: deprecated isRevoked tolerance covers unknown status only, never a revocation', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const verify = async (isRevoked, requireFreshRevocation) => {
    const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
    return wba.verifyWebBotAuth(
      { ...request, headers },
      {
        directory: directoryFor(proof, () => T),
        replayStore: new InMemoryReplayStore(),
        now: () => T,
        isRevoked,
        ...(requireFreshRevocation !== undefined && { requireFreshRevocation }),
      }
    );
  };
  const throwing = reason => async () => {
    throw new wba.WebBotAuthError(403, reason);
  };
  await assert.rejects(verify(throwing('key_revoked'), false), e => e.reason === 'key_revoked');
  // Absent (no list): the deprecated path is conservative and leaves the identity unverified.
  await assert.rejects(verify(throwing('revocation_absent')), e => e.reason === 'identity_unverified');
  assert.equal((await verify(throwing('revocation_absent'), false)).length, 1);
  assert.equal((await verify(throwing('revocation_unavailable'), false)).length, 1);
  await assert.rejects(
    verify(throwing('revocation_persistence_failed'), false),
    e => e instanceof wba.WebBotAuthUnavailableError
  );
});

test('review: a key rotated in during a directory outage is a discovery failure', async () => {
  const oldKey = newKey(),
    newKeyPair = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: oldKey }], { now: () => T });
  let clock = T,
    serve = serving(proof);
  const directory = new wba.SignatureDirectoryResolver({
    now: () => clock,
    fetchOptions: { trustedFetchFn: (...args) => serve(...args) },
  });
  assert.equal((await directory.resolve(oldKey.kid, origin)).kid, oldKey.kid);
  serve = async () => new Response('', { status: 503 });
  clock += 400;
  await assert.rejects(
    directory.resolve(newKeyPair.kid, origin),
    e => e.reason === 'directory_unavailable' && e.unverified
  );
  // The cached key still verifies through the outage.
  assert.equal((await directory.resolve(oldKey.kid, origin)).kid, oldKey.kid);
});

test('review: unsigned directories keep verifying through failed refreshes until their age bound', async () => {
  const key = newKey();
  const { d: _d, ...publicJwk } = key;
  assert.throws(() => new wba.SignatureDirectoryResolver({ maxUnsignedDirectoryAgeSeconds: Number.NaN }), TypeError);
  assert.throws(() => new wba.SignatureDirectoryResolver({ maxUnsignedDirectoryAgeSeconds: 10 }), TypeError);
  let clock = T,
    up = true;
  const directory = new wba.SignatureDirectoryResolver({
    now: () => clock,
    maxUnsignedDirectoryAgeSeconds: 3600,
    fetchOptions: {
      trustedFetchFn: async () =>
        up
          ? new Response(JSON.stringify({ keys: [publicJwk] }), {
              status: 200,
              headers: { 'content-type': 'application/jwk-set+json' },
            })
          : new Response('', { status: 500 }),
    },
  });
  assert.equal((await directory.resolve(key.kid, origin)).kid, key.kid);
  up = false;
  clock += 1800;
  assert.equal((await directory.resolve(key.kid, origin)).kid, key.kid);
  clock = T + 3601;
  await assert.rejects(directory.resolve(key.kid, origin), e => e.unverified);
  // Direct callers get a finite expiry for unsigned directories too.
  const checked = wba.verifyKeyDirectory(
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: [publicJwk] }),
      request: { method: 'GET', url: origin + wba.SIGNATURE_DIRECTORY_PATH },
    },
    T
  );
  assert.equal(checked.signed, false);
  assert.equal(checked.expires, T + 86_400);
});

test('review: RSA keys are bounded to 2048-4096 bits with e = 65537', async () => {
  const { generateKeyPairSync: generate } = require('crypto');
  const small = generate('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  const oddExponent = generate('rsa', { modulusLength: 2048, publicExponent: 3 }).publicKey.export({ format: 'jwk' });
  for (const jwk of [small, oddExponent])
    assert.throws(
      () =>
        wba.verifyKeyDirectory(
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keys: [jwk] }),
            request: { method: 'GET', url: origin + wba.SIGNATURE_DIRECTORY_PATH },
          },
          T
        ),
      e => e.status === 403
    );
});

test('review: revocation status transitions between absent, unknown and current', async () => {
  const identity = require('../../dist/lib/identity-3.3');
  const { CompactSign } = await import('jose');
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T - 60 });
  const { createPrivateKey } = require('crypto');
  const listAt = at =>
    new CompactSign(
      Buffer.from(
        JSON.stringify({
          issuer: origin,
          updated: new Date(at * 1000).toISOString(),
          next_update: new Date((at + 300) * 1000).toISOString(),
          revoked_kids: [],
        })
      )
    )
      .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'adcp-gov-revocation+jws' })
      .sign(createPrivateKey({ key, format: 'jwk' }));
  let clock = T,
    serve;
  const resolver = new identity.OriginRevocationResolver({
    store: new identity.InMemoryOriginRevocationStore(),
    directory: directoryFor(proof, () => clock),
    now: () => clock,
    fetchOptions: { trustedFetchFn: async () => serve() },
  });
  serve = async () => new Response(await listAt(clock));
  assert.equal(await resolver.status(origin, key.kid), 'current');
  serve = async () => new Response('', { status: 404 });
  clock += 301;
  assert.equal(await resolver.status(origin, key.kid), 'absent');
  serve = async () => new Response('', { status: 503 });
  clock += 61;
  assert.equal(await resolver.status(origin, key.kid), 'unknown');
  serve = async () => new Response(await listAt(clock));
  clock += 61;
  assert.equal(await resolver.status(origin, key.kid), 'current');
});

test('review: a saturated directory fetch limiter sheds load with 429, not a re-sign challenge', async () => {
  const key = newKey();
  const releases = [];
  const directory = new wba.SignatureDirectoryResolver({
    now: () => T,
    maxConcurrentFetches: 1,
    fetchOptions: {
      trustedFetchFn: () => new Promise((_, reject) => releases.push(() => reject(new Error('released')))),
    },
  });
  const first = directory.resolve(key.kid, 'https://a.slow.com').catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  try {
    await assert.rejects(
      directory.resolve(key.kid, origin),
      e =>
        e.status === 429 &&
        e.reason === 'directory_fetch_limit' &&
        e.headers['Retry-After'] === '60' &&
        !e.headers['Accept-Signature']
    );
  } finally {
    for (const release of releases) release();
    await first;
  }
});

test('library-first: the signed target URI omits the fragment the HTTP client never sends', async () => {
  const key = newKey();
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const withFragment = { ...request, url: 'https://seller.example.com/mcp?x=1#section' };
  const headers = await wba.signWebBotAuth(withFragment, { privateKey: key }, { origin, now: () => T });
  const received = { ...request, url: 'https://seller.example.com/mcp?x=1', headers };
  const [signer] = await wba.verifyWebBotAuth(received, {
    directory: directoryFor(proof, () => T),
    replayStore: new InMemoryReplayStore(),
    now: () => T,
  });
  assert.equal(signer.origin, origin);
});

test('library-first: a provider may return an ArrayBuffer, as WebCrypto does', async () => {
  const key = newKey();
  const { d: _d, ...publicKey } = key;
  const privateKey = createPrivateKey({ key, format: 'jwk' });
  const provider = {
    keyid: key.kid,
    algorithm: 'ed25519',
    fingerprint: key.kid,
    sign: async data => {
      const bytes = nodeSign(null, data, privateKey);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
  const proof = await wba.createSignedSignatureDirectory(origin, [{ publicKey, provider }], { now: () => T });
  const headers = await wba.signWebBotAuth(request, { publicKey, provider }, { origin, now: () => T });
  assert.match(headers.signature, /^sig1=:[A-Za-z0-9+/]{86}==:$/);
  const [signer] = await wba.verifyWebBotAuth(
    { ...request, headers },
    { directory: directoryFor(proof, () => T), replayStore: new InMemoryReplayStore(), now: () => T }
  );
  assert.equal(signer.keyid, key.kid);
});

test('library-first: relays refuse what the profile cannot verify, as before', async () => {
  const inner = await wba.signWebBotAuth(request, { privateKey: newKey() }, { origin, now: () => T });
  const relay = headers =>
    wba.signWebBotAuth(
      { ...request, headers },
      { privateKey: newKey() },
      { origin: 'https://relay.example.com', label: 'sig2', relay: true, now: () => T }
    );
  // An earlier signature covering a derived component outside the profile.
  await assert.rejects(
    relay({ ...inner, 'signature-input': inner['signature-input'].replace('("@method"', '("@path" "@method"') }),
    e => e instanceof wba.WebBotAuthError && e.status === 400 && e.reason === 'derived_component'
  );
  // A Signature-Agent that already names the relay's label.
  await assert.rejects(
    relay({ ...inner, 'signature-agent': `${inner['signature-agent']}, sig2="https://evil.example.com"` }),
    e => e instanceof wba.WebBotAuthError && e.status === 400
  );
});

test('library-first: covered fields the library refuses are malformed messages', async () => {
  await assert.rejects(
    wba.signWebBotAuth(
      { ...request, headers: { 'content-type': 'application/json\u0001' } },
      { privateKey: newKey() },
      { origin, now: () => T }
    ),
    e => e instanceof wba.WebBotAuthError && e.status === 400 && e.reason === 'component_value'
  );
});
