const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  InMemoryWebhookRegistrationStore,
  SingleAgentClient,
  cleanupExpiredWebhookRegistrations,
  getWebhookRegistrationMigration,
  pgWebhookRegistrationStore,
  redisWebhookRegistrationStore,
} = require('../../dist/lib/index.js');
const { runWebhookRegistrationStoreContract } = require('../helpers/webhook-registration-store-contract.js');

const agent = {
  id: 'durable-registration-seller',
  name: 'Durable registration seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function registration(operationId, overrides = {}) {
  const createdAt = Date.now();
  return {
    agentId: agent.id,
    agentUrl: agent.agent_uri,
    protocol: agent.protocol,
    operationId,
    taskType: 'create_media_buy',
    callbackUrl: `https://buyer.example/webhooks/create_media_buy/${operationId}`,
    method: 'POST',
    mode: 'hmac-sha256',
    authorizationContextVersion: 1,
    delegatedOperatorAuthorization: { brand: 'brand_a', scope: 'media_buying', country: 'GB' },
    createdAt,
    expiresAt: createdAt + 60_000,
    ...overrides,
  };
}

function redisStorageKey(prefix, agentId, operationId) {
  const digest = createHash('sha256')
    .update(JSON.stringify([agentId, operationId]))
    .digest('hex');
  return `${prefix}${digest}`;
}

function hmacHeaders(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'x-adcp-signature': `sha256=${digest}`,
    'x-adcp-timestamp': String(timestamp),
  };
}

runWebhookRegistrationStoreContract('InMemoryWebhookRegistrationStore', async () => {
  let now = Date.now();
  return {
    store: new InMemoryWebhookRegistrationStore({ now: () => now }),
    expire: async ({ registration: value }) => {
      now = value.expiresAt;
    },
  };
});

test('client rejects a registration store that acknowledges but drops the durable marker', async () => {
  let persisted;
  const lossyStore = {
    async putIfAbsent(value) {
      persisted = structuredClone(value);
    },
    async get() {
      return persisted;
    },
    async markRequiresDurableSettlement() {},
  };
  const client = new SingleAgentClient(agent, {
    webhookSecret: 'marker-readback-secret',
    webhookRegistrationStore: lossyStore,
  });
  await client.persistWebhookRegistration({
    agent,
    taskType: 'create_media_buy',
    operationId: 'lossy-marker-operation',
    callbackUrl: 'https://buyer.example/webhooks/create_media_buy/lossy-marker-operation',
    mode: 'hmac-sha256',
  });
  await assert.rejects(
    () => client.markWebhookDurableSettlementRequired('lossy-marker-operation'),
    /did not preserve the durable-settlement requirement/
  );
});

test('corrupt durable state never falls back to recordless read-only HMAC verification', async () => {
  const secret = 'corrupt-registration-secret';
  const operationId = 'corrupt-read-only-registration';
  const client = new SingleAgentClient(agent, {
    webhookSecret: secret,
    webhookRegistrationStore: {
      async putIfAbsent() {},
      async get() {
        return registration(operationId, {
          agentId: 'substituted-seller',
          taskType: 'list_products',
          mode: 'hmac-sha256',
        });
      },
    },
  });
  const rawBody = JSON.stringify({
    idempotency_key: 'corrupt-registration-delivery',
    operation_id: operationId,
    task_id: 'corrupt-registration-task',
    task_type: 'list_products',
    status: 'completed',
    timestamp: new Date().toISOString(),
    result: { products: [] },
  });
  const parsed = await client.verifyAndParseWebhook({
    rawBody,
    headers: hmacHeaders(rawBody, secret),
    taskType: 'list_products',
    operationId,
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'webhook_registration_store_unavailable');
});

test('durable registration backends require deployment isolation in production', () => {
  const script = `
    const {
      pgWebhookRegistrationStore,
      redisWebhookRegistrationStore,
    } = require(${JSON.stringify(require.resolve('../../dist/lib/index.js'))});
    const client = { eval: async () => null, ping: async () => 'PONG' };
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    try { pgWebhookRegistrationStore(db); process.exit(8); }
    catch (error) { if (!/deployment-unique tableName/.test(error.message)) throw error; }
    try { redisWebhookRegistrationStore(client); process.exit(9); }
    catch (error) { if (!/deployment-unique keyPrefix/.test(error.message)) throw error; }
    pgWebhookRegistrationStore(db, { tableName: 'prod_eu_webhook_registrations' });
    redisWebhookRegistrationStore(client, { keyPrefix: 'prod-eu:webhook-registration:v1:' });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

async function proveFreshReceiverAcceptsMutation(storeA, storeB, label) {
  const secret = `shared-hmac-${label}`;
  const operationId = `durable-registration-restart-${label}`;
  const callbackUrl = `https://buyer.example/webhooks/create_media_buy/${operationId}`;
  const producer = new SingleAgentClient(agent, {
    webhookSecret: secret,
    webhookRegistrationStore: storeA,
    strictSchemaValidation: false,
    validateFeatures: false,
  });
  await producer.persistWebhookRegistration({
    agent,
    taskType: 'create_media_buy',
    operationId,
    callbackUrl,
    mode: 'hmac-sha256',
    delegatedOperatorAuthorization: { brand: 'brand_a', scope: 'media_buying', country: 'GB' },
  });
  await producer.markWebhookDurableSettlementRequired(operationId);

  const handlerCalls = [];
  const recoveries = [];
  const receiver = new SingleAgentClient(agent, {
    webhookSecret: secret,
    webhookRegistrationStore: storeB,
    strictSchemaValidation: false,
    validateFeatures: false,
    handlers: {
      onCreateMediaBuyStatusChange: (result, metadata) => handlerCalls.push({ result, metadata }),
    },
  });
  receiver.registerDurableSettlementRecovery(async (recoveredOperationId, observation) => {
    recoveries.push({ operationId: recoveredOperationId, observation });
    return { settled: true, status: observation.status, result: observation.result };
  });

  const payload = {
    idempotency_key: `delivery-${label}`,
    operation_id: operationId,
    task_id: `task-${label}`,
    task_type: 'create_media_buy',
    status: 'completed',
    timestamp: new Date().toISOString(),
    result: { media_buy_id: `buy-${label}`, packages: [] },
  };
  const rawBody = JSON.stringify(payload);
  const parsed = await receiver.verifyAndParseWebhook({
    rawBody,
    headers: hmacHeaders(rawBody, secret),
    taskType: 'create_media_buy',
    operationId,
    requestMethod: 'POST',
    requestUrl: callbackUrl,
  });
  assert.equal(parsed.ok, true);
  assert.equal(await receiver.dispatchParsedWebhook(parsed), true);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].operationId, operationId);
  assert.equal(handlerCalls.length, 1);
}

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const tableName = `adcp_wh_registration_${randomBytes(4).toString('hex')}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ready = pool.query(getWebhookRegistrationMigration({ tableName }));

  after(async () => {
    await ready;
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.end();
  });

  runWebhookRegistrationStoreContract('pgWebhookRegistrationStore (live)', async () => {
    await ready;
    const store = pgWebhookRegistrationStore(pool, { tableName });
    return {
      store,
      expire: async ({ registration: value }) => {
        await pool.query(
          `UPDATE "${tableName}" SET expires_at = clock_timestamp() - interval '1 millisecond', created_at = clock_timestamp() - interval '2 milliseconds' WHERE agent_id = $1 AND operation_id = $2`,
          [value.agentId, value.operationId]
        );
      },
    };
  });

  test('PostgreSQL registration store probes, rejects stale creates, cleans up, and survives reconstruction', async () => {
    await ready;
    const first = pgWebhookRegistrationStore(pool, { tableName });
    await first.probe();
    const expired = registration('pg-already-expired', {
      createdAt: Date.now() - 2_000,
      expiresAt: Date.now() - 1_000,
    });
    await assert.rejects(() => first.putIfAbsent(expired), /expired webhook registration/i);
    assert.equal(await first.get(expired.agentId, expired.operationId), undefined);

    const cleanupTarget = registration('pg-cleanup-target');
    await first.putIfAbsent(cleanupTarget);
    await pool.query(
      `UPDATE "${tableName}" SET expires_at = clock_timestamp() - interval '1 millisecond', created_at = clock_timestamp() - interval '2 milliseconds' WHERE agent_id = $1 AND operation_id = $2`,
      [cleanupTarget.agentId, cleanupTarget.operationId]
    );
    assert.deepEqual(await cleanupExpiredWebhookRegistrations(pool, { tableName, batchSize: 1 }), { deleted: 1 });
    assert.equal(await first.get(cleanupTarget.agentId, cleanupTarget.operationId), undefined);

    const corruptOperationId = 'pg-corrupt-read-only-registration';
    const corruptValue = registration(corruptOperationId, { taskType: 'list_products' });
    await first.putIfAbsent(corruptValue);
    await pool.query(`UPDATE "${tableName}" SET agent_url = 'not a URL' WHERE agent_id = $1 AND operation_id = $2`, [
      corruptValue.agentId,
      corruptValue.operationId,
    ]);
    const corruptReceiver = new SingleAgentClient(agent, {
      webhookSecret: 'pg-corrupt-secret',
      webhookRegistrationStore: first,
    });
    const corruptBody = JSON.stringify({
      idempotency_key: 'pg-corrupt-delivery',
      operation_id: corruptOperationId,
      task_id: 'pg-corrupt-task',
      task_type: 'list_products',
      status: 'completed',
      timestamp: new Date().toISOString(),
      result: { products: [] },
    });
    const corruptParsed = await corruptReceiver.verifyAndParseWebhook({
      rawBody: corruptBody,
      headers: hmacHeaders(corruptBody, 'pg-corrupt-secret'),
      taskType: 'list_products',
      operationId: corruptOperationId,
    });
    assert.equal(corruptParsed.ok, false);
    assert.equal(corruptParsed.code, 'webhook_registration_store_unavailable');

    await proveFreshReceiverAcceptsMutation(
      pgWebhookRegistrationStore(pool, { tableName }),
      pgWebhookRegistrationStore(pool, { tableName }),
      'postgres'
    );
  });

  test('PostgreSQL samples expiry only after a conflicting registration lock is acquired', async () => {
    await ready;
    const operationId = 'pg-conflict-crosses-expiry';
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const first = registration(operationId, {
        createdAt: Date.now(),
        expiresAt: Date.now() + 300,
      });
      await pgWebhookRegistrationStore(holder, { tableName }).putIfAbsent(first);

      const replacement = registration(operationId, {
        callbackUrl: `https://buyer.example/webhooks/create_media_buy/${operationId}/replacement`,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const waitingPut = pgWebhookRegistrationStore(pool, { tableName }).putIfAbsent(replacement);
      await new Promise(resolve => setTimeout(resolve, 450));
      await holder.query('COMMIT');
      await waitingPut;

      assert.deepEqual(await pgWebhookRegistrationStore(pool, { tableName }).get(agent.id, operationId), replacement);
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {}
      holder.release();
    }
  });
}

if (process.env.REDIS_URL) {
  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  const ready = client.connect();
  const prefix = `adcp:test:webhook-registration:${randomBytes(6).toString('hex')}:`;

  after(async () => {
    await ready;
    const keys = await client.keys(`${prefix}*`);
    if (keys.length > 0) await client.del(keys);
    await client.quit();
  });

  runWebhookRegistrationStoreContract('redisWebhookRegistrationStore (live)', async () => {
    await ready;
    const store = redisWebhookRegistrationStore(client, { keyPrefix: prefix });
    return {
      store,
      expire: async ({ registration: value }) => {
        const expired = await client.pExpireAt(
          redisStorageKey(prefix, value.agentId, value.operationId),
          Date.now() - 1
        );
        assert.ok(
          expired === true || expired === 1,
          'the exact Redis registration key must exist before forced expiry'
        );
      },
    };
  });

  test('Redis registration store preserves TTL, hides keys, rejects corruption, and survives reconstruction', async () => {
    await ready;
    const first = redisWebhookRegistrationStore(client, { keyPrefix: prefix });
    await first.probe();
    const value = registration('redis-ttl');
    await first.putIfAbsent(value);
    const key = redisStorageKey(prefix, value.agentId, value.operationId);
    assert.doesNotMatch(key, /durable-registration-seller|redis-ttl|buyer|seller\.example/);
    const expiryBefore = await client.pExpireTime(key);
    await first.putIfAbsent({ ...value, expiresAt: value.expiresAt + 10_000 });
    await first.markRequiresDurableSettlement(value.agentId, value.operationId);
    assert.equal(
      await client.pExpireTime(key),
      expiryBefore,
      'idempotent writes and marking must preserve absolute expiry'
    );

    const corruptOperationId = 'redis-corrupt-canary-operation';
    const corruptKey = redisStorageKey(prefix, agent.id, corruptOperationId);
    await client.set(corruptKey, '{"sellerSecret":"do-not-expose"', { PX: 60_000 });
    await assert.rejects(
      () => first.get(agent.id, corruptOperationId),
      error => {
        assert.match(error.message, /corrupt registration state/);
        assert.doesNotMatch(String(error), /do-not-expose|redis-corrupt-canary-operation/);
        return true;
      }
    );
    const corruptReceiver = new SingleAgentClient(agent, {
      webhookSecret: 'redis-corrupt-secret',
      webhookRegistrationStore: first,
    });
    const corruptBody = JSON.stringify({
      idempotency_key: 'redis-corrupt-delivery',
      operation_id: corruptOperationId,
      task_id: 'redis-corrupt-task',
      task_type: 'list_products',
      status: 'completed',
      timestamp: new Date().toISOString(),
      result: { products: [] },
    });
    const corruptParsed = await corruptReceiver.verifyAndParseWebhook({
      rawBody: corruptBody,
      headers: hmacHeaders(corruptBody, 'redis-corrupt-secret'),
      taskType: 'list_products',
      operationId: corruptOperationId,
    });
    assert.equal(corruptParsed.ok, false);
    assert.equal(corruptParsed.code, 'webhook_registration_store_unavailable');

    const upperRange = registration('redis-upper-range-timestamp', {
      createdAt: 253_402_300_798_999,
      expiresAt: 253_402_300_799_999,
      requiresDurableSettlement: undefined,
    });
    await first.putIfAbsent(upperRange);
    await first.markRequiresDurableSettlement(upperRange.agentId, upperRange.operationId);
    assert.deepEqual(await first.get(upperRange.agentId, upperRange.operationId), {
      ...upperRange,
      requiresDurableSettlement: true,
    });

    await proveFreshReceiverAcceptsMutation(
      redisWebhookRegistrationStore(client, { keyPrefix: prefix }),
      redisWebhookRegistrationStore(client, { keyPrefix: prefix }),
      'redis'
    );
  });
}
