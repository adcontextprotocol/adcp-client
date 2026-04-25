// Smoke tests for `createAdcpServerFromPlatform` — the v6.0 alpha runtime
// entry point that accepts a DecisioningPlatform and dispatches via the
// existing framework. Only `getProducts` is wired in this commit; the
// other specialism methods land in subsequent commits.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { PlatformConfigError, validatePlatform } = require('../dist/lib/server/decisioning/runtime/validate-platform');
const { AccountNotFoundError } = require('../dist/lib/server/decisioning/account');

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
      resolve: async ref => ({
        id: ref?.account_id ?? 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
      upsert: async () => ({ kind: 'sync', result: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async req => ({
        products: [
          {
            product_id: 'p1',
            name: 'sample',
            description: 'spike test',
            format_ids: [{ id: 'standard', agent_url: 'https://example.com/mcp' }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo'] },
            pricing_options: [
              {
                pricing_model: 'cpm',
                rate: 5.0,
                currency: 'USD',
              },
            ],
          },
        ],
      }),
      createMediaBuy: async () => {
        throw new Error('not used in this test');
      },
      updateMediaBuy: async () => {
        throw new Error('not used in this test');
      },
      syncCreatives: async () => {
        throw new Error('not used in this test');
      },
      getMediaBuyDelivery: async () => {
        throw new Error('not used in this test');
      },
    },
    ...overrides,
  };
}

describe('createAdcpServerFromPlatform — v6.0 alpha', () => {
  it('builds an AdcpServer from a DecisioningPlatform', () => {
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(typeof server.connect, 'function');
    assert.strictEqual(typeof server.dispatchTestRequest, 'function');
  });

  it('dispatches get_products through the platform.sales method', async () => {
    let sawCtx;
    const platform = buildPlatform({
      sales: {
        getProducts: async (req, ctx) => {
          sawCtx = ctx;
          return {
            products: [
              {
                product_id: 'p_dispatched',
                name: 'dispatched',
                description: '',
                format_ids: [{ id: 'standard', agent_url: 'https://example.com/mcp' }],
                delivery_type: 'non_guaranteed',
                publisher_properties: { reportable: true },
                reporting_capabilities: { available_dimensions: ['geo'] },
                pricing_options: [{ pricing_model: 'cpm', rate: 1, currency: 'USD' }],
              },
            ],
          };
        },
        createMediaBuy: async () => ({}),
        updateMediaBuy: async () => ({}),
        syncCreatives: async () => ({}),
        getMediaBuyDelivery: async () => ({}),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
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
    assert.ok(result.structuredContent, 'response should carry structuredContent');
    assert.notStrictEqual(result.isError, true, `expected success but got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent.products[0].product_id, 'p_dispatched');
    assert.ok(sawCtx, 'sales.getProducts should receive a RequestContext');
    assert.ok(sawCtx.account, 'ctx.account should be populated from accounts.resolve');
    assert.strictEqual(typeof sawCtx.state.workflowSteps, 'function');
    assert.strictEqual(typeof sawCtx.resolve.creativeFormat, 'function');
  });

  it('catches AccountNotFoundError from accounts.resolve and returns ACCOUNT_NOT_FOUND envelope', async () => {
    const platform = buildPlatform({
      accounts: {
        resolve: async () => {
          throw new AccountNotFoundError();
        },
        upsert: async () => ({ kind: 'sync', result: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'unknown' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
  });
});

describe('SalesPlatform — full surface dispatch', () => {
  function buildSalesPlatform(salesOverrides) {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
        upsert: async () => ({ kind: 'sync', result: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ kind: 'sync', result: { media_buy_id: 'mb_1' } }),
        updateMediaBuy: async () => ({ kind: 'sync', result: { media_buy_id: 'mb_1' } }),
        syncCreatives: async () => ({ kind: 'sync', result: [] }),
        getMediaBuyDelivery: async () => ({ kind: 'sync', result: { media_buys: [] } }),
        ...salesOverrides,
      },
    };
  }

  function buildServer(platform) {
    return createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
  }

  it('createMediaBuy sync arm projects to wire success', async () => {
    const platform = buildSalesPlatform({
      createMediaBuy: async () => ({
        kind: 'sync',
        result: {
          media_buy_id: 'mb_42',
          status: 'pending_creatives',
          packages: [],
        },
      }),
    });
    const server = buildServer(platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_42');
  });

  it('createMediaBuy submitted arm projects to wire submitted envelope', async () => {
    const platform = buildSalesPlatform({
      createMediaBuy: async () => ({
        kind: 'submitted',
        taskHandle: { taskId: 'task_pending_approval', notify: () => {} },
        message: 'Awaiting trafficker approval',
      }),
    });
    const server = buildServer(platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.strictEqual(result.structuredContent.task_id, 'task_pending_approval');
    assert.strictEqual(result.structuredContent.message, 'Awaiting trafficker approval');
  });

  it('createMediaBuy rejected arm projects to ADCP_ERROR envelope', async () => {
    const platform = buildSalesPlatform({
      createMediaBuy: async () => ({
        kind: 'rejected',
        error: { code: 'BUDGET_TOO_LOW', recovery: 'correctable', message: 'floor is $5 CPM' },
      }),
    });
    const server = buildServer(platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'BUDGET_TOO_LOW');
    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'correctable');
  });

  it('updateMediaBuy submitted arm yields INVALID_STATE (no wire submitted arm)', async () => {
    const platform = buildSalesPlatform({
      updateMediaBuy: async () => ({
        kind: 'submitted',
        taskHandle: { taskId: 'task_reapproval', notify: () => {} },
      }),
    });
    const server = buildServer(platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_STATE');
    assert.strictEqual(result.structuredContent.adcp_error.details.task_id, 'task_reapproval');
  });

  it('syncCreatives submitted arm projects to wire submitted envelope', async () => {
    const platform = buildSalesPlatform({
      syncCreatives: async () => ({
        kind: 'submitted',
        taskHandle: { taskId: 'task_creative_review', notify: () => {} },
        message: '4-72h manual review queued',
      }),
    });
    const server = buildServer(platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          creatives: [],
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.strictEqual(result.structuredContent.task_id, 'task_creative_review');
  });
});

describe('Task registry — ctx.startTask + handle.notify lifecycle', () => {
  function buildPlatformWithTask(handlerImpl) {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
        upsert: async () => ({ kind: 'sync', result: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: handlerImpl,
        updateMediaBuy: async () => ({ kind: 'sync', result: { media_buy_id: 'mb_1' } }),
        syncCreatives: async () => ({ kind: 'sync', result: [] }),
        getMediaBuyDelivery: async () => ({ kind: 'sync', result: { media_buys: [] } }),
      },
    };
  }

  it('ctx.startTask returns a TaskHandle wired to the framework registry', async () => {
    let capturedHandle;
    const platform = buildPlatformWithTask(async (req, ctx) => {
      const handle = ctx.startTask({ partialResult: { media_buy_id: 'mb_partial', status: 'pending_creatives' } });
      capturedHandle = handle;
      return { kind: 'submitted', taskHandle: handle, message: 'queued' };
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(result.structuredContent.status, 'submitted');
    const taskId = result.structuredContent.task_id;
    assert.ok(taskId.startsWith('task_'), `expected framework-issued taskId, got ${taskId}`);
    assert.strictEqual(capturedHandle.taskId, taskId);

    // Task registry holds the initial submitted record with partial result.
    const initial = server.getTaskState(taskId);
    assert.ok(initial);
    assert.strictEqual(initial.status, 'submitted');
    assert.strictEqual(initial.tool, 'create_media_buy');
    assert.strictEqual(initial.accountId, 'acc_1');
    assert.deepStrictEqual(initial.partialResult, { media_buy_id: 'mb_partial', status: 'pending_creatives' });
  });

  it('handle.notify({ kind: "completed" }) writes terminal result to registry', async () => {
    let capturedHandle;
    const platform = buildPlatformWithTask(async (req, ctx) => {
      const handle = ctx.startTask();
      capturedHandle = handle;
      return { kind: 'submitted', taskHandle: handle };
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });

    capturedHandle.notify({ kind: 'completed', result: { media_buy_id: 'mb_final', status: 'active' } });

    const finalRecord = server.getTaskState(capturedHandle.taskId);
    assert.strictEqual(finalRecord.status, 'completed');
    assert.deepStrictEqual(finalRecord.result, { media_buy_id: 'mb_final', status: 'active' });
  });

  it('handle.notify({ kind: "failed" }) writes terminal error to registry', async () => {
    let capturedHandle;
    const platform = buildPlatformWithTask(async (req, ctx) => {
      const handle = ctx.startTask();
      capturedHandle = handle;
      return { kind: 'submitted', taskHandle: handle };
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });

    capturedHandle.notify({
      kind: 'failed',
      error: { code: 'GOVERNANCE_DENIED', recovery: 'permanent', message: 'operator declined' },
    });

    const finalRecord = server.getTaskState(capturedHandle.taskId);
    assert.strictEqual(finalRecord.status, 'failed');
    assert.strictEqual(finalRecord.error.code, 'GOVERNANCE_DENIED');
    assert.strictEqual(finalRecord.statusMessage, 'operator declined');
  });

  it('terminal-state lock-out: subsequent notify calls are no-ops', async () => {
    let capturedHandle;
    const platform = buildPlatformWithTask(async (req, ctx) => {
      const handle = ctx.startTask();
      capturedHandle = handle;
      return { kind: 'submitted', taskHandle: handle };
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });

    capturedHandle.notify({ kind: 'completed', result: { media_buy_id: 'first' } });
    capturedHandle.notify({ kind: 'completed', result: { media_buy_id: 'second_should_be_ignored' } });

    const finalRecord = server.getTaskState(capturedHandle.taskId);
    assert.deepStrictEqual(finalRecord.result, { media_buy_id: 'first' });
  });
});

describe('CreativeTemplatePlatform + AudiencePlatform wiring', () => {
  it('build_creative dispatches through platform.creative.buildCreative', async () => {
    let sawReq;
    const platform = {
      capabilities: {
        specialisms: ['creative-template'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
        upsert: async () => ({ kind: 'sync', result: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      creative: {
        buildCreative: async req => {
          sawReq = req;
          return { kind: 'sync', result: { manifest_id: 'mf_1', assets: [] } };
        },
        previewCreative: async () => ({ kind: 'sync', result: { preview_url: 'https://example.com/p' } }),
        syncCreatives: async () => ({ kind: 'sync', result: [] }),
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'build_creative',
        arguments: {
          format_id: { id: 'standard', agent_url: 'https://example.com/mcp' },
          creative_manifest: { assets: [] },
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(sawReq, 'creative.buildCreative should be invoked');
  });

  it('sync_audiences dispatches through platform.audiences.syncAudiences', async () => {
    let sawAudiences;
    const platform = {
      capabilities: {
        specialisms: ['audience-sync'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
        upsert: async () => ({ kind: 'sync', result: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      audiences: {
        syncAudiences: async audList => {
          sawAudiences = audList;
          return {
            kind: 'sync',
            result: audList.map(a => ({
              audience_id: a.audience_id,
              action: 'created',
              status: 'matching',
              match_rate: 0,
            })),
          };
        },
        getAudienceStatus: async () => 'matching',
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_audiences',
        arguments: {
          audiences: [{ audience_id: 'aud_1', identifiers: ['email1', 'email2'] }],
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(sawAudiences, 'audiences.syncAudiences should be invoked');
    assert.strictEqual(sawAudiences[0].audience_id, 'aud_1');
  });
});

describe('validatePlatform', () => {
  it('passes when claimed specialism has its required platform interface', () => {
    const platform = buildPlatform();
    assert.doesNotThrow(() => validatePlatform(platform));
  });

  it('throws PlatformConfigError when sales-non-guaranteed is claimed but sales is missing', () => {
    const platform = buildPlatform();
    delete platform.sales;
    assert.throws(() => validatePlatform(platform), PlatformConfigError);
  });

  it('passes for unknown future specialisms (forward-compat)', () => {
    const platform = buildPlatform({
      capabilities: {
        ...buildPlatform().capabilities,
        specialisms: ['sales-non-guaranteed', 'governance-spend-authority'],
      },
    });
    assert.doesNotThrow(() => validatePlatform(platform));
  });
});
