const { describe, test } = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

const { AgentClient, InMemoryWebhookRegistrationStore, SingleAgentClient } = require('../../dist/lib/index.js');

const TEST_AGENT = {
  id: 'preview-client-test',
  name: 'Preview client test',
  agent_uri: 'https://creative.example/mcp',
  protocol: 'mcp',
};
const WEBHOOK_SECRET = 'preview-test-secret-with-at-least-32-bytes';

function signedWebhook(payload) {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return { rawBody, timestamp, signature: `sha256=${digest}` };
}

function completed(taskName = 'preview_creative') {
  return {
    success: true,
    status: 'completed',
    data: { response_type: 'single', previews: [] },
    metadata: { taskName },
    conversation: [],
    debug_logs: [],
  };
}

function runtimeClient(executeTask, config = {}) {
  const client = new SingleAgentClient(TEST_AGENT, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    ...config,
  });
  client.discoveredEndpoint = TEST_AGENT.agent_uri;
  client.cachedCapabilities = {
    version: 'v3',
    majorVersions: [3],
    supportedVersions: ['3.2.0-beta.9'],
    protocols: ['creative'],
    features: {},
    extensions: [],
    _synthetic: false,
  };
  client.ensureEndpointDiscovered = async () => TEST_AGENT;
  client.executor.validateRequest = () => {};
  client.executor.executeTask = executeTask;
  return client;
}

describe('canonical previewCreative clients', () => {
  const requests = [
    {
      request_type: 'single',
      target_capability_id: 'display.responsive',
      creative_manifest: { manifest_id: 'mf_inline', assets: [] },
    },
    { request_type: 'single', creative_id: 'creative_library_1' },
  ];

  test('SingleAgentClient dispatches canonical preview requests and callback identity', async () => {
    const client = new SingleAgentClient(TEST_AGENT, { validateFeatures: false });
    const calls = [];
    client.executeAndHandle = async (...args) => {
      calls.push(args);
      return completed();
    };

    for (const request of requests) await client.previewCreative(request);

    assert.deepStrictEqual(
      calls.map(([taskName, handlerName, params]) => ({ taskName, handlerName, params })),
      requests.map(params => ({
        taskName: 'preview_creative',
        handlerName: 'onPreviewCreativeStatusChange',
        params,
      }))
    );
  });

  test('AgentClient forwards canonical preview requests through its session-aware client', async () => {
    const client = new AgentClient(TEST_AGENT, { validateFeatures: false });
    const calls = [];
    client.client.previewCreative = async (...args) => {
      calls.push(args);
      return completed();
    };

    for (const request of requests) await client.previewCreative(request);

    assert.deepStrictEqual(
      calls.map(([params]) => params),
      requests
    );
  });

  test('canonical preview projects variant manifests while the legacy alias stays raw', async () => {
    const formatId = { id: 'legacy', agent_url: 'https://creative.example/mcp' };
    const rawResult = {
      success: true,
      status: 'completed',
      data: {
        response_type: 'variant',
        manifest: { manifest_id: 'mf_variant', format_id: formatId, assets: [] },
      },
      metadata: {
        taskId: 'preview-task',
        taskName: 'preview_creative',
        agent: TEST_AGENT,
        responseTimeMs: 1,
        timestamp: '2026-08-20T12:00:00.000Z',
        clarificationRounds: 0,
        status: 'completed',
      },
      conversation: [],
      debug_logs: [],
    };
    const canonicalCallbacks = [];
    const canonical = runtimeClient(async () => structuredClone(rawResult), {
      handlers: { onPreviewCreativeStatusChange: response => canonicalCallbacks.push(response) },
    });

    const projected = await canonical.previewCreative(requests[0]);
    assert.strictEqual(projected.data.manifest.format_id, undefined);
    assert.strictEqual(canonicalCallbacks[0].manifest.format_id, undefined);

    const legacy = runtimeClient(async () => structuredClone(rawResult));
    const unprojected = await legacy.previewCreativeLegacy({
      request_type: 'single',
      creative_id: 'creative_legacy',
      format_id: formatId,
    });
    assert.deepStrictEqual(unprojected.data.manifest.format_id, formatId);
  });

  test('canonical preview rejects a pre-3.2 client pin with legacy recovery guidance', async () => {
    const client = new SingleAgentClient(TEST_AGENT, {
      adcpVersion: '3.1',
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });

    await assert.rejects(
      () => client.previewCreative(requests[0]),
      error =>
        error.code === 'UNSUPPORTED_FEATURE' &&
        error.details.required_version === '3.2' &&
        /previewCreativeLegacy/.test(error.message)
    );
  });

  test('canonical preview rejects legacy identity from untyped callers at any depth', async () => {
    const client = runtimeClient(async () => completed());
    const formatId = { id: 'legacy', agent_url: 'https://creative.example/mcp' };

    await assert.rejects(
      () => client.previewCreative({ request_type: 'single', creative_id: 'creative_1', format_id: formatId }),
      /previewCreative\(\) does not accept legacy creative identity at \$\.format_id/
    );
    await assert.rejects(
      () =>
        client.previewCreative({
          request_type: 'batch',
          requests: [{ creative_id: 'creative_1', format_id: formatId }],
        }),
      /requests\[0\]\.format_id/
    );
  });

  test('canonical preview refuses a seller that advertises only AdCP 3.1', async () => {
    let dispatched = false;
    const client = runtimeClient(async () => {
      dispatched = true;
      return completed();
    });
    client.cachedCapabilities.supportedVersions = ['3.1'];

    await assert.rejects(
      () => client.previewCreative(requests[0]),
      error => error.code === 'UNSUPPORTED_FEATURE' && error.details.current_version === '3.1'
    );
    assert.strictEqual(dispatched, false);
  });

  test('legacy preview keeps its callback identity after webhook completion', async () => {
    const received = [];
    const formatId = { id: 'legacy', agent_url: 'https://creative.example/mcp' };
    const client = runtimeClient(
      async () => ({
        ...completed(),
        data: { response_type: 'variant', manifest: { manifest_id: 'mf_legacy', format_id: formatId, assets: [] } },
        metadata: { ...completed().metadata, taskId: 'preview-legacy-task' },
      }),
      {
        allowUnauthenticatedWebhooks: true,
        handlers: {
          onPreviewCreativeStatusChange: () => received.push('canonical'),
          onPreviewCreativeLegacyStatusChange: response => received.push(response.manifest.format_id.id),
        },
      }
    );
    await client.previewCreativeLegacy({
      request_type: 'single',
      creative_id: 'creative_legacy',
      format_id: formatId,
    });
    received.length = 0;

    const handled = await client.handleWebhook(
      {
        idempotency_key: 'preview-legacy-event',
        operation_id: 'preview-legacy-operation',
        task_id: 'preview-legacy-task',
        task_type: 'preview_creative',
        status: 'completed',
        timestamp: '2026-08-20T12:00:00.000Z',
        result: {
          response_type: 'variant',
          manifest: { manifest_id: 'mf_legacy', format_id: formatId, assets: [] },
        },
      },
      'preview_creative',
      'preview-legacy-operation'
    );

    assert.strictEqual(handled, true);
    assert.deepStrictEqual(received, ['legacy']);
  });

  test('a later legacy preview overrides canonical provenance in a shared session context', async () => {
    const received = [];
    const formatId = { id: 'legacy', agent_url: 'https://creative.example/mcp' };
    let call = 0;
    const client = runtimeClient(
      async () => {
        call += 1;
        return {
          ...completed(),
          data: { response_type: 'variant', manifest: { manifest_id: `mf_${call}`, format_id: formatId, assets: [] } },
          metadata: {
            ...completed().metadata,
            taskId: `preview-shared-${call}`,
            contextId: 'preview-shared-context',
          },
        };
      },
      {
        allowUnauthenticatedWebhooks: true,
        handlers: {
          onPreviewCreativeStatusChange: () => {},
          onPreviewCreativeLegacyStatusChange: response => received.push(response.manifest.format_id?.id),
        },
      }
    );
    await client.previewCreative({ request_type: 'single', creative_id: 'creative_canonical' }, undefined, {
      contextId: 'preview-shared-context',
    });
    await client.previewCreativeLegacy(
      { request_type: 'single', creative_id: 'creative_legacy', format_id: formatId },
      undefined,
      { contextId: 'preview-shared-context' }
    );
    received.length = 0;

    await client.handleWebhook(
      {
        idempotency_key: 'preview-shared-event',
        operation_id: 'preview-shared-operation',
        context_id: 'preview-shared-context',
        task_id: 'preview-shared-2',
        task_type: 'preview_creative',
        status: 'completed',
        timestamp: '2026-08-20T12:00:00.000Z',
        result: {
          response_type: 'variant',
          manifest: { manifest_id: 'mf_legacy', format_id: formatId, assets: [] },
        },
      },
      'preview_creative',
      'preview-shared-operation'
    );

    assert.deepStrictEqual(received, ['legacy']);
  });

  test('preview provenance is registered before dispatch and survives a client restart', async () => {
    const store = new InMemoryWebhookRegistrationStore();
    const formatId = { id: 'legacy', agent_url: 'https://creative.example/mcp' };
    const webhookResult = {
      response_type: 'variant',
      manifest: { manifest_id: 'mf_webhook', format_id: formatId, assets: [] },
    };

    const immediateReceived = [];
    let immediateClient;
    immediateClient = runtimeClient(
      async () => {
        await immediateClient.persistWebhookRegistration({
          agent: TEST_AGENT,
          taskType: 'preview_creative',
          operationId: 'op_immediate_legacy',
          callbackUrl: 'https://buyer.example/webhook',
          mode: 'hmac-sha256',
        });
        const payload = {
          idempotency_key: 'event_immediate_legacy',
          operation_id: 'op_immediate_legacy',
          task_id: 'task_immediate_legacy',
          task_type: 'preview_creative',
          status: 'completed',
          timestamp: '2026-08-20T12:00:00.000Z',
          result: webhookResult,
        };
        const auth = signedWebhook(payload);
        await immediateClient.handleWebhook(
          payload,
          'preview_creative',
          'op_immediate_legacy',
          auth.signature,
          auth.timestamp,
          auth.rawBody
        );
        return completed();
      },
      {
        webhookSecret: WEBHOOK_SECRET,
        webhookRegistrationStore: store,
        handlers: {
          onPreviewCreativeStatusChange: () => immediateReceived.push('canonical'),
          onPreviewCreativeLegacyStatusChange: () => immediateReceived.push('legacy'),
        },
      }
    );
    await immediateClient.previewCreativeLegacy({
      request_type: 'single',
      creative_id: 'creative_legacy',
      format_id: formatId,
    });
    assert.deepStrictEqual(immediateReceived, ['legacy', 'legacy']);

    let producer;
    producer = runtimeClient(
      async () => {
        await producer.persistWebhookRegistration({
          agent: TEST_AGENT,
          taskType: 'preview_creative',
          operationId: 'op_restart_canonical',
          callbackUrl: 'https://buyer.example/webhook',
          mode: 'hmac-sha256',
        });
        return completed();
      },
      { webhookSecret: WEBHOOK_SECRET, webhookRegistrationStore: store }
    );
    await producer.previewCreative({ request_type: 'single', creative_id: 'creative_canonical' });

    const restartedReceived = [];
    const restarted = runtimeClient(async () => completed(), {
      webhookSecret: WEBHOOK_SECRET,
      webhookRegistrationStore: store,
      handlers: {
        onPreviewCreativeStatusChange: response => restartedReceived.push(response),
        onPreviewCreativeLegacyStatusChange: () => restartedReceived.push('legacy'),
      },
    });
    const payload = {
      idempotency_key: 'event_restart_canonical',
      operation_id: 'op_restart_canonical',
      task_id: 'task_restart_canonical',
      task_type: 'preview_creative',
      status: 'completed',
      timestamp: '2026-08-20T12:00:00.000Z',
      result: webhookResult,
    };
    const auth = signedWebhook(payload);
    await restarted.handleWebhook(
      payload,
      'preview_creative',
      'op_restart_canonical',
      auth.signature,
      auth.timestamp,
      auth.rawBody
    );

    assert.strictEqual(restartedReceived.length, 1);
    assert.strictEqual(restartedReceived[0].manifest.format_id, undefined);
  });

  test('legacy HMAC preview overrides stale cross-tool context when registration persistence fails', async () => {
    const formatId = { id: 'legacy', agent_url: 'https://creative.example/mcp' };
    const received = [];
    const unavailableStore = {
      async get() {
        throw new Error('store unavailable');
      },
      async putIfAbsent() {
        throw new Error('store unavailable');
      },
    };
    let call = 0;
    let client;
    client = runtimeClient(
      async () => {
        call += 1;
        if (call === 1) {
          return {
            ...completed('get_products'),
            data: { products: [] },
            metadata: {
              ...completed('get_products').metadata,
              taskId: 'task_store_outage_products',
              contextId: 'shared-context',
            },
          };
        }
        await client.persistWebhookRegistration({
          agent: TEST_AGENT,
          taskType: 'preview_creative',
          operationId: 'op_store_outage_legacy',
          callbackUrl: 'https://buyer.example/webhook',
          mode: 'hmac-sha256',
        });
        const payload = {
          idempotency_key: 'event_store_outage_legacy',
          operation_id: 'op_store_outage_legacy',
          task_id: 'task_store_outage_legacy',
          context_id: 'shared-context',
          task_type: 'preview_creative',
          status: 'completed',
          timestamp: '2026-08-20T12:00:00.000Z',
          result: {
            response_type: 'variant',
            manifest: { manifest_id: 'mf_legacy', format_id: formatId, assets: [] },
          },
        };
        const auth = signedWebhook(payload);
        await client.handleWebhook(
          payload,
          'preview_creative',
          'op_store_outage_legacy',
          auth.signature,
          auth.timestamp,
          auth.rawBody
        );
        return {
          ...completed(),
          data: {
            response_type: 'variant',
            manifest: { manifest_id: 'mf_legacy', format_id: formatId, assets: [] },
          },
        };
      },
      {
        webhookSecret: WEBHOOK_SECRET,
        webhookRegistrationStore: unavailableStore,
        handlers: {
          onPreviewCreativeStatusChange: () => received.push('canonical'),
          onPreviewCreativeLegacyStatusChange: response => received.push(response.manifest.format_id.id),
        },
      }
    );

    await client.getProducts({ buying_mode: 'wholesale' }, undefined, { contextId: 'shared-context' });
    received.length = 0;
    await client.previewCreativeLegacy(
      {
        request_type: 'single',
        creative_id: 'creative_legacy',
        format_id: formatId,
      },
      undefined,
      { contextId: 'shared-context' }
    );

    assert.deepStrictEqual(received, ['legacy', 'legacy']);
  });

  test('recordless HMAC binds operation_id to the trusted route', async () => {
    const unavailableStore = {
      async get() {
        throw new Error('store unavailable');
      },
      async putIfAbsent() {
        throw new Error('store unavailable');
      },
    };
    const client = runtimeClient(async () => completed(), {
      webhookSecret: WEBHOOK_SECRET,
      webhookRegistrationStore: unavailableStore,
    });
    const payload = {
      idempotency_key: 'recordless-route-binding-event',
      operation_id: 'different-known-operation',
      task_id: 'recordless-preview-task',
      task_type: 'preview_creative',
      status: 'completed',
      timestamp: new Date().toISOString(),
      result: { response_type: 'single', previews: [] },
    };
    const auth = signedWebhook(payload);
    const parsed = await client.verifyAndParseWebhook({
      taskType: 'preview_creative',
      operationId: 'trusted-route-operation',
      signature: auth.signature,
      timestamp: auth.timestamp,
      rawBody: auth.rawBody,
    });

    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'webhook_registration_mismatch');
    assert.match(parsed.message, /trusted callback route/);

    for (const operationId of [undefined, 'unknown']) {
      const missingRoute = await client.verifyAndParseWebhook({
        taskType: 'preview_creative',
        ...(operationId !== undefined && { operationId }),
        signature: auth.signature,
        timestamp: auth.timestamp,
        rawBody: auth.rawBody,
      });
      assert.equal(missingRoute.ok, false);
      assert.equal(missingRoute.code, 'webhook_verification_context_missing');
    }
  });

  test('HMAC registration failures block mutations but preserve allowlisted reads', async () => {
    const unavailableStore = {
      async get() {
        throw new Error('store unavailable');
      },
      async putIfAbsent() {
        throw new Error('store unavailable');
      },
    };
    const client = runtimeClient(async () => completed(), {
      webhookSecret: WEBHOOK_SECRET,
      webhookRegistrationStore: unavailableStore,
    });
    const registration = taskType =>
      client.persistWebhookRegistration({
        agent: TEST_AGENT,
        taskType,
        operationId: `registration-${taskType}`,
        callbackUrl: 'https://buyer.example/webhook',
        mode: 'hmac-sha256',
      });

    await registration('preview_creative');
    await assert.rejects(registration('create_media_buy'), error => {
      assert.match(error.message, /Could not persist trusted webhook registration/);
      assert.doesNotMatch(error.message, /store unavailable/);
      assert.match(error.cause.message, /store unavailable/);
      return true;
    });
  });
});
