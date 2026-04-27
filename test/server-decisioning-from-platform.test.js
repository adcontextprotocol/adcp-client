// Smoke tests for `createAdcpServerFromPlatform` — the v6.0 alpha runtime.
// Adopter shape: per spec-HITL tool, exactly one of {sync `xxx`, HITL
// `xxxTask`}. Sync return value projects to wire success arm; throw
// `AdcpError` for structured rejection. HITL allocates `taskId` BEFORE
// invoking, returns submitted envelope to buyer, runs `*Task(taskId, ...)`
// in background; method's return value becomes terminal task result.

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { PlatformConfigError, validatePlatform } = require('../dist/lib/server/decisioning/runtime/validate-platform');
const { AccountNotFoundError } = require('../dist/lib/server/decisioning/account');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
const { setStatusChangeBus, createInMemoryStatusChangeBus } = require('../dist/lib/server/decisioning/status-changes');

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
            description: 'spike test',
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
        upsert: async () => [],
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
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
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

  it('createMediaBuy success arm projects to wire success', async () => {
    const platform = buildSalesPlatform({
      createMediaBuy: async () => ({
        media_buy_id: 'mb_42',
        status: 'pending_creatives',
        packages: [],
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

  it('createMediaBuy throwing AdcpError projects to ADCP_ERROR envelope with structured fields', async () => {
    const platform = buildSalesPlatform({
      createMediaBuy: async () => {
        throw new AdcpError('BUDGET_TOO_LOW', {
          recovery: 'correctable',
          message: 'floor is $5 CPM',
          field: 'total_budget.amount',
          suggestion: 'Raise total_budget to at least 5000',
        });
      },
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
    assert.strictEqual(result.structuredContent.adcp_error.field, 'total_budget.amount');
    assert.strictEqual(result.structuredContent.adcp_error.suggestion, 'Raise total_budget to at least 5000');
  });

  it('generic thrown Error falls through to SERVICE_UNAVAILABLE', async () => {
    const platform = buildSalesPlatform({
      createMediaBuy: async () => {
        throw new Error('upstream API connection refused');
      },
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
    assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
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
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      creative: {
        buildCreative: async req => {
          sawReq = req;
          return { manifest_id: 'mf_1', assets: [] };
        },
        previewCreative: async () => ({ preview_url: 'https://example.com/p' }),
        syncCreatives: async () => [],
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
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      audiences: {
        syncAudiences: async audList => {
          sawAudiences = audList;
          return audList.map(a => ({
            audience_id: a.audience_id,
            action: 'created',
            status: 'matching',
            match_rate: 0,
          }));
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

describe('HITL dual-method dispatch — *Task variants', () => {
  function buildHitlPlatform(salesOverrides) {
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
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      sales: {
        // No sync method; HITL `*Task` variant only.
        getProducts: undefined,
        createMediaBuy: undefined,
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        ...salesOverrides,
      },
    };
  }

  function dispatchCreate(server) {
    return server.dispatchTestRequest({
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
  }

  it('createMediaBuyTask returns submitted envelope; background completes terminal state', async () => {
    let capturedTaskId;
    const platform = buildHitlPlatform({
      createMediaBuyTask: async (taskId, req) => {
        capturedTaskId = taskId;
        await new Promise(r => setTimeout(r, 30));
        return { media_buy_id: 'mb_final', status: 'active' };
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.ok(result.structuredContent.task_id.startsWith('task_'));
    assert.strictEqual(
      result.structuredContent.task_id,
      capturedTaskId,
      'taskId on the wire matches the one passed to *Task'
    );

    const taskId = result.structuredContent.task_id;
    await server.awaitTask(taskId);

    const finalRecord = await server.getTaskState(taskId);
    assert.strictEqual(finalRecord.status, 'completed');
    assert.deepStrictEqual(finalRecord.result, { media_buy_id: 'mb_final', status: 'active' });
  });

  it('createMediaBuyTask throwing AdcpError records terminal failed with structured fields', async () => {
    const platform = buildHitlPlatform({
      createMediaBuyTask: async () => {
        await new Promise(r => setTimeout(r, 20));
        throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'operator declined' });
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    const taskId = result.structuredContent.task_id;

    await server.awaitTask(taskId);

    const finalRecord = await server.getTaskState(taskId);
    assert.strictEqual(finalRecord.status, 'failed');
    assert.strictEqual(finalRecord.error.code, 'GOVERNANCE_DENIED');
    assert.strictEqual(finalRecord.error.recovery, 'terminal');
  });

  it('createMediaBuyTask throwing generic Error records terminal failed as SERVICE_UNAVAILABLE', async () => {
    const platform = buildHitlPlatform({
      createMediaBuyTask: async () => {
        await new Promise(r => setTimeout(r, 20));
        throw new Error('upstream API timeout');
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    const taskId = result.structuredContent.task_id;

    await server.awaitTask(taskId);

    const finalRecord = await server.getTaskState(taskId);
    assert.strictEqual(finalRecord.status, 'failed');
    assert.strictEqual(finalRecord.error.code, 'SERVICE_UNAVAILABLE');
    assert.strictEqual(finalRecord.error.recovery, 'transient');
  });
});

describe('NODE_ENV gate on default in-memory task registry', () => {
  function emptyPlatform() {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'a', metadata: {}, authInfo: { kind: 'api_key' } }),
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      statusMappers: {},
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  function withEnv(env, fn) {
    const prev = process.env.NODE_ENV;
    const prevAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.NODE_ENV;
    if (env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS === undefined)
      delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      if (prevAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = prevAck;
    }
  }

  it('NODE_ENV=test → uses default in-memory registry', () => {
    withEnv({ NODE_ENV: 'test' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServerFromPlatform(emptyPlatform(), {
          name: 't',
          version: '0',
          validation: { requests: 'off', responses: 'off' },
        })
      );
    });
  });

  it('NODE_ENV=development → uses default in-memory registry', () => {
    withEnv({ NODE_ENV: 'development' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServerFromPlatform(emptyPlatform(), {
          name: 't',
          version: '0',
          validation: { requests: 'off', responses: 'off' },
        })
      );
    });
  });

  it('NODE_ENV=production without explicit ack → refuses with diagnostic', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      assert.throws(
        () =>
          createAdcpServerFromPlatform(emptyPlatform(), {
            name: 't',
            version: '0',
            validation: { requests: 'off', responses: 'off' },
          }),
        /in-memory task registry refused/
      );
    });
  });

  it('NODE_ENV unset (also production) without explicit ack → refuses', () => {
    withEnv({ NODE_ENV: undefined }, () => {
      assert.throws(() =>
        createAdcpServerFromPlatform(emptyPlatform(), {
          name: 't',
          version: '0',
          validation: { requests: 'off', responses: 'off' },
        })
      );
    });
  });

  it('NODE_ENV=production WITH ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1 → allows (with documented data-loss tradeoff)', () => {
    withEnv({ NODE_ENV: 'production', ADCP_DECISIONING_ALLOW_INMEMORY_TASKS: '1' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServerFromPlatform(emptyPlatform(), {
          name: 't',
          version: '0',
          validation: { requests: 'off', responses: 'off' },
        })
      );
    });
  });

  it('explicit taskRegistry provided → no NODE_ENV check', () => {
    const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');
    withEnv({ NODE_ENV: 'production' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServerFromPlatform(emptyPlatform(), {
          name: 't',
          version: '0',
          taskRegistry: createInMemoryTaskRegistry(),
          validation: { requests: 'off', responses: 'off' },
        })
      );
    });
  });
});

describe('SalesPlatform optional methods (v1.0 gap-fill for rc.1)', () => {
  // The v1.0 stable surface adds getMediaBuys / providePerformanceFeedback /
  // listCreativeFormats / listCreatives as optional methods on SalesPlatform.
  // Adopters who implement them get first-class dispatch through the platform
  // interface; adopters who don't can still fill via the merge seam (see the
  // separate suite below).

  it('getMediaBuys dispatches through sales.getMediaBuys when defined', async () => {
    let sawCtx;
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async (req, ctx) => {
          sawCtx = ctx;
          return { media_buys: [{ media_buy_id: 'mb_via_platform', status: 'active' }] };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.media_buys[0].media_buy_id, 'mb_via_platform');
    assert.ok(sawCtx?.account, 'platform method received the resolved RequestContext');
  });

  it('providePerformanceFeedback dispatches via auth-derived resolveAccount (no `account` field on wire)', async () => {
    let received;
    let resolveCalledWithRef;
    const platform = buildPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async ref => {
          resolveCalledWithRef = ref;
          return { id: 'singleton', name: 'Acme', status: 'active', metadata: {}, authInfo: { kind: 'api_key' } };
        },
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        providePerformanceFeedback: async req => {
          received = req;
          return { success: true };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'provide_performance_feedback',
        arguments: {
          media_buy_id: 'mb_1',
          performance_index: 0.85,
          measurement_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' },
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(received.media_buy_id, 'mb_1');
    assert.strictEqual(resolveCalledWithRef, undefined, 'auth-derived path passes undefined ref to platform resolver');
  });

  it('listCreativeFormats dispatches via auth-derived resolveAccount', async () => {
    const platform = buildPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => ({
          id: 'singleton', name: 'Acme', status: 'active', metadata: {}, authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        listCreativeFormats: async () => ({
          formats: [{ agent_url: 'https://example.com/mcp', id: 'video_30s', type: 'video' }],
        }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_creative_formats', arguments: {} },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.formats[0].id, 'video_30s');
  });
});

describe('AccountStore optional methods (v1.0 gap-fill for rc.1)', () => {
  function buildAccountsPlatform(extras) {
    return buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_1', name: 'Acme', status: 'active', metadata: {}, authInfo: { kind: 'api_key' },
        }),
        ...extras,
      },
    });
  }

  it('reportUsage dispatches through accounts.reportUsage when defined', async () => {
    let received;
    const platform = buildAccountsPlatform({
      reportUsage: async req => {
        received = req;
        return { success: true };
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'report_usage',
        arguments: {
          account: { account_id: 'acc_1' },
          period: { start: '2026-04-01', end: '2026-04-30' },
          line_items: [],
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(received, 'platform reportUsage was invoked');
  });

  it('getAccountFinancials dispatches through accounts.getAccountFinancials when defined', async () => {
    const platform = buildAccountsPlatform({
      getAccountFinancials: async () => ({
        account: { account_id: 'acc_1' },
        currency: 'USD',
        period: { start: '2026-04-01', end: '2026-04-30' },
        timezone: 'America/New_York',
        spend: { total_spend: 1234.56, media_buy_count: 3 },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.spend.total_spend, 1234.56);
  });

  // Note: when neither the platform nor the merge seam supplies a handler
  // for report_usage / get_account_financials, the framework simply doesn't
  // register the tool — `tools/list` won't include it and a buyer call
  // returns "tool not registered". That's coherent: undeclared = absent.
  // Adopters who want UNSUPPORTED_FEATURE-on-disabled register a stub via
  // the merge seam that throws AdcpError('UNSUPPORTED_FEATURE').
});

describe('Custom-handler merge seam (incremental migration)', () => {
  // The platform shape models the v1.0 stable surface. Adopters with
  // established handler-style adapters use the merge seam to fill gaps for
  // tools the platform doesn't yet model — getMediaBuys, listCreativeFormats,
  // providePerformanceFeedback, reportUsage, sync_event_sources, content-
  // standards CRUD, etc. — without forking the runtime. Platform-derived
  // handlers WIN per-key; adopter handlers fill the rest.

  it('dispatches getMediaBuys (un-wired by SalesPlatform) through opts.mediaBuy', async () => {
    const platform = buildPlatform();
    let sawArgs;
    const server = createAdcpServerFromPlatform(platform, {
      name: 'merged',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: {
        getMediaBuys: async (params, ctx) => {
          sawArgs = { params, account: ctx.account };
          return { media_buys: [{ media_buy_id: 'mb_42', status: 'active' }] };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buys',
        arguments: { account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent.media_buys[0].media_buy_id, 'mb_42');
    assert.ok(sawArgs, 'custom getMediaBuys handler was invoked');
    assert.strictEqual(sawArgs.account.id, 'acc_1', 'custom handler received the resolved account in ctx');
  });

  it('platform-derived handler wins when both define the same key', async () => {
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({
          products: [
            {
              product_id: 'platform_wins',
              name: 'platform',
              description: '',
              format_ids: [{ id: 'standard', agent_url: 'https://example.com/mcp' }],
              delivery_type: 'non_guaranteed',
              publisher_properties: { reportable: true },
              reporting_capabilities: { available_dimensions: ['geo'] },
              pricing_options: [{ pricing_model: 'cpm', rate: 1, currency: 'USD' }],
            },
          ],
        }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'merged',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: {
        // Custom handler tries to override platform.sales.getProducts.
        // Platform-derived MUST win — opts is the gap-filler, not an override.
        getProducts: async () => ({ products: [{ product_id: 'opts_should_lose', name: 'opts', description: '', format_ids: [], delivery_type: 'non_guaranteed', publisher_properties: { reportable: true }, reporting_capabilities: { available_dimensions: [] }, pricing_options: [] }] }),
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: { brief: 'x', promoted_offering: 'y', account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(
      result.structuredContent.products[0].product_id,
      'platform_wins',
      'platform-derived handler must win over opts.mediaBuy.getProducts'
    );
  });

  it('dispatches eventTracking handlers for tools without a v6 specialism', async () => {
    const platform = buildPlatform();
    let logEventCalled = false;
    const server = createAdcpServerFromPlatform(platform, {
      name: 'merged',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      eventTracking: {
        logEvent: async () => {
          logEventCalled = true;
          return { event_id: 'evt_1' };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'log_event',
        arguments: {
          account: { account_id: 'acc_1' },
          event_id: 'evt_1',
          event_type: 'conversion',
          event_source_id: 'src_1',
          timestamp: '2026-04-27T00:00:00Z',
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(logEventCalled, 'custom logEvent handler invoked');
  });

  it('dispatches governance content-standards handlers (deferred specialism)', async () => {
    const platform = buildPlatform();
    let listCalled = false;
    const server = createAdcpServerFromPlatform(platform, {
      name: 'merged',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      governance: {
        listContentStandards: async () => {
          listCalled = true;
          return { standards: [] };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'list_content_standards',
        arguments: { account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(listCalled, 'custom listContentStandards handler invoked');
  });
});

describe('SalesPlatform retail-media tools (M2)', () => {
  it('syncCatalogs dispatches via sales.syncCatalogs (sales-catalog-driven)', async () => {
    let received;
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        syncCatalogs: async req => {
          received = req;
          return { catalogs: [] };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'rm', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_catalogs',
        arguments: {
          account: { account_id: 'acc_1' },
          catalogs: [],
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(received, 'syncCatalogs invoked');
  });

  it('logEvent dispatches via sales.logEvent (conversion tracking)', async () => {
    const platform = buildPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => ({
          id: 'acc_1', name: 'Acme', status: 'active', metadata: {}, authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        logEvent: async () => ({ success: true }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'rm', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'log_event',
        arguments: {
          event_id: 'e1',
          event_type: 'conversion',
          event_source_id: 'src_1',
          timestamp: '2026-04-27T00:00:00Z',
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
  });

  it('syncEventSources dispatches via sales.syncEventSources', async () => {
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        syncEventSources: async () => ({ event_sources: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'rm', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_event_sources',
        arguments: {
          account: { account_id: 'acc_1' },
          event_sources: [],
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
  });
});

describe('ContentStandardsPlatform (M1)', () => {
  it('listContentStandards dispatches via platform.contentStandards', async () => {
    let invoked = false;
    const platform = buildPlatform({
      capabilities: {
        specialisms: ['sales-non-guaranteed', 'content-standards'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      contentStandards: {
        listContentStandards: async () => {
          invoked = true;
          return { standards: [] };
        },
        getContentStandards: async () => ({ standards: [] }),
        createContentStandards: async () => ({ standard: { standard_id: 's_1' } }),
        updateContentStandards: async () => ({ standard: { standard_id: 's_1' } }),
        calibrateContent: async () => ({ calibration: {} }),
        validateContentDelivery: async () => ({ result: {} }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'cs', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_content_standards', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(invoked, 'listContentStandards invoked');
  });

  it('validatePlatform requires contentStandards when content-standards specialism claimed', () => {
    const platform = buildPlatform({
      capabilities: {
        specialisms: ['sales-non-guaranteed', 'content-standards'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
    });
    delete platform.contentStandards;
    assert.throws(() => validatePlatform(platform), /contentStandards/);
  });
});

describe('Merge-seam collision warning (M3)', () => {
  it('warns when opts handler is shadowed by platform-derived handler', () => {
    const warnings = [];
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async () => ({ media_buys: [] }), // platform now models it
      },
    });
    createAdcpServerFromPlatform(platform, {
      name: 'collide', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      logger: {
        debug: () => {}, info: () => {},
        warn: msg => warnings.push(msg),
        error: () => {},
      },
      mediaBuy: {
        // Adopter override that's about to be silently shadowed.
        getMediaBuys: async () => ({ media_buys: [{ media_buy_id: 'opts_should_warn' }] }),
      },
    });
    const collisionWarn = warnings.find(w => w.includes('opts.mediaBuy') && w.includes('getMediaBuys'));
    assert.ok(collisionWarn, `expected merge-seam collision warning, got: ${JSON.stringify(warnings)}`);
  });

  it('throws PlatformConfigError on collision in strict mode', () => {
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    });
    assert.throws(() => createAdcpServerFromPlatform(platform, {
      name: 'collide', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mergeSeam: 'strict',
      mediaBuy: {
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    }), /opts\.mediaBuy.*shadowed/);
  });

  it('log-once mode: first construction warns, subsequent identical-collision constructions stay silent', () => {
    const { _resetMergeSeamDedupe } = require('../dist/lib/server/decisioning/runtime/from-platform');
    _resetMergeSeamDedupe();

    function buildCollidingPlatform() {
      return buildPlatform({
        sales: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
          updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
          syncCreatives: async () => [],
          getMediaBuyDelivery: async () => ({ media_buys: [] }),
          getMediaBuys: async () => ({ media_buys: [] }),
        },
      });
    }

    const warnings1 = [];
    const warnings2 = [];

    createAdcpServerFromPlatform(buildCollidingPlatform(), {
      name: 't1', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mergeSeam: 'log-once',
      logger: { debug: () => {}, info: () => {}, warn: m => warnings1.push(m), error: () => {} },
      mediaBuy: { getMediaBuys: async () => ({ media_buys: [] }) },
    });

    createAdcpServerFromPlatform(buildCollidingPlatform(), {
      name: 't2', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mergeSeam: 'log-once',
      logger: { debug: () => {}, info: () => {}, warn: m => warnings2.push(m), error: () => {} },
      mediaBuy: { getMediaBuys: async () => ({ media_buys: [] }) },
    });

    const merge1 = warnings1.filter(w => w.includes('shadowed by platform-derived'));
    const merge2 = warnings2.filter(w => w.includes('shadowed by platform-derived'));
    assert.strictEqual(merge1.length, 1, 'first construction warns once');
    assert.strictEqual(merge2.length, 0, 'second construction with same collision is silent');
  });

  it('silent mode: no warning, no throw', () => {
    const warnings = [];
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    });
    assert.doesNotThrow(() => createAdcpServerFromPlatform(platform, {
      name: 'silent', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mergeSeam: 'silent',
      logger: {
        debug: () => {}, info: () => {},
        warn: msg => warnings.push(msg),
        error: () => {},
      },
      mediaBuy: { getMediaBuys: async () => ({ media_buys: [] }) },
    }));
    const mergeWarnings = warnings.filter(w => w.includes('shadowed by platform-derived'));
    assert.strictEqual(mergeWarnings.length, 0, 'silent mode emits no merge-seam warnings');
  });
});

describe('Observability hooks (DecisioningObservabilityHooks)', () => {
  function buildHitlPlatform(taskFn) {
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
          id: ref?.account_id ?? 'acc_1', name: 'Acme', status: 'active',
          metadata: {}, authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuyTask: taskFn,
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  it('onAccountResolve fires after every resolve with timing + resolved flag', async () => {
    const calls = [];
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: {
        onAccountResolve: info => calls.push(info),
      },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'x', promoted_offering: 'y', account: { account_id: 'acc_1' } } },
    });
    assert.ok(calls.length >= 1, 'onAccountResolve fired at least once');
    const call = calls[0];
    assert.strictEqual(call.tool, 'get_products');
    assert.strictEqual(call.resolved, true);
    assert.strictEqual(call.fromAuth, false);
    assert.ok(typeof call.durationMs === 'number' && call.durationMs >= 0);
  });

  it('onAccountResolve marks fromAuth=true on auth-derived path', async () => {
    const calls = [];
    const platform = buildPlatform({
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'singleton', name: 'X', status: 'active', metadata: {}, authInfo: { kind: 'api_key' } }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        providePerformanceFeedback: async () => ({ success: true }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: { onAccountResolve: info => calls.push(info) },
    });
    // provide_performance_feedback wire request has no `account` field —
    // framework calls resolveAccountFromAuth → fromAuth=true on the hook.
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'provide_performance_feedback',
        arguments: {
          media_buy_id: 'mb_1',
          performance_index: 0.85,
          measurement_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' },
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    const authCall = calls.find(c => c.fromAuth === true);
    assert.ok(authCall, `expected fromAuth=true call, got: ${JSON.stringify(calls)}`);
    assert.strictEqual(authCall.tool, 'provide_performance_feedback');
  });

  it('onTaskCreate + onTaskTransition fire across HITL lifecycle', async () => {
    const events = [];
    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: {
        onTaskCreate: info => events.push({ kind: 'create', ...info }),
        onTaskTransition: info => events.push({ kind: 'transition', ...info }),
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [], start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);

    const create = events.find(e => e.kind === 'create');
    const transition = events.find(e => e.kind === 'transition');
    assert.ok(create, 'onTaskCreate fired');
    assert.strictEqual(create.tool, 'create_media_buy');
    assert.strictEqual(create.accountId, 'acc_1');
    assert.ok(transition, 'onTaskTransition fired');
    assert.strictEqual(transition.status, 'completed');
    assert.ok(typeof transition.durationMs === 'number' && transition.durationMs >= 0);
  });

  it('onTaskTransition status="failed" carries errorCode on AdcpError', async () => {
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
    const transitions = [];
    const platform = buildHitlPlatform(async () => {
      throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'denied' });
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: { onTaskTransition: info => transitions.push(info) },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [], start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(transitions.length, 1);
    assert.strictEqual(transitions[0].status, 'failed');
    assert.strictEqual(transitions[0].errorCode, 'GOVERNANCE_DENIED');
  });

  it('onWebhookEmit fires after each delivery attempt', async () => {
    const emits = [];
    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_1' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: {
        emit: async params => ({ operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] }),
      },
      observability: { onWebhookEmit: info => emits.push(info) },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [], start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].url, 'https://buyer.example.com/webhook');
    assert.strictEqual(emits[0].status, 'completed');
    assert.strictEqual(emits[0].success, true);
    assert.strictEqual(emits[0].tool, 'create_media_buy');
  });

  it('onStatusChangePublish fires for every server.statusChange.publish', () => {
    const events = [];
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: { onStatusChangePublish: info => events.push(info) },
    });
    server.statusChange.publish({
      account_id: 'acc_1',
      resource_type: 'media_buy',
      resource_id: 'mb_1',
      payload: { status: 'active' },
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].accountId, 'acc_1');
    assert.strictEqual(events[0].resourceType, 'media_buy');
    assert.strictEqual(events[0].resourceId, 'mb_1');
  });

  it('hook throws are caught and logged — dispatch unaffected', async () => {
    const warns = [];
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      logger: { debug: () => {}, info: () => {}, warn: m => warns.push(m), error: () => {} },
      observability: {
        onAccountResolve: () => { throw new Error('telemetry exploded'); },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'x', promoted_offering: 'y', account: { account_id: 'acc_1' } } },
    });
    assert.notStrictEqual(result.isError, true, 'dispatch succeeded despite hook throw');
    const hookWarn = warns.find(w => w.includes('observability hook onAccountResolve threw'));
    assert.ok(hookWarn, `expected hook-throw warning, got: ${JSON.stringify(warns)}`);
  });
});

describe('HITL push notification webhook on terminal state', () => {
  // When a buyer passes `push_notification_config: { url, token }` and the
  // host wires `webhooks` on serve(), the framework emits a signed RFC 9421
  // webhook to that URL on terminal state with the task lifecycle payload.
  // Polling via getTaskState continues to work; webhook is push-on-top.

  function buildHitlPlatform(taskFn) {
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
          id: ref?.account_id ?? 'acc_1', name: 'Acme', status: 'active',
          metadata: {}, authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuyTask: taskFn,
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  it('emits webhook on completed task with push_notification_config', async () => {
    const emits = [];
    const fakeEmitter = {
      emit: async params => {
        emits.push(params);
        return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
      },
    };

    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: fakeEmitter,
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
          push_notification_config: { url: 'https://buyer.example.com/webhook', token: 'shhh' },
        },
      },
    });

    assert.strictEqual(result.structuredContent.status, 'submitted');
    const taskId = result.structuredContent.task_id;
    await server.awaitTask(taskId);

    assert.strictEqual(emits.length, 1, 'one webhook emitted on terminal completion');
    const emit = emits[0];
    assert.strictEqual(emit.url, 'https://buyer.example.com/webhook');
    assert.strictEqual(emit.payload.task.task_id, taskId);
    assert.strictEqual(emit.payload.task.status, 'completed');
    assert.deepStrictEqual(emit.payload.task.result, { media_buy_id: 'mb_42', status: 'active' });
    assert.strictEqual(emit.payload.validation_token, 'shhh');
    assert.ok(emit.operation_id.startsWith('create_media_buy.task_'));
  });

  it('emits webhook on failed task with structured error', async () => {
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
    const emits = [];
    const fakeEmitter = {
      emit: async params => { emits.push(params); return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] }; },
    };

    const platform = buildHitlPlatform(async () => {
      throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'op declined' });
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: fakeEmitter,
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);

    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].payload.task.status, 'failed');
    assert.strictEqual(emits[0].payload.task.error.code, 'GOVERNANCE_DENIED');
    assert.strictEqual(emits[0].payload.validation_token, undefined, 'token omitted when buyer didn\'t supply one');
  });

  it('does not emit webhook when push_notification_config is absent', async () => {
    const emits = [];
    const fakeEmitter = {
      emit: async params => { emits.push(params); return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] }; },
    };
    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_silent' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook', version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: fakeEmitter,
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);

    assert.strictEqual(emits.length, 0, 'no webhook when buyer didn\'t opt in');
  });
});

describe('Push notification webhook URL/token validation (B5/B6)', () => {
  // SSRF + token-replay hardening on the buyer-supplied
  // push_notification_config.url / token.

  function buildHitlPlatform(taskFn) {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [], channels: ['display'], pricingModels: ['cpm'], config: {},
      },
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1', name: 'Acme', status: 'active',
          metadata: {}, authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuyTask: taskFn,
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  async function dispatchWithUrl(server, url, token) {
    return server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
          push_notification_config: { url, ...(token != null && { token }) },
        },
      },
    });
  }

  function makeServer({ warns, emits } = {}) {
    return createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_1' })),
      {
        name: 'ssrf', version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
        logger: warns ? { debug: () => {}, info: () => {}, warn: m => warns.push(m), error: () => {} } : undefined,
        taskWebhookEmitter: emits ? {
          emit: async params => { emits.push(params); return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] }; },
        } : undefined,
      }
    );
  }

  for (const [label, url, reasonFragment] of [
    ['RFC 1918 10/8', 'https://10.0.0.1/hook', 'RFC 1918 private range 10/8'],
    ['RFC 1918 192.168/16', 'https://192.168.0.1/hook', '192.168/16'],
    ['RFC 1918 172.16/12', 'https://172.16.0.1/hook', '172.16/12'],
    ['loopback 127/8', 'https://127.0.0.1/hook', 'loopback range 127/8'],
    ['link-local AWS metadata', 'http://169.254.169.254/latest/meta-data/', 'link-local 169.254/16'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/hook', 'CGNAT range 100.64/10'],
    ['IPv6 loopback', 'https://[::1]/hook', 'IPv6 loopback'],
    ['localhost', 'https://localhost/hook', 'host "localhost" rejected'],
    ['unsupported scheme', 'file:///etc/passwd', 'unsupported scheme "file:"'],
    ['malformed URL', 'not a url', 'malformed URL'],
  ]) {
    it(`rejects ${label}: ${url}`, async () => {
      const warns = [];
      const emits = [];
      const server = makeServer({ warns, emits });
      const result = await dispatchWithUrl(server, url);
      assert.notStrictEqual(result.isError, true, 'task accepted; webhook silently skipped');
      await server.awaitTask(result.structuredContent.task_id);
      assert.strictEqual(emits.length, 0, 'no webhook delivered to rejected URL');
      const warn = warns.find(w => w.includes('push_notification_config.url rejected') && w.includes(reasonFragment));
      assert.ok(warn, `expected rejection reason "${reasonFragment}", got: ${JSON.stringify(warns)}`);
    });
  }

  it('accepts a public https URL', async () => {
    const emits = [];
    const server = makeServer({ emits });
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook');
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].url, 'https://buyer.example.com/webhook');
  });

  it('accepts http:// in NODE_ENV=test (allowlist)', async () => {
    // We're already in NODE_ENV=test (set at module scope); http should be accepted.
    const emits = [];
    const server = makeServer({ emits });
    const result = await dispatchWithUrl(server, 'http://buyer.example.com/webhook');
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(emits.length, 1);
  });

  it('rejects token over 255 chars', async () => {
    const warns = [];
    const emits = [];
    const server = makeServer({ warns, emits });
    const longToken = 'a'.repeat(300);
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', longToken);
    await server.awaitTask(result.structuredContent.task_id);
    // Webhook still delivers (URL was valid) but without the rejected token
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].payload.validation_token, undefined, 'long token NOT round-tripped');
    const warn = warns.find(w => w.includes('token rejected') && w.includes('longer than'));
    assert.ok(warn, `expected token-length rejection, got: ${JSON.stringify(warns)}`);
  });

  it('rejects token with control characters', async () => {
    const warns = [];
    const emits = [];
    const server = makeServer({ warns, emits });
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', 'tok\x00\x01with-controls');
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].payload.validation_token, undefined, 'control-char token NOT round-tripped');
    const warn = warns.find(w => w.includes('token rejected') && w.includes('control characters'));
    assert.ok(warn);
  });

  it('accepts a well-formed token', async () => {
    const emits = [];
    const server = makeServer({ emits });
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', 'tok_abc-123:xyz.456');
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].payload.validation_token, 'tok_abc-123:xyz.456');
  });
});

describe('getTaskState account-scoping (B7)', () => {
  // Cross-tenant leak protection. getTaskState must filter by account when
  // an `expectedAccountId` is supplied — adopters wrapping it as `tasks/get`
  // pass `ctx.account.id` to scope reads.

  function buildHitlPlatform() {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [], channels: ['display'], pricingModels: ['cpm'], config: {},
      },
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1', name: 'Acme', status: 'active',
          metadata: {}, authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuyTask: async () => ({ media_buy_id: 'mb_42' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_42' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  async function createTaskFor(server, accountId) {
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1', idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [], start_time: '2026-05-01T00:00:00Z', end_time: '2026-06-01T00:00:00Z',
          account: { account_id: accountId },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);
    return result.structuredContent.task_id;
  }

  it('returns task for the owning account', async () => {
    const server = createAdcpServerFromPlatform(buildHitlPlatform(), {
      name: 't', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createTaskFor(server, 'acc_owner');
    const record = await server.getTaskState(taskId, 'acc_owner');
    assert.ok(record);
    assert.strictEqual(record.accountId, 'acc_owner');
  });

  it('returns null when expectedAccountId mismatches (cross-tenant probe)', async () => {
    const server = createAdcpServerFromPlatform(buildHitlPlatform(), {
      name: 't', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createTaskFor(server, 'acc_owner');
    const record = await server.getTaskState(taskId, 'acc_other');
    assert.strictEqual(record, null, 'cross-tenant probe must not leak the task');
  });

  it('unscoped read still works (ops/test contexts)', async () => {
    const server = createAdcpServerFromPlatform(buildHitlPlatform(), {
      name: 't', version: '0.0.1', validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createTaskFor(server, 'acc_owner');
    const record = await server.getTaskState(taskId);
    assert.ok(record);
    assert.strictEqual(record.accountId, 'acc_owner');
  });
});

describe('CollectionListsPlatform wiring', () => {
  function buildListsPlatform(overrides = {}) {
    return {
      capabilities: {
        specialisms: ['collection-lists'],
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
      },
      collectionLists: {
        createCollectionList: async () => ({
          list: { list_id: 'cl_1', name: 'Top Brands', authorized_collections: [] },
          fetch_token: 'tok_abc',
        }),
        updateCollectionList: async () => ({
          list: { list_id: 'cl_1', name: 'Updated', authorized_collections: [] },
        }),
        getCollectionList: async () => ({
          list: { list_id: 'cl_1', name: 'Top Brands', authorized_collections: [] },
        }),
        listCollectionLists: async () => ({ lists: [] }),
        deleteCollectionList: async () => ({ success: true }),
      },
      ...overrides,
    };
  }

  it('create_collection_list dispatches through platform.collectionLists.createCollectionList', async () => {
    const platform = buildListsPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'lists',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_collection_list',
        arguments: {
          name: 'Top Brands',
          authorized_collections: [],
          account: { account_id: 'acc_test' },
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success but got ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent.fetch_token, 'tok_abc');
    assert.strictEqual(result.structuredContent.list.list_id, 'cl_1');
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
    // brand-rights and content-standards are in the AdCP enum but not yet
    // wired to a v6.0 platform interface (deferred per the gap matrix).
    // validatePlatform's forward-compat path lets adopters claim them
    // without the framework knowing how to enforce the platform field.
    const platform = buildPlatform({
      capabilities: {
        ...buildPlatform().capabilities,
        specialisms: ['sales-non-guaranteed', 'brand-rights'],
      },
    });
    assert.doesNotThrow(() => validatePlatform(platform));
  });

  it('throws PlatformConfigError when both sync and *Task method-pair are defined', () => {
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        createMediaBuyTask: async (_taskId, _req, _ctx) => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    });
    assert.throws(() => validatePlatform(platform), /both defined/);
  });
});

describe('server.statusChange — per-server bus', () => {
  let prevBus;
  let moduleBus;

  beforeEach(() => {
    moduleBus = createInMemoryStatusChangeBus();
    prevBus = setStatusChangeBus(moduleBus);
  });

  function restoreBus() {
    setStatusChangeBus(prevBus);
  }

  it('exposes a statusChange bus on the returned server', () => {
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    assert.strictEqual(typeof server.statusChange.publish, 'function');
    assert.strictEqual(typeof server.statusChange.subscribe, 'function');
    assert.strictEqual(typeof server.statusChange.recent, 'function');
    restoreBus();
  });

  it('server.statusChange.publish does not leak into the module-level bus', () => {
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    server.statusChange.publish({
      account_id: 'acc_1',
      resource_type: 'media_buy',
      resource_id: 'mb_42',
      payload: { status: 'active' },
    });

    assert.strictEqual(server.statusChange.recent().length, 1, 'per-server bus received the event');
    assert.strictEqual(moduleBus.recent().length, 0, 'module-level bus is not contaminated');
    restoreBus();
  });

  it('two servers have independent buses — events do not cross-contaminate', () => {
    const server1 = createAdcpServerFromPlatform(buildPlatform(), {
      name: 'srv1',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const server2 = createAdcpServerFromPlatform(buildPlatform(), {
      name: 'srv2',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    server1.statusChange.publish({
      account_id: 'acc_1',
      resource_type: 'media_buy',
      resource_id: 'mb_1',
      payload: { status: 'active' },
    });

    assert.strictEqual(server1.statusChange.recent().length, 1);
    assert.strictEqual(server2.statusChange.recent().length, 0, 'server2 bus should not receive server1 events');
    restoreBus();
  });

  it('honors an explicit statusChangeBus override', () => {
    const sharedBus = createInMemoryStatusChangeBus();
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      name: 'shared',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      statusChangeBus: sharedBus,
    });
    assert.strictEqual(server.statusChange, sharedBus, 'server.statusChange exposes the override');
    server.statusChange.publish({
      account_id: 'acc_1',
      resource_type: 'collection_list',
      resource_id: 'cl_99',
      payload: { status: 'updated' },
    });
    assert.strictEqual(sharedBus.recent().length, 1);
    assert.strictEqual(sharedBus.recent()[0].resource_id, 'cl_99');
    assert.strictEqual(sharedBus.recent()[0].resource_type, 'collection_list');
    restoreBus();
  });

  it('accepts property_list + collection_list resource types', () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      name: 'lists',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    server.statusChange.publish({
      account_id: 'acc_1',
      resource_type: 'property_list',
      resource_id: 'pl_42',
      payload: { status: 'updated' },
    });
    server.statusChange.publish({
      account_id: 'acc_1',
      resource_type: 'collection_list',
      resource_id: 'cl_42',
      payload: { status: 'updated' },
    });
    const recent = server.statusChange.recent();
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].resource_type, 'property_list');
    assert.strictEqual(recent[1].resource_type, 'collection_list');
    restoreBus();
  });
});
