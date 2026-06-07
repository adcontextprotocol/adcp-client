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
const { StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore } = require('../dist/lib/signing/server.js');
const { getSchemaValidatorByRef } = require('../dist/lib/validation/schema-loader');

const validateMcpWebhookPayload = getSchemaValidatorByRef('core/mcp-webhook-payload.json');
assert.ok(validateMcpWebhookPayload, 'MCP webhook payload schema must compile');

function assertMcpWebhookPayloadValid(payload) {
  assert.strictEqual(validateMcpWebhookPayload(payload), true, JSON.stringify(validateMcpWebhookPayload.errors));
}

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
        cache_scope: 'account',
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
            cache_scope: 'account',
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

  it('applies responseEnhancer to platform and generated discovery responses', async () => {
    const enhancedStatuses = [];
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      responseEnhancer: response => {
        enhancedStatuses.push(response.structuredContent?.status);
        const first = Array.isArray(response.content) ? response.content[0] : undefined;
        if (first && first.type === 'text' && typeof first.text === 'string') {
          first.text = `${first.text}\n\nenhanced`;
        }
      },
    });

    const products = await server.dispatchTestRequest({
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
    const capabilities = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });

    assert.match(products.content[0].text, /enhanced/);
    assert.match(capabilities.content[0].text, /enhanced/);
    assert.strictEqual(enhancedStatuses.length, 2);
  });

  it('fails closed for auth-derived get_products responses missing cache_scope', async () => {
    let sawCtx;
    const base = buildPlatform();
    const platform = buildPlatform({
      sales: {
        ...base.sales,
        getProducts: async (req, ctx) => {
          sawCtx = ctx;
          return {
            products: [
              {
                product_id: 'p_auth_scoped',
                name: 'auth scoped',
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
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          buying_mode: 'brief',
          brief: 'premium',
        },
      },
    });

    assert.ok(sawCtx?.account, 'auth-derived platform path should populate ctx.account before response defaults');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    const issue = result.structuredContent.adcp_error.issues.find(i => i.pointer === '/cache_scope');
    assert.ok(issue, `expected missing cache_scope issue, got: ${JSON.stringify(result.structuredContent)}`);
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
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

describe('CreativeBuilderPlatform + AudiencePlatform wiring', () => {
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

  it('F13: creative-generative specialism accepts the merged CreativeBuilderPlatform shape', async () => {
    // Pre-merge, creative-generative required CreativeGenerativePlatform
    // (which had `refineCreative` required and no previewCreative). After
    // the merge, the same CreativeBuilderPlatform satisfies both specialism
    // claims — refineCreative + previewCreative are both optional. This
    // test asserts a generative-only adopter (no preview) still wires.
    let sawReq;
    const platform = {
      capabilities: {
        specialisms: ['creative-generative'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      },
      statusMappers: {},
      creative: {
        buildCreative: async req => {
          sawReq = req;
          return { manifest_id: 'mf_gen_1', assets: [] };
        },
        // No previewCreative — generative platforms typically render
        // preview from the generated manifest itself, not as a separate
        // step. Optional in the merged shape.
        // refineCreative could be wired here for iterative generation.
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gen',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'build_creative',
        arguments: {
          format_id: { id: 'gen-square', agent_url: 'https://example.com/mcp' },
          creative_manifest: { assets: [] },
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(sawReq, 'generative builder.buildCreative invoked');
  });

  it('list_creative_formats dispatches through platform.creative.listCreativeFormats (#1324)', async () => {
    // Creative-template / creative-generative agents that own format
    // catalogs implement listCreativeFormats on CreativeBuilderPlatform.
    // Pre-#1324, the only way to wire it was via the v5 escape hatch
    // (`opts.creative.listCreativeFormats`) — the typed-platform path
    // didn't model it.
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
        resolution: 'derived',
        resolve: async () => ({
          id: 'singleton',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      statusMappers: {},
      creative: {
        buildCreative: async () => ({ manifest_id: 'mf_1', assets: [] }),
        listCreativeFormats: async req => {
          sawReq = req;
          return {
            formats: [
              {
                format_id: { id: 'standard_300x250', agent_url: 'https://example.com/mcp' },
                name: 'Standard Display',
                renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],
              },
            ],
          };
        },
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'creative-template',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_creative_formats', arguments: {} },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(sawReq, 'creative.listCreativeFormats should be invoked');
    assert.strictEqual(result.structuredContent.formats[0].format_id.id, 'standard_300x250');
  });

  it('list_creative_formats against creative platform without listCreativeFormats returns UNSUPPORTED_FEATURE (#1324)', async () => {
    const platform = {
      capabilities: {
        specialisms: ['creative-template'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolution: 'derived',
        resolve: async () => ({
          id: 'singleton',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      statusMappers: {},
      creative: {
        buildCreative: async () => ({ manifest_id: 'mf_1', assets: [] }),
        // No listCreativeFormats — adopters who delegate via creative_agents
        // declarations omit it; framework returns UNSUPPORTED_FEATURE.
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'creative-template',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_creative_formats', arguments: {} },
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.structuredContent.adcp_error?.code ?? '', /UNSUPPORTED_FEATURE/);
  });

  it('F13: preview_creative against builder without previewCreative returns UNSUPPORTED_FEATURE', async () => {
    // Generative-only platforms that omit previewCreative MUST surface
    // an UNSUPPORTED_FEATURE error to buyers calling preview_creative,
    // not a runtime crash. Pre-merge this was structurally impossible
    // (Template required previewCreative, Generative didn't have the
    // field at all); post-merge the framework's optional-method check
    // is the only guard.
    const platform = {
      capabilities: {
        specialisms: ['creative-generative'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      },
      statusMappers: {},
      creative: {
        buildCreative: async () => ({ manifest_id: 'mf_1', assets: [] }),
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gen',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'preview_creative',
        arguments: {
          creative_manifest: { assets: [] },
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.structuredContent.adcp_error?.code ?? '', /UNSUPPORTED_FEATURE/);
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
        pollAudienceStatuses: async () => new Map(),
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
        // Default sync createMediaBuy; tests override with handoff variant.
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_default' }),
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

  function dispatchGetProducts(server, overrides = {}) {
    return server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          buying_mode: 'brief',
          brief: 'premium auto intenders',
          promoted_offering: 'cars',
          account: { account_id: 'acc_1' },
          ...overrides,
        },
      },
    });
  }

  function dispatchGetSignals(server, overrides = {}) {
    return server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_signals',
        arguments: {
          discovery_mode: 'brief',
          brief: 'luxury auto intenders',
          account: { account_id: 'acc_1' },
          ...overrides,
        },
      },
    });
  }

  it('getProducts returning ctx.handoffToTask: submitted envelope, background completes terminal products', async () => {
    let capturedTaskId;
    const platform = buildHitlPlatform({
      getProducts: async (_req, ctx) =>
        ctx.handoffToTask(async taskCtx => {
          capturedTaskId = taskCtx.id;
          await new Promise(r => setTimeout(r, 20));
          return {
            products: [{ product_id: 'p_async', name: 'async product' }],
            cache_scope: 'account',
          };
        }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'products-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });

    const result = await dispatchGetProducts(server);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.ok(result.structuredContent.task_id.startsWith('task_'));
    assert.strictEqual(result.structuredContent.task_id, capturedTaskId);
    assert.strictEqual(result.structuredContent.products, undefined);
    assert.strictEqual(result.structuredContent.proposals, undefined);

    const taskId = result.structuredContent.task_id;
    await server.awaitTask(taskId);

    const finalRecord = await server.getTaskState(taskId);
    assert.strictEqual(finalRecord.status, 'completed');
    assert.deepStrictEqual(finalRecord.result, {
      products: [{ product_id: 'p_async', name: 'async product' }],
      cache_scope: 'account',
    });
  });

  it('getSignals returning ctx.handoffToTask: submitted envelope, background completes terminal signals', async () => {
    let capturedTaskId;
    const platform = {
      ...buildHitlPlatform(),
      sales: undefined,
      capabilities: {
        specialisms: ['signal-marketplace'],
        config: {},
      },
      signals: {
        getSignals: async (_req, ctx) =>
          ctx.handoffToTask(async taskCtx => {
            capturedTaskId = taskCtx.id;
            await new Promise(r => setTimeout(r, 20));
            return {
              signals: [{ signal_agent_segment_id: 'sig_async', name: 'Async signal' }],
            };
          }),
        activateSignal: async () => ({ deployments: [] }),
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'signals-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });

    const result = await dispatchGetSignals(server);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.ok(result.structuredContent.task_id.startsWith('task_'));
    assert.strictEqual(result.structuredContent.task_id, capturedTaskId);
    assert.strictEqual(result.structuredContent.signals, undefined);

    const taskId = result.structuredContent.task_id;
    await server.awaitTask(taskId);

    const finalRecord = await server.getTaskState(taskId);
    assert.strictEqual(finalRecord.status, 'completed');
    assert.deepStrictEqual(finalRecord.result, {
      signals: [{ signal_agent_segment_id: 'sig_async', name: 'Async signal' }],
    });
  });

  it('async getProducts is visible via task tools and emits terminal webhook', async () => {
    let releaseTask;
    const unblockTask = new Promise(resolve => {
      releaseTask = resolve;
    });
    const emits = [];
    const platform = buildHitlPlatform({
      getProducts: async (_req, ctx) =>
        ctx.handoffToTask(async () => {
          await unblockTask;
          return {
            products: [{ product_id: 'p_async_pollable', name: 'pollable product' }],
            cache_scope: 'account',
          };
        }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'products-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
      taskWebhookEmitter: {
        emit: async params => {
          emits.push(params);
          return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
        },
      },
    });

    const submitted = await dispatchGetProducts(server, {
      push_notification_config: {
        url: 'https://buyer.example.com/webhook',
        token: 'webhook-token-1234',
        operation_id: 'op_products_async',
      },
    });
    assert.strictEqual(submitted.structuredContent.status, 'submitted');
    const taskId = submitted.structuredContent.task_id;
    assert.strictEqual(submitted.structuredContent.products, undefined);
    assert.strictEqual(submitted.structuredContent.proposals, undefined);

    const status = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_task_status',
        arguments: { task_id: taskId, include_result: true, account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(status.isError, true, JSON.stringify(status.structuredContent));
    assert.strictEqual(status.structuredContent.task_type, 'get_products');
    assert.strictEqual(status.structuredContent.protocol, 'media-buy');
    assert.strictEqual(status.structuredContent.status, 'submitted');
    assert.strictEqual(status.structuredContent.has_webhook, true);
    assert.strictEqual(status.structuredContent.result, undefined);

    const listed = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'list_tasks',
        arguments: {
          account: { account_id: 'acc_1' },
          filters: { task_ids: [taskId], task_type: 'get_products', has_webhook: true },
        },
      },
    });
    assert.notStrictEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
    assert.deepStrictEqual(
      listed.structuredContent.tasks.map(task => ({
        task_id: task.task_id,
        task_type: task.task_type,
        status: task.status,
        has_webhook: task.has_webhook,
      })),
      [{ task_id: taskId, task_type: 'get_products', status: 'submitted', has_webhook: true }]
    );

    releaseTask();
    await server.awaitTask(taskId);

    const completed = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_task_status',
        arguments: { task_id: taskId, include_result: true, account: { account_id: 'acc_1' } },
      },
    });
    assert.strictEqual(completed.structuredContent.status, 'completed');
    assert.deepStrictEqual(completed.structuredContent.result, {
      products: [{ product_id: 'p_async_pollable', name: 'pollable product' }],
      cache_scope: 'account',
    });
    assert.strictEqual(emits.length, 1, 'one get_products webhook emitted on terminal completion');
    assert.strictEqual(emits[0].payload.task_type, 'get_products');
    assert.strictEqual(emits[0].payload.task_id, taskId);
    assert.strictEqual(emits[0].payload.protocol, 'media-buy');
    assert.strictEqual(emits[0].payload.status, 'completed');
    assert.strictEqual(emits[0].payload.operation_id, 'op_products_async');
    assert.strictEqual(emits[0].payload.token, 'webhook-token-1234');
    assert.deepStrictEqual(emits[0].payload.result, {
      products: [{ product_id: 'p_async_pollable', name: 'pollable product' }],
      cache_scope: 'account',
    });
    assertMcpWebhookPayloadValid(emits[0].payload);
  });

  it('async getSignals is visible via task tools and emits terminal webhook', async () => {
    let releaseTask;
    const unblockTask = new Promise(resolve => {
      releaseTask = resolve;
    });
    const emits = [];
    const platform = {
      ...buildHitlPlatform(),
      sales: undefined,
      capabilities: {
        specialisms: ['signal-marketplace'],
        config: {},
      },
      signals: {
        getSignals: async (_req, ctx) =>
          ctx.handoffToTask(async () => {
            await unblockTask;
            return {
              signals: [{ signal_agent_segment_id: 'sig_pollable', name: 'Pollable signal' }],
            };
          }),
        activateSignal: async () => ({ deployments: [] }),
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'signals-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
      taskWebhookEmitter: {
        emit: async params => {
          emits.push(params);
          return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
        },
      },
    });

    const submitted = await dispatchGetSignals(server, {
      push_notification_config: {
        url: 'https://buyer.example.com/signals-webhook',
        token: 'signals-webhook-token-1234',
        operation_id: 'op_signals_async',
      },
    });
    assert.strictEqual(submitted.structuredContent.status, 'submitted');
    const taskId = submitted.structuredContent.task_id;
    assert.strictEqual(submitted.structuredContent.signals, undefined);

    const pending = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_task_status',
        arguments: { task_id: taskId, include_result: true, account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(pending.isError, true, JSON.stringify(pending.structuredContent));
    assert.strictEqual(pending.structuredContent.task_type, 'get_signals');
    assert.strictEqual(pending.structuredContent.protocol, 'signals');
    assert.strictEqual(pending.structuredContent.status, 'submitted');
    assert.strictEqual(pending.structuredContent.has_webhook, true);
    assert.strictEqual(pending.structuredContent.result, undefined);

    const listed = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'list_tasks',
        arguments: {
          account: { account_id: 'acc_1' },
          filters: { task_ids: [taskId], task_type: 'get_signals', has_webhook: true },
        },
      },
    });
    assert.notStrictEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
    assert.deepStrictEqual(
      listed.structuredContent.tasks.map(task => ({
        task_id: task.task_id,
        task_type: task.task_type,
        status: task.status,
        has_webhook: task.has_webhook,
      })),
      [{ task_id: taskId, task_type: 'get_signals', status: 'submitted', has_webhook: true }]
    );

    releaseTask();
    await server.awaitTask(taskId);

    const completed = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_task_status',
        arguments: { task_id: taskId, include_result: true, account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(completed.isError, true, JSON.stringify(completed.structuredContent));
    assert.strictEqual(completed.structuredContent.task_type, 'get_signals');
    assert.strictEqual(completed.structuredContent.protocol, 'signals');
    assert.strictEqual(completed.structuredContent.status, 'completed');
    assert.deepStrictEqual(completed.structuredContent.result, {
      signals: [{ signal_agent_segment_id: 'sig_pollable', name: 'Pollable signal' }],
    });
    assert.strictEqual(emits.length, 1, 'one get_signals webhook emitted on terminal completion');
    assert.strictEqual(emits[0].payload.task_type, 'get_signals');
    assert.strictEqual(emits[0].payload.task_id, taskId);
    assert.strictEqual(emits[0].payload.protocol, 'signals');
    assert.strictEqual(emits[0].payload.status, 'completed');
    assert.strictEqual(emits[0].payload.operation_id, 'op_signals_async');
    assert.strictEqual(emits[0].payload.token, 'signals-webhook-token-1234');
    assert.deepStrictEqual(emits[0].payload.result, {
      signals: [{ signal_agent_segment_id: 'sig_pollable', name: 'Pollable signal' }],
    });
    assertMcpWebhookPayloadValid(emits[0].payload);
  });

  it('rejects async discovery when account is omitted', async () => {
    const productsPlatform = {
      ...buildHitlPlatform({
        getProducts: async (_req, ctx) =>
          ctx.handoffToTask(async () => ({
            products: [{ product_id: 'p_async' }],
            cache_scope: 'public',
          })),
      }),
      accounts: {
        resolve: async ref =>
          ref == null ? null : { id: ref.account_id ?? 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    };
    const productsServer = createAdcpServerFromPlatform(productsPlatform, {
      name: 'products-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const products = await dispatchGetProducts(productsServer, { account: undefined });
    assert.strictEqual(products.isError, true);
    assert.strictEqual(products.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(products.structuredContent.adcp_error.field, 'account');

    const signalsPlatform = {
      ...buildHitlPlatform(),
      accounts: {
        resolve: async ref =>
          ref == null ? null : { id: ref.account_id ?? 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      sales: undefined,
      capabilities: { specialisms: ['signal-marketplace'], config: {} },
      signals: {
        getSignals: async (_req, ctx) => ctx.handoffToTask(async () => ({ signals: [] })),
        activateSignal: async () => ({ deployments: [] }),
      },
    };
    const signalsServer = createAdcpServerFromPlatform(signalsPlatform, {
      name: 'signals-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const signals = await dispatchGetSignals(signalsServer, { account: undefined });
    assert.strictEqual(signals.isError, true);
    assert.strictEqual(signals.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(signals.structuredContent.adcp_error.field, 'account');
  });

  it('rejects wholesale discovery push configs and task handoffs', async () => {
    let productHandlerCalls = 0;
    const productsPlatform = buildHitlPlatform({
      getProducts: async (_req, ctx) => {
        productHandlerCalls += 1;
        return ctx.handoffToTask(async () => ({ products: [], cache_scope: 'account' }));
      },
    });
    const productsServer = createAdcpServerFromPlatform(productsPlatform, {
      name: 'products-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const productsPush = await dispatchGetProducts(productsServer, {
      buying_mode: 'wholesale',
      brief: undefined,
      push_notification_config: { url: 'https://buyer.example.com/webhook' },
    });
    assert.strictEqual(productsPush.isError, true);
    assert.strictEqual(productsPush.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(productsPush.structuredContent.adcp_error.field, 'push_notification_config');
    assert.strictEqual(productHandlerCalls, 0, 'wholesale push config should fail before adapter dispatch');

    const productsHandoff = await dispatchGetProducts(productsServer, { buying_mode: 'wholesale', brief: undefined });
    assert.strictEqual(productsHandoff.isError, true);
    assert.strictEqual(productsHandoff.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(productsHandoff.structuredContent.adcp_error.field, 'buying_mode');

    const productsUndefinedPush = await dispatchGetProducts(productsServer, {
      buying_mode: 'wholesale',
      brief: undefined,
      push_notification_config: undefined,
    });
    assert.strictEqual(productsUndefinedPush.isError, true);
    assert.strictEqual(productsUndefinedPush.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(productsUndefinedPush.structuredContent.adcp_error.field, 'buying_mode');

    let signalHandlerCalls = 0;
    const signalsPlatform = {
      ...buildHitlPlatform(),
      sales: undefined,
      capabilities: { specialisms: ['signal-marketplace'], config: {} },
      signals: {
        getSignals: async (_req, ctx) => {
          signalHandlerCalls += 1;
          return ctx.handoffToTask(async () => ({ signals: [] }));
        },
        activateSignal: async () => ({ deployments: [] }),
      },
    };
    const signalsServer = createAdcpServerFromPlatform(signalsPlatform, {
      name: 'signals-hitl',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const signalsPush = await dispatchGetSignals(signalsServer, {
      discovery_mode: 'wholesale',
      brief: undefined,
      push_notification_config: { url: 'https://buyer.example.com/webhook' },
    });
    assert.strictEqual(signalsPush.isError, true);
    assert.strictEqual(signalsPush.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(signalsPush.structuredContent.adcp_error.field, 'push_notification_config');
    assert.strictEqual(signalHandlerCalls, 0, 'wholesale push config should fail before adapter dispatch');

    const signalsHandoff = await dispatchGetSignals(signalsServer, { discovery_mode: 'wholesale', brief: undefined });
    assert.strictEqual(signalsHandoff.isError, true);
    assert.strictEqual(signalsHandoff.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(signalsHandoff.structuredContent.adcp_error.field, 'discovery_mode');

    const signalsUndefinedPush = await dispatchGetSignals(signalsServer, {
      discovery_mode: 'wholesale',
      brief: undefined,
      push_notification_config: undefined,
    });
    assert.strictEqual(signalsUndefinedPush.isError, true);
    assert.strictEqual(signalsUndefinedPush.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(signalsUndefinedPush.structuredContent.adcp_error.field, 'discovery_mode');
  });

  it('createMediaBuy returning ctx.handoffToTask: submitted envelope, background completes terminal state', async () => {
    let capturedTaskId;
    const platform = buildHitlPlatform({
      createMediaBuy: async (req, ctx) =>
        ctx.handoffToTask(async taskCtx => {
          capturedTaskId = taskCtx.id;
          await new Promise(r => setTimeout(r, 30));
          return { media_buy_id: 'mb_final', status: 'active' };
        }),
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

  it('hybrid createMediaBuy: returns Success directly OR ctx.handoffToTask per call', async () => {
    // Same method handles both paths. Branch on a request signal
    // (here: a flag on req); buyer pattern-matches on response shape.
    const platform = buildHitlPlatform({
      createMediaBuy: async (req, ctx) => {
        if (req.buyer_ref === 'fast') {
          return {
            media_buy_id: 'mb_sync_fast',
            status: 'active',
            confirmed_at: new Date().toISOString(),
            packages: [],
          };
        }
        return ctx.handoffToTask(async () => {
          await new Promise(r => setTimeout(r, 20));
          return {
            media_buy_id: 'mb_hitl_slow',
            status: 'pending_creatives',
            confirmed_at: new Date().toISOString(),
            packages: [],
          };
        });
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'hybrid',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    // Fast path: returns Success directly. No task_id, has media_buy_id.
    const fastResult = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'fast',
          idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(fastResult.structuredContent.media_buy_id, 'mb_sync_fast');
    assert.strictEqual(fastResult.structuredContent.task_id, undefined);

    // Slow path: returns Submitted. Has task_id, no media_buy_id yet.
    const slowResult = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'slow',
          idempotency_key: '22222222-2222-2222-2222-222222222222',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(slowResult.structuredContent.status, 'submitted');
    assert.ok(slowResult.structuredContent.task_id);
    await server.awaitTask(slowResult.structuredContent.task_id);
    const finalSlow = await server.getTaskState(slowResult.structuredContent.task_id);
    assert.strictEqual(finalSlow.result.media_buy_id, 'mb_hitl_slow');
  });

  it('hand-rolled `{status:"submitted", task_id}` from createMediaBuy is rejected with a clear error pointing at ctx.handoffToTask', async () => {
    // Guards the most common LLM-scaffolded mistake: returning a bare
    // submitted-shape envelope instead of `ctx.handoffToTask(fn)`. The
    // framework owns the submitted envelope; an adopter that hand-rolls
    // it skips the task registry — the buyer ends up polling a task_id
    // the framework never registered. Fail loudly at dispatch.
    const platform = buildHitlPlatform({
      createMediaBuy: async () => ({ status: 'submitted', task_id: 'tk_hand_rolled_xyz' }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'guard',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCreate(server);
    // Errors thrown inside the handler bubble up as the framework's
    // generic SERVICE_UNAVAILABLE envelope; the message itself lands in
    // the server log. We assert on the error envelope + that the message
    // referenced `handoffToTask`.
    assert.strictEqual(result.isError, true);
    const text = JSON.stringify(result);
    assert.match(text, /handoffToTask/, 'error message must point at ctx.handoffToTask');
  });

  it('createMediaBuy handoff throwing AdcpError records terminal failed with structured fields', async () => {
    const platform = buildHitlPlatform({
      createMediaBuy: async (req, ctx) =>
        ctx.handoffToTask(async () => {
          await new Promise(r => setTimeout(r, 20));
          throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'operator declined' });
        }),
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

  it('createMediaBuy handoff throwing generic Error records terminal failed as SERVICE_UNAVAILABLE', async () => {
    const platform = buildHitlPlatform({
      createMediaBuy: async (req, ctx) =>
        ctx.handoffToTask(async () => {
          await new Promise(r => setTimeout(r, 20));
          throw new Error('upstream API timeout');
        }),
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  function withEnv(env, fn) {
    const prev = {};
    for (const k of Object.keys(env)) {
      prev[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(env)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
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
    // The 6.0.1 stateStore gate is parallel to the task-registry gate.
    // Both have their own ADCP_DECISIONING_ALLOW_INMEMORY_* ack flag. A
    // production deployment that opts into in-memory tasks AND in-memory
    // state must set both — they're separate footguns with separate
    // recoveries.
    withEnv(
      {
        NODE_ENV: 'production',
        ADCP_DECISIONING_ALLOW_INMEMORY_TASKS: '1',
        ADCP_DECISIONING_ALLOW_INMEMORY_STATE: '1',
      },
      () => {
        assert.doesNotThrow(() =>
          createAdcpServerFromPlatform(emptyPlatform(), {
            name: 't',
            version: '0',
            validation: { requests: 'off', responses: 'off' },
          })
        );
      }
    );
  });

  it('explicit taskRegistry provided → no NODE_ENV check', () => {
    const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');
    const { InMemoryStateStore } = require('../dist/lib/server/state-store');
    withEnv({ NODE_ENV: 'production' }, () => {
      assert.doesNotThrow(() =>
        createAdcpServerFromPlatform(emptyPlatform(), {
          name: 't',
          version: '0',
          taskRegistry: createInMemoryTaskRegistry(),
          // Explicit stateStore opt-in mirrors the explicit-taskRegistry
          // pattern this test exercises — both opt-outs have to be
          // exercised together for the production smoke check.
          stateStore: new InMemoryStateStore(),
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
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
      name: 'gap',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
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
      name: 'gap',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
          id: 'singleton',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
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
      name: 'gap',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
          id: 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
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
      name: 'gap',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
      name: 'gap',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.spend.total_spend, 1234.56);
  });

  it('getAccountFinancials threads resolved Account into ctx.account (#1145)', async () => {
    // Adopters fronting an upstream platform (Snap, Meta, retail-media)
    // need the resolved Account on `ctx.account` so they can read tokens
    // and upstream IDs from `ctx.account.ctx_metadata` without re-resolving.
    let receivedCtx;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_42',
          name: 'Acme via Pinnacle',
          status: 'active',
          ctx_metadata: { upstreamCustomerId: 'snap_cust_xyz', accessToken: 'secret_token_42' },
          authInfo: { kind: 'oauth' },
        }),
        getAccountFinancials: async (req, ctx) => {
          receivedCtx = ctx;
          return {
            account: { account_id: 'acc_42' },
            currency: 'USD',
            period: { start: '2026-04-01', end: '2026-04-30' },
            timezone: 'America/New_York',
            spend: { total_spend: 9.99, media_buy_count: 1 },
          };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap1',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_42' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(receivedCtx, 'getAccountFinancials was invoked');
    assert.ok(receivedCtx.account, 'ctx.account is populated');
    assert.strictEqual(receivedCtx.account.id, 'acc_42');
    assert.strictEqual(
      receivedCtx.account.ctx_metadata.upstreamCustomerId,
      'snap_cust_xyz',
      'adopter reads upstream IDs from ctx.account.ctx_metadata without re-resolving'
    );
    assert.strictEqual(receivedCtx.account.ctx_metadata.accessToken, 'secret_token_42');
  });

  it('getAccountFinancials retries via refreshToken on AUTH_REQUIRED then succeeds (#1145)', async () => {
    // UA's case: upstream platform token expires mid-call. Adapter
    // throws AuthRequiredError (legacy AUTH_REQUIRED), framework calls
    // refreshToken, mutates account.authInfo.token, retries once.
    const { AuthRequiredError } = require('../dist/lib/server');
    let attempt = 0;
    let refreshArgs;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_42',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'expired_token' },
        }),
        getAccountFinancials: async (req, ctx) => {
          attempt += 1;
          if (attempt === 1) {
            assert.strictEqual(ctx.account.authInfo.token, 'expired_token', 'first call sees the stale token');
            throw new AuthRequiredError({ message: 'token expired upstream' });
          }
          assert.strictEqual(ctx.account.authInfo.token, 'fresh_token', 'retry sees the refreshed token');
          return {
            account: { account_id: 'acc_42' },
            currency: 'USD',
            period: { start: '2026-04-01', end: '2026-04-30' },
            timezone: 'America/New_York',
            spend: { total_spend: 5.5, media_buy_count: 1 },
          };
        },
        refreshToken: async (account, reason) => {
          refreshArgs = { accountId: account.id, reason };
          return { token: 'fresh_token' };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_42' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(attempt, 2, 'platform method ran twice (initial + retry)');
    assert.deepStrictEqual(refreshArgs, { accountId: 'acc_42', reason: 'auth_required' });
    assert.strictEqual(result.structuredContent.spend.total_spend, 5.5);
  });

  it('getAccountFinancials retries via refreshToken on AuthMissingError then succeeds (adcp#3730)', async () => {
    const { AuthMissingError } = require('../dist/lib/server');
    let attempt = 0;
    let refreshArgs;
    const sharedResolvedAccount = {
      id: 'acc_missing',
      name: 'Acme',
      status: 'active',
      ctx_metadata: {},
    };
    const platform = buildPlatform({
      accounts: {
        resolve: async () => sharedResolvedAccount,
        getAccountFinancials: async (req, ctx) => {
          attempt += 1;
          if (attempt === 1) {
            assert.strictEqual(ctx.account.authInfo, undefined, 'first call has no upstream credential');
            throw new AuthMissingError({ message: 'Authorization header missing on upstream request' });
          }
          assert.strictEqual(ctx.account.authInfo.kind, 'oauth');
          assert.strictEqual(ctx.account.authInfo.token, 'fresh_token');
          assert.strictEqual(ctx.account.authInfo.expiresAt, 1800000000000);
          return {
            account: { account_id: 'acc_missing' },
            currency: 'USD',
            period: { start: '2026-04-01', end: '2026-04-30' },
            timezone: 'America/New_York',
            spend: { total_spend: 4.25, media_buy_count: 1 },
          };
        },
        refreshToken: async (account, reason) => {
          refreshArgs = { accountId: account.id, reason };
          return { token: 'fresh_token', expiresAt: 1800000000000 };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'auth-missing-refresh',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_missing' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(attempt, 2, 'platform method ran twice (initial + retry)');
    assert.deepStrictEqual(refreshArgs, { accountId: 'acc_missing', reason: 'auth_required' });
    assert.strictEqual(result.structuredContent.spend.total_spend, 4.25);
    assert.strictEqual(
      sharedResolvedAccount.authInfo,
      undefined,
      'refresh writes to request-local account clone, not resolver-owned object'
    );
  });

  it('getAccountFinancials refresh does not alias resolver-owned authInfo (adcp#3730)', async () => {
    const { AuthRequiredError } = require('../dist/lib/server');
    let attempt = 0;
    const sharedResolvedAccount = {
      id: 'acc_stale',
      name: 'Acme',
      status: 'active',
      ctx_metadata: { nested: { upstreamAccountId: 'upstream-1' } },
      authInfo: { kind: 'oauth', token: 'stale_token', claims: { sub: 'buyer-1' } },
    };
    const platform = buildPlatform({
      accounts: {
        resolve: async () => sharedResolvedAccount,
        getAccountFinancials: async (req, ctx) => {
          attempt += 1;
          if (attempt === 1) {
            assert.strictEqual(ctx.account.authInfo.token, 'stale_token');
            assert.deepStrictEqual(ctx.account.authInfo.claims, { sub: 'buyer-1' });
            throw new AuthRequiredError({ message: 'token expired upstream' });
          }
          assert.strictEqual(ctx.account.authInfo.token, 'fresh_token');
          ctx.account.authInfo.claims.sub = 'request-local';
          ctx.account.ctx_metadata.nested.upstreamAccountId = 'request-local-upstream';
          return {
            account: { account_id: 'acc_stale' },
            currency: 'USD',
            period: { start: '2026-04-01', end: '2026-04-30' },
            timezone: 'America/New_York',
            spend: { total_spend: 8.75, media_buy_count: 1 },
          };
        },
        refreshToken: async () => ({ token: 'fresh_token' }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'auth-refresh-request-local',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_stale' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(attempt, 2, 'platform method ran twice (initial + retry)');
    assert.strictEqual(result.structuredContent.spend.total_spend, 8.75);
    assert.deepStrictEqual(
      sharedResolvedAccount.authInfo,
      { kind: 'oauth', token: 'stale_token', claims: { sub: 'buyer-1' } },
      'refresh writes to a request-local authInfo clone, not resolver-owned authInfo'
    );
    assert.deepStrictEqual(
      sharedResolvedAccount.ctx_metadata,
      { nested: { upstreamAccountId: 'upstream-1' } },
      'request-local account clone does not alias nested resolver-owned metadata'
    );
  });

  it('getAccountFinancials projects AuthMissingError to AUTH_MISSING when refreshToken is absent (adcp#3730)', async () => {
    const { AuthMissingError } = require('../dist/lib/server');
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_missing_no_refresh',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'refreshable_token' },
        }),
        getAccountFinancials: async () => {
          throw new AuthMissingError({ message: 'Authorization header missing on upstream request' });
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'auth-missing-no-refresh',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_missing_no_refresh' } } },
    });
    assert.strictEqual(result.isError, true);
    const wire = JSON.stringify(result.structuredContent);
    assert.match(wire, /AUTH_MISSING/);
    assert.match(wire, /correctable/);
    assert.doesNotMatch(wire, /AUTH_REQUIRED/);
  });

  it('getAccountFinancials surfaces correctable AUTH_REQUIRED when refreshToken itself throws (#1145)', async () => {
    // Refresh failure means the upstream authorization is gone — the
    // account isn't currently authorized. Buyer re-links via their UI;
    // recovery: 'correctable'. NOT SERVICE_UNAVAILABLE — that would
    // imply transient retry, but the underlying state won't fix itself.
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome.js');
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_42',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'expired_token' },
        }),
        getAccountFinancials: async () => {
          throw new AdcpError('AUTH_REQUIRED', { message: 'token expired', recovery: 'correctable' });
        },
        refreshToken: async () => {
          throw new Error('refresh endpoint returned 403');
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2-fail',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_42' } } },
    });
    assert.strictEqual(result.isError, true);
    const error = result.structuredContent.errors?.[0] ?? result.structuredContent;
    const wire = JSON.stringify(error);
    assert.match(wire, /AUTH_REQUIRED/);
    assert.match(wire, /correctable/);
    // Inner exception text is intentionally NOT echoed on the wire —
    // see the leak-prevention test below for the security rationale.
    assert.doesNotMatch(wire, /refresh endpoint returned 403/);
  });

  it('getAccountFinancials retry that also throws AUTH_REQUIRED bubbles without a third call (#1145)', async () => {
    // Refresh-then-retry is a single-shot. If the retry also throws
    // AUTH_REQUIRED (e.g., refreshed token was already invalidated by
    // a concurrent revoke), the error bubbles directly to the buyer
    // without a second refresh attempt. Adopters should NOT see the
    // refresh hook fire twice for one request.
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome.js');
    let attempt = 0;
    let refreshCalls = 0;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_x',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'tok' },
        }),
        getAccountFinancials: async () => {
          attempt += 1;
          throw new AdcpError('AUTH_REQUIRED', { message: 'still expired', recovery: 'correctable' });
        },
        refreshToken: async () => {
          refreshCalls += 1;
          return { token: 'fresh_but_already_invalidated' };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2-double',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_x' } } },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(attempt, 2, 'platform method ran twice (initial + one retry)');
    assert.strictEqual(refreshCalls, 1, 'refresh fired exactly once');
  });

  it('refresh-failure error message does NOT echo upstream exception text on the wire (#1145)', async () => {
    // Security: refresh-fn exception text routinely embeds refresh-token
    // prefixes, internal hostnames, and OAuth provider error codes that
    // shouldn't cross to the buyer. The framework projects a fixed
    // message; adopters log inner details server-side.
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome.js');
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_y',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'tok' },
        }),
        getAccountFinancials: async () => {
          throw new AdcpError('AUTH_REQUIRED', { message: 'expired', recovery: 'correctable' });
        },
        refreshToken: async () => {
          // Realistic upstream OAuth-lib-style throw — embeds a
          // refresh-token-like prefix and an internal hostname.
          throw new Error('invalid_grant: rt=1//0gAbCdEfG... at idp.internal.corp:8443');
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2-leak',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_y' } } },
    });
    assert.strictEqual(result.isError, true);
    const wire = JSON.stringify(result.structuredContent);
    assert.match(wire, /AUTH_REQUIRED/);
    assert.match(wire, /correctable/);
    assert.doesNotMatch(wire, /invalid_grant/, 'upstream OAuth error code MUST NOT cross to wire');
    assert.doesNotMatch(wire, /idp\.internal\.corp/, 'internal hostname MUST NOT cross to wire');
    assert.doesNotMatch(wire, /1\/\/0g/, 'refresh-token prefix MUST NOT cross to wire');
  });

  it('AUTH_INVALID bypasses the refresh hook entirely — no SSO retry-storm (adcp#3730)', async () => {
    // Regression-trip wire for the AUTH split: AUTH_INVALID means
    // "credentials were presented and rejected" — refreshing and retrying
    // would be the SSO retry-storm pattern the spec split this code to
    // prevent. The REFRESHABLE_AUTH_CODES allowlist in from-platform.ts
    // must NOT include AUTH_INVALID. This test pins that contract against
    // accidental widening; a future contributor who thinks "symmetric
    // with AUTH_MISSING" and adds AUTH_INVALID to the set breaks this
    // test loudly.
    const { AuthInvalidError } = require('../dist/lib/server');
    let attempt = 0;
    let refreshCalls = 0;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_invalid',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'revoked_token' },
        }),
        getAccountFinancials: async () => {
          attempt += 1;
          throw new AuthInvalidError({ message: 'credentials rejected' });
        },
        refreshToken: async () => {
          refreshCalls += 1;
          return { token: 'should_never_be_used' };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'auth-invalid-no-refresh',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_invalid' } } },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(attempt, 1, 'platform method ran exactly once — no retry');
    assert.strictEqual(refreshCalls, 0, 'refresh hook MUST NOT fire on AUTH_INVALID');
    const wire = JSON.stringify(result.structuredContent);
    assert.match(wire, /AUTH_INVALID/, 'AUTH_INVALID propagates to the wire envelope unchanged');
    assert.match(wire, /terminal/, 'recovery: terminal is preserved on the wire');
  });

  it('refreshToken successful refresh writes expiresAt onto account.authInfo (#1145)', async () => {
    // Adopters reading `ctx.account.authInfo.expiresAt` after a refresh
    // see the new expiry. The contract anchors proactive-refresh
    // patterns (not yet wired but the field is reachable today).
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome.js');
    let lastSeenExpiresAt;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_z',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'old' },
        }),
        getAccountFinancials: async (req, ctx) => {
          if (ctx.account.authInfo.token === 'old') {
            throw new AdcpError('AUTH_REQUIRED', { message: 'expired', recovery: 'correctable' });
          }
          lastSeenExpiresAt = ctx.account.authInfo.expiresAt;
          return {
            account: { account_id: 'acc_z' },
            currency: 'USD',
            period: { start: '2026-04-01', end: '2026-04-30' },
            timezone: 'America/New_York',
            spend: { total_spend: 1, media_buy_count: 1 },
          };
        },
        refreshToken: async () => ({ token: 'fresh', expiresAt: 1800000000000 }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2-expires',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_z' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(lastSeenExpiresAt, 1800000000000, 'expiresAt is reachable on retry call');
  });

  it('refreshToken hook receives Account with adopter ctx_metadata typed (#1168)', async () => {
    // Sentinel for #1168 — RefreshConfig is parametric over TCtxMeta.
    // The adopter's refreshToken impl reads Account.ctx_metadata fields
    // directly (e.g., the upstream refresh-token cached on the account).
    // Before #1168, RefreshConfig.account was Account<unknown>, so this
    // access compiled but adopters lost type safety on field names.
    // After #1168, the type flows through projectSync → runWithTokenRefresh
    // → the hook signature.
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome.js');
    let seenUpstreamRefreshToken;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_typed',
          name: 'Acme',
          status: 'active',
          // Adopter's typed metadata shape — refreshToken hook reads
          // upstreamRefreshToken from this without a cast.
          ctx_metadata: { upstreamRefreshToken: 'rt_abc123', upstreamCustomerId: 'cust_42' },
          authInfo: { kind: 'oauth', token: 'access_old' },
        }),
        getAccountFinancials: async (req, ctx) => {
          if (ctx.account.authInfo.token === 'access_old') {
            throw new AdcpError('AUTH_REQUIRED', { message: 'expired', recovery: 'correctable' });
          }
          return {
            account: { account_id: 'acc_typed' },
            currency: 'USD',
            period: { start: '2026-04-01', end: '2026-04-30' },
            timezone: 'America/New_York',
            spend: { total_spend: 1, media_buy_count: 1 },
          };
        },
        refreshToken: async account => {
          // Adopter reads typed ctx_metadata directly. Before #1168 this
          // was effectively `(account.ctx_metadata as Record<string, unknown>).upstreamRefreshToken`
          // because TCtxMeta collapsed to unknown at the framework boundary.
          seenUpstreamRefreshToken = account.ctx_metadata.upstreamRefreshToken;
          return { token: `access_new_for_${account.ctx_metadata.upstreamCustomerId}` };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2-typed',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_typed' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(seenUpstreamRefreshToken, 'rt_abc123', 'refresh hook read typed ctx_metadata field');
  });

  it('getAccountFinancials does not retry on non-AUTH errors (#1145)', async () => {
    // Refresh hook is reactive only to refreshable auth codes
    // (AUTH_REQUIRED / AUTH_MISSING). INVALID_REQUEST, PERMISSION_DENIED,
    // etc. flow through unchanged — refresh is a narrow signal, not a
    // generic retry.
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome.js');
    let refreshCalled = false;
    let attempt = 0;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_42',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          authInfo: { kind: 'oauth', token: 'tok' },
        }),
        getAccountFinancials: async () => {
          attempt += 1;
          throw new AdcpError('INVALID_REQUEST', { message: 'bad period', recovery: 'correctable' });
        },
        refreshToken: async () => {
          refreshCalled = true;
          return { token: 'new' };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap2-nonauth',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'acc_42' } } },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(attempt, 1, 'no retry on non-AUTH error');
    assert.strictEqual(refreshCalled, false, 'refreshToken not called for non-AUTH error');
  });

  it('getAccountFinancials surfaces ACCOUNT_NOT_FOUND when accounts.resolve returns null', async () => {
    let getFinancialsCalled = false;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => null,
        getAccountFinancials: async () => {
          getFinancialsCalled = true;
          return {};
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'gap1-nf',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_account_financials', arguments: { account: { account_id: 'unknown' } } },
    });
    assert.strictEqual(result.isError, true, 'unresolvable account surfaces an error');
    assert.strictEqual(getFinancialsCalled, false, 'getAccountFinancials does not run on unresolved account');
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

  it('opts.accounts.syncAccounts runs when platform.accounts.upsert is undefined (no UNSUPPORTED_FEATURE shadow)', async () => {
    // Regression: the framework previously emitted an UNSUPPORTED_FEATURE
    // stub for syncAccounts whenever platform.accounts.upsert was undefined.
    // Under the merge seam (platform-derived wins per-key), that stub
    // shadowed adopter-supplied opts.accounts.syncAccounts fillers — every
    // mutating sync_accounts call returned UNSUPPORTED_FEATURE even though
    // the adopter had wired a working handler. Fixed by gating the
    // platform-derived handler on whether `accounts.upsert` is defined.
    let sawCall;
    const platform = buildPlatform({
      // Note: NO upsert/list defined on platform.accounts — the v6.0 platform
      // doesn't model these methods, so adopters fill via opts.accounts.
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'merged',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      accounts: {
        syncAccounts: async (params, ctx) => {
          sawCall = { params, account: ctx.account };
          return {
            accounts: [{ brand: { domain: 'acme.com' }, operator: 'acme.com', action: 'created', status: 'active' }],
          };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          account: { account_id: 'acc_1' },
          accounts: [{ brand: { domain: 'acme.com' }, operator: 'acme.com' }],
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.ok(sawCall, 'opts.accounts.syncAccounts MUST run when platform.accounts.upsert is undefined');
    assert.strictEqual(result.structuredContent.accounts[0].brand.domain, 'acme.com');
  });

  it('opts.accounts.listAccounts runs when platform.accounts.list is undefined', async () => {
    let sawCall = false;
    const platform = buildPlatform({
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'merged',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      accounts: {
        listAccounts: async () => {
          sawCall = true;
          return { accounts: [], next_cursor: undefined };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(sawCall, 'opts.accounts.listAccounts MUST run when platform.accounts.list is undefined');
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
          cache_scope: 'account',
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
        getProducts: async () => ({
          products: [
            {
              product_id: 'opts_should_lose',
              name: 'opts',
              description: '',
              format_ids: [],
              delivery_type: 'non_guaranteed',
              publisher_properties: { reportable: true },
              reporting_capabilities: { available_dimensions: [] },
              pricing_options: [],
            },
          ],
          cache_scope: 'account',
        }),
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
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
      name: 'rm',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
          id: 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        logEvent: async () => ({ success: true }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'rm',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        syncEventSources: async () => ({ event_sources: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'rm',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
      name: 'cs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async () => ({ media_buys: [] }), // platform now models it
      },
    });
    createAdcpServerFromPlatform(platform, {
      name: 'collide',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      logger: {
        debug: () => {},
        info: () => {},
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    });
    assert.throws(
      () =>
        createAdcpServerFromPlatform(platform, {
          name: 'collide',
          version: '0.0.1',
          validation: { requests: 'off', responses: 'off' },
          mergeSeam: 'strict',
          mediaBuy: {
            getMediaBuys: async () => ({ media_buys: [] }),
          },
        }),
      /opts\.mediaBuy.*shadowed/
    );
  });

  it('log-once mode: first construction warns, subsequent identical-collision constructions stay silent', () => {
    const { _resetMergeSeamDedupe } = require('../dist/lib/server/decisioning/runtime/from-platform');
    _resetMergeSeamDedupe();

    function buildCollidingPlatform() {
      return buildPlatform({
        sales: {
          getProducts: async () => ({ products: [], cache_scope: 'account' }),
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
      name: 't1',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      mergeSeam: 'log-once',
      logger: { debug: () => {}, info: () => {}, warn: m => warnings1.push(m), error: () => {} },
      mediaBuy: { getMediaBuys: async () => ({ media_buys: [] }) },
    });

    createAdcpServerFromPlatform(buildCollidingPlatform(), {
      name: 't2',
      version: '0.0.1',
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    });
    assert.doesNotThrow(() =>
      createAdcpServerFromPlatform(platform, {
        name: 'silent',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
        mergeSeam: 'silent',
        logger: {
          debug: () => {},
          info: () => {},
          warn: msg => warnings.push(msg),
          error: () => {},
        },
        mediaBuy: { getMediaBuys: async () => ({ media_buys: [] }) },
      })
    );
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
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: (_req, ctx) => ctx.handoffToTask(async () => taskFn()),
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
      name: 'obs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: {
        onAccountResolve: info => calls.push(info),
      },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: { brief: 'x', promoted_offering: 'y', account: { account_id: 'acc_1' } },
      },
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
        resolve: async () => ({
          id: 'singleton',
          name: 'X',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        providePerformanceFeedback: async () => ({ success: true }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs',
      version: '0.0.1',
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
      name: 'obs',
      version: '0.0.1',
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
          buyer_ref: 'b1',
          idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
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

  it('onTaskTransition fires REGISTRY_WRITE_FAILED when registry.complete throws', async () => {
    // Adopter *Task succeeds but the registry write blows up (DB outage,
    // disk-full, etc.). Framework logs at error level, fires
    // onTaskTransition with synthetic errorCode='REGISTRY_WRITE_FAILED'
    // (so SREs wiring DD/Prom on transitions see the metric, not just
    // the log line), and skips webhook delivery (buyer state would be
    // inconsistent if we pushed without a registry record).
    const transitions = [];
    const emits = [];
    const errors = [];
    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_42' }));
    const flakyRegistry = (() => {
      const inner = require('../dist/lib/server/decisioning/runtime/task-registry').createInMemoryTaskRegistry();
      return {
        ...inner,
        create: opts => inner.create(opts),
        getTask: id => inner.getTask(id),
        complete: async () => {
          throw new Error('connection refused');
        },
        fail: (id, err) => inner.fail(id, err),
        _registerBackground: (id, p) => inner._registerBackground(id, p),
        awaitTask: id => inner.awaitTask(id),
      };
    })();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskRegistry: flakyRegistry,
      taskWebhookEmitter: {
        emit: async params => {
          emits.push(params);
          return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
        },
        unsigned: true,
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: m => errors.push(m) },
      observability: { onTaskTransition: info => transitions.push(info) },
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
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(transitions.length, 1);
    assert.strictEqual(transitions[0].status, 'failed');
    assert.strictEqual(transitions[0].errorCode, 'REGISTRY_WRITE_FAILED');
    assert.strictEqual(emits.length, 0, 'no webhook delivered when registry write failed');
    assert.ok(
      errors.find(e => e.includes('registry write failed')),
      'error logged'
    );
  });

  it('onTaskTransition status="failed" carries errorCode on AdcpError', async () => {
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
    const transitions = [];
    const platform = buildHitlPlatform(async () => {
      throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'denied' });
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      observability: { onTaskTransition: info => transitions.push(info) },
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
      name: 'obs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: {
        emit: async params => ({
          operation_id: params.operation_id,
          idempotency_key: 'k',
          attempts: 1,
          delivered: true,
          errors: [],
        }),
      },
      observability: { onWebhookEmit: info => emits.push(info) },
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
      name: 'obs',
      version: '0.0.1',
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
      name: 'obs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      logger: { debug: () => {}, info: () => {}, warn: m => warns.push(m), error: () => {} },
      observability: {
        onAccountResolve: () => {
          throw new Error('telemetry exploded');
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: { brief: 'x', promoted_offering: 'y', account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(result.isError, true, 'dispatch succeeded despite hook throw');
    const hookWarn = warns.find(w => w.includes('observability hook onAccountResolve threw'));
    assert.ok(hookWarn, `expected hook-throw warning, got: ${JSON.stringify(warns)}`);
  });

  it('hook async rejections are caught and logged — dispatch unaffected', async () => {
    // safeFire must catch promise rejections from accidentally-async hooks.
    // If an adopter writes `onAccountResolve: async () => { throw }`, the
    // returned promise rejects out-of-band; without the .catch in safeFire
    // the process logs 'UnhandledPromiseRejection' and may exit on
    // node --unhandled-rejections=strict.
    const warns = [];
    const platform = buildPlatform();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'obs',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      logger: { debug: () => {}, info: () => {}, warn: m => warns.push(m), error: () => {} },
      observability: {
        onAccountResolve: async () => {
          throw new Error('async telemetry exploded');
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: { brief: 'x', promoted_offering: 'y', account: { account_id: 'acc_1' } },
      },
    });
    assert.notStrictEqual(result.isError, true, 'dispatch succeeded despite async hook rejection');
    // Allow microtask queue to flush so the rejection .catch runs.
    await new Promise(r => setImmediate(r));
    const hookWarn = warns.find(w => w.includes('onAccountResolve') && w.includes('rejected promise'));
    assert.ok(hookWarn, `expected async hook-rejection warning, got: ${JSON.stringify(warns)}`);
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
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: (_req, ctx) => ctx.handoffToTask(async () => taskFn()),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  it('emits webhook on completed task with push_notification_config operation_id', async () => {
    const emits = [];
    const fakeEmitter = {
      emit: async params => {
        emits.push(params);
        return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
      },
    };

    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook',
      version: '0.0.1',
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
          push_notification_config: {
            url: 'https://buyer.example.com/webhook',
            token: 'webhook-token-1234',
            operation_id: 'op_webhook_test',
          },
        },
      },
    });

    assert.strictEqual(result.structuredContent.status, 'submitted');
    const taskId = result.structuredContent.task_id;
    await server.awaitTask(taskId);

    assert.strictEqual(emits.length, 1, 'one webhook emitted on terminal completion');
    const emit = emits[0];
    assert.strictEqual(emit.url, 'https://buyer.example.com/webhook');
    // Spec-flat envelope (mcp-webhook-payload.json): top-level task_id /
    // task_type / status / timestamp / idempotency_key / protocol; result
    // carries the success-arm body.
    assert.strictEqual(emit.payload.task_id, taskId);
    assert.strictEqual(emit.payload.task_type, 'create_media_buy');
    assert.strictEqual(emit.payload.operation_id, 'op_webhook_test');
    assert.strictEqual(emit.payload.status, 'completed');
    assert.strictEqual(emit.payload.protocol, 'media-buy');
    assert.ok(typeof emit.payload.idempotency_key === 'string' && emit.payload.idempotency_key.length >= 16);
    assert.ok(typeof emit.payload.timestamp === 'string');
    assert.deepStrictEqual(emit.payload.result, { media_buy_id: 'mb_42', status: 'active' });
    assert.strictEqual(emit.payload.token, 'webhook-token-1234');
    assert.match(emit.operation_id, new RegExp(`^task-webhook:acc_1:create_media_buy:${taskId}$`));
    assert.notStrictEqual(emit.operation_id, 'op_webhook_test');
    assertMcpWebhookPayloadValid(emit.payload);
  });

  it('treats webhook URL as opaque when push config omits operation_id', async () => {
    const emits = [];
    const fakeEmitter = {
      emit: async params => {
        emits.push(params);
        return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
      },
    };

    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook',
      version: '0.0.1',
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
          push_notification_config: {
            url: 'https://buyer.example.com/step/create_media_buy/op_url_must_not_be_parsed',
            token: 'webhook-token-1234',
          },
        },
      },
    });

    assert.strictEqual(result.structuredContent.status, 'submitted');
    await server.awaitTask(result.structuredContent.task_id);

    assert.strictEqual(emits.length, 1, 'one webhook emitted on terminal completion');
    assert.ok(emits[0].payload.operation_id.startsWith('create_media_buy.'));
    assert.match(emits[0].operation_id, /^task-webhook:acc_1:create_media_buy:task_/);
    assert.notStrictEqual(emits[0].payload.operation_id, 'op_url_must_not_be_parsed');
    assert.notStrictEqual(emits[0].operation_id, 'op_url_must_not_be_parsed');
    assertMcpWebhookPayloadValid(emits[0].payload);
  });

  it('emits webhook on failed task with structured error', async () => {
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
    const emits = [];
    const fakeEmitter = {
      emit: async params => {
        emits.push(params);
        return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
      },
    };

    const platform = buildHitlPlatform(async () => {
      throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'op declined' });
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook',
      version: '0.0.1',
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
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);

    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].payload.status, 'failed');
    assert.deepStrictEqual(emits[0].payload.result.errors[0].code, 'GOVERNANCE_DENIED');
    assert.strictEqual(emits[0].payload.message, 'op declined');
    assert.strictEqual(emits[0].payload.token, undefined, "token omitted when buyer didn't supply one");
  });

  it('does not emit webhook when push_notification_config is absent', async () => {
    const emits = [];
    const fakeEmitter = {
      emit: async params => {
        emits.push(params);
        return { operation_id: params.operation_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
      },
    };
    const platform = buildHitlPlatform(async () => ({ media_buy_id: 'mb_silent' }));
    const server = createAdcpServerFromPlatform(platform, {
      name: 'webhook',
      version: '0.0.1',
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
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);

    assert.strictEqual(emits.length, 0, "no webhook when buyer didn't opt in");
  });
});

describe('Push notification webhook URL/token validation (B5/B6)', () => {
  // SSRF + token-replay hardening on the buyer-supplied
  // push_notification_config.url / token.

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
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: (_req, ctx) => ctx.handoffToTask(async () => taskFn()),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  async function dispatchWithPushConfig(server, pushNotificationConfig) {
    return server.dispatchTestRequest({
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
          push_notification_config: pushNotificationConfig,
        },
      },
    });
  }

  async function dispatchWithUrl(server, url, token) {
    return dispatchWithPushConfig(server, { url, ...(token != null && { token }) });
  }

  function makeServer({ warns, emits } = {}) {
    return createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_1' })),
      {
        name: 'ssrf',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
        logger: warns ? { debug: () => {}, info: () => {}, warn: m => warns.push(m), error: () => {} } : undefined,
        taskWebhookEmitter: emits
          ? {
              emit: async params => {
                emits.push(params);
                return {
                  operation_id: params.operation_id,
                  idempotency_key: 'k',
                  attempts: 1,
                  delivered: true,
                  errors: [],
                };
              },
            }
          : undefined,
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
    ['IPv6 unique-local with brackets', 'https://[fc00::1]/hook', 'IPv6 unique-local'],
    ['IPv6 link-local with brackets', 'https://[fe80::1]/hook', 'IPv6 link-local'],
    ['IPv4-mapped IPv6 dotted (loopback)', 'https://[::ffff:127.0.0.1]/hook', 'IPv4-mapped IPv6'],
    ['IPv4-mapped IPv6 hex (loopback)', 'https://[::ffff:7f00:1]/hook', 'IPv4-mapped IPv6'],
    // Node's WHATWG URL parser canonicalizes alternate IPv4 forms to
    // dotted-decimal before our regex checks see them — `2130706433`,
    // `0x7f000001`, and `0177.0.0.1` all parse to host `127.0.0.1`. So
    // they hit the loopback range check, not the alternate-form rejectors.
    // Either way they're rejected; that's what matters.
    ['integer-form IPv4 (2130706433 = 127.0.0.1)', 'https://2130706433/hook', 'loopback range 127/8'],
    ['hex-form IPv4 (0x7f000001 = 127.0.0.1)', 'https://0x7f000001/hook', 'loopback range 127/8'],
    ['octal-form IPv4 (0177.0.0.1 = 127.0.0.1)', 'https://0177.0.0.1/hook', 'loopback range 127/8'],
    ['localhost', 'https://localhost/hook', 'host "localhost" rejected'],
    ['unsupported scheme', 'file:///etc/passwd', 'unsupported scheme "file:"'],
    ['malformed URL', 'not a url', 'malformed URL'],
  ]) {
    it(`rejects ${label}: ${url}`, async () => {
      const warns = [];
      const emits = [];
      const server = makeServer({ warns, emits });
      const result = await dispatchWithUrl(server, url);
      // Spec posture: fail fast with INVALID_REQUEST so buyers see the
      // bad config at the request boundary instead of waiting for
      // never-fired webhooks. (Was silent-skip before round-3 DX review.)
      assert.strictEqual(result.isError, true, 'task rejected upfront with INVALID_REQUEST');
      assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.strictEqual(result.structuredContent.adcp_error.field, 'push_notification_config.url');
      assert.ok(
        result.structuredContent.adcp_error.message.includes(reasonFragment),
        `expected rejection reason "${reasonFragment}", got: ${result.structuredContent.adcp_error.message}`
      );
      assert.strictEqual(emits.length, 0, 'no webhook delivered to rejected URL');
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

  it('rejects empty token', async () => {
    const emits = [];
    const server = makeServer({ emits });
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', '');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'push_notification_config.token');
    assert.ok(result.structuredContent.adcp_error.message.includes('empty'));
    assert.strictEqual(emits.length, 0);
  });

  it('rejects token over 255 chars', async () => {
    const emits = [];
    const server = makeServer({ emits });
    const longToken = 'a'.repeat(300);
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', longToken);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.ok(result.structuredContent.adcp_error.message.includes('longer than'));
    assert.strictEqual(emits.length, 0);
  });

  it('rejects token with control characters', async () => {
    const emits = [];
    const server = makeServer({ emits });
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', 'tok\x00\x01with-controls');
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.ok(result.structuredContent.adcp_error.message.includes('control characters'));
    assert.strictEqual(emits.length, 0);
  });

  for (const [label, operationId, reasonFragment] of [
    ['non-string operation_id', 123, 'must be a string'],
    ['empty operation_id', '', 'must match'],
    ['operation_id over 255 chars', 'a'.repeat(256), 'must match'],
    ['operation_id with invalid character', 'op/bad', 'must match'],
    ['operation_id with control character', 'op_\n_bad', 'must match'],
  ]) {
    it(`rejects ${label}`, async () => {
      const emits = [];
      const server = makeServer({ emits });
      const result = await dispatchWithPushConfig(server, {
        url: 'https://buyer.example.com/webhook',
        operation_id: operationId,
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.strictEqual(result.structuredContent.adcp_error.field, 'push_notification_config.operation_id');
      assert.ok(
        result.structuredContent.adcp_error.message.includes(reasonFragment),
        `expected rejection reason "${reasonFragment}", got: ${result.structuredContent.adcp_error.message}`
      );
      assert.strictEqual(emits.length, 0);
    });
  }

  it('accepts a well-formed token', async () => {
    const emits = [];
    const server = makeServer({ emits });
    const result = await dispatchWithUrl(server, 'https://buyer.example.com/webhook', 'tok_abc-123:xyz.456');
    await server.awaitTask(result.structuredContent.task_id);
    assert.strictEqual(emits.length, 1);
    assert.strictEqual(emits[0].payload.token, 'tok_abc-123:xyz.456');
  });
});

describe('tasks_get wire tool (B9)', () => {
  // Buyer-facing polling path for HITL task lifecycle. The framework
  // registers a `tasks_get` custom tool automatically; buyers call it with
  // task_id (+ optional account for tenant scoping) and receive the
  // spec-flat lifecycle shape.

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
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: (_req, ctx) => ctx.handoffToTask(async () => taskFn()),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_42' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  async function createTask(server, accountId) {
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
          account: { account_id: accountId },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);
    return result.structuredContent.task_id;
  }

  it('advertises only the MCP-safe tasks_get tool name', async () => {
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_42' })),
      {
        name: 'p',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const listed = await server.dispatchTestRequest({ method: 'tools/list' });
    const toolNames = listed.tools.map(tool => tool.name);
    assert.ok(toolNames.includes('tasks_get'), 'tasks_get should be advertised');
    assert.ok(!toolNames.includes('tasks/get'), 'slash alias should not be registered as an MCP tool');
  });

  it('returns spec-flat lifecycle shape for a completed task', async () => {
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' })),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createTask(server, 'acc_owner');
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: taskId, account: { account_id: 'acc_owner' } } },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const payload = result.structuredContent;
    assert.strictEqual(payload.task_id, taskId);
    assert.strictEqual(payload.task_type, 'create_media_buy');
    assert.strictEqual(payload.status, 'completed');
    assert.strictEqual(payload.protocol, 'media-buy');
    assert.deepStrictEqual(payload.result, { media_buy_id: 'mb_42', status: 'active' });
  });

  it('serves get_task_status/list_tasks from the platform task registry while a task is submitted', async () => {
    let releaseTask;
    const unblockTask = new Promise(resolve => {
      releaseTask = resolve;
    });
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => {
        await unblockTask;
        return { media_buy_id: 'mb_42', status: 'active' };
      }),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    let taskId;

    try {
      const submitted = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            buyer_ref: 'b1',
            idempotency_key: '11111111-1111-1111-1111-111111111112',
            packages: [],
            start_time: '2026-05-01T00:00:00Z',
            end_time: '2026-06-01T00:00:00Z',
            account: { account_id: 'acc_owner' },
            push_notification_config: { url: 'https://buyer.example/webhooks/tasks' },
          },
        },
      });
      assert.strictEqual(submitted.structuredContent.status, 'submitted');
      taskId = submitted.structuredContent.task_id;

      const status = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_task_status',
          arguments: { task_id: taskId, include_result: true, account: { account_id: 'acc_owner' } },
        },
      });
      assert.notStrictEqual(status.isError, true, JSON.stringify(status.structuredContent));
      assert.strictEqual(status.structuredContent.task_id, taskId);
      assert.strictEqual(status.structuredContent.task_type, 'create_media_buy');
      assert.strictEqual(status.structuredContent.protocol, 'media-buy');
      assert.strictEqual(status.structuredContent.status, 'submitted');
      assert.strictEqual(status.structuredContent.has_webhook, true);
      assert.strictEqual(status.structuredContent.result, undefined);
      assert.strictEqual(status.structuredContent.adcp_version, '3.1-rc.10');

      const listed = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'list_tasks',
          arguments: {
            account: { account_id: 'acc_owner' },
            filters: { task_ids: [taskId], statuses: ['submitted'], has_webhook: true },
          },
        },
      });
      assert.notStrictEqual(listed.isError, true, JSON.stringify(listed.structuredContent));
      assert.strictEqual(listed.structuredContent.query_summary.total_matching, 1);
      assert.deepStrictEqual(
        listed.structuredContent.tasks.map(task => ({
          task_id: task.task_id,
          task_type: task.task_type,
          status: task.status,
          has_webhook: task.has_webhook,
        })),
        [{ task_id: taskId, task_type: 'create_media_buy', status: 'submitted', has_webhook: true }]
      );

      const crossTenant = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_task_status',
          arguments: { task_id: taskId, account: { account_id: 'acc_attacker' } },
        },
      });
      assert.strictEqual(crossTenant.isError, true);
      assert.strictEqual(crossTenant.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');

      releaseTask();
      await server.awaitTask(taskId);

      const completed = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_task_status',
          arguments: { task_id: taskId, include_result: true, account: { account_id: 'acc_owner' } },
        },
      });
      assert.notStrictEqual(completed.isError, true, JSON.stringify(completed.structuredContent));
      assert.strictEqual(completed.structuredContent.status, 'completed');
      assert.deepStrictEqual(completed.structuredContent.result, { media_buy_id: 'mb_42', status: 'active' });
    } finally {
      releaseTask();
      if (taskId) await server.awaitTask(taskId);
    }
  });

  it('sanitizes AUTHORIZATION_REQUIRED task errors before polling exposes them', async () => {
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => {
        throw new AdcpError('AUTHORIZATION_REQUIRED', {
          message: 'TikTok publisher identity authorization required',
          details: {
            missing_connections: [
              {
                provider: 'tiktok',
                connection_type: 'publisher_identity',
                status: 'missing',
                authorization_url: 'https://seller.example/connect/tiktok',
                access_token: 'tok_secret',
                resource_ref: {
                  identity_id: 'creator_456',
                  private_note: 'internal',
                },
              },
            ],
            authorization_url: 'https://seller.example/connect',
            refresh_token: 'refresh_secret',
            tenant_id: 'tenant_secret',
          },
        });
      }),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );

    const submitted = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '11111111-1111-1111-1111-111111111113',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: 'acc_owner' },
        },
      },
    });
    const taskId = submitted.structuredContent.task_id;
    await server.awaitTask(taskId);

    const status = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_task_status',
        arguments: { task_id: taskId, account: { account_id: 'acc_owner' } },
      },
    });
    assert.notStrictEqual(status.isError, true, JSON.stringify(status.structuredContent));
    const error = status.structuredContent.error;
    assert.strictEqual(error.code, 'AUTHORIZATION_REQUIRED');
    assert.strictEqual(error.details.authorization_url, 'https://seller.example/connect');
    assert.equal(error.details.refresh_token, undefined);
    assert.equal(error.details.tenant_id, undefined);
    assert.equal(error.details.missing_connections[0].access_token, undefined);
    assert.equal(error.details.missing_connections[0].resource_ref.private_note, undefined);

    const legacyStatus = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'tasks_get',
        arguments: { task_id: taskId, account: { account_id: 'acc_owner' } },
      },
    });
    assert.notStrictEqual(legacyStatus.isError, true, JSON.stringify(legacyStatus.structuredContent));
    const legacyError = legacyStatus.structuredContent.error;
    assert.strictEqual(legacyError.code, 'AUTHORIZATION_REQUIRED');
    assert.strictEqual(legacyError.details.authorization_url, 'https://seller.example/connect');
    assert.equal(legacyError.details.details, undefined);
    assert.equal(legacyError.details.refresh_token, undefined);
    assert.equal(legacyError.details.missing_connections[0].access_token, undefined);
  });

  it('applies responseEnhancer to the framework-owned tasks_get custom tool', async () => {
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' })),
      {
        name: 'p',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
        responseEnhancer: response => {
          const first = Array.isArray(response.content) ? response.content[0] : undefined;
          if (first && first.type === 'text' && typeof first.text === 'string') {
            first.text = `${first.text}\n\nenhanced`;
          }
        },
      }
    );
    const taskId = await createTask(server, 'acc_owner');
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: taskId, account: { account_id: 'acc_owner' } } },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.match(result.content[0].text, /enhanced/);
    assert.strictEqual(result.structuredContent.task_id, taskId);
  });

  it('returns failed task with top-level error per spec tasks-get-response.json', async () => {
    const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => {
        throw new AdcpError('GOVERNANCE_DENIED', { recovery: 'terminal', message: 'denied' });
      }),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createTask(server, 'acc_owner');
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: taskId, account: { account_id: 'acc_owner' } } },
    });
    assert.notStrictEqual(result.isError, true);
    const payload = result.structuredContent;
    assert.strictEqual(payload.status, 'failed');
    // Spec: top-level `error: { code, message, details? }` — NOT nested
    // inside `result`. Required fields are `code` + `message`.
    assert.strictEqual(payload.error.code, 'GOVERNANCE_DENIED');
    assert.strictEqual(payload.error.message, 'denied');
    assert.strictEqual(payload.result, undefined, 'failed task should not carry success result');
    // Terminal-state stamp.
    assert.ok(typeof payload.completed_at === 'string', 'completed_at present on terminal status');
  });

  it('emits completed_at on completed terminal task', async () => {
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_42', status: 'active' })),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createTask(server, 'acc_owner');
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: taskId, account: { account_id: 'acc_owner' } } },
    });
    assert.ok(typeof result.structuredContent.completed_at === 'string');
  });

  it('returns REFERENCE_NOT_FOUND on cross-tenant probe (B7-aligned)', async () => {
    // Use a platform whose resolver checks the ref strictly so cross-tenant
    // resolution succeeds (returning the requested foreign account) but
    // the task ownership mismatch still blocks.
    const server = createAdcpServerFromPlatform(
      {
        capabilities: {
          specialisms: ['sales-non-guaranteed'],
          creative_agents: [],
          channels: ['display'],
          pricingModels: ['cpm'],
          config: {},
        },
        accounts: {
          resolve: async ref => ({
            id: ref?.account_id ?? 'acc_unknown',
            name: 'X',
            status: 'active',
            metadata: {},
            authInfo: { kind: 'api_key' },
          }),
        },
        sales: {
          getProducts: async () => ({ products: [], cache_scope: 'account' }),
          createMediaBuy: (req, ctx) => ctx.handoffToTask(async () => ({ media_buy_id: 'mb_42' })),
          updateMediaBuy: async () => ({ media_buy_id: 'mb_42' }),
          syncCreatives: async () => [],
          getMediaBuyDelivery: async () => ({ media_buys: [] }),
        },
      },
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createTask(server, 'acc_owner');
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: taskId, account: { account_id: 'acc_attacker' } } },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');
  });

  it('refuses to leak when caller omits account AND no auth context resolves one', async () => {
    // Unauthenticated probe path: caller passes only { task_id }, no
    // `account` arg, and the resolver returns nothing for `undefined` ref
    // (i.e. there's no auth-derived account either). The handler must NOT
    // return the task even though task_id is valid — owning account mismatch
    // ('owner' vs undefined) blocks the leak.
    const server = createAdcpServerFromPlatform(
      {
        capabilities: {
          specialisms: ['sales-non-guaranteed'],
          creative_agents: [],
          channels: ['display'],
          pricingModels: ['cpm'],
          config: {},
        },
        accounts: {
          resolve: async ref => {
            // Only resolve when ref explicitly carries account_id; treat
            // `undefined` ref as unauthenticated (no auth-derived match).
            if (!ref?.account_id) return null;
            return {
              id: ref.account_id,
              name: 'X',
              status: 'active',
              metadata: {},
              authInfo: { kind: 'api_key' },
            };
          },
        },
        sales: {
          getProducts: async () => ({ products: [], cache_scope: 'account' }),
          createMediaBuy: (req, ctx) => ctx.handoffToTask(async () => ({ media_buy_id: 'mb_42', status: 'active' })),
          updateMediaBuy: async () => ({ media_buy_id: 'mb_42' }),
          syncCreatives: async () => [],
          getMediaBuyDelivery: async () => ({ media_buys: [] }),
        },
      },
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createTask(server, 'acc_owner');
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: taskId } },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');
  });

  it('returns REFERENCE_NOT_FOUND for unknown task_id', async () => {
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(async () => ({ media_buy_id: 'mb_x' })),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'tasks_get', arguments: { task_id: 'task_unknown', account: { account_id: 'acc_1' } } },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');
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
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: (req, ctx) => ctx.handoffToTask(async () => ({ media_buy_id: 'mb_42' })),
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
          buyer_ref: 'b1',
          idempotency_key: '11111111-1111-1111-1111-111111111111',
          packages: [],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          account: { account_id: accountId },
        },
      },
    });
    await server.awaitTask(result.structuredContent.task_id);
    return result.structuredContent.task_id;
  }

  it('returns task for the owning account', async () => {
    const server = createAdcpServerFromPlatform(buildHitlPlatform(), {
      name: 't',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createTaskFor(server, 'acc_owner');
    const record = await server.getTaskState(taskId, 'acc_owner');
    assert.ok(record);
    assert.strictEqual(record.accountId, 'acc_owner');
  });

  it('returns null when expectedAccountId mismatches (cross-tenant probe)', async () => {
    const server = createAdcpServerFromPlatform(buildHitlPlatform(), {
      name: 't',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createTaskFor(server, 'acc_owner');
    const record = await server.getTaskState(taskId, 'acc_other');
    assert.strictEqual(record, null, 'cross-tenant probe must not leak the task');
  });

  it('unscoped read still works (ops/test contexts)', async () => {
    const server = createAdcpServerFromPlatform(buildHitlPlatform(), {
      name: 't',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
    // Specialisms in the AdCP enum but not yet wired to a v6.0 platform
    // interface fall through to validatePlatform's forward-compat path —
    // adopters can claim them without the framework knowing how to
    // enforce the platform field.
    //
    // `signed-requests` is the canonical example: it's a cross-cutting
    // capability wired on `serve({ authenticate })`, not a specialism
    // platform interface, so claiming it is always forward-compat.
    const platform = buildPlatform({
      capabilities: {
        ...buildPlatform().capabilities,
        specialisms: ['sales-non-guaranteed', 'signed-requests'],
      },
    });
    assert.doesNotThrow(() => validatePlatform(platform));
  });

  it('accepts unified createMediaBuy returning either Success or TaskHandoff', () => {
    // The unified hybrid shape: validatePlatform doesn't enforce
    // exactly-one anymore; the method's return type is what discriminates
    // sync vs HITL at dispatch time. validatePlatform just checks that
    // the specialism declaration matches the implemented interfaces.
    const platform = buildPlatform({
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: (req, ctx) => ctx.handoffToTask(async () => ({ media_buy_id: 'mb_1' })),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    });
    assert.doesNotThrow(() => validatePlatform(platform));
  });

  it('throws PlatformConfigError when sales-* specialism declared without capabilities.channels', () => {
    // Sales platforms declaring an empty/missing `channels` emit a broken
    // get_adcp_capabilities response that buyers cannot interpret. Runtime
    // guard catches what the now-optional type signature lets through.
    const base = buildPlatform();
    const platform = {
      ...base,
      capabilities: {
        ...base.capabilities,
        // channels intentionally omitted (was optional after #1278)
        channels: undefined,
      },
    };
    assert.throws(
      () => validatePlatform(platform),
      err => err instanceof PlatformConfigError && /channels/.test(err.message)
    );
  });

  it('passes for signals-only platform without channels/pricingModels/creative_agents', () => {
    // After #1278 these capability fields are optional on
    // DecisioningCapabilities — signals-only platforms don't sell media
    // and don't compose with creative agents. The `sales-` prefix derived
    // gate (validate-platform.ts) means non-sales claims pass.
    const base = buildPlatform();
    const platform = {
      ...base,
      sales: undefined, // signals-only
      signals: {
        getSignals: async () => ({ signals: [] }),
        activateSignal: async () => ({ deployments: [] }),
      },
      capabilities: {
        specialisms: ['signal-marketplace'],
        config: {},
      },
    };
    assert.doesNotThrow(() => validatePlatform(platform));
  });

  it('requires sponsoredIntelligence when sponsored-intelligence specialism is claimed', () => {
    const base = buildPlatform();
    const platform = {
      ...base,
      sales: undefined,
      sponsoredIntelligence: undefined,
      capabilities: {
        specialisms: ['sponsored-intelligence'],
        config: {},
      },
    };
    assert.throws(
      () => validatePlatform(platform),
      err => err instanceof PlatformConfigError && /sponsored-intelligence.*sponsoredIntelligence/.test(err.message)
    );
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

describe('createAdcpServerFromPlatform — default resolveIdempotencyPrincipal', () => {
  // Surfaced by Emma matrix v2: adopters who declare a typed v6 platform
  // but skip the resolveIdempotencyPrincipal hook hit SERVICE_UNAVAILABLE
  // on every mutating tool call. v5's createAdcpServer makes this a hard
  // requirement; v6 platform path now synthesizes a sensible default
  // (auth.clientId → sessionKey → account.id) so first-30-minutes works.
  function basePlatform() {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      statusMappers: {},
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1',
          name: 'Default',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({
          media_buy_id: 'mb_1',
          status: 'pending_creatives',
          confirmed_at: '2026-04-30T00:00:00Z',
          packages: [],
        }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({
          currency: 'USD',
          reporting_period: { start: '2026-04-01', end: '2026-04-30' },
          media_buy_deliveries: [],
        }),
      },
    };
  }

  it('mutating call succeeds without an explicit resolveIdempotencyPrincipal', async () => {
    // Pre-fix: this returned SERVICE_UNAVAILABLE with
    // "Idempotency principal could not be resolved". Now the default
    // falls back to ctx.account.id so the call goes through.
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          account: { account_id: 'acc_1' },
          promoted_offering: 'x',
          packages: [],
          idempotency_key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_1');
  });
});

// Regression test for #1886: createAdcpServerFromPlatform did not forward
// platform.capabilities.specialisms into the inner createAdcpServer config,
// causing a boot-time throw when signedRequests was wired.
describe('signed-requests specialism forwarding (#1886)', () => {
  const signedRequestsStores = () => ({
    jwks: new StaticJwksResolver([]),
    replayStore: new InMemoryReplayStore({ maxEntriesPerKeyid: 100 }),
    revocationStore: new InMemoryRevocationStore({
      issuer: 'http://seller.example.com',
      updated: new Date().toISOString(),
      next_update: new Date(Date.now() + 3600_000).toISOString(),
      revoked_kids: [],
      revoked_jtis: [],
    }),
  });

  function platformWithSpecialism(specialisms) {
    return {
      capabilities: {
        specialisms,
        channels: ['display'],
        pricingModels: ['cpm'],
        config: null,
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
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }

  it('does not throw at boot when signed-requests is claimed and signedRequests is configured', () => {
    // Pre-fix: always threw "capabilities.specialisms does not include signed-requests"
    // even when platform.capabilities.specialisms included the claim, because
    // projectedCapabilitiesConfig only forwarded overrides, never specialisms.
    assert.doesNotThrow(() =>
      createAdcpServerFromPlatform(platformWithSpecialism(['sales-non-guaranteed', 'signed-requests']), {
        name: 'seller',
        version: '1.0.0',
        validation: { requests: 'off', responses: 'off' },
        signedRequests: signedRequestsStores(),
      })
    );
  });

  it('forwards specialisms into get_adcp_capabilities response', async () => {
    const server = createAdcpServerFromPlatform(platformWithSpecialism(['sales-non-guaranteed', 'signed-requests']), {
      name: 'seller',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
      signedRequests: signedRequestsStores(),
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const caps = result.structuredContent;
    assert.ok(
      Array.isArray(caps.specialisms) && caps.specialisms.includes('signed-requests'),
      `expected specialisms to include 'signed-requests', got: ${JSON.stringify(caps.specialisms)}`
    );
    assert.strictEqual(
      caps.request_signing?.supported,
      true,
      `expected request_signing.supported === true, got: ${JSON.stringify(caps.request_signing)}`
    );
  });

  it('does not inject specialisms when platform declares none', () => {
    // Platforms with an empty specialisms array should not produce a specialisms
    // key in get_adcp_capabilities (existing behavior is preserved).
    assert.doesNotThrow(() =>
      createAdcpServerFromPlatform(platformWithSpecialism([]), {
        name: 'seller',
        version: '1.0.0',
        validation: { requests: 'off', responses: 'off' },
      })
    );
  });
});
