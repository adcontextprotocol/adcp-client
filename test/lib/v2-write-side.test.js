// formatIdsFromOptions / formatIdsForCapability — write-side ergonomics
// for V2-mental-model buyers constructing create_media_buy requests.
//
// Bridges the spec gap documented at adcontextprotocol/adcp#4842 —
// PackageRequest at 3.1-beta still carries only `format_ids[]`, so V2
// buyers need to translate their chosen `format_options[i]` back through
// `v1_format_ref[]` to write the create call. These helpers are the
// canonical place that bridge lives so adopters don't inline it.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  formatIdsFromOptions,
  tryFormatIdsFromOptions,
  formatIdsForCapability,
} = require('../../dist/lib/v2/projection/index.js');

describe('formatIdsFromOptions', () => {
  test('single-size declaration returns the seller-asserted v1 ref', () => {
    const decl = {
      format_kind: 'image',
      capability_id: 'iab_mrec',
      params: { width: 300, height: 250 },
      v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
    };
    const ids = formatIdsFromOptions(decl);
    assert.strictEqual(ids.length, 1);
    assert.strictEqual(ids[0].id, 'display_300x250_image');
    assert.strictEqual(ids[0].agent_url, 'https://creative.adcontextprotocol.org/');
  });

  test('multi-size declaration returns every seller-asserted v1 ref', () => {
    const decl = {
      format_kind: 'image',
      capability_id: 'nytimes_homepage_image',
      params: {
        sizes: [
          { width: 300, height: 250 },
          { width: 728, height: 90 },
          { width: 970, height: 250 },
        ],
      },
      v1_format_ref: [
        { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' },
        { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_728x90_image' },
        { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_970x250_image' },
      ],
    };
    const ids = formatIdsFromOptions(decl);
    assert.strictEqual(ids.length, 3);
    assert.deepStrictEqual(
      ids.map(i => i.id),
      ['display_300x250_image', 'display_728x90_image', 'display_970x250_image']
    );
  });

  test('canonical_formats_only declaration throws (fail-closed)', () => {
    const decl = {
      format_kind: 'custom',
      format_shape: 'multi_placement_takeover',
      params: {},
      canonical_formats_only: true,
    };
    assert.throws(
      () => formatIdsFromOptions(decl),
      err => /no v1 representation/.test(err.message) && /canonical_formats_only/.test(err.message)
    );
  });

  test('inherently-v2 canonical with no v1_format_ref throws (fail-closed)', () => {
    const decl = {
      format_kind: 'sponsored_placement',
      capability_id: 'amazon_sp',
      params: { source_catalog: 'amazon' },
    };
    assert.throws(
      () => formatIdsFromOptions(decl),
      err => /no v1 representation/.test(err.message) && /amazon_sp/.test(err.message)
    );
  });

  test('tryFormatIdsFromOptions returns [] for declarations with no v1 form', () => {
    // Non-throwing variant — used when iterating to find a v1-purchasable
    // option among many.
    assert.deepStrictEqual(tryFormatIdsFromOptions({ format_kind: 'sponsored_placement', params: {} }), []);
    assert.deepStrictEqual(
      tryFormatIdsFromOptions({ format_kind: 'custom', canonical_formats_only: true, params: {} }),
      []
    );
  });

  test('tryFormatIdsFromOptions matches formatIdsFromOptions on the happy path', () => {
    const decl = {
      format_kind: 'image',
      v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
    };
    assert.deepStrictEqual(tryFormatIdsFromOptions(decl), formatIdsFromOptions(decl));
  });

  test('defensive copy — mutating the result does not affect the source decl', () => {
    const decl = {
      format_kind: 'image',
      v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
    };
    const ids = formatIdsFromOptions(decl);
    ids[0].id = 'mutated';
    assert.strictEqual(decl.v1_format_ref[0].id, 'display_300x250_image');
  });
});

describe('formatIdsForCapability', () => {
  const product = {
    product_id: 'p1',
    format_options: [
      {
        format_kind: 'image',
        capability_id: 'iab_mrec',
        v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
      },
      {
        format_kind: 'video_hosted',
        capability_id: 'video_30s',
        v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'video_standard_30s' }],
      },
    ],
  };

  test('resolves capability_id to its format_ids[]', () => {
    const ids = formatIdsForCapability(product, 'video_30s');
    assert.strictEqual(ids.length, 1);
    assert.strictEqual(ids[0].id, 'video_standard_30s');
  });

  test('throws on unknown capability_id with a helpful message listing the available ids', () => {
    assert.throws(
      () => formatIdsForCapability(product, 'unknown_cap'),
      err => {
        assert.match(err.message, /unknown_cap/);
        assert.match(err.message, /iab_mrec/);
        assert.match(err.message, /video_30s/);
        return true;
      }
    );
  });

  test('throws when product has no format_options[]', () => {
    assert.throws(() => formatIdsForCapability({}, 'iab_mrec'), /not found/);
  });
});
