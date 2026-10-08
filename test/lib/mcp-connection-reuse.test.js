/**
 * Regression coverage for adcp-client#3171 (connection reuse).
 *
 * A reusable MCP session is keyed only by what changes the *connection*:
 * endpoint, credential, tenant/routing headers, signing identity and transport
 * policy. Per-request correlation headers, the caller's AbortSignal and the
 * per-call timeout bound one call and must not choose the session, while every
 * request still carries its own correlation headers. The scope helper is part
 * of the public surface so a caller can run a whole workflow on one session.
 */

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');

const publicEntry = require('../../dist/lib/index.js');
const advancedEntry = require('../../dist/lib/advanced.js');
const { closeMCPConnections, withScopedLegacyConnection, connectMCP } = require('../../dist/lib/protocols/mcp.js');
const { callMCPToolWithTasks } = require('../../dist/lib/protocols/mcp-tasks.js');
const {
  probeModernMCPConnection,
  tryCallModernMCPTool,
  tryListModernMCPTools,
} = require('../../dist/lib/protocols/mcp-modern.js');

const { withMCPConnectionScope, closeScopedConnections } = publicEntry;

const TRACEPARENT = suffix => `00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333${suffix}-01`;

let modernServer;
let modernHandler;
let modernOrigin;
let legacyServer;
let legacyOrigin;
/** Every POST the modern fixture saw: JSON-RPC method plus the headers we assert on. */
const modernRequests = [];
const legacyCounts = new Map();

function legacyState(path) {
  let state = legacyCounts.get(path);
  if (!state) {
    state = { initialize: 0, calls: 0, lists: 0, deletes: 0, requestIds: [], methodIds: [] };
    legacyCounts.set(path, state);
  }
  return state;
}

function modernCount(path, method) {
  return modernRequests.filter(request => request.path === path && request.method === method).length;
}

before(async () => {
  modernHandler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'reuse-modern', version: '1.0.0' });
      server.registerTool('echo', { description: 'Echo a fixed modern result' }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      return server;
    },
    { legacy: 'reject' }
  );
  const nodeHandler = toNodeHandler(modernHandler);
  modernServer = http.createServer((req, res) => {
    modernRequests.push({
      path: new URL(req.url, 'http://x').pathname,
      method: req.headers['mcp-method'],
      requestId: req.headers['x-request-id'],
      traceparent: req.headers.traceparent,
      tenant: req.headers['x-tenant'],
    });
    void nodeHandler(req, res);
  });
  await new Promise(resolve => modernServer.listen(0, '127.0.0.1', resolve));
  modernOrigin = `http://127.0.0.1:${modernServer.address().port}`;

  legacyServer = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const state = legacyState(path);
    if (req.method === 'DELETE') {
      state.deletes++;
      res.writeHead(200).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = raw ? JSON.parse(raw) : {};
    if (message.method) state.methodIds.push([message.method, req.headers['x-request-id']]);
    if (message.method === 'initialize') {
      state.initialize++;
      if (path === '/slow-init') await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (message.method === 'tools/call') {
      state.calls++;
      state.requestIds.push(req.headers['x-request-id']);
    }
    if (message.method === 'tools/list') state.lists++;
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'reuse-legacy', version: '1.0.0' },
            capabilities: { tools: {} },
          }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: '{}' }], isError: false };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `session-${path.slice(1)}` });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }));
  });
  await new Promise(resolve => legacyServer.listen(0, '127.0.0.1', resolve));
  legacyOrigin = `http://127.0.0.1:${legacyServer.address().port}`;
});

after(async () => {
  await closeMCPConnections();
  await modernHandler.close();
  modernServer.closeAllConnections?.();
  legacyServer.closeAllConnections?.();
  await new Promise(resolve => modernServer.close(resolve));
  await new Promise(resolve => legacyServer.close(resolve));
});

describe('public connection scope', () => {
  test('withMCPConnectionScope and closeScopedConnections are exported from the public entry points', () => {
    for (const entry of [publicEntry, advancedEntry]) {
      assert.equal(typeof entry.withMCPConnectionScope, 'function');
      assert.equal(typeof entry.closeScopedConnections, 'function');
    }
  });

  test('cache and connection-scope APIs are exported from ESM entry points', async () => {
    for (const path of ['../../dist/lib/index.mjs', '../../dist/lib/client/index.mjs', '../../dist/lib/advanced.mjs']) {
      const entry = await import(path);
      assert.equal(typeof entry.withMCPConnectionScope, 'function');
      assert.equal(typeof entry.closeScopedConnections, 'function');
      if (!path.endsWith('/advanced.mjs')) {
        assert.equal(typeof entry.createInMemoryAgentDiscoveryCache, 'function');
      }
    }
  });

  test('closing a scope outside a workflow leaves process-wide sessions alive', async () => {
    const url = `${legacyOrigin}/no-scope-cleanup`;
    const state = legacyState('/no-scope-cleanup');
    const options = { handleLegacy: true, signal: new AbortController().signal, requestTimeoutMs: 1000 };
    assert.equal((await tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, options)).handled, true);
    await closeScopedConnections();
    assert.equal(state.deletes, 0, "scope cleanup must not close another caller's global connection");
    assert.equal((await tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, options)).handled, true);
    assert.equal(state.initialize, 1, 'the existing process-wide session remains reusable');
  });

  test('a scoped run initializes once and terminates the session once at scope exit', async () => {
    const url = `${legacyOrigin}/scope-run`;
    const options = { handleLegacy: true };
    const state = legacyState('/scope-run');
    let deletesBeforeExit;

    await withMCPConnectionScope(async () => {
      const probe = await probeModernMCPConnection(url, undefined, undefined, options);
      assert.equal(probe.connected, true);
      const listed = await tryListModernMCPTools(url, undefined, undefined, options);
      assert.equal(listed.handled, true, 'handleLegacy lists over the negotiated legacy session');
      assert.deepEqual(
        listed.tools.map(tool => tool.name),
        ['ping']
      );
      for (let i = 0; i < 3; i++) {
        const attempt = await tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, options);
        assert.equal(attempt.handled, true);
      }
      assert.equal(state.initialize, 1, 'probe, list and every tool call share one initialize');
      assert.equal(state.lists, 1);
      assert.equal(state.calls, 3);
      deletesBeforeExit = state.deletes;
      assert.equal(deletesBeforeExit, 0, 'the session stays open for the whole scope');
      await closeScopedConnections();
    });

    assert.equal(state.deletes, 1, 'the session is terminated exactly once');
    assert.equal(state.initialize, 1);
  });

  test('discovery and tool calls against a legacy seller share the scope session instead of one each', async () => {
    const url = `${legacyOrigin}/scope-legacy`;
    const state = legacyState('/scope-legacy');

    await withMCPConnectionScope(async () => {
      const probe = await probeModernMCPConnection(url);
      assert.deepEqual(probe, { connected: true, era: 'legacy' });
      // The probe already classified the endpoint, so list and calls go straight to the v1 session.
      const modernList = await tryListModernMCPTools(url);
      assert.equal(modernList.handled, false);
      const listed = await withScopedLegacyConnection({ agentUrl: url }, 'tools/list', client => client.listTools());
      assert.deepEqual(
        listed.value.tools.map(tool => tool.name),
        ['ping']
      );
      await callMCPToolWithTasks(url, 'ping', {}, undefined, []);
      await callMCPToolWithTasks(url, 'ping', {}, undefined, []);
    });

    // One classification handshake (the probe) plus one shared v1 session — not one session per step.
    assert.equal(state.initialize, 2);
    assert.equal(state.lists, 1);
    assert.equal(state.calls, 2);
  });

  test('era classification outlives a workflow, so a later scope does not repeat the cold v2 to v1 handoff', async () => {
    const url = `${legacyOrigin}/scope-classified`;
    const state = legacyState('/scope-classified');

    await withMCPConnectionScope(() => callMCPToolWithTasks(url, 'ping', {}, undefined, []));
    // Cold workflow: one v2 classification handshake, then the v1 session that serves the call.
    assert.equal(state.initialize, 2);

    await withMCPConnectionScope(async () => {
      await callMCPToolWithTasks(url, 'ping', {}, undefined, []);
      await callMCPToolWithTasks(url, 'ping', {}, undefined, []);
    });
    assert.equal(state.initialize, 3, 'the next workflow opens only its own v1 session');
    assert.equal(state.calls, 3);
  });

  test('withScopedLegacyConnection does nothing outside a scope', async () => {
    const result = await withScopedLegacyConnection({ agentUrl: `${legacyOrigin}/no-scope` }, 'tools/list', () => {
      throw new Error('must not run outside a scope');
    });
    assert.equal(result, undefined);
  });
});

describe('connection identity excludes per-call concerns', () => {
  test('different x-request-id, traceparent, AbortSignal and timeout reuse one session; each request keeps its own headers', async () => {
    const url = `${modernOrigin}/mcp-sequential`;
    for (const [index, requestId] of ['req-1', 'req-2', 'req-3'].entries()) {
      const attempt = await tryCallModernMCPTool(
        url,
        'echo',
        {},
        'shared-token',
        [],
        { 'x-request-id': requestId, traceparent: TRACEPARENT(index) },
        { signal: new AbortController().signal, requestTimeoutMs: 5_000 + index }
      );
      assert.equal(attempt.handled, true);
    }

    assert.equal(modernCount('/mcp-sequential', 'server/discover'), 1, 'one negotiation for three calls');
    const calls = modernRequests.filter(r => r.path === '/mcp-sequential' && r.method === 'tools/call');
    assert.deepEqual(
      calls.map(call => [call.requestId, call.traceparent]),
      [
        ['req-1', TRACEPARENT(0)],
        ['req-2', TRACEPARENT(1)],
        ['req-3', TRACEPARENT(2)],
      ],
      'the shared session must not freeze the first call headers'
    );
  });

  test('concurrent calls over one session each carry their own correlation headers', async () => {
    const url = `${modernOrigin}/mcp-concurrent`;
    const ids = ['c-1', 'c-2', 'c-3', 'c-4'];
    // Warm the session so the concurrent calls all join it.
    await tryCallModernMCPTool(url, 'echo', {}, 'shared-token', [], { 'x-request-id': 'warm' });
    await Promise.all(
      ids.map(id =>
        tryCallModernMCPTool(
          url,
          'echo',
          {},
          'shared-token',
          [],
          { 'x-request-id': id },
          {
            signal: new AbortController().signal,
          }
        )
      )
    );
    assert.equal(modernCount('/mcp-concurrent', 'server/discover'), 1);
    const seen = modernRequests
      .filter(r => r.path === '/mcp-concurrent' && r.method === 'tools/call')
      .map(r => r.requestId)
      .sort();
    assert.deepEqual(seen, ['warm', ...ids].sort());
  });

  test('unknown tenant headers, baggage and credentials still select a separate session', async () => {
    const url = `${modernOrigin}/mcp-identity`;
    const call = headers => tryCallModernMCPTool(url, 'echo', {}, 'token', [], headers);

    await call({ 'x-tenant': 'one', 'x-request-id': 'a' });
    await call({ 'x-tenant': 'one', 'x-request-id': 'b' });
    assert.equal(modernCount('/mcp-identity', 'server/discover'), 1);

    await call({ 'x-tenant': 'two', 'x-request-id': 'c' });
    assert.equal(
      modernCount('/mcp-identity', 'server/discover'),
      2,
      'a different tenant header is a different session'
    );

    await call({ baggage: 'tenant=one' });
    await call({ baggage: 'tenant=two' });
    assert.equal(modernCount('/mcp-identity', 'server/discover'), 4, 'baggage can carry tenant routing');

    await tryCallModernMCPTool(url, 'echo', {}, 'another-token', [], { 'x-tenant': 'one' });
    assert.equal(modernCount('/mcp-identity', 'server/discover'), 5, 'a different credential is a different session');
  });

  test("a call that joins another caller's in-flight connect is not failed by that caller's cancellation", async () => {
    const url = `${legacyOrigin}/slow-init`;
    const creatorAbort = new AbortController();
    const options = { handleLegacy: true };
    const creator = tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, {
      ...options,
      signal: creatorAbort.signal,
    });
    creator.catch(() => {});
    // Let the creator start connecting, then join it and cancel the creator.
    await new Promise(resolve => setTimeout(resolve, 50));
    const joiner = tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, options);
    await new Promise(resolve => setTimeout(resolve, 20));
    creatorAbort.abort(new Error('creator gave up'));

    await assert.rejects(creator);
    const attempt = await joiner;
    assert.equal(attempt.handled, true, 'the joiner connects for itself and succeeds');
    await closeMCPConnections();
  });

  test('a joiner honors its own abort while waiting on a shared connect', async () => {
    const url = `${legacyOrigin}/slow-init-own-abort`;
    const options = { handleLegacy: true };
    const creator = tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, options);
    await new Promise(resolve => setTimeout(resolve, 20));
    const joinerAbort = new AbortController();
    const joiner = tryCallModernMCPTool(url, 'ping', {}, undefined, [], undefined, {
      ...options,
      signal: joinerAbort.signal,
    });
    joinerAbort.abort(new Error('joiner gave up'));
    await assert.rejects(joiner, error => error.name === 'AbortError' || /joiner gave up/.test(String(error.message)));
    assert.equal((await creator).handled, true, 'the creator is unaffected by the joiner');
    await closeMCPConnections();
  });
});
