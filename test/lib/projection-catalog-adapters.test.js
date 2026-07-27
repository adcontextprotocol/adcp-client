const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalFormatLegacyResolverFromCatalogSnapshots,
  projectionAdaptersFromCatalogSnapshots,
  projectV1ProductToV2,
  projectV2ProductToV1,
} = require('../../dist/lib/v2/projection/index.js');

const legacyRef = {
  agent_url: 'https://formats.vox.example/mcp',
  id: 'vox_mrec_html',
  width: 300,
  height: 250,
};

function snapshot(overrides = {}) {
  return {
    source: 'configured',
    publisher_domain: 'vox.example',
    formats: [
      {
        format_kind: 'display_tag',
        format_option_id: 'vox_mrec_html',
        params: { width: 300, height: 250 },
        v1_format_ref: [legacyRef],
        ...overrides,
      },
    ],
  };
}

function legacyProduct() {
  return {
    product_id: 'vox-homepage',
    name: 'Vox homepage',
    description: 'Legacy seller compatibility fixture',
    format_ids: [legacyRef],
  };
}

describe('projection catalog adapters', () => {
  test('round-trips one owner-scoped catalog across a persistence boundary', () => {
    const adapters = projectionAdaptersFromCatalogSnapshots([snapshot()]);
    const projected = projectV1ProductToV2(legacyProduct(), adapters);
    assert.deepStrictEqual(projected.diagnostics, []);
    assert.strictEqual(projected.v2.format_options[0].format_kind, 'display_tag');
    assert.strictEqual(projected.v2.format_options[0].publisher_domain, 'vox.example');

    // JSON round-trip deliberately removes all SDK-private WeakMap metadata.
    const persisted = JSON.parse(JSON.stringify(projected.v2));
    delete persisted.format_options[0].v1_format_ref;
    const downgraded = projectV2ProductToV1(persisted, adapters);
    assert.deepStrictEqual(downgraded.diagnostics, []);
    assert.deepStrictEqual(downgraded.v1.format_ids, [legacyRef]);
  });

  test('resolves creative and selector contexts from stable format option refs', () => {
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots([snapshot()]);
    assert.ok(resolver);

    const creative = resolver({
      source: 'creative',
      creative: {
        format_kind: 'display_tag',
        format_option_ref: {
          scope: 'publisher',
          publisher_domain: 'VOX.EXAMPLE.',
          format_option_id: 'vox_mrec_html',
        },
      },
      selector: {},
      operation: 'sync_creatives',
      field: 'creatives[0]',
    });
    assert.deepStrictEqual(creative, [legacyRef]);

    const selector = resolver({
      source: 'selector',
      selector: {
        format_option_refs: [
          {
            scope: 'publisher',
            publisher_domain: 'vox.example',
            format_option_id: 'vox_mrec_html',
          },
        ],
      },
      operation: 'create_media_buy',
      field: 'packages[0]',
    });
    assert.deepStrictEqual(selector, [legacyRef]);

    const declarationSelector = resolver({
      source: 'selector',
      selector: {
        format_options: [
          {
            publisher_domain: 'vox.example',
            format_option_id: 'vox_mrec_html',
            format_kind: 'display_tag',
            params: { width: 300, height: 250 },
          },
        ],
      },
      operation: 'sync_creatives',
      field: 'selector_containers[0]',
    });
    assert.deepStrictEqual(declarationSelector, [legacyRef]);
  });

  test('does not emit a partial reverse mapping for a multi-option selector', () => {
    let fallbackCalls = 0;
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots([snapshot()], () => {
      fallbackCalls++;
      return undefined;
    });
    const result = resolver({
      source: 'selector',
      selector: {
        format_option_refs: [
          { scope: 'publisher', publisher_domain: 'vox.example', format_option_id: 'vox_mrec_html' },
          { scope: 'publisher', publisher_domain: 'vox.example', format_option_id: 'unknown' },
        ],
      },
      operation: 'create_media_buy',
      field: 'packages[0]',
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(fallbackCalls, 1);
  });

  test('canonical-only declarations never become reverse legacy adapters', () => {
    let fallbackCalls = 0;
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots(
      [snapshot({ canonical_formats_only: true })],
      () => {
        fallbackCalls++;
        return undefined;
      }
    );
    const result = resolver({
      source: 'product',
      declaration: {
        format_kind: 'display_tag',
        format_option_id: 'vox_mrec_html',
        publisher_domain: 'vox.example',
        params: { width: 300, height: 250 },
      },
      productId: 'vox-homepage',
      field: 'format_options[0]',
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(fallbackCalls, 1);

    const forward = projectV1ProductToV2(legacyProduct(), {
      projectionCatalogs: [snapshot({ canonical_formats_only: true })],
    });
    assert.deepStrictEqual(forward.v2.format_options, []);
    assert.strictEqual(forward.diagnostics[0].error.details.resolution_failure, 'no_match');
  });

  test('public canonical-only Snap declarations never authorize a guessed legacy route', () => {
    const snapMirror = snapshot({
      format_kind: 'image',
      format_option_id: 'snap_ad_image_9x16',
      publisher_domain: 'snapchat.com',
      params: { width: 1080, height: 1920 },
      canonical_formats_only: true,
      v1_format_ref: [{ agent_url: 'https://snapchat.com', id: 'snap_ad_image_9x16' }],
    });
    snapMirror.publisher_domain = 'snapchat.com';
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots([snapMirror]);
    assert.strictEqual(
      resolver({
        source: 'creative',
        creative: {
          format_kind: 'image',
          format_option_ref: {
            scope: 'publisher',
            publisher_domain: 'snapchat.com',
            format_option_id: 'snap_ad_image_9x16',
          },
        },
        selector: {},
        operation: 'sync_creatives',
        field: 'creatives[0]',
      }),
      undefined
    );
  });

  test('reverse routes reject contradictory canonical kinds and params', () => {
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots([snapshot()]);
    assert.strictEqual(
      resolver({
        source: 'creative',
        creative: {
          format_kind: 'video_hosted',
          format_option_ref: {
            scope: 'publisher',
            publisher_domain: 'vox.example',
            format_option_id: 'vox_mrec_html',
          },
        },
        selector: {},
        operation: 'sync_creatives',
        field: 'creatives[0]',
      }),
      undefined
    );
    assert.strictEqual(
      resolver({
        source: 'selector',
        selector: {
          format_kind: 'display_tag',
          params: { width: 728, height: 90 },
          format_option_refs: [
            { scope: 'publisher', publisher_domain: 'vox.example', format_option_id: 'vox_mrec_html' },
          ],
        },
        operation: 'create_media_buy',
        field: 'packages[0]',
      }),
      undefined
    );
  });

  test('structurally non-translatable canonicals never compile as legacy routes', () => {
    const carousel = snapshot({
      format_kind: 'image_carousel',
      format_option_id: 'vox_carousel',
      params: { min_items: 2, max_items: 4 },
      v1_format_ref: [{ ...legacyRef, id: 'vox_carousel' }],
    });
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots([carousel]);
    assert.strictEqual(
      resolver({
        source: 'product',
        declaration: {
          format_kind: 'image_carousel',
          format_option_id: 'vox_carousel',
          publisher_domain: 'vox.example',
          params: { min_items: 2, max_items: 4 },
        },
        productId: 'vox-carousel',
        field: 'format_options[0]',
      }),
      undefined
    );
    assert.throws(() => projectionAdaptersFromCatalogSnapshots([carousel]), /canonical-only format kind/);
  });

  test('legacy agent URL identity preserves a distinct terminal slash', () => {
    const slashSnapshot = snapshot({
      v1_format_ref: [legacyRef, { ...legacyRef, agent_url: `${legacyRef.agent_url}/` }],
    });
    assert.throws(() => projectionAdaptersFromCatalogSnapshots([slashSnapshot]), /exactly one legacy route/);
  });

  test('duplicate canonical aliases at one precedence tier fail closed', () => {
    const duplicate = snapshot();
    duplicate.formats.push({ ...duplicate.formats[0], v1_format_ref: [{ ...legacyRef, id: 'other_vox_mrec' }] });
    const resolver = canonicalFormatLegacyResolverFromCatalogSnapshots([duplicate]);
    assert.throws(
      () =>
        resolver({
          source: 'product',
          declaration: {
            format_kind: 'display_tag',
            format_option_id: 'vox_mrec_html',
            publisher_domain: 'vox.example',
            params: {},
          },
          productId: 'vox-homepage',
          field: 'format_options[0]',
        }),
      /ambiguous canonical format option aliases/
    );
  });

  test('bidirectional helper rejects unsafe product-local and many-to-one routes', () => {
    assert.throws(
      () => projectionAdaptersFromCatalogSnapshots([{ ...snapshot(), publisher_domain: undefined }]),
      /publisher-scoped format options/
    );
    assert.throws(
      () =>
        projectionAdaptersFromCatalogSnapshots([
          snapshot({
            v1_format_ref: [legacyRef, { ...legacyRef, id: 'vox_leaderboard_html', width: 728, height: 90 }],
          }),
        ]),
      /exactly one legacy route/
    );
  });

  test('bidirectional helper rejects reverse-route conflicts across precedence tiers', () => {
    assert.throws(
      () =>
        projectionAdaptersFromCatalogSnapshots([
          snapshot(),
          {
            ...snapshot(),
            source: 'aao_mirror',
            formats: [
              {
                ...snapshot().formats[0],
                v1_format_ref: [{ ...legacyRef, agent_url: 'https://mirror.vox.example/mcp' }],
              },
            ],
          },
        ]),
      /conflicting reverse routes/
    );
  });

  test('bidirectional helper rejects one legacy route claimed by two canonical options', () => {
    const ambiguous = snapshot();
    ambiguous.formats.push({
      ...ambiguous.formats[0],
      format_kind: 'image',
      format_option_id: 'vox_mrec_image',
    });
    assert.throws(() => projectionAdaptersFromCatalogSnapshots([ambiguous]), /conflicting forward routes/);
  });

  test('bidirectional helper rejects duplicate declarations at one precedence tier', () => {
    const duplicate = snapshot();
    duplicate.formats.push(structuredClone(duplicate.formats[0]));
    assert.throws(() => projectionAdaptersFromCatalogSnapshots([duplicate]), /duplicate declarations/);
  });
});
