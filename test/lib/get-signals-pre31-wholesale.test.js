const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SingleAgentClient,
  ProtocolClient,
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

function makeModernClientTargeting30(protocol = 'mcp', config = {}, capabilityOverrides = {}) {
  const client = new SingleAgentClient(
    {
      id: `seller-${protocol}`,
      name: `Seller ${protocol}`,
      agent_uri: protocol === 'mcp' ? 'https://seller.example.com/mcp' : 'https://seller.example.com',
      protocol,
    },
    {
      adcpVersion: '3.2.0-rc.0',
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      ...config,
    }
  );
  const capabilities = {
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [ADCP_30_PIN],
    protocols: ['signals', 'media_buy'],
    features: {},
    extensions: [],
    _synthetic: false,
    ...capabilityOverrides,
  };
  client.getCapabilities = async () => capabilities;
  client.ensureEndpointDiscovered = async () => client.agent;
  return client;
}

function assertPre31Unsupported(err, expected) {
  assert.ok(err instanceof FeatureUnsupportedError, `expected FeatureUnsupportedError, got ${err?.constructor?.name}`);
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
      suggestion: 'Probe get_adcp_capabilities at adcp.supported_versions before relying on discovery task webhooks.',
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

  test('auto-injected webhookUrlTemplate degrades to polling (no throw, webhook suppressed)', async () => {
    // An auto-injected discovery webhook (from webhookUrlTemplate) is the
    // library's doing, not the caller's: degrade it to polling for a pre-3.1
    // pin instead of throwing. Contrast with the explicit-config cases above,
    // which remain caller misuse and still throw.
    const client = makePre31Client({
      webhookUrlTemplate: 'https://buyer.example.com/adcp-webhook/{task_type}/{agent_id}/{operation_id}',
    });
    client.ensureEndpointDiscovered = async () => client.agent;
    client.detectServerVersion = async () => 'v3';
    client.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };

    const calls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agent, _taskName, _params, options) => {
      calls.push(options);
      return { status: 'completed', signals: [] };
    };
    try {
      const result = await client.getSignals({ signal_spec: 'sports fans' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].webhookUrl, undefined);
      const driftLog = (result.debug_logs ?? []).find(l => l.type === 'pre31_webhook_degraded');
      assert.ok(driftLog, 'expected a pre31_webhook_degraded debug log');
      assert.strictEqual(driftLog.taskName, 'get_signals');
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
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

describe('modern client cold-call downgrade to a 3.0 seller', () => {
  for (const protocol of ['mcp', 'a2a']) {
    test(`${protocol.toUpperCase()} wholesale getSignals fails with a typed recovery path`, async () => {
      const client = makeModernClientTargeting30(protocol);
      await assert.rejects(
        () => client.getSignals({ discovery_mode: 'wholesale' }),
        err => {
          assert.ok(err instanceof ProtocolFeatureUnsupportedError);
          assert.match(err.message, /target seller does not advertise AdCP 3\.1 support/);
          assert.strictEqual(err.details.current_version, ADCP_30_PIN);
          assert.strictEqual(err.details.field, 'discovery_mode');
          assert.match(err.adcpError.suggestion, /meaningful signal_spec/);
          return true;
        }
      );
    });

    test(`${protocol.toUpperCase()} rejects wholesale when a legacy seller omits release metadata`, async () => {
      const client = makeModernClientTargeting30(protocol, {}, { supportedVersions: undefined });
      await assert.rejects(
        () => client.getSignals({ discovery_mode: 'wholesale' }),
        err => err instanceof ProtocolFeatureUnsupportedError && err.details.current_version === '3.0 (not advertised)'
      );
    });

    test(`${protocol.toUpperCase()} ignores advisory buildVersion when supportedVersions is 3.0`, async () => {
      const client = makeModernClientTargeting30(
        protocol,
        {},
        {
          buildVersion: '3.2.0',
          supportedVersions: ['3.0'],
          _raw: { adcp_version: '3.2-beta.5' },
        }
      );
      await assert.rejects(
        () => client.getSignals({ discovery_mode: 'wholesale' }),
        err => err instanceof ProtocolFeatureUnsupportedError && err.details.current_version === '3.0'
      );
    });

    test(`${protocol.toUpperCase()} accepts wholesale when the response envelope proves a 3.1+ wire release`, async () => {
      const client = makeModernClientTargeting30(
        protocol,
        {},
        { supportedVersions: undefined, _raw: { adcp_version: '3.2-beta.5' } }
      );
      const originalCallTool = ProtocolClient.callTool;
      const calls = [];
      ProtocolClient.callTool = async (_agent, taskName, params) => {
        calls.push({ taskName, params });
        return { status: 'completed', signals: [] };
      };
      try {
        await client.getSignals({ discovery_mode: 'wholesale' });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].params.discovery_mode, 'wholesale');
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    test(`${protocol.toUpperCase()} strips explicit discovery webhook config for a 3.0 seller`, async () => {
      const client = makeModernClientTargeting30(protocol);
      const calls = [];
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async (_agent, taskName, params, options) => {
        calls.push({ taskName, params, options });
        return { status: 'completed', products: [] };
      };
      try {
        const result = await client.getProducts({
          buying_mode: 'brief',
          brief: 'sports fans',
          push_notification_config: { url: 'https://buyer.example.com/adcp-webhook' },
        });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].params.push_notification_config, undefined);
        assert.ok(result.debug_logs.some(log => log.type === 'pre31_discovery_webhook_stripped'));
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    test(`${protocol.toUpperCase()} strips explicit get_signals webhook config for a 3.0 seller`, async () => {
      const client = makeModernClientTargeting30(protocol);
      const calls = [];
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async (_agent, taskName, params, options) => {
        calls.push({ taskName, params, options });
        return { status: 'completed', signals: [] };
      };
      try {
        const result = await client.getSignals({
          signal_spec: 'sports fans',
          push_notification_config: { url: 'https://buyer.example.com/adcp-webhook' },
        });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].params.push_notification_config, undefined);
        assert.ok(result.debug_logs.some(log => log.type === 'pre31_discovery_webhook_stripped'));
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    test(`${protocol.toUpperCase()} suppresses auto-injected discovery webhooks on the first 3.0 call`, async () => {
      const client = makeModernClientTargeting30(protocol, {
        webhookUrlTemplate: 'https://buyer.example.com/adcp-webhook/{task_type}/{agent_id}/{operation_id}',
      });
      const calls = [];
      const originalCallTool = ProtocolClient.callTool;
      ProtocolClient.callTool = async (_agent, taskName, params, options) => {
        calls.push({ taskName, params, options });
        return { status: 'completed', signals: [] };
      };
      try {
        const result = await client.getSignals({ signal_spec: 'sports fans' });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].params.push_notification_config, undefined);
        assert.strictEqual(calls[0].options.webhookUrl, undefined);
        const drift = result.debug_logs.find(log => log.type === 'pre31_webhook_degraded');
        assert.ok(drift);
        assert.match(drift.message, /target seller advertises only 3\.0\.12/);
        assert.doesNotMatch(drift.message, /client is pinned to 3\.2/);
      } finally {
        ProtocolClient.callTool = originalCallTool;
      }
    });
  }
});
