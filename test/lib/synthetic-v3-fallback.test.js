/**
 * Synthetic v3 fallback — issue #1217.
 *
 * When an agent advertises `get_adcp_capabilities` (a v3-only tool) but the
 * call fails (throws OR returns non-success with no v3-shaped data), the
 * client now treats the agent as v3 (synthetic) instead of falling back to
 * v2. The v3-only tool is verifiable evidence that the agent is v3 — falling
 * to v2 would trigger v2.5-schema lookups that obscure the original failure.
 *
 * Composes with #1201 / #1189: that PR handles the case where a non-success
 * response IS structurally v3-shaped (parse anyway). This issue covers the
 * remaining cases — empty data, throws, non-v3-shaped data.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { buildSyntheticV3Capabilities, buildSyntheticCapabilities } = require('../../dist/lib/utils/capabilities.js');
const { VersionUnsupportedError } = require('../../dist/lib/errors/index.js');

const stubAgent = {
  id: 'a1',
  name: 'stub',
  protocol: 'mcp',
  agent_uri: 'https://stub.example/mcp',
};

describe('buildSyntheticV3Capabilities', () => {
  it('emits version=v3 + majorVersions=[3] + _synthetic=true', () => {
    const caps = buildSyntheticV3Capabilities([{ name: 'sync_creatives' }]);
    assert.equal(caps.version, 'v3');
    assert.deepEqual(caps.majorVersions, [3]);
    assert.equal(caps._synthetic, true);
  });

  it('detects features from tool list (sync_creatives → inlineCreativeManagement)', () => {
    const caps = buildSyntheticV3Capabilities([{ name: 'sync_creatives' }]);
    assert.equal(caps.features.inlineCreativeManagement, true);
  });

  it('detects features from tool list (sync_audiences → audienceTargeting)', () => {
    const caps = buildSyntheticV3Capabilities([{ name: 'sync_audiences' }]);
    assert.equal(caps.features.audienceTargeting, true);
  });

  it('keeps v3-only feature flags conservative when undeclared', () => {
    const caps = buildSyntheticV3Capabilities([]);
    // We can't read details from get_adcp_capabilities, so v3-only features
    // we couldn't observe stay false. This is the same shape as v2 synthetic
    // — only `version` / `majorVersions` differ.
    assert.equal(caps.features.propertyListFiltering, false);
    assert.equal(caps.features.contentStandards, false);
  });
});

describe('SingleAgentClient.requireSupportedMajor with synthetic capabilities (issue #1217)', () => {
  it('does NOT throw VersionUnsupportedError on synthetic v3 capabilities', async () => {
    // The agent had `get_adcp_capabilities` in its tool list but the call
    // failed. We synthesized v3 caps from the tool list — version-compat
    // must accept them since the v3-only discovery tool is affirmative
    // evidence the agent is v3.
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = buildSyntheticV3Capabilities([{ name: 'get_adcp_capabilities' }]);

    await client.requireSupportedMajor('test');
    // No throw = pass.
  });

  it('still throws VersionUnsupportedError on synthetic v2 capabilities (no v3 tool present)', async () => {
    // No get_adcp_capabilities in tool list → agent is verifiably v2 →
    // version-compat throws (preserves pre-#1217 safety behavior).
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = buildSyntheticCapabilities([{ name: 'list_signals' }]);

    await assert.rejects(() => client.requireSupportedMajor('test'), VersionUnsupportedError);
  });

  it('skips idempotency-TTL check on synthetic v3 (TTL is unknowable until caps endpoint is fixed)', async () => {
    // Synthetic v3 caps have no `idempotency` block — we couldn't read the
    // TTL from get_adcp_capabilities. The check must skip rather than throw,
    // since the spec requires v3 to support idempotency (we know it's there,
    // we just can't confirm the TTL).
    const client = new SingleAgentClient(stubAgent);
    const caps = buildSyntheticV3Capabilities([{ name: 'get_adcp_capabilities' }]);
    assert.equal(caps.idempotency, undefined, 'precondition: synthetic v3 has no idempotency block');
    client.cachedCapabilities = caps;

    await client.requireSupportedMajor('test');
    // No throw = pass.
  });

  it('still throws VersionUnsupportedError on real v3 caps missing replayTtlSeconds (non-synthetic)', async () => {
    // A real v3 agent that advertises caps but somehow omits idempotency TTL
    // — that's a wire-shape bug worth surfacing loudly, not silently passing.
    // The synthetic-v3 escape hatch is gated on _synthetic === true.
    const client = new SingleAgentClient(stubAgent);
    client.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: false,
    };

    await assert.rejects(() => client.requireSupportedMajor('test'), VersionUnsupportedError);
  });
});
