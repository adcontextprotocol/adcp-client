const { test } = require('node:test');
const assert = require('node:assert');
const { AsyncHandler } = require('../../dist/lib/core/AsyncHandler');
const { memoryBackend } = require('../../dist/lib/server/idempotency/backends/memory');
const { AdCPClient } = require('../../dist/lib/index.js');

function baseMetadata(overrides = {}) {
  return {
    operation_id: 'op_1',
    task_id: 'task_1',
    agent_id: 'agent_1',
    task_type: 'create_media_buy',
    status: 'completed',
    timestamp: new Date().toISOString(),
    idempotency_key: 'whk_01HW9D3H8FZP2N6R8T0V4X6Z9B',
    ...overrides,
  };
}

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

test('webhookDedup missing idempotency_key: warns and dispatches', async () => {
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    const handler = new AsyncHandler({
      webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
      onCreateMediaBuyStatusChange: (_response, metadata) => {
        calls.push(metadata.task_id);
      },
    });

    const meta = baseMetadata();
    delete meta.idempotency_key;
    await handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata: meta });
    await handler.handleWebhook({ result: { media_buy_id: 'mb_1' }, metadata: meta });
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(calls.length, 2, 'should dispatch both deliveries without dedup');
  assert.strictEqual(warnings.length, 2);
  assert.match(warnings[0], /no idempotency_key/);
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

  // Simulate TTL expiry by evicting the dedup entry directly. Scoped key
  // uses the reserved `adcp\u001fwebhook\u001fv1\u001f...` prefix.
  await backend.delete(`adcp\u001fwebhook\u001fv1\u001fagent_1\u001fwhk_expiry_test_0000001`);

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

test('webhookDedup: handler exception does NOT release the claim (at-most-once contract)', async () => {
  // Current behavior: handler errors are caught and logged; the publisher
  // sees 2xx. The claim must stay so the publisher's non-retry doesn't
  // leak into a later unrelated retry re-triggering the broken handler.
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
    await handler.handleWebhook(args);
    await handler.handleWebhook(args);
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(calls.length, 1, 'handler runs once even though it threw');
});

test('webhookDedup: invalid idempotency_key (fails spec regex) treated as missing', async () => {
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    const handler = new AsyncHandler({
      webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
      onCreateMediaBuyStatusChange: (_response, metadata) => {
        calls.push(metadata.task_id);
      },
    });

    // Too short (min 16 chars).
    const tooShort = baseMetadata({ idempotency_key: 'short', protocol: 'mcp' });
    await handler.handleWebhook({ result: {}, metadata: tooShort });
    await handler.handleWebhook({ result: {}, metadata: tooShort });

    // Contains separator byte (U+001F).
    const separator = baseMetadata({
      idempotency_key: `poisoned\u001fagent_other\u001fkey`,
      protocol: 'mcp',
    });
    await handler.handleWebhook({ result: {}, metadata: separator });
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(calls.length, 3, 'all three dispatch (no dedup applied)');
  assert.strictEqual(warnings.length, 3);
  assert.ok(
    warnings.every(w => /invalid idempotency_key/.test(w)),
    'warning indicates the key is invalid, not missing'
  );
});

test('webhookDedup: A2A webhook without idempotency_key does NOT warn', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    const handler = new AsyncHandler({
      webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
      onCreateMediaBuyStatusChange: () => {},
    });

    const meta = baseMetadata({ protocol: 'a2a' });
    delete meta.idempotency_key;
    await handler.handleWebhook({ result: {}, metadata: meta });
    await handler.handleWebhook({ result: {}, metadata: meta });
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(warnings.length, 0, 'A2A should not warn — field is not in the protocol');
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
