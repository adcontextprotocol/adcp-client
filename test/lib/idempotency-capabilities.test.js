/**
 * Client-side reading of `adcp.idempotency.replay_ttl_seconds` from
 * get_adcp_capabilities, and fail-closed behaviour when a v3 seller omits it.
 *
 * The fail-closed test covers `SingleAgentClient.getIdempotencyReplayTtlSeconds()`
 * by constructing a client and stubbing `getCapabilities()` to return
 * controlled capability shapes.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseCapabilitiesResponse } = require('../../dist/lib/utils/capabilities.js');
const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

const stubAgent = {
  id: 'a1',
  name: 'stub',
  protocol: 'mcp',
  agent_uri: 'https://stub.example/mcp',
};

describe('parseCapabilitiesResponse reads adcp.idempotency.replay_ttl_seconds', () => {
  it('surfaces declared TTL from v3 capability response', () => {
    const caps = parseCapabilitiesResponse({
      adcp: { major_versions: [3], idempotency: { replay_ttl_seconds: 86400 } },
      supported_protocols: ['media_buy'],
    });
    assert.equal(caps.idempotency?.replayTtlSeconds, 86400);
    assert.equal(caps.version, 'v3');
  });

  it('omits the idempotency field when the seller does not declare it', () => {
    const caps = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
    });
    assert.equal(caps.idempotency, undefined);
  });

  it('ignores non-positive or non-numeric values (treat as missing)', () => {
    const caps = parseCapabilitiesResponse({
      adcp: { major_versions: [3], idempotency: { replay_ttl_seconds: 0 } },
    });
    assert.equal(caps.idempotency, undefined);
  });
});

describe('SingleAgentClient.getIdempotencyReplayTtlSeconds()', () => {
  it('returns the declared TTL on a v3 seller', async () => {
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {},
      idempotency: { replayTtlSeconds: 86400 },
      extensions: [],
      _synthetic: false,
    };
    assert.equal(await client.getIdempotencyReplayTtlSeconds(), 86400);
  });

  it('fails closed when a v3 seller omits the declaration', async () => {
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: false,
    };
    await assert.rejects(
      () => client.getIdempotencyReplayTtlSeconds(),
      /does not declare adcp\.idempotency\.replay_ttl_seconds/
    );
  });

  it('returns undefined on v2 sellers (pre-idempotency-envelope)', async () => {
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = {
      version: 'v2',
      majorVersions: [2],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: true,
    };
    assert.equal(await client.getIdempotencyReplayTtlSeconds(), undefined);
  });
});
