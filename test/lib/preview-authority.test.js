const { describe, test } = require('node:test');
const assert = require('node:assert');

const { resolvePreviewAuthority } = require('../../dist/lib/utils/preview-authority.js');

const manifest = { format_id: 'display/image' };

describe('resolvePreviewAuthority', () => {
  test('selects authoritative seller truth before every fallback', () => {
    const result = resolvePreviewAuthority({
      sellerPreview: { fidelity: 'authoritative', value: 'seller' },
      targetPlacementId: 'home',
      publisherPreviewProvider: { placementId: 'home', value: 'provider' },
      publisherPresentation: { placementId: 'home', value: 'presentation' },
      communityReference: 'community',
      manifest,
    });

    assert.deepStrictEqual(result.selected, {
      kind: 'serving_platform',
      authoritative: true,
      value: 'seller',
    });
  });

  test('keeps representative seller output secondary to publisher authority', () => {
    const result = resolvePreviewAuthority({
      sellerPreview: { fidelity: 'representative', value: 'seller approximation' },
      targetPlacementId: 'home',
      publisherPreviewProvider: { placementId: 'home', value: 'provider' },
      publisherPresentation: { placementId: 'home', value: 'presentation' },
      communityReference: 'community',
      manifest,
    });

    assert.deepStrictEqual(result.selected, {
      kind: 'publisher_preview_provider',
      authoritative: true,
      placementId: 'home',
      value: 'provider',
    });
    assert.strictEqual(result.representativeSellerPreview, 'seller approximation');
  });

  test('selects placement presentation after the placement preview provider', () => {
    const result = resolvePreviewAuthority({
      targetPlacementId: 'home',
      publisherPresentation: { placementId: 'home', value: 'presentation' },
      communityReference: 'community',
      manifest,
    });

    assert.deepStrictEqual(result.selected, {
      kind: 'publisher_presentation',
      authoritative: true,
      placementId: 'home',
      value: 'presentation',
    });
  });

  test('fails closed on placement mismatch and records ignored candidates', () => {
    const result = resolvePreviewAuthority({
      targetPlacementId: 'article',
      publisherPreviewProvider: { placementId: 'home', value: 'wrong provider' },
      publisherPresentation: { placementId: 'home', value: 'wrong presentation' },
      communityReference: 'community',
      manifest,
    });

    assert.deepStrictEqual(result.selected, {
      kind: 'community_reference',
      authoritative: false,
      value: 'community',
    });
    assert.deepStrictEqual(result.ignoredPlacementCandidates, ['publisher_preview_provider', 'publisher_presentation']);
  });

  test('uses the canonical manifest only after the community reference', () => {
    const community = resolvePreviewAuthority({ communityReference: 'community', manifest });
    const canonical = resolvePreviewAuthority({ manifest });

    assert.strictEqual(community.selected.kind, 'community_reference');
    assert.deepStrictEqual(canonical.selected, {
      kind: 'manifest',
      authoritative: false,
      value: manifest,
    });
  });
});
