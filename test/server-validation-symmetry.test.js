// Cross-transport validation symmetry (#909). Sends the same malformed
// create_media_buy over MCP and A2A against one AdcpServer; asserts the
// framework's AJV validator produces the same adcp_error envelope on
// both transports — same code, same JSON-pointer issue list, same
// recovery classification. Locks the fix against regression.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Client: McpClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { getSdkServer } = require('../dist/lib/server/adcp-server');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');

function randomUuid() {
  const bytes = require('node:crypto').randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildDualTransportApp() {
  const adcp = createAdcpServer({
    name: 'Test',
    version: '0.1.0',
    idempotency: createIdempotencyStore({ backend: memoryBackend() }),
    resolveSessionKey: () => 'tenant_test',
    mediaBuy: {
      createMediaBuy: async () => ({ media_buy_id: 'mb_ok', packages: [] }),
    },
  });
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: {
      name: 'Symmetry',
      description: 'MCP+A2A validation symmetry',
      url: 'http://127.0.0.1/a2a',
      version: '0.1.0',
    },
  });
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const sdk = getSdkServer(adcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await sdk.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await sdk.close().catch(() => {});
    }
  });
  a2a.mount(app);
  return app;
}

async function mcpCall(baseUrl, toolName, args) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new McpClient({ name: 'sym', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

async function a2aCall(baseUrl, skill, input) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: randomUuid(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill, input } }],
      },
    },
  };
  const res = await fetch(`${baseUrl}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function mcpAdcpError(callToolResult) {
  return callToolResult?.structuredContent?.adcp_error;
}

function a2aAdcpError(jsonRpcResponse) {
  return jsonRpcResponse?.result?.artifacts?.[0]?.parts?.[0]?.data?.adcp_error;
}

describe('cross-transport validation symmetry (#909)', () => {
  it('malformed create_media_buy produces identical adcp_error shape on MCP and A2A', async () => {
    const app = buildDualTransportApp();
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const badArgs = {
        account: { account_id: 'a1' },
        brand: { brand_id: 'acme' }, // invalid: should be `domain`
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-05-31T23:59:59Z',
        packages: [{ product_id: 'p1', budget: { amount: 100, currency: 'USD' } }], // budget must be number, missing pricing_option_id
        idempotency_key: '11111111-1111-1111-1111-111111111111',
      };

      const mcpRes = await mcpCall(baseUrl, 'create_media_buy', badArgs);
      const a2aRes = await a2aCall(baseUrl, 'create_media_buy', badArgs);

      const mcpErr = mcpAdcpError(mcpRes);
      const a2aErr = a2aAdcpError(a2aRes);

      assert.ok(mcpErr, 'MCP must carry structured adcp_error (not raw -32602)');
      assert.ok(a2aErr, 'A2A must carry structured adcp_error');

      assert.strictEqual(mcpErr.code, 'VALIDATION_ERROR');
      assert.strictEqual(a2aErr.code, 'VALIDATION_ERROR');
      assert.strictEqual(mcpErr.code, a2aErr.code, 'error codes must match');

      assert.strictEqual(mcpErr.recovery, a2aErr.recovery, 'recovery classification must match');

      // JSON pointers identify which fields failed — same bad payload,
      // same pointers. Sort to compare irrespective of emission order.
      const mcpPointers = (mcpErr.issues ?? []).map(i => i.pointer).sort();
      const a2aPointers = (a2aErr.issues ?? []).map(i => i.pointer).sort();
      assert.deepStrictEqual(
        mcpPointers,
        a2aPointers,
        `pointers must match across transports: MCP=${JSON.stringify(mcpPointers)} A2A=${JSON.stringify(a2aPointers)}`
      );
      assert.ok(mcpPointers.length > 0, 'at least one validation issue expected');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('malformed request is rejected BEFORE reaching the handler on both transports', async () => {
    let handlerRan = false;
    const adcp = createAdcpServer({
      name: 'Test',
      version: '0.1.0',
      idempotency: createIdempotencyStore({ backend: memoryBackend() }),
      resolveSessionKey: () => 'tenant',
      mediaBuy: {
        createMediaBuy: async () => {
          handlerRan = true;
          return { media_buy_id: 'should-not-happen', packages: [] };
        },
      },
    });
    const a2a = createA2AAdapter({
      server: adcp,
      agentCard: { name: 'T', description: 't', url: 'http://127.0.0.1/a2a', version: '0.1.0' },
    });
    const app = express();
    app.use(express.json());
    app.post('/mcp', async (req, res) => {
      const sdk = getSdkServer(adcp);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await sdk.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        await sdk.close().catch(() => {});
      }
    });
    a2a.mount(app);
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Missing EVERYTHING except idempotency_key.
      const badArgs = { idempotency_key: '22222222-2222-2222-2222-222222222222' };

      await mcpCall(baseUrl, 'create_media_buy', badArgs);
      assert.strictEqual(handlerRan, false, 'MCP path must reject before handler');

      await a2aCall(baseUrl, 'create_media_buy', badArgs);
      assert.strictEqual(handlerRan, false, 'A2A path must reject before handler');
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});
