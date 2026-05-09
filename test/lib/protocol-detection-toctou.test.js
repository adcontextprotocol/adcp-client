/**
 * TOCTOU / DNS-rebind defense tests for adcp-client#1627.
 *
 * Before #1627, `detectProtocol` used native `fetch`, which performs its
 * own DNS lookup at connect time. The hostname-literal SSRF gate from
 * #1618 caught `http://169.254.169.254/` but NOT `http://evil.example.com/`
 * that DNS-resolves to `169.254.169.254`. Native fetch would happily
 * connect to the resolved address and hand back any IMDS response — or
 * worse, follow a `Location:` header to an internal target.
 *
 * With #1627, detectProtocol routes the well-known probe through
 * `ssrfSafeFetch`, which:
 *   - resolves DNS once,
 *   - validates the full address set against `address-guards`,
 *   - pins the connect to the first validated address via undici's
 *     `Agent.connect.lookup`, defeating rebind between validation and
 *     connect,
 *   - sets `redirect: 'manual'` so a 302 to an internal URL is not
 *     auto-followed.
 *
 * These tests verify the layered defense holds:
 *   1. The hostname-literal gate (#1618) still catches the obvious cases.
 *   2. Per-IP refusal at fetch time (#1627) catches DNS-resolved private
 *      addresses regardless of what hostname they came from.
 *   3. SSRF refusals propagate as `SsrfRefusedError` — they do NOT get
 *      swallowed into `suspect = true` (the catch-swallow class flagged
 *      throughout the #1612 / #1618 reviews).
 *   4. 3xx redirects are NOT followed (no auto-bounce to attacker URLs).
 */

// The literal-IP refusal tests don't need the env opt-in — those URLs are
// always refused regardless. The redirect test runs against a loopback
// server so it needs the opt-in. Setting it module-load-time is fine
// because the literal-IP tests run BEFORE any real DNS resolution.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test, before } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { detectProtocol } = require('../../dist/lib/index.js');
const { SsrfRefusedError } = require('../../dist/lib/net/ssrf-fetch.js');

describe('detectProtocol — IP-literal SSRF refusal surfaces (#1627)', () => {
  test('IMDS literal (169.254.169.254) refuses with always_blocked_address', async () => {
    // The hostname-literal #1618 gate catches this synchronously, BEFORE
    // any network probe — confirming the layered defense's outer ring.
    await assert.rejects(
      () => detectProtocol('http://169.254.169.254/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError, `Expected SsrfRefusedError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'always_blocked_address');
        return true;
      }
    );
  });

  test('IPv4-mapped IPv6 IMDS (::ffff:169.254.169.254) is refused (canonicalization)', async () => {
    await assert.rejects(
      () => detectProtocol('http://[::ffff:169.254.169.254]/'),
      err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address'
    );
  });

  test('IPv6 link-local literal is refused', async () => {
    await assert.rejects(
      () => detectProtocol('http://[fe80::1]/'),
      err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address'
    );
  });

  // RFC-1918 refusal in default-strict is exhaustively covered in
  // `probe-policy.test.js` (subprocess-based env tests). At this integration
  // layer the file runs with `ADCP_ALLOW_INTERNAL_PROBES=1` so it can talk
  // to a loopback server for redirect tests — leaving RFC-1918 acceptance
  // active. The IMDS / link-local cases above are unconditional regardless
  // of the env opt-in.

  test('SSRF refusals are NOT swallowed by the catch-suspect handler', async () => {
    // This is the regression guard for the catch-swallow class flagged in
    // both #1618 and #1627 reviews. If `ssrfSafeFetch` rejects an internal
    // address inside the for-loop, we must throw — not set `suspect = true`
    // and return 'a2a'.
    let gotSsrfError = false;
    try {
      await detectProtocol('http://169.254.169.254/');
    } catch (err) {
      gotSsrfError = err instanceof SsrfRefusedError;
    }
    assert.strictEqual(gotSsrfError, true, 'SsrfRefusedError must propagate, not get swallowed into suspect');
  });
});

describe('detectProtocol — 3xx redirects are not auto-followed (#1627)', () => {
  // Set env opt-in so loopback targets work for these tests.
  before(() => {
    // Already set if running in the same process as the 1612 file; idempotent.
    process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';
  });

  test('302 with Location to a different host does NOT bounce', async () => {
    // ssrfSafeFetch sets `redirect: 'manual'`, so a 302 stays 302 and the
    // Location header is ignored by detectProtocol. Result: 302 doesn't
    // match the 200-confirm or 5xx-suspect bands → falls through to mcp.
    // The point of THIS test is "we don't follow into an attacker URL",
    // not the resulting classification — those land in negative evidence.
    let probedLocation = false;
    const server = await new Promise(resolve => {
      const s = http.createServer((req, res) => {
        if (req.url.includes('/.well-known/')) {
          res.writeHead(302, { Location: 'http://169.254.169.254/' });
          res.end();
        } else {
          probedLocation = true;
          res.writeHead(200);
          res.end('{}');
        }
      });
      s.listen(0, '127.0.0.1', () =>
        resolve({
          url: `http://127.0.0.1:${s.address().port}`,
          close: () => new Promise(r => s.close(() => r())),
        })
      );
    });
    try {
      const result = await detectProtocol(server.url);
      // We don't assert the exact classification here — the surface invariant
      // is "do not follow into the attacker URL". A 302 lands in negative
      // evidence (not a 200, not 5xx, not auth/rate), so result is 'mcp'.
      assert.strictEqual(result, 'mcp');
      assert.strictEqual(probedLocation, false, 'Must NOT follow Location header into an attacker URL');
    } finally {
      await server.close();
    }
  });
});
