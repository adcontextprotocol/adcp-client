/**
 * Regression tests for adcp-client#1612 (auto-detect on unhealthy A2A roots).
 *
 * Before the fix, detectProtocol returned 'mcp' on any non-200 response from
 * the well-known A2A card URL — including 5xx, 401, and timeouts. That made
 * the runner attempt MCP discovery against a non-MCP root, which then
 * burned ~7 minutes of orphaned MCP retries inside getAgentInfo().
 *
 * The fix: classify 5xx/401/403/429/network-error as "host knows the path
 * but can't return the card right now" → A2A suspect, not MCP. Only true
 * negative evidence (404) falls back to MCP.
 *
 * adcp-client#1627 update: detectProtocol now routes the well-known probe
 * through `ssrfSafeFetch` for DNS-pin / TOCTOU defense. That uses real
 * DNS resolution and an undici-pinned connect — so these tests can no
 * longer mock `globalThis.fetch`. Instead, each test spins up an HTTP
 * server on 127.0.0.1 with the desired status code; the env flag at the
 * top of this file lets `ssrfSafeFetch` accept the loopback target.
 */

// MUST be set before `detectProtocol` (and the modules below it) load —
// `probe-policy` reads `ADCP_ALLOW_INTERNAL_PROBES` once at module load.
// Without this, ssrfSafeFetch refuses 127.0.0.1 with `private_address` and
// every test fails before the server's response shape matters.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { detectProtocol } = require('../../dist/lib/index.js');

/**
 * Spin a one-shot HTTP server that responds to every request with the
 * given status code (and optional body). Returns its base URL plus a
 * close handle. Each test owns its own server so concurrent runs don't
 * race.
 */
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () =>
          new Promise(r => {
            server.close(() => r());
          }),
      });
    });
  });
}

const respond =
  (status, body = '') =>
  (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };

describe('detectProtocol — well-known card response classification (#1612)', () => {
  test('200 → a2a (existing behavior preserved)', async () => {
    const server = await startServer(respond(200, '{}'));
    try {
      assert.strictEqual(await detectProtocol(server.url), 'a2a');
    } finally {
      await server.close();
    }
  });

  test('503 from card path → a2a (was returning mcp before fix)', async () => {
    const server = await startServer(respond(503, ''));
    try {
      assert.strictEqual(
        await detectProtocol(server.url),
        'a2a',
        '5xx on /.well-known/agent.json indicates the host knows this route but cannot serve right now — strong evidence of A2A'
      );
    } finally {
      await server.close();
    }
  });

  test('401 from card path → a2a (auth gate on the well-known path)', async () => {
    const server = await startServer(respond(401, ''));
    try {
      assert.strictEqual(await detectProtocol(server.url), 'a2a');
    } finally {
      await server.close();
    }
  });

  test('429 from card path → a2a (rate limit on the well-known path)', async () => {
    const server = await startServer(respond(429, ''));
    try {
      assert.strictEqual(await detectProtocol(server.url), 'a2a');
    } finally {
      await server.close();
    }
  });

  test('404 from card path → mcp (true negative evidence)', async () => {
    const server = await startServer(respond(404, ''));
    try {
      assert.strictEqual(
        await detectProtocol(server.url),
        'mcp',
        '404 means the host genuinely does not have an A2A well-known path'
      );
    } finally {
      await server.close();
    }
  });

  test('400 from card path → mcp (other 4xx still negative)', async () => {
    const server = await startServer(respond(400, ''));
    try {
      assert.strictEqual(await detectProtocol(server.url), 'mcp');
    } finally {
      await server.close();
    }
  });

  test('network error / connection refused → a2a (slow A2A more likely than MCP at /)', async () => {
    // Bind a server, capture the URL, then close it. The next request
    // will get ECONNREFUSED — the "server briefly unreachable" pattern
    // we expect to classify as A2A suspect.
    const server = await startServer(respond(200, '{}'));
    const closedUrl = server.url;
    await server.close();

    assert.strictEqual(
      await detectProtocol(closedUrl),
      'a2a',
      'A network error on the well-known path is more consistent with a slow A2A host than a missing MCP /mcp endpoint'
    );
  });

  test('URL ending with /mcp short-circuits to mcp without probing', async () => {
    let probed = false;
    const server = await startServer((_req, res) => {
      probed = true;
      res.writeHead(200);
      res.end('{}');
    });
    try {
      assert.strictEqual(await detectProtocol(`${server.url}/mcp`), 'mcp');
      assert.strictEqual(probed, false, 'Should not probe the well-known path when URL already ends in /mcp');
    } finally {
      await server.close();
    }
  });
});
