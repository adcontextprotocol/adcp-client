const { test, describe } = require('node:test');
const assert = require('node:assert');
const { AdCPClient } = require('../dist/lib/index.js');
const crypto = require('crypto');

describe('Webhook Signature Verification (PR #86 Spec)', () => {
  const agent = {
    id: 'test_agent',
    name: 'Test Agent',
    agent_uri: 'https://test.example.com',
    protocol: 'mcp',
  };

  const webhookSecret = 'test-secret-key-minimum-32-characters-long';

  test('should verify valid webhook signature using raw body string', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const rawBody =
      '{"event":"creative.status_changed","creative_id":"creative_123","status":"approved","timestamp":"2025-10-08T22:30:00Z"}';

    const timestamp = Math.floor(Date.now() / 1000);

    // Generate signature per spec: sha256=HMAC({timestamp}.{raw_body})
    const message = `${timestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Verify signature using raw body string
    const isValid = agentClient.verifyWebhookSignature(rawBody, signature, timestamp);
    assert.strictEqual(isValid, true);
  });

  test('should verify signature when raw body has different formatting than JSON.stringify', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    // Raw body with extra spaces (as a Python sender might produce)
    const rawBody = '{"key": "value",  "num": 1.0}';

    const timestamp = Math.floor(Date.now() / 1000);

    // Sender signs over raw body bytes
    const message = `${timestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Verification with raw body should succeed
    const isValid = agentClient.verifyWebhookSignature(rawBody, signature, timestamp);
    assert.strictEqual(isValid, true);

    // Verification with parsed object would fail (different bytes)
    const parsed = JSON.parse(rawBody);
    const isValidParsed = agentClient.verifyWebhookSignature(parsed, signature, timestamp);
    assert.strictEqual(isValidParsed, false, 'Parsed object re-serialization should not match raw body signature');
  });

  test('should still work with parsed object for backward compatibility', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const payload = {
      event: 'creative.status_changed',
      creative_id: 'creative_123',
      status: 'approved',
      timestamp: '2025-10-08T22:30:00Z',
    };

    const timestamp = Math.floor(Date.now() / 1000);

    // Generate signature using JSON.stringify (old-style sender)
    const message = `${timestamp}.${JSON.stringify(payload)}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Verify signature using parsed object (backward compat)
    const isValid = agentClient.verifyWebhookSignature(payload, signature, timestamp);
    assert.strictEqual(isValid, true);
  });

  test('should reject webhook with invalid signature', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const rawBody = '{"event":"creative.status_changed","creative_id":"creative_123","status":"approved"}';

    const timestamp = Math.floor(Date.now() / 1000);
    const invalidSignature = 'sha256=invalid_signature_here';

    const isValid = agentClient.verifyWebhookSignature(rawBody, invalidSignature, timestamp);
    assert.strictEqual(isValid, false);
  });

  test('should reject webhook with old timestamp (> 5 minutes)', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const rawBody = '{"event":"creative.status_changed","creative_id":"creative_123","status":"approved"}';

    // Timestamp from 10 minutes ago
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;

    // Generate valid signature for old timestamp
    const message = `${oldTimestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Should reject due to timestamp being too old
    const isValid = agentClient.verifyWebhookSignature(rawBody, signature, oldTimestamp);
    assert.strictEqual(isValid, false);
  });

  test('should accept webhook within 5 minute window', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const rawBody = '{"event":"creative.status_changed","creative_id":"creative_123","status":"approved"}';

    // Timestamp from 2 minutes ago (within 5 minute window)
    const recentTimestamp = Math.floor(Date.now() / 1000) - 120;

    // Generate valid signature
    const message = `${recentTimestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Should accept
    const isValid = agentClient.verifyWebhookSignature(rawBody, signature, recentTimestamp);
    assert.strictEqual(isValid, true);
  });

  test('should handle timestamp as string', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const rawBody = '{"event":"creative.status_changed","creative_id":"creative_123","status":"approved"}';

    const timestamp = Math.floor(Date.now() / 1000);
    const timestampStr = timestamp.toString();

    // Generate valid signature
    const message = `${timestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Should accept string timestamp
    const isValid = agentClient.verifyWebhookSignature(rawBody, signature, timestampStr);
    assert.strictEqual(isValid, true);
  });

  test('should verify signature from Python json.dumps() sender (cross-language interop)', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    // Python's json.dumps() produces spaces after ":" and "," by default
    // e.g. json.dumps({"event": "creative.status_changed", "num": 1.0})
    // produces: '{"event": "creative.status_changed", "num": 1.0}'
    const pythonRawBody =
      '{"event": "creative.status_changed", "creative_id": "creative_123", "status": "approved", "budget": 1500.0}';

    const timestamp = Math.floor(Date.now() / 1000);

    // Simulate Python signing: hmac.new(secret, f"{ts}.{raw_body}".encode(), hashlib.sha256)
    const message = `${timestamp}.${pythonRawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // JS receiver verifies using the raw body — should pass
    const isValid = agentClient.verifyWebhookSignature(pythonRawBody, signature, timestamp);
    assert.strictEqual(isValid, true, 'Raw body from Python sender should verify correctly');

    // If we had parsed and re-serialized, it would fail because:
    // JSON.stringify produces: {"event":"creative.status_changed","creative_id":"creative_123","status":"approved","budget":1500}
    // Note: no spaces, 1500.0 becomes 1500
    const parsed = JSON.parse(pythonRawBody);
    const isValidParsed = agentClient.verifyWebhookSignature(parsed, signature, timestamp);
    assert.strictEqual(
      isValidParsed,
      false,
      'Re-serialized Python payload should NOT verify (different spacing and number format)'
    );
  });

  test('should return false when webhookSecret not configured', () => {
    const client = new AdCPClient([agent], {}); // No webhookSecret
    const agentClient = client.agent('test_agent');

    const rawBody = '{"event":"test"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = 'sha256=anything';

    const isValid = agentClient.verifyWebhookSignature(rawBody, signature, timestamp);
    assert.strictEqual(isValid, false);
  });
});
