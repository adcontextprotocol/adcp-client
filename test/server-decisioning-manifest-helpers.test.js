// Tests for getAsset / requireAsset helpers.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { getAsset, getAssetSlot, requireAsset } = require('../dist/lib/server/decisioning/manifest-helpers');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

const sampleManifest = {
  format_id: { id: 'audio_30s', agent_url: 'x' },
  assets: {
    script: { asset_type: 'text', content: 'Hello world.', language: 'en' },
    voice: { asset_type: 'text', content: 'nova' },
    cover_image: { asset_type: 'image', url: 'https://cdn/cover.png' },
  },
};

describe('getAsset', () => {
  it('returns the asset narrowed by discriminator on type match', () => {
    const script = getAsset(sampleManifest, 'script', 'text');
    assert.ok(script);
    assert.strictEqual(script.asset_type, 'text');
    assert.strictEqual(script.content, 'Hello world.');
    assert.strictEqual(script.language, 'en');
  });

  it('returns undefined when asset_id missing', () => {
    const result = getAsset(sampleManifest, 'nonexistent', 'text');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when asset_type does not match', () => {
    const result = getAsset(sampleManifest, 'cover_image', 'text');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when manifest is undefined', () => {
    assert.strictEqual(getAsset(undefined, 'script', 'text'), undefined);
  });

  it('returns undefined when manifest.assets is missing', () => {
    assert.strictEqual(getAsset({ format_id: {} }, 'script', 'text'), undefined);
  });
});

describe('requireAsset', () => {
  it('returns the asset narrowed by discriminator on type match', () => {
    const script = requireAsset(sampleManifest, 'script', 'text');
    assert.strictEqual(script.asset_type, 'text');
    assert.strictEqual(script.content, 'Hello world.');
  });

  it('throws AdcpError(INVALID_REQUEST) when asset_id missing', () => {
    assert.throws(
      () => requireAsset(sampleManifest, 'nonexistent', 'text'),
      err => {
        assert.ok(err instanceof AdcpError);
        assert.strictEqual(err.code, 'INVALID_REQUEST');
        assert.strictEqual(err.recovery, 'correctable');
        assert.match(err.message, /assets\.nonexistent is required/);
        assert.strictEqual(err.field, 'creative_manifest.assets.nonexistent');
        return true;
      }
    );
  });

  it('throws AdcpError(INVALID_REQUEST) with field path when asset_type wrong', () => {
    assert.throws(
      () => requireAsset(sampleManifest, 'cover_image', 'audio'),
      err => {
        assert.ok(err instanceof AdcpError);
        assert.strictEqual(err.code, 'INVALID_REQUEST');
        assert.match(err.message, /must be a audio asset.*got asset_type='image'/);
        assert.strictEqual(err.field, 'creative_manifest.assets.cover_image.asset_type');
        return true;
      }
    );
  });

  it('uses messageOverride when provided', () => {
    assert.throws(
      () => requireAsset(sampleManifest, 'nonexistent', 'text', 'custom message please'),
      err => {
        assert.strictEqual(err.message, 'custom message please');
        return true;
      }
    );
  });

  it('throws when manifest is undefined', () => {
    assert.throws(() => requireAsset(undefined, 'script', 'text'), AdcpError);
  });
});

// AdCP 3.1.0-beta.2 widened each slot from `AssetVariant` to
// `AssetVariant | AssetVariant[]` (carousel cards, responsive_creative
// headlines, etc.). Pin both the single-asset back-compat path and the
// new multi-asset slot accessor.
const carouselManifest = {
  format_id: { id: 'carousel_3x', agent_url: 'x' },
  assets: {
    cards: [
      { asset_type: 'image', url: 'https://cdn/card1.png' },
      { asset_type: 'image', url: 'https://cdn/card2.png' },
      { asset_type: 'image', url: 'https://cdn/card3.png' },
    ],
    cta: { asset_type: 'text', content: 'Shop now' },
  },
};

describe('getAsset — array slot unwrap (3.1.0-beta.2 widening)', () => {
  it('returns the first element when slot is an array', () => {
    const card = getAsset(carouselManifest, 'cards', 'image');
    assert.ok(card);
    assert.strictEqual(card.asset_type, 'image');
    assert.strictEqual(card.url, 'https://cdn/card1.png');
  });

  it('returns undefined when array slot is empty', () => {
    const m = { ...carouselManifest, assets: { ...carouselManifest.assets, cards: [] } };
    assert.strictEqual(getAsset(m, 'cards', 'image'), undefined);
  });

  it('single-asset slot behavior unchanged', () => {
    const cta = getAsset(carouselManifest, 'cta', 'text');
    assert.ok(cta);
    assert.strictEqual(cta.content, 'Shop now');
  });
});

describe('getAssetSlot', () => {
  it('returns the full array for multi-element slots', () => {
    const cards = getAssetSlot(carouselManifest, 'cards', 'image');
    assert.ok(cards);
    assert.strictEqual(cards.length, 3);
    assert.strictEqual(cards[2].url, 'https://cdn/card3.png');
  });

  it('wraps single-asset slots in a one-element array', () => {
    const cta = getAssetSlot(carouselManifest, 'cta', 'text');
    assert.ok(cta);
    assert.strictEqual(cta.length, 1);
    assert.strictEqual(cta[0].content, 'Shop now');
  });

  it('returns undefined when slot is missing', () => {
    assert.strictEqual(getAssetSlot(carouselManifest, 'nonexistent', 'image'), undefined);
  });

  it('filters by asset_type within the slot', () => {
    const mixed = {
      ...carouselManifest,
      assets: {
        ...carouselManifest.assets,
        mixed_slot: [
          { asset_type: 'image', url: 'https://cdn/i.png' },
          { asset_type: 'text', content: 'caption' },
        ],
      },
    };
    const images = getAssetSlot(mixed, 'mixed_slot', 'image');
    assert.ok(images);
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].url, 'https://cdn/i.png');
  });
});
