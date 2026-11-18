process.env.NODE_ENV = 'test';

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  serve,
  AgentClient,
  SingleAgentClient,
  ProtocolClient,
  ProtocolFeatureUnsupportedError,
  getClientPreflightAdcpError,
  parseCapabilitiesResponse,
  resolveFeature,
} = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { adcpError } = require('../../dist/lib/server/errors.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');

const FEATURE = 'media_buy.features.creative_start_policy';
const FIELD = 'start_requires_all_creatives_approved';
const AUTH = { authInfo: { token: 't', clientId: 'buyer', scopes: [] } };

function buildServer({ capabilities, validation, idempotency, adcpVersion, received = [] } = {}) {
  return createAdcpServer({
    name: 'creative-start-policy',
    version: '1.0.0',
    ...(adcpVersion && { adcpVersion }),
    resolveAccount: ref => (ref ? { account_id: ref.account_id, status: 'active' } : undefined),
    ...(capabilities && { capabilities }),
    ...(idempotency && { idempotency, resolveIdempotencyPrincipal: () => 'buyer' }),
    validation: validation ?? { requests: 'strict', responses: 'off' },
    mediaBuy: {
      controlMediaBuy: async params => {
        received.push(params);
        return {
          status: 'completed',
          media_buy_id: params.media_buy_id,
          media_buy_status: 'active',
          revision: 2,
          available_actions: [],
        };
      },
    },
  });
}

// `undefined` yields a package with a different control, so every entry is valid.
const controlRequest = (policies, overrides = {}) => ({
  adcp_version: '3.3-beta.6',
  idempotency_key: 'a'.repeat(16),
  account: { account_id: 'acct_1' },
  media_buy_id: 'mb_1',
  revision: 1,
  packages: policies.map((p, i) =>
    p === undefined ? { package_id: `pkg_${i}`, paused: false } : { package_id: `pkg_${i}`, [FIELD]: p }
  ),
  ...overrides,
});

const call = (server, name, args) =>
  server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } }, AUTH);

const errorOf = frame => frame.structuredContent?.adcp_error;

function assertRefused(frame, received, fields) {
  assert.strictEqual(received.length, 0, 'handler must not run');
  assert.deepStrictEqual(errorOf(frame), {
    code: 'UNSUPPORTED_FEATURE',
    message: `${FIELD}: true requires ${FEATURE}, which this seller does not declare`,
    recovery: 'correctable',
    field: fields[0],
    suggestion: `Omit ${FIELD} or send false; check ${FEATURE} in get_adcp_capabilities before opting in`,
    details: { feature: FEATURE, fields },
    mutation_outcome: 'not_applied',
  });
}

describe('control_media_buy creative start policy: server', () => {
  test('refuses an opted-in package when nothing is declared', async () => {
    const received = [];
    const frame = await call(buildServer({ received }), 'control_media_buy', controlRequest([true]));
    assertRefused(frame, received, [`packages[0].${FIELD}`]);
  });

  test('refuses when creativeStartPolicy is explicitly false', async () => {
    const received = [];
    const server = buildServer({ received, capabilities: { features: { creativeStartPolicy: false } } });
    const frame = await call(server, 'control_media_buy', controlRequest([true]));
    assertRefused(frame, received, [`packages[0].${FIELD}`]);
  });

  test('reports the first opted-in package as field and every opted-in package in details.fields', async () => {
    const received = [];
    const frame = await call(
      buildServer({ received }),
      'control_media_buy',
      controlRequest([false, true, undefined, true])
    );
    assertRefused(frame, received, [`packages[1].${FIELD}`, `packages[3].${FIELD}`]);
  });

  test('refuses regardless of validation mode', async () => {
    for (const requests of ['off', 'warn', 'strict']) {
      const received = [];
      const server = buildServer({ received, validation: { requests, responses: 'off' } });
      const frame = await call(server, 'control_media_buy', controlRequest([true]));
      assertRefused(frame, received, [`packages[0].${FIELD}`]);
    }
  });

  test('passes through when declared via capabilities.features', async () => {
    const received = [];
    const server = buildServer({ received, capabilities: { features: { creativeStartPolicy: true } } });
    const frame = await call(server, 'control_media_buy', controlRequest([true, undefined]));
    assert.strictEqual(errorOf(frame), undefined);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].packages[0][FIELD], true);
  });

  test('passes through when declared via capabilities.overrides', async () => {
    const received = [];
    const server = buildServer({
      received,
      capabilities: { overrides: { media_buy: { features: { creative_start_policy: true } } } },
    });
    const frame = await call(server, 'control_media_buy', controlRequest([true]));
    assert.strictEqual(errorOf(frame), undefined);
    assert.strictEqual(received.length, 1);
  });

  test('false and omission always reach the handler', async () => {
    for (const policies of [[false], [undefined], [false, undefined]]) {
      const received = [];
      const frame = await call(buildServer({ received }), 'control_media_buy', controlRequest(policies));
      assert.strictEqual(errorOf(frame), undefined, JSON.stringify(policies));
      assert.strictEqual(received.length, 1, JSON.stringify(policies));
    }
  });

  test('a server pinned below 3.3 is not gated', async () => {
    const received = [];
    const server = buildServer({ received, adcpVersion: '3.2.8', validation: { requests: 'off', responses: 'off' } });
    const frame = await call(server, 'control_media_buy', controlRequest([true], { adcp_version: '3.2.8' }));
    assert.notStrictEqual(errorOf(frame)?.code, 'UNSUPPORTED_FEATURE');
    assert.strictEqual(received.length, 1);
  });

  test('update_media_buy with the field is not gated', async () => {
    let called = 0;
    const server = createAdcpServer({
      name: 'update-not-gated',
      version: '1.0.0',
      resolveAccount: ref => (ref ? { account_id: ref.account_id, status: 'active' } : undefined),
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: {
        updateMediaBuy: async params => {
          called += 1;
          return { media_buy_id: params.media_buy_id, status: 'active', revision: 2 };
        },
      },
    });
    const frame = await call(server, 'update_media_buy', {
      adcp_version: '3.3-beta.6',
      idempotency_key: 'b'.repeat(16),
      account: { account_id: 'acct_1' },
      media_buy_id: 'mb_1',
      revision: 1,
      packages: [{ package_id: 'pkg_0', [FIELD]: true, paused: false }],
    });
    assert.notStrictEqual(errorOf(frame)?.code, 'UNSUPPORTED_FEATURE');
    assert.strictEqual(called, 1);
  });

  test('the refusal runs before idempotency: it is never cached and a cached success is never replayed for it', async () => {
    const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
    const request = controlRequest([true]);

    // Refused first, then the same key and payload succeeds once declared.
    const undeclaredReceived = [];
    const undeclared = buildServer({ received: undeclaredReceived, idempotency });
    assertRefused(await call(undeclared, 'control_media_buy', request), undeclaredReceived, [`packages[0].${FIELD}`]);
    const declaredReceived = [];
    const declared = buildServer({
      received: declaredReceived,
      idempotency,
      capabilities: { features: { creativeStartPolicy: true } },
    });
    const ok = await call(declared, 'control_media_buy', request);
    assert.strictEqual(errorOf(ok), undefined);
    assert.strictEqual(declaredReceived.length, 1);

    // A cached success is not replayed to an undeclared seller that shares the store.
    const replayReceived = [];
    const replay = buildServer({ received: replayReceived, idempotency });
    assertRefused(await call(replay, 'control_media_buy', request), replayReceived, [`packages[0].${FIELD}`]);
  });

  test('get_adcp_capabilities emits creative_start_policy only when declared', async () => {
    const featuresOf = async capabilities => {
      const frame = await buildServer({ capabilities }).dispatchTestRequest({
        method: 'tools/call',
        params: { name: 'get_adcp_capabilities', arguments: { adcp_version: '3.3-beta.6' } },
      });
      return frame.structuredContent.media_buy.features;
    };
    assert.strictEqual((await featuresOf({ features: { creativeStartPolicy: true } })).creative_start_policy, true);
    assert.strictEqual((await featuresOf({ features: { creativeStartPolicy: false } })).creative_start_policy, false);
    assert.ok(!('creative_start_policy' in (await featuresOf(undefined))));
  });
});

describe('creative start policy capability parsing and error helper', () => {
  const parse = value =>
    parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      media_buy: { features: value === undefined ? {} : { creative_start_policy: value } },
    });

  test('true is parsed and resolves', () => {
    const caps = parse(true);
    assert.strictEqual(caps.features.creativeStartPolicy, true);
    assert.strictEqual(resolveFeature(caps, 'creative_start_policy'), true);
  });

  test('false is parsed and does not resolve', () => {
    const caps = parse(false);
    assert.strictEqual(caps.features.creativeStartPolicy, false);
    assert.strictEqual(resolveFeature(caps, 'creative_start_policy'), false);
  });

  test('absent stays undeclared', () => {
    const caps = parse(undefined);
    assert.strictEqual(caps.features.creativeStartPolicy, undefined);
    assert.strictEqual(resolveFeature(caps, 'creative_start_policy'), false);
  });

  test('non-boolean values are ignored', () => {
    for (const value of ['true', 1, null, {}]) {
      const caps = parse(value);
      assert.strictEqual(caps.features.creativeStartPolicy, undefined, JSON.stringify(value));
      assert.strictEqual(resolveFeature(caps, 'creative_start_policy'), false, JSON.stringify(value));
    }
  });

  test('adcpError carries mutation_outcome', () => {
    const response = adcpError('UNSUPPORTED_FEATURE', { message: 'x', mutation_outcome: 'not_applied' });
    assert.strictEqual(response.structuredContent.adcp_error.mutation_outcome, 'not_applied');
    const without = adcpError('UNSUPPORTED_FEATURE', { message: 'x' });
    assert.ok(!('mutation_outcome' in without.structuredContent.adcp_error));
  });
});

describe('control_media_buy creative start policy: client against a real seller', () => {
  async function withSeller(capabilities, run) {
    const received = [];
    const httpServer = serve(() => buildServer({ capabilities, received }), {
      port: 0,
      onListening: () => {},
      authenticate: async () => ({ principal: 'buyer', token: 't', scopes: [] }),
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      if (httpServer.listening) resolve();
      else httpServer.once('listening', resolve);
    });
    const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
    try {
      await run(new AgentClient({ id: 's', name: 's', agent_uri: url, protocol: 'mcp', auth_token: 't' }), received);
    } finally {
      await new Promise(resolve => httpServer.close(resolve));
    }
  }

  const params = (...policies) => ({
    account: { account_id: 'acct_1' },
    media_buy_id: 'mb_1',
    revision: 1,
    packages: policies.map((p, i) => ({ package_id: `pkg_${i}`, [FIELD]: p })),
  });

  test('refuses locally when the seller does not declare the feature', async () => {
    await withSeller(undefined, async (client, received) => {
      let thrown;
      try {
        await client.controlMediaBuy(params(false, true, true));
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof ProtocolFeatureUnsupportedError, `got ${thrown}`);
      assert.strictEqual(thrown.code, 'UNSUPPORTED_FEATURE');
      assert.strictEqual(thrown.dispatched, false);
      assert.deepStrictEqual(thrown.unsupportedFeatures, ['creative_start_policy']);
      assert.strictEqual(received.length, 0, 'seller must never see the request');

      const preflight = getClientPreflightAdcpError(thrown);
      assert.ok(preflight, 'preflight error shape');
      assert.strictEqual(preflight.code, 'UNSUPPORTED_FEATURE');
      assert.strictEqual(preflight.field, `packages[1].${FIELD}`);
      assert.strictEqual(preflight.details.feature, FEATURE);
      assert.deepStrictEqual(preflight.details.fields, [`packages[1].${FIELD}`, `packages[2].${FIELD}`]);
    });
  });

  test('sends when the seller declares the feature', async () => {
    await withSeller({ features: { creativeStartPolicy: true } }, async (client, received) => {
      const result = await client.controlMediaBuy(params(true));
      assert.strictEqual(result.success, true, JSON.stringify(result.error ?? result));
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].packages[0][FIELD], true);
    });
  });

  test('sends false to a seller that does not declare the feature', async () => {
    await withSeller(undefined, async (client, received) => {
      const result = await client.controlMediaBuy(params(false));
      assert.strictEqual(result.success, true, JSON.stringify(result.error ?? result));
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].packages[0][FIELD], false);
    });
  });
});

describe('control_media_buy creative start policy: client unit cases', () => {
  function stubClient({ capabilities, adcpVersion, wireAdcpVersion }) {
    const client = new SingleAgentClient(
      { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example.com/mcp', protocol: 'mcp' },
      {
        ...(adcpVersion && { adcpVersion }),
        ...(wireAdcpVersion && { wireAdcpVersion }),
        validateFeatures: false,
        validation: { requests: 'off', responses: 'off' },
      }
    );
    client.getCapabilities = async () => capabilities;
    client.ensureEndpointDiscovered = async () => client.agent;
    return client;
  }

  const discovered = (supportedVersions, features = {}) => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions,
    protocols: ['media_buy'],
    features,
    extensions: [],
    _synthetic: false,
  });

  async function dispatched(client, request) {
    const original = ProtocolClient.callTool;
    const calls = [];
    ProtocolClient.callTool = async (_agent, taskName, sent) => {
      calls.push({ taskName, params: sent });
      return {
        status: 'completed',
        media_buy_id: 'mb_1',
        media_buy_status: 'active',
        revision: 2,
        available_actions: [],
      };
    };
    try {
      await client.controlMediaBuy(request);
    } finally {
      ProtocolClient.callTool = original;
    }
    return calls;
  }

  const request = policy => ({
    account: { account_id: 'acct_1' },
    media_buy_id: 'mb_1',
    revision: 1,
    packages: [{ package_id: 'pkg_0', [FIELD]: policy }],
  });

  test('synthetic capabilities send and let the seller decide', async () => {
    const client = stubClient({
      capabilities: { ...discovered(['3.3-beta.6']), _synthetic: true },
      wireAdcpVersion: '3.3-beta.6',
    });
    const calls = await dispatched(client, request(true));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].taskName, 'control_media_buy');
  });

  test('discovered capabilities without the feature refuse, with it send', async () => {
    const refused = stubClient({ capabilities: discovered(['3.3-beta.6']) });
    await assert.rejects(dispatched(refused, request(true)), error => error instanceof ProtocolFeatureUnsupportedError);

    const accepted = stubClient({ capabilities: discovered(['3.3-beta.6'], { creativeStartPolicy: true }) });
    assert.strictEqual((await dispatched(accepted, request(true))).length, 1);
  });

  test('false and omission send even when the feature is undeclared', async () => {
    const client = stubClient({ capabilities: discovered(['3.3-beta.6']) });
    assert.strictEqual((await dispatched(client, request(false))).length, 1);
    const omitted = { ...request(false), packages: [{ package_id: 'pkg_0', paused: false }] };
    assert.strictEqual((await dispatched(client, omitted)).length, 1);
  });

  test('a call negotiated below 3.3 sends', async () => {
    const client = stubClient({ capabilities: discovered(['3.2.1']), adcpVersion: '3.2.1' });
    const calls = await dispatched(client, request(true));
    assert.strictEqual(calls.length, 1);
  });
});
