/**
 * `get_adcp_capabilities` is validated against the release the agent echoed
 * even when an external schema root is active for the pin.
 *
 * Hosted compliance always runs with an external schema root for the pinned
 * release (`comply()` derives it from the compliance folder). A 3.0 pin sends
 * only `adcp_major_version: 3`, so a conformant agent serves and echoes its
 * highest 3.x release (versioning spec, "Server echoes"). Before the fix the
 * pin's external root won over the echo, so every storyboard step's
 * `response_schema` check on a 3.2 capabilities response, and the discovery
 * notices, validated against 3.0 and failed on fields 3.0 never had.
 *
 * The echo is used only when it is the pin's major, is listed in the
 * response's own `adcp.supported_versions`, and has a schema root (one
 * supplied through `servedReleaseSchemaRoots`, an external root registered
 * for it, or the SDK's bundled schemas). Otherwise validation stays strictly
 * on the pin, and no other task's validation changes.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { ADCPMultiAgentClient } = require('../../dist/lib/index.js');
const { testCapabilityDiscovery } = require('../../dist/lib/testing/scenarios/capabilities.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const {
  resolveServedValidationVersion,
  withExternalSchemaRoot,
  withServedReleaseSchemaRoots,
} = require('../../dist/lib/validation/schema-loader.js');
const testing = require('../../dist/lib/testing/index.js');

const SCHEMAS_DATA = path.join(__dirname, '../../dist/lib/schemas-data');
/** Stands in for hosted compliance's external root for a 3.0 target. */
const PINNED_30_ROOT = path.join(SCHEMAS_DATA, '3.0');
const MARKER = 'x_hosted_root_marker';
const CAPABILITIES_FILE = path.join('protocol', 'get-adcp-capabilities-response.json');
const PRODUCTS_FILE = path.join('media-buy', 'get-products-response.json');

/** A conformant AdCP 3.2 capabilities response, invalid against 3.0. */
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
    // 3.2 widened `features` entries: 3.0 requires booleans here.
    media_buy: { features: { bidding_policy: { media_buy: { fixed: { modes: ['bid_amount'] } } } } },
    // 3.0 closes `scenarios` to six values; 3.1+ opens the list.
    compliance_testing: { scenarios: ['force_creative_status', 'force_create_media_buy_arm', 'seed_product'] },
    ...overrides,
  };
}

function withSupportedVersions(payload, supported_versions) {
  return { ...payload, adcp: { ...payload.adcp, supported_versions } };
}

/** The 3.0 pin rejects capabilities32() at these pointers. */
const PIN_30_ISSUE = /must be boolean|must be one of/;

/**
 * A hosted-style 3.2.5 schema root: the SDK's bundled 3.2 capabilities and
 * get_products response schemas, each requiring an extra marker field, so a
 * test can tell this root apart from the bundled one.
 */
let hosted32Root;
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-echoed-release-'));
  hosted32Root = path.join(tmpDir, '3.2.5');
  for (const file of [CAPABILITIES_FILE, PRODUCTS_FILE]) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DATA, '3.2', 'bundled', file), 'utf8'));
    schema.required = [...(schema.required ?? []), MARKER];
    const target = path.join(hosted32Root, 'bundled', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(schema));
  }
});

after(async () => {
  await closeMCPConnections();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const underPinnedRoot = fn => withExternalSchemaRoot('3.0', PINNED_30_ROOT, fn);

function responseSchemaCheck(taskName, data, extra = {}) {
  const [result] = runValidations([{ check: 'response_schema', description: 'response conforms' }], {
    taskName,
    adcpVersion: '3.0',
    responseAdcpVersion: '3.0',
    strictResponseSchemaValidation: true,
    taskResult: { success: true, data },
    agentUrl: 'https://agent.example/mcp',
    contributions: new Set(),
    ...extra,
  });
  return result;
}

describe('resolveServedValidationVersion with an external root active for the pin', () => {
  test('uses a same-major echo listed in supported_versions and bundled by the SDK', () => {
    assert.equal(
      underPinnedRoot(() => resolveServedValidationVersion(capabilities32(), '3.0')),
      '3.2'
    );
  });

  test('keeps the pin when the echo is a different major', () => {
    const payload = withSupportedVersions(capabilities32({ adcp_version: '4.0' }), ['3.0', '4.0']);
    assert.equal(
      underPinnedRoot(() => resolveServedValidationVersion(payload, '3.0')),
      '3.0'
    );
  });

  test('keeps the pin when the echo is not listed in supported_versions', () => {
    const unlisted = withSupportedVersions(capabilities32(), ['3.0', '3.1']);
    const missing = capabilities32({ adcp: { major_versions: [3], idempotency: { supported: false } } });
    assert.equal(
      underPinnedRoot(() => resolveServedValidationVersion(unlisted, '3.0')),
      '3.0'
    );
    assert.equal(
      underPinnedRoot(() => resolveServedValidationVersion(missing, '3.0')),
      '3.0'
    );
    // Same rule without any external root.
    assert.equal(resolveServedValidationVersion(unlisted, '3.0'), '3.0');
  });

  test('keeps the pin when no schema is available for the echo', () => {
    const payload = withSupportedVersions(capabilities32({ adcp_version: '3.99' }), ['3.0', '3.99']);
    assert.equal(
      underPinnedRoot(() => resolveServedValidationVersion(payload, '3.0')),
      '3.0'
    );
  });

  test('counts a served-release root and an external root registered for the echo', () => {
    // A release the SDK does not bundle becomes usable once a root is supplied.
    const payload = withSupportedVersions(capabilities32({ adcp_version: '3.2' }), ['3.0', '3.2']);
    const viaServed = underPinnedRoot(() =>
      withServedReleaseSchemaRoots({ '3.2.5': hosted32Root }, () => resolveServedValidationVersion(payload, '3.0'))
    );
    assert.equal(viaServed, '3.2');
    const viaExternal = underPinnedRoot(() =>
      withExternalSchemaRoot('3.2.5', hosted32Root, () => resolveServedValidationVersion(payload, '3.0'))
    );
    assert.equal(viaExternal, '3.2');
  });
});

describe('withServedReleaseSchemaRoots', () => {
  test('is exported from @adcp/sdk/testing', () => {
    assert.equal(typeof testing.withServedReleaseSchemaRoots, 'function');
  });

  test('rejects malformed input up front', () => {
    assert.throws(() => withServedReleaseSchemaRoots(['3.2'], () => 1), /servedReleaseSchemaRoots/);
    assert.throws(() => withServedReleaseSchemaRoots({ '../3.2': hosted32Root }, () => 1), /not a recognized version/);
    assert.throws(() => withServedReleaseSchemaRoots({ '3.2.5': '' }, () => 1), /servedReleaseSchemaRoots/);
    assert.throws(
      () => withServedReleaseSchemaRoots({ '3.2.5': path.join(tmpDir, 'missing') }, () => 1),
      /not found or empty/
    );
    // A root whose schema ids belong to another release.
    assert.throws(() => withServedReleaseSchemaRoots({ 3.1: hosted32Root }, () => 1), /does not match/);
  });

  test('is a no-op without entries', () => {
    assert.equal(
      withServedReleaseSchemaRoots(undefined, () => 7),
      7
    );
    assert.equal(
      withServedReleaseSchemaRoots({}, () => 8),
      8
    );
  });
});

describe('storyboard response_schema check on get_adcp_capabilities under an external pin root', () => {
  test('passes a conformant response for the echoed same-major release', () => {
    const result = underPinnedRoot(() => responseSchemaCheck('get_adcp_capabilities', capabilities32()));
    assert.equal(result.passed, true, result.error);
  });

  test('still fails a real schema error under the echoed release', () => {
    // minProperties: 1 on the 3.2 bidding_policy object.
    const payload = capabilities32({ media_buy: { features: { bidding_policy: {} } } });
    const result = underPinnedRoot(() => responseSchemaCheck('get_adcp_capabilities', payload));
    assert.equal(result.passed, false);
    assert.match(result.error, /bidding_policy/);
    assert.doesNotMatch(result.error, PIN_30_ISSUE, 'validated against 3.2, not the 3.0 pin');
  });

  for (const [label, payload] of [
    ['an echo of a different major', withSupportedVersions(capabilities32({ adcp_version: '4.0' }), ['3.0', '4.0'])],
    ['an echo not in supported_versions', withSupportedVersions(capabilities32(), ['3.0', '3.1'])],
    [
      'an echo with no schema available',
      withSupportedVersions(capabilities32({ adcp_version: '3.99' }), ['3.0', '3.99']),
    ],
    ['no echo', (({ adcp_version: _omitted, ...rest }) => rest)(capabilities32())],
  ]) {
    test(`falls back to the pin, strictly, for ${label}`, () => {
      const result = underPinnedRoot(() => responseSchemaCheck('get_adcp_capabilities', payload));
      assert.equal(result.passed, false, 'the 3.0 pin rejects 3.2 shapes');
      assert.match(result.error, PIN_30_ISSUE);
    });
  }

  test('uses the root supplied for the echoed release', () => {
    const missingMarker = underPinnedRoot(() =>
      withServedReleaseSchemaRoots({ '3.2.5': hosted32Root }, () =>
        responseSchemaCheck('get_adcp_capabilities', capabilities32())
      )
    );
    assert.equal(missingMarker.passed, false);
    assert.match(missingMarker.error, new RegExp(MARKER));

    const withMarker = underPinnedRoot(() =>
      withServedReleaseSchemaRoots({ '3.2.5': hosted32Root }, () =>
        responseSchemaCheck('get_adcp_capabilities', capabilities32({ [MARKER]: true }))
      )
    );
    assert.equal(withMarker.passed, true, withMarker.error);
  });

  test('does not change other tasks: they validate against the pin and ignore served roots', () => {
    // A get_products response that echoes 3.2 and lists it is still graded
    // against the pinned 3.0 root, never the served 3.2 root.
    const products = {
      adcp_version: '3.2',
      adcp: { supported_versions: ['3.0', '3.2'] },
      products: [],
    };
    const baseline = underPinnedRoot(() => responseSchemaCheck('get_products', { products: [] }));
    const echoed = underPinnedRoot(() =>
      withServedReleaseSchemaRoots({ '3.2.5': hosted32Root }, () => responseSchemaCheck('get_products', products))
    );
    assert.equal(echoed.passed, baseline.passed, echoed.error);
    assert.equal(echoed.schema_id, baseline.schema_id);
    assert.doesNotMatch(echoed.error ?? '', new RegExp(MARKER));
  });
});

// ── Live seller: discovery notices, TaskExecutor and runStoryboard ──────────

async function startSeller({ payload }) {
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');
  const { z } = require('zod');
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'echoed-release-seller', version: '1.0.0' });
    server.registerTool(
      'get_adcp_capabilities',
      { description: 'AdCP capabilities', inputSchema: z.object({}).passthrough() },
      async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload })
    );
    for (const name of ['get_products', 'create_media_buy', 'comply_test_controller']) {
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
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function withSeller(t, payload) {
  await closeMCPConnections();
  const seller = await startSeller({ payload });
  t.after(async () => {
    await closeMCPConnections();
    await seller.close();
  });
  return seller;
}

function capabilitiesStoryboard() {
  return {
    id: 'echoed_release_capabilities',
    version: '1.0.0',
    title: 'Echoed-release capabilities',
    category: 'test',
    summary: 'A single get_adcp_capabilities step with a response_schema check.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'capabilities',
        title: 'Capabilities',
        steps: [
          {
            id: 'discover',
            title: 'Discover capabilities',
            task: 'get_adcp_capabilities',
            response_schema_ref: 'protocol/get-adcp-capabilities-response.json',
            validations: [{ check: 'response_schema', description: 'response conforms' }],
          },
        ],
      },
    ],
  };
}

describe('live seller serving 3.2 to a 3.0 pin with an external pin root', () => {
  test('discovery reports no capability schema issues for a conformant 3.2 response', async t => {
    const seller = await withSeller(t, capabilities32());
    const discovery = await underPinnedRoot(() =>
      testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' })
    );
    assert.equal(discovery.profile?.capabilities_schema_issues, undefined);
  });

  test('discovery validates against the supplied root for the echoed release', async t => {
    const seller = await withSeller(t, capabilities32());
    const discovery = await underPinnedRoot(() =>
      withServedReleaseSchemaRoots({ '3.2.5': hosted32Root }, () =>
        testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' })
      )
    );
    const issues = discovery.profile?.capabilities_schema_issues ?? [];
    assert.ok(
      issues.some(issue => issue.pointer === `/${MARKER}` || issue.message.includes(MARKER)),
      JSON.stringify(issues)
    );
    assert.ok(
      issues.every(issue => !PIN_30_ISSUE.test(issue.message)),
      JSON.stringify(issues)
    );
  });

  test('discovery keeps strict pin validation for an echo not in supported_versions', async t => {
    const seller = await withSeller(t, withSupportedVersions(capabilities32(), ['3.0', '3.1']));
    const discovery = await underPinnedRoot(() =>
      testCapabilityDiscovery(seller.url, { protocol: 'mcp', adcpVersion: '3.0' })
    );
    const issues = discovery.profile?.capabilities_schema_issues ?? [];
    assert.ok(
      issues.some(issue => PIN_30_ISSUE.test(issue.message)),
      JSON.stringify(issues)
    );
  });

  test('TaskExecutor accepts getAdcpCapabilities in strict mode', async t => {
    const seller = await withSeller(t, capabilities32());
    const client = new ADCPMultiAgentClient(
      [{ id: 'seller', name: 'Seller', agent_uri: seller.url, protocol: 'mcp' }],
      { adcpVersion: '3.0', validation: { responses: 'strict', logSchemaViolations: false } }
    );
    const result = await underPinnedRoot(() => client.agent('seller').getAdcpCapabilities({}));
    assert.equal(result.success, true, result.error);
  });

  test('runStoryboard passes the capabilities step and honors servedReleaseSchemaRoots', async t => {
    const seller = await withSeller(t, capabilities32());
    const options = { protocol: 'mcp', adcpVersion: '3.0', schemaRoot: PINNED_30_ROOT };

    const passed = await runStoryboard(seller.url, capabilitiesStoryboard(), options);
    const step = passed.phases[0].steps[0];
    const check = step.validations.find(v => v.check === 'response_schema');
    assert.equal(check?.passed, true, JSON.stringify(step, null, 2));

    await closeMCPConnections();
    const served = await runStoryboard(seller.url, capabilitiesStoryboard(), {
      ...options,
      servedReleaseSchemaRoots: { '3.2.5': hosted32Root },
    });
    const servedStep = served.phases[0].steps[0];
    const servedCheck = servedStep.validations.find(v => v.check === 'response_schema');
    assert.equal(servedCheck?.passed, false, JSON.stringify(servedStep, null, 2));
    assert.match(servedCheck.error, new RegExp(MARKER));
  });
});
