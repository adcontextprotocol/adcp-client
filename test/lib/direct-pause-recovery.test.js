const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
  AgentClient,
  DeferredSettlementOwnershipError,
  DirectContinuationRecoveryError,
  MemoryStorage,
  SingleAgentClient,
  TaskExecutor,
} = require('../../dist/lib/index.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');

const agent = {
  id: 'direct-pause-recovery-agent',
  name: 'Direct pause recovery agent',
  agent_uri: 'https://seller.example/.well-known/agent-card.json',
  protocol: 'a2a',
};

function pausedTask(id, contextId, question) {
  return {
    result: {
      kind: 'task',
      id,
      contextId,
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          messageId: `${id}-question`,
          role: 'agent',
          parts: [{ kind: 'data', data: { question, field: 'approval' } }],
        },
      },
      artifacts: [],
    },
  };
}

test('direct continuation recovery fails before dispatch without its required substrate', async () => {
  const protocolCalls = [];
  const originalCallTool = ProtocolClient.callTool;
  ProtocolClient.callTool = async (...args) => {
    protocolCalls.push(args);
    assert.fail('invalid durable recovery configuration must fail before seller dispatch');
  };

  try {
    const noStorage = new TaskExecutor({ validation: { requests: 'off', responses: 'off' } });
    await assert.rejects(
      noStorage.executeTask(agent, 'buy_products', {}, undefined, {
        durableContinuationRecovery: { ownerScope: 'principal:buyer-1/account:account-1' },
      }),
      /requires deferredStorage/
    );

    const storage = new MemoryStorage({ autoCleanup: false });
    try {
      await assert.rejects(
        new TaskExecutor({ deferredStorage: storage, validation: { requests: 'off', responses: 'off' } }).executeTask(
          agent,
          'list_products',
          {},
          undefined,
          { durableContinuationRecovery: { ownerScope: 'principal:buyer-1/account:account-1' } }
        ),
        /only for mutating AdCP requests/
      );
      await assert.rejects(
        new TaskExecutor({ deferredStorage: storage, validation: { requests: 'off', responses: 'off' } }).executeTask(
          { ...agent, protocol: 'mcp' },
          'buy_products',
          {},
          undefined,
          { durableContinuationRecovery: { ownerScope: 'principal:buyer-1/account:account-1' } }
        ),
        /only for resumable A2A mutations/
      );
    } finally {
      storage.destroy();
    }
    assert.equal(protocolCalls.length, 0);
  } finally {
    ProtocolClient.callTool = originalCallTool;
  }
});

test('AgentClient.buyProducts forwards the direct recovery opt-in', async () => {
  const client = new AgentClient(agent, { validateFeatures: false });
  let capturedOptions;
  client.client.executeTask = async (_taskName, _params, _handler, options) => {
    capturedOptions = options;
    return {
      success: false,
      status: 'failed',
      error: 'stubbed before dispatch',
      metadata: {
        taskId: 'public-surface-test',
        taskName: 'buy_products',
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'failed',
      },
    };
  };
  const result = await client.buyProducts(
    { idempotency_key: 'public-surface-key', account: { account_id: 'account-1' } },
    undefined,
    { durableContinuationRecovery: { ownerScope: 'principal:buyer-1/account:account-1' } }
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(capturedOptions.durableContinuationRecovery, {
    ownerScope: 'principal:buyer-1/account:account-1',
  });
});

test('direct mutation recovers nested pause after route commit response is lost', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let protocolCalls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName, params, options) => {
    protocolCalls += 1;
    assert.equal(taskName, 'buy_products');
    if (protocolCalls === 1) {
      return pausedTask('seller-task-a', 'seller-context-a', 'Approve purchase?');
    }
    if (protocolCalls === 2) {
      assert.deepEqual(params, { input: { approved: true } });
      assert.deepEqual(options.session, { contextId: 'seller-context-a', taskId: 'seller-task-a' });
      return pausedTask('seller-task-b', 'seller-context-b', 'Confirm final terms?');
    }
    assert.deepEqual(params, { input: { confirmed: true } });
    assert.deepEqual(options.session, { contextId: 'seller-context-b', taskId: 'seller-task-b' });
    return {
      status: 'completed',
      task_id: 'seller-task-b',
      media_buy_id: 'recovered-direct-buy',
      packages: [],
    };
  };

  try {
    const first = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    const paused = await first.executor.executeTask(
      agent,
      'buy_products',
      { idempotency_key: 'direct-pause-recovery-key', account: { account_id: 'account-1' } },
      undefined,
      { durableContinuationRecovery: { ownerScope: 'principal:buyer-1/account:account-1' } }
    );
    assert.equal(paused.status, 'input-required', paused.error);
    const initialToken = paused.deferred.token;
    const { operationId, recoveryKey } = paused.deferred.recovery;
    assert.equal(operationId, paused.metadata.taskId);
    assert.match(recoveryKey, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(recoveryKey, initialToken);
    const initialRoute = await storage.getBySettlementOperationId(operationId);
    assert.equal(initialRoute.token, initialToken);
    assert.equal(initialRoute.state.directContinuationRecovery, true);
    assert.equal(
      initialRoute.state.directContinuationRecoveryKeyDigest,
      createHash('sha256').update(recoveryKey).digest('base64url')
    );
    assert.equal(JSON.stringify(initialRoute.state).includes(recoveryKey), false);

    const replace = storage.replaceForSettlementOperationIfVersion.bind(storage);
    let loseReplacementAcknowledgement = true;
    storage.replaceForSettlementOperationIfVersion = async (...args) => {
      const stored = await replace(...args);
      if (stored && args[1] !== args[3] && loseReplacementAcknowledgement) {
        loseReplacementAcknowledgement = false;
        throw new Error('simulated crash after replacement route commit');
      }
      return stored;
    };

    await assert.rejects(paused.deferred.resume({ approved: true }), /simulated crash after replacement route commit/);
    const replacementRoute = await storage.getBySettlementOperationId(operationId);
    assert.notEqual(replacementRoute.token, initialToken);
    assert.equal(replacementRoute.state.pauseQuestion, 'Confirm final terms?');
    assert.equal(
      replacementRoute.state.directContinuationRecoveryKeyDigest,
      initialRoute.state.directContinuationRecoveryKeyDigest
    );

    const committedRecovery = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => agent,
      authorizeDeferredSettlementOperationRecovery: async () => true,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      committedRecovery.recoverDeferredTaskForOperation(operationId, recoveryKey),
      error =>
        error instanceof DeferredSettlementOwnershipError &&
        /cannot be recovered through committed settlement authorization/.test(error.message)
    );
    assert.equal(protocolCalls, 2);

    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    restarted.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    await assert.rejects(
      restarted.resumeDeferredTask(initialToken, { approved: true }),
      error =>
        error instanceof DirectContinuationRecoveryError &&
        error.reason === 'superseded' &&
        /use owner-bound operation recovery/.test(error.message) &&
        !error.message.includes(replacementRoute.token)
    );
    assert.equal(protocolCalls, 2);
    const deniedKeys = [
      'direct-pause-recovery-key',
      'seller-task-b',
      operationId,
      replacementRoute.token,
      createHash('sha256').update('wrong').digest('base64url'),
    ];
    for (const deniedKey of deniedKeys) {
      await assert.rejects(
        restarted.recoverDirectPauseContinuation({
          operationId,
          recoveryKey: deniedKey,
          ownerScope: 'principal:buyer-1/account:account-1',
        }),
        error => error instanceof DeferredSettlementOwnershipError && /not authorized/.test(error.message)
      );
    }
    await assert.rejects(
      restarted.recoverDirectPauseContinuation({
        operationId,
        recoveryKey,
        ownerScope: 'principal:buyer-2/account:account-1',
      }),
      error => error instanceof DeferredSettlementOwnershipError && /not authorized/.test(error.message)
    );
    const wrongSellerAgent = { ...agent, agent_uri: 'https://other-seller.example/a2a' };
    const wrongSeller = new SingleAgentClient(wrongSellerAgent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    wrongSeller.ensureCanonicalUrlResolved = async () => wrongSellerAgent;
    await assert.rejects(
      wrongSeller.recoverDirectPauseContinuation({
        operationId,
        recoveryKey,
        ownerScope: 'principal:buyer-1/account:account-1',
      }),
      error => error instanceof DeferredSettlementOwnershipError && /not authorized/.test(error.message)
    );
    assert.equal(protocolCalls, 2);
    const recovered = await restarted.recoverDirectPauseContinuation({
      operationId,
      recoveryKey,
      ownerScope: 'principal:buyer-1/account:account-1',
    });
    assert.equal(recovered.status, 'input-required');
    assert.equal(recovered.deferred.token, replacementRoute.token);
    assert.deepEqual(recovered.deferred.recovery, { operationId, recoveryKey });
    assert.equal(protocolCalls, 2);

    const loadState = storage.get.bind(storage);
    storage.get = async token => {
      const state = await loadState(token);
      if (!state) return state;
      const fieldDroppingState = { ...state };
      delete fieldDroppingState.directContinuationRecovery;
      return fieldDroppingState;
    };
    await assert.rejects(
      recovered.deferred.resume({ confirmed: true }),
      /lost its route-kind discriminator in durable storage/
    );
    assert.equal(protocolCalls, 2);
    storage.get = loadState;

    const current = await storage.getBySettlementOperationId(operationId);
    const claimedVersion = 'claimed-direct-recovery-generation';
    assert.equal(
      await storage.replaceForSettlementOperationIfVersion(
        operationId,
        current.token,
        current.state.continuationVersion,
        current.token,
        { ...current.state, continuationVersion: claimedVersion, continuationClaimed: true },
        60
      ),
      true
    );
    await assert.rejects(
      restarted.recoverDirectPauseContinuation({
        operationId,
        recoveryKey,
        ownerScope: 'principal:buyer-1/account:account-1',
      }),
      error =>
        error instanceof DirectContinuationRecoveryError &&
        error.reason === 'in_progress' &&
        /already being resumed; do not redispatch/.test(error.message)
    );
    assert.equal(protocolCalls, 2);
    assert.equal(
      await storage.replaceForSettlementOperationIfVersion(
        operationId,
        current.token,
        claimedVersion,
        current.token,
        current.state,
        60
      ),
      true
    );

    const expiredAdmissionVersion = 'expired-direct-admission-generation';
    assert.equal(
      await storage.replaceForSettlementOperationIfVersion(
        operationId,
        current.token,
        current.state.continuationVersion,
        current.token,
        {
          ...current.state,
          continuationVersion: expiredAdmissionVersion,
          continuationClaimed: true,
          settlementResumeDispatchLease: {
            ownerId: 'crashed-before-dispatch-owner',
            phase: 'admission',
            expiresAt: Date.now() - 1,
          },
        },
        60
      ),
      true
    );
    const reclaimable = await restarted.recoverDirectPauseContinuation({
      operationId,
      recoveryKey,
      ownerScope: 'principal:buyer-1/account:account-1',
    });
    assert.equal(reclaimable.status, 'input-required');
    const completed = await reclaimable.deferred.resume({ confirmed: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'recovered-direct-buy');
    assert.equal(protocolCalls, 3);
    assert.equal(await storage.getBySettlementOperationId(operationId), undefined);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('task id alone never reveals a direct continuation token', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      client.recoverDirectPauseContinuation({
        operationId: 'unknown-operation',
        recoveryKey: createHash('sha256').update('unknown').digest('base64url'),
        ownerScope: 'principal:buyer-1/account:account-1',
      }),
      error => error instanceof DeferredSettlementOwnershipError && /not authorized/.test(error.message)
    );
  } finally {
    storage.destroy();
  }
});
