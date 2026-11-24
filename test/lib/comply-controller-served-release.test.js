/**
 * adcp-client#3769: `comply_test_controller` registers after `createAdcpServer`
 * returns, outside the spec-tool dispatcher. It must still answer at the
 * caller's served AdCP release (DR-0024): a 3.2 pin gets no 3.3-only fields
 * (`forced.arm: 'unable'` / `proposal_id`), an unservable pin is refused with
 * `VERSION_UNSUPPORTED` before the controller runs, and `adcp_version` is
 * echoed. A raw SDK `McpServer` (no `createAdcpServer`) is unchanged.
 */

process.env.NODE_ENV = 'test';
process.env.ADCP_SANDBOX = '1'; // legacy conformance visibility bridge for complyTest

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { getSdkServer } = require('../../dist/lib/server/adcp-server');
const { registerTestController } = require('../../dist/lib/server/test-controller');
const { createComplyController } = require('../../dist/lib/testing/comply-controller');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform');
const { __resetObservedAccountModes } = require('../../dist/lib/server/decisioning/runtime/observed-modes');
const { validateResponse } = require('../../dist/lib/validation/schema-validator');

const SERVED = ['3.2', '3.3-rc.3'];
const CTX = { correlation_id: 'c-3769' };

const open = [];
after(async () => {
  for (const close of open) await close().catch(() => {});
});

async function connect(server) {
  const sdk = server instanceof McpServer ? server : getSdkServer(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await sdk.connect(st);
  const client = new Client({ name: 'served-release-test', version: '1.0.0' });
  await client.connect(ct);
  open.push(() => client.close());
  return client;
}

/** A force handler that records calls and returns a schema-valid `forced` payload. */
function makeForce() {
  const calls = [];
  return {
    calls,
    create_media_buy_arm: params => {
      calls.push(params);
      return {
        success: true,
        forced: { arm: params.arm, task_id: params.task_id },
        message: 'ok',
      };
    },
  };
}

function makeStore(force) {
  return {
    forceCreateMediaBuyArm: async params => force.create_media_buy_arm(params),
  };
}

const armArgs = (extra = {}) => ({
  account: { sandbox: true },
  scenario: 'force_create_media_buy_arm',
  params: { arm: 'submitted', task_id: 't1' },
  context: CTX,
  ...extra,
});

function adcpServer() {
  return createAdcpServer({
    name: 'served-release',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    capabilities: { supported_versions: SERVED },
  });
}

async function viaRegisterTestController() {
  const force = makeForce();
  const server = adcpServer();
  registerTestController(server, makeStore(force));
  return { client: await connect(server), force };
}

async function viaComplyController() {
  const force = makeForce();
  const server = adcpServer();
  createComplyController({ sandboxGate: () => true, force }).register(server);
  return { client: await connect(server), force };
}

async function viaPlatform() {
  const force = makeForce();
  const server = createAdcpServerFromPlatform(
    {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
        compliance_testing: {},
      },
      statusMappers: {},
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'sb_acc',
          mode: 'sandbox',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({
          currency: 'USD',
          reporting_period: { start: '2026-04-01', end: '2026-04-30' },
          media_buy_deliveries: [],
        }),
      },
    },
    {
      name: 'served-release-platform',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
      capabilities: { supported_versions: SERVED },
      complyTest: { force },
    }
  );
  return { client: await connect(server), force, server };
}

const PATHS = [
  ['registerTestController', viaRegisterTestController],
  ['createComplyController().register', viaComplyController],
  ['createAdcpServerFromPlatform controller', viaPlatform],
];

const call = (client, args) => client.callTool({ name: 'comply_test_controller', arguments: args });

// The platform path declares the major (`supported_versions: ['3']`), so it
// serves 3.0 too; only a release outside 3.x is unservable there.
for (const [label, setup] of PATHS) {
  const unservable = label.startsWith('createAdcpServerFromPlatform') ? ['9.9'] : ['9.9', '3.0'];
  describe(`comply_test_controller served release — ${label}`, () => {
    it('a 3.2 pin gets the 3.2 shape, echoes adcp_version, and validates against the 3.2 schema', async () => {
      const { client } = await setup();
      const result = await call(client, armArgs({ adcp_version: '3.2' }));
      const sc = result.structuredContent;
      assert.equal(sc.success, true, JSON.stringify(sc));
      assert.equal(sc.adcp_version, '3.2');
      assert.equal(sc.forced.arm, 'submitted');
      assert.equal(sc.forced.task_id, 't1');
      assert.equal('proposal_id' in sc.forced, false);
      assert.deepEqual(sc.context, CTX);
      const outcome = validateResponse('comply_test_controller', sc, '3.2');
      assert.equal(outcome.valid, true, JSON.stringify(outcome.issues ?? outcome));
    });

    it('a 3.3 caller gets the body unchanged', async () => {
      const { client } = await setup();
      const sc = (await call(client, armArgs({ adcp_version: '3.3-rc.3' }))).structuredContent;
      assert.equal(sc.success, true, JSON.stringify(sc));
      assert.deepEqual(sc.forced, { arm: 'submitted', task_id: 't1' });
      assert.equal(sc.adcp_version, '3.3-rc.3');
      assert.deepEqual(sc.context, CTX);
      const outcome = validateResponse('comply_test_controller', sc, '3.3.0-rc.3');
      assert.equal(outcome.valid, true, JSON.stringify(outcome.issues ?? outcome));
    });

    it('a call with no pin is served at the default release', async () => {
      const { client } = await setup();
      const sc = (await call(client, armArgs())).structuredContent;
      assert.equal(sc.success, true, JSON.stringify(sc));
      assert.equal(typeof sc.adcp_version, 'string');
      assert.ok(SERVED.includes(sc.adcp_version), `unexpected default release ${sc.adcp_version}`);
      assert.deepEqual(sc.forced, { arm: 'submitted', task_id: 't1' });
    });

    for (const pin of unservable) {
      it(`an unservable pin (${pin}) gets VERSION_UNSUPPORTED and never reaches the store`, async () => {
        const { client, force } = await setup();
        const result = await call(client, armArgs({ adcp_version: pin }));
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
        assert.deepEqual(result.structuredContent.context, CTX);
        assert.equal(force.calls.length, 0, 'controller must not run for an unservable pin');
      });
    }

    it('projects a controller error arm instead of mangling it', async () => {
      const { client } = await setup();
      // Missing task_id for arm=submitted: the controller answers INVALID_PARAMS.
      const sc = (await call(client, armArgs({ adcp_version: '3.2', params: { arm: 'submitted' } }))).structuredContent;
      assert.equal(sc.success, false);
      assert.equal(sc.error, 'INVALID_PARAMS');
      assert.equal(typeof sc.error_detail, 'string');
      assert.deepEqual(sc.context, CTX);
      assert.equal(sc.adcp_version, '3.2');
    });
  });
}

describe('comply_test_controller served release — raw McpServer is unchanged', () => {
  it('adds no adcp_version and projects nothing', async () => {
    const force = makeForce();
    const bare = new McpServer({ name: 'bare', version: '1.0.0' });
    createComplyController({ sandboxGate: () => true, force }).register(bare);
    const client = await connect(bare);
    const result = await call(client, armArgs({ adcp_version: '3.2' }));
    const sc = result.structuredContent;
    assert.equal(sc.success, true, JSON.stringify(sc));
    assert.equal('adcp_version' in sc, false);
    assert.deepEqual(sc.forced, { arm: 'submitted', task_id: 't1' });
    assert.deepEqual(sc.context, CTX);
  });

  it('does not refuse an unservable pin', async () => {
    const force = makeForce();
    const bare = new McpServer({ name: 'bare', version: '1.0.0' });
    createComplyController({ sandboxGate: () => true, force }).register(bare);
    const client = await connect(bare);
    const sc = (await call(client, armArgs({ adcp_version: '9.9' }))).structuredContent;
    assert.equal(sc.success, true, JSON.stringify(sc));
    assert.equal(force.calls.length, 1);
  });
});

describe('comply_test_controller served release — platform visibility gate', () => {
  it('a principal that cannot see the controller gets MethodNotFound, not VERSION_UNSUPPORTED', async () => {
    const force = makeForce();
    const server = createAdcpServerFromPlatform(
      {
        capabilities: {
          specialisms: ['sales-non-guaranteed'],
          creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
          channels: ['display'],
          pricingModels: ['cpm'],
          config: {},
          compliance_testing: {},
        },
        statusMappers: {},
        accounts: {
          resolve: async ref => ({
            id: ref?.account_id ?? 'live_acc',
            mode: 'live',
            ctx_metadata: {},
            authInfo: { kind: 'api_key' },
          }),
        },
        sales: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] }),
          updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
          syncCreatives: async () => [],
          getMediaBuyDelivery: async () => ({
            currency: 'USD',
            reporting_period: { start: '2026-04-01', end: '2026-04-30' },
            media_buy_deliveries: [],
          }),
        },
      },
      {
        name: 'hidden',
        version: '1.0.0',
        validation: { requests: 'off', responses: 'off' },
        capabilities: { supported_versions: SERVED },
        complyTest: { force },
      }
    );
    delete process.env.ADCP_SANDBOX;
    try {
      await assert.rejects(
        () =>
          server.dispatchTestRequest({
            method: 'tools/call',
            params: {
              name: 'comply_test_controller',
              arguments: armArgs({ account: { account_id: 'live_acc' }, adcp_version: '9.9' }),
            },
          }),
        err => err?.code === -32601
      );
      assert.equal(force.calls.length, 0);
    } finally {
      process.env.ADCP_SANDBOX = '1';
    }
  });
});

// A 3.3-only value (`forced.arm: 'unable'`, with its `proposal_id`) is valid at
// 3.3 but has no 3.2 form. A 3.3 caller gets it unchanged; a 3.2 caller is
// refused rather than handed a body 3.2 rejects.
const UNABLE_BODY = () => ({
  success: true,
  forced: { arm: 'unable', proposal_id: 'p1' },
  message: 'ok',
});

async function unableServer(register) {
  const server = adcpServer();
  register(server, { forceCreateMediaBuyArm: async () => UNABLE_BODY() });
  return connect(server);
}

describe('comply_test_controller served release — unrepresentable values', () => {
  it('the fixture is a valid 3.3 body', () => {
    const outcome = validateResponse('comply_test_controller', UNABLE_BODY(), '3.3.0-rc.3');
    assert.equal(outcome.valid, true, JSON.stringify(outcome.issues ?? outcome));
  });

  it('a 3.3 caller gets arm: unable unchanged', async () => {
    const client = await unableServer((server, store) => registerTestController(server, store));
    const sc = (await call(client, armArgs({ adcp_version: '3.3-rc.3' }))).structuredContent;
    assert.equal(sc.success, true, JSON.stringify(sc));
    assert.deepEqual(sc.forced, { arm: 'unable', proposal_id: 'p1' });
    assert.equal(sc.adcp_version, '3.3-rc.3');
  });

  it('a 3.2 caller gets VERSION_UNSUPPORTED, not a malformed success', async () => {
    const client = await unableServer((server, store) => registerTestController(server, store));
    const result = await call(client, armArgs({ adcp_version: '3.2' }));
    const sc = result.structuredContent;
    assert.equal(result.isError, true, JSON.stringify(sc));
    assert.equal(sc.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.equal(sc.status, 'failed');
    assert.equal(sc.adcp_version, '3.2');
    assert.equal('success' in sc, false);
    assert.deepEqual(sc.context, CTX);
  });
});

describe('comply_test_controller served release — cached store bodies', () => {
  it('does not stamp adcp_version onto the store-owned object', async () => {
    const cached = { status: 'completed', success: true, forced: { arm: 'submitted', task_id: 't' } };
    const snapshot = JSON.parse(JSON.stringify(cached));
    const server = adcpServer();
    registerTestController(server, { forceCreateMediaBuyArm: async () => cached });
    const client = await connect(server);

    const first = (await call(client, armArgs({ adcp_version: '3.3-rc.3' }))).structuredContent;
    assert.equal(first.adcp_version, '3.3-rc.3');
    const second = (await call(client, armArgs({ adcp_version: '3.2' }))).structuredContent;
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(second.adcp_version, '3.2');
    assert.deepEqual(cached, snapshot, 'the cached object must not gain adcp_version');
    assert.equal('adcp_version' in cached, false);
  });
});

describe('comply_test_controller served release — platform sandbox denial', () => {
  // The legacy env bridge admits every target and fails closed once a live
  // account has resolved, so this suite runs on resolved account modes only.
  before(() => {
    delete process.env.ADCP_SANDBOX;
    __resetObservedAccountModes();
  });
  after(() => {
    process.env.ADCP_SANDBOX = '1';
    __resetObservedAccountModes();
  });

  async function denialClient() {
    const force = makeForce();
    const platform = {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
        compliance_testing: {},
      },
      statusMappers: {},
      accounts: {
        // The principal (no ref) is a visible sandbox account; the target it
        // names does not exist, so the controller refuses it.
        resolve: async ref => {
          if (ref === undefined) {
            return { id: 'principal_sb', mode: 'sandbox', ctx_metadata: {}, authInfo: { kind: 'api_key' } };
          }
          return { id: 'live_target', mode: 'live', ctx_metadata: {}, authInfo: { kind: 'api_key' } };
        },
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({
          currency: 'USD',
          reporting_period: { start: '2026-04-01', end: '2026-04-30' },
          media_buy_deliveries: [],
        }),
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'denial',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
      capabilities: { supported_versions: SERVED },
      complyTest: { force },
    });
    return { client: await connect(server), force };
  }

  for (const pin of ['3.2', '3.3-rc.3']) {
    it(`PERMISSION_DENIED is finished at the ${pin} pin, with context and ext echoed`, async () => {
      const { client, force } = await denialClient();
      const ext = { trace: 'x-3769' };
      const result = await call(client, armArgs({ account: { account_id: 'live_target' }, adcp_version: pin, ext }));
      const sc = result.structuredContent;
      assert.equal(result.isError, true, JSON.stringify(sc));
      assert.equal(sc.adcp_error.code, 'PERMISSION_DENIED');
      assert.equal(sc.status, 'failed');
      assert.equal(sc.adcp_version, pin);
      assert.deepEqual(sc.context, CTX);
      assert.deepEqual(sc.ext, ext);
      assert.equal(force.calls.length, 0);
    });
  }
});

describe('comply_test_controller served release — string adcp_major_version', () => {
  it('is accepted by registerTestController', async () => {
    const force = makeForce();
    const server = adcpServer();
    registerTestController(server, makeStore(force));
    const client = await connect(server);
    const result = await call(client, armArgs({ adcp_major_version: '3' }));
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.success, true);
    assert.equal(force.calls.length, 1);
  });

  it('is accepted on a raw McpServer', async () => {
    const force = makeForce();
    const bare = new McpServer({ name: 'bare', version: '1.0.0' });
    createComplyController({ sandboxGate: () => true, force }).register(bare);
    const client = await connect(bare);
    const result = await call(client, armArgs({ adcp_major_version: '3' }));
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.success, true);
  });
});
