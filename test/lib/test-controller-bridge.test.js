/**
 * Tests for the `TestControllerBridge` helper factories and merge helpers.
 *
 * Covers both the default-store bridge (process-wide Map, closed over at
 * construction time) and the session-scoped variant (callback-driven, one
 * session per request). The session variant was added for sellers whose
 * seed store is per-tenant / per-brand and loaded from Postgres / Redis
 * on each request (adcp-client#824).
 *
 * Per-tool callback tests (getSeededCreatives, getSeededMediaBuys,
 * getSeededAccounts, getSeededAccountFinancials, getSeededCreativeFormats)
 * cover the merge helpers and the bridgeFromSessionStore wiring
 * (adcp-client#1002).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  bridgeFromTestControllerStore,
  bridgeFromSessionStore,
  mergeSeededCreativesIntoResponse,
  mergeSeededMediaBuysIntoResponse,
  mergeSeededAccountsIntoResponse,
  mergeSeededAccountFinancialsIntoResponse,
  mergeSeededCreativeFormatsIntoResponse,
  filterValidSeededCreatives,
  filterValidSeededMediaBuys,
  filterValidSeededAccounts,
  filterValidSeededAccountFinancials,
  filterValidSeededCreativeFormats,
} = require('../../dist/lib/server/index.js');

// ---------------------------------------------------------------------------
// bridgeFromTestControllerStore
// ---------------------------------------------------------------------------

describe('bridgeFromTestControllerStore', () => {
  it('returns seeded products merged onto defaults', async () => {
    const store = new Map();
    store.set('p1', { name: 'Seeded product' });

    const bridge = bridgeFromTestControllerStore(store, {
      delivery_type: 'guaranteed',
      channels: ['display'],
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 1);
    assert.equal(products[0].product_id, 'p1');
    assert.equal(products[0].name, 'Seeded product');
    assert.equal(products[0].delivery_type, 'guaranteed');
  });

  it('returns [] when the store is empty', async () => {
    const bridge = bridgeFromTestControllerStore(new Map());
    const products = await bridge.getSeededProducts({ input: {} });
    assert.deepEqual(products, []);
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — getSeededProducts (existing behaviour)
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore', () => {
  it('loads the session per request and emits seeded products from the selector', async () => {
    const sessionA = { seeds: new Map([['pA', { name: 'Tenant A product' }]]) };
    const sessionB = { seeds: new Map([['pB', { name: 'Tenant B product' }]]) };

    const loadCalls = [];
    const bridge = bridgeFromSessionStore({
      loadSession: input => {
        loadCalls.push(input);
        // Route by a synthetic tenant key on the request — mirrors the
        // real-world `session_id` / `brand.domain` / `account_id` pattern.
        return input.tenant === 'A' ? sessionA : sessionB;
      },
      selectSeededProducts: session => session.seeds,
      productDefaults: { delivery_type: 'guaranteed' },
    });

    const aProducts = await bridge.getSeededProducts({ input: { tenant: 'A' } });
    const bProducts = await bridge.getSeededProducts({ input: { tenant: 'B' } });

    assert.equal(aProducts.length, 1);
    assert.equal(aProducts[0].product_id, 'pA');
    assert.equal(aProducts[0].delivery_type, 'guaranteed');

    assert.equal(bProducts.length, 1);
    assert.equal(bProducts[0].product_id, 'pB');

    // The loader runs once per request — the bridge doesn't memoise.
    assert.equal(loadCalls.length, 2);
    assert.deepEqual(loadCalls[0], { tenant: 'A' });
    assert.deepEqual(loadCalls[1], { tenant: 'B' });
  });

  it('accepts an async loadSession', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: async () => ({ seeds: new Map([['p1', { name: 'Async product' }]]) }),
      selectSeededProducts: session => session.seeds,
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products[0].name, 'Async product');
  });

  it('accepts an async selectSeededProducts (lazy-load pattern)', async () => {
    // A seller whose seed collection is lazy-loaded (referenced by an ID
    // on the session) can await inside the selector without having to
    // eagerly hydrate inside loadSession.
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ seedCollectionId: 'seeds-v1' }),
      selectSeededProducts: async session => {
        // Simulate a second round-trip on the selector path.
        await new Promise(resolve => setImmediate(resolve));
        return new Map([[`${session.seedCollectionId}:p1`, { name: 'Lazy product' }]]);
      },
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 1);
    assert.equal(products[0].product_id, 'seeds-v1:p1');
    assert.equal(products[0].name, 'Lazy product');
  });

  it('returns [] when the selector returns null / undefined', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => undefined,
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.deepEqual(products, []);
  });

  it('accepts any iterable of [productId, fixture] pairs, not just Map', async () => {
    // Sellers whose seed state is an array of [id, fixture] tuples (or a
    // custom iterable) should be able to pass that directly without
    // rebuilding a Map.
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [
        ['p1', { name: 'From array' }],
        ['p2', { name: 'Also from array' }],
      ],
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 2);
    assert.deepEqual(products.map(p => p.product_id).sort(), ['p1', 'p2']);
  });

  it('tolerates non-object fixture values (treats them as empty)', async () => {
    // A storyboard that seeded `null` or a primitive should still produce
    // a valid product (with just `product_id` + defaults) rather than
    // throwing mid-request.
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        seeds: new Map([
          ['p1', null],
          ['p2', 'not-an-object'],
        ]),
      }),
      selectSeededProducts: session => session.seeds,
      productDefaults: { delivery_type: 'non_guaranteed' },
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 2);
    assert.equal(products[0].product_id, 'p1');
    assert.equal(products[0].delivery_type, 'non_guaranteed');
  });

  it('propagates loadSession rejections (silent seed loss is worse than loud failure)', async () => {
    // If the session store is down, fail loudly. A silent fallback to []
    // would mask a storyboard regression where a seeded product gets
    // dropped because the DB hiccupped mid-run.
    const bridge = bridgeFromSessionStore({
      loadSession: async () => {
        throw new Error('db unavailable');
      },
      selectSeededProducts: session => session.seeds,
    });
    await assert.rejects(() => bridge.getSeededProducts({ input: {} }), /db unavailable/);
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — getSeededCreatives
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore getSeededCreatives', () => {
  const CREATIVE = {
    creative_id: 'cr-1',
    name: 'Banner',
    format_id: { agent_url: 'https://creative.example.com', id: 'display_static' },
    status: 'approved',
    created_date: '2026-01-01T00:00:00Z',
    updated_date: '2026-01-01T00:00:00Z',
  };

  it('returns seeded creatives from selectSeededCreatives', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ creatives: [CREATIVE] }),
      selectSeededProducts: () => [],
      selectSeededCreatives: session => session.creatives,
    });
    const result = await bridge.getSeededCreatives({ input: {} });
    assert.equal(result.length, 1);
    assert.equal(result[0].creative_id, 'cr-1');
  });

  it('returns [] when selectSeededCreatives returns null', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
      selectSeededCreatives: () => null,
    });
    const result = await bridge.getSeededCreatives({ input: {} });
    assert.deepEqual(result, []);
  });

  it('getSeededCreatives is undefined when selectSeededCreatives not provided', () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
    });
    assert.equal(bridge.getSeededCreatives, undefined);
  });

  it('accepts async selectSeededCreatives', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
      selectSeededCreatives: async () => [CREATIVE],
    });
    const result = await bridge.getSeededCreatives({ input: {} });
    assert.equal(result[0].creative_id, 'cr-1');
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — getSeededMediaBuys
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore getSeededMediaBuys', () => {
  const MEDIA_BUY = {
    media_buy_id: 'mb-1',
    status: 'active',
    currency: 'USD',
  };

  it('returns seeded media buys from selectSeededMediaBuys', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ buys: [MEDIA_BUY] }),
      selectSeededProducts: () => [],
      selectSeededMediaBuys: session => session.buys,
    });
    const result = await bridge.getSeededMediaBuys({ input: {} });
    assert.equal(result.length, 1);
    assert.equal(result[0].media_buy_id, 'mb-1');
  });

  it('returns [] when selectSeededMediaBuys returns undefined', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
      selectSeededMediaBuys: () => undefined,
    });
    const result = await bridge.getSeededMediaBuys({ input: {} });
    assert.deepEqual(result, []);
  });

  it('getSeededMediaBuys is undefined when selector not provided', () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
    });
    assert.equal(bridge.getSeededMediaBuys, undefined);
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — getSeededAccounts
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore getSeededAccounts', () => {
  const ACCOUNT = {
    account_id: 'acct-1',
    name: 'Acme',
    status: 'active',
  };

  it('returns seeded accounts from selectSeededAccounts', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ accounts: [ACCOUNT] }),
      selectSeededProducts: () => [],
      selectSeededAccounts: session => session.accounts,
    });
    const result = await bridge.getSeededAccounts({ input: {} });
    assert.equal(result.length, 1);
    assert.equal(result[0].account_id, 'acct-1');
  });

  it('returns [] when selectSeededAccounts returns null', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
      selectSeededAccounts: () => null,
    });
    const result = await bridge.getSeededAccounts({ input: {} });
    assert.deepEqual(result, []);
  });

  it('getSeededAccounts is undefined when selector not provided', () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
    });
    assert.equal(bridge.getSeededAccounts, undefined);
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — getSeededAccountFinancials
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore getSeededAccountFinancials', () => {
  const FINANCIALS = {
    account: { account_id: 'acct-1' },
    currency: 'USD',
    period: { start: '2026-01-01', end: '2026-01-31' },
    timezone: 'America/New_York',
  };

  it('returns seeded financials from selectSeededAccountFinancials', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ fin: [FINANCIALS] }),
      selectSeededProducts: () => [],
      selectSeededAccountFinancials: session => session.fin,
    });
    const result = await bridge.getSeededAccountFinancials({ input: {} });
    assert.equal(result.length, 1);
    assert.equal(result[0].currency, 'USD');
  });

  it('returns [] when selectSeededAccountFinancials returns undefined', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
      selectSeededAccountFinancials: () => undefined,
    });
    const result = await bridge.getSeededAccountFinancials({ input: {} });
    assert.deepEqual(result, []);
  });

  it('getSeededAccountFinancials is undefined when selector not provided', () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
    });
    assert.equal(bridge.getSeededAccountFinancials, undefined);
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — getSeededCreativeFormats
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore getSeededCreativeFormats', () => {
  const FORMAT = {
    format_id: { agent_url: 'https://creative.example.com', id: 'display_static' },
    name: 'Display Static',
  };

  it('returns seeded formats from selectSeededCreativeFormats', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ formats: [FORMAT] }),
      selectSeededProducts: () => [],
      selectSeededCreativeFormats: session => session.formats,
    });
    const result = await bridge.getSeededCreativeFormats({ input: {} });
    assert.equal(result.length, 1);
    assert.equal(result[0].format_id.id, 'display_static');
  });

  it('returns [] when selectSeededCreativeFormats returns null', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
      selectSeededCreativeFormats: () => null,
    });
    const result = await bridge.getSeededCreativeFormats({ input: {} });
    assert.deepEqual(result, []);
  });

  it('getSeededCreativeFormats is undefined when selector not provided', () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => [],
    });
    assert.equal(bridge.getSeededCreativeFormats, undefined);
  });
});

// ---------------------------------------------------------------------------
// Merge helpers — list_creatives
// ---------------------------------------------------------------------------

describe('mergeSeededCreativesIntoResponse', () => {
  const BASE_RESPONSE = {
    query_summary: { total_matching: 1, returned: 1 },
    pagination: { total: 1, page: 1, per_page: 10 },
    creatives: [
      {
        creative_id: 'cr-existing',
        name: 'Existing',
        format_id: { agent_url: 'https://a.com', id: 'display' },
        status: 'approved',
        created_date: '2026-01-01T00:00:00Z',
        updated_date: '2026-01-01T00:00:00Z',
      },
    ],
  };

  it('appends seeded creatives to handler response', () => {
    const seeded = [
      {
        creative_id: 'cr-seeded',
        name: 'Seeded',
        format_id: { agent_url: 'https://a.com', id: 'display' },
        status: 'approved',
        created_date: '2026-01-01T00:00:00Z',
        updated_date: '2026-01-01T00:00:00Z',
      },
    ];
    const result = mergeSeededCreativesIntoResponse(BASE_RESPONSE, seeded);
    assert.equal(result.creatives.length, 2);
    assert.equal(result.query_summary.returned, 2);
    assert.equal(result.sandbox, true);
  });

  it('seeded entry wins on creative_id collision', () => {
    const seeded = [
      {
        creative_id: 'cr-existing',
        name: 'Seeded Override',
        format_id: { agent_url: 'https://a.com', id: 'display' },
        status: 'rejected',
        created_date: '2026-01-01T00:00:00Z',
        updated_date: '2026-01-01T00:00:00Z',
      },
    ];
    const result = mergeSeededCreativesIntoResponse(BASE_RESPONSE, seeded);
    assert.equal(result.creatives.length, 1);
    assert.equal(result.creatives[0].name, 'Seeded Override');
  });

  it('returns original response when seeded is empty', () => {
    const result = mergeSeededCreativesIntoResponse(BASE_RESPONSE, []);
    assert.equal(result, BASE_RESPONSE);
  });

  it('preserves existing sandbox: false', () => {
    const result = mergeSeededCreativesIntoResponse({ ...BASE_RESPONSE, sandbox: false }, [
      {
        creative_id: 'cr-2',
        name: 'X',
        format_id: { agent_url: 'https://a.com', id: 'd' },
        status: 'approved',
        created_date: '2026-01-01T00:00:00Z',
        updated_date: '2026-01-01T00:00:00Z',
      },
    ]);
    assert.equal(result.sandbox, false);
  });
});

// ---------------------------------------------------------------------------
// Merge helpers — get_media_buys
// ---------------------------------------------------------------------------

describe('mergeSeededMediaBuysIntoResponse', () => {
  const BASE_RESPONSE = {
    media_buys: [{ media_buy_id: 'mb-existing', status: 'active', currency: 'USD' }],
  };

  it('appends seeded media buys to handler response', () => {
    const seeded = [{ media_buy_id: 'mb-seeded', status: 'pending_approval', currency: 'USD' }];
    const result = mergeSeededMediaBuysIntoResponse(BASE_RESPONSE, seeded);
    assert.equal(result.media_buys.length, 2);
    assert.equal(result.sandbox, true);
  });

  it('seeded entry wins on media_buy_id collision', () => {
    const seeded = [{ media_buy_id: 'mb-existing', status: 'canceled', currency: 'USD' }];
    const result = mergeSeededMediaBuysIntoResponse(BASE_RESPONSE, seeded);
    assert.equal(result.media_buys.length, 1);
    assert.equal(result.media_buys[0].status, 'canceled');
  });

  it('returns original response when seeded is empty', () => {
    const result = mergeSeededMediaBuysIntoResponse(BASE_RESPONSE, []);
    assert.equal(result, BASE_RESPONSE);
  });
});

// ---------------------------------------------------------------------------
// Merge helpers — list_accounts
// ---------------------------------------------------------------------------

describe('mergeSeededAccountsIntoResponse', () => {
  const BASE_RESPONSE = {
    accounts: [{ account_id: 'acct-existing', name: 'Existing', status: 'active' }],
  };

  it('appends seeded accounts to handler response', () => {
    const seeded = [{ account_id: 'acct-seeded', name: 'Seeded', status: 'active' }];
    const result = mergeSeededAccountsIntoResponse(BASE_RESPONSE, seeded);
    assert.equal(result.accounts.length, 2);
  });

  it('seeded entry wins on account_id collision', () => {
    const seeded = [{ account_id: 'acct-existing', name: 'Seeded Override', status: 'suspended' }];
    const result = mergeSeededAccountsIntoResponse(BASE_RESPONSE, seeded);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].name, 'Seeded Override');
  });

  it('returns original response when seeded is empty', () => {
    const result = mergeSeededAccountsIntoResponse(BASE_RESPONSE, []);
    assert.equal(result, BASE_RESPONSE);
  });
});

// ---------------------------------------------------------------------------
// Merge helpers — get_account_financials
// ---------------------------------------------------------------------------

describe('mergeSeededAccountFinancialsIntoResponse', () => {
  const BASE = {
    account: { account_id: 'acct-1' },
    currency: 'USD',
    period: { start: '2026-01-01', end: '2026-01-31' },
    timezone: 'UTC',
    spend: { total_spend: 100 },
  };

  it('overlays seeded entry fields onto handler response', () => {
    const seeded = [
      {
        account: { account_id: 'acct-1' },
        currency: 'USD',
        period: { start: '2026-01-01', end: '2026-01-31' },
        timezone: 'UTC',
        spend: { total_spend: 500 },
      },
    ];
    const result = mergeSeededAccountFinancialsIntoResponse(BASE, seeded);
    assert.equal(result.spend.total_spend, 500);
    assert.equal(result.timezone, 'UTC');
  });

  it('uses the first seeded entry only', () => {
    const seeded = [
      {
        account: { account_id: 'acct-1' },
        currency: 'USD',
        period: { start: '2026-01-01', end: '2026-01-31' },
        timezone: 'UTC',
        spend: { total_spend: 999 },
      },
      {
        account: { account_id: 'acct-1' },
        currency: 'USD',
        period: { start: '2026-01-01', end: '2026-01-31' },
        timezone: 'UTC',
        spend: { total_spend: 1 },
      },
    ];
    const result = mergeSeededAccountFinancialsIntoResponse(BASE, seeded);
    assert.equal(result.spend.total_spend, 999);
  });

  it('returns original response when seeded is empty', () => {
    const result = mergeSeededAccountFinancialsIntoResponse(BASE, []);
    assert.equal(result, BASE);
  });
});

// ---------------------------------------------------------------------------
// Merge helpers — list_creative_formats
// ---------------------------------------------------------------------------

describe('mergeSeededCreativeFormatsIntoResponse', () => {
  const FORMAT_A = { format_id: { agent_url: 'https://a.com', id: 'display' }, name: 'Display' };
  const FORMAT_B = { format_id: { agent_url: 'https://a.com', id: 'video' }, name: 'Video' };
  const BASE_RESPONSE = { formats: [FORMAT_A] };

  it('appends seeded formats to handler response', () => {
    const result = mergeSeededCreativeFormatsIntoResponse(BASE_RESPONSE, [FORMAT_B]);
    assert.equal(result.formats.length, 2);
    assert.equal(result.sandbox, true);
  });

  it('seeded entry wins on format_id composite collision', () => {
    const seededOverride = { format_id: { agent_url: 'https://a.com', id: 'display' }, name: 'Display Override' };
    const result = mergeSeededCreativeFormatsIntoResponse(BASE_RESPONSE, [seededOverride]);
    assert.equal(result.formats.length, 1);
    assert.equal(result.formats[0].name, 'Display Override');
  });

  it('returns original response when seeded is empty', () => {
    const result = mergeSeededCreativeFormatsIntoResponse(BASE_RESPONSE, []);
    assert.equal(result, BASE_RESPONSE);
  });
});

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

describe('filterValidSeededCreatives', () => {
  it('passes valid entries', () => {
    const entry = {
      creative_id: 'cr-1',
      name: 'X',
      format_id: { agent_url: 'https://a.com', id: 'd' },
      status: 'approved',
      created_date: '2026-01-01T00:00:00Z',
      updated_date: '2026-01-01T00:00:00Z',
    };
    assert.equal(filterValidSeededCreatives([entry]).length, 1);
  });

  it('drops entries missing creative_id', () => {
    assert.equal(filterValidSeededCreatives([{ name: 'No ID' }]).length, 0);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(filterValidSeededCreatives(null), []);
    assert.deepEqual(filterValidSeededCreatives('bad'), []);
  });
});

describe('filterValidSeededMediaBuys', () => {
  it('passes valid entries', () => {
    assert.equal(filterValidSeededMediaBuys([{ media_buy_id: 'mb-1', status: 'active', currency: 'USD' }]).length, 1);
  });

  it('drops entries missing media_buy_id', () => {
    assert.equal(filterValidSeededMediaBuys([{ status: 'active' }]).length, 0);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(filterValidSeededMediaBuys(42), []);
  });
});

describe('filterValidSeededAccounts', () => {
  it('passes valid entries', () => {
    assert.equal(filterValidSeededAccounts([{ account_id: 'acct-1', name: 'A', status: 'active' }]).length, 1);
  });

  it('drops entries missing account_id', () => {
    assert.equal(filterValidSeededAccounts([{ name: 'No ID' }]).length, 0);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(filterValidSeededAccounts({}), []);
  });
});

describe('filterValidSeededAccountFinancials', () => {
  const VALID = {
    account: { account_id: 'acct-1' },
    currency: 'USD',
    period: { start: '2026-01-01', end: '2026-01-31' },
    timezone: 'UTC',
  };

  it('passes valid entries', () => {
    assert.equal(filterValidSeededAccountFinancials([VALID]).length, 1);
  });

  it('drops entries missing account', () => {
    assert.equal(filterValidSeededAccountFinancials([{ currency: 'USD', period: {}, timezone: 'UTC' }]).length, 0);
  });

  it('drops entries missing currency', () => {
    assert.equal(
      filterValidSeededAccountFinancials([{ account: { account_id: 'a' }, period: {}, timezone: 'UTC' }]).length,
      0
    );
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(filterValidSeededAccountFinancials(undefined), []);
  });
});

describe('filterValidSeededCreativeFormats', () => {
  const VALID = { format_id: { agent_url: 'https://a.com', id: 'display' }, name: 'Display' };

  it('passes valid entries', () => {
    assert.equal(filterValidSeededCreativeFormats([VALID]).length, 1);
  });

  it('drops entries missing format_id', () => {
    assert.equal(filterValidSeededCreativeFormats([{ name: 'No ID' }]).length, 0);
  });

  it('drops entries with missing format_id.id', () => {
    assert.equal(
      filterValidSeededCreativeFormats([{ format_id: { agent_url: 'https://a.com' }, name: 'X' }]).length,
      0
    );
  });

  it('drops entries with missing format_id.agent_url', () => {
    assert.equal(filterValidSeededCreativeFormats([{ format_id: { id: 'display' }, name: 'X' }]).length, 0);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(filterValidSeededCreativeFormats('bad'), []);
  });
});
