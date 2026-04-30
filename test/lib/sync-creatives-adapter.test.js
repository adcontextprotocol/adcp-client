const { test, describe } = require('node:test');
const assert = require('node:assert');

const { adaptSyncCreativesRequestForV2 } = require('../../dist/lib/utils/sync-creatives-adapter.js');

const BASE_REQUEST = {
  account: { account_id: 'acct-1' },
  idempotency_key: '33333333-3333-3333-3333-333333333333',
  creatives: [],
};

describe('adaptSyncCreativesRequestForV2 — top-level field stripping', () => {
  test('strips account', () => {
    const result = adaptSyncCreativesRequestForV2({ ...BASE_REQUEST });
    assert.strictEqual(result.account, undefined);
  });

  test('strips adcp_major_version', () => {
    const result = adaptSyncCreativesRequestForV2({ ...BASE_REQUEST, adcp_major_version: 3 });
    assert.strictEqual(result.adcp_major_version, undefined);
  });

  test('preserves idempotency_key', () => {
    const result = adaptSyncCreativesRequestForV2({ ...BASE_REQUEST });
    assert.strictEqual(result.idempotency_key, BASE_REQUEST.idempotency_key);
  });
});

describe('adaptSyncCreativesRequestForV2 — idempotency', () => {
  test('same input produces identical output on repeated calls', () => {
    const input = {
      ...BASE_REQUEST,
      creatives: [
        {
          creative_id: 'cre-1',
          assets: { video: { asset_type: 'video', url: 'https://example.com/v.mp4' } },
        },
      ],
    };
    const r1 = adaptSyncCreativesRequestForV2(input);
    const r2 = adaptSyncCreativesRequestForV2(input);
    assert.deepStrictEqual(r1, r2);
  });
});

describe('adaptSyncCreativesRequestForV2 — status → approved mapping', () => {
  test('status "approved" becomes approved: true', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', status: 'approved' }],
    });
    assert.strictEqual(result.creatives[0].approved, true);
    assert.strictEqual(result.creatives[0].status, undefined);
  });

  test('status "rejected" becomes approved: false', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', status: 'rejected' }],
    });
    assert.strictEqual(result.creatives[0].approved, false);
  });

  test('absent status omits approved entirely', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1' }],
    });
    assert.strictEqual(result.creatives[0].approved, undefined);
  });

  test('catalogs is stripped', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', catalogs: ['cat-1'] }],
    });
    assert.strictEqual(result.creatives[0].catalogs, undefined);
  });
});

describe('adaptSyncCreativesRequestForV2 — manifest flattening (single-role)', () => {
  function singleRoleCase(role, assetPayload) {
    const input = {
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: { [role]: assetPayload } }],
    };
    const result = adaptSyncCreativesRequestForV2(input);
    assert.deepStrictEqual(result.creatives[0].assets, assetPayload, `${role} asset is flattened correctly`);
    assert.strictEqual(result.creatives[0].creative_id, 'cre-1', 'creative_id is preserved');
  }

  test('video asset is flattened', () =>
    singleRoleCase('video', {
      asset_type: 'video',
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080,
      duration_ms: 30000,
    }));

  test('image asset is flattened', () =>
    singleRoleCase('image', {
      asset_type: 'image',
      url: 'https://example.com/img.png',
      width: 300,
      height: 250,
    }));

  test('audio asset is flattened', () =>
    singleRoleCase('audio', {
      asset_type: 'audio',
      url: 'https://example.com/audio.mp3',
      duration_ms: 15000,
    }));

  test('VAST asset is flattened', () =>
    singleRoleCase('vast', {
      asset_type: 'vast',
      url: 'https://example.com/vast.xml',
    }));

  test('text asset is flattened', () =>
    singleRoleCase('headline', {
      asset_type: 'text',
      text: 'Buy now',
    }));

  test('html asset is flattened', () =>
    singleRoleCase('body', {
      asset_type: 'html',
      html: '<div>Ad</div>',
    }));
});

describe('adaptSyncCreativesRequestForV2 — manifest flattening (multi-role)', () => {
  test('multi-role manifest: only primary (first) role is forwarded', () => {
    const videoAsset = { asset_type: 'video', url: 'https://example.com/v.mp4' };
    const bannerAsset = { asset_type: 'image', url: 'https://example.com/banner.png', width: 300, height: 250 };
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: { video: videoAsset, companion: bannerAsset } }],
    });
    assert.strictEqual(result.creatives.length, 1, 'only one creative entry emitted');
    assert.deepStrictEqual(result.creatives[0].assets, videoAsset, 'primary role asset is used');
    assert.strictEqual(result.creatives[0].creative_id, 'cre-1', 'original creative_id preserved');
  });

  test('multi-role with same asset_type: no phantom creative_id collision', () => {
    // Two roles both have asset_type: 'image' — ensures no creative_id--image collision
    const hero = { asset_type: 'image', url: 'https://example.com/hero.png', width: 1200, height: 628 };
    const thumb = { asset_type: 'image', url: 'https://example.com/thumb.png', width: 300, height: 250 };
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: { hero, thumbnail: thumb } }],
    });
    assert.strictEqual(result.creatives.length, 1);
    assert.deepStrictEqual(result.creatives[0].assets, hero);
    assert.strictEqual(result.creatives[0].creative_id, 'cre-1');
  });

  test('batch with mixed single-role and multi-role creatives: output array length matches input', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [
        { creative_id: 'cre-a', assets: { video: { asset_type: 'video', url: 'https://example.com/a.mp4' } } },
        {
          creative_id: 'cre-b',
          assets: {
            image: { asset_type: 'image', url: 'https://example.com/b.png', width: 300, height: 250 },
            companion: { asset_type: 'image', url: 'https://example.com/c.png', width: 728, height: 90 },
          },
        },
      ],
    });
    // flatMap must not be accidentally used; output is one-to-one with input
    assert.strictEqual(result.creatives.length, 2);
    assert.ok(!Array.isArray(result.creatives[0]), 'elements are not nested arrays');
    assert.ok(!Array.isArray(result.creatives[1]), 'elements are not nested arrays');
  });
});

describe('adaptSyncCreativesRequestForV2 — edge cases', () => {
  test('no assets field: assets is omitted from output', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1' }],
    });
    assert.strictEqual(result.creatives[0].assets, undefined);
  });

  test('already-flat assets (has asset_type at top level): passed through unchanged', () => {
    const flat = { asset_type: 'image', url: 'https://example.com/img.png', width: 300, height: 250 };
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: flat }],
    });
    assert.deepStrictEqual(result.creatives[0].assets, flat);
  });

  test('empty manifest object: passed through as empty object (not flattened)', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: {} }],
    });
    // isManifestShape({}) returns false; empty object passes through verbatim
    assert.deepStrictEqual(result.creatives[0].assets, {});
  });

  test('empty creatives array: returns empty array', () => {
    const result = adaptSyncCreativesRequestForV2({ ...BASE_REQUEST, creatives: [] });
    assert.deepStrictEqual(result.creatives, []);
  });

  test('no creatives key: omits creatives from output', () => {
    const { creatives: _omit, ...noCreatives } = BASE_REQUEST;
    const result = adaptSyncCreativesRequestForV2(noCreatives);
    assert.strictEqual(result.creatives, undefined);
  });
});
