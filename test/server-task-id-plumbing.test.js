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

  test('falls back to runner-side UUID and emits debug-log advisory when seller omits task_id', async () => {
    // Spec violation: submitted arm with no task_id field. SDK can't
    // address polling at the seller's task — fall back to the local
    // UUID so callers at least get a non-undefined string to log.
    // The fallback path also writes an advisory entry to debug_logs
    // so operators grepping for "task_id" / "spec violation" can
    // pinpoint the offending seller call.
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
    const advisory = (result.debug_logs ?? []).find(
      e => e?.type === 'warning' && /omitted task_id/i.test(e?.message ?? '')
    );
    assert.ok(advisory, 'fallback path emits a debug_logs advisory naming the spec violation');
  });

  test('A2A wrapped response with `result.kind: "task"` extracts result.id as the server handle', async () => {
    // For A2A submitted-arm responses, the protocol client returns the
    // JSON-RPC envelope (`{ id, jsonrpc, result: <Task> }`).
    // responseParser walks `response.result.kind === 'task'` →
    // `response.result.id` and returns the A2A Task.id. Distinct
    // sentinels on `result.id` vs the flat shape ensure the test is
    // exercising the result-branch, not silently passing because both
    // fields carry the same value. Note: this test pins the CURRENT
    // parser behavior; #967 will revisit this priority for A2A
    // submitted arms (where the AdCP work handle on
    // `artifact.metadata.adcp_task_id` is the buyer's polling key,
    // not `result.id`).
    const A2A_TASK_ID = 'a2a-server-task-uuid-99';
    const FLAT_TASK_ID = 'flat-task-id-should-be-ignored';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return { task: { status: 'completed', result: {} } };
      }
      // The wrapped envelope branch: `result.kind === 'task'` wins
      // over `response.task_id` (flat) per ProtocolResponseParser
      // priority (`response.result` checked first).
      return {
        status: 'submitted',
        task_id: FLAT_TASK_ID,
        result: { kind: 'task', id: A2A_TASK_ID, status: { state: 'submitted' } },
      };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask({ ...mockAgent, protocol: 'a2a' }, 'a2aSubmittedTest', {});
    assert.strictEqual(
      result.submitted.taskId,
      A2A_TASK_ID,
      `wrapped result.id branch must take precedence over flat task_id; got ${result.submitted.taskId}`
    );
  });

  test('MCP `structuredContent.task_id` extraction path', async () => {
    // MCP responses surface the seller handle on
    // `structuredContent.task_id`. Pin the path is exercised so a
    // future parser refactor can't drop this branch silently.
    const MCP_TASK_ID = 'mcp-structured-content-task-id';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return { task: { status: 'completed', result: {} } };
      }
      return { structuredContent: { status: 'submitted', task_id: MCP_TASK_ID } };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'mcpStructuredTest', {});
    assert.strictEqual(result.submitted.taskId, MCP_TASK_ID);
  });

  test('multi-poll lifecycle: every poll addresses the server-assigned task_id (not just the first)', async () => {
    // The pre-fix bug was "polling sends the wrong id." Single-poll
    // tests prove the first call is correct but don't pin that
    // subsequent calls are too. `working → working → completed` makes
    // the regression class observable: a future refactor that fixes
    // the first poll but regresses internal-loop polling would slip
    // past the single-poll test.
    const SERVER_TASK_ID = 'tk_seller_assigned_multipoll';
    const polledIds = [];
    const sequence = ['working', 'working', 'completed'];
    let pollCount = 0;

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        polledIds.push(params?.taskId ?? params?.task_id);
        const state = sequence[Math.min(pollCount++, sequence.length - 1)];
        return state === 'completed'
          ? { task: { status: 'completed', result: { polls: pollCount } } }
          : { task: { status: 'working' } };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'multipollTest', {});
    const completion = await result.submitted.waitForCompletion(5);
    assert.strictEqual(completion.success, true);
    assert.ok(polledIds.length >= 3, `expected ≥3 polls, got ${polledIds.length}`);
    assert.ok(
      polledIds.every(id => id === SERVER_TASK_ID),
      `every poll across the working→completed lifecycle must address the server task_id; observed: ${JSON.stringify(polledIds)}`
    );
  });

  test('concurrent submitted tasks: each continuation polls its own server task_id', async () => {
    // Two `executeTask` calls in flight with distinct seller-side
    // handles. Pins the activeTasks map keying — a regression that
    // confused the local correlation UUID with the server handle
    // could cross-pollinate concurrent polls, and that wouldn't
    // surface on serial tests.
    const SERVER_A = 'tk_concurrent_A';
    const SERVER_B = 'tk_concurrent_B';
    const polledFor = { A: [], B: [] };
    let nextSeller = SERVER_A;

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        const id = params?.taskId ?? params?.task_id;
        if (id === SERVER_A) polledFor.A.push(id);
        if (id === SERVER_B) polledFor.B.push(id);
        return { task: { status: 'completed', result: { id } } };
      }
      const handle = nextSeller;
      nextSeller = nextSeller === SERVER_A ? SERVER_B : SERVER_A;
      return { status: 'submitted', task_id: handle };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const [resultA, resultB] = await Promise.all([
      executor.executeTask({ ...mockAgent, id: 'agent-a' }, 'taskA', {}),
      executor.executeTask({ ...mockAgent, id: 'agent-b' }, 'taskB', {}),
    ]);
    assert.strictEqual(resultA.submitted.taskId, SERVER_A);
    assert.strictEqual(resultB.submitted.taskId, SERVER_B);

    await Promise.all([resultA.submitted.waitForCompletion(5), resultB.submitted.waitForCompletion(5)]);
    assert.ok(polledFor.A.length >= 1, 'task A polled at least once');
    assert.ok(polledFor.B.length >= 1, 'task B polled at least once');
    assert.ok(
      polledFor.A.every(id => id === SERVER_A),
      `task A polls must address SERVER_A; got ${JSON.stringify(polledFor.A)}`
    );
    assert.ok(
      polledFor.B.every(id => id === SERVER_B),
      `task B polls must address SERVER_B; got ${JSON.stringify(polledFor.B)}`
    );
  });

  test('webhook URL macro uses the runner-side correlation id, not the server task_id', async () => {
    // Documents the two-IDs-with-different-purposes invariant: the
    // `{operation_id}` webhook URL macro is a buyer-side correlator
    // (used in callback-URL paths the seller posts back to), so it
    // stays on the local UUID. Conversely, `submitted.taskId` is the
    // server's handle. A future refactor that collapses them would
    // silently break webhook-URL stability across retries.
    const SERVER_TASK_ID = 'tk_webhook_separation';
    const generatedFor = [];
    const registeredFor = [];
    const webhookManager = {
      generateUrl: id => {
        generatedFor.push(id);
        return `https://buyer.example/webhook/${id}`;
      },
      registerWebhook: async (_agent, id) => {
        registeredFor.push(id);
      },
      processWebhook: async () => {},
    };

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return { task: { status: 'working' } };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5, webhookManager });
    const result = await executor.executeTask(mockAgent, 'webhookSepTest', {});
    assert.strictEqual(result.submitted.taskId, SERVER_TASK_ID, 'continuation surfaces server handle');
    assert.ok(generatedFor.length === 1 && registeredFor.length === 1, 'webhook manager invoked once');
    assert.notStrictEqual(
      generatedFor[0],
      SERVER_TASK_ID,
      'webhook URL macro must NOT use the server task_id — it is the buyer-side correlation id'
    );
    assert.strictEqual(
      generatedFor[0],
      registeredFor[0],
      'generateUrl and registerWebhook receive the same id (the runner-side correlation)'
    );
    assert.ok(
      result.submitted.webhookUrl?.endsWith(`/${generatedFor[0]}`),
      'continuation webhookUrl reflects the local correlation id'
    );
  });

  test('tasks/get error surfaces the failure on the resolved TaskResult', async () => {
    // If the polling call itself fails (network, seller error), the
    // SDK should surface failure rather than hang. Pinning behavior
    // on failure prevents a future refactor from silently swallowing
    // poll errors and looping indefinitely.
    const SERVER_TASK_ID = 'tk_error_path';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        // Returns a failed task — within the poll loop's normal
        // failed-status handling path.
        return { task: { status: 'failed', error: 'simulated seller failure' } };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'errorPathTest', {});
    const completion = await result.submitted.waitForCompletion(5);
    assert.strictEqual(completion.success, false, 'failed poll surfaces as completion.success === false');
    assert.strictEqual(completion.status, 'failed');
  });
});
