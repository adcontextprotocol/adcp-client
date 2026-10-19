const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const { MemoryStorage } = require('../../dist/lib/storage/MemoryStorage.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');
const { VersionUnsupportedError, ConfigurationError } = require('../../dist/lib/errors/index.js');
const { resolveAdcpVersion } = require('../../dist/lib/utils/adcp-version-config.js');
const { hasSchemaBundle, resolveBundleKey } = require('../../dist/lib/validation/schema-loader.js');
const { isCompatibleWith } = require('../../dist/lib/version.js');

const agent = { id: 'retired-agent', name: 'Retired agent', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' };

function clientWithResponse(data, { success = true, tools = ['get_adcp_capabilities'] } = {}) {
  const client = new SingleAgentClient(agent);
  const calls = [];
  client.getAgentInfo = async () => ({ tools: tools.map(name => ({ name })) });
  client.ensureEndpointDiscovered = async () => agent;
  client.executor.executeTask = async (_agent, task) => {
    calls.push(task);
    return { success, status: success ? 'completed' : 'failed', data, error: success ? undefined : 'Invalid response' };
  };
  return { client, calls };
}

describe('AdCP 2 end of life', () => {
  for (const version of ['v2.5', 'v2.6', '2.5', '2.5.0', '2.6']) {
    test(`rejects ${version} pins even if a retired schema cache exists`, () => {
      assert.throws(
        () => resolveAdcpVersion(version),
        error => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /2026-08-01/);
          return true;
        }
      );
      assert.throws(() => resolveBundleKey(version), /end of life/);
      assert.equal(hasSchemaBundle(version), false);
      assert.equal(isCompatibleWith(version), false);
      assert.throws(() => new SingleAgentClient(agent, { adcpVersion: version }), ConfigurationError);
    });
  }

  for (const adcp of [{ major_versions: [2] }, { supported_versions: ['2.5'] }]) {
    for (const success of [true, false]) {
      test(`rejects a v2 declaration before business dispatch (${JSON.stringify(adcp)}, success=${success})`, async t => {
        t.mock.method(console, 'warn', () => {});
        const { client, calls } = clientWithResponse({ adcp, supported_protocols: ['media_buy'] }, { success });
        await assert.rejects(
          () => client.getCapabilities(),
          error => {
            assert.ok(error instanceof VersionUnsupportedError);
            assert.equal(error.code, 'VERSION_UNSUPPORTED');
            assert.match(error.message, /2026-08-01/);
            assert.doesNotMatch(error.message, /allowV2|override/);
            return true;
          }
        );
        assert.deepEqual(calls, ['get_adcp_capabilities']);
        assert.equal(client.cachedCapabilities, undefined, 'retired evidence must not be cached');
      });
    }
  }

  test('rejects missing capability discovery without sending a business call', async () => {
    const { client, calls } = clientWithResponse(undefined, { tools: ['get_products'] });
    await assert.rejects(
      () => client.detectServerVersion(),
      error => {
        assert.ok(error instanceof VersionUnsupportedError);
        assert.match(error.message, /does not advertise get_adcp_capabilities/);
        assert.match(error.message, /^Cannot discover supported AdCP capabilities:/);
        assert.doesNotMatch(error.message, /Refusing to dispatch task/);
        return true;
      }
    );
    assert.deepEqual(calls, []);
  });

  test('rejects cached v2 evidence despite the old opt-out environment variable', async t => {
    const previous = process.env.ADCP_ALLOW_V2;
    process.env.ADCP_ALLOW_V2 = '1';
    t.after(() => {
      if (previous === undefined) delete process.env.ADCP_ALLOW_V2;
      else process.env.ADCP_ALLOW_V2 = previous;
    });
    const client = new SingleAgentClient(agent, { allowV2: true });
    client.cachedCapabilities = {
      version: 'v2',
      majorVersions: [2],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: true,
    };
    await assert.rejects(() => client.requireSupportedMajor('create_media_buy'), VersionUnsupportedError);
  });

  test('rejects explicit v2 protocol dispatch even with version-envelope injection disabled', async () => {
    await assert.rejects(
      () => ProtocolClient.callTool(agent, 'get_products', {}, { serverVersion: 'v2', versionEnvelope: 'none' }),
      VersionUnsupportedError
    );
  });

  test('rejects direct executor v2 dispatch before contacting an agent', async () => {
    const executor = new TaskExecutor();
    await assert.rejects(
      () => executor.executeTask(agent, 'get_products', {}, undefined, {}, 'v2'),
      VersionUnsupportedError
    );
  });

  test('rejects stored AdCP 2 continuations before claiming or contacting the seller', async () => {
    const storage = new MemoryStorage({ autoCleanup: false });
    const token = 'A'.repeat(43);
    const state = { serverVersion: 'v2', taskName: 'create_media_buy', expiresAt: Date.now() + 60000 };
    await storage.putIfAbsent(token, state, 60);
    const executor = new TaskExecutor({ deferredStorage: storage });
    await assert.rejects(() => executor.resumeDeferredTask(token, {}), VersionUnsupportedError);
    assert.deepEqual(await storage.get(token), state);
  });

  test('keeps agents advertising AdCP 3 alongside their retired major usable', async () => {
    const { client } = clientWithResponse({ adcp: { major_versions: [2, 3] }, supported_protocols: ['media_buy'] });
    assert.equal(await client.detectServerVersion(), 'v3');
    assert.equal(await client.supportsVersion(3), true);
    assert.equal(await client.supportsVersion(2), false);
  });
});
