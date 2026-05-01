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

  // Non-binary v3 statuses have no v2 equivalent — both status and approved are omitted
  for (const s of ['pending_review', 'processing', 'archived']) {
    test(`status "${s}" omits approved (no v2 equivalent)`, () => {
      const result = adaptSyncCreativesRequestForV2({
        ...BASE_REQUEST,
        creatives: [{ creative_id: 'cre-1', status: s }],
      });
      assert.strictEqual(result.creatives[0].approved, undefined);
      assert.strictEqual(result.creatives[0].status, undefined);
    });
  }

  test('catalogs is stripped', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', catalogs: ['cat-1'] }],
    });
    assert.strictEqual(result.creatives[0].catalogs, undefined);
  });
});

describe('adaptSyncCreativesRequestForV2 — assets pass-through', () => {
  test('single-role manifest passes through as manifest, with v3 asset_type discriminator stripped', () => {
    // v2.5 uses the role key (`video`) as the asset-shape discriminator;
    // v3's `asset_type: 'video'` field on the inner value is meaningless
    // to v2.5 and triggers oneOf ambiguity. The adapter strips it; the
    // role-keyed manifest shape itself is preserved.
    const manifest = {
      video: {
        asset_type: 'video',
        url: 'https://example.com/video.mp4',
        width: 1920,
        height: 1080,
        duration_ms: 30000,
      },
    };
    const expected = {
      video: {
        url: 'https://example.com/video.mp4',
        width: 1920,
        height: 1080,
        duration_ms: 30000,
      },
    };
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: manifest }],
    });
    assert.deepStrictEqual(result.creatives[0].assets, expected, 'manifest preserved, asset_type stripped');
    assert.strictEqual(result.creatives[0].creative_id, 'cre-1', 'creative_id preserved');
  });

  test('multi-role manifest preserves all roles, strips asset_type from each', () => {
    const manifest = {
      video: { asset_type: 'video', url: 'https://example.com/v.mp4' },
      companion: { asset_type: 'image', url: 'https://example.com/banner.png', width: 300, height: 250 },
    };
    const expected = {
      video: { url: 'https://example.com/v.mp4' },
      companion: { url: 'https://example.com/banner.png', width: 300, height: 250 },
    };
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: manifest }],
    });
    assert.deepStrictEqual(result.creatives[0].assets, expected, 'all roles preserved, asset_type stripped');
    assert.strictEqual(result.creatives.length, 1, 'one-to-one creative mapping');
  });

  test('batch of creatives: output length matches input', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [
        { creative_id: 'cre-a', assets: { video: { asset_type: 'video', url: 'https://example.com/a.mp4' } } },
        {
          creative_id: 'cre-b',
          assets: { image: { asset_type: 'image', url: 'https://example.com/b.png', width: 300, height: 250 } },
        },
      ],
    });
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

  test('empty object assets: passed through as empty object', () => {
    const result = adaptSyncCreativesRequestForV2({
      ...BASE_REQUEST,
      creatives: [{ creative_id: 'cre-1', assets: {} }],
    });
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
