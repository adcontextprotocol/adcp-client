// Regression test for adcp-client#966.
//
// Anchors the contract that `SubmittedContinuation.taskId` carries the
// SERVER-assigned task handle (the value the seller emitted in
// `response.task_id`), not the SDK's runner-side correlation UUID. The
// polling cycle (`waitForCompletion` / `track`) must dispatch with the
// server handle so the seller can locate the work.
//
// Pre-fix bug: `setupSubmittedTask` plumbed the runner-side correlation
// UUID through the continuation, so polling addressed a server task the
// seller had never minted. Existing mock tests didn't catch this
// because they ignored the `taskId` param when stubbing the polling
// response.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('SubmittedContinuation: server-assigned task_id plumbing (#966)', () => {
  let TaskExecutor;
  let ProtocolClient;
  let originalCallTool;
  let mockAgent;

  beforeEach(() => {
    delete require.cache[require.resolve('../dist/lib/index.js')];
    const lib = require('../dist/lib/index.js');
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
    if (originalCallTool) ProtocolClient.callTool = originalCallTool;
  });

  test('submitted continuation surfaces the server-assigned task_id, not the runner-side UUID', async () => {
    const SERVER_TASK_ID = 'tk_seller_assigned_42';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, _params) => {
      if (taskName === 'tasks/get') {
        return { task: { status: 'completed', result: { ok: true } } };
      }
      // Initial submitted-arm response carries the seller's task handle.
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'someAsyncTask', {});

    assert.strictEqual(result.status, 'submitted');
    assert.ok(result.submitted, 'submitted continuation present');
    assert.strictEqual(
      result.submitted.taskId,
      SERVER_TASK_ID,
      'continuation must expose the server-minted task_id, not a runner-side UUID'
    );
  });

  test('waitForCompletion polls with the server-assigned task_id', async () => {
    const SERVER_TASK_ID = 'tk_seller_assigned_polling';
    const polledIds = [];

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        // Capture the id the SDK polls with — that's the regression
        // surface. Pre-fix it was the runner-side UUID; post-fix it
        // must be the seller's task handle.
        polledIds.push(params?.taskId ?? params?.task_id);
        return { task: { status: 'completed', result: { polls: polledIds.length } } };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'pollingTest', {});
    assert.strictEqual(result.status, 'submitted');

    const completion = await result.submitted.waitForCompletion(5);
    assert.strictEqual(completion.success, true);
    assert.ok(polledIds.length >= 1, 'at least one poll fired');
    assert.ok(
      polledIds.every(id => id === SERVER_TASK_ID),
      `every poll must address the server task_id; observed: ${JSON.stringify(polledIds)}`
    );
  });

  test('track() uses the server-assigned task_id', async () => {
    const SERVER_TASK_ID = 'tk_seller_assigned_track';
    let trackedId;

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        trackedId = params?.taskId ?? params?.task_id;
        return { task: { status: 'working' } };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'trackTest', {});
    await result.submitted.track();
    assert.strictEqual(trackedId, SERVER_TASK_ID, 'track() must address the server task_id');
  });

  test('falls back to runner-side UUID when seller violates spec and omits task_id', async () => {
    // Spec violation: submitted arm with no task_id field. SDK can't
    // address polling at the seller's task — fall back to the local
    // UUID so callers at least get a non-undefined string to log.
    // This tests the documented escape hatch on the JSDoc.
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return { task: { status: 'completed', result: {} } };
      }
      return { status: 'submitted' }; // no task_id
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'malformedSubmittedTest', {});
    assert.strictEqual(result.status, 'submitted');
    assert.ok(typeof result.submitted.taskId === 'string', 'taskId is a string fallback');
    assert.ok(result.submitted.taskId.length > 0, 'taskId is non-empty');
  });

  test('A2A response with `result.kind: "task"` extracts the A2A Task.id as the server handle', async () => {
    // For A2A responses, the SDK extracts the server handle from
    // `result.id` when `result.kind === 'task'`. Verifies the
    // responseParser.getTaskId branch is what setupSubmittedTask
    // relies on (rather than only looking at `response.task_id` flat).
    const A2A_TASK_ID = 'a2a-server-task-uuid-99';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        return { task: { status: 'completed', result: {} } };
      }
      // Shape of the response the A2A protocol client returns: a
      // JSON-RPC envelope wrapping the A2A Task. responseParser walks
      // `response.result.kind === 'task'` → `response.result.id`.
      return {
        status: 'submitted',
        task_id: A2A_TASK_ID,
        result: { kind: 'task', id: A2A_TASK_ID, status: { state: 'submitted' } },
      };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask({ ...mockAgent, protocol: 'a2a' }, 'a2aSubmittedTest', {});
    assert.strictEqual(result.submitted.taskId, A2A_TASK_ID);
  });
});
