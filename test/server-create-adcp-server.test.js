const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const { createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { adcpError } = require('../dist/lib/server/errors');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function callTool(server, toolName, params) {
  const raw = await callToolRaw(server, toolName, params);
  return raw.structuredContent;
}

async function callToolRaw(server, toolName, params) {
  const tool = server._registeredTools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  const extra = { signal: new AbortController().signal };
  return tool.handler(params, extra);
}

function registeredTools(server) {
  return Object.keys(server._registeredTools);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdcpServer', () => {
  it('returns an McpServer with .tool() method', () => {
    const server = createAdcpServer({ name: 'Test', version: '1.0.0' });
    assert.strictEqual(typeof server.tool, 'function');
  });

  describe('domain grouping', () => {
    it('registers mediaBuy tools under correct MCP tool names', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
        },
      });
      const tools = registeredTools(server);
      assert.ok(tools.includes('get_products'));
      assert.ok(tools.includes('create_media_buy'));
      assert.ok(tools.includes('get_adcp_capabilities'));
    });

    it('registers signals tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        signals: {
          getSignals: async () => ({ signals: [] }),
        },
      });
      assert.ok(registeredTools(server).includes('get_signals'));
    });

    it('registers creative tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        creative: {
          buildCreative: async () => ({
            creative_manifest: { format_id: { id: 'f1', agent_url: 'https://example.com' } },
          }),
        },
      });
      assert.ok(registeredTools(server).includes('build_creative'));
    });

    it('registers governance tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        governance: {
          checkGovernance: async () => ({ decision: 'approve' }),
        },
      });
      assert.ok(registeredTools(server).includes('check_governance'));
    });

    it('registers account tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        accounts: {
          listAccounts: async () => ({ accounts: [] }),
        },
      });
      assert.ok(registeredTools(server).includes('list_accounts'));
    });

    it('registers sponsored intelligence tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        sponsoredIntelligence: {
          getOffering: async () => ({ offering_id: 'o1' }),
        },
      });
      assert.ok(registeredTools(server).includes('si_get_offering'));
    });

    it('deduplicates shared tools across domains', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          listCreativeFormats: async () => ({ formats: [] }),
        },
        creative: {
          listCreativeFormats: async () => ({ formats: [] }),
        },
      });
      // Should not throw — second registration is silently skipped
      const count = registeredTools(server).filter(t => t === 'list_creative_formats').length;
      assert.strictEqual(count, 1);
    });
  });

  describe('auto-generated capabilities', () => {
    it('detects media_buy protocol from mediaBuy handlers', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.ok(caps.supported_protocols.includes('media_buy'));
    });

    it('detects multiple protocols', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
        signals: { getSignals: async () => ({ signals: [] }) },
        sponsoredIntelligence: { getOffering: async () => ({ offering_id: 'o1' }) },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.ok(caps.supported_protocols.includes('media_buy'));
      assert.ok(caps.supported_protocols.includes('signals'));
      assert.ok(caps.supported_protocols.includes('sponsored_intelligence'));
    });

    it('includes media_buy features', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
        capabilities: { features: { inlineCreativeManagement: true } },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.strictEqual(caps.media_buy.features.inline_creative_management, true);
    });
  });

  describe('response builder wiring', () => {
    it('wraps get_products with productsResponse', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [{ product_id: 'p1' }] }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief', brief: 'test',
      });
      assert.strictEqual(result.content[0].text, 'Found 1 products');
      assert.strictEqual(result.structuredContent.products.length, 1);
    });

    it('wraps create_media_buy with mediaBuyResponse defaults', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [] }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.strictEqual(result.structuredContent.media_buy_id, 'mb_1');
      assert.strictEqual(result.structuredContent.revision, 1);
      assert.ok(result.structuredContent.confirmed_at);
    });

    it('wraps get_signals with getSignalsResponse', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        signals: { getSignals: async () => ({ signals: [{ signal_id: 's1' }] }) },
      });
      const result = await callToolRaw(server, 'get_signals', {});
      assert.strictEqual(result.content[0].text, 'Found 1 signal');
    });

    it('uses generic wrapper for tools without dedicated builders', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        governance: {
          createPropertyList: async () => ({ list_id: 'pl_1', name: 'My List' }),
        },
      });
      const result = await callToolRaw(server, 'create_property_list', { name: 'My List' });
      assert.strictEqual(result.content[0].text, 'OK');
      assert.strictEqual(result.structuredContent.list_id, 'pl_1');
    });

    it('passes through adcpError responses', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          getProducts: async () => adcpError('RATE_LIMITED', {
            message: 'Too many requests', retry_after: 30,
          }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief', brief: 'test',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'RATE_LIMITED');
    });

    it('detects build_creative single vs multi-format', async () => {
      const serverSingle = createAdcpServer({
        name: 'Test', version: '1.0.0',
        creative: {
          buildCreative: async () => ({
            creative_manifest: { format_id: { id: 'f1', agent_url: 'https://example.com' } },
          }),
        },
      });
      const single = await callToolRaw(serverSingle, 'build_creative', {});
      assert.ok(single.content[0].text.includes('f1'));

      const serverMulti = createAdcpServer({
        name: 'Test', version: '1.0.0',
        creative: {
          buildCreative: async () => ({
            creative_manifests: [
              { format_id: { id: 'f1', agent_url: 'https://example.com' } },
              { format_id: { id: 'f2', agent_url: 'https://example.com' } },
            ],
          }),
        },
      });
      const multi = await callToolRaw(serverMulti, 'build_creative', {});
      assert.ok(multi.content[0].text.includes('2 creative formats'));
    });
  });

  describe('account resolution', () => {
    it('resolves account and passes to handler context', async () => {
      let receivedCtx;
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        resolveAccount: async (ref) => ({ id: ref.account_id, name: 'Test Account' }),
        mediaBuy: {
          getProducts: async (params, ctx) => {
            receivedCtx = ctx;
            return { products: [] };
          },
        },
      });

      await callTool(server, 'get_products', {
        buying_mode: 'brief', brief: 'test', account: { account_id: 'a1' },
      });

      assert.ok(receivedCtx);
      assert.strictEqual(receivedCtx.account.id, 'a1');
      assert.strictEqual(receivedCtx.account.name, 'Test Account');
    });

    it('returns ACCOUNT_NOT_FOUND when resolveAccount returns null', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        resolveAccount: async () => null,
        mediaBuy: {
          getProducts: async () => { throw new Error('Should not be called'); },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief', brief: 'test', account: { account_id: 'bad_id' },
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    });

    it('skips account resolution when no account in request', async () => {
      let resolveAccountCalled = false;
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        resolveAccount: async () => { resolveAccountCalled = true; return {}; },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });

      await callTool(server, 'get_products', { buying_mode: 'brief', brief: 'test' });
      assert.strictEqual(resolveAccountCalled, false);
    });

    it('skips account resolution for tools without account field', async () => {
      let resolveAccountCalled = false;
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        resolveAccount: async () => { resolveAccountCalled = true; return {}; },
        mediaBuy: {
          updateMediaBuy: async () => ({ media_buy_id: 'mb1' }),
        },
      });

      await callToolRaw(server, 'update_media_buy', { media_buy_id: 'mb1' });
      assert.strictEqual(resolveAccountCalled, false);
    });

    it('returns SERVICE_UNAVAILABLE when resolveAccount throws', async () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        resolveAccount: async () => { throw new Error('DB connection failed'); },
        mediaBuy: {
          getProducts: async () => { throw new Error('Should not be called'); },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief', brief: 'test', account: { account_id: 'a1' },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    });
  });

  describe('governance helper', () => {
    it('governanceDeniedError produces COMPLIANCE_UNSATISFIED adcpError', () => {
      const { governanceDeniedError } = require('../dist/lib/server/governance');
      const result = governanceDeniedError({
        approved: false,
        checkId: 'chk_1',
        explanation: 'Budget exceeds plan',
        findings: [{ category_id: 'budget_compliance', severity: 'high', explanation: 'Over budget' }],
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'COMPLIANCE_UNSATISFIED');
      assert.ok(result.structuredContent.adcp_error.message.includes('Budget exceeds plan'));
      assert.ok(result.structuredContent.adcp_error.details.check_id);
    });
  });

  describe('logger', () => {
    it('logs account not found as warning', async () => {
      const warnings = [];
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        resolveAccount: async () => null,
        logger: {
          debug() {}, info() {},
          warn(msg, data) { warnings.push({ msg, data }); },
          error() {},
        },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });

      await callToolRaw(server, 'get_products', {
        buying_mode: 'brief', brief: 'test', account: { account_id: 'bad' },
      });

      assert.ok(warnings.some(w => w.msg === 'Account not found'));
    });

  });

  describe('tool coherence', () => {
    it('warns when create_media_buy registered without get_products', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test', version: '1.0.0',
        logger: {
          debug() {}, info() {},
          warn(msg) { warnings.push(msg); },
          error() {},
        },
        mediaBuy: {
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
        },
      });

      assert.ok(warnings.some(w => w.includes('create_media_buy without get_products')));
    });

    it('does not warn when both tools are present', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test', version: '1.0.0',
        logger: {
          debug() {}, info() {},
          warn(msg) { warnings.push(msg); },
          error() {},
        },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
        },
      });

      assert.ok(!warnings.some(w => w.includes('create_media_buy without get_products')));
    });
  });

  describe('handler error handling', () => {
    it('returns SERVICE_UNAVAILABLE when handler throws', async () => {
      const errors = [];
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        logger: {
          debug() {}, info() {}, warn() {},
          error(msg, data) { errors.push({ msg, data }); },
        },
        mediaBuy: {
          getProducts: async () => { throw new Error('Database connection lost'); },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief', brief: 'test',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
      assert.ok(errors.some(e => e.msg === 'Handler failed'));
    });
  });

  describe('empty server', () => {
    it('returns empty supported_protocols for bare server', async () => {
      const server = createAdcpServer({ name: 'Test', version: '1.0.0' });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.deepStrictEqual(caps.supported_protocols, []);
      assert.deepStrictEqual(caps.adcp.major_versions, [3]);
    });
  });

  describe('duplicate tool logging', () => {
    it('logs warning when tool registered by multiple domains', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test', version: '1.0.0',
        logger: {
          debug() {}, info() {},
          warn(msg) { warnings.push(msg); },
          error() {},
        },
        mediaBuy: {
          listCreativeFormats: async () => ({ formats: [] }),
        },
        creative: {
          listCreativeFormats: async () => ({ formats: [] }),
        },
      });
      assert.ok(warnings.some(w => w.includes('list_creative_formats') && w.includes('already registered')));
    });
  });

  describe('eventTracking domain', () => {
    it('registers event tracking tools in their own domain', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        eventTracking: {
          syncEventSources: async () => ({ event_sources: [] }),
          logEvent: async () => ({ accepted: true }),
          syncAudiences: async () => ({ audiences: [] }),
          syncCatalogs: async () => ({ catalogs: [] }),
        },
      });
      const tools = registeredTools(server);
      assert.ok(tools.includes('sync_event_sources'));
      assert.ok(tools.includes('log_event'));
      assert.ok(tools.includes('sync_audiences'));
      assert.ok(tools.includes('sync_catalogs'));
    });
  });

  describe('tool annotations', () => {
    it('sets readOnlyHint on read tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const tool = server._registeredTools['get_products'];
      assert.strictEqual(tool.annotations.readOnlyHint, true);
    });

    it('sets destructiveHint false on mutation tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
        },
      });
      const tool = server._registeredTools['create_media_buy'];
      assert.strictEqual(tool.annotations.readOnlyHint, false);
      assert.strictEqual(tool.annotations.destructiveHint, false);
    });

    it('sets destructiveHint true on destructive tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        governance: {
          deletePropertyList: async () => ({ deleted: true }),
        },
      });
      const tool = server._registeredTools['delete_property_list'];
      assert.strictEqual(tool.annotations.destructiveHint, true);
    });

    it('sets idempotentHint on sync tools', () => {
      const server = createAdcpServer({
        name: 'Test', version: '1.0.0',
        mediaBuy: {
          syncCreatives: async () => ({ creatives: [] }),
        },
      });
      const tool = server._registeredTools['sync_creatives'];
      assert.strictEqual(tool.annotations.idempotentHint, true);
    });
  });

  describe('unknown handler key warning', () => {
    it('warns when handler key is not recognized (typo)', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test', version: '1.0.0',
        logger: {
          debug() {}, info() {},
          warn(msg) { warnings.push(msg); },
          error() {},
        },
        mediaBuy: {
          getProduct: async () => ({ products: [] }), // typo: getProduct instead of getProducts
        },
      });
      assert.ok(warnings.some(w => w.includes('Unknown handler key "getProduct"')));
    });

    it('does not warn on valid handler keys', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test', version: '1.0.0',
        logger: {
          debug() {}, info() {},
          warn(msg) { warnings.push(msg); },
          error() {},
        },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      assert.ok(!warnings.some(w => w.includes('Unknown handler key')));
    });
  });
});
