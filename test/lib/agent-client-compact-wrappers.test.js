const { describe, test } = require('node:test');
const assert = require('node:assert');

const { AgentClient } = require('../../dist/lib/index.js');

const TEST_AGENT = {
  id: 'compact-wrapper-test',
  name: 'Compact wrapper test',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

const CASES = [
  ['listProducts', 'list_products', { max_results: 10 }],
  ['requestProposals', 'request_proposals', { idempotency_key: 'request-proposal-key', brief: 'test' }],
  [
    'declineProposals',
    'decline_proposals',
    { idempotency_key: 'decline-proposal-key', declines: [{ proposal_id: 'proposal-1' }] },
  ],
  [
    'buyProducts',
    'buy_products',
    { idempotency_key: 'buy-product-key', account: { account_id: 'account-1' }, feed_version: 'feed-v1' },
  ],
  [
    'acceptProposal',
    'accept_proposal',
    {
      idempotency_key: 'accept-proposal-key',
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-1',
      proposal_terms_digest: 'sha256:test',
    },
  ],
  [
    'controlMediaBuy',
    'control_media_buy',
    { idempotency_key: 'control-media-buy-key', media_buy_id: 'buy-1', action: 'pause' },
  ],
  [
    'reportPlanAdjustment',
    'report_plan_adjustment',
    { idempotency_key: 'report-adjustment-key', plan_id: 'plan-1', adjustment: {} },
  ],
  [
    'syncAgentNotificationConfigs',
    'sync_agent_notification_configs',
    { idempotency_key: 'notification-config-key', notification_configs: [] },
  ],
];

describe('AgentClient compact lifecycle wrappers', () => {
  for (const [method, taskName, params] of CASES) {
    test(`${method} dispatches ${taskName} and retains MCP context without treating work handles as sessions`, async () => {
      const wrapper = new AgentClient(TEST_AGENT, { validateFeatures: false });
      const calls = [];
      const inputHandler = async () => undefined;

      wrapper.client.executeTask = async (...args) => {
        calls.push(args);
        return {
          success: true,
          status: 'working',
          data: {},
          metadata: {
            status: 'working',
            contextId: 'ctx-server',
            serverTaskId: 'task-server',
            taskName,
          },
          conversation: [],
          debug_logs: [],
        };
      };

      await wrapper[method](params, inputHandler, {
        contextId: 'ctx-explicit',
        taskId: 'task-explicit',
        maxClarifications: 7,
      });

      assert.deepStrictEqual(calls[0], [
        taskName,
        params,
        inputHandler,
        { contextId: 'ctx-explicit', taskId: 'task-explicit', maxClarifications: 7 },
      ]);
      assert.strictEqual(wrapper.getContextId(), 'ctx-server');
      assert.strictEqual(wrapper.getPendingTaskId(), undefined);

      await wrapper[method](params);
      assert.deepStrictEqual(calls[1][3], { contextId: 'ctx-server', taskId: undefined });
    });
  }
});
