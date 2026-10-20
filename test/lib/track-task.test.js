const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentClient,
  SingleAgentClient,
  TaskExecutor,
  ProtocolClient,
  AsyncHandler,
  parseCapabilitiesResponse,
  createProductCache,
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
      assert.equal(activities.length, 0, 'an observation failure is not a seller task failure');
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
    const client = clientFor(seller, activities);
    const handle = await client.trackTask({ ...identity, signal: controller.signal });
    const result = await handle.waitForCompletion(0);
    assert.equal(call.mock.callCount(), 1);
    assert.equal(result.success, false);
    assert.match(result.error, /cancelled/);
    assert.equal(result.metadata.taskId, identity.operationId);
    assert.equal(result.metadata.serverTaskId, identity.taskId);
    assert.equal(activities.length, 0, 'cancelling observation must not terminalize seller work');
    const resumed = await client.trackTask(identity);
    mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: {} }));
    await resumed.waitForCompletion(0);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].status, 'completed');
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

  test('attaches to a working result on the same client and rebuilds a dropped handle', async () => {
    const activities = [];
    const client = clientFor(seller, activities);
    client.detectServerVersion = async () => 'v3';
    mock.method(ProtocolClient, 'callTool', async () => ({ status: 'working', task_id: identity.taskId }));
    const original = await client.executeCustomTask(identity.taskType, {}, undefined, {
      operationId: identity.operationId,
    });
    assert.equal(original.status, 'working');
    assert.equal(original.submitted, undefined);
    mock.method(ProtocolClient, 'callTool', async () => response('working'));
    const handle = await client.trackTask(identity);
    assert.equal((await handle.track()).status, 'working');
    const rebuilt = await client.trackTask(identity);
    mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: {} }));
    await rebuilt.waitForCompletion(0);
    await handle.track();
    const statuses = activities.filter(activity => activity.type === 'status_change');
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].operation_id, original.metadata.taskId);
    assert.equal(statuses[0].server_task_id, original.metadata.serverTaskId);
  });

  test('rejects tracking-versus-execution collisions before dispatch', async () => {
    const executor = new TaskExecutor();
    executor.trackTask(seller, identity);
    const call = mock.method(ProtocolClient, 'callTool', async () => ({ status: 'completed' }));
    await assert.rejects(
      executor.executeTask(seller, 'another_tool', {}, undefined, { operationId: identity.operationId }),
      /already in use/
    );
    assert.equal(call.mock.callCount(), 0);
    assert.equal(executor.getActiveTasks()[0].serverTaskId, identity.taskId);
  });

  test('rejects concurrent execution collisions without replacing the first lifecycle', async () => {
    const executor = new TaskExecutor();
    let release;
    let dispatched;
    const started = new Promise(resolve => {
      dispatched = resolve;
    });
    const call = mock.method(ProtocolClient, 'callTool', async () => {
      dispatched();
      return new Promise(resolve => {
        release = resolve;
      });
    });
    const first = executor.executeTask(seller, identity.taskType, {}, undefined, { operationId: identity.operationId });
    await started;
    try {
      await assert.rejects(
        executor.executeTask(seller, 'another_tool', {}, undefined, { operationId: identity.operationId }),
        /already in use/
      );
      assert.equal(call.mock.callCount(), 1);
      assert.equal(executor.getActiveTasks()[0].taskName, identity.taskType);
    } finally {
      release({ status: 'working', task_id: identity.taskId });
      await first;
    }
  });

  for (const method of ['track', 'waitForCompletion']) {
    test(`an old ${method} handle cannot publish into a replacement operation after eviction`, async () => {
      const activities = [];
      const executor = new TaskExecutor({ onActivity: activity => activities.push(activity) });
      const old = executor.trackTask(seller, identity);
      mock.method(ProtocolClient, 'callTool', async (_agent, _tool, params) =>
        response('completed', {
          task_id: params.task_id,
          result: { owner: params.task_id },
        })
      );
      await old.waitForCompletion(0);
      executor.cleanupTerminalTaskInspectionState(identity.operationId);
      const replacement = executor.trackTask(seller, { ...identity, taskId: 'replacement-seller-work' });
      activities.length = 0;
      if (method === 'track') await old.track();
      else await old.waitForCompletion(0);
      assert.equal(activities.length, 0);
      assert.equal(executor.getActiveTasks()[0].status, 'submitted');
      const current = await replacement.waitForCompletion(0);
      assert.equal(current.metadata.serverTaskId, 'replacement-seller-work');
      assert.equal(activities.length, 1);
      assert.equal(activities[0].server_task_id, 'replacement-seller-work');
    });
  }

  for (const status of ['failed', 'rejected', 'canceled']) {
    for (const methods of [
      ['track', 'waitForCompletion'],
      ['waitForCompletion', 'track'],
    ]) {
      test(`${status} publishes once when mixing ${methods.join(' then ')}`, async () => {
        const activities = [];
        mock.method(ProtocolClient, 'callTool', async () => response(status));
        const handle = await clientFor(seller, activities).trackTask(identity);
        for (const method of [...methods, ...methods]) {
          if (method === 'track') await handle.track();
          else await handle.waitForCompletion(0);
        }
        assert.equal(activities.length, 1);
        assert.equal(activities[0].server_task_id, identity.taskId);
      });
    }
  }

  for (const mismatched of [{ serverTaskId: 'unrelated-work' }, { taskType: 'unrelated_tool' }]) {
    test(`refuses a mismatched pushed identity ${JSON.stringify(mismatched)}`, async () => {
      const activities = [];
      const executor = new TaskExecutor({ onActivity: activity => activities.push(activity) });
      executor.trackTask(seller, identity);
      await assert.rejects(
        executor.observeExternalTaskStatus(
          identity.operationId,
          'completed',
          {},
          {
            serverTaskId: identity.taskId,
            taskType: identity.taskType,
            ...mismatched,
          }
        ),
        /does not match/
      );
      assert.equal(activities.length, 0);
      assert.equal(executor.getActiveTasks()[0].serverTaskId, identity.taskId);
      assert.equal(executor.getActiveTasks()[0].status, 'submitted');
    });
  }

  test('an in-flight abort rejection leaves the seller lifecycle observable with a fresh signal', async () => {
    const activities = [];
    const controller = new AbortController();
    const client = clientFor(seller, activities);
    const handle = await client.trackTask({ ...identity, signal: controller.signal });
    mock.method(
      ProtocolClient,
      'callTool',
      async (_agent, _tool, _params, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('poll aborted', 'AbortError')), {
            once: true,
          });
          controller.abort();
        })
    );
    await assert.rejects(handle.waitForCompletion(0), { name: 'AbortError' });
    assert.equal(activities.length, 0);
    const replacement = await client.trackTask(identity);
    mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: {} }));
    await replacement.waitForCompletion(0);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].status, 'completed');
  });

  for (const cancelOnAbort of [undefined, false, true]) {
    test(`A2A tracking cancellation requires explicit opt-in (${cancelOnAbort})`, async () => {
      const agent = { ...seller, protocol: 'a2a' };
      const calls = [];
      const activities = [];
      const trustedFetchFn = async (_url, options) => {
        if (!options?.body)
          return new Response(
            JSON.stringify({
              name: 'Cancellation fixture',
              description: 'A2A cancellation fixture',
              url: agent.agent_uri,
              version: '1.0.0',
              protocolVersion: '0.3.0',
              capabilities: {},
              defaultInputModes: ['application/json'],
              defaultOutputModes: ['application/json'],
              skills: [],
            }),
            { headers: { 'content-type': 'application/json' } }
          );
        const body = JSON.parse(options.body);
        calls.push(body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { id: 'transport-task-42' } }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const executor = new TaskExecutor({
        transport: { trustedFetchFn },
        onActivity: activity => activities.push(activity),
      });
      const controller = new AbortController();
      const handle = executor.trackTask(agent, {
        ...identity,
        a2aTaskId: 'transport-task-42',
        cancelOnAbort,
        signal: controller.signal,
      });
      controller.abort('observer stopped');
      await handle.waitForCompletion(0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, cancelOnAbort === true ? 1 : 0);
      if (cancelOnAbort) {
        assert.equal(calls[0].method, 'tasks/cancel');
        assert.equal(calls[0].params.id, 'transport-task-42');
      }
      assert.equal(activities.length, 0);
    });
  }

  for (const order of ['poll-first', 'push-first']) {
    for (const pushedStatus of ['completed', 'failed']) {
      test(`terminal publication stays final across ${order} and a ${pushedStatus} push`, async () => {
        const activities = [];
        const executor = new TaskExecutor({ onActivity: activity => activities.push(activity) });
        const handle = executor.trackTask(seller, identity);
        mock.method(ProtocolClient, 'callTool', async () => response('completed', { result: {} }));
        const push = () =>
          executor.observeExternalTaskStatus(
            identity.operationId,
            pushedStatus,
            {},
            {
              serverTaskId: identity.taskId,
              taskType: identity.taskType,
            }
          );
        if (order === 'poll-first') {
          await handle.track();
          await push();
        } else {
          await push();
          await handle.track();
        }
        await push();
        await handle.waitForCompletion(0);
        assert.equal(activities.length, 1);
        const expected = order === 'poll-first' ? 'completed' : pushedStatus;
        assert.equal(activities[0].status, expected);
        assert.equal(executor.getActiveTasks()[0].status, expected);
      });
    }
  }

  test('explicit A2A seller cancellation also runs when an in-flight poll rejects on abort', async () => {
    const agent = { ...seller, protocol: 'a2a' };
    const calls = [];
    const trustedFetchFn = async (_url, options) => {
      if (!options?.body)
        return new Response(
          JSON.stringify({
            name: 'In-flight cancellation fixture',
            description: 'A2A cancellation fixture',
            url: agent.agent_uri,
            version: '1.0.0',
            protocolVersion: '0.3.0',
            capabilities: {},
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            skills: [],
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      const body = JSON.parse(options.body);
      calls.push(body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { id: 'transport-task-42' } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const activities = [];
    const executor = new TaskExecutor({
      transport: { trustedFetchFn },
      onActivity: activity => activities.push(activity),
    });
    const controller = new AbortController();
    const handle = executor.trackTask(agent, {
      ...identity,
      a2aTaskId: 'transport-task-42',
      cancelOnAbort: true,
      signal: controller.signal,
    });
    mock.method(
      ProtocolClient,
      'callTool',
      async (_agent, _tool, _params, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('poll aborted', 'AbortError')), {
            once: true,
          });
          controller.abort();
        })
    );
    const result = await handle.waitForCompletion(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.success, false);
    assert.match(result.error, /cancelled/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'tasks/cancel');
    assert.equal(calls[0].params.id, 'transport-task-42');
    assert.equal(activities.length, 0);
  });

  for (const operationId of [undefined, 'resolve-parent-operation']) {
    test(`multi-page account resolution gives each physical dispatch its own id (${operationId})`, async () => {
      const client = clientFor(seller, []);
      client.detectServerVersion = async () => 'v3';
      client.getCapabilities = async () =>
        parseCapabilitiesResponse({
          adcp: { major_versions: [3], supported_versions: ['3.1'] },
          supported_protocols: ['media_buy'],
          media_buy: {},
          account: { require_operator_auth: true },
        });
      const calls = [];
      mock.method(ProtocolClient, 'callTool', async (_agent, tool, params, options) => {
        assert.equal(tool, 'list_accounts');
        calls.push(options);
        const second = params.pagination?.cursor === 'next';
        return {
          status: 'completed',
          accounts: [
            {
              account_id: second ? 'account-two' : 'account-one',
              status: 'active',
              brand: { domain: second ? 'two.example' : 'one.example' },
            },
          ],
          pagination: second ? { has_more: false } : { has_more: true, cursor: 'next' },
        };
      });
      const account = await client.resolveAccount({ brand: { domain: 'two.example' } }, { timeout: 5000, operationId });
      assert.deepEqual(account, { account_id: 'account-two' });
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].operationId, calls[1].operationId);
      if (operationId) assert.ok(calls.every(call => call.operationId !== operationId));
      assert.ok(calls[0].signal);
      assert.equal(calls[0].signal, calls[1].signal, 'children retain the absolute parent deadline signal');
    });
  }

  test('an unconditional product-cache refetch gets a fresh operation id under the same deadline', async () => {
    const client = clientFor(seller, []);
    client.config.productCache = createProductCache();
    client.detectServerVersion = async () => 'v3';
    client.getCapabilities = async () =>
      parseCapabilitiesResponse({
        adcp: { major_versions: [3], supported_versions: ['3.1'] },
        supported_protocols: ['media_buy'],
        media_buy: { buying_modes: ['wholesale'] },
      });
    const calls = [];
    mock.method(ProtocolClient, 'callTool', async (_agent, tool, _params, options) => {
      assert.equal(tool, 'get_products');
      calls.push(options);
      return calls.length === 1
        ? { status: 'completed', unchanged: true, cache_scope: 'public', wholesale_feed_version: 'v1' }
        : { status: 'completed', products: [], cache_scope: 'public', wholesale_feed_version: 'v2' };
    });
    const result = await client.getProducts({ buying_mode: 'wholesale' }, undefined, {
      operationId: 'product-query',
      timeout: 5000,
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.data.products, []);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].operationId, 'product-query');
    assert.notEqual(calls[1].operationId, calls[0].operationId);
    assert.equal(calls[0].signal, calls[1].signal);
  });

  for (const operationId of ['', '.', '..', 'delivery_route:reporting:reserved', 'with spaces', 'x'.repeat(256), 42]) {
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
