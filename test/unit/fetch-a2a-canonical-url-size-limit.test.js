/**
 * Integration check that `SingleAgentClient.fetchA2ACanonicalUrl()` honors
 * `transport.maxResponseBytes` on A2A canonical-URL discovery — the call
 * site that runs implicitly via `resolveCanonicalUrl()` before any A2A
 * request that needs the canonical URL.
 *
 * Closes adcontextprotocol/adcp-client#1804 — companion to #1799
 * (`getAgentInfo`), filed by the security review on PR #1802 because
 * `fetchA2ACanonicalUrl` bypassed the cap even after `getAgentInfo`
 * started honoring it.
 *
 * NOTE: `getAgentInfo()` does NOT route through `fetchA2ACanonicalUrl` —
 * it has its own inline A2A discovery branch (wrapped by PR #1802).
 * To exercise the new wrap, drive through `resolveCanonicalUrl()` which
 * is the only public method that goes through `ensureCanonicalUrlResolved`
 * → `fetchA2ACanonicalUrl`. Pattern mirrors
 * `test/unit/get-agent-info-size-limit.test.js`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AgentClient } = require('../../dist/lib/core/AgentClient');
const { ResponseTooLargeError } = require('../../dist/lib/errors');

describe('SingleAgentClient.fetchA2ACanonicalUrl() — maxResponseBytes (A2A discovery)', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      // Both well-known paths serve the oversized card. Discovery walks
      // multiple candidates; we want a hit on either to trigger the cap.
      if (req.url === '/.well-known/agent.json' || req.url === '/.well-known/agent-card.json') {
        const padding = 'x'.repeat(5 * 1024 * 1024);
        const body = JSON.stringify({
          name: 'oversized-discovery-canonical',
          url: `${baseUrl}/a2a`,
          description: padding,
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('aborts the canonical-URL discovery fetch with ResponseTooLargeError when the card exceeds the cap', async () => {
    const client = new AgentClient(
      { id: 'oversized-a2a-canonical', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { maxResponseBytes: 64 * 1024 } }
    );

    await assert.rejects(
      () => client.resolveCanonicalUrl(),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}: ${err?.message}`
        );
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 64 * 1024);
        return true;
      }
    );
  });

  it('lets the canonical-URL discovery succeed when the cap is generous', async () => {
    const client = new AgentClient(
      { id: 'small-a2a-canonical', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { maxResponseBytes: 16 * 1024 * 1024 } }
    );

    // Cap is large enough that the 5 MB padded card fits — discovery
    // resolves without throwing.
    const canonical = await client.resolveCanonicalUrl();
    assert.strictEqual(typeof canonical, 'string');
    assert.match(canonical, /^http:\/\/127\.0\.0\.1:\d+/);
  });
});
