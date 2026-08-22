const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { SingleAgentClient, TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');
const { markCompletionHandlerAlreadyPublished } = require('../../dist/lib/core/TaskExecutor.js');
const { memoryBackend } = require('../../dist/lib/server/idempotency/backends/memory.js');

const testDurableToken = label => createHash('sha256').update(label).digest('base64url');

const AGENT = {
  id: 'dispatch-boundary-seller',
  name: 'Dispatch boundary seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function a2aPause({ question, field, contextId, taskId, serverTaskId }) {
  return {
    result: {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          messageId: `${taskId}-clarification`,
          role: 'agent',
          parts: [{ kind: 'data', data: { question, field } }],
        },
      },
      artifacts:
        serverTaskId === undefined
          ? []
          : [{ artifactId: `${taskId}-work`, metadata: { adcp_task_id: serverTaskId }, parts: [] }],
    },
  };
}

function deferredStorage(records) {
  return {
    set: async (token, state) => records.set(token, state),
    putIfAbsent: async (token, state) => {
      if (records.has(token)) return false;
      records.set(token, state);
      return true;
    },
    replaceIfVersion: async (token, expectedVersion, state) => {
      if (records.get(token)?.continuationVersion !== expectedVersion) return false;
      records.set(token, state);
      return true;
    },
    takeIfVersion: async (token, expectedVersion) => {
      const state = records.get(token);
      if (state?.continuationVersion !== expectedVersion) return undefined;
      records.delete(token);
      return state;
    },
    get: async token => records.get(token),
    take: async token => {
      const state = records.get(token);
      records.delete(token);
      return state;
    },
    delete: async token => records.delete(token),
    has: async token => records.has(token),
  };
}

const originalCallTool = ProtocolClient.callTool;

afterEach(() => {
  ProtocolClient.callTool = originalCallTool;
});

describe('TaskExecutor pre-dispatch boundary', () => {
  test('MCP pauses remain explicitly nonresumable even when an input handler was supplied', async () => {
    let handlerCalls = 0;
    ProtocolClient.callTool = async () => ({
      status: 'input-required',
      message: 'Seller needs approval',
      field: 'approval',
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(AGENT, 'create_media_buy', {}, async () => {
      handlerCalls += 1;
      return 'approved';
    });
    assert.equal(result.status, 'input-required');
    assert.equal(result.deferred, undefined);
    assert.equal(handlerCalls, 0);
  });

  test('compatibility polling uses the discovered protocol endpoint', async () => {
    const client = new SingleAgentClient(
      { ...AGENT, agent_uri: 'https://seller.example' },
      { strictSchemaValidation: false, validateFeatures: false }
    );
    const discovered = { ...AGENT, agent_uri: 'https://seller.example/private/oauth/mcp' };
    client.ensureEndpointDiscovered = async () => discovered;
    let polledAgent;
    client.executor.getTaskStatus = async agent => {
      polledAgent = agent;
      return {
        taskId: 'discovered-task',
        taskType: 'create_media_buy',
        status: 'working',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    };

    await client.getTaskStatus('discovered-task');
    assert.equal(polledAgent.agent_uri, discovered.agent_uri);
  });

  test('terminalizes and compacts task state when the claim hook rejects', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'completed', data: { ok: true } }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });

    await assert.rejects(
      executor.executeTask(
        AGENT,
        'create_media_buy',
        { idempotency_key: 'rejected-claim', sensitive_payload: 'must-not-be-retained' },
        undefined,
        {},
        'v3',
        undefined,
        async () => {
          throw new Error('claim rejected');
        }
      ),
      /pre-dispatch hook failed/i
    );

    const retained = executor.getActiveTasks();
    assert.equal(
      retained.some(task => task.status === 'pending'),
      false
    );
    assert.equal(retained.length, 1);
    assert.equal(retained[0].status, 'failed');
    assert.equal(retained[0].params, undefined);
    assert.deepEqual(retained[0].options, {});
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
  });

  test('does not run the durable claim hook when aborting during awaited preflight', async () => {
    let releaseActivity;
    const activityStarted = new Promise(resolve => {
      releaseActivity = resolve;
    });
    let markActivityStarted;
    const activityEntered = new Promise(resolve => {
      markActivityStarted = resolve;
    });
    let hookCalled = false;
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'completed', data: { ok: true } }));
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      onActivity: async activity => {
        if (activity.type !== 'protocol_request') return;
        markActivityStarted();
        await activityStarted;
      },
    });
    const controller = new AbortController();

    const execution = executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'preflight-abort' },
      undefined,
      { signal: controller.signal },
      'v3',
      undefined,
      async () => {
        hookCalled = true;
        return { action: 'dispatch_committed' };
      }
    );
    await activityEntered;
    controller.abort(new Error('abort during preflight'));
    releaseActivity();

    await assert.rejects(execution, /abort during preflight/);
    assert.equal(hookCalled, false);
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
  });

  test('reserves durable settlement capacity before awaiting a concurrent claim hook', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'completed', data: { ok: true } }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    for (let index = 0; index < 9_999; index += 1) {
      executor.deferredTerminalPublicationTaskIds.add(`protected-task-${index}`);
    }
    let releaseFirstClaim;
    const firstClaimRelease = new Promise(resolve => {
      releaseFirstClaim = resolve;
    });
    let markFirstClaimStarted;
    const firstClaimStarted = new Promise(resolve => {
      markFirstClaimStarted = resolve;
    });
    let hookCalls = 0;
    const hook = async () => {
      hookCalls += 1;
      markFirstClaimStarted();
      await firstClaimRelease;
      return {
        action: 'return',
        result: {
          success: true,
          status: 'completed',
          data: { media_buy_id: 'capacity-replay' },
          metadata: {
            taskId: 'capacity-replay-task',
            taskName: 'create_media_buy',
            agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
            responseTimeMs: 1,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'completed',
          },
        },
      };
    };
    const first = executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'capacity-first' },
      undefined,
      {},
      'v3',
      undefined,
      hook
    );
    await firstClaimStarted;

    await assert.rejects(
      executor.executeTask(
        AGENT,
        'create_media_buy',
        { idempotency_key: 'capacity-second' },
        undefined,
        {},
        'v3',
        undefined,
        hook
      ),
      error =>
        error?.name === 'BeforeProtocolDispatchHookError' && /capacity is exhausted/i.test(error.original?.message)
    );
    assert.equal(hookCalls, 1);
    releaseFirstClaim();
    assert.equal((await first).status, 'completed');
    assert.equal(executor.settlementCapacityReservations.size, 0);
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
  });

  test('settled duplicate fences do not consume live mutation capacity', async () => {
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    for (let index = 0; index < 10_000; index += 1) {
      const taskId = `settled-fence-${index}`;
      executor.deferredTerminalPublicationTaskIds.add(taskId);
      executor.closedExternalTaskSettlementTaskIds.add(taskId);
    }
    ProtocolClient.callTool = mock.fn(async () => assert.fail('replay must not dispatch'));

    const result = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'capacity-after-settlement' },
      undefined,
      {},
      'v3',
      undefined,
      async () => ({
        action: 'return',
        result: {
          success: true,
          status: 'completed',
          data: { media_buy_id: 'replayed-buy' },
          metadata: {
            taskId: 'replayed-capacity-task',
            taskName: 'create_media_buy',
            agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
            responseTimeMs: 0,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'completed',
          },
        },
      })
    );

    assert.equal(result.status, 'completed', result.error);
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
  });

  test('acknowledges an immediate webhook before the seller response registers settlement', async () => {
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    let queued;
    let settlements = 0;
    ProtocolClient.callTool = mock.fn(async (_agent, _taskName, _params, options) => {
      queued = await executor.observeExternalTaskStatus(
        options.transportActivityContext.operationId,
        'completed',
        { media_buy_id: 'immediate-webhook-buy' },
        { serverTaskId: 'immediate-seller-task', taskType: 'create_media_buy' }
      );
      return { status: 'submitted', task_id: 'immediate-seller-task' };
    });

    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'immediate-webhook-race' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async observation => {
            settlements += 1;
            assert.equal(observation.serverTaskId, 'immediate-seller-task');
            return {
              success: true,
              status: 'completed',
              data: observation.result,
              metadata: { ...result.metadata, status: 'completed' },
            };
          });
          return result;
        },
      })
    );

    assert.equal(pending.status, 'submitted');
    assert.deepEqual(queued, { settled: false, queued: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settlements, 1);
  });

  test('expires unresolved durable settlement handlers from the capacity-accounted claim slot', async () => {
    for (const invalidRetention of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(
        () => new TaskExecutor({ externalTaskSettlementRetentionMs: invalidRetention }),
        /positive safe integer/
      );
    }
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'submitted', task_id: 'expiring-seller-task' }));
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      externalTaskSettlementRetentionMs: 10,
    });
    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'expiring-settlement-handler' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async () => result);
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );

    assert.equal(pending.status, 'submitted');
    assert.equal(executor.deferredTerminalPublicationTaskIds.size, 1);
    assert.equal(executor.externalTaskSettlementHandlers.size, 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(executor.deferredTerminalPublicationTaskIds.size, 0);
    assert.equal(executor.externalTaskSettlementHandlers.size, 0);
    assert.equal(executor.externalTaskSettlementExpiry.size, 0);
  });

  test('fences a committed claim without dispatch when the caller deadline fires while claim is pending', async () => {
    let releaseClaim;
    const claimRelease = new Promise(resolve => {
      releaseClaim = resolve;
    });
    let markClaimStarted;
    const claimStarted = new Promise(resolve => {
      markClaimStarted = resolve;
    });
    let markFenced;
    const fenced = new Promise(resolve => {
      markFenced = resolve;
    });
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'completed', data: {} }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const observedStatuses = [];
    executor.onTaskUpdate(AGENT.id, task => observedStatuses.push(task.status));
    const execution = executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'claim-abort' },
      undefined,
      { timeout: 10 },
      'v3',
      undefined,
      async () => {
        markClaimStarted();
        await claimRelease;
        return {
          action: 'dispatch_committed',
          onResult: async result => result,
          onError: async error => {
            assert.equal(
              observedStatuses.some(status =>
                ['completed', 'failed', 'rejected', 'canceled', 'aborted'].includes(status)
              ),
              false
            );
            markFenced(error);
            throw error;
          },
        };
      }
    );
    await claimStarted;
    await assert.rejects(execution, error => error?.name === 'TaskTimeoutError');
    releaseClaim();

    const fenceError = await fenced;
    assert.equal(fenceError.name, 'TaskTimeoutError');
    assert.equal(ProtocolClient.callTool.mock.callCount(), 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observedStatuses.includes('aborted'), false);
    assert.equal(observedStatuses.at(-1), 'failed');
  });

  test('dispatches the request snapshot validated before an awaited durable claim', async () => {
    let releaseClaim;
    const claimRelease = new Promise(resolve => {
      releaseClaim = resolve;
    });
    let markClaimStarted;
    const claimStarted = new Promise(resolve => {
      markClaimStarted = resolve;
    });
    let dispatchedParams;
    ProtocolClient.callTool = mock.fn(async (_agent, _taskName, params) => {
      dispatchedParams = params;
      return { status: 'completed', data: { media_buy_id: 'buy-snapshot' } };
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const request = {
      account: { account_id: 'account-original' },
      brand: { domain: 'original.example' },
      packages: [{ product_id: 'product-original', targeting: { geo_countries: ['US'] } }],
    };

    const execution = executor.executeTask(
      AGENT,
      'create_media_buy',
      request,
      undefined,
      {},
      'v3',
      undefined,
      async params => {
        assert.equal(params.account.account_id, 'account-original');
        markClaimStarted();
        await claimRelease;
        assert.equal(params.brand.domain, 'original.example');
        assert.deepEqual(params.packages[0].targeting.geo_countries, ['US']);
        return { action: 'dispatch_committed' };
      }
    );
    await claimStarted;
    request.account.account_id = 'account-mutated';
    request.brand.domain = 'mutated.example';
    request.packages[0].targeting.geo_countries[0] = 'GB';
    releaseClaim();

    const result = await execution;
    assert.equal(result.status, 'completed');
    assert.equal(dispatchedParams.account.account_id, 'account-original');
    assert.equal(dispatchedParams.brand.domain, 'original.example');
    assert.deepEqual(dispatchedParams.packages[0].targeting.geo_countries, ['US']);
  });

  test('snapshots direct-executor transport policy before an awaited pre-dispatch boundary', async () => {
    let releaseActivity;
    const activityRelease = new Promise(resolve => {
      releaseActivity = resolve;
    });
    let markActivityStarted;
    const activityStarted = new Promise(resolve => {
      markActivityStarted = resolve;
    });
    let dispatchedOptions;
    ProtocolClient.callTool = mock.fn(async (_agent, _taskName, _params, options) => {
      dispatchedOptions = options;
      return { status: 'completed', data: { media_buy_id: 'buy-transport-snapshot' } };
    });
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      onActivity: async activity => {
        if (activity.type !== 'protocol_request') return;
        markActivityStarted();
        await activityRelease;
      },
    });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const options = {
      transport: {
        allowPrivateIp: false,
        maxResponseBytes: 1024,
        requestTimeoutMs: 5000,
        trustedFetchFn,
      },
      metadata: { admission: { policy: 'original' } },
    };

    const execution = executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'transport-snapshot' },
      undefined,
      options
    );
    await activityStarted;
    options.transport.allowPrivateIp = true;
    options.transport.maxResponseBytes = 999_999_999;
    options.transport.requestTimeoutMs = 1;
    options.transport.trustedFetchFn = mutatedFetchFn;
    options.metadata.admission.policy = 'mutated';
    releaseActivity();

    const result = await execution;
    assert.equal(result.status, 'completed');
    assert.equal(dispatchedOptions.transport.allowPrivateIp, false);
    assert.equal(dispatchedOptions.transport.maxResponseBytes, 1024);
    assert.equal(dispatchedOptions.transport.requestTimeoutMs, 5000);
    assert.equal(dispatchedOptions.transport.trustedFetchFn, trustedFetchFn);
  });

  test('snapshots the direct-executor configured transport before an awaited pre-dispatch boundary', async () => {
    let releaseActivity;
    const activityRelease = new Promise(resolve => {
      releaseActivity = resolve;
    });
    let markActivityStarted;
    const activityStarted = new Promise(resolve => {
      markActivityStarted = resolve;
    });
    let dispatchedOptions;
    ProtocolClient.callTool = mock.fn(async (_agent, _taskName, _params, options) => {
      dispatchedOptions = options;
      return { status: 'completed', data: { media_buy_id: 'buy-config-transport-snapshot' } };
    });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const configuredTransport = {
      allowPrivateIp: false,
      maxResponseBytes: 2048,
      requestTimeoutMs: 4000,
      trustedFetchFn,
    };
    const config = {
      strictSchemaValidation: false,
      transport: configuredTransport,
      onActivity: async activity => {
        if (activity.type !== 'protocol_request') return;
        markActivityStarted();
        await activityRelease;
      },
    };
    const executor = new TaskExecutor(config);

    const execution = executor.executeTask(AGENT, 'create_media_buy', {
      idempotency_key: 'configured-transport-snapshot',
    });
    await activityStarted;
    configuredTransport.allowPrivateIp = true;
    configuredTransport.maxResponseBytes = 999_999_999;
    configuredTransport.requestTimeoutMs = 1;
    configuredTransport.trustedFetchFn = mutatedFetchFn;
    releaseActivity();

    assert.equal((await execution).status, 'completed');
    assert.notStrictEqual(dispatchedOptions.transport, configuredTransport);
    assert.equal(dispatchedOptions.transport.allowPrivateIp, false);
    assert.equal(dispatchedOptions.transport.maxResponseBytes, 2048);
    assert.equal(dispatchedOptions.transport.requestTimeoutMs, 4000);
    assert.equal(dispatchedOptions.transport.trustedFetchFn, trustedFetchFn);
  });

  test('SingleAgentClient owns its configured transport before handing it to TaskExecutor', async () => {
    let releaseActivity;
    const activityRelease = new Promise(resolve => {
      releaseActivity = resolve;
    });
    let markActivityStarted;
    const activityStarted = new Promise(resolve => {
      markActivityStarted = resolve;
    });
    let dispatchedOptions;
    ProtocolClient.callTool = mock.fn(async (_agent, _taskName, _params, options) => {
      dispatchedOptions = options;
      return { status: 'completed', data: { media_buy_id: 'buy-client-config-transport-snapshot' } };
    });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const configuredTransport = {
      allowPrivateIp: false,
      maxResponseBytes: 3072,
      requestTimeoutMs: 3000,
      trustedFetchFn,
    };
    const client = new SingleAgentClient(AGENT, {
      transport: configuredTransport,
      validation: { requests: 'off', responses: 'off' },
      onActivity: async activity => {
        if (activity.type !== 'protocol_request') return;
        markActivityStarted();
        await activityRelease;
      },
    });

    // Mutate the caller's config after construction but before operation
    // admission. The client must already own the original trust policy.
    configuredTransport.allowPrivateIp = true;
    configuredTransport.maxResponseBytes = 999_999_999;
    configuredTransport.requestTimeoutMs = 1;
    configuredTransport.trustedFetchFn = mutatedFetchFn;
    const execution = client.executor.executeTask(AGENT, 'create_media_buy', {
      idempotency_key: 'client-configured-transport-snapshot',
    });
    await activityStarted;
    releaseActivity();

    assert.equal((await execution).status, 'completed');
    assert.notStrictEqual(dispatchedOptions.transport, configuredTransport);
    assert.equal(dispatchedOptions.transport.allowPrivateIp, false);
    assert.equal(dispatchedOptions.transport.maxResponseBytes, 3072);
    assert.equal(dispatchedOptions.transport.requestTimeoutMs, 3000);
    assert.equal(dispatchedOptions.transport.trustedFetchFn, trustedFetchFn);
  });

  test('snapshots direct task-status transport policy before the status lookup yields', async () => {
    let releaseLookup;
    const lookupRelease = new Promise(resolve => {
      releaseLookup = resolve;
    });
    let markLookupStarted;
    const lookupStarted = new Promise(resolve => {
      markLookupStarted = resolve;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const transport = {
      allowPrivateIp: false,
      maxResponseBytes: 1024,
      requestTimeoutMs: 5000,
      trustedFetchFn,
    };
    const signal = new AbortController().signal;
    let observedTransport;
    let observedSignal;
    executor.getTaskStatusWithRawResponse = async (_agent, taskId, lookupTransport, lookupSignal) => {
      observedTransport = lookupTransport;
      observedSignal = lookupSignal;
      markLookupStarted();
      await lookupRelease;
      return {
        task: {
          taskId,
          taskType: 'create_media_buy',
          status: 'working',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        rawResponse: {},
      };
    };

    const lookup = executor.getTaskStatus(AGENT, 'seller-status-snapshot', transport, signal);
    await lookupStarted;
    transport.allowPrivateIp = true;
    transport.maxResponseBytes = 999_999_999;
    transport.requestTimeoutMs = 1;
    transport.trustedFetchFn = mutatedFetchFn;
    releaseLookup();

    assert.equal((await lookup).taskId, 'seller-status-snapshot');
    assert.notStrictEqual(observedTransport, transport);
    assert.equal(observedTransport.allowPrivateIp, false);
    assert.equal(observedTransport.maxResponseBytes, 1024);
    assert.equal(observedTransport.requestTimeoutMs, 5000);
    assert.equal(observedTransport.trustedFetchFn, trustedFetchFn);
    assert.strictEqual(observedSignal, signal);
  });

  test('snapshots direct task-list transport policy before the remote lookup yields', async () => {
    let releaseLookup;
    const lookupRelease = new Promise(resolve => {
      releaseLookup = resolve;
    });
    let markLookupStarted;
    const lookupStarted = new Promise(resolve => {
      markLookupStarted = resolve;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const transport = {
      allowPrivateIp: false,
      maxResponseBytes: 1536,
      requestTimeoutMs: 4500,
      trustedFetchFn,
    };
    let observedTransport;
    executor.listTasksForAgent = async (_agent, lookupTransport) => {
      observedTransport = lookupTransport;
      markLookupStarted();
      await lookupRelease;
      return [];
    };

    const lookup = executor.listTasks(AGENT, transport);
    await lookupStarted;
    transport.allowPrivateIp = true;
    transport.maxResponseBytes = 999_999_999;
    transport.requestTimeoutMs = 1;
    transport.trustedFetchFn = mutatedFetchFn;
    releaseLookup();

    assert.deepEqual(await lookup, []);
    assert.notStrictEqual(observedTransport, transport);
    assert.equal(observedTransport.allowPrivateIp, false);
    assert.equal(observedTransport.maxResponseBytes, 1536);
    assert.equal(observedTransport.requestTimeoutMs, 4500);
    assert.equal(observedTransport.trustedFetchFn, trustedFetchFn);
  });

  test('reuses one transport snapshot across direct polling iterations', async () => {
    let releaseFirstPoll;
    const firstPollRelease = new Promise(resolve => {
      releaseFirstPoll = resolve;
    });
    let markFirstPollStarted;
    const firstPollStarted = new Promise(resolve => {
      markFirstPollStarted = resolve;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const transport = {
      allowPrivateIp: false,
      maxResponseBytes: 2048,
      requestTimeoutMs: 4000,
      trustedFetchFn,
    };
    const observedTransports = [];
    let polls = 0;
    executor.getTaskStatusWithRawResponse = async (_agent, taskId, pollTransport) => {
      observedTransports.push(pollTransport);
      polls += 1;
      if (polls === 1) {
        markFirstPollStarted();
        await firstPollRelease;
        return {
          task: {
            taskId,
            taskType: 'create_media_buy',
            status: 'working',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          rawResponse: {},
        };
      }
      return {
        task: {
          taskId,
          taskType: 'create_media_buy',
          status: 'completed',
          result: { media_buy_id: 'poll-transport-snapshot' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        rawResponse: {},
      };
    };

    const completion = executor.pollTaskCompletion(
      AGENT,
      'seller-poll-snapshot',
      0,
      transport,
      undefined,
      undefined,
      'create_media_buy'
    );
    await firstPollStarted;
    transport.allowPrivateIp = true;
    transport.maxResponseBytes = 999_999_999;
    transport.requestTimeoutMs = 1;
    transport.trustedFetchFn = mutatedFetchFn;
    releaseFirstPoll();

    assert.equal((await completion).status, 'completed');
    assert.equal(observedTransports.length, 2);
    assert.strictEqual(observedTransports[0], observedTransports[1]);
    assert.notStrictEqual(observedTransports[0], transport);
    assert.equal(observedTransports[0].allowPrivateIp, false);
    assert.equal(observedTransports[0].maxResponseBytes, 2048);
    assert.equal(observedTransports[0].requestTimeoutMs, 4000);
    assert.equal(observedTransports[0].trustedFetchFn, trustedFetchFn);
  });

  test('snapshots a submitted track transport override before its lookup yields', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({
      status: 'submitted',
      task_id: 'seller-track-snapshot',
    }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'submitted-track-transport-snapshot' },
      undefined,
      {}
    );
    assert.equal(pending.status, 'submitted');

    let releaseLookup;
    const lookupRelease = new Promise(resolve => {
      releaseLookup = resolve;
    });
    let markLookupStarted;
    const lookupStarted = new Promise(resolve => {
      markLookupStarted = resolve;
    });
    const trustedFetchFn = async () => new Response();
    const mutatedFetchFn = async () => new Response();
    const transport = {
      allowPrivateIp: false,
      maxResponseBytes: 4096,
      requestTimeoutMs: 3000,
      trustedFetchFn,
    };
    let observedTransport;
    executor.getTaskStatusWithRawResponse = async (_agent, taskId, lookupTransport) => {
      observedTransport = lookupTransport;
      markLookupStarted();
      await lookupRelease;
      return {
        task: {
          taskId,
          taskType: 'create_media_buy',
          status: 'working',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        rawResponse: {},
      };
    };

    const lookup = pending.submitted.track(transport);
    await lookupStarted;
    transport.allowPrivateIp = true;
    transport.maxResponseBytes = 999_999_999;
    transport.requestTimeoutMs = 1;
    transport.trustedFetchFn = mutatedFetchFn;
    releaseLookup();

    assert.equal((await lookup).taskId, 'seller-track-snapshot');
    assert.notStrictEqual(observedTransport, transport);
    assert.equal(observedTransport.allowPrivateIp, false);
    assert.equal(observedTransport.maxResponseBytes, 4096);
    assert.equal(observedTransport.requestTimeoutMs, 3000);
    assert.equal(observedTransport.trustedFetchFn, trustedFetchFn);
  });

  test('runs the committed error settlement exactly once when seller dispatch throws', async () => {
    const transportError = new Error('seller transport failed after dispatch');
    const durableError = new Error('durable outcome fenced with secret-db-token');
    ProtocolClient.callTool = mock.fn(async () => {
      throw transportError;
    });
    const activities = [];
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      onActivity: activity => activities.push(activity),
    });
    let errorSettlements = 0;
    let resultSettlements = 0;
    const observedErrors = [];
    executor.onTaskUpdate(AGENT.id, task => {
      if (task.error) observedErrors.push(task.error);
    });

    await assert.rejects(
      executor.executeTask(
        AGENT,
        'create_media_buy',
        { idempotency_key: 'post-dispatch-error' },
        undefined,
        {},
        'v3',
        undefined,
        async () => ({
          action: 'dispatch_committed',
          onResult: async result => {
            resultSettlements += 1;
            return result;
          },
          onError: async error => {
            errorSettlements += 1;
            assert.equal(error, transportError);
            throw durableError;
          },
        })
      ),
      error => error?.name === 'AfterProtocolDispatchHookError' && error.original === durableError
    );

    assert.equal(ProtocolClient.callTool.mock.callCount(), 1);
    assert.equal(errorSettlements, 1);
    assert.equal(resultSettlements, 0);
    assert.equal(observedErrors.at(-1), 'An SDK post-dispatch settlement hook failed.');
    assert.doesNotMatch(JSON.stringify(activities), /secret-db-token/);
    assert.doesNotMatch(JSON.stringify(executor.getActiveTasks()), /secret-db-token/);
  });

  test('publishes terminal completion only after durable result settlement succeeds', async () => {
    const durableError = new Error('durable completion persistence failed');
    ProtocolClient.callTool = mock.fn(async () => ({
      status: 'completed',
      data: { media_buy_id: 'seller-created-buy' },
    }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const observedStatuses = [];
    const observedErrors = [];
    executor.onTaskUpdate(AGENT.id, task => {
      observedStatuses.push(task.status);
      if (task.error) observedErrors.push(task.error);
    });

    await assert.rejects(
      executor.executeTask(
        AGENT,
        'create_media_buy',
        { idempotency_key: 'post-dispatch-settlement-order' },
        undefined,
        {},
        'v3',
        undefined,
        async () => ({
          action: 'dispatch_committed',
          onResult: async () => {
            assert.equal(observedStatuses.includes('completed'), false);
            throw durableError;
          },
          onError: async error => {
            throw error;
          },
        })
      ),
      error => error?.name === 'AfterProtocolDispatchHookError' && error.original === durableError
    );

    assert.equal(observedStatuses.includes('completed'), false);
    assert.equal(observedStatuses.at(-1), 'failed');
    assert.equal(observedErrors.at(-1), 'An SDK post-dispatch settlement hook failed.');
    const retained = executor.getActiveTasks();
    assert.equal(retained[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(retained[0]), /durable completion persistence failed/);
    assert.equal(retained[0].params, undefined);
  });

  for (const observation of ['track', 'waitForCompletion']) {
    test(`does not publish submitted ${observation} completion when durable persistence fails`, async () => {
      const durableError = new Error(`durable ${observation} persistence failed`);
      ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
        if (taskName === 'tasks/get' || taskName === 'tasks_get') {
          return {
            task: {
              taskId: 'seller-created-task',
              status: 'completed',
              taskType: 'create_media_buy',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              result: { media_buy_id: 'seller-created-buy' },
            },
          };
        }
        return { status: 'submitted', task_id: 'seller-created-task' };
      });
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const observedStatuses = [];
      executor.onTaskUpdate(AGENT.id, task => observedStatuses.push(task.status));

      const pending = await executor.executeTask(
        AGENT,
        'create_media_buy',
        { idempotency_key: `submitted-${observation}-settlement-order` },
        undefined,
        {},
        'v3',
        undefined,
        async () => ({
          action: 'dispatch_committed',
          onResult: async result => {
            const submitted = result.submitted;
            result.submitted = {
              ...submitted,
              track: async transport => {
                await submitted.track(transport);
                assert.equal(observedStatuses.includes('completed'), false);
                throw durableError;
              },
              waitForCompletion: async (pollInterval, signal) => {
                const completion = await submitted.waitForCompletion(pollInterval, signal);
                assert.equal(completion.status, 'completed');
                assert.equal(observedStatuses.includes('completed'), false);
                throw durableError;
              },
            };
            return result;
          },
          onError: async error => {
            throw error;
          },
        })
      );

      await assert.rejects(
        observation === 'track' ? pending.submitted.track() : pending.submitted.waitForCompletion(0),
        error => error === durableError
      );
      assert.equal(observedStatuses.includes('completed'), false);
      assert.equal(executor.getActiveTasks()[0].status, 'submitted');
    });
  }

  test('closes durable webhook settlement after polling completes first', async () => {
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks/get' || taskName === 'tasks_get') {
        return {
          task: {
            taskId: 'poll-first-seller-task',
            status: 'completed',
            taskType: 'create_media_buy',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: { media_buy_id: 'poll-first-buy' },
          },
        };
      }
      return { status: 'submitted', task_id: 'poll-first-seller-task' };
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    let webhookSettlements = 0;
    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'poll-first-settlement' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async () => {
            webhookSettlements += 1;
            return result;
          });
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );

    const completed = await pending.submitted.waitForCompletion(0);
    assert.equal(completed.status, 'completed');
    const duplicate = await executor.observeExternalTaskStatus(
      pending.metadata.taskId,
      'completed',
      { media_buy_id: 'poll-first-buy' },
      { serverTaskId: 'poll-first-seller-task', taskType: 'create_media_buy' }
    );
    assert.equal(duplicate.settled, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(webhookSettlements, 0);
  });

  test('rejects an in-flight webhook when polling closes the durable route first', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({
      status: 'submitted',
      task_id: 'poll-race-seller-task',
    }));
    let markWebhookSettlementStarted;
    const webhookSettlementStarted = new Promise(resolve => {
      markWebhookSettlementStarted = resolve;
    });
    let releaseWebhookSettlement;
    const webhookSettlementRelease = new Promise(resolve => {
      releaseWebhookSettlement = resolve;
    });
    let publishPollCompletion;
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    let terminalEvent;
    executor.onTaskUpdate(AGENT.id, task => {
      if (task.status === 'completed') terminalEvent = task;
    });
    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'poll-first-racing-webhook' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => {
        publishPollCompletion = context.publishSettledTaskStatus;
        return {
          action: 'dispatch_committed',
          onResult: async result => {
            context.registerExternalTaskSettlement(async () => {
              markWebhookSettlementStarted();
              await webhookSettlementRelease;
              return {
                success: true,
                status: 'completed',
                data: { media_buy_id: 'webhook-race-loser' },
                metadata: { ...result.metadata, status: 'completed' },
              };
            });
            return result;
          },
          onError: async error => {
            throw error;
          },
        };
      }
    );

    const webhook = executor.observeExternalTaskStatus(
      pending.metadata.taskId,
      'completed',
      { media_buy_id: 'webhook-race-loser' },
      { serverTaskId: 'poll-race-seller-task', taskType: 'create_media_buy' }
    );
    await webhookSettlementStarted;
    publishPollCompletion('completed', { media_buy_id: 'poll-race-winner' });
    releaseWebhookSettlement();

    await assert.rejects(webhook, /settled through its direct response/);
    assert.equal(executor.settledExternalTaskObservationKeys.has(pending.metadata.taskId), false);
    assert.equal(terminalEvent.result.media_buy_id, 'poll-race-winner');
  });

  test('does not publish deferred completion when durable persistence fails', async () => {
    const pauseAgent = { ...AGENT, protocol: 'a2a' };
    const durableError = new Error('durable deferred persistence failed');
    const deferredRecords = new Map();
    let createCalls = 0;
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'create_media_buy' && ++createCalls > 1) {
        return {
          status: 'completed',
          task_id: 'legacy-create-seller-work',
          data: { media_buy_id: 'seller-created-buy' },
        };
      }
      return a2aPause({
        question: 'Approve the legacy purchase?',
        field: 'approval',
        contextId: 'legacy-create-context',
        taskId: 'legacy-create-seller-task',
        serverTaskId: 'legacy-create-seller-work',
      });
    });
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      deferredStorage: deferredStorage(deferredRecords),
    });
    const observedStatuses = [];
    executor.onTaskUpdate(pauseAgent.id, task => observedStatuses.push(task.status));

    const pending = await executor.executeTask(
      pauseAgent,
      'create_media_buy',
      { idempotency_key: 'deferred-settlement-order' },
      async () => ({ defer: true, token: testDurableToken('legacy-create-deferred-token') }),
      {},
      'v3',
      undefined,
      async () => ({
        action: 'dispatch_committed',
        onResult: async result => {
          const deferred = result.deferred;
          result.deferred = {
            ...deferred,
            resume: async input => {
              const completion = await deferred.resume(input);
              assert.equal(completion.status, 'completed');
              assert.equal(observedStatuses.includes('completed'), false);
              throw durableError;
            },
          };
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );

    await assert.rejects(pending.deferred.resume({ approved: true }), error => error === durableError);
    assert.equal(observedStatuses.includes('completed'), false);
    assert.equal(executor.getActiveTasks()[0].status, 'deferred');
  });

  test('SingleAgentClient preserves committed-settlement wrappers on a live durable resume closure', async () => {
    const pauseAgent = { ...AGENT, protocol: 'a2a', agent_uri: 'https://seller.example/a2a' };
    const records = new Map();
    let createCalls = 0;
    let settlementCompletions = 0;
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      assert.equal(taskName, 'create_media_buy');
      createCalls += 1;
      if (createCalls === 1) {
        return a2aPause({
          question: 'Approve the committed purchase?',
          field: 'approval',
          contextId: 'committed-resume-context',
          taskId: 'committed-resume-task',
          serverTaskId: 'committed-resume-work',
        });
      }
      return {
        status: 'completed',
        task_id: 'committed-resume-work',
        data: { media_buy_id: 'committed-resumed-buy', packages: [] },
      };
    });
    const client = new SingleAgentClient(pauseAgent, {
      deferredStorage: deferredStorage(records),
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureEndpointDiscovered = async () => pauseAgent;
    client.detectServerVersion = async () => 'v3';
    client.getEarlyResultForUnsupportedFeatures = async () => null;
    const paused = await client.createMediaBuyLegacyWithPreDispatch(
      {
        idempotency_key: 'committed-resume-wrapper-key',
        account: { account_id: 'account-1' },
        brand: { domain: 'buyer.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        packages: [],
      },
      async () => ({
        action: 'dispatch_committed',
        onResult: async result => {
          const deferred = result.deferred;
          if (deferred) {
            result.deferred = {
              ...deferred,
              resume: async input => {
                const completion = await deferred.resume(input);
                settlementCompletions += 1;
                return completion;
              },
            };
          }
          return result;
        },
        onError: async error => {
          throw error;
        },
      }),
      async () => ({ defer: true, token: testDurableToken('committed-resume-wrapper-token') })
    );

    assert.equal(paused.status, 'deferred', paused.error);
    assert.equal(
      records.get(paused.deferred.token).settlementOperationId,
      paused.metadata.taskId,
      'committed pauses must persist the trusted durable settlement route'
    );
    assert.equal(records.get(paused.deferred.token).settlementServerTaskId, paused.metadata.serverTaskId);
    const completed = await paused.deferred.resume({ approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(settlementCompletions, 1);
    assert.equal(createCalls, 2);
  });

  test('publishes deferred-to-submitted completion only after recursive durable settlement', async () => {
    const pauseAgent = { ...AGENT, protocol: 'a2a' };
    const deferredRecords = new Map();
    let markPersistenceStarted;
    const persistenceStarted = new Promise(resolve => {
      markPersistenceStarted = resolve;
    });
    let releasePersistence;
    const persistenceRelease = new Promise(resolve => {
      releasePersistence = resolve;
    });
    let createCalls = 0;
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'create_media_buy' && ++createCalls > 1) {
        return { status: 'submitted', task_id: 'resumed-seller-task' };
      }
      if (taskName === 'tasks/get' || taskName === 'tasks_get') {
        return {
          task: {
            taskId: 'resumed-seller-task',
            status: 'completed',
            taskType: 'create_media_buy',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: { media_buy_id: 'seller-created-buy' },
          },
        };
      }
      return a2aPause({
        question: 'Approve the legacy purchase?',
        field: 'approval',
        contextId: 'legacy-create-context',
        taskId: 'legacy-create-seller-task',
        serverTaskId: 'resumed-seller-task',
      });
    });
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      deferredStorage: deferredStorage(deferredRecords),
    });
    const observedStatuses = [];
    executor.onTaskUpdate(pauseAgent.id, task => observedStatuses.push(task.status));

    const settleRecursively = result => {
      if (result.deferred) {
        const deferred = result.deferred;
        result.deferred = {
          ...deferred,
          resume: async input => settleRecursively(await deferred.resume(input)),
        };
      }
      if (result.submitted) {
        const submitted = result.submitted;
        result.submitted = {
          ...submitted,
          waitForCompletion: async (pollInterval, signal) => {
            const completion = await submitted.waitForCompletion(pollInterval, signal);
            markPersistenceStarted();
            await persistenceRelease;
            return completion;
          },
        };
      }
      return result;
    };

    const deferred = await executor.executeTask(
      pauseAgent,
      'create_media_buy',
      { idempotency_key: 'deferred-submitted-settlement-order' },
      async () => ({ defer: true, token: testDurableToken('legacy-create-deferred-submitted-token') }),
      {},
      'v3',
      undefined,
      async () => ({
        action: 'dispatch_committed',
        onResult: async result => settleRecursively(result),
        onError: async error => {
          throw error;
        },
      })
    );

    const submitted = await deferred.deferred.resume({ approved: true });
    assert.equal(submitted.status, 'submitted');
    const completionPromise = submitted.submitted.waitForCompletion(0);
    await persistenceStarted;
    assert.equal(observedStatuses.includes('completed'), false);
    releasePersistence();
    const completion = await completionPromise;
    assert.equal(completion.status, 'completed');
    assert.equal(observedStatuses.at(-1), 'completed');
  });

  test('live committed deferred-to-submitted track composes after the raw terminal checkpoint', async () => {
    const pauseAgent = { ...AGENT, protocol: 'a2a' };
    const deferredRecords = new Map();
    let createCalls = 0;
    let settlementTrackCalls = 0;
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'create_media_buy' && ++createCalls > 1) {
        return { status: 'submitted', task_id: 'live-track-seller-task' };
      }
      if (taskName === 'tasks/get' || taskName === 'tasks_get') {
        return {
          task: {
            taskId: 'live-track-seller-task',
            status: 'completed',
            taskType: 'create_media_buy',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: { media_buy_id: 'live-track-buy', packages: [] },
          },
        };
      }
      return a2aPause({
        question: 'Approve the tracked legacy purchase?',
        field: 'approval',
        contextId: 'live-track-context',
        taskId: 'live-track-a2a-task',
        serverTaskId: 'live-track-seller-task',
      });
    });
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      deferredStorage: deferredStorage(deferredRecords),
    });
    const wrapSettlementOwner = result => {
      if (result.deferred) {
        const deferred = result.deferred;
        result.deferred = {
          ...deferred,
          resume: async input => wrapSettlementOwner(await deferred.resume(input)),
        };
      }
      if (result.submitted) {
        const submitted = result.submitted;
        result.submitted = {
          ...submitted,
          track: async transport => {
            const task = await submitted.track(transport);
            settlementTrackCalls += 1;
            return task;
          },
        };
      }
      return result;
    };

    const paused = await executor.executeTask(
      pauseAgent,
      'create_media_buy',
      { idempotency_key: 'live-track-checkpoint-order' },
      async () => ({ defer: true, token: testDurableToken('live-track-checkpoint-token') }),
      {},
      'v3',
      undefined,
      async () => ({
        action: 'dispatch_committed',
        onResult: async result => wrapSettlementOwner(result),
        onError: async error => {
          throw error;
        },
      })
    );

    const submitted = await paused.deferred.resume({ approved: true });
    assert.equal(submitted.status, 'submitted');
    const task = await submitted.submitted.track();
    assert.equal(task.status, 'completed');
    assert.equal(task.result.media_buy_id, 'live-track-buy');
    assert.equal(settlementTrackCalls, 1);
    const checkpoint = deferredRecords.get(testDurableToken('live-track-checkpoint-token'));
    assert.equal(checkpoint.settlementTerminalResult.data.media_buy_id, 'live-track-buy');
    assert.equal(checkpoint.settlementFinalizedResult, undefined);
    assert.equal(checkpoint.settlementFinalizationLease, undefined);
  });

  test('does not publish a submitted webhook completion when durable settlement fails', async () => {
    const durableError = new Error('webhook completion persistence failed');
    let markSettlementStarted;
    const settlementStarted = new Promise(resolve => {
      markSettlementStarted = resolve;
    });
    let releaseSettlement;
    const settlementRelease = new Promise(resolve => {
      releaseSettlement = resolve;
    });
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'submitted', task_id: 'webhook-seller-task' }));
    const webhookActivities = [];
    const handlerResults = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      onActivity: activity => {
        if (activity.type === 'webhook_received') webhookActivities.push(activity);
      },
      handlers: {
        onCreateMediaBuyStatusChange: response => handlerResults.push(response),
      },
    });
    const observedStatuses = [];
    client.onTaskUpdate(task => observedStatuses.push(task.status));

    const pending = await client.executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'submitted-webhook-settlement-order' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async observation => {
            assert.equal(observation.serverTaskId, 'webhook-seller-task');
            assert.equal(observation.taskType, 'create_media_buy');
            markSettlementStarted();
            await settlementRelease;
            throw durableError;
          });
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );

    const webhook = client.handleWebhook(
      {
        idempotency_key: 'submitted-webhook-event-0001',
        operation_id: pending.metadata.taskId,
        task_id: 'webhook-seller-task',
        task_type: 'create_media_buy',
        status: 'completed',
        timestamp: '2026-08-21T12:00:00.000Z',
        result: { media_buy_id: 'unsettled-webhook-buy' },
      },
      'create_media_buy',
      pending.metadata.taskId
    );
    await settlementStarted;
    assert.equal(observedStatuses.includes('completed'), false);
    assert.deepEqual(webhookActivities, []);
    assert.deepEqual(handlerResults, []);

    releaseSettlement();
    await assert.rejects(webhook, error => error === durableError);
    assert.equal(observedStatuses.includes('completed'), false);
    assert.deepEqual(webhookActivities, []);
    assert.deepEqual(handlerResults, []);
    assert.equal(client.getActiveTasks()[0].status, 'submitted');
  });

  test('bounds followers and retained error metadata while one durable webhook settlement is pending', async () => {
    let markSettlementStarted;
    const settlementStarted = new Promise(resolve => {
      markSettlementStarted = resolve;
    });
    let releaseSettlement;
    const settlementRelease = new Promise(resolve => {
      releaseSettlement = resolve;
    });
    const longError = 'E'.repeat(2_048);
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'submitted', task_id: 'bounded-seller-task' }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'bounded-webhook-followers' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async () => {
            markSettlementStarted();
            await settlementRelease;
            return {
              success: false,
              status: 'failed',
              error: longError,
              data: { errors: [{ code: 'INTERNAL_ERROR', message: 'Durable failure' }] },
              metadata: { ...result.metadata, status: 'failed' },
            };
          });
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );
    const observation = {
      status: 'completed',
      result: { media_buy_id: 'must-not-publish' },
      serverTaskId: 'bounded-seller-task',
      taskType: 'create_media_buy',
    };
    const leader = executor.observeExternalTaskStatus(pending.metadata.taskId, observation.status, observation.result, {
      serverTaskId: observation.serverTaskId,
      taskType: observation.taskType,
    });
    await settlementStarted;
    const followers = Array.from({ length: 7 }, () =>
      executor.observeExternalTaskStatus(pending.metadata.taskId, observation.status, observation.result, {
        serverTaskId: observation.serverTaskId,
        taskType: observation.taskType,
      })
    );
    await assert.rejects(
      executor.observeExternalTaskStatus(pending.metadata.taskId, observation.status, observation.result, {
        serverTaskId: observation.serverTaskId,
        taskType: observation.taskType,
      }),
      /Too many terminal push notifications/
    );
    releaseSettlement();
    const settled = await leader;
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error.length, 2_048);
    const duplicates = await Promise.all(followers);
    assert.equal(
      duplicates.every(result => result.duplicate && result.status === 'failed'),
      true
    );
    assert.equal(
      duplicates.every(result => result.error.length === 2_048),
      true
    );
    const retained = executor.settledExternalTaskObservationKeys.get(pending.metadata.taskId);
    assert.equal(retained.error.length, 1_024);
  });

  test('publishes the durably settled webhook result before invoking public handlers', async () => {
    let markSettlementStarted;
    const settlementStarted = new Promise(resolve => {
      markSettlementStarted = resolve;
    });
    let releaseSettlement;
    const settlementRelease = new Promise(resolve => {
      releaseSettlement = resolve;
    });
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'submitted', task_id: 'webhook-seller-task' }));
    const webhookActivities = [];
    const asyncHandlerActivities = [];
    const handlerResults = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      onActivity: activity => {
        if (activity.type === 'webhook_received') webhookActivities.push(activity);
      },
      handlers: {
        onActivity: activity => asyncHandlerActivities.push(activity),
        onCreateMediaBuyStatusChange: response => handlerResults.push(response),
      },
    });
    const observedStatuses = [];
    client.onTaskUpdate(task => observedStatuses.push(task.status));

    const pending = await client.executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'submitted-webhook-success-order' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async observation => {
            if (observation.serverTaskId !== 'webhook-seller-task') throw new Error('pushed task identity mismatch');
            markSettlementStarted();
            await settlementRelease;
            return {
              success: true,
              status: 'completed',
              data: { media_buy_id: 'durably-settled-buy' },
              metadata: { ...result.metadata, status: 'completed' },
            };
          });
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );

    const terminalWebhookPayload = {
      idempotency_key: 'submitted-webhook-event-0002',
      operation_id: pending.metadata.taskId,
      task_id: 'webhook-seller-task',
      task_type: 'create_media_buy',
      status: 'completed',
      timestamp: '2026-08-21T12:00:00.000Z',
      result: { media_buy_id: 'unsettled-webhook-buy' },
    };
    const webhook = client.handleWebhook(terminalWebhookPayload, 'create_media_buy', pending.metadata.taskId);
    await settlementStarted;
    assert.equal(observedStatuses.includes('completed'), false);
    assert.deepEqual(webhookActivities, []);
    assert.deepEqual(handlerResults, []);

    const concurrentDuplicate = client.handleWebhook(
      terminalWebhookPayload,
      'create_media_buy',
      pending.metadata.taskId
    );
    const concurrentConflict = client.handleWebhook(
      {
        ...terminalWebhookPayload,
        idempotency_key: 'submitted-webhook-event-conflict',
        result: { media_buy_id: 'conflicting-unsettled-buy' },
      },
      'create_media_buy',
      pending.metadata.taskId
    );

    releaseSettlement();
    assert.equal(await webhook, true);
    assert.equal(await concurrentDuplicate, true);
    await assert.rejects(concurrentConflict, /already completed durable settlement/);
    assert.equal(observedStatuses.at(-1), 'completed');
    assert.equal(webhookActivities.length, 1);
    assert.equal(webhookActivities[0].payload.media_buy_id, 'durably-settled-buy');
    assert.equal(
      asyncHandlerActivities.find(activity => activity.type === 'webhook_received').payload.media_buy_id,
      'durably-settled-buy'
    );
    assert.equal(asyncHandlerActivities.length, 2);
    assert.equal(asyncHandlerActivities.filter(activity => activity.type === 'webhook_duplicate').length, 1);
    assert.deepEqual(handlerResults, [{ media_buy_id: 'durably-settled-buy' }]);
    const acceptedObservation = client.executor.settledExternalTaskObservationKeys.get(pending.metadata.taskId);
    assert.match(acceptedObservation.key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(acceptedObservation).includes('unsettled-webhook-buy'), false);

    // The short task-inspection window may expire days before the trusted
    // webhook registration. Its canonical durable replay path must survive.
    client.executor.cleanupTerminalTaskInspectionState(pending.metadata.taskId);
    assert.equal(client.executor.deferredTerminalPublicationTaskIds.size, 1);
    assert.equal(
      await client.handleWebhook(
        {
          idempotency_key: 'submitted-webhook-event-0002',
          operation_id: pending.metadata.taskId,
          task_id: 'webhook-seller-task',
          task_type: 'create_media_buy',
          status: 'completed',
          timestamp: '2026-08-21T12:00:00.000Z',
          result: { media_buy_id: 'unsettled-webhook-buy' },
        },
        'create_media_buy',
        pending.metadata.taskId
      ),
      true
    );
    assert.equal(webhookActivities.length, 1);
    assert.equal(asyncHandlerActivities.length, 3);
    assert.equal(asyncHandlerActivities.at(-1).type, 'webhook_duplicate');
    assert.deepEqual(handlerResults, [{ media_buy_id: 'durably-settled-buy' }]);

    await assert.rejects(
      client.handleWebhook(
        {
          idempotency_key: 'submitted-webhook-event-0003',
          operation_id: pending.metadata.taskId,
          task_id: 'different-seller-task',
          task_type: 'create_media_buy',
          status: 'completed',
          timestamp: '2026-08-21T12:01:00.000Z',
          result: { media_buy_id: 'conflicting-late-buy' },
        },
        'create_media_buy',
        pending.metadata.taskId
      ),
      /already completed durable settlement/
    );
    assert.equal(webhookActivities.length, 1);
    assert.equal(asyncHandlerActivities.length, 3);
    assert.deepEqual(handlerResults, [{ media_buy_id: 'durably-settled-buy' }]);
  });

  test('normalizes webhook metadata to the durably settled terminal failure', async () => {
    ProtocolClient.callTool = mock.fn(async () => ({ status: 'submitted', task_id: 'failed-webhook-task' }));
    const topLevelActivities = [];
    const asyncActivities = [];
    const handlerCalls = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      onActivity: activity => {
        if (activity.type === 'webhook_received') topLevelActivities.push(activity);
      },
      handlers: {
        onActivity: activity => asyncActivities.push(activity),
        onCreateMediaBuyStatusChange: (response, metadata) => handlerCalls.push({ response, metadata }),
      },
    });
    const observedStatuses = [];
    client.onTaskUpdate(task => observedStatuses.push(task.status));
    const pending = await client.executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'submitted-webhook-failed-normalization' },
      undefined,
      {},
      'v3',
      undefined,
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async result => {
          context.registerExternalTaskSettlement(async () => ({
            success: false,
            status: 'governance-denied',
            error: 'Canonical durable governance denial',
            data: { errors: [{ code: 'INVALID_REQUEST', message: 'Rejected durably' }] },
            metadata: { ...result.metadata, status: 'governance-denied' },
          }));
          return result;
        },
        onError: async error => {
          throw error;
        },
      })
    );

    assert.equal(
      await client.handleWebhook(
        {
          idempotency_key: 'submitted-webhook-event-0004',
          operation_id: pending.metadata.taskId,
          task_id: 'failed-webhook-task',
          task_type: 'create_media_buy',
          status: 'completed',
          timestamp: '2026-08-21T12:02:00.000Z',
          result: { media_buy_id: 'must-not-be-published' },
        },
        'create_media_buy',
        pending.metadata.taskId
      ),
      true
    );
    assert.equal(observedStatuses.at(-1), 'governance-denied');
    assert.equal(topLevelActivities[0].status, 'governance-denied');
    assert.deepEqual(topLevelActivities[0].payload, {
      errors: [{ code: 'INVALID_REQUEST', message: 'Rejected durably' }],
    });
    assert.equal(asyncActivities[0].status, 'governance-denied');
    assert.deepEqual(asyncActivities[0].payload, topLevelActivities[0].payload);
    assert.equal(handlerCalls[0].metadata.status, 'governance-denied');
    assert.equal(handlerCalls[0].metadata.message, 'Canonical durable governance denial');
    assert.deepEqual(handlerCalls[0].response, topLevelActivities[0].payload);

    assert.equal(
      await client.handleWebhook(
        {
          idempotency_key: 'submitted-webhook-event-0004',
          operation_id: pending.metadata.taskId,
          task_id: 'failed-webhook-task',
          task_type: 'create_media_buy',
          status: 'completed',
          timestamp: '2026-08-21T12:02:00.000Z',
          result: { media_buy_id: 'must-not-be-published' },
        },
        'create_media_buy',
        pending.metadata.taskId
      ),
      true
    );
    assert.equal(asyncActivities.at(-1).type, 'webhook_duplicate');
    assert.equal(asyncActivities.at(-1).status, 'governance-denied');
    assert.equal(handlerCalls.length, 1);
  });

  test('fails closed when a durable webhook registration survives without its process-local settlement route', async () => {
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
    });

    await assert.rejects(
      client.dispatchParsedWebhook({
        ok: true,
        protocol: 'mcp',
        envelope: {
          operation_id: 'restarted-durable-operation',
          task_id: 'restarted-seller-task',
          task_type: 'create_media_buy',
          status: 'completed',
          result: { media_buy_id: 'must-not-publish' },
        },
        result: { media_buy_id: 'must-not-publish' },
        metadata: {
          operationId: 'restarted-durable-operation',
          taskId: 'restarted-seller-task',
          taskType: 'create_media_buy',
          status: 'completed',
          requiresDurableSettlement: true,
        },
      }),
      error =>
        error?.code === 'webhook_durable_settlement_unavailable' &&
        /no recoverable settlement route/i.test(error.message)
    );
  });

  test('webhook HTTP helper returns retryable 503 while durable settlement recovery is unavailable', async () => {
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
    });
    let recoveryAvailable = false;
    client.registerDurableSettlementRecovery(async (_operationId, observation) =>
      recoveryAvailable ? { settled: true, status: 'completed', result: observation.result } : undefined
    );
    client.verifyAndParseWebhook = async () => ({
      ok: true,
      protocol: 'mcp',
      envelope: {},
      result: { media_buy_id: 'durable-http-buy' },
      metadata: {
        operationId: 'durable-http-operation',
        taskId: 'durable-http-seller-task',
        taskType: 'create_media_buy',
        status: 'completed',
        requiresDurableSettlement: true,
      },
    });
    const handler = client.createWebhookHandler();
    const response = () => ({
      statusCode: 0,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
      },
    });

    const unavailable = response();
    await handler({ body: {}, params: {} }, unavailable);
    assert.equal(unavailable.statusCode, 503);

    recoveryAvailable = true;
    const retried = response();
    await handler({ body: {}, params: {} }, retried);
    assert.equal(retried.statusCode, 202);
  });

  test('does not acknowledge a durable callback into process memory when recovery is unavailable', async () => {
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
    });
    const operationId = 'durable-memory-only-operation';
    client.executor.deferredTerminalPublicationTaskIds.add(operationId);
    client.registerDurableSettlementRecovery(async () => undefined);

    await assert.rejects(
      client.dispatchParsedWebhook({
        ok: true,
        protocol: 'mcp',
        envelope: {},
        result: { media_buy_id: 'must-not-queue' },
        metadata: {
          operationId,
          taskId: 'durable-memory-only-task',
          taskType: 'create_media_buy',
          status: 'completed',
          requiresDurableSettlement: true,
        },
      }),
      error => error?.code === 'webhook_durable_settlement_unavailable'
    );
    assert.strictEqual(client.executor.pendingExternalTaskObservations.has(operationId), false);
  });

  test('fails closed when a durable recovery route returns an invalid or contradictory result', async () => {
    const handlerCalls = [];
    const invalidResults = [
      { settled: false },
      { settled: true },
      { settled: true, status: 'completed' },
      { settled: false, duplicate: true, status: 'completed' },
      { settled: true, queued: true, status: 'completed' },
    ];
    for (const [index, invalidResult] of invalidResults.entries()) {
      const client = new SingleAgentClient(AGENT, {
        allowUnauthenticatedWebhooks: true,
        strictSchemaValidation: false,
        validateFeatures: false,
        handlers: {
          onCreateMediaBuyStatusChange: result => handlerCalls.push(result),
        },
      });
      client.registerDurableSettlementRecovery(async () => invalidResult);

      await assert.rejects(
        client.dispatchParsedWebhook({
          ok: true,
          protocol: 'mcp',
          envelope: {},
          result: { media_buy_id: 'must-not-publish' },
          metadata: {
            operationId: `invalid-recovery-result-operation-${index}`,
            taskId: `invalid-recovery-result-task-${index}`,
            taskType: 'create_media_buy',
            status: 'completed',
            requiresDurableSettlement: true,
          },
        }),
        error =>
          error?.code === 'webhook_durable_settlement_unavailable' &&
          /invalid or contradictory callback outcome/i.test(error.message)
      );
    }
    assert.equal(handlerCalls.length, 0);
  });

  test('settles a restarted durable callback through a registered recovery route', async () => {
    const handlerCalls = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      handlers: {
        onCreateMediaBuyStatusChange: (result, metadata) => handlerCalls.push({ result, metadata }),
      },
    });
    const recoveries = [];
    client.registerDurableSettlementRecovery(async (operationId, observation) => {
      recoveries.push({ operationId, observation });
      return {
        settled: true,
        status: 'completed',
        result: { media_buy_id: 'recovered-durable-buy' },
      };
    });

    assert.equal(
      await client.dispatchParsedWebhook({
        ok: true,
        protocol: 'mcp',
        envelope: {
          operation_id: 'restarted-durable-operation',
          task_id: 'restarted-seller-task',
          task_type: 'create_media_buy',
          status: 'completed',
          result: { media_buy_id: 'seller-result' },
        },
        result: { media_buy_id: 'seller-result' },
        metadata: {
          operationId: 'restarted-durable-operation',
          taskId: 'restarted-seller-task',
          taskType: 'create_media_buy',
          status: 'completed',
          requiresDurableSettlement: true,
        },
      }),
      true
    );
    assert.deepEqual(recoveries, [
      {
        operationId: 'restarted-durable-operation',
        observation: {
          status: 'completed',
          result: { media_buy_id: 'seller-result' },
          serverTaskId: 'restarted-seller-task',
          taskType: 'create_media_buy',
        },
      },
    ]);
    assert.deepEqual(handlerCalls[0].result, { media_buy_id: 'recovered-durable-buy' });
    assert.equal(handlerCalls[0].metadata.status, 'completed');
  });

  test('validates configured webhook dedup identity before durable settlement recovery', async () => {
    let recoveries = 0;
    let handlerCalls = 0;
    const activities = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      handlers: {
        webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
        onCreateMediaBuyStatusChange: () => {
          handlerCalls += 1;
        },
      },
      onActivity: activity => activities.push(activity),
    });
    client.registerDurableSettlementRecovery(async (_operationId, observation) => {
      recoveries += 1;
      return { settled: true, status: 'completed', result: observation.result };
    });

    const parsed = idempotencyKey => ({
      ok: true,
      protocol: 'mcp',
      envelope: {},
      result: { media_buy_id: 'durable-buy' },
      metadata: {
        operationId: 'durable-dedup-operation',
        taskId: 'durable-dedup-task',
        taskType: 'create_media_buy',
        status: 'completed',
        requiresDurableSettlement: true,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      },
    });

    for (const key of [undefined, 'short']) {
      await assert.rejects(
        client.dispatchParsedWebhook(parsed(key)),
        error => error?.code === 'webhook_envelope_invalid'
      );
    }
    assert.equal(recoveries, 0);
    assert.equal(handlerCalls, 0);
    assert.equal(activities.length, 0);

    assert.equal(await client.dispatchParsedWebhook(parsed('durable_webhook_key_0001')), true);
    assert.equal(recoveries, 1);
    assert.equal(handlerCalls, 1);
    assert.equal(await client.dispatchParsedWebhook(parsed('durable_webhook_key_0001')), true);
    assert.equal(recoveries, 1, 'an exact sender retry must be deduplicated before durable recovery');
    assert.equal(handlerCalls, 1);
  });

  test('releases durable settlement ownership before making a failed sender claim retryable', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const replaceIfPayloadHash = backend.replaceIfPayloadHash.bind(backend);
    let recoveryCalls = 0;
    let handlerCalls = 0;
    let nackFinished = false;
    let releaseNack;
    let markNackEntered;
    const nackEntered = new Promise(resolve => {
      markNackEntered = resolve;
    });
    backend.replaceIfPayloadHash = async (...args) => {
      const replacement = args[2];
      if (replacement.response?.claimToken && replacement.expiresAt < Math.floor(Date.now() / 1000)) {
        assert.equal(nackFinished, true, 'the durable NACK must finish before the sender claim is released');
      }
      return replaceIfPayloadHash(...args);
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const client = new SingleAgentClient(AGENT, {
        allowUnauthenticatedWebhooks: true,
        strictSchemaValidation: false,
        validateFeatures: false,
        handlers: {
          webhookDedup: { backend },
          onCreateMediaBuyStatusChange: () => {
            handlerCalls += 1;
            if (handlerCalls === 1) throw new Error('publication failed');
          },
        },
      });
      client.registerDurableSettlementRecovery(async (_operationId, observation) => {
        recoveryCalls += 1;
        return {
          settled: true,
          status: 'completed',
          result: observation.result,
          onDispatchError: async () => {
            markNackEntered();
            await new Promise(resolve => {
              releaseNack = resolve;
            });
            nackFinished = true;
          },
        };
      });
      const parsed = {
        ok: true,
        protocol: 'mcp',
        envelope: {},
        result: { media_buy_id: 'nack-before-release' },
        metadata: {
          operationId: 'nack-before-release-operation',
          taskId: 'nack-before-release-task',
          taskType: 'create_media_buy',
          status: 'completed',
          requiresDurableSettlement: true,
          idempotencyKey: 'nack_before_release_key_0001',
        },
      };

      const first = client.dispatchParsedWebhook(parsed);
      await nackEntered;
      await assert.rejects(
        client.dispatchParsedWebhook(parsed),
        error => error?.code === 'webhook_publication_in_progress'
      );
      assert.equal(recoveryCalls, 1);
      releaseNack();
      await assert.rejects(first, /publication failed/);

      assert.equal(await client.dispatchParsedWebhook(parsed), true);
      assert.equal(recoveryCalls, 2);
      assert.equal(handlerCalls, 2);
    } finally {
      console.error = originalError;
    }
  });

  test('does not NACK durable settlement after ACK when sender marker publication fails', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const replaceIfPayloadHash = backend.replaceIfPayloadHash.bind(backend);
    backend.replaceIfPayloadHash = async (...args) => {
      if (args[2]?.response?.state === 'adcp_webhook_handled_v1') return false;
      return replaceIfPayloadHash(...args);
    };
    let recoveryCalls = 0;
    let acknowledgements = 0;
    let rejections = 0;
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      handlers: {
        webhookDedup: { backend },
        onCreateMediaBuyStatusChange: () => undefined,
      },
    });
    client.registerDurableSettlementRecovery(async (_operationId, observation) => {
      recoveryCalls += 1;
      return {
        settled: true,
        status: 'completed',
        result: observation.result,
        afterDispatch: async () => {
          acknowledgements += 1;
        },
        onDispatchError: async () => {
          rejections += 1;
        },
      };
    });
    const parsed = {
      ok: true,
      protocol: 'mcp',
      envelope: {},
      result: { media_buy_id: 'ack-before-marker' },
      metadata: {
        operationId: 'ack-before-marker-operation',
        taskId: 'ack-before-marker-task',
        taskType: 'create_media_buy',
        status: 'completed',
        requiresDurableSettlement: true,
        idempotencyKey: 'ack_before_marker_key_0001',
      },
    };

    await assert.rejects(client.dispatchParsedWebhook(parsed), /claim was lost/);
    assert.equal(acknowledgements, 1);
    assert.equal(rejections, 0);
    await assert.rejects(
      client.dispatchParsedWebhook(parsed),
      error => error?.code === 'webhook_publication_in_progress'
    );
    assert.equal(recoveryCalls, 1, 'the retained sender claim must prevent immediate recovery after ACK');
  });

  test('retains the sender claim when durable settlement ownership cannot be released', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const replaceIfPayloadHash = backend.replaceIfPayloadHash.bind(backend);
    let releaseCalls = 0;
    backend.replaceIfPayloadHash = async (...args) => {
      const replacement = args[2];
      if (replacement.response?.claimToken && replacement.expiresAt < Math.floor(Date.now() / 1000)) {
        releaseCalls += 1;
      }
      return replaceIfPayloadHash(...args);
    };
    let recoveryCalls = 0;
    const originalError = console.error;
    console.error = () => {};
    try {
      const client = new SingleAgentClient(AGENT, {
        allowUnauthenticatedWebhooks: true,
        strictSchemaValidation: false,
        validateFeatures: false,
        handlers: {
          webhookDedup: { backend },
          onCreateMediaBuyStatusChange: () => {
            throw new Error('handler failed before publication');
          },
        },
      });
      client.registerDurableSettlementRecovery(async (_operationId, observation) => {
        recoveryCalls += 1;
        return {
          settled: true,
          status: 'completed',
          result: observation.result,
          onDispatchError: async () => {
            throw new Error('durable NACK failed');
          },
        };
      });
      const parsed = {
        ok: true,
        protocol: 'mcp',
        envelope: {},
        result: { media_buy_id: 'retain-after-nack-failure' },
        metadata: {
          operationId: 'retain-after-nack-failure-operation',
          taskId: 'retain-after-nack-failure-task',
          taskType: 'create_media_buy',
          status: 'completed',
          requiresDurableSettlement: true,
          idempotencyKey: 'retain_after_nack_failure_0001',
        },
      };

      await assert.rejects(
        client.dispatchParsedWebhook(parsed),
        error =>
          error?.code === 'webhook_publication_in_progress' &&
          error?.cause?.name === 'WebhookDedupClaimRetentionError' &&
          error?.cause?.errors?.some(cause => cause?.message === 'durable NACK failed')
      );
      assert.equal(releaseCalls, 0);
      await assert.rejects(
        client.dispatchParsedWebhook(parsed),
        error => error?.code === 'webhook_publication_in_progress'
      );
      assert.equal(recoveryCalls, 1);
      assert.equal(releaseCalls, 0);
    } finally {
      console.error = originalError;
    }
  });

  test('maps durable NACK retention to a public retryable error without configured handlers', async () => {
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
    });
    client.registerDurableSettlementRecovery(async (_operationId, observation) => ({
      settled: true,
      status: 'completed',
      result: observation.result,
      afterDispatch: async () => {
        throw new Error('durable ACK failed');
      },
      onDispatchError: async () => {
        throw new Error('durable NACK failed');
      },
    }));
    const parsed = {
      ok: true,
      protocol: 'mcp',
      envelope: {},
      result: { media_buy_id: 'no-handler-retained-buy' },
      metadata: {
        operationId: 'no-handler-retained-operation',
        taskId: 'no-handler-retained-task',
        taskType: 'create_media_buy',
        status: 'completed',
        requiresDurableSettlement: true,
        idempotencyKey: 'no_handler_retained_event_0001',
      },
    };

    await assert.rejects(
      client.dispatchParsedWebhook(parsed),
      error =>
        error?.code === 'webhook_publication_in_progress' &&
        error?.cause?.name === 'WebhookDedupClaimRetentionError' &&
        error?.cause?.errors?.some(cause => cause?.message === 'durable NACK failed')
    );
  });

  test('publishes a durably queued callback only after durable task binding', async () => {
    const handlerCalls = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      handlers: {
        onCreateMediaBuyStatusChange: (result, metadata) => handlerCalls.push({ result, metadata }),
      },
    });
    client.registerDurableSettlementRecovery(async () => ({ settled: false, queued: true }));

    assert.equal(
      await client.dispatchParsedWebhook({
        ok: true,
        protocol: 'mcp',
        envelope: {
          operation_id: 'queued-durable-operation',
          task_id: 'queued-seller-task',
          task_type: 'create_media_buy',
          status: 'completed',
          result: { media_buy_id: 'queued-durable-buy' },
        },
        result: { media_buy_id: 'queued-durable-buy' },
        metadata: {
          operationId: 'queued-durable-operation',
          taskId: 'queued-seller-task',
          taskType: 'create_media_buy',
          status: 'completed',
          requiresDurableSettlement: true,
        },
      }),
      true
    );
    assert.equal(handlerCalls.length, 0);
    await client.publishDurablySettledWebhook({
      operationId: 'queued-durable-operation',
      serverTaskId: 'queued-seller-task',
      taskType: 'create_media_buy',
      status: 'completed',
      result: { media_buy_id: 'queued-durable-buy' },
    });
    assert.equal(handlerCalls.length, 1);
    assert.deepEqual(handlerCalls[0].result, { media_buy_id: 'queued-durable-buy' });
    assert.equal(handlerCalls[0].metadata.task_id, 'queued-seller-task');
  });

  test('does not invoke a completion handler twice after durable callback publication', async () => {
    const handlerCalls = [];
    ProtocolClient.callTool = mock.fn(async () => ({
      status: 'completed',
      data: { media_buy_id: 'published-before-return', packages: [] },
    }));
    const client = new SingleAgentClient(AGENT, {
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      handlers: {
        onCreateMediaBuyStatusChange: (result, metadata) => handlerCalls.push({ result, metadata }),
      },
    });
    client.ensureEndpointDiscovered = async () => AGENT;
    client.detectServerVersion = async () => 'v3';
    client.getEarlyResultForUnsupportedFeatures = async () => null;

    const result = await client.createMediaBuyLegacyWithPreDispatch(
      {
        idempotency_key: 'published-before-return-key',
        account: { account_id: 'account-1' },
        brand: { domain: 'buyer.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        packages: [],
      },
      async (_params, context) => ({
        action: 'dispatch_committed',
        onResult: async sellerResult => {
          await client.publishDurablySettledWebhook({
            operationId: context.operationId,
            serverTaskId: 'published-before-return-seller-task',
            taskType: 'create_media_buy',
            status: 'completed',
            result: sellerResult.data,
          });
          return markCompletionHandlerAlreadyPublished(sellerResult);
        },
        onError: async error => {
          throw error;
        },
      })
    );

    assert.equal(result.status, 'completed', result.error);
    assert.equal(handlerCalls.length, 1);
    assert.deepEqual(handlerCalls[0].result.data, { media_buy_id: 'published-before-return', packages: [] });
  });

  test('does not republish a callback when inbox binding wins the completion race', async () => {
    const handlerCalls = [];
    const client = new SingleAgentClient(AGENT, {
      allowUnauthenticatedWebhooks: true,
      strictSchemaValidation: false,
      validateFeatures: false,
      handlers: {
        onCreateMediaBuyStatusChange: result => handlerCalls.push(result),
      },
    });
    let releaseRecovery;
    const recoveryGate = new Promise(resolve => {
      releaseRecovery = resolve;
    });
    client.registerDurableSettlementRecovery(async () => {
      await recoveryGate;
      return { settled: true, duplicate: true, status: 'completed' };
    });
    const retry = client.dispatchParsedWebhook({
      ok: true,
      protocol: 'mcp',
      envelope: {},
      result: { media_buy_id: 'race-winner' },
      metadata: {
        operationId: 'race-operation',
        taskId: 'race-task',
        taskType: 'create_media_buy',
        status: 'completed',
        requiresDurableSettlement: true,
      },
    });
    await client.publishDurablySettledWebhook({
      operationId: 'race-operation',
      serverTaskId: 'race-task',
      taskType: 'create_media_buy',
      status: 'completed',
      result: { media_buy_id: 'race-winner' },
    });
    releaseRecovery();
    assert.equal(await retry, true);
    assert.equal(handlerCalls.length, 1);
    assert.deepEqual(handlerCalls[0], { media_buy_id: 'race-winner' });
  });
});
