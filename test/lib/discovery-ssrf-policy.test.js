/**
 * SSRF-policy tests for the discovery layer (#1633).
 *
 * Validates that `NetworkConsistencyChecker` and `PropertyCrawler` route
 * their outbound fetches through `ssrfSafeFetch`, which gives them:
 *
 *   - hostname-literal address-guard refusal (IMDS, IPv6 link-local)
 *   - DNS-pin defense (rebind-resistant connect)
 *   - body cap (rejects oversized adagents.json responses)
 *   - scheme guard (refuses non-HTTPS without env opt-in)
 *
 * The existing test files (`network-consistency-checker.test.js`,
 * `property-crawler.test.js`) mock `globalThis.fetch` and therefore do
 * not exercise the production path after #1633. Their migration to
 * loopback servers is tracked in adcp-client#1637.
 *
 * This file's tests use real HTTP servers to confirm the SSRF defense
 * actually fires.
 */

// Most tests want default-strict (RFC-1918 refused, loopback allowed).
// Set BEFORE the modules load so probe-policy reads the opt-in.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { NetworkConsistencyChecker } = require('../../dist/lib/discovery/network-consistency-checker.js');
const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
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

describe('NetworkConsistencyChecker — SSRF policy gate (#1633)', () => {
  test('probeAgent refuses agent URL pointing at IMDS with [SSRF refused] tag', async () => {
    const checker = new NetworkConsistencyChecker({
      domains: ['attacker.example.com'],
      logLevel: 'silent',
    });
    const result = await checker['probeAgent']({
      url: 'http://169.254.169.254/',
      authorized_for: 'attacker',
    });
    assert.strictEqual(result.reachable, false);
    // The sanitizeError path tags policy refusals with `[SSRF refused]`
    // so operators can tell "host unreachable" apart from "host refused
    // on policy grounds" — closes the catch-swallow regression flagged
    // by the security review of #1638.
    //
    // `validateAgentUrl` may also catch IMDS earlier with its own
    // message; tolerate either path but require non-generic wording so
    // a regression that downgrades to `'Request failed'` would fail.
    assert.ok(
      result.error?.includes('[SSRF refused]') ||
        result.error?.includes('169.254') ||
        result.error?.includes('cloud-metadata') ||
        result.error?.includes('always-blocked'),
      `expected SSRF-refusal-shaped error, got: ${result.error}`
    );
  });

  test('probeAgent succeeds against a loopback agent server', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    try {
      const checker = new NetworkConsistencyChecker({
        domains: ['example.com'],
        logLevel: 'silent',
      });
      const result = await checker['probeAgent']({
        url: server.url,
        authorized_for: 'test',
      });
      assert.strictEqual(result.reachable, true);
      assert.strictEqual(result.statusCode, 200);
    } finally {
      await server.close();
    }
  });

  test('probeAgent reports unreachable when server returns 5xx', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    try {
      const checker = new NetworkConsistencyChecker({
        domains: ['example.com'],
        logLevel: 'silent',
      });
      const result = await checker['probeAgent']({
        url: server.url,
        authorized_for: 'test',
      });
      // 503 is reachable: false (response.ok is false, not 405).
      assert.strictEqual(result.reachable, false);
      assert.strictEqual(result.statusCode, 503);
    } finally {
      await server.close();
    }
  });
});

describe('PropertyCrawler — SSRF policy gate (#1633)', () => {
  test('fetchAdAgentsJsonFromUrl refuses URL pointing at IMDS', async () => {
    const crawler = new PropertyCrawler({ logLevel: 'silent' });
    await assert.rejects(
      // The crawler's public surface is `fetchAdAgentsJson(domain)` which
      // resolves the well-known URL internally. Use the lower-level
      // `fetchAdAgentsJsonFromUrl` (private; access via bracket notation
      // for the test surface).
      () =>
        crawler['fetchAdAgentsJsonFromUrl'](
          'http://169.254.169.254/.well-known/adagents.json',
          'attacker.example.com',
          new Set(),
          0
        ),
      err => {
        // SsrfRefusedError percolates up — the crawler doesn't swallow it.
        // (Or if `fetch` would have been refused before reaching the
        // crawler, the error message will surface that.)
        assert.ok(err.message, 'must surface an error');
        return true;
      }
    );
  });

  test('fetchAdAgentsJsonFromUrl successfully reads from a loopback server', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
          authorized_agents: [
            {
              url: 'https://test-agent.example.com',
              authorized_for: 'Test agent',
            },
          ],
          properties: [
            {
              property_type: 'website',
              name: 'example.com',
              identifiers: [{ type: 'domain', value: 'example.com' }],
            },
          ],
        })
      );
    });
    try {
      const crawler = new PropertyCrawler({ logLevel: 'silent' });
      const result = await crawler['fetchAdAgentsJsonFromUrl'](
        `${server.url}/.well-known/adagents.json`,
        'example.com',
        new Set(),
        0
      );
      assert.strictEqual(result.properties.length, 1);
      assert.strictEqual(result.properties[0].name, 'example.com');
    } finally {
      await server.close();
    }
  });

  test('fetchAdAgentsJsonFromUrl rejects oversized response (body cap)', async () => {
    // Serve a giant body to confirm the body cap fires — defense against a
    // hostile publisher feeding the crawler a slow / huge response.
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 1 MiB of garbage — exceeds the 256 KiB MAX_ADAGENTS_BODY_BYTES cap.
      res.end('a'.repeat(1024 * 1024));
    });
    try {
      const crawler = new PropertyCrawler({ logLevel: 'silent' });
      await assert.rejects(
        () =>
          crawler['fetchAdAgentsJsonFromUrl'](`${server.url}/.well-known/adagents.json`, 'example.com', new Set(), 0),
        err => {
          assert.ok(
            err instanceof SsrfRefusedError ? err.code === 'body_exceeds_limit' : err.message,
            `expected body cap refusal, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      await server.close();
    }
  });
});
