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

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { generateKeyPairSync } = require('node:crypto');

const { createWebhookEmitter, memoryWebhookKeyStore } = require('../../dist/lib/server/webhook-emitter.js');
const { verifyWebhookSignature } = require('../../dist/lib/signing/webhook-verifier.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay.js');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation.js');

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
      operation_id: 'op.mb-1',
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
      operation_id: 'op.mb-x',
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
      operation_id: 'op.retry',
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
      operation_id: 'op.nonce',
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
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.429' });
    assert.strictEqual(result.delivered, true);
    assert.strictEqual(fetch.calls.length, 2);
  });

  test('treats 4xx as terminal', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 400 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.400' });
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
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.401' });
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(fetch.calls.length, 1);
    assert.match(result.errors[0], /webhook_signature_tag_invalid/);
  });

  test('max-attempts cap', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch(Array(10).fill({ status: 503 }));
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, retries: { maxAttempts: 3 } });
    const result = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.cap' });
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(fetch.calls.length, 3);
  });
});

// ────────────────────────────────────────────────────────────
// Idempotency-key stability across separate emit() calls
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: cross-call stability', () => {
  test('same operation_id across two emit() calls reuses the stored key', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const store = memoryWebhookKeyStore();
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep, idempotencyKeyStore: store });

    const first = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.same' });
    const second = await emitter.emit({ url: 'http://x/h', payload: { updated: true }, operation_id: 'op.same' });

    assert.strictEqual(first.idempotency_key, second.idempotency_key);
    assert.strictEqual(await store.get('op.same'), first.idempotency_key);
  });

  test('different operation_ids produce different keys', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const a = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.A' });
    const b = await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.B' });
    assert.notStrictEqual(a.idempotency_key, b.idempotency_key);
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
    await assert.rejects(() => emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.bad' }), /must match/);
  });
});

// ────────────────────────────────────────────────────────────
// Legacy HMAC fallback
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: HMAC fallback', () => {
  test('signs with X-ADCP-Signature when authentication.type = hmac_sha256', async () => {
    const { signerKey } = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });
    const result = await emitter.emit({
      url: 'http://x/h',
      payload: { event: 'hmac' },
      operation_id: 'op.hmac',
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
      operation_id: 'op.bearer',
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
    await emitter.emit({ url: 'http://x/h', payload: {}, operation_id: 'op.obs' });
    assert.strictEqual(attempts.length, 2);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(attempts[0].attempt, 1);
    assert.strictEqual(attempts[1].attempt, 2);
    assert.strictEqual(results[0].willRetry, true);
    assert.strictEqual(results[1].willRetry, false);
    assert.strictEqual(results[1].status, 204);
  });
});
