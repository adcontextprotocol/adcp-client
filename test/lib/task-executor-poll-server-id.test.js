// Regression guard for #966: pollTaskCompletion must use the server-assigned
// task ID, not the SDK-internal local UUID.
// Runs in CI (no skip guard) because this is a correctness regression, not a
// slow timing test.
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('TaskExecutor — server task ID plumbing (#966)', () => {
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
      id: 'mock-agent',
      name: 'Mock Agent',
      agent_uri: 'https://mock.test.com',
      protocol: 'mcp',
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('submitted.taskId carries the server-assigned ID, not the local UUID', async () => {
    const SERVER_TASK_ID = 'server-task-abc-123';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, _params) => {
      if (taskName === 'tasks/get') {
        return {
          task: {
            status: 'completed',
            result: { done: true },
            taskType: 'pollIdTask',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ workingTimeout: 10000 });
    const result = await executor.executeTask(mockAgent, 'pollIdTask', {});

    assert.strictEqual(result.status, 'submitted');
    assert(result.submitted, 'Expected submitted continuation');
    assert.strictEqual(
      result.submitted.taskId,
      SERVER_TASK_ID,
      'submitted.taskId must be server-assigned, not the local UUID'
    );
    // operationId is the local UUID — must differ from the server-assigned ID
    assert.notStrictEqual(
      result.submitted.operationId,
      SERVER_TASK_ID,
      'submitted.operationId should be the SDK-internal local UUID, not the server ID'
    );
  });

  test('tasks/get is called with the server-assigned ID, not the local UUID', async () => {
    const SERVER_TASK_ID = 'server-task-xyz-789';
    const polledIds = [];

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        polledIds.push(params.taskId);
        return {
          task: {
            status: 'completed',
            result: { done: true },
            taskType: 'pollIdTask',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ workingTimeout: 10000 });
    const result = await executor.executeTask(mockAgent, 'pollIdTask', {});
    assert.strictEqual(result.status, 'submitted');

    await result.submitted.waitForCompletion(0);

    assert(polledIds.length > 0, 'Expected at least one tasks/get call');
    for (const polled of polledIds) {
      assert.strictEqual(
        polled,
        SERVER_TASK_ID,
        `tasks/get called with wrong ID "${polled}" — expected server-assigned "${SERVER_TASK_ID}"`
      );
    }
  });

  test('falls back to local UUID when server omits task_id (emits console.warn)', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, _params) => {
      if (taskName === 'tasks/get') {
        return {
          task: { status: 'completed', result: {}, taskType: 't', createdAt: Date.now(), updatedAt: Date.now() },
        };
      }
      // No task_id in submitted response
      return { status: 'submitted' };
    });

    try {
      const executor = new TaskExecutor({ workingTimeout: 10000 });
      const result = await executor.executeTask(mockAgent, 'noIdTask', {});
      assert.strictEqual(result.status, 'submitted');
      // A warning must have been emitted about the missing server task ID
      assert(
        warnings.some(w => w.includes('server-assigned task ID') || w.includes('task_id')),
        `Expected a warning about missing task_id, got: ${JSON.stringify(warnings)}`
      );
    } finally {
      console.warn = origWarn;
    }
  });
});
