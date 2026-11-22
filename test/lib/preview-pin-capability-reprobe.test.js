/**
 * A preview-pinned client re-probes capabilities at an advertised pin
 * (adcp-client#3765, #3715).
 *
 * A client pinned to a preview release discovers unpinned, so a seller that
 * serves the preview only to an exact pin answered at its default release and
 * preview-only `experimental_features` read as undeclared. When the unpinned
 * answer lists the exact pin in `adcp.supported_versions`, the client asks
 * once more, pinned, and uses (and caches) that answer.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { ADCPMultiAgentClient } = require('../../dist/lib/core/ADCPMultiAgentClient.js');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { createInMemoryAgentDiscoveryCache } = require('../../dist/lib/core/agent-discovery-cache.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { advertisesExactAdcpRelease } = require('../../dist/lib/adapters/version/index.js');
const { createTestClient, discoverAgentProfile } = require('../../dist/lib/testing/client.js');
const { ADCP_VERSION, toReleasePrecisionVersion } = require('../../dist/lib/version.js');

// The preview release the SDK ships (e.g. '3.3.0-rc.3'), and its wire form ('3.3-rc.3').
const PREVIEW_PIN = ADCP_VERSION;
const PREVIEW_WIRE = toReleasePrecisionVersion(ADCP_VERSION);
assert.match(PREVIEW_PIN, /-/, 'these tests need the SDK default ADCP_VERSION to be a preview release');
// The preview's release line ('3.3') and a different prerelease on that line.
const PREVIEW_LINE = PREVIEW_WIRE.split('-')[0];
const OTHER_PREVIEW_WIRE = `${PREVIEW_LINE}-alpha.0`;
const FEATURE = 'media_buy.collection_catalog';
// The 3.3 preview schema requires `collection_cards` wherever `collection_catalog` is declared.
const FEATURES = [FEATURE, 'media_buy.collection_cards'];

function capabilities(release, extra = {}) {
  return {
    status: 'completed',
    adcp_version: release,
    adcp: {
      major_versions: [3],
      supported_versions: ['3.2', PREVIEW_WIRE],
      idempotency: { supported: true, replay_ttl_seconds: 86400 },
    },
    supported_protocols: ['media_buy'],
    ...extra,
  };
}

/**
 * A seller whose default release is 3.2. It serves the SDK's preview, with the
 * `media_buy.collection_catalog` experimental feature, only to the exact pin,
 * and refuses any other pin with VERSION_UNSUPPORTED. Records the arguments of
 * every `get_adcp_capabilities` call.
 *
 * @param options.supportedVersions what the unpinned answer advertises
 * @param options.unpinnedRelease the release the unpinned answer is served at
 * @param options.refusePreviewPin when true, the advertised pin is refused
 */
async function startSeller({
  supportedVersions = ['3.2', PREVIEW_WIRE],
  unpinnedRelease = '3.2',
  refusePreviewPin = false,
} = {}) {
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
        serverInfo: { name: 'seller-preview', version: '1.0.0' },
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
      if (rpc.params?.name !== 'get_adcp_capabilities') return reply(toolResult({ products: [] }));
      const version = args.adcp_version;
      if (version === undefined || version === '3.2') {
        const release = version ?? unpinnedRelease;
        const payload = capabilities(release);
        payload.adcp.supported_versions = supportedVersions;
        if (release === PREVIEW_WIRE) payload.experimental_features = FEATURES;
        return reply(toolResult(payload));
      }
      if (version === PREVIEW_WIRE && !refusePreviewPin) {
        const payload = capabilities(PREVIEW_WIRE, { experimental_features: FEATURES });
        payload.adcp.supported_versions = supportedVersions;
        return reply(toolResult(payload));
      }
      return reply(
        toolResult(
          {
            adcp_error: {
              code: 'VERSION_UNSUPPORTED',
              message: `AdCP ${version} is not supported`,
              recovery: 'correctable',
              details: { supported_versions: supportedVersions },
            },
          },
          true
        )
      );
    }
    res.writeHead(400).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    discoveryCalls,
    versions: () => discoveryCalls.map(args => args.adcp_version),
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

function singleAgentFor(url, config = {}) {
  return new SingleAgentClient(
    { id: 'seller', name: 'Seller', agent_uri: url, protocol: 'mcp' },
    {
      validation: { requests: 'warn', responses: 'warn' },
      allowPrivateIp: true,
      transport: { allowPrivateIp: true },
      ...config,
    }
  );
}

function agentFor(url, config = {}) {
  return new ADCPMultiAgentClient([{ id: 'seller', name: 'Seller', agent_uri: url, protocol: 'mcp' }], {
    validation: { requests: 'warn', responses: 'warn' },
    ...config,
  }).agent('seller');
}

async function withSeller(t, options) {
  const seller = await startSeller(options);
  t.after(async () => {
    await closeMCPConnections();
    await seller.stop();
  });
  return seller;
}

describe('a preview-pinned client sees preview-only experimental features (#3765)', () => {
  test('getAdcpCapabilities({}) re-probes at the advertised pin', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({});

    assert.equal(result.success, true, String(result.error));
    assert.equal(result.data.adcp_version, PREVIEW_WIRE);
    assert.deepEqual(result.data.experimental_features, FEATURES);
    assert.deepEqual(seller.discoveryCalls, [{}, { adcp_version: PREVIEW_WIRE, adcp_major_version: 3 }]);
  });

  test('getCapabilities().experimentalFeatures declares the feature', async t => {
    const seller = await withSeller(t);
    const caps = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getCapabilities();

    assert.equal(caps._synthetic, false);
    assert.deepEqual(caps.experimentalFeatures, FEATURES);
    assert.equal(seller.discoveryCalls.length, 2);
    assert.equal(seller.discoveryCalls[0].adcp_version, undefined);
    assert.equal(seller.discoveryCalls[1].adcp_version, PREVIEW_WIRE);
  });

  test('supports("experimental:…") is true', async t => {
    const seller = await withSeller(t);
    const client = singleAgentFor(seller.url, { adcpVersion: PREVIEW_PIN });

    assert.equal(await client.supports(`experimental:${FEATURE}`), true);
    assert.deepEqual(seller.versions(), [undefined, PREVIEW_WIRE]);
  });

  test('a stable client does not re-probe and sees no preview feature', async t => {
    const seller = await withSeller(t);
    const client = singleAgentFor(seller.url, { adcpVersion: '3.2.0' });

    assert.equal(await client.supports(`experimental:${FEATURE}`), false);
    assert.ok(!seller.versions().includes(PREVIEW_WIRE), JSON.stringify(seller.discoveryCalls));
  });
});

describe('no re-probe', () => {
  test('a seller that does not list the exact pin gets one unpinned call', async t => {
    const seller = await withSeller(t, { supportedVersions: ['3.2', OTHER_PREVIEW_WIRE] });
    const client = singleAgentFor(seller.url, { adcpVersion: PREVIEW_PIN });

    const result = await client.getAdcpCapabilities({});
    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(seller.discoveryCalls, [{}]);

    const caps = await client.getCapabilities();
    assert.equal(caps.experimentalFeatures?.includes(FEATURE) ?? false, false);
    assert.equal(await client.supports(`experimental:${FEATURE}`), false);
    assert.ok(seller.discoveryCalls.every(args => args.adcp_version === undefined));
  });

  test('a bare release-line advertisement is not the exact pin', async t => {
    const seller = await withSeller(t, { supportedVersions: ['3.2', PREVIEW_LINE] });
    await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({});

    assert.deepEqual(seller.discoveryCalls, [{}]);
  });

  test('an unpinned answer already served at the pin is used as-is', async t => {
    const seller = await withSeller(t, { unpinnedRelease: PREVIEW_WIRE });
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({});

    assert.equal(result.success, true, String(result.error));
    assert.equal(result.data.adcp_version, PREVIEW_WIRE);
    assert.deepEqual(seller.discoveryCalls, [{}]);
  });

  test('a caller operationId keeps its single dispatch', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({}, undefined, {
      operationId: 'discovery-op-1',
    });

    assert.equal(result.success, true, String(result.error));
    assert.equal(result.metadata?.taskId, 'discovery-op-1');
    assert.equal(result.data.adcp_version, '3.2');
    assert.deepEqual(seller.discoveryCalls, [{}]);
  });

  test('an explicit versionEnvelope keeps the caller in charge of the pin', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({}, undefined, {
      versionEnvelope: 'auto',
    });

    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(seller.versions(), [PREVIEW_WIRE], 'one pinned dispatch, no second probe');
  });

  test('a caller-chosen adcp_version in params is sent once', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({
      adcp_version: '3.2',
    });

    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(seller.versions(), ['3.2']);
  });
});

describe('a failed re-probe falls back to the unpinned answer', () => {
  test('a seller that advertises the pin but refuses it', async t => {
    const seller = await withSeller(t, { refusePreviewPin: true });
    const client = singleAgentFor(seller.url, { adcpVersion: PREVIEW_PIN });
    const result = await client.getAdcpCapabilities({});

    assert.equal(result.success, true, String(result.error));
    assert.equal(result.data.adcp_version, '3.2');
    assert.equal(result.data.experimental_features, undefined);
    assert.deepEqual(seller.versions(), [undefined, PREVIEW_WIRE]);
    assert.equal(await client.supports(`experimental:${FEATURE}`), false);
  });
});

describe('caches keep the pinned and unpinned answers apart', () => {
  test('after a re-probe getCapabilities() serves the pinned answer from cache', async t => {
    const seller = await withSeller(t);
    const client = agentFor(seller.url, { adcpVersion: PREVIEW_PIN });

    await client.getCapabilities();
    assert.deepEqual(seller.versions(), [undefined, PREVIEW_WIRE]);
    const before = seller.discoveryCalls.length;
    const caps = await client.getCapabilities();

    assert.deepEqual(caps.experimentalFeatures, FEATURES);
    assert.equal(caps.servedVersion, PREVIEW_WIRE);
    assert.equal(seller.discoveryCalls.length, before, 'no further get_adcp_capabilities call');
  });

  test('a caller-pinned getAdcpCapabilities does not overwrite the cached pinned capabilities', async t => {
    const seller = await withSeller(t);
    const client = agentFor(seller.url, { adcpVersion: PREVIEW_PIN });
    await client.getCapabilities();

    const other = await client.getAdcpCapabilities({ adcp_version: '3.2' });
    assert.equal(other.data.adcp_version, '3.2');

    const before = seller.discoveryCalls.length;
    const caps = await client.getCapabilities();
    assert.deepEqual(caps.experimentalFeatures, FEATURES);
    assert.equal(caps.servedVersion, PREVIEW_WIRE);
    assert.equal(seller.discoveryCalls.length, before);
  });

  test('a stable and a preview client sharing one discoveryCache each get their own release', async t => {
    const seller = await withSeller(t);
    const cache = createInMemoryAgentDiscoveryCache();
    const build = adcpVersion =>
      new SingleAgentClient(
        { id: 'shared', name: 'shared', agent_uri: seller.url, protocol: 'mcp' },
        {
          adcpVersion,
          allowPrivateIp: true,
          transport: { allowPrivateIp: true },
          discoveryCache: { cache, authIdentity: 'tenant-a' },
        }
      );

    const stable = await build('3.2.0').getCapabilities();
    const preview = await build(PREVIEW_PIN).getCapabilities();
    const discovered = seller.discoveryCalls.length;
    const stableAgain = await build('3.2.0').getCapabilities();
    const previewAgain = await build(PREVIEW_PIN).getCapabilities();
    assert.equal(seller.discoveryCalls.length, discovered, 'both later clients are served from the shared cache');

    assert.equal(stable.servedVersion, '3.2');
    assert.equal(stable.experimentalFeatures?.includes(FEATURE) ?? false, false);
    assert.equal(preview.servedVersion, PREVIEW_WIRE);
    assert.deepEqual(preview.experimentalFeatures, FEATURES);
    assert.equal(stableAgain.servedVersion, '3.2');
    assert.equal(previewAgain.servedVersion, PREVIEW_WIRE);
    assert.deepEqual(previewAgain.experimentalFeatures, FEATURES);
  });

  for (const order of [
    ['none', undefined],
    [undefined, 'none'],
  ]) {
    test(`an explicit 'none' envelope and the default policy keep separate shared evidence (${order.map(String).join(' → ')})`, async t => {
      const seller = await withSeller(t);
      const cache = createInMemoryAgentDiscoveryCache();
      const build = versionEnvelope =>
        new SingleAgentClient(
          { id: 'shared', name: 'shared', agent_uri: seller.url, protocol: 'mcp' },
          {
            adcpVersion: PREVIEW_PIN,
            ...(versionEnvelope !== undefined && { versionEnvelope }),
            allowPrivateIp: true,
            transport: { allowPrivateIp: true },
            discoveryCache: { cache, authIdentity: 'tenant-a' },
          }
        );

      const served = {};
      for (const envelope of order)
        served[envelope ?? 'default'] = (await build(envelope).getCapabilities()).servedVersion;

      assert.equal(served.none, '3.2', 'an explicit unpinned discovery is not re-probed');
      assert.equal(served.default, PREVIEW_WIRE, 'the default policy re-probes at the advertised pin');
    });
  }
});

describe('servedVersion and result metadata', () => {
  test('a re-probed result reports the seller echo and the client pin', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({});

    assert.equal(result.metadata.adcpVersion, PREVIEW_WIRE);
    assert.equal(result.metadata.wireAdcpVersion, PREVIEW_PIN);
  });

  test('an unpinned answer that was not re-probed has no wireAdcpVersion', async t => {
    const seller = await withSeller(t, { supportedVersions: ['3.2'] });
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({});

    assert.equal(result.metadata.adcpVersion, '3.2');
    assert.equal(result.metadata.wireAdcpVersion, undefined);
  });

  test('getCapabilities().servedVersion is the pinned release', async t => {
    const seller = await withSeller(t);
    const caps = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getCapabilities();

    assert.equal(caps.servedVersion, PREVIEW_WIRE);
  });
});

describe('adcp_version param normalization', () => {
  test('a full-semver preview version goes on the wire at release precision', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({
      adcp_version: PREVIEW_PIN,
    });

    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(seller.versions(), [PREVIEW_WIRE]);
    assert.equal(result.data.adcp_version, PREVIEW_WIRE);
  });

  test('a release-precision version passes through unchanged', async t => {
    const seller = await withSeller(t);
    const result = await agentFor(seller.url, { adcpVersion: PREVIEW_PIN }).getAdcpCapabilities({
      adcp_version: PREVIEW_WIRE,
    });

    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(seller.versions(), [PREVIEW_WIRE]);
  });

  test('a non-semver string still fails request validation', async t => {
    const seller = await withSeller(t);
    const client = agentFor(seller.url, { adcpVersion: PREVIEW_PIN, validation: { requests: 'strict' } });

    await assert.rejects(client.getAdcpCapabilities({ adcp_version: 'not-a-version' }));
    assert.deepEqual(seller.discoveryCalls, []);
  });
});

describe('testing discoverAgentProfile with a preview pin (#3715)', () => {
  test('reads the pinned capabilities', async t => {
    const seller = await withSeller(t);
    const client = createTestClient(seller.url, 'mcp', { adcpVersion: PREVIEW_PIN, allow_http: true });
    const { profile, step } = await discoverAgentProfile(client, undefined, PREVIEW_PIN);

    assert.equal(step.passed, true, String(step.error));
    assert.equal(profile.capabilities_probe_error, undefined);
    assert.equal(profile.raw_capabilities.adcp_version, PREVIEW_WIRE);
    assert.ok(profile.raw_capabilities.experimental_features.includes(FEATURE));
    assert.deepEqual(seller.versions(), [undefined, PREVIEW_WIRE]);
  });
});

describe('advertisesExactAdcpRelease', () => {
  test('an exact preview match', () => {
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, ['3.2', PREVIEW_WIRE]), true);
    assert.equal(advertisesExactAdcpRelease(PREVIEW_WIRE, [PREVIEW_WIRE]), true);
  });

  test('a different prerelease tag is not a match', () => {
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, [OTHER_PREVIEW_WIRE]), false);
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, ['3.3-beta.0']), false);
  });

  test('a different patch or the bare release line is not a match', () => {
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, [PREVIEW_LINE, `${PREVIEW_LINE}.1`]), false);
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, ['3.2']), false);
  });

  test('non-string entries are ignored', () => {
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, [undefined, null, 3.3, {}, PREVIEW_WIRE]), true);
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, [undefined, null, 3.3, {}]), false);
  });

  test('empty or undefined advertises nothing', () => {
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, []), false);
    assert.equal(advertisesExactAdcpRelease(PREVIEW_PIN, undefined), false);
  });
});
