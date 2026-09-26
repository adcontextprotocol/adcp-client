/**
 * Unit coverage for `createWebhookEmitter` — the publisher-side symmetric
 * counterpart to PR #629's receiver dedup.
 *
 * These tests intercept HTTP via a stub `fetch`, capture every attempt's
 * headers + body, and assert the behaviors three upstream adcp PRs pin:
 *
 *   - Stable `idempotency_key` across retries (#2417).
 *   - 9421 signing by default with fresh `nonce`/`created` per attempt (#2423).
 *   - Compact-separator JSON serialized once and posted byte-identically (#2478).
 *
 * Plus the adcp-client contract: 5xx/429 retry, 4xx terminal, 401 with
 * `WWW-Authenticate: Signature error="webhook_signature_*"` terminal.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const { generateKeyPairSync } = require('node:crypto');

const { createWebhookEmitter, memoryWebhookKeyStore } = require('../../dist/lib/server/webhook-emitter.js');
const { verifyWebhookSignature } = require('../../dist/lib/signing/webhook-verifier.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay.js');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation.js');
const { signerKeyToProvider } = require('../../dist/lib/signing/testing.js');

// ────────────────────────────────────────────────────────────
// Retry-delay normalization
// ────────────────────────────────────────────────────────────

/**
 * A recovery claim that enforces exactly what every bundled durable backend
 * enforces, so a delay this emitter would have rejected surfaces here.
 */
function recordingRecoveryClaim(released) {
  const { assertRetryAfterMs } = require('../../dist/lib/server/webhook-delivery/common.js');
  return {
    leaseExpiresAtMs: Date.now() + 60_000,
    async renew() {
      return true;
    },
    async release(retryAfterMs) {
      assertRetryAfterMs(retryAfterMs);
      released.push(retryAfterMs);
      return true;
    },
    async settle() {
      return true;
    },
  };
}

function suppressingEmitter({ retries, released }) {
  const { signerKey } = makeSignerKey();
  const claim = recordingRecoveryClaim(released);
  return createWebhookEmitter({
    signerKey,
    fetch: async () => {
      throw new Error('no external attempt should be made');
    },
    sleep: async () => {},
    retries,
    deliveryRecovery: {
      durability: 'durable',
      checkpoint() {
        return claim;
      },
      settle() {},
    },
    // Retryable suppression is the path that releases the lease with a backoff.
    authorizeAttempt: () => ({ decision: 'suppress', reason: 'authorization_error', retryable: true }),
  });
}

test('uses the next durable activity-attempt ordinal after recovery', async () => {
  const { signerKey } = makeSignerKey();
  const observed = [];
  const emitter = createWebhookEmitter({
    signerKey,
    publisherScope: 'publisher-recovery-attempts',
    tenantScope: 'tenant-recovery-attempts',
    fetch: async () => ({ status: 204, headers: { get: () => undefined } }),
    resolveAttemptOrdinal: () => 4,
    onAttempt: attempt => observed.push(attempt.attempt),
  });
  const result = await emitter.emitRecovered({
    key: {
      publisherScope: 'publisher-recovery-attempts',
      tenantScope: 'tenant-recovery-attempts',
      deliveryId: 'delivery-recovery-attempts',
    },
    snapshot: {
      url: 'https://buyer.example/webhook',
      payload: { notification_type: 'reporting.status_changed' },
      authentication: null,
      retries: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    },
    attemptCount: 2,
    leaseExpiresAtMs: Date.now() + 60_000,
    async renew() {
      return true;
    },
    async release() {
      return true;
    },
    async settle() {
      return true;
    },
  });
  assert.equal(result.delivered, true);
  assert.deepEqual(observed, [4], 'a recovered run must continue after attempts 1-3 from the first run');
});

test('does not POST after an awaited observer loses the recovery lease', async () => {
  const { signerKey } = makeSignerKey();
  const fetch = stubFetch([{ status: 204 }]);
  let ownsLease = true;
  const claim = {
    ...recordingRecoveryClaim([]),
    async renew() {
      return ownsLease;
    },
  };
  const emitter = createWebhookEmitter({
    signerKey,
    fetch,
    publisherScope: 'publisher-observer-fence',
    tenantScope: 'tenant-observer-fence',
    deliveryRecovery: {
      durability: 'durable',
      checkpoint: () => claim,
      settle() {},
    },
    async onAttempt() {
      await Promise.resolve();
      ownsLease = false;
    },
  });
  await assert.rejects(
    () => emitter.emit({ url: 'https://buyer.example/webhook', payload: {}, delivery_id: 'delivery-observer-fence' }),
    /recovery lease was lost/
  );
  assert.equal(fetch.calls.length, 0);
});

test('releases a retryable suppression when the configured backoff is fractional', async () => {
  // The recovery contract requires an integer retryAfterMs, but the configured
  // delays were only clamped for sign, never coerced. A fractional
  // initialDelayMs therefore produced a fractional backoff, and releasing a
  // retryable suppression threw instead of releasing — leaving the delivery
  // leased until its lease expired.
  //
  // This is the fractional case only: on attempt 1 with no jitter the backoff is
  // well under the ceiling, so it does not exercise the output clamp. The
  // ceiling is covered separately below.
  const released = [];
  const emitter = suppressingEmitter({
    retries: { maxAttempts: 3, initialDelayMs: 250.5, maxDelayMs: 900_000_000.5, jitter: 0 },
    released,
  });

  const result = await emitter.emit({
    url: 'http://x/h',
    payload: { timestamp: 'stable' },
    delivery_id: 'delivery.fractional-backoff',
  });

  assert.strictEqual(result.delivered, false);
  assert.strictEqual(result.terminal, false, 'a retryable suppression stays retryable');
  assert.strictEqual(result.attempts, 0, 'nothing was sent');
  assert.deepStrictEqual(
    result.errors,
    [],
    'releasing the lease must not fail: a held lease blocks recovery until it expires'
  );
  assert.deepStrictEqual(released, [250], 'the fractional delay floors to a whole millisecond');
});

test('keeps a jittered ceiling-height backoff at or under the retry-after ceiling', async () => {
  // End-to-end ceiling case. The suppression is reported on attempt 1, so the
  // exponential term contributes nothing and no attempt bound is in play —
  // what exercises the clamp is initialDelayMs already sitting at the ceiling,
  // which positive jitter then pushes base + offset above. Only the clamp on
  // backoffDelay's own output keeps the value inside the range release()
  // accepts.
  const released = [];
  const emitter = suppressingEmitter({
    retries: { initialDelayMs: 604_800_000, maxDelayMs: 604_800_000, jitter: 1 },
    released,
  });

  // Repeated because the jitter offset is random: a single draw could land low.
  for (let round = 0; round < 40; round += 1) {
    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { timestamp: 'stable' },
      delivery_id: `delivery.ceiling-backoff-${round}`,
    });
    assert.deepStrictEqual(result.errors, [], 'the lease is released on every draw');
  }
  assert.strictEqual(released.length, 40);
  for (const value of released) {
    assert.ok(
      Number.isSafeInteger(value) && value >= 0 && value <= 604_800_000,
      `retryAfterMs must stay a whole millisecond within the ceiling, got ${value}`
    );
  }
  assert.ok(
    released.some(value => value > 302_400_000),
    'the draws really do reach the top of the range, so the clamp is exercised'
  );
});

test('saturates an infinite configured delay instead of retrying immediately', async () => {
  // Collapsing every non-finite value to 0 turned "wait as long as possible"
  // into a zero-delay retry burst. Positive Infinity saturates to the ceiling.
  for (const [label, retries] of [
    ['maxDelayMs', { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: Number.POSITIVE_INFINITY, jitter: 0 }],
    [
      'initialDelayMs',
      { maxAttempts: 3, initialDelayMs: Number.POSITIVE_INFINITY, maxDelayMs: Number.POSITIVE_INFINITY, jitter: 0 },
    ],
  ]) {
    const released = [];
    const emitter = suppressingEmitter({ retries, released });
    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { timestamp: 'stable' },
      delivery_id: `delivery.infinite-${label}`,
    });
    assert.deepStrictEqual(result.errors, [], `${label}: the lease is released`);
    assert.strictEqual(released.length, 1, `${label}: released once`);
    assert.ok(released[0] > 0, `${label}: an infinite delay must not become an immediate retry`);
    assert.strictEqual(
      released[0],
      label === 'initialDelayMs' ? 604_800_000 : 1_000,
      `${label}: saturates at the ceiling rather than collapsing to zero`
    );
  }
});

test('floors NaN and negative infinity to zero', async () => {
  for (const [label, initialDelayMs] of [
    ['NaN', Number.NaN],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ]) {
    const released = [];
    const emitter = suppressingEmitter({
      retries: { maxAttempts: 3, initialDelayMs, maxDelayMs: 60_000, jitter: 0 },
      released,
    });
    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { timestamp: 'stable' },
      delivery_id: `delivery.nonfinite-${label}`,
    });
    assert.deepStrictEqual(result.errors, [], `${label}: the lease is released`);
    assert.deepStrictEqual(released, [0], `${label}: carries no backoff intent, so it floors to zero`);
  }
});

// ────────────────────────────────────────────────────────────
// Attempt-bound normalization
// ────────────────────────────────────────────────────────────

/**
 * An emitter whose every external attempt fails retryably, so the number of
 * POSTs it makes is exactly the normalized `maxAttempts`.
 *
 * After `RETRYABLE_ATTEMPT_BUDGET` calls the stub turns terminal. That is not
 * part of the contract under test — it is there so an unbounded `maxAttempts`
 * fails this test with a wrong attempt count instead of spinning forever.
 */
const RETRYABLE_ATTEMPT_BUDGET = 50;

function alwaysFailingEmitter({ retries, released }) {
  const { signerKey } = makeSignerKey();
  const claim = recordingRecoveryClaim(released);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    return {
      status: calls.length > RETRYABLE_ATTEMPT_BUDGET ? 400 : 500,
      headers: { get: () => undefined },
    };
  };
  const emitter = createWebhookEmitter({
    signerKey,
    fetch,
    sleep: async () => {},
    retries,
    deliveryRecovery: {
      durability: 'durable',
      checkpoint() {
        return claim;
      },
      settle() {},
    },
  });
  return { emitter, calls };
}

test('falls back to the default attempt bound when maxAttempts is not finite', async () => {
  // `maxAttempts` bounds a loop rather than a wait, so it cannot saturate the
  // way a delay does; a non-finite value falls back to the default 5.
  //
  // NaN was the live defect. `Math.max(1, Math.floor(NaN))` is NaN, so
  // `attempt <= maxAttempts` was false on the first comparison: the loop ran
  // zero attempts, recorded no terminal outcome, and fell through to
  // `release(0)`. That re-queued the delivery immediately with nothing sent,
  // and the recovery worker would reclaim it on the same terms forever — an
  // unbounded reclaim loop that never posts. Infinity was the other half: it
  // left the bound unbounded rather than merely wrong.
  for (const [label, maxAttempts] of [
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ]) {
    const released = [];
    const { emitter, calls } = alwaysFailingEmitter({
      retries: { maxAttempts, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      released,
    });

    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { timestamp: 'stable' },
      delivery_id: `delivery.attempt-bound-${label}`,
    });

    assert.strictEqual(calls.length, 5, `${label}: posts the default number of attempts`);
    assert.strictEqual(result.attempts, 5, `${label}: reports the attempts it actually made`);
    assert.strictEqual(result.final_status, 500, `${label}: exhausted the bound while still retryable`);
    assert.strictEqual(result.terminal, false, `${label}: a 5xx run stays retryable`);
    assert.deepStrictEqual(released, [0], `${label}: released once for the recovery worker to retry`);
    assert.ok(
      result.attempts > 0,
      `${label}: the lease must never be released from a zero-attempt run — that reclaims forever without posting`
    );
  }
});

test('floors and clamps a finite attempt bound up to one', async () => {
  for (const [label, maxAttempts, expected] of [
    ['fractional', 2.9, 2],
    ['zero', 0, 1],
    ['negative', -3, 1],
  ]) {
    const released = [];
    const { emitter, calls } = alwaysFailingEmitter({
      retries: { maxAttempts, initialDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      released,
    });

    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { timestamp: 'stable' },
      delivery_id: `delivery.attempt-bound-${label}`,
    });

    assert.strictEqual(calls.length, expected, `${label}: posts the normalized number of attempts`);
    assert.strictEqual(result.attempts, expected, `${label}: reports the attempts it actually made`);
  }
});

// ────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────

function makeSignerKey(kid = 'test-key-2026') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return {
    signerKey: {
      keyid: kid,
      alg: 'ed25519',
      privateKey: { ...priv, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['sign'] },
    },
    publicJwk: { ...pub, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['verify'] },
  };
}

/** Stub fetch that records every call and returns a scripted status sequence. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body, headers: init?.headers });
    const next = queue.shift() ?? { status: 200 };
    const headers = new Map(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: next.status,
      headers: { get: name => headers.get(name.toLowerCase()) },
    };
  };
  fn.calls = calls;
  return fn;
}

const noSleep = () => Promise.resolve();

// ────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: happy path', () => {
  test('delivers on first attempt and returns the minted idempotency_key', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const result = await emitter.emit({
      url: 'http://127.0.0.1:9999/webhook',
      payload: { task: { task_id: 'mb-1', status: 'completed' } },
      delivery_id: 'delivery.mb-1',
    });

    assert.strictEqual(result.delivered, true);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.final_status, 204);
    assert.match(result.idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
    assert.strictEqual(fetch.calls.length, 1);

    // Body is compact-separator JSON with the idempotency_key folded in.
    const body = JSON.parse(fetch.calls[0].body);
    assert.strictEqual(body.idempotency_key, result.idempotency_key);
    assert.strictEqual(body.task.task_id, 'mb-1');
    assert.ok(!fetch.calls[0].body.includes(', '), 'body MUST be compact (no spaced separators) per adcp#2478');
  });

  test('produces a 9421 signature the public verifier accepts', async () => {
    const { signerKey, publicJwk } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    await emitter.emit({
      url: 'https://buyer.example/webhook',
      payload: { task: { task_id: 'mb-x' } },
      delivery_id: 'delivery.mb-x',
    });

    const call = fetch.calls[0];
    const verified = await verifyWebhookSignature(
      { method: 'POST', url: call.url, headers: call.headers, body: call.body },
      {
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
      }
    );
    assert.strictEqual(verified.status, 'verified');
  });
});

// ────────────────────────────────────────────────────────────
// Retry + idempotency-key stability
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: retry behavior', () => {
  test('retries on 503 and preserves the idempotency_key across attempts', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 503 }, { status: 503 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const result = await emitter.emit({
      url: 'http://127.0.0.1/hook',
      payload: { event: 'x' },
      delivery_id: 'delivery.retry',
    });

    assert.strictEqual(result.delivered, true);
    assert.strictEqual(fetch.calls.length, 3);

    const keys = fetch.calls.map(c => JSON.parse(c.body).idempotency_key);
    assert.strictEqual(new Set(keys).size, 1, 'idempotency_key MUST be byte-identical across retries (adcp#2417)');
  });

  test('emits fresh nonce per attempt while body bytes stay identical', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 500 }, { status: 500 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    await emitter.emit({
      url: 'http://127.0.0.1/hook',
      payload: { event: 'y' },
      delivery_id: 'delivery.nonce',
    });

    const bodies = fetch.calls.map(c => c.body);
    assert.strictEqual(new Set(bodies).size, 1, 'body bytes MUST be byte-identical across retries');
    const nonces = fetch.calls.map(c => /nonce="([^"]+)"/.exec(c.headers['Signature-Input'])?.[1]);
    assert.strictEqual(new Set(nonces).size, 3, 'nonce MUST be fresh per attempt');
  });

  test('retries on 429', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 429 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.429' });
    assert.strictEqual(result.delivered, true);
    assert.strictEqual(fetch.calls.length, 2);
  });

  test('treats 4xx as terminal', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 400 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.400' });
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('treats 401 with WWW-Authenticate: Signature error=... as terminal', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Signature error="webhook_signature_tag_invalid"' },
      },
    ]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.401' });
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(fetch.calls.length, 1);
    assert.equal(result.errors[0], 'attempt 1: HTTP 401');
  });

  test('max-attempts cap', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch(Array(10).fill({ status: 503 }));
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, retries: { maxAttempts: 3 } });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.cap' });
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(fetch.calls.length, 3);
  });

  test('sanitizes nested provider and transport messages in caller-visible errors', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = async () => {
      throw new Error('fetch failed', { cause: new Error('kms://tenant-secret/key IAM principal denied') });
    };
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, retries: { maxAttempts: 1 } });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.sanitized' });
    assert.deepStrictEqual(result.errors, ['attempt 1: Webhook delivery failed']);
  });

  test('does not copy receiver-controlled response headers into caller-visible errors', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([
      {
        status: 302,
        headers: {
          location: 'https://receiver.invalid/secret-path?token=header-secret',
          'www-authenticate': 'Bearer error_description="header-secret"',
        },
      },
    ]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, retries: { maxAttempts: 1 } });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.header-sanitized' });
    assert.equal(result.errors.length, 1);
    assert.doesNotMatch(result.errors[0], /header-secret|receiver\.invalid/);
  });
});

// ────────────────────────────────────────────────────────────
// Idempotency-key stability across separate emit() calls
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: cross-call stability', () => {
  test('same delivery_id and canonical payload reuse the immutable binding', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const store = memoryWebhookKeyStore();
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, idempotencyKeyStore: store });

    const first = await emitter.emit({ url: 'http://x/h', payload: { value: 1 }, delivery_id: 'delivery.same' });
    const second = await emitter.emit({ url: 'http://x/h', payload: { value: 1 }, delivery_id: 'delivery.same' });

    assert.strictEqual(first.idempotency_key, second.idempotency_key);
  });

  test('same delivery_id plus a different canonical payload fails closed before delivery', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    await emitter.emit({ url: 'http://x/h', payload: { status: 'working' }, delivery_id: 'delivery.conflict' });
    await assert.rejects(
      () =>
        emitter.emit({
          url: 'http://x/h',
          payload: { status: 'completed' },
          delivery_id: 'delivery.conflict',
        }),
      /different canonical payload/
    );
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('different delivery_ids produce different keys', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const a = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.A' });
    const b = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.B' });
    assert.notStrictEqual(a.idempotency_key, b.idempotency_key);
  });

  test('concurrent changed payloads have one atomic binding winner', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const outcomes = await Promise.allSettled([
      emitter.emit({ url: 'http://x/h', payload: { status: 'completed' }, delivery_id: 'delivery.race' }),
      emitter.emit({ url: 'http://x/h', payload: { status: 'failed' }, delivery_id: 'delivery.race' }),
    ]);

    assert.strictEqual(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.strictEqual(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.match(outcomes.find(outcome => outcome.status === 'rejected').reason.message, /different canonical payload/);
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('refuses the retained key after the advertised retry horizon', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 503 }, { status: 204 }]);
    let nowMs = 1_000;
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      retries: { maxAttempts: 1 },
      deliveryRetryHorizonSeconds: 86_400,
      now: () => nowMs,
    });

    const params = { url: 'http://x/h', payload: { status: 'completed' }, delivery_id: 'delivery.expired' };
    await emitter.emit(params);
    nowMs += 86_400_001;
    await assert.rejects(() => emitter.emit(params), /is retired after its retry horizon and MUST NOT be rebound/);
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('an expired durable binding becomes an un-rebindable tombstone', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    let nowMs = 1_000;
    const records = new Map();
    const durableStore = {
      durability: 'durable',
      claim(key, proposed, retentionMs) {
        const storageKey = JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]);
        const existing = records.get(storageKey);
        if (existing?.status === 'bound' && nowMs > existing.retainUntilMs) {
          const retired = { status: 'retired' };
          records.set(storageKey, retired);
          return retired;
        }
        if (existing) return { ...existing };
        const binding = {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs: nowMs,
          retainUntilMs: nowMs + retentionMs,
        };
        records.set(storageKey, binding);
        return { ...binding };
      },
    };
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      deliveryStore: durableStore,
      deliveryRetryHorizonSeconds: 86_400,
      now: () => nowMs,
    });
    const params = { url: 'http://x/h', payload: { status: 'completed' }, delivery_id: 'delivery.retired' };
    await emitter.emit(params);
    nowMs += 86_400_001;
    await assert.rejects(() => emitter.emit(params), /retired after its retry horizon/);
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('shared-store delivery IDs are isolated by trusted publisher and tenant scope', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const store = memoryWebhookKeyStore();
    const publisher = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      deliveryStore: store,
      publisherScope: 'publisher-a',
      tenantScope: 'tenant-a',
    });
    const tenantB = publisher.forTenantScope('tenant-b');
    const first = await publisher.emit({
      url: 'http://x/h',
      payload: { tenant: 'a' },
      delivery_id: 'shared-delivery-id',
    });
    const second = await tenantB.emit({
      url: 'http://x/h',
      payload: { tenant: 'b' },
      delivery_id: 'shared-delivery-id',
    });
    assert.notStrictEqual(first.idempotency_key, second.idempotency_key);
    assert.strictEqual(fetch.calls.length, 2);
  });

  test('tolerates a store-authoritative first-attempt clock slightly ahead of the caller', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const store = {
      durability: 'durable',
      claim(_key, proposed, retentionMs) {
        return {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs: 61_000,
          retainUntilMs: 61_000 + retentionMs,
        };
      },
    };
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, deliveryStore: store, now: () => 1_000 });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.clock-skew' });
    assert.strictEqual(result.delivered, true);
  });

  test('store-authoritative expiry wins when the emitter replica clock is behind', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 503 }, { status: 204 }]);
    let storeNowMs = 61_000;
    const records = new Map();
    const store = {
      durability: 'durable',
      claim(key, proposed, retentionMs) {
        const id = JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]);
        const existing = records.get(id);
        if (existing?.status === 'bound' && storeNowMs > existing.retainUntilMs) {
          const retired = { status: 'retired' };
          records.set(id, retired);
          return retired;
        }
        if (existing) return { ...existing };
        const binding = {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs: storeNowMs,
          retainUntilMs: storeNowMs + retentionMs,
        };
        records.set(id, binding);
        return { ...binding };
      },
    };
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      retries: { maxAttempts: 1 },
      deliveryStore: store,
      now: () => 1_000,
    });
    const params = { url: 'http://x/h', payload: {}, delivery_id: 'delivery.authoritative-expiry' };
    await emitter.emit(params);
    storeNowMs += 86_400_001;
    await assert.rejects(() => emitter.emit(params), /retired after its retry horizon/);
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('rejects lone Unicode surrogates before binding or delivery', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    await assert.rejects(
      () => emitter.emit({ url: 'http://x/h', payload: { value: '\ud800' }, delivery_id: 'delivery.surrogate' }),
      /lone Unicode surrogate/
    );
    await assert.rejects(
      () =>
        emitter.emit({ url: 'http://x/h', payload: { ['\udc00']: 'value' }, delivery_id: 'delivery.surrogate-key' }),
      /lone Unicode surrogate/
    );
    assert.strictEqual(fetch.calls.length, 0);
  });

  test('rejects cycles before binding while allowing repeated acyclic references', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const cyclic = { value: 1 };
    cyclic.self = cyclic;
    await assert.rejects(
      () => emitter.emit({ url: 'http://x/h', payload: cyclic, delivery_id: 'delivery.cycle' }),
      /circular reference/
    );
    const shared = { value: 2 };
    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { first: shared, second: shared },
      delivery_id: 'delivery.shared-dag',
    });
    assert.strictEqual(result.delivered, true);
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('durable recovery checkpoints before claim and settles only final outcomes', async () => {
    const { signerKey } = makeSignerKey();
    const events = [];
    const store = memoryWebhookKeyStore();
    const recovery = {
      durability: 'durable',
      checkpoint(key, snapshot) {
        events.push({ kind: 'checkpoint', key: { ...key }, snapshot: structuredClone(snapshot) });
      },
      settle(key, disposition) {
        events.push({ kind: 'settle', key: { ...key }, disposition });
      },
    };
    const delivered = createWebhookEmitter({
      signerKey,
      fetch: stubFetch([{ status: 204 }]),
      sleep: noSleep,
      deliveryStore: {
        ...store,
        claim(key, proposed, retentionMs) {
          events.push({ kind: 'claim' });
          return store.claim(key, proposed, retentionMs);
        },
      },
      deliveryRecovery: recovery,
    });
    await delivered.emit({ url: 'http://x/h', payload: { timestamp: 'stable' }, delivery_id: 'delivery.outbox-ok' });
    assert.deepStrictEqual(
      events.map(event => event.kind),
      ['checkpoint', 'claim', 'settle']
    );
    assert.strictEqual(events[2].disposition, 'delivered');

    events.length = 0;
    const retryable = createWebhookEmitter({
      signerKey,
      fetch: stubFetch([{ status: 503 }]),
      sleep: noSleep,
      retries: { maxAttempts: 1 },
      deliveryRecovery: recovery,
    });
    await retryable.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.outbox-pending' });
    assert.deepStrictEqual(
      events.map(event => event.kind),
      ['checkpoint']
    );

    events.length = 0;
    const terminal = createWebhookEmitter({
      signerKey,
      fetch: stubFetch([{ status: 400 }]),
      sleep: noSleep,
      deliveryRecovery: recovery,
    });
    await terminal.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.outbox-terminal' });
    assert.deepStrictEqual(
      events.map(event => event.kind),
      ['checkpoint', 'settle']
    );
    assert.strictEqual(events[1].disposition, 'terminal');
  });

  test('snapshots delivery identity, destination, auth, retries, and payload before the durable claim await', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    let releaseClaim;
    const claimGate = new Promise(resolve => {
      releaseClaim = resolve;
    });
    const store = {
      durability: 'durable',
      async claim(_key, proposed, retentionMs) {
        await claimGate;
        return {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs: 1_000,
          retainUntilMs: 1_000 + retentionMs,
        };
      },
    };
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      deliveryStore: store,
      now: () => 1_000,
    });
    const params = {
      url: 'http://original/h',
      payload: { value: 'original' },
      delivery_id: 'delivery.original',
      authentication: { type: 'bearer', token: 'original-token' },
      retries: { maxAttempts: 1 },
    };
    const pending = emitter.emit(params);
    params.url = 'http://mutated/h';
    params.payload.value = 'mutated';
    params.delivery_id = 'delivery.mutated';
    params.authentication.token = 'mutated-token';
    params.retries.maxAttempts = 5;
    releaseClaim();
    const result = await pending;
    assert.strictEqual(result.delivery_id, 'delivery.original');
    assert.strictEqual(fetch.calls[0].url, 'http://original/h');
    assert.strictEqual(fetch.calls[0].headers.authorization, 'Bearer original-token');
    assert.strictEqual(JSON.parse(fetch.calls[0].body).value, 'original');
  });

  test('does not start a later in-process attempt after the horizon', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 503 }, { status: 204 }]);
    let nowMs = 1_000;
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      retries: { maxAttempts: 2 },
      deliveryRetryHorizonSeconds: 86_400,
      now: () => nowMs,
      sleep: async () => {
        nowMs += 86_400_001;
      },
    });

    await assert.rejects(
      () => emitter.emit({ url: 'http://x/h', payload: { status: 'completed' }, delivery_id: 'delivery.loop-expired' }),
      /is retired after its retry horizon and MUST NOT be rebound/
    );
    assert.strictEqual(fetch.calls.length, 1);
  });

  test('validates the advertised retry-horizon bounds', () => {
    const { signerKey } = makeSignerKey();
    assert.throws(
      () => createWebhookEmitter({ signerKey, deliveryRetryHorizonSeconds: 86_399 }),
      /integer from 86400 through 604800/
    );
    assert.throws(
      () => createWebhookEmitter({ signerKey, deliveryRetryHorizonSeconds: 604_801 }),
      /integer from 86400 through 604800/
    );
  });

  test('rejects an injected generator that produces a malformed key', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      generateIdempotencyKey: () => 'tooShort',
    });
    await assert.rejects(
      () => emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.bad' }),
      /does not match/
    );
  });
});

// ────────────────────────────────────────────────────────────
// Legacy HMAC fallback
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: HMAC fallback', () => {
  // The HMAC path fires a deprecation console.warn (covered in
  // test/lib/webhook-hmac-deprecation.test.js). Silence it here so these
  // header-correctness tests don't spam CI output.
  let prevSuppress;
  before(() => {
    prevSuppress = process.env.ADCP_SUPPRESS_HMAC_WARNING;
    process.env.ADCP_SUPPRESS_HMAC_WARNING = '1';
  });
  after(() => {
    if (prevSuppress === undefined) delete process.env.ADCP_SUPPRESS_HMAC_WARNING;
    else process.env.ADCP_SUPPRESS_HMAC_WARNING = prevSuppress;
  });

  test('signs with X-ADCP-Signature when authentication.type = hmac_sha256', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { event: 'hmac' },
      delivery_id: 'delivery.hmac',
      authentication: { type: 'hmac_sha256', secret: 'shh-its-a-secret' },
    });
    assert.strictEqual(result.delivered, true);
    const headers = fetch.calls[0].headers;
    assert.ok(headers['x-adcp-signature']?.startsWith('sha256='));
    assert.ok(headers['x-adcp-timestamp']);
    // No 9421 headers in the HMAC path.
    assert.ok(!headers['Signature'], 'HMAC path MUST NOT emit 9421 Signature header');
    assert.ok(!headers['Signature-Input'], 'HMAC path MUST NOT emit 9421 Signature-Input header');
  });

  test('bearer path sets only Authorization (no body-signing)', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    await emitter.emit({
      url: 'http://x/h',
      payload: { event: 'bearer' },
      delivery_id: 'delivery.bearer',
      authentication: { type: 'bearer', token: 'opaque-token' },
    });
    const headers = fetch.calls[0].headers;
    assert.strictEqual(headers.authorization, 'Bearer opaque-token');
    assert.ok(!headers['x-adcp-signature']);
    assert.ok(!headers['Signature']);
  });
});

// ────────────────────────────────────────────────────────────
// Observability
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: observability', () => {
  test('onAttempt + onAttemptResult fire per attempt with matching attempt number', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 503 }, { status: 204 }]);
    const attempts = [];
    const results = [];
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      onAttempt: info => attempts.push(info),
      onAttemptResult: info => results.push(info),
    });
    await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.obs' });
    assert.strictEqual(attempts.length, 2);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(attempts[0].attempt, 1);
    assert.strictEqual(attempts[1].attempt, 2);
    assert.strictEqual(results[0].willRetry, true);
    assert.strictEqual(results[1].willRetry, false);
    assert.strictEqual(results[1].status, 204);
    assert.ok(attempts.every(info => Number.isSafeInteger(info.payload_size_bytes)));
  });

  test('awaits async observers but isolates their failures from delivery', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const observerErrors = [];
    let resultObserved = false;
    const emitter = createWebhookEmitter({
      signerKey,
      fetch,
      sleep: noSleep,
      async onAttempt() {
        await Promise.resolve();
        throw new Error('telemetry unavailable');
      },
      async onAttemptResult() {
        await Promise.resolve();
        resultObserved = true;
        throw new Error('activity completion unavailable');
      },
      onAttemptObserverError(error, phase) {
        observerErrors.push([phase, error.message]);
      },
    });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, delivery_id: 'delivery.obs-failure' });
    assert.strictEqual(result.delivered, true);
    assert.strictEqual(resultObserved, true);
    assert.deepStrictEqual(observerErrors, [
      ['attempt', 'telemetry unavailable'],
      ['result', 'activity completion unavailable'],
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// signerProvider path (KMS-backed async signing)
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: signerProvider path', () => {
  test('provider-signed webhook produces a 9421 signature the public verifier accepts', async () => {
    const { signerKey, publicJwk } = makeSignerKey();
    const provider = signerKeyToProvider(signerKey);
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerProvider: provider, fetch, sleep: noSleep });

    await emitter.emit({
      url: 'https://buyer.example/webhook',
      payload: { task: { task_id: 'mb-provider' } },
      delivery_id: 'delivery.provider',
    });

    const call = fetch.calls[0];
    const verified = await verifyWebhookSignature(
      { method: 'POST', url: call.url, headers: call.headers, body: call.body },
      {
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
      }
    );
    assert.strictEqual(verified.status, 'verified');
  });

  test('provider path delivers and returns idempotency_key with compact body', async () => {
    const { signerKey } = makeSignerKey();
    const provider = signerKeyToProvider(signerKey);
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerProvider: provider, fetch, sleep: noSleep });

    const result = await emitter.emit({
      url: 'http://127.0.0.1:9999/webhook',
      payload: { task: { task_id: 'mb-provider-2' } },
      delivery_id: 'delivery.provider2',
    });

    assert.strictEqual(result.delivered, true);
    assert.strictEqual(result.attempts, 1);
    assert.match(result.idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
    const body = JSON.parse(fetch.calls[0].body);
    assert.strictEqual(body.idempotency_key, result.idempotency_key);
    assert.ok(!fetch.calls[0].body.includes(', '), 'body MUST be compact (adcp#2478)');
  });

  test('provider path retries on 503 with stable idempotency_key', async () => {
    const { signerKey } = makeSignerKey();
    const provider = signerKeyToProvider(signerKey);
    const fetch = stubFetch([{ status: 503 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerProvider: provider, fetch, sleep: noSleep });

    const result = await emitter.emit({
      url: 'http://127.0.0.1/hook',
      payload: { event: 'retry' },
      delivery_id: 'delivery.provider-retry',
    });

    assert.strictEqual(result.delivered, true);
    assert.strictEqual(result.final_status, 204);
    assert.strictEqual(fetch.calls.length, 2);
    const keys = fetch.calls.map(c => JSON.parse(c.body).idempotency_key);
    assert.strictEqual(new Set(keys).size, 1, 'idempotency_key MUST be stable across retries (adcp#2417)');
  });
});

// ────────────────────────────────────────────────────────────
// Wire-byte equality: signerKey and signerProvider paths produce
// byte-identical signature bases for the same input. Locks the
// "only the dispatch differs" contract claimed in the PR description.
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: signerKey and signerProvider produce byte-identical signature bases', () => {
  test('same body + same nonce + same `created` → identical Signature-Input + signatureBase', async () => {
    const { signerKey } = makeSignerKey('parity-test-2026');
    const provider = signerKeyToProvider(signerKey);

    const fixedNow = 1_700_000_000;
    const fixedNonce = 'parity-test-nonce-fixed-1234';

    // Pin nonce + now via signOptions so the only nondeterministic input
    // (timestamp + nonce) is fixed across both paths. Ed25519 is
    // deterministic, so the resulting Signature bytes will also match —
    // but the strong assertion is the signatureBase, which the verifier
    // is what receivers compute against.
    const { signWebhook, signWebhookAsync } = require('../../dist/lib/signing/index.js');
    const request = {
      method: 'POST',
      url: 'https://example.test/webhook',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'idem-test', operation_id: 'op-1', payload: { hello: 'world' } }),
    };
    const sigOpts = { now: () => fixedNow, nonce: fixedNonce };

    const sync = signWebhook(request, signerKey, sigOpts);
    const async_ = await signWebhookAsync(request, provider, sigOpts);

    // Signature base — the bytes the verifier hashes. Wire equivalence.
    assert.strictEqual(async_.signatureBase, sync.signatureBase);
    // Signature-Input header — same params (kid, alg, tag, nonce, created,
    // expires, components). For Ed25519 (deterministic) the Signature
    // bytes also match.
    assert.strictEqual(async_.headers['Signature-Input'], sync.headers['Signature-Input']);
    assert.strictEqual(async_.headers.Signature, sync.headers.Signature);
    assert.strictEqual(async_.headers['Content-Digest'], sync.headers['Content-Digest']);
  });
});

// ────────────────────────────────────────────────────────────
// Construction-time mutual-exclusion validation
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: construction validation', () => {
  test('production permits tenant binding after constructing an unbound publisher', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const records = new Map();
    const deliveryStore = {
      durability: 'durable',
      claim(key, proposed, retentionMs) {
        const storageKey = JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]);
        const existing = records.get(storageKey);
        if (existing) return { ...existing };
        const record = {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs: 1_000,
          retainUntilMs: 1_000 + retentionMs,
        };
        records.set(storageKey, record);
        return { ...record };
      },
    };
    const recoveryKeys = [];
    const deliveryRecovery = {
      durability: 'durable',
      checkpoint(key) {
        recoveryKeys.push({ ...key });
      },
      settle() {},
    };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let publisher;
    try {
      publisher = createWebhookEmitter({
        signerKey,
        fetch,
        sleep: noSleep,
        now: () => 1_000,
        deliveryStore,
        deliveryRecovery,
        publisherScope: 'publisher',
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    await assert.rejects(
      () => publisher.emit({ url: 'http://x/h', payload: {}, delivery_id: 'unbound-delivery' }),
      /not tenant-bound; call forTenantScope/
    );
    const result = await publisher
      .forTenantScope('trusted-tenant')
      .emit({ url: 'http://x/h', payload: {}, delivery_id: 'bound-delivery' });

    assert.equal(result.delivered, true);
    assert.deepEqual(recoveryKeys, [
      { publisherScope: 'publisher', tenantScope: 'trusted-tenant', deliveryId: 'bound-delivery' },
    ]);
    assert.equal(fetch.calls.length, 1);
  });

  test('production rejects an explicit process-local delivery store', () => {
    const { signerKey } = makeSignerKey();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createWebhookEmitter({
            signerKey,
            deliveryStore: memoryWebhookKeyStore(),
            publisherScope: 'publisher',
            tenantScope: 'tenant',
          }),
        /requires a durable WebhookDeliveryStore/
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv ?? 'test';
    }
  });

  test('production rejects a durable binding store without durable recovery state', () => {
    const { signerKey } = makeSignerKey();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createWebhookEmitter({
            signerKey,
            deliveryStore: {
              durability: 'durable',
              claim: (_key, proposed, retentionMs) => ({
                status: 'bound',
                ...proposed,
                firstAttemptAtMs: 1_000,
                retainUntilMs: 1_000 + retentionMs,
              }),
            },
            publisherScope: 'publisher',
            tenantScope: 'tenant',
          }),
        /requires durable deliveryRecovery/
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv ?? 'test';
    }
  });

  test('throws when neither signerKey nor signerProvider is provided', () => {
    const fetch = stubFetch([]);
    assert.throws(
      () => createWebhookEmitter({ fetch, sleep: noSleep }),
      err => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /one of signerKey or signerProvider is required/);
        return true;
      }
    );
  });

  test('throws when both signerKey and signerProvider are provided', () => {
    const { signerKey } = makeSignerKey();
    const provider = signerKeyToProvider(signerKey);
    const fetch = stubFetch([]);
    assert.throws(
      () => createWebhookEmitter({ signerKey, signerProvider: provider, fetch, sleep: noSleep }),
      err => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /provide exactly one of signerKey or signerProvider, not both/);
        return true;
      }
    );
  });
});
