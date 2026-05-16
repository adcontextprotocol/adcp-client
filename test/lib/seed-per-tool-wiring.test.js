/**
 * Wiring tests for the per-tool `TestControllerBridge` callbacks added for
 * platform-proxy sellers (adcp-client#1002). Each callback mirrors the
 * `getSeededProducts` contract — opt-in by presence, post-handler merge,
 * gated on sandbox + resolved-account + controller-present.
 *
 * Each suite below verifies: seeded-only path, handler-only path, merge
 * path (order matches `getSeededProducts` — handler entries first, seeded
 * append), sandbox-gating refusal, validation drop. Schema validation is
 * opted off so fixtures can stay minimal (just the id field + a name) and
 * the tests focus on merge semantics, not response-shape coverage.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServer: _createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { bridgeFromSessionStore } = require('../../dist/lib/server/index.js');

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

// ---------------------------------------------------------------------------
// getSeededCreatives — list_creatives
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededCreatives wiring (list_creatives)', () => {
  function handlerWith(creatives) {
    return async () => ({
      query_summary: { total_matching: creatives.length, returned: creatives.length },
      pagination: { limit: 50, offset: 0, has_more: false },
      creatives,
    });
  }

  it('appends seeded creatives to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        listCreatives: handlerWith([{ creative_id: 'handler-1', name: 'Handler' }]),
      },
      testController: {
        getSeededCreatives: () => [
          { creative_id: 'seed-1', name: 'Seeded 1' },
          { creative_id: 'seed-2', name: 'Seeded 2' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    const ids = res.structuredContent.creatives.map(c => c.creative_id);
    assert.deepEqual(ids, ['handler-1', 'seed-1', 'seed-2']);
    assert.equal(res.structuredContent.sandbox, true);
  });

  it('returns handler-only entries when getSeededCreatives is omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        listCreatives: handlerWith([
          { creative_id: 'h-1', name: 'A' },
          { creative_id: 'h-2', name: 'B' },
          { creative_id: 'h-3', name: 'C' },
        ]),
      },
      testController: {},
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['h-1', 'h-2', 'h-3']
    );
  });

  it('returns seeded-only entries when handler returned empty', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { listCreatives: handlerWith([]) },
      testController: {
        getSeededCreatives: () => [
          { creative_id: 's-1', name: 'A' },
          { creative_id: 's-2', name: 'B' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['s-1', 's-2']
    );
  });

  it('does not call the bridge on non-sandbox requests', async () => {
    let bridgeCalled = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { listCreatives: handlerWith([{ creative_id: 'h-1', name: 'A' }]) },
      testController: {
        getSeededCreatives: () => {
          bridgeCalled = true;
          return [{ creative_id: 's-1', name: 'Seed' }];
        },
      },
    });
    const res = await dispatch(server, 'list_creatives', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(bridgeCalled, false);
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['h-1']
    );
  });

  it('drops seeded entries missing creative_id and keeps valid ones', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { listCreatives: handlerWith([]) },
      testController: {
        getSeededCreatives: () => [
          { creative_id: 'ok-1', name: 'A' },
          { name: 'no id' },
          { creative_id: '', name: 'empty id' },
          { creative_id: 'ok-2', name: 'B' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededMediaBuys — get_media_buys
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededMediaBuys wiring (get_media_buys)', () => {
  function handlerWith(buys) {
    return async () => ({ media_buys: buys });
  }

  it('appends seeded media buys to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuys: handlerWith([{ media_buy_id: 'h-1', status: 'active', currency: 'USD' }]),
      },
      testController: {
        getSeededMediaBuys: () => [
          { media_buy_id: 's-1', status: 'active', currency: 'USD' },
          { media_buy_id: 's-2', status: 'completed', currency: 'USD' },
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.media_buys.map(b => b.media_buy_id),
      ['h-1', 's-1', 's-2']
    );
  });

  it('seeded wins on media_buy_id collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuys: handlerWith([
          { media_buy_id: 'shared', status: 'active', currency: 'USD' },
          { media_buy_id: 'h-only', status: 'active', currency: 'USD' },
        ]),
      },
      testController: {
        getSeededMediaBuys: () => [{ media_buy_id: 'shared', status: 'completed', currency: 'USD' }],
      },
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    const byId = Object.fromEntries(res.structuredContent.media_buys.map(b => [b.media_buy_id, b.status]));
    assert.equal(byId.shared, 'completed', 'seeded wins on collision');
    assert.equal(byId['h-only'], 'active');
  });

  it('handler-only when bridge omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuys: handlerWith([{ media_buy_id: 'h-1', status: 'active', currency: 'USD' }]) },
      testController: {},
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.media_buys.map(b => b.media_buy_id),
      ['h-1']
    );
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuys: handlerWith([]) },
      testController: {
        getSeededMediaBuys: () => {
          called = true;
          return [{ media_buy_id: 's-1', status: 'active', currency: 'USD' }];
        },
      },
    });
    const res = await dispatch(server, 'get_media_buys', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.deepEqual(res.structuredContent.media_buys, []);
  });

  it('drops seeded entries missing media_buy_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuys: handlerWith([]) },
      testController: {
        getSeededMediaBuys: () => [
          { media_buy_id: 'ok-1', status: 'active', currency: 'USD' },
          { status: 'active', currency: 'USD' },
          { media_buy_id: '', status: 'active', currency: 'USD' },
          { media_buy_id: 'ok-2', status: 'active', currency: 'USD' },
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.media_buys.map(b => b.media_buy_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededAccounts — list_accounts
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededAccounts wiring (list_accounts)', () => {
  function handlerWith(accounts) {
    return async () => ({ accounts });
  }

  it('appends seeded accounts to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: {
        listAccounts: handlerWith([{ account_id: 'h-1', name: 'Handler', status: 'active' }]),
      },
      testController: {
        getSeededAccounts: () => [{ account_id: 's-1', name: 'Seed', status: 'active' }],
      },
    });
    const res = await dispatch(server, 'list_accounts', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.accounts.map(a => a.account_id),
      ['h-1', 's-1']
    );
  });

  it('drops seeded entries missing account_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { listAccounts: handlerWith([]) },
      testController: {
        getSeededAccounts: () => [
          { account_id: 'ok-1', name: 'A', status: 'active' },
          { name: 'no id', status: 'active' },
          { account_id: 'ok-2', name: 'B', status: 'active' },
        ],
      },
    });
    const res = await dispatch(server, 'list_accounts', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.accounts.map(a => a.account_id),
      ['ok-1', 'ok-2']
    );
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { listAccounts: handlerWith([{ account_id: 'h-1', name: 'A', status: 'active' }]) },
      testController: {
        getSeededAccounts: () => {
          called = true;
          return [{ account_id: 's-1', name: 'A', status: 'active' }];
        },
      },
    });
    const res = await dispatch(server, 'list_accounts', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.accounts.map(a => a.account_id),
      ['h-1']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededAccountFinancials — get_account_financials (singleton replace)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededAccountFinancials wiring (get_account_financials)', () => {
  // Note: get_account_financials returns a SINGLE envelope. The bridge picks
  // the seeded fixture whose `account.account_id` matches the request's
  // `account.account_id` and REPLACES the handler envelope for that account.
  // No match → handler response passes through.
  function handlerStub(result) {
    return async () => result;
  }

  it('replaces handler response when seeded fixture matches request account_id', async () => {
    const seededEnvelope = {
      account: { account_id: 'acct-1' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 999, media_buy_count: 5 },
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: {
        getAccountFinancials: handlerStub({
          account: { account_id: 'acct-1' },
          currency: 'USD',
          period: { start: '2025-01-01', end: '2025-01-31' },
          timezone: 'UTC',
          spend: { total_spend: 1, media_buy_count: 1 },
        }),
      },
      testController: {
        getSeededAccountFinancials: () => [seededEnvelope],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'acct-1', sandbox: true },
    });
    assert.equal(res.structuredContent.spend.total_spend, 999);
  });

  it('passes through handler response when no seeded fixture matches', async () => {
    const handlerEnvelope = {
      account: { account_id: 'acct-2' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 42 },
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { getAccountFinancials: handlerStub(handlerEnvelope) },
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
    assert.equal(res.structuredContent.spend.total_spend, 42);
  });

  it('drops seeded entries missing account.account_id', async () => {
    let pickedReplaced = false;
    const handlerEnvelope = {
      account: { account_id: 'acct-3' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 7 },
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { getAccountFinancials: handlerStub(handlerEnvelope) },
      testController: {
        getSeededAccountFinancials: () => [
          {
            /* no account field — dropped */
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
          },
          {
            account: { account_id: 'acct-3' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 555 },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'acct-3', sandbox: true },
    });
    // Valid seeded fixture (acct-3) replaced the handler response.
    assert.equal(res.structuredContent.spend.total_spend, 555);
    pickedReplaced = true;
    assert.ok(pickedReplaced);
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const handlerEnvelope = {
      account: { account_id: 'acct-4' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 11 },
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { getAccountFinancials: handlerStub(handlerEnvelope) },
      testController: {
        getSeededAccountFinancials: () => {
          called = true;
          return [
            {
              account: { account_id: 'acct-4' },
              currency: 'USD',
              period: { start: '2025-01-01', end: '2025-01-31' },
              timezone: 'UTC',
              spend: { total_spend: 999 },
            },
          ];
        },
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'acct-4' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.spend.total_spend, 11);
  });
});

// ---------------------------------------------------------------------------
// getSeededCreativeFormats — list_creative_formats
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededCreativeFormats wiring (list_creative_formats)', () => {
  function handlerWith(formats) {
    return async () => ({ formats });
  }

  function makeFormat(agentUrl, id, overrides = {}) {
    return {
      format_id: { agent_url: agentUrl, id },
      name: `Format ${id}`,
      ...overrides,
    };
  }

  it('appends seeded formats to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        listCreativeFormats: handlerWith([makeFormat('https://h.example', 'h-1')]),
      },
      testController: {
        getSeededCreativeFormats: () => [
          makeFormat('https://s.example', 's-1'),
          makeFormat('https://s.example', 's-2'),
        ],
      },
    });
    const res = await dispatch(server, 'list_creative_formats', { context: { sandbox: true } });
    const ids = res.structuredContent.formats.map(f => f.format_id.id);
    assert.deepEqual(ids, ['h-1', 's-1', 's-2']);
    assert.equal(res.structuredContent.sandbox, true);
  });

  it('seeded wins on (agent_url|id) collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        listCreativeFormats: handlerWith([
          makeFormat('https://x.example', 'shared', { name: 'Handler shared' }),
          makeFormat('https://x.example', 'h-only', { name: 'Handler only' }),
        ]),
      },
      testController: {
        getSeededCreativeFormats: () => [makeFormat('https://x.example', 'shared', { name: 'Seeded shared' })],
      },
    });
    const res = await dispatch(server, 'list_creative_formats', { context: { sandbox: true } });
    const byId = Object.fromEntries(res.structuredContent.formats.map(f => [f.format_id.id, f.name]));
    assert.equal(byId.shared, 'Seeded shared');
    assert.equal(byId['h-only'], 'Handler only');
  });

  it('drops seeded entries with incomplete format_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { listCreativeFormats: handlerWith([]) },
      testController: {
        getSeededCreativeFormats: () => [
          makeFormat('https://x.example', 'ok-1'),
          { name: 'no format_id' },
          { format_id: { agent_url: '', id: 'empty-url' }, name: 'bad' },
          { format_id: { agent_url: 'https://x.example' /* no id */ }, name: 'bad' },
          makeFormat('https://x.example', 'ok-2'),
        ],
      },
    });
    const res = await dispatch(server, 'list_creative_formats', { context: { sandbox: true } });
    assert.deepEqual(
      res.structuredContent.formats.map(f => f.format_id.id),
      ['ok-1', 'ok-2']
    );
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { listCreativeFormats: handlerWith([makeFormat('https://x.example', 'h-1')]) },
      testController: {
        getSeededCreativeFormats: () => {
          called = true;
          return [makeFormat('https://x.example', 's-1')];
        },
      },
    });
    const res = await dispatch(server, 'list_creative_formats', {});
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.formats.map(f => f.format_id.id),
      ['h-1']
    );
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — per-tool selectors
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore — per-tool selectors', () => {
  it('wires getSeededCreatives from selectSeededCreatives', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        creatives: [{ creative_id: 'sc-1', name: 'A' }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededCreatives: session => session.creatives,
    });
    const out = await bridge.getSeededCreatives({ input: {} });
    assert.deepEqual(
      out.map(c => c.creative_id),
      ['sc-1']
    );
  });

  it('wires getSeededMediaBuys from selectSeededMediaBuys', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        buys: [{ media_buy_id: 'mb-1', status: 'active', currency: 'USD' }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededMediaBuys: session => session.buys,
    });
    const out = await bridge.getSeededMediaBuys({ input: {} });
    assert.deepEqual(
      out.map(b => b.media_buy_id),
      ['mb-1']
    );
  });

  it('wires getSeededAccounts from selectSeededAccounts', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ accounts: [{ account_id: 'a-1', name: 'A', status: 'active' }] }),
      selectSeededProducts: () => undefined,
      selectSeededAccounts: session => session.accounts,
    });
    const out = await bridge.getSeededAccounts({ input: {} });
    assert.deepEqual(
      out.map(a => a.account_id),
      ['a-1']
    );
  });

  it('wires getSeededAccountFinancials from selectSeededAccountFinancials', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        fins: [
          {
            account: { account_id: 'a-1' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
          },
        ],
      }),
      selectSeededProducts: () => undefined,
      selectSeededAccountFinancials: session => session.fins,
    });
    const out = await bridge.getSeededAccountFinancials({ input: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].account.account_id, 'a-1');
  });

  it('wires getSeededCreativeFormats from selectSeededCreativeFormats', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        formats: [{ format_id: { agent_url: 'https://x.example', id: 'f-1' }, name: 'A' }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededCreativeFormats: session => session.formats,
    });
    const out = await bridge.getSeededCreativeFormats({ input: {} });
    assert.deepEqual(
      out.map(f => f.format_id.id),
      ['f-1']
    );
  });

  it('omits per-tool callbacks when no selector is provided', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => undefined,
    });
    assert.equal(typeof bridge.getSeededProducts, 'function');
    assert.equal(bridge.getSeededCreatives, undefined);
    assert.equal(bridge.getSeededMediaBuys, undefined);
    assert.equal(bridge.getSeededAccounts, undefined);
    assert.equal(bridge.getSeededAccountFinancials, undefined);
    assert.equal(bridge.getSeededCreativeFormats, undefined);
  });
});

// ---------------------------------------------------------------------------
// get_account_financials — brand+operator AccountReference resolution
//
// AccountReference is a discriminated union. The brand+operator variants
// don't carry `account_id` on the wire — `resolveAccount` produces a
// resolved record with `account_id`, and the bridge MUST key on the
// resolved id, not the (absent) request field.
// ---------------------------------------------------------------------------

describe('get_account_financials — brand+operator account reference resolution', () => {
  it('matches seeded fixture against resolved ctx.account.account_id on brand+operator requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      resolveAccount: async () => ({ account_id: 'resolved-acct-7', sandbox: true }),
      accounts: {
        getAccountFinancials: async () => ({
          account: { account_id: 'resolved-acct-7' },
          currency: 'USD',
          period: { start: '2025-01-01', end: '2025-01-31' },
          timezone: 'UTC',
          spend: { total_spend: 1 },
        }),
      },
      testController: {
        getSeededAccountFinancials: () => [
          {
            account: { account_id: 'resolved-acct-7' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 4242 },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    assert.equal(res.structuredContent.spend.total_spend, 4242, 'seeded fixture should replace via resolved id');
  });

  it('resolved ctx.account.account_id takes precedence over request account.account_id', async () => {
    // Operator-resolved AccountReference variant: request carries `account_id`
    // AND `resolveAccount` produces a record with a DIFFERENT `account_id`.
    // The bridge MUST key on the resolved id (the framework's source of truth
    // for who the caller is), not the request's. This is the contract that
    // makes seeded fixtures interchangeable across AccountReference variants —
    // if the request id won, brand+operator variants and operator-resolved
    // variants for the same account would have to seed under different keys.
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      resolveAccount: async () => ({ account_id: 'resolved-acct', sandbox: true }),
      accounts: {
        getAccountFinancials: async () => ({
          account: { account_id: 'resolved-acct' },
          currency: 'USD',
          period: { start: '2025-01-01', end: '2025-01-31' },
          timezone: 'UTC',
          spend: { total_spend: 1 },
        }),
      },
      testController: {
        getSeededAccountFinancials: () => [
          {
            // Fixture seeded under the RESOLVED id, not the request's id.
            account: { account_id: 'resolved-acct' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 1234 },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      // Request carries a DIFFERENT account_id than the resolved one. The bridge
      // should match against the resolved id, find the seeded fixture, and
      // replace the handler envelope.
      account: { account_id: 'request-acct', sandbox: true },
    });
    assert.equal(
      res.structuredContent.spend.total_spend,
      1234,
      'resolved id wins; seeded fixture for resolved-acct replaces the envelope'
    );
  });

  it('passes handler envelope through unchanged when no seeded fixture matches the resolved id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      resolveAccount: async () => ({ account_id: 'resolved-acct-8', sandbox: true }),
      accounts: {
        getAccountFinancials: async () => ({
          account: { account_id: 'resolved-acct-8' },
          currency: 'USD',
          period: { start: '2025-01-01', end: '2025-01-31' },
          timezone: 'UTC',
          spend: { total_spend: 17 },
        }),
      },
      testController: {
        getSeededAccountFinancials: () => [
          {
            account: { account_id: 'some-other-account' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 999 },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    assert.equal(res.structuredContent.spend.total_spend, 17, 'handler response should pass through unchanged');
  });
});

// ---------------------------------------------------------------------------
// get_account_financials — preserve handler context/ext on singleton replace
// ---------------------------------------------------------------------------

describe('get_account_financials — handler context/ext preserved on singleton replace', () => {
  it('preserves handler.context and handler.ext when replacing with seeded financials', async () => {
    const handlerEnvelope = {
      context: { adcp_version: '3.0.11', request_id: 'req-xyz' },
      ext: { audit: { trace_id: 'trace-1' } },
      account: { account_id: 'acct-ctx' },
      currency: 'USD',
      period: { start: '2025-01-01', end: '2025-01-31' },
      timezone: 'UTC',
      spend: { total_spend: 1 },
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      accounts: { getAccountFinancials: async () => handlerEnvelope },
      testController: {
        getSeededAccountFinancials: () => [
          {
            // Seeded fixture has NO context / ext. Replace must preserve
            // the handler's context echo, not produce a fixture envelope
            // missing it.
            account: { account_id: 'acct-ctx' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 7777 },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'acct-ctx', sandbox: true },
    });
    assert.equal(res.structuredContent.spend.total_spend, 7777, 'financials replaced by seeded fixture');
    assert.deepEqual(
      res.structuredContent.context,
      { adcp_version: '3.0.11', request_id: 'req-xyz' },
      'handler context preserved across replace'
    );
    assert.deepEqual(
      res.structuredContent.ext,
      { audit: { trace_id: 'trace-1' } },
      'handler ext preserved across replace'
    );
  });
});

// ---------------------------------------------------------------------------
// get_account_financials — duplicate seeded account_ids warn-and-drop
// ---------------------------------------------------------------------------

describe('get_account_financials — duplicate seeded account_ids', () => {
  it('warns and drops duplicate seeded entries by account.account_id (first wins)', async () => {
    const warnings = [];
    const logger = {
      info: () => {},
      warn: (message, meta) => warnings.push({ message, meta }),
      error: () => {},
      debug: () => {},
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      accounts: {
        getAccountFinancials: async () => ({
          account: { account_id: 'dup-acct' },
          currency: 'USD',
          period: { start: '2025-01-01', end: '2025-01-31' },
          timezone: 'UTC',
          spend: { total_spend: 1 },
        }),
      },
      testController: {
        getSeededAccountFinancials: () => [
          {
            account: { account_id: 'dup-acct' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 100 },
          },
          {
            account: { account_id: 'dup-acct' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 200 },
          },
          {
            account: { account_id: 'other-acct' },
            currency: 'USD',
            period: { start: '2025-01-01', end: '2025-01-31' },
            timezone: 'UTC',
            spend: { total_spend: 300 },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_account_financials', {
      account: { account_id: 'dup-acct', sandbox: true },
    });
    // First seeded fixture (total_spend: 100) wins; the duplicate (total_spend: 200) is dropped.
    assert.equal(res.structuredContent.spend.total_spend, 100);
    const dupWarn = warnings.find(w => /duplicate account.account_id/.test(w.message));
    assert.ok(dupWarn, 'should have logged a duplicate-drop warning');
    assert.equal(dupWarn.meta.account_id, 'dup-acct');
  });
});

// ---------------------------------------------------------------------------
// list_creatives — query_summary count update on merge
// ---------------------------------------------------------------------------

describe('list_creatives — query_summary count updates on merge', () => {
  it('updates returned and total_matching when new seeded entries append', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        listCreatives: async () => ({
          query_summary: { total_matching: 50, returned: 2 },
          pagination: { has_more: true, total_count: 50 },
          creatives: [
            { creative_id: 'h-1', name: 'A' },
            { creative_id: 'h-2', name: 'B' },
          ],
        }),
      },
      testController: {
        getSeededCreatives: () => [
          { creative_id: 's-1', name: 'X' },
          { creative_id: 's-2', name: 'Y' },
          { creative_id: 's-3', name: 'Z' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.creatives.length, 5);
    assert.equal(res.structuredContent.query_summary.returned, 5, 'returned == final array length');
    assert.equal(res.structuredContent.query_summary.total_matching, 53, 'total_matching += new seeded count');
    // pagination.total_count mirrors the delta when the handler set it.
    assert.equal(res.structuredContent.pagination.total_count, 53);
  });

  it('mixed-collision count drift: total_matching grows only by the non-colliding subset', async () => {
    // Handler returns 2 creatives (1 shared id, 1 unique). Bridge seeds 2 (1
    // collision, 1 new). The merged array is 3 entries (shared deduped to the
    // seeded fixture). query_summary.total_matching should grow by exactly 1
    // — the non-colliding seeded entry. If the bridge added the full seeded
    // count (2) instead of the new count (1), the total drifts past the array
    // length on subsequent merges.
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        listCreatives: async () => ({
          query_summary: { total_matching: 50, returned: 2 },
          pagination: { has_more: true, total_count: 50 },
          creatives: [
            { creative_id: 'shared', name: 'Handler shared' },
            { creative_id: 'h-only', name: 'Handler only' },
          ],
        }),
      },
      testController: {
        getSeededCreatives: () => [
          { creative_id: 'shared', name: 'Seeded shared' },
          { creative_id: 's-new', name: 'Seeded new' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.creatives.length, 3, 'array: handler h-only + seeded shared + seeded s-new');
    assert.equal(res.structuredContent.query_summary.returned, 3, 'returned == final array length');
    assert.equal(
      res.structuredContent.query_summary.total_matching,
      51,
      'total_matching += newCount (1), not += seededCount (2)'
    );
    assert.equal(
      res.structuredContent.pagination.total_count,
      51,
      'pagination mirror increments by newCount, not seededCount'
    );
  });

  it('does not inflate counts on id collision (dedupe wins, no drift)', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        listCreatives: async () => ({
          query_summary: { total_matching: 10, returned: 3 },
          pagination: { has_more: false, total_count: 10 },
          creatives: [
            { creative_id: 'shared-1', name: 'A' },
            { creative_id: 'shared-2', name: 'B' },
            { creative_id: 'h-only', name: 'C' },
          ],
        }),
      },
      testController: {
        getSeededCreatives: () => [
          { creative_id: 'shared-1', name: 'A-seeded' },
          { creative_id: 'shared-2', name: 'B-seeded' },
        ],
      },
    });
    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.creatives.length, 3, 'array length unchanged on full collision');
    assert.equal(res.structuredContent.query_summary.returned, 3);
    assert.equal(
      res.structuredContent.query_summary.total_matching,
      10,
      'no drift; collided entries do not grow total'
    );
    assert.equal(res.structuredContent.pagination.total_count, 10);
  });
});

// ---------------------------------------------------------------------------
// get_media_buys — pagination.total_count update on merge
// ---------------------------------------------------------------------------

describe('get_media_buys — pagination.total_count updates on merge', () => {
  it('updates pagination.total_count when new seeded entries append', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuys: async () => ({
          pagination: { has_more: true, total_count: 50 },
          media_buys: [
            { media_buy_id: 'h-1', status: 'active', currency: 'USD' },
            { media_buy_id: 'h-2', status: 'active', currency: 'USD' },
          ],
        }),
      },
      testController: {
        getSeededMediaBuys: () => [
          { media_buy_id: 's-1', status: 'active', currency: 'USD' },
          { media_buy_id: 's-2', status: 'active', currency: 'USD' },
          { media_buy_id: 's-3', status: 'active', currency: 'USD' },
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.media_buys.length, 5);
    assert.equal(res.structuredContent.pagination.total_count, 53);
  });

  it('does not inflate pagination.total_count on full id collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuys: async () => ({
          pagination: { has_more: false, total_count: 10 },
          media_buys: [
            { media_buy_id: 'shared-1', status: 'active', currency: 'USD' },
            { media_buy_id: 'shared-2', status: 'active', currency: 'USD' },
            { media_buy_id: 'h-only', status: 'active', currency: 'USD' },
          ],
        }),
      },
      testController: {
        getSeededMediaBuys: () => [
          { media_buy_id: 'shared-1', status: 'completed', currency: 'USD' },
          { media_buy_id: 'shared-2', status: 'completed', currency: 'USD' },
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buys', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.media_buys.length, 3);
    assert.equal(res.structuredContent.pagination.total_count, 10);
  });
});

// ---------------------------------------------------------------------------
// getSeededMediaBuyDelivery — get_media_buy_delivery
//
// Unlike the other array bridges, the merge here recomputes
// `aggregated_totals` from the merged per-delivery `totals` so the response
// stays wire-correct after the merge. On collision the SEEDED entry wins —
// matches the precedent set by mergeSeededMediaBuys / mergeSeededCreatives /
// mergeSeededAccounts. Storyboards seed deliberately; a seeded fixture for
// an existing media_buy_id is an explicit author override.
// aggregated_totals are then recomputed from the final merged list.
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededMediaBuyDelivery wiring (get_media_buy_delivery)', () => {
  const REPORTING_PERIOD = { start: '2025-01-01T00:00:00Z', end: '2025-01-31T23:59:59Z' };

  function makeDelivery(media_buy_id, totals = {}, extras = {}) {
    return {
      media_buy_id,
      status: 'active',
      totals,
      by_package: [],
      ...extras,
    };
  }

  function handlerWith(deliveries, aggregated_totals = undefined) {
    return async () => ({
      reporting_period: REPORTING_PERIOD,
      currency: 'USD',
      aggregated_totals: aggregated_totals ?? {
        impressions: deliveries.reduce((acc, d) => acc + (d.totals?.impressions ?? 0), 0),
        spend: deliveries.reduce((acc, d) => acc + (d.totals?.spend ?? 0), 0),
        media_buy_count: deliveries.length,
      },
      media_buy_deliveries: deliveries,
    });
  }

  it('seeded-only: empty handler, two seeded; aggregated_totals recomputed from per-delivery totals', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: handlerWith([], { impressions: 0, spend: 0, media_buy_count: 0 }),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [
          makeDelivery('s-1', { impressions: 100, spend: 5 }),
          makeDelivery('s-2', { impressions: 250, spend: 12 }),
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.media_buy_deliveries.length, 2);
    assert.equal(res.structuredContent.aggregated_totals.impressions, 350);
    assert.equal(res.structuredContent.aggregated_totals.spend, 17);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 2);
  });

  it('handler-only: bridge callback not registered, response passes through verbatim', async () => {
    const handlerEnvelope = {
      reporting_period: REPORTING_PERIOD,
      currency: 'USD',
      aggregated_totals: { impressions: 7, spend: 3, media_buy_count: 1 },
      media_buy_deliveries: [makeDelivery('h-1', { impressions: 7, spend: 3 })],
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuyDelivery: async () => handlerEnvelope },
      testController: {},
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.media_buy_deliveries.length, 1);
    assert.equal(res.structuredContent.aggregated_totals.impressions, 7);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 1);
  });

  it('append-merge: handler 1 + bridge 2 (different ids) → merged 3 with summed aggregated_totals', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: handlerWith([makeDelivery('h-1', { impressions: 100, spend: 4 })]),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [
          makeDelivery('s-1', { impressions: 200, spend: 8 }),
          makeDelivery('s-2', { impressions: 300, spend: 12 }),
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.media_buy_deliveries.map(d => d.media_buy_id),
      ['h-1', 's-1', 's-2']
    );
    assert.equal(res.structuredContent.aggregated_totals.impressions, 600);
    assert.equal(res.structuredContent.aggregated_totals.spend, 24);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 3);
  });

  it('collision dedup: seeded wins on shared media_buy_id; aggregated_totals reflect seeded value', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: handlerWith([makeDelivery('X', { impressions: 999, spend: 50 })]),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [makeDelivery('X', { impressions: 1, spend: 1 })],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.media_buy_deliveries.length, 1, 'collision deduped');
    assert.equal(res.structuredContent.media_buy_deliveries[0].totals.impressions, 1, 'seeded wins on collision');
    assert.equal(res.structuredContent.aggregated_totals.impressions, 1);
    assert.equal(res.structuredContent.aggregated_totals.spend, 1);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 1);
  });

  it('mixed collision: handler [A,B] + bridge [B,C] → merged [A,B,C] with seeded-wins on B and aggregated_totals from merged set', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: handlerWith([
          makeDelivery('A', { impressions: 10, spend: 1 }),
          makeDelivery('B', { impressions: 20, spend: 2 }),
        ]),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [
          makeDelivery('B', { impressions: 99, spend: 99 }), // collides → seeded wins
          makeDelivery('C', { impressions: 30, spend: 3 }), // new → appended
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.media_buy_deliveries.map(d => d.media_buy_id),
      ['A', 'B', 'C']
    );
    // B in merged is the SEEDED one (99/99), not the handler's (20/2).
    // aggregated_totals reflects A.totals (handler 10/1) + B.totals (seeded 99/99) + C.totals (seeded 30/3) = 139/103.
    assert.equal(res.structuredContent.aggregated_totals.impressions, 139);
    assert.equal(res.structuredContent.aggregated_totals.spend, 103);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 3);
  });

  it('optional-field guard: partial population on seeded falls back to handler value', async () => {
    // Handler reports clicks on both deliveries. Bridge seeds one delivery
    // WITHOUT clicks. The merged set is no longer uniformly populated, so the
    // bridge MUST NOT recompute a partial sum — fall back to the handler's
    // `aggregated_totals.clicks` (50). If we summed the partial set we'd get
    // 30, silently understating the metric.
    const handlerEnvelope = {
      reporting_period: REPORTING_PERIOD,
      currency: 'USD',
      aggregated_totals: { impressions: 100, spend: 5, media_buy_count: 2, clicks: 50 },
      media_buy_deliveries: [
        makeDelivery('h-1', { impressions: 60, spend: 3, clicks: 30 }),
        makeDelivery('h-2', { impressions: 40, spend: 2, clicks: 20 }),
      ],
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuyDelivery: async () => handlerEnvelope },
      testController: {
        getSeededMediaBuyDelivery: () => [makeDelivery('s-1', { impressions: 10, spend: 1 /* no clicks */ })],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    // impressions/spend recomputed (every delivery has them).
    assert.equal(res.structuredContent.aggregated_totals.impressions, 110);
    assert.equal(res.structuredContent.aggregated_totals.spend, 6);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 3);
    // clicks is NOT recomputed — falls back to handler's value.
    assert.equal(
      res.structuredContent.aggregated_totals.clicks,
      50,
      'partial population falls back to handler value, not partial sum (30)'
    );
  });

  it('derived ratios: completion_rate recomputed when impressions and completed_views uniformly populated', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: handlerWith([makeDelivery('h-1', { impressions: 400, completed_views: 100, spend: 5 })], {
          impressions: 400,
          completed_views: 100,
          spend: 5,
          media_buy_count: 1,
          completion_rate: 0.25,
        }),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [makeDelivery('s-1', { impressions: 600, completed_views: 200, spend: 5 })],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    // impressions = 1000, completed_views = 300, completion_rate = 0.3
    assert.equal(res.structuredContent.aggregated_totals.impressions, 1000);
    assert.equal(res.structuredContent.aggregated_totals.completed_views, 300);
    assert.equal(res.structuredContent.aggregated_totals.completion_rate, 0.3);
  });

  it('derived ratios: omitted on divide-by-zero (impressions=0 → no completion_rate)', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getMediaBuyDelivery: handlerWith([makeDelivery('h-1', { impressions: 0, completed_views: 0, spend: 0 })], {
          impressions: 0,
          completed_views: 0,
          spend: 0,
          media_buy_count: 1,
        }),
      },
      testController: {
        getSeededMediaBuyDelivery: () => [makeDelivery('s-1', { impressions: 0, completed_views: 0, spend: 0 })],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.aggregated_totals.impressions, 0);
    assert.equal(
      res.structuredContent.aggregated_totals.completion_rate,
      undefined,
      'no divide-by-zero; ratio omitted'
    );
  });

  it('pass-through: reach / frequency / new_to_brand_rate survive merge unchanged', async () => {
    const handlerEnvelope = {
      reporting_period: REPORTING_PERIOD,
      currency: 'USD',
      aggregated_totals: {
        impressions: 100,
        spend: 5,
        media_buy_count: 1,
        reach: 80,
        reach_unit: 'individuals',
        frequency: 1.25,
        new_to_brand_rate: 0.42,
      },
      media_buy_deliveries: [makeDelivery('h-1', { impressions: 100, spend: 5 })],
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuyDelivery: async () => handlerEnvelope },
      testController: {
        getSeededMediaBuyDelivery: () => [makeDelivery('s-1', { impressions: 50, spend: 2 })],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    // Sums recomputed; reach/frequency/NTB survive verbatim from handler.
    assert.equal(res.structuredContent.aggregated_totals.impressions, 150);
    assert.equal(res.structuredContent.aggregated_totals.reach, 80);
    assert.equal(res.structuredContent.aggregated_totals.reach_unit, 'individuals');
    assert.equal(res.structuredContent.aggregated_totals.frequency, 1.25);
    assert.equal(res.structuredContent.aggregated_totals.new_to_brand_rate, 0.42);
  });

  it('skipped on non-sandbox requests (bridge callback not invoked)', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuyDelivery: handlerWith([makeDelivery('h-1', { impressions: 10, spend: 1 })]) },
      testController: {
        getSeededMediaBuyDelivery: () => {
          called = true;
          return [makeDelivery('s-1', { impressions: 999, spend: 999 })];
        },
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.media_buy_deliveries.length, 1);
    assert.equal(res.structuredContent.aggregated_totals.impressions, 10);
  });

  it('validation: warn-and-drop seeded entries missing media_buy_id; valid entries still merge', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuyDelivery: handlerWith([]) },
      testController: {
        getSeededMediaBuyDelivery: () => [
          makeDelivery('ok-1', { impressions: 5, spend: 1 }),
          // missing media_buy_id — dropped
          { status: 'active', totals: { impressions: 999, spend: 999 }, by_package: [] },
        ],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.media_buy_deliveries.map(d => d.media_buy_id),
      ['ok-1']
    );
    assert.equal(res.structuredContent.aggregated_totals.impressions, 5, 'invalid fixture did not contaminate sums');
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 1);
  });

  it('empty merged set: bridge returns []; handler envelope unchanged', async () => {
    const handlerEnvelope = {
      reporting_period: REPORTING_PERIOD,
      currency: 'USD',
      aggregated_totals: { impressions: 42, spend: 2, media_buy_count: 1 },
      media_buy_deliveries: [makeDelivery('h-1', { impressions: 42, spend: 2 })],
    };
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getMediaBuyDelivery: async () => handlerEnvelope },
      testController: {
        getSeededMediaBuyDelivery: () => [],
      },
    });
    const res = await dispatch(server, 'get_media_buy_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.media_buy_deliveries.length, 1);
    assert.equal(res.structuredContent.aggregated_totals.impressions, 42);
    assert.equal(res.structuredContent.aggregated_totals.media_buy_count, 1);
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — selectSeededMediaBuyDelivery wiring
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore — selectSeededMediaBuyDelivery', () => {
  it('wires getSeededMediaBuyDelivery from selectSeededMediaBuyDelivery', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        snapshots: [
          {
            media_buy_id: 'mb-1',
            status: 'active',
            totals: { impressions: 100, spend: 5 },
            by_package: [],
          },
        ],
      }),
      selectSeededProducts: () => undefined,
      selectSeededMediaBuyDelivery: session => session.snapshots,
    });
    const out = await bridge.getSeededMediaBuyDelivery({ input: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].media_buy_id, 'mb-1');
  });

  it('omits getSeededMediaBuyDelivery when no selector is provided', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => undefined,
    });
    assert.equal(bridge.getSeededMediaBuyDelivery, undefined);
  });
});

// ---------------------------------------------------------------------------
// getSeededPropertyLists — list_property_lists (append-merge)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededPropertyLists wiring (list_property_lists)', () => {
  function handlerWith(lists) {
    return async () => ({ lists });
  }

  function plist(id, overrides = {}) {
    return { list_id: id, name: `List ${id}`, ...overrides };
  }

  it('appends seeded property lists to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listPropertyLists: handlerWith([plist('h-1')]) },
      testController: {
        getSeededPropertyLists: () => [plist('s-1'), plist('s-2')],
      },
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['h-1', 's-1', 's-2']
    );
  });

  it('returns seeded-only entries when handler returned empty', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listPropertyLists: handlerWith([]) },
      testController: { getSeededPropertyLists: () => [plist('s-1')] },
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['s-1']
    );
  });

  it('returns handler-only entries when bridge is omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listPropertyLists: handlerWith([plist('h-1'), plist('h-2')]) },
      testController: {},
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['h-1', 'h-2']
    );
  });

  it('seeded wins on list_id collision; mixed [A, B] handler + [B, C] bridge → [A, B-seeded, C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        listPropertyLists: handlerWith([plist('A', { name: 'Handler A' }), plist('B', { name: 'Handler B' })]),
      },
      testController: {
        getSeededPropertyLists: () => [plist('B', { name: 'Seeded B' }), plist('C', { name: 'Seeded C' })],
      },
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    const byId = Object.fromEntries(res.structuredContent.lists.map(l => [l.list_id, l.name]));
    assert.deepEqual(Object.keys(byId).sort(), ['A', 'B', 'C']);
    assert.equal(byId.A, 'Handler A');
    assert.equal(byId.B, 'Seeded B', 'seeded wins on collision');
    assert.equal(byId.C, 'Seeded C');
  });

  it('updates pagination.total_count by the non-colliding seeded count', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        listPropertyLists: async () => ({
          lists: [plist('A'), plist('B')],
          pagination: { has_more: false, total_count: 2 },
        }),
      },
      testController: {
        getSeededPropertyLists: () => [plist('B'), plist('C'), plist('D')],
      },
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    // 2 new seeded (C, D); B collided (seeded wins, no count increment).
    assert.equal(res.structuredContent.pagination.total_count, 4);
  });

  it('does not call the bridge on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listPropertyLists: handlerWith([plist('h-1')]) },
      testController: {
        getSeededPropertyLists: () => {
          called = true;
          return [plist('s-1')];
        },
      },
    });
    const res = await dispatch(server, 'list_property_lists', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['h-1']
    );
  });

  it('drops seeded entries missing list_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listPropertyLists: handlerWith([]) },
      testController: {
        getSeededPropertyLists: () => [plist('ok-1'), { name: 'no id' }, { list_id: '', name: 'empty' }, plist('ok-2')],
      },
    });
    const res = await dispatch(server, 'list_property_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededPropertyLists — get_property_list (singleton replace)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededPropertyLists wiring (get_property_list)', () => {
  function plist(id, overrides = {}) {
    return { list_id: id, name: `List ${id}`, ...overrides };
  }

  it('replaces the response.list field when a seeded fixture matches request.list_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getPropertyList: async () => ({
          list: plist('pl-1', { name: 'Handler' }),
          identifiers: [],
          resolved_at: '2025-05-14T00:00:00Z',
        }),
      },
      testController: {
        getSeededPropertyLists: () => [plist('pl-1', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_property_list', {
      list_id: 'pl-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.list.name, 'Seeded');
  });

  it('passes handler response through when no seeded fixture matches request.list_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getPropertyList: async () => ({ list: plist('pl-1', { name: 'Handler' }) }),
      },
      testController: {
        getSeededPropertyLists: () => [plist('other-id', { name: 'Other' })],
      },
    });
    const res = await dispatch(server, 'get_property_list', {
      list_id: 'pl-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.list.name, 'Handler');
  });

  it('preserves handler context, ext, identifiers, pagination, resolved_at across the replace', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getPropertyList: async () => ({
          list: plist('pl-1', { name: 'Handler' }),
          identifiers: [{ type: 'domain', value: 'example.com' }],
          pagination: { has_more: false, total_count: 1 },
          resolved_at: '2025-05-14T00:00:00Z',
          cache_valid_until: '2025-05-15T00:00:00Z',
          context: { adcp_version: '3.0.11', request_id: 'req-1' },
          ext: { audit: { trace_id: 't-1' } },
        }),
      },
      testController: {
        getSeededPropertyLists: () => [plist('pl-1', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_property_list', {
      list_id: 'pl-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.list.name, 'Seeded');
    assert.deepEqual(res.structuredContent.identifiers, [{ type: 'domain', value: 'example.com' }]);
    assert.deepEqual(res.structuredContent.pagination, { has_more: false, total_count: 1 });
    assert.equal(res.structuredContent.resolved_at, '2025-05-14T00:00:00Z');
    assert.equal(res.structuredContent.cache_valid_until, '2025-05-15T00:00:00Z');
    assert.deepEqual(res.structuredContent.context, { adcp_version: '3.0.11', request_id: 'req-1' });
    assert.deepEqual(res.structuredContent.ext, { audit: { trace_id: 't-1' } });
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getPropertyList: async () => ({ list: plist('pl-1', { name: 'Handler' }) }),
      },
      testController: {
        getSeededPropertyLists: () => {
          called = true;
          return [plist('pl-1', { name: 'Seeded' })];
        },
      },
    });
    const res = await dispatch(server, 'get_property_list', {
      list_id: 'pl-1',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.list.name, 'Handler');
  });
});

// ---------------------------------------------------------------------------
// getSeededCollectionLists — list_collection_lists + get_collection_list
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededCollectionLists wiring (list_collection_lists)', () => {
  function clist(id, overrides = {}) {
    return { list_id: id, name: `Collection ${id}`, ...overrides };
  }

  it('appends seeded collection lists to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listCollectionLists: async () => ({ lists: [clist('h-1')] }) },
      testController: {
        getSeededCollectionLists: () => [clist('s-1'), clist('s-2')],
      },
    });
    const res = await dispatch(server, 'list_collection_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['h-1', 's-1', 's-2']
    );
  });

  it('seeded wins on list_id collision; mixed [A, B] + [B, C] → [A, B-seeded, C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        listCollectionLists: async () => ({
          lists: [clist('A', { name: 'Handler A' }), clist('B', { name: 'Handler B' })],
        }),
      },
      testController: {
        getSeededCollectionLists: () => [clist('B', { name: 'Seeded B' }), clist('C', { name: 'Seeded C' })],
      },
    });
    const res = await dispatch(server, 'list_collection_lists', { account: SANDBOX_ACCOUNT });
    const byId = Object.fromEntries(res.structuredContent.lists.map(l => [l.list_id, l.name]));
    assert.deepEqual(Object.keys(byId).sort(), ['A', 'B', 'C']);
    assert.equal(byId.A, 'Handler A');
    assert.equal(byId.B, 'Seeded B');
    assert.equal(byId.C, 'Seeded C');
  });

  it('updates pagination.total_count by the non-colliding seeded count', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        listCollectionLists: async () => ({
          lists: [clist('A')],
          pagination: { has_more: false, total_count: 1 },
        }),
      },
      testController: {
        getSeededCollectionLists: () => [clist('A'), clist('B')],
      },
    });
    const res = await dispatch(server, 'list_collection_lists', { account: SANDBOX_ACCOUNT });
    // Only B is new (A collided).
    assert.equal(res.structuredContent.pagination.total_count, 2);
  });

  it('handler-only when bridge omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listCollectionLists: async () => ({ lists: [clist('h-1')] }) },
      testController: {},
    });
    const res = await dispatch(server, 'list_collection_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['h-1']
    );
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listCollectionLists: async () => ({ lists: [clist('h-1')] }) },
      testController: {
        getSeededCollectionLists: () => {
          called = true;
          return [clist('s-1')];
        },
      },
    });
    const res = await dispatch(server, 'list_collection_lists', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['h-1']
    );
  });

  it('drops seeded entries missing list_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listCollectionLists: async () => ({ lists: [] }) },
      testController: {
        getSeededCollectionLists: () => [clist('ok-1'), { name: 'no id' }, { list_id: '' }, clist('ok-2')],
      },
    });
    const res = await dispatch(server, 'list_collection_lists', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.lists.map(l => l.list_id),
      ['ok-1', 'ok-2']
    );
  });
});

describe('createAdcpServer — getSeededCollectionLists wiring (get_collection_list)', () => {
  function clist(id, overrides = {}) {
    return { list_id: id, name: `Collection ${id}`, ...overrides };
  }

  it('replaces response.list when a seeded fixture matches request.list_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCollectionList: async () => ({ list: clist('cl-1', { name: 'Handler' }) }),
      },
      testController: {
        getSeededCollectionLists: () => [clist('cl-1', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_collection_list', {
      list_id: 'cl-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.list.name, 'Seeded');
  });

  it('passes handler response through when no fixture matches request.list_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCollectionList: async () => ({ list: clist('cl-1', { name: 'Handler' }) }),
      },
      testController: {
        getSeededCollectionLists: () => [clist('other', { name: 'Other' })],
      },
    });
    const res = await dispatch(server, 'get_collection_list', {
      list_id: 'cl-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.list.name, 'Handler');
  });

  it('preserves handler context, ext, collections, pagination across replace', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCollectionList: async () => ({
          list: clist('cl-1', { name: 'Handler' }),
          collections: [{ name: 'Coll A' }],
          pagination: { has_more: false, total_count: 1 },
          resolved_at: '2025-05-14T00:00:00Z',
          context: { adcp_version: '3.0.11', request_id: 'req-2' },
          ext: { tag: 'preserve-me' },
        }),
      },
      testController: {
        getSeededCollectionLists: () => [clist('cl-1', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_collection_list', {
      list_id: 'cl-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.list.name, 'Seeded');
    assert.deepEqual(res.structuredContent.collections, [{ name: 'Coll A' }]);
    assert.deepEqual(res.structuredContent.pagination, { has_more: false, total_count: 1 });
    assert.equal(res.structuredContent.resolved_at, '2025-05-14T00:00:00Z');
    assert.deepEqual(res.structuredContent.context, { adcp_version: '3.0.11', request_id: 'req-2' });
    assert.deepEqual(res.structuredContent.ext, { tag: 'preserve-me' });
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCollectionList: async () => ({ list: clist('cl-1', { name: 'Handler' }) }),
      },
      testController: {
        getSeededCollectionLists: () => {
          called = true;
          return [clist('cl-1', { name: 'Seeded' })];
        },
      },
    });
    const res = await dispatch(server, 'get_collection_list', {
      list_id: 'cl-1',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.list.name, 'Handler');
  });
});

// ---------------------------------------------------------------------------
// getSeededContentStandards — list_content_standards (append-merge)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededContentStandards wiring (list_content_standards)', () => {
  function cs(id, overrides = {}) {
    return { standards_id: id, name: `Standards ${id}`, ...overrides };
  }

  it('appends seeded content-standards to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listContentStandards: async () => ({ standards: [cs('h-1')] }) },
      testController: {
        getSeededContentStandards: () => [cs('s-1'), cs('s-2')],
      },
    });
    const res = await dispatch(server, 'list_content_standards', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.standards.map(s => s.standards_id),
      ['h-1', 's-1', 's-2']
    );
  });

  it('seeded wins on standards_id collision; mixed [A, B] + [B, C] → [A, B-seeded, C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        listContentStandards: async () => ({
          standards: [cs('A', { name: 'Handler A' }), cs('B', { name: 'Handler B' })],
        }),
      },
      testController: {
        getSeededContentStandards: () => [cs('B', { name: 'Seeded B' }), cs('C', { name: 'Seeded C' })],
      },
    });
    const res = await dispatch(server, 'list_content_standards', { account: SANDBOX_ACCOUNT });
    const byId = Object.fromEntries(res.structuredContent.standards.map(s => [s.standards_id, s.name]));
    assert.deepEqual(Object.keys(byId).sort(), ['A', 'B', 'C']);
    assert.equal(byId.A, 'Handler A');
    assert.equal(byId.B, 'Seeded B');
    assert.equal(byId.C, 'Seeded C');
  });

  it('updates pagination.total_count by the non-colliding seeded count', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        listContentStandards: async () => ({
          standards: [cs('A')],
          pagination: { has_more: false, total_count: 1 },
        }),
      },
      testController: { getSeededContentStandards: () => [cs('A'), cs('B'), cs('C')] },
    });
    const res = await dispatch(server, 'list_content_standards', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.pagination.total_count, 3);
  });

  it('handler-only when bridge omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listContentStandards: async () => ({ standards: [cs('h-1')] }) },
      testController: {},
    });
    const res = await dispatch(server, 'list_content_standards', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.standards.map(s => s.standards_id),
      ['h-1']
    );
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listContentStandards: async () => ({ standards: [cs('h-1')] }) },
      testController: {
        getSeededContentStandards: () => {
          called = true;
          return [cs('s-1')];
        },
      },
    });
    const res = await dispatch(server, 'list_content_standards', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.standards.map(s => s.standards_id),
      ['h-1']
    );
  });

  it('drops seeded entries missing standards_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: { listContentStandards: async () => ({ standards: [] }) },
      testController: {
        getSeededContentStandards: () => [cs('ok-1'), { name: 'no id' }, { standards_id: '' }, cs('ok-2')],
      },
    });
    const res = await dispatch(server, 'list_content_standards', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.standards.map(s => s.standards_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededContentStandards — get_content_standards (singleton replace)
//
// Unlike PropertyList / CollectionList, the success arm of
// GetContentStandardsResponse IS `ContentStandards` directly — no envelope
// wrapper. Replace the entire response; preserve only the handler's `ext`.
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededContentStandards wiring (get_content_standards)', () => {
  function cs(id, overrides = {}) {
    return { standards_id: id, name: `Standards ${id}`, ...overrides };
  }

  it('replaces the response with seeded fixture when standards_id matches', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getContentStandards: async () => cs('cs-1', { name: 'Handler' }),
      },
      testController: {
        getSeededContentStandards: () => [cs('cs-1', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_content_standards', {
      standards_id: 'cs-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.name, 'Seeded');
    assert.equal(res.structuredContent.standards_id, 'cs-1');
  });

  it('passes handler response through when no fixture matches request.standards_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getContentStandards: async () => cs('cs-1', { name: 'Handler' }),
      },
      testController: {
        getSeededContentStandards: () => [cs('other', { name: 'Other' })],
      },
    });
    const res = await dispatch(server, 'get_content_standards', {
      standards_id: 'cs-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.name, 'Handler');
  });

  it('preserves handler.ext on replace; seeded ext loses', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getContentStandards: async () => ({
          ...cs('cs-1', { name: 'Handler' }),
          ext: { audit: { trace_id: 't-cs' } },
        }),
      },
      testController: {
        getSeededContentStandards: () => [{ ...cs('cs-1', { name: 'Seeded' }), ext: { audit: { trace_id: 'WRONG' } } }],
      },
    });
    const res = await dispatch(server, 'get_content_standards', {
      standards_id: 'cs-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.name, 'Seeded', 'body replaced');
    assert.deepEqual(res.structuredContent.ext, { audit: { trace_id: 't-cs' } }, 'handler ext preserved');
  });

  it('getSeededContentStandards: replace preserves handler context and ext', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getContentStandards: async () => ({
          // Handler returns envelope with context echo + ext, alongside the body.
          context: { adcp_version: '3.0.11', request_id: 'req-cs-ctx' },
          ext: { audit: { trace_id: 't-cs-ctx' } },
          ...cs('cs-1', { name: 'Handler' }),
        }),
      },
      testController: {
        // Seeded fixture has NO context / NO ext — just the standards body.
        // Replace must preserve the handler's context echo, not strip it.
        getSeededContentStandards: () => [cs('cs-1', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_content_standards', {
      standards_id: 'cs-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.name, 'Seeded', 'standards body replaced by seeded fixture');
    assert.equal(res.structuredContent.standards_id, 'cs-1');
    assert.deepEqual(
      res.structuredContent.context,
      { adcp_version: '3.0.11', request_id: 'req-cs-ctx' },
      'handler context preserved across replace'
    );
    assert.deepEqual(
      res.structuredContent.ext,
      { audit: { trace_id: 't-cs-ctx' } },
      'handler ext preserved across replace'
    );
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getContentStandards: async () => cs('cs-1', { name: 'Handler' }),
      },
      testController: {
        getSeededContentStandards: () => {
          called = true;
          return [cs('cs-1', { name: 'Seeded' })];
        },
      },
    });
    const res = await dispatch(server, 'get_content_standards', {
      standards_id: 'cs-1',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.name, 'Handler');
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — governance selectors
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore — governance selectors', () => {
  it('wires getSeededPropertyLists from selectSeededPropertyLists', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ pls: [{ list_id: 'pl-a', name: 'A' }] }),
      selectSeededProducts: () => undefined,
      selectSeededPropertyLists: session => session.pls,
    });
    const out = await bridge.getSeededPropertyLists({ input: {} });
    assert.deepEqual(
      out.map(l => l.list_id),
      ['pl-a']
    );
  });

  it('wires getSeededCollectionLists from selectSeededCollectionLists', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ cls: [{ list_id: 'cl-a', name: 'A' }] }),
      selectSeededProducts: () => undefined,
      selectSeededCollectionLists: session => session.cls,
    });
    const out = await bridge.getSeededCollectionLists({ input: {} });
    assert.deepEqual(
      out.map(l => l.list_id),
      ['cl-a']
    );
  });

  it('wires getSeededContentStandards from selectSeededContentStandards', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ cs: [{ standards_id: 'cs-a', name: 'A' }] }),
      selectSeededProducts: () => undefined,
      selectSeededContentStandards: session => session.cs,
    });
    const out = await bridge.getSeededContentStandards({ input: {} });
    assert.deepEqual(
      out.map(s => s.standards_id),
      ['cs-a']
    );
  });

  it('omits governance per-tool callbacks when no selectors are provided', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => undefined,
    });
    assert.equal(bridge.getSeededPropertyLists, undefined);
    assert.equal(bridge.getSeededCollectionLists, undefined);
    assert.equal(bridge.getSeededContentStandards, undefined);
  });
});

// ---------------------------------------------------------------------------
// getSeededSignals — get_signals (append-merge by signal_id)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededSignals wiring (get_signals)', () => {
  // SignalID is a discriminated union; build a canonical fixture matcher.
  function catalogSignal(id, dataProvider = 'polk.com', overrides = {}) {
    return {
      signal_id: { source: 'catalog', data_provider_domain: dataProvider, id },
      signal_agent_segment_id: `seg-${id}`,
      name: `Signal ${id}`,
      description: `Description ${id}`,
      signal_type: 'marketplace',
      data_provider: 'Polk',
      coverage_percentage: 50,
      deployments: [],
      pricing_options: [
        {
          pricing_option_id: 'p1',
          currency: 'USD',
          cpm: 1,
        },
      ],
      ...overrides,
    };
  }

  function agentSignal(id, agentUrl = 'https://signals.example/.well-known/adcp/signals', overrides = {}) {
    return {
      signal_id: { source: 'agent', agent_url: agentUrl, id },
      signal_agent_segment_id: `seg-${id}`,
      name: `Signal ${id}`,
      description: `Description ${id}`,
      signal_type: 'owned',
      data_provider: 'Agent',
      coverage_percentage: 30,
      deployments: [],
      pricing_options: [
        {
          pricing_option_id: 'p1',
          currency: 'USD',
          cpm: 1,
        },
      ],
      ...overrides,
    };
  }

  function handlerWith(signals) {
    return async () => ({ signals });
  }

  it('appends seeded signals to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: {
        getSignals: handlerWith([catalogSignal('h-1')]),
      },
      testController: {
        getSeededSignals: () => [catalogSignal('s-1'), catalogSignal('s-2')],
      },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'auto buyers',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    const ids = res.structuredContent.signals.map(s => s.signal_id.id);
    assert.deepEqual(ids, ['h-1', 's-1', 's-2']);
    assert.equal(res.structuredContent.sandbox, true);
  });

  it('returns handler-only entries when getSeededSignals is omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: { getSignals: handlerWith([catalogSignal('h-1'), catalogSignal('h-2')]) },
      testController: {},
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.signals.map(s => s.signal_id.id),
      ['h-1', 'h-2']
    );
  });

  it('seeded wins on canonical (source,origin,id) collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: {
        getSignals: handlerWith([
          catalogSignal('shared', 'polk.com', { name: 'Handler' }),
          catalogSignal('h-only', 'polk.com'),
        ]),
      },
      testController: {
        getSeededSignals: () => [catalogSignal('shared', 'polk.com', { name: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    const byId = Object.fromEntries(res.structuredContent.signals.map(s => [s.signal_id.id, s.name]));
    assert.equal(byId.shared, 'Seeded');
    assert.equal(byId['h-only'], 'Signal h-only');
  });

  it('mixed collision: handler [A,B] + bridge [B,C] → merged [A,B-seeded,C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: {
        getSignals: handlerWith([
          catalogSignal('A', 'polk.com', { coverage_percentage: 10 }),
          catalogSignal('B', 'polk.com', { coverage_percentage: 20 }),
        ]),
      },
      testController: {
        getSeededSignals: () => [
          catalogSignal('B', 'polk.com', { coverage_percentage: 99 }), // collides → seeded wins
          catalogSignal('C', 'polk.com', { coverage_percentage: 30 }), // new → appended
        ],
      },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.signals.map(s => s.signal_id.id),
      ['A', 'B', 'C']
    );
    const byId = Object.fromEntries(res.structuredContent.signals.map(s => [s.signal_id.id, s.coverage_percentage]));
    assert.equal(byId.A, 10);
    assert.equal(byId.B, 99, 'B replaced by seeded value');
    assert.equal(byId.C, 30);
  });

  it('catalog and agent signals with the same id are distinct (different sources)', async () => {
    // signal_id discriminator: {source:'catalog'} vs {source:'agent'} make
    // these two different signals even though both have id='shared'.
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: {
        getSignals: handlerWith([catalogSignal('shared', 'polk.com', { name: 'Catalog one' })]),
      },
      testController: {
        getSeededSignals: () => [
          agentSignal('shared', 'https://signals.example/.well-known/adcp/signals', { name: 'Agent one' }),
        ],
      },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    // Both entries survive — different source discriminator.
    assert.equal(res.structuredContent.signals.length, 2);
    const sources = res.structuredContent.signals.map(s => s.signal_id.source).sort();
    assert.deepEqual(sources, ['agent', 'catalog']);
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: { getSignals: handlerWith([catalogSignal('h-1')]) },
      testController: {
        getSeededSignals: () => {
          called = true;
          return [catalogSignal('s-1')];
        },
      },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.signals.map(s => s.signal_id.id),
      ['h-1']
    );
  });

  it('drops seeded entries with invalid signal_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      signals: { getSignals: handlerWith([]) },
      testController: {
        getSeededSignals: () => [
          catalogSignal('ok-1'),
          { /* no signal_id at all */ name: 'no id' },
          { signal_id: { source: 'catalog' /* missing id and origin */ }, name: 'bad' },
          { signal_id: { source: 'agent', agent_url: '', id: 'empty-url' }, name: 'bad' },
          { signal_id: 'not-an-object', name: 'bad' },
          catalogSignal('ok-2'),
        ],
      },
    });
    const res = await dispatch(server, 'get_signals', {
      signal_spec: 'x',
      deliver_to: { platforms: 'all', countries: ['US'] },
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.signals.map(s => s.signal_id.id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededCreativeDelivery — get_creative_delivery (append-merge by creative_id)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededCreativeDelivery wiring (get_creative_delivery)', () => {
  const REPORTING_PERIOD = { start: '2025-01-01T00:00:00Z', end: '2025-01-31T23:59:59Z' };

  function makeDelivery(creative_id, overrides = {}) {
    return {
      creative_id,
      variants: [],
      ...overrides,
    };
  }

  function handlerWith(creatives, pagination = undefined) {
    return async () => {
      const out = {
        reporting_period: REPORTING_PERIOD,
        currency: 'USD',
        creatives,
      };
      if (pagination) out.pagination = pagination;
      return out;
    };
  }

  it('seeded-only: empty handler, two seeded entries append', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([]),
      },
      testController: {
        getSeededCreativeDelivery: () => [makeDelivery('s-1'), makeDelivery('s-2')],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['s-1', 's-2']
    );
  });

  it('handler-only: bridge omitted, response passes through verbatim', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([makeDelivery('h-1')]),
      },
      testController: {},
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['h-1']
    );
  });

  it('append-merge: handler [h-1] + bridge [s-1, s-2] → [h-1, s-1, s-2]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([makeDelivery('h-1')]),
      },
      testController: {
        getSeededCreativeDelivery: () => [makeDelivery('s-1'), makeDelivery('s-2')],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['h-1', 's-1', 's-2']
    );
  });

  it('seeded wins on creative_id collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([
          makeDelivery('shared', { totals: { impressions: 1 } }),
          makeDelivery('h-only'),
        ]),
      },
      testController: {
        getSeededCreativeDelivery: () => [makeDelivery('shared', { totals: { impressions: 999 } })],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.creatives.length, 2);
    const byId = Object.fromEntries(res.structuredContent.creatives.map(c => [c.creative_id, c]));
    assert.equal(byId.shared.totals.impressions, 999, 'seeded wins on collision');
  });

  it('mixed collision: handler [A,B] + bridge [B,C] → merged [A, B-seeded, C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([
          makeDelivery('A', { variant_count: 1 }),
          makeDelivery('B', { variant_count: 2 }),
        ]),
      },
      testController: {
        getSeededCreativeDelivery: () => [
          makeDelivery('B', { variant_count: 99 }), // collides → seeded wins
          makeDelivery('C', { variant_count: 3 }), // new → appended
        ],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['A', 'B', 'C']
    );
    const byId = Object.fromEntries(res.structuredContent.creatives.map(c => [c.creative_id, c.variant_count]));
    assert.equal(byId.A, 1);
    assert.equal(byId.B, 99);
    assert.equal(byId.C, 3);
  });

  it('pagination.total updates by newCount on append-merge', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([makeDelivery('h-1'), makeDelivery('h-2')], {
          limit: 50,
          offset: 0,
          has_more: true,
          total: 50,
        }),
      },
      testController: {
        getSeededCreativeDelivery: () => [makeDelivery('s-1'), makeDelivery('s-2'), makeDelivery('s-3')],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.creatives.length, 5);
    assert.equal(res.structuredContent.pagination.total, 53);
  });

  it('pagination.total: no drift on full collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: {
        getCreativeDelivery: handlerWith([makeDelivery('shared-1'), makeDelivery('shared-2')], {
          limit: 50,
          offset: 0,
          has_more: false,
          total: 10,
        }),
      },
      testController: {
        getSeededCreativeDelivery: () => [
          makeDelivery('shared-1', { variant_count: 1 }),
          makeDelivery('shared-2', { variant_count: 1 }),
        ],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.equal(res.structuredContent.creatives.length, 2);
    assert.equal(res.structuredContent.pagination.total, 10, 'no drift on full collision');
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { getCreativeDelivery: handlerWith([makeDelivery('h-1')]) },
      testController: {
        getSeededCreativeDelivery: () => {
          called = true;
          return [makeDelivery('s-1')];
        },
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['h-1']
    );
  });

  it('drops seeded entries missing creative_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { getCreativeDelivery: handlerWith([]) },
      testController: {
        getSeededCreativeDelivery: () => [
          makeDelivery('ok-1'),
          { variants: [] /* no id */ },
          { creative_id: '', variants: [] },
          makeDelivery('ok-2'),
        ],
      },
    });
    const res = await dispatch(server, 'get_creative_delivery', { account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededCreativeFeatures — get_creative_features (merge into results[] by feature_id)
//
// `get_creative_features` is a `oneOf` envelope. Success arm carries
// `results: CreativeFeatureResult[]`; error arm carries `errors: Error[]`.
// The bridge seeds at the per-feature granularity — adopters override
// specific feature scores without rewriting the whole evaluation handler.
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededCreativeFeatures wiring (get_creative_features)', () => {
  function feature(id, value, overrides = {}) {
    return { feature_id: id, value, ...overrides };
  }

  function manifest() {
    return {
      format_id: { agent_url: 'https://x.example', id: 'fmt-1' },
      assets: {},
    };
  }

  it('merges seeded results into handler success-arm results array', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({
          results: [feature('quality', 0.5)],
        }),
      },
      testController: {
        getSeededCreativeFeatures: () => [feature('brand_safety', true), feature('toxicity', 0.1)],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    const ids = res.structuredContent.results.map(r => r.feature_id);
    assert.deepEqual(ids, ['quality', 'brand_safety', 'toxicity']);
  });

  it('handler-only: bridge omitted, response passes through', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({ results: [feature('q', 1)] }),
      },
      testController: {},
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.results.map(r => r.feature_id),
      ['q']
    );
  });

  it('seeded wins on feature_id collision; handler value replaced', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({
          results: [feature('brand_safety', false), feature('quality', 0.7)],
        }),
      },
      testController: {
        getSeededCreativeFeatures: () => [feature('brand_safety', true, { confidence: 0.95 })],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    const byId = Object.fromEntries(res.structuredContent.results.map(r => [r.feature_id, r]));
    assert.equal(byId.brand_safety.value, true);
    assert.equal(byId.brand_safety.confidence, 0.95);
    assert.equal(byId.quality.value, 0.7);
  });

  it('mixed collision: handler [A,B] + bridge [B,C] → merged [A, B-seeded, C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({
          results: [feature('A', 0.1), feature('B', 0.2)],
        }),
      },
      testController: {
        getSeededCreativeFeatures: () => [feature('B', 0.99), feature('C', 0.3)],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.results.map(r => r.feature_id),
      ['A', 'B', 'C']
    );
    const byId = Object.fromEntries(res.structuredContent.results.map(r => [r.feature_id, r.value]));
    assert.equal(byId.A, 0.1);
    assert.equal(byId.B, 0.99);
    assert.equal(byId.C, 0.3);
  });

  it('error arm passes through unchanged (no-op)', async () => {
    // When the handler returned the error arm of the oneOf envelope, the
    // bridge MUST be a no-op — the seeded results array can't be grafted
    // onto an error envelope without producing a wire-incorrect mixed shape.
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({
          errors: [{ code: 'EVAL_FAILED', message: 'cannot evaluate' }],
        }),
      },
      testController: {
        getSeededCreativeFeatures: () => [feature('brand_safety', true)],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.results, undefined, 'no results grafted onto error arm');
    assert.equal(res.structuredContent.errors[0].code, 'EVAL_FAILED');
  });

  it('preserves handler context, ext, and other success-arm envelope fields', async () => {
    // The framework-managed envelope fields (`context`, `ext`,
    // `detail_url`, `pricing_option_id`, `vendor_cost`, `currency`,
    // `consumption`) must round-trip from the handler verbatim.
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({
          results: [feature('q', 0.5)],
          context: { adcp_version: '3.0.11', request_id: 'req-feat-1' },
          ext: { audit: { trace_id: 't-feat' } },
          detail_url: 'https://vendor.example/report/123',
          vendor_cost: 0.05,
          currency: 'USD',
        }),
      },
      testController: {
        getSeededCreativeFeatures: () => [feature('brand_safety', true)],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.context,
      { adcp_version: '3.0.11', request_id: 'req-feat-1' },
      'handler context preserved'
    );
    assert.deepEqual(res.structuredContent.ext, { audit: { trace_id: 't-feat' } }, 'handler ext preserved');
    assert.equal(res.structuredContent.detail_url, 'https://vendor.example/report/123');
    assert.equal(res.structuredContent.vendor_cost, 0.05);
    assert.equal(res.structuredContent.currency, 'USD');
    assert.equal(res.structuredContent.results.length, 2);
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({ results: [feature('q', 0.5)] }),
      },
      testController: {
        getSeededCreativeFeatures: () => {
          called = true;
          return [feature('brand_safety', true)];
        },
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.results.map(r => r.feature_id),
      ['q']
    );
  });

  it('drops seeded entries missing feature_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      governance: {
        getCreativeFeatures: async () => ({ results: [] }),
      },
      testController: {
        getSeededCreativeFeatures: () => [
          feature('ok-1', 1),
          { value: 'no id' },
          { feature_id: '', value: 'empty id' },
          feature('ok-2', 2),
        ],
      },
    });
    const res = await dispatch(server, 'get_creative_features', {
      creative_manifest: manifest(),
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.results.map(r => r.feature_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — signals / creative-delivery / creative-features selectors
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore — signals / creative selectors', () => {
  it('wires getSeededSignals from selectSeededSignals', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        sigs: [
          {
            signal_id: { source: 'catalog', data_provider_domain: 'polk.com', id: 's-1' },
            signal_agent_segment_id: 'seg-1',
            name: 'A',
            description: 'A',
            signal_type: 'marketplace',
            data_provider: 'Polk',
            coverage_percentage: 50,
            deployments: [],
            pricing_options: [{ pricing_option_id: 'p1', currency: 'USD', cpm: 1 }],
          },
        ],
      }),
      selectSeededProducts: () => undefined,
      selectSeededSignals: session => session.sigs,
    });
    const out = await bridge.getSeededSignals({ input: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].signal_id.id, 's-1');
  });

  it('wires getSeededCreativeDelivery from selectSeededCreativeDelivery', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        deliveries: [{ creative_id: 'c-1', variants: [] }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededCreativeDelivery: session => session.deliveries,
    });
    const out = await bridge.getSeededCreativeDelivery({ input: {} });
    assert.deepEqual(
      out.map(d => d.creative_id),
      ['c-1']
    );
  });

  it('wires getSeededCreativeFeatures from selectSeededCreativeFeatures', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        feats: [{ feature_id: 'brand_safety', value: true }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededCreativeFeatures: session => session.feats,
    });
    const out = await bridge.getSeededCreativeFeatures({ input: {} });
    assert.deepEqual(
      out.map(f => f.feature_id),
      ['brand_safety']
    );
  });

  it('omits signals / creative-delivery / features callbacks when no selectors provided', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => undefined,
    });
    assert.equal(bridge.getSeededSignals, undefined);
    assert.equal(bridge.getSeededCreativeDelivery, undefined);
    assert.equal(bridge.getSeededCreativeFeatures, undefined);
  });
});

// ---------------------------------------------------------------------------
// getSeededBrandIdentity — get_brand_identity (singleton replace, brand_id key)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededBrandIdentity wiring (get_brand_identity)', () => {
  function bi(brandId, overrides = {}) {
    return {
      brand_id: brandId,
      house: { domain: 'example.com', name: 'Example' },
      names: [{ en_US: `Brand ${brandId}` }],
      ...overrides,
    };
  }

  it('replaces the response with seeded fixture when brand_id matches', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: {
        getBrandIdentity: async () => bi('b-1', { description: 'Handler' }),
      },
      testController: {
        getSeededBrandIdentity: () => [bi('b-1', { description: 'Seeded' })],
      },
    });
    const res = await dispatch(server, 'get_brand_identity', {
      brand_id: 'b-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.brand_id, 'b-1');
    assert.equal(res.structuredContent.description, 'Seeded');
  });

  it('passes handler response through when no fixture matches request.brand_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: {
        getBrandIdentity: async () => bi('b-1', { description: 'Handler' }),
      },
      testController: {
        getSeededBrandIdentity: () => [bi('other', { description: 'Other' })],
      },
    });
    const res = await dispatch(server, 'get_brand_identity', {
      brand_id: 'b-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.description, 'Handler');
  });

  it('preserves handler context and ext on replace; seeded context/ext lose', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: {
        getBrandIdentity: async () => ({
          ...bi('b-1', { description: 'Handler' }),
          context: { adcp_version: '3.0.11', request_id: 'req-bi' },
          ext: { audit: { trace_id: 't-bi' } },
        }),
      },
      testController: {
        getSeededBrandIdentity: () => [
          {
            ...bi('b-1', { description: 'Seeded' }),
            context: { adcp_version: 'WRONG', request_id: 'WRONG' },
            ext: { audit: { trace_id: 'WRONG' } },
          },
        ],
      },
    });
    const res = await dispatch(server, 'get_brand_identity', {
      brand_id: 'b-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.description, 'Seeded', 'body replaced');
    assert.deepEqual(
      res.structuredContent.context,
      { adcp_version: '3.0.11', request_id: 'req-bi' },
      'handler context preserved'
    );
    assert.deepEqual(res.structuredContent.ext, { audit: { trace_id: 't-bi' } }, 'handler ext preserved');
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: {
        getBrandIdentity: async () => bi('b-1', { description: 'Handler' }),
      },
      testController: {
        getSeededBrandIdentity: () => {
          called = true;
          return [bi('b-1', { description: 'Seeded' })];
        },
      },
    });
    const res = await dispatch(server, 'get_brand_identity', {
      brand_id: 'b-1',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.description, 'Handler');
  });

  it('drops seeded entries missing brand_id and duplicates (first wins)', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: {
        getBrandIdentity: async () => bi('b-2', { description: 'Handler' }),
      },
      testController: {
        getSeededBrandIdentity: () => [
          { house: { domain: 'x', name: 'x' }, names: [] }, // missing brand_id
          { brand_id: '', house: { domain: 'x', name: 'x' }, names: [] }, // empty
          bi('b-2', { description: 'First B-2' }),
          bi('b-2', { description: 'Duplicate B-2 — dropped' }),
        ],
      },
    });
    const res = await dispatch(server, 'get_brand_identity', {
      brand_id: 'b-2',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.description, 'First B-2');
  });
});

// ---------------------------------------------------------------------------
// getSeededRights — get_rights (append-merge, rights_id key)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededRights wiring (get_rights)', () => {
  function rt(rightsId, overrides = {}) {
    return {
      rights_id: rightsId,
      brand_id: 'brand-a',
      name: `Right ${rightsId}`,
      available_uses: ['likeness'],
      pricing_options: [],
      ...overrides,
    };
  }
  function handlerWith(rights) {
    return async () => ({ rights });
  }

  it('appends seeded rights to handler output on sandbox requests', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getRights: handlerWith([rt('h-1')]) },
      testController: {
        getSeededRights: () => [rt('s-1'), rt('s-2')],
      },
    });
    const res = await dispatch(server, 'get_rights', {
      query: 'anything',
      account: SANDBOX_ACCOUNT,
    });
    assert.deepEqual(
      res.structuredContent.rights.map(r => r.rights_id),
      ['h-1', 's-1', 's-2']
    );
  });

  it('returns seeded-only entries when handler returned empty', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getRights: handlerWith([]) },
      testController: { getSeededRights: () => [rt('s-1')] },
    });
    const res = await dispatch(server, 'get_rights', { query: 'q', account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.rights.map(r => r.rights_id),
      ['s-1']
    );
  });

  it('returns handler-only entries when bridge is omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getRights: handlerWith([rt('h-1'), rt('h-2')]) },
      testController: {},
    });
    const res = await dispatch(server, 'get_rights', { query: 'q', account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.rights.map(r => r.rights_id),
      ['h-1', 'h-2']
    );
  });

  it('seeded wins on rights_id collision; mixed [A, B] handler + [B, C] bridge → [A, B-seeded, C]', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: {
        getRights: handlerWith([rt('A', { name: 'Handler A' }), rt('B', { name: 'Handler B' })]),
      },
      testController: {
        getSeededRights: () => [rt('B', { name: 'Seeded B' }), rt('C', { name: 'Seeded C' })],
      },
    });
    const res = await dispatch(server, 'get_rights', { query: 'q', account: SANDBOX_ACCOUNT });
    const byId = Object.fromEntries(res.structuredContent.rights.map(r => [r.rights_id, r.name]));
    assert.deepEqual(Object.keys(byId).sort(), ['A', 'B', 'C']);
    assert.equal(byId.A, 'Handler A');
    assert.equal(byId.B, 'Seeded B', 'seeded wins on collision');
    assert.equal(byId.C, 'Seeded C');
  });

  it('does not call the bridge on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getRights: handlerWith([rt('h-1')]) },
      testController: {
        getSeededRights: () => {
          called = true;
          return [rt('s-1')];
        },
      },
    });
    const res = await dispatch(server, 'get_rights', {
      query: 'q',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.deepEqual(
      res.structuredContent.rights.map(r => r.rights_id),
      ['h-1']
    );
  });

  it('drops seeded entries missing rights_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      brandRights: { getRights: handlerWith([]) },
      testController: {
        getSeededRights: () => [rt('ok-1'), { name: 'no id' }, { rights_id: '', name: 'empty' }, rt('ok-2')],
      },
    });
    const res = await dispatch(server, 'get_rights', { query: 'q', account: SANDBOX_ACCOUNT });
    assert.deepEqual(
      res.structuredContent.rights.map(r => r.rights_id),
      ['ok-1', 'ok-2']
    );
  });
});

// ---------------------------------------------------------------------------
// getSeededSiOffering — si_get_offering (singleton replace, offering_id key)
// ---------------------------------------------------------------------------

describe('createAdcpServer — getSeededSiOffering wiring (si_get_offering)', () => {
  function off(offeringId, overrides = {}) {
    return {
      available: true,
      offering: { offering_id: offeringId, title: `Offering ${offeringId}`, ...(overrides.offering ?? {}) },
      ...(overrides.top ?? {}),
    };
  }

  it('replaces the response with seeded fixture when offering.offering_id matches request.offering_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      sponsoredIntelligence: {
        getOffering: async () => off('o-1', { offering: { title: 'Handler' } }),
      },
      testController: {
        getSeededSiOffering: () => [off('o-1', { offering: { title: 'Seeded' } })],
      },
    });
    const res = await dispatch(server, 'si_get_offering', {
      offering_id: 'o-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.offering.title, 'Seeded');
    assert.equal(res.structuredContent.offering.offering_id, 'o-1');
  });

  it('passes handler response through when no fixture matches request.offering_id', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      sponsoredIntelligence: {
        getOffering: async () => off('o-1', { offering: { title: 'Handler' } }),
      },
      testController: {
        getSeededSiOffering: () => [off('other', { offering: { title: 'Other' } })],
      },
    });
    const res = await dispatch(server, 'si_get_offering', {
      offering_id: 'o-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.offering.title, 'Handler');
  });

  it('preserves handler context and ext on replace; seeded context/ext lose', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      sponsoredIntelligence: {
        getOffering: async () => ({
          ...off('o-1', { offering: { title: 'Handler' } }),
          context: { adcp_version: '3.0.11', request_id: 'req-si' },
          ext: { audit: { trace_id: 't-si' } },
        }),
      },
      testController: {
        getSeededSiOffering: () => [
          {
            ...off('o-1', { offering: { title: 'Seeded' } }),
            context: { adcp_version: 'WRONG', request_id: 'WRONG' },
            ext: { audit: { trace_id: 'WRONG' } },
          },
        ],
      },
    });
    const res = await dispatch(server, 'si_get_offering', {
      offering_id: 'o-1',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.offering.title, 'Seeded', 'body replaced');
    assert.deepEqual(
      res.structuredContent.context,
      { adcp_version: '3.0.11', request_id: 'req-si' },
      'handler context preserved'
    );
    assert.deepEqual(res.structuredContent.ext, { audit: { trace_id: 't-si' } }, 'handler ext preserved');
  });

  it('skipped on non-sandbox requests', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      sponsoredIntelligence: {
        getOffering: async () => off('o-1', { offering: { title: 'Handler' } }),
      },
      testController: {
        getSeededSiOffering: () => {
          called = true;
          return [off('o-1', { offering: { title: 'Seeded' } })];
        },
      },
    });
    const res = await dispatch(server, 'si_get_offering', {
      offering_id: 'o-1',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    assert.equal(called, false);
    assert.equal(res.structuredContent.offering.title, 'Handler');
  });

  it('drops seeded entries missing offering.offering_id and warn-drops duplicates (first wins)', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      sponsoredIntelligence: {
        getOffering: async () => off('o-2', { offering: { title: 'Handler' } }),
      },
      testController: {
        getSeededSiOffering: () => [
          { available: true }, // no offering at all
          { available: true, offering: {} }, // no offering_id
          { available: true, offering: { offering_id: '' } }, // empty
          off('o-2', { offering: { title: 'First O-2' } }),
          off('o-2', { offering: { title: 'Duplicate O-2 — dropped' } }),
        ],
      },
    });
    const res = await dispatch(server, 'si_get_offering', {
      offering_id: 'o-2',
      account: SANDBOX_ACCOUNT,
    });
    assert.equal(res.structuredContent.offering.title, 'First O-2');
  });
});

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — brand-rights + SI selectors
// ---------------------------------------------------------------------------

describe('bridgeFromSessionStore — brand-rights + SI selectors', () => {
  it('wires getSeededBrandIdentity from selectSeededBrandIdentity', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        bi: [{ brand_id: 'b-a', house: { domain: 'x.com', name: 'X' }, names: [] }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededBrandIdentity: session => session.bi,
    });
    const out = await bridge.getSeededBrandIdentity({ input: {} });
    assert.deepEqual(
      out.map(e => e.brand_id),
      ['b-a']
    );
  });

  it('wires getSeededRights from selectSeededRights', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({
        rights: [{ rights_id: 'r-a', brand_id: 'b', name: 'R', available_uses: [], pricing_options: [] }],
      }),
      selectSeededProducts: () => undefined,
      selectSeededRights: session => session.rights,
    });
    const out = await bridge.getSeededRights({ input: {} });
    assert.deepEqual(
      out.map(r => r.rights_id),
      ['r-a']
    );
  });

  it('wires getSeededSiOffering from selectSeededSiOffering', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({ off: [{ available: true, offering: { offering_id: 'o-a', title: 'A' } }] }),
      selectSeededProducts: () => undefined,
      selectSeededSiOffering: session => session.off,
    });
    const out = await bridge.getSeededSiOffering({ input: {} });
    assert.deepEqual(
      out.map(o => o.offering.offering_id),
      ['o-a']
    );
  });

  it('omits brand-rights + SI per-tool callbacks when no selectors are provided', async () => {
    const bridge = bridgeFromSessionStore({
      loadSession: () => ({}),
      selectSeededProducts: () => undefined,
    });
    assert.equal(bridge.getSeededBrandIdentity, undefined);
    assert.equal(bridge.getSeededRights, undefined);
    assert.equal(bridge.getSeededSiOffering, undefined);
  });
});

// ---------------------------------------------------------------------------
// Sandbox-gate diagnostic
//
// When the request carries a sandbox marker (`account.sandbox === true` or
// `context.sandbox === true`) but the resolved `ctx.account` is explicitly
// non-sandbox, the dispatcher rejects the merge silently. Emit a `debug`
// line so dev logs surface the rejection without adding production-traffic
// noise (the first gate, `isSandboxRequest`, fails first there and never
// reaches this branch).
// ---------------------------------------------------------------------------

describe('createAdcpServer — sandbox-gate debug log on resolved-account mismatch', () => {
  function makeRecordingLogger() {
    const records = { debug: [], info: [], warn: [], error: [] };
    return {
      logger: {
        debug: (msg, data) => records.debug.push({ msg, data }),
        info: (msg, data) => records.info.push({ msg, data }),
        warn: (msg, data) => records.warn.push({ msg, data }),
        error: (msg, data) => records.error.push({ msg, data }),
      },
      records,
    };
  }

  function handlerListCreatives() {
    return async () => ({
      query_summary: { total_matching: 0, returned: 0 },
      pagination: { limit: 50, offset: 0, has_more: false },
      creatives: [],
    });
  }

  it('emits debug when request is sandbox-flagged but resolved account is sandbox:false', async () => {
    const { logger, records } = makeRecordingLogger();
    let bridgeCalled = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      resolveAccount: () => ({ account_id: 'prod-acct', sandbox: false }),
      creative: { listCreatives: handlerListCreatives() },
      testController: {
        getSeededCreatives: () => {
          bridgeCalled = true;
          return [{ creative_id: 'leaked-fixture', name: 'should not appear' }];
        },
      },
    });

    await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });

    assert.equal(bridgeCalled, false);
    const hit = records.debug.find(r =>
      r.msg.includes('request is sandbox-flagged but resolved account is not sandbox')
    );
    assert.ok(hit, 'expected sandbox-gate debug log');
    assert.equal(hit.data.tool, 'list_creatives');
    assert.equal(hit.data.resolved_account_id, 'prod-acct', 'log should include resolved account_id for diagnostics');
  });

  it('does not emit debug when request lacks sandbox marker (gate fails first)', async () => {
    const { logger, records } = makeRecordingLogger();
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      resolveAccount: () => ({ account_id: 'prod-acct', sandbox: false }),
      creative: { listCreatives: handlerListCreatives() },
      testController: {
        getSeededCreatives: () => [{ creative_id: 's-1', name: 'X' }],
      },
    });

    await dispatch(server, 'list_creatives', {
      account: { brand: { domain: 'example.com' }, operator: 'example.com' /* no sandbox */ },
    });

    const hit = records.debug.find(r =>
      r.msg.includes('request is sandbox-flagged but resolved account is not sandbox')
    );
    assert.equal(hit, undefined, 'should not log gate-mismatch when production traffic');
  });

  it('does not emit debug when resolved account is sandbox (gate passes)', async () => {
    const { logger, records } = makeRecordingLogger();
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      resolveAccount: () => ({ account_id: 'sandbox-acct', sandbox: true }),
      creative: { listCreatives: handlerListCreatives() },
      testController: {
        getSeededCreatives: () => [{ creative_id: 's-1', name: 'X' }],
      },
    });

    const res = await dispatch(server, 'list_creatives', { account: SANDBOX_ACCOUNT });
    const hit = records.debug.find(r =>
      r.msg.includes('request is sandbox-flagged but resolved account is not sandbox')
    );
    assert.equal(hit, undefined, 'should not log when the gate passes');
    assert.deepEqual(
      res.structuredContent.creatives.map(c => c.creative_id),
      ['s-1']
    );
  });
});

// ---------------------------------------------------------------------------
// #1784 — construction-time warn when `testController` is registered without
// any account resolver. The dispatch-time sandbox gate admits requests where
// `ctx.account === undefined`, so without `resolveAccount` (or
// `resolveAccountFromAuth`) the only remaining check is the buyer-supplied
// `account.sandbox` / `context.sandbox` marker — caller-controlled, not a
// trust boundary. The warn makes that silent failure mode loud once, without
// breaking the legitimate storyboard-runner case (runner-without-resolver
// configs simply ignore the warning).
// ---------------------------------------------------------------------------

describe('createAdcpServer — trust-boundary warn when testController lacks resolveAccount (#1784)', () => {
  function makeRecordingLogger() {
    const records = { debug: [], info: [], warn: [], error: [] };
    return {
      logger: {
        debug: (msg, data) => records.debug.push({ msg, data }),
        info: (msg, data) => records.info.push({ msg, data }),
        warn: (msg, data) => records.warn.push({ msg, data }),
        error: (msg, data) => records.error.push({ msg, data }),
      },
      records,
    };
  }

  const MATCH = /testController is wired but no account resolver/;

  it('warns once at construction when testController is set and neither resolver is configured', () => {
    const { logger, records } = makeRecordingLogger();
    _createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      testController: { getSeededProducts: () => [] },
    });
    const hits = records.warn.filter(r => MATCH.test(r.msg));
    assert.equal(hits.length, 1, 'warn fires exactly once');
  });

  it('does not warn when testController is omitted (state-local seller)', () => {
    const { logger, records } = makeRecordingLogger();
    _createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      // no testController, no resolver — state-local seller path
    });
    const hits = records.warn.filter(r => MATCH.test(r.msg));
    assert.equal(hits.length, 0);
  });

  it('does not warn when resolveAccount is configured', () => {
    const { logger, records } = makeRecordingLogger();
    _createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      validation: { requests: 'off', responses: 'off' },
      resolveAccount: () => ({ account_id: 'a', sandbox: true }),
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      testController: { getSeededProducts: () => [] },
    });
    const hits = records.warn.filter(r => MATCH.test(r.msg));
    assert.equal(hits.length, 0);
  });

  it('does not warn when resolveAccountFromAuth is configured (OAuth-passthrough setups)', () => {
    const { logger, records } = makeRecordingLogger();
    _createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      validation: { requests: 'off', responses: 'off' },
      resolveAccountFromAuth: () => ({ account_id: 'a', sandbox: true }),
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      testController: { getSeededProducts: () => [] },
    });
    const hits = records.warn.filter(r => MATCH.test(r.msg));
    assert.equal(hits.length, 0);
  });

  it('does not re-warn on subsequent dispatches', async () => {
    const { logger, records } = makeRecordingLogger();
    const server = _createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      logger,
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      testController: { getSeededProducts: () => [] },
    });
    await dispatch(server, 'get_products', {
      brief: 'x',
      buying_mode: 'brief',
      account: SANDBOX_ACCOUNT,
    });
    await dispatch(server, 'get_products', {
      brief: 'x',
      buying_mode: 'brief',
      account: SANDBOX_ACCOUNT,
    });
    const hits = records.warn.filter(r => MATCH.test(r.msg));
    assert.equal(hits.length, 1, 'warn fires once across construction + N requests');
  });

  // The default `logger` is `noopLogger`, which swallows `.warn`. The
  // misconfig is most likely on day one when no logger is wired yet —
  // so the warn also goes through `process.emitWarning` (stderr by
  // default, dedupable via `code`). Spy on `process.emitWarning` itself
  // for synchronous capture — `process.on('warning')` would also work
  // but adds event-loop-flush timing dependencies.
  it('also emits via process.emitWarning so the signal is visible without configured logging', () => {
    const calls = [];
    const original = process.emitWarning;
    process.emitWarning = (...args) => {
      calls.push(args);
      return original.apply(process, args);
    };
    try {
      _createAdcpServer({
        name: 'Test',
        version: '1.0.0',
        // no `logger` → defaults to noopLogger
        validation: { requests: 'off', responses: 'off' },
        mediaBuy: { getProducts: async () => ({ products: [] }) },
        testController: { getSeededProducts: () => [] },
      });
      const ours = calls.filter(args => args[1]?.code === 'ADCP_BRIDGE_NO_RESOLVER');
      assert.equal(ours.length, 1, 'exactly one process.emitWarning call');
      assert.match(ours[0][0], MATCH);
      assert.equal(ours[0][1].type, 'AdcpServerConfigWarning');
    } finally {
      process.emitWarning = original;
    }
  });
});
