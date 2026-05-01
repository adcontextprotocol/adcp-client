// F11 — allowPrivateWebhookUrls opt for sandbox / local-testing flows.
// Without the flag, the framework's request-ingest validator rejects
// loopback / RFC 1918 / link-local URLs at the wire boundary (SSRF /
// cloud-metadata exfiltration defense). With the flag set, only the
// private-IP branch relaxes — malformed-URL, scheme, and the http://
// reject (separately gated by NODE_ENV / env) still fire.

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
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-29T00:00:00Z',
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
  };
}

const BASE_OPTS = { name: 'sb', version: '0.0.1', validation: { requests: 'off', responses: 'off' } };

async function callCreateMediaBuyWithUrl(server, url) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'create_media_buy',
      arguments: {
        account: { account_id: 'acc_1' },
        promoted_offering: 'x',
        packages: [],
        idempotency_key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        push_notification_config: { url },
      },
    },
  });
}

describe('F11: allowPrivateWebhookUrls opt — relaxes loopback/private-IP guard for sandbox', () => {
  it('default (allowPrivateWebhookUrls undefined) rejects http://127.0.0.1', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), BASE_OPTS);
    const result = await callCreateMediaBuyWithUrl(server, 'http://127.0.0.1:8080/webhook');
    assert.strictEqual(result.isError, true);
    const err = result.structuredContent.adcp_error;
    assert.strictEqual(err.code, 'INVALID_REQUEST');
    assert.match(err.message ?? '', /loopback range 127\/8 rejected/);
  });

  it('default rejects http://localhost', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), BASE_OPTS);
    const result = await callCreateMediaBuyWithUrl(server, 'http://localhost:8080/webhook');
    assert.strictEqual(result.isError, true);
    assert.match(result.structuredContent.adcp_error?.message ?? '', /loopback/);
  });

  it('default rejects http://10.0.0.5 (RFC 1918)', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), BASE_OPTS);
    const result = await callCreateMediaBuyWithUrl(server, 'http://10.0.0.5/webhook');
    assert.strictEqual(result.isError, true);
    assert.match(result.structuredContent.adcp_error?.message ?? '', /RFC 1918/);
  });

  it('allowPrivateWebhookUrls: true accepts http://127.0.0.1', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      allowPrivateWebhookUrls: true,
    });
    const result = await callCreateMediaBuyWithUrl(server, 'http://127.0.0.1:8080/webhook');
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.media_buy_id, 'mb_1');
  });

  it('allowPrivateWebhookUrls: true accepts http://localhost', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      allowPrivateWebhookUrls: true,
    });
    const result = await callCreateMediaBuyWithUrl(server, 'http://localhost:8080/webhook');
    assert.notStrictEqual(result.isError, true);
  });

  it('allowPrivateWebhookUrls: true STILL rejects malformed URLs', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      allowPrivateWebhookUrls: true,
    });
    const result = await callCreateMediaBuyWithUrl(server, 'not-a-url');
    assert.strictEqual(result.isError, true);
    assert.match(result.structuredContent.adcp_error?.message ?? '', /malformed URL/);
  });

  it('allowPrivateWebhookUrls: true STILL rejects unsupported schemes', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      ...BASE_OPTS,
      allowPrivateWebhookUrls: true,
    });
    const result = await callCreateMediaBuyWithUrl(server, 'file:///etc/passwd');
    assert.strictEqual(result.isError, true);
    assert.match(result.structuredContent.adcp_error?.message ?? '', /unsupported scheme/);
  });

  it('production-like NODE_ENV emits a footgun warn when allowPrivateWebhookUrls: true', () => {
    const warnings = [];
    const originalWarn = console.warn;
    const originalEnv = process.env.NODE_ENV;
    const originalAckTasks = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
    const originalAckState = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
    console.warn = (...args) => warnings.push(args.join(' '));
    process.env.NODE_ENV = 'production';
    // The in-memory task registry AND the in-memory state store both
    // refuse to construct outside test/dev unless these acks are set.
    // Production is fine for THIS test because we only care that the
    // allowPrivateWebhookUrls warn fires.
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = '1';
    process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = '1';
    try {
      createAdcpServerFromPlatform(basePlatform(), {
        ...BASE_OPTS,
        allowPrivateWebhookUrls: true,
      });
    } finally {
      console.warn = originalWarn;
      process.env.NODE_ENV = originalEnv;
      if (originalAckTasks === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS = originalAckTasks;
      if (originalAckState === undefined) delete process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE;
      else process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE = originalAckState;
    }
    const hit = warnings.find(w => w.includes('allowPrivateWebhookUrls'));
    assert.ok(hit, `expected footgun warning, got: ${JSON.stringify(warnings)}`);
    assert.match(hit, /SSRF/);
    assert.match(hit, /production/);
  });

  it('test NODE_ENV does NOT emit the footgun warn', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      createAdcpServerFromPlatform(basePlatform(), {
        ...BASE_OPTS,
        allowPrivateWebhookUrls: true,
      });
    } finally {
      console.warn = originalWarn;
    }
    const hit = warnings.find(w => w.includes('allowPrivateWebhookUrls'));
    assert.strictEqual(hit, undefined, 'no warning under NODE_ENV=test');
  });
});
