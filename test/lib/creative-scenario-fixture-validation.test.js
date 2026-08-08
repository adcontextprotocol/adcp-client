// Regression test for issue #2460: local creative scenario fixture must be schema-valid.
//
// The testCreativeSync() fixture in src/lib/testing/scenarios/media-buy.ts was
// missing asset_type: "image" on assets.primary, agent_url in the string-format
// fallback path, and idempotency_key on the sync_creatives call envelope.
// This file validates the canonical fixture shape against the published schema
// so future regressions are caught at build time.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validateRequest } = require('../../dist/lib/validation');
const { testCreativeInline, testCreativeSync } = require('../../dist/lib/testing');

const SELLER_URL = 'https://seller.example/mcp';

// Mirrors the default formatId initialised in testCreativeSync()
const DEFAULT_FORMAT_ID = {
  agent_url: 'https://creative.adcontextprotocol.org',
  id: 'display_300x250',
};

// Mirrors the testCreative const built inside testCreativeSync() after the fix.
const BASE_CREATIVE = {
  creative_id: 'test-creative-fixture-regression',
  name: 'E2E Test Creative',
  format_id: DEFAULT_FORMAT_ID,
  assets: {
    primary: {
      asset_type: 'image',
      url: 'https://via.placeholder.com/300x250',
      width: 300,
      height: 250,
      format: 'png',
    },
  },
};

// Minimal valid sync_creatives envelope that wraps the fixture.
const BASE_ENVELOPE = {
  account: { account_id: 'test-account' },
  creatives: [BASE_CREATIVE],
  idempotency_key: 'test-sync-creative-regression-001',
};

describe('creative scenario fixture schema validity (issue #2460)', () => {
  test('default format_id has agent_url', () => {
    assert.ok(typeof DEFAULT_FORMAT_ID.agent_url === 'string', 'agent_url must be a string');
    assert.ok(DEFAULT_FORMAT_ID.agent_url.startsWith('https://'), 'agent_url must be https');
  });

  test('fixture asset has asset_type discriminator', () => {
    assert.strictEqual(BASE_CREATIVE.assets.primary.asset_type, 'image');
  });

  test('testCreativeSync sends its schema-valid fixture with a seller-owned string format ID', async () => {
    const stringFormatFromAgent = 'video_1920x1080';
    let syncRequest;
    const client = {
      listCreativeFormatsLegacy: async () => ({
        success: true,
        data: { format_ids: [stringFormatFromAgent], formats: [] },
      }),
      syncCreatives: async request => {
        syncRequest = request;
        return { success: true, data: { creatives: [] } };
      },
    };

    await testCreativeSync(SELLER_URL, {
      sandbox: true,
      _client: client,
      _profile: { tools: ['list_creative_formats', 'sync_creatives'] },
    });

    assert.ok(syncRequest, 'testCreativeSync must dispatch sync_creatives');
    assert.deepStrictEqual(syncRequest.creatives[0].format_id, {
      agent_url: SELLER_URL,
      id: stringFormatFromAgent,
    });
    assert.strictEqual(syncRequest.creatives[0].assets.primary.asset_type, 'image');
    assert.match(syncRequest.creatives[0].creative_id, /^test-creative-[0-9a-f-]{36}$/);
    assert.notStrictEqual(syncRequest.creatives[0].creative_id, `test-creative-${syncRequest.idempotency_key}`);

    const outcome = validateRequest('sync_creatives', syncRequest);
    assert.strictEqual(
      outcome.valid,
      true,
      `Expected actual scenario request to be schema-valid, got: ${JSON.stringify(outcome.issues, null, 2)}`
    );
  });

  test('sync_creatives envelope with fixture validates against published schema', () => {
    const outcome = validateRequest('sync_creatives', BASE_ENVELOPE);
    assert.strictEqual(
      outcome.valid,
      true,
      `Expected no schema issues, got: ${JSON.stringify(outcome.issues, null, 2)}`
    );
  });

  test('fixture without asset_type fails schema validation', () => {
    const brokenCreative = {
      ...BASE_CREATIVE,
      assets: {
        primary: {
          // asset_type intentionally omitted — reproduces the pre-fix bug
          url: 'https://via.placeholder.com/300x250',
          width: 300,
          height: 250,
          format: 'png',
        },
      },
    };
    const outcome = validateRequest('sync_creatives', { ...BASE_ENVELOPE, creatives: [brokenCreative] });
    assert.strictEqual(outcome.valid, false, 'Expected schema validation to fail without asset_type');
  });

  test('envelope without idempotency_key fails schema validation', () => {
    const { idempotency_key, ...envelopeWithoutKey } = BASE_ENVELOPE;
    const outcome = validateRequest('sync_creatives', envelopeWithoutKey);
    assert.strictEqual(outcome.valid, false, 'Expected schema validation to fail without idempotency_key');
  });

  test('format_id without agent_url fails schema validation', () => {
    const brokenCreative = {
      ...BASE_CREATIVE,
      format_id: { id: 'display_300x250' }, // agent_url intentionally omitted
    };
    const outcome = validateRequest('sync_creatives', { ...BASE_ENVELOPE, creatives: [brokenCreative] });
    assert.strictEqual(outcome.valid, false, 'Expected schema validation to fail without agent_url in format_id');
  });
});

describe('creative scenario residual paths (issue #2443)', () => {
  test('testCreativeSync keeps the AAO default when format discovery is unavailable', async () => {
    let syncRequest;
    const client = {
      syncCreatives: async request => {
        syncRequest = request;
        return { success: true, data: { creatives: [] } };
      },
    };

    await testCreativeSync(SELLER_URL, {
      sandbox: true,
      _client: client,
      _profile: { tools: ['sync_creatives'] },
    });

    assert.deepStrictEqual(syncRequest.creatives[0].format_id, DEFAULT_FORMAT_ID);
  });

  for (const [label, formatsData, expectedFormatId] of [
    ['direct format object', { formats: [{ id: 'display_direct' }] }, { agent_url: SELLER_URL, id: 'display_direct' }],
    [
      'nested format object',
      { formats: [{ format_id: { id: 'display_nested' } }] },
      { agent_url: SELLER_URL, id: 'display_nested' },
    ],
    [
      'nested format object with an explicit owner',
      { formats: [{ format_id: { agent_url: 'https://creative.example/mcp', id: 'display_owned' } }] },
      { agent_url: 'https://creative.example/mcp', id: 'display_owned' },
    ],
  ]) {
    test(`testCreativeSync binds ${label} to the seller agent`, async () => {
      let syncRequest;
      const client = {
        listCreativeFormatsLegacy: async () => ({ success: true, data: formatsData }),
        syncCreatives: async request => {
          syncRequest = request;
          return { success: true, data: { creatives: [] } };
        },
      };

      await testCreativeSync(SELLER_URL, {
        sandbox: true,
        _client: client,
        _profile: { tools: ['list_creative_formats', 'sync_creatives'] },
      });

      assert.deepStrictEqual(syncRequest.creatives[0].format_id, expectedFormatId);
    });
  }

  test('testCreativeInline includes the image asset discriminator', async () => {
    let createRequest;
    const product = {
      product_id: 'display-product',
      name: 'Display product',
      description: 'Regression fixture',
      channels: ['display'],
      format_ids: [{ agent_url: SELLER_URL, id: 'display_300x250' }],
      pricing_options: [
        {
          pricing_option_id: 'display-cpm',
          pricing_model: 'cpm',
          currency: 'USD',
          fixed_price: 10,
        },
      ],
    };
    const client = {
      getProducts: async () => ({ success: true, data: { products: [product] } }),
      createMediaBuy: async request => {
        createRequest = request;
        return { success: false, error: 'Captured request' };
      },
    };

    await testCreativeInline(SELLER_URL, {
      sandbox: true,
      _client: client,
      _profile: { tools: ['create_media_buy'] },
    });

    const creative = createRequest.packages[0].creatives[0];
    assert.strictEqual(creative.assets.primary.asset_type, 'image');
    assert.strictEqual(
      validateRequest('create_media_buy', {
        ...createRequest,
        idempotency_key: 'test-inline-creative-regression-001',
      }).valid,
      true
    );
  });
});
