const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SingleAgentClient,
  FeatureUnsupportedError,
  ProtocolFeatureUnsupportedError,
  getClientPreflightAdcpError,
} = require('../../dist/lib/index.js');
const {
  registerExternalSchemaRoot,
  unregisterExternalSchemaRoot,
  _resetValidationLoader,
} = require('../../dist/lib/validation/schema-loader.js');

const ADCP_30_PIN = '3.0.12';
let schemaRoot;

function writeMinimalPre31SchemaRoot(root) {
  const bundledDir = path.join(root, 'bundled', 'signals');
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundledDir, 'get-signals-request.json'),
    JSON.stringify({
      $id: `/schemas/${ADCP_30_PIN}/bundled/signals/get-signals-request.json`,
      type: 'object',
      properties: {
        signal_spec: { type: 'string' },
      },
      required: ['signal_spec'],
      additionalProperties: false,
    })
  );
}

function makePre31Client(config = {}) {
  return new SingleAgentClient(
    {
      id: 'seller',
      name: 'Seller',
      agent_uri: 'https://seller.example.com/mcp',
      protocol: 'mcp',
    },
    {
      adcpVersion: ADCP_30_PIN,
      validateFeatures: false,
      validation: { requests: 'strict', responses: 'off' },
      ...config,
    }
  );
}

function assertPre31Unsupported(err, expected) {
  assert.ok(
    err instanceof FeatureUnsupportedError,
    `expected FeatureUnsupportedError, got ${err?.constructor?.name}`
  );
  assert.ok(
    err instanceof ProtocolFeatureUnsupportedError,
    `expected ProtocolFeatureUnsupportedError, got ${err?.constructor?.name}`
  );
  assert.strictEqual(err.code, 'UNSUPPORTED_FEATURE');
  assert.match(err.message, /requires AdCP 3\.1 or later/);
  assert.doesNotMatch(err.message, /signal_spec/);
  assert.strictEqual(err.details.required_version, '3.1');
  assert.strictEqual(err.details.capability_path, expected.capabilityPath);
  assert.strictEqual(err.details.current_version, ADCP_30_PIN);
  assert.strictEqual(err.details.field, expected.field);
  assert.strictEqual(err.details.tool, expected.tool);
  assert.deepStrictEqual(err.details.unsupported_features, [expected.feature]);
  assert.deepStrictEqual(getClientPreflightAdcpError(err), {
    code: 'UNSUPPORTED_FEATURE',
    message: err.message,
    recovery: 'correctable',
    field: expected.field,
    suggestion: expected.suggestion,
    details: err.details,
  });
  return true;
}

function assertWholesaleUnsupported(err) {
  return assertPre31Unsupported(err, {
    tool: 'get_signals',
    field: 'discovery_mode',
    feature: 'get_signals.discovery_mode=wholesale',
    capabilityPath: 'signals.discovery_modes',
    suggestion: 'Probe get_adcp_capabilities at signals.discovery_modes before issuing wholesale calls.',
  });
}

function assertPushConfigUnsupported(tool) {
  return err =>
    assertPre31Unsupported(err, {
      tool,
      field: 'push_notification_config',
      feature: `${tool}.push_notification_config`,
      capabilityPath: 'adcp.supported_versions',
      suggestion:
        'Probe get_adcp_capabilities at adcp.supported_versions before relying on discovery task webhooks.',
    });
}

before(() => {
  schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-pre31-schema-'));
  writeMinimalPre31SchemaRoot(schemaRoot);
  registerExternalSchemaRoot(ADCP_30_PIN, schemaRoot);
});

after(() => {
  unregisterExternalSchemaRoot(ADCP_30_PIN);
  _resetValidationLoader(ADCP_30_PIN);
  fs.rmSync(schemaRoot, { recursive: true, force: true });
});

describe('get_signals wholesale against pre-3.1 client pin', () => {
  test('typed getSignals throws UNSUPPORTED_FEATURE before schema validation', async () => {
    const client = makePre31Client();

    await assert.rejects(() => client.getSignals({ discovery_mode: 'wholesale' }), assertWholesaleUnsupported);
  });

  test('generic executeTask throws the same typed error before schema validation', async () => {
    const client = makePre31Client();

    await assert.rejects(
      () => client.executeTask('get_signals', { discovery_mode: 'wholesale' }),
      assertWholesaleUnsupported
    );
  });

  test('getSignals push_notification_config throws UNSUPPORTED_FEATURE before schema validation', async () => {
    const client = makePre31Client();

    await assert.rejects(
      () =>
        client.getSignals({
          signal_spec: 'sports fans',
          push_notification_config: { url: 'https://buyer.example.com/adcp-webhook' },
        }),
      assertPushConfigUnsupported('get_signals')
    );
  });

  test('getProducts push_notification_config throws UNSUPPORTED_FEATURE before schema validation', async () => {
    const client = makePre31Client();

    await assert.rejects(
      () =>
        client.getProducts({
          buying_mode: 'brief',
          brief: 'sports fans',
          push_notification_config: { url: 'https://buyer.example.com/adcp-webhook' },
        }),
      assertPushConfigUnsupported('get_products')
    );
  });

  test('generic executeTask get_products push_notification_config throws the same typed error', async () => {
    const client = makePre31Client();

    await assert.rejects(
      () =>
        client.executeTask('get_products', {
          buying_mode: 'brief',
          brief: 'sports fans',
          push_notification_config: { url: 'https://buyer.example.com/adcp-webhook' },
        }),
      assertPushConfigUnsupported('get_products')
    );
  });

  test('webhookUrlTemplate injection throws the same pre-3.1 push_notification_config error', async () => {
    const client = makePre31Client({
      webhookUrlTemplate: 'https://buyer.example.com/adcp-webhook/{task_type}/{agent_id}/{operation_id}',
    });

    await assert.rejects(
      () =>
        client.getSignals({
          signal_spec: 'sports fans',
        }),
      assertPushConfigUnsupported('get_signals')
    );
  });

  test('conditional feed version probes are not treated as pre-3.1 unsupported features', async () => {
    const client = makePre31Client();

    await assert.rejects(
      () =>
        client.getSignals({
          signal_spec: 'sports fans',
          if_wholesale_feed_version: 'feed-v1',
          if_pricing_version: 'pricing-v1',
        }),
      err => {
        assert.ok(
          !(err instanceof ProtocolFeatureUnsupportedError),
          'conditional version probes should fall through instead of throwing UNSUPPORTED_FEATURE'
        );
        assert.notStrictEqual(err.code, 'UNSUPPORTED_FEATURE');
        return true;
      }
    );
  });
});
