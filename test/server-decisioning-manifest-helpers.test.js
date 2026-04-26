// Tests for getAsset / requireAsset helpers.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { getAsset, requireAsset } = require('../dist/lib/server/decisioning/manifest-helpers');
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
