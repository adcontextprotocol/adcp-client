/**
 * Failures before dispatch carry a typed error and `dispatched: false`
 * (adcp-client#3378).
 *
 * A buyer that tracks seller health must tell "we refused to send it" from
 * "the seller failed" without matching message text. These tests pin the
 * request-validation error (class, fields, no submitted values, unchanged
 * message), the marker on each local refusal that sets it, and its absence
 * wherever the agent was contacted or the task was already sent.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const {
  AdCPClient,
  ADCPValidationError,
  FeatureUnsupportedError,
  ProtocolClient,
  ProtocolFeatureUnsupportedError,
  RequestValidationError,
  SingleAgentClient,
  VersionUnsupportedError,
  isPreDispatchError,
} = require('../../dist/lib/index.js');
const { validateOutgoingRequest } = require('../../dist/lib/validation/index.js');
const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const { MemoryStorage } = require('../../dist/lib/storage/MemoryStorage.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const SENTINEL = 'sentinel-submitted-value-7f3a';

function captureDispatch(t) {
  const calls = [];
  t.mock.method(ProtocolClient, 'callTool', async (_agent, taskName) => {
    calls.push(taskName);
    return { status: 'completed' };
  });
  return calls;
}

function caps(supportedVersions, overrides = {}) {
  return {
    version: 'v3',
    majorVersions: [3],
    ...(supportedVersions !== undefined && { supportedVersions }),
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    idempotency: { replayTtlSeconds: 86400 },
    _synthetic: false,
    ...overrides,
  };
}

function makeClient(sellerCapabilities, config = {}, agentUri = 'https://seller.example/mcp') {
  const client = new SingleAgentClient(
    { id: 'seller', name: 'Seller', agent_uri: agentUri, protocol: 'mcp' },
    { adcpVersion: '3.2.5', validateFeatures: false, validation: { requests: 'off', responses: 'off' }, ...config }
  );
  client.getCapabilities = async () => sellerCapabilities;
  return client;
}

function mediaBuyRequest() {
  return {
    idempotency_key: 'pre-dispatch-errors-0001',
    account: { brand: { domain: 'nike.com' }, operator: 'agency.example' },
    brand: { domain: 'nike.com' },
    start_time: 'asap',
    end_time: '2027-01-31T23:59:59Z',
    packages: [{ product_id: 'prod_1', pricing_option_id: 'po_1', budget: 1000 }],
  };
}

/** Everything a logger or serializer could see on the error. */
function serialized(err) {
  return JSON.stringify({ ...err, message: err.message, stack: err.stack, details: err.details });
}

describe('RequestValidationError from the client request schema (Zod)', () => {
  const agentConfig = { id: 'a2a-agent', name: 'A2A agent', agent_uri: 'https://test.example', protocol: 'a2a' };

  async function rejectSyncCreatives(t) {
    const calls = captureDispatch(t);
    const agent = new AdCPClient([agentConfig]).agent(agentConfig.id);
    let caught;
    await assert.rejects(
      agent.syncCreatives({
        account: { account_id: 'acc_1' },
        creatives: [
          {
            creative_id: 'cr_1',
            name: 'Creative',
            format_id: { agent_url: 'https://test.example', id: 'video_30s' },
            // Invalid: assets is a map, not an array.
            assets: [{ asset_type: 'video', url: `https://cdn.example/${SENTINEL}.mp4` }],
          },
        ],
      }),
      err => {
        caught = err;
        return true;
      }
    );
    assert.deepEqual(calls, [], 'the request must not reach the transport');
    return caught;
  }

  test('throws the exported typed error with the task and invalid paths', async t => {
    const err = await rejectSyncCreatives(t);
    assert.ok(err instanceof RequestValidationError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.ok(err instanceof ADCPValidationError, 'existing ValidationError catch sites keep matching');
    assert.equal(err.name, 'RequestValidationError');
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.task, 'sync_creatives');
    assert.deepEqual(err.fields, ['/creatives/0/assets']);
    assert.equal(err.field, '/creatives/0/assets');
    assert.equal(err.dispatched, false);
    assert.equal(isPreDispatchError(err), true);
  });

  test('keeps the existing message text', async t => {
    const err = await rejectSyncCreatives(t);
    assert.match(err.message, /^Request validation failed for sync_creatives: creatives\.0\.assets: \S/);
    assert.equal(err.stack.split('\n')[0], `RequestValidationError: ${err.message}`);
  });

  test('never carries the submitted value', async t => {
    const err = await rejectSyncCreatives(t);
    assert.equal(err.value, undefined);
    assert.ok(!serialized(err).includes(SENTINEL), serialized(err));
  });

  test('lists every invalid path once, as RFC 6901 pointers', async t => {
    const calls = captureDispatch(t);
    const agent = new AdCPClient([agentConfig]).agent(agentConfig.id);
    const err = await agent
      .createMediaBuy({
        account: { account_id: 'acc_1' },
        brand: { domain: 'nike.com' },
        start_time: 'asap',
        packages: [{ product_id: 'prod_1', pricing_option_id: 'po_1', budget: SENTINEL }],
      })
      .then(
        () => assert.fail('expected a validation error'),
        e => e
      );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof RequestValidationError, err?.message);
    assert.equal(err.task, 'create_media_buy');
    assert.ok(err.fields.includes('/end_time'), err.fields.join(', '));
    assert.ok(err.fields.includes('/packages/0/budget'), err.fields.join(', '));
    assert.equal(new Set(err.fields).size, err.fields.length);
    assert.ok(Object.isFrozen(err.fields));
    assert.match(err.message, /^Request validation failed for create_media_buy: /);
    assert.ok(!serialized(err).includes(SENTINEL), serialized(err));
  });
});

describe('RequestValidationError from schema-driven request validation (AJV)', () => {
  test('strict mode throws the typed error with the unchanged message', () => {
    let err;
    try {
      validateOutgoingRequest('get_products', { buying_mode: SENTINEL }, 'strict');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof RequestValidationError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.ok(err instanceof ADCPValidationError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.task, 'get_products');
    assert.equal(err.dispatched, false);
    assert.ok(err.fields.length > 0);
    assert.ok(
      err.fields.every(field => field.startsWith('/')),
      err.fields.join(', ')
    );
    assert.equal(err.field, err.fields[0]);
    assert.equal(err.value, undefined);
    assert.deepEqual(
      err.fields,
      [...new Set(err.details.issues.map(issue => issue.pointer))],
      'fields mirror the issue pointers'
    );
    assert.equal(err.details.side, 'request');
    assert.match(err.message, new RegExp(`^Validation failed for field '${err.field}': get_products request: `));
    assert.ok(!serialized(err).includes(SENTINEL), serialized(err));
  });

  test('a client in strict request mode refuses before dispatch', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.2']), { validation: { requests: 'strict', responses: 'off' } });
    client.ensureEndpointDiscovered = async () => client.agent;
    // Bypass the generated Zod pass so the schema-driven pass is the one that refuses.
    client.validateRequest = () => {};
    const err = await client.getProducts({ buying_mode: 'brief', brief: 7 }).then(
      () => assert.fail('expected a validation error'),
      e => e
    );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof RequestValidationError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, false);
    assert.ok(err.fields.includes('/brief'), err.fields.join(', '));
  });
});

describe('dispatched: false on local refusals', () => {
  for (const [label, sellerCaps, reason] of [
    ['no release on or below the client line', caps(['4.0']), 'version'],
    ['no idempotency replay window', caps(['3.2'], { idempotency: undefined }), 'idempotency'],
  ]) {
    test(`the version check from known capabilities: ${label}`, async t => {
      const calls = captureDispatch(t);
      const client = makeClient(sellerCaps, { requireV3ForMutations: true });
      client.ensureEndpointDiscovered = async () => client.agent;
      const err = await client.createMediaBuy(mediaBuyRequest()).then(
        () => assert.fail('expected a version error'),
        e => e
      );
      assert.deepEqual(calls, []);
      assert.ok(err instanceof VersionUnsupportedError, `got ${err?.constructor?.name}: ${err?.message}`);
      assert.equal(err.reason, reason);
      assert.equal(err.taskType, 'create_media_buy');
      assert.equal(err.dispatched, false);
      assert.equal(isPreDispatchError(err), true);
    });
  }

  test('a v2 server version passed to the executor', async t => {
    const calls = captureDispatch(t);
    const executor = new TaskExecutor();
    const err = await executor
      .executeTask(
        { id: 'a', name: 'a', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'get_products',
        {},
        undefined,
        {},
        'v2'
      )
      .then(
        () => assert.fail('expected a version error'),
        e => e
      );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof VersionUnsupportedError);
    assert.equal(err.dispatched, false);
  });

  test('the release and feature gates', async t => {
    const calls = captureDispatch(t);
    // The SDK's own 3.3 preview pin against a seller that advertises only an older
    // preview: exact preview negotiation refuses the 3.3-only tool before dispatch.
    const client = makeClient(caps(['3.3-beta.0']), { adcpVersion: ADCP_VERSION });
    client.ensureEndpointDiscovered = async () => client.agent;
    const err = await client.listCollections().then(
      () => assert.fail('expected a feature error'),
      e => e
    );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof ProtocolFeatureUnsupportedError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, false);
    assert.equal(new FeatureUnsupportedError(['audience_targeting'], []).dispatched, false);
  });

  test('executeTask throws the marked validation error in strict request mode', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.2']), { validation: { requests: 'strict', responses: 'off' } });
    client.ensureEndpointDiscovered = async () => client.agent;
    const err = await client.executeTask('get_products', { buying_mode: SENTINEL }).then(
      result => assert.fail(`expected a throw, got ${JSON.stringify(result)}`),
      e => e
    );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof RequestValidationError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, false);
  });

  test('isPreDispatchError checks the property, not the class', () => {
    const foreign = Object.assign(new Error('Request refused'), { code: 'VALIDATION_ERROR', dispatched: false });
    assert.equal(isPreDispatchError(foreign), true);
    assert.equal(isPreDispatchError(new Error('Request validation failed for get_products: x')), false);
    assert.equal(isPreDispatchError(Object.assign(new Error('sent'), { dispatched: true })), false);
    assert.equal(isPreDispatchError(undefined), false);
    assert.equal(isPreDispatchError('dispatched: false'), false);
  });
});

/** A local port with nothing listening on it. */
async function refusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** A seller that answers every request with 503. */
async function unavailableSeller(t) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('service unavailable');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function liveClient(port, config) {
  return new SingleAgentClient(
    { id: 'down-seller', name: 'Down seller', agent_uri: `http://127.0.0.1:${port}/mcp`, protocol: 'mcp' },
    config
  );
}

describe('no dispatched marker where the agent was contacted or the task was sent', () => {
  const configs = [
    ['default config', {}],
    ['validateFeatures: false', { validateFeatures: false }],
  ];
  const calls = [
    ['getProducts', client => client.getProducts({ buying_mode: 'brief', brief: 'shoes' })],
    ['createMediaBuy', client => client.createMediaBuy(mediaBuyRequest())],
  ];
  const sellers = [
    ['a seller refusing connections', async () => refusedPort()],
    ['a seller answering 503', async t => unavailableSeller(t)],
  ];

  for (const [sellerName, seller] of sellers) {
    for (const [configName, config] of configs) {
      for (const [method, call] of calls) {
        test(`${method} against ${sellerName} under ${configName}`, async t => {
          const client = liveClient(await seller(t), config);
          const outcome = await call(client).then(
            result => ({ result }),
            error => ({ error })
          );
          const failure = outcome.error ?? outcome.result;
          assert.ok(outcome.error || outcome.result?.success === false, 'the call must fail');
          assert.equal(isPreDispatchError(failure), false, `marked: ${failure?.message ?? failure?.error}`);
          assert.equal(failure?.dispatched, undefined);
        });
      }
    }
  }

  test('getCapabilities() rejecting a v2 seller', async t => {
    t.mock.method(console, 'warn', () => {});
    const client = new SingleAgentClient({
      id: 'v2-seller',
      name: 'v2 seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    });
    const sent = [];
    client.getAgentInfo = async () => ({ tools: [{ name: 'get_adcp_capabilities' }] });
    client.ensureEndpointDiscovered = async () => client.agent;
    client.executor.executeTask = async (_agent, task) => {
      sent.push(task);
      return { success: true, status: 'completed', data: { adcp: { major_versions: [2] } } };
    };
    const err = await client.getCapabilities().then(
      () => assert.fail('expected a version error'),
      e => e
    );
    assert.deepEqual(sent, ['get_adcp_capabilities'], 'the capabilities request was sent');
    assert.ok(err instanceof VersionUnsupportedError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, undefined);
    assert.equal(isPreDispatchError(err), false);
  });

  test('refusing to resume a deferred task', async () => {
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = 'B'.repeat(43);
    await storage.putIfAbsent(
      token,
      { serverVersion: 'v2', taskName: 'create_media_buy', expiresAt: Date.now() + 60000 },
      60
    );
    const executor = new TaskExecutor({ deferredStorage: storage });
    const err = await executor.resumeDeferredTask(token, {}).then(
      () => assert.fail('expected a version error'),
      e => e
    );
    assert.ok(err instanceof VersionUnsupportedError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, undefined);
    assert.equal(isPreDispatchError(err), false);
  });
});
