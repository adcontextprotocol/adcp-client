// AdCP 3.2 requires sync terminal responses to remain silent on the task
// webhook channel, including when the removed compatibility flag is present.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform() {
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
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_42',
        status: 'active',
        confirmed_at: '2026-04-29T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_42', status: 'active' }),
      syncCreatives: async () => [{ creative_id: 'cr_1', action: 'created', status: 'approved' }],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

function buildServer(opts = {}, platform = basePlatform()) {
  const calls = [];
  const taskWebhookEmitter = {
    emit: async params => {
      calls.push(params);
      return { delivered: true };
    },
    unsigned: true, // suppress signed-emitter warning in tests
  };
  const server = createAdcpServerFromPlatform(platform, {
    name: 'auto-emit-host',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    taskWebhookEmitter,
    allowPrivateWebhookUrls: true, // tests use https://buyer.example.com — but be safe
    ...opts,
  });
  return { server, calls };
}

const ARGS_BASE = {
  account: { account_id: 'acc_1' },
  promoted_offering: 'x',
  packages: [],
  idempotency_key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

// Webhook auto-emit is fire-and-forget (security review F12 must-fix —
// awaiting inline lets a slowloris buyer URL hold the seller's request
// worker for the full retry budget). Tests asserting on `calls` after
// dispatch must flush the microtask queue first so the background
// emitWebhook promise has a chance to settle.
async function flushMicrotasks() {
  // setImmediate runs after all queued microtasks (then/catch handlers)
  // have drained. Two flushes cover the case where the emitter's own
  // implementation queues a follow-up microtask.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

describe('sync completion webhook silence', () => {
  it('does not emit a webhook for a synchronous terminal response by default', async () => {
    const { server, calls } = buildServer();
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_42');
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0, 'sync terminal response must not emit by default');
  });

  it('does not emit by default through the creative-owned sync_creatives path', async () => {
    const platform = basePlatform();
    delete platform.sales;
    platform.capabilities.specialisms = [];
    platform.creative = {
      syncCreatives: async () => [{ creative_id: 'cr_1', action: 'created', status: 'approved' }],
    };
    const { server, calls } = buildServer({}, platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_1', name: 'Creative 1', format_kind: 'image', assets: {} }],
          idempotency_key: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0, 'creative sync terminal response must not emit by default');
  });

  it('does not emit by default through the synchronous get_signals path', async () => {
    const platform = basePlatform();
    platform.signals = { getSignals: async () => ({ signals: [] }) };
    const { server, calls } = buildServer({}, platform);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_signals',
        arguments: {
          account: { account_id: 'acc_1' },
          discovery_mode: 'brief',
          brief: 'sports fans',
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0, 'signals sync terminal response must not emit by default');
  });

  it('stays silent when the deprecated compatibility flag is explicitly enabled', async () => {
    const { server, calls } = buildServer({ autoEmitCompletionWebhooks: true });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_42');
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0, 'sync terminal response MUST NOT emit a task webhook');
  });

  it('does NOT fire when buyer omits push_notification_config.url', async () => {
    const { server, calls } = buildServer({ autoEmitCompletionWebhooks: true });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'create_media_buy', arguments: ARGS_BASE },
    });
    assert.strictEqual(calls.length, 0, 'no webhook without url');
  });

  it('autoEmitCompletionWebhooks: false suppresses the auto-emit', async () => {
    const { server, calls } = buildServer({ autoEmitCompletionWebhooks: false });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(calls.length, 0, 'auto-emit suppressed');
  });

  it('does not leak an echoed token through a forbidden sync webhook', async () => {
    const { server, calls } = buildServer({ autoEmitCompletionWebhooks: true });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook', token: 'shhh' },
        },
      },
    });
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0);
  });

  it('does not invoke a failing emitter for a sync response', async () => {
    const failingEmitter = {
      emit: async () => ({ delivered: false, errors: ['receiver returned 500'] }),
      unsigned: true,
    };
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: failingEmitter,
      allowPrivateWebhookUrls: true,
      autoEmitCompletionWebhooks: true,
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    // Sync response succeeds because the webhook emitter is never invoked.
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_42');
  });

  it('sync_creatives remains silent even with the deprecated flag', async () => {
    const { server, calls } = buildServer({ autoEmitCompletionWebhooks: true });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_1', name: 'Creative 1', format_kind: 'image', assets: {} }],
          idempotency_key: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0);
  });

  it('update_media_buy remains silent even with the deprecated flag', async () => {
    const { server, calls } = buildServer({ autoEmitCompletionWebhooks: true });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          account: { account_id: 'acc_1' },
          media_buy_id: 'mb_42',
          idempotency_key: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    await flushMicrotasks();
    assert.strictEqual(calls.length, 0);
  });

  it('SLOWLORIS DEFENSE: a sync response never calls a slow webhook receiver', async () => {
    let webhookCalled = false;
    const slowEmitter = {
      emit: () => {
        webhookCalled = true;
        return new Promise(() => {});
      },
      unsigned: true,
    };
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'slow',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: slowEmitter,
      allowPrivateWebhookUrls: true,
      autoEmitCompletionWebhooks: true,
    });
    const start = Date.now();
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    const elapsedMs = Date.now() - start;
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_42');
    assert.ok(elapsedMs < 100, `sync response should return fast; took ${elapsedMs}ms`);
    assert.strictEqual(webhookCalled, false);
  });
});
