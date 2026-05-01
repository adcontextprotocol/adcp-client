const { test, describe } = require('node:test');
const assert = require('node:assert');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { VersionUnsupportedError } = require('../../dist/lib/errors/index.js');

function clientWithCapabilities(caps, configOverrides = {}) {
  const client = new SingleAgentClient(
    {
      id: 'test',
      name: 'Test Agent',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
    },
    { ...configOverrides }
  );
  client.getCapabilities = async () => caps;
  return client;
}

const idempotency = { replayTtlSeconds: 86400 };

describe('SingleAgentClient.requireV3 — corroborated check', () => {
  test('accepts v3 with majorVersions and idempotency', async () => {
    const client = clientWithCapabilities({
      version: 'v3',
      majorVersions: [3],
      idempotency,
      _synthetic: false,
    });
    await client.requireV3('sync_creatives');
  });

  test('accepts multi-version seller that includes 3', async () => {
    const client = clientWithCapabilities({
      version: 'v2',
      majorVersions: [2, 3],
      idempotency,
      _synthetic: false,
    });
    await client.requireV3('sync_creatives');
  });

  test('rejects seller with v3 string but missing replayTtlSeconds', async () => {
    const client = clientWithCapabilities({
      version: 'v3',
      majorVersions: [3],
      _synthetic: false,
    });
    await assert.rejects(
      () => client.requireV3('sync_creatives'),
      err => err instanceof VersionUnsupportedError && err.reason === 'idempotency'
    );
  });

  // _synthetic + v3 means the agent advertised get_adcp_capabilities (a v3
  // tool) but the call failed. We know the agent is v3; the fix in issue #1189
  // lets this through so v2 adapters don't cascade on top of the real error.
  // idempotency is not included because buildSyntheticV3Capabilities doesn't
  // set it — the idempotency check is skipped for synthetic caps.
  test('accepts synthetic v3 capabilities (tool present, call failed)', async () => {
    const client = clientWithCapabilities({
      version: 'v3',
      majorVersions: [3],
      _synthetic: true,
      // no idempotency — synthetic caps skip the idempotency check
    });
    await client.requireV3('sync_creatives'); // must not throw
  });

  test('rejects synthetic v2 capabilities (no get_adcp_capabilities tool)', async () => {
    const client = clientWithCapabilities({
      version: 'v2',
      majorVersions: [2],
      _synthetic: true,
    });
    await assert.rejects(
      () => client.requireV3('sync_creatives'),
      err => err instanceof VersionUnsupportedError && err.reason === 'synthetic'
    );
  });

  test('rejects v2-only seller', async () => {
    const client = clientWithCapabilities({
      version: 'v2',
      majorVersions: [2],
      _synthetic: false,
    });
    await assert.rejects(
      () => client.requireV3('sync_creatives'),
      err => err instanceof VersionUnsupportedError && err.reason === 'version'
    );
  });

  test('allowV2: true bypasses the guard without touching env', async () => {
    const client = clientWithCapabilities({ version: 'v2', majorVersions: [2], _synthetic: false }, { allowV2: true });
    await client.requireV3('sync_creatives');
  });

  test('allowV2: false overrides ADCP_ALLOW_V2=1', async () => {
    const original = process.env.ADCP_ALLOW_V2;
    process.env.ADCP_ALLOW_V2 = '1';
    try {
      const client = clientWithCapabilities(
        { version: 'v2', majorVersions: [2], _synthetic: false },
        { allowV2: false }
      );
      await assert.rejects(() => client.requireV3('sync_creatives'), VersionUnsupportedError);
    } finally {
      if (original === undefined) delete process.env.ADCP_ALLOW_V2;
      else process.env.ADCP_ALLOW_V2 = original;
    }
  });

  test('ADCP_ALLOW_V2=1 bypasses when allowV2 is undefined', async () => {
    const original = process.env.ADCP_ALLOW_V2;
    process.env.ADCP_ALLOW_V2 = '1';
    try {
      const client = clientWithCapabilities({
        version: 'v2',
        majorVersions: [2],
        _synthetic: false,
      });
      await client.requireV3('sync_creatives');
    } finally {
      if (original === undefined) delete process.env.ADCP_ALLOW_V2;
      else process.env.ADCP_ALLOW_V2 = original;
    }
  });

  test('VersionUnsupportedError omits agent_uri from message', () => {
    const err = new VersionUnsupportedError('sync_creatives', 'version', 'v2', 'https://secret-seller.internal/mcp');
    assert.ok(!err.message.includes('secret-seller.internal'));
    assert.equal(err.agentUrl, 'https://secret-seller.internal/mcp');
  });
});
