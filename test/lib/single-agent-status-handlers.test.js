const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { DEFERRED_SETTLEMENT_ACK } = require('../../dist/lib/core/TaskExecutor.js');

const agent = {
  id: 'status-handler-seller',
  name: 'Status handler seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function taskResult(status = 'completed') {
  return {
    success: true,
    status,
    ...(status === 'completed' && { data: { creatives: [] } }),
    metadata: {
      taskId: 'buyer-operation',
      taskName: 'sync_creatives',
      agent,
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status,
    },
    conversation: [],
  };
}

function makeClient(executeTask, config = {}) {
  const client = new SingleAgentClient(agent, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    ...config,
  });
  client.discoveredEndpoint = agent.agent_uri;
  client.cachedCapabilities = {
    version: 'v3',
    majorVersions: [3],
    protocols: ['media_buy'],
    features: { canonicalCreatives: true },
    extensions: [],
    _synthetic: false,
  };
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  client.validateTaskFeatures = async () => {};
  client.executor.executeTask = executeTask;
  return client;
}

test('skipping a throwing inline handler returns the seller result and acknowledges settlement', async () => {
  let handlerCalls = 0;
  let executions = 0;
  let acknowledged;
  const result = taskResult();
  result[DEFERRED_SETTLEMENT_ACK] = async finalized => {
    acknowledged = finalized;
  };
  const client = makeClient(
    async (_agent, _task, params) => {
      assert.equal(params.skipStatusHandlers, undefined, 'local option must not enter seller arguments');
      return executions++ === 0 ? result : taskResult();
    },
    {
      handlers: {
        onSyncCreativesStatusChange: () => {
          handlerCalls += 1;
          throw new Error('local identity mismatch');
        },
      },
    }
  );

  const completed = await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
    skipStatusHandlers: true,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.success, true);
  assert.deepEqual(completed.data, { creatives: [] });
  assert.equal(handlerCalls, 0);
  assert.equal(acknowledged, completed);

  await assert.rejects(
    client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }),
    /local identity mismatch/
  );
  assert.equal(handlerCalls, 1, 'skip applies to one call only');
});

for (const skipStatusHandlers of [undefined, false]) {
  test(`inline handler errors still reject by default (skip=${skipStatusHandlers})`, async () => {
    const failure = new Error('handler failure');
    const client = makeClient(async () => taskResult(), {
      handlers: {
        onSyncCreativesStatusChange: async () => {
          throw failure;
        },
      },
    });
    await assert.rejects(
      client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, { skipStatusHandlers }),
      error => error === failure
    );
  });
}

for (const failure of [new Error('secret bearer in handler error'), 'non-Error rejection']) {
  test(`isolated handler failure returns completion, reports context, and acknowledges (${typeof failure})`, async () => {
    let acknowledged;
    let observed;
    const result = taskResult();
    result[DEFERRED_SETTLEMENT_ACK] = async finalized => {
      acknowledged = finalized;
    };
    const client = makeClient(async () => result, {
      isolateStatusHandlerErrors: true,
      handlers: {
        onSyncCreativesStatusChange: async () => {
          throw failure;
        },
      },
      onStatusHandlerError: async (error, context) => {
        observed = { error, context };
      },
    });
    const completed = await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
      contextId: 'conversation',
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.data, { creatives: [] });
    assert.equal(observed.error, failure);
    assert.equal(observed.context.handlerName, 'onSyncCreativesStatusChange');
    assert.equal(observed.context.metadata.agent_id, agent.id);
    assert.equal(observed.context.metadata.task_type, 'sync_creatives');
    assert.equal(observed.context.metadata.status, 'completed');
    assert.equal(observed.context.metadata.context_id, 'conversation');
    assert.equal(acknowledged, completed);
    assert.match(completed.debug_logs[0].message, /Inline status handler failed/);
    assert.doesNotMatch(JSON.stringify(completed.debug_logs), /secret bearer|non-Error rejection/);
  });
}

test('failure in the error observer cannot discard a successful result', async () => {
  const client = makeClient(async () => taskResult(), {
    isolateStatusHandlerErrors: true,
    handlers: {
      onSyncCreativesStatusChange: () => {
        throw new Error('handler error');
      },
    },
    onStatusHandlerError: () => {
      throw new Error('observer error');
    },
  });
  const completed = await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] });
  assert.equal(completed.status, 'completed');
  assert.match(completed.debug_logs[1].message, /onStatusHandlerError observer failed/);
});

test('isolation without an observer still reports a warning', async () => {
  const client = makeClient(async () => taskResult(), {
    isolateStatusHandlerErrors: true,
    handlers: {
      onSyncCreativesStatusChange: () => {
        throw new Error('handler error');
      },
    },
  });
  const completed = await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.debug_logs.length, 1);
});

test('handler isolation preserves caller cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  let observed = false;
  const client = makeClient(async () => taskResult(), {
    isolateStatusHandlerErrors: true,
    handlers: {
      onSyncCreativesStatusChange: () => {
        controller.abort(reason);
        throw new Error('handler interrupted');
      },
    },
    onStatusHandlerError: () => {
      observed = true;
    },
  });
  await assert.rejects(
    client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
      signal: controller.signal,
    }),
    error => error.name === 'AbortError' && error.cause === reason
  );
  assert.equal(observed, false);
});

for (const status of ['deferred', 'submitted']) {
  test(`skip survives an in-process ${status} continuation`, async () => {
    let handlerCalls = 0;
    const pending = taskResult(status);
    if (status === 'deferred') {
      pending.deferred = { token: 'continuation-token', resume: async () => taskResult() };
    } else {
      pending.submitted = { taskId: 'seller-task', waitForCompletion: async () => taskResult() };
    }
    const client = makeClient(async () => pending, {
      handlers: {
        onSyncCreativesStatusChange: () => {
          handlerCalls += 1;
        },
      },
    });
    const result = await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
      skipStatusHandlers: true,
    });
    const completed =
      status === 'deferred'
        ? await result.deferred.resume({ approved: true })
        : await result.submitted.waitForCompletion();
    assert.equal(completed.status, 'completed');
    assert.equal(handlerCalls, 0);
  });
}

test('skip is persisted in both typed and generic task continuation contexts', async () => {
  const contexts = [];
  let handlerCalls = 0;
  const client = makeClient(
    async (...args) => {
      contexts.push(args[8]);
      return taskResult();
    },
    {
      handlers: {
        onSyncCreativesStatusChange: () => {
          handlerCalls += 1;
        },
      },
    }
  );
  await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
    skipStatusHandlers: true,
  });
  await client.executeTaskLegacy('sync_creatives', { account: { account_id: 'account-1' }, creatives: [] }, undefined, {
    skipStatusHandlers: true,
  });
  await client.executeTask('sync_creatives', { account: { account_id: 'account-1' }, creatives: [] }, undefined, {
    skipStatusHandlers: true,
  });
  assert.equal(contexts.length, 3);
  for (const context of contexts) assert.equal(context.skipStatusHandlers, true);
  assert.equal(handlerCalls, 0);
});

test('default mode preserves a handler error when the caller also aborts', async () => {
  const controller = new AbortController();
  const failure = new Error('handler failed');
  const client = makeClient(async () => taskResult(), {
    handlers: {
      onSyncCreativesStatusChange: () => {
        controller.abort(new Error('caller cancelled'));
        throw failure;
      },
    },
  });
  await assert.rejects(
    client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
      signal: controller.signal,
    }),
    error => error === failure
  );
});

test('cancellation during the error observer still rejects', async () => {
  const controller = new AbortController();
  const reason = new Error('observer cancelled');
  const client = makeClient(async () => taskResult(), {
    isolateStatusHandlerErrors: true,
    handlers: {
      onSyncCreativesStatusChange: () => {
        throw new Error('handler failed');
      },
    },
    onStatusHandlerError: () => {
      controller.abort(reason);
    },
  });
  await assert.rejects(
    client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
      signal: controller.signal,
    }),
    error => error.name === 'AbortError' && error.cause === reason
  );
});

test('skipping inline handlers leaves independently delivered webhook handlers active', async () => {
  let handlerCalls = 0;
  const client = makeClient(async () => taskResult(), {
    allowUnauthenticatedWebhooks: true,
    handlers: {
      onSyncCreativesStatusChange: () => {
        handlerCalls += 1;
      },
    },
  });
  await client.syncCreatives({ account: { account_id: 'account-1' }, creatives: [] }, undefined, {
    skipStatusHandlers: true,
  });
  assert.equal(handlerCalls, 0);
  const handled = await client.handleWebhook(
    {
      idempotency_key: 'independent-webhook-event',
      operation_id: 'buyer-operation',
      task_id: 'seller-task',
      task_type: 'sync_creatives',
      status: 'completed',
      timestamp: new Date().toISOString(),
      result: { creatives: [] },
    },
    'sync_creatives',
    'buyer-operation'
  );
  assert.equal(handled, true);
  assert.equal(handlerCalls, 1);
});
