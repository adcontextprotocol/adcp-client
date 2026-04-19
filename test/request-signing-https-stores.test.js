const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  HttpsJwksResolver,
  HttpsRevocationStore,
  RequestSignatureError,
  verifyRequestSignature,
  signRequest,
  InMemoryReplayStore,
} = require('../dist/lib/signing');
const { SsrfRefusedError } = require('../dist/lib/net');

// ────────────────────────────────────────────────────────────
// Test key material (public + private pair shipped with compliance vectors).
// ────────────────────────────────────────────────────────────

const keysPath = path.join(
  __dirname,
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
if (!primary) throw new Error('Expected test-ed25519-2026 in compliance key fixtures');

const primaryPublic = withoutPrivate(primary);
const primaryPrivate = { ...primary, d: primary._private_d_for_test_only };
delete primaryPrivate._private_d_for_test_only;

function withoutPrivate(k) {
  const copy = { ...k };
  delete copy._private_d_for_test_only;
  delete copy.d;
  return copy;
}

// Build a JWKS-serving stub. The test can mutate `state` mid-run to simulate
// key rotation or ETag responses.
async function startJwksServer(initial) {
  const state = {
    jwks: initial.jwks,
    etag: initial.etag ?? 'v1',
    cacheControl: initial.cacheControl ?? 'max-age=60',
    requestCount: 0,
    ifNoneMatchSeen: [],
  };
  const server = http.createServer((req, res) => {
    state.requestCount += 1;
    const ifNoneMatch = req.headers['if-none-match'];
    state.ifNoneMatchSeen.push(ifNoneMatch ?? null);
    if (ifNoneMatch && ifNoneMatch === state.etag) {
      res.writeHead(304, { etag: state.etag, 'cache-control': state.cacheControl });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/jwk-set+json',
      etag: state.etag,
      'cache-control': state.cacheControl,
    });
    res.end(JSON.stringify({ keys: state.jwks }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/jwks.json`;
  return { url, state, stop: () => new Promise(r => server.close(() => r())) };
}

// ────────────────────────────────────────────────────────────
// HttpsJwksResolver
// ────────────────────────────────────────────────────────────

describe('HttpsJwksResolver', () => {
  it('fetches and caches keys on first resolve()', async () => {
    const server = await startJwksServer({ jwks: [primaryPublic] });
    try {
      const resolver = new HttpsJwksResolver(server.url, { allowPrivateIp: true });
      const jwk = await resolver.resolve('test-ed25519-2026');
      assert.ok(jwk, 'returned a JWK for known kid');
      assert.strictEqual(jwk.kid, 'test-ed25519-2026');
      assert.strictEqual(server.state.requestCount, 1);

      // A second resolve() for the same kid within the cache window hits the
      // cache and does NOT refetch.
      await resolver.resolve('test-ed25519-2026');
      assert.strictEqual(server.state.requestCount, 1, 'second resolve is a cache hit');
    } finally {
      await server.stop();
    }
  });

  it('refetches lazily on unknown kid once the cooldown has elapsed', async () => {
    // Start with only the primary key published. Later add a rotated key.
    const server = await startJwksServer({ jwks: [primaryPublic] });
    try {
      let clock = 1_000;
      const resolver = new HttpsJwksResolver(server.url, {
        allowPrivateIp: true,
        minCooldownSeconds: 30,
        now: () => clock,
      });

      // Prime the cache.
      const first = await resolver.resolve('test-ed25519-2026');
      assert.ok(first);
      assert.strictEqual(server.state.requestCount, 1);

      // Server adds a new kid. First resolve for the new kid inside the
      // cooldown should NOT trigger a refetch (we just fetched at clock=1000).
      const rotated = { ...primaryPublic, kid: 'test-ed25519-rotated' };
      server.state.jwks = [primaryPublic, rotated];
      server.state.etag = 'v2';

      const insideCooldown = await resolver.resolve('test-ed25519-rotated');
      assert.strictEqual(insideCooldown, null, 'unknown kid inside cooldown returns null without refetch');
      assert.strictEqual(server.state.requestCount, 1);

      // Advance past cooldown; now unknown-kid resolve MUST trigger a refetch
      // and pick up the rotated key.
      clock += 60;
      const refreshed = await resolver.resolve('test-ed25519-rotated');
      assert.ok(refreshed, 'rotated kid picked up after cooldown');
      assert.strictEqual(refreshed.kid, 'test-ed25519-rotated');
      assert.strictEqual(server.state.requestCount, 2);
      // Refresh sent If-None-Match from our cached ETag (v1).
      assert.strictEqual(server.state.ifNoneMatchSeen[1], 'v1');
    } finally {
      await server.stop();
    }
  });

  it('sends If-None-Match + handles 304 without dropping the cache', async () => {
    const server = await startJwksServer({ jwks: [primaryPublic], etag: 'stable-v1', cacheControl: 'max-age=1' });
    try {
      let clock = 1_000;
      const resolver = new HttpsJwksResolver(server.url, {
        allowPrivateIp: true,
        minCooldownSeconds: 0, // let every refetch fire for this test
        now: () => clock,
      });
      const first = await resolver.resolve('test-ed25519-2026');
      assert.ok(first);
      assert.strictEqual(server.state.requestCount, 1);

      // Advance past the max-age=1 expiry.
      clock += 5;

      // Second resolve hits the server; server returns 304. Cache stays intact.
      const second = await resolver.resolve('test-ed25519-2026');
      assert.ok(second, 'cache survived 304');
      assert.strictEqual(second.kid, 'test-ed25519-2026');
      assert.strictEqual(server.state.requestCount, 2);
      assert.strictEqual(server.state.ifNoneMatchSeen[1], 'stable-v1');

      // The 304 response carried `cache-control: max-age=1`. Bump the clock
      // by less than that and the third resolve MUST hit the cache — the
      // 304 path properly extended `expiresAt`.
      clock += 0; // still within the new max-age window from the 304
      const third = await resolver.resolve('test-ed25519-2026');
      assert.ok(third, 'third resolve served from cache within refreshed max-age');
      assert.strictEqual(server.state.requestCount, 2, 'third resolve did not refetch');
    } finally {
      await server.stop();
    }
  });

  it('304 adopts a new ETag when the origin emits one', async () => {
    const server = await startJwksServer({ jwks: [primaryPublic], etag: 'orig', cacheControl: 'max-age=1' });
    try {
      let clock = 1_000;
      const resolver = new HttpsJwksResolver(server.url, {
        allowPrivateIp: true,
        minCooldownSeconds: 0,
        now: () => clock,
      });
      await resolver.resolve('test-ed25519-2026');
      assert.strictEqual(server.state.requestCount, 1);

      // Origin rotates its ETag while keeping the same keyset — next
      // request returns 304 but with a new ETag. Our resolver must adopt it
      // so future If-None-Match requests match what the origin is willing
      // to validate against.
      server.state.etag = 'rotated';
      clock += 5;
      await resolver.resolve('test-ed25519-2026');
      assert.strictEqual(server.state.requestCount, 2);

      // Advance again — the If-None-Match should now carry the rotated ETag.
      clock += 5;
      await resolver.resolve('test-ed25519-2026');
      assert.strictEqual(server.state.ifNoneMatchSeen[2], 'rotated');
    } finally {
      await server.stop();
    }
  });

  it('keeps serving the cached keyset when refresh transiently fails', async () => {
    const server = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=1' });
    let clock = 1_000;
    const resolver = new HttpsJwksResolver(server.url, {
      allowPrivateIp: true,
      minCooldownSeconds: 0,
      now: () => clock,
    });
    // Prime cache.
    await resolver.resolve('test-ed25519-2026');
    // Server goes dark — subsequent refetches will throw.
    await server.stop();

    clock += 5; // past the cache-control max-age=1

    // `resolve()` swallows refresh errors when a cache snapshot exists.
    const still = await resolver.resolve('test-ed25519-2026');
    assert.ok(still, 'stale key still served when the origin is unreachable');
    assert.strictEqual(still.kid, 'test-ed25519-2026');
  });

  it('refuses a JWKS URL pointing at IMDS even under allowPrivateIp', async () => {
    const resolver = new HttpsJwksResolver('http://169.254.169.254/latest/iam/security-credentials/', {
      allowPrivateIp: true,
    });
    await assert.rejects(
      () => resolver.resolve('any-kid'),
      err => {
        assert.ok(err instanceof SsrfRefusedError, `expected SsrfRefusedError, got ${err?.constructor?.name}`);
        assert.strictEqual(err.code, 'always_blocked_address');
        return true;
      }
    );
  });

  it('refuses a non-HTTPS JWKS URL by default', async () => {
    const resolver = new HttpsJwksResolver('http://example.com/.well-known/jwks.json');
    await assert.rejects(
      () => resolver.resolve('any'),
      err => err instanceof SsrfRefusedError
    );
  });

  it('end-to-end rotation: verifier picks up a new kid without process restart', async () => {
    // Seller's JWKS endpoint starts with just the primary kid, then rotates.
    const server = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=0' });
    try {
      let clock = 2_000;
      const resolver = new HttpsJwksResolver(server.url, {
        allowPrivateIp: true,
        minCooldownSeconds: 0,
        now: () => clock,
      });

      // Build and verify a signed request using the primary key — establishes
      // the flow works end-to-end before rotation.
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';
      const signed = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
        { now: () => clock, windowSeconds: 300, nonce: 'rotation-before-aaaa' }
      );
      const result1 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed.headers, body },
        {
          capability: { supported: true, covers_content_digest: 'either', required_for: [] },
          jwks: resolver,
          replayStore: new InMemoryReplayStore(),
          revocationStore: {
            async isRevoked() {
              return false;
            },
          },
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result1.status, 'verified');
      assert.strictEqual(result1.keyid, 'test-ed25519-2026');

      // Rotate: server now publishes a second key pair.
      const rotatedKid = 'test-ed25519-rotated-2027';
      const rotatedPublic = { ...primaryPublic, kid: rotatedKid };
      const rotatedPrivate = { ...primaryPrivate, kid: rotatedKid };
      server.state.jwks = [primaryPublic, rotatedPublic];
      server.state.etag = 'v-after-rotation';

      // Advance clock past cooldown so the unknown-kid branch will refetch.
      clock += 60;

      // Sign a new request with the rotated key.
      const signedRotated = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: rotatedKid, alg: 'ed25519', privateKey: rotatedPrivate },
        { now: () => clock, windowSeconds: 300, nonce: 'rotation-after-bbbb' }
      );
      const result2 = await verifyRequestSignature(
        { method: 'POST', url, headers: signedRotated.headers, body },
        {
          capability: { supported: true, covers_content_digest: 'either', required_for: [] },
          jwks: resolver,
          replayStore: new InMemoryReplayStore(),
          revocationStore: {
            async isRevoked() {
              return false;
            },
          },
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result2.status, 'verified');
      assert.strictEqual(result2.keyid, rotatedKid);
    } finally {
      await server.stop();
    }
  });
});

// ────────────────────────────────────────────────────────────
// HttpsRevocationStore
// ────────────────────────────────────────────────────────────

async function startRevocationServer(initial) {
  const state = {
    snapshot: initial,
    requestCount: 0,
  };
  const server = http.createServer((_, res) => {
    state.requestCount += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.snapshot));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/revocation.json`;
  return { url, state, stop: () => new Promise(r => server.close(() => r())) };
}

function snapshot({ issuer = 'urn:test', revoked = [], updatedAt, nextUpdateAt }) {
  return {
    issuer,
    updated: new Date(updatedAt * 1000).toISOString(),
    next_update: new Date(nextUpdateAt * 1000).toISOString(),
    revoked_kids: revoked,
    revoked_jtis: [],
  };
}

describe('HttpsRevocationStore', () => {
  it('lazy-fetches the snapshot on first isRevoked() call', async () => {
    const now = 1_000_000;
    const server = await startRevocationServer(
      snapshot({ revoked: ['bad-kid'], updatedAt: now, nextUpdateAt: now + 3600 })
    );
    try {
      const store = new HttpsRevocationStore(server.url, { allowPrivateIp: true, now: () => now });
      assert.strictEqual(await store.isRevoked('bad-kid'), true);
      assert.strictEqual(await store.isRevoked('good-kid'), false);
      assert.strictEqual(server.state.requestCount, 1, 'fetch happens once; subsequent calls hit cache');
    } finally {
      await server.stop();
    }
  });

  it('keeps serving the cached snapshot within grace even when the origin is unreachable', async () => {
    const issuedAt = 1_000_000;
    const server = await startRevocationServer(
      snapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 60, revoked: ['bad-kid'] })
    );
    let clock = issuedAt;
    const store = new HttpsRevocationStore(server.url, {
      allowPrivateIp: true,
      graceSeconds: 120,
      minRefetchIntervalSeconds: 0,
      now: () => clock,
    });
    assert.strictEqual(await store.isRevoked('bad-kid'), true);
    assert.strictEqual(await store.isRevoked('good-kid'), false);
    // Origin goes dark.
    await server.stop();

    // Now past next_update but inside the 120s grace. The store attempts a
    // refresh, fails, and MUST keep serving the cached answer rather than
    // panicking.
    clock = issuedAt + 100; // 40s past next_update, 80s before grace expires
    assert.strictEqual(await store.isRevoked('bad-kid'), true, 'cached revocation still enforced inside grace');
    assert.strictEqual(await store.isRevoked('good-kid'), false, 'cached non-revocation still served inside grace');
  });

  it('refreshes when now > next_update', async () => {
    const issuedAt = 1_000_000;
    const server = await startRevocationServer(
      snapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 600, revoked: [] })
    );
    try {
      let clock = issuedAt;
      const store = new HttpsRevocationStore(server.url, {
        allowPrivateIp: true,
        minRefetchIntervalSeconds: 0,
        now: () => clock,
      });
      // First call: populates cache.
      assert.strictEqual(await store.isRevoked('a'), false);
      assert.strictEqual(server.state.requestCount, 1);

      // Operator publishes a new snapshot — kid 'a' is now revoked.
      const newerIssuedAt = issuedAt + 1200;
      server.state.snapshot = snapshot({
        updatedAt: newerIssuedAt,
        nextUpdateAt: newerIssuedAt + 600,
        revoked: ['a'],
      });

      // Advance past first snapshot's next_update so the store refreshes.
      clock = newerIssuedAt;
      assert.strictEqual(await store.isRevoked('a'), true, 'revoked kid picked up on next call past next_update');
      assert.strictEqual(server.state.requestCount, 2);
    } finally {
      await server.stop();
    }
  });

  it('fails closed with request_signature_revocation_stale when snapshot is past next_update + grace', async () => {
    const issuedAt = 1_000_000;
    const server = await startRevocationServer(
      snapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 60, revoked: [] })
    );
    try {
      let clock = issuedAt;
      const store = new HttpsRevocationStore(server.url, {
        allowPrivateIp: true,
        graceSeconds: 30,
        minRefetchIntervalSeconds: 300, // long enough that no refresh fires during this test
        now: () => clock,
      });
      assert.strictEqual(await store.isRevoked('a'), false);
      // Now shut down the server so refresh attempts fail. The store must
      // keep serving the cached snapshot until grace expires, then fail
      // closed.
      await server.stop();

      // Still inside next_update + grace (60 + 30 = 90s window).
      clock = issuedAt + 80;
      // The store attempts a refresh because now > nextUpdate, but the
      // minRefetchInterval (300s) is far enough that we won't retry — wait,
      // the refresh would fire once because nothing has been tried yet in
      // this window. Let's verify behavior by actually stopping at inside
      // grace first.
      // Bump cooldown by making minRefetchInterval=0 scenarios separate.
      // For this branch, staleness check is the primary assertion.
      clock = issuedAt + 120; // 60 past next_update, beyond 30s grace
      await assert.rejects(
        () => store.isRevoked('a'),
        err => {
          assert.ok(err instanceof RequestSignatureError);
          assert.strictEqual(err.code, 'request_signature_revocation_stale');
          assert.strictEqual(err.failedStep, 9);
          return true;
        }
      );
    } finally {
      // Safe no-op if server already stopped.
      if (!server.stopped) await server.stop().catch(() => {});
    }
  });

  it('refuses a revocation URL pointing at IMDS even under allowPrivateIp', async () => {
    const store = new HttpsRevocationStore('http://169.254.169.254/latest/meta-data/iam/', { allowPrivateIp: true });
    await assert.rejects(
      () => store.isRevoked('any'),
      err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address'
    );
  });

  it('refuses a snapshot whose next_update is more than maxValidityWindow past updated', async () => {
    const issuedAt = 1_000_000;
    // Year 9999 `next_update` would otherwise defeat the grace check forever.
    const server = await startRevocationServer({
      issuer: 'urn:test',
      updated: new Date(issuedAt * 1000).toISOString(),
      next_update: '9999-12-31T23:59:59Z',
      revoked_kids: [],
      revoked_jtis: [],
    });
    try {
      const store = new HttpsRevocationStore(server.url, {
        allowPrivateIp: true,
        maxValidityWindowSeconds: 7 * 24 * 3600,
        now: () => issuedAt,
      });
      await assert.rejects(() => store.isRevoked('any'), /validity window/);
    } finally {
      await server.stop();
    }
  });

  it('refuses a snapshot whose next_update is not strictly after updated', async () => {
    const issuedAt = 1_000_000;
    const server = await startRevocationServer({
      issuer: 'urn:test',
      updated: new Date(issuedAt * 1000).toISOString(),
      next_update: new Date(issuedAt * 1000).toISOString(),
      revoked_kids: [],
      revoked_jtis: [],
    });
    try {
      const store = new HttpsRevocationStore(server.url, { allowPrivateIp: true, now: () => issuedAt });
      await assert.rejects(() => store.isRevoked('any'), /pre-dates itself/);
    } finally {
      await server.stop();
    }
  });

  it('refuses a snapshot whose issuer does not match expectedIssuer', async () => {
    const issuedAt = 1_000_000;
    const server = await startRevocationServer(
      snapshot({ issuer: 'urn:wrong', updatedAt: issuedAt, nextUpdateAt: issuedAt + 600, revoked: [] })
    );
    try {
      const store = new HttpsRevocationStore(server.url, {
        allowPrivateIp: true,
        expectedIssuer: 'urn:right',
        now: () => issuedAt,
      });
      await assert.rejects(() => store.isRevoked('any'), /issuer.*urn:wrong.*expected.*urn:right/);
    } finally {
      await server.stop();
    }
  });

  it('end-to-end: freshly-revoked kid is rejected at verifier step 9 on next request', async () => {
    const issuedAt = 1_000_000;
    const server = await startRevocationServer(
      snapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 600, revoked: [] })
    );
    const jwksServer = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=600' });
    try {
      let clock = issuedAt;
      const jwks = new HttpsJwksResolver(jwksServer.url, { allowPrivateIp: true, now: () => clock });
      const revocationStore = new HttpsRevocationStore(server.url, {
        allowPrivateIp: true,
        minRefetchIntervalSeconds: 0,
        now: () => clock,
      });

      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';
      const signedBefore = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
        { now: () => clock, windowSeconds: 300, nonce: 'revoke-before-aaaaaaa' }
      );
      const before = await verifyRequestSignature(
        { method: 'POST', url, headers: signedBefore.headers, body },
        {
          capability: { supported: true, covers_content_digest: 'either', required_for: [] },
          jwks,
          replayStore: new InMemoryReplayStore(),
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(before.status, 'verified');

      // Operator publishes revocation.
      const newerIssuedAt = issuedAt + 1200;
      server.state.snapshot = snapshot({
        updatedAt: newerIssuedAt,
        nextUpdateAt: newerIssuedAt + 600,
        revoked: ['test-ed25519-2026'],
      });

      // Advance clock past the first snapshot's next_update so the store refreshes.
      clock = newerIssuedAt;

      const signedAfter = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: primaryPrivate },
        { now: () => clock, windowSeconds: 300, nonce: 'revoke-after-bbbbbbbb' }
      );
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signedAfter.headers, body },
            {
              capability: { supported: true, covers_content_digest: 'either', required_for: [] },
              jwks,
              replayStore: new InMemoryReplayStore(),
              revocationStore,
              now: () => clock,
              operation: 'create_media_buy',
            }
          ),
        err => err instanceof RequestSignatureError && err.code === 'request_signature_key_revoked'
      );
    } finally {
      await server.stop();
      await jwksServer.stop();
    }
  });
});
