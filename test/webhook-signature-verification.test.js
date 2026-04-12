const { test, describe } = require('node:test');
const assert = require('node:assert');
const { AdCPClient } = require('../dist/lib/index.js');
const crypto = require('crypto');

describe('Webhook Signature Verification (PR #86 Spec)', () => {
  const agent = {
    id: 'test_agent',
    name: 'Test Agent',
    agent_uri: 'https://test.example',
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

/**
 * Official AdCP spec test vectors from:
 * https://github.com/adcontextprotocol/adcp/blob/main/static/test-vectors/webhook-hmac-sha256.json
 *
 * These are static, known-good HMAC signatures that all AdCP implementations
 * must produce identically. Validates cross-language interop.
 */
describe('AdCP Spec Test Vectors (webhook-hmac-sha256.json)', () => {
  const secret = 'test-secret-key-minimum-32-characters-long';

  const vectors = [
    {
      description: 'compact JSON (JS-style JSON.stringify)',
      timestamp: 1700000000,
      raw_body: '{"event":"creative.status_changed","creative_id":"creative_123","status":"approved"}',
      expected_signature: 'sha256=c4faf82609efe07621706df0d28c801de2b5145f427e129f243a3839df891a4e',
    },
    {
      description: 'spaced JSON (Python-style json.dumps with default separators)',
      timestamp: 1700000000,
      raw_body: '{"event": "creative.status_changed", "creative_id": "creative_123", "status": "approved"}',
      expected_signature: 'sha256=4acce503547a93922a2b41c32f5f0e646b71a36572fd1536d3d7fcd88a4e5c5f',
    },
    {
      description: 'empty object',
      timestamp: 1700000000,
      raw_body: '{}',
      expected_signature: 'sha256=fc66235ab6cf0a5927d76d88194036fa99c7e08c75d55c9de5008288d448f1a0',
    },
    {
      description: 'nested objects and arrays',
      timestamp: 1700000000,
      raw_body:
        '{"task_id":"task_456","operation_id":"op_789","result":{"media_buy_id":"mb_001","packages":[{"package_id":"pkg_1"},{"package_id":"pkg_2"}]}}',
      expected_signature: 'sha256=a90052e145bd73ba69a236748df05a3887ef9e73ddd429ef179bdd498ddb97ba',
    },
    {
      description: 'unicode characters (literal UTF-8, not escaped)',
      timestamp: 1700000000,
      raw_body: '{"brand_name":"Café Münchën","tagline":"日本語テスト"}',
      expected_signature: 'sha256=4383aa943264c461c5b9796734fdd9ae51934ecbdf7d38fcf94d330bfa590576',
    },
    {
      description: 'pretty-printed JSON (multiline with indentation)',
      timestamp: 1700000000,
      raw_body: '{\n  "status": "completed",\n  "result": {\n    "id": "mb_001"\n  }\n}',
      expected_signature: 'sha256=ad4858d6a7a38207ee178502b4bffc700080258a433e127919b445b68794f085',
    },
    {
      description: 'numeric values, booleans, and null',
      timestamp: 1700000000,
      raw_body: '{"price":19.99,"count":1000,"active":true,"discount":null}',
      expected_signature: 'sha256=12d4173bebd369c066880bd8f12952c4c1f6f48addbc1dc5267d8ba8de205a4f',
    },
    {
      description: 'empty body',
      timestamp: 1700000000,
      raw_body: '',
      expected_signature: 'sha256=9ab3f90245d5919d344a849a4a1b0ec20b75fcf8f29d817e63b23b54fce52294',
    },
    {
      description: 'timestamp zero',
      timestamp: 0,
      raw_body: '{"event":"test"}',
      expected_signature: 'sha256=446cc9dbe11ee98af9445a27dfcf9d52530c874583e5750d295bad336a406c3c',
    },
    {
      description: 'large timestamp (year 2040)',
      timestamp: 2208988800,
      raw_body: '{"event":"test"}',
      expected_signature: 'sha256=a0fdee5e93b2ac2efdf8d3d22b7a03ae8e6df157b493d0140f7902ef32f6be60',
    },
  ];

  // First, verify our HMAC computation matches all spec vectors directly
  for (const vector of vectors) {
    test(`HMAC matches spec: ${vector.description}`, () => {
      const message = `${vector.timestamp}.${vector.raw_body}`;
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(message);
      const computed = `sha256=${hmac.digest('hex')}`;
      assert.strictEqual(computed, vector.expected_signature);
    });
  }

  // Then, verify verifyWebhookSignature accepts all spec vectors via raw body path.
  // Timestamp validation is bypassed by using vectors with timestamps far from "now",
  // so we only test the vectors where timestamp freshness won't reject them.
  // For full coverage, we test HMAC computation directly above.
  const agent = {
    id: 'test_agent',
    name: 'Test Agent',
    agent_uri: 'https://test.example',
    protocol: 'mcp',
  };

  for (const vector of vectors) {
    test(`verifyWebhookSignature accepts spec vector: ${vector.description}`, () => {
      // Mock Date.now so the timestamp freshness check passes
      const originalNow = Date.now;
      Date.now = () => vector.timestamp * 1000;
      try {
        const client = new AdCPClient([agent], { webhookSecret: secret });
        const agentClient = client.agent('test_agent');
        const isValid = agentClient.verifyWebhookSignature(
          vector.raw_body,
          vector.expected_signature,
          vector.timestamp
        );
        assert.strictEqual(isValid, true, `Vector "${vector.description}" should verify`);
      } finally {
        Date.now = originalNow;
      }
    });
  }
});
