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
    assert.strictEqual(call.body.id, null, 'fire-and-forget uses null id per JSON-RPC 2.0 spec');
    assert.strictEqual(call.body.method, 'tasks/cancel');
    assert.strictEqual(call.body.params.id, 'task-xyz', 'should address cancel by server task id');
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
