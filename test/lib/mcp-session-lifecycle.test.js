const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { callMCPToolWithTasks } = require('../../dist/lib/protocols/mcp-tasks.js');
const { propagation } = require('@opentelemetry/api');
const { connectMCP, connectMCPWithFallback, closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { callMCPToolWithOAuth } = require('../../dist/lib/protocols/mcp.js');
const { tryCallModernMCPTool, tryListModernMCPTools } = require('../../dist/lib/protocols/mcp-modern.js');
const { withMCPConnectionScope } = require('../../dist/lib/index.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, tasks = false) {
  const receivedSlow = deferred();
  const releaseSlow = deferred();
  const requests = [];
  let initializes = 0;
  let taskPolls = 0;
  const task = status => ({
    taskId: 'long-task',
    status,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttl: 60000,
    pollInterval: 60,
  });
  let deletes = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      deletes++;
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    requests.push({ method: message.method, headers: { ...req.headers } });
    if (message.method.startsWith('notifications/')) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      initializes++;
      result = {
        protocolVersion: tasks ? '2025-11-25' : '2025-03-26',
        capabilities: { tools: {}, ...(tasks && { tasks: { requests: { tools: { call: {} } } } }) },
        serverInfo: { name: 'lifecycle', version: '1' },
      };
    } else if (message.method === 'tasks/get') {
      taskPolls++;
      result = task(taskPolls >= 5 ? 'completed' : 'working');
    } else if (message.method === 'tasks/result') {
      result = { content: [{ type: 'text', text: 'finished' }] };
    } else if (message.method === 'tools/list' && tasks) {
      result = {
        tools: [
          { name: 'long', inputSchema: { type: 'object', properties: {} }, execution: { taskSupport: 'required' } },
        ],
      };
    } else if (message.method === 'tools/list') {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('listing unavailable');
      return;
    } else if (message.method === 'tools/call') {
      if (message.params.name === 'slow') {
        receivedSlow.resolve();
        await releaseSlow.promise;
      }
      result =
        tasks && message.params.name === 'long'
          ? { task: task('working') }
          : { content: [{ type: 'text', text: message.params.name }] };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'lifecycle-session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    releaseSlow.resolve();
    await closeMCPConnections();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    receivedSlow,
    releaseSlow,
    requests,
    get taskPolls() {
      return taskPolls;
    },
    get initializes() {
      return initializes;
    },
    get deletes() {
      return deletes;
    },
  };
}

for (const api of ['connectMCP', 'connectMCPWithFallback']) {
  test(`${api} preserves explicit correlation headers on initialization and direct calls`, async t => {
    const server = await fixture(t);
    propagation.setGlobalPropagator({
      inject(_context, carrier, setter) {
        setter.set(carrier, 'traceparent', 'ambient-parent');
        setter.set(carrier, 'tracestate', 'ambient=state');
        setter.set(carrier, 'baggage', 'ambient=member');
      },
      extract(context) {
        return context;
      },
      fields() {
        return ['traceparent', 'tracestate', 'baggage'];
      },
    });
    t.after(() => propagation.disable());
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
    const headers = { 'x-request-id': 'direct-request', traceparent };
    const client =
      api === 'connectMCP'
        ? (await connectMCP({ agentUrl: server.url, customHeaders: headers, allowPrivateIp: true })).client
        : await connectMCPWithFallback(new URL(server.url), headers, [], 'direct', undefined, { allowPrivateIp: true });
    try {
      assert.equal((await client.callTool({ name: 'ping', arguments: {} })).content[0].text, 'ping');
    } finally {
      await client.close();
    }
    for (const request of server.requests.filter(request => ['initialize', 'tools/call'].includes(request.method))) {
      assert.equal(request.headers['x-request-id'], 'direct-request');
      assert.equal(request.headers.traceparent, traceparent);
      assert.equal(
        request.headers.tracestate,
        undefined,
        'ambient trace state must not attach to an explicit trace family'
      );
      assert.equal(request.headers.baggage, undefined);
    }
    assert.ok(server.requests.some(request => request.method === 'initialize'));
    assert.ok(server.requests.some(request => request.method === 'tools/call'));
  });
}

for (const mode of ['static', 'oauth']) {
  test(`ambient tenant baggage partitions ${mode} legacy sessions`, async t => {
    const server = await fixture(t);
    const routing = new AsyncLocalStorage();
    propagation.setGlobalPropagator({
      inject(_context, carrier, setter) {
        setter.set(carrier, 'baggage', routing.getStore());
      },
      extract(context) {
        return context;
      },
      fields() {
        return ['baggage'];
      },
    });
    t.after(() => propagation.disable());
    const provider = {
      redirectUrl: undefined,
      clientMetadata: { client_name: 'ambient-routing', redirect_uris: [] },
      async clientInformation() {
        return { client_id: 'ambient-routing' };
      },
      async tokens() {
        return { access_token: 'token', token_type: 'Bearer' };
      },
      async saveTokens() {},
      async redirectToAuthorization() {
        throw new Error('Unexpected authorization flow');
      },
      async saveCodeVerifier() {},
      async codeVerifier() {
        return 'verifier';
      },
    };
    const call = tenant =>
      routing.run(`tenant=${tenant}`, () =>
        mode === 'static'
          ? callMCPToolWithTasks(server.url, 'ping', {}, 'token', [], undefined, { allowPrivateIp: true })
          : callMCPToolWithOAuth({
              agentUrl: server.url,
              toolName: 'ping',
              args: {},
              authProvider: provider,
              allowPrivateIp: true,
            })
      );
    await withMCPConnectionScope(async () => {
      await Promise.all([call('one'), call('two')]);
      const coldInitializes = server.initializes;
      await Promise.all([call('one'), call('two')]);
      assert.equal(server.initializes, coldInitializes, 'each tenant reuses its own session');
      const initialized = server.requests.filter(request => request.method === 'initialize');
      assert.ok(initialized.some(request => request.headers.baggage === 'tenant=one'));
      assert.ok(initialized.some(request => request.headers.baggage === 'tenant=two'));
      assert.deepEqual(
        server.requests
          .filter(request => request.method === 'tools/call')
          .map(request => request.headers.baggage)
          .sort(),
        ['tenant=one', 'tenant=one', 'tenant=two', 'tenant=two']
      );
    });
  });
}

test('a failed scoped tools/list retires the session after the concurrent tool call finishes', async t => {
  const server = await fixture(t);
  const options = { handleLegacy: true, allowPrivateIp: true, requestTimeoutMs: 3000 };
  await withMCPConnectionScope(async () => {
    assert.equal((await tryCallModernMCPTool(server.url, 'warm', {}, undefined, [], undefined, options)).handled, true);
    const slow = tryCallModernMCPTool(server.url, 'slow', {}, undefined, [], undefined, options).catch(error => error);
    await server.receivedSlow.promise;
    await assert.rejects(tryListModernMCPTools(server.url, undefined, undefined, options));
    assert.equal(server.deletes, 0, 'listing failure must not terminate an active tool call');
    server.releaseSlow.resolve();
    const result = await slow;
    assert.equal(result.response?.content[0].text, 'slow');
    assert.equal(
      (await tryCallModernMCPTool(server.url, 'after', {}, undefined, [], undefined, options)).handled,
      true
    );
    assert.equal(server.initializes, 2, 'later calls negotiate a replacement for the retired session');
  });
});

test('legacy session expiry does not terminate a call still using the expired session', async t => {
  const server = await fixture(t);
  const options = { handleLegacy: true, allowPrivateIp: true, requestTimeoutMs: 3000 };
  await withMCPConnectionScope(async () => {
    await tryCallModernMCPTool(server.url, 'warm', {}, undefined, [], undefined, options);
    const slow = tryCallModernMCPTool(server.url, 'slow', {}, undefined, [], undefined, options).catch(error => error);
    await server.receivedSlow.promise;
    const realNow = Date.now;
    const expiredAt = realNow() + 5 * 60_000 + 1;
    try {
      Date.now = () => expiredAt;
      assert.equal(
        (await tryCallModernMCPTool(server.url, 'fresh', {}, undefined, [], undefined, options)).handled,
        true
      );
    } finally {
      Date.now = realNow;
    }
    assert.equal(server.deletes, 0, 'an expired session remains open for its active users');
    assert.equal(server.initializes, 2);
    server.releaseSlow.resolve();
    const result = await slow;
    assert.equal(result.response?.content[0].text, 'slow');
  });
});

test('v1 Tasks polling can outlive requestTimeoutMs while individual requests make progress', async t => {
  const server = await fixture(t, true);
  await withMCPConnectionScope(async () => {
    await callMCPToolWithTasks(server.url, 'warm', {}, undefined, [], undefined, {
      requestTimeoutMs: 1000,
      allowPrivateIp: true,
    });
    const started = performance.now();
    const result = await callMCPToolWithTasks(server.url, 'long', {}, undefined, [], undefined, {
      requestTimeoutMs: 150,
      allowPrivateIp: true,
    });
    assert.equal(result.content?.[0].text, 'finished');
    assert.ok(server.taskPolls >= 5);
    assert.ok(performance.now() - started > 150, 'the call must outlast a single request timeout');
  });
});
