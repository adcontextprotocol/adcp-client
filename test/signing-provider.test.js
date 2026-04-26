/**
 * Tests for the SigningProvider abstraction:
 *   - InMemorySigningProvider produces byte-identical output to signRequest
 *   - signRequestAsync + InMemorySigningProvider round-trips through verifyRequestSignature
 *   - signWebhookAsync produces a verifiable webhook signature
 *   - createSigningFetch accepts a SigningProvider
 *   - buildAgentSigningContext: fingerprint < 16 chars throws
 *   - Cache-isolation: two providers with same kid but distinct fingerprints get distinct cache keys
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { generateKeyPairSync } = require('node:crypto');

const {
  signRequest,
  signRequestAsync,
  signWebhookAsync,
  createSigningFetch,
} = require('../dist/lib/signing/client.js');

const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  verifyRequestSignature,
  verifyWebhookSignature,
} = require('../dist/lib/signing/server.js');

const {
  buildAgentSigningContext,
  buildAgentSigningContextFromConfig,
  CapabilityCache,
  buildCapabilityCacheKey,
} = require('../dist/lib/signing/client.js');

const { InMemorySigningProvider } = require('../dist/lib/signing/testing.js');

// ---------------------------------------------------------------------------
// Key fixtures — generated fresh per process, self-contained
// ---------------------------------------------------------------------------
let privateJwk;    // request-signing key
let publicJwk;
let webhookPrivJwk; // webhook-signing key
let webhookPubJwk;

before(() => {
  function makeKeypair(kid, adcp_use) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    // alg must be the JOSE name (EdDSA), not the AdCP wire name (ed25519)
    const priv = { ...privateKey.export({ format: 'jwk' }), kid, kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', adcp_use, key_ops: ['sign'] };
    const pub  = { ...publicKey.export({ format: 'jwk' }),  kid, kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', adcp_use, key_ops: ['verify'] };
    return { priv, pub };
  }
  const req = makeKeypair('test-gen-ed25519', 'request-signing');
  privateJwk = req.priv;
  publicJwk  = req.pub;
  const wh = makeKeypair('test-gen-webhook', 'webhook-signing');
  webhookPrivJwk = wh.priv;
  webhookPubJwk  = wh.pub;
});

function makeReq(opts = {}) {
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? 'https://seller.example.com/mcp',
    headers: { 'content-type': 'application/json', host: 'seller.example.com', ...opts.headers },
    body: opts.body ?? '{"method":"tools/call","params":{"name":"create_media_buy"}}',
  };
}

function makeVerifier(pubJwk) {
  return {
    jwks: new StaticJwksResolver([pubJwk]),
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
    capability: { supported: true, covers_content_digest: 'either', required_for: [] },
  };
}

describe('InMemorySigningProvider', () => {
  it('sign() produces byte-identical output to signRequest for ed25519', async () => {
    const now = 1700000000;
    const nonce = 'test-nonce-abc';
    const req = makeReq();

    // Use privateJwk for signing; adcp_use scoping only affects the verifier.
    const signerKey = { keyid: privateJwk.kid, alg: 'ed25519', privateKey: privateJwk };
    const syncResult = signRequest(req, signerKey, { now: () => now, nonce });

    const provider = new InMemorySigningProvider({
      keyid: privateJwk.kid,
      algorithm: 'ed25519',
      privateKey: privateJwk,
    });
    const asyncResult = await signRequestAsync(req, provider, { now: () => now, nonce });

    assert.strictEqual(asyncResult.headers['Signature'], syncResult.headers['Signature'],
      'async provider signature must match sync signRequest output');
    assert.strictEqual(asyncResult.headers['Signature-Input'], syncResult.headers['Signature-Input']);
    assert.strictEqual(asyncResult.signatureBase, syncResult.signatureBase);
  });

  it('fingerprint matches legacy AgentRequestSigningConfig derivation', () => {
    const provider = new InMemorySigningProvider({
      keyid: 'my-key',
      algorithm: 'ed25519',
      privateKey: { d: 'secret-scalar', kty: 'OKP', crv: 'Ed25519' },
    });
    const { createHash } = require('node:crypto');
    const expected = createHash('sha256').update('my-key').update('\0').update('secret-scalar').digest('hex').slice(0, 16);
    assert.strictEqual(provider.fingerprint, expected);
  });
});

describe('signRequestAsync round-trip through verifyRequestSignature', () => {
  it('signed with InMemorySigningProvider verifies successfully', async () => {
    const provider = new InMemorySigningProvider({
      keyid: publicJwk.kid,
      algorithm: 'ed25519',
      privateKey: privateJwk,
    });

    const now = Math.floor(Date.now() / 1000);
    const req = makeReq();
    const signed = await signRequestAsync(req, provider, { now: () => now });

    const verifier = makeVerifier(publicJwk);
    const result = await verifyRequestSignature(
      { method: req.method, url: req.url, headers: { ...req.headers, ...signed.headers }, body: req.body },
      { ...verifier, now: () => now }
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, publicJwk.kid);
  });
});

describe('signWebhookAsync round-trip', () => {
  it('webhook signed with InMemorySigningProvider verifies successfully', async () => {
    const provider = new InMemorySigningProvider({
      keyid: webhookPubJwk.kid,
      algorithm: 'ed25519',
      privateKey: webhookPrivJwk,
    });

    const now = Math.floor(Date.now() / 1000);
    const req = { method: 'POST', url: 'https://buyer.example.com/webhooks', headers: { host: 'buyer.example.com', 'content-type': 'application/json' }, body: '{"event":"delivery"}' };
    const signed = await signWebhookAsync(req, provider, { now: () => now });

    const result = await verifyWebhookSignature(
      { method: req.method, url: req.url, headers: { ...req.headers, ...signed.headers }, body: req.body },
      {
        jwks: new StaticJwksResolver([webhookPubJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => now,
      }
    );
    assert.strictEqual(result.status, 'verified');
  });
});

describe('createSigningFetch with SigningProvider', () => {
  it('sends signed request and upstream receives correct Signature header', async () => {
    const provider = new InMemorySigningProvider({
      keyid: publicJwk.kid,
      algorithm: 'ed25519',
      privateKey: privateJwk,
    });

    let capturedHeaders;
    const fakeUpstream = async (_url, init) => {
      capturedHeaders = init.headers;
      return new Response('{}', { status: 200 });
    };

    const fetch = createSigningFetch(fakeUpstream, provider);
    await fetch('https://seller.example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"method":"tools/call"}',
    });

    assert.ok(capturedHeaders['Signature'], 'Signature header must be set');
    assert.ok(capturedHeaders['Signature-Input'], 'Signature-Input header must be set');
    assert.match(capturedHeaders['Signature'], /^sig1=:/);
  });
});

describe('buildAgentSigningContextFromConfig fingerprint validation', () => {
  it('throws when provider fingerprint is shorter than 16 characters', () => {
    const shortFpProvider = {
      keyid: 'k1',
      algorithm: 'ed25519',
      fingerprint: 'tooshort',
      async sign() { return new Uint8Array(64); },
    };

    assert.throws(
      () => buildAgentSigningContextFromConfig(
        { provider: shortFpProvider, agent_url: 'https://buyer.example.com' },
        'https://seller.example.com'
      ),
      err => err.message.includes('at least 16 characters')
    );
  });

  it('succeeds when fingerprint is exactly 16 characters', () => {
    const provider = new InMemorySigningProvider({
      keyid: 'k1',
      algorithm: 'ed25519',
      privateKey: { d: 'aaaaaaaaaaaaaaaa', kty: 'OKP', crv: 'Ed25519' },
    });
    assert.ok(provider.fingerprint.length >= 16);

    const ctx = buildAgentSigningContextFromConfig(
      { provider, agent_url: 'https://buyer.example.com' },
      'https://seller.example.com'
    );
    assert.ok(ctx.cacheKey.startsWith('sig='));
  });
});

describe('cache-isolation: two providers, same kid, distinct fingerprints', () => {
  it('get distinct cacheKey and capabilityCacheKey entries', () => {
    const providerA = new InMemorySigningProvider({
      keyid: 'shared-kid',
      algorithm: 'ed25519',
      privateKey: { d: 'key-material-tenant-a', kty: 'OKP', crv: 'Ed25519' },
    });
    const providerB = new InMemorySigningProvider({
      keyid: 'shared-kid',
      algorithm: 'ed25519',
      privateKey: { d: 'key-material-tenant-b', kty: 'OKP', crv: 'Ed25519' },
    });

    assert.notStrictEqual(providerA.fingerprint, providerB.fingerprint,
      'distinct private keys must produce distinct fingerprints');

    const sellerUri = 'https://seller.example.com';
    const ctxA = buildAgentSigningContextFromConfig(
      { provider: providerA, agent_url: 'https://buyer-a.example.com' },
      sellerUri
    );
    const ctxB = buildAgentSigningContextFromConfig(
      { provider: providerB, agent_url: 'https://buyer-b.example.com' },
      sellerUri
    );

    assert.notStrictEqual(ctxA.cacheKey, ctxB.cacheKey,
      'transport cache keys must differ for distinct key material');
    assert.notStrictEqual(ctxA.capabilityCacheKey, ctxB.capabilityCacheKey,
      'capability cache keys must differ for distinct key material');
  });
});
