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
const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');
const { verifyWebhookSignature } = require('../../dist/lib/signing/webhook-verifier.js');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay.js');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation.js');

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
      webhooks: { signerKey },
      mediaBuy: {
        createMediaBuy: async (params, ctx) => {
          // Business logic: create the media buy, then fire the webhook.
          const media_buy_id = 'mb_e2e_01';
          const result = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: {
              task: {
                task_id: `task_${media_buy_id}`,
                status: 'completed',
                result: { media_buy_id },
              },
            },
            operation_id: `create_media_buy.${media_buy_id}`,
          });
          emitted.push(result);
          return { media_buy_id, packages: [] };
        },
      },
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

  test('idempotency-key stability survives two emit calls for the same operation_id', async () => {
    const { signerKey } = makeSignerKey();
    receiver = await createWebhookReceiver();

    const firstKeys = [];
    const server = createAdcpServer({
      name: 'stability-publisher',
      version: '1.0.0',
      webhooks: { signerKey },
      mediaBuy: {
        createMediaBuy: async (params, ctx) => {
          // Emit twice for the same operation_id — simulates a handler
          // that notifies on two lifecycle transitions of the same event.
          const first = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: { task: { status: 'accepted' } },
            operation_id: 'create_media_buy.mb_stable',
          });
          const second = await ctx.emitWebhook({
            url: params.push_notification_config.url,
            payload: { task: { status: 'completed' } },
            operation_id: 'create_media_buy.mb_stable',
          });
          firstKeys.push(first.idempotency_key, second.idempotency_key);
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
      push_notification_config: { url: `${receiver.base_url}/step/stable/op_stable` },
    });
    assert.strictEqual(firstKeys[0], firstKeys[1], "both emits must reuse the operation_id's stored key");
    const captured = receiver.all();
    assert.strictEqual(captured.length, 2);
    assert.strictEqual(captured[0].body.idempotency_key, captured[1].body.idempotency_key);
  });
});
