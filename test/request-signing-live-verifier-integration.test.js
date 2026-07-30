/**
 * Live-verifier integration tests: HttpsJwksResolver + HttpsRevocationStore
 * composed inside verifyRequestSignature across multi-step flows where the
 * stores' upstream state changes mid-session.
 *
 * Closes #609.
 *
 * Scope: a CI-only dev artifact. The scenarios here are NOT a specialism
 * grader — they test that our library's HTTPS stores glue into the verifier
 * pipeline correctly under state transitions. External agents have no way to
 * let a remote tester drive their JWKS / revocation snapshots, so this file
 * intentionally lives outside `@adcp/sdk/testing/storyboard/request-signing`
 * (the operator-facing grader stays pure spec-conformance) and is not exposed
 * via any public barrel. It runs as part of `npm test` and in CI.
 *
 * What's tested here that isn't covered elsewhere:
 *   - The per-store unit tests (`request-signing-https-stores.test.js`)
 *     exercise each store in isolation.
 *   - The AdCP Verified grader (`request-signing-grader-*.test.js`) drives
 *     the 28 RFC 9421 vectors against a `StaticJwksResolver` + an
 *     `InMemoryRevocationStore` — pure spec conformance, no HTTPS I/O.
 *   - This file runs the real HTTPS stores behind verifyRequestSignature
 *     across sequences of requests, with origin-side state transitions
 *     between them, so rotation / revocation-publish / fail-closed paths
 *     and middleware SSRF-surface paths are exercised end-to-end.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  HttpsJwksResolver,
  HttpsRevocationStore,
  RequestSignatureError,
  verifyRequestSignature,
  signRequest,
  InMemoryReplayStore,
  createExpressVerifier,
} = require('../dist/lib/signing');
const { SsrfRefusedError } = require('../dist/lib/net');
const { startJwksServer, startRevocationServer, revocationSnapshot } = require('./helpers/signing-origin-servers');

// ────────────────────────────────────────────────────────────
// Key material — shared test vectors shipped with the spec.
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

function withPublicShape(k) {
  const copy = { ...k };
  delete copy._private_d_for_test_only;
  delete copy.d;
  return copy;
}

function withPrivateShape(k) {
  const copy = { ...k, d: k._private_d_for_test_only };
  delete copy._private_d_for_test_only;
  return copy;
}

const primaryPublic = withPublicShape(primary);
const primaryPrivate = withPrivateShape(primary);

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function buildSigned({ kid, privateKey, clock, nonce, url, body }) {
  return signRequest(
    { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
    { keyid: kid, alg: 'ed25519', privateKey },
    { now: () => clock, windowSeconds: 300, nonce }
  );
}

function baseCapability() {
  return { supported: true, covers_content_digest: 'either', required_for: [] };
}

function neverRevoked() {
  return {
    async isRevoked() {
      return false;
    },
  };
}

/**
 * Helper to wrap a test body that owns one or more servers. Guarantees every
 * server's `stop()` runs even if setup throws before the try block would have
 * been entered (a real regression this file is meant to catch shouldn't
 * manifest as a CI hang).
 */
async function withServers(servers, body) {
  try {
    await body();
  } finally {
    for (const s of servers) {
      if (s && typeof s.stop === 'function') {
        await s.stop().catch(() => {});
      }
    }
  }
}

// ────────────────────────────────────────────────────────────
// Scenario: mid-run key rotation picked up without process restart.
// ────────────────────────────────────────────────────────────

describe('live-verifier integration: JWKS rotation', () => {
  it('verifier picks up a rotated kid after cooldown without a restart', async () => {
    const jwksServer = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=0' });
    await withServers([jwksServer], async () => {
      let clock = 10_000;
      const jwks = new HttpsJwksResolver(jwksServer.url, {
        allowPrivateIp: true,
        minCooldownSeconds: 0,
        now: () => clock,
      });
      const replay = new InMemoryReplayStore();
      const revocation = neverRevoked();
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';

      const signed1 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'rotate-before-nonce-aaaa',
        url,
        body,
      });
      const result1 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed1.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore: revocation,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result1.status, 'verified');
      assert.strictEqual(result1.keyid, 'test-ed25519-2026');
      const jwksCountAfterReq1 = jwksServer.state.requestCount;

      // Rotation: add a second kid.
      const rotatedKid = 'test-ed25519-rotated-2027';
      const rotatedPublic = { ...primaryPublic, kid: rotatedKid };
      const rotatedPrivate = { ...primaryPrivate, kid: rotatedKid };
      jwksServer.state.jwks = [primaryPublic, rotatedPublic];
      jwksServer.state.etag = 'after-rotation';

      // Advance past cooldown so the resolver's unknown-kid path refetches.
      clock += 60;

      const signed2 = buildSigned({
        kid: rotatedKid,
        privateKey: rotatedPrivate,
        clock,
        nonce: 'rotate-after-nonce-bbbb',
        url,
        body,
      });
      const result2 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed2.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore: revocation,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result2.status, 'verified');
      assert.strictEqual(result2.keyid, rotatedKid);
      // Pin down that the verifier actually re-fetched — without this a
      // regression that serves stale cache but happens to include both kids
      // would pass by coincidence.
      assert.ok(jwksServer.state.requestCount > jwksCountAfterReq1, 'resolver refetched JWKS for unknown kid');

      // Request 3: back to the original kid, still in rotation.
      const signed3 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'rotate-back-nonce-cccc',
        url,
        body,
      });
      const result3 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed3.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore: revocation,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result3.status, 'verified');
      assert.strictEqual(result3.keyid, 'test-ed25519-2026');
    });
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: mid-run revocation publish propagates on the next verify.
// ────────────────────────────────────────────────────────────

describe('live-verifier integration: revocation publish', () => {
  it('freshly-revoked kid is rejected at step 9 after next_update passes', async () => {
    const jwksServer = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=3600' });
    const issuedAt = 20_000;
    const revocationServer = await startRevocationServer(
      revocationSnapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 600, revoked: [] })
    );
    await withServers([jwksServer, revocationServer], async () => {
      let clock = issuedAt;
      const jwks = new HttpsJwksResolver(jwksServer.url, { allowPrivateIp: true, now: () => clock });
      const revocationStore = new HttpsRevocationStore(revocationServer.url, {
        allowPrivateIp: true,
        minRefetchIntervalSeconds: 0,
        now: () => clock,
      });
      const replay = new InMemoryReplayStore();
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';

      const signed1 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'revoke-before-nonce-aaaa',
        url,
        body,
      });
      const result1 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed1.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result1.status, 'verified');
      const revocationCountAfterReq1 = revocationServer.state.requestCount;
      assert.strictEqual(revocationCountAfterReq1, 1, 'revocation snapshot fetched once on first verify');

      // Operator publishes revocation.
      const newIssuedAt = issuedAt + 1_200;
      revocationServer.state.snapshot = revocationSnapshot({
        updatedAt: newIssuedAt,
        nextUpdateAt: newIssuedAt + 600,
        revoked: ['test-ed25519-2026'],
      });

      // Advance past the first snapshot's next_update to trigger refresh.
      clock = newIssuedAt;

      const signed2 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'revoke-after-nonce-bbbb',
        url,
        body,
      });
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed2.headers, body },
            {
              capability: baseCapability(),
              jwks,
              replayStore: replay,
              revocationStore,
              now: () => clock,
              operation: 'create_media_buy',
            }
          ),
        err =>
          err instanceof RequestSignatureError && err.code === 'request_signature_key_revoked' && err.failedStep === 9
      );
      // Tight assertion: the revocation refresh actually fired. Without this,
      // a regression that skipped the refresh would still reject req 2 if the
      // replay store happened to collide, producing a false pass for a
      // different failure path.
      assert.ok(
        revocationServer.state.requestCount > revocationCountAfterReq1,
        'revocation snapshot refetched after next_update'
      );
    });
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: revocation origin goes silent past grace → fail-closed.
// ────────────────────────────────────────────────────────────

describe('live-verifier integration: stale-revocation fail-closed', () => {
  it('past next_update + grace with origin silent → request_signature_revocation_stale', async () => {
    const jwksServer = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=3600' });
    const issuedAt = 30_000;
    const revocationServer = await startRevocationServer(
      revocationSnapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 60, revoked: [] })
    );
    await withServers([jwksServer, revocationServer], async () => {
      let clock = issuedAt;
      const jwks = new HttpsJwksResolver(jwksServer.url, { allowPrivateIp: true, now: () => clock });
      const revocationStore = new HttpsRevocationStore(revocationServer.url, {
        allowPrivateIp: true,
        graceSeconds: 30,
        minRefetchIntervalSeconds: 300,
        now: () => clock,
      });
      const replay = new InMemoryReplayStore();
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';

      // Seed the cache.
      const signed1 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'stale-before-nonce-aaaa',
        url,
        body,
      });
      const result1 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed1.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result1.status, 'verified');

      // Origin stops responding. Advance past next_update + grace.
      await revocationServer.stop();
      clock = issuedAt + 60 /* nextUpdate */ + 31 /* past 30s grace */;

      const signed2 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'stale-after-nonce-bbbb',
        url,
        body,
      });
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed2.headers, body },
            {
              capability: baseCapability(),
              jwks,
              replayStore: replay,
              revocationStore,
              now: () => clock,
              operation: 'create_media_buy',
            }
          ),
        err =>
          err instanceof RequestSignatureError &&
          err.code === 'request_signature_revocation_stale' &&
          err.failedStep === 9
      );
    });
  });

  it('garbage response during grace window → snapshot validation throws, but cached snapshot still enforced', async () => {
    // Likelier real incident than a silent origin: a misconfigured CDN starts
    // returning a 500 or a non-JSON body after next_update passes. We want to
    // keep serving the cached snapshot until grace expires — the alternative
    // (immediately fail-closed on first misbehavior) would create cascading
    // outages on routine revocation endpoint blips.
    //
    // Key property this test guards against: a regression that cleared the
    // cached snapshot on refresh-failure (substituting an empty revocation
    // set) would ACCEPT a request signed with a kid the snapshot had
    // previously revoked. We pin that down by keeping an
    // `already-revoked-kid` in the JWKS and asserting it stays rejected
    // during grace.
    const alreadyRevokedKid = 'already-revoked-kid';
    const alreadyRevokedPublic = { ...primaryPublic, kid: alreadyRevokedKid };
    const alreadyRevokedPrivate = { ...primaryPrivate, kid: alreadyRevokedKid };

    const jwksServer = await startJwksServer({
      jwks: [primaryPublic, alreadyRevokedPublic],
      cacheControl: 'max-age=3600',
    });
    const issuedAt = 30_500;
    const revocationServer = await startRevocationServer(
      revocationSnapshot({
        updatedAt: issuedAt,
        nextUpdateAt: issuedAt + 60,
        revoked: [alreadyRevokedKid],
      })
    );
    await withServers([jwksServer, revocationServer], async () => {
      let clock = issuedAt;
      const jwks = new HttpsJwksResolver(jwksServer.url, { allowPrivateIp: true, now: () => clock });
      const revocationStore = new HttpsRevocationStore(revocationServer.url, {
        allowPrivateIp: true,
        graceSeconds: 120,
        minRefetchIntervalSeconds: 0,
        now: () => clock,
      });
      const replay = new InMemoryReplayStore();
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';

      // Seed the cache — req 1 with the non-revoked primary kid establishes
      // the snapshot in memory.
      const signed1 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'garbage-before-nonce-aa',
        url,
        body,
      });
      const result1 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed1.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result1.status, 'verified');

      // Origin breaks: 500 with HTML body.
      revocationServer.state.responseOverride = (_req, res) => {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<html>origin is down</html>');
      };

      // Inside grace window but past next_update.
      clock = issuedAt + 90; // 30s past next_update, 90s before grace expires

      // (a) A non-revoked kid still verifies — cache enforced, non-revoked path.
      const signed2 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'garbage-during-nonce-bb',
        url,
        body,
      });
      const result2 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed2.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(result2.status, 'verified', 'cached snapshot still enforced during grace despite origin 500');

      // (b) A previously-revoked kid is still rejected at step 9 — cache
      // enforced, revoked path. This is the regression-catcher: a refresh
      // failure that silently cleared the cache would accept this request.
      const signed3 = buildSigned({
        kid: alreadyRevokedKid,
        privateKey: alreadyRevokedPrivate,
        clock,
        nonce: 'garbage-during-revoked-cc',
        url,
        body,
      });
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed3.headers, body },
            {
              capability: baseCapability(),
              jwks,
              replayStore: replay,
              revocationStore,
              now: () => clock,
              operation: 'create_media_buy',
            }
          ),
        err =>
          err instanceof RequestSignatureError && err.code === 'request_signature_key_revoked' && err.failedStep === 9
      );

      // Past grace → fail-closed regardless of which kid or whether the
      // origin is silent or returning garbage.
      clock = issuedAt + 60 + 121; // 1s past grace
      const signed4 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'garbage-past-nonce-dddd',
        url,
        body,
      });
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed4.headers, body },
            {
              capability: baseCapability(),
              jwks,
              replayStore: replay,
              revocationStore,
              now: () => clock,
              operation: 'create_media_buy',
            }
          ),
        err => err instanceof RequestSignatureError && err.code === 'request_signature_revocation_stale'
      );
    });
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: SSRF refusal propagates through the verifier (and middleware).
// ────────────────────────────────────────────────────────────

describe('live-verifier integration: JWKS SSRF refusal propagates through verifier', () => {
  it('a JWKS URL pointing at IMDS is refused with SsrfRefusedError', async () => {
    const jwks = new HttpsJwksResolver('http://169.254.169.254/latest/iam/security-credentials/', {
      allowPrivateIp: true,
    });
    const replay = new InMemoryReplayStore();
    const revocation = neverRevoked();
    const clock = 40_000;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"plan_id":"plan_001"}';
    const signed = buildSigned({
      kid: 'test-ed25519-2026',
      privateKey: primaryPrivate,
      clock,
      nonce: 'ssrf-nonce-aaaaaaaaa',
      url,
      body,
    });
    await assert.rejects(
      () =>
        verifyRequestSignature(
          { method: 'POST', url, headers: signed.headers, body },
          {
            capability: baseCapability(),
            jwks,
            replayStore: replay,
            revocationStore: revocation,
            now: () => clock,
            operation: 'create_media_buy',
          }
        ),
      err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address'
    );
  });

  it('a revocation URL pointing at a private IP is refused before any request verifies', async () => {
    const jwksServer = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=3600' });
    await withServers([jwksServer], async () => {
      const jwks = new HttpsJwksResolver(jwksServer.url, { allowPrivateIp: true, now: () => 50_000 });
      const revocationStore = new HttpsRevocationStore('https://127.0.0.1:1/revocation.json', { now: () => 50_000 });
      const replay = new InMemoryReplayStore();
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';
      const signed = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock: 50_000,
        nonce: 'ssrf-revocation-nonce-xx',
        url,
        body,
      });
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed.headers, body },
            {
              capability: baseCapability(),
              jwks,
              replayStore: replay,
              revocationStore,
              now: () => 50_000,
              operation: 'create_media_buy',
            }
          ),
        err => err instanceof SsrfRefusedError && err.code === 'private_address'
      );
    });
  });

  it('SSRF refusal reaches next(err) in middleware, NOT mapped to a 401', async () => {
    // The middleware's catch only maps `RequestSignatureError` to 401; every
    // other error (including SsrfRefusedError) falls through to `next(err)`.
    // Without this assertion, a future regression that wrapped SSRF failures
    // as `request_signature_key_unknown` — a plausible shortcut someone might
    // take in the JWKS resolver — would silently leak SSRF refusals as 401,
    // trained the caller to retry, and shift the attack surface.
    const jwks = new HttpsJwksResolver('http://169.254.169.254/latest/iam/', { allowPrivateIp: true });
    const replay = new InMemoryReplayStore();
    const revocation = neverRevoked();
    const clock = 60_000;

    const signed = buildSigned({
      kid: 'test-ed25519-2026',
      privateKey: primaryPrivate,
      clock,
      nonce: 'ssrf-middleware-nonce-x',
      url: 'https://seller.example.com/adcp/create_media_buy',
      body: '{}',
    });

    const middleware = createExpressVerifier({
      capability: baseCapability(),
      jwks,
      replayStore: replay,
      revocationStore: revocation,
      now: () => clock,
      resolveOperation: () => 'create_media_buy',
      getUrl: () => 'https://seller.example.com/adcp/create_media_buy',
    });

    const req = {
      method: 'POST',
      url: '/adcp/create_media_buy',
      headers: signed.headers,
      rawBody: '{}',
    };

    let statusCalls = 0;
    const res = {
      status() {
        statusCalls += 1;
        return {
          set() {
            return { json() {} };
          },
        };
      },
    };

    let nextErr;
    await middleware(req, res, err => {
      nextErr = err;
    });

    assert.strictEqual(statusCalls, 0, 'middleware did NOT call res.status — SSRF was not mapped to 401');
    assert.ok(nextErr instanceof SsrfRefusedError, `expected SsrfRefusedError at next(err), got ${nextErr}`);
    assert.strictEqual(nextErr.code, 'always_blocked_address');
    assert.strictEqual(req.verifiedSigner, undefined, 'no verifiedSigner attached on failure');
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: rotation and revocation concurrently.
//
// Both stores operate on the same verifier across a sequence of requests.
// Exercises the "store A's refresh invalidated store B's cache state"
// interaction that can't surface when each is tested in isolation.
// ────────────────────────────────────────────────────────────

describe('live-verifier integration: rotation + revocation combined', () => {
  it('a single verifier instance handles rotation and revocation in one flow', async () => {
    const jwksServer = await startJwksServer({ jwks: [primaryPublic], cacheControl: 'max-age=0' });
    const issuedAt = 70_000;
    const revocationServer = await startRevocationServer(
      revocationSnapshot({ updatedAt: issuedAt, nextUpdateAt: issuedAt + 600, revoked: [] })
    );
    await withServers([jwksServer, revocationServer], async () => {
      let clock = issuedAt;
      const jwks = new HttpsJwksResolver(jwksServer.url, {
        allowPrivateIp: true,
        minCooldownSeconds: 0,
        now: () => clock,
      });
      const revocationStore = new HttpsRevocationStore(revocationServer.url, {
        allowPrivateIp: true,
        minRefetchIntervalSeconds: 0,
        now: () => clock,
      });
      const replay = new InMemoryReplayStore();
      const url = 'https://seller.example.com/adcp/create_media_buy';
      const body = '{"plan_id":"plan_001"}';

      // Req 1: baseline verified with primary kid.
      const signed1 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'combo-step-1-nonce-aaaa',
        url,
        body,
      });
      const r1 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed1.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(r1.status, 'verified');

      // Rotate JWKS.
      const rotatedKid = 'test-ed25519-rotated-2027';
      const rotatedPublic = { ...primaryPublic, kid: rotatedKid };
      const rotatedPrivate = { ...primaryPrivate, kid: rotatedKid };
      jwksServer.state.jwks = [primaryPublic, rotatedPublic];
      jwksServer.state.etag = 'post-rotation';
      clock += 60;

      // Req 2: rotated kid verifies after the lazy refetch.
      const signed2 = buildSigned({
        kid: rotatedKid,
        privateKey: rotatedPrivate,
        clock,
        nonce: 'combo-step-2-nonce-bbbb',
        url,
        body,
      });
      const r2 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed2.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(r2.status, 'verified');
      assert.strictEqual(r2.keyid, rotatedKid);

      // Publish a revocation on the rotated kid.
      const newIssuedAt = clock + 60;
      revocationServer.state.snapshot = revocationSnapshot({
        updatedAt: newIssuedAt,
        nextUpdateAt: newIssuedAt + 600,
        revoked: [rotatedKid],
      });
      clock = issuedAt + 700; // past initial next_update

      // Req 3: rotated kid is now revoked → rejected at step 9.
      const signed3 = buildSigned({
        kid: rotatedKid,
        privateKey: rotatedPrivate,
        clock,
        nonce: 'combo-step-3-nonce-cccc',
        url,
        body,
      });
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed3.headers, body },
            {
              capability: baseCapability(),
              jwks,
              replayStore: replay,
              revocationStore,
              now: () => clock,
              operation: 'create_media_buy',
            }
          ),
        err =>
          err instanceof RequestSignatureError && err.code === 'request_signature_key_revoked' && err.failedStep === 9
      );

      // Req 4: primary kid (not rotated, not revoked) must still verify.
      const signed4 = buildSigned({
        kid: 'test-ed25519-2026',
        privateKey: primaryPrivate,
        clock,
        nonce: 'combo-step-4-nonce-dddd',
        url,
        body,
      });
      const r4 = await verifyRequestSignature(
        { method: 'POST', url, headers: signed4.headers, body },
        {
          capability: baseCapability(),
          jwks,
          replayStore: replay,
          revocationStore,
          now: () => clock,
          operation: 'create_media_buy',
        }
      );
      assert.strictEqual(r4.status, 'verified');
      assert.strictEqual(r4.keyid, 'test-ed25519-2026');
    });
  });
});
