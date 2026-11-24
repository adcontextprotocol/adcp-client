/**
 * adcp-client#3693: a seller hashes the whole request under its idempotency key,
 * `push_notification_config` included. The SDK's default operation id fills
 * `push_notification_config.operation_id` and the `{operation_id}` URL macro, so
 * it must be a pure function of (agent, task, idempotency_key) or a same-key retry
 * is answered IDEMPOTENCY_CONFLICT.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const z = require('zod');

const {
  ADCPMultiAgentClient,
  ConfigurationError,
  InMemoryWebhookRegistrationStore,
} = require('../../dist/lib/index.js');
const { idempotentOperationId } = require('../../dist/lib/core/task-deadline.js');

const AGENT_ID = 'stable-op-agent';
const WEBHOOK_TEMPLATE = 'https://buyer.example/webhooks/{task_type}/{agent_id}/{operation_id}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function createHarness() {
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

  // When armed, the next sync_accounts call parks inside the seller until released.
  const gate = { current: undefined };

  const server = new McpServer({ name: 'stable-op-seller', version: '1.0.0' });
  const common = {
    adcp_major_version: z.number().optional(),
    adcp_version: z.string().optional(),
    push_notification_config: z.any().optional(),
  };
  server.registerTool('get_adcp_capabilities', { inputSchema: common }, async args => {
    calls.push({ tool: 'get_adcp_capabilities', args: structuredClone(args) });
    return toolResult({
      status: 'completed',
      adcp_version: '3.2.1',
      adcp: {
        major_versions: [3],
        supported_versions: ['3.2.1'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      supported_protocols: ['media_buy'],
      specialisms: [],
    });
  });
  server.registerTool(
    'sync_accounts',
    { inputSchema: { ...common, accounts: z.array(z.any()).optional(), idempotency_key: z.string().optional() } },
    async args => {
      calls.push({ tool: 'sync_accounts', args: structuredClone(args) });
      const armed = gate.current;
      if (armed) {
        gate.current = undefined;
        armed.started.resolve();
        await armed.release.promise;
      }
      return toolResult({ status: 'completed', accounts: [] });
    }
  );
  server.registerTool(
    'update_media_buy',
    {
      inputSchema: {
        ...common,
        account: z.any().optional(),
        media_buy_id: z.string().optional(),
        paused: z.boolean().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    async args => {
      calls.push({ tool: 'update_media_buy', args: structuredClone(args) });
      return toolResult({ status: 'completed', media_buy_id: 'mb_1', revision: 2 });
    }
  );
  server.registerTool('get_products', { inputSchema: { ...common, brief: z.string().optional() } }, async args => {
    calls.push({ tool: 'get_products', args: structuredClone(args) });
    return toolResult({ status: 'completed', products: [] });
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'stable-op-test', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  const client = new ADCPMultiAgentClient(
    [
      {
        id: AGENT_ID,
        name: 'Stable op agent',
        agent_uri: `in-process://${AGENT_ID}`,
        protocol: 'mcp',
        _inProcessMcpClient: mcpClient,
      },
    ],
    {
      adcpVersion: '3.2.7',
      requireV3ForMutations: true,
      validateFeatures: false,
      webhookUrlTemplate: WEBHOOK_TEMPLATE,
      webhookSecret: 'stable-operation-id-secret',
      webhookRegistrationStore: registrationStore,
      validation: { requests: 'off', responses: 'off' },
    }
  );

  return {
    agent: client.agent(AGENT_ID),
    calls,
    registrations,
    gate,
    callsTo: tool => calls.filter(call => call.tool === tool),
    registrationsFor: taskType => registrations.filter(r => r.taskType === taskType),
    async close() {
      await mcpClient.close();
      await server.close();
    },
  };
}

const sync = (agent, key, options) => agent.syncAccounts({ idempotency_key: key, accounts: [] }, undefined, options);
const update = (agent, key, options) =>
  agent.updateMediaBuyLegacy(
    { account: { account_id: 'acc_1' }, media_buy_id: 'mb_1', idempotency_key: key, paused: true },
    undefined,
    options
  );

for (const [name, invoke] of [
  ['sync_accounts', sync],
  ['update_media_buy', update],
]) {
  test(`${name}: same-key sequential calls send byte-identical push_notification_config`, async t => {
    const h = await createHarness();
    t.after(() => h.close());
    const key = `${name}-retry-key-0001`;

    const first = await invoke(h.agent, key);
    const second = await invoke(h.agent, key); // right after the first: inside the old terminal retention
    assert.equal(first.success, true, first.error);
    assert.equal(second.success, true, second.error);

    const sent = h.callsTo(name).map(call => call.args.push_notification_config);
    assert.equal(sent.length, 2);
    assert.ok(sent[0].operation_id, 'operation_id is sent');
    assert.equal(JSON.stringify(sent[0]), JSON.stringify(sent[1]));
    assert.match(sent[0].url, /\/webhooks\/[^/]+\/stable-op-agent\/idem-[0-9a-f]{40}$/);

    const registered = h.registrationsFor(name);
    assert.equal(registered.length, 2);
    assert.equal(registered[0].operationId, registered[1].operationId);
    assert.equal(registered[0].operationId, idempotentOperationId(AGENT_ID, name, key));
    assert.equal(first.metadata.taskId, second.metadata.taskId);
  });
}

test('different idempotency keys derive different operation ids', async t => {
  const h = await createHarness();
  t.after(() => h.close());

  await sync(h.agent, 'key-aaaaaaaaaaaa-0001');
  await sync(h.agent, 'key-bbbbbbbbbbbb-0002');

  const [a, b] = h.callsTo('sync_accounts').map(call => call.args.push_notification_config);
  assert.notEqual(a.operation_id, b.operation_id);
  assert.notEqual(a.url, b.url);
  assert.notEqual(
    idempotentOperationId('x', 'sync_accounts', 'k'),
    idempotentOperationId('x', 'update_media_buy', 'k')
  );
  assert.notEqual(idempotentOperationId('x', 'sync_accounts', 'k'), idempotentOperationId('y', 'sync_accounts', 'k'));
});

test('a caller-supplied operationId wins over the derived id and may be reused after the call finishes', async t => {
  const h = await createHarness();
  t.after(() => h.close());

  const first = await sync(h.agent, 'key-cccccccccccc-0003', { operationId: 'caller-op-1' });
  const second = await sync(h.agent, 'key-cccccccccccc-0003', { operationId: 'caller-op-1' });
  assert.equal(first.success, true, first.error);
  assert.equal(second.success, true, second.error);

  const sent = h.callsTo('sync_accounts').map(call => call.args.push_notification_config);
  assert.equal(sent[0].operation_id, 'caller-op-1');
  assert.equal(sent[1].operation_id, 'caller-op-1');
  assert.ok(sent[0].url.endsWith('/caller-op-1'));
  assert.equal(first.metadata.taskId, 'caller-op-1');
});

test('a request without an idempotency key still gets a random UUID operation id', async t => {
  const h = await createHarness();
  t.after(() => h.close());

  const first = await h.agent.getProducts({ brief: 'one' });
  const second = await h.agent.getProducts({ brief: 'one' });
  assert.equal(first.success, true, first.error);
  assert.equal(second.success, true, second.error);

  assert.match(first.metadata.taskId, UUID);
  assert.match(second.metadata.taskId, UUID);
  assert.notEqual(first.metadata.taskId, second.metadata.taskId);
  assert.ok(!first.metadata.taskId.startsWith('idem-'));
});

test('the derived operation id never contains the idempotency key', async t => {
  const h = await createHarness();
  t.after(() => h.close());
  const key = 'secret-retry-pattern-key-0004';

  await sync(h.agent, key);

  const config = h.callsTo('sync_accounts')[0].args.push_notification_config;
  assert.ok(!config.operation_id.includes(key));
  assert.ok(!config.url.includes(key));
  assert.ok(!JSON.stringify(h.registrations).includes(key));
  assert.match(config.operation_id, /^idem-[0-9a-f]{40}$/);
});

test('a TaskTimeoutError carries the derived taskId and the key; retrying with that key reproduces push_notification_config', async t => {
  const h = await createHarness();
  const release = deferred();
  t.after(async () => {
    release.resolve();
    await h.close();
  });
  const key = 'timeout-retry-key-0005';

  // Warm the capability probe so the deadline expires inside the mutation itself.
  await sync(h.agent, 'warmup-key-000000-0006');
  h.gate.current = { started: deferred(), release };

  const error = await sync(h.agent, key, { timeout: 300, transport: { requestTimeoutMs: 0 } }).then(
    () => assert.fail('expected a timeout'),
    err => err
  );
  assert.equal(error.name, 'TaskTimeoutError');
  const derived = idempotentOperationId(AGENT_ID, 'sync_accounts', key);
  assert.equal(error.taskId, derived);
  assert.ok(error.message.includes(derived));
  assert.equal(error.idempotency_key, key);

  release.resolve();
  const retry = await sync(h.agent, error.idempotency_key);
  assert.equal(retry.success, true, retry.error);

  const sent = h.callsTo('sync_accounts').map(call => call.args.push_notification_config);
  assert.equal(sent.length, 3); // warmup, timed-out attempt, retry
  assert.equal(JSON.stringify(sent[1]), JSON.stringify(sent[2]));
  assert.equal(sent[2].operation_id, derived);
});

test('a same-key call issued while the first is in flight is rejected with ConfigurationError', async t => {
  const h = await createHarness();
  const release = deferred();
  t.after(async () => {
    release.resolve();
    await h.close();
  });
  const key = 'in-flight-key-00000-0007';

  await sync(h.agent, 'warmup-key-000000-0008');
  const started = deferred();
  h.gate.current = { started, release };

  const first = sync(h.agent, key, { transport: { requestTimeoutMs: 0 } });
  await started.promise;

  await assert.rejects(sync(h.agent, key), error => {
    assert.ok(error instanceof ConfigurationError, `unexpected error: ${error}`);
    assert.match(error.message, /idempotency_key/);
    return true;
  });
  assert.equal(h.callsTo('sync_accounts').length, 2, 'the rejected call never reached the seller');

  release.resolve();
  const settled = await first;
  assert.equal(settled.success, true, settled.error);

  // Once the first call has finished, the same key is reusable.
  const again = await sync(h.agent, key);
  assert.equal(again.success, true, again.error);
});

test('a listener that aborts the call and retries the same key synchronously keeps the retry fenced', async t => {
  const { ProtocolClient, TaskExecutor } = require('../../dist/lib/index.js');
  const originalCallTool = ProtocolClient.callTool;
  t.after(() => {
    ProtocolClient.callTool = originalCallTool;
  });

  const agent = { id: 'reentrant-agent', name: 'Reentrant', agent_uri: 'https://agent.example/mcp/', protocol: 'mcp' };
  const key = 'reentrant-key-00000-0009';
  const reached = deferred();
  const release = deferred();
  let sellerCalls = 0;
  ProtocolClient.callTool = async () => {
    sellerCalls++;
    reached.resolve();
    await release.promise;
    return { status: 'completed', accounts: [] };
  };

  const executor = new TaskExecutor({
    agentId: agent.id,
    webhookUrlTemplate: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
    validation: { requests: 'off', responses: 'off' },
  });
  const run = options =>
    executor.executeTask(agent, 'sync_accounts', { idempotency_key: key, accounts: [] }, undefined, options);

  const controller = new AbortController();
  let retry;
  const unsubscribe = executor.onTaskUpdate(agent.id, task => {
    if (task.status !== 'submitted' || retry) return;
    controller.abort();
    retry = run({});
  });
  t.after(unsubscribe);

  const original = run({ signal: controller.signal });
  await assert.rejects(original, error => error?.name === 'AbortError' || /\bAbortError\b/.test(String(error)));
  assert.ok(retry, 'the listener started the retry');

  await reached.promise; // the retry is now parked in its seller call
  assert.equal(sellerCalls, 1);

  await assert.rejects(run({}), error => {
    assert.ok(error instanceof ConfigurationError, `unexpected error: ${error}`);
    assert.match(error.message, /idempotency_key/);
    return true;
  });
  assert.equal(sellerCalls, 1, 'the refused third call never reached the seller');

  release.resolve();
  const settled = await retry;
  assert.equal(settled.success, true, settled.error);
  assert.equal(settled.metadata.taskId, idempotentOperationId(agent.id, 'sync_accounts', key));
  assert.equal(sellerCalls, 1);
});

test('a child dispatch does not re-point a caller-supplied parent operationId on timeout', async t => {
  const { ProtocolClient, SingleAgentClient } = require('../../dist/lib/index.js');
  const originalCallTool = ProtocolClient.callTool;
  t.after(() => {
    ProtocolClient.callTool = originalCallTool;
  });

  const agent = { id: 'implicit-agent', name: 'Implicit', agent_uri: 'https://agent.example/mcp/', protocol: 'mcp' };
  const client = new SingleAgentClient(agent, { validation: { requests: 'off', responses: 'off' } });
  client.ensureEndpointDiscovered = async () => agent;
  client.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [client.getAdcpVersion()],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: false,
    account: { requiredForProducts: false, supportedBilling: ['operator'] },
  });

  ProtocolClient.callTool = async (_agent, _task, _params, options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2000);
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(options.signal.reason);
      });
    });
    return { status: 'completed', accounts: [] };
  };

  const error = await client
    .resolveAccount(
      { brand: { domain: 'brand.example' }, operator: 'agency.example' },
      { operationId: 'explicit-parent-operation', timeout: 40 }
    )
    .then(
      () => assert.fail('expected a timeout'),
      err => err
    );
  assert.equal(error.name, 'TaskTimeoutError');
  assert.equal(error.taskId, 'explicit-parent-operation');
  assert.match(error.message, /explicit-parent-operation/);
  assert.doesNotMatch(error.message, /idem-/);
});
