/**
 * Integration test for adcp-client#1618 — confirms the SSRF policy fires
 * at the two integration sites identified in triage:
 *
 * 1. `detectA2AOrMcp` — guard runs BEFORE the try/catch loop, so a denied
 *    URL can't be silently swallowed and converted into `'a2a'` by
 *    `catch { suspect = true }` (the code-reviewer-flagged catch-swallow class).
 *
 * 2. `createTestClient` — guard runs at URL construction so every transport
 *    call inherits the agent URI's policy verdict (covers downstream
 *    `getAgentInfo` / `getAdcpCapabilities` without instrumenting them).
 *
 * #1627 update: detectProtocol now routes through `ssrfSafeFetch` (real DNS,
 * connection-pinned, `redirect: 'manual'`). Tests that exercise the "passes
 * the gate" path against loopback need the env opt-in set BEFORE module
 * load; tests that exercise refusal don't.
 */

// Set BEFORE any require so `probe-policy`'s module-load-time read picks
// up the opt-in. Without this, loopback URLs would be refused by the
// `ssrfSafeFetch` private-address guard one layer below the policy gate.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { detectProtocol } = require('../../dist/lib/utils/protocol-detection.js');
const { createTestClient } = require('../../dist/lib/testing/client.js');
const { SsrfRefusedError } = require('../../dist/lib/net/ssrf-fetch.js');

function startServer(handler) {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${s.address().port}`,
        close: () => new Promise(r => s.close(() => r())),
      });
    });
  });
}

describe('detectProtocol: SSRF policy gate (#1618)', () => {
  test('rejects AWS IMDS literal BEFORE entering the try/catch loop', async () => {
    // If the gate were inside the try/catch, `catch { suspect = true }`
    // would swallow the SsrfRefusedError and return 'a2a' — the exact
    // bug the code-reviewer flagged.
    await assert.rejects(
      () => detectProtocol('http://169.254.169.254/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError, `Expected SsrfRefusedError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'always_blocked_address');
        return true;
      }
    );
  });

  // RFC-1918 refusal in default-strict mode lives in `probe-policy.test.js`
  // (subprocess-based). This file enables `ADCP_ALLOW_INTERNAL_PROBES=1`
  // so it can spin loopback servers for the integration assertions —
  // RFC-1918 acceptance is the by-design consequence of that opt-in.

  test('passes the gate for public hostnames (refusal is from DNS, not the gate)', async () => {
    // `agent.example.com` doesn't resolve in CI. The point of this test is
    // "the SSRF gate didn't block it" — any non-SsrfRefusedError on the
    // private/always_blocked codes means the gate let it through. DNS
    // resolution failure (`dns_lookup_failed`) is acceptable.
    let err;
    try {
      await detectProtocol('https://agent.example.com/');
    } catch (e) {
      err = e;
    }
    if (err instanceof SsrfRefusedError) {
      assert.notStrictEqual(err.code, 'always_blocked_address', 'gate must not refuse public hostname');
      assert.notStrictEqual(err.code, 'private_address', 'gate must not refuse public hostname');
    }
  });

  test('allows 127.0.0.1 loopback through the gate (with env opt-in)', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const result = await detectProtocol(server.url);
      assert.strictEqual(result, 'mcp');
    } finally {
      await server.close();
    }
  });
});

describe('createTestClient: SSRF policy gate (#1618)', () => {
  test('throws SsrfRefusedError on AWS IMDS', () => {
    assert.throws(
      () => createTestClient('http://169.254.169.254/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'always_blocked_address');
        // Hostname-only in user-visible message — no resolved IP echo.
        assert.match(err.message, /169\.254\.169\.254/);
        return true;
      }
    );
  });

  // RFC-1918 refusal at createTestClient lives under the env-opt-out
  // subprocess tests in `probe-policy.test.js` — same reason as above.

  test('throws SsrfRefusedError on IPv6 link-local', () => {
    assert.throws(
      () => createTestClient('http://[fe80::1]/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'always_blocked_address');
        return true;
      }
    );
  });

  test('accepts loopback', () => {
    assert.doesNotThrow(() => createTestClient('http://localhost:3000/mcp'));
  });

  test('accepts public hostname', () => {
    assert.doesNotThrow(() => createTestClient('https://agent.example.com/mcp'));
  });

  test('accepts 127.0.0.1', () => {
    assert.doesNotThrow(() => createTestClient('http://127.0.0.1:8080/mcp'));
  });
});
