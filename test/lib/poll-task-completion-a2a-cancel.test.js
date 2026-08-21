// Tests that pollTaskCompletion fires A2A tasks/cancel when the AbortSignal
// fires — Phase 1 of adcp-client#1617. The cancel is fire-and-forget:
// failure is non-fatal and the caller's TaskResult is unaffected.

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

describe('pollTaskCompletion A2A cancel-on-abort (#1617)', () => {
  let TaskExecutor;
  let mockAgent;

  beforeEach(() => {
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');
    TaskExecutor = lib.TaskExecutor;
    mockAgent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://test.example.com/a2a',
      protocol: 'a2a',
    };
  });

  function agentCardResponse() {
    return new Response(
      JSON.stringify({
        name: 'Cancel test agent',
        description: 'A2A cancellation fixture',
        url: mockAgent.agent_uri,
        version: '1.0.0',
        protocolVersion: '0.3.0',
        capabilities: {},
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  test('fires tasks/cancel JSON-RPC call to seller when A2A poll aborts', async () => {
    const cancelCalls = [];
    const trustedFetchFn = mock.fn(async (url, options) => {
      if (!options?.body) return agentCardResponse();
      cancelCalls.push({ url, body: JSON.parse(options.body) });
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: cancelCalls.at(-1).body.id, result: { id: 'task-xyz' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    });

    const executor = new TaskExecutor({ transport: { trustedFetchFn } });
    const signal = AbortSignal.abort('test cancelled');
    const result = await executor.pollTaskCompletion(
      mockAgent,
      'adcp-work-xyz',
      10,
      undefined,
      signal,
      'a2a-transport-task-xyz'
    );

    // The caller's result is the clean failed outcome — cancel is transparent
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('cancelled'), `Expected cancelled error, got: ${result.error}`);

    // Allow fire-and-forget promise to settle
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(cancelCalls.length, 1, 'should have fired exactly one cancel request');
    const [call] = cancelCalls;
    assert.strictEqual(String(call.url), mockAgent.agent_uri, 'should POST to agent_uri');
    assert.strictEqual(call.body.jsonrpc, '2.0');
    // A2A 0.3.0 §7.4 defines tasks/cancel as request/response, so the official
    // client must carry a real (non-null) JSON-RPC id. Its allocator currently
    // uses integers; the protocol contract does not require a UUID.
    assert.notStrictEqual(call.body.id, null);
    assert.notStrictEqual(call.body.id, undefined);
    assert.strictEqual(call.body.method, 'tasks/cancel');
    assert.strictEqual(
      call.body.params.id,
      'a2a-transport-task-xyz',
      'should address cancellation by A2A transport Task.id'
    );
  });

  // code-reviewer follow-up on #1620: confirm the auth-header shape matches
  // callA2AToolImpl (Bearer + x-adcp-auth). Without this test, a refactor
  // that drops one of the two headers could ship undetected — Phase 1
  // sellers split on which header they recognize.
  test('cancel POST carries Bearer + x-adcp-auth headers when agent has auth_token', async () => {
    let lastHeaders;
    const trustedFetchFn = mock.fn(async (_url, options) => {
      if (!options?.body) return agentCardResponse();
      lastHeaders = Object.fromEntries(new Headers(options.headers));
      const id = JSON.parse(options.body).id;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { id: 'task-auth' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const authedAgent = { ...mockAgent, auth_token: 'tok-secret-abc' };
    const executor = new TaskExecutor({ transport: { trustedFetchFn } });
    const signal = AbortSignal.abort('test cancelled');
    await executor.pollTaskCompletion(authedAgent, 'adcp-work-auth', 10, undefined, signal, 'a2a-transport-task-auth');

    // Two microtask ticks — the fire-and-forget chain settles via
    // Promise.then chained inside .catch(), so a single tick is racy.
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(lastHeaders.authorization, 'Bearer tok-secret-abc');
    assert.strictEqual(lastHeaders['x-adcp-auth'], 'tok-secret-abc');
  });

  test('does NOT fire tasks/cancel for MCP agents on abort', async () => {
    let fetchCalled = false;
    const trustedFetchFn = mock.fn(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const mcpAgent = { ...mockAgent, protocol: 'mcp' };
    const executor = new TaskExecutor({ transport: { trustedFetchFn } });
    const signal = AbortSignal.abort('test cancelled');
    const result = await executor.pollTaskCompletion(mcpAgent, 'task-mcp', 10, undefined, signal);

    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(result.success, false);
    assert.strictEqual(fetchCalled, false, 'should not fire cancel for MCP protocol');
  });

  test('cancel failure does not affect the TaskResult returned to caller', async () => {
    const trustedFetchFn = mock.fn(async () => {
      throw new Error('simulated network unreachable');
    });

    const executor = new TaskExecutor({ transport: { trustedFetchFn } });
    const signal = AbortSignal.abort('test cancelled');
    const result = await executor.pollTaskCompletion(
      mockAgent,
      'adcp-work-cancel-fail',
      10,
      undefined,
      signal,
      'a2a-transport-task-cancel-fail'
    );

    await new Promise(resolve => setImmediate(resolve));

    // Cancel failed but the poll result is unaffected — non-fatal by design
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('cancelled'), `Expected cancelled error, got: ${result.error}`);
  });

  test('skips cancel when no A2A transport task identity is available', async () => {
    let fetchCalled = false;
    const trustedFetchFn = mock.fn(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const executor = new TaskExecutor({ transport: { trustedFetchFn } });
    const signal = AbortSignal.abort('test cancelled');
    await executor.pollTaskCompletion(mockAgent, 'adcp-work-only', 10, undefined, signal);

    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(fetchCalled, false, 'should not cancel using the AdCP tasks/get work handle');
  });
});
