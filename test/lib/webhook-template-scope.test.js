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

function canonicalCreateMediaBuyParams(reportingWebhook) {
  return {
    account: { account_id: 'acc_1' },
    brand: { domain: 'brand.example' },
    start_time: 'asap',
    end_time: '2026-12-31T00:00:00Z',
    packages: [
      {
        product_id: 'prod_1',
        budget: 1000,
        pricing_option_id: 'po_1',
        format_kind: 'image',
        params: {},
      },
    ],
    reporting_webhook: reportingWebhook,
  };
}

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

    // `reporting-webhook.json` requires `authentication`, so a registration is
    // only sendable when a real credential backs it.
    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['media_buy_delivery'],
      },
      webhookSecret: 'a-real-secret-of-at-least-32-characters',
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
    assert.deepEqual(calls[0].params.reporting_webhook.authentication, {
      schemes: ['HMAC-SHA256'],
      credentials: 'a-real-secret-of-at-least-32-characters',
    });
    assert.equal(calls[0].options.webhookUrl, undefined);
  });

  it('skips reporting_webhook injection when no webhookSecret backs the required authentication', async () => {
    // The alternative would be registering with a hardcoded placeholder
    // credential, which tells the seller the channel is authenticated when it is
    // not. Skipping leaves the media buy itself unaffected.
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

    assert.equal(calls.length, 1, 'the media buy still goes out');
    assert.equal(calls[0].params.reporting_webhook, undefined, 'no unauthenticated registration is sent');
  });

  it('uses a caller-supplied authentication block when there is no webhookSecret', async () => {
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
      reporting_webhook: {
        authentication: { schemes: ['Bearer'], credentials: 'caller-supplied-credential-value' },
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.reporting_webhook.authentication, {
      schemes: ['Bearer'],
      credentials: 'caller-supplied-credential-value',
    });
  });

  it('completes caller reporting preferences before canonical creative preflight validation', async () => {
    const calls = [];
    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['media_buy_delivery'],
      },
      webhookSecret: 'a-real-secret-of-at-least-32-characters',
      validateFeatures: false,
      validation: { requests: 'strict', responses: 'off' },
    });
    client.getCapabilities = async () => ({ features: { canonicalCreatives: true } });
    client.executeAndHandle = async (taskName, _handler, params) => {
      calls.push({ taskName, params });
      return { success: true, status: 'completed', data: { media_buy_id: 'mb_1' } };
    };

    await client.createMediaBuy(
      canonicalCreateMediaBuyParams({
        url: undefined,
        reporting_frequency: 'daily',
        requested_metrics: ['impressions', 'spend'],
      })
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskName, 'create_media_buy');
    assert.match(
      calls[0].params.reporting_webhook.url,
      /^https:\/\/buyer\.example\/webhook\/media_buy_delivery\/agent_1\/delivery_report_agent_1_/
    );
    assert.deepEqual(calls[0].params.reporting_webhook.authentication, {
      schemes: ['HMAC-SHA256'],
      credentials: 'a-real-secret-of-at-least-32-characters',
    });
    assert.deepEqual(calls[0].params.reporting_webhook.requested_metrics, ['impressions', 'spend']);

    await client.createMediaBuy(
      canonicalCreateMediaBuyParams({
        reporting_frequency: undefined,
        requested_metrics: ['impressions'],
      })
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.reporting_webhook.reporting_frequency, 'daily');
  });

  it('rejects malformed reporting webhook input before capability discovery', async () => {
    let capabilityCalls = 0;
    let dispatchCalls = 0;
    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['media_buy_delivery'],
      },
      webhookSecret: 'a-real-secret-of-at-least-32-characters',
      validateFeatures: false,
      validation: { requests: 'strict', responses: 'off' },
    });
    client.getCapabilities = async () => {
      capabilityCalls += 1;
      return { features: { canonicalCreatives: true } };
    };
    client.executeAndHandle = async () => {
      dispatchCalls += 1;
      return { success: true, status: 'completed', data: { media_buy_id: 'mb_1' } };
    };

    for (const malformedWebhook of [
      null,
      new Date('2026-01-01T00:00:00Z'),
      new Map([['reporting_frequency', 'daily']]),
    ]) {
      await assert.rejects(
        () => client.createMediaBuy(canonicalCreateMediaBuyParams(malformedWebhook)),
        /reporting_webhook/
      );
    }
    assert.equal(capabilityCalls, 0);
    assert.equal(dispatchCalls, 0);
  });

  it('never binds the client secret to a caller-controlled reporting URL', async () => {
    let capabilityCalls = 0;
    let dispatchCalls = 0;
    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['media_buy_delivery'],
      },
      webhookSecret: 'a-real-secret-of-at-least-32-characters',
      validateFeatures: false,
      validation: { requests: 'strict', responses: 'off' },
    });
    client.getCapabilities = async () => {
      capabilityCalls += 1;
      return { features: { canonicalCreatives: true } };
    };
    client.executeAndHandle = async () => {
      dispatchCalls += 1;
      return { success: true, status: 'completed', data: { media_buy_id: 'mb_1' } };
    };

    await assert.rejects(
      () =>
        client.createMediaBuy(
          canonicalCreateMediaBuyParams({
            url: 'https://tenant-controlled.example/capture',
            reporting_frequency: 'daily',
          })
        ),
      /reporting_webhook requires an `authentication` block/
    );
    assert.equal(capabilityCalls, 0);
    assert.equal(dispatchCalls, 0);
  });

  it('rejects null reporting authentication instead of replacing it with the client secret', async () => {
    let capabilityCalls = 0;
    let dispatchCalls = 0;
    const client = new SingleAgentClient(agent, {
      webhookUrlTemplate: {
        template: 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}',
        tools: ['media_buy_delivery'],
      },
      webhookSecret: 'a-real-secret-of-at-least-32-characters',
      validateFeatures: false,
      validation: { requests: 'strict', responses: 'off' },
    });
    client.getCapabilities = async () => {
      capabilityCalls += 1;
      return { features: { canonicalCreatives: true } };
    };
    client.executeAndHandle = async () => {
      dispatchCalls += 1;
      return { success: true, status: 'completed', data: { media_buy_id: 'mb_1' } };
    };

    await assert.rejects(
      () =>
        client.createMediaBuy(
          canonicalCreateMediaBuyParams({
            reporting_frequency: 'daily',
            authentication: null,
          })
        ),
      /reporting_webhook requires an `authentication` block/
    );
    assert.equal(capabilityCalls, 0);
    assert.equal(dispatchCalls, 0);
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
