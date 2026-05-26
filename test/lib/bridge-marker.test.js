/**
 * Verifies the `_bridge` marker the framework stamps on responses that the
 * `testController` bridge augmented with seeded fixtures (adcp-client#1775).
 *
 * The marker is the runner-visible signal that distinguishes
 * "this pass exercised the adopter's adapter against upstream" from
 * "this pass exercised wire conformance against fixture data merged by the
 * SDK". Storyboard runners read it to attribute bridge participation in
 * compliance run records; without it, a leaderboard score reads identically
 * across both cases. Tests assert:
 *   - presence + correct `{ callback, tool, merged_count }` payload on
 *     `structuredContent` when a bridge callback merged entries into the
 *     handler response,
 *   - absence when the callback is omitted,
 *   - absence on non-sandbox requests (bridge gated out),
 *   - absence on singleton-replace tools when no seeded fixture matched
 *     (the response wasn't actually augmented),
 *   - absence on append-merge tools when the callback returned no valid
 *     entries (nothing to merge → no marker).
 *
 * The text-body mirror (`content[0].text`) is opportunistic — it only fires
 * when the text body is JSON, which the standard AdCP response wrappers
 * don't produce (they emit human-readable summaries). Adopters that embed
 * JSON in the text body inherit the mirror via the same `stampReplayed`
 * pattern; no separate assertion needed here.
 *
 * Fixtures here are deliberately minimal — schema validation is opted off
 * via the same wrapper used in `seed-per-tool-wiring.test.js` so this file
 * focuses on the marker contract, not on response shape coverage.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer: _createAdcpServer } = require('../../dist/lib/server/create-adcp-server');

function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

function dispatch(server, name, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

const SANDBOX_ACCOUNT = { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true };

/**
 * Assert the marker is present on `structuredContent` with the expected
 * `{ callback, tool, merged_count }` payload. The text-body mirror
 * (`content[0].text`) is opportunistic — it only fires when the text body
 * is JSON, which the standard AdCP response wrappers don't produce (they
 * emit human-readable summaries like `"Found 3 products"`). Adopters that
 * embed JSON in the text body inherit the mirror; see the dedicated
 * text-mirror test below.
 */
function expectBridgeMarker(res, callback, tool, mergedCount) {
  const sc = res.structuredContent;
  assert.ok(sc?._bridge, `structuredContent._bridge missing on ${tool}`);
  assert.deepEqual(sc._bridge, { callback, tool, merged_count: mergedCount });
}

function expectNoBridgeMarker(res) {
  assert.equal(res.structuredContent?._bridge, undefined);
}

// ---------------------------------------------------------------------------
// Append-merge tools: marker emits when callback returns ≥ 1 valid entry.
// ---------------------------------------------------------------------------

describe('_bridge marker — append-merge tools', () => {
  it('stamps getSeededProducts / get_products', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ cache_scope: 'account', products: [{ product_id: 'h-1', name: 'Handler' }] }),
      },
      testController: {
        getSeededProducts: () => [
          { product_id: 's-1', name: 'S1' },
          { product_id: 's-2', name: 'S2' },
        ],
      },
    });
    const res = await dispatch(server, 'get_products', {
      brief: 'x',
      buying_mode: 'brief',
      account: SANDBOX_ACCOUNT,
    });
    expectBridgeMarker(res, 'getSeededProducts', 'get_products', 2);
  });

  it('stamps getSeededCreatives / list_creatives', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        listCreatives: async () => ({
          query_summary: { total_matching: 1, returned: 1 },
          pagination: { limit: 50, offset: 0, has_more: false },
          creatives: [{ creative_id: 'h-1', name: 'Handler' }],
        }),
      },
      testController: {
        getSeededCreatives: () => [{ creative_id: 's-1', name: 'Seed' }],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededCreatives', 'list_creatives', 1);
  });

  it('stamps getSeededMediaBuys / get_media_buys', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuys: async () => ({ media_buys: [{ media_buy_id: 'h-1' }] }),
      },
      testController: {
        getSeededMediaBuys: () => [{ media_buy_id: 's-1' }, { media_buy_id: 's-2' }, { media_buy_id: 's-3' }],
      },
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededMediaBuys', 'get_media_buys', 3);
  });

  it('stamps getSeededMediaBuyDelivery / get_media_buy_delivery', async () => {
    const period = { start: '2025-01-01T00:00:00Z', end: '2025-01-31T23:59:59Z' };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: async () => ({
          reporting_period: period,
          currency: 'USD',
          aggregated_totals: { impressions: 0, spend: 0, media_buy_count: 0 },
          media_buy_deliveries: [],
        }),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [
          { media_buy_id: 's-1', status: 'active', totals: { impressions: 10, spend: 1 }, by_package: [] },
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededMediaBuyDelivery', 'get_media_buy_delivery', 1);
  });

  it('stamps getSeededAccounts / list_accounts', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { listAccounts: async () => ({ accounts: [] }) },
      testController: {
        getSeededAccounts: () => [{ account_id: 's-1' }, { account_id: 's-2' }],
      },
    });
    const res = await dispatch(server, 'list_accounts', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededAccounts', 'list_accounts', 2);
  });

  it('stamps getSeededCreativeFormats / list_creative_formats', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { listCreativeFormats: async () => ({ formats: [] }) },
      testController: {
        getSeededCreativeFormats: () => [
          { format_id: { agent_url: 'https://creative.example/.well-known/adcp/creative', id: 'f-1' }, name: 'F1' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creative_formats', { context: { sandbox: true } });
    expectBridgeMarker(res, 'getSeededCreativeFormats', 'list_creative_formats', 1);
  });

  it('stamps getSeededPropertyLists / list_property_lists', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listPropertyLists: async () => ({ lists: [] }) },
      testController: {
        getSeededPropertyLists: () => [
          { list_id: 's-1', name: 'S1' },
          { list_id: 's-2', name: 'S2' },
        ],
      },
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededPropertyLists', 'list_property_lists', 2);
  });

  it('stamps getSeededCollectionLists / list_collection_lists', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listCollectionLists: async () => ({ lists: [] }) },
      testController: {
        getSeededCollectionLists: () => [{ list_id: 's-1', name: 'S1' }],
      },
    });
    const res = await dispatch(server, 'list_collection_lists', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededCollectionLists', 'list_collection_lists', 1);
  });

  it('stamps getSeededContentStandards / list_content_standards', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listContentStandards: async () => ({ standards: [] }) },
      testController: {
        getSeededContentStandards: () => [{ standards_id: 's-1', name: 'S1' }],
      },
    });
    const res = await dispatch(server, 'list_content_standards', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededContentStandards', 'list_content_standards', 1);
  });

  it('stamps getSeededSignals / get_signals', async () => {
    const seed = {
      signal_id: { source: 'catalog', data_provider_domain: 'polk.com', id: 's-1' },
      signal_agent_segment_id: 'seg-s-1',
      name: 'Signal s-1',
      description: 'd',
      signal_type: 'marketplace',
      data_provider: 'Polk',
      coverage_percentage: 50,
      deployments: [],
      pricing_options: [{ pricing_option_id: 'p1', currency: 'USD', cpm: 1 }],
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: { getSignals: async () => ({ signals: [] }) },
      testController: { getSeededSignals: () => [seed] },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    expectBridgeMarker(res, 'getSeededSignals', 'get_signals', 1);
  });

  it('stamps getSeededCreativeDelivery / get_creative_delivery', async () => {
    const period = { start: '2025-01-01T00:00:00Z', end: '2025-01-31T23:59:59Z' };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: async () => ({ reporting_period: period, creatives: [] }),
      },
      testController: {
        getSeededCreativeDelivery: () => [{ creative_id: 's-1', totals: {}, by_package: [] }],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededCreativeDelivery', 'get_creative_delivery', 1);
  });

  it('stamps getSeededCreativeFeatures / get_creative_features', async () => {
    const manifest = { format_id: { agent_url: 'https://x.example', id: 'fmt-1' }, assets: {} };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({ results: [] }),
      },
      testController: {
        getSeededCreativeFeatures: () => [{ feature_id: 'f-1', score: 0.9 }],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest,
      account: SANDBOX_ACCOUNT,
    });
    expectBridgeMarker(res, 'getSeededCreativeFeatures', 'get_creative_features', 1);
  });

  it('stamps getSeededRights / get_rights', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getRights: async () => ({ rights: [] }) },
      testController: {
        getSeededRights: () => [
          {
            rights_id: 's-1',
            brand_id: 'brand-a',
            name: 'Right s-1',
            available_uses: ['likeness'],
            pricing_options: [],
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_rights', { query: 'x', account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededRights', 'get_rights', 1);
  });
});

// ---------------------------------------------------------------------------
// Singleton-replace tools: marker emits only when a fixture actually replaced
// the handler payload (request id matched a seeded entry's id).
// ---------------------------------------------------------------------------

describe('_bridge marker — singleton-replace tools', () => {
  it('stamps getSeededAccountFinancials / get_account_financials on match', async () => {
    const handlerEnv = {
      account: { account_id: 'acct-1' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 1 },
    };
    const seededEnv = { ...handlerEnv, spend: { total_spend: 999 } };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { getAccountFinancials: async () => handlerEnv },
      testController: { getSeededAccountFinancials: () => [seededEnv] },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'acct-1', sandbox: true },
    });
    expectBridgeMarker(res, 'getSeededAccountFinancials', 'get_account_financials', 1);
  });

  it('stamps getSeededPropertyLists / get_property_list on match', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getPropertyList: async () => ({ list: { list_id: 'pl-1', name: 'Handler' } }),
      },
      testController: {
        getSeededPropertyLists: () => [{ list_id: 'pl-1', name: 'Seeded' }],
      },
    });
    const res = await dispatch(server, 'get_property_list', {
      list_id: 'pl-1',
      account: SANDBOX_ACCOUNT,
    });
    expectBridgeMarker(res, 'getSeededPropertyLists', 'get_property_list', 1);
  });

  it('stamps getSeededCollectionLists / get_collection_list on match', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCollectionList: async () => ({ list: { list_id: 'cl-1', name: 'Handler' } }),
      },
      testController: {
        getSeededCollectionLists: () => [{ list_id: 'cl-1', name: 'Seeded' }],
      },
    });
    const res = await dispatch(server, 'get_collection_list', {
      list_id: 'cl-1',
      account: SANDBOX_ACCOUNT,
    });
    expectBridgeMarker(res, 'getSeededCollectionLists', 'get_collection_list', 1);
  });

  it('stamps getSeededContentStandards / get_content_standards on match', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getContentStandards: async () => ({ standards_id: 'cs-1', name: 'Handler' }),
      },
      testController: {
        getSeededContentStandards: () => [{ standards_id: 'cs-1', name: 'Seeded' }],
      },
    });
    const res = await dispatch(server, 'get_content_standards', {
      standards_id: 'cs-1',
      account: SANDBOX_ACCOUNT,
    });
    expectBridgeMarker(res, 'getSeededContentStandards', 'get_content_standards', 1);
  });

  it('stamps getSeededBrandIdentity / get_brand_identity on match', async () => {
    const seed = { brand_id: 'b-1', house: { domain: 'example.com', name: 'X' }, names: [{ en_US: 'B1' }] };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getBrandIdentity: async () => ({ ...seed, description: 'Handler' }) },
      testController: { getSeededBrandIdentity: () => [{ ...seed, description: 'Seeded' }] },
    });
    const res = await dispatch(server, 'get_brand_identity', { brand_id: 'b-1', account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededBrandIdentity', 'get_brand_identity', 1);
  });

  it('stamps getSeededSiOffering / si_get_offering on match', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      sponsoredIntelligence: {
        getOffering: async () => ({ available: true, offering: { offering_id: 'o-1', title: 'Handler' } }),
      },
      testController: {
        getSeededSiOffering: () => [{ available: true, offering: { offering_id: 'o-1', title: 'Seeded' } }],
      },
    });
    const res = await dispatch(server, 'si_get_offering', { offering_id: 'o-1', account: SANDBOX_ACCOUNT });
    expectBridgeMarker(res, 'getSeededSiOffering', 'si_get_offering', 1);
  });
});

// ---------------------------------------------------------------------------
// Absence: marker MUST NOT appear when no bridge merge occurred.
// ---------------------------------------------------------------------------

describe('_bridge marker — absent when no merge ran', () => {
  it('is absent when the bridge callback is omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ cache_scope: 'account', products: [{ product_id: 'h-1', name: 'H' }] }) },
      testController: {},
    });
    const res = await dispatch(server, 'get_products', {
      brief: 'x',
      buying_mode: 'brief',
      account: SANDBOX_ACCOUNT,
    });
    expectNoBridgeMarker(res);
  });

  it('is absent on non-sandbox requests (bridge gated out)', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ cache_scope: 'account', products: [{ product_id: 'h-1', name: 'H' }] }) },
      testController: { getSeededProducts: () => [{ product_id: 's-1', name: 'S' }] },
    });
    const res = await dispatch(server, 'get_products', {
      brief: 'x',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    expectNoBridgeMarker(res);
  });

  it('is absent on singleton-replace tools when no fixture matches the request id', async () => {
    const handlerEnv = {
      account: { account_id: 'acct-2' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 42 },
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { getAccountFinancials: async () => handlerEnv },
      testController: {
        getSeededAccountFinancials: () => [
          {
            account: { account_id: 'other-account' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'acct-2', sandbox: true },
    });
    expectNoBridgeMarker(res);
  });

  it('is absent on append-merge tools when the bridge returned no valid entries', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ cache_scope: 'account', products: [{ product_id: 'h-1', name: 'H' }] }) },
      testController: { getSeededProducts: () => [] },
    });
    const res = await dispatch(server, 'get_products', {
      brief: 'x',
      buying_mode: 'brief',
      account: SANDBOX_ACCOUNT,
    });
    expectNoBridgeMarker(res);
  });
});
