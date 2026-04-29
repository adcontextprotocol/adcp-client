// F12 — auto-emit completion webhook on sync responses with
// push_notification_config.url. v6 framework previously fired only on
// HITL task completion; sync mutating tools left buyers polling
// (or adopters wired ctx.emitWebhook manually inside every handler).
// Spec-listed mutating tools (create_media_buy, update_media_buy,
// sync_creatives) now auto-fire when the buyer supplied a push URL.

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

function buildServer(opts = {}) {
  const calls = [];
  const taskWebhookEmitter = {
    emit: async params => {
      calls.push(params);
      return { delivered: true };
    },
    unsigned: true, // suppress signed-emitter warning in tests
  };
  const server = createAdcpServerFromPlatform(basePlatform(), {
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

describe('F12: auto-emit completion webhook on sync mutating responses', () => {
  it('fires webhook on sync create_media_buy success when push_notification_config.url is set', async () => {
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
    assert.strictEqual(calls.length, 1, 'one webhook fired');
    assert.strictEqual(calls[0].url, 'https://buyer.example.com/webhook');
    const payload = calls[0].payload;
    assert.strictEqual(payload.task_type, 'create_media_buy');
    assert.strictEqual(payload.status, 'completed');
    assert.match(payload.task_id, /^sync-/, 'sync task_id prefix');
    // Buyer correlates via the resource id on result, not task_id.
    assert.strictEqual(payload.result?.media_buy_id, 'mb_42');
  });

  it('does NOT fire when buyer omits push_notification_config.url', async () => {
    const { server, calls } = buildServer();
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

  it('default (option omitted) is true — webhook fires', async () => {
    const { server, calls } = buildServer({});
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          ...ARGS_BASE,
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.strictEqual(calls.length, 1, 'default-on');
  });

  it('passes echoed token to the webhook payload', async () => {
    const { server, calls } = buildServer();
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
    assert.strictEqual(calls[0].payload.token, 'shhh');
  });

  it('webhook delivery failure does NOT fail the sync response', async () => {
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
    // Sync response succeeded even though the webhook delivery flopped.
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_42');
  });

  it('sync_creatives auto-fires webhook on success', async () => {
    const { server, calls } = buildServer();
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_1', format_id: { id: 'f', agent_url: 'https://x' } }],
          idempotency_key: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          push_notification_config: { url: 'https://buyer.example.com/webhook' },
        },
      },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].payload.task_type, 'sync_creatives');
    assert.strictEqual(calls[0].payload.status, 'completed');
    // Result carries the projected creatives array.
    assert.ok(Array.isArray(calls[0].payload.result?.creatives));
  });
});
