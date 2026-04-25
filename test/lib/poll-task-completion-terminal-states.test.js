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

    // Use 'a2a' protocol so getTaskStatus goes directly to ProtocolClient.callTool
    // (the 'mcp' path tries getMCPTaskStatus first, which requires a live server).
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

  test('exits on failed status (regression — pre-existing branch, now in shared FAILED|CANCELED|REJECTED block)', async () => {
    let pollCount = 0;
    ProtocolClient.callTool = mock.fn(async () => {
      pollCount++;
      return {
        task: {
          taskId: 'task-failed',
          status: 'failed',
          error: 'Internal error',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    });

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-failed', 10);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('Internal error'));
    assert.strictEqual(pollCount, 1, 'failed exits on first poll, like rejected');
  });

  test('exits on canceled status (regression — pre-existing branch)', async () => {
    let pollCount = 0;
    ProtocolClient.callTool = mock.fn(async () => {
      pollCount++;
      return {
        task: {
          taskId: 'task-canceled',
          status: 'canceled',
          message: 'Buyer canceled before activation',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    });

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-canceled', 10);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error.includes('Buyer canceled'), `expected message-field fallback, got: ${result.error}`);
    assert.strictEqual(pollCount, 1);
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

  // ────────────────────────────────────────────────────────────
  // Paused states (#977 part 2): input-required / auth-required.
  //
  // Polling alone can't advance these — the buyer must satisfy the
  // paused condition (supply input / refresh auth) and retry the
  // original tool call. The polling loop returns a
  // TaskResultIntermediate so callers can branch on `result.status`,
  // matching the synchronous handleInputRequired no-handler path
  // (`success: true` because the task is progressing, not failed).
  //
  // Pre-fix: pollTaskCompletion ignored these statuses and looped
  // until timeout — a worse failure mode than a clean paused-state
  // result.
  // ────────────────────────────────────────────────────────────

  test('exits with TaskResultIntermediate when status === input-required', async () => {
    let pollCount = 0;
    ProtocolClient.callTool = mock.fn(async () => {
      pollCount++;
      return {
        task: {
          taskId: 'task-input',
          status: 'input-required',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    });

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-input', 10);

    assert.strictEqual(result.success, true, 'task is progressing, not failed');
    assert.strictEqual(result.status, 'input-required');
    assert.strictEqual(pollCount, 1, 'should not loop on paused state');
  });

  test('exits with TaskResultIntermediate when status === auth-required', async () => {
    let pollCount = 0;
    ProtocolClient.callTool = mock.fn(async () => {
      pollCount++;
      return {
        task: {
          taskId: 'task-auth',
          status: 'auth-required',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    });

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-auth', 10);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'auth-required');
    assert.strictEqual(pollCount, 1, 'should not loop on paused state');
  });

  test('paused-state result preserves the wire status (not collapsed)', async () => {
    // Distinct from `failed`/`canceled`/`rejected` which all collapse
    // to `status: 'failed'` on TaskResultFailure. Paused states
    // preserve their wire status so callers can pattern-match.
    ProtocolClient.callTool = mock.fn(async () => ({
      task: {
        taskId: 'task-distinct',
        status: 'auth-required',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));

    const executor = new TaskExecutor();
    const result = await executor.pollTaskCompletion(mockAgent, 'task-distinct', 10);

    assert.notStrictEqual(result.status, 'failed');
    assert.notStrictEqual(result.status, 'completed');
    assert.strictEqual(result.status, 'auth-required');
  });
});
