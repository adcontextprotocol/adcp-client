const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  applyBrandAssetMappings,
  checkLogoSlotCoverage,
  extractBrandWebsiteAliasDomains,
  extractBrandWebsiteAliases,
  selectLogoForSlot,
  updateBrandJsonFromMappings,
  validateBrandAssetMappings,
} = require('../../dist/lib/brand/index.js');

describe('brand asset mapping helpers', () => {
  test('validates approved mappings against candidate asset ids', () => {
    const result = validateBrandAssetMappings({
      candidates: [{ asset_id: 'candidate_logo_0001' }],
      mappings: [
        {
          asset_id: 'candidate_logo_0001',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: { id: 'primary_horizontal' },
        },
      ],
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.approvedMappings.length, 1);
  });

  test('reports mappings that do not point at extracted candidates', () => {
    const result = validateBrandAssetMappings({
      candidates: [{ asset_id: 'candidate_logo_0001' }],
      mappings: [
        {
          asset_id: 'missing_logo',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: { id: 'primary_horizontal' },
        },
      ],
    });

    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0].message, /does not match/);
  });

  test('allows direct URL mappings when no candidate list is supplied', () => {
    const result = validateBrandAssetMappings({
      mappings: [
        {
          asset_id: 'hosted_logo',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: { id: 'primary_horizontal', url: 'https://assets.example/acme/logo.svg' },
        },
      ],
    });

    assert.strictEqual(result.valid, true);
  });

  test('applies approved logo mappings without mutating the input brand json', () => {
    const brandJson = { domain: 'acme.example', name: 'Acme' };
    const result = applyBrandAssetMappings(brandJson, {
      candidates: [
        {
          asset_id: 'candidate_logo_0001',
          asset_group_id: 'logo',
          url: 'https://assets.example/acme/logo.svg',
          width: 640,
          height: 220,
        },
      ],
      mappings: [
        {
          asset_id: 'candidate_logo_0001',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: {
            id: 'primary_horizontal',
            variant: 'primary',
            background: 'light-bg',
            slots: ['logo_card_light', 'marketplace_listing'],
          },
        },
      ],
    });

    assert.strictEqual(brandJson.logos, undefined);
    assert.strictEqual(result.appliedMappings.length, 1);
    assert.deepStrictEqual(result.skippedMappings, []);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.brandJson.logos[0].id, 'primary_horizontal');
    assert.strictEqual(result.brandJson.logos[0].url, 'https://assets.example/acme/logo.svg');
    assert.strictEqual(result.brandJson.logos[0].width, 640);
  });

  test('selects logos by rendering slot and checks required slot coverage', () => {
    const brandJson = {
      logos: [
        {
          id: 'primary_horizontal',
          url: 'https://assets.example/acme/logo.svg',
          background: 'light-bg',
          variant: 'primary',
          slots: ['logo_card_light', 'marketplace_listing'],
        },
        {
          id: 'knockout_horizontal',
          url: 'https://assets.example/acme/logo-knockout.svg',
          background: 'dark-bg',
          variant: 'secondary',
          slots: ['logo_card_dark', 'ad_end_card'],
        },
      ],
    };

    const logo = selectLogoForSlot(brandJson, {
      requestedSlot: 'logo_card_dark',
      background: 'dark-bg',
      preferredVariant: 'secondary',
    });
    const coverage = checkLogoSlotCoverage(brandJson, ['logo_card_light', 'logo_card_dark', 'nav_header']);

    assert.strictEqual(logo.id, 'knockout_horizontal');
    assert.deepStrictEqual(coverage.present, ['logo_card_light', 'logo_card_dark']);
    assert.deepStrictEqual(coverage.missing, ['nav_header']);
  });

  test('falls back to protocol logo fields when slots are absent', () => {
    const brandJson = {
      logos: [
        {
          id: 'primary_horizontal',
          url: 'https://assets.example/acme/logo.svg',
          orientation: 'horizontal',
          background: 'light-bg',
          variant: 'primary',
        },
      ],
    };

    const logo = selectLogoForSlot(brandJson, {
      requestedSlot: 'logo_card_light',
      background: 'light-bg',
    });
    const coverage = checkLogoSlotCoverage(brandJson, ['logo_card_light', 'nav_header', 'logo_card_dark']);

    assert.strictEqual(logo.id, 'primary_horizontal');
    assert.deepStrictEqual(coverage.present, ['logo_card_light', 'nav_header']);
    assert.deepStrictEqual(coverage.missing, ['logo_card_dark']);
  });

  test('updates the requested brand in a house brand json', () => {
    const result = applyBrandAssetMappings(
      {
        house: { domain: 'house.example' },
        brands: [
          { id: 'spark', name: 'Spark', logos: [] },
          { id: 'bolt', name: 'Bolt', logos: [] },
        ],
      },
      {
        brandId: 'spark',
        assetsBaseUrl: 'https://assets.example/brand-assets///',
        candidates: [{ asset_id: 'candidate_logo_0002', file: 'spark/logo.png' }],
        mappings: [
          {
            asset_id: 'candidate_logo_0002',
            target: 'logos[]',
            review_status: 'approved',
            proposed_logo: { id: 'spark_primary', slots: ['logo_card_light'] },
          },
        ],
      }
    );

    assert.strictEqual(result.brandJson.brands[0].logos[0].url, 'https://assets.example/brand-assets/spark/logo.png');
    assert.deepStrictEqual(result.brandJson.brands[1].logos, []);

    const logo = selectLogoForSlot(result.brandJson, { brandId: 'spark', requestedSlot: 'logo_card_light' });
    const coverage = checkLogoSlotCoverage(result.brandJson, ['logo_card_light', 'logo_card_dark'], {
      brandId: 'spark',
    });

    assert.strictEqual(logo.id, 'spark_primary');
    assert.deepStrictEqual(coverage.present, ['logo_card_light']);
    assert.deepStrictEqual(coverage.missing, ['logo_card_dark']);
  });

  test('fails closed on redirect and agent-only brand json variants', async () => {
    const mappingOptions = {
      candidates: [{ asset_id: 'candidate_logo_0001', url: 'https://assets.example/acme/logo.svg' }],
      mappings: [
        {
          asset_id: 'candidate_logo_0001',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: { id: 'primary_horizontal', slots: ['logo_card_light'] },
        },
      ],
    };
    const redirectResult = applyBrandAssetMappings({ house: 'house.example', note: 'Redirect' }, mappingOptions);
    const agentOnlyResult = applyBrandAssetMappings(
      { agents: [{ type: 'brand', url: 'https://agent.example.com', id: 'brand_agent' }] },
      mappingOptions
    );

    assert.match(redirectResult.errors[0].message, /not editable/);
    assert.strictEqual(redirectResult.brandJson.logos, undefined);
    assert.match(agentOnlyResult.errors[0].message, /not editable/);

    let saveCalled = false;
    const updateResult = await updateBrandJsonFromMappings({
      registryClient: {
        async getBrandJson() {
          return { authoritative_location: 'https://cdn.example.com/brand.json' };
        },
        async saveBrand() {
          saveCalled = true;
          return { success: true, message: 'saved' };
        },
      },
      domain: 'acme.example',
      ...mappingOptions,
    });

    assert.strictEqual(updateResult.saved, false);
    assert.strictEqual(saveCalled, false);
    assert.match(updateResult.errors[0].message, /not editable/);
  });

  test('can fetch, update, and save a brand json through the registry client', async () => {
    let savedPayload;
    const registryClient = {
      async getBrandJson(domain) {
        assert.strictEqual(domain, 'acme.example');
        return { domain, name: 'Acme', logos: [] };
      },
      async saveBrand(payload) {
        savedPayload = payload;
        return { success: true, message: 'saved', domain: payload.domain, id: 'brand_123' };
      },
    };

    const result = await updateBrandJsonFromMappings({
      registryClient,
      domain: 'acme.example',
      candidates: [{ asset_id: 'candidate_logo_0001', url: 'https://assets.example/acme/logo.svg' }],
      mappings: [
        {
          asset_id: 'candidate_logo_0001',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: { id: 'primary_horizontal', slots: ['logo_card_light'] },
        },
      ],
    });

    assert.strictEqual(result.saved, true);
    assert.strictEqual(savedPayload.domain, 'acme.example');
    assert.strictEqual(savedPayload.brand_name, 'Acme');
    assert.strictEqual(savedPayload.brand_manifest.logos[0].id, 'primary_horizontal');
  });

  test('infers registry brand_name from localized names when saving a brand entry', async () => {
    let savedPayload;
    const registryClient = {
      async getBrandJson() {
        throw new Error('existingBrandJson should be used');
      },
      async saveBrand(payload) {
        savedPayload = payload;
        return { success: true, message: 'saved', domain: payload.domain, id: 'brand_456' };
      },
    };

    const result = await updateBrandJsonFromMappings({
      registryClient,
      domain: 'house.example',
      brandId: 'spark',
      existingBrandJson: {
        house: { domain: 'house.example', name: 'House' },
        brands: [{ id: 'spark', names: [{ en: 'Spark' }], logos: [] }],
      },
      candidates: [{ asset_id: 'candidate_logo_0001', url: 'https://assets.example/spark/logo.svg' }],
      mappings: [
        {
          asset_id: 'candidate_logo_0001',
          target: 'logos[]',
          review_status: 'approved',
          proposed_logo: { id: 'spark_primary', slots: ['logo_card_light'] },
        },
      ],
    });

    assert.strictEqual(result.saved, true);
    assert.strictEqual(savedPayload.brand_name, 'Spark');
  });

  test('extracts owned website aliases from house portfolio properties', () => {
    const aliases = extractBrandWebsiteAliases({
      house: { domain: 'loopme.ai', name: 'LoopMe' },
      brands: [
        {
          id: 'loopme',
          names: [{ en: 'LoopMe' }],
          properties: [
            { type: 'website', identifier: 'loopme.ai', primary: true },
            { type: 'website', identifier: 'https://LOOPME.com/about' },
            { type: 'mobile_app', identifier: 'com.loopme.app' },
            { type: 'website', identifier: 'agency.example', relationship: 'delegated' },
          ],
        },
      ],
    });

    assert.deepStrictEqual(aliases, [
      {
        domain: 'loopme.ai',
        source: 'brand_json_property',
        path: 'brands[0].properties[0]',
        brandId: 'loopme',
        brandName: 'LoopMe',
        primary: true,
        relationship: 'owned',
      },
      {
        domain: 'loopme.com',
        source: 'brand_json_property',
        path: 'brands[0].properties[1]',
        brandId: 'loopme',
        brandName: 'LoopMe',
        relationship: 'owned',
      },
    ]);
  });

  test('extracts website aliases from compatibility property shapes and supports brandId filtering', () => {
    const domains = extractBrandWebsiteAliasDomains(
      {
        house: { domain: 'house.example', name: 'House' },
        brands: [
          {
            id: 'spark',
            name: 'Spark',
            properties: [
              { property_type: 'website', domain: 'Spark.Example' },
              { property_type: 'website', url: 'https://www.spark.example/path' },
              {
                property_type: 'website',
                identifiers: [
                  { type: 'domain', value: 'shop.spark.example' },
                  { type: 'ios_bundle', value: 'com.spark.app' },
                ],
              },
            ],
          },
          {
            id: 'bolt',
            name: 'Bolt',
            properties: [{ type: 'website', identifier: 'bolt.example' }],
          },
        ],
      },
      { brandId: 'spark', includeCompatibilityFields: true }
    );

    assert.deepStrictEqual(domains, ['spark.example', 'www.spark.example', 'shop.spark.example']);
  });

  test('does not promote compatibility fields as owned aliases unless explicitly requested', () => {
    const aliases = extractBrandWebsiteAliases({
      name: 'Acme',
      properties: [
        {
          type: 'website',
          identifier: 'brand.example',
          domain: 'domain-extra.example',
          url: 'https://url-extra.example/path',
          identifiers: [{ type: 'domain', value: 'identifier-extra.example' }],
        },
      ],
    });

    assert.deepStrictEqual(aliases, [
      {
        domain: 'brand.example',
        source: 'brand_json_property',
        path: 'properties[0]',
        brandName: 'Acme',
        relationship: 'owned',
      },
    ]);
  });

  test('does not treat delegated, direct, or network website properties as owned aliases', () => {
    const aliases = extractBrandWebsiteAliases({
      name: 'Acme',
      properties: [
        { type: 'website', identifier: 'owned.example' },
        { type: 'website', identifier: 'direct.example', relationship: 'direct' },
        { type: 'website', identifier: 'delegated.example', relationship: 'delegated' },
        { type: 'website', identifier: 'network.example', relationship: 'ad_network' },
        { type: 'website', identifier: 'direct-delegation-type.example', delegation_type: 'direct' },
        { type: 'website', identifier: 'delegation-type.example', delegation_type: 'delegated' },
        { type: 'website', identifier: 'network-delegation-type.example', delegation_type: 'ad_network' },
        { type: 'website', identifier: 'ftp://invalid.example' },
        { type: 'website', identifier: 'localhost' },
      ],
    });

    assert.deepStrictEqual(aliases, [
      {
        domain: 'owned.example',
        source: 'brand_json_property',
        path: 'properties[0]',
        brandName: 'Acme',
        relationship: 'owned',
      },
    ]);
  });
});
