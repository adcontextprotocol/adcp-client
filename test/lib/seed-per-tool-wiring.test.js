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
