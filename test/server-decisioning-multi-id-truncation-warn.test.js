// Tests for #1399 / #1410 — dev-mode warning when multi-id read tools return
// fewer rows than requested. Catches the canonical `ids[0]`-truncation bug
// class at adapter-development time across getMediaBuyDelivery, getMediaBuys,
// listCreatives (sales path), and getSignals.

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function buildPlatform(handlers = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async () => ({
        id: 'acc_1',
        name: 'Acme',
        status: 'active',
        ctx_metadata: {},
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      ...handlers,
    },
  };
}

function captureWarnings() {
  const allCalls = [];
  const logger = {
    info: () => {},
    warn: (msg, ...rest) => {
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
      allCalls.push({ msg: text, rest });
    },
    error: () => {},
    debug: () => {},
  };
  const truncationCalls = (idField = 'media_buy_ids') =>
    allCalls.filter(c => c.msg.includes('platform returned') && c.msg.includes(idField));
  return { logger, truncationCalls, allCalls };
}

const SERVER_OPTS_BASE = {
  name: 'multi-id-warn-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

describe('#1399 — dev-mode multi-id truncation warning', () => {
  let originalNodeEnv;
  let originalSuppress;
  let originalInMem;
  let originalInMemState;
  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalSuppress = process.env.ADCP_SUPPRESS_MULTI_ID_WARN;
    originalInMem = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    originalInMemState = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    delete process.env.ADCP_SUPPRESS_MULTI_ID_WARN;
    delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalSuppress === undefined) delete process.env.ADCP_SUPPRESS_MULTI_ID_WARN;
    else process.env.ADCP_SUPPRESS_MULTI_ID_WARN = originalSuppress;
    if (originalInMem === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = originalInMem;
    if (originalInMemState === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = originalInMemState;
  });

  describe('getMediaBuyDelivery', () => {
    it('warns when adapter truncates a 3-id request to 1 row', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        getMediaBuyDelivery: async filter => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          // BUG: only returns first id's row.
          media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 0, spend: 0 }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'acc_1' },
            media_buy_ids: ['mb_1', 'mb_2', 'mb_3'],
          },
        },
      });
      const warns = cap.truncationCalls();
      assert.strictEqual(warns.length, 1, `expected exactly one warn, got ${warns.length}`);
      assert.match(warns[0].msg, /getMediaBuyDelivery: platform returned 1 row for 3 requested media_buy_ids/);
      assert.match(warns[0].msg, /1342/);
      assert.match(warns[0].msg, /ADCP_SUPPRESS_MULTI_ID_WARN=1/);
    });

    it('does not warn when adapter returns one row per requested id', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        getMediaBuyDelivery: async filter => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: filter.media_buy_ids.map(id => ({
            media_buy_id: id,
            impressions: 0,
            spend: 0,
          })),
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'acc_1' },
            media_buy_ids: ['mb_1', 'mb_2'],
          },
        },
      });
      assert.strictEqual(cap.truncationCalls().length, 0, 'no warn when row count matches request');
    });

    it('does not warn when media_buy_ids is omitted (paginated-list mode)', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        getMediaBuyDelivery: async () => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: [],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: { account: { account_id: 'acc_1' } },
        },
      });
      assert.strictEqual(cap.truncationCalls().length, 0, 'paginated-list mode must not warn');
    });
  });

  describe('getMediaBuys', () => {
    it('warns when adapter truncates a multi-id request', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        getMediaBuys: async req => ({
          // BUG: returns one row regardless of how many ids.
          media_buys: [{ media_buy_id: req.media_buy_ids[0], status: 'active' }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buys',
          arguments: {
            account: { account_id: 'acc_1' },
            media_buy_ids: ['mb_a', 'mb_b'],
          },
        },
      });
      const warns = cap.truncationCalls();
      const buysWarn = warns.find(c => c.msg.includes('getMediaBuys'));
      assert.ok(buysWarn, `expected getMediaBuys warn, got ${JSON.stringify(warns.map(c => c.msg))}`);
      assert.match(buysWarn.msg, /returned 1 row for 2 requested/);
    });
  });

  describe('environment gating', () => {
    it('does not warn when NODE_ENV=production', async () => {
      const cap = captureWarnings();
      process.env.NODE_ENV = 'production';
      // Framework refuses in-memory task registry + state store under
      // production without explicit ack — set the documented escape
      // hatches for this test (real adopters pass durable backends).
      process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = '1';
      process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = '1';
      const platform = buildPlatform({
        getMediaBuyDelivery: async filter => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 0, spend: 0 }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'acc_1' },
            media_buy_ids: ['mb_1', 'mb_2', 'mb_3'],
          },
        },
      });
      assert.strictEqual(cap.truncationCalls().length, 0, 'production must not log truncation warnings');
    });

    it('does not warn when ADCP_SUPPRESS_MULTI_ID_WARN=1', async () => {
      const cap = captureWarnings();
      process.env.ADCP_SUPPRESS_MULTI_ID_WARN = '1';
      const platform = buildPlatform({
        getMediaBuyDelivery: async filter => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 0, spend: 0 }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'acc_1' },
            media_buy_ids: ['mb_1', 'mb_2', 'mb_3'],
          },
        },
      });
      assert.strictEqual(cap.truncationCalls().length, 0, 'env-suppression must silence the warn');
    });
  });

  describe('listCreatives (sales adapter path) — #1410', () => {
    it('warns when adapter truncates a creative_ids-scoped request to fewer rows', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        listCreatives: async params => ({
          query_summary: {},
          pagination: { total: 1, has_more: false },
          // BUG: returns only first creative regardless of how many ids were requested
          creatives: [{ creative_id: params?.filters?.creative_ids?.[0] ?? 'c_1' }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'list_creatives',
          arguments: {
            account: { account_id: 'acc_1' },
            filters: { creative_ids: ['c_1', 'c_2', 'c_3'] },
          },
        },
      });
      const warns = cap.truncationCalls('creative_ids');
      assert.strictEqual(warns.length, 1, `expected exactly one warn, got ${warns.length}`);
      assert.match(warns[0].msg, /listCreatives: platform returned 1 row for 3 requested creative_ids/);
      assert.match(warns[0].msg, /1342/);
      assert.match(warns[0].msg, /ADCP_SUPPRESS_MULTI_ID_WARN=1/);
    });

    it('does not warn when listCreatives returns all requested creatives', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        listCreatives: async params => ({
          query_summary: {},
          pagination: { total: 3, has_more: false },
          creatives: (params?.filters?.creative_ids ?? []).map(id => ({ creative_id: id })),
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'list_creatives',
          arguments: {
            account: { account_id: 'acc_1' },
            filters: { creative_ids: ['c_1', 'c_2', 'c_3'] },
          },
        },
      });
      assert.strictEqual(cap.truncationCalls('creative_ids').length, 0, 'no warn when row count matches');
    });

    it('does not warn when listCreatives is called without creative_ids filter (browse mode)', async () => {
      const cap = captureWarnings();
      const platform = buildPlatform({
        listCreatives: async () => ({
          query_summary: {},
          pagination: { total: 0, has_more: false },
          creatives: [],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'list_creatives',
          arguments: { account: { account_id: 'acc_1' } },
        },
      });
      assert.strictEqual(cap.truncationCalls('creative_ids').length, 0, 'browse mode must not warn');
    });
  });

  describe('getSignals — #1410', () => {
    it('warns when signals adapter truncates a signal_ids request', async () => {
      const cap = captureWarnings();
      const platform = {
        ...buildPlatform(),
        signals: {
          getSignals: async () => ({
            // BUG: returns only one signal even though two signal_ids were requested
            signals: [{ signal_agent_segment_id: 's_1', name: 'Seg 1' }],
          }),
          activateSignal: async () => ({ deployments: [] }),
        },
      };
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_signals',
          arguments: {
            account: { account_id: 'acc_1' },
            signal_ids: [{ signal_id: 's_1' }, { signal_id: 's_2' }],
          },
        },
      });
      const warns = cap.truncationCalls('signal_ids');
      assert.strictEqual(warns.length, 1, `expected exactly one warn, got ${warns.length}`);
      assert.match(warns[0].msg, /getSignals: platform returned 1 row for 2 requested signal_ids/);
      assert.match(warns[0].msg, /1342/);
    });

    it('does not warn when getSignals returns all requested signals', async () => {
      const cap = captureWarnings();
      const platform = {
        ...buildPlatform(),
        signals: {
          getSignals: async req => ({
            signals: (req?.signal_ids ?? []).map((s, i) => ({
              signal_agent_segment_id: `s_${i}`,
              name: `Seg ${i}`,
            })),
          }),
          activateSignal: async () => ({ deployments: [] }),
        },
      };
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS_BASE, logger: cap.logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_signals',
          arguments: {
            account: { account_id: 'acc_1' },
            signal_ids: [{ signal_id: 's_1' }, { signal_id: 's_2' }],
          },
        },
      });
      assert.strictEqual(cap.truncationCalls('signal_ids').length, 0, 'no warn when count matches');
    });
  });
});
