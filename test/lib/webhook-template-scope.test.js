const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ProtocolClient, SingleAgentClient, TaskExecutor } = require('../../dist/lib/index.js');

const originalCallTool = ProtocolClient.callTool;

const agent = {
  id: 'agent_1',
  name: 'Agent 1',
  agent_uri: 'https://agent.example/mcp/',
  protocol: 'mcp',
};

describe('webhook template scoping', () => {
  afterEach(() => {
    ProtocolClient.callTool = originalCallTool;
  });

  it('does not send webhookUrl for tools outside the scoped template', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, _taskName, _params, options) => {
      calls.push(options);
      return { status: 'completed', products: [] };
    };

    const executor = new TaskExecutor({
      agentId: agent.id,
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['sync_creatives'],
      },
      validation: { requests: 'off', responses: 'off' },
    });

    await executor.executeTask(agent, 'get_products', {});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].webhookUrl, undefined);
  });

  it('sends webhookUrl for tools inside the scoped template', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, _taskName, _params, options) => {
      calls.push(options);
      return { status: 'completed', creatives: [] };
    };

    const executor = new TaskExecutor({
      agentId: agent.id,
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['sync_creatives'],
      },
      validation: { requests: 'off', responses: 'off' },
    });

    await executor.executeTask(agent, 'sync_creatives', {});

    assert.equal(calls.length, 1);
    assert.match(calls[0].webhookUrl, /^https:\/\/buyer\.example\/webhook\/sync_creatives\/agent_1\//);
  });

  it('disableWebhook suppresses a globally configured template for one call', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, _taskName, _params, options) => {
      calls.push(options);
      return { status: 'completed', creatives: [] };
    };

    const executor = new TaskExecutor({
      agentId: agent.id,
      webhookUrlTemplate: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
      validation: { requests: 'off', responses: 'off' },
    });

    await executor.executeTask(agent, 'sync_creatives', {}, undefined, { disableWebhook: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].webhookUrl, undefined);
  });

  it('injects reporting_webhook when media_buy_delivery is in scope', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, taskName, params, options) => {
      calls.push({ taskName, params, options });
      return { status: 'completed', media_buy_id: 'mb_1' };
    };

    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['media_buy_delivery'],
      },
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureEndpointDiscovered = async () => agent;
    client.detectServerVersion = async () => 'v3';

    await client.createMediaBuy({
      account: { account_id: 'acc_1' },
      brand: { domain: 'brand.example' },
      start_time: 'asap',
      end_time: '2026-12-31T00:00:00Z',
      packages: [{ product_id: 'prod_1', budget: 1000, pricing_option_id: 'po_1' }],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskName, 'create_media_buy');
    assert.match(
      calls[0].params.reporting_webhook.url,
      /^https:\/\/buyer\.example\/webhook\/media_buy_delivery\/agent_1\/delivery_report_agent_1_/
    );
    assert.equal(calls[0].options.webhookUrl, undefined);
  });

  it('does not inject reporting_webhook when media_buy_delivery is out of scope', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, taskName, params, options) => {
      calls.push({ taskName, params, options });
      return { status: 'completed', media_buy_id: 'mb_1' };
    };

    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['sync_creatives'],
      },
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureEndpointDiscovered = async () => agent;
    client.detectServerVersion = async () => 'v3';

    await client.createMediaBuy({
      account: { account_id: 'acc_1' },
      brand: { domain: 'brand.example' },
      start_time: 'asap',
      end_time: '2026-12-31T00:00:00Z',
      packages: [{ product_id: 'prod_1', budget: 1000, pricing_option_id: 'po_1' }],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.reporting_webhook, undefined);
    assert.equal(calls[0].options.webhookUrl, undefined);
  });
});
