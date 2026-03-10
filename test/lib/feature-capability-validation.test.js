// Tests for issue #304: Feature capability validation (supports/require API)

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  resolveFeature,
  listDeclaredFeatures,
  FeatureUnsupportedError,
  SingleAgentClient,
  ProtocolClient,
} = require('../../dist/lib/index.js');

/**
 * Build a capabilities object for testing.
 * Defaults to a v3 server with media_buy protocol.
 */
function makeCapabilities(overrides = {}) {
  return {
    version: 'v3',
    majorVersions: [2, 3],
    protocols: ['media_buy'],
    features: {
      inlineCreativeManagement: true,
      propertyListFiltering: false,
      contentStandards: false,
      conversionTracking: true,
      audienceManagement: false,
    },
    extensions: ['scope3'],
    _synthetic: false,
    _raw: {
      supported_protocols: ['media_buy'],
      extensions_supported: ['scope3'],
      media_buy: {
        features: {
          inline_creative_management: true,
          conversion_tracking: true,
        },
        execution: {
          targeting: {
            geo_countries: true,
            geo_regions: false,
            device_type: true,
          },
        },
      },
    },
    ...overrides,
  };
}

describe('resolveFeature', () => {
  test('checks supported_protocols for protocol names', () => {
    const caps = makeCapabilities();
    assert.strictEqual(resolveFeature(caps, 'media_buy'), true);
    assert.strictEqual(resolveFeature(caps, 'signals'), false);
  });

  test('checks extensions with ext: prefix', () => {
    const caps = makeCapabilities();
    assert.strictEqual(resolveFeature(caps, 'ext:scope3'), true);
    assert.strictEqual(resolveFeature(caps, 'ext:garm'), false);
  });

  test('checks targeting capabilities with targeting. prefix', () => {
    const caps = makeCapabilities();
    assert.strictEqual(resolveFeature(caps, 'targeting.geo_countries'), true);
    assert.strictEqual(resolveFeature(caps, 'targeting.geo_regions'), false);
    assert.strictEqual(resolveFeature(caps, 'targeting.device_type'), true);
    assert.strictEqual(resolveFeature(caps, 'targeting.language'), false);
  });

  test('checks media_buy.features for known feature names', () => {
    const caps = makeCapabilities();
    assert.strictEqual(resolveFeature(caps, 'inline_creative_management'), true);
    assert.strictEqual(resolveFeature(caps, 'conversion_tracking'), true);
    assert.strictEqual(resolveFeature(caps, 'property_list_filtering'), false);
    assert.strictEqual(resolveFeature(caps, 'content_standards'), false);
  });

  test('returns false for unknown features', () => {
    const caps = makeCapabilities();
    assert.strictEqual(resolveFeature(caps, 'nonexistent_feature'), false);
  });

  test('returns false for targeting when _raw is missing', () => {
    const caps = makeCapabilities({ _raw: undefined });
    assert.strictEqual(resolveFeature(caps, 'targeting.geo_countries'), false);
  });

  test('handles v2 synthetic capabilities (no _raw)', () => {
    const caps = makeCapabilities({
      version: 'v2',
      _synthetic: true,
      _raw: undefined,
      extensions: [],
    });
    assert.strictEqual(resolveFeature(caps, 'media_buy'), true);
    assert.strictEqual(resolveFeature(caps, 'targeting.geo_countries'), false);
    assert.strictEqual(resolveFeature(caps, 'ext:scope3'), false);
  });
});

describe('listDeclaredFeatures', () => {
  test('lists protocols, features, extensions, and targeting', () => {
    const caps = makeCapabilities();
    const features = listDeclaredFeatures(caps);

    assert.ok(features.includes('media_buy'), 'should list protocol');
    assert.ok(features.includes('inline_creative_management'), 'should list media_buy feature');
    assert.ok(features.includes('conversion_tracking'), 'should list conversion_tracking');
    assert.ok(features.includes('ext:scope3'), 'should list extension');
    assert.ok(features.includes('targeting.geo_countries'), 'should list targeting feature');
    assert.ok(features.includes('targeting.device_type'), 'should list targeting.device_type');
    // false features should not be listed
    assert.ok(!features.includes('targeting.geo_regions'), 'should not list false targeting feature');
  });

  test('returns empty-ish list for minimal capabilities', () => {
    const caps = makeCapabilities({
      protocols: [],
      features: {},
      extensions: [],
      _raw: undefined,
    });
    const features = listDeclaredFeatures(caps);
    assert.strictEqual(features.length, 0);
  });
});

describe('FeatureUnsupportedError', () => {
  test('constructs with unsupported and declared features', () => {
    const err = new FeatureUnsupportedError(
      ['audience_targeting', 'ext:garm'],
      ['media_buy', 'inline_creative_management', 'ext:scope3'],
      'https://seller.example.com'
    );

    assert.ok(err instanceof Error, 'should be an Error');
    assert.strictEqual(err.code, 'FEATURE_UNSUPPORTED');
    assert.ok(err.message.includes('audience_targeting'), 'should mention missing feature');
    assert.ok(err.message.includes('ext:garm'), 'should mention missing extension');
    assert.ok(err.message.includes('inline_creative_management'), 'should list declared features');
    assert.ok(err.message.includes('https://seller.example.com'), 'should include agent URL');
  });

  test('handles empty declared features', () => {
    const err = new FeatureUnsupportedError(['signals'], [], 'https://empty.example.com');
    assert.ok(err.message.includes('(none)'), 'should say (none) for empty declared features');
  });
});

describe('SingleAgentClient feature API exists', () => {
  // SingleAgentClient.supports/require/refreshCapabilities are thin async wrappers
  // around resolveFeature/listDeclaredFeatures (tested above). Full integration
  // tests require a live MCP server; mocking the entire endpoint discovery chain
  // would be brittle and mock-heavy. These tests verify the methods are exported.

  test('SingleAgentClient has supports method', () => {
    const client = new SingleAgentClient({
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
    });
    assert.strictEqual(typeof client.supports, 'function');
  });

  test('SingleAgentClient has require method', () => {
    const client = new SingleAgentClient({
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
    });
    assert.strictEqual(typeof client.require, 'function');
  });

  test('SingleAgentClient has refreshCapabilities method', () => {
    const client = new SingleAgentClient({
      id: 'test',
      name: 'Test',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
    });
    assert.strictEqual(typeof client.refreshCapabilities, 'function');
  });
});
