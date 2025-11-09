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
    requiresAuth: false,
  };

  const webhookSecret = 'test-secret-key-minimum-32-characters-long';

  test('should verify valid webhook signature per PR #86 spec', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const payload = {
      event: 'creative.status_changed',
      creative_id: 'creative_123',
      status: 'approved',
      timestamp: '2025-10-08T22:30:00Z',
    };

    const timestamp = Math.floor(Date.now() / 1000);

    // Generate signature per PR #86 spec: sha256=HMAC({timestamp}.{json_payload})
    const message = `${timestamp}.${JSON.stringify(payload)}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Verify signature
    const isValid = agentClient.verifyWebhookSignature(payload, signature, timestamp);
    assert.strictEqual(isValid, true);
  });

  test('should reject webhook with invalid signature', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const payload = {
      event: 'creative.status_changed',
      creative_id: 'creative_123',
      status: 'approved',
    };

    const timestamp = Math.floor(Date.now() / 1000);
    const invalidSignature = 'sha256=invalid_signature_here';

    const isValid = agentClient.verifyWebhookSignature(payload, invalidSignature, timestamp);
    assert.strictEqual(isValid, false);
  });

  test('should reject webhook with old timestamp (> 5 minutes)', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const payload = {
      event: 'creative.status_changed',
      creative_id: 'creative_123',
      status: 'approved',
    };

    // Timestamp from 10 minutes ago
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;

    // Generate valid signature for old timestamp
    const message = `${oldTimestamp}.${JSON.stringify(payload)}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Should reject due to timestamp being too old
    const isValid = agentClient.verifyWebhookSignature(payload, signature, oldTimestamp);
    assert.strictEqual(isValid, false);
  });

  test('should accept webhook within 5 minute window', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const payload = {
      event: 'creative.status_changed',
      creative_id: 'creative_123',
      status: 'approved',
    };

    // Timestamp from 2 minutes ago (within 5 minute window)
    const recentTimestamp = Math.floor(Date.now() / 1000) - 120;

    // Generate valid signature
    const message = `${recentTimestamp}.${JSON.stringify(payload)}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Should accept
    const isValid = agentClient.verifyWebhookSignature(payload, signature, recentTimestamp);
    assert.strictEqual(isValid, true);
  });

  test('should handle timestamp as string', () => {
    const client = new AdCPClient([agent], { webhookSecret });
    const agentClient = client.agent('test_agent');

    const payload = {
      event: 'creative.status_changed',
      creative_id: 'creative_123',
      status: 'approved',
    };

    const timestamp = Math.floor(Date.now() / 1000);
    const timestampStr = timestamp.toString();

    // Generate valid signature
    const message = `${timestamp}.${JSON.stringify(payload)}`;
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(message);
    const signature = `sha256=${hmac.digest('hex')}`;

    // Should accept string timestamp
    const isValid = agentClient.verifyWebhookSignature(payload, signature, timestampStr);
    assert.strictEqual(isValid, true);
  });

  test('should return false when webhookSecret not configured', () => {
    const client = new AdCPClient([agent], {}); // No webhookSecret
    const agentClient = client.agent('test_agent');

    const payload = { event: 'test' };
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = 'sha256=anything';

    const isValid = agentClient.verifyWebhookSignature(payload, signature, timestamp);
    assert.strictEqual(isValid, false);
  });
});
