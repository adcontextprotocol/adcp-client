/**
 * v3.0 Compatibility Tests
 *
 * Tests for backward compatibility between v3.0 clients and v2.x servers
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

// Import v3.0 compatibility utilities
const {
  parseCapabilitiesResponse,
  supportsV3,
  supportsProtocol,
  supportsPropertyListFiltering,
  supportsContentStandards,
  supportsSyncCreatives,
  supportsExperimentalFeature,
  requiresOperatorAuth,
  requiresAccountForProducts,
  resolveFeature,
  listDeclaredFeatures,
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  CREATIVE_TOOLS,
} = require('../../dist/lib/utils/capabilities.js');

const {
  usesV2PricingFields,
  usesV3PricingFields,
  isFixedPricing,
  getPrice,
  getFloorPrice,
  normalizePricingOption,
  normalizeProductPricing,
  normalizeGetProductsResponse,
} = require('../../dist/lib/utils/pricing-adapter.js');

const { isCompatibleWith, COMPATIBLE_ADCP_VERSIONS } = require('../../dist/lib/version.js');

// ============================================
// Version Compatibility Tests
// ============================================

describe('Version Compatibility', () => {
  test('should recognize compatible versions', () => {
    assert.strictEqual(isCompatibleWith('v2.5'), false);
    assert.strictEqual(isCompatibleWith('v2.6'), false);
    assert.strictEqual(isCompatibleWith('v3'), true);
  });

  test('should reject incompatible versions', () => {
    assert.strictEqual(isCompatibleWith('v1.0'), false);
    assert.strictEqual(isCompatibleWith('v4.0'), false);
    assert.strictEqual(isCompatibleWith('unknown'), false);
  });

  test('should include expected versions in COMPATIBLE_ADCP_VERSIONS', () => {
    assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('v2.5'));
    assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('v2.6'));
    assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('v3'));
  });
});

describe('parseCapabilitiesResponse', () => {
  test('preserves the release selected for capability discovery', () => {
    const capabilities = parseCapabilitiesResponse({
      adcp_version: '3.1',
      adcp: { major_versions: [3], supported_versions: ['3.0', '3.1', '3.2-beta.5'] },
      supported_protocols: ['media_buy'],
    });

    assert.equal(capabilities.servedVersion, '3.1');
  });

  test('should parse v3 capabilities response', () => {
    // Response format matches the actual AdCP get_adcp_capabilities spec
    const response = {
      adcp: {
        major_versions: [2, 3],
      },
      supported_protocols: ['media_buy', 'signals'],
      media_buy: {
        lifecycle_tools: ['list_products', 'request_proposals', 42],
        features: {
          inline_creative_management: true,
          property_list_filtering: true,
          content_standards: true,
        },
        portfolio: {
          publisher_domains: ['example.com'],
          primary_channels: ['display', 'olv'],
          primary_countries: ['FR'],
          channels: ['legacy-value-must-not-win'],
        },
      },
      extensions_supported: ['scope3'],
      last_updated: '2025-01-01T00:00:00Z',
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.strictEqual(capabilities.version, 'v3');
    assert.ok(capabilities.protocols.includes('media_buy'));
    assert.strictEqual(capabilities.features.inlineCreativeManagement, true);
    assert.strictEqual(capabilities.features.propertyListFiltering, true);
    assert.strictEqual(capabilities.features.contentStandards, true);
    assert.deepStrictEqual(capabilities.mediaBuyLifecycleTools, ['list_products', 'request_proposals']);
    assert.deepStrictEqual(capabilities.extensions, ['scope3']);
    assert.deepStrictEqual(capabilities.publisherDomains, ['example.com']);
    assert.deepStrictEqual(capabilities.channels, ['display', 'olv']);
    assert.deepStrictEqual(capabilities.countries, ['FR']);
    assert.strictEqual(capabilities._synthetic, false);
    assert.strictEqual(capabilities.account, undefined);
  });

  test('preserves the legacy nonstandard portfolio.channels fallback', () => {
    const capabilities = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      media_buy: { portfolio: { channels: ['display'] } },
    });

    assert.deepStrictEqual(capabilities.channels, ['display']);
  });

  test('supportsSyncCreatives follows creative.has_creative_library, not media_buy inline support', () => {
    const libraryCaps = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy', 'creative'],
      media_buy: { features: { inline_creative_management: false } },
      creative: { has_creative_library: true },
      extensions_supported: [],
    });
    const inlineOnlyCaps = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      media_buy: { features: { inline_creative_management: true } },
      creative: { has_creative_library: false },
      extensions_supported: [],
    });

    assert.strictEqual(supportsSyncCreatives(libraryCaps), true);
    assert.strictEqual(supportsSyncCreatives(inlineOnlyCaps), false);
  });

  test('should parse account capabilities when present', () => {
    const response = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      account: {
        require_operator_auth: true,
        authorization_endpoint: 'https://seller.example.com/oauth/authorize',
        supported_billing: ['operator', 'agent'],
        default_billing: 'operator',
        required_for_products: true,
      },
      extensions_supported: [],
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.ok(capabilities.account, 'account capabilities should be present');
    assert.strictEqual(capabilities.account.requireOperatorAuth, true);
    assert.strictEqual(capabilities.account.authorizationEndpoint, 'https://seller.example.com/oauth/authorize');
    assert.deepStrictEqual(capabilities.account.supportedBilling, ['operator', 'agent']);
    assert.strictEqual(capabilities.account.defaultBilling, 'operator');
    assert.strictEqual(capabilities.account.requiredForProducts, true);
  });

  test('should apply account capability defaults when fields are absent', () => {
    const response = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      account: {
        supported_billing: ['brand'],
      },
      extensions_supported: [],
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.ok(capabilities.account);
    assert.strictEqual(capabilities.account.requireOperatorAuth, false);
    assert.strictEqual(capabilities.account.authorizationEndpoint, undefined);
    assert.strictEqual(capabilities.account.defaultBilling, undefined);
    assert.strictEqual(capabilities.account.requiredForProducts, false);
  });

  test('should default supported_billing to empty array when absent', () => {
    const response = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      account: {},
      extensions_supported: [],
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.ok(capabilities.account);
    assert.deepStrictEqual(capabilities.account.supportedBilling, []);
  });

  test('should parse experimental_features from the AdCP 3.0 GA response envelope', () => {
    const response = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy', 'brand'],
      extensions_supported: [],
      experimental_features: ['brand.rights_lifecycle', 'governance.campaign'],
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.deepStrictEqual(capabilities.experimentalFeatures, ['brand.rights_lifecycle', 'governance.campaign']);
  });

  test('experimentalFeatures is undefined when the seller does not declare any', () => {
    const response = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      extensions_supported: [],
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.strictEqual(capabilities.experimentalFeatures, undefined);
  });

  test('experimentalFeatures drops non-string entries rather than throwing on malformed payloads', () => {
    const response = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      extensions_supported: [],
      experimental_features: ['brand.rights_lifecycle', 123, null, 'governance.campaign'],
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.deepStrictEqual(capabilities.experimentalFeatures, ['brand.rights_lifecycle', 'governance.campaign']);
  });
});

describe('supportsExperimentalFeature', () => {
  const caps = parseCapabilitiesResponse({
    adcp: { major_versions: [3] },
    supported_protocols: ['brand'],
    extensions_supported: [],
    experimental_features: ['brand.rights_lifecycle'],
  });

  test('returns true when the seller declared the feature id', () => {
    assert.strictEqual(supportsExperimentalFeature(caps, 'brand.rights_lifecycle'), true);
  });

  test('returns false when the seller did not declare the feature id', () => {
    assert.strictEqual(supportsExperimentalFeature(caps, 'governance.campaign'), false);
  });

  test('returns false when the seller declared no experimental features at all', () => {
    const noneCaps = parseCapabilitiesResponse({
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      extensions_supported: [],
    });
    assert.strictEqual(supportsExperimentalFeature(noneCaps, 'brand.rights_lifecycle'), false);
  });

  test('resolveFeature honors the experimental:<id> namespace', () => {
    assert.strictEqual(resolveFeature(caps, 'experimental:brand.rights_lifecycle'), true);
    assert.strictEqual(resolveFeature(caps, 'experimental:governance.campaign'), false);
  });

  test('listDeclaredFeatures surfaces experimental ids so error messages can cite them', () => {
    assert.ok(listDeclaredFeatures(caps).includes('experimental:brand.rights_lifecycle'));
  });
});

describe('Capability Checks', () => {
  test('supportsV3 should return true for v3', () => {
    const capabilities = { version: 'v3', majorVersions: [3] };
    assert.strictEqual(supportsV3(capabilities), true);
  });

  test('supportsV3 should return false for v2.x', () => {
    const capabilities = { version: 'v2', majorVersions: [2] };
    assert.strictEqual(supportsV3(capabilities), false);
  });

  test('supportsProtocol should check protocol support', () => {
    const capabilities = { protocols: ['media_buy', 'creative'] };
    assert.strictEqual(supportsProtocol(capabilities, 'media_buy'), true);
    assert.strictEqual(supportsProtocol(capabilities, 'signals'), false);
  });

  test('requiresOperatorAuth should return true when set', () => {
    const capabilities = {
      account: { requireOperatorAuth: true, supportedBilling: ['operator'], requiredForProducts: false },
    };
    assert.strictEqual(requiresOperatorAuth(capabilities), true);
  });

  test('requiresOperatorAuth should return false when account is absent', () => {
    const capabilities = { account: undefined };
    assert.strictEqual(requiresOperatorAuth(capabilities), false);
  });

  test('requiresAccountForProducts should return true when set', () => {
    const capabilities = {
      account: { requireOperatorAuth: false, supportedBilling: ['brand'], requiredForProducts: true },
    };
    assert.strictEqual(requiresAccountForProducts(capabilities), true);
  });

  test('requiresAccountForProducts should return false when account is absent', () => {
    const capabilities = { account: undefined };
    assert.strictEqual(requiresAccountForProducts(capabilities), false);
  });
});

// ============================================
// Tool Constants Tests
// ============================================

describe('Tool Constants', () => {
  test('MEDIA_BUY_TOOLS should contain expected tools', () => {
    assert.ok(MEDIA_BUY_TOOLS.includes('get_products'));
    assert.ok(MEDIA_BUY_TOOLS.includes('create_media_buy'));
    assert.ok(MEDIA_BUY_TOOLS.includes('update_media_buy'));
    assert.ok(MEDIA_BUY_TOOLS.includes('sync_creatives'));
    assert.ok(MEDIA_BUY_TOOLS.includes('list_creative_formats'));
    for (const tool of [
      'list_products',
      'request_proposals',
      'refine_proposals',
      'decline_proposals',
      'buy_products',
      'accept_proposal',
      'control_media_buy',
    ]) {
      assert.ok(MEDIA_BUY_TOOLS.includes(tool), `expected media-buy classifier to include ${tool}`);
    }
  });

  test('SIGNALS_TOOLS should contain expected tools', () => {
    assert.ok(SIGNALS_TOOLS.includes('get_signals'));
    assert.ok(SIGNALS_TOOLS.includes('activate_signal'));
  });

  test('CREATIVE_TOOLS should contain expected tools', () => {
    // Creative tools for preview and format discovery
    assert.ok(CREATIVE_TOOLS.includes('preview_creative'));
    assert.ok(CREATIVE_TOOLS.includes('list_creative_formats'));
  });
});

// ============================================
// UnsupportedFeatureError Tests
// ============================================

describe('UnsupportedFeatureError', () => {
  // Import the error class
  const { UnsupportedFeatureError } = require('../../dist/lib/core/SingleAgentClient.js');

  test('should create error with feature and version', () => {
    const error = new UnsupportedFeatureError('property_list', 'v2');

    assert.strictEqual(error.feature, 'property_list');
    assert.strictEqual(error.serverVersion, 'v2');
    assert.strictEqual(error.name, 'UnsupportedFeatureError');
    assert.ok(error.message.includes('property_list'));
    assert.ok(error.message.includes('v2'));
  });

  test('should use custom message when provided', () => {
    const customMessage = 'Custom error message for testing';
    const error = new UnsupportedFeatureError('content_standards', 'v2', customMessage);

    assert.strictEqual(error.message, customMessage);
    assert.strictEqual(error.feature, 'content_standards');
    assert.strictEqual(error.serverVersion, 'v2');
  });

  test('should be instance of Error', () => {
    const error = new UnsupportedFeatureError('property_list_filtering', 'v2');

    assert.ok(error instanceof Error);
  });
});

// ============================================
// Request Parameter Normalization Tests
// ============================================

const { normalizeRequestParams, normalizePackageParams } = require('../../dist/lib/utils/request-normalizer.js');
const { MUTATING_TASKS } = require('../../dist/lib/utils/idempotency.js');

const { resetWarnings } = require('../../dist/lib/utils/deprecation.js');

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('normalizeRequestParams: idempotency_key auto-inject (MUTATING_TASKS coverage)', () => {
  // create_media_buy now requires account; provide a minimal fixture when the
  // task under test is create_media_buy so the iterator doesn't trip the
  // (separately tested) account-required validation.
  const baseParamsFor = task => (task === 'create_media_buy' ? { account: { account_id: 'test-acc' } } : {});

  test('every MUTATING_TASKS member gets a UUID v4 when the caller omits idempotency_key', () => {
    assert.ok(MUTATING_TASKS.size >= 20, `MUTATING_TASKS set looks empty (${MUTATING_TASKS.size})`);
    for (const task of MUTATING_TASKS) {
      const result = normalizeRequestParams(task, baseParamsFor(task));
      assert.match(
        String(result?.idempotency_key),
        UUID_V4_PATTERN,
        `${task}: expected auto-injected UUID v4 idempotency_key, got ${JSON.stringify(result?.idempotency_key)}`
      );
    }
  });

  test('read-only tasks do not receive an auto-injected idempotency_key', () => {
    for (const task of ['get_products', 'get_signals', 'get_media_buys', 'list_accounts', 'list_creatives']) {
      const result = normalizeRequestParams(task, {});
      assert.strictEqual(
        result?.idempotency_key,
        undefined,
        `${task}: read-only task should not auto-inject idempotency_key`
      );
    }
  });

  test('the proposal-finalize get_products variant receives an auto-injected key', () => {
    const result = normalizeRequestParams('get_products', {
      buying_mode: 'refine',
      refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'proposal_1' }],
    });
    assert.match(String(result?.idempotency_key), UUID_V4_PATTERN);
  });

  test('preserves a caller-supplied idempotency_key (BYOK)', () => {
    const result = normalizeRequestParams('create_media_buy', {
      account: { account_id: 'test-acc' },
      idempotency_key: 'byok-1234567890abcdef',
    });
    assert.strictEqual(result?.idempotency_key, 'byok-1234567890abcdef');
  });

  test('treats empty-string idempotency_key as unset and injects a fresh UUID', () => {
    const result = normalizeRequestParams('create_media_buy', {
      account: { account_id: 'test-acc' },
      idempotency_key: '',
    });
    assert.match(String(result?.idempotency_key), UUID_V4_PATTERN);
  });

  test('skipIdempotencyAutoInject=true leaves the field absent so compliance scenarios can exercise missing-key rejection', () => {
    const result = normalizeRequestParams(
      'create_media_buy',
      { account: { account_id: 'test-acc' } },
      { skipIdempotencyAutoInject: true }
    );
    assert.strictEqual(result?.idempotency_key, undefined);
  });
});

describe('Request Parameter Normalization', () => {
  // Reset deprecation warnings before each test so warnOnce fires
  // (node:test doesn't have beforeEach, but we can call inline)

  describe('account_id → account', () => {
    test('should convert bare account_id string to account object', () => {
      resetWarnings();
      const result = normalizeRequestParams('create_media_buy', {
        account_id: 'acct_123',
        buyer_ref: 'buyer-1',
      });

      assert.deepStrictEqual(result.account, { account_id: 'acct_123' });
      assert.strictEqual(result.account_id, undefined);
      assert.strictEqual(result.buyer_ref, 'buyer-1');
    });

    test('should not overwrite existing account field and should remove deprecated account_id', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_media_buys', {
        account_id: 'acct_old',
        account: { account_id: 'acct_new' },
      });

      assert.deepStrictEqual(result.account, { account_id: 'acct_new' });
      assert.strictEqual(result.account_id, undefined, 'deprecated account_id should be removed');
    });

    test('should not convert non-string account_id', () => {
      resetWarnings();
      // Use a non-mutating task here: when account_id is non-string the shim
      // skips and `account` stays undefined, which is fine for read-only tools
      // but would trip the create_media_buy account-required validation.
      const result = normalizeRequestParams('get_media_buys', {
        account_id: 123,
        buyer_ref: 'ref-1',
      });

      assert.strictEqual(result.account, undefined);
    });

    test('should work across all tool types', () => {
      resetWarnings();
      for (const tool of ['get_signals', 'activate_signal', 'sync_creatives', 'sync_audiences']) {
        const result = normalizeRequestParams(tool, { account_id: 'acct_1' });
        assert.deepStrictEqual(result.account, { account_id: 'acct_1' }, `Failed for ${tool}`);
        assert.strictEqual(result.account_id, undefined, `account_id leaked for ${tool}`);
      }
    });
  });

  describe('campaign_ref → buyer_campaign_ref', () => {
    test('should rename campaign_ref to buyer_campaign_ref', () => {
      resetWarnings();
      const result = normalizeRequestParams('create_media_buy', {
        account: { account_id: 'acc-1' },
        campaign_ref: 'camp_Q2',
        buyer_ref: 'buyer-1',
      });

      assert.strictEqual(result.buyer_campaign_ref, 'camp_Q2');
      assert.strictEqual(result.campaign_ref, undefined);
    });

    test('should not overwrite existing buyer_campaign_ref and should remove deprecated campaign_ref', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_signals', {
        campaign_ref: 'old_ref',
        buyer_campaign_ref: 'new_ref',
      });

      assert.strictEqual(result.buyer_campaign_ref, 'new_ref');
      assert.strictEqual(result.campaign_ref, undefined, 'deprecated campaign_ref should be removed');
    });
  });

  describe('deployments → destinations (activate_signal)', () => {
    test('should rename deployments to destinations for activate_signal', () => {
      resetWarnings();
      const deployments = [{ agent_url: 'https://dsp.example.com' }];
      const result = normalizeRequestParams('activate_signal', {
        signal_agent_segment_id: 'sig_1',
        deployments,
      });

      assert.deepStrictEqual(result.destinations, deployments);
      assert.strictEqual(result.deployments, undefined);
    });

    test('should not rename deployments for other tools', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_signals', {
        deployments: [{ agent_url: 'https://dsp.example.com' }],
      });

      // deployments is not a known field for get_signals, but normalizer should not touch it
      // since the shim is scoped to activate_signal
      assert.ok(result.deployments);
      assert.strictEqual(result.destinations, undefined);
    });

    test('should not overwrite existing destinations and should remove deprecated deployments', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        deployments: [{ agent_url: 'https://old.com' }],
        destinations: [{ agent_url: 'https://new.com' }],
      });

      assert.deepStrictEqual(result.destinations, [{ agent_url: 'https://new.com' }]);
      assert.strictEqual(result.deployments, undefined, 'deprecated deployments should be removed');
    });
  });

  describe('signal_id → signal_agent_segment_id (activate_signal)', () => {
    test('should rename signal_id to signal_agent_segment_id', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        signal_id: 'seg_123',
        destinations: [{ platform: 'dv360', account_id: 'acct' }],
      });
      assert.strictEqual(result.signal_agent_segment_id, 'seg_123');
      assert.strictEqual(result.signal_id, undefined);
    });

    test('should not overwrite existing signal_agent_segment_id', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        signal_id: 'old_id',
        signal_agent_segment_id: 'new_id',
        destinations: [{ platform: 'dv360', account_id: 'acct' }],
      });
      assert.strictEqual(result.signal_agent_segment_id, 'new_id');
      assert.strictEqual(result.signal_id, undefined);
    });
  });

  describe('destination (singular) → destinations (array) (activate_signal)', () => {
    test('should wrap singular destination in array', () => {
      resetWarnings();
      const dest = { platform: 'meta', account_id: 'acct' };
      const result = normalizeRequestParams('activate_signal', {
        signal_agent_segment_id: 'seg_1',
        destination: dest,
      });
      assert.deepStrictEqual(result.destinations, [dest]);
      assert.strictEqual(result.destination, undefined);
    });

    test('should not overwrite existing destinations array', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        signal_agent_segment_id: 'seg_1',
        destination: { platform: 'old' },
        destinations: [{ platform: 'new' }],
      });
      assert.deepStrictEqual(result.destinations, [{ platform: 'new' }]);
      assert.strictEqual(result.destination, undefined);
    });
  });

  describe('options removal (activate_signal)', () => {
    test('should strip options field', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        signal_agent_segment_id: 'seg_1',
        destinations: [{ platform: 'dv360' }],
        options: { dry_run: true },
      });
      assert.strictEqual(result.options, undefined);
    });
  });

  describe('activate_signal normalizer scoping', () => {
    test('should not rename signal_id for other tools', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_signals', { signal_id: 'seg_1' });
      assert.strictEqual(result.signal_id, 'seg_1');
      assert.strictEqual(result.signal_agent_segment_id, undefined);
    });

    test('should not strip options for other tools', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', { options: { limit: 10 } });
      assert.deepStrictEqual(result.options, { limit: 10 });
    });
  });

  describe('activate_signal combined normalization', () => {
    test('should normalize all deprecated fields together', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        signal_id: 'seg_1',
        deployments: [{ agent_url: 'https://old.com' }],
        options: { dry_run: true },
      });
      assert.strictEqual(result.signal_agent_segment_id, 'seg_1');
      assert.deepStrictEqual(result.destinations, [{ agent_url: 'https://old.com' }]);
      assert.strictEqual(result.signal_id, undefined);
      assert.strictEqual(result.deployments, undefined);
      assert.strictEqual(result.options, undefined);
    });
  });

  describe('deliver_to → destinations (get_signals)', () => {
    test('should rename deliver_to to destinations for get_signals', () => {
      resetWarnings();
      const deliver_to = [{ agent_url: 'https://dsp.example.com' }];
      const result = normalizeRequestParams('get_signals', {
        signal_spec: 'auto intenders',
        deliver_to,
      });

      assert.deepStrictEqual(result.destinations, deliver_to);
      assert.strictEqual(result.deliver_to, undefined);
    });

    test('should not rename deliver_to for other tools', () => {
      resetWarnings();
      const result = normalizeRequestParams('activate_signal', {
        deliver_to: [{ agent_url: 'https://dsp.example.com' }],
        signal_agent_segment_id: 'sig_1',
        destinations: [{ agent_url: 'https://x.com' }],
      });

      // deliver_to should be untouched for activate_signal
      assert.ok(result.deliver_to);
    });
  });

  describe('removed get_products fields', () => {
    test('should strip feedback, product_ids, and proposal_id with warnings', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        buying_mode: 'wholesale',
        feedback: [{ product_id: 'p-1', rating: 5 }],
        product_ids: ['p-1', 'p-2'],
        proposal_id: 'prop-1',
      });

      assert.strictEqual(result.feedback, undefined);
      assert.strictEqual(result.product_ids, undefined);
      assert.strictEqual(result.proposal_id, undefined);
      assert.strictEqual(result.buying_mode, 'wholesale');
    });

    test('should not strip removed fields for other tools', () => {
      resetWarnings();
      const result = normalizeRequestParams('create_media_buy', {
        account: { account_id: 'acc-1' },
        feedback: 'some_data',
      });

      // feedback is not stripped for non-get_products tools
      assert.strictEqual(result.feedback, 'some_data');
    });
  });

  describe('product_selectors normalization', () => {
    test('should convert product_selectors to catalog for get_products', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        buying_mode: 'wholesale',
        product_selectors: {
          manifest_gtins: ['gtin-1', 'gtin-2'],
          manifest_tags: ['summer'],
        },
      });

      assert.ok(result.catalog, 'catalog should be set');
      assert.strictEqual(result.product_selectors, undefined);
    });

    test('should not overwrite existing catalog with product_selectors', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        buying_mode: 'wholesale',
        catalog: { type: 'offering', items: [{}] },
        product_selectors: { manifest_gtins: ['gtin-1'] },
      });

      assert.strictEqual(result.catalog.type, 'offering');
      assert.strictEqual(result.product_selectors, undefined);
    });
  });

  describe('null/undefined params', () => {
    test('should pass through null params unchanged', () => {
      assert.strictEqual(normalizeRequestParams('get_products', null), null);
    });

    test('should pass through undefined params unchanged', () => {
      assert.strictEqual(normalizeRequestParams('get_products', undefined), undefined);
    });
  });

  describe('combined shims', () => {
    test('should apply account_id + campaign_ref + package shims in a single request', () => {
      resetWarnings();
      const result = normalizeRequestParams('create_media_buy', {
        account_id: 'acct_1',
        campaign_ref: 'camp_Q2',
        buyer_ref: 'buyer-1',
        packages: [
          {
            product_id: 'prod-1',
            optimization_goal: { kind: 'metric', metric: 'clicks' },
            catalog: { type: 'product', gtins: ['gtin-1'] },
            budget: 5000,
          },
        ],
      });

      assert.deepStrictEqual(result.account, { account_id: 'acct_1' });
      assert.strictEqual(result.account_id, undefined);
      assert.strictEqual(result.buyer_campaign_ref, 'camp_Q2');
      assert.strictEqual(result.campaign_ref, undefined);
      assert.deepStrictEqual(result.packages[0].optimization_goals, [{ kind: 'metric', metric: 'clicks' }]);
      assert.strictEqual(result.packages[0].optimization_goal, undefined);
      assert.deepStrictEqual(result.packages[0].catalogs, [{ type: 'product', gtins: ['gtin-1'] }]);
      assert.strictEqual(result.packages[0].catalog, undefined);
    });

    test('should apply brand_manifest + account_id shims together', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        account_id: 'acct_1',
        brand_manifest: 'https://acme.com',
        buying_mode: 'wholesale',
      });

      assert.deepStrictEqual(result.account, { account_id: 'acct_1' });
      assert.deepStrictEqual(result.brand, { domain: 'acme.com' });
      assert.strictEqual(result.account_id, undefined);
      assert.strictEqual(result.brand_manifest, 'https://acme.com');
    });

    test('should derive brand from brand_manifest for create_media_buy', () => {
      resetWarnings();
      const result = normalizeRequestParams('create_media_buy', {
        account: { account_id: 'acc-1' },
        buyer_ref: 'buyer-1',
        brand_manifest: 'https://acme.com',
        packages: [],
      });

      assert.deepStrictEqual(result.brand, { domain: 'acme.com' });
      assert.strictEqual(result.brand_manifest, 'https://acme.com');
    });

    test('should handle brand_manifest as object with url', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        brand_manifest: { name: 'Acme', url: 'https://acme.com' },
        buying_mode: 'wholesale',
      });

      assert.deepStrictEqual(result.brand, { domain: 'acme.com' });
      assert.deepStrictEqual(result.brand_manifest, { name: 'Acme', url: 'https://acme.com' });
    });

    test('should preserve brand_manifest when it has no url', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        brand_manifest: { name: 'Acme' },
        buying_mode: 'wholesale',
      });

      assert.strictEqual(result.brand, undefined);
      assert.deepStrictEqual(result.brand_manifest, { name: 'Acme' });
    });
  });

  describe('account validation (create_media_buy)', () => {
    // The v2 shim that inferred account.operator from brand.domain was removed
    // with the v2 sunset (April 2026). create_media_buy now requires account
    // explicitly; the normalizer throws ValidationError when it is missing.
    const { ADCPValidationError } = require('../../dist/lib/index.js');

    test('should throw ValidationError when account is missing', () => {
      resetWarnings();
      assert.throws(
        () =>
          normalizeRequestParams('create_media_buy', {
            buyer_ref: 'buyer-1',
            brand: { name: 'Acme', domain: 'acme.com' },
            packages: [],
          }),
        err => {
          assert.ok(err instanceof ADCPValidationError, `expected ADCPValidationError, got ${err.constructor.name}`);
          assert.ok(err.message.includes('account'), 'error message should mention account');
          return true;
        }
      );
    });

    test('should not overwrite existing account', () => {
      resetWarnings();
      const result = normalizeRequestParams('create_media_buy', {
        buyer_ref: 'buyer-1',
        account: { account_id: 'acct_existing' },
        brand: { name: 'Acme', domain: 'acme.com' },
        packages: [],
      });

      assert.deepStrictEqual(result.account, { account_id: 'acct_existing' });
    });

    test('should throw ValidationError when both account and brand are missing', () => {
      resetWarnings();
      assert.throws(
        () =>
          normalizeRequestParams('create_media_buy', {
            buyer_ref: 'buyer-1',
            packages: [],
          }),
        err => {
          assert.ok(err instanceof ADCPValidationError, `expected ADCPValidationError, got ${err.constructor.name}`);
          return true;
        }
      );
    });

    test('should not require account for other task types', () => {
      resetWarnings();
      const result = normalizeRequestParams('get_products', {
        brand: { name: 'Acme', domain: 'acme.com' },
        buying_mode: 'wholesale',
      });

      assert.strictEqual(result.account, undefined);
    });

    test('should throw when account is missing even if brand has no domain', () => {
      resetWarnings();
      assert.throws(
        () =>
          normalizeRequestParams('create_media_buy', {
            buyer_ref: 'buyer-1',
            brand: { name: 'Acme' },
            packages: [],
          }),
        err => {
          assert.ok(err instanceof ADCPValidationError, `expected ADCPValidationError, got ${err.constructor.name}`);
          return true;
        }
      );
    });

    test('should throw when account is missing even if brand_manifest is provided', () => {
      resetWarnings();
      // Regression: previously this branch fabricated account.operator from
      // brand_manifest URL. The shim is gone; the call must throw.
      assert.throws(
        () =>
          normalizeRequestParams('create_media_buy', {
            buyer_ref: 'buyer-1',
            brand_manifest: 'https://acme.com',
            packages: [],
          }),
        err => {
          assert.ok(err instanceof ADCPValidationError, `expected ADCPValidationError, got ${err.constructor.name}`);
          return true;
        }
      );
    });
  });
});

describe('Package Parameter Normalization', () => {
  test('should convert optimization_goal scalar to optimization_goals array', () => {
    resetWarnings();
    const result = normalizePackageParams({
      product_id: 'prod-1',
      optimization_goal: { kind: 'metric', metric: 'ctr' },
      budget: 5000,
    });

    assert.deepStrictEqual(result.optimization_goals, [{ kind: 'metric', metric: 'ctr' }]);
    assert.strictEqual(result.optimization_goal, undefined);
    assert.strictEqual(result.budget, 5000);
  });

  test('should not overwrite existing optimization_goals', () => {
    resetWarnings();
    const goals = [
      { kind: 'metric', metric: 'clicks' },
      { kind: 'metric', metric: 'conversions' },
    ];
    const result = normalizePackageParams({
      optimization_goal: { kind: 'metric', metric: 'ctr' },
      optimization_goals: goals,
    });

    assert.deepStrictEqual(result.optimization_goals, goals);
  });

  test('should convert catalog scalar to catalogs array', () => {
    resetWarnings();
    const catalog = { type: 'product', gtins: ['gtin-1', 'gtin-2'] };
    const result = normalizePackageParams({
      package_id: 'pkg-1',
      catalog,
    });

    assert.deepStrictEqual(result.catalogs, [catalog]);
    assert.strictEqual(result.catalog, undefined);
  });

  test('should not overwrite existing catalogs', () => {
    resetWarnings();
    const catalogs = [
      { type: 'product', gtins: ['gtin-1'] },
      { type: 'offering', items: [{}] },
    ];
    const result = normalizePackageParams({
      catalog: { type: 'store', ids: ['s-1'] },
      catalogs,
    });

    assert.deepStrictEqual(result.catalogs, catalogs);
  });

  test('should pass through null/non-object values', () => {
    assert.strictEqual(normalizePackageParams(null), null);
    assert.strictEqual(normalizePackageParams(undefined), undefined);
    assert.strictEqual(normalizePackageParams(42), 42);
  });

  test('should NOT copy context.buyer_ref to top-level buyer_ref (v3 field removed)', () => {
    // The AdCP 3.0 package schema removed top-level buyer_ref; strict v3
    // receivers reject it as an unknown field. The v2.5 adapter in
    // creative-adapter.ts derives it for legacy servers only.
    const result = normalizePackageParams({
      product_id: 'prod-1',
      budget: 5000,
      pricing_option_id: 'po-1',
      context: { buyer_ref: 'br-123' },
    });
    assert.strictEqual(result.buyer_ref, undefined);
    assert.strictEqual(result.context.buyer_ref, 'br-123');
  });

  test('should preserve a caller-supplied top-level buyer_ref (still legal on v2)', () => {
    // The normalizer must not strip a top-level buyer_ref the caller set
    // themselves — the field is v2.5-legal and the v2 adapter reads it as
    // the highest-priority derivation source.
    const result = normalizePackageParams({
      product_id: 'prod-1',
      buyer_ref: 'existing-ref',
      context: { buyer_ref: 'context-ref' },
    });
    assert.strictEqual(result.buyer_ref, 'existing-ref');
  });

  test('should not set buyer_ref when context has no buyer_ref', () => {
    const result = normalizePackageParams({
      product_id: 'prod-1',
      context: { trace_id: 'abc' },
    });
    assert.strictEqual(result.buyer_ref, undefined);
  });
});

describe('Request-level context.buyer_ref → buyer_ref (create_media_buy)', () => {
  test('should NOT copy request-level context.buyer_ref to top-level buyer_ref (v3 field removed)', () => {
    resetWarnings();
    const result = normalizeRequestParams('create_media_buy', {
      account: { account_id: 'acc-1' },
      brand: { domain: 'example.com' },
      context: { buyer_ref: 'br-request-123' },
    });
    assert.strictEqual(result.buyer_ref, undefined);
    assert.strictEqual(result.context.buyer_ref, 'br-request-123');
  });

  test('should preserve a caller-supplied top-level buyer_ref (legal on v2)', () => {
    resetWarnings();
    const result = normalizeRequestParams('create_media_buy', {
      buyer_ref: 'existing-ref',
      account: { account_id: 'acc-1' },
      brand: { domain: 'example.com' },
      context: { buyer_ref: 'context-ref' },
    });
    assert.strictEqual(result.buyer_ref, 'existing-ref');
  });

  test('should not set buyer_ref when neither top-level nor context supplies one', () => {
    resetWarnings();
    const result = normalizeRequestParams('create_media_buy', {
      account: { account_id: 'acc-1' },
      brand: { domain: 'example.com' },
      context: { trace_id: 'abc' },
    });
    assert.strictEqual(result.buyer_ref, undefined);
  });

  test('should NOT copy context.buyer_ref to top-level buyer_ref for update_media_buy', () => {
    resetWarnings();
    const result = normalizeRequestParams('update_media_buy', {
      media_buy_id: 'mb-1',
      context: { buyer_ref: 'br-update-123' },
    });
    assert.strictEqual(result.buyer_ref, undefined);
  });
});

// ============================================
// New Type Shape Validation Tests
// ============================================

const {
  DurationSchema,
  FrequencyCapSchema,
  ProvenanceSchema,
  DeviceTypeSchema,
  DigitalSourceTypeSchema,
} = require('../../dist/lib/types/schemas.generated.js');

describe('Duration type construction', () => {
  test('should accept valid Duration with minutes', () => {
    const result = DurationSchema.safeParse({ interval: 60, unit: 'minutes' });
    assert.strictEqual(result.success, true);
  });

  test('should accept valid Duration with campaign unit', () => {
    const result = DurationSchema.safeParse({ interval: 1, unit: 'campaign' });
    assert.strictEqual(result.success, true);
  });

  test('should reject Duration with invalid unit', () => {
    const result = DurationSchema.safeParse({ interval: 7, unit: 'weeks' });
    assert.strictEqual(result.success, false);
  });

  test('should reject Duration without interval', () => {
    const result = DurationSchema.safeParse({ unit: 'days' });
    assert.strictEqual(result.success, false);
  });
});

describe('FrequencyCap type construction', () => {
  test('should accept recency-gate mode (suppress only)', () => {
    const result = FrequencyCapSchema.safeParse({
      suppress: { interval: 60, unit: 'minutes' },
    });
    assert.strictEqual(result.success, true);
  });

  test('should accept volumetric-cap mode (max_impressions + per + window)', () => {
    const result = FrequencyCapSchema.safeParse({
      max_impressions: 3,
      per: 'individuals',
      window: { interval: 7, unit: 'days' },
    });
    assert.strictEqual(result.success, true);
  });

  test('should accept both modes combined', () => {
    const result = FrequencyCapSchema.safeParse({
      suppress: { interval: 30, unit: 'minutes' },
      max_impressions: 5,
      per: 'households',
      window: { interval: 1, unit: 'campaign' },
    });
    assert.strictEqual(result.success, true);
  });

  test('should accept legacy suppress_minutes', () => {
    const result = FrequencyCapSchema.safeParse({
      suppress_minutes: 60,
    });
    assert.strictEqual(result.success, true);
  });
});

describe('Provenance type construction', () => {
  test('should accept full provenance object', () => {
    const result = ProvenanceSchema.safeParse({
      digital_source_type: 'trained_algorithmic_media',
      ai_tool: { name: 'Claude', version: '4', provider: 'Anthropic' },
      human_oversight: 'directed',
    });
    assert.strictEqual(result.success, true);
  });

  test('should accept minimal provenance', () => {
    const result = ProvenanceSchema.safeParse({});
    assert.strictEqual(result.success, true);
  });

  test('should reject invalid digital_source_type', () => {
    const result = DigitalSourceTypeSchema.safeParse('photoshop_filter');
    assert.strictEqual(result.success, false);
  });
});

describe('DeviceType type validation', () => {
  test('should accept all valid device types', () => {
    for (const dt of ['desktop', 'mobile', 'tablet', 'ctv', 'dooh', 'unknown']) {
      const result = DeviceTypeSchema.safeParse(dt);
      assert.strictEqual(result.success, true, `Failed for ${dt}`);
    }
  });

  test('should reject invalid device type', () => {
    const result = DeviceTypeSchema.safeParse('smartwatch');
    assert.strictEqual(result.success, false);
  });
});

// ── Standard Error Codes ──

const { STANDARD_ERROR_CODES, isStandardErrorCode, getErrorRecovery } = require('../../dist/lib/types/error-codes.js');

const { ErrorSchema } = require('../../dist/lib/types/schemas.generated.js');
const { ErrorCodeValues } = require('../../dist/lib/types/enums.generated.js');
const { FORWARD_COMPAT_ERROR_CODES } = require('../../dist/lib/types/forward-compat-error-codes.js');

describe('Standard Error Codes', () => {
  test('STANDARD_ERROR_CODES enumerates every code in the spec enum + forward-compat overlay', () => {
    // Drift guard — STANDARD_ERROR_CODES = manifest ∪ overlay. Adding codes
    // to error-code.json (or the overlay) fails this test until they get
    // description+recovery rows. The companion test in
    // standard-error-codes-drift.test.js is the authoritative drift guard.
    const expected = ErrorCodeValues.length + Object.keys(FORWARD_COMPAT_ERROR_CODES).length;
    assert.strictEqual(Object.keys(STANDARD_ERROR_CODES).length, expected);
  });

  test('includes the idempotency codes added in AdCP v3 (PR #2315)', () => {
    assert.ok(STANDARD_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    assert.ok(STANDARD_ERROR_CODES.IDEMPOTENCY_EXPIRED);
  });

  test('includes ACTION_NOT_ALLOWED as a standard AdCP 3.1 code', () => {
    assert.ok(STANDARD_ERROR_CODES.ACTION_NOT_ALLOWED);
    assert.strictEqual(STANDARD_ERROR_CODES.ACTION_NOT_ALLOWED.recovery, 'correctable');
    assert.strictEqual(isStandardErrorCode('ACTION_NOT_ALLOWED'), true);
  });

  test('every code has description and recovery', () => {
    for (const [code, info] of Object.entries(STANDARD_ERROR_CODES)) {
      assert.ok(info.description, `${code} missing description`);
      assert.ok(
        ['transient', 'correctable', 'terminal'].includes(info.recovery),
        `${code} has invalid recovery: ${info.recovery}`
      );
    }
  });

  test('transient codes are retry-appropriate', () => {
    const transientCodes = Object.entries(STANDARD_ERROR_CODES)
      .filter(([, info]) => info.recovery === 'transient')
      .map(([code]) => code);
    assert.ok(transientCodes.includes('RATE_LIMITED'));
    assert.ok(transientCodes.includes('SERVICE_UNAVAILABLE'));
    // Spec moved CONFLICT to transient (concurrent-modification retry).
    assert.ok(transientCodes.includes('CONFLICT'));
    // GOVERNANCE_UNAVAILABLE / CAMPAIGN_SUSPENDED are also transient (added in AdCP 3.0).
    assert.ok(transientCodes.includes('GOVERNANCE_UNAVAILABLE'));
    assert.ok(transientCodes.includes('CAMPAIGN_SUSPENDED'));
  });

  test('terminal codes require human intervention', () => {
    const terminalCodes = Object.entries(STANDARD_ERROR_CODES)
      .filter(([, info]) => info.recovery === 'terminal')
      .map(([code]) => code);
    assert.ok(terminalCodes.includes('ACCOUNT_SUSPENDED'));
    assert.ok(terminalCodes.includes('ACCOUNT_PAYMENT_REQUIRED'));
    assert.ok(terminalCodes.includes('ACCOUNT_NOT_FOUND'));
    assert.ok(terminalCodes.includes('BUDGET_EXHAUSTED'));
  });

  test('isStandardErrorCode returns true for known codes', () => {
    assert.strictEqual(isStandardErrorCode('RATE_LIMITED'), true);
    assert.strictEqual(isStandardErrorCode('BUDGET_EXHAUSTED'), true);
    assert.strictEqual(isStandardErrorCode('CONFLICT'), true);
    assert.strictEqual(isStandardErrorCode('ACTION_NOT_ALLOWED'), true);
  });

  test('isStandardErrorCode returns false for custom codes', () => {
    assert.strictEqual(isStandardErrorCode('CUSTOM_VENDOR_ERROR'), false);
    assert.strictEqual(isStandardErrorCode(''), false);
  });

  test('getErrorRecovery returns correct recovery for known codes', () => {
    assert.strictEqual(getErrorRecovery('RATE_LIMITED'), 'transient');
    assert.strictEqual(getErrorRecovery('INVALID_REQUEST'), 'correctable');
    assert.strictEqual(getErrorRecovery('ACTION_NOT_ALLOWED'), 'correctable');
    assert.strictEqual(getErrorRecovery('ACCOUNT_SUSPENDED'), 'terminal');
  });

  test('getErrorRecovery returns undefined for unknown codes', () => {
    assert.strictEqual(getErrorRecovery('CUSTOM_VENDOR_ERROR'), undefined);
  });

  test('Error schema validates standard error with recovery', () => {
    const error = {
      code: 'RATE_LIMITED',
      message: 'Too many requests',
      recovery: 'transient',
      retry_after: 30,
    };
    const result = ErrorSchema.safeParse(error);
    assert.strictEqual(result.success, true);
  });

  test('Error schema validates error with field and suggestion', () => {
    const error = {
      code: 'BUDGET_TOO_LOW',
      message: 'Budget below minimum',
      field: 'packages[0].budget',
      suggestion: 'Increase budget to at least $500',
      recovery: 'correctable',
    };
    const result = ErrorSchema.safeParse(error);
    assert.strictEqual(result.success, true);
  });
});
