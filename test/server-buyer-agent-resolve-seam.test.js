'use strict';

// Stage 2 of #1269 — buyer-agent registry resolve seam.
//
// These tests exercise the dispatcher's seam end-to-end via
// `createAdcpServerFromPlatform`. The factory routing tests live in
// `test/lib/buyer-agent-registry.test.js` (Stage 1); this file asserts the
// seam wires correctly into the v6 platform shim.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function buildPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async (ref, ctx) => ({
        id: ref?.account_id ?? 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
        // Stash the resolve-time `agent` so tests can assert threading.
        _resolveAgent: ctx?.agent,
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async (_req, ctx) => ({
        products: [
          {
            product_id: 'p1',
            name: 'sample',
            description: '',
            format_ids: [{ id: 'standard', agent_url: 'https://example.com/mcp' }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 1, currency: 'USD' }],
          },
        ],
        // Echo the agent on the response (under products[0]) so assertions can
        // inspect what the handler saw via RequestContext.
        _ctxAgent: ctx?.agent,
        _accountResolveAgent: ctx?.account?._resolveAgent,
      }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

const sampleAgent = () => ({
  agent_url: 'https://agent.scope3.com',
  display_name: 'Scope3',
  status: 'active',
  billing_capabilities: new Set(['operator', 'agent']),
  default_account_terms: { rate_card: 'rc_premium' },
});

const dispatch = server =>
  server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'get_products',
      arguments: {
        brief: 'premium',
        promoted_offering: 'cars',
        account: { account_id: 'acc_test' },
      },
    },
  });

describe('buyer-agent registry resolve seam — Stage 2 of #1269', () => {
  it('no agentRegistry configured → ctx.agent undefined; existing behavior unchanged', async () => {
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server);
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent._ctxAgent, undefined, 'handler must see ctx.agent === undefined');
    assert.strictEqual(
      result.structuredContent._accountResolveAgent,
      undefined,
      'accounts.resolve must see ctx.agent === undefined'
    );
  });

  it('agentRegistry returning a BuyerAgent populates ctx.agent and threads it to accounts.resolve and the handler', async () => {
    const agent = sampleAgent();
    const platform = buildPlatform({
      agentRegistry: {
        async resolve() {
          return agent;
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server);
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(result.structuredContent._ctxAgent, 'handler must see ctx.agent populated');
    assert.strictEqual(result.structuredContent._ctxAgent.agent_url, 'https://agent.scope3.com');
    assert.ok(result.structuredContent._accountResolveAgent, 'accounts.resolve must see ctx.agent');
    assert.strictEqual(result.structuredContent._accountResolveAgent.agent_url, 'https://agent.scope3.com');
  });

  it('framework freezes resolved BuyerAgent and its billing_capabilities Set', async () => {
    const agent = sampleAgent();
    const platform = buildPlatform({
      agentRegistry: {
        async resolve() {
          return agent;
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await dispatch(server);
    assert.equal(Object.isFrozen(agent), true, 'resolved BuyerAgent must be frozen');
    // Object.freeze locks the Set's own enumerable properties but does NOT
    // protect the internal [[SetData]] slot — `.add()` / `.delete()` /
    // `.clear()` still mutate. `ReadonlySet` is a TypeScript-only contract.
    // We freeze the Set for completeness (Object.isFrozen → true) but
    // adopters must not rely on `.add()` throwing at runtime.
    assert.equal(Object.isFrozen(agent.billing_capabilities), true);
    // Property assignment on the frozen agent is a no-op; the value stays.
    try {
      agent.status = 'blocked';
    } catch {
      /* expected in strict mode */
    }
    assert.equal(agent.status, 'active', 'frozen agent property must not change');
  });

  it('agentRegistry returning null → ctx.agent stays undefined; dispatch continues', async () => {
    const platform = buildPlatform({
      agentRegistry: {
        async resolve() {
          return null;
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server);
    // Phase 1: framework does NOT reject on null. Stage 4 / Phase 2 add
    // the gate; Stage 2 just keeps dispatch flowing.
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent._ctxAgent, undefined);
  });

  it('agentRegistry throwing → SERVICE_UNAVAILABLE; handler not invoked', async () => {
    let handlerInvoked = false;
    const platform = buildPlatform({
      agentRegistry: {
        async resolve() {
          throw new Error('upstream identity-provider 5xx');
        },
      },
      sales: {
        getProducts: async () => {
          handlerInvoked = true;
          return { products: [] };
        },
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(handlerInvoked, false, 'handler must NOT run when registry throws');
  });

  it('resolveSessionKey sees ctx.agent', async () => {
    let sessionKeyAgent;
    const platform = buildPlatform({
      agentRegistry: {
        async resolve() {
          return sampleAgent();
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      resolveSessionKey: async ctx => {
        sessionKeyAgent = ctx.agent;
        return 'session-key';
      },
    });
    await dispatch(server);
    assert.ok(sessionKeyAgent, 'resolveSessionKey must see ctx.agent');
    assert.equal(sessionKeyAgent.agent_url, 'https://agent.scope3.com');
  });
});
