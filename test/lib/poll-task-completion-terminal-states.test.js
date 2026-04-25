// Tests that pollTaskCompletion exits immediately on terminal/paused states
// instead of spinning until timeout.
//
// Calls pollTaskCompletion directly (bypassing executeTask) to isolate the
// polling loop behavior from schema validation on the initial call.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('pollTaskCompletion terminal state handling', () => {
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
      protocol: 'mcp',
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('exits loop and returns failure when tasks/get returns rejected (error field)', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({
      task: {
        taskId: 'task-abc',
        status: 'rejected',
        error: 'Request rejected by agent policy',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-abc', 10);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(
      result.error.includes('rejected by agent policy'),
      `Expected error to include rejection message, got: ${result.error}`
    );
  });

  test('preserves message field as error fallback when error field is absent on rejection', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({
      task: {
        taskId: 'task-def',
        status: 'rejected',
        message: 'Budget cap exceeded — task not started',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-def', 10);

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Budget cap exceeded'), `Expected error from message field, got: ${result.error}`);
  });

  test('exits on first poll without retries when tasks/get returns rejected', async () => {
    let pollCount = 0;

    ProtocolClient.callTool = mock.fn(async () => {
      pollCount++;
      return {
        task: {
          taskId: 'task-ghi',
          status: 'rejected',
          error: 'Rejected immediately',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    });

    const executor = new TaskExecutor();
    await executor.pollTaskCompletion(mockAgent, 'task-ghi', 10);

    assert.strictEqual(pollCount, 1, 'Should exit after exactly one poll on rejected');
  });

  test('generic error string when no error or message field on rejection', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({
      task: {
        taskId: 'task-jkl',
        status: 'rejected',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-jkl', 10);

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('rejected'), `Expected fallback error to mention status, got: ${result.error}`);
  });
});
