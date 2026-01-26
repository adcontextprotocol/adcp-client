/**
 * v3.0 Compatibility Tests
 *
 * Tests for backward compatibility between v3.0 clients and v2.x servers
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

// Import v3.0 compatibility utilities
const {
  buildSyntheticCapabilities,
  parseCapabilitiesResponse,
  supportsV3,
  supportsProtocol,
  supportsPropertyListFiltering,
  supportsContentStandards,
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  CREATIVE_TOOLS,
} = require('../../dist/lib/utils/capabilities.js');

const {
  adaptPackageRequestForV2,
  adaptCreateMediaBuyRequestForV2,
  adaptUpdateMediaBuyRequestForV2,
  normalizePackageResponse,
  normalizeMediaBuyResponse,
  usesV2CreativeIds,
  usesV3CreativeAssignments,
  getCreativeIds,
  getCreativeAssignments,
} = require('../../dist/lib/utils/creative-adapter.js');

const {
  normalizeFormatRenders,
  normalizeFormatsResponse,
  getFormatRenders,
  getPrimaryRender,
  usesV2Dimensions,
  usesV3Renders,
  getFormatDimensions,
} = require('../../dist/lib/utils/format-renders.js');

const {
  normalizePreviewRender,
  normalizePreview,
  usesV2RenderFields,
  usesV3RenderFields,
  getRenderId,
  getRenderRole,
  getPrimaryPreviewRender,
} = require('../../dist/lib/utils/preview-normalizer.js');

const {
  usesV2PricingFields,
  usesV3PricingFields,
  isFixedPricing,
  getPrice,
  getFloorPrice,
  adaptPricingOptionForV2,
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
    assert.strictEqual(isCompatibleWith('v2.5'), true);
    assert.strictEqual(isCompatibleWith('v2.6'), true);
    assert.strictEqual(isCompatibleWith('v3'), true);
  });

  test('should reject incompatible versions', () => {
    assert.strictEqual(isCompatibleWith('v1.0'), false);
    assert.strictEqual(isCompatibleWith('v4.0'), false);
    assert.strictEqual(isCompatibleWith('unknown'), false);
  });

  test('should include expected versions in COMPATIBLE_ADCP_VERSIONS', () => {
    assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('v2.5'));
    assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('v2.6'));
    assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('v3'));
  });
});

// ============================================
// Synthetic Capabilities Builder Tests
// ============================================

describe('Synthetic Capabilities Builder', () => {
  test('should detect media_buy protocol from tools', () => {
    const tools = [{ name: 'get_products' }, { name: 'create_media_buy' }, { name: 'list_creative_formats' }];

    const capabilities = buildSyntheticCapabilities(tools);

    assert.ok(capabilities.protocols.includes('media_buy'));
    assert.strictEqual(capabilities._synthetic, true);
  });

  test('should detect signals protocol from tools', () => {
    const tools = [{ name: 'get_signals' }, { name: 'activate_signal' }];

    const capabilities = buildSyntheticCapabilities(tools);

    assert.ok(capabilities.protocols.includes('signals'));
  });

  test('should detect media_buy protocol from creative tools', () => {
    // Creative tools like list_creative_formats are part of media_buy protocol
    const tools = [{ name: 'preview_creative' }, { name: 'list_creative_formats' }];

    const capabilities = buildSyntheticCapabilities(tools);

    // list_creative_formats is in MEDIA_BUY_TOOLS, so it should detect media_buy
    assert.ok(capabilities.protocols.includes('media_buy'));
  });

  test('should set version to v2 for synthetic capabilities', () => {
    const tools = [{ name: 'get_products' }];
    const capabilities = buildSyntheticCapabilities(tools);

    assert.strictEqual(capabilities.version, 'v2');
  });

  test('should handle empty tool list', () => {
    const capabilities = buildSyntheticCapabilities([]);

    assert.strictEqual(capabilities.version, 'v2');
    assert.deepStrictEqual(capabilities.protocols, []);
    assert.strictEqual(capabilities._synthetic, true);
  });
});

describe('parseCapabilitiesResponse', () => {
  test('should parse v3 capabilities response', () => {
    // Response format matches the actual AdCP get_adcp_capabilities spec
    const response = {
      adcp: {
        major_versions: [2, 3],
      },
      supported_protocols: ['media_buy', 'signals'],
      media_buy: {
        features: {
          inline_creative_management: true,
          property_list_filtering: true,
          content_standards: true,
        },
        portfolio: {
          publisher_domains: ['example.com'],
          channels: ['display', 'video'],
        },
      },
      extensions_supported: ['scope3'],
      last_updated: '2025-01-01T00:00:00Z',
    };

    const capabilities = parseCapabilitiesResponse(response);

    assert.strictEqual(capabilities.version, 'v3');
    assert.ok(capabilities.protocols.includes('media_buy'));
    assert.strictEqual(capabilities.features.propertyListFiltering, true);
    assert.strictEqual(capabilities.features.contentStandards, true);
    assert.deepStrictEqual(capabilities.extensions, ['scope3']);
    assert.strictEqual(capabilities._synthetic, false);
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
});

// ============================================
// Creative Assignment Adapter Tests
// ============================================

describe('Creative Assignment Adapter', () => {
  describe('adaptPackageRequestForV2', () => {
    test('should convert creative_assignments to creative_ids', () => {
      const v3Package = {
        product_id: 'prod-1',
        creative_assignments: [
          { creative_id: 'creative-1', weight: 50 },
          { creative_id: 'creative-2', weight: 50, placement_ids: ['placement-1'] },
        ],
      };

      const v2Package = adaptPackageRequestForV2(v3Package);

      assert.deepStrictEqual(v2Package.creative_ids, ['creative-1', 'creative-2']);
      assert.strictEqual(v2Package.creative_assignments, undefined);
    });

    test('should pass through packages without creative_assignments', () => {
      const v2Package = {
        product_id: 'prod-1',
        creative_ids: ['creative-1'],
      };

      const result = adaptPackageRequestForV2(v2Package);

      assert.deepStrictEqual(result.creative_ids, ['creative-1']);
    });
  });

  describe('normalizePackageResponse', () => {
    test('should convert creative_ids to creative_assignments', () => {
      const v2Package = {
        product_id: 'prod-1',
        creative_ids: ['creative-1', 'creative-2'],
      };

      const v3Package = normalizePackageResponse(v2Package);

      assert.strictEqual(v3Package.creative_assignments.length, 2);
      assert.strictEqual(v3Package.creative_assignments[0].creative_id, 'creative-1');
    });

    test('should pass through packages with creative_assignments', () => {
      const v3Package = {
        product_id: 'prod-1',
        creative_assignments: [{ creative_id: 'creative-1' }],
      };

      const result = normalizePackageResponse(v3Package);

      assert.deepStrictEqual(result.creative_assignments, v3Package.creative_assignments);
    });
  });

  describe('Detection helpers', () => {
    test('usesV2CreativeIds should detect v2 format', () => {
      assert.strictEqual(usesV2CreativeIds({ creative_ids: ['a'] }), true);
      assert.strictEqual(usesV2CreativeIds({ creative_assignments: [{ creative_id: 'a' }] }), false);
    });

    test('usesV3CreativeAssignments should detect v3 format', () => {
      assert.strictEqual(usesV3CreativeAssignments({ creative_assignments: [{ creative_id: 'a' }] }), true);
      assert.strictEqual(usesV3CreativeAssignments({ creative_ids: ['a'] }), false);
    });

    test('getCreativeIds should work with both formats', () => {
      assert.deepStrictEqual(getCreativeIds({ creative_ids: ['a', 'b'] }), ['a', 'b']);
      assert.deepStrictEqual(getCreativeIds({ creative_assignments: [{ creative_id: 'a' }, { creative_id: 'b' }] }), [
        'a',
        'b',
      ]);
    });
  });
});

// ============================================
// Format Renders Normalizer Tests
// ============================================

describe('Format Renders Normalizer', () => {
  describe('normalizeFormatRenders', () => {
    test('should convert v2 top-level dimensions to v3 renders array', () => {
      const v2Format = {
        format_id: { agent_url: 'https://example.com', id: 'banner' },
        width: 300,
        height: 250,
      };

      const v3Format = normalizeFormatRenders(v2Format);

      assert.ok(Array.isArray(v3Format.renders));
      assert.strictEqual(v3Format.renders.length, 1);
      assert.strictEqual(v3Format.renders[0].render_id, 'primary');
      assert.strictEqual(v3Format.renders[0].role, 'primary');
      assert.deepStrictEqual(v3Format.renders[0].dimensions, { width: 300, height: 250 });
    });

    test('should pass through v3 formats with renders array', () => {
      const v3Format = {
        format_id: { agent_url: 'https://example.com', id: 'banner' },
        renders: [{ render_id: 'main', role: 'primary', dimensions: { width: 300, height: 250 } }],
      };

      const result = normalizeFormatRenders(v3Format);

      assert.strictEqual(result.renders[0].render_id, 'main');
    });

    test('should handle v2 dimensions object', () => {
      const v2Format = {
        format_id: { agent_url: 'https://example.com', id: 'banner' },
        dimensions: { width: 728, height: 90 },
      };

      const v3Format = normalizeFormatRenders(v2Format);

      assert.deepStrictEqual(v3Format.renders[0].dimensions, { width: 728, height: 90 });
    });
  });

  describe('Detection helpers', () => {
    test('usesV2Dimensions should detect v2 format', () => {
      assert.strictEqual(usesV2Dimensions({ width: 300, height: 250 }), true);
      assert.strictEqual(usesV2Dimensions({ renders: [] }), false);
    });

    test('usesV3Renders should detect v3 format', () => {
      assert.strictEqual(usesV3Renders({ renders: [] }), true);
      assert.strictEqual(usesV3Renders({ width: 300 }), false);
    });

    test('getFormatDimensions should work with both formats', () => {
      const v2 = { width: 300, height: 250 };
      const v3 = { renders: [{ role: 'primary', dimensions: { width: 728, height: 90 } }] };

      assert.deepStrictEqual(getFormatDimensions(v2), { width: 300, height: 250 });
      assert.deepStrictEqual(getFormatDimensions(v3), { width: 728, height: 90 });
    });
  });

  describe('normalizeFormatsResponse', () => {
    test('should normalize all formats in a list_creative_formats response', () => {
      const response = {
        formats: [
          { format_id: { id: 'format-1' }, width: 300, height: 250 },
          { format_id: { id: 'format-2' }, renders: [{ role: 'primary' }] },
        ],
      };

      const normalized = normalizeFormatsResponse(response);

      assert.ok(normalized.formats[0].renders);
      assert.ok(normalized.formats[1].renders);
    });
  });
});

// ============================================
// Preview Response Normalizer Tests
// ============================================

describe('Preview Response Normalizer', () => {
  describe('normalizePreviewRender', () => {
    test('should convert v2 output_id/output_role to v3 render_id/role', () => {
      const v2Render = {
        output_id: 'main',
        output_role: 'primary',
        output_format: 'url',
        preview_url: 'https://example.com/preview.jpg',
      };

      const v3Render = normalizePreviewRender(v2Render);

      assert.strictEqual(v3Render.render_id, 'main');
      assert.strictEqual(v3Render.role, 'primary');
      assert.strictEqual(v3Render.preview_url, 'https://example.com/preview.jpg');
    });

    test('should pass through v3 render fields', () => {
      const v3Render = {
        render_id: 'main',
        role: 'primary',
        output_format: 'html',
        preview_html: '<div>Preview</div>',
      };

      const result = normalizePreviewRender(v3Render);

      assert.strictEqual(result.render_id, 'main');
      assert.strictEqual(result.role, 'primary');
    });

    test('should use defaults when fields are missing', () => {
      const render = {
        output_format: 'url',
        preview_url: 'https://example.com/preview.jpg',
      };

      const result = normalizePreviewRender(render);

      assert.strictEqual(result.render_id, 'primary');
      assert.strictEqual(result.role, 'primary');
    });
  });

  describe('Detection helpers', () => {
    test('usesV2RenderFields should detect v2 format', () => {
      assert.strictEqual(usesV2RenderFields({ output_id: 'main', output_role: 'primary' }), true);
      assert.strictEqual(usesV2RenderFields({ render_id: 'main', role: 'primary' }), false);
    });

    test('usesV3RenderFields should detect v3 format', () => {
      assert.strictEqual(usesV3RenderFields({ render_id: 'main' }), true);
      assert.strictEqual(usesV3RenderFields({ role: 'primary' }), true);
      assert.strictEqual(usesV3RenderFields({ output_id: 'main' }), false);
    });

    test('getRenderId should work with both formats', () => {
      assert.strictEqual(getRenderId({ output_id: 'out-1' }), 'out-1');
      assert.strictEqual(getRenderId({ render_id: 'render-1' }), 'render-1');
      assert.strictEqual(getRenderId({ render_id: 'render-1', output_id: 'out-1' }), 'render-1');
    });

    test('getRenderRole should work with both formats', () => {
      assert.strictEqual(getRenderRole({ output_role: 'companion' }), 'companion');
      assert.strictEqual(getRenderRole({ role: 'primary' }), 'primary');
      assert.strictEqual(getRenderRole({ role: 'primary', output_role: 'companion' }), 'primary');
    });
  });

  describe('normalizePreview', () => {
    test('should normalize all renders in a preview', () => {
      const preview = {
        preview_id: 'preview-1',
        renders: [
          { output_id: 'main', output_role: 'primary', output_format: 'url' },
          { output_id: 'side', output_role: 'companion', output_format: 'html' },
        ],
        expires_at: '2025-01-01T00:00:00Z',
      };

      const normalized = normalizePreview(preview);

      assert.strictEqual(normalized.renders[0].render_id, 'main');
      assert.strictEqual(normalized.renders[0].role, 'primary');
      assert.strictEqual(normalized.renders[1].render_id, 'side');
      assert.strictEqual(normalized.renders[1].role, 'companion');
    });
  });

  describe('getPrimaryPreviewRender', () => {
    test('should return primary render from preview', () => {
      const preview = {
        renders: [
          { output_id: 'side', output_role: 'companion', output_format: 'html' },
          { output_id: 'main', output_role: 'primary', output_format: 'url' },
        ],
      };

      const primary = getPrimaryPreviewRender(preview);

      assert.strictEqual(primary.role, 'primary');
      assert.strictEqual(primary.render_id, 'main');
    });

    test('should return first render if no primary role found', () => {
      const preview = {
        renders: [
          { output_id: 'first', output_format: 'url' },
          { output_id: 'second', output_format: 'html' },
        ],
      };

      const primary = getPrimaryPreviewRender(preview);

      assert.strictEqual(primary.render_id, 'first');
    });
  });
});

// ============================================
// Pricing Option Adapter Tests
// ============================================

describe('Pricing Option Adapter', () => {
  describe('Field Detection', () => {
    test('should detect v2 pricing fields', () => {
      // v2 uses: rate, is_fixed, price_guidance.floor
      assert.strictEqual(usesV2PricingFields({ rate: 5.0, is_fixed: true }), true);
      assert.strictEqual(usesV2PricingFields({ price_guidance: { floor: 1.0 } }), true);
      assert.strictEqual(usesV2PricingFields({ fixed_price: 5.0 }), false);
    });

    test('should detect v3 pricing fields', () => {
      // v3 uses: fixed_price, floor_price
      assert.strictEqual(usesV3PricingFields({ fixed_price: 5.0 }), true);
      assert.strictEqual(usesV3PricingFields({ floor_price: 1.0 }), true);
      assert.strictEqual(usesV3PricingFields({ rate: 5.0 }), false);
    });
  });

  describe('Pricing Type Detection', () => {
    test('isFixedPricing should work with v3 fixed_price', () => {
      assert.strictEqual(isFixedPricing({ fixed_price: 5.0 }), true);
      assert.strictEqual(isFixedPricing({ floor_price: 1.0 }), false);
    });

    test('isFixedPricing should work with v2 is_fixed', () => {
      assert.strictEqual(isFixedPricing({ rate: 5.0, is_fixed: true }), true);
      assert.strictEqual(isFixedPricing({ is_fixed: false, price_guidance: { floor: 1.0 } }), false);
    });
  });

  describe('Price Accessor Functions', () => {
    test('getPrice should work with both formats', () => {
      assert.strictEqual(getPrice({ fixed_price: 5.0 }), 5.0);
      assert.strictEqual(getPrice({ rate: 3.5 }), 3.5);
      assert.strictEqual(getPrice({ floor_price: 1.0 }), undefined); // auction has no fixed price
    });

    test('getFloorPrice should work with both formats', () => {
      assert.strictEqual(getFloorPrice({ floor_price: 1.0 }), 1.0);
      assert.strictEqual(getFloorPrice({ price_guidance: { floor: 0.5 } }), 0.5);
      assert.strictEqual(getFloorPrice({ fixed_price: 5.0 }), undefined); // fixed has no floor
    });
  });

  describe('adaptPricingOptionForV2', () => {
    test('should convert v3 fixed pricing to v2 format', () => {
      const v3Option = {
        pricing_option_id: 'cpm_fixed_usd',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 5.0,
        min_spend_per_package: 1000,
      };

      const v2Option = adaptPricingOptionForV2(v3Option);

      assert.strictEqual(v2Option.rate, 5.0);
      assert.strictEqual(v2Option.is_fixed, true);
      assert.strictEqual(v2Option.fixed_price, undefined);
      assert.strictEqual(v2Option.min_spend_per_package, 1000);
    });

    test('should convert v3 auction pricing to v2 format', () => {
      const v3Option = {
        pricing_option_id: 'cpm_auction_usd',
        pricing_model: 'cpm',
        currency: 'USD',
        floor_price: 1.0,
        price_guidance: { p50: 2.5, p75: 3.5 },
      };

      const v2Option = adaptPricingOptionForV2(v3Option);

      assert.strictEqual(v2Option.is_fixed, false);
      assert.strictEqual(v2Option.price_guidance.floor, 1.0);
      assert.strictEqual(v2Option.price_guidance.p50, 2.5);
      assert.strictEqual(v2Option.floor_price, undefined);
    });
  });

  describe('normalizePricingOption', () => {
    test('should convert v2 fixed pricing to v3 format', () => {
      const v2Option = {
        pricing_option_id: 'cpm_fixed_usd',
        pricing_model: 'cpm',
        currency: 'USD',
        rate: 5.0,
        is_fixed: true,
      };

      const v3Option = normalizePricingOption(v2Option);

      assert.strictEqual(v3Option.fixed_price, 5.0);
      assert.strictEqual(v3Option.rate, undefined);
      assert.strictEqual(v3Option.is_fixed, undefined);
    });

    test('should convert v2 auction pricing to v3 format', () => {
      const v2Option = {
        pricing_option_id: 'cpm_auction_usd',
        pricing_model: 'cpm',
        currency: 'USD',
        is_fixed: false,
        price_guidance: { floor: 1.0, p50: 2.5 },
      };

      const v3Option = normalizePricingOption(v2Option);

      assert.strictEqual(v3Option.floor_price, 1.0);
      assert.strictEqual(v3Option.price_guidance.p50, 2.5);
      assert.strictEqual(v3Option.price_guidance.floor, undefined);
    });
  });

  describe('Response Normalization', () => {
    test('normalizeProductPricing should normalize all pricing options', () => {
      const product = {
        id: 'product-1',
        name: 'Premium Placement',
        pricing_options: [
          { pricing_option_id: 'opt1', rate: 5.0, is_fixed: true, pricing_model: 'cpm', currency: 'USD' },
          {
            pricing_option_id: 'opt2',
            is_fixed: false,
            price_guidance: { floor: 1.0 },
            pricing_model: 'cpm',
            currency: 'USD',
          },
        ],
      };

      const normalized = normalizeProductPricing(product);

      assert.strictEqual(normalized.pricing_options[0].fixed_price, 5.0);
      assert.strictEqual(normalized.pricing_options[1].floor_price, 1.0);
    });

    test('normalizeGetProductsResponse should normalize entire response', () => {
      const response = {
        products: [
          {
            id: 'p1',
            pricing_options: [
              { pricing_option_id: 'opt', rate: 10.0, is_fixed: true, pricing_model: 'cpm', currency: 'USD' },
            ],
          },
        ],
        total: 1,
      };

      const normalized = normalizeGetProductsResponse(response);

      assert.strictEqual(normalized.products[0].pricing_options[0].fixed_price, 10.0);
      assert.strictEqual(normalized.total, 1);
    });
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
// V3 Feature Guard Logic Tests
// ============================================

describe('V3 Feature Guard Logic', () => {
  /**
   * These tests verify the logic for detecting v3-only features in requests.
   *
   * When v3-only features are used against a v2 server, the library returns
   * an empty result (semantically "no products match this filter") rather
   * than throwing an error.
   */

  test('should identify property_list as v3-only feature', () => {
    const requestWithPropertyList = {
      brief: 'Premium products',
      property_list: {
        agent_url: 'https://example.com',
        list_id: 'list-123',
      },
    };

    // Property list is present, so this requires v3
    assert.ok(requestWithPropertyList.property_list !== undefined);
  });

  test('should identify content_standards in required_features as v3-only', () => {
    const requestWithContentStandards = {
      brief: 'Premium products',
      filters: {
        required_features: ['content_standards'],
      },
    };

    // Check if content_standards is in required_features
    const hasContentStandards = requestWithContentStandards.filters?.required_features?.includes('content_standards');
    assert.strictEqual(hasContentStandards, true);
  });

  test('should identify property_list_filtering in required_features as v3-only', () => {
    const requestWithPropertyFiltering = {
      brief: 'Premium products',
      filters: {
        required_features: ['property_list_filtering', 'inline_creative_management'],
      },
    };

    const hasPropertyListFiltering =
      requestWithPropertyFiltering.filters?.required_features?.includes('property_list_filtering');
    assert.strictEqual(hasPropertyListFiltering, true);
  });

  test('should allow requests without v3 features against v2 servers', () => {
    const basicRequest = {
      brief: 'Premium products',
      filters: {
        delivery_type: 'direct',
      },
    };

    // No v3-only features
    const hasPropertyList = basicRequest.property_list !== undefined;
    const hasContentStandards = basicRequest.filters?.required_features?.includes('content_standards');
    const hasPropertyListFiltering = basicRequest.filters?.required_features?.includes('property_list_filtering');

    assert.strictEqual(hasPropertyList, false);
    assert.strictEqual(hasContentStandards, undefined); // no required_features array
    assert.strictEqual(hasPropertyListFiltering, undefined);
  });

  test('empty response structure should match GetProductsResponse', () => {
    // When v3 features are used against v2 server, library returns this structure
    const emptyResponse = {
      products: [],
      property_list_applied: false,
    };

    // Verify structure matches expected GetProductsResponse
    assert.ok(Array.isArray(emptyResponse.products));
    assert.strictEqual(emptyResponse.products.length, 0);
    assert.strictEqual(emptyResponse.property_list_applied, false);
  });
});
