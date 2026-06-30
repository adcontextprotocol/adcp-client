const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { ADCPMultiAgentClient, closeMCPConnections, serve } = require('../dist/lib/index.js');
const { closeConnections } = require('../dist/lib/protocols/index.js');
const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');

function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    stateStore: config?.stateStore ?? new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function startMcpFixture(handlers) {
  const httpServer = serve(
    () =>
      createAdcpServer({
        name: 'Transport Diagnostics MCP Seller',
        version: '1.0.0',
        ...handlers,
      }),
    { port: 0, onListening: () => {} }
  );
  await waitForListening(httpServer);
  const { port } = httpServer.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => closeServer(httpServer),
  };
}

async function startA2aFixture(handlers) {
  const adcp = createAdcpServer({
    name: 'Transport Diagnostics A2A Seller',
    version: '1.0.0',
    ...handlers,
  });
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/a2a`;
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: {
      name: 'Transport Diagnostics A2A Seller',
      description: 'A2A fixture for transport diagnostics E2E tests',
      url,
      version: '1.0.0',
      provider: { organization: 'Test', url: 'https://test.example' },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  });
  a2a.mount(app);
  return {
    url,
    close: () => closeServer(server),
  };
}

function createClient(agent, events) {
  return new ADCPMultiAgentClient([agent], {
    allowV2: true,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    webhookUrlTemplate: 'https://buyer.example/webhook?token=webhook-url-secret#fragment',
    webhookSecret: 'webhook-secret-minimum-32-characters',
    onTransportActivity: event => events.push(event),
  });
}

const createMediaBuyParams = {
  account: { account_id: 'acct_transport_e2e' },
  brand: { domain: 'brand.example' },
  start_time: '2026-05-01T00:00:00Z',
  end_time: '2026-05-31T23:59:59Z',
  packages: [{ product_id: 'prod_transport_e2e', pricing_option_id: 'po_transport_e2e', budget: 5000 }],
};

function assertNoSecretLeak(events, secrets) {
  const serialized = JSON.stringify(events);
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `transport events leaked ${secret}`);
  }
}

function findToolEvent(events, type, protocol) {
  return events.find(
    event =>
      event.type === type &&
      event.protocol === protocol &&
      event.tool === 'create_media_buy' &&
      event.method === 'POST' &&
      event.requestBody?.includes('create_media_buy')
  );
}

function toolEvents(events, type, protocol) {
  return events.filter(
    event =>
      event.type === type &&
      event.protocol === protocol &&
      event.tool === 'create_media_buy' &&
      event.method === 'POST' &&
      event.requestBody?.includes('create_media_buy')
  );
}

describe('transport diagnostics public-client E2E', () => {
  it('emits sanitized MCP transport events through ADCPMultiAgentClient', async () => {
    const calls = [];
    const events = [];
    const fixture = await startMcpFixture({
      mediaBuy: {
        createMediaBuy: async params => {
          calls.push(params);
          return { media_buy_id: `mb_transport_mcp_${calls.length}`, packages: [] };
        },
      },
    });

    try {
      const client = createClient(
        {
          id: 'mcp-agent',
          name: 'MCP Agent',
          agent_uri: fixture.url,
          protocol: 'mcp',
          auth_token: 'mcp-auth-token-secret',
          headers: {
            'x-api-key': 'mcp-api-key-secret',
            'x-scope3-debug-id': 'debug-mcp-e2e',
          },
        },
        events
      );

      const result = await client.agent('mcp-agent').createMediaBuy(createMediaBuyParams);
      assert.equal(result.success, true, result.error);
      assert.equal(result.status, 'completed');
      const secondResult = await client.agent('mcp-agent').createMediaBuy(createMediaBuyParams);
      assert.equal(secondResult.success, true, secondResult.error);
      assert.equal(result.data.media_buy_id, 'mb_transport_mcp_1');
      assert.equal(secondResult.data.media_buy_id, 'mb_transport_mcp_2');
      assert.equal(calls.length, 2);

      const started = findToolEvent(events, 'request_started', 'mcp');
      const received = findToolEvent(events, 'response_received', 'mcp');
      assert.ok(started, `missing MCP request_started event: ${JSON.stringify(events, null, 2)}`);
      assert.ok(received, `missing MCP response_received event: ${JSON.stringify(events, null, 2)}`);
      assert.equal(started.agentId, 'mcp-agent');
      assert.equal(typeof started.operationId, 'string');
      assert.equal(typeof started.taskId, 'string');
      assert.equal(typeof started.idempotencyKeyHash, 'string');
      assert.notEqual(started.idempotencyKeyHash, result.metadata.idempotency_key);
      assert.equal(started.requestHeaders.authorization, '[redacted]');
      assert.equal(started.requestHeaders['x-adcp-auth'], '[redacted]');
      assert.equal(started.requestHeaders['x-api-key'], '[redacted]');
      assert.equal(started.requestHeaders['x-scope3-debug-id'], 'debug-mcp-e2e');
      assert.equal(received.httpStatus, 200);
      const toolStarts = toolEvents(events, 'request_started', 'mcp');
      assert.equal(toolStarts.length, 2, `expected two MCP create_media_buy request events`);
      assert.notEqual(toolStarts[0].operationId, toolStarts[1].operationId);
      assert.notEqual(toolStarts[0].taskId, toolStarts[1].taskId);
      assert.notEqual(toolStarts[0].idempotencyKeyHash, toolStarts[1].idempotencyKeyHash);
      assertNoSecretLeak(events, [
        'mcp-auth-token-secret',
        'mcp-api-key-secret',
        'webhook-secret-minimum-32-characters',
        'webhook-url-secret',
        result.metadata.idempotency_key,
        secondResult.metadata.idempotency_key,
      ]);
    } finally {
      await closeMCPConnections();
      await fixture.close();
    }
  });

  it('emits sanitized A2A transport events through ADCPMultiAgentClient', async () => {
    const calls = [];
    const events = [];
    const fixture = await startA2aFixture({
      mediaBuy: {
        createMediaBuy: async params => {
          calls.push(params);
          return { media_buy_id: `mb_transport_a2a_${calls.length}`, packages: [] };
        },
      },
    });

    try {
      const client = createClient(
        {
          id: 'a2a-agent',
          name: 'A2A Agent',
          agent_uri: fixture.url,
          protocol: 'a2a',
          auth_token: 'a2a-auth-token-secret',
          headers: {
            'x-api-key': 'a2a-api-key-secret',
            'x-scope3-debug-id': 'debug-a2a-e2e',
          },
        },
        events
      );

      const result = await client.agent('a2a-agent').createMediaBuy(createMediaBuyParams);
      assert.equal(result.success, true, result.error);
      assert.equal(result.status, 'completed');
      const secondResult = await client.agent('a2a-agent').createMediaBuy(createMediaBuyParams);
      assert.equal(secondResult.success, true, secondResult.error);
      assert.equal(result.data.media_buy_id, 'mb_transport_a2a_1');
      assert.equal(secondResult.data.media_buy_id, 'mb_transport_a2a_2');
      assert.equal(calls.length, 2);

      const started = findToolEvent(events, 'request_started', 'a2a');
      const received = findToolEvent(events, 'response_received', 'a2a');
      assert.ok(started, `missing A2A request_started event: ${JSON.stringify(events, null, 2)}`);
      assert.ok(received, `missing A2A response_received event: ${JSON.stringify(events, null, 2)}`);
      assert.equal(started.agentId, 'a2a-agent');
      assert.equal(typeof started.operationId, 'string');
      assert.equal(typeof started.taskId, 'string');
      assert.equal(typeof started.idempotencyKeyHash, 'string');
      assert.notEqual(started.idempotencyKeyHash, result.metadata.idempotency_key);
      assert.equal(started.requestHeaders.authorization, '[redacted]');
      assert.equal(started.requestHeaders['x-adcp-auth'], '[redacted]');
      assert.equal(started.requestHeaders['x-api-key'], '[redacted]');
      assert.equal(started.requestHeaders['x-scope3-debug-id'], 'debug-a2a-e2e');
      assert.equal(received.httpStatus, 200);
      const toolStarts = toolEvents(events, 'request_started', 'a2a');
      assert.equal(toolStarts.length, 2, `expected two A2A create_media_buy request events`);
      assert.notEqual(toolStarts[0].operationId, toolStarts[1].operationId);
      assert.notEqual(toolStarts[0].taskId, toolStarts[1].taskId);
      assert.notEqual(toolStarts[0].idempotencyKeyHash, toolStarts[1].idempotencyKeyHash);
      assertNoSecretLeak(events, [
        'a2a-auth-token-secret',
        'a2a-api-key-secret',
        'webhook-secret-minimum-32-characters',
        'webhook-url-secret',
        result.metadata.idempotency_key,
        secondResult.metadata.idempotency_key,
      ]);
    } finally {
      await closeConnections('a2a');
      await fixture.close();
    }
  });
});
