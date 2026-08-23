/**
 * Full-stack publisher E2E: `createAdcpServer` → tool handler invokes
 * `ctx.emitWebhook` → our receiver captures the POST → `verifyWebhookSignature`
 * accepts the signature against the publisher's published JWK.
 *
 * This is the "spin up an actual server, watch the whole stack verify"
 * test — no mocks at the signer, no mocks at the verifier. Real fetch
 * between the two halves. The only mock is the receiver, which is the
 * same ephemeral HTTP listener our runner uses to grade third-party
 * publishers (adcp#2426).
 */
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const { generateKeyPairSync } = require('node:crypto');

const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { memoryWebhookDeliveryStore } = require('../../dist/lib/server/webhook-emitter.js');
const {
  createPinAndBindFetch,
  LOOPBACK_OK_WEBHOOK_SSRF_POLICY,
} = require('../../dist/lib/server/pin-and-bind-fetch.js');
const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');
const { verifyWebhookSignature } = require('../../dist/lib/signing/webhook-verifier.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay.js');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation.js');

// The emitter defaults to a strict pin-and-bind fetch that denies loopback
// http. This E2E delivers to an in-process http://127.0.0.1 receiver, so it
// opts into the loopback-relaxed policy — the same escape hatch the
// storyboard runner uses. Cloud-metadata / private ranges stay denied.
const loopbackFetch = createPinAndBindFetch({ policy: LOOPBACK_OK_WEBHOOK_SSRF_POLICY });

function makeSignerKey(kid = 'e2e-webhook-key') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  return {
    signerKey: {
      keyid: kid,
      alg: 'ed25519',
      privateKey: { ...priv, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['sign'] },
    },
    publicJwk: { ...pub, kid, alg: 'ed25519', adcp_use: 'webhook-signing', key_ops: ['verify'] },
  };
}

async function callTool(server, toolName, params) {
  const raw = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: toolName, arguments: params ?? {} },
  });
  return raw.structuredContent;
}

describe('createAdcpServer + webhook emitter: full-stack publisher E2E', () => {
  let receiver;

  afterEach(async () => {
    if (receiver) await receiver.close();
    receiver = undefined;
  });

  test('handler calls ctx.emitWebhook → receiver captures → verifier accepts', async () => {
    const { signerKey, publicJwk } = makeSignerKey();
    receiver = await createWebhookReceiver();

    const emitted = [];
    const server = createAdcpServer({
      name: 'e2e-publisher',
      version: '1.0.0',
      webhooks: { signerKey, fetch: loopbackFetch },
      mediaBuy: {
        createMediaBuy: async (params, ctx) => {
          // Business logic: create the media buy, then fire the webhook.
          const media_buy_id = 'mb_e2e_01';
          const result = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: {
              operation_id: 'e2e_op_01',
              task: {
                task_id: `task_${media_buy_id}`,
                status: 'completed',
                result: { media_buy_id },
              },
            },
            delivery_id: `create_media_buy.${media_buy_id}.completed`,
          });
          emitted.push(result);
          return { media_buy_id, packages: [] };
        },
      },
    });

    const capabilities = await callTool(server, 'get_adcp_capabilities', {});
    assert.deepStrictEqual(capabilities.webhook_signing, {
      supported: true,
      profile: 'adcp/webhook-signing/v1',
      algorithms: ['ed25519'],
      legacy_hmac_fallback: false,
      delivery_retry_horizon_seconds: 86_400,
    });

    const handlerResult = await callTool(server, 'create_media_buy', {
      account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
      brand: { domain: 'acme.example' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po-1' }],
      idempotency_key: 'e2e_create_key_0123456',
      push_notification_config: {
        url: `${receiver.base_url}/step/e2e_trigger/e2e_op_01`,
        operation_id: 'e2e_op_01',
      },
    });

    assert.strictEqual(handlerResult.media_buy_id, 'mb_e2e_01');
    assert.strictEqual(emitted.length, 1, 'handler must have called emitWebhook');
    assert.strictEqual(emitted[0].delivered, true);
    assert.match(emitted[0].idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);

    // Receiver captured the delivery.
    const [captured] = receiver.all();
    assert.ok(captured, 'receiver must have captured the webhook');
    assert.strictEqual(captured.step_id, 'e2e_trigger');
    assert.strictEqual(captured.operation_id, 'e2e_op_01');
    assert.strictEqual(captured.body.idempotency_key, emitted[0].idempotency_key);
    assert.strictEqual(captured.body.task.result.media_buy_id, 'mb_e2e_01');

    // Full 9421 signature verification against the published JWK.
    const verified = await verifyWebhookSignature(
      {
        method: captured.method,
        url: `${receiver.base_url}/step/${captured.step_id}/${captured.operation_id}`,
        headers: captured.headers,
        body: captured.raw_body,
      },
      {
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
      }
    );
    assert.strictEqual(verified.status, 'verified');
    assert.strictEqual(verified.keyid, signerKey.keyid);
  });

  test('ctx.emitWebhook is undefined when webhooks config is omitted', async () => {
    let seenEmitWebhook;
    const server = createAdcpServer({
      name: 'no-webhooks',
      version: '1.0.0',
      mediaBuy: {
        createMediaBuy: async (_params, ctx) => {
          seenEmitWebhook = ctx.emitWebhook;
          return { media_buy_id: 'mb_no_emit', packages: [] };
        },
      },
    });
    await callTool(server, 'create_media_buy', {
      account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
      brand: { domain: 'acme.example' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po-1' }],
      idempotency_key: 'no_emit_key_0123456789',
    });
    assert.strictEqual(seenEmitWebhook, undefined);
  });

  test('production server binds its unbound publisher from an explicit single-tenant fallback', async () => {
    const { signerKey } = makeSignerKey();
    const claimedKeys = [];
    const deliveryStore = {
      durability: 'durable',
      claim(key, proposed, retentionMs) {
        claimedKeys.push({ ...key });
        const firstAttemptAtMs = Date.now();
        return {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs,
          retainUntilMs: firstAttemptAtMs + retentionMs,
        };
      },
    };
    const deliveryRecovery = {
      durability: 'durable',
      checkpoint() {},
      settle() {},
    };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let server;
    try {
      server = createAdcpServer({
        name: 'production-publisher',
        version: '1.0.0',
        stateStore: new InMemoryStateStore(),
        idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
        resolveIdempotencyPrincipal: () => 'trusted-principal',
        webhooks: {
          signerKey,
          deliveryStore,
          deliveryRecovery,
          tenantScope: 'single-tenant',
          fetch: async () => new Response(null, { status: 204 }),
        },
        mediaBuy: {
          createMediaBuy: async (_params, ctx) => {
            await ctx.emitWebhook({ url: 'https://buyer.example/status', payload: {}, delivery_id: 'delivery-1' });
            return { media_buy_id: 'mb_production', packages: [] };
          },
        },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    const result = await callTool(server, 'create_media_buy', {
      account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
      brand: { domain: 'acme.example' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po-1' }],
      idempotency_key: 'production_create_key_01',
      push_notification_config: { url: 'https://buyer.example/status', operation_id: 'production-op-01' },
    });

    assert.strictEqual(result.media_buy_id, 'mb_production');
    assert.deepStrictEqual(claimedKeys, [
      { publisherScope: 'production-publisher', tenantScope: 'single-tenant', deliveryId: 'delivery-1' },
    ]);
  });

  test('production server refuses webhook emission without trusted tenant scope', async () => {
    const { signerKey } = makeSignerKey();
    let claims = 0;
    let checkpoints = 0;
    let fetches = 0;
    let emissionError;
    const deliveryStore = {
      durability: 'durable',
      claim(_key, proposed, retentionMs) {
        claims += 1;
        const firstAttemptAtMs = Date.now();
        return {
          status: 'bound',
          ...proposed,
          firstAttemptAtMs,
          retainUntilMs: firstAttemptAtMs + retentionMs,
        };
      },
    };
    const deliveryRecovery = {
      durability: 'durable',
      checkpoint() {
        checkpoints += 1;
      },
      settle() {},
    };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let server;
    try {
      server = createAdcpServer({
        name: 'unscoped-production-publisher',
        version: '1.0.0',
        stateStore: new InMemoryStateStore(),
        idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
        resolveIdempotencyPrincipal: () => 'trusted-principal',
        webhooks: {
          signerKey,
          deliveryStore,
          deliveryRecovery,
          fetch: async () => {
            fetches += 1;
            return new Response(null, { status: 204 });
          },
        },
        mediaBuy: {
          createMediaBuy: async (_params, ctx) => {
            try {
              await ctx.emitWebhook({
                url: 'https://buyer.example/status',
                payload: {},
                delivery_id: 'unscoped-delivery',
              });
            } catch (error) {
              emissionError = error;
              throw error;
            }
            return { media_buy_id: 'must-not-complete', packages: [] };
          },
        },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    const result = await callTool(server, 'create_media_buy', {
      account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
      brand: { domain: 'acme.example' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po-1' }],
      idempotency_key: 'unscoped_create_key_01',
      push_notification_config: { url: 'https://buyer.example/status', operation_id: 'unscoped-op-01' },
    });

    assert.match(emissionError.message, /not tenant-bound; call forTenantScope/);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(claims, 0);
    assert.strictEqual(checkpoints, 0);
    assert.strictEqual(fetches, 0);
  });

  test('production server validates an explicit tenant scope at startup', () => {
    const { signerKey } = makeSignerKey();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const memory = memoryWebhookDeliveryStore();
      assert.throws(
        () =>
          createAdcpServer({
            name: 'invalid-tenant-scope',
            version: '1.0.0',
            stateStore: new InMemoryStateStore(),
            webhooks: {
              signerKey,
              tenantScope: 'invalid\0tenant',
              deliveryStore: { ...memory, durability: 'durable' },
              deliveryRecovery: { durability: 'durable', checkpoint() {}, settle() {} },
            },
          }),
        /tenantScope must be a non-empty string without NUL characters/
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test('production server refuses an implicit in-memory delivery binding store', () => {
    const { signerKey } = makeSignerKey();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'durability-required',
            version: '1.0.0',
            stateStore: new InMemoryStateStore(),
            webhooks: { signerKey, fetch: loopbackFetch },
          }),
        /production webhook emission requires a durable WebhookDeliveryStore/
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test('production server refuses an explicitly supplied process-local delivery store', () => {
    const { signerKey } = makeSignerKey();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          createAdcpServer({
            name: 'durability-required-explicit',
            version: '1.0.0',
            stateStore: new InMemoryStateStore(),
            webhooks: { signerKey, fetch: loopbackFetch, deliveryStore: memoryWebhookDeliveryStore() },
          }),
        /production webhook emission requires a durable WebhookDeliveryStore/
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test('production server refuses a durable binding store without durable recovery state', () => {
    const { signerKey } = makeSignerKey();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const memory = memoryWebhookDeliveryStore();
      assert.throws(
        () =>
          createAdcpServer({
            name: 'recovery-required',
            version: '1.0.0',
            stateStore: new InMemoryStateStore(),
            webhooks: { signerKey, fetch: loopbackFetch, deliveryStore: { ...memory, durability: 'durable' } },
          }),
        /requires durable deliveryRecovery/
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test('3.1 capability projection omits the 3.2 retry-horizon field', async () => {
    const { signerKey } = makeSignerKey();
    const server = createAdcpServer({
      name: 'legacy-capability-projection',
      version: '1.0.0',
      adcpVersion: '3.1.18',
      webhooks: { signerKey, fetch: loopbackFetch },
      mediaBuy: {
        getProducts: async () => ({ products: [], cache_scope: 'public' }),
      },
    });

    const capabilities = await callTool(server, 'get_adcp_capabilities', {});
    assert.strictEqual(capabilities.webhook_signing.supported, true);
    assert.strictEqual(capabilities.webhook_signing.delivery_retry_horizon_seconds, undefined);
  });

  test('delivery identity is separate from stable payload operation identity', async () => {
    const { signerKey } = makeSignerKey();
    receiver = await createWebhookReceiver();

    const emittedKeys = [];
    const server = createAdcpServer({
      name: 'stability-publisher',
      version: '1.0.0',
      webhooks: { signerKey, fetch: loopbackFetch },
      mediaBuy: {
        createMediaBuy: async (params, ctx) => {
          const workingPayload = {
            operation_id: 'op_stable',
            task: { status: 'accepted' },
            timestamp: '2026-05-01T00:00:00Z',
          };
          // Exact retries reuse the delivery id/key.
          const first = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: workingPayload,
            delivery_id: 'create_media_buy.mb_stable.accepted',
          });
          const second = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: workingPayload,
            delivery_id: 'create_media_buy.mb_stable.accepted',
          });
          // A new observation retains the payload operation_id but gets a
          // distinct delivery id/key.
          const terminal = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: {
              operation_id: 'op_stable',
              task: { status: 'completed' },
              timestamp: '2026-05-01T00:01:00Z',
            },
            delivery_id: 'create_media_buy.mb_stable.completed',
          });
          emittedKeys.push(first.idempotency_key, second.idempotency_key, terminal.idempotency_key);
          return { media_buy_id: 'mb_stable', packages: [] };
        },
      },
    });
    await callTool(server, 'create_media_buy', {
      account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
      brand: { domain: 'acme.example' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po-1' }],
      idempotency_key: 'stability_key_abcdefghij',
      push_notification_config: {
        url: `${receiver.base_url}/step/stable/op_stable`,
        operation_id: 'op_stable',
      },
    });
    assert.strictEqual(emittedKeys[0], emittedKeys[1], 'exact retries must reuse the delivery key');
    assert.notStrictEqual(emittedKeys[1], emittedKeys[2], 'changed observations must use a fresh delivery key');
    const captured = receiver.all();
    assert.strictEqual(captured.length, 3);
    assert.strictEqual(captured[0].body.idempotency_key, captured[1].body.idempotency_key);
    assert.notStrictEqual(captured[1].body.idempotency_key, captured[2].body.idempotency_key);
    assert.strictEqual(captured[0].body.operation_id, captured[2].body.operation_id);
  });

  test('trusted resolved tenant scopes isolate colliding delivery IDs in one shared store', async () => {
    const { signerKey } = makeSignerKey();
    const delivered = [];
    const claimedKeys = [];
    const bindings = memoryWebhookDeliveryStore();
    const deliveryStore = {
      durability: bindings.durability,
      claim(key, proposed, retentionMs) {
        claimedKeys.push({ ...key });
        return bindings.claim(key, proposed, retentionMs);
      },
    };
    const server = createAdcpServer({
      name: 'tenant-scoped-publisher',
      version: '1.0.0',
      resolveAccount: async ref => ({ id: ref.brand.domain }),
      resolveSessionKey: ({ account }) => account.id,
      webhooks: {
        signerKey,
        deliveryStore,
        fetch: async (_url, init) => {
          delivered.push(JSON.parse(init.body));
          return { status: 204, headers: new Headers() };
        },
      },
      mediaBuy: {
        createMediaBuy: async (_params, ctx) => {
          await ctx.emitWebhook({
            url: 'https://buyer.example/webhook',
            payload: { tenant: ctx.account.id },
            delivery_id: 'same-local-delivery-id',
          });
          return { media_buy_id: `mb_${ctx.account.id}`, packages: [] };
        },
      },
    });
    const request = domain => ({
      account: { brand: { domain }, operator: 'op.example' },
      brand: { domain },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po-1' }],
      idempotency_key: `tenant_scope_${domain.replace(/[^a-z]/g, '_')}_0123456789`,
    });
    await callTool(server, 'create_media_buy', request('tenant-a.example'));
    await callTool(server, 'create_media_buy', request('tenant-b.example'));
    assert.strictEqual(delivered.length, 2);
    assert.notStrictEqual(delivered[0].idempotency_key, delivered[1].idempotency_key);
    assert.strictEqual(claimedKeys.length, 2);
    assert.strictEqual(claimedKeys[0].publisherScope, 'tenant-scoped-publisher');
    assert.strictEqual(claimedKeys[1].publisherScope, 'tenant-scoped-publisher');
    assert.strictEqual(claimedKeys[0].deliveryId, 'same-local-delivery-id');
    assert.strictEqual(claimedKeys[1].deliveryId, 'same-local-delivery-id');
    assert.match(claimedKeys[0].tenantScope, /tenant-a\.example/);
    assert.match(claimedKeys[1].tenantScope, /tenant-b\.example/);
    assert.notStrictEqual(claimedKeys[0].tenantScope, claimedKeys[1].tenantScope);
  });
});
