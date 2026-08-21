const { describe, test } = require('node:test');
const assert = require('node:assert');

const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const { ProtocolClient } = require('../../dist/lib/index.js');
const { createTestClient, discoverAgentProfile } = require('../../dist/lib/testing/client.js');

const CAPABILITIES_RESPONSE = {
  adcp: {
    major_versions: [3],
    idempotency: { supported: false },
  },
  supported_protocols: ['media_buy'],
  account: { supported_billing: ['operator'] },
  compliance_testing: {
    // AdCP 3.1 opened this list to implementation-specific scenarios. The
    // provisional 3.0 compatibility check still carries the old closed enum.
    scenarios: ['implementation_specific_scenario'],
  },
};

function makeExecutor(responses, logSchemaViolations) {
  return new TaskExecutor({
    validation: { responses },
    logSchemaViolations,
    versionEnvelope: 'major-only',
    adcpVersion: '3.1.18',
  });
}

function captureConsole(method, callback) {
  const original = console[method];
  const calls = [];
  console[method] = (...args) => calls.push(args);
  try {
    return { result: callback(), calls };
  } finally {
    console[method] = original;
  }
}

async function discoverWithCapabilities(response) {
  const client = createTestClient('https://example.com/mcp', 'mcp', {
    adcpVersion: '3.1.18',
    versionEnvelope: 'major-only',
  });
  client.getAgentInfo = async () => ({
    name: '3.1-only seller',
    tools: [{ name: 'get_adcp_capabilities' }],
  });
  client.client.discoveredEndpoint = 'https://example.com/mcp';

  const originalCallTool = ProtocolClient.callTool;
  const originalWarn = console.warn;
  const warnings = [];
  ProtocolClient.callTool = async () => response;
  console.warn = (...args) => warnings.push(args);
  try {
    const discovery = await discoverAgentProfile(client, undefined, '3.1.18');
    return { discovery, warnings };
  } finally {
    ProtocolClient.callTool = originalCallTool;
    console.warn = originalWarn;
  }
}

describe('TaskExecutor schema violation logging', () => {
  test('fixture is valid for 3.1 but not the provisional 3.0 compatibility schema', () => {
    assert.strictEqual(validateResponse('get_adcp_capabilities', CAPABILITIES_RESPONSE, '3.1.18').valid, true);
    assert.strictEqual(validateResponse('get_adcp_capabilities', CAPABILITIES_RESPONSE, '3.0.25').valid, false);
  });

  test('logSchemaViolations=false suppresses warn-mode console and debug output', () => {
    const executor = makeExecutor('warn', false);
    const debugLogs = [];
    const { result, calls } = captureConsole('warn', () =>
      executor.validateResponseSchema(CAPABILITIES_RESPONSE, 'get_adcp_capabilities', debugLogs)
    );

    assert.deepStrictEqual(result, { valid: true, errors: [] });
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(debugLogs, []);
  });

  test('logSchemaViolations=false suppresses strict-mode console output without changing the verdict', () => {
    const executor = makeExecutor('strict', false);
    const debugLogs = [];
    const { result, calls } = captureConsole('error', () =>
      executor.validateResponseSchema(CAPABILITIES_RESPONSE, 'get_adcp_capabilities', debugLogs)
    );

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(error => error.includes('/compliance_testing/scenarios/0')));
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(debugLogs, []);
  });

  test('enabled warn-mode output identifies the schema version', () => {
    const executor = makeExecutor('warn', true);
    const debugLogs = [];
    const { result, calls } = captureConsole('warn', () =>
      executor.validateResponseSchema(CAPABILITIES_RESPONSE, 'get_adcp_capabilities', debugLogs)
    );

    assert.strictEqual(result.valid, true);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0][0], /against AdCP 3\.0 \(non-blocking\)/);
    assert.strictEqual(debugLogs.length, 1);
    assert.strictEqual(debugLogs[0].schemaVersion, '3.0');
    assert.ok(debugLogs[0].issues.some(issue => issue.pointer === '/compliance_testing/scenarios/0'));
  });

  test('default executor diagnostics identify the SDK-pinned schema version', () => {
    const executor = new TaskExecutor({
      validation: { responses: 'warn' },
      logSchemaViolations: true,
    });
    const debugLogs = [];
    const { calls } = captureConsole('warn', () =>
      executor.validateResponseSchema({}, 'get_adcp_capabilities', debugLogs)
    );

    assert.strictEqual(calls.length, 1);
    assert.match(calls[0][0], new RegExp(`against AdCP ${ADCP_VERSION.replaceAll('.', '\\.')}`));
    assert.strictEqual(debugLogs.length, 1);
    assert.strictEqual(debugLogs[0].schemaVersion, ADCP_VERSION);
  });

  test('3.1-only capability discovery suppresses the provisional 3.0 advisory', async () => {
    const response = {
      ...CAPABILITIES_RESPONSE,
      status: 'completed',
      adcp_version: '3.1',
      adcp: {
        ...CAPABILITIES_RESPONSE.adcp,
        supported_versions: ['3.1'],
      },
    };
    const { discovery, warnings } = await discoverWithCapabilities(response);

    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(discovery.profile.capabilities_schema_issues, undefined);
    assert.deepStrictEqual(discovery.profile.adcp_supported_versions, ['3.1']);
  });

  test('primary capability violations remain available as structured issues', async () => {
    const response = {
      ...CAPABILITIES_RESPONSE,
      status: 'completed',
      adcp_version: '3.1',
      adcp: {
        major_versions: [3],
        supported_versions: ['3.1'],
        // Missing required idempotency declaration.
      },
    };
    const { discovery, warnings } = await discoverWithCapabilities(response);

    assert.deepStrictEqual(warnings, []);
    assert.ok(
      discovery.profile.capabilities_schema_issues.some(issue => issue.pointer === '/adcp/idempotency'),
      JSON.stringify(discovery.profile.capabilities_schema_issues)
    );
  });
});
