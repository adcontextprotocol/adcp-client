// F16 — buildCreative discriminated return shape (single | multi).
// Adopters can return CreativeManifest, CreativeManifest[], OR a fully
// shaped BuildCreativeSuccess / BuildCreativeMultiSuccess envelope. The
// projector inspects the return shape and wraps appropriately, so
// multi-format storyboards (target_format_ids: [...]) get
// `{ creative_manifests: [...] }` instead of being double-wrapped.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform(buildCreativeImpl) {
  return {
    capabilities: {
      specialisms: ['creative-template'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
    },
    creative: {
      buildCreative: buildCreativeImpl,
    },
  };
}

const ARGS_BASE = {
  account: { account_id: 'acc_1' },
  creative_manifest: { assets: [] },
};

async function dispatch(server, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'build_creative', arguments: args },
  });
}

function buildServer(impl) {
  return createAdcpServerFromPlatform(basePlatform(impl), {
    name: 'build-creative-host',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });
}

describe('F16: buildCreative discriminated return — single shape', () => {
  it('plain CreativeManifest gets wrapped as { creative_manifest: <obj> }', async () => {
    const server = buildServer(async () => ({
      manifest_id: 'mf_1',
      assets: [{ asset_id: 'a1', asset_type: 'image' }],
    }));
    const result = await dispatch(server, {
      ...ARGS_BASE,
      target_format_id: { id: 'standard', agent_url: 'https://example.com/mcp' },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(result.structuredContent.creative_manifest, 'creative_manifest present');
    assert.strictEqual(result.structuredContent.creative_manifest.manifest_id, 'mf_1');
    // Not double-wrapped:
    assert.strictEqual(result.structuredContent.creative_manifest.creative_manifest, undefined);
  });

  it('fully-shaped BuildCreativeSuccess passes through with sandbox/expires_at/preview', async () => {
    const server = buildServer(async () => ({
      creative_manifest: { manifest_id: 'mf_1', assets: [] },
      sandbox: true,
      expires_at: '2026-12-31T00:00:00Z',
    }));
    const result = await dispatch(server, {
      ...ARGS_BASE,
      target_format_id: { id: 'standard', agent_url: 'https://example.com/mcp' },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.creative_manifest.manifest_id, 'mf_1');
    // Adopter-set metadata preserved:
    assert.strictEqual(result.structuredContent.sandbox, true);
    assert.strictEqual(result.structuredContent.expires_at, '2026-12-31T00:00:00Z');
    // Not re-wrapped:
    assert.strictEqual(result.structuredContent.creative_manifest.creative_manifest, undefined);
  });
});

describe('F16: buildCreative discriminated return — multi shape', () => {
  it('CreativeManifest[] gets wrapped as { creative_manifests: <array> }', async () => {
    const server = buildServer(async () => [
      { manifest_id: 'mf_300x250', assets: [] },
      { manifest_id: 'mf_728x90', assets: [] },
    ]);
    const result = await dispatch(server, {
      ...ARGS_BASE,
      target_format_ids: [
        { id: 'standard_300x250', agent_url: 'https://example.com/mcp' },
        { id: 'standard_728x90', agent_url: 'https://example.com/mcp' },
      ],
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(Array.isArray(result.structuredContent.creative_manifests));
    assert.strictEqual(result.structuredContent.creative_manifests.length, 2);
    assert.strictEqual(result.structuredContent.creative_manifests[0].manifest_id, 'mf_300x250');
    // NOT double-wrapped (the bug F16 closes — projector previously
    // wrapped the array itself as { creative_manifest: [array] }
    // which fails Multi schema validation).
    assert.strictEqual(result.structuredContent.creative_manifest, undefined);
  });

  it('fully-shaped BuildCreativeMultiSuccess passes through with metadata', async () => {
    const server = buildServer(async () => ({
      creative_manifests: [
        { manifest_id: 'mf_a', assets: [] },
        { manifest_id: 'mf_b', assets: [] },
      ],
      sandbox: true,
      expires_at: '2026-12-31T00:00:00Z',
    }));
    const result = await dispatch(server, {
      ...ARGS_BASE,
      target_format_ids: [
        { id: 'a', agent_url: 'https://example.com/mcp' },
        { id: 'b', agent_url: 'https://example.com/mcp' },
      ],
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.creative_manifests.length, 2);
    assert.strictEqual(result.structuredContent.sandbox, true);
    assert.strictEqual(result.structuredContent.expires_at, '2026-12-31T00:00:00Z');
    // No double-wrapping:
    assert.strictEqual(result.structuredContent.creative_manifest, undefined);
  });

  it('empty array still produces { creative_manifests: [] } (not single-wrapped)', async () => {
    // Adopter contract violation, but the projector's array-detection
    // shouldn't depend on length — empty array stays multi-shaped.
    const server = buildServer(async () => []);
    const result = await dispatch(server, {
      ...ARGS_BASE,
      target_format_ids: [{ id: 'a', agent_url: 'https://example.com/mcp' }],
    });
    assert.notStrictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent.creative_manifests, []);
  });
});
