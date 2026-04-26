const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fc = require('fast-check');

const {
  signRequest,
  signRequestAsync,
  signWebhook,
  signWebhookAsync,
  createSigningFetchAsync,
  buildAgentSigningContext,
  derEcdsaToP1363,
  SigningProviderAlgorithmMismatchError,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  verifyRequestSignature,
  RequestSignatureError,
} = require('../dist/lib/signing/index.js');

const { InMemorySigningProvider, signerKeyToProvider } = require('../dist/lib/signing/testing.js');

const KEYS_PATH = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const keysData = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));
const keysByKid = new Map(keysData.keys.map(k => [k.kid, k]));

function publicJwkFor(kid) {
  const k = keysByKid.get(kid);
  if (!k) throw new Error(`Test key '${kid}' not in vectors`);
  // Strip the test-only private scalar before returning a "public" JWK.
  const { _private_d_for_test_only, ...publicPart } = k;
  return publicPart;
}

function privateJwkFor(kid) {
  const k = keysByKid.get(kid);
  if (!k) throw new Error(`Test key '${kid}' not in vectors`);
  const { _private_d_for_test_only, ...rest } = k;
  return { ...rest, d: _private_d_for_test_only };
}

const SAMPLE_REQUEST = {
  method: 'POST',
  url: 'https://seller.example.com/adcp/create_media_buy',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plan_id: 'plan_001' }),
};

const SAMPLE_OPTIONS = {
  now: () => 1776520800,
  nonce: 'KXYnfEfJ0PBRZXQyVXfVQA',
  windowSeconds: 300,
};

describe('signRequestAsync produces byte-identical output to signRequest (Ed25519)', () => {
  test('matches sync signature for the same request', async () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };

    const sync = signRequest(SAMPLE_REQUEST, key, SAMPLE_OPTIONS);
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    const async_ = await signRequestAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);

    assert.strictEqual(async_.headers.Signature, sync.headers.Signature);
    assert.strictEqual(async_.headers['Signature-Input'], sync.headers['Signature-Input']);
    assert.strictEqual(async_.signatureBase, sync.signatureBase);
  });
});

describe('signRequestAsync produces byte-equivalent output to signRequest (ECDSA-P256)', () => {
  test('signature is valid (ECDSA is non-deterministic, so verify-equivalence not byte-equality)', async () => {
    const kid = 'test-es256-2026';
    const key = { keyid: kid, alg: 'ecdsa-p256-sha256', privateKey: privateJwkFor(kid) };
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ecdsa-p256-sha256',
      privateKey: privateJwkFor(kid),
    });

    const sync = signRequest(SAMPLE_REQUEST, key, SAMPLE_OPTIONS);
    const async_ = await signRequestAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);

    // Signature base is deterministic; sig bytes differ per ECDSA non-determinism.
    assert.strictEqual(async_.signatureBase, sync.signatureBase);
    assert.strictEqual(async_.headers['Signature-Input'], sync.headers['Signature-Input']);
    assert.notStrictEqual(async_.headers.Signature, undefined);
    assert.match(async_.headers.Signature, /^sig1=:[A-Za-z0-9_-]+:$/);
  });
});

describe('signWebhookAsync is functionally equivalent to signWebhook', () => {
  test('headers and base match for Ed25519', async () => {
    const kid = 'test-ed25519-2026';
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    const sync = signWebhook(SAMPLE_REQUEST, key, SAMPLE_OPTIONS);
    const async_ = await signWebhookAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);
    assert.strictEqual(async_.headers.Signature, sync.headers.Signature);
    assert.strictEqual(async_.headers['Signature-Input'], sync.headers['Signature-Input']);
    assert.strictEqual(async_.signatureBase, sync.signatureBase);
  });
});

describe('createSigningFetchAsync rejects non-UTF-8 byte bodies', () => {
  test('Uint8Array with invalid UTF-8 throws a clear TypeError instead of silently lossy-converting', async () => {
    const kid = 'test-ed25519-2026';
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    const upstream = async () => new Response('ok', { status: 200 });
    const fetchSigned = createSigningFetchAsync(upstream, provider);
    // 0xff 0xfe is not valid UTF-8 (continuation bytes without a start).
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    await assert.rejects(
      () =>
        fetchSigned('https://seller.example.com/adcp/create_media_buy', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: invalidUtf8,
        }),
      err => err instanceof TypeError && /not valid UTF-8/.test(err.message)
    );
  });
});

describe('createSigningFetchAsync routes through the provider', () => {
  test('signs POST requests and forwards to upstream', async () => {
    const kid = 'test-ed25519-2026';
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    let captured;
    const upstream = async (url, init) => {
      captured = { url, init };
      return new Response('ok', { status: 200 });
    };
    const fetchSigned = createSigningFetchAsync(upstream, provider);
    await fetchSigned('https://seller.example.com/adcp/create_media_buy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: 'p1' }),
    });
    assert.ok(captured.init.headers.Signature, 'Signature header was set');
    assert.match(captured.init.headers['Signature-Input'], /keyid="test-ed25519-2026"/);
    assert.match(captured.init.headers['Signature-Input'], /alg="ed25519"/);
  });

  test('skips GET requests by default', async () => {
    const kid = 'test-ed25519-2026';
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    let captured;
    const upstream = async (url, init) => {
      captured = init;
      return new Response('ok', { status: 200 });
    };
    const fetchSigned = createSigningFetchAsync(upstream, provider);
    await fetchSigned('https://seller.example.com/health', { method: 'GET' });
    assert.strictEqual(captured?.headers, undefined);
  });
});

describe('buildAgentSigningContext: cache isolation', () => {
  test('two providers with same kid but different fingerprint get distinct cacheKeys', () => {
    const kid = 'test-ed25519-2026';
    const provA = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });

    // Fabricate a second provider advertising the same kid+algorithm but a
    // distinct fingerprint, simulating two tenants holding different KMS keys
    // that happen to publish the same `kid` string.
    const provB = {
      keyid: kid,
      algorithm: 'ed25519',
      fingerprint: 'distinct-fingerprint-for-tenant-b',
      sign: async () => new Uint8Array(64),
    };

    const ctxA = buildAgentSigningContext({
      id: 'a',
      name: 'A',
      agent_uri: 'https://seller.example.com',
      protocol: 'mcp',
      request_signing: { kind: 'provider', provider: provA, agent_url: 'https://a.example.com' },
    });
    const ctxB = buildAgentSigningContext({
      id: 'b',
      name: 'B',
      agent_uri: 'https://seller.example.com',
      protocol: 'mcp',
      request_signing: { kind: 'provider', provider: provB, agent_url: 'https://b.example.com' },
    });

    assert.notStrictEqual(ctxA.cacheKey, ctxB.cacheKey);
    assert.notStrictEqual(ctxA.capabilityCacheKey, ctxB.capabilityCacheKey);
  });

  test('SDK defensively hashes provider fingerprint — low-entropy fingerprints still isolated by kid', () => {
    // Two providers, same kid, both supplying a stupid `fingerprint: 'x'`.
    // SDK-side hash includes algorithm+kid so they collide ONLY if all three
    // (algorithm, kid, fingerprint) match. Demonstrate that swapping kid
    // produces a different cache key even when the fingerprint is constant.
    const provA = {
      keyid: 'kid-A',
      algorithm: 'ed25519',
      fingerprint: 'x',
      sign: async () => new Uint8Array(64),
    };
    const provB = {
      keyid: 'kid-B',
      algorithm: 'ed25519',
      fingerprint: 'x',
      sign: async () => new Uint8Array(64),
    };
    const ctxA = buildAgentSigningContext({
      id: 'a',
      name: 'A',
      agent_uri: 'https://seller.example.com',
      protocol: 'mcp',
      request_signing: { kind: 'provider', provider: provA, agent_url: 'https://a.example.com' },
    });
    const ctxB = buildAgentSigningContext({
      id: 'b',
      name: 'B',
      agent_uri: 'https://seller.example.com',
      protocol: 'mcp',
      request_signing: { kind: 'provider', provider: provB, agent_url: 'https://b.example.com' },
    });
    assert.notStrictEqual(ctxA.cacheKey, ctxB.cacheKey);
  });

  test('cacheKey is deterministic across context rebuilds for the same provider', () => {
    const kid = 'test-ed25519-2026';
    const buildCtx = () => {
      const provider = new InMemorySigningProvider({
        keyid: kid,
        algorithm: 'ed25519',
        privateKey: privateJwkFor(kid),
      });
      return buildAgentSigningContext({
        id: 'a',
        name: 'A',
        agent_uri: 'https://seller.example.com',
        protocol: 'mcp',
        request_signing: { kind: 'provider', provider, agent_url: 'https://a.example.com' },
      });
    };
    const c1 = buildCtx();
    const c2 = buildCtx();
    assert.strictEqual(c1.cacheKey, c2.cacheKey);
    assert.strictEqual(c1.capabilityCacheKey, c2.capabilityCacheKey);
  });

  test('algorithm flip on the same kid+fingerprint produces a different cacheKey', () => {
    const provA = {
      keyid: 'shared-kid',
      algorithm: 'ed25519',
      fingerprint: 'shared-fp',
      sign: async () => new Uint8Array(64),
    };
    const provB = {
      keyid: 'shared-kid',
      algorithm: 'ecdsa-p256-sha256',
      fingerprint: 'shared-fp',
      sign: async () => new Uint8Array(64),
    };
    const ctxA = buildAgentSigningContext({
      id: 'a',
      name: 'A',
      agent_uri: 'https://seller.example.com',
      protocol: 'mcp',
      request_signing: { kind: 'provider', provider: provA, agent_url: 'https://a.example.com' },
    });
    const ctxB = buildAgentSigningContext({
      id: 'b',
      name: 'B',
      agent_uri: 'https://seller.example.com',
      protocol: 'mcp',
      request_signing: { kind: 'provider', provider: provB, agent_url: 'https://b.example.com' },
    });
    assert.notStrictEqual(ctxA.cacheKey, ctxB.cacheKey);
  });
});

describe('InMemorySigningProvider production gate', () => {
  test('throws when NODE_ENV=production without ack env', () => {
    const original = { node_env: process.env.NODE_ENV, ack: process.env.ADCP_ALLOW_IN_MEMORY_SIGNER };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ADCP_ALLOW_IN_MEMORY_SIGNER;
      assert.throws(
        () =>
          new InMemorySigningProvider({
            keyid: 'k',
            algorithm: 'ed25519',
            privateKey: privateJwkFor('test-ed25519-2026'),
          }),
        /InMemorySigningProvider blocked in production/
      );
    } finally {
      if (original.node_env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original.node_env;
      if (original.ack === undefined) delete process.env.ADCP_ALLOW_IN_MEMORY_SIGNER;
      else process.env.ADCP_ALLOW_IN_MEMORY_SIGNER = original.ack;
    }
  });

  test('allows when NODE_ENV=production and ack flag set', () => {
    const original = { node_env: process.env.NODE_ENV, ack: process.env.ADCP_ALLOW_IN_MEMORY_SIGNER };
    try {
      process.env.NODE_ENV = 'production';
      process.env.ADCP_ALLOW_IN_MEMORY_SIGNER = '1';
      const p = new InMemorySigningProvider({
        keyid: 'k',
        algorithm: 'ed25519',
        privateKey: privateJwkFor('test-ed25519-2026'),
      });
      assert.strictEqual(p.keyid, 'k');
    } finally {
      if (original.node_env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original.node_env;
      if (original.ack === undefined) delete process.env.ADCP_ALLOW_IN_MEMORY_SIGNER;
      else process.env.ADCP_ALLOW_IN_MEMORY_SIGNER = original.ack;
    }
  });

  test('allows in test/development environments without ack', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      const p = new InMemorySigningProvider({
        keyid: 'k',
        algorithm: 'ed25519',
        privateKey: privateJwkFor('test-ed25519-2026'),
      });
      assert.strictEqual(p.algorithm, 'ed25519');
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  test('rejects JWK without private scalar', () => {
    assert.throws(
      () =>
        new InMemorySigningProvider({
          keyid: 'k',
          algorithm: 'ed25519',
          privateKey: publicJwkFor('test-ed25519-2026'),
        }),
      /private_key.*must include.*d|private scalar/i
    );
  });
});

describe('signerKeyToProvider adapter', () => {
  test('produces a provider whose fingerprint matches the legacy inline derivation', () => {
    const kid = 'test-ed25519-2026';
    const priv = privateJwkFor(kid);
    const provider = signerKeyToProvider({ keyid: kid, alg: 'ed25519', privateKey: priv });

    const expected = createHash('sha256').update(kid).update('\0').update(priv.d).digest('hex').slice(0, 16);
    assert.strictEqual(provider.fingerprint, expected);
    assert.strictEqual(provider.keyid, kid);
    assert.strictEqual(provider.algorithm, 'ed25519');
  });
});

describe('SigningProviderAlgorithmMismatchError', () => {
  test('exposes expected/actual/providerKid fields', () => {
    const err = new SigningProviderAlgorithmMismatchError('ed25519', 'EC_SIGN_P256_SHA256', 'addie-2026');
    assert.strictEqual(err.expected, 'ed25519');
    assert.strictEqual(err.actual, 'EC_SIGN_P256_SHA256');
    assert.strictEqual(err.providerKid, 'addie-2026');
    assert.match(err.message, /declared algorithm 'ed25519'/);
    assert.match(err.message, /underlying key is 'EC_SIGN_P256_SHA256'/);
  });
});

describe('property: signRequest (sync) and signRequestAsync share canonicalization', () => {
  // Locks the parallel structure of signer.ts and signer-async.ts. If a future
  // change adds a mandatory component, header-handling tweak, or default change
  // to one path without the other, this property fails. Ed25519 is deterministic,
  // so we can assert byte-identical Signature output as well as base equality.
  const kid = 'test-ed25519-2026';

  function buildArbitrary() {
    return fc.record({
      method: fc.constantFrom('POST', 'PUT', 'DELETE', 'PATCH'),
      pathSegments: fc.array(
        fc.string({ minLength: 1, maxLength: 16, unit: fc.constantFrom('a', 'b', 'c', 'media_buy', '_') }),
        { minLength: 1, maxLength: 4 }
      ),
      // Body is JSON-encoded (UTF-8 by construction) — the signer covers
      // exact wire bytes, so feeding it valid JSON bytes is the realistic case.
      body: fc.option(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 12, unit: fc.constantFrom('a', 'b', 'c', '_', '0', '1') }),
          fc.oneof(
            fc.string({ maxLength: 32, unit: fc.constantFrom('a', 'b', 'c', ' ', '0') }),
            fc.integer({ min: -1000, max: 1000 })
          ),
          { minKeys: 0, maxKeys: 6 }
        ),
        { nil: undefined }
      ),
      coverContentDigest: fc.boolean(),
      now: fc.integer({ min: 1700000000, max: 1900000000 }),
      windowSeconds: fc.integer({ min: 1, max: 300 }),
      nonce: fc.string({ minLength: 16, maxLength: 22, unit: fc.constantFrom('a', 'b', 'c', '0', '_', '-') }),
    });
  }

  test('sync and async produce identical signatureBase, Signature-Input, and Signature for Ed25519', async () => {
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });
    const key = { keyid: kid, alg: 'ed25519', privateKey: privateJwkFor(kid) };

    await fc.assert(
      fc.asyncProperty(buildArbitrary(), async input => {
        const request = {
          method: input.method,
          url: 'https://seller.example.com/' + input.pathSegments.join('/'),
          headers: { 'Content-Type': 'application/json' },
          body: input.body === undefined ? '' : JSON.stringify(input.body),
        };
        const opts = {
          coverContentDigest: input.coverContentDigest,
          now: () => input.now,
          windowSeconds: input.windowSeconds,
          nonce: input.nonce,
        };
        const sync = signRequest(request, key, opts);
        const async_ = await signRequestAsync(request, provider, opts);

        // Same canonicalization → same base, same Signature-Input, same Ed25519 sig.
        assert.strictEqual(async_.signatureBase, sync.signatureBase);
        assert.strictEqual(async_.headers['Signature-Input'], sync.headers['Signature-Input']);
        assert.strictEqual(async_.headers.Signature, sync.headers.Signature);
        return true;
      }),
      { numRuns: 50 }
    );
  });

  test('sync and async produce identical signatureBase + Signature-Input for ECDSA-P256 (signature bytes vary by non-determinism)', async () => {
    const ecdsaKid = 'test-es256-2026';
    const provider = new InMemorySigningProvider({
      keyid: ecdsaKid,
      algorithm: 'ecdsa-p256-sha256',
      privateKey: privateJwkFor(ecdsaKid),
    });
    const key = { keyid: ecdsaKid, alg: 'ecdsa-p256-sha256', privateKey: privateJwkFor(ecdsaKid) };

    await fc.assert(
      fc.asyncProperty(buildArbitrary(), async input => {
        const request = {
          method: input.method,
          url: 'https://seller.example.com/' + input.pathSegments.join('/'),
          headers: { 'Content-Type': 'application/json' },
          body: input.body === undefined ? '' : JSON.stringify(input.body),
        };
        const opts = {
          coverContentDigest: input.coverContentDigest,
          now: () => input.now,
          windowSeconds: input.windowSeconds,
          nonce: input.nonce,
        };
        const sync = signRequest(request, key, opts);
        const async_ = await signRequestAsync(request, provider, opts);

        // ECDSA is non-deterministic so Signature bytes legitimately differ.
        // The canonicalization invariant lives in the base + Signature-Input;
        // both ECDSA branches must compute these identically.
        assert.strictEqual(async_.signatureBase, sync.signatureBase);
        assert.strictEqual(async_.headers['Signature-Input'], sync.headers['Signature-Input']);
        return true;
      }),
      { numRuns: 50 }
    );
  });
});

describe('end-to-end: provider-signed request verifies under the SDK verifier', () => {
  function makeVerifierContext(kid) {
    const publicJwk = publicJwkFor(kid);
    return {
      jwks: new StaticJwksResolver([publicJwk]),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      capability: {
        supported: true,
        covers_content_digest: 'either',
        required_for: ['create_media_buy'],
      },
    };
  }

  test('Ed25519 round-trip succeeds via signRequestAsync + InMemorySigningProvider', async () => {
    const kid = 'test-ed25519-2026';
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });

    const signed = await signRequestAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);
    const ctx = makeVerifierContext(kid);

    const result = await verifyRequestSignature(
      { ...SAMPLE_REQUEST, headers: signed.headers },
      {
        ...ctx,
        operation: 'create_media_buy',
        now: SAMPLE_OPTIONS.now,
      }
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, kid);
  });

  test('ECDSA-P256 round-trip succeeds via signRequestAsync + InMemorySigningProvider', async () => {
    const kid = 'test-es256-2026';
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ecdsa-p256-sha256',
      privateKey: privateJwkFor(kid),
    });

    const signed = await signRequestAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);
    const ctx = makeVerifierContext(kid);

    const result = await verifyRequestSignature(
      { ...SAMPLE_REQUEST, headers: signed.headers },
      {
        ...ctx,
        operation: 'create_media_buy',
        now: SAMPLE_OPTIONS.now,
      }
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, kid);
  });

  test('round-trip via createSigningFetchAsync + verifier (full HTTP path)', async () => {
    const kid = 'test-ed25519-2026';
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: privateJwkFor(kid),
    });

    let captured;
    const upstream = async (url, init) => {
      captured = { url, init };
      return new Response('ok', { status: 200 });
    };
    const fetchSigned = createSigningFetchAsync(upstream, provider, {
      now: SAMPLE_OPTIONS.now,
      nonce: SAMPLE_OPTIONS.nonce,
    });
    await fetchSigned('https://seller.example.com/adcp/create_media_buy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: 'plan_001' }),
    });

    const verifyRequest = {
      method: 'POST',
      url: captured.url,
      headers: captured.init.headers,
      body: captured.init.body,
    };
    const ctx = makeVerifierContext(kid);
    const result = await verifyRequestSignature(verifyRequest, {
      ...ctx,
      operation: 'create_media_buy',
      now: SAMPLE_OPTIONS.now,
    });
    assert.strictEqual(result.status, 'verified');
  });

  test('webhook async round-trip: signWebhookAsync produces signatures the webhook verifier accepts', async () => {
    const { verifyWebhookSignature } = require('../dist/lib/signing/index.js');
    const kid = 'test-ed25519-2026';
    const webhookKey = keysData.keys.find(k => k.adcp_use === 'webhook-signing');
    if (!webhookKey) {
      // Conformance vectors don't include a separate webhook-signing key; reuse
      // the request-signing key with a synthetic adcp_use override for the
      // verifier's purpose check.
      const provider = new InMemorySigningProvider({
        keyid: kid,
        algorithm: 'ed25519',
        privateKey: privateJwkFor(kid),
      });
      const signed = await signWebhookAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);
      // Just assert headers shape — full verifier round-trip needs a webhook-purpose key.
      assert.match(signed.headers['Signature-Input'], /tag="adcp\/webhook-signing\/v1"/);
      assert.match(signed.headers['Signature-Input'], /keyid="test-ed25519-2026"/);
      assert.ok(signed.headers['Content-Digest'].startsWith('sha-256='));
      return;
    }
    const webhookKid = webhookKey.kid;
    const webhookPriv = { ...webhookKey, d: webhookKey._private_d_for_test_only };
    delete webhookPriv._private_d_for_test_only;
    const provider = new InMemorySigningProvider({
      keyid: webhookKid,
      algorithm: 'ed25519',
      privateKey: webhookPriv,
    });
    const signed = await signWebhookAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);
    const ctx = makeVerifierContext(webhookKid);
    const result = await verifyWebhookSignature(
      { ...SAMPLE_REQUEST, headers: signed.headers },
      { ...ctx, now: SAMPLE_OPTIONS.now }
    );
    assert.strictEqual(result.status, 'verified');
  });

  test('verifier rejects when provider signs with a different private key than the JWKS publishes', async () => {
    const kid = 'test-ed25519-2026';
    // Sign with the wrong key but advertise the right `kid`. Verifier must
    // reject — the signature won't validate against the JWKS public key.
    const wrongKey = privateJwkFor('test-ed25519-2026');
    // Mutate `d` to a different valid Ed25519 scalar (also from the test
    // vectors): use the gov-signing key's scalar but keep `kid` advertising
    // the request-signing identity.
    const wrongJwk = { ...wrongKey, d: privateJwkFor('test-gov-2026').d };
    const provider = new InMemorySigningProvider({
      keyid: kid,
      algorithm: 'ed25519',
      privateKey: wrongJwk,
    });

    const signed = await signRequestAsync(SAMPLE_REQUEST, provider, SAMPLE_OPTIONS);
    const ctx = makeVerifierContext(kid);

    await assert.rejects(
      () =>
        verifyRequestSignature(
          { ...SAMPLE_REQUEST, headers: signed.headers },
          {
            ...ctx,
            operation: 'create_media_buy',
            now: SAMPLE_OPTIONS.now,
          }
        ),
      err => err instanceof RequestSignatureError && /signature_invalid|key_purpose|key_unknown/.test(err.code)
    );
  });
});

describe('derEcdsaToP1363', () => {
  test('strips DER leading-zero padding and left-pads short components', () => {
    // Constructed DER: SEQUENCE { INTEGER 0x00||r, INTEGER s }
    // r has a leading zero (sign-bit guard); s is exactly 32 bytes.
    const r = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0xab)]); // 33 bytes
    const s = Buffer.alloc(32, 0xcd); // 32 bytes
    const der = Buffer.concat([
      Buffer.from([0x30, 2 + r.length + 2 + s.length]),
      Buffer.from([0x02, r.length]),
      r,
      Buffer.from([0x02, s.length]),
      s,
    ]);
    const p1363 = derEcdsaToP1363(new Uint8Array(der), 32);
    assert.strictEqual(p1363.length, 64);
    // r component (after leading-zero strip) is 32 bytes of 0xab.
    assert.deepStrictEqual(p1363.subarray(0, 32), new Uint8Array(Buffer.alloc(32, 0xab)));
    // s component is 32 bytes of 0xcd.
    assert.deepStrictEqual(p1363.subarray(32), new Uint8Array(Buffer.alloc(32, 0xcd)));
  });

  test('left-pads short r/s components', () => {
    const r = Buffer.from([0x01, 0x02]); // 2 bytes
    const s = Buffer.from([0x03]); // 1 byte
    const der = Buffer.concat([
      Buffer.from([0x30, 2 + r.length + 2 + s.length]),
      Buffer.from([0x02, r.length]),
      r,
      Buffer.from([0x02, s.length]),
      s,
    ]);
    const p1363 = derEcdsaToP1363(new Uint8Array(der), 32);
    assert.strictEqual(p1363.length, 64);
    assert.strictEqual(p1363[30], 0x01);
    assert.strictEqual(p1363[31], 0x02);
    assert.strictEqual(p1363[63], 0x03);
  });

  test('throws on malformed DER', () => {
    assert.throws(
      () => derEcdsaToP1363(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 32),
      /SEQUENCE tag/
    );
  });
});
