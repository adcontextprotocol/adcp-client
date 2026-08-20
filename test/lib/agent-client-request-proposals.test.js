const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentClient } = require('../../dist/lib/index.js');

test('AgentClient rejects projection-only products_available from native request_proposals', async () => {
  const agent = new AgentClient(
    {
      id: 'native-compact-seller',
      name: 'Native compact seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    },
    { validateFeatures: false }
  );
  agent.client.executeTask = async () => ({
    success: true,
    status: 'completed',
    data: {
      outcome: 'products_available',
      products: [{ product_id: 'p1' }],
      purchase_continuation: { kind: 'listed_purchase', product_ids: ['p1'] },
    },
    metadata: {
      taskId: 'proposal-task',
      taskName: 'request_proposals',
      agent: { id: 'native-compact-seller', name: 'Native compact seller', protocol: 'mcp' },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
  });

  await assert.rejects(
    agent.requestProposals({
      idempotency_key: 'native-proposals-guard-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Native proposals only',
    }),
    /projection-only products_available/
  );
});
