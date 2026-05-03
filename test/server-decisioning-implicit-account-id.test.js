// Tests for #1364 — framework refusal of inline account_id references
// against `accounts.resolution: 'implicit'` platforms. Documented behavior
// at AccountStore.resolution; previously aspirational (docstring claim
// without enforcement).
//
// Also covers #1469 — same refusal extended to `accounts.resolution: 'derived'`
// (single-tenant agents). Both modes share the enforcement; messages differ.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function buildImplicitPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolution: 'implicit',
      resolve: async () => ({
        id: 'acc_from_principal',
        name: 'Acme',
        status: 'active',
        ctx_metadata: {},
        authInfo: { kind: 'oauth', principal: 'p1' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({
        products: [
          {
            product_id: 'p1',
            name: 'sample',
            description: 'fixture',
            format_ids: [{ id: 'standard', agent_url: 'https://example.com/mcp' }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 5.0, currency: 'USD' }],
          },
        ],
      }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

const SERVER_OPTS = {
  name: 'implicit-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

describe("#1364 — accounts.resolution: 'implicit' refuses inline account_id", () => {
  it('rejects { account_id } reference with INVALID_REQUEST and field=account.account_id', async () => {
    let resolveCalled = false;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => {
          resolveCalled = true;
          return null;
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'snap_act_123' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
    assert.match(result.structuredContent.adcp_error.message, /sync_accounts/);
    assert.strictEqual(resolveCalled, false, 'resolve must not be invoked when implicit-mode rejects upfront');
  });

  it('permits the brand+operator union arm — only account_id is refused', async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'acc_from_brand_lookup',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' });
  });

  it("'explicit' resolution (default) accepts inline account_id — no enforcement leaks across modes", async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'explicit',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: ref?.account_id ?? 'acc_default',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'acc_explicit' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { account_id: 'acc_explicit' });
  });

  it('omitted resolution (defaults to explicit) accepts inline account_id', async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        // resolution omitted — framework defaults to 'explicit'
        resolve: async ref => {
          sawRef = ref;
          return {
            id: ref?.account_id ?? 'acc_default',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'acc_explicit_default' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { account_id: 'acc_explicit_default' });
  });

  it('implicit + omitted account flows to auth-derived resolution (no enforcement, no rejection)', async () => {
    // Implicit-mode tools where the request omits `account` entirely should
    // route through the auth-derived path. The framework calls
    // `accounts.resolve(undefined, ctx)`; the platform looks up by
    // `ctx.authInfo.principal` (or whichever field). No INVALID_REQUEST here.
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'acc_from_principal',
            name: 'Acme',
            status: 'active',
            ctx_metadata: {},
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          // no `account` field — auth-derived path
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawRef, undefined, 'auth-derived path passes undefined ref');
  });

  it('tasks_get rejects { account_id } with INVALID_REQUEST on implicit platforms', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => null,
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'tasks_get',
        arguments: {
          task_id: 'task_does_not_matter',
          account: { account_id: 'snap_act_123' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });

  it('get_account_financials rejects { account_id } with INVALID_REQUEST on implicit platforms', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => null,
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
        getAccountFinancials: async () => ({
          financials: { spend: { amount: 0, currency: 'USD' } },
        }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_account_financials',
        arguments: {
          account: { account_id: 'snap_act_123' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });
});

function buildDerivedPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({
        id: 'acc_singleton',
        name: 'SingleTenant',
        status: 'active',
        ctx_metadata: {},
        authInfo: { kind: 'oauth', principal: 'p1' },
      }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({
        products: [
          {
            product_id: 'p1',
            name: 'sample',
            description: 'fixture',
            format_ids: [{ id: 'standard', agent_url: 'https://example.com/mcp' }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 5.0, currency: 'USD' }],
          },
        ],
      }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

describe("#1469 — accounts.resolution: 'derived' refuses inline account_id", () => {
  it('rejects { account_id } reference with INVALID_REQUEST and field=account.account_id', async () => {
    let resolveCalled = false;
    const platform = buildDerivedPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => {
          resolveCalled = true;
          return null;
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'acc_foo' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
    assert.ok(
      !result.structuredContent.adcp_error.message.includes('sync_accounts'),
      'derived-mode message must not mention sync_accounts'
    );
    assert.match(result.structuredContent.adcp_error.message, /single-tenant/i);
    assert.strictEqual(resolveCalled, false, 'resolve must not be invoked when derived-mode rejects upfront');
  });

  it('permits the brand+operator union arm — only account_id is refused', async () => {
    let sawRef;
    const platform = buildDerivedPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'acc_singleton',
            name: 'SingleTenant',
            status: 'active',
            ctx_metadata: {},
          };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawRef, { brand: { domain: 'acme.com' }, operator: 'pinnacle.com' });
  });

  it('derived + omitted account flows through to resolve (no rejection)', async () => {
    let resolveCalled = false;
    const platform = buildDerivedPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => {
          resolveCalled = true;
          return {
            id: 'acc_singleton',
            name: 'SingleTenant',
            status: 'active',
            ctx_metadata: {},
          };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          // no account field — auth-derived path
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(resolveCalled, true, 'resolve must be called for the omitted-account path');
  });

  it('tasks_get rejects { account_id } with INVALID_REQUEST on derived platforms', async () => {
    const platform = buildDerivedPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => null,
      },
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'tasks_get',
        arguments: {
          task_id: 'task_does_not_matter',
          account: { account_id: 'acc_foo' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });

  it("error message for 'derived' is distinct from 'implicit' — no sync_accounts guidance", async () => {
    const derived = buildDerivedPlatform({
      accounts: { resolution: 'derived', resolve: async () => null },
    });
    const dServer = createAdcpServerFromPlatform(derived, SERVER_OPTS);
    const dResult = await dServer.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: { brief: 'x', account: { account_id: 'foo' } },
      },
    });
    const implicit = buildImplicitPlatform({
      accounts: {
        resolution: 'implicit',
        resolve: async () => null,
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const iServer = createAdcpServerFromPlatform(implicit, SERVER_OPTS);
    const iResult = await iServer.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: { brief: 'x', account: { account_id: 'foo' } },
      },
    });
    assert.notStrictEqual(
      dResult.structuredContent.adcp_error.message,
      iResult.structuredContent.adcp_error.message,
      'derived and implicit modes must emit distinct error messages'
    );
    assert.ok(
      !dResult.structuredContent.adcp_error.suggestion.includes('sync_accounts'),
      'derived suggestion must not reference sync_accounts'
    );
  });
});
