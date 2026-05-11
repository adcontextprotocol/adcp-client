// Tests that pollTaskCompletion returns a descriptive failed TaskResult
// when getTaskStatus throws "Task <id> not found" (A2A 0.3.x defines no
// minimum retention TTL — sellers may evict completed tasks before the
// first explicit poll fires). Defense-in-depth for adcp-client#1585.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('pollTaskCompletion handles evicted tasks (#1585)', () => {
  let TaskExecutor;
  let ProtocolClient;
  let originalCallTool;
  let mockAgent;

  beforeEach(() => {
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');
    TaskExecutor = lib.TaskExecutor;
    ProtocolClient = lib.ProtocolClient;
    originalCallTool = ProtocolClient.callTool;

    mockAgent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://test.example.com',
      protocol: 'a2a',
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('returns failed TaskResult with actionable error when getTaskStatus reports task not found', async () => {
    ProtocolClient.callTool = mock.fn(async () => {
      throw new Error('A2A agent returned error: Task abc-123 not found');
    });

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'abc-123', 10);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('abc-123'), `Expected error to include the task id, got: ${result.error}`);
    assert.ok(/no longer queryable/i.test(result.error), `Expected actionable hint, got: ${result.error}`);
    assert.ok(
      /reporting_webhook|push notification/i.test(result.error),
      `Expected suggestion to use push notifications, got: ${result.error}`
    );
  });

  test('does not loop on task-not-found — exits on first poll', async () => {
    let pollCount = 0;
    ProtocolClient.callTool = mock.fn(async () => {
      pollCount++;
      throw new Error('Task xyz-789 not found');
    });

    const executor = new TaskExecutor();
    await executor.pollTaskCompletion(mockAgent, 'xyz-789', 10);

    assert.strictEqual(pollCount, 1, 'should exit after a single poll on not-found');
  });

  test('re-throws unrelated errors from getTaskStatus (does not swallow non-matching failures)', async () => {
    ProtocolClient.callTool = mock.fn(async () => {
      throw new Error('Network unreachable: ECONNREFUSED');
    });

    const executor = new TaskExecutor();
    await assert.rejects(
      () => executor.pollTaskCompletion(mockAgent, 'task-network', 10),
      /ECONNREFUSED/,
      'unrelated transport errors must propagate, not be coerced into failed TaskResult'
    );
  });

  test('failed result carries metadata (taskId, agent) for diagnostics', async () => {
    ProtocolClient.callTool = mock.fn(async () => {
      throw new Error('Task task-meta-1 not found');
    });

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-meta-1', 10);

    assert.ok(result.metadata, 'failed result must include metadata');
    assert.strictEqual(result.metadata.taskId, 'task-meta-1');
    assert.strictEqual(result.metadata.status, 'failed');
  });
});
