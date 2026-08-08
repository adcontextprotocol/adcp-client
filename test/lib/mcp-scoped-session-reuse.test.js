/**
 * Regression coverage for adcontextprotocol/adcp#6204.
 *
 * A hosted conformance run supplies a scoped fetch function, an AbortSignal,
 * and a request timeout. Those safeguards used to force a brand-new MCP
 * transport for every tool call. The connection cache now includes their
 * identities/configuration so calls in the same scope reuse one initialized
 * session without crossing policy or cancellation boundaries.
 */

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { propagation } = require('@opentelemetry/api');

const { callMCPToolWithTasks } = require('../../dist/lib/protocols/mcp-tasks.js');
const { callMCPTool, closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { withMCPConnectionScope } = require('../../dist/lib/protocols/index.js');

let server;
let origin;
const counts = new Map();
let blockedCall;

function counter(path) {
  let value = counts.get(path);
  if (!value) {
    value = { initialize: 0, calls: 0, deletes: 0, traceparents: [] };
    counts.set(path, value);
  }
  return value;
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    const state = counter(path);
    if (req.method === 'DELETE') {
      state.deletes++;
      if (path === '/hung-delete' || path === '/hung-success-delete') return;
      res.writeHead(200).end();
      return;
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = raw ? JSON.parse(raw) : {};

    if (message.method === 'initialize') state.initialize++;
    if (message.method === 'tools/call') {
      state.calls++;
      state.traceparents.push(req.headers.traceparent);
    }

    if ((path === '/delayed' || path === '/scoped-delayed') && message.method === 'initialize') {
      await new Promise(resolve => setTimeout(resolve, 75));
    }

    if (path === '/drop' && message.method === 'tools/call') {
      req.socket.destroy();
      return;
    }

    if (path === '/scope-b' && message.method === 'tools/call' && blockedCall) {
      await blockedCall.promise;
    }

    if (path === '/hung-delete' && message.method === 'tools/call') {
      await new Promise(() => {});
    }

    if (path === '/not-found' && message.method === 'tools/call') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Session not found');
      return;
    }

    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }

    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'session-reuse-test', version: '1.0.0' },
            capabilities: { tools: {} },
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : { content: [{ type: 'text', text: '{}' }], isError: false };
    res.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': `session-${path.slice(1)}`,
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeMCPConnections();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

describe('scoped MCP session reuse', () => {
  test('reuses and gracefully closes one session per caller-owned workflow', async () => {
    const scopedFetch = (input, init) => fetch(input, init);
    const controller = new AbortController();
    const options = { fetchFn: scopedFetch, signal: controller.signal, requestTimeoutMs: 2_000 };
    let deletesBeforeWorkflowClose = 0;

    await withMCPConnectionScope(async () => {
      await callMCPToolWithTasks(`${origin}/workflow`, 'ping', {}, undefined, [], undefined, options);
      const initializedAfterFirstCall = counter('/workflow').initialize;
      const deletesAfterNegotiation = counter('/workflow').deletes;
      deletesBeforeWorkflowClose = deletesAfterNegotiation;
      await callMCPToolWithTasks(`${origin}/workflow`, 'ping', {}, undefined, [], undefined, options);
      assert.equal(counter('/workflow').initialize, initializedAfterFirstCall);
      assert.equal(counter('/workflow').calls, 2);
      assert.equal(
        counter('/workflow').deletes,
        deletesAfterNegotiation,
        'the shared session stays live until workflow completion'
      );
    });

    const initializedAfterFirstWorkflow = counter('/workflow').initialize;
    const deletesAfterFirstWorkflow = counter('/workflow').deletes;
    assert.ok(
      deletesAfterFirstWorkflow > deletesBeforeWorkflowClose,
      'workflow completion should terminate only its session'
    );
    await withMCPConnectionScope(() =>
      callMCPToolWithTasks(`${origin}/workflow`, 'ping', {}, undefined, [], undefined, options)
    );
    assert.ok(
      counter('/workflow').initialize > initializedAfterFirstWorkflow,
      'the next workflow must get a fresh session'
    );
  });

  test('one completed workflow cannot close another workflow active in the same process', async () => {
    let releaseBlockedCall;
    blockedCall = {
      promise: new Promise(resolve => {
        releaseBlockedCall = resolve;
      }),
    };
    const optionsFor = () => ({
      fetchFn: (input, init) => fetch(input, init),
      signal: new AbortController().signal,
      requestTimeoutMs: 2_000,
    });

    const workflowB = withMCPConnectionScope(() =>
      callMCPToolWithTasks(`${origin}/scope-b`, 'ping', {}, undefined, [], undefined, optionsFor())
    );
    try {
      while (counter('/scope-b').calls === 0) await new Promise(resolve => setTimeout(resolve, 5));
      const bDeletesWhileActive = counter('/scope-b').deletes;

      await withMCPConnectionScope(() =>
        callMCPToolWithTasks(`${origin}/scope-a`, 'ping', {}, undefined, [], undefined, optionsFor())
      );
      assert.equal(
        counter('/scope-b').deletes,
        bDeletesWhileActive,
        'workflow A teardown must not terminate workflow B'
      );
    } finally {
      releaseBlockedCall();
      blockedCall = undefined;
    }

    await workflowB;
  });

  test('reuses a session across calls with the same fetch, signal, and timeout', async () => {
    const controller = new AbortController();
    const scopedFetch = (input, init) => fetch(input, init);
    const options = { fetchFn: scopedFetch, signal: controller.signal, requestTimeoutMs: 2_000 };

    const deletesBeforeScope = counter('/reuse').deletes;
    await withMCPConnectionScope(async () => {
      await callMCPToolWithTasks(`${origin}/reuse`, 'ping', {}, undefined, [], undefined, options);
      const initializedAfterFirstCall = counter('/reuse').initialize;
      await callMCPToolWithTasks(`${origin}/reuse`, 'ping', {}, undefined, [], undefined, options);

      assert.equal(counter('/reuse').initialize, initializedAfterFirstCall, 'second call must reuse the session');
      assert.equal(counter('/reuse').calls, 2);
    });
    assert.ok(counter('/reuse').deletes > deletesBeforeScope, 'session should close at scope teardown');
  });

  test('treats session-not-found 404 as terminal instead of reconnecting and replaying', async () => {
    const scopedFetch = (input, init) => fetch(input, init);
    const controller = new AbortController();

    await assert.rejects(
      callMCPToolWithTasks(`${origin}/not-found`, 'mutate', {}, undefined, [], undefined, {
        fetchFn: scopedFetch,
        signal: controller.signal,
        requestTimeoutMs: 2_000,
      }),
      /404|Session not found/i
    );

    assert.equal(counter('/not-found').calls, 1, 'failed tool call must not be replayed');
  });

  test('does not replay a tool call after an ambiguous connection failure', async () => {
    const controller = new AbortController();
    const scopedFetch = (input, init) => fetch(input, init);

    await assert.rejects(
      callMCPToolWithTasks(`${origin}/drop`, 'mutate', {}, undefined, [], undefined, {
        fetchFn: scopedFetch,
        signal: controller.signal,
        requestTimeoutMs: 2_000,
      })
    );

    assert.equal(counter('/drop').calls, 1, 'ambiguous tool call must not be replayed');
  });

  test('a direct one-shot abort does not wait for a server that hangs DELETE', async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    try {
      await assert.rejects(
        Promise.race([
          callMCPTool(
            `${origin}/hung-delete`,
            'ping',
            {},
            undefined,
            [],
            undefined,
            undefined,
            (input, init) => fetch(input, init),
            { signal: controller.signal, requestTimeoutMs: 1_000 }
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('abort path hung')), 500)),
        ]),
        error => error?.name === 'AbortError'
      );
    } finally {
      clearTimeout(abortTimer);
    }

    assert.ok(Date.now() - startedAt < 500, 'abort must not be extended by graceful session termination');
    assert.equal(counter('/hung-delete').deletes, 0, 'failed one-shot calls should close locally without DELETE');
  });

  test('successful graceful teardown is bounded when a server hangs DELETE', async () => {
    const startedAt = Date.now();
    const response = await callMCPTool(
      `${origin}/hung-success-delete`,
      'ping',
      {},
      undefined,
      [],
      undefined,
      undefined,
      (input, init) => fetch(input, init),
      { requestTimeoutMs: 2_000 }
    );

    assert.equal(response.content[0].text, '{}');
    assert.ok(Date.now() - startedAt < 1_500, 'best-effort DELETE must have a bounded deadline');
    assert.equal(counter('/hung-success-delete').deletes, 1);
  });

  test('drains a connection whose initialize is still pending during teardown', async () => {
    const firstCall = callMCPToolWithTasks(`${origin}/delayed`, 'ping', {}, undefined, [], undefined);

    while (counter('/delayed').initialize === 0) await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.allSettled([firstCall, closeMCPConnections()]);
    assert.ok(counter('/delayed').deletes >= 1, 'teardown should terminate the late connection');

    const initializedBeforeSecondCall = counter('/delayed').initialize;
    await callMCPToolWithTasks(`${origin}/delayed`, 'ping', {}, undefined, [], undefined);
    assert.ok(
      counter('/delayed').initialize > initializedBeforeSecondCall,
      'a connection completed after teardown must not repopulate the cache'
    );
  });

  test('scoped teardown drains initialize work that outlives the workflow body', async () => {
    const controller = new AbortController();
    const scopedFetch = (input, init) => fetch(input, init);
    const options = { fetchFn: scopedFetch, signal: controller.signal, requestTimeoutMs: 2_000 };
    let pendingCall;

    const deletesBefore = counter('/scoped-delayed').deletes;
    await withMCPConnectionScope(async () => {
      pendingCall = callMCPToolWithTasks(`${origin}/scoped-delayed`, 'ping', {}, undefined, [], undefined, options);
      void pendingCall.catch(() => {});
      while (counter('/scoped-delayed').initialize === 0) await new Promise(resolve => setTimeout(resolve, 5));
      // Deliberately return without awaiting the branch, matching a runner
      // barrier that has stopped waiting for a slow parallel dispatch.
    });
    await Promise.allSettled([pendingCall]);

    assert.ok(
      counter('/scoped-delayed').deletes > deletesBefore,
      'late initialization must be terminated before scoped teardown completes'
    );
  });

  test('refreshes trace context on each request over a reused session', async () => {
    let traceparent = '00-11111111111111111111111111111111-1111111111111111-01';
    const installed = propagation.setGlobalPropagator({
      inject(_context, carrier, setter) {
        setter.set(carrier, 'traceparent', traceparent);
      },
      extract(context) {
        return context;
      },
      fields() {
        return ['traceparent'];
      },
    });
    assert.equal(installed, true);

    const controller = new AbortController();
    const scopedFetch = (input, init) => fetch(input, init);
    const options = { fetchFn: scopedFetch, signal: controller.signal, requestTimeoutMs: 2_000 };
    try {
      await withMCPConnectionScope(async () => {
        await callMCPToolWithTasks(`${origin}/tracing`, 'ping', {}, undefined, [], undefined, options);
        traceparent = '00-22222222222222222222222222222222-2222222222222222-01';
        await callMCPToolWithTasks(`${origin}/tracing`, 'ping', {}, undefined, [], undefined, options);
      });
    } finally {
      propagation.disable();
    }

    assert.deepStrictEqual(counter('/tracing').traceparents, [
      '00-11111111111111111111111111111111-1111111111111111-01',
      '00-22222222222222222222222222222222-2222222222222222-01',
    ]);
  });
});
