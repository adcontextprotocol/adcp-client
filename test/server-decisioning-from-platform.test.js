// Smoke tests for `createAdcpServerFromPlatform` — the v6.0 alpha runtime.
// Adopter shape: per spec-HITL tool, exactly one of {sync `xxx`, HITL
// `xxxTask`}. Sync return value projects to wire success arm; throw
// `AdcpError` for structured rejection. HITL allocates `taskId` BEFORE
// invoking, returns submitted envelope to buyer, runs `*Task(taskId, ...)`
// in background; method's return value becomes terminal task result.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { PlatformConfigError, validatePlatform } = require('../dist/lib/server/decisioning/runtime/validate-platform');
const { AccountNotFoundError } = require('../dist/lib/server/decisioning/account');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

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

    const finalRecord = server.getTaskState(taskId);
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

    const finalRecord = server.getTaskState(taskId);
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

    const finalRecord = server.getTaskState(taskId);
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
