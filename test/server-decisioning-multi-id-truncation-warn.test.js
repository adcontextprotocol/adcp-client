// Tests for #1399 — dev-mode warning when getMediaBuyDelivery / getMediaBuys
// returns fewer rows than requested media_buy_ids.

process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

const SERVER_OPTS = {
  name: 'multi-id-warn-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

// Only count warns emitted by warnMultiIdTruncation (have structured `tool` data).
function truncationWarns(calls) {
  return calls.filter(c => c.data && (c.data.tool === 'getMediaBuyDelivery' || c.data.tool === 'getMediaBuys'));
}

function buildLogger() {
  const calls = [];
  return {
    logger: {
      debug() {},
      info() {},
      warn(msg, data) {
        calls.push({ msg, data });
      },
      error() {},
    },
    calls,
  };
}

function basePlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'acc_1',
        name: 'Acme',
        status: 'active',
        ctx_metadata: {},
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      ...overrides,
    },
  };
}

// ── getMediaBuyDelivery ──────────────────────────────────────────────────────

describe('#1399 — getMediaBuyDelivery multi-id truncation warn', () => {
  let savedSuppressEnv;
  beforeEach(() => {
    savedSuppressEnv = process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION;
  });
  afterEach(() => {
    if (savedSuppressEnv === undefined) delete process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION;
    else process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION = savedSuppressEnv;
  });

  it('warns once when platform returns fewer rows than requested ids', async () => {
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuyDelivery: async filter => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 1, spend: 1 }],
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
      },
    });
    const tw = truncationWarns(calls);
    assert.strictEqual(tw.length, 1, 'expected exactly one truncation warn');
    assert.match(tw[0].msg, /getMediaBuyDelivery/);
    assert.match(tw[0].msg, /1.*row|row.*1/);
    assert.match(tw[0].msg, /ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION/);
    assert.strictEqual(tw[0].data.requested, 3);
    assert.strictEqual(tw[0].data.returned, 1);
  });

  it('does not warn when platform returns the same number of rows as requested', async () => {
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuyDelivery: async filter => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: (filter.media_buy_ids ?? []).map(id => ({ media_buy_id: id, impressions: 1, spend: 1 })),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2'] },
      },
    });
    assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when row count matches');
  });

  it('does not warn when media_buy_ids is omitted (paginated-list contract)', async () => {
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buy_delivery', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when media_buy_ids omitted');
  });

  it('does not warn when suppressed via ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION=1', async () => {
    process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION = '1';
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuyDelivery: async filter => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 1, spend: 1 }],
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
      },
    });
    assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when suppression env var set');
  });

  it('does not warn in production (NODE_ENV=production)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origTaskAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    const origStateAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    process.env.NODE_ENV = 'production';
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = '1';
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = '1';
    try {
      const { logger, calls } = buildLogger();
      const platform = basePlatform({
        getMediaBuyDelivery: async filter => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 1, spend: 1 }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
        },
      });
      assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn in production');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origTaskAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = origTaskAck;
      if (origStateAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = origStateAck;
    }
  });

  it('does not warn when NODE_ENV is unset', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origTaskAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    const origStateAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    delete process.env.NODE_ENV;
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = '1';
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = '1';
    try {
      const { logger, calls } = buildLogger();
      const platform = basePlatform({
        getMediaBuyDelivery: async filter => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: [{ media_buy_id: filter.media_buy_ids[0], impressions: 1, spend: 1 }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
        },
      });
      assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when NODE_ENV unset');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origTaskAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = origTaskAck;
      if (origStateAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = origStateAck;
    }
  });
});

// ── getMediaBuys ─────────────────────────────────────────────────────────────

describe('#1399 — getMediaBuys multi-id truncation warn', () => {
  let savedSuppressEnv;
  beforeEach(() => {
    savedSuppressEnv = process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION;
  });
  afterEach(() => {
    if (savedSuppressEnv === undefined) delete process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION;
    else process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION = savedSuppressEnv;
  });

  it('warns once when platform returns fewer rows than requested ids', async () => {
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuys: async req => ({
        media_buys: [{ media_buy_id: (req.media_buy_ids ?? [])[0], status: 'active' }],
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buys',
        arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
      },
    });
    const tw = truncationWarns(calls);
    assert.strictEqual(tw.length, 1, 'expected exactly one truncation warn');
    assert.match(tw[0].msg, /getMediaBuys/);
    assert.strictEqual(tw[0].data.requested, 3);
    assert.strictEqual(tw[0].data.returned, 1);
  });

  it('does not warn when platform returns the same number of rows as requested', async () => {
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuys: async req => ({
        media_buys: (req.media_buy_ids ?? []).map(id => ({ media_buy_id: id, status: 'active' })),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buys',
        arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2'] },
      },
    });
    assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when row count matches');
  });

  it('does not warn when suppressed via ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION=1', async () => {
    process.env.ADCP_DECISIONING_ALLOW_MULTI_ID_TRUNCATION = '1';
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuys: async req => ({
        media_buys: [{ media_buy_id: (req.media_buy_ids ?? [])[0], status: 'active' }],
      }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buys',
        arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
      },
    });
    assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when suppression env var set');
  });

  it('does not warn when media_buy_ids is omitted (paginated-list contract)', async () => {
    const { logger, calls } = buildLogger();
    const platform = basePlatform({
      getMediaBuys: async () => ({ media_buys: [] }),
    });
    const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: { account: { account_id: 'acc_1' } } },
    });
    assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn when media_buy_ids omitted');
  });

  it('does not warn in production (NODE_ENV=production)', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origTaskAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    const origStateAck = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    process.env.NODE_ENV = 'production';
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = '1';
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = '1';
    try {
      const { logger, calls } = buildLogger();
      const platform = basePlatform({
        getMediaBuys: async req => ({
          media_buys: [{ media_buy_id: (req.media_buy_ids ?? [])[0], status: 'active' }],
        }),
      });
      const server = createAdcpServerFromPlatform(platform, { ...SERVER_OPTS, logger });
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buys',
          arguments: { account: { account_id: 'acc_1' }, media_buy_ids: ['mb_1', 'mb_2', 'mb_3'] },
        },
      });
      assert.strictEqual(truncationWarns(calls).length, 0, 'no truncation warn in production');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origTaskAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = origTaskAck;
      if (origStateAck === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = origStateAck;
    }
  });
});
