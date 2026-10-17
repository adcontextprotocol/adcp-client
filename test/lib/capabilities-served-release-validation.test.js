/**
 * Capability discovery validates `get_adcp_capabilities` against the release
 * the seller served, not the caller's pin, and cross-checks the
 * `compliance_testing` block against `comply_test_controller` under the key
 * the capabilities parser actually reports.
 *
 * A 3.0 pin cannot carry `adcp_version` (the 3.0 bundle predates the field),
 * so the SDK sends only `adcp_major_version: 3`. Per the versioning spec a
 * major-only request is served the seller's highest release in that major,
 * and the seller echoes it in `adcp_version` ("Server echoes": buyers SHOULD
 * validate against that release's schema, not their pin). Before the fix,
 * `discoverAgentProfile` and `TaskExecutor` both validated a 3.2 response
 * strictly against 3.0 and reported false `capabilities_schema_issues`.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { ADCPMultiAgentClient } = require('../../dist/lib/index.js');
const { testCapabilityDiscovery } = require('../../dist/lib/testing/scenarios/capabilities.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const {
  resolveServedValidationVersion,
  withExternalSchemaRoot,
} = require('../../dist/lib/validation/schema-loader.js');

/** A conformant AdCP 3.2 capabilities response, invalid against 3.0 and 3.1. */
function capabilities32(overrides = {}) {
  return {
    status: 'completed',
    adcp_version: '3.2',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.0', '3.1', '3.2'],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
    },
    supported_protocols: ['media_buy'],
    account: { require_operator_auth: false, supported_billing: ['operator'] },
    // 3.2 widened `features` entries: 3.0/3.1 require booleans here.
    media_buy: { features: { bidding_policy: { media_buy: { fixed: { modes: ['bid_amount'] } } } } },
    // 3.0 closes `scenarios` to six values; 3.1+ opens the list.
    compliance_testing: { scenarios: ['force_creative_status', 'force_create_media_buy_arm', 'seed_product'] },
    ...overrides,
  };
}

const MEDIA_BUY_TOOLS = ['get_products', 'create_media_buy'];

async function startSeller({ payload, tools = [...MEDIA_BUY_TOOLS, 'comply_test_controller'] }) {
  const capabilityRequests = [];
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');
  const { z } = require('zod');
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'served-release-seller', version: '1.0.0' });
    server.registerTool(
      'get_adcp_capabilities',
      { description: 'AdCP capabilities', inputSchema: z.object({}).passthrough() },
      async args => {
        capabilityRequests.push(args);
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
    );
    for (const name of tools) {
      server.registerTool(name, { description: name }, async () => ({
        content: [{ type: 'text', text: '{}' }],
        structuredContent: {},
      }));
    }
    return server;
  });
  const serveMcp = toNodeHandler(handler);
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/mcp' && req.url !== '/mcp/') {
      res.writeHead(404).end('not found');
      return;
    }
    await serveMcp(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    capabilityRequests,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function withSeller(t, options) {
  await closeMCPConnections();
  const seller = await startSeller(options);
  t.after(async () => {
    await closeMCPConnections();
    await seller.close();
  });
  return seller;
}

const stepNamed = (steps, name) => steps.find(step => step.step === name);
const failedSteps = steps => steps.filter(step => !step.passed && !step.skipped);

/** An echo of `release` that the response also lists in `supported_versions`. */
const echo = (release, supported = ['3.0', '3.1', '3.2', release]) => ({
  adcp_version: release,
  adcp: { supported_versions: [...new Set(supported)] },
});

describe('resolveServedValidationVersion', () => {
  test('uses a bundled same-major echo listed in supported_versions instead of the pin', () => {
    assert.equal(resolveServedValidationVersion(echo('3.2'), '3.0'), '3.2');
    assert.equal(resolveServedValidationVersion(echo('3.1'), '3.0.25'), '3.1');
    assert.equal(resolveServedValidationVersion(echo('3.0'), '3.2'), '3.0');
  });

  test('keeps the exact pin when the echo is the pinned release', () => {
    // Preserves a patch-precise pin (and any external schema root bound to it).
    assert.equal(resolveServedValidationVersion(echo('3.0'), '3.0.25'), '3.0.25');
    assert.equal(resolveServedValidationVersion(echo('3.2'), '3.2'), '3.2');
  });

  test('falls back to the pin when there is no usable echo', () => {
    assert.equal(resolveServedValidationVersion({}, '3.0'), '3.0', 'no echo');
    assert.equal(resolveServedValidationVersion(undefined, '3.0'), '3.0', 'no payload');
    assert.equal(resolveServedValidationVersion({ ...echo('3.2'), adcp_version: 3.2 }, '3.0'), '3.0', 'non-string');
    assert.equal(resolveServedValidationVersion(echo('3.2.4'), '3.0'), '3.0', 'not release precision');
    assert.equal(resolveServedValidationVersion(echo('../3.2'), '3.0'), '3.0', 'garbage');
    assert.equal(resolveServedValidationVersion(echo('4.0'), '3.0'), '3.0', 'different major');
    assert.equal(resolveServedValidationVersion(echo('2.5'), '3.0'), '3.0', 'older major');
    assert.equal(resolveServedValidationVersion(echo('3.99'), '3.0'), '3.0', 'no bundled schema');
    assert.equal(resolveServedValidationVersion(echo('3.2'), 'v2.5'), 'v2.5', 'legacy v2 pin');
  });

  test('requires the echo to be listed in supported_versions', () => {
    assert.equal(resolveServedValidationVersion({ adcp_version: '3.2' }, '3.0'), '3.0', 'no supported_versions');
    assert.equal(resolveServedValidationVersion(echo('3.2', ['3.0', '3.1']), '3.0'), '3.0', 'not listed');
    assert.equal(
      resolveServedValidationVersion({ adcp_version: '3.2', adcp: { supported_versions: '3.2' } }, '3.0'),
      '3.0',
      'malformed supported_versions'
    );
    // supported_versions alone never moves validation off the pin.
    assert.equal(resolveServedValidationVersion({ adcp: { supported_versions: ['3.0', '3.2'] } }, '3.0'), '3.0');
  });

  test('handles prerelease and legacy pins', () => {
    assert.equal(resolveServedValidationVersion(echo('3.2'), '3.1-beta'), '3.2', 'stable echo, beta pin');
    assert.equal(resolveServedValidationVersion(echo('3.1-beta.1'), '3.1.0-beta.1'), '3.1.0-beta.1');
    assert.equal(resolveServedValidationVersion(echo('3.4-rc.1'), '3.0'), '3.0', 'unbundled prerelease echo');
    assert.equal(resolveServedValidationVersion(echo('3.2'), 'v3'), 'v3', 'legacy alias pin');
  });

  test('an external schema root bound to the pin does not override a usable echo', () => {
    // Hosted compliance always runs with one (adcp-client#3320).
    const root = path.join(__dirname, '../../dist/lib/schemas-data/3.0');
    const selected = withExternalSchemaRoot('3.0', root, () => resolveServedValidationVersion(echo('3.2'), '3.0'));
    assert.equal(selected, '3.2');
    const pinnedEcho = withExternalSchemaRoot('3.0', root, () => resolveServedValidationVersion(echo('3.0'), '3.0'));
    assert.equal(pinnedEcho, '3.0', 'an echo of the pinned release keeps the pin and its root');
  });
});

describe('capability discovery with a 3.0 pin against a seller serving 3.2', () => {
  after(() => closeMCPConnections());

  test('validates the response against the served release, so a conformant 3.2 response passes', async t => {
    const seller = await withSeller(t, { payload: capabilities32() });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' });

    // The probe really was major-only: a 3.0 pin cannot carry adcp_version.
    assert.ok(seller.capabilityRequests.length > 0, 'seller received get_adcp_capabilities');
    for (const args of seller.capabilityRequests) {
      assert.equal(args.adcp_major_version, 3);
      assert.equal(args.adcp_version, undefined);
    }

    assert.deepEqual(discovery.profile?.capabilities_schema_issues, undefined);
    assert.deepEqual(failedSteps(discovery.steps), [], JSON.stringify(discovery.steps, null, 2));
    assert.equal(stepNamed(discovery.steps, 'Get AdCP capabilities (v3)')?.passed, true);
  });

  test('still validates strictly: a response invalid against the served release is reported', async t => {
    // minProperties: 1 on the 3.2 bidding_policy object.
    const payload = capabilities32({ media_buy: { features: { bidding_policy: {} } } });
    const seller = await withSeller(t, { payload });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' });

    const issues = discovery.profile?.capabilities_schema_issues ?? [];
    assert.ok(
      issues.some(issue => issue.pointer === '/media_buy/features/bidding_policy'),
      JSON.stringify(issues)
    );
    // Reported against 3.2 (fewer properties), not 3.0 (must be boolean).
    assert.ok(
      issues.every(issue => !/must be boolean|must be one of/.test(issue.message)),
      JSON.stringify(issues)
    );
  });

  test('falls back to the pin when the seller omits adcp_version', async t => {
    const { adcp_version: _omitted, ...payload } = capabilities32();
    const seller = await withSeller(t, { payload });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' });

    const issues = discovery.profile?.capabilities_schema_issues ?? [];
    assert.ok(
      issues.some(issue => issue.pointer === '/media_buy/features/bidding_policy'),
      JSON.stringify(issues)
    );
  });

  test('does not pass an echo from a different major; validates against the pin', async t => {
    const seller = await withSeller(t, { payload: capabilities32({ adcp_version: '4.0' }) });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' });

    const issues = discovery.profile?.capabilities_schema_issues ?? [];
    assert.ok(issues.length > 0, 'a 4.0 echo must not silence 3.0 validation');
  });

  test('does not pass an echo the SDK has no schema for; validates against the pin', async t => {
    const seller = await withSeller(t, { payload: capabilities32({ adcp_version: '3.99' }) });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' });

    const issues = discovery.profile?.capabilities_schema_issues ?? [];
    assert.ok(issues.length > 0, 'an unvalidatable echo must not silence 3.0 validation');
  });

  test('TaskExecutor validates getAdcpCapabilities against the served release in strict mode', async t => {
    const seller = await withSeller(t, { payload: capabilities32() });
    const client = new ADCPMultiAgentClient(
      [{ id: 'seller', name: 'Seller', agent_uri: seller.url, protocol: 'mcp' }],
      { adcpVersion: '3.0', validation: { responses: 'strict' } }
    );

    const result = await client.agent('seller').getAdcpCapabilities({});

    assert.equal(result.success, true, result.error);
  });

  test('TaskExecutor uses the echo under an explicit major-only envelope', async t => {
    // responseAdcpVersionForValidation() pins major-only validation to 3.0.
    const seller = await withSeller(t, { payload: capabilities32() });
    const client = new ADCPMultiAgentClient(
      [{ id: 'seller', name: 'Seller', agent_uri: seller.url, protocol: 'mcp' }],
      { adcpVersion: '3.2', versionEnvelope: 'major-only', validation: { responses: 'strict' } }
    );

    const result = await client.agent('seller').getAdcpCapabilities({});

    assert.equal(result.success, true, result.error);
    assert.equal(seller.capabilityRequests.at(-1)?.adcp_version, undefined);
  });

  test('TaskExecutor keeps strict validation against the served release', async t => {
    const payload = capabilities32({ media_buy: { features: { bidding_policy: {} } } });
    const seller = await withSeller(t, { payload });
    const client = new ADCPMultiAgentClient(
      [{ id: 'seller', name: 'Seller', agent_uri: seller.url, protocol: 'mcp' }],
      { adcpVersion: '3.0', validation: { responses: 'strict', logSchemaViolations: false } }
    );

    const result = await client.agent('seller').getAdcpCapabilities({});

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /bidding_policy/);
    assert.doesNotMatch(result.error ?? '', /must be boolean/);
  });
});

describe('capability cross-check keys comply_test_controller as compliance_testing', () => {
  after(() => closeMCPConnections());

  const CROSS_CHECK = 'Cross-validate protocols and tools';

  test('an agent declaring compliance_testing with comply_test_controller passes', async t => {
    const seller = await withSeller(t, { payload: capabilities32() });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.2' });

    const step = stepNamed(discovery.steps, CROSS_CHECK);
    assert.ok(step, 'cross-check step ran');
    assert.equal(step.passed, true, step.error);
    assert.doesNotMatch(step.details ?? '', /unreported/);
  });

  test('comply_test_controller without the compliance_testing block is flagged under compliance_testing', async t => {
    const { compliance_testing: _omitted, ...payload } = capabilities32();
    const seller = await withSeller(t, { payload });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.2' });

    const step = stepNamed(discovery.steps, CROSS_CHECK);
    assert.equal(step?.passed, false);
    assert.match(
      step.error,
      /Tools suggest unreported protocols: compliance_testing \(has: \[comply_test_controller\]\)/
    );
  });

  test('a compliance_testing block without comply_test_controller is flagged', async t => {
    const seller = await withSeller(t, { payload: capabilities32(), tools: MEDIA_BUY_TOOLS });

    const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.2' });

    const step = stepNamed(discovery.steps, CROSS_CHECK);
    assert.equal(step?.passed, false);
    assert.match(step.error, /Protocol 'compliance_testing' reported but no matching tools found/);
  });
});
