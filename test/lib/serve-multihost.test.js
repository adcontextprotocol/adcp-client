const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHash } = require('node:crypto');

/**
 * Exercises the multi-host `serve()` surface: function-form `publicUrl`
 * and `protectedResource`, `ServeContext.host` threading, per-host PRM
 * caching, and the `trustForwardedHost` opt-in for `X-Forwarded-Host`.
 *
 * Tests cover the wire shape operators will actually see under a
 * reverse-proxy in front of a multi-tenant Node process.
 */

function request(port, { path = '/mcp', method = 'POST', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.host = host;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: h }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

describe('serve() multi-host', () => {
  let serve,
    taskScopeFromPrincipal,
    tagAuthenticatorNeedsRawBody,
    createIdempotencyStore,
    memoryBackend,
    InMemoryStateStore,
    InMemoryTaskStore,
    createTaskCapableServer,
    createAdcpServer;
  let McpServer;

  before(() => {
    const lib = require('../../dist/lib/index.js');
    serve = lib.serve;
    taskScopeFromPrincipal = lib.taskScopeFromPrincipal;
    createIdempotencyStore = lib.createIdempotencyStore;
    memoryBackend = lib.memoryBackend;
    InMemoryStateStore = lib.InMemoryStateStore;
    createTaskCapableServer = lib.createTaskCapableServer;
    InMemoryTaskStore = require('@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js').InMemoryTaskStore;
    const legacyServer = require('../../dist/lib/server/legacy/v5/index.js');
    createAdcpServer = legacyServer.createAdcpServer;
    tagAuthenticatorNeedsRawBody = legacyServer.tagAuthenticatorNeedsRawBody;
    const mcp = require('@modelcontextprotocol/sdk/server/mcp.js');
    McpServer = mcp.McpServer;
  });

  test('passes resolved host to factory ctx', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };

    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `seller-a.example.com:${port}` });
    await request(port, { host: `seller-b.example.com:${port}` });
    await request(port, { host: `SELLER-A.EXAMPLE.COM:${port}` });

    // Host header is lowercased, port preserved.
    assert.deepStrictEqual(seen.sort(), [
      `seller-a.example.com:${port}`,
      `seller-a.example.com:${port}`,
      `seller-b.example.com:${port}`,
    ]);

    server.close();
  });

  test('rejects query strings on the MCP mount before agent or auth work', async () => {
    let factoryCalls = 0;
    let authCalls = 0;
    const server = serve(
      () => {
        factoryCalls += 1;
        return new McpServer({ name: 'Test', version: '1.0.0' });
      },
      {
        port: 0,
        authenticate: async () => {
          authCalls += 1;
          return { principal: 'buyer-a' };
        },
        onListening: () => {},
      }
    );
    await waitForListening(server);
    const port = server.address().port;

    try {
      const response = await request(port, {
        path: '/mcp?replay-scope-variant=1',
        host: `seller.example.com:${port}`,
      });
      assert.strictEqual(response.status, 400);
      assert.match(response.body, /exact origin-form path/);
      assert.strictEqual(authCalls, 0);
      assert.strictEqual(factoryCalls, 0);

      const bareDelimiter = await request(port, {
        path: '/mcp?',
        host: `seller.example.com:${port}`,
      });
      assert.strictEqual(bareDelimiter.status, 400);
      assert.strictEqual(authCalls, 0);
      assert.strictEqual(factoryCalls, 0);

      for (const path of ['//replay-variant.example/mcp', '/\\replay-variant.example/mcp']) {
        const nonOriginForm = await request(port, {
          path,
          host: `seller.example.com:${port}`,
        });
        assert.strictEqual(nonOriginForm.status, 400);
      }
      assert.strictEqual(authCalls, 0);
      assert.strictEqual(factoryCalls, 0);
    } finally {
      server.close();
    }
  });

  test('rejects publicUrl values that advertise an unsupported query or fragment', () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    assert.throws(
      () => serve(factory, { publicUrl: 'https://seller.example.com/mcp?tenant=a' }),
      /must not include query parameters or a fragment/
    );
    assert.throws(
      () => serve(factory, { publicUrl: 'https://seller.example.com/mcp#fragment' }),
      /must not include query parameters or a fragment/
    );
    assert.throws(
      () => serve(factory, { publicUrl: 'https://seller.example.com/mcp?' }),
      /must not include query parameters or a fragment/
    );
    assert.throws(
      () => serve(factory, { publicUrl: 'https://seller.example.com/mcp#' }),
      /must not include query parameters or a fragment/
    );
  });

  test('rejects insecure or credential-bearing publicUrl values', () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    assert.throws(() => serve(factory, { publicUrl: 'http://seller.example.com/mcp' }), /must use https/);
    assert.throws(() => serve(factory, { publicUrl: 'ftp://seller.example.com/mcp' }), /must use https/);
    assert.throws(
      () => serve(factory, { publicUrl: 'https://user:password@seller.example.com/mcp' }),
      /must not include username or password/
    );
    const loopback = serve(factory, { port: 0, publicUrl: 'http://127.0.0.1/mcp', onListening: () => {} });
    loopback.close();
  });

  test('stamps a canonical idempotency scope despite Host port variants', async () => {
    const scopes = [];
    const server = serve(
      ctx => {
        scopes.push(ctx.idempotencyScope);
        return new McpServer({ name: 'Test', version: '1.0.0' });
      },
      {
        port: 0,
        publicUrl: 'https://seller.example.com/mcp',
        onListening: () => {},
      }
    );
    await waitForListening(server);
    const port = server.address().port;

    try {
      await request(port, { host: 'seller.example.com' });
      await request(port, { host: `seller.example.com:${port}` });
      await request(port, { host: 'seller.example.com:443' });
      await request(port, { host: 'seller%2eexample.com' });
      assert.deepStrictEqual(
        scopes,
        Array(4).fill(JSON.stringify(['https://seller.example.com/mcp', 'seller.example.com']))
      );
    } finally {
      server.close();
    }
  });

  test('fallback idempotency scope ignores client-controlled Host ports', async () => {
    const scopes = [];
    const server = serve(
      ctx => {
        scopes.push(ctx.idempotencyScope);
        return new McpServer({ name: 'Test', version: '1.0.0' });
      },
      {
        port: 0,
        onListening: () => {},
      }
    );
    await waitForListening(server);
    const port = server.address().port;

    try {
      await request(port, { host: 'seller.example.com' });
      await request(port, { host: 'seller.example.com:1' });
      await request(port, { host: 'seller.example.com:65535' });
      await request(port, { host: 'seller%2eexample.com' });
      assert.deepStrictEqual(scopes, Array(4).fill(JSON.stringify(['seller.example.com', port, '/mcp'])));
    } finally {
      server.close();
    }
  });

  test('function publicUrl scope is stable across replicas with different listener ports', async () => {
    const scopes = [];
    const startReplica = () =>
      serve(
        ctx => {
          scopes.push(ctx.idempotencyScope);
          return new McpServer({ name: 'Test', version: '1.0.0' });
        },
        {
          port: 0,
          publicUrl: host => `https://${host}/mcp`,
          onListening: () => {},
        }
      );
    const replicaA = startReplica();
    const replicaB = startReplica();
    await Promise.all([waitForListening(replicaA), waitForListening(replicaB)]);

    try {
      const portA = replicaA.address().port;
      const portB = replicaB.address().port;
      assert.notStrictEqual(portA, portB);
      await request(portA, { host: 'seller.example.com' });
      await request(portB, { host: 'seller.example.com' });
      assert.deepStrictEqual(
        scopes,
        Array(2).fill(JSON.stringify(['https://seller.example.com/mcp', 'seller.example.com']))
      );
    } finally {
      replicaA.close();
      replicaB.close();
    }
  });

  test('function publicUrl scope preserves a server-configured non-default port', async () => {
    const scopes = [];
    const server = serve(
      ctx => {
        scopes.push(ctx.idempotencyScope);
        return new McpServer({ name: 'Test', version: '1.0.0' });
      },
      {
        port: 0,
        publicUrl: host => `https://${host}:8443/mcp`,
        onListening: () => {},
      }
    );
    await waitForListening(server);

    try {
      await request(server.address().port, { host: 'seller.example.com:1234' });
      assert.deepStrictEqual(scopes, [JSON.stringify(['https://seller.example.com:8443/mcp', 'seller.example.com'])]);
    } finally {
      server.close();
    }
  });

  test('serve() scopes unauthenticated reused-agent idempotency end to end', async () => {
    let handlerCalls = 0;
    const agent = createAdcpServer({
      name: 'Idempotency scope test',
      version: '1.0.0',
      stateStore: new InMemoryStateStore(),
      validation: { requests: 'off', responses: 'off' },
      resolveSessionKey: () => 'anonymous-session',
      idempotency: createIdempotencyStore({
        backend: memoryBackend({ sweepIntervalMs: 0 }),
        ttlSeconds: 3600,
      }),
      capabilities: { features: { inlineCreativeManagement: false } },
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async params => {
          handlerCalls += 1;
          return {
            media_buy_id: `mb-${handlerCalls}`,
            status: 'active',
            confirmed_at: new Date(0).toISOString(),
            revision: 1,
            packages: (params.packages ?? []).map(pkg => ({ package_id: pkg.package_id, status: 'active' })),
          };
        },
        updateMediaBuy: async () => ({
          media_buy_id: 'unused',
          status: 'active',
          confirmed_at: new Date(0).toISOString(),
          revision: 1,
          packages: [],
        }),
      },
    });
    const server = serve(() => agent, {
      port: 0,
      reuseAgent: true,
      publicUrl: host => `https://${host}/mcp`,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          idempotency_key: 'serve-scope-e2e-key-0001',
          buyer_agent_url: 'https://buyer.example.com',
          packages: [{ package_id: 'pkg-1', products: [{ product_id: 'prod-1' }] }],
        },
      },
    });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

    try {
      const [agentA, agentB] = await Promise.all([
        request(port, { host: 'agent-a.example.com', headers, body }),
        request(port, { host: 'agent-b.example.com', headers, body }),
      ]);
      assert.strictEqual(agentA.status, 200);
      assert.strictEqual(agentB.status, 200);
      assert.strictEqual(handlerCalls, 2, 'different routed hosts must not cross-replay');

      const replay = await request(port, { host: 'agent-a.example.com:444', headers, body });
      assert.strictEqual(replay.status, 200);
      assert.strictEqual(handlerCalls, 2, 'an equivalent Host spelling must replay within the same endpoint scope');
      assert.match(replay.body, /"replayed":true/);
    } finally {
      server.close();
    }
  });

  test('framework Host validation runs before signature-auth and preTransport replay work', async () => {
    let preTransportCalls = 0;
    let replayInsertCalls = 0;
    const server = serve(() => createAdcpServer({ name: 'Host guard test', version: '1.0.0' }), {
      port: 0,
      publicUrl: 'https://allowed.example.com/mcp',
      authenticate: tagAuthenticatorNeedsRawBody(async () => {
        // Signature authentication commits its replay nonce before returning
        // the principal; this counter models that security-sensitive write.
        replayInsertCalls += 1;
        return { principal: 'signed-buyer' };
      }),
      preTransport: async () => {
        preTransportCalls += 1;
        return false;
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    try {
      const response = await request(port, { host: 'replay-scope-attacker.example.com' });
      assert.notStrictEqual(response.status, 200);
      const portVariant = await request(port, { host: 'allowed.example.com:444' });
      assert.strictEqual(portVariant.status, 400);
      const protoVariant = await request(port, {
        host: 'allowed.example.com',
        headers: { 'x-forwarded-proto': 'attacker-scheme' },
      });
      assert.strictEqual(protoVariant.status, 400);
      assert.strictEqual(replayInsertCalls, 0);
      assert.strictEqual(preTransportCalls, 0);
    } finally {
      server.close();
    }
  });

  test('signature authority uses the trusted forwarded host behind a rewriting proxy', async () => {
    let authCalls = 0;
    let preTransportCalls = 0;
    const server = serve(() => createAdcpServer({ name: 'Proxy signature test', version: '1.0.0' }), {
      port: 0,
      publicUrl: 'https://seller.example.com/mcp',
      trustForwardedHost: true,
      allowedHosts: ['internal.fly', 'seller.example.com'],
      authenticate: tagAuthenticatorNeedsRawBody(async () => {
        authCalls += 1;
        return { principal: 'signed-buyer' };
      }),
      preTransport: async () => {
        preTransportCalls += 1;
        return false;
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    try {
      await request(port, {
        host: `internal.fly:${port}`,
        headers: {
          'x-forwarded-host': 'seller.example.com',
          'x-forwarded-proto': 'https',
        },
      });
      assert.strictEqual(authCalls, 1);
      assert.strictEqual(preTransportCalls, 1);
    } finally {
      server.close();
    }
  });

  test('taskScope binds every TaskStore operation to the authenticated principal', async () => {
    const scopes = [];
    const task = {
      taskId: 'task-1',
      status: 'working',
      ttl: 60_000,
      createdAt: new Date(0).toISOString(),
      lastUpdatedAt: new Date(0).toISOString(),
    };
    const backingStore = {
      createTask: async (_params, _requestId, _request, sessionId) => {
        scopes.push(sessionId);
        return task;
      },
      getTask: async (_taskId, sessionId) => {
        scopes.push(sessionId);
        return task;
      },
      storeTaskResult: async (_taskId, _status, _result, sessionId) => {
        scopes.push(sessionId);
      },
      getTaskResult: async (_taskId, sessionId) => {
        scopes.push(sessionId);
        return {};
      },
      updateTaskStatus: async (_taskId, _status, _message, sessionId) => {
        scopes.push(sessionId);
      },
      listTasks: async (_cursor, sessionId) => {
        scopes.push(sessionId);
        return { tasks: [task] };
      },
    };
    let scopedStore;
    const server = serve(
      ctx => {
        scopedStore = ctx.taskStore;
        return createTaskCapableServer('Test', '1.0.0', { taskStore: ctx.taskStore });
      },
      {
        port: 0,
        taskStore: backingStore,
        allowedHosts: ['seller.example.com'],
        authenticate: async () => ({ principal: 'buyer-a' }),
        taskScope: taskScopeFromPrincipal,
        onListening: () => {},
      }
    );
    await waitForListening(server);
    const port = server.address().port;
    await request(port, { host: `seller.example.com:${port}` });

    try {
      assert.ok(scopedStore);
      await scopedStore.createTask({}, '1', { method: 'tools/call' }, 'client-controlled');
      await scopedStore.getTask('task-1', 'client-controlled');
      await scopedStore.storeTaskResult('task-1', 'completed', {}, 'client-controlled');
      await scopedStore.getTaskResult('task-1', 'client-controlled');
      await scopedStore.updateTaskStatus('task-1', 'cancelled', undefined, 'client-controlled');
      await scopedStore.listTasks(undefined, 'client-controlled');
      const endpointScope = JSON.stringify(['seller.example.com', port, '/mcp']);
      const expectedScope = `serve:v1:${createHash('sha256')
        .update(JSON.stringify([endpointScope, 'buyer-a']), 'utf8')
        .digest('hex')}`;
      assert.deepStrictEqual(scopes, Array(6).fill(expectedScope));
    } finally {
      server.close();
    }
  });

  test('taskScope isolates principals on one host and the same principal across hosts', async () => {
    const tasksByScope = new Map();
    const backingStore = {
      createTask: async (_params, requestId, _request, sessionId) => {
        const task = {
          taskId: `task-${requestId}`,
          status: 'working',
          ttl: 60_000,
          createdAt: new Date(0).toISOString(),
          lastUpdatedAt: new Date(0).toISOString(),
        };
        const tasks = tasksByScope.get(sessionId) ?? [];
        tasks.push(task);
        tasksByScope.set(sessionId, tasks);
        return task;
      },
      getTask: async (taskId, sessionId) =>
        (tasksByScope.get(sessionId) ?? []).find(task => task.taskId === taskId) ?? null,
      storeTaskResult: async () => {},
      getTaskResult: async () => ({}),
      updateTaskStatus: async () => {},
      listTasks: async (_cursor, sessionId) => ({ tasks: tasksByScope.get(sessionId) ?? [] }),
    };
    const scopedStores = [];
    const server = serve(
      ctx => {
        scopedStores.push({ host: ctx.host, store: ctx.taskStore });
        return createTaskCapableServer('Test', '1.0.0', { taskStore: ctx.taskStore });
      },
      {
        port: 0,
        taskStore: backingStore,
        allowedHosts: ['agent-a.example.com', 'agent-b.example.com'],
        authenticate: async req => ({ principal: req.headers['x-test-principal'] }),
        taskScope: taskScopeFromPrincipal,
        onListening: () => {},
      }
    );
    await waitForListening(server);
    const port = server.address().port;

    try {
      await request(port, {
        host: `agent-a.example.com:${port}`,
        headers: { 'x-test-principal': 'buyer-a' },
      });
      await request(port, {
        host: `agent-a.example.com:${port}`,
        headers: { 'x-test-principal': 'buyer-b' },
      });
      await request(port, {
        host: `agent-b.example.com:${port}`,
        headers: { 'x-test-principal': 'buyer-a' },
      });
      const buyerAAgentAStore = scopedStores[0].store;
      const buyerBAgentAStore = scopedStores[1].store;
      const buyerAAgentBStore = scopedStores[2].store;
      await buyerAAgentAStore.createTask({}, 'a', { method: 'tools/call' });

      assert.strictEqual((await buyerAAgentAStore.listTasks()).tasks.length, 1);
      assert.strictEqual((await buyerBAgentAStore.listTasks()).tasks.length, 0);
      assert.strictEqual((await buyerAAgentBStore.listTasks()).tasks.length, 0);
      assert.strictEqual(await buyerBAgentAStore.getTask('task-a'), null);
      assert.strictEqual(await buyerAAgentBStore.getTask('task-a'), null);
    } finally {
      server.close();
    }
  });

  test('taskScope fails fast without authentication or with agent reuse', () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    assert.throws(() => serve(factory, { taskScope: principal => principal.principal }), /requires `authenticate`/);
    assert.throws(
      () =>
        serve(factory, {
          authenticate: async () => ({ principal: 'buyer-a' }),
          taskScope: taskScopeFromPrincipal,
        }),
      /requires an explicit scope-enforcing `taskStore`/
    );
    assert.throws(
      () =>
        serve(factory, {
          authenticate: async () => ({ principal: 'buyer-a' }),
          taskStore: new InMemoryTaskStore(),
          taskScope: taskScopeFromPrincipal,
        }),
      /cannot use InMemoryTaskStore/
    );
    assert.throws(
      () =>
        serve(factory, {
          authenticate: async () => ({ principal: 'buyer-a' }),
          taskStore: {},
          taskScope: taskScopeFromPrincipal,
          reuseAgent: true,
        }),
      /cannot be combined with `reuseAgent`/
    );
    assert.throws(
      () => taskScopeFromPrincipal({ principal: 'unknown' }, {}, 'seller.example.com'),
      /stable non-empty identity/
    );
    assert.strictEqual(
      taskScopeFromPrincipal({ principal: 'buyer-a' }, {}, 'seller.example.com'),
      'serve:v1:78be314325f46b28d887ce6ff66ffa2a1c425fb09e71b8c55ac624701031bc18'
    );
    const largeScope = taskScopeFromPrincipal(
      { principal: `buyer-${'x'.repeat(16 * 1024)}` },
      {},
      'seller.example.com'
    );
    assert.match(largeScope, /^serve:v1:[a-f0-9]{64}$/);
    assert.strictEqual(largeScope.length, 73);
    assert.strictEqual(
      largeScope,
      taskScopeFromPrincipal({ principal: `buyer-${'x'.repeat(16 * 1024)}` }, {}, 'seller.example.com')
    );
  });

  test('taskScope applies the default Host guard before authentication and factory work', async () => {
    let authCalls = 0;
    let factoryCalls = 0;
    const backingStore = {
      createTask: async () => ({ taskId: 'unused', status: 'working', createdAt: '', lastUpdatedAt: '' }),
      getTask: async () => null,
      storeTaskResult: async () => {},
      getTaskResult: async () => ({}),
      updateTaskStatus: async () => {},
      listTasks: async () => ({ tasks: [] }),
    };
    const server = serve(
      ctx => {
        factoryCalls += 1;
        return createTaskCapableServer('Test', '1.0.0', { taskStore: ctx.taskStore });
      },
      {
        port: 0,
        taskStore: backingStore,
        authenticate: async () => {
          authCalls += 1;
          return { principal: 'buyer-a' };
        },
        taskScope: taskScopeFromPrincipal,
        onListening: () => {},
      }
    );
    await waitForListening(server);

    try {
      const response = await request(server.address().port, { host: 'attacker.example.com' });
      assert.notStrictEqual(response.status, 200);
      assert.strictEqual(authCalls, 0);
      assert.strictEqual(factoryCalls, 0);
    } finally {
      server.close();
    }
  });

  test('taskScope rejects a TaskMessageQueue before attaching the transport', async () => {
    let queueCalls = 0;
    const taskMessageQueue = new Proxy(
      {},
      {
        get() {
          queueCalls += 1;
          return async () => undefined;
        },
      }
    );
    const backingStore = {
      createTask: async () => ({ taskId: 'unused', status: 'working', createdAt: '', lastUpdatedAt: '' }),
      getTask: async () => null,
      storeTaskResult: async () => {},
      getTaskResult: async () => ({}),
      updateTaskStatus: async () => {},
      listTasks: async () => ({ tasks: [] }),
    };
    const server = serve(
      ctx =>
        createAdcpServer({
          name: 'Scoped queue rejection',
          version: '1.0.0',
          stateStore: new InMemoryStateStore(),
          taskStore: ctx.taskStore,
          taskMessageQueue,
        }),
      {
        port: 0,
        taskStore: backingStore,
        allowedHosts: ['seller.example.com'],
        authenticate: async () => ({ principal: 'buyer-a' }),
        taskScope: taskScopeFromPrincipal,
        onListening: () => {},
      }
    );
    await waitForListening(server);

    try {
      const response = await request(server.address().port, { host: 'seller.example.com' });
      assert.strictEqual(response.status, 500);
      assert.deepStrictEqual(JSON.parse(response.body), { error: 'Internal server error' });
      assert.strictEqual(queueCalls, 0);
    } finally {
      server.close();
    }
  });

  test('taskScope fails closed for an unmarked raw McpServer with a TaskMessageQueue', async () => {
    let queueCalls = 0;
    const taskMessageQueue = new Proxy(
      {},
      {
        get() {
          queueCalls += 1;
          return async () => undefined;
        },
      }
    );
    const backingStore = {
      createTask: async () => ({ taskId: 'unused', status: 'working', createdAt: '', lastUpdatedAt: '' }),
      getTask: async () => null,
      storeTaskResult: async () => {},
      getTaskResult: async () => ({}),
      updateTaskStatus: async () => {},
      listTasks: async () => ({ tasks: [] }),
    };
    let closeCalls = 0;
    const server = serve(
      ctx => {
        const rawServer = new McpServer(
          { name: 'Raw scoped queue rejection', version: '1.0.0' },
          { taskStore: ctx.taskStore, taskMessageQueue }
        );
        const originalClose = rawServer.close.bind(rawServer);
        rawServer.close = async () => {
          closeCalls += 1;
          await originalClose();
        };
        return rawServer;
      },
      {
        port: 0,
        taskStore: backingStore,
        allowedHosts: ['seller.example.com'],
        authenticate: async () => ({ principal: 'buyer-a' }),
        taskScope: taskScopeFromPrincipal,
        onListening: () => {},
      }
    );
    await waitForListening(server);

    try {
      const response = await request(server.address().port, { host: 'seller.example.com' });
      assert.strictEqual(response.status, 500);
      assert.deepStrictEqual(JSON.parse(response.body), { error: 'Internal server error' });
      assert.strictEqual(queueCalls, 0);
      assert.strictEqual(closeCalls, 1);
    } finally {
      server.close();
    }
  });

  test('function-form publicUrl advertises per-host resource', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const resA = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    const resB = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `meta.example.com:${port}`,
    });

    assert.strictEqual(resA.status, 200);
    assert.strictEqual(resB.status, 200);
    const bodyA = JSON.parse(resA.body);
    const bodyB = JSON.parse(resB.body);
    assert.strictEqual(bodyA.resource, 'https://snap.example.com/mcp');
    assert.strictEqual(bodyB.resource, 'https://meta.example.com/mcp');
    // authorization_servers still comes from the static PRM object.
    assert.deepStrictEqual(bodyA.authorization_servers, ['https://auth.example.com']);
    assert.deepStrictEqual(bodyB.authorization_servers, ['https://auth.example.com']);

    server.close();
  });

  test('function-form protectedResource returns per-host PRM', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      protectedResource: host => ({
        authorization_servers: [`https://${host.split(':')[0]}/oauth`],
        scopes_supported: ['read', 'write'],
      }),
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });

    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.authorization_servers, ['https://snap.example.com/oauth']);
    assert.deepStrictEqual(body.scopes_supported, ['read', 'write']);

    server.close();
  });

  test('caches resolvers per host (called once per unique host)', async () => {
    const publicUrlCalls = [];
    const prmCalls = [];
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => {
        publicUrlCalls.push(host);
        return `https://${host.split(':')[0]}/mcp`;
      },
      protectedResource: host => {
        prmCalls.push(host);
        return { authorization_servers: [`https://${host.split(':')[0]}/oauth`] };
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: 'snap.example.com:443',
    });
    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: 'snap%2eexample.com',
    });
    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `meta.example.com:${port}`,
    });

    // Each resolver is called once per canonical hostname. Port variants
    // and equivalent URL hostname spellings share the first cache entry.
    assert.deepStrictEqual(publicUrlCalls.sort(), ['meta.example.com', 'snap.example.com']);
    assert.deepStrictEqual(prmCalls.sort(), ['meta.example.com', 'snap.example.com']);

    server.close();
  });

  test('invalid publicUrl path per host surfaces as 500', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      // Returns a publicUrl whose path does NOT match the mount path.
      // The framework fails closed rather than advertising a mismatched
      // `resource` URL that would mint audience-mismatched tokens.
      publicUrl: host => `https://${host.split(':')[0]}/wrong-path`,
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });

    assert.strictEqual(res.status, 500);

    server.close();
  });

  test('ignores X-Forwarded-Host without trustForwardedHost', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `real.example.com:${port}`,
      headers: { 'x-forwarded-host': 'attacker.example.com' },
    });

    assert.strictEqual(seen[0], `real.example.com:${port}`);

    server.close();
  });

  test('honors X-Forwarded-Host when trustForwardedHost: true', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: { 'x-forwarded-host': 'snap.example.com' },
    });

    assert.strictEqual(seen[0], 'snap.example.com');

    server.close();
  });

  test('X-Forwarded-Host chain picks first entry (client-reported origin)', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: { 'x-forwarded-host': 'snap.example.com, cdn.example.com, edge.example.com' },
    });

    assert.strictEqual(seen[0], 'snap.example.com');

    server.close();
  });

  test('generic resolver throw (not UnknownHostError) surfaces as 500 on PRM probe', async () => {
    // For UnknownHostError → 404 routing, see the dedicated tests that
    // throw `UnknownHostError`. This test pins the OTHER branch: a
    // resolver that throws a plain `Error` is a real bug, so the
    // framework surfaces it loudly as 500 rather than hiding it behind
    // a 404.
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => {
        if (host.startsWith('snap.')) return `https://snap.example.com/mcp`;
        throw new Error(`unknown host: ${host}`); // plain Error, NOT UnknownHostError
      },
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `unknown.example.com:${port}`,
    });

    assert.strictEqual(res.status, 500);

    server.close();
  });

  test('static publicUrl still works (backward compat)', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: 'https://my-agent.example.com/mcp',
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const resA = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    const resB = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `meta.example.com:${port}`,
    });

    // Both hosts see the same static `resource` — that's the pre-multi-host
    // behavior, preserved when the caller doesn't opt in to per-host.
    assert.strictEqual(JSON.parse(resA.body).resource, 'https://my-agent.example.com/mcp');
    assert.strictEqual(JSON.parse(resB.body).resource, 'https://my-agent.example.com/mcp');

    server.close();
  });

  test('UnknownHostError from factory maps to 404 (not 500)', async () => {
    const { UnknownHostError } = require('../../dist/lib/index.js');
    const factory = ctx => {
      if (ctx.host.startsWith('known.')) return new McpServer({ name: 'Test', version: '1.0.0' });
      throw new UnknownHostError(`no adapter for ${ctx.host}`);
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, { host: `unknown.example.com:${port}` });
    assert.strictEqual(res.status, 404, 'UnknownHostError must map to 404');
    // Body is a generic "Not found" — the routing table never crosses the wire.
    assert.ok(!res.body.includes('unknown.example.com'), 'host must not appear in 404 body');

    server.close();
  });

  test('UnknownHostError from publicUrl resolver maps to 404 on PRM probe', async () => {
    const { UnknownHostError } = require('../../dist/lib/index.js');
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => {
        if (host.startsWith('known.')) return `https://${host.split(':')[0]}/mcp`;
        throw new UnknownHostError(host);
      },
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `unknown.example.com:${port}`,
    });
    assert.strictEqual(res.status, 404);

    server.close();
  });

  test('ServeRequestContext stamped on req before authenticate runs', async () => {
    const { getServeRequestContext } = require('../../dist/lib/index.js');
    const seen = [];
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      authenticate: req => {
        seen.push(getServeRequestContext(req));
        return { principal: 'test' };
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `snap.example.com:${port}` });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].host, `snap.example.com:${port}`);
    assert.strictEqual(seen[0].publicUrl, 'https://snap.example.com/mcp');

    server.close();
  });

  test('resolveHost() export matches serve()s internal resolution', () => {
    const { resolveHost } = require('../../dist/lib/index.js');

    // Default (no options) ignores X-Forwarded-Host.
    assert.strictEqual(
      resolveHost({ headers: { host: 'real.example.com', 'x-forwarded-host': 'attacker.example.com' } }),
      'real.example.com'
    );

    // Options-bag, trustForwardedHost: false — same as default.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'real.example.com', 'x-forwarded-host': 'attacker.example.com' } },
        { trustForwardedHost: false }
      ),
      'real.example.com'
    );

    // Trust on: X-Forwarded-Host wins.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'internal.fly', 'x-forwarded-host': 'snap.example.com' } },
        { trustForwardedHost: true }
      ),
      'snap.example.com'
    );

    // Trust on: X-Forwarded-Host first-entry wins, lowercase, port preserved.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'internal.fly', 'x-forwarded-host': 'SNAP.example.com:8443, cdn.example.com' } },
        { trustForwardedHost: true }
      ),
      'snap.example.com:8443'
    );

    // Trust on: RFC 7239 Forwarded fallback.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'internal.fly', forwarded: 'host=snap.example.com' } },
        { trustForwardedHost: true }
      ),
      'snap.example.com'
    );

    // Empty on no Host header at all.
    assert.strictEqual(resolveHost({ headers: {} }, { trustForwardedHost: true }), '');
  });

  test('hostname() helper strips port (including IPv6 brackets)', () => {
    const { hostname } = require('../../dist/lib/index.js');
    assert.strictEqual(hostname('snap.example.com'), 'snap.example.com');
    assert.strictEqual(hostname('snap.example.com:3001'), 'snap.example.com');
    assert.strictEqual(hostname('[::1]'), '[::1]');
    assert.strictEqual(hostname('[::1]:3001'), '[::1]');
    assert.strictEqual(hostname('[2001:db8::1]:8080'), '[2001:db8::1]');
  });

  test('honors RFC 7239 Forwarded: host= when trustForwardedHost: true', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: { forwarded: 'for=1.2.3.4;host=snap.example.com;proto=https' },
    });

    assert.strictEqual(seen[0], 'snap.example.com');

    server.close();
  });

  test('RFC 7239 Forwarded: picks first hop, strips quotes, handles IPv6', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    // Quoted host (RFC 7239 §4 — IPv6 and hosts-with-ports must be quoted).
    await request(port, {
      host: `internal.fly:${port}`,
      headers: { forwarded: 'host="snap.example.com:8443"' },
    });
    assert.strictEqual(seen[0], 'snap.example.com:8443');

    // Multi-hop — first entry is the client-facing proxy.
    await request(port, {
      host: `internal.fly:${port}`,
      headers: { forwarded: 'for=1;host=first.example, for=2;host=second.example' },
    });
    assert.strictEqual(seen[1], 'first.example');

    server.close();
  });

  test('X-Forwarded-Host takes precedence over Forwarded: when both set', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: {
        'x-forwarded-host': 'xfh.example.com',
        forwarded: 'host=forwarded.example.com',
      },
    });
    assert.strictEqual(seen[0], 'xfh.example.com');

    server.close();
  });

  test('RFC 7239 ignored when trustForwardedHost: false', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `real.example.com:${port}`,
      headers: { forwarded: 'host=attacker.example.com' },
    });
    assert.strictEqual(seen[0], `real.example.com:${port}`);

    server.close();
  });

  test('reuseAgent: true lets the factory cache per-host servers across requests', async () => {
    const constructed = [];
    const returned = [];
    const cache = new Map();
    const factory = ctx => {
      let agent = cache.get(ctx.host);
      if (!agent) {
        constructed.push(ctx.host);
        agent = new McpServer({ name: `Agent for ${ctx.host}`, version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      returned.push(ctx.host);
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    // 4 requests across 2 hosts. Factory called 4 times (still per-request),
    // but constructAdcpServer runs only 2 times (one per unique host).
    await request(port, { host: `snap.example.com:${port}` });
    await request(port, { host: `meta.example.com:${port}` });
    await request(port, { host: `snap.example.com:${port}` });
    await request(port, { host: `meta.example.com:${port}` });

    assert.strictEqual(returned.length, 4, 'factory called once per request');
    assert.deepStrictEqual(
      constructed.sort(),
      [`meta.example.com:${port}`, `snap.example.com:${port}`],
      'server constructed exactly once per unique host'
    );

    server.close();
  });

  test('reuseAgent: true serializes concurrent requests on the same cached server', async () => {
    // Two concurrent requests to the same host. Without the mutex,
    // MCP SDK's Protocol.connect() throws "Already connected to a
    // transport" on the second. With the mutex, they serialize and
    // both succeed.
    const cache = new Map();
    const factory = ctx => {
      let agent = cache.get(ctx.host);
      if (!agent) {
        agent = new McpServer({ name: `Agent for ${ctx.host}`, version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    // 4 concurrent requests on the same host — must all complete without
    // "Already connected" errors crashing the handler.
    const results = await Promise.all([
      request(port, { host: `snap.example.com:${port}` }),
      request(port, { host: `snap.example.com:${port}` }),
      request(port, { host: `snap.example.com:${port}` }),
      request(port, { host: `snap.example.com:${port}` }),
    ]);
    for (const res of results) {
      // All 4 should be status 2xx/4xx from MCP (depending on body), not
      // 500 from the framework. 500 would mean the mutex broke.
      assert.notStrictEqual(res.status, 500, `unexpected 500 — response body: ${res.body}`);
    }

    server.close();
  });

  test('reuseAgent: true concurrent requests on DIFFERENT cached servers run in parallel', async () => {
    // Mutex is keyed on server INSTANCE. Two requests on different hosts
    // (different cached servers) should NOT serialize against each other.
    // Verified by checking that the framework invokes each factory twice
    // across the two hosts — a global mutex would still serialize but
    // would still produce the same count, so this test is by shape
    // (cache-one-per-host) not by wall-clock timing.
    const cache = new Map();
    const entryLog = [];
    const factory = ctx => {
      let agent = cache.get(ctx.host);
      if (!agent) {
        agent = new McpServer({ name: `Agent for ${ctx.host}`, version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      entryLog.push(ctx.host);
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await Promise.all([
      request(port, { host: `a.example.com:${port}` }),
      request(port, { host: `a.example.com:${port}` }),
      request(port, { host: `b.example.com:${port}` }),
      request(port, { host: `b.example.com:${port}` }),
    ]);

    assert.strictEqual(entryLog.length, 4);
    assert.strictEqual(entryLog.filter(h => h.startsWith('a.')).length, 2);
    assert.strictEqual(entryLog.filter(h => h.startsWith('b.')).length, 2);
    // Only 2 UNIQUE servers were ever constructed — one per host.
    assert.strictEqual(cache.size, 2);

    server.close();
  });

  test('reuseAgent: true — same cached server instance handles sequential requests', async () => {
    // Pin the reuse contract explicitly: across multiple sequential
    // requests on the same host, the factory returns the SAME server
    // reference every time. If the framework's internal close() ever
    // rendered the cached instance dead (it does not, per MCP SDK's
    // Protocol._onclose only clearing `_transport`), this assertion
    // catches the regression.
    const returned = new Set();
    const mcp = new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(
      () => {
        returned.add(mcp);
        return mcp;
      },
      { port: 0, reuseAgent: true, onListening: () => {} }
    );
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `host.example.com:${port}` });
    await request(port, { host: `host.example.com:${port}` });
    await request(port, { host: `host.example.com:${port}` });

    // One reference across three requests — not a fresh instance each time.
    assert.strictEqual(returned.size, 1);

    server.close();
  });

  test('reuseAgent: false (default) still creates fresh server per request', async () => {
    const constructed = [];
    const factory = ctx => {
      constructed.push(ctx.host);
      return new McpServer({ name: 'fresh', version: '1.0.0' });
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `a.example.com:${port}` });
    await request(port, { host: `a.example.com:${port}` });

    // Two requests → two constructions. Default behavior preserved.
    assert.strictEqual(constructed.length, 2);

    server.close();
  });

  test('reuseAgent: true isolates auth context across requests on the shared server', async () => {
    // Critical safety check: when an AdcpServer is shared across
    // requests, per-request `authInfo` MUST come from the MCP
    // transport per invocation (via RequestHandlerExtra.authInfo) and
    // NEVER be captured on the server instance. If it bled, request
    // 1's token would authorize request 2's tool call. The MCP SDK's
    // contract is that `extra.authInfo` is populated from `req.auth`
    // per-invocation — this test holds that guarantee for our reuse
    // mode.
    //
    // Uses a bare McpServer with a tool that has no input schema so we
    // can observe `extra.authInfo` directly, avoiding AdCP's
    // schema-validated dispatch path.
    const seenAuth = [];
    const mcp = new McpServer({ name: 'Test', version: '1.0.0' });
    // inputSchema MUST be present — without it, the MCP SDK calls the
    // handler as `(extra)` rather than `(args, extra)` (mcp.js:238),
    // and our observation would see `authInfo: undefined` in what we
    // thought was `extra`.
    mcp.registerTool(
      'observe_auth',
      { description: 'returns authInfo seen', inputSchema: {} },
      async (_args, extra) => {
        seenAuth.push({
          clientId: extra?.authInfo?.clientId ?? null,
          token: extra?.authInfo?.token ?? null,
        });
        return { content: [{ type: 'text', text: 'ok' }] };
      }
    );

    let callNum = 0;
    const server = serve(() => mcp, {
      port: 0,
      reuseAgent: true,
      // Mint a distinct principal per request. Request 1 → principal_1,
      // request 2 → principal_2. If the dispatcher captured request 1's
      // authInfo on the instance, request 2 would see principal_1.
      authenticate: () => {
        callNum++;
        return { principal: `principal_${callNum}`, token: `token_${callNum}` };
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const callObserve = () =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'observe_auth', arguments: {} },
        });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': Buffer.byteLength(body),
              host: `test.example.com:${port}`,
            },
          },
          res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          }
        );
        req.on('error', reject);
        req.end(body);
      });

    await callObserve();
    await callObserve();

    assert.strictEqual(seenAuth.length, 2, `expected 2 handler invocations, got ${seenAuth.length}`);
    assert.strictEqual(seenAuth[0].clientId, 'principal_1', 'request 1 must see principal 1');
    assert.strictEqual(
      seenAuth[1].clientId,
      'principal_2',
      'request 2 must see principal 2 (not the leaked principal 1 from the prior call)'
    );
    assert.strictEqual(seenAuth[0].token, 'token_1');
    assert.strictEqual(seenAuth[1].token, 'token_2');

    server.close();
  });

  test('reuseAgent: true, factory throw in one request does not poison subsequent requests', async () => {
    // If the first request rejects somewhere in the chain, the mutex
    // must not leave the cached server in a locked state — subsequent
    // requests should still acquire and proceed.
    const cache = new Map();
    let failNext = true;
    const factory = ctx => {
      if (failNext) {
        failNext = false;
        throw new Error('synthetic factory failure');
      }
      let agent = cache.get(ctx.host);
      if (!agent) {
        agent = new McpServer({ name: 'Test', version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    // First request — factory throws, server 500s.
    const r1 = await request(port, { host: `snap.example.com:${port}` });
    assert.strictEqual(r1.status, 500);

    // Second request — factory succeeds, mutex chain should be healthy.
    const r2 = await request(port, { host: `snap.example.com:${port}` });
    assert.notStrictEqual(r2.status, 500, 'subsequent request must not be blocked by the prior failure');

    server.close();
  });

  test('function-form publicUrl with no protectedResource is allowed', async () => {
    // publicUrl-only mode (no PRM advertising). Factory sees the host so
    // an adapter can pick a handler set without ever publishing OAuth.
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    // No PRM route served.
    const prmRes = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    assert.strictEqual(prmRes.status, 404);

    // MCP mount still routes and threads host.
    await request(port, { host: `snap.example.com:${port}` });
    assert.strictEqual(seen[0], `snap.example.com:${port}`);

    server.close();
  });
});
