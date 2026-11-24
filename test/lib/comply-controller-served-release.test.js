/**
 * adcp-client#3769: `comply_test_controller` registers after `createAdcpServer`
 * returns, outside the spec-tool dispatcher. It must still answer at the
 * caller's served AdCP release (DR-0024): a 3.2 pin gets no 3.3-only fields
 * (`forced.proposal_id`), an unservable pin is refused with
 * `VERSION_UNSUPPORTED` before the controller runs, and `adcp_version` is
 * echoed. A raw SDK `McpServer` (no `createAdcpServer`) is unchanged.
 */

process.env.NODE_ENV = 'test';
process.env.ADCP_SANDBOX = '1'; // legacy conformance visibility bridge for complyTest

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { getSdkServer } = require('../../dist/lib/server/adcp-server');
const { registerTestController } = require('../../dist/lib/server/test-controller');
const { createComplyController } = require('../../dist/lib/testing/comply-controller');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform');
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

/** A force handler that records calls and returns a 3.3-shaped `forced` payload. */
function makeForce() {
  const calls = [];
  return {
    calls,
    create_media_buy_arm: params => {
      calls.push(params);
      return {
        success: true,
        forced: { arm: params.arm, task_id: params.task_id, proposal_id: 'prop_1' },
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
      assert.equal('proposal_id' in sc.forced, false, 'proposal_id is 3.3-only');
      assert.deepEqual(sc.context, CTX);
      const outcome = validateResponse('comply_test_controller', sc, '3.2');
      assert.equal(outcome.valid, true, JSON.stringify(outcome.issues ?? outcome));
    });

    it('a 3.3 caller keeps the 3.3 fields', async () => {
      const { client } = await setup();
      const sc = (await call(client, armArgs({ adcp_version: '3.3-rc.3' }))).structuredContent;
      assert.equal(sc.success, true, JSON.stringify(sc));
      assert.equal(sc.forced.proposal_id, 'prop_1');
      assert.equal(sc.adcp_version, '3.3-rc.3');
      assert.deepEqual(sc.context, CTX);
    });

    it('a call with no pin is served at the default release', async () => {
      const { client } = await setup();
      const sc = (await call(client, armArgs())).structuredContent;
      assert.equal(sc.success, true, JSON.stringify(sc));
      assert.equal(typeof sc.adcp_version, 'string');
      assert.ok(SERVED.includes(sc.adcp_version), `unexpected default release ${sc.adcp_version}`);
      if (sc.adcp_version === '3.2') assert.equal('proposal_id' in sc.forced, false);
      else assert.equal(sc.forced.proposal_id, 'prop_1');
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
    assert.equal(sc.forced.proposal_id, 'prop_1');
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
