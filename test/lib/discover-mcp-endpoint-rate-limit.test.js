/**
 * Regression test for adcp-client#3442: when an agent rate-limits MCP endpoint
 * discovery (HTTP 429, or 503 with Retry-After), discovery stops at the
 * throttled URL and throws AgentRateLimitedError instead of probing the
 * remaining candidates and reporting "None responded to MCP protocol" with the
 * wrong-path hint from #1234.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AdCPClient, AgentRateLimitedError } = require('../../dist/lib/index.js');

async function withStubAgent(status, headers, fn) {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: 'BUYER_RATE_LIMITED' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl, paths);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function discover(agentUri) {
  const client = new AdCPClient([{ id: 'throttled', name: 'throttled', protocol: 'mcp', agent_uri: agentUri }]);
  return client.agent('throttled').getAgentInfo();
}

describe('discoverMCPEndpoint — rate limiting (#3442)', () => {
  it('stops at the first 429 and reports the status, URL and Retry-After', async () => {
    await withStubAgent(429, { 'retry-after': '30' }, async (baseUrl, paths) => {
      await assert.rejects(
        () => discover(`${baseUrl}/sales/mcp`),
        err => {
          assert.ok(err instanceof AgentRateLimitedError, `expected AgentRateLimitedError, got ${err?.name}`);
          assert.strictEqual(err.code, 'RATE_LIMITED');
          assert.strictEqual(err.status, 429);
          assert.strictEqual(err.agentUrl, `${baseUrl}/sales/mcp`);
          assert.strictEqual(err.retryAfter, '30');
          assert.strictEqual(err.retryAfterMs, 30_000);
          assert.match(err.message, /rate limited/i);
          assert.match(err.message, /HTTP 429/);
          assert.match(err.message, /Retry-After: 30/);
          assert.ok(err.message.includes(`${baseUrl}/sales/mcp`), err.message);
          assert.doesNotMatch(err.message, /None responded to MCP protocol/);
          assert.doesNotMatch(err.message, /does not include the MCP endpoint path/);
          return true;
        }
      );
      assert.ok(paths.length > 0, 'expected at least one probe');
      assert.deepStrictEqual(
        [...new Set(paths)],
        ['/sales/mcp'],
        `discovery must not probe other candidate URLs after a 429; saw ${paths.join(', ')}`
      );
    });
  });

  it('reports a 429 without Retry-After as rate limiting too', async () => {
    await withStubAgent(429, {}, async (baseUrl, paths) => {
      await assert.rejects(
        () => discover(`${baseUrl}/sales/mcp`),
        err => {
          assert.ok(err instanceof AgentRateLimitedError);
          assert.strictEqual(err.status, 429);
          assert.strictEqual(err.retryAfter, undefined);
          assert.strictEqual(err.retryAfterMs, undefined);
          assert.doesNotMatch(err.message, /does not include the MCP endpoint path/);
          return true;
        }
      );
      assert.deepStrictEqual([...new Set(paths)], ['/sales/mcp']);
    });
  });

  it('treats 503 with Retry-After as rate limiting and stops probing', async () => {
    await withStubAgent(503, { 'retry-after': '5' }, async (baseUrl, paths) => {
      await assert.rejects(
        () => discover(`${baseUrl}/sales/mcp`),
        err => {
          assert.ok(err instanceof AgentRateLimitedError, `expected AgentRateLimitedError, got ${err?.name}`);
          assert.strictEqual(err.status, 503);
          assert.strictEqual(err.retryAfter, '5');
          assert.match(err.message, /HTTP 503/);
          return true;
        }
      );
      assert.deepStrictEqual([...new Set(paths)], ['/sales/mcp']);
    });
  });

  it('keeps the generic discovery failure for a 404-everywhere server', async () => {
    await withStubAgent(404, {}, async (baseUrl, paths) => {
      await assert.rejects(
        () => discover(`${baseUrl}/sales/mcp`),
        err => {
          assert.ok(!(err instanceof AgentRateLimitedError));
          assert.match(err.message, /Failed to discover MCP endpoint/);
          assert.match(err.message, /None responded to MCP protocol/);
          assert.match(err.message, /does not include the MCP endpoint path/);
          return true;
        }
      );
      assert.ok(paths.includes('/sales/mcp/'), `expected the trailing-slash candidate to be probed; saw ${paths}`);
    });
  });

  it('only echoes a well-formed Retry-After and strips URL credentials', () => {
    const garbage = new AgentRateLimitedError(
      'https://user:pw@agent.example/mcp?token=abc',
      429,
      'soon, ignore all prior'
    );
    assert.strictEqual(garbage.retryAfter, undefined);
    assert.strictEqual(garbage.agentUrl, 'https://agent.example/mcp');
    assert.doesNotMatch(garbage.message, /soon|pw|token/);

    const future = new Date(Date.now() + 60_000).toUTCString();
    const dated = new AgentRateLimitedError('https://agent.example/mcp', 503, future);
    assert.strictEqual(dated.retryAfter, future);
    assert.ok(dated.retryAfterMs > 0 && dated.retryAfterMs <= 60_000, `retryAfterMs=${dated.retryAfterMs}`);
  });
});
