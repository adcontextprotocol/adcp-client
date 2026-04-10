const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  capabilitiesResponse,
  productsResponse,
  mediaBuyResponse,
  deliveryResponse,
  listAccountsResponse,
  listCreativeFormatsResponse,
  updateMediaBuyResponse,
  getMediaBuysResponse,
  performanceFeedbackResponse,
  buildCreativeResponse,
  buildCreativeMultiResponse,
  previewCreativeResponse,
  creativeDeliveryResponse,
  listCreativesResponse,
  syncCreativesResponse,
  getSignalsResponse,
  activateSignalResponse,
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
      media_buy_deliveries: [{ media_buy_id: 'mb_1', status: 'active', totals: {}, by_package: [] }],
    };
    const result = deliveryResponse(data);
    assert.strictEqual(result.content[0].text, 'Delivery data for 1 media buy');
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

describe('listAccountsResponse', () => {
  it('returns account count in default summary', () => {
    const result = listAccountsResponse({ accounts: [{ account_id: 'a1' }, { account_id: 'a2' }] });
    assert.strictEqual(result.content[0].text, 'Found 2 accounts');
    assert.strictEqual(result.structuredContent.accounts.length, 2);
  });
});

describe('listCreativeFormatsResponse', () => {
  it('returns format count in default summary', () => {
    const result = listCreativeFormatsResponse({ formats: [{ format_id: 'f1' }, { format_id: 'f2' }] });
    assert.strictEqual(result.content[0].text, 'Found 2 creative formats');
  });
});

describe('updateMediaBuyResponse', () => {
  it('returns media buy id in default summary', () => {
    const result = updateMediaBuyResponse({ media_buy_id: 'mb_456' });
    assert.strictEqual(result.content[0].text, 'Media buy mb_456 updated');
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_456');
  });
});

describe('getMediaBuysResponse', () => {
  it('returns media buy count in default summary', () => {
    const result = getMediaBuysResponse({ media_buys: [{ media_buy_id: 'mb_1' }] });
    assert.strictEqual(result.content[0].text, 'Found 1 media buy');
  });
});

describe('performanceFeedbackResponse', () => {
  it('returns default summary', () => {
    const result = performanceFeedbackResponse({ success: true });
    assert.strictEqual(result.content[0].text, 'Performance feedback accepted');
  });
});

describe('buildCreativeResponse', () => {
  it('returns format id in default summary', () => {
    const result = buildCreativeResponse({
      creative_manifest: { format_id: { agent_url: 'https://example.com', id: 'banner_300x250' } },
    });
    assert.strictEqual(result.content[0].text, 'Creative built: banner_300x250');
  });
});

describe('buildCreativeMultiResponse', () => {
  it('returns manifest count in default summary', () => {
    const result = buildCreativeMultiResponse({
      creative_manifests: [
        { format_id: { agent_url: 'https://example.com', id: 'f1' } },
        { format_id: { agent_url: 'https://example.com', id: 'f2' } },
      ],
    });
    assert.strictEqual(result.content[0].text, 'Built 2 creative formats');
  });
});

describe('previewCreativeResponse', () => {
  it('handles single response type', () => {
    const result = previewCreativeResponse({
      response_type: 'single',
      previews: [{ preview_id: 'p1', renders: [] }],
    });
    assert.strictEqual(result.content[0].text, 'Preview generated: 1 variant');
  });

  it('handles batch response type', () => {
    const result = previewCreativeResponse({
      response_type: 'batch',
      results: [{ success: true }, { success: true }],
    });
    assert.strictEqual(result.content[0].text, 'Batch preview: 2 results');
  });

  it('handles variant response type', () => {
    const result = previewCreativeResponse({ response_type: 'variant' });
    assert.strictEqual(result.content[0].text, 'Variant preview generated');
  });
});

describe('creativeDeliveryResponse', () => {
  it('returns currency in default summary', () => {
    const result = creativeDeliveryResponse({ currency: 'USD' });
    assert.strictEqual(result.content[0].text, 'Creative delivery data for USD report');
  });
});

describe('listCreativesResponse', () => {
  it('returns matching/returned counts in default summary', () => {
    const result = listCreativesResponse({
      query_summary: { total_matching: 50, returned: 10, filters: [] },
    });
    assert.strictEqual(result.content[0].text, 'Found 50 creatives (10 returned)');
  });
});

describe('syncCreativesResponse', () => {
  it('returns creative count in default summary', () => {
    const result = syncCreativesResponse({
      creatives: [{ creative_id: 'c1', action: 'created' }],
    });
    assert.strictEqual(result.content[0].text, 'Synced 1 creative');
  });
});

describe('getSignalsResponse', () => {
  it('returns signal count in default summary', () => {
    const result = getSignalsResponse({
      signals: [{ signal_agent_segment_id: 's1', name: 'Test' }],
    });
    assert.strictEqual(result.content[0].text, 'Found 1 signal');
  });
});

describe('activateSignalResponse', () => {
  it('returns deployment count in default summary', () => {
    const result = activateSignalResponse({
      deployments: [{ destination_id: 'd1', status: 'active' }],
    });
    assert.strictEqual(result.content[0].text, 'Signal activated across 1 deployment');
  });

  it('uses custom summary when provided', () => {
    const result = activateSignalResponse({ deployments: [] }, 'Custom');
    assert.strictEqual(result.content[0].text, 'Custom');
  });
});
