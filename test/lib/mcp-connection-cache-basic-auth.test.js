/**
 * Connection-cache key disambiguation for non-Bearer auth schemes.
 *
 * Before this fix, `connectionCacheKey` hashed `authToken` only. When two
 * callers targeted the same agent URL with the CLI's `--auth-scheme basic`
 * shape (or any other non-Bearer caller-supplied `Authorization` header),
 * `authToken` was undefined and the cache key collapsed to just `agentUrl`.
 * A multi-tenant SDK consumer (`createTestClient`-fronted host serving N
 * principals) would then route both callers through the SAME cached MCP
 * transport — the transport closed over whichever Basic credential it saw
 * first.
 *
 * This test exercises the fix by spinning up a local MCP server, calling it
 * twice via `callMCPTool` with different `Authorization: Basic …` headers,
 * and asserting the server received two distinct outgoing credentials. A
 * regression would show the second call carrying the first call's
 * credential (cache hit → wrong transport).
 *
 * Spec-irrelevant headers (`X-Tenant`, `User-Agent`, etc.) do NOT need this
 * treatment because only `Authorization` is the credential disambiguator.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { callMCPTool, closeMCPConnections } = require('../../dist/lib/protocols/mcp');

let server;
let baseUrl;
// Track every distinct Authorization value we've ever seen. Each MCP call
// triggers >1 HTTP requests (initialize handshake + tools/list); we want to
// know whether tenant-b's credential ever reached the wire, not which
// connection it rode.
const seenAuths = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    seenAuths.add(req.headers.authorization ?? '');
    // Respond as a minimal MCP server: accept initialize + return empty
    // tools, then accept callTool and return a no-op result.
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end();
      }
      const id = msg.id ?? null;
      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'test', version: '1.0.0' },
          capabilities: { tools: {} },
        };
      } else if (msg.method === 'tools/list') {
        result = { tools: [] };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: '{}' }], isError: false };
      } else {
        result = {};
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
});

after(async () => {
  await closeMCPConnections();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve()));
});

test('two callers with different Authorization: Basic headers get distinct cached MCP transports', async () => {
  // Distinct Basic credentials — different tenants on a multi-tenant gateway.
  const basicA = 'Basic ' + Buffer.from('tenant-a:secret-A').toString('base64');
  const basicB = 'Basic ' + Buffer.from('tenant-b:secret-B').toString('base64');

  // No authToken — credential rides entirely on customHeaders (this is the
  // shape the CLI builds when `--auth-scheme basic` is in effect).
  await callMCPTool(baseUrl, 'tools/list', {}, undefined, [], { Authorization: basicA }).catch(() => {});
  await callMCPTool(baseUrl, 'tools/list', {}, undefined, [], { Authorization: basicB }).catch(() => {});

  const seen = Array.from(seenAuths);
  assert.ok(
    seen.includes(basicA),
    `expected the server to have received tenant-a's Basic credential, saw: ${seen.join(', ')}`
  );
  assert.ok(
    seen.includes(basicB),
    `expected the server to have received tenant-b's Basic credential — regression would show only tenant-a's credential because both calls shared the same cached transport. Saw: ${seen.join(', ')}`
  );
});

test('two callers with the SAME Authorization: Basic header send only that one credential (no cross-tenant leak via shared cache)', async () => {
  // Reset for isolation.
  seenAuths.clear();
  // Use a credential unique to this test so previously-cached transports
  // don't satisfy the lookup. The invariant we assert: only THIS credential
  // ever reaches the wire — a cache key that didn't include the auth
  // fingerprint would let prior test calls' transports satisfy this one and
  // we'd see other credentials in `seenAuths`.
  const basicSame = 'Basic ' + Buffer.from('tenant-shared:same-secret').toString('base64');

  await callMCPTool(baseUrl, 'tools/list', {}, undefined, [], { Authorization: basicSame }).catch(() => {});
  await callMCPTool(baseUrl, 'tools/list', {}, undefined, [], { Authorization: basicSame }).catch(() => {});

  const seen = Array.from(seenAuths);
  assert.strictEqual(
    seen.length,
    1,
    `expected exactly one distinct Authorization value reaching the wire, saw: ${JSON.stringify(seen)}`
  );
  assert.strictEqual(seen[0], basicSame);
});
