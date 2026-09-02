const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

describe('Zod Schema Validation', () => {
  let schemas;

  test('schemas can be imported', async () => {
    schemas = await import('../../dist/lib/types/schemas.generated.js');
    assert.ok(schemas, 'Schemas should be importable');
  });

  test('reporting delivery uses the reporting file-transfer schema', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const reportingTransfer = {
      pattern: 'file_transfer',
      transport: 'sftp',
      orchestration: 'producer_managed',
      destination: {
        mode: 'existing',
        destination_ref: 'reporting-destination-1',
      },
      format: 'parquet',
    };
    const audienceTransfer = {
      pattern: 'file_transfer',
      transport: 's3',
      vendor: { domain: 'storage.example' },
    };

    assert.equal(schemas.ReportingDeliveryMethodSchema.safeParse(reportingTransfer).success, true);
    assert.equal(schemas.ReportingDeliveryMethodSchema.safeParse(audienceTransfer).success, false);
  });

  test('ESM package entry can be imported', async () => {
    const sdk = await import('../../dist/lib/index.mjs');
    assert.equal(typeof sdk.ADCP_VERSION, 'string', 'package root should expose its version');
  });

  test('get_products schemas split canonical and legacy field selection', async () => {
    const publicSchemas = await import('../../dist/lib/schemas/index.js');
    const request = {
      buying_mode: 'wholesale',
      fields: ['format_ids'],
      brand: {
        domain: 'buyer.example',
        brand_kit_override: {
          logo: {
            asset_type: 'image',
            url: 'https://buyer.example/logo.png',
            width: 100,
            height: 100,
            provenance: {
              disclosure: {
                required: true,
                jurisdictions: [
                  {
                    country: 'US',
                    regulation: 'example_rule',
                    render_guidance: { positions: [] },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const parsed = publicSchemas.LegacyGetProductsRequestSchema.parse(request);

    assert.deepEqual(parsed.fields, ['format_ids']);
    assert.equal(publicSchemas.GetProductsRequestSchema.safeParse(request).success, false);
    const canonicalJsonSchema = z.toJSONSchema(publicSchemas.GetProductsRequestSchema);
    const canonicalFieldsJson = JSON.stringify(canonicalJsonSchema.properties.fields);
    assert.doesNotMatch(canonicalFieldsJson, /format_ids/);
    assert.match(canonicalFieldsJson, /format_options/);
    assert.deepEqual(
      parsed.brand.brand_kit_override.logo.provenance.disclosure.jurisdictions[0].render_guidance.positions,
      []
    );
  });

  test('beta.4 enforces flexible-window and outcome-target constraints', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    assert.equal(
      schemas.ForecastPointDimensionsSchema.safeParse([
        { kind: 'time', start_time: '2027-01-01T00:00:00Z', end_time: '2027-01-02T00:00:00Z' },
      ]).success,
      true
    );
    assert.equal(
      schemas.TimeForecastDimensionSchema.safeParse({
        kind: 'time',
        start_time: 'not-a-date-time',
        end_time: 'also-invalid',
      }).success,
      false
    );
    const horizon = {
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    assert.equal(schemas.ProductOfferFiltersSchema.safeParse({ availability_horizon: horizon }).success, true);
    assert.equal(
      schemas.ProductOfferFiltersSchema.safeParse({
        availability_horizon: { ...horizon, start_time: 'not-a-date-time' },
      }).success,
      false
    );
    assert.equal(
      schemas.ProductOfferFiltersSchema.safeParse({ availability_horizon: horizon, start_date: '2027-01-01' }).success,
      false
    );
    assert.equal(
      schemas.OutcomeTargetSchema.safeParse({ goal: { kind: 'metric', metric: 'impressions' }, volume: 0 }).success,
      false
    );
    assert.equal(
      schemas.OutcomeTargetSchema.safeParse({ goal: { kind: 'event', event_type: 'custom' }, volume: 1 }).success,
      false
    );
    assert.equal(
      schemas.OutcomeTargetSchema.safeParse({
        goal: { kind: 'event', event_type: 'custom', custom_event_name: '' },
        volume: 1,
      }).success,
      false
    );
    assert.equal(schemas.AvailabilityStatusSchema.safeParse('available').success, true);
  });

  test('beta.5 validates canonical proposal budget guidance and forecast', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    const proposal = {
      proposal_id: 'proposal-outcome-target',
      proposal_kind: 'new_media_buy',
      proposal_status: 'draft',
      expires_at: '2027-01-02T00:00:00Z',
      name: 'Outcome target proposal',
      commercial_terms: {
        brand: { domain: 'buyer.example' },
        purchases: [
          {
            product_id: 'product-1',
            pricing_option_id: 'price-1',
            pricing: {
              pricing_option_id: 'price-1',
              pricing_model: 'cpm',
              currency: 'USD',
              fixed_price: 8,
            },
            start_time: '2027-01-01T00:00:00Z',
            end_time: '2027-02-01T00:00:00Z',
          },
        ],
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 8_000, currency: 'USD' },
      },
      terms_digest: `sha256:${'A'.repeat(43)}`,
      total_budget_guidance: { recommended: 8_000, currency: 'USD' },
      forecast: {
        points: [{ metrics: { clicks: { mid: 10_000 } } }],
        forecast_range_unit: 'clicks',
        method: 'modeled',
        currency: 'USD',
      },
    };

    assert.equal(schemas.CanonicalProposalSchema.safeParse(proposal).success, true);
    assert.equal(
      schemas.CanonicalProposalSchema.safeParse({
        ...proposal,
        total_budget_guidance: { recommended: 8_000 },
      }).success,
      false
    );
    assert.equal(
      schemas.CanonicalProposalSchema.safeParse({
        ...proposal,
        total_budget_guidance: { currency: 'USD' },
      }).success,
      false
    );
    assert.equal(
      schemas.CanonicalProposalSchema.safeParse({ ...proposal, forecast: { method: 'modeled', currency: 'USD' } })
        .success,
      false
    );
    const proposalWithSignalTargeting = signalSourceUrl => ({
      ...proposal,
      commercial_terms: {
        ...proposal.commercial_terms,
        purchases: [
          {
            ...proposal.commercial_terms.purchases[0],
            targeting_overlay: {
              signal_targeting_groups: {
                operator: 'all',
                groups: [
                  {
                    operator: 'any',
                    signals: [
                      {
                        signal_ref: {
                          scope: 'signal_source',
                          signal_source_url: signalSourceUrl,
                          signal_id: 'segment_1',
                        },
                        value_type: 'binary',
                        value: true,
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const validSignalTargeting = schemas.CanonicalProposalSchema.safeParse(
      proposalWithSignalTargeting('http://[v1.fe80::a+en1]/')
    );
    assert.equal(validSignalTargeting.success, true, JSON.stringify(validSignalTargeting.error?.issues));
    assert.equal(
      schemas.CanonicalProposalSchema.safeParse(proposalWithSignalTargeting('https://example.com/%zz')).success,
      false
    );
  });

  test('beta.4 continuation input schema accepts signed vectors and preserves closed loss consent', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    const vectors = JSON.parse(
      readFileSync(
        path.resolve(
          __dirname,
          '../../compliance/cache/latest/test-vectors/products-only-brief-compatibility/vectors.json'
        ),
        'utf8'
      )
    );
    for (const vector of vectors.cases) {
      assert.equal(
        schemas.CompatibilityPurchaseCoordinatorInputSchema.safeParse(vector.continuation_input).success,
        true
      );
    }
    const valid = vectors.cases[1].continuation_input;
    for (const invalid of [
      { ...valid, accepted_losses: ['feed_version_not_atomic'] },
      { ...valid, accepted_losses: [...valid.accepted_losses, valid.accepted_losses[0]] },
      { ...valid, selected_product_ids: [...valid.selected_product_ids, valid.selected_product_ids[0]] },
      { ...valid, unexpected: true },
    ]) {
      assert.equal(schemas.CompatibilityPurchaseCoordinatorInputSchema.safeParse(invalid).success, false);
    }
  });

  test('beta.4 request-proposals response schema enforces every legacy continuation loss', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    const vectors = JSON.parse(
      readFileSync(
        path.resolve(
          __dirname,
          '../../compliance/cache/latest/test-vectors/products-only-brief-compatibility/vectors.json'
        ),
        'utf8'
      )
    );
    for (const vector of vectors.cases) {
      assert.equal(schemas.RequestProposalsResponseSchema.safeParse(vector.compact_projection).success, true);
    }
    const listed = vectors.listed_purchase_cases[0].compact_projection;
    assert.equal(schemas.RequestProposalsResponseSchema.safeParse(listed).success, true);
    const v25 = vectors.cases[0].compact_projection;
    const invalidResponses = [
      { outcome: 'products_available', status: 'completed' },
      { outcome: 'products_available', status: 'completed', products: [] },
      { outcome: 'rejected', status: 'completed', reason: 'no', purchase_continuation: v25.purchase_continuation },
      {
        ...v25,
        purchase_continuation: {
          ...v25.purchase_continuation,
          losses: ['mutation_idempotency_not_guaranteed'],
        },
      },
      {
        ...v25,
        purchase_continuation: {
          ...v25.purchase_continuation,
          losses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
        },
      },
      {
        ...v25,
        purchase_continuation: {
          ...v25.purchase_continuation,
          losses: ['feed_version_not_atomic', 'feed_version_not_atomic', 'pricing_version_not_atomic'],
        },
      },
      {
        ...v25,
        purchase_continuation: { ...v25.purchase_continuation, product_ids: [''] },
      },
      {
        ...listed,
        purchase_continuation: { ...listed.purchase_continuation, product_ids: ['', ''] },
      },
      {
        ...listed,
        purchase_continuation: { ...listed.purchase_continuation, product_ids: ['different-product'] },
      },
      {
        ...listed,
        purchase_continuation: {
          ...listed.purchase_continuation,
          product_ids: [listed.products[0].product_id, 'missing-product'],
        },
        products: [listed.products[0], { ...listed.products[0] }],
      },
      {
        ...listed,
        products: [...listed.products, { ...listed.products[0], product_id: 'extra-product' }],
      },
      {
        ...listed,
        products: listed.products.map(({ pricing_options: _pricing, ...product }) => product),
      },
      {
        ...listed,
        products: listed.products.map(product => ({ ...product, pricing_options: [] })),
      },
      {
        ...listed,
        incomplete: [{ scope: 'pricing', description: 'missing' }],
      },
    ];
    for (const invalid of invalidResponses) {
      assert.equal(schemas.RequestProposalsResponseSchema.safeParse(invalid).success, false);
    }
  });

  test('reference image and carousel fixtures conform to SDK schemas', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }
    const { prepareImageCarouselReference, prepareImageReference } =
      await import('../../packages/reference-renderers/index.js');
    const imageManifest = {
      format_kind: 'image',
      assets: {
        image_main: {
          asset_type: 'image',
          url: 'https://cdn.example/image.png',
          width: 300,
          height: 250,
        },
      },
    };
    const imageDeclaration = {
      format_kind: 'image',
      params: { width: 300, height: 250 },
    };
    const carouselManifest = {
      format_kind: 'image_carousel',
      assets: {
        cards: ['one', 'two'].map(id => ({
          asset_type: 'card',
          media: {
            asset_type: 'image',
            url: `https://cdn.example/${id}.png`,
            width: 600,
            height: 600,
          },
          headline: `Card ${id}`,
        })),
      },
    };
    const carouselDeclaration = {
      format_kind: 'image_carousel',
      params: {
        min_cards: 2,
        max_cards: 4,
        card_aspect_ratio: '1:1',
        allowed_card_media_asset_types: ['image'],
      },
    };

    for (const [manifest, declaration, prepare] of [
      [imageManifest, imageDeclaration, prepareImageReference],
      [carouselManifest, carouselDeclaration, prepareImageCarouselReference],
    ]) {
      assert.strictEqual(schemas.CreativeManifestSchema.safeParse(manifest).success, true);
      assert.strictEqual(schemas.ProductFormatDeclarationSchema.safeParse(declaration).success, true);
      assert.strictEqual(prepare({ manifest, declaration }).ok, true);
    }
  });

  test('PreviewCreativeRequestSchema enforces mode and one-generation batch routing', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    const legacyFormat = { agent_url: 'https://creative.example', id: 'display' };
    const validBatch = {
      request_type: 'batch',
      target_capability_id: 'preview_capability',
      requests: [{ creative_id: 'creative-1' }, { target_capability_id: 'item_capability', creative_id: 'creative-2' }],
    };
    assert.equal(schemas.PreviewCreativeRequestSchema.safeParse(validBatch).success, true);
    for (const invalid of [
      { request_type: 'single' },
      { request_type: 'single', creative_id: 'one', creative_manifest: {} },
      { request_type: 'single', creative_id: 'one', requests: [] },
      { request_type: 'single', creative_id: 'one', requests: [{}] },
      { request_type: 'variant' },
      { request_type: 'variant', variant_id: undefined },
      { request_type: 'batch' },
      { request_type: 'batch', requests: [] },
      { request_type: 'batch', requests: Array.from({ length: 51 }, (_, index) => ({ creative_id: `c-${index}` })) },
      { request_type: 'batch', requests: [{}] },
      { request_type: 'batch', requests: [{ creative_id: 'one', creative_manifest: {} }] },
      { ...validBatch, format_id: legacyFormat },
      {
        request_type: 'batch',
        requests: [
          { target_capability_id: 'canonical', creative_id: 'one' },
          { format_id: legacyFormat, creative_id: 'two' },
        ],
      },
    ]) {
      assert.equal(schemas.PreviewCreativeRequestSchema.safeParse(invalid).success, false);
    }
  });

  test('all canonical-format overlays accept the shared array-valued slots contract', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }
    const canonicalSchemas = [
      schemas.CanonicalFormatDisplayTagSchema,
      schemas.CanonicalFormatImageCarouselSchema,
      schemas.CanonicalFormatHostedVideoSchema,
      schemas.CanonicalFormatVASTVideoSchema,
      schemas.CanonicalFormatHostedAudioSchema,
      schemas.CanonicalFormatDAASTAudioSchema,
      schemas.CanonicalFormatSponsoredPlacementRetailMediaCatalogDrivenSchema,
      schemas.CanonicalFormatNativeInFeedSchema,
      schemas.CanonicalFormatResponsiveCreativeSchema,
      schemas.CanonicalFormatAgentPlacementAISurfaceSponsoredPlacementSchema,
      schemas.CanonicalFormatHTML5BannerSchema,
    ];
    const value = {
      slots: [{ asset_group_id: 'audio_main', asset_type: 'audio', required: true }],
    };

    for (const schema of canonicalSchemas) {
      assert.strictEqual(schema.safeParse(value).success, true);
    }
  });

  test('placement presentation documents preserve their closed declarative boundary', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const valid = {
      schema_version: '1.0',
      canvas: { width: 300, height: 250, background_color: '#ffffff' },
      creative_slot: { x: 0, y: 0, width: 300, height: 200, fit: 'contain', clip: true },
      decorations: [
        {
          kind: 'text',
          layer: 'in_front_of_creative',
          bounds: { x: 0, y: 200, width: 300, height: 50 },
          text: 'Sponsored',
          text_color: '#000000',
          font_size: 14,
        },
      ],
    };
    assert.strictEqual(schemas.PlacementPresentationDocumentSchema.safeParse(valid).success, true);

    const invalidDocuments = [
      { ...valid, html: '<script>alert(1)</script>' },
      { ...valid, canvas: { ...valid.canvas, width: 300.5 } },
      { ...valid, creative_slot: { ...valid.creative_slot, x: 1 } },
      { ...valid, decorations: Array.from({ length: 101 }, () => valid.decorations[0]) },
      {
        ...valid,
        decorations: [{ ...valid.decorations[0], bounds: { x: 0, y: 201, width: 300, height: 50 } }],
      },
      {
        ...valid,
        decorations: [{ ...valid.decorations[0], event_handler: 'alert(1)' }],
      },
    ];

    for (const document of invalidDocuments) {
      assert.strictEqual(schemas.PlacementPresentationDocumentSchema.safeParse(document).success, false);
    }
  });

  test('asset size constraints retain integer and positive-number semantics', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const image = { asset_type: 'image', url: 'https://cdn.example/image.png', width: 300, height: 250 };
    assert.strictEqual(schemas.ImageAssetSchema.safeParse({ ...image, file_size_bytes: 1 }).success, true);
    assert.strictEqual(schemas.ImageAssetSchema.safeParse({ ...image, file_size_bytes: 0.5 }).success, false);
    assert.strictEqual(schemas.CanonicalFormatHostedVideoSchema.safeParse({ max_file_size_mb: 1 }).success, true);
    assert.strictEqual(schemas.CanonicalFormatHostedVideoSchema.safeParse({ max_file_size_mb: 1.5 }).success, false);
    assert.strictEqual(schemas.CanonicalFormatHostedAudioSchema.safeParse({ max_file_size_mb: 0.5 }).success, true);
    assert.strictEqual(schemas.CanonicalFormatHostedAudioSchema.safeParse({ max_file_size_mb: 0 }).success, false);
  });

  test('legacy structured format references preserve RFC 3986 URI semantics', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    const formatReference = agent_url => ({ agent_url, id: 'display_static' });
    assert.equal(
      schemas.FormatReferenceStructuredObjectSchema.safeParse(formatReference('http://[v1.fe80::a+en1]/')).success,
      true
    );
    assert.equal(
      schemas.FormatReferenceStructuredObjectSchema.safeParse(formatReference('https://example.com/%zz')).success,
      false
    );
  });

  test('CreativeBriefSchema requires at least one required disclosure when present', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const brief = required_disclosures => ({
      name: 'Launch brief',
      compliance: { required_disclosures },
    });
    assert.strictEqual(schemas.CreativeBriefSchema.safeParse(brief([])).success, false);
    assert.strictEqual(schemas.CreativeBriefSchema.safeParse(brief([{ text: 'Terms apply.' }])).success, true);
  });

  test('ProductSchema is importable and has parse method', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.ProductSchema, 'ProductSchema should exist');
    assert.ok(typeof schemas.ProductSchema.safeParse === 'function', 'ProductSchema should have safeParse method');
    assert.ok(schemas.ProductSchema.shape.product_id, 'ProductSchema should expose object shape');
    assert.equal(typeof schemas.ProductSchema.extend, 'function', 'ProductSchema should support extend');
    assert.equal(typeof schemas.ProductSchema.omit, 'function', 'ProductSchema should support omit');
    assert.equal(typeof schemas.ProductSchema.pick, 'function', 'ProductSchema should support pick');
    assert.ok(schemas.CanonicalFormatImageSchema.shape.image_formats, 'canonical formats should expose object shape');
    assert.equal(schemas.CanonicalFormatImageSchema.safeParse({ motion_level: 'limited_motion' }).success, true);
    assert.equal(schemas.CanonicalFormatImageSchema.safeParse({ motion_level: 'full_motion' }).success, false);
  });

  test('PriceBreakdownSchema preserves adjustment XOR and 1..20 bounds', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }
    const adjustment = { kind: 'fee', name: 'ad_serving', rate: 0.1 };
    assert.equal(schemas.PriceBreakdownSchema.safeParse({ list_price: 10, adjustments: [adjustment] }).success, true);
    assert.equal(schemas.PriceBreakdownSchema.safeParse({ list_price: 10, adjustments: [] }).success, false);
    assert.equal(
      schemas.PriceBreakdownSchema.safeParse({ list_price: 10, adjustments: Array(21).fill(adjustment) }).success,
      false
    );
    assert.equal(
      schemas.PriceBreakdownSchema.safeParse({
        list_price: 10,
        adjustments: [{ ...adjustment, amount: 1 }],
      }).success,
      false
    );
  });

  test('ProductSchema exposes ZodObject composition helpers', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.strictEqual(typeof schemas.ProductSchema.extend, 'function', 'ProductSchema should expose .extend()');
    assert.strictEqual(typeof schemas.ProductSchema.omit, 'function', 'ProductSchema should expose .omit()');
    assert.strictEqual(typeof schemas.ProductSchema.pick, 'function', 'ProductSchema should expose .pick()');

    const extended = schemas.ProductSchema.extend({ _cached_at: z.string().datetime() });
    const omitted = schemas.ProductSchema.omit({ description: true });
    const picked = schemas.ProductSchema.pick({ product_id: true });
    assert.ok(extended.shape._cached_at, 'extended ProductSchema should include the extension field');
    assert.ok(!('description' in omitted.shape), 'omitted ProductSchema should remove the omitted field');
    assert.ok(
      picked.safeParse({ product_id: 'prod_123' }).success,
      'picked ProductSchema should validate picked shape'
    );
  });

  test('CancellationPolicySchema enforces fee values by fee type', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const policy = cancellation_fee => ({
      notice_period: { interval: 30, unit: 'days' },
      cancellation_fee,
    });

    assert.ok(schemas.CancellationPolicySchema.safeParse(policy({ type: 'percent_remaining', rate: 0.5 })).success);
    assert.ok(!schemas.CancellationPolicySchema.safeParse(policy({ type: 'percent_remaining' })).success);
    assert.ok(schemas.CancellationPolicySchema.safeParse(policy({ type: 'fixed_fee', amount: 250 })).success);
    assert.ok(!schemas.CancellationPolicySchema.safeParse(policy({ type: 'fixed_fee' })).success);
    assert.ok(schemas.CancellationPolicySchema.safeParse(policy({ type: 'full_commitment' })).success);
    assert.ok(schemas.CancellationPolicySchema.safeParse(policy({ type: 'none' })).success);
  });

  test('canonical delivery metrics stay strict while legacy response variants remain tolerant', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const baseMetrics = { impressions: 10, spend: 2.5 };
    assert.ok(!schemas.CatalogItemDeliveryMetricsSchema.safeParse(baseMetrics).success);
    assert.ok(schemas.CatalogItemDeliveryMetricsSchema.safeParse({ ...baseMetrics, content_id: 'sku-1' }).success);

    assert.ok(!schemas.KeywordDeliveryMetricsSchema.safeParse({ ...baseMetrics, keyword: 'running shoes' }).success);
    assert.ok(!schemas.KeywordDeliveryMetricsSchema.safeParse({ ...baseMetrics, match_type: 'exact' }).success);
    assert.ok(
      schemas.KeywordDeliveryMetricsSchema.safeParse({
        ...baseMetrics,
        keyword: 'running shoes',
        match_type: 'exact',
      }).success
    );

    assert.ok(!schemas.GeoDeliveryMetricsSchema.safeParse({ ...baseMetrics, geo_level: 'country' }).success);
    assert.ok(!schemas.GeoDeliveryMetricsSchema.safeParse({ ...baseMetrics, geo_code: 'US' }).success);
    assert.ok(
      schemas.GeoDeliveryMetricsSchema.safeParse({ ...baseMetrics, geo_level: 'country', geo_code: 'US' }).success
    );

    assert.ok(schemas.GetMediaBuyDeliveryCatalogItemMetricsSchema.safeParse(baseMetrics).success);
    assert.ok(schemas.GetMediaBuyDeliveryKeywordMetricsSchema.safeParse(baseMetrics).success);
    assert.ok(schemas.GetMediaBuyDeliveryGeoMetricsSchema.safeParse(baseMetrics).success);

    const legacyResponse = {
      status: 'completed',
      reporting_period: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
      media_buy_deliveries: [
        {
          media_buy_id: 'buy-1',
          status: 'active',
          totals: baseMetrics,
          by_package: [
            {
              package_id: 'package-1',
              ...baseMetrics,
              by_catalog_item: [baseMetrics],
              by_keyword: [baseMetrics],
              by_geo: [baseMetrics],
              by_geo_truncated: false,
              by_device_type: [baseMetrics],
              by_device_platform: [baseMetrics],
              by_audience: [baseMetrics],
              by_placement: [baseMetrics],
            },
          ],
        },
      ],
    };
    assert.ok(
      schemas.GetMediaBuyDeliveryResponseSchema.safeParse(legacyResponse).success,
      'full legacy delivery response should remain wired to optional compatibility metrics'
    );
  });

  test('beta.6 reporting request and delivery identities round-trip', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const request = {
      requested_metrics: ['viewable_rate', 'quartile_100', 'time_based_views'],
      reporting_dimensions: {
        creative: { limit: 5, sort_by: 'quartile_100', sort_direction: 'asc' },
        keyword: { sort_by: 'viewable_rate', sort_direction: 'desc' },
        catalog_item: {},
        format: { limit: 3, sort_by: 'cpm', sort_direction: 'desc' },
      },
    };
    assert.ok(
      schemas.GetMediaBuyDeliveryRequestSchema.safeParse(request).success,
      'requested metric leaves and negotiated breakdown controls should validate'
    );
    assert.ok(
      !schemas.GetMediaBuyDeliveryRequestSchema.safeParse({ requested_metrics: [] }).success,
      'requested metrics must not be empty'
    );
    assert.ok(
      !schemas.GetMediaBuyDeliveryRequestSchema.safeParse({ requested_metrics: ['clicks', 'clicks'] }).success,
      'requested metrics must be unique'
    );

    const deliveryMetrics = {
      impressions: 100,
      spend: 25,
      time_based_views: [
        { threshold_seconds: 2, basis: 'play_time', views: 80 },
        { threshold_seconds: 2, basis: 'in_view', views: 60, standard: 'mrc' },
      ],
      vendor_metric_values: [
        {
          vendor: { domain: 'measurement.example' },
          metric_id: 'incremental_outcomes',
          value: 12,
          qualifier: { attribution_window: { interval: 7, unit: 'days' } },
        },
        {
          vendor: { domain: 'measurement.example' },
          metric_id: 'incremental_outcomes',
          value: 18,
          qualifier: { attribution_window: { interval: 30, unit: 'days' } },
        },
      ],
    };
    assert.ok(
      schemas.DeliveryMetricsSchema.safeParse(deliveryMetrics).success,
      'time-based views and qualifier-distinct vendor rows should validate'
    );
    assert.ok(
      !schemas.DeliveryMetricsSchema.safeParse({
        time_based_views: [{ threshold_seconds: 0, basis: 'play_time', views: 1 }],
      }).success,
      'time-based view thresholds must be positive'
    );
    assert.ok(
      !schemas.VendorMetricValueSchema.safeParse({
        vendor: { domain: 'measurement.example' },
        metric_id: 'incremental_outcomes',
        value: 1,
        qualifier: { unrecognized_identity: 'poison' },
      }).success,
      'vendor metric identity qualifiers must reject unknown keys'
    );

    const aggregateRows = [
      {
        scope: 'standard',
        metric_id: 'viewable_rate',
        value: 0.75,
        measurable_impressions: 80,
        viewable_impressions: 60,
        qualifier: { viewability_standard: 'mrc' },
      },
      {
        scope: 'standard',
        metric_id: 'completion_rate',
        value: 0.5,
        impressions: 100,
        completed_views: 50,
      },
      { scope: 'standard', metric_id: 'cost_per_acquisition', value: 4, spend: 20, conversions: 5 },
      { scope: 'standard', metric_id: 'roas', value: 3, spend: 20, conversion_value: 60 },
    ];
    for (const aggregate of aggregateRows) {
      assert.ok(schemas.DeliveryMetricAggregateSchema.safeParse(aggregate).success);
      for (const requiredComponent of Object.keys(aggregate).filter(
        key => !['scope', 'metric_id', 'value', 'qualifier'].includes(key)
      )) {
        const incomplete = { ...aggregate };
        delete incomplete[requiredComponent];
        assert.ok(
          !schemas.DeliveryMetricAggregateSchema.safeParse(incomplete).success,
          `${aggregate.metric_id} must require ${requiredComponent}`
        );
      }
    }
    assert.ok(
      !schemas.DeliveryMetricAggregateSchema.safeParse({
        scope: 'standard',
        metric_id: 'clicks',
        value: 1,
        qualifier: { unrecognized_identity: 'poison' },
      }).success,
      'standard delivery aggregate qualifiers must reject unknown identity keys'
    );
    assert.ok(
      !schemas.DeliveryMetricAggregateSchema.safeParse({
        scope: 'vendor',
        vendor: { domain: 'measurement.example' },
        metric_id: 'incremental_outcomes',
        value: 1,
        qualifier: { unrecognized_identity: 'poison' },
      }).success,
      'delivery aggregate qualifiers must reject unknown identity keys'
    );

    const response = {
      status: 'completed',
      reporting_period: { start: '2026-08-01T00:00:00Z', end: '2026-08-02T00:00:00Z' },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'buy-1',
          status: 'active',
          totals: deliveryMetrics,
          by_package: [
            {
              package_id: 'package-1',
              impressions: 100,
              spend: 25,
              by_format: [{ format_kind: 'video_vast', impressions: 100, spend: 25 }],
              by_format_truncated: false,
              by_format_sorted_by: 'cpm',
              by_format_sort_direction: 'desc',
            },
          ],
        },
      ],
    };
    assert.ok(
      schemas.GetMediaBuyDeliveryResponseSchema.safeParse(response).success,
      'format breakdown completeness and applied-sort echoes should validate'
    );
  });

  test('beta.6 promoted canonical formats preserve nested wire constraints', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    for (const format_kind of ['seller_rendered_stateful_display', 'coordinated_placements']) {
      const option = { format_kind, params: {} };
      assert.ok(
        schemas.CanonicalFormatOptionSchema.safeParse(option).success,
        `${format_kind} must be accepted by compact format options`
      );
      assert.ok(
        schemas.CanonicalProductSchema.safeParse({
          product_id: `product-${format_kind}`,
          name: format_kind,
          format_options: [option],
        }).success,
        `${format_kind} must be accepted in canonical products`
      );
    }

    const stateful = {
      states: [
        {
          state_id: 'default',
          anchoring: 'inline',
          breakpoints: [{ breakpoint_id: 'desktop', width: 300, height: 250 }],
          close_affordance: false,
        },
      ],
      initial_state_id: 'default',
      user_controls: { dismissible: false, user_collapsible: false },
    };
    assert.ok(schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.shape);
    assert.ok(schemas.CanonicalFormatCoordinatedPlacementsSchema.shape);
    assert.ok(schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse(stateful).success);
    const deeplyNestedValue = {};
    let cursor = deeplyNestedValue;
    for (let depth = 0; depth < 4000; depth += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    assert.doesNotThrow(() =>
      schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse({
        ...stateful,
        slots: [{ asset_group_id: 'body', asset_type: 'text', max_size_kb: deeplyNestedValue }],
      })
    );
    for (const invalid of [
      { ...stateful, experimental: 'wrong' },
      { ...stateful, v1_translatable: 42 },
      { ...stateful, composition_model: { bad: true } },
      { ...stateful, slots: { not: 'an array' } },
      {
        ...stateful,
        states: [
          {
            ...stateful.states[0],
            breakpoints: [{ breakpoint_id: 'desktop', width: 300, width_range: [250, 350], height: 250 }],
          },
        ],
      },
      {
        ...stateful,
        states: [
          {
            ...stateful.states[0],
            breakpoints: [{ breakpoint_id: 'desktop', width: 300, height: 250, height_range: [200, 300] }],
          },
        ],
      },
      {
        ...stateful,
        states: [{ ...stateful.states[0], breakpoints: [{ breakpoint_id: 'desktop', width: 300 }] }],
      },
      { ...stateful, duration_ms_range: [null, null] },
      { ...stateful, duration_ms_range: [0, 100, 200] },
      { ...stateful, containers: ['mp4', 'mp4'] },
    ]) {
      assert.ok(
        !schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse(invalid).success,
        `stateful-display must reject ${JSON.stringify(invalid)}`
      );
    }
    assert.ok(
      !schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse({
        ...stateful,
        states: [{ ...stateful.states[0], breakpoints: [{}] }],
      }).success,
      'stateful-display breakpoints must retain required identity and geometry'
    );
    assert.ok(
      !schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse({
        ...stateful,
        transitions: [{ trigger: 'timer' }],
      }).success,
      'stateful-display transitions must retain common and arm-specific required fields'
    );
    const transitionBase = {
      transition_id: 'expand',
      from_state_id: 'default',
      to_state_id: 'expanded',
      trigger: 'timer',
      transition_mode: 'animated',
      delay_ms: 250,
    };
    assert.ok(
      schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse({
        ...stateful,
        transitions: [transitionBase],
      }).success
    );
    assert.ok(
      !schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse({
        ...stateful,
        transitions: [{ ...transitionBase, input: 'tap' }],
      }).success,
      'timer transitions reject user input'
    );
    assert.ok(
      !schemas.CanonicalFormatSellerRenderedStatefulDisplaySchema.safeParse({
        ...stateful,
        transitions: [
          {
            ...transitionBase,
            trigger: 'scroll_progress',
            input: 'scroll',
            scroll_reference: 'page',
            scroll_start_percent: 0,
            scroll_end_percent: 100,
          },
        ],
      }).success,
      'scroll-progress transitions require scroll-linked mode and forbid timer fields'
    );

    const coordinated = {
      components: [
        {
          component_id: 'hero',
          placement_ref: { placement_id: 'hero-placement' },
          required: true,
          format_kind: 'image',
          params: {},
        },
        {
          component_id: 'rail',
          placement_ref: { placement_id: 'rail-placement' },
          required: false,
          format_option_ref: { scope: 'product', format_option_id: 'rail-option' },
        },
      ],
    };
    assert.ok(schemas.CanonicalFormatCoordinatedPlacementsSchema.safeParse(coordinated).success);
    assert.ok(
      !schemas.CanonicalFormatCoordinatedPlacementsSchema.safeParse({ components: [{}, {}] }).success,
      'coordinated components must retain required identity, placement, and format selection'
    );
    assert.ok(
      !schemas.CanonicalFormatCoordinatedPlacementsSchema.safeParse({
        components: coordinated.components.map(component => ({ ...component, required: false })),
      }).success,
      'at least one coordinated component must be required'
    );
    assert.ok(
      !schemas.CanonicalFormatCoordinatedPlacementsSchema.safeParse({
        components: [
          {
            ...coordinated.components[0],
            format_option_ref: { scope: 'product', format_option_id: 'also-a-reference' },
          },
          coordinated.components[1],
        ],
      }).success,
      'inline and referenced component formats are mutually exclusive'
    );
    for (const firstComponent of [
      { ...coordinated.components[0], params: undefined },
      { ...coordinated.components[0], format_kind: 'custom' },
      { ...coordinated.components[0], format_kind: 'coordinated_placements' },
      { ...coordinated.components[0], params: { width: 0 } },
    ]) {
      assert.ok(
        !schemas.CanonicalFormatCoordinatedPlacementsSchema.safeParse({
          components: [firstComponent, coordinated.components[1]],
        }).success,
        `coordinated inline format must reject ${JSON.stringify(firstComponent)}`
      );
    }
    for (const consumed_by of [[], ['hero', 'hero']]) {
      assert.ok(
        !schemas.CanonicalFormatCoordinatedPlacementsSchema.safeParse({
          ...coordinated,
          shared_slots: [{ asset_group_id: 'logo', asset_type: 'image', consumed_by }],
        }).success,
        `shared-slot consumers must reject ${JSON.stringify(consumed_by)}`
      );
    }
  });

  test('PostalCountrySystemSchema requires a valid country and system pair', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(!schemas.PostalCountrySystemSchema.safeParse({}).success);
    assert.ok(!schemas.PostalCountrySystemSchema.safeParse({ country: 'US' }).success);
    assert.ok(!schemas.PostalCountrySystemSchema.safeParse({ system: 'zip' }).success);
    assert.ok(schemas.PostalCountrySystemSchema.safeParse({ country: 'US', system: 'zip' }).success);
    assert.ok(!schemas.PostalCountrySystemSchema.safeParse({ country: 'US', system: 'outward' }).success);
  });

  test('Trusted Match request schemas reject unexpected privacy-boundary fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const contextRequest = {
      type: 'context_match_request',
      request_id: 'ctx-1',
      property_rid: '018f33bb-9a82-7cc5-a839-6c9f1e5a4d01',
      property_type: 'website',
      placement_id: 'plc_1',
      seller_agent_url: 'https://seller.example/mcp/',
    };
    assert.ok(schemas.ContextMatchRequestSchema.safeParse(contextRequest).success);
    assert.ok(!schemas.ContextMatchRequestSchema.safeParse({ ...contextRequest, identity: {} }).success);
    assert.ok(
      !schemas.ContextMatchRequestSchema.safeParse({
        ...contextRequest,
        geo: { country: 'US', unexpected: true },
      }).success
    );

    const identityRequest = {
      type: 'identity_match_request',
      request_id: 'id-1',
      seller_agent_url: 'https://seller.example/mcp/',
      identities: [{ user_token: 'opaque', uid_type: 'uid2' }],
    };
    assert.ok(schemas.IdentityMatchRequestSchema.safeParse(identityRequest).success);
    assert.ok(!schemas.IdentityMatchRequestSchema.safeParse({ ...identityRequest, context: {} }).success);

    const identityWithProof = {
      ...identityRequest,
      identities: [
        {
          user_token: 'opaque',
          uid_type: 'uid2',
          attestation: {
            issuer: { domain: 'issuer.example' },
            scheme: 'scheme-1',
            claims: ['unique_human'],
            proof: { merkle_root: 'proof-value' },
          },
        },
      ],
    };
    assert.ok(schemas.IdentityMatchRequestSchema.safeParse(identityWithProof).success);
  });

  test('Trusted Match 3.1.10 schemas enforce hop isolation and TMPX constraints', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const chunk = { slot_id: 'primary', value: 'opaque-value' };
    const baseResponse = {
      status: 'completed',
      type: 'identity_match_response',
      request_id: 'id-1',
      eligible_package_ids: ['pkg-1'],
      serve_window_sec: 60,
    };
    const providerResponse = { ...baseResponse, tmpx_chunks: [chunk] };
    const routerResponse = {
      ...baseResponse,
      tmpx_providers: { provider_1: { chunks: [chunk] } },
    };

    assert.ok(schemas.IdentityMatchResponseProviderRouterSchema.safeParse(providerResponse).success);
    assert.ok(schemas.IdentityMatchResponseRouterPublisherSchema.safeParse(routerResponse).success);
    assert.strictEqual(schemas.IdentityMatchResponseSchema, schemas.IdentityMatchResponseRouterPublisherSchema);
    assert.ok(schemas.TmpxMacroSchema.safeParse({ name: 'LEGACY_SLOT', value: 'opaque' }).success);

    for (const forbidden of [
      { context: {} },
      { ext: {} },
      { tmpx: 'legacy' },
      { tmpx_providers: { provider_1: { chunks: [chunk] } } },
    ]) {
      assert.ok(
        !schemas.IdentityMatchResponseProviderRouterSchema.safeParse({ ...providerResponse, ...forbidden }).success
      );
    }
    for (const forbidden of [{ context: {} }, { ext: {} }, { tmpx_chunks: [chunk] }, { tmpx_macros: [] }]) {
      assert.ok(
        !schemas.IdentityMatchResponseRouterPublisherSchema.safeParse({ ...routerResponse, ...forbidden }).success
      );
    }

    assert.ok(!schemas.TMPXChunkSchema.safeParse({ ...chunk, destination: 'PUBLISHER_MACRO' }).success);
    assert.ok(
      !schemas.IdentityMatchResponseProviderRouterSchema.safeParse({ ...baseResponse, tmpx_chunks: [] }).success
    );
    assert.ok(
      !schemas.IdentityMatchResponseProviderRouterSchema.safeParse({
        ...baseResponse,
        tmpx_chunks: [chunk, { ...chunk, slot_id: 'secondary' }, { ...chunk, slot_id: 'third' }],
      }).success
    );
    assert.ok(
      !schemas.IdentityMatchResponseRouterPublisherSchema.safeParse({
        ...baseResponse,
        tmpx_providers: { 'bad-provider': { chunks: [chunk] } },
      }).success
    );

    const registration = {
      provider_id: 'provider_1',
      endpoint: 'https://provider.example',
      identity_match: true,
      countries: ['US'],
      uid_types: ['uid2'],
      tmpx_slots: ['primary', 'secondary'],
    };
    assert.ok(schemas.TMPProviderRegistrationSchema.safeParse(registration).success);
    assert.ok(!schemas.TMPProviderRegistrationSchema.safeParse({ ...registration, countries: undefined }).success);
    assert.ok(
      !schemas.TMPProviderRegistrationSchema.safeParse({ ...registration, tmpx_slots: ['primary', 'primary'] }).success
    );
    assert.ok(
      !schemas.TMPProviderRegistrationSchema.safeParse({ ...registration, tmpx_slots: ['a', 'b', 'c'] }).success
    );

    const mapping = { tmpx_macro_mapping: { provider_1: { primary: 'GAM_KEY' } } };
    assert.ok(schemas.PublisherTMPXMacroMappingSchema.safeParse(mapping).success);
    assert.ok(
      !schemas.PublisherTMPXMacroMappingSchema.safeParse({
        tmpx_macro_mapping: { 'bad-provider': { primary: 'GAM_KEY' } },
      }).success
    );
    assert.ok(
      !schemas.PublisherTMPXMacroMappingSchema.safeParse({
        tmpx_macro_mapping: { provider_1: { a: 'A', b: 'B', c: 'C' } },
      }).success
    );
  });

  test('generated declarations do not expose record-union object intersections', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // Runtime check so the test fails closed even if Zod adjusts its tuple stringification.
    // Zod 4 dropped `_def.typeName`; constructor name is the stable cross-version probe.
    assert.strictEqual(
      schemas.ProductSchema.constructor.name,
      'ZodObject',
      'ProductSchema should be a ZodObject, not a ZodIntersection'
    );

    const declarations = readFileSync(path.join(__dirname, '../../dist/lib/types/schemas.generated.d.ts'), 'utf8');
    const matches = declarations.match(/z\.ZodIntersection<z\.ZodUnion<readonly \[z\.ZodRecord/g) ?? [];

    assert.strictEqual(
      matches.length,
      0,
      'record-only union markers intersected with object schemas should emit as ZodObject declarations'
    );
  });

  test('MediaBuySchema validates valid media buy', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validMediaBuy = {
      media_buy_id: 'mb_123',
      status: 'pending_start', // Must match enum value
      promoted_offering: 'Nike Spring Collection 2024',
      confirmed_at: '2026-01-15T10:00:00Z',
      revision: 1,
      total_budget: 50000,
      packages: [],
    };

    const result = schemas.MediaBuySchema.safeParse(validMediaBuy);
    assert.ok(
      result.success,
      `MediaBuy validation should succeed: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('GetProductsRequestSchema validates valid request (if available)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // GetProductsRequestSchema may not be generated due to complex discriminated unions in v3 schemas
    if (!schemas.GetProductsRequestSchema) {
      console.log('⏭️  GetProductsRequestSchema not available - skipping validation test');
      return;
    }

    const validRequest = {
      buying_mode: 'brief',
      brief: 'Looking for premium display inventory in US',
    };

    const result = schemas.GetProductsRequestSchema.safeParse(validRequest);
    assert.ok(
      result.success,
      `GetProductsRequest validation should succeed: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('ProductSchema rejects invalid product', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const invalidProduct = {
      product_id: 'prod_123',
      // Missing required fields
    };

    const result = schemas.ProductSchema.safeParse(invalidProduct);
    assert.ok(!result.success, 'Product validation should fail for invalid data');
  });

  test('GetProductsResponseSchema validates response (if available)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // GetProductsResponseSchema may not be generated due to complex discriminated unions in v3 schemas
    if (!schemas.GetProductsResponseSchema) {
      console.log('⏭️  GetProductsResponseSchema not available - skipping validation test');
      return;
    }

    const validResponse = {
      status: 'completed',
      products: [],
    };

    const result = schemas.GetProductsResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetProductsResponse validation should succeed: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('CreativeAssetSchema is importable and has parse method', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.CreativeAssetSchema, 'CreativeAssetSchema should exist');
    assert.ok(
      typeof schemas.CreativeAssetSchema.safeParse === 'function',
      'CreativeAssetSchema should have safeParse method'
    );
  });

  test('macro-bearing URL aliases preserve their primitive string runtime shape', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const url = 'https://tracker.example/pixel?cb=%%CACHEBUSTER%%';
    const aliases = Object.entries(schemas).filter(([name]) => /^MacroBearingURL\d+Schema$/.test(name));
    assert.ok(aliases.length > 0, 'expected generated macro-bearing URL aliases');

    for (const [name, schema] of aliases) {
      assert.strictEqual(schema.safeParse(url).success, true, `${name} must accept macro-bearing URL strings`);
      assert.strictEqual(schema.safeParse({}).success, false, `${name} must remain a primitive string schema`);
    }

    assert.strictEqual(
      schemas.DAASTAssetSchema.safeParse({
        asset_type: 'daast',
        delivery_type: 'url',
        url,
      }).success,
      true,
      'URL-delivered DAAST assets must accept macro-bearing URL strings'
    );
  });

  test('CreativeAssetSchema enforces exclusive identity and a valid legacy agent URL', async () => {
    const schemas = await import('../../dist/lib/types/schemas.generated.mjs');
    const base = { creative_id: 'creative_1', name: 'Creative', assets: {} };

    assert.strictEqual(
      schemas.CreativeAssetSchema.safeParse({
        ...base,
        format_kind: 'image',
        format_id: { agent_url: 'https://legacy.example', id: 'display_image' },
      }).success,
      false
    );
    assert.strictEqual(
      schemas.CreativeAssetSchema.safeParse({
        ...base,
        format_id: { agent_url: 'bad', id: 'display_image' },
      }).success,
      false
    );
    assert.doesNotThrow(() =>
      schemas.CreativeAssetSchema.safeParse({
        ...base,
        format_id: { agent_url: ' https://legacy.example ', id: 'display_image' },
      })
    );
    assert.strictEqual(
      schemas.CreativeAssetSchema.safeParse({
        ...base,
        format_id: { agent_url: ' https://legacy.example ', id: 'display_image' },
      }).success,
      false
    );
    for (const agent_url of [
      'https://legacy.example/a b',
      'https://legacy.example/a\tb',
      'https://legacy.example/%ZZ',
      'https://münich.example',
    ]) {
      assert.strictEqual(
        schemas.CreativeAssetSchema.safeParse({
          ...base,
          format_id: { agent_url, id: 'display_image' },
        }).success,
        false,
        `agent_url must reject whitespace: ${JSON.stringify(agent_url)}`
      );
    }
    for (const forbiddenIdentity of ['capability_id', 'capability_ref']) {
      assert.strictEqual(
        schemas.CreativeAssetSchema.safeParse({
          ...base,
          format_kind: 'image',
          [forbiddenIdentity]: 'legacy-capability',
        }).success,
        false,
        `${forbiddenIdentity} is forbidden by the creative schema`
      );
    }
  });

  test('creative schemas validate slot assets and canonical manifest identity', async () => {
    const schemas = await import('../../dist/lib/types/schemas.generated.mjs');

    assert.strictEqual(
      schemas.CreativeManifestSchema.safeParse({
        format_kind: 'display_tag',
        assets: { tag_url: { asset_type: 'url' } },
      }).success,
      false,
      'URL assets must include url'
    );
    assert.strictEqual(
      schemas.CreativeManifestSchema.safeParse({
        format_kind: 'display_tag',
        assets: { tag_url: [] },
      }).success,
      false,
      'multi-value asset slots must be non-empty'
    );
    assert.strictEqual(
      schemas.CreativeManifestSchema.safeParse({
        format_kind: 'display_tag',
        assets: {
          tag_url: { asset_type: 'url', url: 'https://creative.example/tag.js' },
        },
      }).success,
      true
    );
    assert.strictEqual(
      schemas.CreativeManifestSchema.safeParse({ assets: {} }).success,
      false,
      'a manifest requires exactly one identity branch'
    );
    assert.strictEqual(
      schemas.CreativeManifestSchema.safeParse({
        format_kind: 'display_tag',
        format_id: { agent_url: 'https://legacy.example', id: 'display_tag' },
        assets: {},
      }).success,
      false,
      'legacy and canonical identities are mutually exclusive'
    );
    assert.strictEqual(
      schemas.CreativeManifestSchema.safeParse({
        format_kind: 'display_tag',
        assets: { 'x-vendor-extension': { vendor_payload: true } },
      }).success,
      true,
      'nonmatching extension keys remain allowed by additionalProperties'
    );

    const assetBase = { creative_id: 'creative_1', name: 'Creative', format_kind: 'display_tag' };
    assert.strictEqual(
      schemas.CreativeAssetSchema.safeParse({
        ...assetBase,
        assets: { tag_url: { asset_type: 'url' } },
      }).success,
      false,
      'creative library assets apply the same slot validation'
    );
    assert.strictEqual(
      schemas.CreativeAssetSchema.safeParse({
        ...assetBase,
        assets: {
          tag_url: [
            { asset_type: 'url', url: 'https://creative.example/one.js' },
            { asset_type: 'url', url: 'https://creative.example/two.js' },
          ],
        },
      }).success,
      true,
      'creative library assets accept populated variant arrays'
    );
    assert.strictEqual(
      schemas.CreativeAssetSchema.safeParse({
        ...assetBase,
        assets: { 'x-vendor-extension': { vendor_payload: true } },
      }).success,
      true,
      'creative library assets preserve extension keys'
    );
  });

  test('creative runtime validation does not inflate MCP JSON schemas', async () => {
    const schemas = await import('../../dist/lib/types/schemas.generated.mjs');
    const inputSchema = z.toJSONSchema(schemas.CreativeManifestSchema);

    assert.deepStrictEqual(
      inputSchema.properties.assets.additionalProperties,
      {},
      'runtime-only slot validation must not expand AssetVariant into MCP discovery schemas'
    );
  });

  test('GetMediaBuysRequestSchema validates valid request', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetMediaBuysRequestSchema, 'GetMediaBuysRequestSchema should exist');

    const validRequest = {
      account: { account_id: 'acc_123' },
      media_buy_ids: ['mb_123', 'mb_456'],
      include_snapshot: true,
    };

    const result = schemas.GetMediaBuysRequestSchema.safeParse(validRequest);
    assert.ok(result.success, `GetMediaBuysRequest validation should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysRequestSchema validates request with only required account field', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({ account: { account_id: 'acc_123' } });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with only account should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysRequestSchema validates status_filter as single value', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      account: { account_id: 'acc_123' },
      status_filter: 'active',
    });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with single status_filter should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysRequestSchema validates status_filter as array', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      account: { account_id: 'acc_123' },
      status_filter: ['active', 'paused'],
    });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with array status_filter should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates valid response', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetMediaBuysResponseSchema, 'GetMediaBuysResponseSchema should exist');

    const validResponse = {
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_123',
          buyer_ref: 'buyer-ref-1',
          buyer_campaign_ref: 'Q4_Campaign',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          confirmed_at: '2026-01-15T10:00:00Z',
          revision: 1,
          packages: [
            {
              package_id: 'pkg_1',
              budget: 25000,
              creative_approvals: [
                {
                  creative_id: 'cr_1',
                  approval_status: 'approved',
                },
              ],
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse validation should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema rejects creative approvals missing creative_id', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const responseWithApproval = approval => ({
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_123',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          confirmed_at: '2026-01-15T10:00:00Z',
          revision: 1,
          packages: [{ package_id: 'pkg_1', creative_approvals: [approval] }],
        },
      ],
    });

    assert.equal(
      schemas.GetMediaBuysResponseSchema.safeParse(responseWithApproval({ approval_status: 'approved' })).success,
      false
    );
    assert.equal(
      schemas.GetMediaBuysResponseSchema.safeParse(
        responseWithApproval({ indicator_types_evaluated: ['creative_fatigue'] })
      ).success,
      false
    );
    assert.equal(
      schemas.GetMediaBuysResponseSchema.safeParse(
        responseWithApproval({ creative_id: 'creative-1', approval_status: 'approved' })
      ).success,
      true
    );
  });

  test('GetMediaBuysResponseSchema validates response with snapshot', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_123',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          confirmed_at: '2026-01-15T10:00:00Z',
          revision: 1,
          packages: [
            {
              package_id: 'pkg_1',
              snapshot: {
                as_of: '2026-02-22T12:00:00Z',
                staleness_seconds: 900,
                impressions: 12500,
                spend: 1250.5,
                delivery_status: 'delivering',
                pacing_index: 1.05,
              },
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with snapshot should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('CreativeApprovalStatusSchema rejects invalid creative approval status', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.CreativeApprovalStatusSchema.safeParse('invalid_status');
    assert.ok(!result.success, 'CreativeApprovalStatusSchema with invalid approval_status should fail');
  });

  test('MediaBuySchema rejects media buy missing required fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // Missing required: status, confirmed_at, total_budget, packages, revision
    const invalidMediaBuy = {
      media_buy_id: 'mb_123',
    };

    const result = schemas.MediaBuySchema.safeParse(invalidMediaBuy);
    assert.ok(!result.success, 'MediaBuy with missing required fields should fail');
  });

  // --- Lifecycle field tests ---

  test('GetMediaBuysRequestSchema validates request with include_history', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      account: { account_id: 'acc_123' },
      media_buy_ids: ['mb_123'],
      include_history: 10,
    });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with include_history should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates response with lifecycle fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_123',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          confirmed_at: '2026-01-15T10:00:00Z',
          revision: 3,
          valid_actions: ['pause', 'cancel', 'update_budget'],
          packages: [
            {
              package_id: 'pkg_1',
              budget: 25000,
              creative_deadline: '2026-02-01T23:59:59Z',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with lifecycle fields should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates canceled media buy with cancellation fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_456',
          status: 'canceled',
          currency: 'USD',
          total_budget: 30000,
          confirmed_at: '2026-01-10T08:00:00Z',
          canceled_at: '2026-01-20T14:30:00Z',
          canceled_by: 'buyer',
          cancellation_reason: 'Campaign strategy changed',
          revision: 5,
          valid_actions: [],
          packages: [
            {
              package_id: 'pkg_2',
              budget: 30000,
              canceled: true,
              canceled_at: '2026-01-20T14:30:00Z',
              canceled_by: 'buyer',
              cancellation_reason: 'Parent media buy canceled',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with canceled media buy should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates response with history entries', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_789',
          status: 'active',
          currency: 'USD',
          total_budget: 25000,
          confirmed_at: '2026-01-15T10:00:00Z',
          revision: 3,
          history: [
            { revision: 3, timestamp: '2026-01-18T12:00:00Z', action: 'resumed', actor: 'buyer-agent' },
            {
              revision: 2,
              timestamp: '2026-01-17T10:00:00Z',
              action: 'paused',
              actor: 'buyer-agent',
              summary: 'Paused for budget review',
            },
            {
              revision: 1,
              timestamp: '2026-01-15T10:00:00Z',
              action: 'created',
              summary: 'Created with 2 packages, budget $25,000',
            },
          ],
          packages: [{ package_id: 'pkg_1', budget: 25000 }],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with history should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema rejects history entries missing revision', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const invalidResponse = {
      status: 'completed',
      media_buys: [
        {
          media_buy_id: 'mb_789',
          status: 'active',
          currency: 'USD',
          total_budget: 25000,
          packages: [{ package_id: 'pkg_1', budget: 25000 }],
          history: [{ timestamp: '2026-01-18T12:00:00Z', action: 'resumed' }],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(invalidResponse);
    assert.ok(!result.success, 'GetMediaBuysResponse history entry without revision should fail');
    assert.ok(
      result.error.issues.some(issue => issue.path.join('.') === 'media_buys.0.history.0.revision'),
      `Expected history revision error, got: ${JSON.stringify(result.error.issues)}`
    );
  });

  test('MediaBuySchema validates media buy with lifecycle fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.MediaBuySchema.safeParse({
      media_buy_id: 'mb_123',
      status: 'canceled',
      promoted_offering: 'Test Campaign',
      total_budget: 10000,
      confirmed_at: '2026-01-10T08:00:00Z',
      canceled_at: '2026-01-15T12:00:00Z',
      canceled_by: 'seller',
      cancellation_reason: 'Policy violation',
      revision: 4,
      packages: [],
    });
    assert.ok(result.success, `MediaBuy with lifecycle fields should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetCreativeFeaturesRequestSchema validates valid request', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetCreativeFeaturesRequestSchema, 'GetCreativeFeaturesRequestSchema should exist');

    const result = schemas.GetCreativeFeaturesRequestSchema.safeParse({
      creative_manifest: {
        format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
        assets: { banner: { asset_type: 'image', url: 'https://example.com/banner.jpg', width: 300, height: 250 } },
      },
      feature_ids: ['viewability', 'brand_safety'],
    });
    assert.ok(
      result.success,
      `GetCreativeFeaturesRequest validation should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetCreativeFeaturesResponseSchema is importable', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetCreativeFeaturesResponseSchema, 'GetCreativeFeaturesResponseSchema should exist');
    assert.ok(typeof schemas.GetCreativeFeaturesResponseSchema.safeParse === 'function');
  });

  test('object schemas preserve unknown fields (passthrough)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // BrandReferenceSchema is a simple object schema — unknown fields should be preserved
    const input = {
      domain: 'example.com',
      brand_id: 'brand_123',
      platform_specific_field: 'should be kept',
    };

    const result = schemas.BrandReferenceSchema.safeParse(input);
    assert.ok(
      result.success,
      `BrandReference with extra field should succeed: ${JSON.stringify(result.error?.issues)}`
    );
    assert.strictEqual(
      result.data.platform_specific_field,
      'should be kept',
      'Extra field should be preserved after parsing'
    );
  });

  test('nested object schemas preserve unknown fields (passthrough)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // MediaBuySchema contains nested objects — verify unknown fields are kept at all levels
    const result = schemas.MediaBuySchema.safeParse({
      media_buy_id: 'mb_123',
      status: 'active',
      promoted_offering: 'Test Campaign',
      confirmed_at: '2026-01-15T10:00:00Z',
      revision: 1,
      total_budget: 10000,
      packages: [],
      vendor_extension: 'top-level extra field',
    });

    assert.ok(result.success, `MediaBuy with extra field should succeed: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(
      result.data.vendor_extension,
      'top-level extra field',
      'Top-level extra field should be preserved'
    );
  });

  test('inline nested object schemas preserve unknown fields (passthrough)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // ProvenanceSchema has inline z.object() definitions for ai_tool, declared_by, c2pa, etc.
    // These nested objects must also have .passthrough() so their unknown fields are kept.
    const result = schemas.ProvenanceSchema.safeParse({
      ai_tool: {
        name: 'DALL-E',
        provider: 'OpenAI',
        extra_platform_field: 'should be kept inside nested object',
      },
    });

    assert.ok(
      result.success,
      `Provenance with nested extra field should succeed: ${JSON.stringify(result.error?.issues)}`
    );
    assert.strictEqual(
      result.data.ai_tool.extra_platform_field,
      'should be kept inside nested object',
      'Unknown fields inside nested inline objects should be preserved'
    );
  });

  test('all schemas convert to JSON Schema without errors', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const { toJSONSchema } = await import('zod/v4');

    const failures = [];
    for (const [name, value] of Object.entries(schemas)) {
      if (!name.endsWith('Schema')) continue;
      if (!value || typeof value.safeParse !== 'function') continue;

      try {
        toJSONSchema(value);
      } catch (err) {
        failures.push({ name, error: err.message });
      }
    }

    assert.strictEqual(
      failures.length,
      0,
      `${failures.length} schemas failed JSON Schema conversion:\n` +
        failures.map(f => `  ${f.name}: ${f.error}`).join('\n')
    );
  });

  test('schemas with record types have .shape access (not ZodIntersection)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // These schemas previously lost .shape due to .and(z.record(...)) intersections
    const schemasToCheck = [
      'UpdateMediaBuyRequestSchema',
      'PackageUpdateSchema',
      'ProvidePerformanceFeedbackRequestSchema',
      'MediaBuyFeaturesSchema',
    ];

    for (const name of schemasToCheck) {
      const schema = schemas[name];
      assert.ok(schema, `${name} should exist in generated schemas`);

      assert.ok(
        schema.shape !== undefined,
        `${name} should have .shape (got ${schema.constructor?.name || typeof schema})`
      );
    }
  });

  test('schemas with object intersections have object helper access', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const schemasToCheck = [
      'ValidatePropertyDeliveryRequestSchema',
      'TasksGetRequestSchema',
      'TasksGetResponseSchema',
      'ValidatePropertyDeliveryResponseSchema',
      'IndividualImageAssetSchema',
      'GroupVideoAssetSchema',
      'CreativeVariantSchema',
      'CanonicalProposalSchema',
    ];

    for (const name of schemasToCheck) {
      const schema = schemas[name];
      assert.ok(schema, `${name} should exist in generated schemas`);
      assert.ok(schema.shape !== undefined, `${name} should expose .shape`);
      assert.strictEqual(typeof schema.extend, 'function', `${name} should expose .extend()`);
      assert.strictEqual(typeof schema.omit, 'function', `${name} should expose .omit()`);
      assert.strictEqual(typeof schema.pick, 'function', `${name} should expose .pick()`);
    }

    const proposalSchema = schemas.CanonicalProposalSchema;
    const picked = proposalSchema.pick({ proposal_id: true });
    assert.equal(picked.safeParse({ proposal_id: 'proposal-1' }).success, true);
    assert.equal(picked.safeParse({}).success, false);
    const omitted = proposalSchema.omit({ description: true });
    assert.ok(omitted.shape.proposal_id, 'omit() should return an operable object schema');
    const extended = proposalSchema.extend({ extension_field: z.string() });
    assert.ok(extended.shape.extension_field, 'extend() should return an operable object schema');
  });

  test('every generated tool request schema has an MCP input shape', async () => {
    const { TOOL_INPUT_SHAPES, TOOL_REQUEST_SCHEMAS } = await import('../../dist/lib/schemas/index.js');

    const missing = Object.keys(TOOL_REQUEST_SCHEMAS).filter(toolName => !TOOL_INPUT_SHAPES[toolName]);

    assert.deepStrictEqual(missing, []);
    assert.ok(TOOL_INPUT_SHAPES.validate_property_delivery, 'validate_property_delivery should be registered');
    assert.ok(
      TOOL_INPUT_SHAPES.validate_property_delivery.list_id,
      'validate_property_delivery should expose its request fields'
    );
  });

  // ---- Audience governance schemas ----

  test('AudienceSelectorSchema validates signal-type selector', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const signalSelector = {
      type: 'signal',
      signal_id: { source: 'catalog', data_provider_domain: 'signals.example.com', id: 'ev_buyers' },
      value_type: 'binary',
      value: true,
    };

    const result = schemas.AudienceSelectorSchema.safeParse(signalSelector);
    assert.ok(result.success, `Signal selector should validate: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(result.data.type, 'signal');
  });

  test('AudienceSelectorSchema validates description-type selector', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const descSelector = {
      type: 'description',
      description: 'Adults aged 25-54 in urban areas',
      category: 'demographic',
    };

    const result = schemas.AudienceSelectorSchema.safeParse(descSelector);
    assert.ok(result.success, `Description selector should validate: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(result.data.type, 'description');
  });

  test('AudienceSelectorSchema validates categorical signal selector', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const catSelector = {
      type: 'signal',
      signal_id: { source: 'catalog', data_provider_domain: 'signals.example.com', id: 'income_bracket' },
      value_type: 'categorical',
      values: ['high', 'medium'],
    };

    const result = schemas.AudienceSelectorSchema.safeParse(catSelector);
    assert.ok(result.success, `Categorical signal selector should validate: ${JSON.stringify(result.error?.issues)}`);
  });

  test('SignalTargetingExpressionSchema preserves every discriminated branch', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'intent' },
        value_type: 'binary',
        value: true,
      }).success,
      true,
      'binary true must satisfy the binary branch'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'intent' },
        value_type: 'binary',
        value: false,
      }).success,
      false,
      'binary false must not fall through an open-object codegen branch'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'segment' },
        value_type: 'categorical',
        values: ['sports'],
      }).success,
      true,
      'a non-empty categorical selector must satisfy the categorical branch'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'segment' },
        value_type: 'categorical',
        values: [],
      }).success,
      false,
      'categorical selectors require at least one value'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'age' },
        value_type: 'numeric',
        min_value: 25,
      }).success,
      true,
      'a lower-bounded numeric branch must remain available after code generation'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'age' },
        value_type: 'numeric',
        max_value: 54,
      }).success,
      true,
      'an upper-bounded numeric branch must remain available after code generation'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'age' },
        value_type: 'numeric',
      }).success,
      false,
      'a numeric expression must declare at least one bound'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({
        signal_ref: { scope: 'product', signal_id: 'age' },
        value_type: 'numeric',
        min_value: 55,
        max_value: 54,
      }).success,
      false,
      'numeric bounds must be ordered'
    );
    assert.equal(
      schemas.SignalTargetingExpressionSchema.safeParse({ arbitrary: true }).success,
      false,
      'unrelated objects must not satisfy the targeting expression union'
    );
  });

  test('AudienceConstraintsSchema validates include/exclude arrays', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const constraints = {
      include: [{ type: 'description', description: 'Adults 25-54 interested in home improvement' }],
      exclude: [{ type: 'description', description: 'Children under 13' }],
    };

    const result = schemas.AudienceConstraintsSchema.safeParse(constraints);
    assert.ok(result.success, `Audience constraints should validate: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(result.data.include.length, 1);
    assert.strictEqual(result.data.exclude.length, 1);
  });

  test('RestrictedAttributeSchema validates GDPR Article 9 categories', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validValues = [
      'racial_ethnic_origin',
      'political_opinions',
      'religious_beliefs',
      'trade_union_membership',
      'health_data',
      'sex_life_sexual_orientation',
      'genetic_data',
      'biometric_data',
    ];

    for (const value of validValues) {
      const result = schemas.RestrictedAttributeSchema.safeParse(value);
      assert.ok(result.success, `"${value}" should be a valid restricted attribute`);
    }
  });

  test('RestrictedAttributeSchema rejects invalid values', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.RestrictedAttributeSchema.safeParse('financial_status');
    assert.ok(!result.success, 'Non-enum value should be rejected');
  });

  test('MatchIdTypeSchema validates identifier types', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validTypes = ['hashed_email', 'hashed_phone', 'rampid', 'id5', 'uid2', 'euid', 'pairid', 'maid', 'other'];

    for (const idType of validTypes) {
      const result = schemas.MatchIDTypeSchema.safeParse(idType);
      assert.ok(result.success, `"${idType}" should be a valid match ID type`);
    }
  });

  test('MatchIdTypeSchema rejects invalid values', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.MatchIDTypeSchema.safeParse('cookie_id');
    assert.ok(!result.success, 'Non-enum value should be rejected');
  });

  test('SyncPlansRequestSchema validates plan with audience governance fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const planWithAudience = {
      plans: [
        {
          plan_id: 'plan-tylenol-q4',
          brand: { domain: 'tylenol.com' },
          objectives: "Drive awareness of children's Tylenol",
          budget: { total: 500000, currency: 'USD', reallocation_unlimited: true },
          flight: { start: '2026-04-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
          countries: ['US'],
          policy_categories: ['children_directed', 'pharmaceutical_advertising'],
          human_review_required: true,
          audience: {
            include: [{ type: 'description', description: 'Parents of children aged 2-12' }],
            exclude: [{ type: 'description', description: 'Children under 13' }],
          },
          restricted_attributes: ['health_data'],
          restricted_attributes_custom: ['parental_status'],
          min_audience_size: 1000,
          policy_ids: ['us_coppa_data_collection'],
        },
      ],
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
    };

    const result = schemas.SyncPlansRequestSchema.safeParse(planWithAudience);
    assert.ok(result.success, `Plan with audience fields should validate: ${JSON.stringify(result.error?.issues)}`);
  });

  test('SyncPlansRequestSchema rejects invalid restricted_attributes', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const plan = {
      plans: [
        {
          plan_id: 'plan-1',
          brand: { domain: 'example.com' },
          objectives: 'Test',
          budget: { total: 1000, currency: 'USD', reallocation_unlimited: true },
          flight: { start: '2026-04-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
          restricted_attributes: ['invalid_attribute'],
        },
      ],
    };

    const result = schemas.SyncPlansRequestSchema.safeParse(plan);
    assert.ok(!result.success, 'Invalid restricted_attribute value should be rejected');
  });

  test('CheckGovernanceRequestSchema validates delivery_metrics with audience_distribution', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const request = {
      plan_id: 'plan-1',
      binding: 'committed',
      caller: 'https://seller.example.com',
      phase: 'delivery',
      delivery_metrics: {
        reporting_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' },
        spend: 12500,
        cumulative_spend: 125000,
        impressions: 500000,
        cumulative_impressions: 5000000,
        pacing: 'on_track',
        audience_distribution: {
          baseline: 'platform',
          indices: {
            'age:18-24': 0.8,
            'age:25-34': 1.4,
            'gender:female': 1.05,
          },
          cumulative_indices: {
            'age:18-24': 0.85,
            'age:25-34': 1.35,
            'gender:female': 1.03,
          },
        },
      },
    };

    const result = schemas.CheckGovernanceRequestSchema.safeParse(request);
    assert.ok(
      result.success,
      `Delivery metrics with audience_distribution should validate: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('SyncAudiencesSuccessSchema validates response with match breakdown', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const response = {
      audiences: [
        {
          audience_id: 'existing_customers',
          action: 'updated',
          status: 'ready',
          uploaded_count: 5000,
          matched_count: 18750,
          effective_match_rate: 0.75,
          match_breakdown: [
            { id_type: 'hashed_email', submitted: 25000, matched: 17500, match_rate: 0.7 },
            { id_type: 'hashed_phone', submitted: 15000, matched: 12000, match_rate: 0.8 },
            { id_type: 'rampid', submitted: 8000, matched: 7200, match_rate: 0.9 },
          ],
        },
      ],
    };

    const result = schemas.SyncAudiencesSuccessSchema.safeParse(response);
    assert.ok(
      result.success,
      `Sync audiences with match breakdown should validate: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetSignalsResponseSchema validates signals with governance metadata', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const response = {
      status: 'completed',
      signals: [
        {
          signal_id: { source: 'agent', agent_url: 'https://signals.example.com', id: 'sig-001' },
          signal_agent_segment_id: 'seg-001',
          name: 'Chronic Condition Households',
          description: 'Households with modeled indicators of chronic health conditions',
          signal_type: 'marketplace',
          data_provider: 'Health Data Co',
          coverage_percentage: 8.2,
          deployments: [{ type: 'platform', platform: 'dv360', is_live: false }],
          pricing_options: [{ pricing_option_id: 'spo1', model: 'cpm', cpm: 3.5, currency: 'USD' }],
          restricted_attributes: ['health_data'],
          policy_categories: ['pharmaceutical_advertising', 'health_wellness'],
        },
      ],
    };

    const result = schemas.GetSignalsResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Signal with governance metadata should validate: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('activate signal destination/deployment unions preserve platform and agent identities', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const destinations = [
      { type: 'platform', platform: 'the-trade-desk', account: 'seat_123' },
      { type: 'agent', agent_url: 'https://signals.example.com/mcp', account: 'agent_account_456' },
    ];
    const request = schemas.ActivateSignalRequestSchema.safeParse({
      signal_agent_segment_id: 'segment_1',
      destinations,
      idempotency_key: 'activate-signal-union-0001',
    });
    assert.ok(request.success, `Both destination arms should validate: ${JSON.stringify(request.error?.issues)}`);

    const deployments = destinations.map(destination =>
      destination.type === 'platform' ? { ...destination, is_live: false } : { ...destination, is_live: false }
    );
    const response = schemas.ActivateSignalSuccessSchema.safeParse({ deployments });
    assert.ok(response.success, `Both deployment arms should validate: ${JSON.stringify(response.error?.issues)}`);
    assert.deepStrictEqual(response.data.deployments, deployments);
  });

  test('record schemas preserve value types after undefined removal', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // GeographicBreakdownSupportSchema.metro was z.record(z.string(), z.union([z.boolean(), z.undefined()]))
    // Should now be z.record(z.string(), z.boolean()), not z.record(z.string(), z.unknown())
    const geo = schemas.GeographicBreakdownSupportSchema;
    const result = geo.safeParse({ metro: { NYC: 'not-a-boolean' } });
    assert.ok(!result.success, 'metro record should reject non-boolean values');

    const valid = geo.safeParse({ metro: { NYC: true } });
    assert.ok(valid.success, 'metro record should accept boolean values');
  });

  test('PostalAreaSupportSchema enforces country-key and deprecated-alias property names', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(
      schemas.PostalAreaSupportSchema.safeParse({ US: ['zip'], NL: ['postal_code'], us_zip: true }).success,
      'postal support should accept explicit countries, generic future country keys, and deprecated aliases'
    );

    assert.ok(
      !schemas.PostalAreaSupportSchema.safeParse({ nl: ['postal_code'] }).success,
      'postal support should reject lowercase country keys'
    );

    assert.ok(
      !schemas.PostalAreaSupportSchema.safeParse({ foo: ['custom'] }).success,
      'postal support should reject arbitrary property names'
    );

    assert.ok(
      !schemas.PostalAreaSupportSchema.safeParse({ NL: ['outward'] }).success,
      'postal support should keep future country keys restricted to postal_code/custom'
    );
  });

  test('PostalAreaSchema requires a non-empty native values list', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.equal(schemas.PostalAreaSchema.safeParse({ country: 'US', system: 'zip' }).success, false);
    assert.equal(schemas.PostalAreaSchema.safeParse({ country: 'US', system: 'zip', values: [] }).success, false);
    assert.equal(schemas.PostalAreaSchema.safeParse({ country: 'US', system: 'zip', values: ['10001'] }).success, true);
  });

  test('per-asset-type requirements schemas are typed (not z.any)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // Regression guard for #1659: ts-to-zod was emitting z.any() stubs for the 12
    // *AssetRequirementsSchema exports when tools.generated.ts referenced them via
    // a cross-file `import type` block. Verify both that the exports exist and that
    // they actually validate the field-level shape (z.any() would pass anything).
    const exports = [
      ['ImageAssetRequirementsSchema', 'max_animation_duration_ms', 'aspect_ratio'],
      ['VideoAssetRequirementsSchema', 'max_duration_ms', 'frame_rates'],
      ['TextAssetRequirementsSchema', 'max_length', 'prohibited_terms'],
    ];

    for (const [name, knownField] of exports) {
      const schema = schemas[name];
      assert.ok(schema, `${name} should be exported`);
      // z.any() would accept a wrong-shape value. A typed object schema rejects it.
      const wrongShape = schema.safeParse({ [knownField]: { not: 'the right type' } });
      assert.ok(
        !wrongShape.success,
        `${name} should reject wrong-typed ${knownField}; if this passes, the schema is z.any()`
      );
    }

    // AssetRequirementsSchema must be a real union of the 12 typed schemas — not
    // a union of z.any() (which would degenerate to z.any() and validate any value
    // including a primitive). passthrough means stray keys are accepted, so we
    // probe with a non-object value instead.
    assert.ok(schemas.AssetRequirementsSchema, 'AssetRequirementsSchema should be exported');
    const bogus = schemas.AssetRequirementsSchema.safeParse('not-an-object');
    assert.ok(!bogus.success, 'AssetRequirementsSchema should reject non-object values');
  });

  test('RefineProposalsResponseSchema preserves exact canonical and refine-arm requirements', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }
    const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');
    const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');

    const commercial_terms = {
      brand: { domain: 'buyer.example' },
      purchases: [
        {
          product_id: 'product-1',
          pricing_option_id: 'price-1',
          pricing: {
            pricing_option_id: 'price-1',
            pricing_model: 'cpm',
            currency: 'USD',
            fixed_price: 8,
          },
          impressions: 1_000_000,
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      ],
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 8_000, currency: 'USD' },
    };
    const canonicalProposal = (status, suffix) => ({
      proposal_id: `proposal-${suffix}`,
      proposal_kind: 'new_media_buy',
      parent_proposal_id: 'proposal-source',
      proposal_status: status,
      name: `Proposal ${suffix}`,
      commercial_terms,
      terms_digest: proposalTermsDigest(commercial_terms),
      ...(status === 'committed' && { expires_at: '2027-01-02T00:00:00Z' }),
    });
    const completed = result => ({ status: 'completed', results: [result], products: [] });
    const dateEdgeProposal = (suffix, expires_at) => ({
      ...canonicalProposal('draft', suffix),
      expires_at,
    });
    const dateEdges = [
      ['lowercase-date', '2027-01-02t00:00:00z'],
      ['leap-second', '2016-12-31T23:59:60Z'],
      ['space-separator', '2027-01-02 00:00:00Z'],
      ['compact-offset', '2027-01-02T00:00:00+0100'],
    ];
    const exactValidator = getSchemaValidatorByRef('media-buy/refine-proposals-response.json');
    assert.ok(exactValidator, 'exact refine_proposals response validator should be available');
    const exactAccepts = payload => exactValidator(payload);
    const zodAccepts = payload => schemas.RefineProposalsResponseSchema.safeParse(payload).success;

    const valid = [
      { status: 'submitted', task_id: 'task-refine-1' },
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: [canonicalProposal('draft', 'revised')],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'partial')],
        reason_code: 'commercially_declined',
        reason: 'Only part of the request can be offered',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'finalized',
        proposal: {
          ...canonicalProposal('committed', 'finalized'),
          expires_at: '2027-01-02T01:00:00+01:00',
        },
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: dateEdges.map(([suffix, expiresAt]) => dateEdgeProposal(suffix, expiresAt)),
      }),
      ...dateEdges.map(([suffix, expiresAt]) =>
        completed({
          source_proposal_id: 'proposal-source',
          outcome: 'finalized',
          proposal: {
            ...canonicalProposal('committed', `finalized-${suffix}`),
            expires_at: expiresAt,
          },
        })
      ),
    ];
    const incomplete = [
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: [{ proposal_status: 'draft', parent_proposal_id: 'proposal-source' }],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [{ proposal_status: 'draft', parent_proposal_id: 'proposal-source' }],
        reason_code: 'commercially_declined',
        reason: 'Only part of the request can be offered',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'finalized',
        proposal: {
          proposal_status: 'committed',
          parent_proposal_id: 'proposal-source',
          expires_at: '2027-01-02T00:00:00Z',
        },
      }),
    ];
    const missingParentDraft = canonicalProposal('draft', 'missing-parent');
    delete missingParentDraft.parent_proposal_id;
    const missingParentCommitted = canonicalProposal('committed', 'missing-parent-finalized');
    delete missingParentCommitted.parent_proposal_id;
    const missingExpiry = canonicalProposal('committed', 'missing-expiry');
    delete missingExpiry.expires_at;
    const emptyProposalId = canonicalProposal('draft', 'empty-id');
    emptyProposalId.proposal_id = '';
    const malformedDigest = canonicalProposal('draft', 'bad-digest');
    malformedDigest.terms_digest = 'sha256:not-a-digest';
    const invalidExpiry = canonicalProposal('committed', 'invalid-expiry');
    invalidExpiry.expires_at = 'tomorrow';
    const invalidOptionalExpiry = canonicalProposal('draft', 'invalid-optional-expiry');
    invalidOptionalExpiry.expires_at = 'tomorrow';
    const invalidOptionalAcceptedAt = canonicalProposal('draft', 'invalid-optional-accepted-at');
    invalidOptionalAcceptedAt.accepted_at = 'tomorrow';
    const emptyPurchases = canonicalProposal('draft', 'empty-purchases');
    emptyPurchases.commercial_terms = { ...commercial_terms, purchases: [] };
    const missingResolvedPurchase = canonicalProposal('draft', 'missing-resolved-purchase');
    missingResolvedPurchase.commercial_terms = {
      ...commercial_terms,
      purchases: [{ product_id: 'product-1', pricing_option_id: 'price-1' }],
    };
    const invalidCommercialFlight = canonicalProposal('draft', 'invalid-commercial-flight');
    invalidCommercialFlight.commercial_terms = { ...commercial_terms, end_time: 'tomorrow' };
    const invalidCommercialBudget = canonicalProposal('draft', 'invalid-commercial-budget');
    invalidCommercialBudget.commercial_terms = {
      ...commercial_terms,
      total_budget: { amount: -1, currency: 'usd' },
    };
    const proposalWithTargetingOverlay = (suffix, targeting_overlay) => {
      const proposal = canonicalProposal('draft', suffix);
      proposal.commercial_terms = {
        ...commercial_terms,
        purchases: [{ ...commercial_terms.purchases[0], targeting_overlay }],
      };
      return proposal;
    };
    const missingFrequencyDependencies = proposalWithTargetingOverlay('frequency-dependencies', {
      frequency_cap: { max_impressions: 3 },
    });
    const missingVerifiedAgeBasis = proposalWithTargetingOverlay('verified-age-basis', {
      demographics: {
        age: {
          min: 18,
          include_unknown: false,
          accepted_verification_methods: ['digital_id'],
          accepted_bases: ['declared'],
        },
      },
    });
    const emptyBiddingPolicy = canonicalProposal('draft', 'empty-bidding-policy');
    emptyBiddingPolicy.commercial_terms = {
      ...commercial_terms,
      purchases: [{ ...commercial_terms.purchases[0], bidding: {} }],
    };
    const incompleteUpdate = {
      ...canonicalProposal('draft', 'incomplete-update'),
      proposal_kind: 'media_buy_update',
    };
    delete incompleteUpdate.media_buy_id;
    delete incompleteUpdate.base_media_buy_revision;
    const missingProducts = completed({
      source_proposal_id: 'proposal-source',
      outcome: 'revised',
      proposals: [canonicalProposal('draft', 'missing-products')],
    });
    delete missingProducts.products;
    const completedWithTaskId = {
      ...completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: [canonicalProposal('draft', 'completed-task-id')],
      }),
      task_id: 'task-not-allowed-on-completed',
    };
    incomplete.push(
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [] }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [],
        reason_code: 'commercially_declined',
        reason: 'No successor was produced',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: [missingParentDraft],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [missingParentDraft],
        reason_code: 'commercially_declined',
        reason: 'Only part of the request can be offered',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'finalized',
        proposal: missingParentCommitted,
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'finalized',
        proposal: missingExpiry,
      }),
      missingProducts,
      { status: 'completed', results: [], products: [] },
      completedWithTaskId,
      {
        status: 'completed',
        results: [
          {
            source_proposal_id: 'proposal-source',
            outcome: 'revised',
            proposals: [canonicalProposal('draft', 'mixed-revised')],
          },
          {
            source_proposal_id: 'proposal-source-2',
            outcome: 'finalized',
            proposal: {
              ...canonicalProposal('committed', 'mixed-finalized'),
              parent_proposal_id: 'proposal-source-2',
            },
          },
        ],
        products: [],
      },
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: [canonicalProposal('draft', 'forbidden-reason')],
        reason: 'not allowed on revised',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'partial-forbidden-proposal')],
        proposal: canonicalProposal('draft', 'partial-singular'),
        reason_code: 'commercially_declined',
        reason: 'Partial response',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'finalized',
        proposal: canonicalProposal('committed', 'finalized-forbidden-proposals'),
        proposals: [canonicalProposal('draft', 'finalized-draft')],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'unable',
        reason_code: 'source_unavailable',
        reason: 'Source unavailable',
        proposal: canonicalProposal('draft', 'unable-forbidden-proposal'),
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'empty-suggestions')],
        reason_code: 'commercially_declined',
        reason: 'Partial response',
        suggestions: [],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'empty-unsatisfied')],
        reason_code: 'commercially_declined',
        reason: 'Partial response',
        unsatisfied_constraints: [],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'unable',
        reason_code: 'constraint_unsatisfiable',
        reason: 'No matching terms',
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'duplicate-constraints')],
        reason_code: 'constraint_unsatisfiable',
        reason: 'Repeated constraint keys',
        unsatisfied_constraints: ['budget', 'budget'],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'empty-constraint-name')],
        reason_code: 'constraint_unsatisfiable',
        reason: 'Empty constraint key',
        unsatisfied_constraints: [''],
      }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'partial',
        proposals: [canonicalProposal('draft', 'empty-suggestion')],
        reason_code: 'commercially_declined',
        reason: 'Empty suggestion',
        suggestions: [''],
      }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [emptyProposalId] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [malformedDigest] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [incompleteUpdate] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'finalized', proposal: invalidExpiry }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [invalidOptionalExpiry] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [invalidOptionalAcceptedAt] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [emptyPurchases] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [missingResolvedPurchase] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [invalidCommercialFlight] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [invalidCommercialBudget] }),
      completed({
        source_proposal_id: 'proposal-source',
        outcome: 'revised',
        proposals: [missingFrequencyDependencies],
      }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [missingVerifiedAgeBasis] }),
      completed({ source_proposal_id: 'proposal-source', outcome: 'revised', proposals: [emptyBiddingPolicy] }),
      {
        status: 'submitted',
        task_id: 'task-mixed-results',
        results: [
          {
            source_proposal_id: 'proposal-source',
            outcome: 'revised',
            proposals: [canonicalProposal('draft', 'submitted-revised')],
          },
          {
            source_proposal_id: 'proposal-source-2',
            outcome: 'finalized',
            proposal: {
              ...canonicalProposal('committed', 'submitted-finalized'),
              parent_proposal_id: 'proposal-source-2',
            },
          },
        ],
      }
    );

    for (const [index, payload] of valid.entries()) {
      assert.equal(exactAccepts(payload), true, 'exact schema should accept a complete canonical proposal');
      const parsed = schemas.RefineProposalsResponseSchema.safeParse(payload);
      assert.equal(
        parsed.success,
        true,
        `public Zod schema should accept complete canonical proposal ${index}: ${JSON.stringify(parsed.error?.issues)}`
      );
    }
    for (const [index, payload] of incomplete.entries()) {
      assert.equal(exactAccepts(payload), false, `exact schema should reject incomplete case ${index}`);
      assert.equal(
        zodAccepts(payload),
        false,
        `public Zod schema must reject incomplete case ${index}: ${JSON.stringify(payload)}`
      );
    }
  });
});
