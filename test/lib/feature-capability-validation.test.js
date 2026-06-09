// Tests for issue #304: Feature capability validation (supports/require API)

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseCapabilitiesResponse,
  resolveFeature,
  supportsContentStandards,
  listDeclaredFeatures,
  FeatureUnsupportedError,
  ProtocolFeatureUnsupportedError,
  getClientPreflightAdcpError,
  mapSdkErrorCodeToProtocolErrorCode,
  SingleAgentClient,
  ProtocolClient,
  TASK_FEATURE_MAP,
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
      audienceTargeting: false,
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

function makeClientWithCapabilities(capabilities) {
  const client = new SingleAgentClient({
    id: 'test',
    name: 'Test',
    agent_uri: 'https://seller.example.com/mcp',
    protocol: 'mcp',
  });
  client.getCapabilities = async () => capabilities;
  return client;
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

  test('treats content-standards specialism as content_standards support', () => {
    const caps = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['governance'],
      specialisms: ['content-standards'],
      media_buy: { features: { content_standards: false } },
      extensions_supported: [],
    });

    assert.strictEqual(caps.features.contentStandards, true);
    assert.strictEqual(resolveFeature(caps, 'governance'), true);
    assert.strictEqual(resolveFeature(caps, 'content_standards'), true);
  });

  test('treats hand-built content-standards specialism as content_standards support', () => {
    const caps = makeCapabilities({
      protocols: ['governance'],
      specialisms: ['content-standards'],
      features: {
        inlineCreativeManagement: false,
        propertyListFiltering: false,
        contentStandards: false,
        conversionTracking: false,
        audienceTargeting: false,
      },
    });

    assert.strictEqual(supportsContentStandards(caps), true);
    assert.strictEqual(resolveFeature(caps, 'content_standards'), true);
    assert.ok(listDeclaredFeatures(caps).includes('content_standards'));
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

  test('lists declared specialisms for feature-gate diagnostics', () => {
    const caps = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['governance'],
      specialisms: ['content-standards', 'property-lists'],
      extensions_supported: [],
    });
    const features = listDeclaredFeatures(caps);

    assert.ok(features.includes('governance'), 'should list protocol');
    assert.ok(features.includes('content_standards'), 'should list resolved internal content standards feature');
    assert.ok(features.includes('specialism:content-standards'), 'should list public content standards specialism');
    assert.ok(features.includes('specialism:property-lists'), 'should list other public specialisms');
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
    assert.deepStrictEqual(err.details.unsupported_features, ['audience_targeting', 'ext:garm']);
    assert.deepStrictEqual(err.details.declared_features, ['media_buy', 'inline_creative_management', 'ext:scope3']);
    assert.ok(err.message.includes('audience_targeting'), 'should mention missing feature');
    assert.ok(err.message.includes('ext:garm'), 'should mention missing extension');
    assert.ok(err.message.includes('inline_creative_management'), 'should list declared features');
    assert.ok(err.message.includes('https://seller.example.com'), 'should include agent URL');
  });

  test('handles empty declared features', () => {
    const err = new FeatureUnsupportedError(['signals'], [], 'https://empty.example.com');
    assert.ok(err.message.includes('(none)'), 'should say (none) for empty declared features');
  });

  test('keeps legacy SDK code separate from protocol error code mapping', () => {
    const err = new FeatureUnsupportedError(['signals'], [], 'https://seller.example.com');

    assert.strictEqual(err.code, 'FEATURE_UNSUPPORTED');
    assert.strictEqual(mapSdkErrorCodeToProtocolErrorCode(err.code), 'UNSUPPORTED_FEATURE');
    assert.strictEqual(getClientPreflightAdcpError(err), undefined);
  });

  test('ProtocolFeatureUnsupportedError exposes protocol-shaped preflight metadata', () => {
    const err = new ProtocolFeatureUnsupportedError(['signals.wholesale'], [], 'https://seller.example.com', {
      message: 'Wholesale signals require AdCP 3.1 or later',
      field: 'discovery_mode',
      suggestion: 'Probe get_adcp_capabilities before retrying.',
      details: {
        required_version: '3.1',
        capability_path: 'signals.discovery_modes',
      },
    });

    assert.ok(err instanceof FeatureUnsupportedError);
    assert.strictEqual(err.code, 'UNSUPPORTED_FEATURE');
    assert.deepStrictEqual(getClientPreflightAdcpError(err), {
      code: 'UNSUPPORTED_FEATURE',
      message: 'Wholesale signals require AdCP 3.1 or later',
      recovery: 'correctable',
      field: 'discovery_mode',
      suggestion: 'Probe get_adcp_capabilities before retrying.',
      details: {
        unsupported_features: ['signals.wholesale'],
        declared_features: [],
        required_version: '3.1',
        capability_path: 'signals.discovery_modes',
      },
    });
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

describe('SingleAgentClient feature gate', () => {
  test('allows content standards tasks for governance + content-standards specialism', async () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['governance'],
      specialisms: ['content-standards'],
      extensions_supported: [],
    });
    const client = makeClientWithCapabilities(capabilities);

    await assert.doesNotReject(() => client.require('governance', 'content_standards'));
  });

  test('content-standards specialism does not bypass missing governance protocol', async () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: [],
      specialisms: ['content-standards'],
      extensions_supported: [],
    });
    const client = makeClientWithCapabilities(capabilities);

    await assert.rejects(
      () => client.require('governance', 'content_standards'),
      err => {
        assert.ok(err instanceof FeatureUnsupportedError);
        assert.ok(err.message.includes('governance'));
        assert.ok(err.message.includes('content_standards'));
        assert.ok(err.message.includes('specialism:content-standards'));
        return true;
      }
    );
  });
});

describe('TASK_FEATURE_MAP', () => {
  test('maps core media buy tasks to media_buy protocol', () => {
    for (const task of ['get_products', 'create_media_buy', 'update_media_buy', 'get_media_buys']) {
      assert.ok(TASK_FEATURE_MAP[task], `${task} should be in TASK_FEATURE_MAP`);
      assert.ok(TASK_FEATURE_MAP[task].includes('media_buy'), `${task} should require media_buy`);
    }
  });

  test('maps sync_audiences to audience_targeting', () => {
    assert.ok(TASK_FEATURE_MAP.sync_audiences.includes('audience_targeting'));
    assert.ok(TASK_FEATURE_MAP.sync_audiences.includes('media_buy'));
  });

  test('maps sync_catalogs to media_buy', () => {
    assert.ok(TASK_FEATURE_MAP.sync_catalogs.includes('media_buy'));
  });

  test('maps event tracking tasks to conversion_tracking', () => {
    for (const task of ['sync_event_sources', 'log_event']) {
      assert.ok(TASK_FEATURE_MAP[task].includes('conversion_tracking'), `${task} should require conversion_tracking`);
    }
  });

  test('maps dual-domain creative tasks correctly', () => {
    // sync_creatives, list_creatives, and list_creative_formats are intentionally
    // omitted from TASK_FEATURE_MAP because they serve both media-buy and creative domains
    assert.strictEqual(
      TASK_FEATURE_MAP.sync_creatives,
      undefined,
      'sync_creatives should not be in TASK_FEATURE_MAP (dual-domain)'
    );
    assert.strictEqual(
      TASK_FEATURE_MAP.list_creatives,
      undefined,
      'list_creatives should not be in TASK_FEATURE_MAP (dual-domain)'
    );
    assert.strictEqual(
      TASK_FEATURE_MAP.list_creative_formats,
      undefined,
      'list_creative_formats should not be in TASK_FEATURE_MAP (dual-domain)'
    );
  });

  test('maps creative-only tasks to creative protocol', () => {
    for (const task of ['build_creative', 'list_transformers', 'preview_creative']) {
      assert.ok(TASK_FEATURE_MAP[task].includes('creative'), `${task} should require creative`);
    }
  });

  test('maps signals tasks to signals protocol', () => {
    for (const task of ['get_signals', 'activate_signal']) {
      assert.ok(TASK_FEATURE_MAP[task].includes('signals'), `${task} should require signals`);
    }
  });

  test('maps governance tasks to governance protocol', () => {
    for (const task of ['create_property_list', 'get_property_list']) {
      assert.ok(TASK_FEATURE_MAP[task].includes('governance'), `${task} should require governance`);
    }
  });

  test('maps content standards tasks to governance + content_standards', () => {
    for (const task of ['list_content_standards', 'calibrate_content']) {
      assert.ok(TASK_FEATURE_MAP[task].includes('governance'), `${task} should require governance`);
      assert.ok(TASK_FEATURE_MAP[task].includes('content_standards'), `${task} should require content_standards`);
    }
  });

  test('maps brand tasks to brand protocol', () => {
    for (const task of ['get_brand_identity', 'search_brands', 'get_rights', 'acquire_rights', 'update_rights']) {
      assert.ok(TASK_FEATURE_MAP[task].includes('brand'), `${task} should require brand`);
    }
  });

  test('does not map get_adcp_capabilities (meta task)', () => {
    assert.strictEqual(TASK_FEATURE_MAP.get_adcp_capabilities, undefined);
  });
});
