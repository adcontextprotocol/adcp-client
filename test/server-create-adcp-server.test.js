const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { getSdkServer } = require('../dist/lib/server/adcp-server');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { InMemoryTaskStore } = require('../dist/lib/server/tasks');
const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');
const { adcpError } = require('../dist/lib/server/errors');

// These tests exercise envelope wrapping, state-store propagation, and
// idempotency middleware using deliberately sparse handler fixtures
// (e.g. `{ products: [{ product_id: 'p1' }] }`). The strict response-
// validation default turns that drift into VALIDATION_ERROR at the
// dispatcher. Opt out so this file keeps testing middleware behavior;
// `test/lib/schema-validation-server.test.js` covers the validator itself.
//
// Shallow-merge `validation` so a per-test `validation: { requests: 'strict' }`
// doesn't silently re-enable response validation; only keys the test
// explicitly sets win over the file-level opt-out.
function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// Tool invocations go through AdcpServer.dispatchTestRequest — the same
// public surface downstream consumers use. Tool enumeration reaches into
// the internal SDK handle (package-private) since there's no public
// synchronous equivalent and this file is inside our own package.

async function callTool(server, toolName, params, extras) {
  const raw = await callToolRaw(server, toolName, params, extras);
  return raw.structuredContent;
}

async function callToolRaw(server, toolName, params, extras) {
  return server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: { name: toolName, arguments: params ?? {} },
    },
    extras
  );
}

function registeredTools(server) {
  const sdk = getSdkServer(server);
  if (!sdk) throw new Error('registeredTools: value is not an AdcpServer');
  return Object.keys(sdk._registeredTools);
}

function registeredTool(server, toolName) {
  const sdk = getSdkServer(server);
  if (!sdk) throw new Error('registeredTool: value is not an AdcpServer');
  return sdk._registeredTools[toolName];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdcpServer', () => {
  it('returns an AdcpServer with connect / close / dispatchTestRequest', () => {
    const server = createAdcpServer({ name: 'Test', version: '1.0.0' });
    assert.strictEqual(typeof server.connect, 'function');
    assert.strictEqual(typeof server.close, 'function');
    assert.strictEqual(typeof server.dispatchTestRequest, 'function');
  });

  it('wraps an SDK McpServer reachable via getSdkServer', () => {
    const server = createAdcpServer({ name: 'Test', version: '1.0.0' });
    const sdk = getSdkServer(server);
    assert.ok(sdk, 'getSdkServer should return the underlying McpServer');
    assert.strictEqual(typeof sdk.connect, 'function');
    // Private SDK field we rely on for test dispatch — lock in the contract
    // so a SDK bump that renames it trips this test.
    assert.strictEqual(typeof sdk._registeredTools, 'object');
  });

  it('dispatchTestRequest routes tools/call through the registered handler', async () => {
    let sawParams;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async params => {
          sawParams = params;
          return { products: [] };
        },
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'premium' } },
    });
    assert.deepStrictEqual(sawParams, { brief: 'premium' });
    assert.ok(result.content, 'CallToolResult should carry content');
    assert.ok(result.structuredContent, 'CallToolResult should carry structuredContent');
  });

  it('dispatchTestRequest throws for unknown tools and methods', async () => {
    const server = createAdcpServer({ name: 'Test', version: '1.0.0' });
    await assert.rejects(
      () => server.dispatchTestRequest({ method: 'tools/call', params: { name: 'nope' } }),
      /tool "nope" is not registered/
    );
    await assert.rejects(
      () => server.dispatchTestRequest({ method: 'made/up' }),
      /no handler registered for method "made\/up"/
    );
  });

  describe('domain grouping', () => {
    it('registers mediaBuy tools under correct MCP tool names', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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
        name: 'Test',
        version: '1.0.0',
        signals: {
          getSignals: async () => ({ signals: [] }),
        },
      });
      assert.ok(registeredTools(server).includes('get_signals'));
    });

    it('registers creative tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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
        name: 'Test',
        version: '1.0.0',
        governance: {
          checkGovernance: async () => ({ decision: 'approve' }),
        },
      });
      assert.ok(registeredTools(server).includes('check_governance'));
    });

    it('registers account tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        accounts: {
          listAccounts: async () => ({ accounts: [] }),
        },
      });
      assert.ok(registeredTools(server).includes('list_accounts'));
    });

    it('registers sponsored intelligence tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        sponsoredIntelligence: {
          getOffering: async () => ({ offering_id: 'o1' }),
        },
      });
      assert.ok(registeredTools(server).includes('si_get_offering'));
    });

    it('deduplicates shared tools across domains', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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

  describe('customTools', () => {
    const { z } = require('zod');

    it('registers a custom tool the handler dispatches through dispatchTestRequest', async () => {
      let seenArgs;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        customTools: {
          creative_approval: {
            description: 'Approve or reject a creative out-of-band.',
            inputSchema: { creative_id: z.string(), approved: z.boolean() },
            handler: async ({ creative_id, approved }) => {
              seenArgs = { creative_id, approved };
              return {
                content: [{ type: 'text', text: `creative ${creative_id} ${approved ? 'approved' : 'rejected'}` }],
                structuredContent: { creative_id, approved },
              };
            },
          },
        },
      });
      assert.ok(registeredTools(server).includes('creative_approval'));
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: { name: 'creative_approval', arguments: { creative_id: 'cr_1', approved: true } },
      });
      assert.deepStrictEqual(seenArgs, { creative_id: 'cr_1', approved: true });
      assert.deepStrictEqual(result.structuredContent, { creative_id: 'cr_1', approved: true });
    });

    it('refuses customTools that collide with a framework-registered tool', () => {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'Test',
            version: '1.0.0',
            mediaBuy: { getProducts: async () => ({ products: [] }) },
            customTools: {
              get_products: {
                description: 'Shadows the spec handler — should throw.',
                handler: async () => ({ content: [{ type: 'text', text: 'shadow' }] }),
              },
            },
          }),
        /customTools\["get_products"\] collides with a framework-registered tool/
      );
    });

    // 6.7.0 promoted `update_rights` from customTool territory to a
    // framework-registered first-class tool (#1349). Adopters carrying a
    // pre-6.7 `customTools.update_rights` registration into 6.7 hit the
    // collision throw — which previously surfaced as HTTP 500 HTML on every
    // MCP probe and looked like a discovery regression (adcp-client#1438).
    // Guard the migration hint in the error message so the next adopter
    // gets a pointer at BrandRightsPlatform.updateRights instead of the
    // generic "rename the tool" advice.
    it('refuses customTools["update_rights"] with migration hint', () => {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'Test',
            version: '1.0.0',
            brandRights: { updateRights: async () => ({ ok: true }) },
            customTools: {
              update_rights: {
                description: 'Pre-6.7 customTool registration — should throw.',
                handler: async () => ({ content: [{ type: 'text', text: 'shadow' }] }),
              },
            },
          }),
        /customTools\["update_rights"\] collides with a framework-registered tool[\s\S]*BrandRightsPlatform\.updateRights/
      );
    });

    it('refuses customTools["get_adcp_capabilities"]', () => {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'Test',
            version: '1.0.0',
            customTools: {
              get_adcp_capabilities: {
                description: 'Framework owns this one.',
                handler: async () => ({ content: [{ type: 'text', text: 'override' }] }),
              },
            },
          }),
        /customTools\["get_adcp_capabilities"\] is not allowed/
      );
    });

    // Framework-registered tools declare `annotations` at register time via
    // `registerTool`'s config object (not via post-registration `.update()`).
    // Regression guard for #705 — the deprecated `tool()` overload has no
    // annotations parameter, so if someone reverts the migration this test
    // fails loudly instead of silently dropping the hints from `tools/list`.
    it('registerTool passes annotations through to the SDK tool definition', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const tool = registeredTool(server, 'get_products');
      assert.ok(tool, 'get_products should be registered');
      assert.strictEqual(tool.annotations?.readOnlyHint, true);
    });

    it('registers framework tools with passthrough input schemas by default', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const tool = registeredTool(server, 'get_products');
      assert.ok(tool, 'get_products should be registered');
      assert.strictEqual(typeof tool.inputSchema?.passthrough, 'function');
      assert.deepStrictEqual(Object.keys(tool.inputSchema.shape), []);
    });

    it('exposes shallow top-level schema hints for framework tools when opted in', async () => {
      const { TOOL_INPUT_SHAPES } = require('../dist/lib/schemas');
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        exposeToolSchemas: true,
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const tool = registeredTool(server, 'get_products');
      assert.ok(tool, 'get_products should be registered');
      assert.ok(tool.inputSchema.shape.buying_mode, 'buying_mode hint should be exposed');
      assert.ok(tool.inputSchema.shape.brief, 'brief hint should be exposed');
      assert.notStrictEqual(tool.inputSchema.shape.buying_mode, TOOL_INPUT_SHAPES.get_products.buying_mode);

      const toolsList = await server.dispatchTestRequest({ method: 'tools/list' });
      const listedTool = toolsList.tools.find(({ name }) => name === 'get_products');
      assert.ok(listedTool, 'get_products should be listed');
      assert.ok(listedTool.inputSchema.properties.buying_mode, 'buying_mode should be exposed in tools/list');
      assert.ok(listedTool.inputSchema.properties.brief, 'brief should be exposed in tools/list');
      assert.strictEqual(listedTool.inputSchema.required, undefined);

      const parsed = await getSdkServer(server).validateToolInput(
        tool,
        { buying_mode: 'brief', brief: 123, unknown_probe: { keep: true } },
        'get_products'
      );
      assert.deepStrictEqual(parsed, { buying_mode: 'brief', brief: 123, unknown_probe: { keep: true } });
    });

    // Custom tools declaring an `outputSchema` keep the SDK validation path
    // on — proves the `registerTool({ ..., outputSchema }, ...)` plumbing
    // survives the migration. `dispatchTestRequest` bypasses SDK validation
    // (it invokes the handler directly), so we check the registered tool's
    // metadata instead of round-tripping through the transport.
    it('customTools with outputSchema store the schema on the SDK tool definition', () => {
      const outputSchema = { approved: z.boolean() };
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        customTools: {
          creative_approval: {
            description: 'Approve or reject a creative.',
            inputSchema: { creative_id: z.string() },
            outputSchema,
            handler: async ({ creative_id }) => ({
              content: [{ type: 'text', text: `creative ${creative_id}` }],
              structuredContent: { approved: true },
            }),
          },
        },
      });
      const tool = registeredTool(server, 'creative_approval');
      assert.ok(tool, 'creative_approval should be registered');
      assert.ok(tool.outputSchema, 'outputSchema must be wired on the registered tool');
    });
  });

  describe('auto-generated capabilities', () => {
    it('detects media_buy protocol from mediaBuy handlers', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.ok(caps.supported_protocols.includes('media_buy'));
    });

    it('emits envelope status: "completed" on the auto-registered handler', async () => {
      // AdCP #4876 made envelope `status` required on every task response;
      // the auto-registered get_adcp_capabilities handler must satisfy it
      // for sync wire conformance. Tracks #4877.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.strictEqual(caps.status, 'completed');
    });

    it('detects multiple protocols', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [] }) },
        signals: { getSignals: async () => ({ signals: [] }) },
        sponsoredIntelligence: { getOffering: async () => ({ offering_id: 'o1' }) },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.ok(caps.supported_protocols.includes('media_buy'));
      assert.ok(caps.supported_protocols.includes('signals'));
      assert.ok(caps.supported_protocols.includes('sponsored_intelligence'));
    });

    it('promotes explicitly declared measurement capabilities into supported_protocols', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        capabilities: {
          overrides: {
            measurement: { metrics: [] },
            experimental_features: ['measurement.core'],
          },
        },
      });
      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.ok(caps.supported_protocols.includes('measurement'));
      assert.deepStrictEqual(caps.measurement, { metrics: [] });
      assert.deepStrictEqual(caps.experimental_features, ['measurement.core']);
    });

    it('includes media_buy features', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [{ product_id: 'p1' }] }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.content[0].text, 'Found 1 products');
      assert.strictEqual(result.structuredContent.products.length, 1);
    });

    it('defaults get_products cache_scope to public only when request has no account', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        validation: { responses: 'strict' },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const result = await callTool(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.cache_scope, 'public');
    });

    it('syncs inferred get_products cache_scope into JSON text fallback', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ products: [] }) }],
            structuredContent: { products: [] },
          }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.structuredContent.cache_scope, 'public');
      assert.strictEqual(JSON.parse(result.content[0].text).cache_scope, 'public');
    });

    it('fails closed for auth-scoped get_products responses missing cache_scope without response validation', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const result = await callToolRaw(
        server,
        'get_products',
        {
          buying_mode: 'brief',
          brief: 'test',
        },
        {
          authInfo: { token: 'caller-token', clientId: 'buyer-1', scopes: ['adcp.media_buy'] },
        }
      );
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      const issue = result.structuredContent.adcp_error.issues.find(i => i.pointer === '/cache_scope');
      assert.ok(issue, `expected missing cache_scope issue, got: ${JSON.stringify(result.structuredContent)}`);
    });

    it('does not infer get_products cache_scope for auth-derived account context', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccountFromAuth: async () => ({ account_id: 'derived_acct' }),
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      const issue = result.structuredContent.adcp_error.issues.find(i => i.pointer === '/cache_scope');
      assert.ok(issue, `expected missing cache_scope issue, got: ${JSON.stringify(result.structuredContent)}`);
    });

    it('does not infer get_products cache_scope for account-scoped requests', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        account: { account_id: 'acct_1' },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      const issue = result.structuredContent.adcp_error.issues.find(i => i.pointer === '/cache_scope');
      assert.ok(issue, `expected missing cache_scope issue, got: ${JSON.stringify(result.structuredContent)}`);
      assert.match(issue.hint ?? '', /public.*account-specific overlays/);
    });

    it('wraps create_media_buy with mediaBuyResponse defaults', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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
        name: 'Test',
        version: '1.0.0',
        signals: { getSignals: async () => ({ signals: [{ signal_id: 's1' }] }) },
      });
      const result = await callToolRaw(server, 'get_signals', {});
      assert.strictEqual(result.content[0].text, 'Found 1 signal');
    });
  });

  describe('envelope status (AdCP #4876 / adcp-client#1897)', () => {
    // The v3 protocol envelope requires top-level `status` on every task
    // response. The framework stamps `status: "completed"` at the dispatch
    // chokepoint when the handler-projected payload doesn't already carry one,
    // so every per-tool wrap helper + the genericResponse fallback inherit
    // envelope conformance without needing per-helper edits.

    it('stamps status: "completed" on get_products (productsResponse path)', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: { getProducts: async () => ({ products: [{ product_id: 'p1' }] }) },
      });
      const caps = await callTool(server, 'get_products', { buying_mode: 'brief', brief: 't' });
      assert.strictEqual(caps.status, 'completed');
    });

    it('stamps status: "completed" on get_signals (getSignalsResponse path)', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        signals: { getSignals: async () => ({ signals: [{ signal_id: 's1' }] }) },
      });
      const caps = await callTool(server, 'get_signals', {});
      assert.strictEqual(caps.status, 'completed');
    });

    it('stamps status: "completed" on list_property_lists (genericResponse fallback)', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        governance: {
          listPropertyLists: async () => ({ property_lists: [] }),
        },
      });
      const caps = await callTool(server, 'list_property_lists', {});
      assert.strictEqual(caps.status, 'completed');
    });

    it('preserves governance_context on check_governance while stamping envelope status', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        governance: {
          checkGovernance: async () => ({
            check_id: 'check_1',
            verdict: 'approved',
            plan_id: 'plan_1',
            explanation: 'Approved',
            governance_context: 'gc_signed_token_123',
          }),
        },
      });
      const caps = await callTool(server, 'check_governance', {});
      assert.strictEqual(caps.status, 'completed');
      assert.strictEqual(caps.governance_context, 'gc_signed_token_123');
    });

    it('splits MediaBuyStatus on create_media_buy into media_buy_status', async () => {
      // Legacy handlers may still return the media-buy lifecycle in `status`.
      // The server response must expose the AdCP envelope status at `status`
      // and carry the lifecycle value at `media_buy_status`.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [], status: 'active' }),
        },
      });
      const caps = await callTool(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.strictEqual(caps.status, 'completed');
      assert.strictEqual(caps.media_buy_status, 'active');
    });

    it('uses generic wrapper for tools without dedicated builders', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        governance: {
          createPropertyList: async () => ({ list_id: 'pl_1', name: 'My List' }),
        },
      });
      const result = await callToolRaw(server, 'create_property_list', { name: 'My List' });
      assert.strictEqual(result.content[0].text, 'create_property_list completed');
      assert.strictEqual(result.structuredContent.list_id, 'pl_1');
    });

    it('passes through adcpError responses', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () =>
            adcpError('RATE_LIMITED', {
              message: 'Too many requests',
              retry_after: 30,
            }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'RATE_LIMITED');
    });

    it('detects build_creative single vs multi-format', async () => {
      const serverSingle = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        creative: {
          buildCreative: async () => ({
            creative_manifest: { format_id: { id: 'f1', agent_url: 'https://example.com' } },
          }),
        },
      });
      const single = await callToolRaw(serverSingle, 'build_creative', {});
      assert.ok(single.content[0].text.includes('f1'));

      const serverMulti = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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

  describe('response-union narrowing (handler returns full Response)', () => {
    it('handler that returns create_media_buy Error arm → isError + errors preserved', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({
            errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'no such product', field: 'packages[0].product_id' }],
          }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.strictEqual(result.isError, true, 'Error arm must surface as MCP isError');
      assert.ok(Array.isArray(result.structuredContent.errors), 'errors array preserved on wire');
      assert.strictEqual(result.structuredContent.errors[0].code, 'PRODUCT_NOT_FOUND');
      // Must NOT apply Success-arm defaults to an Error payload.
      assert.strictEqual(result.structuredContent.revision, undefined);
      assert.strictEqual(result.structuredContent.confirmed_at, undefined);
      assert.strictEqual(result.structuredContent.media_buy_id, undefined);
    });

    it('handler that returns create_media_buy Submitted arm → no success defaults, structuredContent preserved', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({
            status: 'submitted',
            task_id: 'tk_123',
            message: 'Awaiting IO signature',
          }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.notStrictEqual(result.isError, true, 'submitted is not an error');
      assert.strictEqual(result.structuredContent.status, 'submitted');
      assert.strictEqual(result.structuredContent.task_id, 'tk_123');
      // Success defaults must not leak onto an async-task envelope.
      assert.strictEqual(result.structuredContent.revision, undefined);
      assert.strictEqual(result.structuredContent.confirmed_at, undefined);
      assert.ok(result.content[0].text.includes('tk_123') || result.content[0].text.includes('signature'));
    });

    it('handler that returns sync_creatives Error arm → errors preserved, no creatives/summary corruption', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        creative: {
          syncCreatives: async () => ({
            errors: [{ code: 'AUTHENTICATION_FAILED', message: 'bad token' }],
          }),
        },
      });
      const result = await callToolRaw(server, 'sync_creatives', {
        account: { account_id: 'a1' },
        creatives: [],
        idempotency_key: '11111111-1111-1111-1111-111111111111',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.creatives, undefined, 'Success-only field absent on Error arm');
      assert.strictEqual(result.structuredContent.errors[0].code, 'AUTHENTICATION_FAILED');
    });

    it('returns response validation errors for malformed handler-returned errors[] arms', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        validation: { responses: 'strict' },
        creative: {
          syncCreatives: async () => ({
            errors: ['refresh_token=sekret'],
          }),
        },
      });
      const result = await callToolRaw(server, 'sync_creatives', {
        account: { account_id: 'a1' },
        creatives: [],
        idempotency_key: '11111111-1111-1111-1111-111111111111',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      assert.ok(!JSON.stringify(result.structuredContent).includes('sekret'));
    });

    it('handler that returns Success arm still gets response-builder defaults', async () => {
      // Regression: narrowing must not change the Success-path behavior.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
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

    it('sync_creatives Submitted with advisory errors routes as submitted, not error', async () => {
      // SyncCreativesSubmitted has optional `errors: Error[]` for advisory warnings
      // (e.g. throttled_severity). The isSubmittedEnvelope check must fire BEFORE
      // isErrorArm so the payload doesn't accidentally flip to isError: true.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        creative: {
          syncCreatives: async () => ({
            status: 'submitted',
            task_id: 'tk_batch_1',
            message: 'Batch ingestion queued',
            errors: [{ code: 'THROTTLED_SEVERITY', message: 'rate-limited severity advisory' }],
          }),
        },
      });
      const result = await callToolRaw(server, 'sync_creatives', {
        account: { account_id: 'a1' },
        creatives: [],
        idempotency_key: '22222222-2222-2222-2222-222222222222',
      });
      assert.notStrictEqual(result.isError, true, 'submitted-with-advisories must not flip to isError');
      assert.strictEqual(result.structuredContent.status, 'submitted');
      assert.strictEqual(result.structuredContent.task_id, 'tk_batch_1');
      assert.strictEqual(result.structuredContent.errors[0].code, 'THROTTLED_SEVERITY');
    });

    it('Error arm preserves context and ext siblings on structuredContent', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({
            errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'gone' }],
            context: { correlation_id: 'corr_xyz' },
            ext: { seller_note: 'see knowledge base kb_1234' },
          }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.errors[0].code, 'PRODUCT_NOT_FOUND');
      assert.strictEqual(result.structuredContent.context.correlation_id, 'corr_xyz');
      assert.strictEqual(result.structuredContent.ext.seller_note, 'see knowledge base kb_1234');
    });

    it('empty errors[] still flips isError and emits a generic summary', async () => {
      // Spec violation at the handler, but the dispatcher must not throw.
      // Operators see the warn log; the wire shape stays consistent.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({ errors: [] }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(result.structuredContent.errors, []);
      assert.ok(result.content[0].text.length > 0);
    });

    it('errors[] alongside a Success-only field falls through to the Success builder', async () => {
      // Unknown sibling keys mean this is NOT a pure Error arm — the shape
      // carries Success fields (media_buy_id) so isErrorArm returns false.
      // Success builder runs. Response validation (off by default in this
      // file) would reject this drift in strict mode, which is correct.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({
            errors: [{ code: 'WARNING', message: 'partial success' }],
            media_buy_id: 'mb_partial_1',
            packages: [],
          }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.media_buy_id, 'mb_partial_1');
      assert.strictEqual(result.structuredContent.revision, 1, 'Success defaults applied');
    });
  });

  describe('adcpError() does not carry issues on non-VALIDATION_ERROR codes', () => {
    it('RATE_LIMITED envelope has no top-level issues field', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => adcpError('RATE_LIMITED', { message: 'slow down', retry_after: 30 }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.structuredContent.adcp_error.code, 'RATE_LIMITED');
      // issues is conditional-spread in adcpError; undefined options.issues
      // must not materialize an empty key.
      assert.ok(
        !('issues' in result.structuredContent.adcp_error),
        'issues must be absent when caller did not pass options.issues'
      );
    });
  });

  describe('account resolution', () => {
    it('resolves account and passes to handler context', async () => {
      let receivedCtx;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async ref => ({ id: ref.account_id, name: 'Test Account' }),
        mediaBuy: {
          getProducts: async (params, ctx) => {
            receivedCtx = ctx;
            return { products: [] };
          },
        },
      });

      await callTool(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        account: { account_id: 'a1' },
      });

      assert.ok(receivedCtx);
      assert.strictEqual(receivedCtx.account.id, 'a1');
      assert.strictEqual(receivedCtx.account.name, 'Test Account');
    });

    it('returns ACCOUNT_NOT_FOUND when resolveAccount returns null', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async () => null,
        mediaBuy: {
          getProducts: async () => {
            throw new Error('Should not be called');
          },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        account: { account_id: 'bad_id' },
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    });

    it('skips account resolution when no account in request', async () => {
      let resolveAccountCalled = false;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async () => {
          resolveAccountCalled = true;
          return {};
        },
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
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async () => {
          resolveAccountCalled = true;
          return {};
        },
        mediaBuy: {
          updateMediaBuy: async () => ({ media_buy_id: 'mb1' }),
        },
      });

      await callToolRaw(server, 'update_media_buy', { media_buy_id: 'mb1' });
      assert.strictEqual(resolveAccountCalled, false);
    });

    it('resolves account on create_media_buy (required account field)', async () => {
      let resolvedRef;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async ref => {
          resolvedRef = ref;
          return { id: 'resolved' };
        },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async (params, ctx) => {
            assert.ok(ctx.account);
            return { media_buy_id: 'mb1', packages: [] };
          },
        },
      });

      await callToolRaw(server, 'create_media_buy', {
        account: { account_id: 'acct_1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });
      assert.ok(resolvedRef);
      assert.strictEqual(resolvedRef.account_id, 'acct_1');
    });

    it('returns SERVICE_UNAVAILABLE when resolveAccount throws', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async () => {
          throw new Error('DB connection failed');
        },
        mediaBuy: {
          getProducts: async () => {
            throw new Error('Should not be called');
          },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        account: { account_id: 'a1' },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    });

    it('passes toolName and authInfo to resolveAccount via the second argument', async () => {
      let resolverCtx;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async (ref, ctx) => {
          resolverCtx = ctx;
          return { id: ref.account_id, upstreamToken: ctx.authInfo?.extra?.upstreamToken };
        },
        mediaBuy: {
          getProducts: async (_params, ctx) => {
            assert.strictEqual(ctx.account.upstreamToken, 'upstream-xyz');
            return { products: [] };
          },
        },
      });

      const authInfo = {
        token: 'caller-token',
        clientId: 'buyer-1',
        scopes: ['adcp.media_buy'],
        extra: { upstreamToken: 'upstream-xyz' },
      };

      await server.dispatchTestRequest(
        {
          method: 'tools/call',
          params: {
            name: 'get_products',
            arguments: { buying_mode: 'brief', brief: 'test', account: { account_id: 'a1' } },
          },
        },
        { authInfo }
      );

      assert.ok(resolverCtx);
      assert.strictEqual(resolverCtx.toolName, 'get_products');
      assert.strictEqual(resolverCtx.authInfo.token, 'caller-token');
      assert.deepStrictEqual(resolverCtx.authInfo.extra, { upstreamToken: 'upstream-xyz' });
    });

    it('single-argument resolvers remain compatible', async () => {
      // A pre-existing `async (ref) => ...` must still be callable. TS widens
      // a 1-arg callback to fit the 2-arg resolver signature; the runtime
      // just ignores the extra argument.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async ref => ({ id: ref.account_id }),
        mediaBuy: {
          getProducts: async (_params, ctx) => {
            assert.strictEqual(ctx.account.id, 'legacy-1');
            return { products: [], cache_scope: 'account' };
          },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        account: { account_id: 'legacy-1' },
      });
      assert.strictEqual(result.isError, undefined);
    });
  });

  describe('governance helper', () => {
    it('governanceDeniedError produces GOVERNANCE_DENIED adcpError', () => {
      const { governanceDeniedError } = require('../dist/lib/server/governance');
      const result = governanceDeniedError({
        approved: false,
        checkId: 'chk_1',
        explanation: 'Budget exceeds plan',
        findings: [{ category_id: 'budget_compliance', severity: 'high', explanation: 'Over budget' }],
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'GOVERNANCE_DENIED');
      assert.ok(result.structuredContent.adcp_error.message.includes('Budget exceeds plan'));
      assert.ok(result.structuredContent.adcp_error.details.check_id);
    });
  });

  describe('logger', () => {
    it('logs account not found as warning', async () => {
      const warnings = [];
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async () => null,
        logger: {
          debug() {},
          info() {},
          warn(msg, data) {
            warnings.push({ msg, data });
          },
          error() {},
        },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });

      await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        account: { account_id: 'bad' },
      });

      assert.ok(warnings.some(w => w.msg === 'Account not found'));
    });
  });

  describe('tool coherence', () => {
    it('warns when create_media_buy registered without get_products', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        logger: {
          debug() {},
          info() {},
          warn(msg) {
            warnings.push(msg);
          },
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
        name: 'Test',
        version: '1.0.0',
        logger: {
          debug() {},
          info() {},
          warn(msg) {
            warnings.push(msg);
          },
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

  describe('context echo', () => {
    it('echoes params.context into successful response structuredContent', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        context: { correlation_id: 'trace-abc' },
      });
      assert.strictEqual(result.isError, undefined);
      assert.deepStrictEqual(result.structuredContent.context, { correlation_id: 'trace-abc' });
    });

    it('echoes params.context into adcpError structuredContent', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () =>
            adcpError('PRODUCT_NOT_FOUND', {
              message: 'No products match',
              field: 'brief',
            }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        context: { correlation_id: 'trace-err-1' },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'PRODUCT_NOT_FOUND');
      assert.deepStrictEqual(result.structuredContent.context, { correlation_id: 'trace-err-1' });
    });

    it('echoes context into the L2 JSON text fallback on errors', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => adcpError('INVALID_REQUEST', { message: 'bad', field: 'brief' }),
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        context: { correlation_id: 'trace-err-2' },
      });
      const parsed = JSON.parse(result.content[0].text);
      assert.deepStrictEqual(parsed.context, { correlation_id: 'trace-err-2' });
      assert.strictEqual(parsed.adcp_error.code, 'INVALID_REQUEST');
    });

    it('echoes context on framework ACCOUNT_NOT_FOUND errors', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        resolveAccount: async () => null,
        mediaBuy: {
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', {
        account: { brand: { domain: 'unknown.example' }, operator: 'unknown.example' },
        packages: [{ product_id: 'p1', budget: 1000, pricing_option_id: 'pr1' }],
        context: { correlation_id: 'trace-acct-err' },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
      assert.deepStrictEqual(result.structuredContent.context, { correlation_id: 'trace-acct-err' });
    });

    it('does not echo a string request.context into the response (si_get_offering)', async () => {
      // si_get_offering's request schema overrides `context` as a string
      // (natural-language intent hint). The response schema still expects a
      // core/context.json object, so the framework must not copy the string.
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        sponsoredIntelligence: {
          getOffering: async () => ({
            available: true,
            offering_token: 'tok_123',
            ttl_seconds: 300,
          }),
        },
      });
      const result = await callToolRaw(server, 'si_get_offering', {
        offering_id: 'off_1',
        context: 'mens size 14 near Cincinnati',
      });
      assert.strictEqual(result.isError, undefined);
      assert.ok(!('context' in result.structuredContent), 'string request.context must not leak into response.context');
    });

    it('echoes context on framework SERVICE_UNAVAILABLE when handler throws', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        mediaBuy: {
          getProducts: async () => {
            throw new Error('boom');
          },
        },
      });
      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
        context: { correlation_id: 'trace-throw' },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
      assert.deepStrictEqual(result.structuredContent.context, { correlation_id: 'trace-throw' });
    });
  });

  describe('handler error handling', () => {
    it('returns SERVICE_UNAVAILABLE when handler throws', async () => {
      const errors = [];
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        logger: {
          debug() {},
          info() {},
          warn() {},
          error(msg, data) {
            errors.push({ msg, data });
          },
        },
        mediaBuy: {
          getProducts: async () => {
            throw new Error('Database connection lost');
          },
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
      assert.ok(errors.some(e => e.msg === 'Handler failed'));
    });

    it('sanitizes a hand-rolled IDEMPOTENCY_CONFLICT envelope against the allowlist', async () => {
      // Handlers that bypass adcpError() and build the envelope by hand
      // must not ship non-allowlisted fields on the wire — the dispatcher
      // re-applies ADCP_ERROR_FIELD_ALLOWLIST as defence-in-depth so a
      // seller who hand-rolls { isError, structuredContent: { adcp_error:
      // { code: 'IDEMPOTENCY_CONFLICT', ...prior_payload } } } doesn't
      // leak the prior request body or cached response to a stolen-key
      // attacker. (The storyboard invariant catches the same thing at
      // conformance-test time; this closes the runtime gap.)
      const leakyEnvelope = {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              adcp_error: {
                code: 'IDEMPOTENCY_CONFLICT',
                message: 'key reused',
                recovery: { prior_payload: { secret: 'tok-123' } },
                retry_after: 30,
                details: { prior_budget: 5000, prior_account: 'acct_123' },
              },
            }),
          },
        ],
        structuredContent: {
          adcp_error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'key reused',
            recovery: { prior_payload: { secret: 'tok-123' } },
            retry_after: 30,
            details: { prior_budget: 5000, prior_account: 'acct_123' },
          },
        },
      };
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => leakyEnvelope,
        },
      });

      const result = await callToolRaw(server, 'get_products', {
        buying_mode: 'brief',
        brief: 'test',
      });
      const sanitized = result.structuredContent.adcp_error;
      assert.strictEqual(sanitized.code, 'IDEMPOTENCY_CONFLICT');
      assert.strictEqual(sanitized.message, 'key reused');
      assert.strictEqual(sanitized.recovery, 'correctable');
      assert.ok(!('retry_after' in sanitized));
      assert.ok(!('details' in sanitized));
      // L2 text payload stays in lockstep.
      const text = JSON.parse(result.content[0].text).adcp_error;
      assert.strictEqual(text.recovery, 'correctable');
      assert.ok(!('details' in text));
      assert.ok(!('retry_after' in text));
    });
  });

  describe('schema relaxation for handler-level validation', () => {
    it('create_media_buy handler runs when account is missing', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async params => {
            if (!params.account) {
              return adcpError('INVALID_REQUEST', { message: 'account is required' });
            }
            return { media_buy_id: 'mb1', packages: [] };
          },
        },
      });

      // Request without account — should reach handler, not fail at MCP schema level
      const result = await callToolRaw(server, 'create_media_buy', {
        packages: [{ product_id: 'p1', budget: 1000, pricing_option_id: 'pr1' }],
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
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

  describe('protocol task tools', () => {
    it('does not expose raw MCP task-store records through AdCP task tools', async () => {
      const taskStore = new InMemoryTaskStore();
      try {
        await taskStore.createTask(
          { ttl: null },
          'req_1',
          { method: 'tools/call', params: { name: 'custom_long_running' } },
          'session_1'
        );
        const server = createAdcpServer({ name: 'Test', version: '1.0.0', taskStore });
        const tools = registeredTools(server);
        assert.ok(!tools.includes('get_task_status'));
        assert.ok(!tools.includes('list_tasks'));
      } finally {
        taskStore.cleanup();
      }
    });

    it('does not require custom AdCP task registries to implement list', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry: {
          async create() {
            return { taskId: 'task_1' };
          },
          async getTask() {
            return null;
          },
          async complete() {},
          async fail() {},
          async updateProgress() {},
          _registerBackground() {},
          async awaitTask() {},
        },
      });

      const tools = registeredTools(server);
      assert.ok(tools.includes('get_task_status'));
      assert.ok(!tools.includes('list_tasks'));
    });

    it('does not register protocol task tools for older AdCP schema pins', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        adcpVersion: '3.0.12',
        taskRegistry,
      });
      const tools = registeredTools(server);
      assert.ok(!tools.includes('get_task_status'));
      assert.ok(!tools.includes('list_tasks'));
    });

    it('registers protocol task tools for the release-precision 3.1 pin', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        adcpVersion: '3.1',
        taskRegistry,
      });
      const tools = registeredTools(server);
      assert.ok(tools.includes('get_task_status'));
      assert.ok(tools.includes('list_tasks'));
    });

    it('registers protocol task tools for the 3.1.0 stable bundle pin', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        adcpVersion: '3.1.0',
        taskRegistry,
      });
      const tools = registeredTools(server);
      assert.ok(tools.includes('get_task_status'));
      assert.ok(tools.includes('list_tasks'));
    });

    it('validates protocol task tool requests on the built server', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        validation: { requests: 'strict' },
      });

      const status = await callToolRaw(server, 'get_task_status', {
        task_id: 'task_1',
        include_result: 'yes',
      });
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'VALIDATION_ERROR');

      const listed = await callToolRaw(server, 'list_tasks', {
        filters: { has_webhook: 'true' },
      });
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'VALIDATION_ERROR');

      const badAccount = await callToolRaw(server, 'get_task_status', {
        task_id: 'task_1',
        account: { account_id: 123 },
      });
      assert.strictEqual(badAccount.isError, true);
      assert.strictEqual(badAccount.structuredContent.adcp_error.code, 'VALIDATION_ERROR');

      const badListAccount = await callToolRaw(server, 'list_tasks', {
        account: { foo: 'bar' },
      });
      assert.strictEqual(badListAccount.isError, true);
      assert.strictEqual(badListAccount.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    });

    it('validates the task-query account extension even when request validation is off', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_1',
        ownerScope: 'account:acct_1',
      });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        validation: { requests: 'off' },
        resolveAccount: async () => ({ id: 'acct_1' }),
      });

      const status = await callToolRaw(server, 'get_task_status', {
        task_id: owned.taskId,
        account: { nope: 'x' },
      });
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'VALIDATION_ERROR');

      const listed = await callToolRaw(server, 'list_tasks', {
        account: { account_id: 123 },
        filters: { task_ids: [owned.taskId] },
      });
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    });

    it('rejects include_history on protocol task polling aliases because history is not stored', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_1',
        ownerScope: 'account:acct_1',
      });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccount: async () => ({ id: 'acct_1' }),
      });

      const status = await callToolRaw(server, 'get_task_status', {
        task_id: owned.taskId,
        include_history: true,
        account: { account_id: 'acct_1' },
      });
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.match(status.structuredContent.adcp_error.message, /include_history/);

      const listed = await callToolRaw(server, 'list_tasks', {
        include_history: true,
        account: { account_id: 'acct_1' },
      });
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.match(listed.structuredContent.adcp_error.message, /include_history/);
    });

    it('validates protocol task tool responses on the built server', async () => {
      const invalidTask = {
        taskId: 'task_invalid_status',
        tool: 'sync_creatives',
        accountId: 'acct_1',
        ownerScope: 'api_key:buyer-1',
        status: 'not-a-real-status',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:01:00.000Z',
      };
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        validation: { responses: 'strict' },
        taskRegistry: {
          async create() {
            return { taskId: invalidTask.taskId };
          },
          async getTask(taskId) {
            return taskId === invalidTask.taskId ? invalidTask : null;
          },
          async list() {
            return { tasks: [invalidTask] };
          },
          async complete() {},
          async fail() {},
          async updateProgress() {},
          _registerBackground() {},
          async awaitTask() {},
        },
        resolveAccountFromAuth: async () => ({ id: 'acct_1' }),
      });
      const buyerOne = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };

      const status = await callToolRaw(server, 'get_task_status', { task_id: invalidTask.taskId }, buyerOne);
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'VALIDATION_ERROR');

      const listed = await callToolRaw(server, 'list_tasks', {}, buyerOne);
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    });

    it('answers get_task_status/list_tasks from the scoped AdCP task registry only', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_1',
        ownerScope: 'api_key:buyer-1',
        hasWebhook: true,
      });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const other = await taskRegistry.create({
        tool: 'activate_signal',
        accountId: 'acct_2',
        ownerScope: 'api_key:buyer-2',
      });

      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccountFromAuth: async ctx => ({
          id:
            ctx.authInfo?.credential?.kind === 'api_key' && ctx.authInfo.credential.key_id === 'buyer-1'
              ? 'acct_1'
              : 'acct_2',
        }),
      });

      const buyerOne = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };
      const buyerTwo = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-2' } } };

      const status = await callTool(
        server,
        'get_task_status',
        { task_id: owned.taskId, include_result: true, context: { trace_id: 'trace_1' } },
        buyerOne
      );
      assert.strictEqual(status.task_id, owned.taskId);
      assert.strictEqual(status.status, 'completed');
      assert.strictEqual(status.task_type, 'sync_creatives');
      assert.strictEqual(status.protocol, 'creative');
      assert.strictEqual(status.has_webhook, true);
      assert.strictEqual(status.adcp_version, '3.1');
      assert.deepStrictEqual(status.result, { creatives: [{ creative_id: 'cr_1' }] });
      assert.deepStrictEqual(status.context, { trace_id: 'trace_1' });

      const crossTenant = await callToolRaw(server, 'get_task_status', { task_id: owned.taskId }, buyerTwo);
      assert.strictEqual(crossTenant.isError, true);
      assert.strictEqual(crossTenant.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');

      const listed = await callTool(
        server,
        'list_tasks',
        {
          filters: { protocols: ['creative'], statuses: ['completed'], context_contains: 'cr_1', has_webhook: true },
          pagination: { max_results: 1 },
        },
        buyerOne
      );
      assert.strictEqual(listed.query_summary.total_matching, 1);
      assert.strictEqual(listed.query_summary.returned, 1);
      assert.deepStrictEqual(listed.query_summary.status_breakdown, { completed: 1 });
      assert.strictEqual(listed.tasks.length, 1);
      assert.strictEqual(listed.tasks[0].task_id, owned.taskId);
      assert.strictEqual(listed.tasks[0].task_type, 'sync_creatives');
      assert.strictEqual(listed.tasks[0].has_webhook, true);
      assert.strictEqual(listed.pagination.total_count, 1);
      assert.strictEqual(listed.adcp_version, '3.1');

      const buyerTwoList = await callTool(
        server,
        'list_tasks',
        { filters: { task_ids: [owned.taskId, other.taskId] } },
        buyerTwo
      );
      assert.strictEqual(buyerTwoList.tasks.length, 1);
      assert.strictEqual(buyerTwoList.tasks[0].task_id, other.taskId);

      const badCursor = await callToolRaw(server, 'list_tasks', { pagination: { cursor: 'not-a-number' } }, buyerOne);
      assert.strictEqual(badCursor.isError, true);
      assert.strictEqual(badCursor.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.strictEqual(badCursor.structuredContent.adcp_version, '3.1');

      const opaqueTaskId = 'opaque_' + 'x'.repeat(160);
      const opaque = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_1',
        ownerScope: 'api_key:buyer-1',
        overrideTaskId: opaqueTaskId,
      });
      await taskRegistry.complete(opaque.taskId, { creatives: [{ creative_id: 'cr_opaque' }] });
      const opaqueStatus = await callTool(server, 'get_task_status', { task_id: opaqueTaskId }, buyerOne);
      assert.strictEqual(opaqueStatus.task_id, opaqueTaskId);

      const tooManyTaskIds = await callToolRaw(
        server,
        'list_tasks',
        { filters: { task_ids: Array.from({ length: 101 }, (_, i) => `task_${i}`) } },
        buyerOne
      );
      assert.strictEqual(tooManyTaskIds.isError, true);
      assert.strictEqual(tooManyTaskIds.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    });

    it('uses the task protocol map for media-buy event task filters', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_event_sources',
        accountId: 'acct_1',
        ownerScope: 'api_key:buyer-1',
      });
      await taskRegistry.complete(owned.taskId, { event_sources: [{ event_source_id: 'evt_1' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccountFromAuth: async () => ({ id: 'acct_1' }),
      });
      const buyerOne = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };

      const status = await callTool(server, 'get_task_status', { task_id: owned.taskId }, buyerOne);
      assert.strictEqual(status.protocol, 'media-buy');

      const mediaBuy = await callTool(server, 'list_tasks', { filters: { protocol: 'media-buy' } }, buyerOne);
      assert.strictEqual(mediaBuy.tasks.length, 1);
      assert.strictEqual(mediaBuy.tasks[0].task_id, owned.taskId);

      const measurement = await callTool(server, 'list_tasks', { filters: { protocol: 'measurement' } }, buyerOne);
      assert.deepStrictEqual(measurement.tasks, []);
    });

    it('does not leak tasks between credentials that resolve to the same account', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_shared',
        ownerScope: 'api_key:buyer-1',
      });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccountFromAuth: async () => ({ id: 'acct_shared' }),
      });
      const buyerTwo = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-2' } } };

      const status = await callToolRaw(server, 'get_task_status', { task_id: owned.taskId }, buyerTwo);
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');

      const listed = await callTool(server, 'list_tasks', { filters: { task_ids: [owned.taskId] } }, buyerTwo);
      assert.deepStrictEqual(listed.tasks, []);
    });

    it('uses sessionKey ahead of shared credentials for task alias ownership', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const channelA = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_shared',
        ownerScope: 'session:channel-a',
      });
      await taskRegistry.complete(channelA.taskId, { creatives: [{ creative_id: 'cr_a' }] });
      const channelB = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_shared',
        ownerScope: 'session:channel-b',
      });
      await taskRegistry.complete(channelB.taskId, { creatives: [{ creative_id: 'cr_b' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccountFromAuth: async () => ({ id: 'acct_shared' }),
        resolveSessionKey: async ({ params }) => params?.context?.publisher_account_id,
      });
      const sharedCredential = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };

      const owned = await callTool(
        server,
        'get_task_status',
        { task_id: channelA.taskId, context: { publisher_account_id: 'channel-a' } },
        sharedCredential
      );
      assert.strictEqual(owned.task_id, channelA.taskId);

      const crossSession = await callToolRaw(
        server,
        'get_task_status',
        { task_id: channelA.taskId, context: { publisher_account_id: 'channel-b' } },
        sharedCredential
      );
      assert.strictEqual(crossSession.isError, true);
      assert.strictEqual(crossSession.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');

      const listed = await callTool(
        server,
        'list_tasks',
        {
          filters: { task_ids: [channelA.taskId, channelB.taskId] },
          context: { publisher_account_id: 'channel-b' },
        },
        sharedCredential
      );
      assert.deepStrictEqual(
        listed.tasks.map(task => task.task_id),
        [channelB.taskId]
      );
    });

    it('filters list_tasks datetime boundaries by instant, not lexicographic string order', async () => {
      const tasks = [
        {
          taskId: 'task_equal_boundary',
          tool: 'sync_creatives',
          accountId: 'acct_1',
          ownerScope: 'api_key:buyer-1',
          status: 'completed',
          createdAt: '2026-05-01T05:00:00.000Z',
          updatedAt: '2026-05-01T05:00:00.000Z',
          result: { creatives: [{ creative_id: 'cr_equal' }] },
        },
        {
          taskId: 'task_after_boundary',
          tool: 'sync_creatives',
          accountId: 'acct_1',
          ownerScope: 'api_key:buyer-1',
          status: 'completed',
          createdAt: '2026-05-01T05:01:00.000Z',
          updatedAt: '2026-05-01T05:01:00.000Z',
          result: { creatives: [{ creative_id: 'cr_after' }] },
        },
      ];
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry: {
          async create() {
            return { taskId: 'unused' };
          },
          async getTask(taskId) {
            return tasks.find(task => task.taskId === taskId) ?? null;
          },
          async list() {
            return { tasks };
          },
          async complete() {},
          async fail() {},
          async updateProgress() {},
          _registerBackground() {},
          async awaitTask() {},
        },
        resolveAccountFromAuth: async () => ({ id: 'acct_1' }),
      });
      const buyerOne = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };

      const listed = await callTool(
        server,
        'list_tasks',
        { filters: { created_after: '2026-05-01T00:00:00-05:00' } },
        buyerOne
      );
      assert.deepStrictEqual(
        listed.tasks.map(task => task.task_id),
        ['task_after_boundary']
      );
    });

    it('defensively rechecks owner scope after custom taskRegistry.list results', async () => {
      const task = {
        taskId: 'task_owned_by_buyer_1',
        tool: 'sync_creatives',
        accountId: 'acct_shared',
        ownerScope: 'api_key:buyer-1',
        status: 'completed',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:01:00.000Z',
        result: { creatives: [{ creative_id: 'cr_1' }] },
      };
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry: {
          async create() {
            return { taskId: task.taskId };
          },
          async getTask(taskId) {
            return taskId === task.taskId ? task : null;
          },
          async list() {
            return { tasks: [task] };
          },
          async complete() {},
          async fail() {},
          async updateProgress() {},
          _registerBackground() {},
          async awaitTask() {},
        },
        resolveAccountFromAuth: async () => ({ id: 'acct_shared' }),
      });
      const buyerTwo = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-2' } } };

      const listed = await callTool(server, 'list_tasks', { filters: { task_ids: [task.taskId] } }, buyerTwo);
      assert.deepStrictEqual(listed.tasks, []);
    });

    it('does not ignore explicit task-query accounts when explicit resolution is unavailable', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_auth',
        ownerScope: 'api_key:buyer-1',
      });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccountFromAuth: async () => ({ id: 'acct_auth' }),
      });
      const buyerOne = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };

      const status = await callToolRaw(
        server,
        'get_task_status',
        { task_id: owned.taskId, account: { account_id: 'acct_other' } },
        buyerOne
      );
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');

      const listed = await callToolRaw(
        server,
        'list_tasks',
        { account: { account_id: 'acct_other' }, filters: { task_ids: [owned.taskId] } },
        buyerOne
      );
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    });

    it('serves legacy ownerless task records only through account-fallback scope', async () => {
      const task = {
        taskId: 'task_legacy_ownerless',
        tool: 'sync_creatives',
        accountId: 'acct_legacy',
        status: 'completed',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:01:00.000Z',
        result: { creatives: [{ creative_id: 'cr_legacy' }] },
      };
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry: {
          async create() {
            return { taskId: task.taskId };
          },
          async getTask(taskId) {
            return taskId === task.taskId ? task : null;
          },
          async list() {
            return { tasks: [task] };
          },
          async complete() {},
          async fail() {},
          async updateProgress() {},
          _registerBackground() {},
          async awaitTask() {},
        },
        resolveAccount: async ref => ({ id: ref.account_id }),
      });

      const status = await callToolRaw(server, 'get_task_status', {
        task_id: task.taskId,
        account: { account_id: 'acct_legacy' },
      });
      assert.notStrictEqual(status.isError, true, JSON.stringify(status.structuredContent));
      assert.strictEqual(status.structuredContent.task_id, task.taskId);

      const listed = await callTool(server, 'list_tasks', {
        account: { account_id: 'acct_legacy' },
        filters: { task_ids: [task.taskId] },
      });
      assert.strictEqual(listed.tasks.length, 1);
      assert.strictEqual(listed.tasks[0].task_id, task.taskId);

      const credentialScoped = await callToolRaw(
        server,
        'get_task_status',
        {
          task_id: task.taskId,
          account: { account_id: 'acct_legacy' },
        },
        { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } }
      );
      assert.strictEqual(credentialScoped.isError, true);
      assert.strictEqual(credentialScoped.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');
    });

    it('applies authInfo credential scanning to protocol task aliases', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({
        tool: 'sync_creatives',
        accountId: 'acct_1',
        ownerScope: 'api_key:buyer-1',
      });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        credentialPolicy: { policy: 'authInfo-only', scanAuthInfo: true },
        resolveAccountFromAuth: async () => ({ id: 'acct_1' }),
      });
      const extra = {
        authInfo: {
          credential: { kind: 'api_key', key_id: 'buyer-1' },
          extra: { upstream_access_token: 'sekret' },
        },
      };

      const status = await callToolRaw(server, 'get_task_status', { task_id: owned.taskId }, extra);
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
      assert.strictEqual(status.structuredContent.adcp_version, '3.1');

      const listed = await callToolRaw(server, 'list_tasks', {}, extra);
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
      assert.strictEqual(listed.structuredContent.adcp_version, '3.1');

      const contextLeak = await callToolRaw(
        server,
        'get_task_status',
        { task_id: owned.taskId, context: { upstream_access_token: 'sekret-context' } },
        { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } }
      );
      assert.strictEqual(contextLeak.isError, true);
      assert.strictEqual(contextLeak.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
      assert.strictEqual(contextLeak.structuredContent.context, undefined);
      assert.ok(!JSON.stringify(contextLeak).includes('sekret-context'));
    });

    it('fails closed when task polling has no account scope', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({ tool: 'sync_creatives', accountId: 'acct_1' });
      await taskRegistry.complete(owned.taskId, { creatives: [{ creative_id: 'cr_1' }] });
      const other = await taskRegistry.create({ tool: 'activate_signal', accountId: 'acct_2' });
      const server = createAdcpServer({ name: 'Test', version: '1.0.0', taskRegistry });

      const status = await callToolRaw(server, 'get_task_status', { task_id: owned.taskId, include_result: true });
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'REFERENCE_NOT_FOUND');

      const listed = await callTool(server, 'list_tasks', { filters: { task_ids: [owned.taskId, other.taskId] } });
      assert.deepStrictEqual(listed.tasks, []);
    });

    it('returns ACCOUNT_NOT_FOUND for explicit nonexistent task-query accounts', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({ tool: 'sync_creatives', accountId: 'acct_1' });
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccount: async () => null,
      });

      const status = await callToolRaw(server, 'get_task_status', {
        task_id: owned.taskId,
        account: { account_id: 'missing' },
      });
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');

      const listed = await callToolRaw(server, 'list_tasks', {
        account: { account_id: 'missing' },
        filters: { task_ids: [owned.taskId] },
      });
      assert.strictEqual(listed.isError, true);
      assert.strictEqual(listed.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    });

    it('applies responseEnhancer once on protocol task account-resolution errors', async () => {
      const taskRegistry = createInMemoryTaskRegistry();
      const owned = await taskRegistry.create({ tool: 'sync_creatives', accountId: 'acct_1' });
      let enhancerCalls = 0;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        taskRegistry,
        resolveAccount: async () => {
          throw new Error('account-db-down');
        },
        responseEnhancer: response => {
          enhancerCalls += 1;
          response.structuredContent = {
            ...(response.structuredContent ?? {}),
            enhancer_calls: enhancerCalls,
          };
        },
      });

      const status = await callToolRaw(server, 'get_task_status', {
        task_id: owned.taskId,
        account: { account_id: 'acct_1' },
      });
      assert.strictEqual(status.isError, true);
      assert.strictEqual(status.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
      assert.strictEqual(status.structuredContent.enhancer_calls, 1);
      assert.strictEqual(enhancerCalls, 1);
    });
  });

  describe('duplicate tool logging', () => {
    it('logs warning when tool registered by multiple domains', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        logger: {
          debug() {},
          info() {},
          warn(msg) {
            warnings.push(msg);
          },
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
    it('registers event tracking tools in their own domain without advertising experimental measurement', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
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

      const caps = await callTool(server, 'get_adcp_capabilities', {});
      assert.ok(caps.supported_protocols.includes('media_buy'));
      assert.ok(!caps.supported_protocols.includes('measurement'));
    });
  });

  describe('tool annotations', () => {
    it('sets readOnlyHint on read tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      const tool = registeredTool(server, 'get_products');
      assert.strictEqual(tool.annotations.readOnlyHint, true);
    });

    it('sets destructiveHint false on mutation tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
          createMediaBuy: async () => ({ media_buy_id: 'mb1', packages: [] }),
        },
      });
      const tool = registeredTool(server, 'create_media_buy');
      assert.strictEqual(tool.annotations.readOnlyHint, false);
      assert.strictEqual(tool.annotations.destructiveHint, false);
    });

    it('sets destructiveHint true on destructive tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        governance: {
          deletePropertyList: async () => ({ deleted: true }),
        },
      });
      const tool = registeredTool(server, 'delete_property_list');
      assert.strictEqual(tool.annotations.destructiveHint, true);
    });

    it('sets idempotentHint on sync tools', () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          syncCreatives: async () => ({ creatives: [] }),
        },
      });
      const tool = registeredTool(server, 'sync_creatives');
      assert.strictEqual(tool.annotations.idempotentHint, true);
    });
  });

  describe('unknown handler key warning', () => {
    it('warns when handler key is not recognized (typo)', () => {
      const warnings = [];
      createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        logger: {
          debug() {},
          info() {},
          warn(msg) {
            warnings.push(msg);
          },
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
        name: 'Test',
        version: '1.0.0',
        logger: {
          debug() {},
          info() {},
          warn(msg) {
            warnings.push(msg);
          },
          error() {},
        },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });
      assert.ok(!warnings.some(w => w.includes('Unknown handler key')));
    });
  });

  describe('state store', () => {
    it('provides ctx.store to handlers (InMemoryStateStore by default)', async () => {
      let receivedStore;
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async (params, ctx) => {
            receivedStore = ctx.store;
            return { products: [] };
          },
        },
      });

      await callTool(server, 'get_products', { buying_mode: 'brief', brief: 'test' });
      assert.ok(receivedStore);
      assert.strictEqual(typeof receivedStore.get, 'function');
      assert.strictEqual(typeof receivedStore.put, 'function');
      assert.strictEqual(typeof receivedStore.delete, 'function');
      assert.strictEqual(typeof receivedStore.list, 'function');
    });

    it('accepts a custom state store', async () => {
      const store = new InMemoryStateStore();
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        stateStore: store,
        mediaBuy: {
          createMediaBuy: async (params, ctx) => {
            const buy = { media_buy_id: 'mb_1', status: 'active', packages: [] };
            await ctx.store.put('media_buys', buy.media_buy_id, buy);
            return buy;
          },
          getMediaBuys: async (params, ctx) => {
            const result = await ctx.store.list('media_buys');
            return { media_buys: result.items };
          },
        },
      });

      // Create a media buy
      await callTool(server, 'create_media_buy', {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
      });

      // Verify it's in the store
      assert.strictEqual(store.size('media_buys'), 1);
      const stored = await store.get('media_buys', 'mb_1');
      assert.strictEqual(stored.status, 'active');

      // Read it back through the handler
      const buys = await callTool(server, 'get_media_buys', {});
      assert.strictEqual(buys.media_buys.length, 1);
      assert.strictEqual(buys.media_buys[0].media_buy_id, 'mb_1');
    });

    it('shares state store across domain handlers', async () => {
      const store = new InMemoryStateStore();
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        stateStore: store,
        mediaBuy: {
          getProducts: async (params, ctx) => {
            await ctx.store.put('shared', 'flag', { set_by: 'mediaBuy' });
            return { products: [] };
          },
        },
        signals: {
          getSignals: async (params, ctx) => {
            const flag = await ctx.store.get('shared', 'flag');
            return { signals: [{ signal_id: 'test', source: flag?.set_by }] };
          },
        },
      });

      await callTool(server, 'get_products', { buying_mode: 'brief', brief: 'test' });
      const result = await callTool(server, 'get_signals', {});
      assert.strictEqual(result.signals[0].source, 'mediaBuy');
    });
  });

  describe('InMemoryStateStore', () => {
    it('get returns null for missing documents', async () => {
      const store = new InMemoryStateStore();
      const result = await store.get('col', 'missing');
      assert.strictEqual(result, null);
    });

    it('put and get roundtrip', async () => {
      const store = new InMemoryStateStore();
      await store.put('col', 'id1', { name: 'test', value: 42 });
      const result = await store.get('col', 'id1');
      assert.deepStrictEqual(result, { name: 'test', value: 42 });
    });

    it('put overwrites existing documents', async () => {
      const store = new InMemoryStateStore();
      await store.put('col', 'id1', { v: 1 });
      await store.put('col', 'id1', { v: 2 });
      const result = await store.get('col', 'id1');
      assert.strictEqual(result.v, 2);
    });

    it('delete returns true for existing, false for missing', async () => {
      const store = new InMemoryStateStore();
      await store.put('col', 'id1', { v: 1 });
      assert.strictEqual(await store.delete('col', 'id1'), true);
      assert.strictEqual(await store.delete('col', 'id1'), false);
      assert.strictEqual(await store.get('col', 'id1'), null);
    });

    it('list returns all documents in collection', async () => {
      const store = new InMemoryStateStore();
      await store.put('buys', 'mb1', { status: 'active' });
      await store.put('buys', 'mb2', { status: 'paused' });
      await store.put('other', 'x', { unrelated: true });

      const result = await store.list('buys');
      assert.strictEqual(result.items.length, 2);
    });

    it('list filters by field values', async () => {
      const store = new InMemoryStateStore();
      await store.put('buys', 'mb1', { status: 'active' });
      await store.put('buys', 'mb2', { status: 'paused' });
      await store.put('buys', 'mb3', { status: 'active' });

      const result = await store.list('buys', { filter: { status: 'active' } });
      assert.strictEqual(result.items.length, 2);
    });

    it('list respects limit', async () => {
      const store = new InMemoryStateStore();
      for (let i = 0; i < 10; i++) {
        await store.put('col', `id${i}`, { i });
      }

      const result = await store.list('col', { limit: 3 });
      assert.strictEqual(result.items.length, 3);
      assert.ok(result.nextCursor);
    });

    it('get returns a copy (mutations do not affect store)', async () => {
      const store = new InMemoryStateStore();
      await store.put('col', 'id1', { name: 'original' });
      const result = await store.get('col', 'id1');
      result.name = 'mutated';
      const result2 = await store.get('col', 'id1');
      assert.strictEqual(result2.name, 'original');
    });

    it('patch merges fields into existing document', async () => {
      const store = new InMemoryStateStore();
      await store.put('col', 'id1', { status: 'active', budget: 1000 });
      await store.patch('col', 'id1', { status: 'paused' });
      const result = await store.get('col', 'id1');
      assert.strictEqual(result.status, 'paused');
      assert.strictEqual(result.budget, 1000);
    });

    it('patch creates document if it does not exist', async () => {
      const store = new InMemoryStateStore();
      await store.patch('col', 'id1', { status: 'new' });
      const result = await store.get('col', 'id1');
      assert.strictEqual(result.status, 'new');
    });

    it('cursor-based pagination roundtrip', async () => {
      const store = new InMemoryStateStore();
      for (let i = 0; i < 5; i++) {
        await store.put('col', `id${i}`, { i });
      }

      const page1 = await store.list('col', { limit: 2 });
      assert.strictEqual(page1.items.length, 2);
      assert.ok(page1.nextCursor);

      const page2 = await store.list('col', { limit: 2, cursor: page1.nextCursor });
      assert.strictEqual(page2.items.length, 2);
      assert.ok(page2.nextCursor);

      const page3 = await store.list('col', { limit: 2, cursor: page2.nextCursor });
      assert.strictEqual(page3.items.length, 1);
      assert.strictEqual(page3.nextCursor, undefined);

      // All 5 items across 3 pages, no duplicates
      const allItems = [...page1.items, ...page2.items, ...page3.items];
      assert.strictEqual(allItems.length, 5);
      const allValues = allItems.map(item => item.i).sort();
      assert.deepStrictEqual(allValues, [0, 1, 2, 3, 4]);
    });

    it('list returns copies (mutations do not affect store)', async () => {
      const store = new InMemoryStateStore();
      await store.put('col', 'id1', { name: 'original' });
      const result = await store.list('col');
      result.items[0].name = 'mutated';
      const result2 = await store.list('col');
      assert.strictEqual(result2.items[0].name, 'original');
    });

    it('list caps limit at MAX_PAGE_SIZE', async () => {
      const store = new InMemoryStateStore();
      // Just verify it doesn't crash — we can't easily test the cap value
      const result = await store.list('col', { limit: 999999 });
      assert.ok(Array.isArray(result.items));
    });

    it('clear removes all data', async () => {
      const store = new InMemoryStateStore();
      await store.put('a', '1', { v: 1 });
      await store.put('b', '2', { v: 2 });
      store.clear();
      assert.strictEqual(store.size('a'), 0);
      assert.strictEqual(store.size('b'), 0);
    });
  });

  describe('cross-domain specialism declaration', () => {
    // Drift class from matrix issue #785: an agent wires creative/signals/
    // brandRights handlers but forgets to claim the matching specialism in
    // capabilities.specialisms. The conformance runner then reports "No
    // applicable tracks found for this agent" silently. createAdcpServer
    // logs an error so the mismatch surfaces in boot diagnostics — not
    // thrown so middleware-only test harnesses keep working.

    const noopHandler = async () => ({});

    function captureLoggerErrors() {
      const errors = [];
      return {
        logger: {
          error: msg => errors.push(msg),
          warn: () => {},
          info: () => {},
          debug: () => {},
        },
        errors,
      };
    }

    it('logs error when creative handlers are wired without a creative specialism', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        creative: { listCreativeFormats: noopHandler },
        capabilities: { specialisms: [] },
      });
      assert.ok(
        errors.some(e => e.includes('creative handlers are wired but capabilities.specialisms does not include')),
        `expected creative-specialism warning, got: ${JSON.stringify(errors)}`
      );
    });

    it('does NOT log when creative handlers + creative-template claim are aligned', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        creative: { listCreativeFormats: noopHandler },
        capabilities: { specialisms: ['creative-template'] },
      });
      assert.ok(
        !errors.some(e => e.includes('creative handlers are wired')),
        `did not expect creative-specialism warning, got: ${JSON.stringify(errors)}`
      );
    });

    it('logs error when signals handlers are wired without a signals specialism', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        signals: { getSignals: noopHandler },
        capabilities: { specialisms: ['creative-template'] },
      });
      assert.ok(
        errors.some(e => e.includes('signals handlers are wired but capabilities.specialisms does not include')),
        `expected signals-specialism warning, got: ${JSON.stringify(errors)}`
      );
    });

    it('logs error when brandRights handlers are wired without brand-rights claimed', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        brandRights: { acquireRights: noopHandler },
        capabilities: { specialisms: ['creative-template'] },
      });
      assert.ok(
        errors.some(e => e.includes('brandRights handlers are wired but capabilities.specialisms does not include')),
        `expected brandRights-specialism warning, got: ${JSON.stringify(errors)}`
      );
    });

    it('does not warn on mediaBuy without a specialism (commercial-significance carve-out)', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        mediaBuy: { getProducts: noopHandler },
        capabilities: { specialisms: [] },
      });
      assert.ok(
        !errors.some(e => e.includes('mediaBuy handlers are wired')),
        `mediaBuy should be exempt; got: ${JSON.stringify(errors)}`
      );
    });

    it('does not warn when no domain handlers are wired', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        capabilities: { specialisms: [] },
      });
      assert.ok(
        !errors.some(e => e.includes('handlers are wired but')),
        `no warning expected when no handlers wired; got: ${JSON.stringify(errors)}`
      );
    });

    it('logs error when governance handlers are wired without a governance specialism', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        governance: { getPropertyList: noopHandler },
        capabilities: { specialisms: ['creative-template'] },
      });
      assert.ok(
        errors.some(e => e.includes('governance handlers are wired but capabilities.specialisms does not include')),
        `expected governance-specialism warning, got: ${JSON.stringify(errors)}`
      );
    });

    it('accepts governance handlers when property-lists is claimed', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        governance: { getPropertyList: noopHandler },
        capabilities: { specialisms: ['property-lists'] },
      });
      assert.ok(
        !errors.some(e => e.includes('governance handlers are wired')),
        `did not expect governance warning, got: ${JSON.stringify(errors)}`
      );
    });

    it('does not warn for an empty domain handlers object', () => {
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        creative: {},
        capabilities: { specialisms: [] },
      });
      assert.ok(
        !errors.some(e => e.includes('creative handlers are wired')),
        `empty creative {} should not trigger warning; got: ${JSON.stringify(errors)}`
      );
    });

    it('does not warn when handler keys are present but values are undefined', () => {
      // Repro of the edge case where `{ ...maybeHandlers }` spreads in a key
      // with an undefined value — Object.keys would count the key, but no
      // real handler is wired. Filter to function-valued keys.
      const { logger, errors } = captureLoggerErrors();
      createAdcpServer({
        name: 'test',
        version: '1.0.0',
        logger,
        creative: { listCreativeFormats: undefined, buildCreative: undefined },
        capabilities: { specialisms: [] },
      });
      assert.ok(
        !errors.some(e => e.includes('creative handlers are wired')),
        `undefined-value keys should not trigger warning; got: ${JSON.stringify(errors)}`
      );
    });
  });
});
