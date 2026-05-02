'use strict';

// Issue #1310 — `AccountStore.upsert` and `AccountStore.list` accept
// (and the framework forwards) the same `ResolveContext` shape that
// `accounts.resolve` already gets. Adopters implementing principal-based
// gates on `sync_accounts` / `list_accounts` (e.g. the spec's
// `BILLING_NOT_PERMITTED_FOR_AGENT` per-buyer-agent gate from
// adcontextprotocol/adcp#3851) need the calling principal — same plumbing
// already wired for `resolve`, `reportUsage`, `getAccountFinancials`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

const sampleAgent = () => ({
  agent_url: 'https://agent.scope3.com',
  display_name: 'Scope3',
  status: 'active',
  billing_capabilities: new Set(['operator']),
});

function buildPlatform(captures, overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
      upsert: async (refs, ctx) => {
        captures.upsertCtx = ctx;
        return refs.map(r => ({
          brand: r.brand ?? { domain: 'acme.com' },
          operator: r.operator ?? 'acme.com',
          action: 'created',
          status: 'active',
        }));
      },
      list: async (filter, ctx) => {
        captures.listCtx = ctx;
        captures.listFilter = filter;
        return { items: [], nextCursor: null };
      },
      reportUsage: async (req, ctx) => {
        captures.reportUsageCtx = ctx;
        return { accepted: [], rejected: [] };
      },
      getAccountFinancials: async (req, ctx) => {
        captures.getAccountFinancialsCtx = ctx;
        return { account_id: ctx?.account?.id ?? 'acc_1', currency: 'USD' };
      },
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

const dispatchSync = (server, authInfo) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          accounts: [{ brand: { domain: 'acme.com' }, operator: 'acme.com' }],
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    },
    authInfo ? { authInfo } : undefined
  );

const dispatchList = (server, authInfo) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    },
    authInfo ? { authInfo } : undefined
  );

describe('Issue #1310 — accounts.upsert receives ResolveContext', () => {
  it('forwards authInfo from request ctx to accounts.upsert', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(buildPlatform(captures), {
      name: 'gap-1310',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const authInfo = { kind: 'api_key', clientId: 'buyer-xyz' };
    const result = await dispatchSync(server, authInfo);
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(captures.upsertCtx, 'upsert MUST receive a non-null ctx');
    assert.deepStrictEqual(captures.upsertCtx.authInfo, authInfo, 'upsert ctx.authInfo must match request authInfo');
    assert.strictEqual(captures.upsertCtx.toolName, 'sync_accounts', 'toolName must be set');
  });

  it('forwards resolved BuyerAgent to accounts.upsert when agentRegistry is configured', async () => {
    const captures = {};
    const agent = sampleAgent();
    const server = createAdcpServerFromPlatform(
      buildPlatform(captures, {
        agentRegistry: {
          async resolve() {
            return agent;
          },
        },
      }),
      {
        name: 'gap-1310',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const result = await dispatchSync(server, { kind: 'api_key', clientId: 'buyer-xyz' });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(captures.upsertCtx?.agent, 'upsert MUST receive ctx.agent when agentRegistry is configured');
    assert.strictEqual(captures.upsertCtx.agent.agent_url, 'https://agent.scope3.com');
  });

  it('upsert ctx.authInfo is undefined when no authentication is wired', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(buildPlatform(captures), {
      name: 'gap-1310',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchSync(server);
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(captures.upsertCtx, 'upsert MUST receive a ctx object even when authInfo is absent');
    assert.strictEqual(captures.upsertCtx.authInfo, undefined);
    assert.strictEqual(captures.upsertCtx.toolName, 'sync_accounts');
  });
});

describe('Issue #1310 — accounts.list receives ResolveContext', () => {
  it('forwards authInfo from request ctx to accounts.list', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(buildPlatform(captures), {
      name: 'gap-1310',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const authInfo = { kind: 'oauth', clientId: 'buyer-xyz' };
    const result = await dispatchList(server, authInfo);
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(captures.listCtx, 'list MUST receive a non-null ctx');
    assert.deepStrictEqual(captures.listCtx.authInfo, authInfo);
    assert.strictEqual(captures.listCtx.toolName, 'list_accounts');
  });

  it('forwards resolved BuyerAgent to accounts.list when agentRegistry is configured', async () => {
    const captures = {};
    const agent = sampleAgent();
    const server = createAdcpServerFromPlatform(
      buildPlatform(captures, {
        agentRegistry: {
          async resolve() {
            return agent;
          },
        },
      }),
      {
        name: 'gap-1310',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const result = await dispatchList(server, { kind: 'api_key', clientId: 'buyer-xyz' });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(captures.listCtx?.agent, 'list MUST receive ctx.agent when agentRegistry is configured');
    assert.strictEqual(captures.listCtx.agent.agent_url, 'https://agent.scope3.com');
  });

  it('list filter is still passed as the first arg', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(buildPlatform(captures), {
      name: 'gap-1310',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await dispatchList(server);
    assert.ok(captures.listFilter, 'first arg must be the filter, ctx must come second');
  });
});

// Symmetric follow-up: `reportUsage` and `getAccountFinancials` already
// received `authInfo` and `toolName`, but the framework was not forwarding
// `agent` (the resolved BuyerAgent record). Fixed by routing all four
// AccountStore handlers through a single `toResolveCtx` helper, so any
// future addition to `ResolveContext` lands on every method automatically.

const dispatchReportUsage = (server, authInfo) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'report_usage',
        arguments: {
          usage: [
            {
              account: { account_id: 'acc_1' },
              period_start: '2026-05-01T00:00:00Z',
              period_end: '2026-05-02T00:00:00Z',
              line_item_id: 'li_1',
              impressions: 1000,
            },
          ],
          idempotency_key: '22222222-2222-2222-2222-222222222222',
        },
      },
    },
    authInfo ? { authInfo } : undefined
  );

const dispatchGetAccountFinancials = (server, authInfo) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_account_financials',
        arguments: { account: { account_id: 'acc_1' } },
      },
    },
    authInfo ? { authInfo } : undefined
  );

describe('Symmetric follow-up — reportUsage receives ctx.agent', () => {
  it('forwards resolved BuyerAgent to accounts.reportUsage when agentRegistry is configured', async () => {
    const captures = {};
    const agent = sampleAgent();
    const server = createAdcpServerFromPlatform(
      buildPlatform(captures, {
        agentRegistry: {
          async resolve() {
            return agent;
          },
        },
      }),
      {
        name: 'symmetric',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const result = await dispatchReportUsage(server, { kind: 'api_key', clientId: 'buyer-xyz' });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(captures.reportUsageCtx?.agent, 'reportUsage MUST receive ctx.agent when agentRegistry is configured');
    assert.strictEqual(captures.reportUsageCtx.agent.agent_url, 'https://agent.scope3.com');
    assert.strictEqual(captures.reportUsageCtx.toolName, 'report_usage');
  });
});

describe('Symmetric follow-up — getAccountFinancials receives ctx.agent', () => {
  it('forwards resolved BuyerAgent to accounts.getAccountFinancials when agentRegistry is configured', async () => {
    const captures = {};
    const agent = sampleAgent();
    const server = createAdcpServerFromPlatform(
      buildPlatform(captures, {
        agentRegistry: {
          async resolve() {
            return agent;
          },
        },
      }),
      {
        name: 'symmetric',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const result = await dispatchGetAccountFinancials(server, { kind: 'api_key', clientId: 'buyer-xyz' });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(
      captures.getAccountFinancialsCtx?.agent,
      'getAccountFinancials MUST receive ctx.agent when agentRegistry is configured'
    );
    assert.strictEqual(captures.getAccountFinancialsCtx.agent.agent_url, 'https://agent.scope3.com');
    assert.strictEqual(captures.getAccountFinancialsCtx.toolName, 'get_account_financials');
    assert.ok(captures.getAccountFinancialsCtx.account, 'AccountToolContext keeps `account` populated');
  });
});
