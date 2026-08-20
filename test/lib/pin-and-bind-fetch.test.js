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
const { createServer } = require('node:http');
const { Request: UndiciRequest } = require('undici');

const {
  createPinAndBindFetch,
  WEBHOOK_SSRF_POLICY,
  LOOPBACK_OK_WEBHOOK_SSRF_POLICY,
} = require('../../dist/lib/server/pin-and-bind-fetch.js');

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

function errorChainText(err) {
  const messages = [];
  let cur = err;
  while (cur) {
    if (cur.message) messages.push(cur.message);
    cur = cur.cause;
  }
  return messages.join(' — ');
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

  test('does not expose a DNS-resolved private address in the rejection chain', async () => {
    const privateAddress = '10.23.45.67';
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: privateAddress, family: 4 }]),
    });

    try {
      await fetch('https://rebind.attacker.test/leak');
      assert.fail('expected fetch to reject with SSRF error');
    } catch (err) {
      assert.ok(ssrfErrorThrown(err));
      assert.doesNotMatch(errorChainText(err), new RegExp(privateAddress.replaceAll('.', '\\.')));
    }
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

  test('always blocks unsafe IPv6 translation and tunnel targets returned by DNS', async () => {
    for (const address of ['64:ff9b:1::1', '2001::1', '2002:a9fe:a9fe::']) {
      const fetch = createPinAndBindFetch({
        lookup: stubLookup([{ address, family: 6 }]),
      });
      await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
    }
  });

  test('default webhook policy inherits every shared non-routable IPv6 classification', async () => {
    for (const address of ['::2', 'fec0::1', '100:0:0:1::1', '2001:2::1', '3ffe::1', '3fff::1', '5f00::1']) {
      const fetch = createPinAndBindFetch({
        lookup: stubLookup([{ address, family: 6 }]),
      });
      await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
    }
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
  test('blocks http:// at the synchronous wrapper pre-check', async () => {
    // The synchronous URL pre-check inside the wrapper enforces scheme
    // BEFORE any network or lookup work happens, so this must surface as
    // EADCP_SSRF_BLOCKED with the schemes_denied rule.
    const fetch = createPinAndBindFetch({
      lookup: stubLookup([{ address: '203.0.113.10', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('http://allowed.example/leak'));
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
      shared_private_address_policy: 'allow_loopback',
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

  test('LOOPBACK_OK_WEBHOOK_SSRF_POLICY allows http loopback (storyboard escape hatch)', async () => {
    // Storyboard `createWebhookReceiver` listens on http://127.0.0.1:port.
    // The loopback-OK preset must permit both the http scheme and the
    // 127.0.0.0/8 address family so adopters can pin-and-bind in production
    // without breaking in-process storyboard runs.
    const fetch = createPinAndBindFetch({
      policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY,
      lookup: stubLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    try {
      await fetch('http://localhost:9/path');
    } catch (err) {
      assert.ok(!ssrfErrorThrown(err), `loopback-OK preset must not raise SSRF; got ${err?.code}: ${err?.message}`);
    }
  });

  test('LOOPBACK_OK_WEBHOOK_SSRF_POLICY relaxes only loopback from the shared private tier', async () => {
    for (const address of ['::2', 'fec0::1', '100:0:0:1::1', '2001:2::1', '3ffe::1', '3fff::1', '5f00::1']) {
      const fetch = createPinAndBindFetch({
        policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY,
        lookup: stubLookup([{ address, family: 6 }]),
      });
      await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
    }
  });

  test('built-in webhook presets apply the shared classifier to literal hosts', async () => {
    for (const policy of [WEBHOOK_SSRF_POLICY, LOOPBACK_OK_WEBHOOK_SSRF_POLICY]) {
      const fetch = createPinAndBindFetch({ policy });
      await expectSsrfBlocked(fetch('https://[3ffe::1]/leak'));
    }
  });

  test('spread-based built-in policy overrides retain shared private blocking', async () => {
    for (const policy of [{ ...WEBHOOK_SSRF_POLICY }, { ...WEBHOOK_SSRF_POLICY, schemes_allowed: ['http', 'https'] }]) {
      const fetch = createPinAndBindFetch({ policy });
      await expectSsrfBlocked(fetch('https://[3ffe::1]/leak'));
    }
  });

  test('rejects nonstandard coercible inputs before validation and fetch can diverge', async () => {
    let coercions = 0;
    const input = {
      toString() {
        coercions += 1;
        return coercions === 1 ? 'https://public.example/' : 'http://127.0.0.1/';
      },
    };
    const fetch = createPinAndBindFetch();
    await expectSsrfBlocked(fetch(input));
    assert.equal(coercions, 0);
  });

  test('normalizes global and undici Request inputs without losing fetch semantics', async () => {
    const observations = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        observations.push({
          method: req.method,
          requestHeader: req.headers['x-request'],
          initHeader: req.headers['x-init'],
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      for (const RequestCtor of [Request, UndiciRequest]) {
        const request = new RequestCtor(`http://127.0.0.1:${port}/request`, {
          method: 'POST',
          headers: { 'x-request': 'request' },
          body: 'payload',
          duplex: 'half',
        });
        const fetch = createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY });
        const response = await fetch(request, { headers: { 'x-init': 'override' } });
        assert.equal(response.status, 204);

        const controller = new AbortController();
        const abortedRequest = new RequestCtor(`http://127.0.0.1:${port}/aborted`, {
          signal: controller.signal,
        });
        controller.abort();
        await assert.rejects(
          () => fetch(abortedRequest),
          err => err?.name === 'AbortError'
        );
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    assert.deepEqual(observations, [
      { method: 'POST', requestHeader: undefined, initHeader: 'override', body: 'payload' },
      { method: 'POST', requestHeader: undefined, initHeader: 'override', body: 'payload' },
    ]);
  });

  test('LOOPBACK_OK_WEBHOOK_SSRF_POLICY allows native loopback literals', async () => {
    const fetch = createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY });
    try {
      await fetch('http://[::1]:9/path');
    } catch (err) {
      assert.ok(!ssrfErrorThrown(err), `loopback-OK preset must not raise SSRF; got ${err?.code}: ${err?.message}`);
    }
  });

  test('LOOPBACK_OK_WEBHOOK_SSRF_POLICY still blocks cloud metadata (regression guard)', async () => {
    // The preset relaxes ONLY loopback. Every other deny range — link-local,
    // RFC 1918, CGNAT, IPv6 ULA, metadata hosts — must still fire. A copy
    // of the preset that accidentally drops 169.254.0.0/16 would silently
    // re-open the original DNS-rebinding hole.
    const fetch = createPinAndBindFetch({
      policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY,
      lookup: stubLookup([{ address: '169.254.169.254', family: 4 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
  });

  test('policy overrides cannot enable shared always-blocked addresses', async () => {
    const permissive = {
      ...LOOPBACK_OK_WEBHOOK_SSRF_POLICY,
      hosts_denied_ipv4_cidrs: [],
      hosts_denied_ipv6_cidrs: [],
      hosts_denied_metadata: [],
    };

    for (const url of ['https://[fd00:ec2::254]/leak', 'https://[64:ff9b:1::1]/leak', 'https://[2001::1]/leak']) {
      const fetch = createPinAndBindFetch({ policy: permissive });
      await expectSsrfBlocked(fetch(url));
    }

    const fetch = createPinAndBindFetch({
      policy: permissive,
      lookup: stubLookup([{ address: '64:ff9b:1::1', family: 6 }]),
    });
    await expectSsrfBlocked(fetch('https://rebind.attacker.test/leak'));
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

  test('emit() with the default fetch (no opt-in) is SSRF-guarded and blocks loopback', async () => {
    // The emitter defaults to createPinAndBindFetch() — omitting `fetch`
    // is secure-by-default. A loopback URL is refused (terminal), the same
    // as the explicit opt-in above. Adopters delivering to a loopback
    // receiver must opt into LOOPBACK_OK_WEBHOOK_SSRF_POLICY explicitly.
    const emitter = createWebhookEmitter({
      signerKey: makeSignerKey(),
      sleep: () => Promise.resolve(),
      retries: { maxAttempts: 5 }, // SSRF should still cap at 1 — terminal.
    });
    const result = await emitter.emit({
      url: 'https://127.0.0.1:9999/webhook',
      payload: { task: { task_id: 'default-guarded', status: 'completed' } },
      operation_id: 'op.default-guarded',
    });
    assert.strictEqual(result.delivered, false, 'default fetch must not deliver to loopback');
    assert.strictEqual(result.attempts, 1, 'SSRF block must be terminal — no retries');
    assert.ok(
      result.errors.some(e => /SSRF|EADCP_SSRF_BLOCKED|hosts_denied|host_literal/i.test(e)),
      `expected SSRF-shaped error from the default fetch, got: ${JSON.stringify(result.errors)}`
    );
  });
});

// ────────────────────────────────────────────────────────────
// Redirect handling
// ────────────────────────────────────────────────────────────

describe('createPinAndBindFetch: redirects are not followed', () => {
  /**
   * Both SSRF guards only ever see the URL the caller passed: the synchronous
   * scheme/CIDR pre-check runs before the request, and undici skips
   * `connect.lookup` entirely for IP-literal hosts. A followed `Location:` hop
   * would therefore reach its destination unevaluated, which is the whole
   * bypass. These tests pin the 3xx-surfacing behavior in place.
   */
  function startRedirector(location) {
    const server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: location });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('followed');
    });
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  }

  test('a redirect to a denied IP literal is surfaced as a 3xx, not followed', async () => {
    // Loopback is allowed by the test policy so the FIRST hop connects; the
    // Location points at the cloud metadata service, which must never be hit.
    const { server, port } = await startRedirector('https://169.254.169.254/latest/meta-data/');
    try {
      const fetch = createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY });
      const res = await fetch(`http://127.0.0.1:${port}/start`);
      assert.strictEqual(res.status, 302, 'the 3xx itself must be returned to the caller');
      assert.strictEqual(
        res.headers.get('location'),
        'https://169.254.169.254/latest/meta-data/',
        'Location is surfaced so the caller can decide, having not been followed'
      );
    } finally {
      server.close();
    }
  });

  test('a caller asking for redirect: follow still does not get redirects followed', async () => {
    // The mode is forced rather than defaulted — honouring 'follow' here would
    // reopen the bypass for any call site that passed it.
    const { server, port } = await startRedirector('https://169.254.169.254/latest/meta-data/');
    try {
      const fetch = createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY });
      const res = await fetch(`http://127.0.0.1:${port}/start`, { redirect: 'follow' });
      assert.strictEqual(res.status, 302, 'redirect: follow must not re-enable following');
    } finally {
      server.close();
    }
  });

  test('a same-origin redirect is also not followed', async () => {
    // Not a security case on its own, but it documents that the helper never
    // follows — callers re-enter it with the new URL to get a fresh policy run.
    const { server, port } = await startRedirector('/landing');
    try {
      const fetch = createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY });
      const res = await fetch(`http://127.0.0.1:${port}/start`);
      assert.strictEqual(res.status, 302);
    } finally {
      server.close();
    }
  });
});
