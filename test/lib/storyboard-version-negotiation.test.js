const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CURRENT_BETA_VERSION = '3.1.0-beta.7';
const CURRENT_BETA_RELEASE_PRECISION = '3.1-beta.7';

function writeComplianceIndex(complianceDir, version = '3.0.12') {
  fs.mkdirSync(complianceDir, { recursive: true });
  fs.writeFileSync(
    path.join(complianceDir, 'index.json'),
    JSON.stringify({ adcp_version: version, universal: [], protocols: [], specialisms: [] })
  );
}

function writeGetProductsRequestSchema(schemaRoot, idVersion, sentinel = 'external') {
  fs.mkdirSync(path.join(schemaRoot, 'bundled', 'media-buy'), { recursive: true });
  fs.writeFileSync(
    path.join(schemaRoot, 'bundled', 'media-buy', 'get-products-request.json'),
    JSON.stringify({
      $id: `/schemas/${idVersion}/bundled/media-buy/get-products-request.json`,
      type: 'object',
      properties: { sentinel: { const: sentinel } },
      required: ['sentinel'],
      additionalProperties: false,
    })
  );
}

function writeComplyControllerAsyncRefSchemas(schemaRoot, idVersion) {
  fs.mkdirSync(path.join(schemaRoot, 'compliance'), { recursive: true });
  fs.mkdirSync(path.join(schemaRoot, 'core'), { recursive: true });
  fs.mkdirSync(path.join(schemaRoot, 'media-buy'), { recursive: true });
  fs.writeFileSync(
    path.join(schemaRoot, 'compliance', 'comply-test-controller-request.json'),
    JSON.stringify({
      $id: `/schemas/${idVersion}/compliance/comply-test-controller-request.json`,
      type: 'object',
      properties: {
        account: {
          type: 'object',
          properties: { sandbox: { type: 'boolean' } },
          required: ['sandbox'],
          additionalProperties: false,
        },
        scenario: { enum: ['list_scenarios'] },
        context: {
          type: 'object',
          properties: { correlation_id: { type: 'string' } },
          additionalProperties: true,
        },
        response_data: { $ref: `/schemas/${idVersion}/core/async-response-data.json` },
      },
      required: ['account', 'scenario'],
      additionalProperties: false,
    })
  );
  fs.writeFileSync(
    path.join(schemaRoot, 'core', 'async-response-data.json'),
    JSON.stringify({
      $id: `/schemas/${idVersion}/core/async-response-data.json`,
      oneOf: [{ $ref: `/schemas/${idVersion}/media-buy/get-products-async-response-working.json` }],
    })
  );
  fs.writeFileSync(
    path.join(schemaRoot, 'media-buy', 'get-products-async-response-working.json'),
    JSON.stringify({
      $id: `/schemas/${idVersion}/media-buy/get-products-async-response-working.json`,
      type: 'object',
      properties: {
        status: { const: 'working' },
        task_id: { type: 'string' },
      },
      required: ['status', 'task_id'],
      additionalProperties: false,
    })
  );
}

describe('storyboard runner AdCP version negotiation', () => {
  test('derives legacy-major-only version envelope for 3.0 storyboards', () => {
    const { applyStoryboardVersionOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyStoryboardVersionOptions({ adcp_version: '3.0.12' }, {});

    assert.strictEqual(options.adcpVersion, '3.0.12');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('derives explicit opt-in envelope for 3.1 storyboards', () => {
    const { applyStoryboardVersionOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyStoryboardVersionOptions({ adcp_version: CURRENT_BETA_VERSION }, {});

    assert.strictEqual(options.adcpVersion, CURRENT_BETA_VERSION);
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('caller-supplied version envelope mode wins', () => {
    const { applyStoryboardVersionOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyStoryboardVersionOptions(
      { adcp_version: '3.0.12' },
      { adcpVersion: '3.0.12', versionEnvelope: 'auto' }
    );

    assert.strictEqual(options.adcpVersion, '3.0.12');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('legacy v3 alias keeps integer version marker behavior', () => {
    const { applyAdcpVersionRunOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyAdcpVersionRunOptions(undefined, { adcpVersion: 'v3' });

    assert.strictEqual(options.adcpVersion, 'v3');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('shared test client is reused only when version options match', () => {
    const { createTestClient, getOrCreateClient } = require('../../dist/lib/testing/client.js');

    const shared = createTestClient('https://example.com/mcp', 'mcp', {
      adcpVersion: CURRENT_BETA_VERSION,
      versionEnvelope: 'auto',
    });

    assert.strictEqual(
      getOrCreateClient('https://example.com/mcp', {
        _client: shared,
        adcpVersion: CURRENT_BETA_VERSION,
        versionEnvelope: 'auto',
      }),
      shared
    );
    assert.notStrictEqual(
      getOrCreateClient('https://example.com/mcp', {
        _client: shared,
        adcpVersion: CURRENT_BETA_VERSION,
        versionEnvelope: 'none',
      }),
      shared
    );
  });

  test('major-only version envelope suppresses exact adcp_version while preserving legacy marker', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ProtocolClient } = require('../../dist/lib/index.js');
    const z = require('zod');

    let captured;
    const server = new McpServer({ name: 'storyboard-version-test', version: '1.0.0' });
    server.registerTool(
      'get_adcp_capabilities',
      {
        inputSchema: {
          adcp_major_version: z.number().optional(),
          adcp_version: z.string().optional(),
        },
      },
      async args => {
        captured = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: {
            status: 'completed',
            adcp: { major_versions: [3] },
            supported_protocols: ['media_buy'],
          },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    await ProtocolClient.callTool(
      {
        id: 'storyboard-version-test',
        protocol: 'mcp',
        agent_uri: 'in-process://storyboard-version-test',
        _inProcessMcpClient: mcpClient,
      },
      'get_adcp_capabilities',
      {},
      { adcpVersion: CURRENT_BETA_VERSION, versionEnvelope: 'major-only' }
    );

    assert.strictEqual(captured.adcp_major_version, 3);
    assert.strictEqual(captured.adcp_version, undefined);

    await mcpClient.close();
    await server.close();
  });

  test('3.0 storyboards suppress exact adcp_version while preserving legacy major marker', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ProtocolClient } = require('../../dist/lib/index.js');
    const z = require('zod');

    let captured;
    const server = new McpServer({ name: 'storyboard-version-test', version: '1.0.0' });
    server.registerTool(
      'get_products',
      {
        inputSchema: {
          brief: z.string().optional(),
          adcp_major_version: z.number().optional(),
          adcp_version: z.string().optional(),
        },
      },
      async args => {
        captured = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { success: true, products: [] },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    await ProtocolClient.callTool(
      {
        id: 'storyboard-version-test',
        protocol: 'mcp',
        agent_uri: 'in-process://storyboard-version-test',
        _inProcessMcpClient: mcpClient,
      },
      'get_products',
      { brief: 'legacy 3.0 storyboard' },
      { adcpVersion: '3.0.12' }
    );

    assert.strictEqual(captured.adcp_major_version, 3);
    assert.strictEqual(captured.adcp_version, undefined);

    await mcpClient.close();
    await server.close();
  });

  test('exact seller supported_versions are matched against cache version aliases', () => {
    const { isComplianceVersionSupported } = require('../../dist/lib/testing/storyboard/index.js');

    assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, [CURRENT_BETA_VERSION]), true);
    assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, [CURRENT_BETA_RELEASE_PRECISION]), true);
    assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.1-beta']), true);
    assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.1-beta.2']), false);
    assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.1.0-beta.2']), false);
    assert.strictEqual(isComplianceVersionSupported('3.0.12', ['3.0.0']), true);
    assert.strictEqual(isComplianceVersionSupported('3.1.1', ['3.1.0']), true);
    assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.0']), false);
  });

  test('compliance negotiation uses major-only envelope for strict 3.0 capability profiles', () => {
    const { applyNegotiatedComplianceVersionOptions } = require('../../dist/lib/testing/compliance/comply.js');

    const options = applyNegotiatedComplianceVersionOptions(
      {
        name: 'Strict 3.0',
        tools: ['get_adcp_capabilities', 'get_products'],
        adcp_version: 'v3',
        adcp_major_versions: [3],
        supported_protocols: ['media_buy'],
        library_version: '@adcp/client@5.22.0',
      },
      { adcpVersion: CURRENT_BETA_VERSION, versionEnvelope: 'auto' },
      { complianceVersion: CURRENT_BETA_VERSION }
    );

    assert.strictEqual(options.versionEnvelope, 'major-only');
    assert.strictEqual(options._serverAdcpVersion, '3.0');
  });

  test('hosted stable-line alias keeps beta validators while emitting stable wire version', () => {
    const { applyNegotiatedComplianceVersionOptions } = require('../../dist/lib/testing/compliance/comply.js');

    const options = applyNegotiatedComplianceVersionOptions(
      {
        name: 'Stable-line seller',
        tools: ['get_adcp_capabilities', 'get_products'],
        adcp_version: 'v3',
        adcp_major_versions: [3],
        adcp_supported_versions: ['3.1'],
        supported_protocols: ['media_buy'],
      },
      { adcpVersion: CURRENT_BETA_VERSION, versionEnvelope: 'auto' },
      { complianceVersion: CURRENT_BETA_VERSION, hostedStableLineAlias: '3.1' }
    );

    assert.strictEqual(options.adcpVersion, CURRENT_BETA_VERSION);
    assert.strictEqual(options.wireAdcpVersion, '3.1');
    assert.strictEqual(options._serverAdcpVersion, '3.1');
  });

  test('missing supported_versions alone does not downgrade a v3 seller', () => {
    const { applyNegotiatedComplianceVersionOptions } = require('../../dist/lib/testing/compliance/comply.js');

    const options = applyNegotiatedComplianceVersionOptions(
      {
        name: '3.1 seller during SHOULD-emit phase',
        tools: ['get_adcp_capabilities', 'get_products'],
        adcp_version: 'v3',
        adcp_major_versions: [3],
        supported_protocols: ['media_buy'],
      },
      { adcpVersion: CURRENT_BETA_VERSION, versionEnvelope: 'auto' },
      { complianceVersion: CURRENT_BETA_VERSION }
    );

    assert.strictEqual(options.versionEnvelope, 'auto');
    assert.strictEqual(options._serverAdcpVersion, CURRENT_BETA_VERSION);
  });

  test('pre-3.1 build_version is positive downgrade evidence', () => {
    const { applyNegotiatedComplianceVersionOptions } = require('../../dist/lib/testing/compliance/comply.js');

    const options = applyNegotiatedComplianceVersionOptions(
      {
        name: 'Strict 3.0',
        tools: ['get_adcp_capabilities', 'get_products'],
        adcp_version: 'v3',
        adcp_major_versions: [3],
        adcp_build_version: '3.0.12',
        supported_protocols: ['media_buy'],
      },
      { adcpVersion: CURRENT_BETA_VERSION, versionEnvelope: 'auto' },
      { complianceVersion: CURRENT_BETA_VERSION }
    );

    assert.strictEqual(options.versionEnvelope, 'major-only');
    assert.strictEqual(options._serverAdcpVersion, '3.0.12');
  });

  test('capability resolution fails loudly on exact version mismatch', () => {
    const {
      CapabilityResolutionError,
      resolveStoryboardsForCapabilities,
    } = require('../../dist/lib/testing/storyboard/index.js');

    assert.throws(
      () =>
        resolveStoryboardsForCapabilities({
          supported_protocols: [],
          supported_versions: ['3.0'],
        }),
      err =>
        err instanceof CapabilityResolutionError &&
        err.code === 'unsupported_adcp_version' &&
        /Compliance cache version/.test(err.message) &&
        /supported_versions \[3\.0\]/.test(err.message)
    );
  });

  test('hosted stable-line alias can resolve prerelease-backed compliance cache per call', () => {
    const {
      CapabilityResolutionError,
      isComplianceVersionSupported,
      resolveStoryboardsForCapabilities,
    } = require('../../dist/lib/testing/storyboard/index.js');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-hosted-stable-alias-'));
    const complianceDir = path.join(tempRoot, 'compliance', 'cache', CURRENT_BETA_VERSION);
    try {
      writeComplianceIndex(complianceDir, CURRENT_BETA_VERSION);

      assert.strictEqual(isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.1']), false);
      assert.strictEqual(
        isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.1'], { hostedStableLineAlias: '3.1' }),
        true
      );
      assert.strictEqual(
        isComplianceVersionSupported(CURRENT_BETA_VERSION, ['3.0'], { hostedStableLineAlias: '3.1' }),
        false
      );

      assert.throws(
        () =>
          resolveStoryboardsForCapabilities(
            { supported_protocols: [], supported_versions: ['3.1'] },
            { complianceDir }
          ),
        err => err instanceof CapabilityResolutionError && err.code === 'unsupported_adcp_version'
      );
      assert.deepStrictEqual(
        resolveStoryboardsForCapabilities(
          { supported_protocols: [], supported_versions: ['3.1'] },
          { complianceDir, hostedStableLineAlias: '3.1' }
        ).storyboards,
        []
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('external compliance dir resolves its sibling schema bundle for scoped validation', () => {
    const { getExternalSchemaRootForCompliance, loadComplianceIndex } =
      require('../../dist/lib/testing/storyboard/index.js');
    const { getValidator, _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');
    const { withExternalSchemaRoot } = require('../../dist/lib/testing/index.js');
    const { resolveAdcpVersion } = require('../../dist/lib/utils/adcp-version-config.js');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-external-compliance-'));
    const complianceDir = path.join(tempRoot, 'package', 'compliance', 'cache', '3.0.12');
    const schemaRoot = path.join(tempRoot, 'package', 'dist', 'lib', 'schemas-data', '3.0');
    try {
      writeComplianceIndex(complianceDir);
      writeGetProductsRequestSchema(schemaRoot, '3.0');

      const index = loadComplianceIndex({ complianceDir });
      const resolvedRoot = getExternalSchemaRootForCompliance({ complianceDir }, index.adcp_version);

      withExternalSchemaRoot('3.0.12', resolvedRoot, () => {
        assert.strictEqual(resolveAdcpVersion('3.0.12'), '3.0.12');
        const validator = getValidator('get_products', 'request', '3.0.12');
        assert.ok(validator, 'external 3.0 request validator should compile');
        assert.strictEqual(validator({ sentinel: 'external' }), true);
        assert.strictEqual(validator({ sentinel: 'installed-sdk-default' }), false);
      });
      _resetValidationLoader('3.0.12');
      assert.throws(
        () => getValidator('get_products', 'request', '3.0.12'),
        /AdCP schema data for version "3\.0\.12" not found/
      );
    } finally {
      _resetValidationLoader('3.0.12');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('explicit schemaRoot registers a non-sibling external schema bundle', () => {
    const { getExternalSchemaRootForCompliance, loadComplianceIndex } =
      require('../../dist/lib/testing/storyboard/index.js');
    const { withExternalSchemaRoot } = require('../../dist/lib/testing/index.js');
    const { getValidator, _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-explicit-schema-root-'));
    const complianceDir = path.join(tempRoot, 'compliance-cache', '3.0.12');
    const schemaRoot = path.join(tempRoot, 'schema-bundles', '3.0');
    try {
      writeComplianceIndex(complianceDir);
      writeGetProductsRequestSchema(schemaRoot, '3.0', 'explicit');

      const index = loadComplianceIndex({ complianceDir, schemaRoot });
      const resolvedRoot = getExternalSchemaRootForCompliance({ complianceDir, schemaRoot }, index.adcp_version);

      withExternalSchemaRoot('3.0.12', resolvedRoot, () => {
        const validator = getValidator('get_products', 'request', '3.0.12');
        assert.ok(validator, 'explicit schema root validator should compile');
        assert.strictEqual(validator({ sentinel: 'explicit' }), true);
        assert.strictEqual(validator({ sentinel: 'external' }), false);
      });
    } finally {
      _resetValidationLoader('3.0.12');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('external schemaRoot resolves async-response-data refs without response validator prewarm', () => {
    const { loadComplianceIndex } = require('../../dist/lib/testing/storyboard/index.js');
    const { withExternalSchemaRoot } = require('../../dist/lib/testing/index.js');
    const { _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');
    const { validateRequest } = require('../../dist/lib/validation/schema-validator.js');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-async-response-ref-'));
    const complianceDir = path.join(tempRoot, 'compliance-cache', '3.0.12');
    const schemaRoot = path.join(tempRoot, 'schema-bundles', '3.0');
    try {
      writeComplianceIndex(complianceDir);
      writeComplyControllerAsyncRefSchemas(schemaRoot, '3.0.12');

      loadComplianceIndex({ complianceDir, schemaRoot });
      withExternalSchemaRoot('3.0.12', schemaRoot, () => {
        const outcome = validateRequest(
          'comply_test_controller',
          {
            account: { sandbox: true },
            scenario: 'list_scenarios',
            context: { correlation_id: 'deterministic_testing--list_scenarios' },
          },
          '3.0.12'
        );

        assert.strictEqual(outcome.valid, true, JSON.stringify(outcome.issues));
      });
    } finally {
      _resetValidationLoader('3.0.12');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('explicit schemaRoot fails fast when missing or version-mismatched', () => {
    const { withExternalSchemaRoot } = require('../../dist/lib/testing/index.js');
    const { _resetValidationLoader } = require('../../dist/lib/validation/schema-loader.js');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-bad-schema-root-'));
    const complianceDir = path.join(tempRoot, 'compliance-cache', '3.0.12');
    const wrongSchemaRoot = path.join(tempRoot, 'schema-bundles', '3.1');
    try {
      writeComplianceIndex(complianceDir);

      assert.throws(
        () => withExternalSchemaRoot('3.0.12', path.join(tempRoot, 'missing'), () => {}),
        /External AdCP schema root for version "3\.0\.12" not found or empty/
      );
      assert.throws(
        () => withExternalSchemaRoot('3.0.12', complianceDir, () => {}),
        /External AdCP schema root for version "3\.0\.12" not found or empty/
      );

      writeGetProductsRequestSchema(wrongSchemaRoot, CURRENT_BETA_VERSION);
      assert.throws(
        () => withExternalSchemaRoot('3.0.12', wrongSchemaRoot, () => {}),
        /must contain only bundle "3\.0".*3\.1\.0-beta\.7/
      );
    } finally {
      _resetValidationLoader('3.0.12');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('fix commands preserve external schema and hosted alias options', () => {
    const { extractFailures } = require('../../dist/lib/testing/compliance/comply.js');
    const failures = extractFailures(
      [
        {
          storyboard_id: 'story',
          phases: [
            {
              steps: [
                {
                  passed: false,
                  skipped: false,
                  step_id: 'step',
                  title: 'Step',
                  task: 'get_products',
                  validations: [],
                },
              ],
            },
          ],
        },
      ],
      [{ id: 'story', track: 'core', phases: [{ steps: [{ id: 'step', expected: 'works' }] }] }],
      'agent-alias',
      {
        complianceVersion: CURRENT_BETA_VERSION,
        complianceDir: '/tmp/compliance cache',
        schemaRoot: '/tmp/schema root',
        hostedStableLineAlias: '3.1',
      }
    );

    assert.match(failures[0].fix_command, /--schema-root '\/tmp\/schema root'/);
    assert.match(failures[0].fix_command, /--hosted-stable-line-alias 3\.1/);
  });
});
