const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient, TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');

const AGENT = {
  id: 'dispatch-boundary-seller',
  name: 'Dispatch boundary seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

const originalCallTool = ProtocolClient.callTool;

afterEach(() => {
  ProtocolClient.callTool = originalCallTool;
});

describe('TaskExecutor pre-dispatch boundary', () => {
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

  test('runs the committed error settlement exactly once when seller dispatch throws', async () => {
    const transportError = new Error('seller transport failed after dispatch');
    const durableError = new Error('durable outcome fenced');
    ProtocolClient.callTool = mock.fn(async () => {
      throw transportError;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    let errorSettlements = 0;
    let resultSettlements = 0;

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
  });

  test('publishes terminal completion only after durable result settlement succeeds', async () => {
    const durableError = new Error('durable completion persistence failed');
    ProtocolClient.callTool = mock.fn(async () => ({
      status: 'completed',
      data: { media_buy_id: 'seller-created-buy' },
    }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const observedStatuses = [];
    executor.onTaskUpdate(AGENT.id, task => observedStatuses.push(task.status));

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
    const retained = executor.getActiveTasks();
    assert.equal(retained[0].status, 'failed');
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
    await assert.rejects(
      executor.observeExternalTaskStatus(
        pending.metadata.taskId,
        'completed',
        { media_buy_id: 'poll-first-buy' },
        { serverTaskId: 'poll-first-seller-task', taskType: 'create_media_buy' }
      ),
      /settled through its direct response|already completed durable settlement/
    );
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
    const durableError = new Error('durable deferred persistence failed');
    const deferredRecords = new Map();
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) =>
      taskName === 'continue_task'
        ? { status: 'completed', data: { media_buy_id: 'seller-created-buy' } }
        : {
            status: 'input-required',
            question: 'Approve the legacy purchase?',
            field: 'approval',
            contextId: 'legacy-create-context',
          }
    );
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      deferredStorage: {
        set: async (token, state) => deferredRecords.set(token, state),
        get: async token => deferredRecords.get(token),
        delete: async token => deferredRecords.delete(token),
      },
    });
    const observedStatuses = [];
    executor.onTaskUpdate(AGENT.id, task => observedStatuses.push(task.status));

    const pending = await executor.executeTask(
      AGENT,
      'create_media_buy',
      { idempotency_key: 'deferred-settlement-order' },
      async () => ({ defer: true, token: 'legacy-create-deferred-token' }),
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

  test('publishes deferred-to-submitted completion only after recursive durable settlement', async () => {
    const deferredRecords = new Map();
    let markPersistenceStarted;
    const persistenceStarted = new Promise(resolve => {
      markPersistenceStarted = resolve;
    });
    let releasePersistence;
    const persistenceRelease = new Promise(resolve => {
      releasePersistence = resolve;
    });
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'continue_task') return { status: 'submitted', task_id: 'resumed-seller-task' };
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
      return {
        status: 'input-required',
        question: 'Approve the legacy purchase?',
        field: 'approval',
        contextId: 'legacy-create-context',
      };
    });
    const executor = new TaskExecutor({
      strictSchemaValidation: false,
      deferredStorage: {
        set: async (token, state) => deferredRecords.set(token, state),
        get: async token => deferredRecords.get(token),
        delete: async token => deferredRecords.delete(token),
      },
    });
    const observedStatuses = [];
    executor.onTaskUpdate(AGENT.id, task => observedStatuses.push(task.status));

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
      AGENT,
      'create_media_buy',
      { idempotency_key: 'deferred-submitted-settlement-order' },
      async () => ({ defer: true, token: 'legacy-create-deferred-submitted-token' }),
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
});
