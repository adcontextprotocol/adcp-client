/**
 * Failures before dispatch carry a typed error and `dispatched: false`
 * (adcp-client#3378).
 *
 * A buyer that tracks seller health must tell "we refused to send it" from
 * "the seller failed" without matching message text. These tests pin the
 * request-validation error (class, fields, no submitted values, unchanged
 * message) and the marker on each pre-dispatch path that sets it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AdCPClient,
  ADCPValidationError,
  AuthenticationRequiredError,
  FeatureUnsupportedError,
  ProtocolClient,
  ProtocolFeatureUnsupportedError,
  RequestValidationError,
  SingleAgentClient,
  VersionUnsupportedError,
  isPreDispatchError,
} = require('../../dist/lib/index.js');
const { validateOutgoingRequest } = require('../../dist/lib/validation/index.js');

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

describe('dispatched: false on other pre-dispatch failures', () => {
  test('the version check', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['4.0'], { majorVersions: [4] }), { requireV3ForMutations: true });
    client.ensureEndpointDiscovered = async () => client.agent;
    const err = await client.createMediaBuy(mediaBuyRequest()).then(
      () => assert.fail('expected a version error'),
      e => e
    );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof VersionUnsupportedError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, false);
    assert.equal(isPreDispatchError(err), true);
    await assert.rejects(client.requireSupportedMajor('create_media_buy'), e => e.dispatched === false);
  });

  test('the release and feature gates', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.3-beta.0']), { adcpVersion: '3.3.0-beta.1' });
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

  test('endpoint discovery on a typed task method', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.2']), {}, 'https://seller.example');
    client.discoverMCPEndpoint = async () => {
      throw new Error('no MCP endpoint answered at https://seller.example');
    };
    const err = await client.getProducts({ buying_mode: 'brief', brief: 'shoes' }).then(
      () => assert.fail('expected a discovery error'),
      e => e
    );
    assert.deepEqual(calls, []);
    assert.match(err.message, /no MCP endpoint answered/);
    assert.equal(err.dispatched, false);
    assert.equal(isPreDispatchError(err), true);
  });

  test('endpoint discovery on executeTask', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.2']), {}, 'https://seller.example');
    client.discoverMCPEndpoint = async () => {
      throw new AuthenticationRequiredError('https://seller.example');
    };
    const err = await client.executeTask('get_products', { buying_mode: 'brief', brief: 'shoes' }).then(
      () => assert.fail('expected a discovery error'),
      e => e
    );
    assert.deepEqual(calls, []);
    assert.ok(err instanceof AuthenticationRequiredError, `got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.dispatched, false);
  });

  test('a caller abort during discovery is left unmarked', async t => {
    captureDispatch(t);
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const client = makeClient(caps(['3.2']), {}, 'https://seller.example');
    client.discoverMCPEndpoint = async () => {
      controller.abort(reason);
      throw reason;
    };
    const err = await client
      .getProducts({ buying_mode: 'brief', brief: 'shoes' }, undefined, { signal: controller.signal })
      .then(
        () => assert.fail('expected an abort'),
        e => e
      );
    assert.equal(err.dispatched, undefined);
    assert.equal(Object.hasOwn(reason, 'dispatched'), false);
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
