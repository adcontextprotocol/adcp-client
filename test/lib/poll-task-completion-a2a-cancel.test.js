// Tests that pollTaskCompletion fires A2A tasks/cancel when the AbortSignal
// fires — Phase 1 of adcp-client#1617. The cancel is fire-and-forget:
// failure is non-fatal and the caller's TaskResult is unaffected.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('pollTaskCompletion A2A cancel-on-abort (#1617)', () => {
  let TaskExecutor;
  let originalFetch;
  let mockAgent;

  beforeEach(() => {
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');
    TaskExecutor = lib.TaskExecutor;
    originalFetch = global.fetch;

    mockAgent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://test.example.com/a2a',
      protocol: 'a2a',
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('fires tasks/cancel JSON-RPC call to seller when A2A poll aborts', async () => {
    const cancelCalls = [];
    global.fetch = mock.fn(async (url, options) => {
      cancelCalls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'task-xyz' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const executor = new TaskExecutor();
    const signal = AbortSignal.abort('test cancelled');
    const result = await executor.pollTaskCompletion(mockAgent, 'task-xyz', 10, undefined, signal);

    // The caller's result is the clean failed outcome — cancel is transparent
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('cancelled'), `Expected cancelled error, got: ${result.error}`);

    // Allow fire-and-forget promise to settle
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(cancelCalls.length, 1, 'should have fired exactly one cancel request');
    const [call] = cancelCalls;
    assert.strictEqual(call.url, mockAgent.agent_uri, 'should POST to agent_uri');
    assert.strictEqual(call.body.jsonrpc, '2.0');
    // A2A 0.3.0 §7.4 defines tasks/cancel as request/response, so the wire
    // request must carry a real (non-null) id — JSON-RPC 2.0 §4.1.3 reserves
    // null for notifications. Fire-and-forget is the caller's discipline
    // (we don't await/parse the response), not a wire-protocol claim.
    assert.match(
      call.body.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      `expected a UUID v4 id, got: ${JSON.stringify(call.body.id)}`
    );
    assert.strictEqual(call.body.method, 'tasks/cancel');
    assert.strictEqual(call.body.params.id, 'task-xyz', 'should address cancel by server task id');
  });

  // code-reviewer follow-up on #1620: confirm the auth-header shape matches
  // callA2AToolImpl (Bearer + x-adcp-auth). Without this test, a refactor
  // that drops one of the two headers could ship undetected — Phase 1
  // sellers split on which header they recognize.
  test('cancel POST carries Bearer + x-adcp-auth headers when agent has auth_token', async () => {
    let lastHeaders;
    global.fetch = mock.fn(async (_url, options) => {
      lastHeaders = options.headers;
      return new Response('{}', { status: 200 });
    });

    const authedAgent = { ...mockAgent, auth_token: 'tok-secret-abc' };
    const executor = new TaskExecutor();
    const signal = AbortSignal.abort('test cancelled');
    await executor.pollTaskCompletion(authedAgent, 'task-auth', 10, undefined, signal);

    // Two microtask ticks — the fire-and-forget chain settles via
    // Promise.then chained inside .catch(), so a single tick is racy.
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(lastHeaders.Authorization, 'Bearer tok-secret-abc');
    assert.strictEqual(lastHeaders['x-adcp-auth'], 'tok-secret-abc');
  });

  test('does NOT fire tasks/cancel for MCP agents on abort', async () => {
    let fetchCalled = false;
    global.fetch = mock.fn(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const mcpAgent = { ...mockAgent, protocol: 'mcp' };
    const executor = new TaskExecutor();
    const signal = AbortSignal.abort('test cancelled');
    const result = await executor.pollTaskCompletion(mcpAgent, 'task-mcp', 10, undefined, signal);

    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(result.success, false);
    assert.strictEqual(fetchCalled, false, 'should not fire cancel for MCP protocol');
  });

  test('cancel failure does not affect the TaskResult returned to caller', async () => {
    global.fetch = mock.fn(async () => {
      throw new Error('simulated network unreachable');
    });

    const executor = new TaskExecutor();
    const signal = AbortSignal.abort('test cancelled');
    const result = await executor.pollTaskCompletion(mockAgent, 'task-cancel-fail', 10, undefined, signal);

    await new Promise(resolve => setImmediate(resolve));

    // Cancel failed but the poll result is unaffected — non-fatal by design
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('cancelled'), `Expected cancelled error, got: ${result.error}`);
  });

  test('skips cancel when taskId is empty', async () => {
    let fetchCalled = false;
    global.fetch = mock.fn(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const executor = new TaskExecutor();
    const signal = AbortSignal.abort('test cancelled');
    await executor.pollTaskCompletion(mockAgent, '', 10, undefined, signal);

    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(fetchCalled, false, 'should not fire cancel when taskId is empty string');
  });
});
