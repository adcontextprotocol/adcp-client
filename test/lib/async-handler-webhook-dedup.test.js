const { test } = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { AsyncHandler, WebhookDedupConflictError } = require('../../dist/lib/core/AsyncHandler');
const { memoryBackend } = require('../../dist/lib/server/idempotency/backends/memory');
const { redisBackend } = require('../../dist/lib/server/idempotency/backends/redis');
const { AdCPClient, createLazyBackend } = require('../../dist/lib/index.js');
const { canonicalize } = require('../../dist/lib/utils/jcs.js');

function baseMetadata(overrides = {}) {
  return {
    operation_id: 'op_1',
    task_id: 'task_1',
    agent_id: 'agent_1',
    task_type: 'create_media_buy',
    status: 'working',
    timestamp: new Date().toISOString(),
    idempotency_key: 'whk_01HW9D3H8FZP2N6R8T0V4X6Z9B',
    notification_id: 'notification_01HW9D3H8FZP2N6R8T0V4X6Z9B',
    ...overrides,
  };
}

function dedupStorageKey(metadata) {
  const agentScope = createHash('sha256').update(metadata.agent_id).digest('base64url');
  return `adcp\u001fwebhook\u001fv2\u001f${agentScope}\u001f${metadata.idempotency_key}`;
}

function legacyDedupStorageKey(metadata) {
  return `adcp\u001fwebhook\u001fv1\u001f${metadata.agent_id}\u001f${metadata.idempotency_key}`;
}

function dedupEventFingerprint(metadata, result) {
  return createHash('sha256')
    .update(
      canonicalize({
        operationId: metadata.operation_id,
        taskId: metadata.task_id,
        taskType: metadata.task_type,
        status: metadata.status,
        notificationId: metadata.notification_id ?? null,
        contextId: metadata.context_id ?? null,
        message: metadata.message ?? null,
        result: result ?? null,
      })
    )
    .digest('base64url');
}

test('webhookDedup fails closed when a custom backend lacks atomic fencing', () => {
  assert.throws(
    () =>
      new AsyncHandler({
        webhookDedup: {
          backend: {
            get: async () => null,
            put: async () => {},
            putIfAbsent: async () => true,
            delete: async () => {},
          },
        },
      }),
    /must implement atomic putIfAbsent\(\), replaceIfPayloadHash\(\), replaceIfPayloadHashAndExpired\(\), and deleteIfPayloadHash\(\)/
  );
});

test('webhookDedup fails closed when a custom backend lacks atomic first-owner claiming', () => {
  assert.throws(
    () =>
      new AsyncHandler({
        webhookDedup: {
          backend: {
            get: async () => null,
            put: async () => {},
            replaceIfPayloadHash: async () => true,
            replaceIfPayloadHashAndExpired: async () => true,
            deleteIfPayloadHash: async () => true,
            delete: async () => {},
          },
        },
      }),
    /must implement atomic putIfAbsent\(\)/
  );
});

test('webhookDedup fails closed when a custom backend lacks atomic expired-owner replacement', () => {
  const { replaceIfPayloadHashAndExpired: _omitted, ...backend } = memoryBackend({ sweepIntervalMs: 0 });
  assert.throws(
    () => new AsyncHandler({ webhookDedup: { backend } }),
    /must implement atomic putIfAbsent\(\), replaceIfPayloadHash\(\), replaceIfPayloadHashAndExpired\(\), and deleteIfPayloadHash\(\)/
  );
});

test('webhookDedup rejects invalid retention and lease TTLs at construction', () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  for (const ttlSeconds of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new AsyncHandler({ webhookDedup: { backend, ttlSeconds } }),
      /ttlSeconds must be a positive safe integer/
    );
  }
  for (const inFlightTtlSeconds of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new AsyncHandler({ webhookDedup: { backend, inFlightTtlSeconds } }),
      /inFlightTtlSeconds must be a positive safe integer/
    );
  }
  assert.doesNotThrow(() => new AsyncHandler({ webhookDedup: { backend, ttlSeconds: 60, inFlightTtlSeconds: 60 } }));
  assert.throws(
    () => new AsyncHandler({ webhookDedup: { backend, ttlSeconds: 60, inFlightTtlSeconds: 61 } }),
    /inFlightTtlSeconds must be less than or equal to webhookDedup\.ttlSeconds/
  );
  assert.throws(
    () => new AsyncHandler({ webhookDedup: { backend, inFlightTtlSeconds: 86_401 } }),
    /inFlightTtlSeconds must be less than or equal to webhookDedup\.ttlSeconds/
  );
});

test('webhookDedup fails before handler execution when a lazy backend resolves without fencing', async () => {
  let handlerCalls = 0;
  const entries = new Map();
  const lazyBackend = createLazyBackend(async () => ({
    get: async key => entries.get(key) ?? null,
    put: async (key, entry) => entries.set(key, entry),
    putIfAbsent: async (key, entry) => {
      if (entries.has(key)) return false;
      entries.set(key, entry);
      return true;
    },
    delete: async key => entries.delete(key),
  }));
  const handler = new AsyncHandler({
    webhookDedup: { backend: lazyBackend },
    onCreateMediaBuyStatusChange: () => {
      handlerCalls += 1;
    },
  });

  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() }),
    /failed to resolve idempotency backend/
  );
  assert.strictEqual(handlerCalls, 0);
});

test('memory backend payload-hash fencing rejects stale replace and delete', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const original = { payloadHash: 'owner-a', response: { owner: 'a' }, expiresAt: 4_000_000_000 };
  const replacement = { payloadHash: 'owner-b', response: { owner: 'b' }, expiresAt: 4_000_000_001 };
  await backend.put('fenced-key', original);
  assert.strictEqual(await backend.replaceIfPayloadHash('fenced-key', 'stale-owner', replacement), false);
  assert.deepStrictEqual(await backend.get('fenced-key'), { ...original, retainUntil: original.expiresAt });
  assert.strictEqual(await backend.replaceIfPayloadHash('fenced-key', 'owner-a', replacement), true);
  assert.strictEqual(await backend.deleteIfPayloadHash('fenced-key', 'owner-a'), false);
  assert.strictEqual(await backend.deleteIfPayloadHash('fenced-key', 'owner-b'), true);
  assert.strictEqual(await backend.get('fenced-key'), null);
});

test('memory backend expired replacement requires the exact owner and backend-time expiry', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const now = Math.floor(Date.now() / 1000);
  const replacement = {
    payloadHash: 'owner-b',
    response: { owner: 'b' },
    expiresAt: now + 300,
    retainUntil: now + 600,
  };
  await backend.put('expiry-fenced-key', {
    payloadHash: 'owner-a',
    response: { owner: 'a' },
    expiresAt: now,
    retainUntil: now + 600,
  });

  assert.strictEqual(
    await backend.replaceIfPayloadHashAndExpired('expiry-fenced-key', 'owner-a', replacement),
    false,
    'an entry expiring in the current second remains live'
  );
  await backend.put('expiry-fenced-key', {
    payloadHash: 'owner-a',
    response: { owner: 'a' },
    expiresAt: now - 1,
    retainUntil: now + 600,
  });
  assert.strictEqual(
    await backend.replaceIfPayloadHashAndExpired('expiry-fenced-key', 'stale-owner', replacement),
    false
  );
  assert.strictEqual(await backend.replaceIfPayloadHashAndExpired('expiry-fenced-key', 'owner-a', replacement), true);
  assert.deepStrictEqual(await backend.get('expiry-fenced-key'), replacement);
});

test('webhookDedup drops duplicate delivery by idempotency_key', async () => {
  const calls = [];
  const activities = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => {
      calls.push(metadata.idempotency_key);
    },
    onActivity: a => activities.push(a.type),
  });

  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  await handler.handleWebhook(args);
  await handler.handleWebhook(args);
  await handler.handleWebhook(args);

  assert.deepStrictEqual(calls, ['whk_01HW9D3H8FZP2N6R8T0V4X6Z9B']);
  assert.deepStrictEqual(activities, ['webhook_received', 'webhook_duplicate', 'webhook_duplicate']);
});

test('webhookDedup dispatches distinct idempotency_keys independently', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => {
      calls.push(metadata.idempotency_key);
    },
  });

  await handler.handleWebhook({
    result: { media_buy_id: 'mb_1' },
    metadata: baseMetadata({ idempotency_key: 'whk_0000000000000001' }),
  });
  await handler.handleWebhook({
    result: { media_buy_id: 'mb_1' },
    metadata: baseMetadata({ idempotency_key: 'whk_0000000000000002' }),
  });

  assert.deepStrictEqual(calls, ['whk_0000000000000001', 'whk_0000000000000002']);
});

test('webhookDedup publishes one terminal task across distinct delivery keys', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => calls.push(metadata.idempotency_key),
  });
  const terminal = {
    status: 'completed',
    notification_id: 'notification_terminal_0001',
  };
  assert.strictEqual(
    await handler.handleWebhook({
      result: { media_buy_id: 'mb_1' },
      metadata: baseMetadata({ ...terminal, idempotency_key: 'whk_terminal_000000001' }),
    }),
    'handled'
  );
  assert.strictEqual(
    await handler.handleWebhook({
      result: { media_buy_id: 'mb_1' },
      metadata: baseMetadata({ ...terminal, idempotency_key: 'whk_terminal_000000002' }),
    }),
    'already_handled'
  );
  assert.deepStrictEqual(calls, ['whk_terminal_000000001']);
});

test('webhookDedup keeps identical seller task IDs isolated by buyer operation', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => calls.push(metadata.operation_id),
  });
  for (const [operation_id, idempotency_key] of [
    ['op_tenant_a', 'whk_terminal_tenant_0001'],
    ['op_tenant_b', 'whk_terminal_tenant_0002'],
  ]) {
    assert.strictEqual(
      await handler.handleWebhook({
        result: { media_buy_id: 'mb_shared_seller_id' },
        metadata: baseMetadata({
          operation_id,
          task_id: 'seller_task_scoped_per_operation',
          status: 'completed',
          idempotency_key,
        }),
      }),
      'handled'
    );
  }
  assert.deepStrictEqual(calls, ['op_tenant_a', 'op_tenant_b']);
});

test('webhookDedup rejects conflicting terminal artifacts across delivery keys', async () => {
  const handler = new AsyncHandler({ webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) } });
  await handler.handleWebhook({
    result: { media_buy_id: 'mb_1' },
    metadata: baseMetadata({ status: 'completed', idempotency_key: 'whk_terminal_conflict01' }),
  });
  await assert.rejects(
    handler.handleWebhook({
      result: { media_buy_id: 'mb_2' },
      metadata: baseMetadata({ status: 'completed', idempotency_key: 'whk_terminal_conflict02' }),
    }),
    /idempotency key was reused/
  );
});

test('sender delivery keys cannot poison the internal terminal-task namespace', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_result, metadata) => calls.push(metadata.status),
  });
  const taskId = 'task_namespace_isolation';
  const taskHash = createHash('sha256').update(taskId).digest('base64url');
  await handler.handleWebhook({
    result: { progress: 50 },
    metadata: baseMetadata({
      task_id: taskId,
      status: 'working',
      idempotency_key: `terminal:${taskHash}`,
    }),
  });
  await handler.handleWebhook({
    result: { media_buy_id: 'mb_1' },
    metadata: baseMetadata({
      task_id: taskId,
      status: 'completed',
      idempotency_key: 'whk_terminal_namespace01',
    }),
  });
  assert.deepStrictEqual(calls, ['working', 'completed']);
});

test('webhookDedup rejects one sender key reused for a different callback payload', async () => {
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
  });
  await handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() });
  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_2' }, metadata: baseMetadata() }),
    /idempotency key was reused/
  );
  await assert.rejects(
    handler.handleWebhook({
      result: { media_buy_id: 'mb_1' },
      metadata: baseMetadata({ message: 'A different failure explanation' }),
    }),
    /idempotency key was reused/
  );
});

test('webhookDedup scopes by agent_id so different senders do not collide', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => {
      calls.push(`${metadata.agent_id}:${metadata.idempotency_key}`);
    },
  });

  const sharedKey = 'whk_0000000000000001';
  await handler.handleWebhook({
    result: { media_buy_id: 'mb_1' },
    metadata: baseMetadata({ agent_id: 'agent_a', idempotency_key: sharedKey }),
  });
  await handler.handleWebhook({
    result: { media_buy_id: 'mb_1' },
    metadata: baseMetadata({ agent_id: 'agent_b', idempotency_key: sharedKey }),
  });

  assert.deepStrictEqual(calls, [`agent_a:${sharedKey}`, `agent_b:${sharedKey}`]);
});

test('webhookDedup honors a live origin-main raw-agent fence and dispatches after it expires', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ agent_id: 'legacy-agent' });
  const legacyKey = legacyDedupStorageKey(metadata);
  const nowSeconds = Math.floor(Date.now() / 1000);
  await backend.put(legacyKey, { payloadHash: '', response: null, expiresAt: nowSeconds + 60 });
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });
  const args = { result: { media_buy_id: 'mb_legacy' }, metadata };

  assert.strictEqual(await handler.handleWebhook(args), 'already_handled');
  assert.strictEqual(calls, 0);
  assert.strictEqual(await backend.get(dedupStorageKey(metadata)), null, 'legacy replay must not claim the new key');

  await backend.put(legacyKey, { payloadHash: '', response: null, expiresAt: nowSeconds - 1 });
  assert.strictEqual(await handler.handleWebhook(args), 'handled');
  assert.strictEqual(calls, 1);
  assert.ok(await backend.get(dedupStorageKey(metadata)));
});

test('webhookDedup gives current hashed conflicts precedence over a live legacy fence', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ agent_id: 'transition-agent' });
  const originalResult = { media_buy_id: 'mb_original' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  await backend.put(legacyDedupStorageKey(metadata), {
    payloadHash: '',
    response: null,
    expiresAt: nowSeconds + 60,
  });
  await backend.put(dedupStorageKey(metadata), {
    payloadHash: 'handled-generation',
    response: {
      state: 'adcp_webhook_handled_v1',
      eventFingerprint: dedupEventFingerprint(metadata, originalResult),
    },
    expiresAt: nowSeconds + 60,
  });
  const handler = new AsyncHandler({ webhookDedup: { backend } });

  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_conflict' }, metadata }),
    error => error instanceof WebhookDedupConflictError
  );
});

test('webhookDedup fails closed on a live malformed current entry before consulting legacy state', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ agent_id: 'corrupt-current-agent' });
  const nowSeconds = Math.floor(Date.now() / 1000);
  await backend.put(legacyDedupStorageKey(metadata), {
    payloadHash: '',
    response: null,
    expiresAt: nowSeconds + 60,
  });
  await backend.put(dedupStorageKey(metadata), {
    payloadHash: 'unknown-owner',
    response: { unexpected: true },
    expiresAt: nowSeconds + 60,
  });
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  assert.strictEqual(await handler.handleWebhook({ result: {}, metadata }), 'in_progress');
  assert.strictEqual(calls, 0);
});

test('webhookDedup hashes direct-caller agent IDs for writes while transition-reading the legacy key', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  const readKeys = [];
  const writeKeys = [];
  const backend = {
    ...delegate,
    get: async key => {
      readKeys.push(key);
      return delegate.get(key);
    },
    putIfAbsent: async (key, entry) => {
      writeKeys.push(key);
      return delegate.putIfAbsent(key, entry);
    },
    replaceIfPayloadHash: async (key, expected, entry) => {
      writeKeys.push(key);
      return delegate.replaceIfPayloadHash(key, expected, entry);
    },
    deleteIfPayloadHash: async (key, expected) => delegate.deleteIfPayloadHash(key, expected),
  };
  const handler = new AsyncHandler({ webhookDedup: { backend } });
  const agentId = 'tenant-a\u001fspoofed-scope';
  const metadata = baseMetadata({ agent_id: agentId });
  await handler.handleWebhook({ result: {}, metadata });
  assert.ok(readKeys.includes(legacyDedupStorageKey(metadata)));
  assert.ok(writeKeys.length > 0);
  assert.ok(writeKeys.every(key => !key.includes(agentId)));
});

test('webhookDedup isolates a raw agent ID that equals another sender hash', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const victimAgentId = 'victim-agent';
  const hashShapedAgentId = createHash('sha256').update(victimAgentId).digest('base64url');
  const idempotencyKey = 'whk_0000000000000001';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const victimMetadata = baseMetadata({ agent_id: victimAgentId, idempotency_key: idempotencyKey });
  const hashShapedMetadata = baseMetadata({ agent_id: hashShapedAgentId, idempotency_key: idempotencyKey });

  // Origin-main wrote v1 raw-agent fences. This hash-shaped raw ID is exactly
  // the victim's digest, but the victim's current v2 scope must remain distinct.
  await backend.put(legacyDedupStorageKey(hashShapedMetadata), {
    payloadHash: '',
    response: null,
    expiresAt: nowSeconds + 60,
  });
  let victimCalls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend },
    onCreateMediaBuyStatusChange: () => {
      victimCalls += 1;
    },
  });

  assert.strictEqual(await handler.handleWebhook({ result: {}, metadata: victimMetadata }), 'handled');
  assert.strictEqual(victimCalls, 1);
  assert.notStrictEqual(dedupStorageKey(victimMetadata), legacyDedupStorageKey(hashShapedMetadata));
  assert.strictEqual(await handler.handleWebhook({ result: {}, metadata: hashShapedMetadata }), 'already_handled');
  assert.strictEqual(victimCalls, 1, 'the hash-shaped sender must not dispatch through the victim scope');
});

test('webhookDedup missing MCP idempotency_key: rejects before dispatch', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => {
      calls.push(metadata.task_id);
    },
  });

  const meta = baseMetadata();
  delete meta.idempotency_key;
  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata: meta }),
    /idempotency_key is required/
  );

  assert.strictEqual(calls.length, 0, 'missing MCP key must not bypass configured dedup');
});

test('no webhookDedup config: duplicates still dispatch (back-compat)', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    onCreateMediaBuyStatusChange: (_response, metadata) => {
      calls.push(metadata.idempotency_key);
    },
  });

  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  await handler.handleWebhook(args);
  await handler.handleWebhook(args);

  assert.strictEqual(calls.length, 2);
});

test('idempotency_key propagates from MCP envelope through SingleAgentClient to handler metadata', async () => {
  const client = new AdCPClient(
    [{ id: 'agent_mcp', name: 'MCP', agent_uri: 'https://agent.example', protocol: 'mcp' }],
    {
      allowUnauthenticatedWebhooks: true,
      handlers: {
        onCreateMediaBuyStatusChange: (_response, metadata) => {
          seenMetadata = metadata;
        },
      },
    }
  );
  let seenMetadata = null;

  const envelope = {
    idempotency_key: 'whk_01HW9D3H8FZP2N6R8T0V4X6Z9B',
    notification_id: 'notification_01HW9D3H8FZP2N6R8T0V4X6Z9B',
    operation_id: 'op_1',
    task_id: 'task_1',
    task_type: 'create_media_buy',
    status: 'completed',
    timestamp: new Date().toISOString(),
    result: { media_buy_id: 'mb_1' },
  };

  const handled = await client.agent('agent_mcp').handleWebhook(envelope, 'create_media_buy', 'op_1');
  assert.strictEqual(handled, true);
  assert.ok(seenMetadata, 'handler should be called');
  assert.strictEqual(seenMetadata.idempotency_key, 'whk_01HW9D3H8FZP2N6R8T0V4X6Z9B');
  assert.strictEqual(seenMetadata.notification_id, 'notification_01HW9D3H8FZP2N6R8T0V4X6Z9B');
});

test('webhookDedup re-dispatches after backend eviction (TTL expiry path)', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const activities = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 1 },
    onActivity: a => activities.push(a.type),
  });

  const meta = baseMetadata({ idempotency_key: 'whk_expiry_test_0000001' });
  await handler.handleWebhook({ result: {}, metadata: meta });

  // Simulate logical TTL expiry without a backend sweeper. Scoped keys use
  // the reserved `adcp\u001fwebhook\u001fv2\u001f...` prefix.
  const completedKey = dedupStorageKey(meta);
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  await backend.put(completedKey, { ...(await backend.get(completedKey)), expiresAt: expiredAt });

  await handler.handleWebhook({ result: {}, metadata: meta });
  assert.deepStrictEqual(activities, ['webhook_received', 'webhook_received']);
});

test('webhookDedup: concurrent retries race on one claim, exactly one handler call', async () => {
  const calls = [];
  const activities = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: async (_response, metadata) => {
      // Simulate a slow handler to widen the race window.
      await new Promise(r => setTimeout(r, 10));
      calls.push(metadata.idempotency_key);
    },
    onActivity: a => activities.push(a.type),
  });

  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  await Promise.all([
    handler.handleWebhook(args),
    handler.handleWebhook(args),
    handler.handleWebhook(args),
    handler.handleWebhook(args),
    handler.handleWebhook(args),
  ]);

  assert.strictEqual(calls.length, 1, 'exactly one handler call for five concurrent retries');
  const received = activities.filter(t => t === 'webhook_received').length;
  const duplicates = activities.filter(t => t === 'webhook_duplicate').length;
  assert.strictEqual(received, 1);
  assert.strictEqual(duplicates, 4);
});

test('webhookDedup distinguishes an in-progress retry from a completed replay', async () => {
  let releaseHandler;
  let markHandlerEntered;
  const handlerEntered = new Promise(resolve => {
    markHandlerEntered = resolve;
  });
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: async () => {
      markHandlerEntered();
      await new Promise(resolve => {
        releaseHandler = resolve;
      });
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };

  const first = handler.handleWebhook(args);
  await handlerEntered;
  assert.strictEqual(await handler.handleWebhook(args), 'in_progress');
  releaseHandler();
  assert.strictEqual(await first, 'handled');
  assert.strictEqual(await handler.handleWebhook(args), 'already_handled');
});

test('webhookDedup rejects a different payload while the sender key is actively claimed', async () => {
  let releaseHandler;
  let markHandlerEntered;
  const handlerEntered = new Promise(resolve => {
    markHandlerEntered = resolve;
  });
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: async () => {
      markHandlerEntered();
      await new Promise(resolve => {
        releaseHandler = resolve;
      });
    },
  });
  const metadata = baseMetadata();
  const first = handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata });
  await handlerEntered;

  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_conflict' }, metadata }),
    error => error instanceof WebhookDedupConflictError && /idempotency key was reused/.test(error.message)
  );

  releaseHandler();
  assert.strictEqual(await first, 'handled');
});

test('webhookDedup renews a live handler claim past its initial lease', async () => {
  let releaseHandler;
  let markHandlerEntered;
  const handlerEntered = new Promise(resolve => {
    markHandlerEntered = resolve;
  });
  const handler = new AsyncHandler({
    webhookDedup: {
      backend: memoryBackend({ sweepIntervalMs: 0 }),
      ttlSeconds: 60,
      inFlightTtlSeconds: 1,
    },
    onCreateMediaBuyStatusChange: async () => {
      markHandlerEntered();
      await new Promise(resolve => {
        releaseHandler = resolve;
      });
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  const first = handler.handleWebhook(args);
  await handlerEntered;
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.strictEqual(await handler.handleWebhook(args), 'in_progress');
  releaseHandler();
  assert.strictEqual(await first, 'handled');
});

test('webhookDedup retries claim renewal after a transient backend error', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const replace = backend.replaceIfPayloadHash.bind(backend);
  let renewalAttempts = 0;
  backend.replaceIfPayloadHash = async (...args) => {
    const replacement = args[2];
    if (replacement.response?.claimToken && renewalAttempts++ === 1) {
      throw new Error('transient backend outage');
    }
    return replace(...args);
  };
  let releaseHandler;
  let markHandlerEntered;
  const handlerEntered = new Promise(resolve => {
    markHandlerEntered = resolve;
  });
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 60, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: async () => {
      markHandlerEntered();
      await new Promise(resolve => {
        releaseHandler = resolve;
      });
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  const first = handler.handleWebhook(args);
  await handlerEntered;
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.strictEqual(await handler.handleWebhook(args), 'in_progress');
  assert.ok(renewalAttempts >= 3, 'renewal continues after a transient failure');
  releaseHandler();
  assert.strictEqual(await first, 'handled');
});

test('webhookDedup survives a renewal that commits before its response is lost', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const replace = backend.replaceIfPayloadHash.bind(backend);
  let ownerWrites = 0;
  backend.replaceIfPayloadHash = async (...args) => {
    const replacement = args[2];
    if (replacement.response?.claimToken) {
      ownerWrites += 1;
      const replaced = await replace(...args);
      if (ownerWrites === 2) throw new Error('renewal response lost after commit');
      return replaced;
    }
    return replace(...args);
  };
  let releaseHandler;
  let markHandlerEntered;
  const handlerEntered = new Promise(resolve => {
    markHandlerEntered = resolve;
  });
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 60, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: async () => {
      markHandlerEntered();
      await new Promise(resolve => {
        releaseHandler = resolve;
      });
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  const first = handler.handleWebhook(args);
  await handlerEntered;
  await new Promise(resolve => setTimeout(resolve, 1250));
  releaseHandler();

  assert.strictEqual(await first, 'handled');
  assert.strictEqual(await handler.handleWebhook(args), 'already_handled');
  assert.ok(ownerWrites >= 3, 'renewal retries safely with the stable owner token');
});

test('webhookDedup releases the renewed owner claim when the public handler fails', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const handler = new AsyncHandler({
      webhookDedup: { backend, ttlSeconds: 60, inFlightTtlSeconds: 1 },
      onCreateMediaBuyStatusChange: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise(resolve => setTimeout(resolve, 450));
          throw new Error('handler failed after renewal');
        }
      },
    });
    const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };

    await assert.rejects(handler.handleWebhook(args), /handler failed after renewal/);
    assert.strictEqual(await handler.handleWebhook(args), 'handled');
    assert.strictEqual(calls, 2);
  } finally {
    console.error = originalError;
  }
});

test('webhookDedup defaults an in-progress claim to the full retention fence', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  let releaseHandler;
  let markHandlerEntered;
  const handlerEntered = new Promise(resolve => {
    markHandlerEntered = resolve;
  });
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300 },
    onCreateMediaBuyStatusChange: async () => {
      markHandlerEntered();
      await new Promise(resolve => {
        releaseHandler = resolve;
      });
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  const first = handler.handleWebhook(args);
  await handlerEntered;
  const claimKey = dedupStorageKey(args.metadata);
  const inFlight = await backend.get(claimKey);
  assert.ok(inFlight.expiresAt >= Math.floor(Date.now() / 1000) + 299);
  releaseHandler();
  assert.strictEqual(await first, 'handled');
});

test('webhookDedup lets a cold receiver reclaim an expired in-progress claim', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  let releaseOriginal;
  let markOriginalEntered;
  const originalEntered = new Promise(resolve => {
    markOriginalEntered = resolve;
  });
  const original = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300, inFlightTtlSeconds: 30 },
    onCreateMediaBuyStatusChange: async () => {
      markOriginalEntered();
      await new Promise(resolve => {
        releaseOriginal = resolve;
      });
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
  const first = original.handleWebhook(args);
  await originalEntered;

  const completedKey = dedupStorageKey(args.metadata);
  const claimKey = completedKey;
  const inFlight = await backend.get(claimKey);
  assert.equal(typeof inFlight.response.claimToken, 'string');
  assert.ok(inFlight.expiresAt <= Math.floor(Date.now() / 1000) + 30);
  await backend.put(claimKey, { ...inFlight, expiresAt: Math.floor(Date.now() / 1000) - 1 });

  let coldHandlerCalls = 0;
  const coldReceiver = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300 },
    onCreateMediaBuyStatusChange: () => {
      coldHandlerCalls += 1;
    },
  });
  assert.strictEqual(await coldReceiver.handleWebhook(args), 'handled');
  assert.strictEqual(coldHandlerCalls, 1);
  releaseOriginal();
  await assert.rejects(first, /processing claim was lost/);
});

test('webhookDedup stale read cannot replace a claim renewed before atomic takeover', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ idempotency_key: 'renewal_aba_claim_0001' });
  const result = { media_buy_id: 'mb_1' };
  const eventFingerprint = dedupEventFingerprint(metadata, result);
  const key = dedupStorageKey(metadata);
  const owner = 'owner-generation';
  await delegate.put(key, {
    payloadHash: owner,
    response: { claimToken: owner, eventFingerprint },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
  });

  let releaseStaleRead;
  let markStaleRead;
  const staleRead = new Promise(resolve => {
    markStaleRead = resolve;
  });
  const staleReadGate = new Promise(resolve => {
    releaseStaleRead = resolve;
  });
  let blockNextGet = true;
  const backend = {
    ...delegate,
    get: async scopedKey => {
      const snapshot = await delegate.get(scopedKey);
      if (blockNextGet) {
        blockNextGet = false;
        markStaleRead();
        await staleReadGate;
      }
      return snapshot;
    },
  };
  let calls = 0;
  const receiver = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  const attempt = receiver.handleWebhook({ result, metadata });
  await staleRead;
  assert.strictEqual(
    await delegate.replaceIfPayloadHash(key, owner, {
      payloadHash: owner,
      response: { claimToken: owner, eventFingerprint },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }),
    true
  );
  releaseStaleRead();

  assert.strictEqual(await attempt, 'in_progress');
  assert.strictEqual(calls, 0);
});

test('webhookDedup stale completed-marker read cannot overwrite a fresh same-event publication', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ idempotency_key: 'completed_aba_marker_01' });
  const args = { result: { media_buy_id: 'mb_1' }, metadata };
  await new AsyncHandler({ webhookDedup: { backend: delegate, ttlSeconds: 300 } }).handleWebhook(args);
  const key = dedupStorageKey(metadata);
  const expired = await delegate.get(key);
  await delegate.put(key, { ...expired, expiresAt: Math.floor(Date.now() / 1000) - 1 });

  let releaseStaleRead;
  let markStaleRead;
  const staleRead = new Promise(resolve => {
    markStaleRead = resolve;
  });
  const staleReadGate = new Promise(resolve => {
    releaseStaleRead = resolve;
  });
  let blockNextGet = true;
  const backend = {
    ...delegate,
    get: async scopedKey => {
      const snapshot = await delegate.get(scopedKey);
      if (blockNextGet) {
        blockNextGet = false;
        markStaleRead();
        await staleReadGate;
      }
      return snapshot;
    },
  };
  let calls = 0;
  const receiver = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  const staleAttempt = receiver.handleWebhook(args);
  await staleRead;
  assert.strictEqual(await receiver.handleWebhook(args), 'handled');
  releaseStaleRead();

  assert.strictEqual(await staleAttempt, 'already_handled');
  assert.strictEqual(calls, 1);
});

test('webhookDedup reclaims an expired claim through an exact-generation payload-hash CAS', async () => {
  const entries = new Map();
  const backend = {
    get: async key => structuredClone(entries.get(key) ?? null),
    put: async (key, entry) => entries.set(key, structuredClone(entry)),
    putIfAbsent: async (key, entry) => {
      if (entries.has(key)) return false;
      entries.set(key, structuredClone(entry));
      return true;
    },
    replaceIfPayloadHash: async (key, expected, entry) => {
      if (entries.get(key)?.payloadHash !== expected) return false;
      entries.set(key, structuredClone(entry));
      return true;
    },
    replaceIfPayloadHashAndExpired: async (key, expected, entry) => {
      const current = entries.get(key);
      if (current?.payloadHash !== expected || current.expiresAt >= Math.floor(Date.now() / 1000)) {
        return false;
      }
      entries.set(key, structuredClone(entry));
      return true;
    },
    deleteIfPayloadHash: async (key, expected) => {
      if (entries.get(key)?.payloadHash !== expected) return false;
      entries.delete(key);
      return true;
    },
    delete: async key => entries.delete(key),
  };
  const metadata = baseMetadata({ idempotency_key: 'custom_expired_claim_0001' });
  const key = dedupStorageKey(metadata);
  const result = { media_buy_id: 'mb_1' };
  entries.set(key, {
    payloadHash: 'stale-owner',
    response: { claimToken: 'stale-owner', eventFingerprint: dedupEventFingerprint(metadata, result) },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    retainUntil: Math.floor(Date.now() / 1000) + 300,
  });
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });
  assert.equal(await handler.handleWebhook({ result, metadata }), 'handled');
  assert.equal(calls, 1);
});

test('webhookDedup stale expired-claim read cannot overwrite a newer expired payload generation', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ idempotency_key: 'expired_claim_aba_0001' });
  const originalResult = { media_buy_id: 'mb_original' };
  const changedResult = { media_buy_id: 'mb_changed' };
  const key = dedupStorageKey(metadata);
  const oldOwner = 'old-expired-owner';
  await delegate.put(key, {
    payloadHash: oldOwner,
    response: { claimToken: oldOwner, eventFingerprint: dedupEventFingerprint(metadata, originalResult) },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    retainUntil: Math.floor(Date.now() / 1000) + 300,
  });

  let releaseTakeover;
  let markTakeover;
  const takeoverReached = new Promise(resolve => {
    markTakeover = resolve;
  });
  const takeoverGate = new Promise(resolve => {
    releaseTakeover = resolve;
  });
  const replaceIfPayloadHashAndExpired = delegate.replaceIfPayloadHashAndExpired.bind(delegate);
  const backend = {
    ...delegate,
    replaceIfPayloadHashAndExpired: async (...args) => {
      if (args[1] === oldOwner && args[2]?.response?.claimToken) {
        markTakeover();
        await takeoverGate;
      }
      return replaceIfPayloadHashAndExpired(...args);
    },
  };
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  const staleAttempt = handler.handleWebhook({ result: originalResult, metadata });
  await takeoverReached;
  const newOwner = 'new-expired-owner';
  await delegate.put(key, {
    payloadHash: newOwner,
    response: { claimToken: newOwner, eventFingerprint: dedupEventFingerprint(metadata, changedResult) },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    retainUntil: Math.floor(Date.now() / 1000) + 300,
  });
  releaseTakeover();

  await assert.rejects(staleAttempt, error => error instanceof WebhookDedupConflictError);
  assert.equal(calls, 0);
  assert.equal((await delegate.get(key)).payloadHash, newOwner);
});

test('webhookDedup stale absent read cannot overwrite a newly expired payload generation', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ idempotency_key: 'absent_claim_aba_0001' });
  const staleResult = { media_buy_id: 'mb_stale' };
  const newerResult = { media_buy_id: 'mb_newer' };
  const key = dedupStorageKey(metadata);
  const legacyKey = legacyDedupStorageKey(metadata);

  let releaseLegacyRead;
  let markLegacyRead;
  const legacyReadReached = new Promise(resolve => {
    markLegacyRead = resolve;
  });
  const legacyReadGate = new Promise(resolve => {
    releaseLegacyRead = resolve;
  });
  let blockLegacyRead = true;
  const backend = {
    ...delegate,
    get: async scopedKey => {
      if (scopedKey === legacyKey && blockLegacyRead) {
        blockLegacyRead = false;
        markLegacyRead();
        await legacyReadGate;
      }
      return delegate.get(scopedKey);
    },
  };
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  const staleAttempt = handler.handleWebhook({ result: staleResult, metadata });
  await legacyReadReached;
  const newerOwner = 'newer-expired-owner';
  await delegate.put(key, {
    payloadHash: newerOwner,
    response: { claimToken: newerOwner, eventFingerprint: dedupEventFingerprint(metadata, newerResult) },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    retainUntil: Math.floor(Date.now() / 1000) + 300,
  });
  releaseLegacyRead();

  await assert.rejects(staleAttempt, error => error instanceof WebhookDedupConflictError);
  assert.equal(calls, 0);
  assert.equal((await delegate.get(key)).payloadHash, newerOwner);
});

test('webhookDedup rejects a changed payload after an active lease expires inside the retained window', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ idempotency_key: 'retained_expired_claim_0001' });
  const originalResult = { media_buy_id: 'mb_original' };
  const owner = 'expired-owner';
  await backend.put(dedupStorageKey(metadata), {
    payloadHash: owner,
    response: { claimToken: owner, eventFingerprint: dedupEventFingerprint(metadata, originalResult) },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    retainUntil: Math.floor(Date.now() / 1000) + 300,
  });
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_changed' }, metadata }),
    error => error instanceof WebhookDedupConflictError
  );
  assert.equal(calls, 0);
});

test('webhookDedup preserves expired-lease payload conflicts through the Redis adapter', async () => {
  const values = new Map();
  const prefix = 'webhook-expiry:';
  const metadata = baseMetadata({ idempotency_key: 'redis_expired_claim_0001' });
  const originalResult = { media_buy_id: 'mb_original' };
  const owner = 'expired-owner';
  values.set(
    `${prefix}${dedupStorageKey(metadata)}`,
    JSON.stringify({
      payloadHash: owner,
      response: { claimToken: owner, eventFingerprint: dedupEventFingerprint(metadata, originalResult) },
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      retainUntil: Math.floor(Date.now() / 1000) + 300,
    })
  );
  const backend = redisBackend(
    {
      get: async key => values.get(key) ?? null,
      set: async () => 'OK',
      del: async () => 0,
      eval: async () => {
        throw new Error('changed payload must conflict before Redis takeover');
      },
      ping: async () => 'PONG',
    },
    { keyPrefix: prefix }
  );
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  await assert.rejects(
    handler.handleWebhook({ result: { media_buy_id: 'mb_changed' }, metadata }),
    error => error instanceof WebhookDedupConflictError
  );
  assert.equal(calls, 0);
});

test('webhookDedup fails closed on an unknown expired entry inside its retention window', async () => {
  const backend = memoryBackend({ sweepIntervalMs: 0 });
  const metadata = baseMetadata({ idempotency_key: 'retained_unknown_claim_0001' });
  await backend.put(dedupStorageKey(metadata), {
    payloadHash: 'unknown-owner',
    response: { unexpected: true },
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    retainUntil: Math.floor(Date.now() / 1000) + 300,
  });
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300, inFlightTtlSeconds: 1 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  assert.equal(await handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata }), 'in_progress');
  assert.equal(calls, 0);
});

test('webhookDedup: handler exception releases the claim for an exact retry', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = () => {}; // swallow expected handler-error log
  try {
    const handler = new AsyncHandler({
      webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
      onCreateMediaBuyStatusChange: (_response, metadata) => {
        calls.push(metadata.idempotency_key);
        throw new Error('downstream db write failed');
      },
    });

    const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };
    await assert.rejects(handler.handleWebhook(args), /downstream db write failed/);
    await assert.rejects(
      handler.handleWebhook({ ...args, result: { media_buy_id: 'mb_changed' } }),
      error => error instanceof WebhookDedupConflictError
    );
    await assert.rejects(handler.handleWebhook(args), /downstream db write failed/);
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(calls.length, 2, 'an unacknowledged delivery remains retryable');
});

test('webhookDedup keeps the claim when handled-marker publication fails after callback success', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  let releaseCalls = 0;
  const backend = {
    ...delegate,
    replaceIfPayloadHash: async (key, expected, entry) => {
      if (entry.response?.state === 'adcp_webhook_handled_v1') throw new Error('publish backend outage');
      if (entry.response?.claimToken && entry.expiresAt < Math.floor(Date.now() / 1000)) releaseCalls += 1;
      return delegate.replaceIfPayloadHash(key, expected, entry);
    },
  };
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };

  await assert.rejects(handler.handleWebhook(args), /publish backend outage/);
  assert.strictEqual(await handler.handleWebhook(args), 'in_progress');
  assert.strictEqual(calls, 1);
  assert.strictEqual(releaseCalls, 0, 'post-callback publication failure must not release the side-effect fence');
});

test('webhookDedup observes handled state when publication commits and then throws', async () => {
  const delegate = memoryBackend({ sweepIntervalMs: 0 });
  let throwAfterCommit = true;
  const backend = {
    ...delegate,
    replaceIfPayloadHash: async (key, expected, entry) => {
      const replaced = await delegate.replaceIfPayloadHash(key, expected, entry);
      if (entry.response?.state === 'adcp_webhook_handled_v1' && throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error('connection dropped after commit');
      }
      return replaced;
    },
  };
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend, ttlSeconds: 300 },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });
  const args = { result: { media_buy_id: 'mb_1' }, metadata: baseMetadata() };

  await assert.rejects(handler.handleWebhook(args), /connection dropped after commit/);
  assert.strictEqual(await handler.handleWebhook(args), 'already_handled');
  assert.strictEqual(calls, 1);
});

test('webhookDedup starts the full handled retention window at publication time', async () => {
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const metadata = baseMetadata();
    const handler = new AsyncHandler({
      webhookDedup: { backend, ttlSeconds: 60 },
      onCreateMediaBuyStatusChange: () => {
        now += 120_000;
      },
    });
    await handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata });
    const handled = await backend.get(dedupStorageKey(metadata));
    assert.strictEqual(handled.expiresAt, Math.floor(now / 1000) + 60);
  } finally {
    Date.now = originalNow;
  }
});

test('webhookDedup: invalid idempotency_key fails closed before dispatch', async () => {
  const calls = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: (_response, metadata) => {
      calls.push(metadata.task_id);
    },
  });

  // Too short (min 16 chars).
  const tooShort = baseMetadata({ idempotency_key: 'short', protocol: 'mcp' });
  await assert.rejects(handler.handleWebhook({ result: {}, metadata: tooShort }), /idempotency_key is invalid/);

  // Contains separator byte (U+001F), including on the legacy A2A path.
  const separator = baseMetadata({
    idempotency_key: `poisoned\u001fagent_other\u001fkey`,
    protocol: 'a2a',
  });
  await assert.rejects(handler.handleWebhook({ result: {}, metadata: separator }), /idempotency_key is invalid/);

  assert.strictEqual(calls.length, 0, 'malformed keys must not bypass configured dedup');
});

test('webhookDedup: A2A webhook without idempotency_key fails closed', async () => {
  let calls = 0;
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: () => {
      calls += 1;
    },
  });

  const meta = baseMetadata({ protocol: 'a2a' });
  delete meta.idempotency_key;
  await assert.rejects(handler.handleWebhook({ result: {}, metadata: meta }), /idempotency_key is required/);
  assert.strictEqual(calls, 0);
});

test('webhook_duplicate activity omits payload, includes idempotency_key for correlation', async () => {
  const activities = [];
  const handler = new AsyncHandler({
    webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
    onCreateMediaBuyStatusChange: () => {},
    onActivity: a => activities.push(a),
  });

  const result = { media_buy_id: 'mb_1', secret_token: 'SHOULD_NOT_APPEAR_IN_DUP_ACTIVITY' };
  const meta = baseMetadata();
  await handler.handleWebhook({ result, metadata: meta });
  await handler.handleWebhook({ result, metadata: meta });

  const received = activities.find(a => a.type === 'webhook_received');
  const duplicate = activities.find(a => a.type === 'webhook_duplicate');

  assert.ok(received && duplicate, 'both events present');
  assert.strictEqual(received.payload.media_buy_id, 'mb_1');
  assert.strictEqual(received.idempotency_key, meta.idempotency_key);
  assert.strictEqual(duplicate.payload, undefined, 'duplicate omits payload');
  assert.strictEqual(duplicate.idempotency_key, meta.idempotency_key, 'duplicate carries key for correlation');
});
