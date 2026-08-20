const { describe, test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  ADCPMultiAgentClient,
  InMemoryWebhookRegistrationStore,
  SingleAgentClient,
  TaskExecutor,
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

  test('preserves recordless legacy HMAC compatibility after restart or replica changes', async () => {
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
    const rawBody = JSON.stringify(envelope({ operation_id: 'unregistered-operation' }));
    const headers = hmacHeaders(rawBody, secret);
    const verified = await client.verifyAndParseWebhook({
      rawBody,
      headers,
      taskType: 'get_products',
      operationId: 'unregistered-operation',
    });
    assert.strictEqual(verified.ok, true);

    const registrationBase = {
      agent,
      taskType: 'get_products',
      operationId: 'op-persistence-outage',
      callbackUrl: 'https://buyer.example/webhook/op-persistence-outage',
    };
    await client.persistWebhookRegistration({ ...registrationBase, mode: 'hmac-sha256' });
    await assert.rejects(
      client.persistWebhookRegistration({ ...registrationBase, mode: 'rfc9421' }),
      /store unavailable/
    );
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

  test('prepares MCP and A2A placement exactly and never treats reporting_webhook as task registration', async () => {
    const reporting = { url: 'https://buyer.example/reporting' };
    const callbackUrl = 'https://buyer.example/webhook/op-placement';
    const mcp = prepareProtocolToolCall(agent, { reporting_webhook: reporting }, { webhookUrl: callbackUrl });
    assert.strictEqual(mcp.args.reporting_webhook, reporting);
    assert.deepStrictEqual(mcp.args.push_notification_config, { url: callbackUrl });

    const a2aAgent = { ...agent, protocol: 'a2a' };
    const a2a = prepareProtocolToolCall(a2aAgent, { reporting_webhook: reporting }, { webhookUrl: callbackUrl });
    assert.strictEqual(a2a.args.reporting_webhook, reporting);
    assert.strictEqual(a2a.args.push_notification_config, undefined);
    assert.deepStrictEqual(a2a.pushNotificationConfig, { url: callbackUrl });

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
