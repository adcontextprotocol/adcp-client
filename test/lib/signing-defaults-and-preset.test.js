/**
 * Defaults + presets shipped alongside the RFC 9421 signing surface:
 *
 *   - `verifySignatureAsAuthenticator` defaults `replayStore` and
 *     `revocationStore` to in-memory stores.
 *   - `createExpressVerifier` defaults `replayStore` and `revocationStore`
 *     to in-memory stores (symmetric with the authenticator shape).
 *   - `buildAgentSigningFetch` defaults `upstream` to `globalThis.fetch`.
 *   - `createAgentSignedFetch` bundles capability-cache wiring for the
 *     single-seller case.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');

const {
  AuthError,
  verifySignatureAsAuthenticator,
  mcpToolNameResolver,
} = require('../../dist/lib/server/index.js');
const {
  signRequest,
  StaticJwksResolver,
  CapabilityCache,
  defaultCapabilityCache,
  buildAgentSigningFetch,
  createAgentSignedFetch,
  createExpressVerifier,
} = require('../../dist/lib/signing/index.js');

// ---------------------------------------------------------------------------
// Key + request helpers
// ---------------------------------------------------------------------------

const keysPath = path.join(
  __dirname,
  '..',
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const { keys } = JSON.parse(readFileSync(keysPath, 'utf8'));
const primary = keys.find(k => k.kid === 'test-ed25519-2026');
const primaryPublic = { ...primary };
delete primaryPublic._private_d_for_test_only;
delete primaryPublic.d;
const primaryPrivate = { ...primary, d: primary._private_d_for_test_only };
delete primaryPrivate._private_d_for_test_only;

function signedReq({ now, url, body, nonce }) {
  const signed = signRequest(
    { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
    { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
    { now: () => now, windowSeconds: 300, nonce }
  );
  const headers = { host: 'seller.example.com' };
  for (const [k, v] of Object.entries(signed.headers)) {
    headers[k.toLowerCase()] = v;
  }
  const parsed = new URL(url);
  return {
    method: 'POST',
    url: parsed.pathname + parsed.search,
    headers,
    rawBody: body,
  };
}

// ---------------------------------------------------------------------------
// verifySignatureAsAuthenticator — default stores
// ---------------------------------------------------------------------------

describe('verifySignatureAsAuthenticator default stores', () => {
  const now = 1_776_520_800;
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_media_buy","arguments":{}}}';
  const url = 'https://seller.example.com/mcp';

  function baseOptionsWithoutStores(overrides = {}) {
    return {
      jwks: new StaticJwksResolver([primaryPublic]),
      capability: { supported: true, covers_content_digest: 'either', required_for: [] },
      resolveOperation: mcpToolNameResolver,
      getUrl: req => `https://seller.example.com${req.url ?? '/mcp'}`,
      now: () => now,
      ...overrides,
    };
  }

  it('accepts a valid signature when replayStore/revocationStore are omitted', async () => {
    const auth = verifySignatureAsAuthenticator(baseOptionsWithoutStores());
    const req = signedReq({ now, url, body, nonce: 'default-stores-01' });
    const result = await auth(req);
    assert.ok(result, 'should return a principal');
    assert.strictEqual(result.principal, 'signing:test-ed25519-2026');
  });

  it('the default replay store actually rejects replayed nonces', async () => {
    // Single authenticator instance means a single default InMemoryReplayStore
    // shared across requests — same as wiring an explicit store once at boot.
    const auth = verifySignatureAsAuthenticator(baseOptionsWithoutStores());
    const nonce = 'default-stores-replay-01';

    const firstReq = signedReq({ now, url, body, nonce });
    const first = await auth(firstReq);
    assert.ok(first, 'first request should verify');

    // Re-sign the same nonce: new request object, identical replay fingerprint.
    const replayedReq = signedReq({ now, url, body, nonce });
    await assert.rejects(
      () => auth(replayedReq),
      err => err instanceof AuthError && /replay/i.test(err.publicMessage ?? err.message ?? '')
    );
  });

  it('every new authenticator instance gets its own default stores (no cross-talk)', async () => {
    const nonce = 'default-stores-isolation-01';

    const authA = verifySignatureAsAuthenticator(baseOptionsWithoutStores());
    const authB = verifySignatureAsAuthenticator(baseOptionsWithoutStores());

    const req1 = signedReq({ now, url, body, nonce });
    const resultA = await authA(req1);
    assert.ok(resultA, 'authA should verify');

    // authB must accept the same nonce — its default store is independent.
    const req2 = signedReq({ now, url, body, nonce });
    const resultB = await authB(req2);
    assert.ok(resultB, 'authB should verify (separate default store from authA)');
  });
});

// ---------------------------------------------------------------------------
// buildAgentSigningFetch default upstream
// ---------------------------------------------------------------------------

describe('buildAgentSigningFetch default upstream', () => {
  it('falls back to globalThis.fetch when upstream is omitted', async () => {
    const original = globalThis.fetch;
    let captured;
    globalThis.fetch = async (input, init) => {
      captured = { input: String(input), init };
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      // Minimal signing config; capability cache empty so the request passes
      // through unsigned — we only need to confirm the default upstream was
      // called.
      const signedFetch = buildAgentSigningFetch({
        signing: {
          kid: 'test-ed25519-2026',
          alg: 'ed25519',
          private_key: primaryPrivate,
          agent_url: 'https://buyer.example.com',
        },
        getCapability: () => undefined,
      });
      const res = await signedFetch('https://seller.example.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      });
      assert.strictEqual(res.status, 200);
      assert.ok(captured, 'default upstream (globalThis.fetch) should have been invoked');
      assert.strictEqual(captured.input, 'https://seller.example.com/mcp');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws a clear error when no upstream is provided and globalThis.fetch is unavailable', () => {
    const original = globalThis.fetch;
    delete globalThis.fetch;
    try {
      assert.throws(
        () =>
          buildAgentSigningFetch({
            signing: {
              kid: 'test-ed25519-2026',
              alg: 'ed25519',
              private_key: primaryPrivate,
              agent_url: 'https://buyer.example.com',
            },
            getCapability: () => undefined,
          }),
        err => err instanceof TypeError && /globalThis\.fetch is unavailable/i.test(err.message)
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// createAgentSignedFetch preset
// ---------------------------------------------------------------------------

describe('createAgentSignedFetch preset', () => {
  const signing = {
    kid: 'test-ed25519-2026',
    alg: 'ed25519',
    private_key: primaryPrivate,
    agent_url: 'https://buyer.example.com',
  };
  const sellerAgentUri = 'https://seller.example.com';

  function makeCapturingUpstream() {
    const captured = {};
    const upstream = async (input, init) => {
      captured.input = String(input);
      captured.init = init;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { captured, upstream };
  }

  it('returns a FetchLike function', () => {
    const signedFetch = createAgentSignedFetch({ signing, sellerAgentUri, cache: new CapabilityCache() });
    assert.strictEqual(typeof signedFetch, 'function');
  });

  it('passes through unsigned when the capability cache is cold', async () => {
    const cache = new CapabilityCache();
    const { captured, upstream } = makeCapturingUpstream();
    const signedFetch = createAgentSignedFetch({ signing, sellerAgentUri, cache, upstream });
    await signedFetch('https://seller.example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_media_buy","arguments":{}}}',
    });
    const headers = new Headers(captured.init?.headers);
    assert.strictEqual(headers.get('signature-input'), null, 'cold cache should not sign');
  });

  it('signs when the capability cache lists the operation as required_for', async () => {
    const cache = new CapabilityCache();
    const { buildCapabilityCacheKey } = require('../../dist/lib/signing/index.js');
    const cacheKey = buildCapabilityCacheKey(sellerAgentUri);
    cache.set(cacheKey, {
      agentUri: sellerAgentUri,
      requestSigning: {
        supported: true,
        required_for: ['create_media_buy'],
        covers_content_digest: 'either',
      },
      cachedAt: Date.now(),
    });
    const { captured, upstream } = makeCapturingUpstream();
    const signedFetch = createAgentSignedFetch({ signing, sellerAgentUri, cache, upstream });
    await signedFetch('https://seller.example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_media_buy","arguments":{}}}',
    });
    const headers = new Headers(captured.init?.headers);
    assert.ok(headers.get('signature-input'), 'required_for op should be signed');
    assert.ok(headers.get('signature'), 'Signature header should be present');
  });

  it('defaults to defaultCapabilityCache when no cache is passed', () => {
    const signedFetch = createAgentSignedFetch({ signing, sellerAgentUri });
    assert.strictEqual(typeof signedFetch, 'function');
    assert.ok(defaultCapabilityCache, 'defaultCapabilityCache should be exported');
  });
});

// ---------------------------------------------------------------------------
// createExpressVerifier — default stores
// ---------------------------------------------------------------------------

describe('createExpressVerifier default stores', () => {
  const now = 1_776_520_800;
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_media_buy","arguments":{}}}';
  const url = 'https://seller.example.com/mcp';

  function baseOptionsWithoutStores(overrides = {}) {
    return {
      jwks: new StaticJwksResolver([primaryPublic]),
      capability: { supported: true, covers_content_digest: 'either', required_for: [] },
      resolveOperation: req => {
        try {
          const parsed = JSON.parse(req.rawBody ?? '');
          if (parsed.method === 'tools/call') return parsed.params?.name;
        } catch {}
        return undefined;
      },
      getUrl: req => `https://seller.example.com${req.originalUrl ?? req.url ?? '/mcp'}`,
      now: () => now,
      ...overrides,
    };
  }

  function expressReq(signed, bodyStr) {
    const headers = { host: 'seller.example.com' };
    for (const [k, v] of Object.entries(signed.headers)) {
      headers[k.toLowerCase()] = v;
    }
    return {
      method: 'POST',
      url: '/mcp',
      originalUrl: '/mcp',
      protocol: 'https',
      headers,
      rawBody: bodyStr,
      get(name) {
        return headers[name.toLowerCase()];
      },
    };
  }

  function sign(nonce, bodyStr) {
    return signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: bodyStr },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
      { now: () => now, windowSeconds: 300, nonce }
    );
  }

  function fakeRes() {
    const state = { status: undefined, headers: {}, body: undefined };
    const chain = {
      set(k, v) {
        state.headers[k] = v;
        return chain;
      },
      json(b) {
        state.body = b;
        return chain;
      },
    };
    return {
      status(code) {
        state.status = code;
        return chain;
      },
      state,
    };
  }

  it('accepts a valid signature when replayStore/revocationStore are omitted', async () => {
    const middleware = createExpressVerifier(baseOptionsWithoutStores());
    const req = expressReq(sign('express-default-stores-01', body), body);
    const res = fakeRes();
    let nextCalled = false;
    await middleware(req, res, err => {
      if (err) throw err;
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true, 'next() should be called on verified request');
    assert.ok(req.verifiedSigner, 'req.verifiedSigner should be populated');
    assert.strictEqual(req.verifiedSigner.keyid, 'test-ed25519-2026');
  });

  it('the default replay store rejects replayed nonces', async () => {
    const middleware = createExpressVerifier(baseOptionsWithoutStores());
    const nonce = 'express-default-stores-replay-01';

    const req1 = expressReq(sign(nonce, body), body);
    const res1 = fakeRes();
    await middleware(req1, res1, () => {});
    assert.ok(req1.verifiedSigner, 'first request should verify');

    const req2 = expressReq(sign(nonce, body), body);
    const res2 = fakeRes();
    await middleware(req2, res2, () => {});
    assert.strictEqual(res2.state.status, 401, 'replay should yield 401');
    assert.ok(
      res2.state.headers['WWW-Authenticate']?.startsWith('Signature error="'),
      'should carry Signature WWW-Authenticate challenge'
    );
  });

  it('every new middleware instance gets its own default stores', async () => {
    const mwA = createExpressVerifier(baseOptionsWithoutStores());
    const mwB = createExpressVerifier(baseOptionsWithoutStores());
    const nonce = 'express-default-stores-isolation-01';

    const reqA = expressReq(sign(nonce, body), body);
    await mwA(reqA, fakeRes(), () => {});
    assert.ok(reqA.verifiedSigner, 'mwA should verify');

    // Same nonce on an independent middleware instance must verify — default stores don't leak across instances.
    const reqB = expressReq(sign(nonce, body), body);
    await mwB(reqB, fakeRes(), () => {});
    assert.ok(reqB.verifiedSigner, 'mwB should verify (independent default store)');
  });
});
