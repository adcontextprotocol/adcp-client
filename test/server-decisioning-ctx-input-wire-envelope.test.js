// Regression: every v6 platform-method dispatch must expose the
// un-destructured wire request envelope on `ctx.input` so adopters can
// read request fields the typed signature doesn't model. The audit in
// adcp-client#1842 enumerated four `sync_*` methods that drop
// spec-meaningful modifiers (`assignments[]`, `delete_missing`, `dry_run`,
// `validation_mode`) because the framework only forwards the payload
// array. Without these tests, a future refactor of `ctxFor` could
// silently re-introduce the same drop.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async () => ({
        id: 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: async () => ({ cache_scope: 'account', products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
    ...overrides,
  };
}

function buildServer(platform) {
  return createAdcpServerFromPlatform(platform, {
    name: 'ctx-input-test',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });
}

describe('ctx.input — un-destructured wire envelope on every v6 dispatch', () => {
  it('exposes sync_creatives.assignments[] on ctx.input even though the typed signature only takes creatives[]', async () => {
    let observedCtx;
    const platform = basePlatform({
      sales: {
        getProducts: async () => ({ cache_scope: 'account', products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async (creatives, ctx) => {
          observedCtx = ctx;
          return [{ creative_id: creatives[0].creative_id, action: 'unchanged' }];
        },
        getMediaBuyDelivery: async () => ({ media_buy_deliveries: [] }),
      },
    });

    const result = await buildServer(platform).dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          idempotency_key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          creatives: [{ creative_id: 'cr_1', format_id: { id: 'f', agent_url: 'https://x' } }],
          assignments: [{ creative_id: 'cr_1', package_ids: ['pkg_1', 'pkg_2'] }],
          delete_missing: true,
          dry_run: false,
          validation_mode: 'strict',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(observedCtx, 'sales.syncCreatives should receive a RequestContext');
    assert.ok(observedCtx.input, 'ctx.input should be set on every v6 dispatch');
    assert.deepStrictEqual(
      observedCtx.input.assignments,
      [{ creative_id: 'cr_1', package_ids: ['pkg_1', 'pkg_2'] }],
      'assignments[] from the wire envelope must survive to the platform method'
    );
    assert.strictEqual(observedCtx.input.delete_missing, true);
    assert.strictEqual(observedCtx.input.dry_run, false);
    assert.strictEqual(observedCtx.input.validation_mode, 'strict');
    // Sanity: the typed first-arg projection still works.
    assert.strictEqual(observedCtx.input.creatives.length, 1);
  });

  it('exposes sync_audiences.delete_missing on ctx.input', async () => {
    let observedCtx;
    const platform = basePlatform({
      capabilities: {
        specialisms: ['sales-non-guaranteed', 'audience-sync'],
        creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      audiences: {
        syncAudiences: async (audiences, ctx) => {
          observedCtx = ctx;
          return audiences.map(a => ({ audience_id: a.audience_id, action: 'unchanged' }));
        },
      },
    });

    const result = await buildServer(platform).dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_audiences',
        arguments: {
          account: { account_id: 'acc_1' },
          idempotency_key: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          audiences: [{ audience_id: 'aud_1', name: 'a' }],
          delete_missing: true,
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(observedCtx, 'audiences.syncAudiences should receive a RequestContext');
    assert.ok(observedCtx.input, 'ctx.input should be set on sync_audiences');
    assert.strictEqual(observedCtx.input.delete_missing, true);
    assert.ok(Array.isArray(observedCtx.input.audiences));
  });

  it('exposes the full envelope on update_media_buy — including media_buy_id which the framework hoists to a positional arg', async () => {
    // Asymmetry callout from the audit: `updateMediaBuy(buyId, patch, ctx)`
    // hoists `media_buy_id` out of the wire envelope to a positional. The
    // typed `patch` arg also still carries it. `ctx.input` is the
    // un-destructured wire envelope; `media_buy_id` is present at the
    // top level there, NOT residual.
    let observedBuyId;
    let observedCtx;
    const platform = basePlatform({
      sales: {
        getProducts: async () => ({ cache_scope: 'account', products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async (buyId, patch, ctx) => {
          observedBuyId = buyId;
          observedCtx = ctx;
          return { media_buy_id: buyId, status: 'active' };
        },
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buy_deliveries: [] }),
      },
    });

    const result = await buildServer(platform).dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          account: { account_id: 'acc_1' },
          idempotency_key: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          media_buy_id: 'mb_42',
          active: true,
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(observedBuyId, 'mb_42');
    assert.ok(observedCtx, 'sales.updateMediaBuy should receive a RequestContext');
    assert.ok(observedCtx.input, 'ctx.input should be set on update_media_buy');
    assert.strictEqual(
      observedCtx.input.media_buy_id,
      'mb_42',
      'media_buy_id must still be present on ctx.input even though the framework hoists it'
    );
    assert.strictEqual(observedCtx.input.active, true);
  });

  it('exposes sync_accounts.delete_missing + dry_run on ctx.input — account handlers route through ResolveContext, not RequestContext', async () => {
    // Audit follow-up: account tool handlers (`syncAccounts`,
    // `syncGovernance`, `listAccounts`, `reportUsage`, `getAccountFinancials`)
    // use `toResolveCtx` → `ResolveContext`, not `ctxFor` →
    // `RequestContext`. The fix wires `input` onto `ResolveContext` too,
    // so the silent-drop closes symmetrically for `sync_accounts.delete_missing`
    // / `dry_run` and any future modifier fields on account requests.
    let observedCtx;
    const platform = basePlatform({
      accounts: {
        resolve: async () => ({
          id: 'acc_1',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
        upsert: async (refs, ctx) => {
          observedCtx = ctx;
          return refs.map(r => ({ account_id: r.account_id ?? 'acc_x', action: 'unchanged' }));
        },
        list: async () => ({ items: [], nextCursor: null }),
      },
    });

    const result = await buildServer(platform).dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          accounts: [{ account_id: 'acc_42' }],
          delete_missing: true,
          dry_run: false,
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(observedCtx, 'accounts.upsert should receive a ResolveContext');
    assert.ok(observedCtx.input, 'ctx.input should be set on sync_accounts (ResolveContext path)');
    assert.strictEqual(observedCtx.input.delete_missing, true);
    assert.strictEqual(observedCtx.input.dry_run, false);
    assert.ok(Array.isArray(observedCtx.input.accounts));
  });

  it('exposes the original envelope on get_products (methods that already pass params whole)', async () => {
    let observedCtx;
    const platform = basePlatform({
      sales: {
        getProducts: async (req, ctx) => {
          observedCtx = ctx;
          return { cache_scope: 'account', products: [] };
        },
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buy_deliveries: [] }),
      },
    });

    const result = await buildServer(platform).dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          account: { account_id: 'acc_1' },
          brief: 'premium homepage',
          promoted_offering: 'cars',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(observedCtx, 'sales.getProducts should receive a RequestContext');
    assert.ok(observedCtx.input, 'ctx.input should be set on get_products too');
    // For methods that already forward `params` whole, `ctx.input` is
    // semantically identical to the first arg — but it's still set, so
    // adopters can use a single read pattern across the surface.
    assert.strictEqual(observedCtx.input.brief, 'premium homepage');
    assert.strictEqual(observedCtx.input.promoted_offering, 'cars');
  });
});
