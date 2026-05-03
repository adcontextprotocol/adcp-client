// Tests for #1364 — framework refusal of inline account_id references
// against `accounts.resolution: 'implicit'` platforms. Documented behavior
// at AccountStore.resolution; previously aspirational (docstring claim
// without enforcement).

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

describe("#1468 — accounts.resolution: 'derived' refuses inline account_id (mirrors #1364)", () => {
  it('rejects { account_id } reference with INVALID_REQUEST and field=account.account_id', async () => {
    let resolveCalled = false;
    const platform = buildImplicitPlatform({
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
          account: { account_id: 'audiostack_singleton' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
    assert.strictEqual(resolveCalled, false, 'resolve must not be invoked when derived-mode rejects upfront');
  });

  it('derived-mode error message names single-tenant / derived (not sync_accounts, which does not exist in derived mode)', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'singleton', name: 'Singleton', status: 'active', ctx_metadata: {} }),
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
          account: { account_id: 'foo' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(
      result.structuredContent.adcp_error.message,
      /single-tenant|derived/i,
      'derived-mode message should explain single-tenant semantics, not point at sync_accounts'
    );
    assert.doesNotMatch(
      result.structuredContent.adcp_error.message,
      /sync_accounts/,
      'derived-mode message must not suggest sync_accounts (no such step in derived mode)'
    );
  });

  it('derived + omitted account flows to auth-derived resolution (no enforcement, no rejection)', async () => {
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'singleton',
            name: 'Singleton',
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
          // no `account` field — auth-derived path
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(sawRef, undefined, 'auth-derived path passes undefined ref');
  });

  it('tasks_get rejects { account_id } with INVALID_REQUEST on derived platforms', async () => {
    const platform = buildImplicitPlatform({
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
          account: { account_id: 'audiostack_singleton' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });

  it('get_account_financials rejects { account_id } with INVALID_REQUEST on derived platforms', async () => {
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => null,
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
          account: { account_id: 'audiostack_singleton' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'account.account_id');
  });

  it('derived-mode permits brand+operator union arm (no account_id present)', async () => {
    // Brand+operator refs are not refused by the framework regardless of
    // resolution mode — only the `{ account_id }` arm is refused. Adopters
    // who want to additionally reject brand-arm refs do so in their resolver.
    let sawRef;
    const platform = buildImplicitPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref => {
          sawRef = ref;
          return {
            id: 'singleton',
            name: 'Singleton',
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
});
