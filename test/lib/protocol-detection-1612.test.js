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
 * NOTE: Each test mocks `globalThis.fetch` inline (not via beforeEach) so
 * concurrent test runs don't race on the global. Pattern is: snapshot →
 * mock → call → assert → restore in `finally`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { detectProtocol } = require('../../dist/lib/index.js');

async function withMockedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const respond =
  (status, statusText = '') =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
  });

const networkError =
  (err = new Error('ECONNRESET')) =>
  async () => {
    throw err;
  };

describe('detectProtocol — well-known card response classification (#1612)', () => {
  test('200 → a2a (existing behavior preserved)', async () => {
    await withMockedFetch(respond(200), async () => {
      assert.strictEqual(await detectProtocol('https://agent.example.com'), 'a2a');
    });
  });

  test('503 from card path → a2a (was returning mcp before fix)', async () => {
    await withMockedFetch(respond(503, 'Service Unavailable'), async () => {
      assert.strictEqual(
        await detectProtocol('https://agent.example.com'),
        'a2a',
        '5xx on /.well-known/agent.json indicates the host knows this route but cannot serve right now — strong evidence of A2A'
      );
    });
  });

  test('401 from card path → a2a (auth gate on the well-known path)', async () => {
    await withMockedFetch(respond(401, 'Unauthorized'), async () => {
      assert.strictEqual(await detectProtocol('https://agent.example.com'), 'a2a');
    });
  });

  test('429 from card path → a2a (rate limit on the well-known path)', async () => {
    await withMockedFetch(respond(429, 'Too Many Requests'), async () => {
      assert.strictEqual(await detectProtocol('https://agent.example.com'), 'a2a');
    });
  });

  test('404 from card path → mcp (true negative evidence)', async () => {
    await withMockedFetch(respond(404, 'Not Found'), async () => {
      assert.strictEqual(
        await detectProtocol('https://agent.example.com'),
        'mcp',
        '404 means the host genuinely does not have an A2A well-known path'
      );
    });
  });

  test('400 from card path → mcp (other 4xx still negative)', async () => {
    await withMockedFetch(respond(400), async () => {
      assert.strictEqual(await detectProtocol('https://agent.example.com'), 'mcp');
    });
  });

  test('network error / timeout → a2a (slow A2A more likely than MCP at /)', async () => {
    await withMockedFetch(networkError(), async () => {
      assert.strictEqual(
        await detectProtocol('https://agent.example.com'),
        'a2a',
        'A network error on the well-known path is more consistent with a slow A2A host than a missing MCP /mcp endpoint'
      );
    });
  });

  test('URL ending with /mcp short-circuits to mcp without probing', async () => {
    let probed = false;
    await withMockedFetch(
      async () => {
        probed = true;
        return { ok: true, status: 200 };
      },
      async () => {
        assert.strictEqual(await detectProtocol('https://agent.example.com/mcp'), 'mcp');
        assert.strictEqual(probed, false, 'Should not probe the well-known path when URL already ends in /mcp');
      }
    );
  });
});
