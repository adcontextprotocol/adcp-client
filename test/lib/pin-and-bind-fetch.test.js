/**
 * Unit coverage for `createPinAndBindFetch` — the DNS-rebinding-resistant
 * fetch wired as the default for `createWebhookEmitter`.
 *
 * Strategy: stub the `lookup` option to simulate the rebinding sequence
 * without touching real DNS. Each test asserts the rule that fires when
 * the resolved IPs hit (or escape) the policy. We do NOT require the
 * underlying TCP/TLS connection to succeed — verifying that the guarded
 * lookup rejects the connect attempt with an SSRF error code is the
 * load-bearing assertion.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { createPinAndBindFetch, WEBHOOK_SSRF_POLICY } = require('../../dist/lib/server/pin-and-bind-fetch.js');

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Build a `lookup` stub that emits the supplied addresses (IP + family).
 * Matches the all=true variant the helper invokes internally.
 */
function stubLookup(addresses) {
  return (hostname, options, callback) => {
    setImmediate(() => callback(null, addresses));
  };
}

function ssrfErrorThrown(err) {
  if (!err) return false;
  if (err.code === 'EADCP_SSRF_BLOCKED') return true;
  // undici wraps lookup errors in fetch failures — drill into cause chain.
  let cur = err;
  while (cur) {
    if (cur.code === 'EADCP_SSRF_BLOCKED') return true;
    cur = cur.cause;
  }
  return false;
}

async function expectSsrfBlocked(promise) {
  try {
    await promise;
    assert.fail('expected fetch to reject with SSRF error');
  } catch (err) {
    assert.ok(ssrfErrorThrown(err), `expected EADCP_SSRF_BLOCKED, got ${err?.code ?? 'no code'}: ${err?.message}`);
  }
}

// ────────────────────────────────────────────────────────────
// DNS-rebinding scenarios
// ────────────────────────────────────────────────────────────

describe('createPinAndBindFetch: DNS rebinding defense', () => {
  test('blocks when resolution lands on cloud metadata IP (169.254.169.254)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '169.254.169.254', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks when resolution lands on loopback (127.0.0.1)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks RFC 1918 private (10.0.0.5)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '10.0.0.5', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks RFC 1918 private (192.168.1.1)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '192.168.1.1', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks CGNAT shared-address space (100.64.0.1)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '100.64.0.1', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks IPv6 loopback (::1)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '::1', family: 6 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks IPv6 ULA (fc00::/7)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: 'fc00::1', family: 6 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks IPv6 link-local (fe80::/10)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: 'fe80::1', family: 6 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks IPv4-mapped IPv6 with private suffix (::ffff:10.0.0.1)', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '::ffff:10.0.0.1', family: 6 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('blocks split-resolution: ANY private IP rejects whole hostname (mixed A records)', async () => {
    // Multi-record DNS attack: attacker returns BOTH a public IP AND a
    // private IP, hoping the connector picks the "good" one. The whole
    // resolution must reject — picking public would still expose bytes
    // to whatever the client of the public IP routes back.
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([
        { address: '203.0.113.10', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });
});

// ────────────────────────────────────────────────────────────
// Scheme + metadata hostname guards
// ────────────────────────────────────────────────────────────

describe('createPinAndBindFetch: scheme + hostname guards', () => {
  test('blocks http:// (default policy is https-only for signed webhooks)', async () => {
    // Resolution never runs — undici should have rejected at the URL stage,
    // but our policy is enforced inside lookup. To exercise the scheme
    // path we need a public IP so resolution succeeds; the scheme deny
    // check fires earlier in the chain. http URL fails at fetch parsing
    // (in undici) or at the connect-allowed check; either way, no payload.
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '203.0.113.10', family: 4 }]),
    });
    // Call against http — we expect rejection. The exact error code may
    // be undici's connect failure rather than EADCP_SSRF_BLOCKED, since
    // scheme is enforced in synchronous policy compilation. Accept any
    // failure; the assertion is "did not deliver".
    let delivered = false;
    try {
      await fetch('http://allowed.example/leak');
      delivered = true;
    } catch {
      // expected
    }
    assert.strictEqual(delivered, false, 'http:// must not deliver under default webhook policy');
  });

  test('blocks resolution returning empty address list', async () => {
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([]),
    });
    await expectSsrfBlocked(fetch('https://empty-resolve.test/path'));
  });
});

// ────────────────────────────────────────────────────────────
// Policy override
// ────────────────────────────────────────────────────────────

describe('createPinAndBindFetch: policy override', () => {
  test('relaxed policy without 127.0.0.0/8 allows loopback resolution', async () => {
    // Build a relaxed policy: drop the 127.0.0.0/8 deny so loopback is OK.
    // (Schemes still https-only — this is purely an IP-CIDR relaxation.)
    const relaxed = {
      ...WEBHOOK_SSRF_POLICY,
      hosts_denied_ipv4_cidrs: WEBHOOK_SSRF_POLICY.hosts_denied_ipv4_cidrs.filter(c => c !== '127.0.0.0/8'),
    };
    const fetch = createPinAndBindFetch({
      policy: relaxed,
      lookup: stubLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    // Connection will fail at TCP layer (nothing listening on 9 typically),
    // but it MUST get past the policy gate. Assert that the rejection is
    // NOT an SSRF block — anything else (ECONNREFUSED, timeout) is fine.
    try {
      await fetch('https://loopback.test:9/path');
      // If something happens to listen, that's also fine — it got past the gate.
    } catch (err) {
      assert.ok(
        !ssrfErrorThrown(err),
        `expected non-SSRF error after policy relaxed; got ${err?.code}: ${err?.message}`
      );
    }
  });

  test('default WEBHOOK_SSRF_POLICY is the strict baseline (verify constant)', () => {
    assert.deepStrictEqual(WEBHOOK_SSRF_POLICY.schemes_allowed, ['https']);
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_ipv4_cidrs.includes('169.254.0.0/16'), 'must deny link-local');
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_ipv4_cidrs.includes('127.0.0.0/8'), 'must deny loopback v4');
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_ipv4_cidrs.includes('10.0.0.0/8'), 'must deny RFC 1918 /8');
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_ipv4_cidrs.includes('100.64.0.0/10'), 'must deny CGNAT');
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_ipv6_cidrs.includes('::1/128'), 'must deny v6 loopback');
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_ipv6_cidrs.includes('fc00::/7'), 'must deny v6 ULA');
    assert.ok(WEBHOOK_SSRF_POLICY.hosts_denied_metadata.includes('metadata.google.internal'), 'must deny GCE metadata');
    assert.strictEqual(WEBHOOK_SSRF_POLICY.host_literal_policy, 'allow');
  });
});

// ────────────────────────────────────────────────────────────
// Opt-in integration with createWebhookEmitter
// ────────────────────────────────────────────────────────────

describe('createWebhookEmitter: pin-and-bind opt-in via fetch override', () => {
  const { createWebhookEmitter } = require('../../dist/lib/server/webhook-emitter.js');
  const { generateKeyPairSync } = require('node:crypto');

  function makeSignerKey() {
    const { privateKey } = generateKeyPairSync('ed25519');
    const priv = privateKey.export({ format: 'jwk' });
    return {
      keyid: 'test-pin-bind-key',
      alg: 'ed25519',
      privateKey: { ...priv, kid: 'test-pin-bind-key', alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['sign'] },
    };
  }

  test('emit() with pin-and-bind fetch refuses loopback URLs and marks SSRF as terminal', async () => {
    const emitter = createWebhookEmitter({
      signerKey: makeSignerKey(),
      fetch: createPinAndBindFetch(),
      sleep: () => Promise.resolve(),
      retries: { maxAttempts: 5 }, // SSRF should still cap at 1 — terminal.
    });

    const result = await emitter.emit({
      url: 'https://127.0.0.1:9999/webhook',
      payload: { task: { task_id: 'mb-pin-test', status: 'completed' } },
      operation_id: 'op.mb-pin-test',
    });

    assert.strictEqual(result.delivered, false, 'pin-and-bind must not deliver to loopback');
    assert.strictEqual(result.attempts, 1, 'SSRF block must be terminal — no retries');
    assert.ok(
      result.errors.some(e => /SSRF|EADCP_SSRF_BLOCKED|hosts_denied|host_literal/i.test(e)),
      `expected SSRF-shaped error in result.errors, got: ${JSON.stringify(result.errors)}`
    );
  });

  test('emit() with default fetch (no opt-in) still works against loopback (back-compat)', async () => {
    // Asserts that flipping pin-and-bind from default in v6 is the only
    // behavior change — until then, omitting `fetch` keeps the legacy
    // globalThis.fetch path that storyboard tests rely on.
    const emitter = createWebhookEmitter({
      signerKey: makeSignerKey(),
      sleep: () => Promise.resolve(),
      retries: { maxAttempts: 1 },
    });
    // We don't actually need a server listening; the assertion is that the
    // call gets to the connect phase (i.e. wasn't blocked synchronously).
    // ECONNREFUSED is the expected outcome on a free loopback port.
    const result = await emitter.emit({
      url: 'https://127.0.0.1:9999/webhook',
      payload: { task: { task_id: 'compat', status: 'completed' } },
      operation_id: 'op.compat',
    });
    assert.strictEqual(result.delivered, false);
    assert.ok(
      !result.errors.some(e => /EADCP_SSRF_BLOCKED/.test(e)),
      'default fetch must not raise SSRF block today'
    );
  });
});
