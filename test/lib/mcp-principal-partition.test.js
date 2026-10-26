const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpHandler, McpServer: ModernServer } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');
const {
  withMCPConnectionScope,
  SingleAgentClient,
  createInMemoryAgentDiscoveryCache,
} = require('../../dist/lib/index.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { agentDiscoveryCacheKey } = require('../../dist/lib/core/agent-discovery-cache.js');

async function seller(t, modern, nativeTasks = false, options = {}) {
  const requests = [];
  const sessions = new Map();
  let initializeRejected = false;
  const { InMemoryTaskStore } = require('@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js');
  const taskStore = nativeTasks ? new InMemoryTaskStore() : undefined;
  const capabilities = {
    adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
    supported_protocols: ['media_buy'],
  };
  const registerCapabilities = mcp =>
    mcp.registerTool('get_adcp_capabilities', { description: 'Advertise capabilities' }, async () => ({
      content: [{ type: 'text', text: JSON.stringify(capabilities) }],
    }));
  let handler;
  if (modern) {
    handler = createMcpHandler(
      () => {
        const mcp = new ModernServer({ name: 'partition-test', version: '1.0.0' });
        mcp.registerTool('ping', { description: 'Run a task' }, async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }));
        registerCapabilities(mcp);
        return mcp;
      },
      { legacy: 'reject' }
    );
  }
  const nodeHandler = handler && toNodeHandler(handler);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    if (modern) {
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({
          httpMethod: req.method,
          headers: { ...req.headers },
          body,
          method: body ? JSON.parse(body).method : undefined,
          operation: body ? JSON.parse(body).params?.name : undefined,
        });
      });
      return nodeHandler(req, res);
    }
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = body ? JSON.parse(body) : undefined;
    requests.push({
      httpMethod: req.method,
      headers: { ...req.headers },
      body,
      method: parsed?.method,
      operation: parsed?.params?.name,
    });
    if (parsed?.method === 'server/discover') return res.writeHead(404).end();
    if (parsed?.method === 'initialize' && options.rejectFirstInitialize && !initializeRejected) {
      initializeRejected = true;
      return res.writeHead(405).end();
    }
    let session = sessions.get(req.headers['mcp-session-id']);
    if (!session && parsed?.method === 'initialize') {
      const mcp = nativeTasks
        ? require('../../dist/lib/server/tasks.js').createTaskCapableServer('partition-tasks', '1.0.0', { taskStore })
        : new McpServer({ name: 'partition-test', version: '1.0.0' });
      if (nativeTasks)
        require('../../dist/lib/server/tasks.js').registerAdcpTaskTool(
          mcp,
          'create_media_buy',
          { description: 'Start work', inputSchema: {}, taskSupport: 'required' },
          {
            createTask: async (_args, extra) => ({ task: await extra.taskStore.createTask({ ttl: 60000 }) }),
            getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
            getTaskResult: async (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
          }
        );
      mcp.registerTool('ping', { inputSchema: {} }, async () => {
        await options.onPing?.();
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      registerCapabilities(mcp);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => sessions.set(id, { mcp, transport }),
      });
      await mcp.connect(transport);
      session = { mcp, transport };
    }
    if (!session) return res.writeHead(404).end();
    if (nativeTasks && parsed?.method === 'tasks/get') await new Promise(resolve => setTimeout(resolve, 2000));
    await session.transport.handleRequest(req, res, parsed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  t.after(async () => {
    await closeMCPConnections();
    taskStore?.cleanup();
    await handler?.close();
    await Promise.all([...sessions.values()].map(session => session.mcp.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const agent = {
    id: 'partition-test',
    name: 'Partition test',
    protocol: 'mcp',
    agent_uri: url,
    auth_token: 'shared-token',
  };
  return { requests, agent, taskStore, call: transport => ProtocolClient.callTool(agent, 'ping', {}, { transport }) };
}

for (const modern of [false, true]) {
  test(`${modern ? 'modern' : 'legacy'} MCP isolates caller partitions and keeps them off the wire`, async t => {
    const s = await seller(t, modern);
    const partitionA = 'local-principal-alpha-private';
    const partitionB = 'local-principal-beta-private';
    const negotiation = () => s.requests.filter(r => r.method === (modern ? 'server/discover' : 'initialize')).length;
    await s.call({ connectionPartition: partitionA });
    const first = negotiation();
    await s.call({ connectionPartition: partitionA });
    assert.equal(negotiation(), first, 'same principal must reuse its connection');
    await s.call({ connectionPartition: partitionB });
    assert.ok(negotiation() > first, 'different principal must negotiate a separate connection');
    assert.ok(!JSON.stringify(s.requests).includes(partitionA));
    assert.ok(!JSON.stringify(s.requests).includes(partitionB));
    const beforeDefault = negotiation();
    const deletesBeforeDefault = s.requests.filter(r => r.httpMethod === 'DELETE').length;
    await s.call();
    await s.call();
    assert.ok(negotiation() >= beforeDefault + 2, 'unscoped default calls must own separate sessions');
    if (!modern)
      assert.ok(
        s.requests.filter(r => r.httpMethod === 'DELETE').length >= deletesBeforeDefault + 2,
        'each successful one-shot session must be terminated'
      );
    const beforeProcess = negotiation();
    await s.call({ connectionReuse: 'process' });
    const processWarm = negotiation();
    assert.ok(processWarm > beforeProcess);
    await s.call({ connectionReuse: 'process' });
    assert.equal(negotiation(), processWarm, 'explicit process opt-in preserves reuse');
    await withMCPConnectionScope(async () => {
      await s.call({ connectionPartition: partitionA });
      const scopeWarm = negotiation();
      await s.call({ connectionPartition: partitionA });
      assert.equal(negotiation(), scopeWarm);
      await s.call({ connectionPartition: partitionB });
      assert.ok(negotiation() > scopeWarm, 'a workflow scope must still isolate its principals');
    });
  });
}

test('shared discovery keys include a private partition without changing unset keys', () => {
  const input = {
    protocol: 'mcp',
    agentUri: 'https://seller.example/mcp',
    adcpVersion: '3.2.6',
    authIdentity: 'shared',
  };
  const a = agentDiscoveryCacheKey({ ...input, connectionPartition: 'a' });
  assert.equal(a, agentDiscoveryCacheKey({ ...input, connectionPartition: 'a' }));
  assert.notEqual(a, agentDiscoveryCacheKey({ ...input, connectionPartition: 'b' }));
  assert.notEqual(a, agentDiscoveryCacheKey(input));
});

test('shared and per-call discovery honor partitions on the same client and across instances', async t => {
  const s = await seller(t, false);
  const cache = createInMemoryAgentDiscoveryCache();
  const client = partition =>
    new SingleAgentClient(s.agent, {
      transport: { connectionPartition: partition },
      discoveryCache: { cache, authIdentity: 'shared-credential-owner' },
    });
  const a = client('a');
  const capabilityCalls = () => s.requests.filter(r => r.operation === 'get_adcp_capabilities').length;
  await a.getCapabilities();
  const first = capabilityCalls();
  assert.ok(first > 0);
  await client('a').getCapabilities();
  assert.equal(capabilityCalls(), first, 'same partition can reuse shared discovery');
  await client('b').getCapabilities();
  assert.ok(capabilityCalls() > first, 'different partition needs its own discovery');
  const beforeOverride = capabilityCalls();
  await a.getCapabilities({ transport: { connectionPartition: 'b' } });
  assert.ok(capabilityCalls() > beforeOverride, 'per-call partition must bypass locally cached evidence');
});

test('OAuth sessions partition the same provider without changing transport authentication', async t => {
  const s = await seller(t, false);
  const agent = {
    ...s.agent,
    auth_token: undefined,
    oauth_tokens: { access_token: 'shared-oauth-token', token_type: 'Bearer' },
    oauth_client: { client_id: 'shared-oauth-client' },
  };
  for (const partition of ['oauth-principal-a', 'oauth-principal-a', 'oauth-principal-b']) {
    await ProtocolClient.callTool(agent, 'ping', {}, { transport: { connectionPartition: partition } });
  }
  const calls = s.requests.filter(r => r.method === 'tools/call');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers['mcp-session-id'], calls[1].headers['mcp-session-id']);
  assert.notEqual(calls[0].headers['mcp-session-id'], calls[2].headers['mcp-session-id']);
  assert.ok(calls.every(r => r.headers.authorization === 'Bearer shared-oauth-token'));
  assert.ok(!JSON.stringify(s.requests).includes('oauth-principal-'));
});

test('injected fetch stays one-shot outside a scope even with explicit process reuse', async t => {
  const s = await seller(t, false);
  const transport = { trustedFetchFn: fetch, connectionPartition: 'private-principal', connectionReuse: 'process' };
  await s.call(transport);
  await s.call(transport);
  const calls = s.requests.filter(r => r.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers['mcp-session-id'], calls[1].headers['mcp-session-id']);
});

test('malformed local connection policies fail before network dispatch', async () => {
  const agent = {
    id: 'invalid-policy',
    name: 'Invalid policy',
    protocol: 'mcp',
    agent_uri: 'https://seller.example/mcp',
  };
  for (const transport of [
    { connectionPartition: '' },
    { connectionPartition: 42 },
    { connectionPartition: [] },
    { connectionReuse: true },
    { connectionReuse: 'global' },
  ]) {
    await assert.rejects(ProtocolClient.callTool(agent, 'ping', {}, { transport }), TypeError);
  }
});

test('signing advertisements and transport contexts remain local to a principal partition', () => {
  const { generateKeyPairSync } = require('node:crypto');
  const { buildAgentSigningContext } = require('../../dist/lib/signing/agent-context.js');
  const { CapabilityCache } = require('../../dist/lib/signing/capability-cache.js');
  const pair = generateKeyPairSync('ed25519');
  const agent = {
    id: 'signed',
    name: 'Signed',
    protocol: 'mcp',
    agent_uri: 'https://seller.example/mcp',
    request_signing: {
      kid: 'partition-key',
      alg: 'ed25519',
      agent_url: 'https://buyer.example',
      private_key: { ...pair.privateKey.export({ format: 'jwk' }), kid: 'partition-key' },
    },
  };
  const cache = new CapabilityCache();
  const a = buildAgentSigningContext(agent, { cache, connectionPartition: 'a' });
  const b = buildAgentSigningContext(agent, { cache, connectionPartition: 'b' });
  assert.notEqual(a.cacheKey, b.cacheKey);
  assert.notEqual(a.capabilityCacheKey, b.capabilityCacheKey);
  cache.set(a.capabilityCacheKey, {
    fetchedAt: Date.now() / 1000,
    requestSigning: { supported: true, required_for: ['create_media_buy'] },
  });
  assert.equal(b.getCapability(), undefined);
  assert.deepEqual(a.getCapability().requestSigning.required_for, ['create_media_buy']);
});

test('functional test clients are reused only with the same partition and reuse policy', () => {
  const { createTestClient, getOrCreateClientResolution } = require('../../dist/lib/testing/client.js');
  const options = { protocol: 'mcp', transport: { connectionPartition: 'a' } };
  const client = createTestClient('https://seller.example/mcp', 'mcp', options);
  const reuse = transport =>
    getOrCreateClientResolution('https://seller.example/mcp', { ...options, transport, _client: client }).reusedShared;
  assert.equal(reuse({ connectionPartition: 'a' }), true);
  assert.equal(reuse({ connectionPartition: 'b' }), false);
  assert.equal(reuse({ connectionPartition: 'a', connectionReuse: 'process' }), false);
});

test('default modern discovery does not consume process-owned server/discover evidence', async t => {
  const s = await seller(t, true);
  const processClient = new SingleAgentClient(s.agent, { transport: { connectionReuse: 'process' } });
  await processClient.getAgentInfo();
  const discoveries = () => s.requests.filter(r => r.method === 'server/discover').length;
  const before = discoveries();
  assert.ok(before > 0);
  const isolated = new SingleAgentClient(s.agent);
  await isolated.getAgentInfo();
  assert.ok(discoveries() > before, 'an unscoped caller must discover for itself');
  const afterFirst = discoveries();
  await isolated.getAgentInfo();
  assert.ok(discoveries() > afterFirst, 'default discovery must not retain a process-wide hint');
});

for (const oauth of [false, true]) {
  test(`a timed-out one-shot ${oauth ? 'OAuth' : 'legacy'} call closes without deleting its server session`, async t => {
    let finish;
    let enteredTool = false;
    let closed = 0;
    let closedAtToolStart = 0;
    const pendingWork = new Promise(resolve => {
      finish = resolve;
    });
    t.after(() => finish());
    const s = await seller(t, false, false, {
      // Force the v2 negotiation attempt to decline, exercising both v1
      // cleanup implementations rather than the modern OAuth legacy bridge.
      rejectFirstInitialize: true,
      onPing: async () => {
        enteredTool = true;
        closedAtToolStart = closed;
        await pendingWork;
      },
    });
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const close = Client.prototype.close;
    Client.prototype.close = async function (...args) {
      const result = await close.apply(this, args);
      closed++;
      return result;
    };
    t.after(() => {
      Client.prototype.close = close;
    });
    const agent = oauth
      ? {
          ...s.agent,
          auth_token: undefined,
          oauth_tokens: { access_token: 'timeout-oauth-token', token_type: 'Bearer' },
          oauth_client: { client_id: 'timeout-oauth-client' },
        }
      : s.agent;

    await assert.rejects(
      ProtocolClient.callTool(agent, 'ping', {}, { transport: { requestTimeoutMs: 1000 } }),
      /timed out|timeout/i
    );
    assert.equal(enteredTool, true, 'the timeout occurs after the seller starts work');
    assert.ok(
      s.requests.some(request => request.method === 'initialize'),
      'a legacy session was established'
    );
    // The caller deadline can win before the underlying SDK request unwinds.
    // Observe cleanup before checking DELETE so late termination cannot hide.
    const closeDeadline = Date.now() + 2000;
    while (closed <= closedAtToolStart && Date.now() < closeDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(closed > closedAtToolStart, 'the actual SDK client was closed after the timeout');
    assert.equal(
      s.requests.filter(request => request.httpMethod === 'DELETE').length,
      0,
      'client cleanup must not terminate the seller session and cancel its ongoing work'
    );
    finish();
  });
}

test('an ordinary failure terminates its initialized one-shot legacy session', async t => {
  const s = await seller(t, false);
  const { withCachedConnection } = require('../../dist/lib/protocols/mcp.js');
  await assert.rejects(
    withCachedConnection(
      s.agent.agent_uri,
      'shared-token',
      { authorization: 'Bearer shared-token' },
      [],
      'failing-operation',
      async () => {
        throw new Error('operation failed');
      }
    ),
    /operation failed/
  );
  assert.equal(s.requests.filter(r => r.httpMethod === 'DELETE').length, 1);
});

test('a public call without a partition clears an enclosing principal policy', async t => {
  const s = await seller(t, false);
  const { withMCPConnectionPolicy } = require('../../dist/lib/protocols/mcp-connection-policy.js');
  await s.call({ connectionPartition: 'outer-principal' });
  await withMCPConnectionPolicy({ connectionPartition: 'outer-principal' }, async () => {
    await s.call();
    await s.call();
  });
  const sessions = s.requests.filter(r => r.method === 'tools/call').map(r => r.headers['mcp-session-id']);
  assert.equal(
    new Set(sessions).size,
    3,
    'nested public calls must own fresh sessions instead of inheriting the outer principal'
  );
});

test('public low-level MCP calls detach an enclosing principal and support explicit reuse', async t => {
  const s = await seller(t, false);
  const { callMCPTool } = require('../../dist/lib/protocols/mcp.js');
  const { withMCPConnectionPolicy } = require('../../dist/lib/protocols/mcp-connection-policy.js');
  const call = policy =>
    callMCPTool(s.agent.agent_uri, 'ping', {}, 'shared-token', [], undefined, undefined, undefined, policy);
  await withMCPConnectionPolicy({ connectionPartition: 'enclosing-principal' }, async () => {
    await call();
    await call();
  });
  await call({ connectionPartition: 'direct-principal' });
  await call({ connectionPartition: 'direct-principal' });
  const sessions = s.requests.filter(r => r.method === 'tools/call').map(r => r.headers['mcp-session-id']);
  assert.notEqual(sessions[0], sessions[1]);
  assert.equal(sessions[2], sessions[3]);
  assert.notEqual(sessions[0], sessions[2]);
});

test('an explicit unset signing partition clears an enclosing principal', () => {
  const { buildAgentSigningContext } = require('../../dist/lib/signing/agent-context.js');
  const { withMCPConnectionPolicy } = require('../../dist/lib/protocols/mcp-connection-policy.js');
  const { generateKeyPairSync } = require('node:crypto');
  const pair = generateKeyPairSync('ed25519');
  const agent = {
    id: 'explicit-unset',
    name: 'Explicit unset',
    protocol: 'mcp',
    agent_uri: 'https://seller.example/mcp',
    request_signing: {
      kid: 'key',
      alg: 'ed25519',
      agent_url: 'https://buyer.example',
      private_key: { ...pair.privateKey.export({ format: 'jwk' }), kid: 'key' },
    },
  };
  const unpartitioned = buildAgentSigningContext(agent);
  withMCPConnectionPolicy({ connectionPartition: 'enclosing' }, () => {
    assert.notEqual(buildAgentSigningContext(agent).capabilityCacheKey, unpartitioned.capabilityCacheKey);
    assert.equal(
      buildAgentSigningContext(agent, { connectionPartition: undefined }).capabilityCacheKey,
      unpartitioned.capabilityCacheKey
    );
  });
});

for (const mode of ['partition', 'scope']) {
  test(`native MCP task timeout, polling and result retain session ownership with a ${mode}`, async t => {
    const s = await seller(t, false, true);
    const {
      callMCPToolWithTasks,
      getMCPTaskStatus,
      getMCPTaskResult,
    } = require('../../dist/lib/protocols/mcp-tasks.js');
    const policy = mode === 'partition' ? { connectionPartition: 'task-owner' } : {};
    const headers = { 'x-buyer-route': 'native-task-owner' };
    const { generateKeyPairSync } = require('node:crypto');
    const { buildAgentSigningContext } = require('../../dist/lib/signing/agent-context.js');
    const pair = generateKeyPairSync('ed25519');
    const signingContext = buildAgentSigningContext(
      {
        ...s.agent,
        headers,
        request_signing: {
          kid: 'native-key',
          alg: 'ed25519',
          agent_url: 'https://buyer.example',
          private_key: {
            ...pair.privateKey.export({ format: 'jwk' }),
            kid: 'native-key',
            adcp_use: 'request-signing',
            key_ops: ['sign'],
          },
          always_sign: ['create_media_buy'],
          always_sign_protocol_methods: ['tasks/get', 'tasks/result'],
        },
      },
      policy
    );
    const followup = { ...policy, headers, signingContext };
    const run = async () => {
      const created = await callMCPToolWithTasks(
        s.agent.agent_uri,
        'create_media_buy',
        {},
        'shared-token',
        [],
        headers,
        { ...policy, signingContext, workingTimeout: 1000, requestTimeoutMs: 1000 }
      );
      assert.equal(created.structuredContent.status, 'working');
      const id = created.structuredContent.task_id;
      assert.ok(id);
      const status = await getMCPTaskStatus(s.agent.agent_uri, id, 'shared-token', [], undefined, followup);
      assert.equal(status.status, 'working');
      await s.taskStore.storeTaskResult(id, 'completed', { content: [{ type: 'text', text: 'completed work' }] });
      const result = await getMCPTaskResult(s.agent.agent_uri, id, 'shared-token', [], followup);
      assert.equal(result.content[0].text, 'completed work');
      const sessions = s.requests
        .filter(r => ['tools/call', 'tasks/get', 'tasks/result'].includes(r.method))
        .map(r => r.headers['mcp-session-id']);
      assert.equal(new Set(sessions).size, 1);
      const calls = s.requests.filter(r => ['tools/call', 'tasks/get', 'tasks/result'].includes(r.method));
      assert.ok(calls.every(r => r.headers['x-buyer-route'] === headers['x-buyer-route']));
      assert.ok(
        calls.every(r => r.headers['signature-input']),
        'native follow-ups retain the explicit signing context'
      );
    };
    await (mode === 'scope' ? withMCPConnectionScope(run) : run());
  });
}

test('a native task follow-up does not borrow an enclosing signing identity', async t => {
  const s = await seller(t, false, true);
  const { getMCPTaskStatus } = require('../../dist/lib/protocols/mcp-tasks.js');
  const { buildAgentSigningContext, signingContextStorage } = require('../../dist/lib/signing/client.js');
  const { generateKeyPairSync } = require('node:crypto');
  const pair = generateKeyPairSync('ed25519');
  const context = buildAgentSigningContext({
    ...s.agent,
    request_signing: {
      kid: 'outer-key',
      alg: 'ed25519',
      agent_url: 'https://outer-buyer.example',
      private_key: {
        ...pair.privateKey.export({ format: 'jwk' }),
        kid: 'outer-key',
        adcp_use: 'request-signing',
        key_ops: ['sign'],
      },
      always_sign_protocol_methods: ['tasks/get'],
    },
  });
  await signingContextStorage.run(context, () =>
    assert.rejects(getMCPTaskStatus(s.agent.agent_uri, 'unknown-task', 'shared-token'))
  );
  const requests = s.requests.filter(r => r.method === 'tasks/get');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['signature-input'], undefined);
});
