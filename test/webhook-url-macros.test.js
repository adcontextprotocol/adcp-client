// Test webhook URL macro substitution

const { test } = require('node:test');
const assert = require('node:assert');
const { AdCPClient } = require('../dist/lib/index.js');

const agentConfig = {
  id: 'test_agent',
  name: 'Test Agent',
  agent_uri: 'https://agent.example.com',
  protocol: 'a2a',
};

test('path-based template', () => {
  const client = new AdCPClient([agentConfig], {
    webhookUrlTemplate: 'https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}',
  });

  const url = client.agent('test_agent').getWebhookUrl('sync_creatives', 'op_123');
  assert.strictEqual(url, 'https://myapp.com/webhook/sync_creatives/test_agent/op_123');
});

test('query string template', () => {
  const client = new AdCPClient([agentConfig], {
    webhookUrlTemplate: 'https://myapp.com/webhook?agent={agent_id}&op={operation_id}&type={task_type}',
  });

  const url = client.agent('test_agent').getWebhookUrl('sync_creatives', 'op_123');
  assert.strictEqual(url, 'https://myapp.com/webhook?agent=test_agent&op=op_123&type=sync_creatives');
});

test('mixed path and query template', () => {
  const client = new AdCPClient([agentConfig], {
    webhookUrlTemplate: 'https://myapp.com/api/v1/callbacks/{agent_id}?operation={operation_id}',
  });

  const url = client.agent('test_agent').getWebhookUrl('create_media_buy', 'op_456');
  assert.strictEqual(url, 'https://myapp.com/api/v1/callbacks/test_agent?operation=op_456');
});

test('notification webhook URL', () => {
  const client = new AdCPClient([agentConfig], {
    webhookUrlTemplate: 'https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}',
  });

  const url = client.agent('test_agent').getWebhookUrl('media_buy_delivery', 'delivery_report_test_agent_2025-10');
  assert.strictEqual(url, 'https://myapp.com/webhook/media_buy_delivery/test_agent/delivery_report_test_agent_2025-10');
});

test('throws error if webhookUrlTemplate not configured', () => {
  const client = new AdCPClient([agentConfig], {});

  assert.throws(
    () => client.agent('test_agent').getWebhookUrl('sync_creatives', 'op_123'),
    /webhookUrlTemplate not configured/
  );
});
