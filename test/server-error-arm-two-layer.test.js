// Schema-driven regression test for issue #1606 / RFC
// docs/proposals/adcperror-two-layer-emission.md.
//
// For every AdCP tool whose response schema declares a top-level Error
// arm (`required: ["errors"]`), assert that the SDK's failure path
// emits a response satisfying the tool's response schema. Both error
// paths are covered:
//
//   1. Adopter calls `adcpError(code, options)` — emits envelope only;
//      framework auto-wraps `errors[]` from the same data.
//   2. Adopter returns `{errors: [...]}` arm directly — emits payload
//      only; framework auto-wraps `adcp_error` from the first item.
//
// The set of tools is derived dynamically from the bundled schema cache
// so adding a new Error-arm tool in a future AdCP version automatically
// extends coverage.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { adcpError } = require('../dist/lib/server/errors');
const { getToolsWithErrorArm } = require('../dist/lib/server/error-arm-tools');
const { getValidator } = require('../dist/lib/validation/schema-loader');

// Disable schema validation in the dispatcher itself so the test only
// asserts wire-shape-correctness of the dispatcher's emitted response,
// not request-side gating that some tools have stricter shapes for.
function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

async function callToolRaw(server, toolName, params) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: toolName, arguments: params ?? {} },
  });
}

// Maps tool name → (handlerKey, domainKey, requestArgs). The dispatcher
// routes handlers via `domainKey.handlerKey` keyed off the tool name.
// Request args are the minimum shape that won't trip request-side
// schema validation when it's enabled — for this test it stays off, so
// `{}` is sufficient for most tools, with a few that need an `account`
// to satisfy the framework's account-resolution gate.
const TOOL_REGISTRATION = {
  create_media_buy: {
    domain: 'mediaBuy',
    key: 'createMediaBuy',
    args: {
      account: { account_id: 'a1' },
      brand: { brand_id: 'b1' },
      start_time: '2026-01-01T00:00:00Z',
      end_time: '2026-02-01T00:00:00Z',
    },
  },
  update_media_buy: { domain: 'mediaBuy', key: 'updateMediaBuy', args: { media_buy_id: 'mb_1' } },
  sync_creatives: {
    domain: 'creative',
    key: 'syncCreatives',
    args: { account: { account_id: 'a1' }, creatives: [], idempotency_key: '11111111-1111-1111-1111-111111111111' },
  },
  build_creative: { domain: 'creative', key: 'buildCreative', args: {} },
  provide_performance_feedback: { domain: 'mediaBuy', key: 'providePerformanceFeedback', args: {} },
  sync_event_sources: { domain: 'eventTracking', key: 'syncEventSources', args: {} },
  log_event: { domain: 'eventTracking', key: 'logEvent', args: {} },
  sync_audiences: { domain: 'eventTracking', key: 'syncAudiences', args: {} },
  sync_catalogs: { domain: 'eventTracking', key: 'syncCatalogs', args: {} },
  activate_signal: { domain: 'signals', key: 'activateSignal', args: {} },
  list_content_standards: { domain: 'governance', key: 'listContentStandards', args: {} },
  get_content_standards: { domain: 'governance', key: 'getContentStandards', args: {} },
  create_content_standards: { domain: 'governance', key: 'createContentStandards', args: {} },
  update_content_standards: { domain: 'governance', key: 'updateContentStandards', args: {} },
  calibrate_content: { domain: 'governance', key: 'calibrateContent', args: {} },
  validate_content_delivery: { domain: 'governance', key: 'validateContentDelivery', args: {} },
  get_media_buy_artifacts: { domain: 'governance', key: 'getMediaBuyArtifacts', args: {} },
  get_creative_features: { domain: 'governance', key: 'getCreativeFeatures', args: {} },
};

const TOOLS = [...getToolsWithErrorArm().keys()].sort();

describe('two-layer error emission (RFC #1608, issue #1606)', () => {
  it('schema audit: 18 tools have a top-level Error arm', () => {
    // Lock the count — drift here means a new AdCP minor changed which
    // tools require two-layer emission. Update this assertion AND the
    // RFC's affected-tools list together.
    assert.strictEqual(TOOLS.length, 18, `expected 18 Error-arm tools, got ${TOOLS.length}: ${TOOLS.join(', ')}`);
  });

  it('coverage: every Error-arm tool has a registration entry in this test', () => {
    // The registration table must enumerate every Error-arm tool —
    // otherwise a new tool ships without a regression test.
    const missing = TOOLS.filter(t => !TOOL_REGISTRATION[t]);
    assert.deepStrictEqual(missing, [], `add registration for: ${missing.join(', ')}`);
  });

  describe('Path A: handler calls adcpError() — framework synthesises payload errors[]', () => {
    for (const toolName of TOOLS) {
      const reg = TOOL_REGISTRATION[toolName];
      if (!reg) continue;
      it(`${toolName} emits both adcp_error envelope and errors[] payload`, async () => {
        const server = createAdcpServer({
          name: 'Test',
          version: '1.0.0',
          [reg.domain]: {
            [reg.key]: async () =>
              adcpError('VALIDATION_ERROR', {
                message: `${toolName}: synthetic error for two-layer test`,
                field: 'synthetic_field',
              }),
          },
        });
        const result = await callToolRaw(server, toolName, reg.args);

        assert.strictEqual(result.isError, true, 'isError flag set');

        // Envelope layer present.
        const sc = result.structuredContent;
        assert.ok(sc, 'structuredContent present');
        assert.ok(sc.adcp_error, 'adcp_error envelope present');
        assert.strictEqual(sc.adcp_error.code, 'VALIDATION_ERROR');

        // Payload layer auto-synthesised from the envelope.
        assert.ok(Array.isArray(sc.errors), 'errors[] payload synthesised');
        assert.strictEqual(sc.errors.length, 1);
        assert.strictEqual(sc.errors[0].code, 'VALIDATION_ERROR');
        assert.strictEqual(sc.errors[0].message, sc.adcp_error.message);
        assert.strictEqual(sc.errors[0].field, sc.adcp_error.field);

        // Schema validates against the bundled response schema.
        const validate = getValidator(toolName, 'sync');
        assert.ok(validate, `validator exists for ${toolName}`);
        const valid = validate(sc);
        assert.ok(valid, `${toolName} response failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`);

        // L2 text fallback mirrors structuredContent (JSON envelope from
        // adcpError() — wrapErrorArm uses prose, covered separately).
        const parsed = JSON.parse(result.content[0].text);
        assert.deepStrictEqual(parsed.adcp_error, sc.adcp_error);
        assert.deepStrictEqual(parsed.errors, sc.errors);
      });
    }
  });

  describe('Path B: handler returns {errors:[...]} arm — framework synthesises adcp_error envelope', () => {
    for (const toolName of TOOLS) {
      const reg = TOOL_REGISTRATION[toolName];
      if (!reg) continue;
      it(`${toolName} synthesises adcp_error envelope from typed Error arm`, async () => {
        const server = createAdcpServer({
          name: 'Test',
          version: '1.0.0',
          [reg.domain]: {
            [reg.key]: async () => ({
              errors: [
                {
                  code: 'PRODUCT_NOT_FOUND',
                  message: `${toolName}: synthetic error for two-layer test`,
                  field: 'synthetic_field',
                },
              ],
            }),
          },
        });
        const result = await callToolRaw(server, toolName, reg.args);

        assert.strictEqual(result.isError, true);

        const sc = result.structuredContent;
        assert.ok(Array.isArray(sc.errors));
        assert.strictEqual(sc.errors[0].code, 'PRODUCT_NOT_FOUND');

        // Envelope auto-synthesised from the first payload item.
        assert.ok(sc.adcp_error, 'adcp_error envelope synthesised');
        assert.strictEqual(sc.adcp_error.code, 'PRODUCT_NOT_FOUND');
        assert.strictEqual(sc.adcp_error.message, sc.errors[0].message);
        assert.strictEqual(sc.adcp_error.field, sc.errors[0].field);

        // Schema validates against the bundled response schema.
        const validate = getValidator(toolName, 'sync');
        assert.ok(validate);
        const valid = validate(sc);
        assert.ok(valid, `${toolName} response failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`);
      });
    }
  });

  describe('idempotency: handlers that already emit both layers pass through unchanged', () => {
    it('does not duplicate or replace pre-emitted errors[]', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  adcp_error: { code: 'CUSTOM_CODE', message: 'pre-emitted by adopter' },
                  errors: [{ code: 'CUSTOM_CODE', message: 'pre-emitted by adopter', recovery: 'transient' }],
                }),
              },
            ],
            structuredContent: {
              adcp_error: { code: 'CUSTOM_CODE', message: 'pre-emitted by adopter' },
              errors: [{ code: 'CUSTOM_CODE', message: 'pre-emitted by adopter', recovery: 'transient' }],
            },
          }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', TOOL_REGISTRATION.create_media_buy.args);
      const sc = result.structuredContent;
      assert.strictEqual(sc.errors.length, 1, 'errors[] not duplicated');
      assert.strictEqual(sc.errors[0].recovery, 'transient', 'adopter recovery preserved');
      assert.strictEqual(sc.adcp_error.code, 'CUSTOM_CODE');
    });
  });

  describe('non-Error-arm tools are not wrapped', () => {
    it('get_products error response stays envelope-only (no spurious errors[])', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async () => adcpError('RATE_LIMITED', { message: 'slow down', retry_after: 30 }),
        },
      });
      const result = await callToolRaw(server, 'get_products', { brief: 'test', buying_mode: 'brief' });
      const sc = result.structuredContent;
      assert.ok(sc.adcp_error, 'envelope present');
      assert.strictEqual(sc.adcp_error.code, 'RATE_LIMITED');
      assert.ok(!('errors' in sc), 'errors[] NOT synthesised on non-Error-arm tool');
    });

    it('get_signals error response stays envelope-only', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        signals: {
          getSignals: async () => adcpError('PERMISSION_DENIED', { message: 'no access' }),
        },
      });
      const result = await callToolRaw(server, 'get_signals', {});
      const sc = result.structuredContent;
      assert.ok(sc.adcp_error);
      assert.ok(!('errors' in sc), 'errors[] NOT synthesised on get_signals');
    });
  });

  describe('comply_test_controller is NOT in the wrap set', () => {
    // The test controller is framework-internal and not part of the AdCP
    // schema cache, so the gate's schema-derivation never picks it up.
    // Locking this in case someone bundles a synthetic schema for it.
    it('comply_test_controller is not in TOOLS_WITH_ERROR_ARM', () => {
      const map = getToolsWithErrorArm();
      assert.ok(!map.has('comply_test_controller'));
      assert.ok(!map.has('comply_test_controller_simulate'));
    });
  });

  describe('success path is untouched on Error-arm tools', () => {
    it('successful create_media_buy response carries no adcp_error/errors layers', async () => {
      const server = createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        mediaBuy: {
          createMediaBuy: async () => ({ media_buy_id: 'mb_1', packages: [] }),
        },
      });
      const result = await callToolRaw(server, 'create_media_buy', TOOL_REGISTRATION.create_media_buy.args);
      const sc = result.structuredContent;
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(sc.adcp_error, undefined);
      assert.strictEqual(sc.errors, undefined);
    });
  });
});
