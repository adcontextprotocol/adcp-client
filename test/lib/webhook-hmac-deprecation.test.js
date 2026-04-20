/**
 * HMAC-SHA256 webhook deprecation warning — removal target: @adcp/client 6.0.0.
 *
 * The emitter's HMAC branch is a compatibility shim for buyers that
 * registered `push_notification_config.authentication.credentials` before
 * the RFC 9421 webhook profile (adcp#2423) existed. 5.x emits a one-time
 * `console.warn` on first HMAC delivery per process so integrations
 * surface the removal notice in logs without spamming every retry.
 *
 * Suppression: `process.env.ADCP_SUPPRESS_HMAC_WARNING === '1'`.
 *
 * The module-level `hmacWarningFired` flag lives inside
 * `dist/lib/server/webhook-emitter.js`. We reset it between tests by
 * flushing the `require` cache so each scenario sees a fresh process.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');

const EMITTER_PATH = require.resolve('../../dist/lib/server/webhook-emitter.js');

function loadEmitterFresh() {
  // Flush every adcp-client dist module from the require cache — the
  // HMAC flag lives inside webhook-emitter.js but re-requiring a single
  // file while its neighbors are cached produces mixed-state references.
  const distRoot = path.resolve(__dirname, '../../dist');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(distRoot)) delete require.cache[key];
  }
  return require(EMITTER_PATH);
}

function makeSignerKey(kid = 'hmac-dep-test-kid') {
  const { privateKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' });
  return {
    keyid: kid,
    alg: 'ed25519',
    privateKey: { ...priv, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['sign'] },
  };
}

function stubFetch(responses) {
  const queue = [...responses];
  return async () => {
    const next = queue.shift() ?? { status: 200 };
    const headers = new Map(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: next.status, headers: { get: name => headers.get(name.toLowerCase()) } };
  };
}

function captureWarn() {
  const captured = [];
  const original = console.warn;
  console.warn = (...args) => {
    captured.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return {
    get calls() {
      return captured;
    },
    restore() {
      console.warn = original;
    },
  };
}

const HMAC_AUTH = { type: 'hmac_sha256', secret: 'shh-its-a-secret' };
const noSleep = () => Promise.resolve();

describe('webhook HMAC-SHA256 deprecation warning', () => {
  let origSuppress;

  beforeEach(() => {
    origSuppress = process.env.ADCP_SUPPRESS_HMAC_WARNING;
    delete process.env.ADCP_SUPPRESS_HMAC_WARNING;
  });

  afterEach(() => {
    if (origSuppress === undefined) {
      delete process.env.ADCP_SUPPRESS_HMAC_WARNING;
    } else {
      process.env.ADCP_SUPPRESS_HMAC_WARNING = origSuppress;
    }
  });

  it('emits one console.warn on first HMAC emission with the expected message shape', async () => {
    const { createWebhookEmitter } = loadEmitterFresh();
    const signerKey = makeSignerKey();
    const emitter = createWebhookEmitter({ signerKey, fetch: stubFetch([{ status: 204 }]), sleep: noSleep });

    const warn = captureWarn();
    try {
      await emitter.emit({
        url: 'http://x/h',
        payload: { event: 'hmac' },
        operation_id: 'op.hmac.dep.1',
        authentication: HMAC_AUTH,
      });

      assert.equal(warn.calls.length, 1, 'expected exactly one HMAC deprecation warning');
      assert.match(warn.calls[0], /HMAC-SHA256 authentication is deprecated/);
      assert.match(warn.calls[0], /removed in @adcp\/client 6\.0\.0/);
      assert.match(warn.calls[0], /docs\/migration-4\.30-to-5\.2\.md#webhook-hmac-legacy-deprecation/);
      assert.match(warn.calls[0], /ADCP_SUPPRESS_HMAC_WARNING=1/);
    } finally {
      warn.restore();
    }
  });

  it('does not re-warn on the second HMAC emission in the same process', async () => {
    const { createWebhookEmitter } = loadEmitterFresh();
    const signerKey = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const warn = captureWarn();
    try {
      await emitter.emit({
        url: 'http://x/h',
        payload: { n: 1 },
        operation_id: 'op.hmac.dep.first',
        authentication: HMAC_AUTH,
      });
      await emitter.emit({
        url: 'http://x/h',
        payload: { n: 2 },
        operation_id: 'op.hmac.dep.second',
        authentication: HMAC_AUTH,
      });

      assert.equal(warn.calls.length, 1, 'HMAC deprecation warning MUST fire only once per process');
    } finally {
      warn.restore();
    }
  });

  it('does not emit when ADCP_SUPPRESS_HMAC_WARNING=1 is set', async () => {
    process.env.ADCP_SUPPRESS_HMAC_WARNING = '1';
    const { createWebhookEmitter } = loadEmitterFresh();
    const signerKey = makeSignerKey();
    const emitter = createWebhookEmitter({ signerKey, fetch: stubFetch([{ status: 204 }]), sleep: noSleep });

    const warn = captureWarn();
    try {
      await emitter.emit({
        url: 'http://x/h',
        payload: { event: 'hmac-suppressed' },
        operation_id: 'op.hmac.dep.suppress',
        authentication: HMAC_AUTH,
      });

      assert.equal(warn.calls.length, 0, 'opt-out env var must fully suppress the HMAC deprecation warning');
    } finally {
      warn.restore();
    }
  });

  it('does not emit on the default 9421 path or the bearer fallback', async () => {
    const { createWebhookEmitter } = loadEmitterFresh();
    const signerKey = makeSignerKey();
    const fetch = stubFetch([{ status: 204 }, { status: 204 }]);
    const emitter = createWebhookEmitter({ signerKey, fetch, sleep: noSleep });

    const warn = captureWarn();
    try {
      await emitter.emit({
        url: 'http://x/h',
        payload: { p: '9421' },
        operation_id: 'op.hmac.dep.9421',
      });
      await emitter.emit({
        url: 'http://x/h',
        payload: { p: 'bearer' },
        operation_id: 'op.hmac.dep.bearer',
        authentication: { type: 'bearer', token: 'opaque' },
      });

      assert.equal(warn.calls.length, 0, 'non-HMAC paths must not fire the HMAC deprecation warning');
    } finally {
      warn.restore();
    }
  });
});
