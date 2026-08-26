const { describe, test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  ADCPMultiAgentClient,
  InMemoryWebhookRegistrationStore,
  SingleAgentClient,
  TaskExecutor,
  memoryBackend,
} = require('../dist/lib/index.js');
const { ProtocolClient, prepareProtocolToolCall } = require('../dist/lib/protocols/index.js');
const {
  preparedProtocolToolCallFor,
  withPreparedProtocolToolCall,
} = require('../dist/lib/protocols/prepared-call-context.js');
const { signWebhook } = require('../dist/lib/signing/signer.js');
const { StaticJwksResolver } = require('../dist/lib/signing/jwks.js');
const { ResolvedAgentJwksResolver } = require('../dist/lib/signing/agent-resolver/index.js');

const agent = {
  id: 'seller-1',
  name: 'Seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function envelope(overrides = {}) {
  return {
    idempotency_key: 'whk_rfc9421_0000001',
    operation_id: 'op-rfc-1',
    task_id: 'task-rfc-1',
    task_type: 'get_products',
    status: 'completed',
    timestamp: new Date().toISOString(),
    result: { products: [] },
    ...overrides,
  };
}

function keypair(kid = 'seller-webhook-2026') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  return {
    signer: {
      keyid: kid,
      alg: 'ed25519',
      privateKey: { ...privateJwk, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['sign'] },
    },
    publicJwk: { ...publicJwk, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['verify'] },
  };
}

async function registeredRfcClient() {
  const store = new InMemoryWebhookRegistrationStore();
  const callbackUrl = 'https://buyer.example/webhooks/get_products/op-rfc-1';
  await store.putIfAbsent({
    agentId: agent.id,
    agentUrl: agent.agent_uri,
    protocol: agent.protocol,
    operationId: 'op-rfc-1',
    taskType: 'get_products',
    callbackUrl,
    method: 'POST',
    mode: 'rfc9421',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const { signer, publicJwk } = keypair();
  const client = new SingleAgentClient(agent, {
    webhookRegistrationStore: store,
    webhookVerification: { jwks: new StaticJwksResolver([publicJwk]) },
  });
  return { client, callbackUrl, signer };
}

async function registeredA2ARfcClient({ durable = false, handlers } = {}) {
  const a2aAgent = {
    id: 'seller-a2a',
    name: 'A2A Seller',
    agent_uri: 'https://seller.example/a2a',
    protocol: 'a2a',
  };
  const store = new InMemoryWebhookRegistrationStore();
  const callbackUrl = 'https://buyer.example/webhooks/create_media_buy/op-a2a-1';
  await store.putIfAbsent({
    agentId: a2aAgent.id,
    agentUrl: a2aAgent.agent_uri,
    protocol: a2aAgent.protocol,
    operationId: 'op-a2a-1',
    taskType: 'create_media_buy',
    callbackUrl,
    method: 'POST',
    mode: 'rfc9421',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  if (durable) await store.markRequiresDurableSettlement(a2aAgent.id, 'op-a2a-1');
  const { signer, publicJwk } = keypair('seller-a2a-webhook-2026');
  const client = new SingleAgentClient(a2aAgent, {
    webhookRegistrationStore: store,
    webhookVerification: { jwks: new StaticJwksResolver([publicJwk]) },
    strictSchemaValidation: false,
    validateFeatures: false,
    ...(handlers && { handlers }),
  });
  return { client, callbackUrl, signer };
}

function a2aTaskWebhook(status, result) {
  return {
    kind: 'task',
    id: 'a2a-transport-task',
    contextId: 'a2a-context',
    status: { state: 'completed', timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifactId: 'a2a-webhook-artifact',
        metadata: { adcp_task_id: 'adcp-work-task' },
        parts: [
          {
            kind: 'data',
            data: {
              status,
              task_id: 'adcp-work-task',
              task_type: 'create_media_buy',
              ...(result !== undefined && { result }),
            },
          },
        ],
      },
    ],
  };
}

function hmacHeaders(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'x-adcp-signature': `sha256=${digest}`,
    'x-adcp-timestamp': String(timestamp),
  };
}

function makeResponse() {
  return {
    statusCode: 0,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
    writeHead(code) {
      this.statusCode = code;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}

test('webhook registrations persist durable-settlement routing provenance', async () => {
  const store = new InMemoryWebhookRegistrationStore();
  await store.putIfAbsent({
    agentId: agent.id,
    agentUrl: agent.agent_uri,
    protocol: agent.protocol,
    operationId: 'op-durable-settlement-marker',
    taskType: 'create_media_buy',
    callbackUrl: 'https://buyer.example/webhooks/create_media_buy/op-durable-settlement-marker',
    method: 'POST',
    mode: 'rfc9421',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });

  await store.markRequiresDurableSettlement(agent.id, 'op-durable-settlement-marker');
  assert.equal((await store.get(agent.id, 'op-durable-settlement-marker')).requiresDurableSettlement, true);
});

describe('SingleAgentClient RFC 9421 webhook receiver', () => {
  test('verifies the registered seller, public URL, and exact raw bytes', async () => {
    const { client, callbackUrl, signer } = await registeredRfcClient();
    const rawBody = JSON.stringify(envelope());
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const result = await client.verifyAndParseWebhook({
      rawBody: Buffer.from(rawBody),
      payload: envelope({ idempotency_key: 'attacker-controlled-parsed-copy' }),
      headers: signed.headers,
      taskType: 'get_products',
      operationId: 'op-rfc-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.metadata.idempotencyKey, 'whk_rfc9421_0000001');

    const replay = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'get_products',
      operationId: 'op-rfc-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(replay.ok, false);
    assert.strictEqual(replay.code, 'webhook_signature_replayed');
  });

  test('rejects mode substitution and a different externally visible URL without fallback', async () => {
    const { client, callbackUrl, signer } = await registeredRfcClient();
    const rawBody = JSON.stringify(envelope());
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );

    const legacyHeaders = await client.verifyAndParseWebhook({
      rawBody,
      headers: { ...signed.headers, 'x-adcp-timestamp': String(Math.floor(Date.now() / 1000)) },
      operationId: 'op-rfc-1',
      taskType: 'get_products',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(legacyHeaders.ok, false);
    assert.strictEqual(legacyHeaders.code, 'webhook_mode_mismatch');

    const wrongUrl = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      operationId: 'op-rfc-1',
      taskType: 'get_products',
      requestMethod: 'POST',
      requestUrl: 'https://buyer.example/webhooks/get_products/other',
    });
    assert.strictEqual(wrongUrl.ok, false);
    assert.strictEqual(wrongUrl.code, 'webhook_signature_invalid');
  });

  test('requires trusted route provenance for an RFC-signed request', async () => {
    const { client, callbackUrl, signer } = await registeredRfcClient();
    const rawBody = JSON.stringify(envelope());
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const result = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'webhook_verification_context_missing');
  });

  test('compares authenticated payload routing claims to the trusted registration', async () => {
    const { client, callbackUrl, signer } = await registeredRfcClient();
    const rawBody = JSON.stringify(envelope({ operation_id: 'different-operation' }));
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const result = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'get_products',
      operationId: 'op-rfc-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'webhook_envelope_invalid');
  });

  test('uses configured HMAC without persisting secret-derived material and rejects selector substitution', async () => {
    const secret = 'legacy-secret';
    const store = new InMemoryWebhookRegistrationStore();
    const registration = {
      agentId: agent.id,
      agentUrl: agent.agent_uri,
      protocol: agent.protocol,
      operationId: 'op-rfc-1',
      taskType: 'get_products',
      callbackUrl: 'https://buyer.example/webhooks/get_products/op-rfc-1',
      method: 'POST',
      mode: 'hmac-sha256',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    await store.putIfAbsent(registration);
    assert.ok(!JSON.stringify(registration).includes(secret));

    const client = new SingleAgentClient(agent, {
      webhookSecret: secret,
      webhookRegistrationStore: store,
    });
    const rawBody = JSON.stringify(envelope());
    const headers = hmacHeaders(rawBody, secret);
    const verified = await client.verifyAndParseWebhook({
      rawBody,
      headers,
      taskType: 'get_products',
      operationId: 'op-rfc-1',
    });
    assert.strictEqual(verified.ok, true);

    const substituted = await client.verifyAndParseWebhook({
      rawBody,
      headers: { ...headers, signature: 'sig1=:AAAA:' },
      taskType: 'get_products',
      operationId: 'op-rfc-1',
    });
    assert.strictEqual(substituted.ok, false);
    assert.strictEqual(substituted.code, 'webhook_mode_mismatch');
  });

  test('preserves recordless legacy HMAC compatibility only for explicitly read-only tasks', async () => {
    const secret = 'legacy-secret';
    const unavailableStore = {
      async get() {
        throw new Error('store unavailable');
      },
      async putIfAbsent() {
        throw new Error('store unavailable');
      },
    };
    const client = new SingleAgentClient(agent, {
      webhookSecret: secret,
      webhookRegistrationStore: unavailableStore,
    });
    const rawBody = JSON.stringify(envelope({ operation_id: 'unregistered-operation', task_type: 'list_products' }));
    const headers = hmacHeaders(rawBody, secret);
    const verified = await client.verifyAndParseWebhook({
      rawBody,
      headers,
      taskType: 'list_products',
      operationId: 'unregistered-operation',
    });
    assert.strictEqual(verified.ok, true);

    const mutatingRawBody = JSON.stringify(
      envelope({
        operation_id: 'unregistered-mutation',
        task_type: 'create_media_buy',
        result: { media_buy_id: 'must-not-dispatch' },
      })
    );
    const mutatingVerified = await client.verifyAndParseWebhook({
      rawBody: mutatingRawBody,
      headers: hmacHeaders(mutatingRawBody, secret),
      taskType: 'create_media_buy',
      operationId: 'unregistered-mutation',
    });
    assert.strictEqual(mutatingVerified.ok, false);
    assert.strictEqual(mutatingVerified.code, 'webhook_registration_store_unavailable');

    const recoveredStoreClient = new SingleAgentClient(agent, {
      webhookSecret: secret,
      webhookRegistrationStore: {
        async get() {
          return undefined;
        },
        async putIfAbsent() {},
      },
    });
    for (const taskType of ['create_media_buy', 'get_products', 'extension_task']) {
      const missingRawBody = JSON.stringify(envelope({ operation_id: `missing-${taskType}`, task_type: taskType }));
      const missing = await recoveredStoreClient.verifyAndParseWebhook({
        rawBody: missingRawBody,
        headers: hmacHeaders(missingRawBody, secret),
        taskType,
        operationId: `missing-${taskType}`,
      });
      assert.strictEqual(missing.ok, false);
      assert.strictEqual(missing.code, 'webhook_registration_store_unavailable');
    }

    const registrationBase = {
      agent,
      taskType: 'list_products',
      operationId: 'op-persistence-outage',
      callbackUrl: 'https://buyer.example/webhook/op-persistence-outage',
    };
    await client.persistWebhookRegistration({ ...registrationBase, mode: 'hmac-sha256' });
    await assert.rejects(
      client.persistWebhookRegistration({ ...registrationBase, mode: 'rfc9421' }),
      error =>
        /Could not persist trusted webhook registration/.test(error.message) &&
        /store unavailable/.test(error.cause?.message)
    );
  });

  test('authenticates native A2A task and status-update callbacks from structured AdCP observations', async () => {
    for (const payload of [
      a2aTaskWebhook('completed', { media_buy_id: 'buy-a2a-task', packages: [] }),
      {
        kind: 'status-update',
        taskId: 'a2a-transport-status-task',
        contextId: 'a2a-status-context',
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            role: 'agent',
            messageId: 'a2a-status-message',
            parts: [
              {
                kind: 'data',
                data: {
                  status: 'completed',
                  task_id: 'adcp-work-task',
                  task_type: 'create_media_buy',
                  result: { media_buy_id: 'buy-a2a-status', packages: [] },
                },
              },
            ],
          },
        },
        final: true,
      },
    ]) {
      const { client, callbackUrl, signer } = await registeredA2ARfcClient();
      const rawBody = JSON.stringify(payload);
      const signed = signWebhook(
        { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
        signer
      );
      const parsed = await client.verifyAndParseWebhook({
        rawBody,
        headers: signed.headers,
        taskType: 'create_media_buy',
        operationId: 'op-a2a-1',
        requestMethod: 'POST',
        requestUrl: callbackUrl,
      });
      assert.strictEqual(parsed.ok, true);
      assert.strictEqual(parsed.protocol, 'a2a');
      assert.strictEqual(parsed.metadata.taskId, 'adcp-work-task');
      assert.strictEqual(parsed.metadata.status, 'completed');
      assert.notStrictEqual(parsed.metadata.taskId, payload.id ?? payload.taskId);
    }
  });

  test('authenticates an A2A 1.0 Task response envelope with JSON-encoded DataParts', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const payload = {
      task: {
        id: 'a2a-v1-transport-task',
        contextId: 'a2a-v1-context',
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: 'a2a-v1-result',
            parts: [
              {
                data: {
                  operation_id: 'op-a2a-1',
                  task_id: 'adcp-v1-work-task',
                  task_type: 'create_media_buy',
                  status: 'completed',
                  idempotency_key: 'a2a_v1_webhook_event_0001',
                  result: { media_buy_id: 'buy-a2a-v1', packages: [] },
                },
                mediaType: 'application/json',
              },
            ],
          },
        ],
      },
    };
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.protocol, 'a2a');
    assert.strictEqual(parsed.metadata.taskId, 'adcp-v1-work-task');
    assert.strictEqual(parsed.metadata.status, 'completed');
    assert.strictEqual(parsed.result.media_buy_id, 'buy-a2a-v1');
  });

  test('prefers a terminal Task artifact over stale status-message data and preserves A2A idempotency', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const payload = a2aTaskWebhook('completed', {
      media_buy_id: 'buy-final-artifact',
      packages: [],
    });
    payload.artifacts[0].parts[0].data.operation_id = 'op-a2a-1';
    payload.artifacts[0].parts[0].data.idempotency_key = 'a2a_webhook_event_0001';
    payload.status.message = {
      kind: 'message',
      role: 'agent',
      messageId: 'stale-progress-message',
      parts: [
        {
          kind: 'data',
          data: {
            operation_id: 'op-a2a-1',
            task_type: 'create_media_buy',
            task_id: 'adcp-work-task',
            status: 'working',
            result: { media_buy_id: 'buy-stale-message', packages: [] },
          },
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.metadata.status, 'completed');
    assert.strictEqual(parsed.metadata.idempotencyKey, 'a2a_webhook_event_0001');
    assert.strictEqual(parsed.result.media_buy_id, 'buy-final-artifact');
  });

  test('accepts native typed A2A terminal artifacts without conflating transport identity or state', async () => {
    for (const { adcpStatus, data } of [
      {
        adcpStatus: 'completed',
        data: { media_buy_id: 'buy-native-typed', packages: [] },
      },
      {
        adcpStatus: 'failed',
        data: { adcp_error: { code: 'SELLER_FAILURE', message: 'Seller rejected the operation' } },
      },
    ]) {
      const { client, callbackUrl, signer } = await registeredA2ARfcClient();
      const payload = {
        kind: 'task',
        id: 'a2a-transport-only-identity',
        contextId: 'a2a-native-context',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: 'native-typed-result',
            metadata: { adcp_status: adcpStatus, adcp_task_id: 'adcp-work-task' },
            parts: [{ kind: 'data', data }],
          },
        ],
      };
      const rawBody = JSON.stringify(payload);
      const signed = signWebhook(
        { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
        signer
      );
      const parsed = await client.verifyAndParseWebhook({
        rawBody,
        headers: signed.headers,
        taskType: 'create_media_buy',
        operationId: 'op-a2a-1',
        requestMethod: 'POST',
        requestUrl: callbackUrl,
      });
      assert.strictEqual(parsed.ok, true);
      assert.strictEqual(parsed.metadata.status, adcpStatus);
      assert.strictEqual(parsed.metadata.taskId, 'adcp-work-task');
      assert.notStrictEqual(parsed.metadata.taskId, payload.id);
    }
  });

  test('accepts prior-SDK terminal artifact names only on an RFC 9421-bound route', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const payload = {
      kind: 'task',
      id: 'legacy-a2a-transport-task',
      contextId: 'legacy-a2a-context',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      artifacts: [
        {
          artifactId: 'legacy-result',
          name: 'result',
          parts: [{ kind: 'data', data: { media_buy_id: 'buy-legacy-a2a', packages: [] } }],
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.metadata.status, 'completed');
    assert.strictEqual(parsed.metadata.taskId, 'op-a2a-1');
  });

  test('rejects replaying one HMAC-signed A2A callback body onto another registered route', async () => {
    const secret = 'legacy-a2a-route-secret';
    const a2aAgent = {
      id: 'seller-a2a-hmac',
      name: 'A2A HMAC Seller',
      agent_uri: 'https://seller.example/a2a',
      protocol: 'a2a',
    };
    const store = new InMemoryWebhookRegistrationStore();
    for (const operationId of ['op-a2a-hmac-a', 'op-a2a-hmac-b']) {
      await store.putIfAbsent({
        agentId: a2aAgent.id,
        agentUrl: a2aAgent.agent_uri,
        protocol: 'a2a',
        operationId,
        taskType: 'create_media_buy',
        callbackUrl: `https://buyer.example/webhooks/create_media_buy/${operationId}`,
        method: 'POST',
        mode: 'hmac-sha256',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    }
    const client = new SingleAgentClient(a2aAgent, {
      webhookSecret: secret,
      webhookRegistrationStore: store,
      strictSchemaValidation: false,
      validateFeatures: false,
    });
    const payload = a2aTaskWebhook('completed', { media_buy_id: 'buy-hmac-route-a', packages: [] });
    payload.artifacts[0].parts[0].data.operation_id = 'op-a2a-hmac-a';
    const rawBody = JSON.stringify(payload);
    const headers = hmacHeaders(rawBody, secret);
    const accepted = await client.verifyAndParseWebhook({
      rawBody,
      headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-hmac-a',
    });
    assert.strictEqual(accepted.ok, true);

    const statusPayload = {
      kind: 'status-update',
      taskId: 'a2a-hmac-transport-task',
      contextId: 'a2a-hmac-context',
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          kind: 'message',
          role: 'agent',
          messageId: 'a2a-hmac-status-message',
          parts: [
            {
              kind: 'data',
              data: {
                operation_id: 'op-a2a-hmac-a',
                task_type: 'create_media_buy',
                task_id: 'adcp-hmac-status-work-task',
                status: 'completed',
                result: { media_buy_id: 'buy-hmac-status-route-a', packages: [] },
              },
            },
          ],
        },
      },
      final: true,
    };
    const statusBody = JSON.stringify(statusPayload);
    const statusHeaders = hmacHeaders(statusBody, secret);
    const acceptedStatus = await client.verifyAndParseWebhook({
      rawBody: statusBody,
      headers: statusHeaders,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-hmac-a',
    });
    assert.strictEqual(acceptedStatus.ok, true);
    assert.strictEqual(acceptedStatus.metadata.taskId, 'adcp-hmac-status-work-task');

    const rejected = await client.verifyAndParseWebhook({
      rawBody,
      headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-hmac-b',
    });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'webhook_registration_mismatch');

    const rejectedStatus = await client.verifyAndParseWebhook({
      rawBody: statusBody,
      headers: statusHeaders,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-hmac-b',
    });
    assert.strictEqual(rejectedStatus.ok, false);
    assert.strictEqual(rejectedStatus.code, 'webhook_registration_mismatch');
  });

  test('accepts a Task DataPart work ID when artifact metadata omits the duplicate identity', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const payload = a2aTaskWebhook('completed', { media_buy_id: 'buy-data-id', packages: [] });
    delete payload.artifacts[0].metadata;
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.metadata.taskId, 'adcp-work-task');
  });

  test('metadata work status wins over a colliding typed domain status', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const payload = {
      kind: 'task',
      id: 'a2a-domain-status-transport-task',
      contextId: 'a2a-domain-status-context',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      artifacts: [
        {
          artifactId: 'native-domain-status-result',
          metadata: { adcp_status: 'completed', adcp_task_id: 'adcp-work-task' },
          parts: [
            {
              kind: 'data',
              data: { media_buy_id: 'buy-canceled', status: 'canceled', revision: 2, affected_packages: [] },
            },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.metadata.status, 'completed');
    assert.strictEqual(parsed.result.status, 'canceled');
  });

  test('rejects conflicting metadata and explicit DataPart task-envelope statuses', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const payload = a2aTaskWebhook('failed');
    payload.artifacts[0].metadata.adcp_status = 'completed';
    payload.artifacts[0].parts[0].data.error = { code: 'SELLER_FAILURE', message: 'failed' };
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'webhook_envelope_invalid');
  });

  test('keeps A2A submitted work non-terminal and rejects transport-only status', async () => {
    const { client, callbackUrl, signer } = await registeredA2ARfcClient();
    const submittedPayload = a2aTaskWebhook('submitted');
    const submittedBody = JSON.stringify(submittedPayload);
    const submittedSigned = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: submittedBody },
      signer
    );
    const submitted = await client.verifyAndParseWebhook({
      rawBody: submittedBody,
      headers: submittedSigned.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(submitted.ok, true);
    assert.strictEqual(submitted.metadata.status, 'submitted');
    assert.strictEqual(submitted.metadata.taskId, 'adcp-work-task');

    const second = await registeredA2ARfcClient();
    const transportOnly = {
      kind: 'status-update',
      taskId: 'a2a-transport-only',
      contextId: 'a2a-context',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    };
    const transportBody = JSON.stringify(transportOnly);
    const transportSigned = signWebhook(
      {
        method: 'POST',
        url: second.callbackUrl,
        headers: { 'content-type': 'application/json' },
        body: transportBody,
      },
      second.signer
    );
    const rejected = await second.client.verifyAndParseWebhook({
      rawBody: transportBody,
      headers: transportSigned.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: second.callbackUrl,
    });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'webhook_envelope_invalid');
  });

  test('durably settles an authenticated A2A terminal callback by AdCP work identity', async () => {
    const handlerCalls = [];
    const { client, callbackUrl, signer } = await registeredA2ARfcClient({
      durable: true,
      handlers: {
        onCreateMediaBuyStatusChange: (result, metadata) => handlerCalls.push({ result, metadata }),
      },
    });
    const recoveries = [];
    client.registerDurableSettlementRecovery(async (operationId, observation) => {
      recoveries.push({ operationId, observation });
      return { settled: true, status: 'completed', result: observation.result };
    });
    const payload = a2aTaskWebhook('completed', { media_buy_id: 'buy-a2a-durable', packages: [] });
    const rawBody = JSON.stringify(payload);
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      headers: signed.headers,
      taskType: 'create_media_buy',
      operationId: 'op-a2a-1',
      requestMethod: 'POST',
      requestUrl: callbackUrl,
    });
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(await client.dispatchParsedWebhook(parsed), true);
    assert.deepStrictEqual(recoveries[0], {
      operationId: 'op-a2a-1',
      observation: {
        status: 'completed',
        result: { media_buy_id: 'buy-a2a-durable', packages: [] },
        serverTaskId: 'adcp-work-task',
        taskType: 'create_media_buy',
      },
    });
    assert.strictEqual(handlerCalls.length, 1);
  });
});

describe('webhook registration provenance', () => {
  test('putIfAbsent is idempotent for exact provenance and rejects substitution', async () => {
    const store = new InMemoryWebhookRegistrationStore();
    const registration = {
      agentId: agent.id,
      agentUrl: agent.agent_uri,
      protocol: agent.protocol,
      operationId: 'op-store-1',
      taskType: 'get_products',
      callbackUrl: 'https://buyer.example/webhook/op-store-1',
      method: 'POST',
      mode: 'rfc9421',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    await store.putIfAbsent(registration);
    await store.putIfAbsent({ ...registration, createdAt: registration.createdAt + 1 });
    await assert.rejects(
      store.putIfAbsent({ ...registration, callbackUrl: 'https://attacker.example/webhook' }),
      /different trusted provenance/
    );
    await assert.rejects(store.putIfAbsent({ ...registration, previewMode: 'legacy' }), /different trusted provenance/);
    await assert.rejects(
      store.putIfAbsent({
        ...registration,
        operationId: 'op-agent-userinfo',
        agentUrl: 'https://seller-user:secret@seller.example/mcp',
      }),
      /userinfo credentials/
    );
  });

  test('strips seller URL userinfo before durable webhook registration', async () => {
    let persisted;
    const client = new SingleAgentClient(
      { ...agent, agent_uri: 'https://seller-user:secret@seller.example/mcp#fragment' },
      {
        webhookSecret: 'legacy-secret',
        webhookRegistrationStore: {
          async get() {
            return undefined;
          },
          async putIfAbsent(registration) {
            persisted = registration;
          },
        },
      }
    );
    await client.persistWebhookRegistration({
      agent: { ...agent, agent_uri: 'https://seller-user:secret@seller.example/mcp#fragment' },
      taskType: 'get_products',
      operationId: 'op-sanitized-agent-url',
      callbackUrl: 'https://buyer.example/webhook/op-sanitized-agent-url',
      mode: 'hmac-sha256',
    });
    assert.strictEqual(persisted.agentUrl, 'https://seller.example/mcp');
    assert.strictEqual(JSON.stringify(persisted).includes('secret'), false);
  });

  test('TaskExecutor persists the single prepared call before dispatch', async () => {
    const original = ProtocolClient.callTool;
    let registration;
    const store = new InMemoryWebhookRegistrationStore();
    ProtocolClient.callTool = async () => {
      assert.ok(registration, 'registration must be durable before dispatch begins');
      return { status: 'completed', result: { products: [] } };
    };
    try {
      const executor = new TaskExecutor({
        webhookUrlTemplate: 'https://buyer.example/webhook/{operation_id}',
        agentId: agent.id,
        onWebhookRegistration: async value => {
          registration = value;
          const now = Date.now();
          await store.putIfAbsent({
            agentId: value.agent.id,
            agentUrl: value.agent.agent_uri,
            protocol: value.agent.protocol,
            operationId: value.operationId,
            taskType: value.taskType,
            callbackUrl: value.callbackUrl,
            method: 'POST',
            mode: value.mode,
            createdAt: now,
            expiresAt: now + 60_000,
          });
        },
        validation: { requests: 'off', responses: 'off' },
      });
      await executor.executeTask(agent, 'extension_task', {});
      assert.strictEqual(registration.callbackUrl, `https://buyer.example/webhook/${registration.operationId}`);
      assert.ok(!JSON.stringify(registration).includes('credentials'));
      assert.ok(
        await store.get(agent.id, registration.operationId),
        'a late callback remains verifiable after a synchronous terminal response'
      );
    } finally {
      ProtocolClient.callTool = original;
    }
  });

  test('does not claim or dispatch after timing out while the durable marker is pending', async () => {
    const original = ProtocolClient.callTool;
    let markStarted;
    const markerStarted = new Promise(resolve => {
      markStarted = resolve;
    });
    let releaseMarker;
    const markerRelease = new Promise(resolve => {
      releaseMarker = resolve;
    });
    let claims = 0;
    let dispatches = 0;
    ProtocolClient.callTool = async () => {
      dispatches += 1;
      return { status: 'completed', result: {} };
    };
    try {
      const executor = new TaskExecutor({
        webhookUrlTemplate: 'https://buyer.example/webhook/{operation_id}',
        agentId: agent.id,
        onWebhookRegistration: async () => {},
        onDurableSettlementRequired: async () => {
          markStarted();
          await markerRelease;
        },
        validation: { requests: 'off', responses: 'off' },
      });
      const execution = executor.executeTask(
        agent,
        'create_media_buy',
        { idempotency_key: 'marker-timeout-before-claim' },
        undefined,
        { timeout: 10 },
        'v3',
        undefined,
        async () => {
          claims += 1;
          return { action: 'dispatch_committed' };
        }
      );
      await markerStarted;
      await assert.rejects(execution, error => error?.name === 'TaskTimeoutError');
      releaseMarker();
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(claims, 0);
      assert.strictEqual(dispatches, 0);
    } finally {
      ProtocolClient.callTool = original;
    }
  });

  test('custom durable stores must implement the pre-claim settlement marker', async () => {
    const original = ProtocolClient.callTool;
    let claims = 0;
    let dispatches = 0;
    ProtocolClient.callTool = async () => {
      dispatches += 1;
      return { status: 'completed', result: {} };
    };
    try {
      const client = new SingleAgentClient(agent, {
        webhookUrlTemplate: 'https://buyer.example/webhook/{operation_id}',
        webhookSecret: 'legacy-secret',
        webhookRegistrationStore: {
          async get() {
            return undefined;
          },
          async putIfAbsent() {},
        },
        validation: { requests: 'off', responses: 'off' },
      });
      await assert.rejects(
        client.executor.executeTask(
          agent,
          'create_media_buy',
          { idempotency_key: 'missing-marker-contract' },
          undefined,
          {},
          'v3',
          undefined,
          async () => {
            claims += 1;
            return { action: 'dispatch_committed' };
          }
        ),
        error => /must implement markRequiresDurableSettlement/.test(error?.cause?.message ?? '')
      );
      assert.strictEqual(claims, 0);
      assert.strictEqual(dispatches, 0);
    } finally {
      ProtocolClient.callTool = original;
    }
  });

  test('webhook HTTP helpers do not reflect arbitrary infrastructure errors', async () => {
    const client = new SingleAgentClient(agent, {
      allowUnauthenticatedWebhooks: true,
      onActivity: () => {
        throw new Error('database password appeared in an internal failure');
      },
    });
    const handler = client.createWebhookHandler();
    const response = makeResponse();
    await handler(
      {
        body: envelope({ operation_id: 'op-generic-http-error' }),
        params: { task_type: 'get_products', operation_id: 'op-generic-http-error' },
      },
      response
    );
    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(response.body.error, 'Webhook could not be processed.');
    assert.strictEqual(JSON.stringify(response.body).includes('password'), false);
  });

  test('webhook HTTP helper returns 503 while the matching handler publication is in progress', async () => {
    let releaseHandler;
    let markHandlerEntered;
    const handlerEntered = new Promise(resolve => {
      markHandlerEntered = resolve;
    });
    const client = new SingleAgentClient(agent, {
      allowUnauthenticatedWebhooks: true,
      handlers: {
        webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
        onGetProductsStatusChange: async () => {
          markHandlerEntered();
          await new Promise(resolve => {
            releaseHandler = resolve;
          });
        },
      },
    });
    const handler = client.createWebhookHandler();
    const request = {
      body: envelope({ operation_id: 'op-http-in-progress' }),
      params: { task_type: 'get_products', operation_id: 'op-http-in-progress' },
    };
    const firstResponse = makeResponse();
    const first = handler(request, firstResponse);
    await handlerEntered;

    const retryResponse = makeResponse();
    await handler(request, retryResponse);
    assert.strictEqual(retryResponse.statusCode, 503);
    assert.strictEqual(retryResponse.body.error, 'A matching callback publication is still in progress.');

    releaseHandler();
    await first;
    assert.strictEqual(firstResponse.statusCode, 202);
  });

  test('webhook HTTP helper maps active same-key payload substitution to 409', async () => {
    let releaseHandler;
    let markHandlerEntered;
    const handlerEntered = new Promise(resolve => {
      markHandlerEntered = resolve;
    });
    const client = new SingleAgentClient(agent, {
      allowUnauthenticatedWebhooks: true,
      handlers: {
        webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
        onGetProductsStatusChange: async () => {
          markHandlerEntered();
          await new Promise(resolve => {
            releaseHandler = resolve;
          });
        },
      },
    });
    const handler = client.createWebhookHandler();
    const request = {
      body: envelope({ operation_id: 'op-http-active-conflict' }),
      params: { task_type: 'get_products', operation_id: 'op-http-active-conflict' },
    };
    const firstResponse = makeResponse();
    const first = handler(request, firstResponse);
    await handlerEntered;

    const conflictResponse = makeResponse();
    await handler(
      { ...request, body: { ...request.body, result: { products: [{ product_id: 'different' }] } } },
      conflictResponse
    );
    assert.strictEqual(conflictResponse.statusCode, 409);
    assert.match(conflictResponse.body.error, /idempotency key was reused/);

    releaseHandler();
    await first;
    assert.strictEqual(firstResponse.statusCode, 202);
  });

  test('getTaskStatus owns transport options before endpoint discovery yields', async () => {
    const client = new SingleAgentClient(agent);
    const trustedFetch = async () => new Response('{}', { status: 200 });
    const substitutedFetch = async () => new Response('{}', { status: 500 });
    const transport = { trustedFetchFn: trustedFetch, allowPrivateIp: false, requestTimeoutMs: 1_000 };
    let releaseDiscovery;
    let markDiscoveryEntered;
    const discoveryEntered = new Promise(resolve => {
      markDiscoveryEntered = resolve;
    });
    const discoveryRelease = new Promise(resolve => {
      releaseDiscovery = resolve;
    });
    client.ensureEndpointDiscovered = async options => {
      markDiscoveryEntered();
      await discoveryRelease;
      assert.strictEqual(options.transport.trustedFetchFn, trustedFetch);
      assert.strictEqual(options.transport.allowPrivateIp, false);
      return agent;
    };
    client.executor.getTaskStatus = async (_agent, taskId, observedTransport) => {
      assert.strictEqual(observedTransport.trustedFetchFn, trustedFetch);
      assert.strictEqual(observedTransport.allowPrivateIp, false);
      return { taskId, taskType: 'create_media_buy', status: 'working', createdAt: 1, updatedAt: 1 };
    };

    const status = client.getTaskStatus('seller-task-snapshot', transport);
    await discoveryEntered;
    transport.trustedFetchFn = substitutedFetch;
    transport.allowPrivateIp = true;
    releaseDiscovery();

    assert.strictEqual((await status).taskId, 'seller-task-snapshot');
  });

  test('webhook HTTP helper maps malformed dedup keys to 400 before handler dispatch', async () => {
    let calls = 0;
    const client = new SingleAgentClient(agent, {
      allowUnauthenticatedWebhooks: true,
      handlers: {
        webhookDedup: { backend: memoryBackend({ sweepIntervalMs: 0 }) },
        onGetProductsStatusChange: () => {
          calls += 1;
        },
      },
    });
    const handler = client.createWebhookHandler();
    const response = makeResponse();
    await handler(
      {
        body: envelope({ idempotency_key: 'short', operation_id: 'op-http-invalid-key' }),
        params: { task_type: 'get_products', operation_id: 'op-http-invalid-key' },
      },
      response
    );
    assert.strictEqual(response.statusCode, 400);
    assert.match(response.body.error, /idempotency_key is invalid/);
    assert.strictEqual(calls, 0);
  });

  test('prepares MCP and A2A placement exactly and never treats reporting_webhook as task registration', async () => {
    const reporting = { url: 'https://buyer.example/reporting' };
    const callbackUrl = 'https://buyer.example/webhook/op-placement';
    const operationId = 'op-placement';
    const mcp = prepareProtocolToolCall(
      agent,
      { reporting_webhook: reporting },
      { webhookUrl: callbackUrl, operationId }
    );
    assert.strictEqual(mcp.args.reporting_webhook, reporting);
    assert.deepStrictEqual(mcp.args.push_notification_config, { url: callbackUrl, operation_id: operationId });

    const a2aAgent = { ...agent, protocol: 'a2a' };
    const a2a = prepareProtocolToolCall(
      a2aAgent,
      { reporting_webhook: reporting },
      { webhookUrl: callbackUrl, operationId }
    );
    assert.strictEqual(a2a.args.reporting_webhook, reporting);
    assert.deepStrictEqual(a2a.args.push_notification_config, { url: callbackUrl, operation_id: operationId });
    assert.deepStrictEqual(a2a.pushNotificationConfig, { url: callbackUrl });

    const inProcess = prepareProtocolToolCall(
      { ...agent, _inProcessMcpClient: {} },
      {},
      { webhookUrl: callbackUrl, operationId }
    );
    assert.deepStrictEqual(inProcess.args.push_notification_config, { url: callbackUrl, operation_id: operationId });

    const legacyA2a = prepareProtocolToolCall(a2aAgent, {}, { webhookUrl: callbackUrl, adcpVersion: '3.1.18' });
    assert.strictEqual(legacyA2a.args.push_notification_config, undefined);
    assert.deepStrictEqual(legacyA2a.pushNotificationConfig, { url: callbackUrl });

    const callerDowngrade = prepareProtocolToolCall(
      a2aAgent,
      { adcp_version: '3.1', adcp_major_version: 3 },
      { webhookUrl: callbackUrl, operationId }
    );
    assert.strictEqual(callerDowngrade.args.push_notification_config, undefined);
    const callerUpgrade = prepareProtocolToolCall(
      a2aAgent,
      { adcp_version: '3.2-beta.5', adcp_major_version: 3 },
      { webhookUrl: callbackUrl, operationId, adcpVersion: '3.1.18' }
    );
    assert.deepStrictEqual(callerUpgrade.args.push_notification_config, {
      url: callbackUrl,
      operation_id: operationId,
    });

    const args = { reporting_webhook: reporting };
    const prepared = { args: { ...args, exact_marker: true } };
    await withPreparedProtocolToolCall(
      { agent, toolName: 'extension_task', args, preparedCall: prepared },
      async () => {
        assert.strictEqual(
          preparedProtocolToolCallFor(agent, 'extension_task', args),
          prepared,
          'the internal transport handoff preserves prepared object identity'
        );
        assert.strictEqual(preparedProtocolToolCallFor(agent, 'extension_task', { ...args }), undefined);
      }
    );

    const original = ProtocolClient.callTool;
    let registrations = 0;
    ProtocolClient.callTool = async () => ({ status: 'completed', result: {} });
    try {
      const executor = new TaskExecutor({
        agentId: agent.id,
        onWebhookRegistration: async () => {
          registrations += 1;
        },
        validation: { requests: 'off', responses: 'off' },
      });
      await executor.executeTask(agent, 'extension_task', { reporting_webhook: reporting });
      await executor.executeTask(agent, 'extension_task', {
        push_notification_config: { url: 'http://caller-owned.example/callback' },
      });
      assert.strictEqual(registrations, 0);
    } finally {
      ProtocolClient.callTool = original;
    }
  });

  test('HMAC registration contains no secret material and preserves existing short credentials', async () => {
    const original = ProtocolClient.callTool;
    const secret = 'legacy-secret';
    let registration;
    let dispatches = 0;
    ProtocolClient.callTool = async () => {
      dispatches += 1;
      return { status: 'submitted' };
    };
    try {
      const executor = new TaskExecutor({
        webhookUrlTemplate: 'https://buyer.example/webhook/{operation_id}',
        webhookSecret: secret,
        agentId: agent.id,
        onWebhookRegistration: async value => {
          registration = value;
        },
        validation: { requests: 'off', responses: 'off' },
      });
      await executor.executeTask(agent, 'extension_task', {});
      assert.strictEqual(dispatches, 1);
      assert.strictEqual(registration.mode, 'hmac-sha256');
      assert.ok(!JSON.stringify(registration).includes(secret));
    } finally {
      ProtocolClient.callTool = original;
    }
  });

  test('A2A registration comes from transport configuration, and store failure prevents dispatch', async () => {
    const original = ProtocolClient.callTool;
    const a2aAgent = { ...agent, id: 'seller-a2a', protocol: 'a2a', agent_uri: 'https://seller.example/a2a' };
    let dispatches = 0;
    let registration;
    ProtocolClient.callTool = async () => {
      dispatches += 1;
      return { status: 'completed', result: {} };
    };
    try {
      const executor = new TaskExecutor({
        webhookUrlTemplate: 'https://buyer.example/webhook/{operation_id}',
        agentId: a2aAgent.id,
        onWebhookRegistration: async value => {
          registration = value;
        },
        validation: { requests: 'off', responses: 'off' },
      });
      await executor.executeTask(a2aAgent, 'extension_task', {});
      assert.strictEqual(dispatches, 1);
      assert.strictEqual(registration.callbackUrl, `https://buyer.example/webhook/${registration.operationId}`);

      const failing = new TaskExecutor({
        webhookUrlTemplate: 'https://buyer.example/webhook/{operation_id}',
        agentId: a2aAgent.id,
        onWebhookRegistration: async () => {
          throw new Error('durable store unavailable');
        },
        validation: { requests: 'off', responses: 'off' },
      });
      const failed = await failing.executeTask(a2aAgent, 'extension_task', {});
      assert.strictEqual(failed.success, false);
      assert.strictEqual(dispatches, 1, 'seller dispatch must not happen after a registration write failure');
    } finally {
      ProtocolClient.callTool = original;
    }
  });
});

describe('seller-pinned webhook JWK discovery cache', () => {
  test('coalesces positive lookups and rate-limits unknown-kid refreshes', async () => {
    let now = 1_700_000_000;
    let resolutions = 0;
    const resolver = new ResolvedAgentJwksResolver('https://seller.example/mcp', 'mcp', {
      now: () => now,
      resolve: async (agentUrl, options) => {
        resolutions += 1;
        assert.strictEqual(agentUrl, 'https://seller.example/mcp');
        assert.strictEqual(options.protocol, 'mcp');
        return { jwks: { keys: [{ kid: 'known-key', kty: 'OKP' }] } };
      },
    });

    assert.strictEqual((await resolver.resolve('known-key')).kid, 'known-key');
    assert.strictEqual((await resolver.resolve('known-key')).kid, 'known-key');
    assert.strictEqual(resolutions, 1);
    assert.strictEqual(await resolver.resolve('unknown-key'), null);
    assert.strictEqual(await resolver.resolve('unknown-key'), null);
    assert.strictEqual(resolutions, 2);
    assert.strictEqual(await resolver.resolve('different-attacker-key'), null);
    assert.strictEqual(resolutions, 2, 'unknown-kid cooldown is global, not attacker-keyed');
    now += 31;
    assert.strictEqual(await resolver.resolve('unknown-key'), null);
    assert.strictEqual(resolutions, 3);
  });

  test('binds A2A discovery protocol and retries immediately after a failed refresh', async () => {
    let resolutions = 0;
    const resolver = new ResolvedAgentJwksResolver('https://seller.example/a2a', 'a2a', {
      resolve: async (_agentUrl, options) => {
        resolutions += 1;
        assert.strictEqual(options.protocol, 'a2a');
        if (resolutions === 1) throw new Error('temporary discovery failure');
        return { jwks: { keys: [{ kid: 'recovered-key', kty: 'OKP' }] } };
      },
    });
    await assert.rejects(resolver.resolve('recovered-key'), /temporary discovery failure/);
    assert.strictEqual((await resolver.resolve('recovered-key')).kid, 'recovered-key');
    assert.strictEqual(resolutions, 2);
  });

  test('rejects invalid cache and cooldown limits', () => {
    assert.throws(
      () => new ResolvedAgentJwksResolver(agent.agent_uri, 'mcp', { cacheTtlSeconds: Number.NaN }),
      /finite positive/
    );
    assert.throws(
      () => new ResolvedAgentJwksResolver(agent.agent_uri, 'mcp', { unknownKidCooldownSeconds: -1 }),
      /finite non-negative/
    );
  });
});

describe('multi-agent trusted webhook routing', () => {
  test('selects the verifier from trusted route state and rejects a signed payload that spoofs another agent', async () => {
    const secondAgent = { ...agent, id: 'seller-2', agent_uri: 'https://seller-2.example/mcp' };
    const store = new InMemoryWebhookRegistrationStore();
    const callbackUrl = 'https://buyer.example/webhooks/get_products/seller-1/op-rfc-1';
    await store.putIfAbsent({
      agentId: agent.id,
      agentUrl: agent.agent_uri,
      protocol: agent.protocol,
      operationId: 'op-rfc-1',
      taskType: 'get_products',
      callbackUrl,
      method: 'POST',
      mode: 'rfc9421',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const { signer, publicJwk } = keypair('multi-agent-key');
    const client = new ADCPMultiAgentClient([agent, secondAgent], {
      webhookRegistrationStore: store,
      webhookVerification: { jwks: new StaticJwksResolver([publicJwk]) },
    });
    const handler = client.createWebhookHandler({
      getAgentId: req => req.params.agent_id,
      getRequestUrl: () => callbackUrl,
    });

    const rawBody = JSON.stringify(envelope());
    const signed = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: rawBody },
      signer
    );
    const accepted = makeResponse();
    await handler(
      {
        body: rawBody,
        rawBody,
        headers: signed.headers,
        method: 'POST',
        params: { agent_id: agent.id, task_type: 'get_products', operation_id: 'op-rfc-1' },
      },
      accepted
    );
    assert.strictEqual(accepted.statusCode, 202);

    const spoofedBody = JSON.stringify(envelope({ agent_id: secondAgent.id }));
    const spoofedSigned = signWebhook(
      { method: 'POST', url: callbackUrl, headers: { 'content-type': 'application/json' }, body: spoofedBody },
      signer
    );
    const rejected = makeResponse();
    await handler(
      {
        body: spoofedBody,
        rawBody: spoofedBody,
        headers: spoofedSigned.headers,
        method: 'POST',
        params: { agent_id: agent.id, task_type: 'get_products', operation_id: 'op-rfc-1' },
      },
      rejected
    );
    assert.strictEqual(rejected.statusCode, 400);
  });
});
