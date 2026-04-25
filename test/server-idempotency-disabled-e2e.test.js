/**
 * Wire-level e2e for `idempotency: 'disabled'` mode.
 *
 * The unit tests in `server-idempotency.test.js` exercise the dispatcher
 * via `dispatchTestRequest()`. This test starts a real HTTP server, talks
 * to it with the official `@modelcontextprotocol/sdk` Client over
 * `StreamableHTTPClientTransport`, and also exercises the A2A path via
 * `createA2AAdapter`. The goal is to confirm disabled mode behaves the
 * same way over real wire as it does in-process — including capability
 * advertisement, missing-key tolerance, and the shape gate.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Disabled-mode requires NODE_ENV in {'test', 'development'} or an explicit
// ack env var. The test runner doesn't set NODE_ENV by default, so pin it
// for this whole file and restore on teardown.
let _prevNodeEnv;
before(() => {
  _prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
});
after(() => {
  if (_prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = _prevNodeEnv;
});

const lib = require('../dist/lib/index.js');
const { serve, createAdcpServer: _createAdcpServer } = lib;
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

function makeFactory({ calls, validation } = {}) {
  return () =>
    _createAdcpServer({
      name: 'Disabled E2E',
      version: '1.0.0',
      idempotency: 'disabled',
      stateStore: new InMemoryStateStore(),
      resolveSessionKey: () => 'tenant_e2e',
      validation: validation ?? { requests: 'strict', responses: 'off' },
      mediaBuy: {
        createMediaBuy: async params => {
          calls?.push(params);
          return { media_buy_id: `mb_${calls?.length ?? 1}`, packages: [] };
        },
      },
    });
}

const basePayload = {
  account: { brand: { domain: 'acme.example' }, operator: 'op.example' },
  brand: { domain: 'acme.example' },
  start_time: '2026-05-01T00:00:00Z',
  end_time: '2026-05-31T23:59:59Z',
  packages: [{ product_id: 'p1', budget: 5000, pricing_option_id: 'po1' }],
};

describe('idempotency: disabled — MCP wire roundtrip', () => {
  it('get_adcp_capabilities advertises {supported: false, no replay_ttl_seconds} over real HTTP', async () => {
    const httpServer = serve(makeFactory(), { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: 'Buyer', version: '1.0.0' });
      await client.connect(transport);

      const result = await client.callTool({ name: 'get_adcp_capabilities', arguments: {} });
      const caps = result.structuredContent;
      assert.equal(caps.adcp.idempotency.supported, false);
      assert.equal(
        caps.adcp.idempotency.replay_ttl_seconds,
        undefined,
        'replay_ttl_seconds MUST be absent on the IdempotencyUnsupported branch'
      );
      await client.close();
    } finally {
      httpServer.close();
    }
  });

  it('create_media_buy without idempotency_key succeeds over real HTTP (strict request validation enabled)', async () => {
    const calls = [];
    const httpServer = serve(makeFactory({ calls }), { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: 'Buyer', version: '1.0.0' });
      await client.connect(transport);

      const result = await client.callTool({ name: 'create_media_buy', arguments: basePayload });
      const body = result.structuredContent;
      assert.equal(body.adcp_error, undefined, `expected success, got error: ${JSON.stringify(body.adcp_error)}`);
      assert.equal(calls.length, 1, 'handler ran once');
      assert.equal(body.media_buy_id, 'mb_1');
      await client.close();
    } finally {
      httpServer.close();
    }
  });

  it('rejects malformed idempotency_key over real HTTP — schema layer (strict validation)', async () => {
    // With strict request validation (the dev/test default), the AJV
    // pattern check on the spec's `^[A-Za-z0-9_.:-]{16,255}$` fires first
    // and returns VALIDATION_ERROR. The schema-filter only drops
    // `keyword === 'required', pointer === '/idempotency_key'`, so a
    // pattern failure passes through correctly.
    const calls = [];
    const httpServer = serve(makeFactory({ calls }), { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: 'Buyer', version: '1.0.0' });
      await client.connect(transport);

      const result = await client.callTool({
        name: 'create_media_buy',
        arguments: { ...basePayload, idempotency_key: 'too short' },
      });
      const body = result.structuredContent;
      assert.equal(body.adcp_error?.code, 'VALIDATION_ERROR');
      const issues = body.adcp_error?.issues ?? body.adcp_error?.details?.issues ?? [];
      assert.ok(
        issues.some(i => i.pointer === '/idempotency_key' && i.keyword === 'pattern'),
        `expected a pattern issue on /idempotency_key, got: ${JSON.stringify(issues)}`
      );
      assert.equal(calls.length, 0, 'malformed key must not reach the handler');
      await client.close();
    } finally {
      httpServer.close();
    }
  });

  it('rejects malformed idempotency_key over real HTTP — shape gate (validation off)', async () => {
    // Production-like setup: validation off (the default under
    // NODE_ENV=production). The schema layer doesn't run, so the
    // dispatcher's shape gate is the last line of defense. It must reject
    // a malformed key with INVALID_REQUEST before the handler runs.
    const calls = [];
    const httpServer = serve(makeFactory({ calls, validation: { requests: 'off', responses: 'off' } }), {
      port: 0,
      onListening: () => {},
    });
    await waitForListening(httpServer);
    const port = httpServer.address().port;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: 'Buyer', version: '1.0.0' });
      await client.connect(transport);

      const result = await client.callTool({
        name: 'create_media_buy',
        arguments: { ...basePayload, idempotency_key: 'too short' },
      });
      const body = result.structuredContent;
      assert.equal(body.adcp_error?.code, 'INVALID_REQUEST');
      assert.equal(body.adcp_error?.field, 'idempotency_key');
      assert.equal(calls.length, 0, 'shape gate must reject before the handler');
      await client.close();
    } finally {
      httpServer.close();
    }
  });
});

describe('idempotency: disabled — A2A wire roundtrip', () => {
  function mountAdapter(a2a) {
    const app = express();
    app.use(express.json());
    app.use('/.well-known/agent-card.json', a2a.agentCardHandler);
    app.use('/', a2a.jsonRpcHandler);
    return app;
  }

  function dataPartMessage(skill, input) {
    return {
      kind: 'message',
      messageId: '00000000-0000-0000-0000-' + String(Date.now()).padStart(12, '0'),
      role: 'user',
      parts: [{ kind: 'data', data: { skill, input } }],
    };
  }

  async function jsonRpcCall(app, body) {
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it('A2A: create_media_buy succeeds without idempotency_key under strict validation', async () => {
    const calls = [];
    const adcp = makeFactory({ calls })();
    const a2a = createA2AAdapter({
      server: adcp,
      agentCard: {
        name: 'Test',
        description: 'd',
        url: 'https://example.com/a2a',
        version: '1.0.0',
        provider: { organization: 'X', url: 'https://example.com' },
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      },
    });
    const app = mountAdapter(a2a);
    const res = await jsonRpcCall(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: dataPartMessage('create_media_buy', basePayload) },
    });
    assert.equal(res.status, 200);
    // A2A wraps the response in an artifact — pull the first DataPart out.
    const result = res.body.result;
    const artifact = result?.artifacts?.[0] ?? result?.parts;
    const dataPart = (artifact?.parts ?? artifact)?.find?.(p => p.kind === 'data');
    const payload = dataPart?.data;
    assert.ok(payload, `expected DataPart payload, got: ${JSON.stringify(res.body)}`);
    assert.equal(
      payload.adcp_error,
      undefined,
      `A2A roundtrip should accept missing idempotency_key in disabled mode, got: ${JSON.stringify(payload.adcp_error)}`
    );
    assert.equal(calls.length, 1);
  });
});
