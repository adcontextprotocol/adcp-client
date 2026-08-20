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
      adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
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

  it('rejects replay windows outside the protocol 1h-7d integer range', () => {
    for (const replay_ttl_seconds of [0, 3599, 604801, 86400.5, '86400']) {
      assert.throws(
        () =>
          parseCapabilitiesResponse({
            adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds } },
          }),
        error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'adcp.idempotency.replay_ttl_seconds'
      );
    }
  });

  it('rejects contradictory or discriminator-free replay declarations', () => {
    for (const idempotency of [
      { supported: false, replay_ttl_seconds: 86400 },
      { replay_ttl_seconds: 86400 },
      { supported: true },
    ]) {
      assert.throws(
        () => parseCapabilitiesResponse({ adcp: { major_versions: [3], idempotency } }),
        error => error.code === 'CONFIGURATION_ERROR'
      );
    }
    const unsupported = parseCapabilitiesResponse({
      adcp: { major_versions: [3], idempotency: { supported: false } },
    });
    assert.equal(unsupported.idempotency, undefined);
  });

  it('does not downgrade a contradictory v3 recovery payload to synthetic capabilities', async () => {
    const client = new SingleAgentClient(stubAgent);
    client.getAgentInfo = async () => ({
      name: 'contradictory seller',
      tools: [{ name: 'get_adcp_capabilities' }],
    });
    client.ensureEndpointDiscovered = async () => stubAgent;
    client.executor.executeTask = async () => ({
      success: false,
      status: 'failed',
      data: {
        adcp: {
          major_versions: [3],
          idempotency: { supported: false, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
      },
      error: 'schema-invalid capabilities response',
      metadata: {},
    });

    await assert.rejects(
      () => client.getCapabilities(),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'adcp.idempotency.replay_ttl_seconds'
    );
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

  it('rejects an invalid normalized replay window instead of trusting it', async () => {
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {},
      idempotency: { replayTtlSeconds: 3599 },
      extensions: [],
      _synthetic: false,
    };
    await assert.rejects(
      () => client.getIdempotencyReplayTtlSeconds(),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'adcp.idempotency.replay_ttl_seconds'
    );
  });
});
