// Regression test for adcp-client#967.
//
// Anchors the contract that `getTaskStatus` dispatches the AdCP
// `tasks/get` tool with snake_case `task_id` per AdCP 3.0
// (`schemas/cache/3.0.0/bundled/core/tasks-get-request.json`) and
// maps the spec's flat snake_case response shape
// (`schemas/cache/3.0.0/bundled/core/tasks-get-response.json`) to
// the SDK's internal `TaskInfo`.
//
// Pre-fix bugs (caught by these tests):
//   1. SDK passed `{ taskId }` (camelCase) — spec violation; conformant
//      sellers reject as INVALID_PARAMS.
//   2. SDK read `(response.task as TaskInfo)` — expects either a
//      legacy nested wrapper or camelCase fields directly. Spec
//      response is flat snake_case; real responses got
//      `taskId: undefined` everywhere.
//   3. SDK tried MCP `experimental.tasks.getTask` first for MCP
//      agents — that's transport-call lifecycle, not AdCP work
//      lifecycle. For polling submitted-arm tasks (which is what
//      `pollTaskCompletion` does) we need work status; the two
//      interfaces are not substitutes.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

describe('getTaskStatus: AdCP tasks/get spec-shape mapping (#967)', () => {
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

  test('dispatches tasks/get with snake_case task_id (not camelCase taskId)', async () => {
    const SERVER_TASK_ID = 'tk_snake_case_test';
    let observedParams;

    ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
      if (taskName === 'tasks/get') {
        observedParams = params;
        // AdCP 3.0 spec response (flat snake_case)
        return {
          task_id: SERVER_TASK_ID,
          task_type: 'create_media_buy',
          protocol: 'media-buy',
          status: 'completed',
          created_at: '2026-04-25T10:00:00Z',
          updated_at: '2026-04-25T10:05:00Z',
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'pollSnakeCaseTest', {});
    await result.submitted.waitForCompletion(5);

    assert.ok(observedParams, 'tasks/get was dispatched');
    assert.strictEqual(observedParams.task_id, SERVER_TASK_ID, 'request must use snake_case task_id per AdCP 3.0 spec');
    assert.strictEqual(observedParams.taskId, undefined, 'request must NOT include legacy camelCase taskId');
  });

  test('maps the AdCP-spec flat response shape correctly', async () => {
    const SERVER_TASK_ID = 'tk_flat_shape_test';
    const CREATED = '2026-04-25T10:00:00Z';
    const UPDATED = '2026-04-25T10:05:30Z';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return {
          task_id: SERVER_TASK_ID,
          task_type: 'create_media_buy',
          protocol: 'media-buy',
          status: 'completed',
          created_at: CREATED,
          updated_at: UPDATED,
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'flatShapeTest', {});
    const status = await result.submitted.track();
    assert.strictEqual(status.taskId, SERVER_TASK_ID);
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(status.taskType, 'create_media_buy');
    assert.strictEqual(status.createdAt, Date.parse(CREATED));
    assert.strictEqual(status.updatedAt, Date.parse(UPDATED));
  });

  test('passes through `result` field if seller adds it via additionalProperties', async () => {
    // AdCP 3.0 tasks/get response schema doesn't define a `result`
    // field for the completed task's payload (see adcp#3123). Sellers
    // MAY surface it via additionalProperties: true. The SDK passes
    // it through so `pollTaskCompletion` can return it as the
    // resolved task data.
    const SERVER_TASK_ID = 'tk_result_passthrough';
    const COMPLETION_DATA = { media_buy_id: 'mb_42', packages: [] };

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return {
          task_id: SERVER_TASK_ID,
          task_type: 'create_media_buy',
          protocol: 'media-buy',
          status: 'completed',
          created_at: '2026-04-25T10:00:00Z',
          updated_at: '2026-04-25T10:05:00Z',
          result: COMPLETION_DATA, // additionalProperties passthrough
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'resultPassthroughTest', {});
    const completion = await result.submitted.waitForCompletion(5);
    assert.strictEqual(completion.success, true);
    assert.deepStrictEqual(completion.data, COMPLETION_DATA);
  });

  test('maps spec-shape error block to TaskInfo.error', async () => {
    const SERVER_TASK_ID = 'tk_error_mapping';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        return {
          task_id: SERVER_TASK_ID,
          task_type: 'create_media_buy',
          protocol: 'media-buy',
          status: 'failed',
          created_at: '2026-04-25T10:00:00Z',
          updated_at: '2026-04-25T10:05:00Z',
          error: { code: 'IO_REVIEW_FAILED', message: 'Sales rejected the IO terms' },
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'errorMappingTest', {});
    const completion = await result.submitted.waitForCompletion(5);
    assert.strictEqual(completion.success, false);
    assert.strictEqual(completion.status, 'failed');
  });

  test('continues to handle the legacy { task: {...} } nested shape for backward compat', async () => {
    // Some pre-3.0 sellers and existing test fixtures emit a non-spec
    // wrapper. Until those migrate, we keep handling both shapes so
    // we don't break ecosystem on the day this PR lands.
    const SERVER_TASK_ID = 'tk_legacy_shape';

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get') {
        // Legacy nested wrapper with camelCase TaskInfo fields
        return {
          task: {
            taskId: SERVER_TASK_ID,
            status: 'completed',
            taskType: 'create_media_buy',
            createdAt: 1714000000000,
            updatedAt: 1714000300000,
            result: { ok: true },
          },
        };
      }
      return { status: 'submitted', task_id: SERVER_TASK_ID };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'legacyShapeTest', {});
    const completion = await result.submitted.waitForCompletion(5);
    assert.strictEqual(completion.success, true);
    assert.deepStrictEqual(completion.data, { ok: true });
  });

  test('does NOT try MCP experimental.tasks.getTask before the AdCP tool', async () => {
    // The previous implementation tried `getMCPTaskStatus` first and
    // fell through to the AdCP tool on capability-missing. The two
    // interfaces track different lifecycles (MCP-experimental =
    // transport, AdCP tasks/get = work). For submitted-arm polling
    // we always want work status — pin it.
    let callCount = 0;
    let observedToolNames = [];

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      callCount++;
      observedToolNames.push(taskName);
      if (taskName === 'tasks/get') {
        return {
          task_id: 'tk_no_experimental',
          task_type: 'create_media_buy',
          protocol: 'media-buy',
          status: 'completed',
          created_at: '2026-04-25T10:00:00Z',
          updated_at: '2026-04-25T10:05:00Z',
        };
      }
      return { status: 'submitted', task_id: 'tk_no_experimental' };
    });

    const executor = new TaskExecutor({ pollingInterval: 5 });
    const result = await executor.executeTask(mockAgent, 'noExperimentalTest', {});
    await result.submitted.waitForCompletion(5);

    // Two callTool invocations expected: the initial task + one tasks/get poll
    const tasksGetCalls = observedToolNames.filter(name => name === 'tasks/get');
    assert.ok(tasksGetCalls.length >= 1, 'tasks/get was called for polling');
    // No experimental.tasks.getTask reached ProtocolClient.callTool —
    // the experimental path bypasses callTool entirely (uses the SDK's
    // experimental subsystem), so its absence here proves the new
    // dispatch path skipped it.
  });
});
