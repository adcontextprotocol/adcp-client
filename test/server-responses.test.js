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
  listPropertyListsResponse,
  listCollectionListsResponse,
  listContentStandardsResponse,
  getPlanAuditLogsResponse,
  syncCreativesResponse,
  getSignalsResponse,
  activateSignalResponse,
  cancelMediaBuyResponse,
} = require('../dist/lib/server/responses');
const { validActionsForStatus } = require('../dist/lib/server/media-buy-helpers');

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

  it('defaults revision to 1 when not provided', () => {
    const result = mediaBuyResponse({ media_buy_id: 'mb_1', packages: [] });
    assert.strictEqual(result.structuredContent.revision, 1);
  });

  it('preserves explicit revision', () => {
    const result = mediaBuyResponse({ media_buy_id: 'mb_1', packages: [], revision: 5 });
    assert.strictEqual(result.structuredContent.revision, 5);
  });

  it('defaults confirmed_at when not provided', () => {
    const before = new Date().toISOString();
    const result = mediaBuyResponse({ media_buy_id: 'mb_1', packages: [] });
    const after = new Date().toISOString();
    assert.ok(result.structuredContent.confirmed_at >= before);
    assert.ok(result.structuredContent.confirmed_at <= after);
  });

  it('preserves explicit confirmed_at', () => {
    const ts = '2026-01-15T12:00:00.000Z';
    const result = mediaBuyResponse({ media_buy_id: 'mb_1', packages: [], confirmed_at: ts });
    assert.strictEqual(result.structuredContent.confirmed_at, ts);
  });

  it('populates valid_actions from status when not provided', () => {
    const result = mediaBuyResponse({ media_buy_id: 'mb_1', packages: [], status: 'active' });
    assert.ok(Array.isArray(result.structuredContent.valid_actions));
    assert.ok(result.structuredContent.valid_actions.includes('pause'));
    assert.ok(result.structuredContent.valid_actions.includes('cancel'));
  });

  it('does not set valid_actions when status is not provided', () => {
    const result = mediaBuyResponse({ media_buy_id: 'mb_1', packages: [] });
    assert.strictEqual(result.structuredContent.valid_actions, undefined);
  });

  it('preserves explicit valid_actions', () => {
    const result = mediaBuyResponse({
      media_buy_id: 'mb_1',
      packages: [],
      status: 'active',
      valid_actions: ['cancel'],
    });
    assert.deepStrictEqual(result.structuredContent.valid_actions, ['cancel']);
  });

  it('throws when `setup` is placed at the top level instead of inside account', () => {
    assert.throws(
      () =>
        mediaBuyResponse({
          media_buy_id: 'mb_1',
          packages: [],
          status: 'pending_approval',
          setup: { url: 'https://example.com/sign', message: 'Review IO' },
        }),
      /`setup` is not a field on the media buy.*belongs inside `account\.setup`/
    );
  });

  it('accepts setup nested under account', () => {
    const result = mediaBuyResponse({
      media_buy_id: 'mb_1',
      packages: [],
      status: 'pending_approval',
      account: {
        account_id: 'acct_1',
        name: 'Acme',
        status: 'pending_approval',
        setup: { url: 'https://example.com/sign', message: 'Review IO' },
      },
    });
    assert.strictEqual(result.structuredContent.account.setup.url, 'https://example.com/sign');
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

  it('populates valid_actions from status when not provided', () => {
    const result = updateMediaBuyResponse({ media_buy_id: 'mb_1', status: 'paused' });
    assert.ok(Array.isArray(result.structuredContent.valid_actions));
    assert.ok(result.structuredContent.valid_actions.includes('resume'));
    assert.ok(!result.structuredContent.valid_actions.includes('pause'));
  });

  it('does not set valid_actions when status is not provided', () => {
    const result = updateMediaBuyResponse({ media_buy_id: 'mb_1' });
    assert.strictEqual(result.structuredContent.valid_actions, undefined);
  });

  it('preserves explicit valid_actions', () => {
    const result = updateMediaBuyResponse({
      media_buy_id: 'mb_1',
      status: 'active',
      valid_actions: ['cancel'],
    });
    assert.deepStrictEqual(result.structuredContent.valid_actions, ['cancel']);
  });

  it('throws when `setup` is placed at the top level instead of inside account', () => {
    assert.throws(
      () =>
        updateMediaBuyResponse({
          media_buy_id: 'mb_1',
          status: 'pending_approval',
          setup: { url: 'https://example.com/sign', message: 'Review IO' },
        }),
      /`setup` is not a field on the media buy.*belongs inside `account\.setup`/
    );
  });
});

describe('getMediaBuysResponse', () => {
  it('returns media buy count in default summary', () => {
    const result = getMediaBuysResponse({ media_buys: [{ media_buy_id: 'mb_1' }] });
    assert.strictEqual(result.content[0].text, 'Found 1 media buy');
  });

  it('throws when any media buy has `setup` at the top level', () => {
    assert.throws(
      () =>
        getMediaBuysResponse({
          media_buys: [
            { media_buy_id: 'mb_1' },
            {
              media_buy_id: 'mb_2',
              status: 'pending_approval',
              setup: { url: 'https://example.com/sign', message: 'Review IO' },
            },
          ],
        }),
      /getMediaBuysResponse.*`setup` is not a field on the media buy/
    );
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

  it('falls back gracefully when creative_manifest is missing format_id', () => {
    // Regression: the default summary used to crash with
    // "Cannot read properties of undefined (reading 'id')" — swallowing
    // the real schema violation (missing required `format_id` per
    // `creative-manifest.json`) behind an opaque SERVICE_UNAVAILABLE.
    const result = buildCreativeResponse({
      creative_manifest: { renders: [{ role: 'primary', media_type: 'image/png' }] },
    });
    assert.strictEqual(result.content[0].text, 'Creative built');
  });

  it('accepts a fully-missing creative_manifest without crashing', () => {
    const result = buildCreativeResponse({});
    assert.strictEqual(result.content[0].text, 'Creative built');
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

  it('falls back to count=0 when creative_manifests is missing', () => {
    const result = buildCreativeMultiResponse({});
    assert.strictEqual(result.content[0].text, 'Built 0 creative formats');
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

describe('validActionsForStatus', () => {
  it('returns actions including pause for active status', () => {
    const actions = validActionsForStatus('active');
    assert.ok(actions.includes('pause'));
    assert.ok(actions.includes('cancel'));
    assert.ok(actions.includes('update_budget'));
    assert.ok(!actions.includes('resume'));
  });

  it('returns resume but not pause for paused status', () => {
    const actions = validActionsForStatus('paused');
    assert.ok(actions.includes('resume'));
    assert.ok(actions.includes('cancel'));
    assert.ok(!actions.includes('pause'));
    assert.ok(!actions.includes('sync_creatives'));
  });

  it('returns cancel and modification actions for pending_creatives', () => {
    const actions = validActionsForStatus('pending_creatives');
    assert.ok(actions.includes('cancel'));
    assert.ok(actions.includes('sync_creatives'));
    assert.ok(!actions.includes('pause'));
    assert.ok(!actions.includes('resume'));
  });

  it('returns cancel and modification actions for pending_start', () => {
    const actions = validActionsForStatus('pending_start');
    assert.ok(actions.includes('cancel'));
    assert.ok(actions.includes('update_packages'));
    assert.ok(!actions.includes('pause'));
  });

  it('returns empty array for canceled status', () => {
    assert.deepStrictEqual(validActionsForStatus('canceled'), []);
  });

  it('returns empty array for completed status', () => {
    assert.deepStrictEqual(validActionsForStatus('completed'), []);
  });

  it('returns empty array for rejected status', () => {
    assert.deepStrictEqual(validActionsForStatus('rejected'), []);
  });

  it('returns an array for every known status', () => {
    const allStatuses = ['pending_creatives', 'pending_start', 'active', 'paused', 'completed', 'rejected', 'canceled'];
    for (const status of allStatuses) {
      const result = validActionsForStatus(status);
      assert.ok(Array.isArray(result), `Expected array for status "${status}"`);
    }
  });
});

describe('cancelMediaBuyResponse', () => {
  it('sets status to canceled and valid_actions to empty', () => {
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 3,
    });
    assert.strictEqual(result.structuredContent.status, 'canceled');
    assert.deepStrictEqual(result.structuredContent.valid_actions, []);
  });

  it('requires canceled_by and auto-sets canceled_at', () => {
    const before = new Date().toISOString();
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'seller',
      revision: 2,
    });
    const after = new Date().toISOString();
    const cancellation = result.structuredContent.cancellation;
    assert.strictEqual(cancellation.canceled_by, 'seller');
    assert.ok(cancellation.canceled_at >= before);
    assert.ok(cancellation.canceled_at <= after);
  });

  it('preserves explicit canceled_at', () => {
    const ts = '2026-03-01T00:00:00.000Z';
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 4,
      canceled_at: ts,
    });
    assert.strictEqual(result.structuredContent.cancellation.canceled_at, ts);
  });

  it('includes reason when provided', () => {
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 2,
      reason: 'Campaign ended early',
    });
    assert.strictEqual(result.structuredContent.cancellation.reason, 'Campaign ended early');
  });

  it('omits reason when not provided', () => {
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 2,
    });
    assert.strictEqual(result.structuredContent.cancellation.reason, undefined);
  });

  it('returns correct default summary', () => {
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_99',
      canceled_by: 'buyer',
      revision: 1,
    });
    assert.strictEqual(result.content[0].text, 'Media buy mb_99 canceled');
  });

  it('passes through revision and sandbox', () => {
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 7,
      sandbox: true,
    });
    assert.strictEqual(result.structuredContent.revision, 7);
    assert.strictEqual(result.structuredContent.sandbox, true);
  });

  it('passes through affected_packages', () => {
    const packages = [{ package_id: 'pkg_1' }, { package_id: 'pkg_2' }];
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 3,
      affected_packages: packages,
    });
    assert.deepStrictEqual(result.structuredContent.affected_packages, packages);
  });

  it('omits affected_packages and sandbox when not provided', () => {
    const result = cancelMediaBuyResponse({
      media_buy_id: 'mb_1',
      canceled_by: 'buyer',
      revision: 2,
    });
    assert.strictEqual(result.structuredContent.affected_packages, undefined);
    assert.strictEqual(result.structuredContent.sandbox, undefined);
  });
});

describe('listPropertyListsResponse', () => {
  it('wraps lists in the correct envelope with a counted default summary', () => {
    const data = {
      lists: [
        { list_id: 'pl1', name: 'Premium inventory', properties: [] },
        { list_id: 'pl2', name: 'Sponsored sports', properties: [] },
      ],
    };
    const result = listPropertyListsResponse(data);
    assert.match(result.content[0].text, /Found 2 property lists/);
    assert.deepStrictEqual(result.structuredContent.lists, data.lists);
  });

  it('handles the singular case without the plural "s"', () => {
    const result = listPropertyListsResponse({ lists: [{ list_id: 'pl1', name: 'One', properties: [] }] });
    assert.match(result.content[0].text, /Found 1 property list\b/);
  });

  it('handles the empty case cleanly', () => {
    const result = listPropertyListsResponse({ lists: [] });
    assert.match(result.content[0].text, /Found 0 property lists/);
  });
});

describe('listCollectionListsResponse', () => {
  it('wraps lists with the expected collection summary', () => {
    const data = {
      lists: [
        { list_id: 'cl1', name: 'News collections', collections: [] },
        { list_id: 'cl2', name: 'Sports', collections: [] },
        { list_id: 'cl3', name: 'Lifestyle', collections: [] },
      ],
    };
    const result = listCollectionListsResponse(data);
    assert.match(result.content[0].text, /Found 3 collection lists/);
    assert.deepStrictEqual(result.structuredContent.lists, data.lists);
  });
});

describe('listContentStandardsResponse', () => {
  it('names the standards count on the success branch', () => {
    const data = {
      standards: [
        { standard_id: 'cs1', name: 'Brand safety', policies: [] },
        { standard_id: 'cs2', name: 'Suitability', policies: [] },
      ],
    };
    const result = listContentStandardsResponse(data);
    assert.match(result.content[0].text, /Found 2 content standards/);
    assert.deepStrictEqual(result.structuredContent.standards, data.standards);
  });

  it('switches default summary on the error branch', () => {
    // The response type is a union — error branch has `errors` array and no `standards`.
    const data = { errors: [{ code: 'UNAUTHORIZED', message: 'bad token' }] };
    const result = listContentStandardsResponse(data);
    assert.match(result.content[0].text, /Content standards lookup error/);
    assert.deepStrictEqual(result.structuredContent.errors, data.errors);
  });

  it('success branch with advisory errors still gets the count summary', () => {
    // Discriminator is presence of `standards`, not absence of `errors` —
    // a legitimate success response carrying advisory warnings under
    // `errors` must NOT be labelled a lookup error.
    const data = {
      standards: [{ standard_id: 'cs1', name: 'Brand safety', policies: [] }],
      errors: [{ code: 'PARTIAL_RESULTS', message: 'some registries timed out' }],
    };
    const result = listContentStandardsResponse(data);
    assert.match(result.content[0].text, /Found 1 content standard\b/);
    assert.doesNotMatch(result.content[0].text, /error/i);
  });
});

describe('getPlanAuditLogsResponse', () => {
  it('wraps plans under the required envelope with a counted default summary', () => {
    const data = {
      plans: [
        {
          plan_id: 'plan_1',
          plan_version: 1,
          status: 'active',
          budget: {},
          governed_actions: [],
          summary: {},
        },
        {
          plan_id: 'plan_2',
          plan_version: 3,
          status: 'completed',
          budget: {},
          governed_actions: [],
          summary: {},
        },
      ],
    };
    const result = getPlanAuditLogsResponse(data);
    assert.match(result.content[0].text, /Audit data for 2 plans/);
    assert.deepStrictEqual(result.structuredContent.plans, data.plans);
  });

  it('handles the singular case without the plural "s"', () => {
    const result = getPlanAuditLogsResponse({
      plans: [
        {
          plan_id: 'plan_1',
          plan_version: 1,
          status: 'active',
          budget: {},
          governed_actions: [],
          summary: {},
        },
      ],
    });
    assert.match(result.content[0].text, /Audit data for 1 plan\b/);
  });

  it('honours an explicit summary override', () => {
    const result = getPlanAuditLogsResponse({ plans: [] }, 'Audit pulled');
    assert.strictEqual(result.content[0].text, 'Audit pulled');
  });
});
