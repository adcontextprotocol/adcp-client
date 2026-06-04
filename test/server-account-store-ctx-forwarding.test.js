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

const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
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

const dispatchSyncCreatives = (server, args, authInfo) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: { name: 'sync_creatives', arguments: args },
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

  it('list_accounts surfaces advertiser and publisher-identity authorization side by side', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(
      buildPlatform(captures, {
        accounts: {
          resolve: async ref => ({
            id: ref?.account_id ?? 'tiktok_ads_123',
            name: 'TikTok Ads Account',
            status: 'active',
            ctx_metadata: {},
            authInfo: { kind: 'oauth' },
          }),
          list: async (_filter, ctx) => {
            captures.listCtx = ctx;
            return {
              items: [
                {
                  id: 'tiktok_ads_123',
                  name: 'Acme TikTok Ads',
                  status: 'active',
                  account_scope: 'brand',
                  brand: { domain: 'acme.example' },
                  operator: 'acme.example',
                  authorization: {
                    allowed_tasks: ['list_accounts', 'get_products', 'create_media_buy', 'sync_creatives'],
                    scope_name: 'custom:tiktok_ads_manager',
                  },
                  ctx_metadata: {},
                  authInfo: { kind: 'oauth' },
                },
                {
                  id: 'tiktok_creator_456',
                  name: '@acme TikTok Creator Identity',
                  status: 'active',
                  account_scope: 'brand',
                  brand: { domain: 'acme.example' },
                  operator: 'acme.example',
                  authorization: {
                    allowed_tasks: ['list_accounts', 'sync_creatives'],
                    field_scopes: {
                      sync_creatives: ['account', 'creatives', 'idempotency_key'],
                    },
                    scope_name: 'custom:tiktok_publisher_identity',
                    read_only: false,
                  },
                  ctx_metadata: {
                    provider: 'tiktok',
                    connection_type: 'publisher_identity',
                    identity_id: 'creator_456',
                  },
                  authInfo: { kind: 'oauth' },
                },
              ],
              nextCursor: null,
            };
          },
        },
      }),
      {
        name: 'tiktok-account-authz',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );

    const result = await dispatchList(server, { kind: 'oauth', clientId: 'buyer-agent' });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);

    const accounts = result.structuredContent.accounts;
    assert.equal(accounts.length, 2);
    assert.deepEqual(
      accounts.map(a => a.account_id),
      ['tiktok_ads_123', 'tiktok_creator_456']
    );
    assert.equal(accounts[0].authorization.scope_name, 'custom:tiktok_ads_manager');
    assert.deepEqual(accounts[0].authorization.allowed_tasks, [
      'list_accounts',
      'get_products',
      'create_media_buy',
      'sync_creatives',
    ]);
    assert.equal(accounts[1].authorization.scope_name, 'custom:tiktok_publisher_identity');
    assert.deepEqual(accounts[1].authorization.allowed_tasks, ['list_accounts', 'sync_creatives']);
    assert.deepEqual(accounts[1].authorization.field_scopes.sync_creatives, [
      'account',
      'creatives',
      'idempotency_key',
    ]);
    assert.equal('ctx_metadata' in accounts[1], false, 'adapter metadata must not leak on list_accounts');
    assert.equal(captures.listCtx.authInfo.clientId, 'buyer-agent');
  });

  it('sync_creatives reports missing publisher identity authorization as AUTHORIZATION_REQUIRED', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(
      buildPlatform(captures, {
        accounts: {
          resolve: async ref => ({
            id: ref?.account_id ?? 'tiktok_ads_123',
            name: 'Acme TikTok Ads',
            status: 'active',
            ctx_metadata: {},
            authInfo: { kind: 'oauth' },
          }),
          list: async () => ({ items: [], nextCursor: null }),
        },
        sales: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
          updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
          syncCreatives: async () => {
            throw new AdcpError('AUTHORIZATION_REQUIRED', {
              message: 'Connect the TikTok creator identity before boosting this post.',
              field: 'creatives[0].assets[0].url',
              details: {
                missing_connections: [
                  {
                    provider: 'tiktok',
                    connection_type: 'publisher_identity',
                    required_for: ['sync_creatives'],
                    scope: 'identity',
                    status: 'missing',
                    resource_ref: {
                      identity_id: 'creator_456',
                      handle: '@acme',
                      post_url: 'https://www.tiktok.com/@acme/video/123',
                    },
                    authorization_url: 'https://seller.example/connections/tiktok/creator_456',
                    authorization_instructions: 'Connect @acme in TikTok Business Center, then retry.',
                  },
                ],
              },
            });
          },
          getMediaBuyDelivery: async () => ({ media_buys: [] }),
        },
      }),
      {
        name: 'tiktok-publisher-authz',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );

    const result = await dispatchSyncCreatives(
      server,
      {
        account: { account_id: 'tiktok_ads_123' },
        idempotency_key: '33333333-3333-3333-3333-333333333333',
        creatives: [
          {
            creative_id: 'cr_boost_1',
            assets: [{ asset_type: 'url', url: 'https://www.tiktok.com/@acme/video/123' }],
          },
        ],
      },
      { kind: 'oauth', clientId: 'buyer-agent' }
    );

    assert.equal(result.isError, true);
    const error = result.structuredContent.adcp_error;
    assert.equal(error.code, 'AUTHORIZATION_REQUIRED');
    assert.equal(error.recovery, 'correctable');
    assert.equal(error.field, 'creatives[0].assets[0].url');
    assert.equal(error.details.missing_connections[0].provider, 'tiktok');
    assert.equal(error.details.missing_connections[0].connection_type, 'publisher_identity');
    assert.equal(error.details.missing_connections[0].status, 'missing');
    assert.equal(error.details.missing_connections[0].resource_ref.identity_id, 'creator_456');
    assert.equal(error.details.missing_connections[0].authorization_url, 'https://seller.example/connections/tiktok/creator_456');
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
