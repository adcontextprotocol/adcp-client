const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');

const { trace } = require('@opentelemetry/api');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const z = require('zod');

const {
  ADCPMultiAgentClient,
  InMemoryWebhookRegistrationStore,
  SingleAgentClient,
  withSpan,
} = require('../../dist/lib/index.js');
const { getTaskOperationId, withTaskDeadline } = require('../../dist/lib/core/task-deadline.js');

const WEBHOOK_TEMPLATE = 'https://buyer.example/webhooks/{task_type}/{agent_id}/{operation_id}';
const WEBHOOK_SECRET = 'capability-probe-operation-id-secret';

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createHarness(mutationName, { clientConfig = {}, beforeCapabilitiesResponse } = {}) {
  const calls = [];
  const registrations = [];
  const backingStore = new InMemoryWebhookRegistrationStore();
  const registrationStore = {
    async putIfAbsent(registration) {
      registrations.push(structuredClone(registration));
      await backingStore.putIfAbsent(registration);
    },
    get: (...args) => backingStore.get(...args),
    delete: (...args) => backingStore.delete(...args),
    markRequiresDurableSettlement: (...args) => backingStore.markRequiresDurableSettlement(...args),
  };

  const server = new McpServer({ name: `${mutationName}-seller`, version: '1.0.0' });
  server.registerTool(
    'get_adcp_capabilities',
    {
      inputSchema: {
        adcp_major_version: z.number().optional(),
        adcp_version: z.string().optional(),
        push_notification_config: z.any().optional(),
      },
    },
    async args => {
      calls.push({ tool: 'get_adcp_capabilities', args: structuredClone(args) });
      await beforeCapabilitiesResponse?.();
      return toolResult({
        status: 'completed',
        adcp_version: '3.2.0-rc.1',
        adcp: {
          major_versions: [3],
          supported_versions: ['3.2.0-rc.1'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
      });
    }
  );
  server.registerTool(
    mutationName,
    {
      inputSchema: {
        account: z.any().optional(),
        accounts: z.array(z.any()).optional(),
        media_buy_id: z.string().optional(),
        packages: z.array(z.any()).optional(),
        paused: z.boolean().optional(),
        idempotency_key: z.string().optional(),
        adcp_major_version: z.number().optional(),
        adcp_version: z.string().optional(),
        push_notification_config: z.any().optional(),
      },
    },
    async args => {
      calls.push({ tool: mutationName, args: structuredClone(args) });
      return toolResult(
        mutationName === 'sync_accounts'
          ? { status: 'completed', accounts: [] }
          : { status: 'completed', media_buy_id: 'mb_1', revision: 2 }
      );
    }
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'capability-probe-operation-id-test', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  const client = new ADCPMultiAgentClient(
    [
      {
        id: `${mutationName}-agent`,
        name: `${mutationName} agent`,
        agent_uri: `in-process://${mutationName}-agent`,
        protocol: 'mcp',
        _inProcessMcpClient: mcpClient,
      },
    ],
    {
      requireV3ForMutations: true,
      validateFeatures: false,
      webhookUrlTemplate: WEBHOOK_TEMPLATE,
      webhookSecret: WEBHOOK_SECRET,
      webhookRegistrationStore: registrationStore,
      validation: { requests: 'off', responses: 'off' },
      ...clientConfig,
    }
  );

  return {
    agent: client.agent(`${mutationName}-agent`),
    calls,
    registrations,
    async close() {
      await mcpClient.close();
      await server.close();
    },
  };
}

function invokeMutation(agent, mutationName, options) {
  return mutationName === 'sync_accounts'
    ? agent.syncAccounts({ idempotency_key: 'sync-accounts-idempotency-key', accounts: [] }, undefined, options)
    : agent.updateMediaBuyLegacy(
        {
          account: { account_id: 'acc_1' },
          media_buy_id: 'mb_1',
          idempotency_key: 'update-media-buy-idempotency-key',
          paused: true,
        },
        undefined,
        options
      );
}

function invokeCanonicalCreativeUpdate(agent, options) {
  return agent.updateMediaBuy(
    {
      account: { account_id: 'acc_1' },
      media_buy_id: 'mb_1',
      idempotency_key: 'canonical-update-idempotency-key',
      packages: [{ package_id: 'pkg_1', creatives: [] }],
    },
    undefined,
    options
  );
}

for (const mutationName of ['update_media_buy', 'sync_accounts']) {
  test(`lazy capability discovery uses a child operation ID before ${mutationName}`, async t => {
    const harness = await createHarness(mutationName);
    t.after(() => harness.close());

    let parentOperationId;
    const result = await withTaskDeadline({}, async options => {
      parentOperationId = getTaskOperationId(options);
      return invokeMutation(harness.agent, mutationName, options);
    });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(
      harness.calls.map(call => call.tool),
      ['get_adcp_capabilities', mutationName],
      'the mutation must reach the seller after capability discovery'
    );
    assert.equal(harness.registrations.length, 2);

    const probeRegistration = harness.registrations.find(
      registration => registration.taskType === 'get_adcp_capabilities'
    );
    const mutationRegistration = harness.registrations.find(registration => registration.taskType === mutationName);
    assert.ok(probeRegistration);
    assert.ok(mutationRegistration);
    assert.notEqual(probeRegistration.operationId, mutationRegistration.operationId);
    assert.equal(mutationRegistration.operationId, parentOperationId, 'the mutation retains its parent operation ID');
    assert.equal(result.metadata.taskId, parentOperationId);
    assert.equal(harness.calls[0].args.push_notification_config.operation_id, probeRegistration.operationId);
    assert.equal(harness.calls[1].args.push_notification_config.operation_id, mutationRegistration.operationId);
  });
}

test('lazy capability discovery preserves webhook suppression for the probe and mutation', async t => {
  const harness = await createHarness('sync_accounts');
  t.after(() => harness.close());

  const result = await invokeMutation(harness.agent, 'sync_accounts', { disableWebhook: true });

  assert.equal(result.success, true, result.error);
  assert.deepEqual(
    harness.calls.map(call => call.tool),
    ['get_adcp_capabilities', 'sync_accounts']
  );
  assert.equal(harness.registrations.length, 0);
  assert.equal(harness.calls[0].args.push_notification_config, undefined);
  assert.equal(harness.calls[1].args.push_notification_config, undefined);
});

test('creative-format preflight preserves webhook suppression on a cold client', async t => {
  const harness = await createHarness('update_media_buy');
  t.after(() => harness.close());

  const result = await invokeCanonicalCreativeUpdate(harness.agent, { disableWebhook: true });

  assert.equal(result.success, true, result.error);
  assert.deepEqual(
    harness.calls.map(call => call.tool),
    ['get_adcp_capabilities', 'update_media_buy']
  );
  assert.equal(harness.registrations.length, 0);
  assert.equal(harness.calls[0].args.push_notification_config, undefined);
  assert.equal(harness.calls[1].args.push_notification_config, undefined);
});

test('lazy capability discovery preserves per-call callback authorization provenance', async t => {
  const defaultAuthorization = { brand: 'tenant_a', scope: 'media_buying', country: 'US' };
  const delegatedOperatorAuthorization = { brand: 'tenant_b', scope: 'governance', country: 'GB' };
  const harness = await createHarness('sync_accounts', {
    clientConfig: {
      webhookVerification: {
        resolverOptions: {
          requiredOperatorBrand: defaultAuthorization.brand,
          requiredOperatorScope: defaultAuthorization.scope,
          requiredOperatorCountry: defaultAuthorization.country,
        },
      },
    },
  });
  t.after(() => harness.close());

  const result = await invokeMutation(harness.agent, 'sync_accounts', { delegatedOperatorAuthorization });

  assert.equal(result.success, true, result.error);
  assert.equal(harness.registrations.length, 2);
  for (const registration of harness.registrations) {
    assert.deepEqual(registration.delegatedOperatorAuthorization, delegatedOperatorAuthorization);
  }
});

test('creative-format preflight preserves per-call callback authorization provenance', async t => {
  const delegatedOperatorAuthorization = { brand: 'tenant_b', scope: 'governance', country: 'GB' };
  const harness = await createHarness('update_media_buy', {
    clientConfig: {
      webhookVerification: {
        resolverOptions: {
          requiredOperatorBrand: 'tenant_a',
          requiredOperatorScope: 'media_buying',
          requiredOperatorCountry: 'US',
        },
      },
    },
  });
  t.after(() => harness.close());

  const result = await invokeCanonicalCreativeUpdate(harness.agent, { delegatedOperatorAuthorization });

  assert.equal(result.success, true, result.error);
  assert.equal(harness.registrations.length, 2);
  for (const registration of harness.registrations) {
    assert.deepEqual(registration.delegatedOperatorAuthorization, delegatedOperatorAuthorization);
  }
});

for (const cancellation of ['caller abort', 'task deadline']) {
  test(`lazy capability discovery honors ${cancellation} before dispatching the mutation`, async t => {
    const started = deferred();
    const release = deferred();
    const harness = await createHarness('sync_accounts', {
      beforeCapabilitiesResponse: async () => {
        started.resolve();
        await release.promise;
      },
    });
    t.after(async () => {
      release.resolve();
      await harness.close();
    });

    const controller = new AbortController();
    const options =
      cancellation === 'caller abort'
        ? { signal: controller.signal, transport: { requestTimeoutMs: 0 } }
        : { timeout: 2000, transport: { requestTimeoutMs: 0 } };
    const pending = invokeMutation(harness.agent, 'sync_accounts', options);
    await started.promise;
    if (cancellation === 'caller abort') controller.abort();

    try {
      await assert.rejects(pending, error =>
        cancellation === 'caller abort'
          ? error?.name === 'AbortError' || /\bAbortError\b/.test(String(error))
          : error?.name === 'TaskTimeoutError'
      );
    } finally {
      release.resolve();
    }
    assert.deepEqual(
      harness.calls.map(call => call.tool),
      ['get_adcp_capabilities']
    );
  });
}

test('probe and mutation spans retain their shared caller trace parent', async t => {
  const harness = await createHarness('sync_accounts');
  t.after(() => harness.close());

  const activeSpan = new AsyncLocalStorage();
  const spans = [];
  const originalGetTracer = trace.getTracer;
  trace.getTracer = () => ({
    startActiveSpan(name, _options, fn) {
      const record = {
        id: `span-${spans.length + 1}`,
        name,
        parentId: activeSpan.getStore()?.id,
      };
      spans.push(record);
      const span = {
        setStatus() {},
        recordException() {},
        end() {},
      };
      return activeSpan.run(record, () => fn(span));
    },
  });

  try {
    const result = await withSpan('buyer.dispatch', {}, () => invokeMutation(harness.agent, 'sync_accounts', {}));
    assert.equal(result.success, true, result.error);
  } finally {
    trace.getTracer = originalGetTracer;
  }

  const parent = spans.find(span => span.name === 'buyer.dispatch');
  assert.ok(parent);
  const physicalTasks = spans.filter(span => span.name === 'adcp.mcp.call_tool' && span.parentId === parent.id);
  assert.equal(physicalTasks.length, 2);
});

test('capability child options preserve request policy without inheriting the parent operation ID', async () => {
  const agent = {
    id: 'probe-options-agent',
    name: 'Probe options agent',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  };
  const client = new SingleAgentClient(agent, {
    validation: { requests: 'off', responses: 'off' },
  });
  client.getAgentInfo = async () => ({
    name: agent.name,
    protocol: 'mcp',
    url: agent.agent_uri,
    tools: [{ name: 'get_adcp_capabilities' }],
  });
  client.ensureEndpointDiscovered = async () => agent;

  let receivedOptions;
  client.executor.executeTask = async (_agent, _task, _params, _handler, options) => {
    receivedOptions = options;
    return {
      success: true,
      status: 'completed',
      data: {
        adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
        supported_protocols: ['media_buy'],
      },
    };
  };

  const controller = new AbortController();
  const transport = { requestTimeoutMs: 4321, maxResponseBytes: 9876 };
  const delegatedOperatorAuthorization = { brand: 'tenant_b', scope: 'governance', country: 'GB' };
  let parentOperationId;
  await withTaskDeadline(
    { signal: controller.signal, transport, disableWebhook: true, delegatedOperatorAuthorization },
    async options => {
      parentOperationId = getTaskOperationId(options);
      await client.getCapabilities(options);
    }
  );

  assert.ok(parentOperationId);
  assert.equal(getTaskOperationId(receivedOptions), undefined);
  assert.equal(receivedOptions.signal, controller.signal);
  assert.deepEqual(receivedOptions.transport, transport);
  assert.equal(receivedOptions.disableWebhook, true);
  assert.deepEqual(receivedOptions.delegatedOperatorAuthorization, delegatedOperatorAuthorization);
  assert.notEqual(receivedOptions.delegatedOperatorAuthorization, delegatedOperatorAuthorization);
});
