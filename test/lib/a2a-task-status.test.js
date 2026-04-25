// Tests for the native A2A tasks/get polling path added in issue #963.
//
// The bug: TaskExecutor.getTaskStatus fell through to ProtocolClient.callTool
// for A2A agents, dispatching `message/send { skill: 'tasks/get' }`. Conformant
// sellers reject that because tasks/get is a native A2A JSON-RPC method, not an
// AdCP tool. The fix adds getA2ATaskStatus which calls client.getTask() directly.
//
// Key invariant under test: A2A Task.state is always 'completed' for submitted
// AdCP arms; the real AdCP status is read from artifact.parts[0].data.status.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// Load from dist — tests run against the compiled output.
const { getA2ATaskStatus, closeA2AConnections } = require('../../dist/lib/protocols/a2a.js');

const AGENT_URL = 'https://seller.example.com/a2a';
const SERVER_TASK_ID = 'srv-task-abc123';
const TS = '2026-04-25T12:00:00.000Z';

// ─── stub helpers ────────────────────────────────────────────────────────────

function makeA2ATask({ state = 'completed', artifacts = undefined, timestamp = TS } = {}) {
  return {
    kind: 'task',
    id: SERVER_TASK_ID,
    contextId: 'ctx-xyz',
    status: { state, timestamp },
    ...(artifacts !== undefined ? { artifacts } : {}),
  };
}

function submittedArtifact(extra = {}) {
  return [
    {
      artifactId: 'art-1',
      name: 'submitted',
      parts: [{ kind: 'data', data: { status: 'submitted', task_id: 'adcp-task-001', ...extra } }],
      metadata: { adcp_task_id: 'adcp-task-001' },
    },
  ];
}

function completedArtifact(resultData = {}) {
  return [
    {
      artifactId: 'art-2',
      name: 'result',
      parts: [{ kind: 'data', data: { status: 'completed', ...resultData } }],
    },
  ];
}

/**
 * Stubs A2AClient so getTask() returns controlled Task objects.
 * Returns { getTaskCalls, enqueue, restore }.
 */
function installGetTaskStub() {
  closeA2AConnections();

  const getTaskCalls = [];
  const queue = [];

  const stubClient = {
    sendMessage: async () => {
      throw new Error('sendMessage should not be called during tasks/get polling');
    },
    getTask: async params => {
      getTaskCalls.push(params);
      if (queue.length === 0) throw new Error('No responses enqueued for getTask');
      return queue.shift();
    },
  };

  const { A2AClient } = require('@a2a-js/sdk/client');
  const originalFromCardUrl = A2AClient.fromCardUrl;
  A2AClient.fromCardUrl = async () => stubClient;

  return {
    getTaskCalls,
    enqueue(task) {
      queue.push(task);
    },
    restore() {
      A2AClient.fromCardUrl = originalFromCardUrl;
      closeA2AConnections();
    },
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('getA2ATaskStatus', () => {
  let stub;

  beforeEach(() => {
    stub = installGetTaskStub();
  });

  afterEach(() => {
    stub.restore();
  });

  test('reads AdCP status from artifact data, not Task.state', async () => {
    // Task.state is 'completed' (transport done) but AdCP status is 'submitted'
    stub.enqueue(makeA2ATask({ state: 'completed', artifacts: submittedArtifact() }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'submitted', 'must read status from artifact.data.status');
    assert.strictEqual(info.taskId, SERVER_TASK_ID);
    assert.strictEqual(info.taskType, 'unknown');
    assert.ok(info.result, 'result must be populated from artifact data');
    assert.strictEqual(info.result.task_id, 'adcp-task-001');
  });

  test('maps completed artifact with full result', async () => {
    stub.enqueue(
      makeA2ATask({
        state: 'completed',
        artifacts: completedArtifact({ media_buy_id: 'mb-001', status: 'completed' }),
      })
    );

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(info.result?.media_buy_id, 'mb-001');
    assert.ok(!info.error, 'no error on completed task');
  });

  test('maps A2A failed state to status: failed with error field', async () => {
    stub.enqueue(makeA2ATask({ state: 'failed', artifacts: [] }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'failed');
    assert.ok(info.error, 'error field must be set for failed tasks');
    assert.ok(info.error.includes(SERVER_TASK_ID));
  });

  test('maps A2A rejected state to status: rejected with error field', async () => {
    stub.enqueue(makeA2ATask({ state: 'rejected', artifacts: [] }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'rejected');
    assert.ok(info.error?.includes('rejected'));
  });

  test('maps A2A canceled state to status: canceled with no error field', async () => {
    stub.enqueue(makeA2ATask({ state: 'canceled', artifacts: [] }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'canceled');
    assert.ok(!info.error, 'canceled is a deliberate stop, not an error');
  });

  test('converts ISO timestamp to epoch milliseconds in createdAt', async () => {
    stub.enqueue(makeA2ATask({ state: 'completed', artifacts: completedArtifact() }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    const expected = new Date(TS).getTime();
    assert.strictEqual(info.createdAt, expected, 'createdAt must be epoch ms, not ISO string');
    assert.ok(typeof info.createdAt === 'number');
  });

  test('dispatches getTask with the server-assigned task id', async () => {
    stub.enqueue(makeA2ATask({ state: 'completed', artifacts: completedArtifact() }));

    await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(stub.getTaskCalls.length, 1);
    assert.strictEqual(stub.getTaskCalls[0].id, SERVER_TASK_ID);
  });

  test('never calls sendMessage (not routed through callTool/message/send)', async () => {
    stub.enqueue(makeA2ATask({ state: 'completed', artifacts: completedArtifact() }));

    // The stub throws if sendMessage is called — this test implicitly passes if no throw.
    await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);
  });

  test('rejects empty taskId before network call', async () => {
    await assert.rejects(() => getA2ATaskStatus(AGENT_URL, '', undefined), /Invalid a2aTaskId/);
    assert.strictEqual(stub.getTaskCalls.length, 0, 'no network call made for invalid id');
  });

  test('rejects taskId longer than 256 chars', async () => {
    const longId = 'x'.repeat(257);
    await assert.rejects(() => getA2ATaskStatus(AGENT_URL, longId, undefined), /Invalid a2aTaskId/);
  });

  test('handles task with no artifacts — falls back to A2A state', async () => {
    stub.enqueue(makeA2ATask({ state: 'working', artifacts: [] }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'working');
    assert.ok(!info.result, 'no result when artifacts array is empty');
  });

  test('handles task with no artifacts field — falls back to A2A state', async () => {
    stub.enqueue(makeA2ATask({ state: 'submitted' }));

    const info = await getA2ATaskStatus(AGENT_URL, SERVER_TASK_ID, undefined);

    assert.strictEqual(info.status, 'submitted');
  });
});
