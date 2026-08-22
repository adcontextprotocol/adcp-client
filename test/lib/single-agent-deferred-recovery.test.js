const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { SingleAgentClient, TaskExecutor, MemoryStorage } = require('../../dist/lib/index.js');
const {
  DeferredSettlementOwnershipError,
  acknowledgeDeferredSettlement,
  rejectDeferredSettlement,
} = require('../../dist/lib/core/TaskExecutor.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');

const testDurableToken = label => createHash('sha256').update(label).digest('base64url');

const agent = {
  id: 'durable-resume-agent',
  name: 'Durable resume agent',
  agent_uri: 'https://seller.example/.well-known/agent-card.json',
  protocol: 'a2a',
};

function committedContinuationState({ operationId, sellerWorkId, version, now = Date.now(), dispatchLease }) {
  return {
    continuationVersion: version,
    ...(dispatchLease !== undefined && {
      continuationClaimed: true,
      settlementResumeDispatchLease: dispatchLease,
    }),
    taskId: operationId,
    contextId: `${operationId}-context`,
    a2aTaskId: `${operationId}-a2a-task`,
    serverVersion: 'v3',
    agentId: agent.id,
    taskName: 'create_media_buy',
    params: {},
    messages: [],
    settlementOperationId: operationId,
    settlementResumeAuthorizationRequired: true,
    settlementServerTaskId: sellerWorkId,
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

function committedTerminalResult(operationId, sellerWorkId, mediaBuyId) {
  return {
    success: true,
    status: 'completed',
    data: { media_buy_id: mediaBuyId, packages: [] },
    metadata: {
      taskId: operationId,
      serverTaskId: sellerWorkId,
      taskName: 'create_media_buy',
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
    conversation: [],
    debug_logs: [],
  };
}

test('MemoryStorage rejects non-positive atomic continuation TTLs', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  try {
    await assert.rejects(storage.putIfAbsent('invalid-put', { continuationVersion: 'v1' }, 0), /positive finite/);
    await assert.rejects(storage.set('invalid-set', { continuationVersion: 'v1' }, 0), /positive finite/);
    await assert.rejects(
      storage.mset([{ key: 'invalid-mset', value: { continuationVersion: 'v1' }, ttl: Number.NaN }]),
      /positive finite/
    );
    await storage.set('replace', { continuationVersion: 'v1' });
    await assert.rejects(
      storage.replaceIfVersion('replace', 'v1', { continuationVersion: 'v2' }, -1),
      /positive finite/
    );
  } finally {
    storage.destroy();
  }
});

test('callback wins during trusted-agent resolution before deferred input dispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('callback-wins-during-agent-resolution-token');
  const operationId = 'callback-wins-during-agent-resolution-operation';
  const sellerWorkId = 'callback-wins-during-agent-resolution-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'callback-wins-during-agent-resolution-version',
    }),
    60
  );

  let releaseResolution;
  const resolutionGate = new Promise(resolve => {
    releaseResolution = resolve;
  });
  let markResolutionEntered;
  const resolutionEntered = new Promise(resolve => {
    markResolutionEntered = resolve;
  });
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('a callback winner before dispatch commit must prevent the seller call');
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => {
      markResolutionEntered();
      await resolutionGate;
      return { ...agent, agent_uri: 'https://seller.example/a2a' };
    },
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const resume = executor.resumeDeferredTask(token, { approved: true });
    await resolutionEntered;
    const callback = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      committedTerminalResult(operationId, sellerWorkId, 'callback-resolution-winner-buy')
    );
    assert.ok(callback);
    await acknowledgeDeferredSettlement(callback);
    releaseResolution();
    await assert.rejects(
      resume,
      error =>
        error instanceof DeferredSettlementOwnershipError && /original state was not restored/.test(error.message)
    );
    assert.equal(protocolCalls, 0);

    const replay = await executor.resumeDeferredTask(token, { ignored: 'already-finalized' });
    assert.equal(replay.data.media_buy_id, 'callback-resolution-winner-buy');
    assert.equal(protocolCalls, 0);
  } finally {
    releaseResolution?.();
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('deferred storage read outage is typed ownership and a later retry dispatches exactly once', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('deferred-read-outage-retry-token');
  const operationId = 'deferred-read-outage-retry-operation';
  const sellerWorkId = 'deferred-read-outage-retry-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'deferred-read-outage-retry-version',
    }),
    60
  );

  const storageFailure = new Error('injected deferred storage read outage');
  const originalGet = storage.get.bind(storage);
  let failRead = true;
  storage.get = async key => {
    if (failRead) {
      failRead = false;
      throw storageFailure;
    }
    return originalGet(key);
  };
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return {
      status: 'completed',
      task_id: sellerWorkId,
      media_buy_id: 'deferred-read-outage-retry-buy',
      packages: [],
    };
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      error => error instanceof DeferredSettlementOwnershipError && error.cause === storageFailure
    );
    assert.equal(protocolCalls, 0);
    assert.equal((await originalGet(token)).continuationClaimed, undefined);

    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.data.media_buy_id, 'deferred-read-outage-retry-buy');
    assert.equal(protocolCalls, 1);
  } finally {
    storage.get = originalGet;
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('external callback checkpoint storage outage is sanitized ownership and leaves state retryable', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('external-checkpoint-read-outage-token');
  const operationId = 'external-checkpoint-read-outage-operation';
  const sellerWorkId = 'external-checkpoint-read-outage-work';
  const initialState = committedContinuationState({
    operationId,
    sellerWorkId,
    version: 'external-checkpoint-read-outage-version',
  });
  await storage.putIfAbsent(token, initialState, 60);

  const storageFailure = new Error('redis://secret-host callback read outage');
  const originalGet = storage.get.bind(storage);
  storage.get = async () => {
    throw storageFailure;
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.checkpointExternalDeferredSettlement(
        token,
        operationId,
        committedTerminalResult(operationId, sellerWorkId, 'external-checkpoint-read-outage-buy')
      ),
      error => {
        assert.ok(error instanceof DeferredSettlementOwnershipError);
        assert.strictEqual(error.cause, storageFailure);
        assert.doesNotMatch(error.message, /secret-host/);
        return true;
      }
    );
    assert.deepEqual(await originalGet(token), initialState);
  } finally {
    storage.get = originalGet;
    storage.destroy();
  }
});

test('expiry during trusted-agent resolution is typed ownership after generation-fenced removal', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('expiry-during-resolution-token');
  const operationId = 'expiry-during-resolution-operation';
  const sellerWorkId = 'expiry-during-resolution-work';
  const expiringState = committedContinuationState({
    operationId,
    sellerWorkId,
    version: 'expiry-during-resolution-version',
  });
  expiringState.expiresAt = Date.now() + 50;
  await storage.putIfAbsent(token, expiringState, 60);

  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('an expired admitted continuation must not reach the seller');
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      return { ...agent, agent_uri: 'https://seller.example/a2a' };
    },
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      error =>
        error instanceof DeferredSettlementOwnershipError &&
        /expired during trusted-agent resolution/.test(error.message)
    );
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.get(token), undefined);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('deferred resume reauthorizes the durable route immediately before dispatch commit', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('deferred-route-changes-before-dispatch-token');
  const operationId = 'deferred-route-changes-before-dispatch-operation';
  const sellerWorkId = 'deferred-route-changes-before-dispatch-work';
  const originalState = committedContinuationState({
    operationId,
    sellerWorkId,
    version: 'deferred-route-changes-before-dispatch-version',
  });
  await storage.putIfAbsent(token, originalState, 60);

  let authorizationChecks = 0;
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('route revocation before dispatch commit must prevent the seller call');
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => {
      const admitted = await storage.get(token);
      assert.equal(admitted.continuationClaimed, true);
      assert.equal(admitted.settlementResumeDispatchLease.phase, 'admission');
      authorizationChecks += 1;
      return authorizationChecks === 1;
    },
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(executor.resumeDeferredTask(token, { approved: true }), /no longer the current route/);
    assert.equal(authorizationChecks, 2);
    assert.equal(protocolCalls, 0);
    const restored = await storage.get(token);
    assert.equal(restored.continuationVersion, originalState.continuationVersion);
    assert.equal(restored.continuationClaimed, undefined);
    assert.equal(restored.settlementResumeDispatchLease, undefined);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('authorization loss after the original deadline removes admission instead of extending resume eligibility', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('expired-auth-loss-removes-admission-token');
  const operationId = 'expired-auth-loss-removes-admission-operation';
  const sellerWorkId = 'expired-auth-loss-removes-admission-work';
  const expiringState = committedContinuationState({
    operationId,
    sellerWorkId,
    version: 'expired-auth-loss-removes-admission-version',
  });
  expiringState.expiresAt = Date.now() + 150;
  await storage.putIfAbsent(token, expiringState, 60);

  let authorizationChecks = 0;
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('an expired original continuation must never be reclaimed from the safety-retention fence');
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => {
      authorizationChecks += 1;
      if (authorizationChecks === 2) {
        await new Promise(resolve => setTimeout(resolve, 200));
        return false;
      }
      return true;
    },
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      error => error instanceof DeferredSettlementOwnershipError && /no longer the current route/.test(error.message)
    );
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.get(token), undefined);
    await assert.rejects(executor.resumeDeferredTask(token, { approved: 'must-not-reclaim' }), /not found/);
    assert.equal(protocolCalls, 0);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('pre-dispatch restore storage failure remains typed ownership with the adapter error as cause', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('pre-dispatch-restore-storage-failure-token');
  const operationId = 'pre-dispatch-restore-storage-failure-operation';
  const sellerWorkId = 'pre-dispatch-restore-storage-failure-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'pre-dispatch-restore-storage-failure-version',
    }),
    60
  );
  const storageFailure = new Error('injected pre-dispatch restore storage failure');
  const originalReplace = storage.replaceIfVersion.bind(storage);
  storage.replaceIfVersion = async (key, version, value, ttl) => {
    if (value.continuationClaimed !== true) throw storageFailure;
    return originalReplace(key, version, value, ttl);
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    authorizeDeferredSettlementResume: async () => false,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      error => error instanceof DeferredSettlementOwnershipError && error.cause === storageFailure
    );
  } finally {
    storage.replaceIfVersion = originalReplace;
    storage.destroy();
  }
});

test('expired deferred dispatch admission is reclaimable exactly once', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('expired-dispatch-admission-token');
  const operationId = 'expired-dispatch-admission-operation';
  const sellerWorkId = 'expired-dispatch-admission-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'expired-dispatch-admission-version',
      dispatchLease: {
        ownerId: 'crashed-admission-owner',
        phase: 'admission',
        expiresAt: Date.now() - 1,
      },
    }),
    60
  );

  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return {
      status: 'completed',
      task_id: sellerWorkId,
      media_buy_id: 'reclaimed-admission-buy',
      packages: [],
    };
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.data.media_buy_id, 'reclaimed-admission-buy');
    assert.equal(protocolCalls, 1);
    const replay = await executor.resumeDeferredTask(token, { ignored: 'finalized' });
    assert.equal(replay.data.media_buy_id, 'reclaimed-admission-buy');
    assert.equal(protocolCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('dispatch-committed deferred continuation never redispatches and accepts a later callback', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('dispatch-committed-no-redispatch-token');
  const operationId = 'dispatch-committed-no-redispatch-operation';
  const sellerWorkId = 'dispatch-committed-no-redispatch-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'dispatch-committed-no-redispatch-version',
      dispatchLease: {
        ownerId: 'uncertain-dispatch-owner',
        phase: 'dispatch-committed',
        expiresAt: Date.now() - 1,
      },
    }),
    60
  );

  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('dispatch-committed input must never be sent a second time');
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      error => error instanceof DeferredSettlementOwnershipError && /already being resumed/.test(error.message)
    );
    assert.equal(protocolCalls, 0);
    const callback = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      committedTerminalResult(operationId, sellerWorkId, 'uncertain-dispatch-callback-buy')
    );
    assert.ok(callback);
    await acknowledgeDeferredSettlement(callback);
    const replay = await executor.resumeDeferredTask(token, { ignored: 'callback-finalized' });
    assert.equal(replay.data.media_buy_id, 'uncertain-dispatch-callback-buy');
    assert.equal(protocolCalls, 0);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('immediate deferred callback can finalize after dispatch commit without deadlocking the seller response', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('immediate-callback-after-dispatch-commit-token');
  const operationId = 'immediate-callback-after-dispatch-commit-operation';
  const sellerWorkId = 'immediate-callback-after-dispatch-commit-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'immediate-callback-after-dispatch-commit-version',
    }),
    60
  );

  let executor;
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    const terminal = committedTerminalResult(operationId, sellerWorkId, 'immediate-callback-buy');
    terminal.data = {
      status: 'completed',
      task_id: sellerWorkId,
      media_buy_id: 'immediate-callback-buy',
      packages: [],
    };
    const callback = await executor.checkpointExternalDeferredSettlement(token, operationId, terminal);
    assert.ok(callback);
    await acknowledgeDeferredSettlement(callback);
    return {
      status: 'completed',
      task_id: sellerWorkId,
      media_buy_id: 'immediate-callback-buy',
      packages: [],
    };
  };
  executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.data.media_buy_id, 'immediate-callback-buy');
    assert.equal(protocolCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

for (const responseStatus of ['submitted', 'working']) {
  test(`webhook-first deferred completion converges when the seller response is ${responseStatus}`, async () => {
    const originalCallTool = ProtocolClient.callTool;
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = testDurableToken(`webhook-first-${responseStatus}-response-token`);
    const operationId = `webhook-first-${responseStatus}-response-operation`;
    const sellerWorkId = `webhook-first-${responseStatus}-response-work`;
    await storage.putIfAbsent(
      token,
      committedContinuationState({
        operationId,
        sellerWorkId,
        version: `webhook-first-${responseStatus}-response-version`,
      }),
      60
    );

    let executor;
    let protocolCalls = 0;
    ProtocolClient.callTool = async () => {
      protocolCalls += 1;
      const callback = await executor.checkpointExternalDeferredSettlement(
        token,
        operationId,
        committedTerminalResult(operationId, sellerWorkId, `webhook-first-${responseStatus}-buy`)
      );
      assert.ok(callback);
      await acknowledgeDeferredSettlement(callback);
      return { status: responseStatus, task_id: sellerWorkId };
    };
    executor = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
      authorizeDeferredSettlementResume: async () => true,
      canRecoverDeferredSettlement: async () => true,
      recoverDeferredSettlement: async result => ({ result }),
      validation: { requests: 'off', responses: 'off' },
    });

    try {
      const completed = await executor.resumeDeferredTask(token, { approved: true });
      assert.equal(completed.status, 'completed');
      assert.equal(completed.data.media_buy_id, `webhook-first-${responseStatus}-buy`);
      assert.equal(protocolCalls, 1);
    } finally {
      ProtocolClient.callTool = originalCallTool;
      storage.destroy();
    }
  });
}

test('active callback finalization remains typed contention and replays after acknowledgement', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('active-callback-finalizer-contention-token');
  const operationId = 'active-callback-finalizer-contention-operation';
  const sellerWorkId = 'active-callback-finalizer-contention-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'active-callback-finalizer-contention-version',
    }),
    60
  );

  let executor;
  let callback;
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    callback = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      committedTerminalResult(operationId, sellerWorkId, 'active-callback-finalizer-buy')
    );
    assert.ok(callback);
    return { status: 'submitted', task_id: sellerWorkId };
  };
  executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      error =>
        error instanceof DeferredSettlementOwnershipError && /finalization is already in progress/.test(error.message)
    );
    assert.equal(protocolCalls, 1);
    await acknowledgeDeferredSettlement(callback);
    const replay = await executor.resumeDeferredTask(token, { ignored: 'finalized' });
    assert.equal(replay.data.media_buy_id, 'active-callback-finalizer-buy');
    assert.equal(protocolCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('finalized acknowledgement rejects handler-mutated seller identity and leaves an exact retry', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('finalized-handler-mutated-seller-id-token');
  const operationId = 'finalized-handler-mutated-seller-id-operation';
  const sellerWorkId = 'finalized-handler-mutated-seller-id-work';
  const exactTerminal = committedTerminalResult(operationId, sellerWorkId, 'finalized-handler-mutated-seller-id-buy');
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'finalized-handler-mutated-seller-id-version',
    }),
    60
  );
  const executor = new TaskExecutor({
    deferredStorage: storage,
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const mutated = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      structuredClone(exactTerminal)
    );
    assert.ok(mutated);
    mutated.metadata.serverTaskId = 'handler-mutated-conflicting-work';
    await assert.rejects(acknowledgeDeferredSettlement(mutated), /changed its bound seller task identity/);
    const retryable = await storage.get(token);
    assert.equal(retryable.settlementFinalizedResult, undefined);
    assert.equal(retryable.settlementFinalizationLease, undefined);
    assert.equal(retryable.settlementTerminalResult.metadata.serverTaskId, sellerWorkId);

    const retry = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      structuredClone(exactTerminal)
    );
    assert.ok(retry);
    delete retry.metadata.serverTaskId;
    await acknowledgeDeferredSettlement(retry);
    assert.equal(retry.metadata.serverTaskId, sellerWorkId);
    const replay = await executor.resumeDeferredTask(token, { ignored: true });
    assert.equal(replay.metadata.serverTaskId, sellerWorkId);
    assert.equal(replay.data.media_buy_id, 'finalized-handler-mutated-seller-id-buy');
  } finally {
    storage.destroy();
  }
});

test('finalization acknowledgement storage failures are typed and preserve a retryable terminal checkpoint', async () => {
  for (const failurePoint of ['get', 'cas']) {
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = testDurableToken(`finalization-${failurePoint}-failure-token`);
    const operationId = `finalization-${failurePoint}-failure-operation`;
    const sellerWorkId = `finalization-${failurePoint}-failure-work`;
    const terminal = committedTerminalResult(operationId, sellerWorkId, `finalization-${failurePoint}-failure-buy`);
    await storage.putIfAbsent(
      token,
      committedContinuationState({
        operationId,
        sellerWorkId,
        version: `finalization-${failurePoint}-failure-version`,
      }),
      60
    );
    const executor = new TaskExecutor({
      deferredStorage: storage,
      validation: { requests: 'off', responses: 'off' },
    });
    const checkpointed = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      structuredClone(terminal)
    );
    assert.ok(checkpointed);
    const storageFailure = new Error(`injected finalization ${failurePoint} failure`);
    const originalGet = storage.get.bind(storage);
    const originalReplace = storage.replaceIfVersion.bind(storage);
    if (failurePoint === 'get') {
      let failNextGet = true;
      storage.get = async key => {
        if (failNextGet) {
          failNextGet = false;
          throw storageFailure;
        }
        return originalGet(key);
      };
    } else {
      let failNextFinalizedCas = true;
      storage.replaceIfVersion = async (key, version, value, ttl) => {
        if (failNextFinalizedCas && value.settlementFinalizedResult !== undefined) {
          failNextFinalizedCas = false;
          return false;
        }
        return originalReplace(key, version, value, ttl);
      };
    }

    try {
      await assert.rejects(
        acknowledgeDeferredSettlement(checkpointed),
        error =>
          error instanceof DeferredSettlementOwnershipError &&
          (failurePoint === 'get' ? error.cause === storageFailure : /ownership changed/.test(error.message))
      );
      const retryable = await originalGet(token);
      assert.equal(retryable.settlementTerminalResult.data.media_buy_id, `finalization-${failurePoint}-failure-buy`);
      assert.equal(retryable.settlementFinalizationLease, undefined);
      assert.equal(retryable.settlementFinalizedResult, undefined);

      storage.get = originalGet;
      storage.replaceIfVersion = originalReplace;
      const retry = await executor.checkpointExternalDeferredSettlement(token, operationId, structuredClone(terminal));
      assert.ok(retry);
      await acknowledgeDeferredSettlement(retry);
      assert.equal((await originalGet(token)).settlementFinalizedResult.data.media_buy_id, terminal.data.media_buy_id);
    } finally {
      storage.get = originalGet;
      storage.replaceIfVersion = originalReplace;
      storage.destroy();
    }
  }
});

test('finalization lease release storage failure is typed with the adapter error as its cause', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('finalization-release-storage-failure-token');
  const operationId = 'finalization-release-storage-failure-operation';
  const sellerWorkId = 'finalization-release-storage-failure-work';
  const terminal = committedTerminalResult(operationId, sellerWorkId, 'finalization-release-storage-failure-buy');
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'finalization-release-storage-failure-version',
    }),
    60
  );
  const executor = new TaskExecutor({
    deferredStorage: storage,
    validation: { requests: 'off', responses: 'off' },
  });
  const checkpointed = await executor.checkpointExternalDeferredSettlement(
    token,
    operationId,
    structuredClone(terminal)
  );
  assert.ok(checkpointed);
  const storageFailure = new Error('injected finalization release storage failure');
  const originalReplace = storage.replaceIfVersion.bind(storage);
  storage.replaceIfVersion = async (key, version, value, ttl) => {
    if (value.settlementFinalizationLease === undefined && value.settlementFinalizedResult === undefined) {
      throw storageFailure;
    }
    return originalReplace(key, version, value, ttl);
  };

  try {
    await assert.rejects(
      rejectDeferredSettlement(checkpointed),
      error => error instanceof DeferredSettlementOwnershipError && error.cause === storageFailure
    );
  } finally {
    storage.replaceIfVersion = originalReplace;
    storage.destroy();
  }
});

test('terminal continuation binds trusted seller work identity independently of its A2A task ID', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('trusted-terminal-task-binding-token');
  const operationId = 'trusted-terminal-task-binding-operation';
  const sellerWorkId = 'trusted-terminal-seller-work';
  const a2aTaskId = `${operationId}-a2a-task`;
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'trusted-terminal-task-binding-version',
    }),
    60
  );

  let recoveredServerTaskId;
  let recoveredMetadataServerTaskId;
  ProtocolClient.callTool = async (_resolvedAgent, _taskName, _params, options) => {
    assert.equal(options.session.taskId, a2aTaskId);
    return {
      status: 'completed',
      media_buy_id: 'trusted-terminal-task-binding-buy',
      packages: [],
    };
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async (result, _recoveredOperationId, serverTaskId) => {
      recoveredServerTaskId = serverTaskId;
      recoveredMetadataServerTaskId = result.metadata.serverTaskId;
      return { result };
    },
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.metadata.serverTaskId, sellerWorkId);
    assert.equal(recoveredServerTaskId, sellerWorkId);
    assert.equal(recoveredMetadataServerTaskId, sellerWorkId);
    const finalized = await storage.get(token);
    assert.equal(finalized.settlementTerminalResult.metadata.serverTaskId, sellerWorkId);
    assert.equal(finalized.settlementFinalizedResult.metadata.serverTaskId, sellerWorkId);

    const exactCallback = structuredClone(finalized.settlementTerminalResult);
    assert.equal(await executor.checkpointExternalDeferredSettlement(token, operationId, exactCallback), undefined);
    const replay = await executor.resumeDeferredTask(token, { ignored: 'exact-replay' });
    assert.equal(replay.metadata.serverTaskId, sellerWorkId);
    await assert.rejects(
      executor.checkpointExternalDeferredSettlement(token, operationId, {
        ...exactCallback,
        metadata: { ...exactCallback.metadata, serverTaskId: a2aTaskId },
      }),
      /changed its bound seller task identity/
    );
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('replacement pause cannot change the committed seller work identity', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('replacement-pause-seller-id-conflict-token');
  const operationId = 'replacement-pause-seller-id-conflict-operation';
  const sellerWorkId = 'replacement-pause-seller-id-conflict-work';
  const conflictingWorkId = 'replacement-pause-conflicting-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'replacement-pause-seller-id-conflict-version',
    }),
    60
  );
  ProtocolClient.callTool = async () => ({
    result: {
      kind: 'task',
      id: 'replacement-pause-next-a2a-task',
      contextId: 'replacement-pause-next-context',
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          messageId: 'replacement-pause-question',
          role: 'agent',
          parts: [{ kind: 'data', data: { status: 'input-required', question: 'Approve again?' } }],
        },
      },
      artifacts: [
        {
          artifactId: 'replacement-pause-artifact',
          metadata: { adcp_task_id: conflictingWorkId },
          parts: [],
        },
      ],
    },
  });
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      /changed its bound seller task identity/
    );
    const retained = await storage.get(token);
    assert.equal(retained.settlementServerTaskId, sellerWorkId);
    assert.equal(retained.settlementResumeDispatchLease.phase, 'dispatch-committed');
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('nested committed pause without a repeated work ID retains the trusted seller identity', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('nested-pause-omitted-seller-id-token');
  const operationId = 'nested-pause-omitted-seller-id-operation';
  const sellerWorkId = 'nested-pause-omitted-seller-id-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'nested-pause-omitted-seller-id-version',
    }),
    60
  );
  ProtocolClient.callTool = async () => ({
    result: {
      kind: 'task',
      id: 'nested-pause-next-a2a-task',
      contextId: 'nested-pause-next-context',
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          messageId: 'nested-pause-next-question',
          role: 'agent',
          parts: [{ kind: 'data', data: { status: 'input-required', question: 'Approve again?' } }],
        },
      },
      artifacts: [],
    },
  });
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    replaceDeferredSettlementResumeToken: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const paused = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(paused.status, 'input-required');
    assert.equal(paused.metadata.serverTaskId, sellerWorkId);
    assert.ok(paused.deferred);
    const replacement = await storage.get(paused.deferred.token);
    assert.equal(replacement.settlementServerTaskId, sellerWorkId);
    assert.equal(replacement.a2aTaskId, 'nested-pause-next-a2a-task');
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

for (const responseStatus of ['working', 'submitted']) {
  test(`committed ${responseStatus} response without a repeated work ID exposes the trusted seller identity`, async () => {
    const originalCallTool = ProtocolClient.callTool;
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = testDurableToken(`${responseStatus}-omitted-seller-id-token`);
    const operationId = `${responseStatus}-omitted-seller-id-operation`;
    const sellerWorkId = `${responseStatus}-omitted-seller-id-work`;
    await storage.putIfAbsent(
      token,
      committedContinuationState({
        operationId,
        sellerWorkId,
        version: `${responseStatus}-omitted-seller-id-version`,
      }),
      60
    );

    const calls = [];
    ProtocolClient.callTool = async (_resolvedAgent, taskName, params) => {
      calls.push({ taskName, params });
      if (calls.length === 1) return { status: responseStatus };
      assert.equal(taskName, 'tasks/get');
      assert.deepEqual(params, { task_id: sellerWorkId, include_result: true });
      return {
        task_id: sellerWorkId,
        task_type: 'create_media_buy',
        status: 'completed',
        result: { media_buy_id: `${responseStatus}-omitted-seller-id-buy`, packages: [] },
      };
    };
    const executor = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
      authorizeDeferredSettlementResume: async () => true,
      canRecoverDeferredSettlement: async () => true,
      recoverDeferredSettlement: async result => ({ result }),
      validation: { requests: 'off', responses: 'off' },
    });

    try {
      const pending = await executor.resumeDeferredTaskFromLiveClosure(token, { approved: true }, false);
      assert.equal(pending.status, responseStatus);
      assert.equal(pending.metadata.serverTaskId, sellerWorkId);
      const checkpoint = await storage.get(token);
      assert.equal(checkpoint.settlementPendingTaskId, sellerWorkId);
      assert.equal(checkpoint.settlementServerTaskId, sellerWorkId);

      if (responseStatus === 'submitted') {
        assert.equal(pending.submitted.taskId, sellerWorkId);
        const tracked = await pending.submitted.track();
        assert.equal(tracked.taskId, sellerWorkId);
        assert.equal(calls.length, 2);
        assert.equal((await storage.get(token)).settlementTerminalResult.metadata.serverTaskId, sellerWorkId);
      } else {
        assert.equal(calls.length, 1);
      }
    } finally {
      ProtocolClient.callTool = originalCallTool;
      storage.destroy();
    }
  });
}

for (const responseStatus of ['working', 'submitted']) {
  test(`committed ${responseStatus} response cannot replace the trusted seller work identity`, async () => {
    const originalCallTool = ProtocolClient.callTool;
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = testDurableToken(`${responseStatus}-seller-id-conflict-token`);
    const operationId = `${responseStatus}-seller-id-conflict-operation`;
    const sellerWorkId = `${responseStatus}-seller-id-conflict-work`;
    const conflictingWorkId = `${responseStatus}-conflicting-work`;
    await storage.putIfAbsent(
      token,
      committedContinuationState({
        operationId,
        sellerWorkId,
        version: `${responseStatus}-seller-id-conflict-version`,
      }),
      60
    );
    ProtocolClient.callTool = async () => ({ status: responseStatus, task_id: conflictingWorkId });
    const executor = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
      authorizeDeferredSettlementResume: async () => true,
      canRecoverDeferredSettlement: async () => true,
      recoverDeferredSettlement: async result => ({ result }),
      validation: { requests: 'off', responses: 'off' },
    });

    try {
      await assert.rejects(
        executor.resumeDeferredTask(token, { approved: true }),
        /changed its bound seller task identity/
      );
      const retained = await storage.get(token);
      assert.equal(retained.settlementServerTaskId, sellerWorkId);
      assert.equal(retained.settlementPendingTaskId, undefined);
      assert.equal(retained.settlementResumeDispatchLease.phase, 'dispatch-committed');
    } finally {
      ProtocolClient.callTool = originalCallTool;
      storage.destroy();
    }
  });
}

test('submitted fallback correlation ID is never persisted as seller work identity', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('submitted-local-fallback-not-seller-work-token');
  const operationId = 'submitted-local-fallback-not-seller-work-operation';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId: undefined,
      version: 'submitted-local-fallback-not-seller-work-version',
    }),
    60
  );
  ProtocolClient.callTool = async () => ({ status: 'submitted' });
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      /without the seller work handle required for recovery/
    );
    const retained = await storage.get(token);
    assert.equal(retained.settlementServerTaskId, undefined);
    assert.equal(retained.settlementPendingTaskId, undefined);
    assert.equal(retained.settlementResumeDispatchLease.phase, 'dispatch-committed');
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('transport uncertainty retains the dispatch-committed fence for callback recovery', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('transport-uncertainty-dispatch-fence-token');
  const operationId = 'transport-uncertainty-dispatch-fence-operation';
  const sellerWorkId = 'transport-uncertainty-dispatch-fence-work';
  await storage.putIfAbsent(
    token,
    committedContinuationState({
      operationId,
      sellerWorkId,
      version: 'transport-uncertainty-dispatch-fence-version',
    }),
    60
  );

  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    throw new Error('transport response lost after seller dispatch');
  };
  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    authorizeDeferredSettlementResume: async () => true,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: true }),
      /transport response lost after seller dispatch/
    );
    const uncertain = await storage.get(token);
    assert.equal(uncertain.continuationClaimed, true);
    assert.equal(uncertain.settlementResumeDispatchLease.phase, 'dispatch-committed');
    await assert.rejects(
      executor.resumeDeferredTask(token, { approved: 'must-not-repeat' }),
      error => error instanceof DeferredSettlementOwnershipError && /already being resumed/.test(error.message)
    );
    assert.equal(protocolCalls, 1);

    const callback = await executor.checkpointExternalDeferredSettlement(
      token,
      operationId,
      committedTerminalResult(operationId, sellerWorkId, 'transport-uncertainty-callback-buy')
    );
    assert.ok(callback);
    await acknowledgeDeferredSettlement(callback);
    const replay = await executor.resumeDeferredTask(token, { ignored: 'finalized' });
    assert.equal(replay.data.media_buy_id, 'transport-uncertainty-callback-buy');
    assert.equal(protocolCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('SingleAgentClient resolves the canonical A2A endpoint before resuming after restart', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let calls = 0;
  ProtocolClient.callTool = async (resolvedAgent, taskName, params, options) => {
    calls += 1;
    if (calls === 1) {
      return {
        result: {
          kind: 'task',
          id: 'seller-durable-task',
          contextId: 'seller-durable-context',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'seller-question',
              role: 'agent',
              parts: [{ kind: 'data', data: { question: 'Approve?', field: 'approval' } }],
            },
          },
          artifacts: [],
        },
      };
    }
    assert.equal(resolvedAgent.agent_uri, 'https://seller.example/a2a');
    assert.equal(taskName, 'create_media_buy');
    assert.deepEqual(params, { input: { approved: true } });
    assert.deepEqual(options.session, {
      contextId: 'seller-durable-context',
      taskId: 'seller-durable-task',
    });
    return { status: 'completed', data: { approved: true } };
  };

  try {
    const first = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    const paused = await first.executor.executeTask(
      agent,
      'create_media_buy',
      {
        idempotency_key: 'single-agent-durable-pause-key',
        account: { account_id: 'account-1' },
      },
      async () => ({
        defer: true,
        token: testDurableToken('single-agent-durable-token'),
      }),
      { skipIdempotencyAutoInject: true, skipAccountValidation: true }
    );
    assert.equal(paused.status, 'deferred', paused.error);

    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    let canonicalResolutions = 0;
    restarted.ensureCanonicalUrlResolved = async () => {
      canonicalResolutions += 1;
      return { ...agent, agent_uri: 'https://seller.example/a2a' };
    };
    const resumed = await restarted.resumeDeferredTask(paused.deferred.token, { approved: true });
    assert.equal(resumed.status, 'completed');
    assert.equal(calls, 2);
    assert.equal(canonicalResolutions, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('SingleAgentClient discovers the current MCP endpoint before resuming persisted state', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('mcp-discovered-durable-token');
  const now = Date.now();
  const mcpAgent = {
    id: 'mcp-durable-resume-agent',
    name: 'MCP durable resume agent',
    agent_uri: 'https://seller.example',
    protocol: 'mcp',
  };
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'mcp-discovered-version',
      taskId: 'client-correlation-id',
      contextId: 'seller-context-id',
      a2aTaskId: 'seller-task-id',
      serverVersion: 'v3',
      agentId: mcpAgent.id,
      taskName: 'create_media_buy',
      params: { idempotency_key: 'durable-mcp-resume-key' },
      messages: [],
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let discoveryCalls = 0;
  ProtocolClient.callTool = async () => {
    assert.fail('MCP persisted pauses must fail before continuation dispatch');
  };

  try {
    const restarted = new SingleAgentClient(mcpAgent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    restarted.ensureEndpointDiscovered = async () => {
      discoveryCalls += 1;
      return { ...mcpAgent, agent_uri: 'https://seller.example/oauth/mcp' };
    };
    await assert.rejects(
      restarted.resumeDeferredTask(token, { approved: true }),
      /can only resume an exact A2A seller task/
    );
    assert.equal(discoveryCalls, 1);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('restart resume preserves v2 wire identity and re-enters canonical policy and handler finalization', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const v2Agent = {
    id: 'v2-canonical-resume-agent',
    name: 'V2 canonical resume agent',
    agent_uri: 'https://seller.example/.well-known/agent-card.json',
    protocol: 'a2a',
  };
  const canonicalAgent = { ...v2Agent, agent_uri: 'https://seller.example/a2a' };
  const legacyDisplayRef = {
    agent_url: 'https://formats.seller.example/mcp',
    id: 'seller_display_300x250',
  };
  const projectionCatalog = (formatOptionId, publisherDomain) => ({
    source: 'configured',
    publisher_domain: publisherDomain,
    formats: [
      {
        format_kind: 'display_tag',
        format_option_id: formatOptionId,
        params: { width: 300, height: 250 },
        v1_format_ref: [legacyDisplayRef],
      },
    ],
  });
  const statusResults = [];
  let calls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName, params, options) => {
    calls += 1;
    assert.equal(taskName, 'get_products');
    assert.equal(options.serverVersion, 'v2');
    if (calls === 1) {
      return {
        result: {
          kind: 'task',
          id: 'seller-v2-task',
          contextId: 'seller-v2-context',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'seller-v2-question',
              role: 'agent',
              parts: [{ kind: 'data', data: { question: 'Approve catalog?', field: 'approval' } }],
            },
          },
          artifacts: [],
        },
      };
    }
    assert.deepEqual(params, { input: { approved: true } });
    return {
      result: {
        kind: 'task',
        id: 'seller-v2-task',
        contextId: 'seller-v2-context',
        status: { state: 'completed' },
        artifacts: [
          {
            artifactId: 'get-products-result',
            parts: [
              {
                kind: 'data',
                data: {
                  success: true,
                  products: [
                    {
                      product_id: 'kept-product',
                      name: 'Kept product',
                      description: 'Has a transactable price',
                      publisher_properties: [{ publisher_domain: 'seller.example', selection_type: 'all' }],
                      format_ids: [legacyDisplayRef],
                      delivery_type: 'guaranteed',
                      delivery_measurement: { provider: 'first-party' },
                      pricing_options: [
                        {
                          pricing_option_id: 'po-cpm',
                          pricing_model: 'cpm',
                          rate: 5,
                          currency: 'USD',
                          is_fixed: true,
                        },
                      ],
                      reporting_capabilities: {
                        available_reporting_frequencies: ['daily'],
                        expected_delay_minutes: 60,
                        timezone: 'UTC',
                        supports_webhooks: false,
                        available_metrics: ['impressions'],
                        date_range_support: 'date_range',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
  };

  const config = {
    deferredStorage: storage,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'strict', rejectProductsWithoutPricingOptions: true },
    handlers: {
      onGetProductsStatusChange: data => statusResults.push(data),
    },
    projectionCatalogs: [projectionCatalog('configured-display', 'configured.example')],
  };

  try {
    const first = new SingleAgentClient(v2Agent, config);
    first.ensureEndpointDiscovered = async () => canonicalAgent;
    first.detectServerVersion = async () => 'v2';
    first.getEarlyResultForUnsupportedFeatures = async () => null;
    const perCallProjectionCatalogs = [projectionCatalog('per-call-display', 'per-call.example')];
    const paused = await first.getProducts(
      {
        buying_mode: 'brief',
        brief: 'Find display inventory',
        account: { account_id: 'account-1' },
      },
      async () => ({
        defer: true,
        token: testDurableToken('v2-canonical-resume-token'),
      }),
      { projectionCatalogs: perCallProjectionCatalogs }
    );
    assert.equal(paused.status, 'deferred');
    assert.equal(statusResults.length, 0);
    perCallProjectionCatalogs[0].publisher_domain = 'mutated-after-dispatch.example';
    const persisted = await storage.get(paused.deferred.token);
    assert.equal(persisted.clientContext.projectionCatalogs[0].publisher_domain, 'per-call.example');

    const restarted = new SingleAgentClient(v2Agent, config);
    restarted.ensureCanonicalUrlResolved = async () => canonicalAgent;
    const resumed = await restarted.resumeDeferredTask(paused.deferred.token, { approved: true });

    assert.equal(resumed.status, 'completed');
    assert.ok(Array.isArray(resumed.data?.products), JSON.stringify(resumed));
    assert.equal(resumed.data.products.length, 1);
    assert.equal(resumed.data.products[0].product_id, 'kept-product');
    assert.equal(resumed.data.products[0].format_ids, undefined);
    assert.equal(resumed.data.products[0].format_options[0].format_kind, 'display_tag');
    assert.equal(resumed.data.products[0].format_options[0].format_option_id, 'per-call-display');
    assert.equal(resumed.data.products[0].format_options[0].publisher_domain, 'per-call.example');
    assert.equal(statusResults.length, 1);
    assert.equal(statusResults[0].products[0].format_ids, undefined);

    const selectedOption = resumed.data.products[0].format_options[0];
    let capturedPurchase;
    restarted.getCapabilities = async () => ({ features: { canonicalCreatives: false } });
    restarted.executeAndHandle = async (_taskName, _handlerName, wireParams) => {
      capturedPurchase = wireParams;
      return { success: true, status: 'completed', data: { media_buy_id: 'mb-after-resume', packages: [] } };
    };
    await restarted.createMediaBuy({
      account: { account_id: 'account-1' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          buyer_ref: 'pkg-after-resume',
          product_id: resumed.data.products[0].product_id,
          pricing_option_id: 'po-cpm',
          budget: 1000,
          format_option_refs: [
            {
              scope: selectedOption.publisher_domain ? 'publisher' : 'product',
              ...(selectedOption.publisher_domain && { publisher_domain: selectedOption.publisher_domain }),
              format_option_id: selectedOption.format_option_id,
            },
          ],
        },
      ],
    });
    assert.equal(capturedPurchase.packages[0].format_option_refs, undefined);
    assert.deepEqual(capturedPurchase.packages[0].format_ids, [legacyDisplayRef]);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('durable clients reject non-serializable per-call projection converters before dispatch', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      client.getProducts({ buying_mode: 'brief', brief: 'Find display inventory' }, undefined, {
        legacyFormatConverter: () => undefined,
      }),
      /cannot be used with durable deferredStorage/
    );
  } finally {
    storage.destroy();
  }
});

test('durable clients reject authenticated property-list verification before seller dispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('unsupported durable property-list credentials must fail before seller dispatch');
  };
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      client.getProducts({
        buying_mode: 'brief',
        brief: 'Find private inventory',
        property_list: {
          agent_url: 'https://property-lists.example/mcp',
          list_id: 'private-list',
          auth_token: 'private-list-secret',
        },
      }),
      error => {
        assert.match(error.message, /cannot persist property_list\.auth_token/);
        assert.doesNotMatch(error.message, /private-list-secret/);
        return true;
      }
    );
    assert.equal(protocolCalls, 0);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('durable property-list requests own nested input before asynchronous preflight', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let releasePreflight;
  let preflightStarted;
  const preflightGate = new Promise(resolve => {
    releasePreflight = resolve;
  });
  const preflightEntered = new Promise(resolve => {
    preflightStarted = resolve;
  });
  const originalTrustedFetch = async () => new Response();
  ProtocolClient.callTool = async (_resolvedAgent, taskName, params, options) => {
    assert.equal(taskName, 'get_products');
    assert.equal(params.property_list.auth_token, undefined);
    assert.equal(options.transport.allowPrivateIp, false);
    assert.equal(options.transport.maxResponseBytes, 2048);
    assert.equal(options.transport.trustedFetchFn, originalTrustedFetch);
    return {
      result: {
        kind: 'task',
        id: 'nested-request-snapshot-task',
        contextId: 'nested-request-snapshot-context',
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            messageId: 'nested-request-snapshot-question',
            role: 'agent',
            parts: [{ kind: 'data', data: { question: 'Approve?', field: 'approval' } }],
          },
        },
        artifacts: [],
      },
    };
  };
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.validateTaskFeatures = async () => {
      preflightStarted();
      await preflightGate;
    };
    client.getEarlyResultForUnsupportedFeatures = async () => null;
    client.ensureEndpointDiscovered = async () => agent;
    client.detectServerVersion = async () => 'v3';
    const request = {
      buying_mode: 'brief',
      brief: 'Find inventory',
      property_list: {
        agent_url: 'https://property-lists.example/mcp',
        list_id: 'public-list',
      },
    };
    const taskOptions = {
      transport: {
        allowPrivateIp: false,
        maxResponseBytes: 2048,
        trustedFetchFn: originalTrustedFetch,
      },
    };
    const pending = client.getProducts(
      request,
      async () => ({
        defer: true,
        token: testDurableToken('nested-request-snapshot-token'),
      }),
      taskOptions
    );
    await preflightEntered;
    request.property_list.auth_token = 'late-caller-secret';
    taskOptions.transport.allowPrivateIp = true;
    taskOptions.transport.maxResponseBytes = 999999;
    taskOptions.transport.trustedFetchFn = async () => new Response('mutated');
    releasePreflight();
    const paused = await pending;
    assert.equal(paused.status, 'deferred');
    assert.doesNotMatch(JSON.stringify(await storage.get(paused.deferred.token)), /late-caller-secret/);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('resumed v2 submitted continuations keep v2 polling semantics', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('v2-resumed-submitted-token');
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'v2-submitted-version',
      taskId: 'client-v2-submitted-correlation',
      contextId: 'seller-v2-submitted-context',
      a2aTaskId: 'seller-v2-submitted-a2a-task',
      serverVersion: 'v2',
      agentId: agent.id,
      taskName: 'get_products',
      params: { buying_mode: 'brief', brief: 'Display' },
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'get_products',
        handlerName: 'onGetProductsStatusChange',
        canonical: true,
        productPolicyRequest: { account: { account_id: 'account-submitted' } },
      },
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let calls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName, _params, options) => {
    calls += 1;
    assert.equal(options.serverVersion, 'v2');
    if (calls === 1) {
      assert.equal(taskName, 'get_products');
      return { status: 'submitted', task_id: 'seller-v2-work-handle' };
    }
    assert.equal(taskName, 'tasks/get');
    return {
      task_id: 'seller-v2-work-handle',
      task_type: 'get_products',
      status: 'completed',
      result: {
        success: true,
        products: [
          {
            product_id: 'submitted-product',
            name: 'Submitted product',
            description: 'Legacy product completed through polling',
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
            pricing_options: [
              { pricing_option_id: 'submitted-price', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 },
            ],
          },
        ],
      },
      created_at: now,
      updated_at: now,
    };
  };

  try {
    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    restarted.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    const submitted = await restarted.resumeDeferredTask(token, { approved: true });
    assert.equal(submitted.status, 'submitted');
    const completed = await submitted.submitted.waitForCompletion(0);
    assert.equal(completed.status, 'completed');
    const selected = completed.data.products[0].format_options[0];
    let capturedPurchase;
    restarted.getCapabilities = async () => ({ features: { canonicalCreatives: false } });
    restarted.executeAndHandle = async (_taskName, _handlerName, wireParams) => {
      capturedPurchase = wireParams;
      return { success: true, status: 'completed', data: { media_buy_id: 'submitted-follow-on', packages: [] } };
    };
    await restarted.createMediaBuy({
      account: { account_id: 'account-submitted' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          product_id: 'submitted-product',
          pricing_option_id: 'submitted-price',
          budget: 1000,
          format_option_refs: [
            {
              scope: selected.publisher_domain ? 'publisher' : 'product',
              ...(selected.publisher_domain && { publisher_domain: selected.publisher_domain }),
              format_option_id: selected.format_option_id,
            },
          ],
        },
      ],
    });
    assert.equal(capturedPurchase.packages[0].format_option_refs, undefined);
    assert.deepEqual(capturedPurchase.packages[0].format_ids, [
      { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' },
    ]);
    assert.equal(calls, 2);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('canonical mutation snapshots projection catalogs before capability preflight awaits', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const legacyRef = { agent_url: 'https://formats.example/mcp', id: 'legacy-display' };
  const catalogs = [
    {
      source: 'configured',
      publisher_domain: 'before-await.example',
      formats: [
        {
          format_kind: 'display',
          format_option_id: 'before-await-option',
          params: { width: 300, height: 250 },
          v1_format_ref: [legacyRef],
        },
      ],
    },
  ];
  let releaseCapabilities;
  let capabilityStarted;
  const capabilitiesStarted = new Promise(resolve => {
    capabilityStarted = resolve;
  });
  const capabilityGate = new Promise(resolve => {
    releaseCapabilities = resolve;
  });

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.getCapabilities = async () => {
      capabilityStarted();
      await capabilityGate;
      return { features: { canonicalCreatives: true } };
    };
    let capturedConverter;
    let capturedCatalogs;
    let capturedWireParams;
    let capturedCanonicalRequest;
    client.executeAndHandle = async (
      _task,
      _handler,
      wireParams,
      _input,
      _options,
      _transform,
      converter,
      canonicalRequest,
      projectionCatalogs
    ) => {
      capturedConverter = converter;
      capturedCatalogs = projectionCatalogs;
      capturedWireParams = wireParams;
      capturedCanonicalRequest = canonicalRequest;
      return { success: true, status: 'completed', data: { media_buy_id: 'snapshot-buy', packages: [] } };
    };

    const request = {
      account: { account_id: 'account-1' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          product_id: 'product-1',
          pricing_option_id: 'price-1',
          budget: 1000,
          format_option_refs: [
            {
              scope: 'publisher',
              publisher_domain: 'before-await.example',
              format_option_id: 'before-await-option',
            },
          ],
        },
      ],
    };
    const pending = client.createMediaBuy(request, undefined, { projectionCatalogs: catalogs });
    await capabilitiesStarted;
    catalogs[0].publisher_domain = 'mutated-during-await.example';
    catalogs[0].formats[0].format_option_id = 'mutated-during-await-option';
    request.packages[0].budget = 999999;
    request.packages[0].format_option_refs[0].format_option_id = 'mutated-commercial-option';
    releaseCapabilities();
    await pending;

    assert.equal(capturedCatalogs[0].publisher_domain, 'before-await.example');
    assert.equal(capturedCatalogs[0].formats[0].format_option_id, 'before-await-option');
    assert.equal(capturedConverter({ formatId: legacyRef })?.format_option_id, 'before-await-option');
    assert.equal(capturedWireParams.packages[0].budget, 1000);
    assert.equal(capturedWireParams.packages[0].format_option_refs[0].format_option_id, 'before-await-option');
    assert.equal(capturedCanonicalRequest.packages[0].budget, 1000);
    assert.equal(capturedCanonicalRequest.packages[0].format_option_refs[0].format_option_id, 'before-await-option');
  } finally {
    storage.destroy();
  }
});

test('sync creatives snapshots nested selector options at its public boundary', async () => {
  const client = new SingleAgentClient(agent, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  let capturedParams;
  let capturedOptions;
  let releaseBoundary;
  let boundaryStarted;
  const boundaryGate = new Promise(resolve => {
    releaseBoundary = resolve;
  });
  const boundaryEntered = new Promise(resolve => {
    boundaryStarted = resolve;
  });
  client.syncCreativesWithinDeadline = async (params, _inputHandler, options) => {
    boundaryStarted();
    await boundaryGate;
    capturedParams = params;
    capturedOptions = options;
    return { success: true, status: 'completed', data: { creatives: [] } };
  };
  const request = {
    account: { account_id: 'account-1' },
    idempotency_key: 'sync-snapshot-key',
    creatives: [{ creative_id: 'creative-1', name: 'Creative 1', assets: {} }],
    assignments: [{ creative_id: 'creative-1', package_id: 'package-before-await' }],
  };
  const originalTrustedFetch = async () => new Response();
  const options = {
    transport: {
      maxResponseBytes: 1024,
      requestTimeoutMs: 5000,
      allowPrivateIp: false,
      trustedFetchFn: originalTrustedFetch,
    },
    creativeFormatProjection: {
      selectorContainers: [{ package_id: 'package-before-await' }],
    },
  };
  const pending = client.syncCreatives(request, undefined, options);
  await boundaryEntered;
  request.assignments[0].package_id = 'package-mutated-during-await';
  options.creativeFormatProjection.selectorContainers[0].package_id = 'selector-mutated-during-await';
  options.transport.maxResponseBytes = 999999;
  options.transport.requestTimeoutMs = 1;
  options.transport.allowPrivateIp = true;
  options.transport.trustedFetchFn = async () => new Response('mutated');
  releaseBoundary();
  await pending;
  assert.equal(capturedParams.assignments[0].package_id, 'package-before-await');
  assert.equal(capturedOptions.creativeFormatProjection.selectorContainers[0].package_id, 'package-before-await');
  assert.equal(capturedOptions.transport.maxResponseBytes, 1024);
  assert.equal(capturedOptions.transport.requestTimeoutMs, 5000);
  assert.equal(capturedOptions.transport.allowPrivateIp, false);
  assert.equal(capturedOptions.transport.trustedFetchFn, originalTrustedFetch);
});

test('restart resume routes a committed terminal result through durable settlement exactly once', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('committed-restart-settlement-token');
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'committed-restart-version',
      taskId: 'committed-operation-id',
      contextId: 'committed-context-id',
      a2aTaskId: 'committed-a2a-task-id',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: { idempotency_key: 'committed-restart-key' },
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: 'committed-operation-id',
      settlementServerTaskId: 'committed-seller-work-id',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  ProtocolClient.callTool = async () => ({
    status: 'completed',
    task_id: 'committed-seller-work-id',
    media_buy_id: 'committed-restart-buy',
    packages: [],
  });
  let settlementCalls = 0;
  let completionHandlerCalls = 0;
  let storeCompleted = false;

  try {
    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      handlers: {
        onCreateMediaBuyStatusChange: () => {
          completionHandlerCalls += 1;
        },
      },
    });
    restarted.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    restarted.registerDurableSettlementRecovery(async (operationId, observation) => {
      settlementCalls += 1;
      assert.equal(operationId, 'committed-operation-id');
      assert.equal(observation.serverTaskId, 'committed-seller-work-id');
      assert.equal(observation.taskType, 'create_media_buy');
      assert.equal(observation.status, 'completed');
      storeCompleted = true;
      return { settled: true, status: 'completed', result: observation.result };
    });

    const completed = await restarted.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'committed-restart-buy');
    assert.equal(storeCompleted, true);
    assert.equal(settlementCalls, 1);
    assert.equal(completionHandlerCalls, 1);
    const replay = await restarted.resumeDeferredTask(token, { approved: true });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.data.media_buy_id, 'committed-restart-buy');
    assert.equal(settlementCalls, 1);
    assert.equal(completionHandlerCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('low-level committed resume refuses before seller dispatch and retains the token', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('low-level-committed-token');
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'low-level-version',
      taskId: 'low-level-operation',
      a2aTaskId: 'low-level-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: 'low-level-operation',
      settlementServerTaskId: 'low-level-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return { status: 'completed' };
  };

  try {
    const executor = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => agent,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(executor.resumeDeferredTask(token, { approved: true }), /settlement recovery is unavailable/);
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('owning client without a recoverer refuses committed resume before dispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('missing-recoverer-token');
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'missing-recoverer-version',
      taskId: 'missing-recoverer-operation',
      a2aTaskId: 'missing-recoverer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: 'missing-recoverer-operation',
      settlementServerTaskId: 'missing-recoverer-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return { status: 'completed' };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(client.resumeDeferredTask(token, { approved: true }), /settlement recovery is unavailable/);
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('an unlinked committed continuation cannot resume even when settlement recovery exists', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('unlinked-committed-token');
  const operationId = 'unlinked-committed-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'unlinked-committed-version',
      taskId: operationId,
      a2aTaskId: 'unlinked-committed-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementResumeAuthorizationRequired: true,
      settlementServerTaskId: 'unlinked-committed-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return { status: 'completed' };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.registerDurableSettlementRecovery(async () => {
      assert.fail('An unlinked continuation must fail before settlement recovery.');
    });
    await assert.rejects(client.resumeDeferredTask(token, { approved: true }), /not the current durable route/);
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('failed committed recovery retains the terminal observation and retries without seller redispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('retryable-terminal-settlement-token');
  const operationId = 'retryable-terminal-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'retryable-terminal-version',
      taskId: operationId,
      a2aTaskId: 'retryable-terminal-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementServerTaskId: 'retryable-terminal-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return {
      status: 'completed',
      task_id: 'retryable-terminal-seller-task',
      media_buy_id: 'retryable-terminal-buy',
      packages: [],
      credentials: { private_key: 'seller-terminal-private-key' },
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.executor.activeTasks.set(operationId, {
      id: operationId,
      status: 'input-required',
      taskName: 'create_media_buy',
      agent,
      params: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const observedStatuses = [];
    client.executor.onTaskUpdate(agent.id, task => observedStatuses.push(task.status));
    client.registerDurableSettlementRecovery(async () => undefined);

    await assert.rejects(
      client.resumeDeferredTask(token, { auth_token: 'resume-input-secret' }),
      /settlement recovery was unavailable/
    );
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), true);
    const firstCheckpoint = await storage.get(token);
    assert.ok(firstCheckpoint.settlementTerminalResult);
    assert.doesNotMatch(JSON.stringify(firstCheckpoint), /resume-input-secret|seller-terminal-private-key/);
    assert.match(JSON.stringify(firstCheckpoint), /\[redacted\]/);
    assert.equal(observedStatuses.includes('completed'), false);

    let releaseRecovery;
    let recoveryStarted;
    const recoveryGate = new Promise(resolve => {
      releaseRecovery = resolve;
    });
    const recoveryEntered = new Promise(resolve => {
      recoveryStarted = resolve;
    });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => {
      recoveryStarted();
      await recoveryGate;
      return {
        settled: true,
        status: 'completed',
        result: observation.result,
      };
    });
    const pendingCompletion = client.resumeDeferredTask(token, { approved: true });
    await recoveryEntered;
    const checkpoint = await storage.get(token);
    assert.equal(
      await storage.putIfAbsent(
        token,
        {
          ...checkpoint,
          continuationVersion: 'unrelated-reused-token-version',
          taskId: 'unrelated-new-task',
          settlementTerminalResult: undefined,
        },
        60
      ),
      false
    );
    releaseRecovery();
    const completed = await pendingCompletion;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'retryable-terminal-buy');
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), true);
    assert.equal(observedStatuses.includes('completed'), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('transport failure retains a claimed fence without aliasing raw resume input into durable messages', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('transport-failure-resume-secret-token');
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'transport-failure-resume-secret-version',
      taskId: 'transport-failure-resume-secret-operation',
      a2aTaskId: 'transport-failure-resume-secret-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'approval_task',
      params: {},
      messages: [],
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  const resumeSecret = 'raw-resume-input-secret';
  let protocolCalls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName, params) => {
    protocolCalls += 1;
    assert.equal(taskName, 'approval_task');
    assert.equal(params.input.auth_token, resumeSecret);
    throw new Error('uncertain continuation transport failure');
  };

  try {
    const executor = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      executor.resumeDeferredTask(token, { auth_token: resumeSecret }),
      /uncertain continuation transport failure/
    );
    assert.equal(protocolCalls, 1);
    const retainedFence = await storage.get(token);
    assert.equal(retainedFence.continuationClaimed, true);
    assert.deepEqual(retainedFence.messages, []);
    assert.doesNotMatch(JSON.stringify(retainedFence), new RegExp(resumeSecret));
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('committed submitted resume reconstructs polling after restart without redispatching input', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('restart-pending-settlement-token');
  const operationId = 'restart-pending-settlement-operation';
  const sellerWorkId = 'restart-pending-seller-work';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'restart-pending-version',
      taskId: operationId,
      a2aTaskId: 'restart-pending-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: sellerWorkId,
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let continuationCalls = 0;
  let pollCalls = 0;
  let recoveryCalls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName) => {
    if (taskName === 'create_media_buy') {
      continuationCalls += 1;
      return { status: 'submitted', task_id: sellerWorkId };
    }
    assert.equal(taskName, 'tasks/get');
    pollCalls += 1;
    return {
      task_id: sellerWorkId,
      task_type: 'create_media_buy',
      status: 'completed',
      result: { media_buy_id: 'restart-pending-buy', packages: [] },
      created_at: now,
      updated_at: Date.now(),
    };
  };
  const recover = async (_recoveredOperationId, observation) => {
    recoveryCalls += 1;
    return {
      settled: true,
      status: 'completed',
      result: observation.result,
    };
  };

  try {
    const firstClient = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    firstClient.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    firstClient.registerDurableSettlementRecovery(recover);
    const submitted = await firstClient.resumeDeferredTask(token, { approved: true });
    assert.equal(submitted.status, 'submitted');
    const pendingState = await storage.get(token);
    assert.equal(pendingState.settlementPendingTaskId, sellerWorkId);

    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    restarted.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    restarted.registerDurableSettlementRecovery(recover);
    const reconstructed = await restarted.resumeDeferredTask(token, { approved: 'must-not-redispatch' });
    assert.equal(reconstructed.status, 'submitted');
    const completed = await reconstructed.submitted.waitForCompletion(0);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'restart-pending-buy');
    assert.equal(continuationCalls, 1);
    assert.equal(pollCalls, 1);
    assert.equal(recoveryCalls, 1);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('pending terminal polling checkpoints before one replica enters durable recovery', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('concurrent-pending-settlement-token');
  const operationId = 'concurrent-pending-settlement-operation';
  const sellerWorkId = 'concurrent-pending-seller-work';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'concurrent-pending-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'concurrent-pending-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: sellerWorkId,
      settlementPendingTaskId: sellerWorkId,
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let pollCalls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName) => {
    assert.equal(taskName, 'tasks/get');
    pollCalls += 1;
    return {
      task_id: sellerWorkId,
      task_type: 'create_media_buy',
      status: 'completed',
      result: { media_buy_id: 'concurrent-pending-buy', packages: [] },
      created_at: now,
      updated_at: Date.now(),
    };
  };

  let releaseRecovery;
  let recoveryEntered;
  const recoveryGate = new Promise(resolve => {
    releaseRecovery = resolve;
  });
  const recoveryStarted = new Promise(resolve => {
    recoveryEntered = resolve;
  });
  let recoveryCalls = 0;
  const recover = async (_recoveredOperationId, observation) => {
    recoveryCalls += 1;
    recoveryEntered();
    await recoveryGate;
    return { settled: true, status: 'completed', result: observation.result };
  };

  const createClient = () => {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(recover);
    return client;
  };

  try {
    const first = await createClient().resumeDeferredTask(token, { ignored: 'first' });
    const second = await createClient().resumeDeferredTask(token, { ignored: 'second' });
    const firstCompletion = first.submitted.waitForCompletion(0);
    await recoveryStarted;

    const checkpoint = await storage.get(token);
    assert.equal(checkpoint.settlementPendingTaskId, undefined);
    assert.equal(checkpoint.settlementTerminalResult.data.media_buy_id, 'concurrent-pending-buy');
    assert.equal(checkpoint.settlementFinalizedResult, undefined);

    await assert.rejects(
      second.submitted.waitForCompletion(0),
      /could not replace its pending checkpoint|finalization was claimed/
    );
    assert.equal(recoveryCalls, 1);
    releaseRecovery();
    const completed = await firstCompletion;
    assert.equal(completed.status, 'completed');
    assert.equal(recoveryCalls, 1);
    assert.equal(pollCalls, 2);
  } finally {
    releaseRecovery?.();
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('local pending-poll failures retain the seller work handle until an authoritative terminal result', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('retryable-pending-observer-token');
  const operationId = 'retryable-pending-observer-operation';
  const sellerWorkId = 'retryable-pending-observer-work';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'retryable-pending-observer-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'retryable-pending-observer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: sellerWorkId,
      settlementPendingTaskId: sellerWorkId,
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let pollCalls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName) => {
    assert.equal(taskName, 'tasks/get');
    pollCalls += 1;
    if (pollCalls === 1) throw new Error(`Task ${sellerWorkId} not found`);
    return {
      task_id: sellerWorkId,
      task_type: 'create_media_buy',
      status: 'completed',
      result: { media_buy_id: 'retryable-pending-observer-buy', packages: [] },
      created_at: now,
      updated_at: Date.now(),
    };
  };
  let recoveryCalls = 0;

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => {
      recoveryCalls += 1;
      return { settled: true, status: 'completed', result: observation.result };
    });

    const aborted = await client.resumeDeferredTask(token, { ignored: 'abort' });
    const controller = new AbortController();
    controller.abort(new Error('local observer stopped'));
    const abortedResult = await aborted.submitted.waitForCompletion(0, controller.signal);
    assert.equal(abortedResult.status, 'failed');
    assert.equal(recoveryCalls, 0);
    assert.equal((await storage.get(token)).settlementPendingTaskId, sellerWorkId);

    const evicted = await client.resumeDeferredTask(token, { ignored: 'not-found' });
    const evictedResult = await evicted.submitted.waitForCompletion(0);
    assert.equal(evictedResult.status, 'failed');
    assert.equal(recoveryCalls, 0);
    assert.equal((await storage.get(token)).settlementPendingTaskId, sellerWorkId);

    const retry = await client.resumeDeferredTask(token, { ignored: 'success' });
    const completed = await retry.submitted.waitForCompletion(0);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'retryable-pending-observer-buy');
    assert.equal(recoveryCalls, 1);
    assert.equal(pollCalls, 2);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('pending polling keeps input and auth pauses nonresumable without an A2A continuation identity', async () => {
  const originalCallTool = ProtocolClient.callTool;

  try {
    for (const pauseStatus of ['input-required', 'auth-required']) {
      const storage = new MemoryStorage({ autoCleanup: false });
      const token = testDurableToken(`pending-${pauseStatus}-token`);
      const operationId = `pending-${pauseStatus}-operation`;
      const sellerWorkId = `pending-${pauseStatus}-seller-work`;
      const now = Date.now();
      await storage.putIfAbsent(
        token,
        {
          continuationVersion: `pending-${pauseStatus}-version`,
          continuationClaimed: true,
          taskId: operationId,
          a2aTaskId: sellerWorkId,
          serverVersion: 'v3',
          agentId: agent.id,
          taskName: 'create_media_buy',
          params: {},
          messages: [],
          clientContext: {
            kind: 'single-agent',
            taskType: 'create_media_buy',
            canonical: false,
            productPolicyRequest: {},
          },
          settlementOperationId: operationId,
          settlementServerTaskId: sellerWorkId,
          settlementPendingTaskId: sellerWorkId,
          createdAt: now,
          expiresAt: now + 60_000,
        },
        60
      );

      let pollCalls = 0;
      let recoveryCalls = 0;
      ProtocolClient.callTool = async (_resolvedAgent, taskName) => {
        if (taskName === 'tasks/get') {
          pollCalls += 1;
          if (pollCalls > 1) {
            return {
              task_id: sellerWorkId,
              task_type: 'create_media_buy',
              status: 'completed',
              result: { media_buy_id: `pending-${pauseStatus}-buy`, packages: [] },
              created_at: now,
              updated_at: Date.now(),
            };
          }
          return {
            task_id: sellerWorkId,
            task_type: 'create_media_buy',
            status: pauseStatus,
            result: { question: `Provide ${pauseStatus} input` },
            created_at: now,
            updated_at: Date.now(),
          };
        }
        assert.fail(`polling pause must not invent a ${taskName} continuation call`);
      };

      try {
        const client = new SingleAgentClient(agent, {
          deferredStorage: storage,
          validateFeatures: false,
          validation: { requests: 'off', responses: 'off' },
        });
        client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
        client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => {
          recoveryCalls += 1;
          return { settled: true, status: 'completed', result: observation.result };
        });

        const submitted = await client.resumeDeferredTask(token, { ignored: true });
        const paused = await submitted.submitted.waitForCompletion(0);
        assert.equal(paused.status, pauseStatus);
        assert.equal(paused.deferred, undefined);
        assert.equal(recoveryCalls, 0);
        const pausedState = await storage.get(token);
        assert.equal(pausedState.settlementPendingTaskId, sellerWorkId);
        assert.equal(pausedState.continuationClaimed, true);

        const retry = await client.resumeDeferredTask(token, { ignored: 'poll-only' });
        const completed = await retry.submitted.waitForCompletion(0);
        assert.equal(completed.status, 'completed');
        assert.equal(completed.data.media_buy_id, `pending-${pauseStatus}-buy`);
        assert.equal(pollCalls, 2);
        assert.equal(recoveryCalls, 1);
      } finally {
        storage.destroy();
      }
    }
  } finally {
    ProtocolClient.callTool = originalCallTool;
  }
});

test('terminal track checkpoints raw seller output for public token finalization', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('track-checkpoint-token');
  const operationId = 'track-checkpoint-operation';
  const sellerWorkId = 'track-checkpoint-seller-work';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'track-checkpoint-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'track-checkpoint-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: sellerWorkId,
      settlementPendingTaskId: sellerWorkId,
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let pollCalls = 0;
  let recoveryCalls = 0;
  let handlerCalls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName) => {
    assert.equal(taskName, 'tasks/get');
    pollCalls += 1;
    return {
      task_id: sellerWorkId,
      task_type: 'create_media_buy',
      status: 'completed',
      result: { media_buy_id: 'track-checkpoint-buy', packages: [] },
      created_at: now,
      updated_at: Date.now(),
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      handlers: {
        onCreateMediaBuyStatusChange: async () => {
          handlerCalls += 1;
        },
      },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => {
      recoveryCalls += 1;
      return { settled: true, status: 'completed', result: observation.result };
    });

    const submitted = await client.resumeDeferredTask(token, { ignored: true });
    await assert.rejects(
      submitted.submitted.track(),
      /terminal seller observation was saved.*resume the durable token/
    );
    const checkpoint = await storage.get(token);
    assert.equal(checkpoint.settlementTerminalResult.data.media_buy_id, 'track-checkpoint-buy');
    assert.equal(checkpoint.settlementFinalizedResult, undefined);
    assert.equal(recoveryCalls, 0);
    assert.equal(handlerCalls, 0);

    const completed = await client.resumeDeferredTask(token, { ignored: 'checkpointed' });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'track-checkpoint-buy');
    assert.equal(recoveryCalls, 1);
    assert.equal(handlerCalls, 1);
    assert.equal(pollCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('external callbacks cannot replace an existing deferred terminal winner', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('external-terminal-conflict-token');
  const operationId = 'external-terminal-conflict-operation';
  const sellerWorkId = 'external-terminal-conflict-seller-work';
  const now = Date.now();
  const metadata = {
    taskId: operationId,
    serverTaskId: sellerWorkId,
    taskName: 'create_media_buy',
    agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
    responseTimeMs: 1,
    timestamp: new Date().toISOString(),
    clarificationRounds: 0,
    status: 'completed',
  };
  const terminalWinner = {
    success: true,
    status: 'completed',
    data: { media_buy_id: 'poll-winner-buy', packages: [] },
    metadata,
    conversation: [],
    debug_logs: [],
  };
  const conflictingCallback = {
    ...terminalWinner,
    data: { media_buy_id: 'conflicting-callback-buy', packages: [] },
  };
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'external-terminal-conflict-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'external-terminal-conflict-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementServerTaskId: sellerWorkId,
      settlementTerminalResult: terminalWinner,
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      client.checkpointExternalDeferredSettlement(token, operationId, conflictingCallback),
      /conflicts with the saved deferred terminal observation/
    );
    const afterConflict = await storage.get(token);
    assert.equal(afterConflict.settlementFinalizationLease, undefined);
    assert.equal(afterConflict.settlementFinalizedResult, undefined);
    assert.equal(afterConflict.settlementTerminalResult.data.media_buy_id, 'poll-winner-buy');

    const exactRetry = await client.checkpointExternalDeferredSettlement(token, operationId, terminalWinner);
    assert.ok(exactRetry);
    await acknowledgeDeferredSettlement(exactRetry);
    const finalized = await storage.get(token);
    assert.equal(finalized.settlementTerminalResult.data.media_buy_id, 'poll-winner-buy');
    assert.equal(finalized.settlementFinalizedResult.data.media_buy_id, 'poll-winner-buy');
  } finally {
    storage.destroy();
  }
});

test('finalized deferred callbacks compare the raw seller observation while public replay stays finalized', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('finalized-external-callback-duplicate-token');
  const malformedToken = testDurableToken('finalized-external-callback-missing-raw-token');
  const operationId = 'finalized-external-callback-operation';
  const sellerWorkId = 'finalized-external-callback-seller-work';
  const now = Date.now();
  const metadata = {
    taskId: operationId,
    serverTaskId: sellerWorkId,
    taskName: 'create_media_buy',
    agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
    responseTimeMs: 1,
    timestamp: new Date().toISOString(),
    clarificationRounds: 0,
    status: 'completed',
  };
  const rawSellerResult = {
    success: true,
    status: 'completed',
    data: { media_buy_id: 'raw-seller-buy', legacy_format_id: 'legacy-format' },
    metadata,
    conversation: [],
    debug_logs: [],
  };
  const finalizedPublicResult = {
    ...rawSellerResult,
    data: {
      media_buy_id: 'raw-seller-buy',
      format_option_id: 'canonical-format',
      application_handler_annotation: true,
    },
  };
  const baseState = {
    continuationVersion: 'finalized-external-callback-version',
    continuationClaimed: true,
    taskId: operationId,
    a2aTaskId: 'finalized-external-callback-a2a-task',
    serverVersion: 'v3',
    agentId: agent.id,
    taskName: 'create_media_buy',
    params: {},
    messages: [],
    settlementOperationId: operationId,
    settlementServerTaskId: sellerWorkId,
    settlementFinalizedResult: finalizedPublicResult,
    createdAt: now,
    expiresAt: now + 60_000,
  };
  await storage.putIfAbsent(token, { ...baseState, settlementTerminalResult: rawSellerResult }, 60);
  await storage.putIfAbsent(
    malformedToken,
    { ...baseState, continuationVersion: 'finalized-external-callback-missing-raw-version' },
    60
  );

  try {
    const executor = new TaskExecutor({
      deferredStorage: storage,
      validation: { requests: 'off', responses: 'off' },
    });
    assert.equal(
      await executor.checkpointExternalDeferredSettlement(token, operationId, structuredClone(rawSellerResult)),
      undefined
    );
    const replay = await executor.resumeDeferredTask(token, { ignored: true });
    assert.deepEqual(replay.data, finalizedPublicResult.data);
    await assert.rejects(
      executor.checkpointExternalDeferredSettlement(malformedToken, operationId, rawSellerResult),
      /conflicts with the finalized deferred settlement/
    );
  } finally {
    storage.destroy();
  }
});

test('old terminal checkpoint restores trusted seller task identity before recovery and duplicate comparison', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('old-terminal-missing-server-task-token');
  const operationId = 'old-terminal-missing-server-task-operation';
  const sellerWorkId = 'old-terminal-trusted-seller-work';
  const rawTerminal = committedTerminalResult(operationId, sellerWorkId, 'old-terminal-trusted-buy');
  delete rawTerminal.metadata.serverTaskId;
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      ...committedContinuationState({
        operationId,
        sellerWorkId,
        version: 'old-terminal-missing-server-task-version',
        now,
      }),
      continuationClaimed: true,
      settlementTerminalResult: rawTerminal,
    },
    60
  );

  let recoveryServerTaskId;
  let recoveryMetadataServerTaskId;
  const executor = new TaskExecutor({
    deferredStorage: storage,
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async (result, _recoveredOperationId, serverTaskId) => {
      recoveryServerTaskId = serverTaskId;
      recoveryMetadataServerTaskId = result.metadata.serverTaskId;
      return { result };
    },
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const completed = await executor.resumeDeferredTask(token, { ignored: true });
    assert.equal(completed.metadata.serverTaskId, sellerWorkId);
    assert.equal(recoveryServerTaskId, sellerWorkId);
    assert.equal(recoveryMetadataServerTaskId, sellerWorkId);
    const finalized = await storage.get(token);
    assert.equal(finalized.settlementTerminalResult.metadata.serverTaskId, undefined);
    assert.equal(finalized.settlementFinalizedResult.metadata.serverTaskId, sellerWorkId);
    const exactCallback = committedTerminalResult(operationId, sellerWorkId, 'old-terminal-trusted-buy');
    assert.equal(await executor.checkpointExternalDeferredSettlement(token, operationId, exactCallback), undefined);
  } finally {
    storage.destroy();
  }
});

test('terminal resume binds a newly observed seller task ID for finalized callback duplicates', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('terminal-binds-late-seller-task-token');
  const mismatchToken = testDurableToken('terminal-rejects-changed-seller-task-token');
  const operationId = 'terminal-binds-late-seller-task-operation';
  const mismatchOperationId = 'terminal-rejects-changed-seller-task-operation';
  const sellerWorkId = 'terminal-binds-late-seller-task-work';
  const previouslyBoundWorkId = 'terminal-previously-bound-seller-task-work';
  const conflictingWorkId = 'terminal-conflicting-seller-task-work';
  const now = Date.now();
  const baseState = {
    continuationVersion: 'terminal-binds-late-seller-task-version',
    taskId: operationId,
    a2aTaskId: 'terminal-binds-late-a2a-task',
    serverVersion: 'v3',
    agentId: agent.id,
    taskName: 'create_media_buy',
    params: {},
    messages: [],
    settlementOperationId: operationId,
    createdAt: now,
    expiresAt: now + 60_000,
  };
  await storage.putIfAbsent(token, baseState, 60);
  await storage.putIfAbsent(
    mismatchToken,
    {
      ...baseState,
      continuationVersion: 'terminal-rejects-changed-seller-task-version',
      taskId: mismatchOperationId,
      a2aTaskId: 'terminal-rejects-changed-a2a-task',
      settlementOperationId: mismatchOperationId,
      settlementServerTaskId: previouslyBoundWorkId,
    },
    60
  );

  ProtocolClient.callTool = async (_resolvedAgent, taskName, _params, options) => {
    assert.equal(taskName, 'create_media_buy');
    const mismatched = options.session.taskId === 'terminal-rejects-changed-a2a-task';
    return {
      status: 'completed',
      task_id: mismatched ? conflictingWorkId : sellerWorkId,
      data: {
        media_buy_id: mismatched ? 'terminal-conflicting-buy' : 'terminal-late-bound-buy',
        packages: [],
      },
    };
  };

  const executor = new TaskExecutor({
    deferredStorage: storage,
    resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
    canRecoverDeferredSettlement: async () => true,
    recoverDeferredSettlement: async result => ({ result }),
    validation: { requests: 'off', responses: 'off' },
  });

  try {
    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    const finalized = await storage.get(token);
    assert.equal(finalized.settlementServerTaskId, sellerWorkId);
    assert.deepEqual(finalized.settlementFinalizedResult.data, completed.data);

    const exactCallback = {
      success: true,
      status: 'completed',
      data: structuredClone(completed.data),
      metadata: { ...completed.metadata, serverTaskId: sellerWorkId },
      conversation: [],
      debug_logs: [],
    };
    assert.equal(await executor.checkpointExternalDeferredSettlement(token, operationId, exactCallback), undefined);
    await assert.rejects(
      executor.checkpointExternalDeferredSettlement(token, operationId, {
        ...exactCallback,
        metadata: { ...exactCallback.metadata, serverTaskId: conflictingWorkId },
      }),
      /changed its bound seller task identity/
    );

    await assert.rejects(
      executor.resumeDeferredTask(mismatchToken, { approved: true }),
      /changed its bound seller task identity/
    );
    const mismatchFence = await storage.get(mismatchToken);
    assert.equal(mismatchFence.settlementServerTaskId, previouslyBoundWorkId);
    assert.equal(mismatchFence.settlementTerminalResult, undefined);
    assert.equal(mismatchFence.continuationClaimed, true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('pending restart refuses protocol drift before polling or recovery', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('pending-protocol-drift-token');
  const operationId = 'pending-protocol-drift-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'pending-protocol-drift-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'pending-protocol-drift-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementServerTaskId: 'pending-protocol-drift-work',
      settlementPendingTaskId: 'pending-protocol-drift-work',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let protocolCalls = 0;
  let recoveryCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return { status: 'completed' };
  };

  try {
    const driftedAgent = { ...agent, protocol: 'mcp', agent_uri: 'https://seller.example/mcp' };
    const client = new SingleAgentClient(driftedAgent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureEndpointDiscovered = async () => driftedAgent;
    client.registerDurableSettlementRecovery(async () => {
      recoveryCalls += 1;
      return undefined;
    });
    await assert.rejects(client.resumeDeferredTask(token, { ignored: true }), /only poll its exact A2A seller task/);
    assert.equal(protocolCalls, 0);
    assert.equal(recoveryCalls, 0);
    assert.equal((await storage.get(token)).settlementPendingTaskId, 'pending-protocol-drift-work');
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('failed completion handler retains the checkpoint and retries finalization without seller redispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('retryable-finalizer-token');
  const operationId = 'retryable-finalizer-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'retryable-finalizer-version',
      taskId: operationId,
      a2aTaskId: 'retryable-finalizer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: 'retryable-finalizer-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  let handlerCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return {
      status: 'completed',
      task_id: 'retryable-finalizer-seller-task',
      media_buy_id: 'retryable-finalizer-buy',
      packages: [],
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      deferredTaskTtlSeconds: 1,
      handlers: {
        onCreateMediaBuyStatusChange: async () => {
          handlerCalls += 1;
          if (handlerCalls === 1) {
            await new Promise(resolve => setTimeout(resolve, 1_200));
            throw new Error('temporary completion publication failure');
          }
        },
      },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => ({
      settled: true,
      status: 'completed',
      result: observation.result,
    }));

    await assert.rejects(
      client.resumeDeferredTask(token, { approved: true }),
      /temporary completion publication failure/
    );
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), true);

    const completed = await client.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'retryable-finalizer-buy');
    assert.equal(protocolCalls, 1);
    assert.equal(handlerCalls, 2);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('an active terminal checkpoint lease excludes concurrent clients', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('concurrent-finalizer-token');
  const operationId = 'concurrent-finalizer-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'concurrent-finalizer-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'concurrent-finalizer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: 'concurrent-finalizer-seller-task',
      settlementTerminalResult: {
        success: true,
        status: 'completed',
        data: {
          task_id: 'concurrent-finalizer-seller-task',
          media_buy_id: 'concurrent-finalizer-buy',
          packages: [],
        },
        metadata: {
          taskId: operationId,
          taskName: 'create_media_buy',
          agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
          responseTimeMs: 1,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
        conversation: [],
        debug_logs: [],
      },
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let recoveryCalls = 0;
  let handlerCalls = 0;
  let releaseRecovery;
  let markRecoveryStarted;
  const recoveryGate = new Promise(resolve => {
    releaseRecovery = resolve;
  });
  const recoveryStarted = new Promise(resolve => {
    markRecoveryStarted = resolve;
  });
  const config = {
    deferredStorage: storage,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    handlers: {
      onCreateMediaBuyStatusChange: async () => {
        handlerCalls += 1;
      },
    },
  };
  const firstClient = new SingleAgentClient(agent, config);
  const secondClient = new SingleAgentClient(agent, config);
  const recover = async (_recoveredOperationId, observation) => {
    recoveryCalls += 1;
    markRecoveryStarted();
    await recoveryGate;
    return {
      settled: true,
      status: 'completed',
      result: observation.result,
    };
  };
  firstClient.registerDurableSettlementRecovery(recover);
  secondClient.registerDurableSettlementRecovery(recover);

  try {
    const first = firstClient.resumeDeferredTask(token, { approved: true });
    await recoveryStarted;
    await assert.rejects(
      secondClient.resumeDeferredTask(token, { approved: true }),
      /finalization is already in progress|claimed by another replica/
    );
    assert.equal(recoveryCalls, 1);
    assert.equal(handlerCalls, 0);

    releaseRecovery();
    const completed = await first;
    assert.equal(completed.status, 'completed');
    assert.equal(handlerCalls, 1);

    const replay = await secondClient.resumeDeferredTask(token, { approved: true });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.data.media_buy_id, 'concurrent-finalizer-buy');
    assert.equal(recoveryCalls, 1);
    assert.equal(handlerCalls, 1);
  } finally {
    storage.destroy();
  }
});

test('terminal checkpoint receives a fresh recovery horizon when seller continuation crosses token expiry', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('cross-expiry-terminal-token');
  const operationId = 'cross-expiry-operation';
  const now = Date.now();
  const originalExpiry = now + 50;
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'cross-expiry-version',
      taskId: operationId,
      a2aTaskId: 'cross-expiry-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementServerTaskId: 'cross-expiry-seller-task',
      createdAt: now,
      expiresAt: originalExpiry,
    },
    1
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    return {
      status: 'completed',
      task_id: 'cross-expiry-seller-task',
      media_buy_id: 'cross-expiry-buy',
      packages: [],
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      deferredTaskTtlSeconds: 1,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => ({
      settled: true,
      status: 'completed',
      result: observation.result,
    }));

    const completed = await client.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(protocolCalls, 1);
    const checkpoint = await storage.get(token);
    assert.ok(checkpoint.settlementTerminalResult);
    assert.ok(checkpoint.expiresAt > originalExpiry + 50_000);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('ordinary deferred cleanup stays generation-fenced when seller work crosses token expiry', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = testDurableToken('cross-expiry-ordinary-token');
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'cross-expiry-ordinary-version',
      taskId: 'cross-expiry-ordinary-operation',
      a2aTaskId: 'cross-expiry-ordinary-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'approval_task',
      params: {},
      messages: [],
      createdAt: now,
      expiresAt: now + 50,
    },
    1
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    return { status: 'completed', data: { approved: true } };
  };

  try {
    const executor = new TaskExecutor({
      deferredStorage: storage,
      deferredTaskTtlSeconds: 1,
      resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
      validation: { requests: 'off', responses: 'off' },
    });
    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), false);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});
