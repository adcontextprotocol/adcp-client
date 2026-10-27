const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { withMCPConnectionScope } = require('../../dist/lib/protocols/mcp-scope.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

const nonterminalStatuses = ['submitted', 'working', 'input-required', 'auth-required'];

async function seller(t, status) {
  const sessions = new Map();
  const acceptedSessions = [];
  const deletes = [];
  const activeWork = new Set();
  const closedClients = [];
  const workAuthorizations = [];
  const sessionByClient = new WeakMap();
  const originalConnect = Client.prototype.connect;
  t.mock.method(Client.prototype, 'connect', async function (transport, ...args) {
    const result = await originalConnect.call(this, transport, ...args);
    if (transport.sessionId) sessionByClient.set(this, transport.sessionId);
    return result;
  });
  const originalClose = Client.prototype.close;
  t.mock.method(Client.prototype, 'close', async function (...args) {
    const sessionId = sessionByClient.get(this);
    await originalClose.apply(this, args);
    if (sessionId) closedClients.push(sessionId);
  });
  const capabilities = {
    adcp_version: '3.2',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.2'],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
    },
    supported_protocols: ['media_buy'],
    specialisms: [],
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      if (body?.method === 'server/discover') return res.writeHead(404).end();
      const sessionId = req.headers['mcp-session-id'];
      if (body?.method === 'tools/call' && body.params?.name === 'async_work') {
        workAuthorizations.push(req.headers.authorization);
      }
      if (req.method === 'DELETE') {
        deletes.push(sessionId);
        activeWork.delete(sessionId);
      }
      let session = sessions.get(sessionId);
      if (!session && body?.method === 'initialize') {
        const mcp = new McpServer({ name: 'async-session-seller', version: '1' });
        mcp.registerTool('get_adcp_capabilities', { description: 'Capabilities' }, async () => ({
          content: [{ type: 'text', text: JSON.stringify(capabilities) }],
          structuredContent: capabilities,
        }));
        mcp.registerTool('async_work', { description: 'Start work', inputSchema: {} }, async (_args, extra) => {
          acceptedSessions.push(extra.sessionId);
          if (nonterminalStatuses.includes(status)) activeWork.add(extra.sessionId);
          const result = { adcp_version: '3.2', status, task_id: 'accepted-work', message: 'Seller task status' };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => sessions.set(id, { mcp, transport }),
        });
        await mcp.connect(transport);
        session = { mcp, transport };
      }
      if (!session) return res.writeHead(404).end();
      await session.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('Fixture failure');
      else res.end();
    }
  });
  server.keepAliveTimeout = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await closeMCPConnections();
    await Promise.all([...sessions.values()].map(({ mcp }) => mcp.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const makeClient = authToken =>
    new SingleAgentClient(
      {
        id: randomUUID(),
        name: 'Async seller',
        auth_token: authToken,
        protocol: 'mcp',
        agent_uri: `http://127.0.0.1:${server.address().port}/mcp`,
      },
      {
        adcpVersion: '3.2.7',
        allowPrivateIp: true,
        transport: { allowPrivateIp: true },
        validateFeatures: false,
        validation: { requests: 'off', responses: 'off' },
      }
    );
  return {
    client: makeClient('buyer-a'),
    makeClient,
    acceptedSessions,
    deletes,
    activeWork,
    closedClients,
    workAuthorizations,
    setStatus(value) {
      status = value;
    },
  };
}

for (const status of nonterminalStatuses) {
  test(`implicit ${status} result closes local transports without terminating accepted seller work`, async t => {
    const state = await seller(t, status);
    const result = await state.client.executeCustomTask('async_work', {});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.status, status);
    assert.equal(state.acceptedSessions.length, 1);
    const sessionId = state.acceptedSessions[0];
    assert.equal(typeof sessionId, 'string');
    assert.ok(state.closedClients.includes(sessionId), 'the implicit scope must still close its local client');
    assert.equal(state.deletes.includes(sessionId), false, 'a nonterminal result must not send session DELETE');
    assert.equal(state.activeWork.has(sessionId), true, 'accepted seller work remains live after the result returns');
  });
}

test('a completed implicit task still terminates its owned session', async t => {
  const state = await seller(t, 'completed');
  const result = await state.client.executeCustomTask('async_work', {});
  assert.equal(result.status, 'completed');
  const sessionId = state.acceptedSessions[0];
  assert.ok(state.closedClients.includes(sessionId));
  assert.equal(state.deletes.filter(id => id === sessionId).length, 1);
});

for (const status of nonterminalStatuses) {
  test(`an explicit caller-owned workflow keeps normal final session cleanup after ${status}`, async t => {
    const state = await seller(t, status);
    await withMCPConnectionScope(async () => {
      const result = await state.client.executeCustomTask('async_work', {});
      assert.equal(result.status, status);
      const sessionId = state.acceptedSessions[0];
      assert.equal(state.deletes.includes(sessionId), false);
      assert.equal(state.closedClients.includes(sessionId), false);
    });
    const sessionId = state.acceptedSessions[0];
    assert.equal(state.deletes.filter(id => id === sessionId).length, 1);
    assert.ok(state.closedClients.includes(sessionId));
  });
}

for (const callerOwnedScope of [false, true]) {
  test(`deferred task results respect scope ownership (caller-owned: ${callerOwnedScope})`, async t => {
    const state = await seller(t, 'completed');
    const deferred = { success: true, status: 'deferred' };
    // MCP currently returns pauses as input/auth-required. Exercise the shared
    // task boundary for a deferred result from an enclosing callback/HITL flow.
    const run = async () => {
      const result = await state.client.withTaskConnectionScope({}, async () => {
        await state.client.executeCustomTask('async_work', {});
        return deferred;
      });
      assert.equal(result, deferred);
      const sessionId = state.acceptedSessions[0];
      assert.equal(state.deletes.includes(sessionId), false);
      assert.equal(state.closedClients.includes(sessionId), !callerOwnedScope);
    };
    if (callerOwnedScope) await withMCPConnectionScope(run);
    else await run();
    const sessionId = state.acceptedSessions[0];
    assert.ok(state.closedClients.includes(sessionId));
    assert.equal(state.deletes.includes(sessionId), callerOwnedScope);
  });
}

test('preserving one buyer async task does not reuse its session or credentials for another buyer', async t => {
  const state = await seller(t, 'working');
  assert.equal((await state.client.executeCustomTask('async_work', {})).status, 'working');
  const firstSession = state.acceptedSessions[0];
  state.setStatus('completed');
  const second = state.makeClient('buyer-b');
  assert.equal((await second.executeCustomTask('async_work', {})).status, 'completed');
  const secondSession = state.acceptedSessions[1];
  assert.notEqual(firstSession, secondSession);
  assert.equal(state.deletes.includes(firstSession), false);
  assert.equal(state.deletes.includes(secondSession), true);
  assert.equal(state.activeWork.has(firstSession), true);
  assert.deepEqual(state.workAuthorizations, ['Bearer buyer-a', 'Bearer buyer-b']);
});

for (const outcome of ['completed', 'throw']) {
  test(`only the owning implicit task result decides cleanup after a nested nonterminal result (${outcome})`, async t => {
    const state = await seller(t, 'working');
    const run = state.client.withTaskConnectionScope({}, async () => {
      const nested = await state.client.executeCustomTask('async_work', {});
      assert.equal(nested.status, 'working');
      if (outcome === 'throw') throw new Error('owner failed');
      return { success: true, status: 'completed' };
    });
    if (outcome === 'throw') await assert.rejects(run, /owner failed/);
    else assert.equal((await run).status, 'completed');
    const sessionId = state.acceptedSessions[0];
    assert.ok(state.closedClients.includes(sessionId));
    assert.equal(state.deletes.filter(id => id === sessionId).length, 1);
  });
}
