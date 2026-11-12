/**
 * Capability discovery never sends a preview pin to a seller that has not
 * advertised it.
 *
 * Reported in AdCP Slack: a registration check on the 3.3 beta SDK kept saying
 * a 3.0-only seller "does not look like an AdCP agent". The check called
 * `get_adcp_capabilities` pinned to `adcp_version: "3.3-beta.5"`, the seller
 * correctly answered `VERSION_UNSUPPORTED` with `supported_versions: ["3.0"]`,
 * and nothing retried.
 *
 * The rule: a buyer sends a preview pin only to a peer that advertises that
 * exact release, so preview discovery goes out unpinned; a pinned discovery the
 * seller refuses for the version is retried once unpinned. A pin the caller
 * chose (version fields in params, or an explicit envelope) is left alone, and
 * the seller's refusal comes back with its supported_versions.
 */

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { ADCPMultiAgentClient } = require('../../dist/lib/core/ADCPMultiAgentClient.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const { capabilityDiscoveryEnvelope } = require('../../dist/lib/adapters/version/negotiate.js');
const {
  createTestClient,
  discoverAgentProfile,
  testClientDiscoveryWireAdcpVersion,
} = require('../../dist/lib/testing/client.js');
const { comply } = require('../../dist/lib/testing/compliance/comply.js');

const PREVIEW_PIN = '3.3.0-beta.5';
const PREVIEW_WIRE = '3.3-beta.5';

const CAPABILITIES = {
  adcp: {
    major_versions: [3],
    supported_versions: ['3.0'],
    idempotency: { supported: true, replay_ttl_seconds: 86400 },
  },
  supported_protocols: ['media_buy'],
};

/**
 * A seller that implements AdCP 3.0 only. Any `adcp_version` it does not
 * support is refused with the spec's VERSION_UNSUPPORTED error. Records the
 * arguments of every `get_adcp_capabilities` call.
 */
async function startSeller30() {
  const discoveryCalls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let rpc;
    try {
      rpc = body ? JSON.parse(body) : undefined;
    } catch {
      rpc = undefined;
    }
    const reply = result => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };
    const toolResult = (payload, isError = false) => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...(isError && { isError: true }),
    });
    if (!rpc || rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'seller-3.0', version: '1.0.0' },
      });
    }
    if (rpc.method === 'tools/list') {
      return reply({
        tools: [
          { name: 'get_adcp_capabilities', inputSchema: { type: 'object' } },
          { name: 'get_products', inputSchema: { type: 'object' } },
        ],
      });
    }
    if (rpc.method === 'tools/call') {
      const args = rpc.params?.arguments ?? {};
      if (rpc.params?.name === 'get_adcp_capabilities') discoveryCalls.push(args);
      const version = args.adcp_version;
      if (version !== undefined && !String(version).startsWith('3.0')) {
        return reply(
          toolResult(
            {
              adcp_error: {
                code: 'VERSION_UNSUPPORTED',
                message: `AdCP ${version} is not supported`,
                recovery: 'correctable',
                details: { supported_versions: ['3.0'] },
              },
            },
            true
          )
        );
      }
      if (rpc.params?.name === 'get_adcp_capabilities') return reply(toolResult(CAPABILITIES));
      return reply(toolResult({ products: [] }));
    }
    // `server/discover` and anything else: not this legacy seller's method.
    res.writeHead(400).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    discoveryCalls,
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

function agentFor(url, config = {}) {
  return new ADCPMultiAgentClient([{ id: 'seller', name: 'Seller', agent_uri: url, protocol: 'mcp' }], {
    validation: { requests: 'warn', responses: 'warn' },
    ...config,
  }).agent('seller');
}

describe('capabilityDiscoveryEnvelope', () => {
  test('a preview pin discovers unpinned', () => {
    assert.equal(capabilityDiscoveryEnvelope(undefined, undefined, PREVIEW_PIN), 'none');
    assert.equal(capabilityDiscoveryEnvelope(undefined, '3.2.0-rc.7', '3.2.1'), 'none');
  });

  test('a stable pin keeps the default envelope', () => {
    assert.equal(capabilityDiscoveryEnvelope(undefined, undefined, '3.1'), undefined);
    assert.equal(capabilityDiscoveryEnvelope(undefined, '3.2', '3.2.1'), undefined);
  });

  test('an explicit envelope always wins', () => {
    assert.equal(capabilityDiscoveryEnvelope('auto', undefined, PREVIEW_PIN), 'auto');
    assert.equal(capabilityDiscoveryEnvelope('major-only', undefined, PREVIEW_PIN), 'major-only');
  });
});

describe('preview-pinned client against a 3.0-only seller', () => {
  let seller;

  before(async () => {
    seller = await startSeller30();
  });
  after(async () => {
    await closeMCPConnections();
    await seller.stop();
  });
  beforeEach(() => {
    seller.discoveryCalls.length = 0;
  });

  test('the SDK default is the preview this file exercises', () => {
    assert.equal(ADCP_VERSION, PREVIEW_PIN, 'update PREVIEW_PIN when the SDK default release moves');
  });

  test('getAdcpCapabilities() discovers unpinned and succeeds', async () => {
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({});

    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(result.data.adcp.supported_versions, ['3.0']);
    assert.deepEqual(seller.discoveryCalls, [{}], 'discovery must not carry the preview pin');
  });

  test('getCapabilities() discovers unpinned and succeeds', async () => {
    const capabilities = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getCapabilities();

    assert.equal(capabilities._synthetic, false);
    assert.deepEqual(capabilities.supportedVersions, ['3.0']);
    assert.ok(
      seller.discoveryCalls.every(args => args.adcp_version === undefined),
      JSON.stringify(seller.discoveryCalls)
    );
  });

  test('an adcp_version the caller passes is sent as-is and the refusal carries supported_versions', async () => {
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({
      adcp_version: PREVIEW_WIRE,
    });

    assert.equal(result.success, false);
    assert.equal(result.adcpError?.code, 'VERSION_UNSUPPORTED');
    assert.deepEqual(result.adcpError?.details?.supported_versions, ['3.0']);
    assert.equal(seller.discoveryCalls.length, 1, 'an explicit caller pin is not retried');
    assert.equal(seller.discoveryCalls[0].adcp_version, PREVIEW_WIRE);
  });

  test('an explicit versionEnvelope keeps discovery pinned', async () => {
    for (const config of [{ versionEnvelope: 'auto' }, {}]) {
      seller.discoveryCalls.length = 0;
      const options = config.versionEnvelope ? undefined : { versionEnvelope: 'auto' };
      const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN, ...config }).getAdcpCapabilities(
        {},
        undefined,
        options
      );

      assert.equal(result.adcpError?.code, 'VERSION_UNSUPPORTED');
      assert.deepEqual(result.adcpError?.details?.supported_versions, ['3.0']);
      assert.deepEqual(
        seller.discoveryCalls.map(args => args.adcp_version),
        [PREVIEW_WIRE]
      );
    }
  });

  test('a refused stable pin is retried once unpinned', async () => {
    const result = await agentFor(seller.url, { adcpVersion: '3.1' }).getAdcpCapabilities({});

    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(
      seller.discoveryCalls.map(args => args.adcp_version),
      ['3.1', undefined]
    );
  });
});

describe('testing discovery with a preview pin against a 3.0-only seller', () => {
  let seller;

  before(async () => {
    seller = await startSeller30();
  });
  after(async () => {
    await closeMCPConnections();
    await seller.stop();
  });
  beforeEach(() => {
    seller.discoveryCalls.length = 0;
  });

  test('discoverAgentProfile reads the seller profile instead of a VERSION_UNSUPPORTED', async () => {
    const client = createTestClient(seller.url, 'mcp', { adcpVersion: PREVIEW_PIN, allow_http: true });
    const { profile, step } = await discoverAgentProfile(client, undefined, PREVIEW_PIN);

    assert.equal(step.passed, true, String(step.error));
    assert.equal(profile.capabilities_probe_error, undefined);
    assert.deepEqual(profile.adcp_supported_versions, ['3.0']);
    assert.deepEqual(seller.discoveryCalls, [{}]);
  });

  test('a test that pins the envelope still probes VERSION_UNSUPPORTED with the pin', async () => {
    const client = createTestClient(seller.url, 'mcp', { adcpVersion: PREVIEW_PIN, versionEnvelope: 'auto' });
    const { profile } = await discoverAgentProfile(client, undefined, PREVIEW_PIN);

    assert.equal(
      profile.capabilities_probe_error,
      `VERSION_UNSUPPORTED: requested "${PREVIEW_WIRE}"; seller supports "3.0"`
    );
    assert.deepEqual(
      seller.discoveryCalls.map(args => args.adcp_version),
      [PREVIEW_WIRE]
    );
  });

  test('diagnostics name a requested release only when discovery sent one', () => {
    const unpinned = createTestClient('https://seller.example/mcp', 'mcp', { adcpVersion: PREVIEW_PIN });
    const pinned = createTestClient('https://seller.example/mcp', 'mcp', {
      adcpVersion: PREVIEW_PIN,
      versionEnvelope: 'auto',
    });
    const stable = createTestClient('https://seller.example/mcp', 'mcp', { adcpVersion: '3.2.1' });

    assert.equal(testClientDiscoveryWireAdcpVersion(unpinned), undefined);
    assert.equal(testClientDiscoveryWireAdcpVersion(pinned), PREVIEW_WIRE);
    assert.equal(testClientDiscoveryWireAdcpVersion(stable), '3.2');
  });

  // Discovery now reads the seller's release window, so comply reaches its
  // version check instead of reporting "Agent unreachable — VERSION_UNSUPPORTED".
  test('comply reports the version mismatch, not an unreachable agent', async () => {
    await assert.rejects(
      comply(seller.url, { allow_http: true, adcpVersion: PREVIEW_PIN, timeout_ms: 30_000 }),
      error => {
        assert.equal(error.name, 'CapabilityResolutionError');
        assert.equal(error.code, 'unsupported_adcp_version');
        assert.equal(error.complianceVersion, PREVIEW_PIN);
        assert.deepEqual(error.supportedVersions, ['3.0']);
        return true;
      }
    );
    assert.ok(seller.discoveryCalls.length > 0, 'comply should have discovered capabilities');
    assert.ok(
      seller.discoveryCalls.every(args => args.adcp_version === undefined),
      `comply discovery must not carry the preview pin: ${JSON.stringify(seller.discoveryCalls)}`
    );
  });
});
