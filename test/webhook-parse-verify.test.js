const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { SingleAgentClient, WebhookDispatchError } = require('../dist/lib/index.js');

const agent = {
  id: 'test_agent',
  name: 'Test Agent',
  agent_uri: 'https://test.example/mcp/',
  protocol: 'mcp',
};

function deliveryEnvelope(overrides = {}) {
  return {
    idempotency_key: 'whk_test_delivery_0000001',
    operation_id: 'delivery_report_67_2026-04',
    task_id: 'delivery_report_67_2026-04_000031',
    task_type: 'media_buy_delivery',
    status: 'completed',
    timestamp: '2026-05-26T09:00:44.582Z',
    result: {
      notification_type: 'scheduled',
      sequence_number: 31,
      reporting_period: {
        start: '2026-05-25T00:00:00Z',
        end: '2026-05-25T23:59:00Z',
      },
      currency: 'USD',
      media_buy_deliveries: [],
    },
    ...overrides,
  };
}

describe('verifyAndParseWebhook', () => {
  test('accepts delivery reports nested inside an MCP webhook envelope', async () => {
    const client = new SingleAgentClient(agent, {});
    const parsed = await client.verifyAndParseWebhook({
      body: JSON.stringify(deliveryEnvelope()),
      taskType: 'media_buy_delivery',
      operationId: 'delivery_report_67_2026-04',
    });

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.protocol, 'mcp');
    assert.strictEqual(parsed.metadata.taskType, 'media_buy_delivery');
    assert.strictEqual(parsed.metadata.idempotencyKey, 'whk_test_delivery_0000001');
    assert.strictEqual(parsed.result.notification_type, 'scheduled');
  });

  test('rejects bare delivery result payloads before dispatch', async () => {
    const client = new SingleAgentClient(agent, {});
    const parsed = await client.verifyAndParseWebhook({
      body: JSON.stringify(deliveryEnvelope().result),
      taskType: 'media_buy_delivery',
      operationId: 'delivery_report_67_2026-04',
    });

    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'webhook_unsupported_payload');
    assert.match(parsed.message, /bare delivery report result/);
  });

  test('handleWebhook throws a typed dispatch error for malformed envelopes', async () => {
    const client = new SingleAgentClient(agent, {});
    await assert.rejects(
      () =>
        client.handleWebhook(
          { task_id: 'task_1', task_type: 'media_buy_delivery', status: 'completed', result: {} },
          'media_buy_delivery',
          'op_1'
        ),
      error => {
        assert.ok(error instanceof WebhookDispatchError);
        assert.strictEqual(error.code, 'webhook_envelope_invalid');
        assert.match(error.message, /missing top-level field/);
        return true;
      }
    );
  });

  test('returns typed signature errors for invalid HMAC requests', async () => {
    const webhookSecret = 'test-secret-key-minimum-32-characters-long';
    const client = new SingleAgentClient(agent, { webhookSecret });
    const rawBody = JSON.stringify(deliveryEnvelope());
    const timestamp = Math.floor(Date.now() / 1000);

    const parsed = await client.verifyAndParseWebhook({
      body: rawBody,
      headers: {
        'x-adcp-signature': `sha256=${'0'.repeat(64)}`,
        'x-adcp-timestamp': String(timestamp),
      },
      taskType: 'media_buy_delivery',
      operationId: 'delivery_report_67_2026-04',
    });

    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'webhook_signature_invalid');

    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(`${timestamp}.${rawBody}`);
    const valid = await client.verifyAndParseWebhook({
      body: rawBody,
      headers: {
        'x-adcp-signature': `sha256=${hmac.digest('hex')}`,
        'x-adcp-timestamp': String(timestamp),
      },
      taskType: 'media_buy_delivery',
      operationId: 'delivery_report_67_2026-04',
    });
    assert.strictEqual(valid.ok, true);
  });

  test('parses verified raw HMAC bytes instead of a conflicting parsed payload', async () => {
    const webhookSecret = 'test-secret-key-minimum-32-characters-long';
    const client = new SingleAgentClient(agent, { webhookSecret });
    const rawEnvelope = deliveryEnvelope({ idempotency_key: 'whk_signed_raw_0000001' });
    const rawBody = JSON.stringify(rawEnvelope);
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(`${timestamp}.${rawBody}`);

    const parsed = await client.verifyAndParseWebhook({
      rawBody,
      payload: deliveryEnvelope({
        idempotency_key: 'whk_conflicting_payload',
        result: { notification_type: 'scheduled', media_buy_deliveries: [{ media_buy_id: 'wrong' }] },
      }),
      headers: {
        'x-adcp-signature': `sha256=${hmac.digest('hex')}`,
        'x-adcp-timestamp': String(timestamp),
      },
      taskType: 'media_buy_delivery',
      operationId: 'delivery_report_67_2026-04',
    });

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.metadata.idempotencyKey, 'whk_signed_raw_0000001');
    assert.deepStrictEqual(parsed.result.media_buy_deliveries, []);
  });
});
