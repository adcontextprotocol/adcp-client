const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCapabilitiesResponse, supportsV3 } = require('../../dist/lib/utils/capabilities.js');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

describe('capability version declarations', () => {
  test('recognizes an agent declaring only supported_versions as AdCP 3', () => {
    const response = {
      adcp: { supported_versions: ['3.0', '3.1'] },
      supported_protocols: ['media_buy'],
    };
    const capabilities = parseCapabilitiesResponse(response);

    assert.equal(capabilities.version, 'v3');
    assert.deepEqual(capabilities.majorVersions, [3]);
    assert.deepEqual(capabilities.supportedVersions, ['3.0', '3.1']);
    assert.equal(supportsV3(capabilities), true);
    assert.equal(capabilities._synthetic, false);
    assert.equal(capabilities._raw, response);
    assert.equal(response.adcp.major_versions, undefined, 'normalization must not modify the wire response');
  });

  test('derives unique majors across stable, prerelease, and full semver releases', () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { supported_versions: ['2.5', '3.0', '3.1.29', '3.3-beta.1', '3.3.0-beta.2+build.1'] },
    });

    assert.deepEqual(capabilities.majorVersions, [2, 3]);
    assert.equal(capabilities.version, 'v3');
  });

  test('prefers supported_versions over the deprecated major-only declaration', () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { major_versions: [2], supported_versions: ['3.0', '3.1'] },
    });

    assert.deepEqual(capabilities.majorVersions, [3]);
    assert.equal(capabilities.version, 'v3');
  });

  test('does not infer AdCP 3 support when the release list explicitly advertises only AdCP 2', () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { major_versions: [2, 3], supported_versions: ['2.5'] },
    });

    assert.deepEqual(capabilities.majorVersions, [2]);
    assert.equal(supportsV3(capabilities), false);
  });

  for (const adcp of [{ major_versions: [2] }, { supported_versions: ['2.5'] }]) {
    test(`preserves an explicit AdCP 2 declaration: ${JSON.stringify(adcp)}`, () => {
      const capabilities = parseCapabilitiesResponse({ adcp });

      assert.equal(capabilities.version, 'v2');
      assert.deepEqual(capabilities.majorVersions, [2]);
      assert.equal(supportsV3(capabilities), false);
    });
  }

  test('retains legacy major-only declarations', () => {
    const capabilities = parseCapabilitiesResponse({ adcp: { major_versions: [2, 3] } });

    assert.deepEqual(capabilities.majorVersions, [2, 3]);
    assert.equal(capabilities.supportedVersions, undefined);
  });

  test('ignores malformed release entries without interpreting their numeric prefixes as majors', () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { supported_versions: [null, 2, '2garbage', '2.5-invalid!', '3.1', '3.2-beta.1'] },
    });

    assert.deepEqual(capabilities.majorVersions, [3]);
    assert.deepEqual(capabilities.supportedVersions, ['2garbage', '2.5-invalid!', '3.1', '3.2-beta.1']);
  });

  test('falls back to explicit legacy majors when releases are empty or unusable', () => {
    for (const supported_versions of [[], ['invalid', null], '3.1']) {
      const capabilities = parseCapabilitiesResponse({ adcp: { supported_versions, major_versions: [2] } });

      assert.equal(capabilities.version, 'v2');
      assert.deepEqual(capabilities.majorVersions, [2]);
    }
  });

  test('defaults capability responses without a usable version declaration to AdCP 3', () => {
    for (const adcp of [undefined, {}, { major_versions: [] }, { supported_versions: [] }]) {
      const capabilities = parseCapabilitiesResponse({ adcp, supported_protocols: ['media_buy'] });

      assert.equal(capabilities.version, 'v3');
      assert.deepEqual(capabilities.majorVersions, [3]);
    }
  });
});

describe('buyer discovery without major_versions', () => {
  test('reuses valid AdCP 3 evidence that also advertises a future major', async () => {
    const client = new SingleAgentClient({
      id: 'future-major-test',
      name: 'Future major test',
      protocol: 'mcp',
      agent_uri: 'https://seller.example/mcp',
    });
    const capabilities = parseCapabilitiesResponse({ adcp: { supported_versions: ['3.2', '4.0.0-beta.1'] } });
    assert.deepEqual(capabilities.majorVersions, [3, 4]);
    assert.equal(
      client.primeCapabilities({
        scope: client.getCapabilityEvidenceScope(),
        capabilities,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        toolSchemas: {},
      }),
      true
    );
    client.getAgentInfo = async () => assert.fail('primed AdCP 3 evidence must be reused');
    const cached = await client.getCapabilities();
    assert.deepEqual(cached.majorVersions, [3, 4]);
    assert.deepEqual(cached.supportedVersions, capabilities.supportedVersions);
  });

  for (const adcp of [{ supported_versions: ['3.0', '3.1'] }, {}]) {
    test(`selects v3 adapters without a v2 sunset warning: ${JSON.stringify(adcp)}`, async t => {
      const agent = {
        id: 'capabilities-version-test',
        name: 'Capabilities version test',
        protocol: 'mcp',
        agent_uri: 'https://seller.example/mcp',
      };
      const client = new SingleAgentClient(agent, { adcpVersion: '3.1' });
      client.getAgentInfo = async () => ({ tools: [{ name: 'get_adcp_capabilities' }] });
      client.ensureEndpointDiscovered = async () => agent;
      client.executor.executeTask = async (_agent, task) => {
        assert.equal(task, 'get_adcp_capabilities');
        return {
          success: true,
          status: 'completed',
          data: {
            adcp: { ...adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
            supported_protocols: ['media_buy'],
          },
        };
      };
      const warnings = t.mock.method(console, 'warn', () => {});

      assert.equal(await client.detectServerVersion(), 'v3');
      assert.equal(await client.supportsVersion(3), true);
      assert.equal(await client.supportsVersion(2), false);
      assert.equal((await client.getCapabilities())._synthetic, false);
      await client.requireSupportedMajor('get_products');
      assert.equal(warnings.mock.callCount(), 0);
    });
  }
});
