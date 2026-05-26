const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  CanonicalFormat,
  formatRef,
  formatRefs,
  imageFormatDeclaration,
  productCard,
  productCardDetailed,
} = require('../../dist/lib/v2/projection');
const root = require('../../dist/lib');

describe('canonical creative format helpers', () => {
  it('builds structured v1 format references', () => {
    const ref = formatRef('https://creative.adcontextprotocol.org', 'display_300x250_image', {
      width: 300,
      height: 250,
    });

    assert.deepStrictEqual(ref, {
      agent_url: 'https://creative.adcontextprotocol.org',
      id: 'display_300x250_image',
      width: 300,
      height: 250,
    });
  });

  it('copies format reference arrays', () => {
    const source = formatRef('https://creative.adcontextprotocol.org', 'display_728x90_image');
    const refs = formatRefs(source);
    refs[0].id = 'changed';

    assert.strictEqual(source.id, 'display_728x90_image');
  });

  it('builds canonical image declarations with v1 refs', () => {
    const decl = imageFormatDeclaration(
      { width: 300, height: 250 },
      {
        capability_id: 'homepage_mrec',
        display_name: 'Homepage MREC',
        v1_format_ref: [formatRef('https://creative.adcontextprotocol.org', 'display_300x250_image')],
      }
    );

    assert.strictEqual(decl.format_kind, 'image');
    assert.deepStrictEqual(decl.params, { width: 300, height: 250 });
    assert.strictEqual(decl.capability_id, 'homepage_mrec');
    assert.strictEqual(decl.v1_format_ref[0].id, 'display_300x250_image');
  });

  it('exposes the grouped CanonicalFormat namespace', () => {
    const decl = CanonicalFormat.videoVast(
      { max_duration_ms: 30000 },
      { capability_id: 'vast_30s', v1_format_ref: [CanonicalFormat.ref('https://example.com', 'video_30s')] }
    );

    assert.strictEqual(decl.format_kind, 'video_vast');
    assert.strictEqual(decl.capability_id, 'vast_30s');
  });

  it('exposes all canonical format builders from the root namespace', () => {
    const declarations = [
      root.CanonicalFormat.imageCarousel({ images: [{ width: 300, height: 250 }] }),
      root.CanonicalFormat.sponsoredPlacement({ placement_type: 'native' }),
      root.CanonicalFormat.nativeInFeed({ assets: [] }),
      root.CanonicalFormat.responsiveCreative({ aspect_ratios: ['1:1'] }),
      root.CanonicalFormat.agentPlacement({ requirements: {} }),
    ];

    assert.deepStrictEqual(
      declarations.map(decl => decl.format_kind),
      ['image_carousel', 'sponsored_placement', 'native_in_feed', 'responsive_creative', 'agent_placement']
    );
  });

  it('builds product cards without format references', () => {
    const card = productCard({ title: 'Homepage', price_label: 'From $12 CPM' });
    const detailed = productCardDetailed({
      title: 'Homepage Takeover',
      specifications: [{ label: 'Slot', value: 'Above the fold' }],
    });

    assert.deepStrictEqual(card, { title: 'Homepage', price_label: 'From $12 CPM' });
    assert.deepStrictEqual(detailed.specifications, [{ label: 'Slot', value: 'Above the fold' }]);
    assert.strictEqual('format_id' in card, false);
  });
});
