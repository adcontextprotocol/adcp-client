const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentClient,
  SingleAgentClient,
  TaskExecutor,
  ProtocolClient,
  AsyncHandler,
} = require('../../dist/lib/index.js');

const seller = {
  id: 'persisted-task-seller',
  name: 'Persisted task seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};
const identity = { taskId: 'seller-work-42', taskType: 'catalog_refresh', operationId: 'buyer-operation-42' };
const response = (status, extra = {}) => ({
  task_id: identity.taskId,
  task_type: identity.taskType,
  status,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...extra,
});

function clientFor(agent, activities) {
  const client = new SingleAgentClient(agent, {
    strictSchemaValidation: false,
    validateFeatures: false,
    onActivity: activity => activities.push(activity),
  });
  const discovered = { ...agent, agent_uri: 'https://seller.example/discovered-endpoint' };
  client.ensureEndpointDiscovered = async () => discovered;
  client.ensureCanonicalUrlResolved = async () => discovered;
  return client;
}

describe('persisted seller task tracking (#3338)', () => {
  afterEach(() => mock.restoreAll());

  for (const protocol of ['mcp', 'a2a']) {
    test(`${protocol}: restart polling emits one terminal lifecycle record under the original operation`, async () => {
      const activities = [];
      const calls = [];
      const statuses = ['submitted', 'working', 'submitted', 'completed'];
      const resultData = { refreshed: true };
      mock.method(ProtocolClient, 'callTool', async (agent, tool, params, options) => {
        calls.push({ agent, tool, params, options });
        const status = statuses.shift() ?? 'completed';
        return response(status, status === 'completed' ? { result: resultData } : {});
      });
      const client = clientFor({ ...seller, protocol }, activities);
      const handle = await client.trackTask(identity);
      assert.equal(handle.taskId, identity.taskId);
      assert.equal(handle.operationId, identity.operationId);
      assert.equal((await handle.track()).status, 'submitted');
      const completed = await handle.waitForCompletion(0);
      assert.equal(completed.status, 'completed');
      assert.deepEqual(completed.data, resultData);
      assert.equal(completed.metadata.taskId, identity.operationId);
      assert.equal(completed.metadata.serverTaskId, identity.taskId);
      assert.equal(completed.metadata.taskName, identity.taskType);
      await handle.track();
      await handle.waitForCompletion(0);
      assert.equal(activities.length, 1);
      assert.equal(activities[0].type, 'status_change');
      assert.equal(activities[0].status, 'completed');
      assert.equal(activities[0].operation_id, identity.operationId);
      assert.equal(activities[0].task_id, identity.operationId);
      assert.equal(activities[0].server_task_id, identity.taskId);
      assert.equal(activities[0].task_type, identity.taskType);
      for (const call of calls) {
        assert.equal(call.tool, protocol === 'mcp' ? 'tasks_get' : 'tasks/get');
        assert.equal(call.agent.agent_uri, 'https://seller.example/discovered-endpoint');
        assert.deepEqual(call.params, { task_id: identity.taskId, include_result: true });
        assert.equal(call.options.transportActivityContext.operationId, identity.operationId);
        assert.equal(call.options.transportActivityContext.taskId, identity.taskId);
      }
    });
  }

  test('AgentClient exposes tracking and generates a stable operation id when omitted', async () => {
    const activities = [];
    const client = new AgentClient(seller);
    client.client = clientFor(seller, activities);
    mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: {} }));
    const handle = await client.trackTask({ taskId: identity.taskId, taskType: identity.taskType });
    assert.match(handle.operationId, /^[0-9a-f-]{36}$/);
    const result = await handle.waitForCompletion(0);
    assert.equal(result.metadata.taskId, handle.operationId);
    assert.equal(activities[0].operation_id, handle.operationId);
  });

  test('a single terminal track emits both identities and does not fabricate empty result data', async () => {
    const activities = [];
    mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: { products: [] } }));
    const handle = await clientFor(seller, activities).trackTask(identity);
    const task = await handle.track();
    assert.deepEqual(task.result, { products: [] });
    assert.equal(task.taskId, identity.taskId);
    assert.equal(task.serverTaskId, identity.taskId);
    assert.equal(task.operationId, identity.operationId);
    assert.equal(activities[0].server_task_id, identity.taskId);
  });

  for (const [label, fields] of [
    ['task id', { task_id: 'unrelated-work' }],
    ['task type', { task_type: 'unrelated_tool' }],
  ]) {
    test(`rejects a seller ${label} mismatch without exposing its result`, async () => {
      const activities = [];
      mock.method(ProtocolClient, 'callTool', async () =>
        response('completed', { ...fields, result: { unrelated: true } })
      );
      const handle = await clientFor(seller, activities).trackTask(identity);
      const result = await handle.waitForCompletion(0);
      assert.equal(result.success, false);
      assert.equal(result.data, undefined);
      assert.match(result.error, /does not match/);
      assert.equal(result.metadata.taskId, identity.operationId);
      assert.equal(result.metadata.serverTaskId, identity.taskId);
      assert.equal(activities[0].operation_id, identity.operationId);
      assert.equal(activities[0].server_task_id, identity.taskId);
    });
  }

  for (const status of ['failed', 'rejected', 'canceled', 'input-required', 'auth-required']) {
    test(`preserves the existing polling behavior for ${status}`, async () => {
      const activities = [];
      mock.method(ProtocolClient, 'callTool', async () =>
        response(status, { error: { message: 'Seller paused or failed' } })
      );
      const handle = await clientFor(seller, activities).trackTask(identity);
      const result = await handle.waitForCompletion(0);
      assert.equal(result.success, ['input-required', 'auth-required'].includes(status));
      assert.equal(result.status, ['input-required', 'auth-required'].includes(status) ? status : 'failed');
      assert.equal(result.metadata.taskId, identity.operationId);
      assert.equal(result.metadata.serverTaskId, identity.taskId);
      assert.equal(activities[0].server_task_id, identity.taskId);
    });
  }

  test('cancellation stops polling without confusing the seller and operation ids', async () => {
    const activities = [];
    const controller = new AbortController();
    const call = mock.method(ProtocolClient, 'callTool', async () => {
      controller.abort('buyer stopped');
      return response('working');
    });
    const handle = await clientFor(seller, activities).trackTask({ ...identity, signal: controller.signal });
    const result = await handle.waitForCompletion(0);
    assert.equal(call.mock.callCount(), 1);
    assert.equal(result.success, false);
    assert.match(result.error, /cancelled/);
    assert.equal(result.metadata.taskId, identity.operationId);
    assert.equal(result.metadata.serverTaskId, identity.taskId);
    assert.equal(activities[0].server_task_id, identity.taskId);
  });

  test('transport options are snapshotted for the tracking lifetime', async () => {
    const activities = [];
    const transport = { maxResponseBytes: 123456 };
    const call = mock.method(ProtocolClient, 'callTool', async () => response('working'));
    const client = clientFor(seller, activities);
    const pending = client.trackTask({ ...identity, transport });
    transport.maxResponseBytes = 1;
    const handle = await pending;
    await handle.track();
    assert.equal(call.mock.calls[0].arguments[3].transport.maxResponseBytes, 123456);
    await handle.track({ maxResponseBytes: 987654 });
    assert.equal(call.mock.calls[1].arguments[3].transport.maxResponseBytes, 987654);
  });

  test('refuses to replace an existing local lifecycle with the same operation id', async () => {
    const client = clientFor(seller, []);
    await client.trackTask(identity);
    await assert.rejects(client.trackTask({ ...identity, taskId: 'other-seller-work' }), /already tracked/);
  });

  test('the public operationId survives task deadline wrappers and reaches responses, activity, and transport', async () => {
    const activities = [];
    const call = mock.method(ProtocolClient, 'callTool', async () => ({
      status: 'submitted',
      task_id: identity.taskId,
    }));
    const client = clientFor(seller, activities);
    client.detectServerVersion = async () => 'v3';
    const result = await client.executeCustomTask(identity.taskType, {}, undefined, {
      operationId: identity.operationId,
      timeout: 5000,
    });
    assert.equal(result.metadata.taskId, identity.operationId);
    assert.equal(result.metadata.serverTaskId, identity.taskId);
    assert.equal(call.mock.calls[0].arguments[3].operationId, identity.operationId);
    assert.deepEqual(
      activities.map(activity => activity.type),
      ['protocol_request', 'protocol_response']
    );
    assert.ok(activities.every(activity => activity.operation_id === identity.operationId));
    assert.equal(activities[1].server_task_id, identity.taskId);
    mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: {} }));
    await result.submitted.waitForCompletion(0);
    assert.equal(activities.at(-1).server_task_id, identity.taskId);
  });

  test('webhook activity exposes the seller handle alongside the runner operation id', async () => {
    const activities = [];
    const handler = new AsyncHandler({ onActivity: activity => activities.push(activity) });
    await handler.handleWebhook({
      result: {},
      metadata: {
        operation_id: identity.operationId,
        task_id: identity.taskId,
        task_type: identity.taskType,
        agent_id: seller.id,
        status: 'completed',
        timestamp: new Date().toISOString(),
      },
    });
    assert.equal(activities[0].operation_id, identity.operationId);
    assert.equal(activities[0].task_id, identity.taskId);
    assert.equal(activities[0].server_task_id, identity.taskId);
  });

  for (const operationId of ['', 'with spaces', 'x'.repeat(256), 42]) {
    test(`rejects invalid public operationId ${JSON.stringify(operationId)} before discovery`, async () => {
      const client = clientFor(seller, []);
      let discovered = false;
      client.ensureEndpointDiscovered = async () => {
        discovered = true;
        return seller;
      };
      await assert.rejects(client.trackTask({ ...identity, operationId }), /operationId/);
      assert.equal(discovered, false);
      const executor = new TaskExecutor();
      await assert.rejects(
        executor.executeTask(seller, identity.taskType, {}, undefined, { operationId }),
        /operationId/
      );
    });
  }
});
