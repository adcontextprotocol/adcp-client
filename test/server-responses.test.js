const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  capabilitiesResponse,
  productsResponse,
  mediaBuyResponse,
  deliveryResponse,
} = require('../dist/lib/server/responses');

describe('capabilitiesResponse', () => {
  it('returns MCP-compatible shape with structuredContent', () => {
    const data = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
    };
    const result = capabilitiesResponse(data);

    assert.ok(Array.isArray(result.content));
    assert.strictEqual(result.content[0].type, 'text');
    assert.strictEqual(typeof result.content[0].text, 'string');
    assert.deepStrictEqual(result.structuredContent.adcp, { major_versions: [3] });
  });

  it('uses custom summary when provided', () => {
    const result = capabilitiesResponse({ supported_protocols: [] }, 'Custom summary');
    assert.strictEqual(result.content[0].text, 'Custom summary');
  });
});

describe('productsResponse', () => {
  it('returns product count in default summary', () => {
    const result = productsResponse({ products: [{ product_id: 'p1' }, { product_id: 'p2' }] });
    assert.strictEqual(result.content[0].text, 'Found 2 products');
    assert.strictEqual(result.structuredContent.products.length, 2);
  });

  it('handles empty products array', () => {
    const result = productsResponse({ products: [] });
    assert.strictEqual(result.content[0].text, 'Found 0 products');
  });
});

describe('mediaBuyResponse', () => {
  it('returns media buy id in default summary', () => {
    const result = mediaBuyResponse({ media_buy_id: 'mb_123', buyer_ref: 'br1', packages: [] });
    assert.strictEqual(result.content[0].text, 'Media buy mb_123 created');
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_123');
  });
});

describe('deliveryResponse', () => {
  it('returns delivery count in default summary', () => {
    const data = {
      reporting_period: { start: '2026-01-01', end: '2026-01-02' },
      media_buy_deliveries: [
        { media_buy_id: 'mb_1', status: 'active', totals: {}, by_package: [] },
      ],
    };
    const result = deliveryResponse(data);
    assert.strictEqual(result.content[0].text, 'Delivery data for 1 media buys');
    assert.strictEqual(result.structuredContent.media_buy_deliveries.length, 1);
  });

  it('handles empty deliveries', () => {
    const data = {
      reporting_period: { start: '2026-01-01', end: '2026-01-02' },
      media_buy_deliveries: [],
    };
    const result = deliveryResponse(data);
    assert.strictEqual(result.content[0].text, 'Delivery data for 0 media buys');
  });
});
