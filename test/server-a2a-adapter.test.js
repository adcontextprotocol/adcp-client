const { describe, it } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { adcpError } = require('../dist/lib/server/errors');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');

// Opt out of strict response validation for sparse handler fixtures —
// same rationale as server-create-adcp-server.test.js.
function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    stateStore: config?.stateStore ?? new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

function baseCard(overrides) {
  return {
    name: 'Test Agent',
    description: 'Test agent',
    url: 'https://example.com/a2a',
    version: '1.0.0',
    provider: { organization: 'Test Co', url: 'https://example.com' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    ...overrides,
  };
}

function randomUuid() {
  return (
    '00000000-0000-0000-0000-' +
    Math.floor(Math.random() * 1e12)
      .toString()
      .padStart(12, '0')
  );
}

function dataPartMessage(skill, input) {
  return {
    kind: 'message',
    messageId: randomUuid(),
    role: 'user',
    parts: [{ kind: 'data', data: { skill, input } }],
  };
}

async function postJsonRpc(app, body, headers = {}) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

async function getAgentCard(app) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

function messageSend(message) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: { message },
  };
}

function taskGet(taskId) {
  return { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: taskId } };
}

function taskCancel(taskId) {
  return { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: taskId } };
}

function mountAdapter(a2a) {
  const app = express();
  app.use(express.json());
  app.use('/.well-known/agent-card.json', a2a.agentCardHandler);
  app.use('/', a2a.jsonRpcHandler);
  return app;
}

describe('createA2AAdapter', () => {
  describe('agent card', () => {
    it('exposes seller identity fields and auto-seeds skills from registered tools', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
        signals: { getSignals: async () => ({ signals: [] }) },
      });
      const a2a = createA2AAdapter({ server: adcp, agentCard: baseCard() });
      const app = mountAdapter(a2a);
      const res = await getAgentCard(app);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.name, 'Test Agent');
      assert.strictEqual(res.body.url, 'https://example.com/a2a');
      assert.ok(Array.isArray(res.body.skills));
      const skillIds = res.body.skills.map(s => s.id);
      assert.ok(skillIds.includes('get_products'), 'get_products skill derived');
      assert.ok(skillIds.includes('get_signals'), 'get_signals skill derived');
      assert.ok(!skillIds.includes('get_adcp_capabilities'), 'capabilities tool excluded from skills');
      assert.ok(res.body.capabilities, 'capabilities block present');
      assert.strictEqual(res.body.capabilities.streaming, false);
      assert.strictEqual(res.body.capabilities.pushNotifications, false);
      assert.deepStrictEqual(res.body.provider, { organization: 'Test Co', url: 'https://example.com' });
    });

    it('allows seller to override skills entirely', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard({
          skills: [{ id: 'custom', name: 'Custom', description: 'hand-written', tags: ['enriched'] }],
        }),
      });
      const card = await a2a.getAgentCard();
      assert.strictEqual(card.skills.length, 1);
      assert.strictEqual(card.skills[0].id, 'custom');
    });

    it('fails loud at boot when agent card is missing required fields', () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      assert.throws(
        () =>
          createA2AAdapter({
            server: adcp,
            agentCard: { name: 'Missing URL', description: 'nope', version: '1.0.0' },
          }),
        /missing required fields/i
      );
    });

    it('fails loud when no tools are registered and no skills override supplied', () => {
      const adcp = createAdcpServer({});
      assert.throws(() => createA2AAdapter({ server: adcp, agentCard: baseCard() }), /no skills/i);
    });
  });

  describe('mount() helper', () => {
    async function jsonRpcAt(app, path, body) {
      const server = app.listen(0);
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      } finally {
        server.close();
      }
    }

    async function cardAt(app, path) {
      const server = app.listen(0);
      try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: res.status, body: res.status === 200 ? await res.json() : null };
      } finally {
        server.close();
      }
    }

    it('derives basePath from agent-card URL pathname and mounts all four routes', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [{ product_id: 'p1' }] }) },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard({ url: 'https://example.com/a2a' }),
      });
      const app = express();
      app.use(express.json());
      a2a.mount(app);

      // Agent card at both locations
      const atBase = await cardAt(app, '/a2a/.well-known/agent-card.json');
      assert.strictEqual(atBase.status, 200);
      assert.strictEqual(atBase.body.name, 'Test Agent');
      const atRoot = await cardAt(app, '/.well-known/agent-card.json');
      assert.strictEqual(atRoot.status, 200);
      assert.strictEqual(atRoot.body.name, 'Test Agent');

      // JSON-RPC at the derived basePath
      const rpc = await jsonRpcAt(app, '/a2a', messageSend(dataPartMessage('get_products', { brief: 'ctv' })));
      assert.strictEqual(rpc.status, 200);
      assert.strictEqual(rpc.body.result?.status?.state, 'completed');
    });

    it('wellKnownAtRoot: false omits origin-root mount', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard({ url: 'https://example.com/a2a' }),
      });
      const app = express();
      app.use(express.json());
      a2a.mount(app, { wellKnownAtRoot: false });

      const atBase = await cardAt(app, '/a2a/.well-known/agent-card.json');
      assert.strictEqual(atBase.status, 200, 'base-path card still mounted');
      const atRoot = await cardAt(app, '/.well-known/agent-card.json');
      assert.strictEqual(atRoot.status, 404, 'origin-root mount suppressed');
    });

    it('accepts explicit basePath override', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard({ url: 'https://example.com/a2a' }),
      });
      const app = express();
      app.use(express.json());
      a2a.mount(app, { basePath: '/agents/foo' });

      const card = await cardAt(app, '/agents/foo/.well-known/agent-card.json');
      assert.strictEqual(card.status, 200);
      const missed = await cardAt(app, '/a2a/.well-known/agent-card.json');
      assert.strictEqual(missed.status, 404, 'default basePath not used when overridden');
    });

    it('falls back to /a2a when agent-card URL has no pathname', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard({ url: 'https://example.com' }), // no path
      });
      const app = express();
      app.use(express.json());
      a2a.mount(app);

      const card = await cardAt(app, '/a2a/.well-known/agent-card.json');
      assert.strictEqual(card.status, 200, 'fallback basePath is /a2a');
    });
  });

  describe('message/send routing', () => {
    it('Success arm → Task.state=completed + DataPart artifact', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [{ product_id: 'p1' }] }) },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'premium' })));
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.result, 'JSON-RPC success result');
      assert.strictEqual(res.body.result.kind, 'task');
      assert.strictEqual(res.body.result.status.state, 'completed');
      const artifacts = res.body.result.artifacts ?? [];
      assert.strictEqual(artifacts.length, 1);
      const dataPart = artifacts[0].parts.find(p => p.kind === 'data');
      assert.ok(dataPart, 'artifact carries DataPart');
      assert.deepStrictEqual(dataPart.data.products, [{ product_id: 'p1' }]);
    });

    it('Submitted AdCP arm → A2A state=completed; adcp_task_id on artifact.metadata', async () => {
      const adcp = createAdcpServer({
        mediaBuy: {
          createMediaBuy: async () => ({
            status: 'submitted',
            task_id: 'tk_async_1',
            message: 'Queued for IO signature',
          }),
        },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(
        app,
        messageSend(
          dataPartMessage('create_media_buy', {
            account: { account_id: 'a1' },
            brand: { brand_id: 'b1' },
            start_time: '2026-01-01T00:00:00Z',
            end_time: '2026-02-01T00:00:00Z',
          })
        )
      );
      // A2A Task.state tracks the transport call — completed means the HTTP
      // call finished; the AdCP-level async state lives inside the artifact.
      assert.strictEqual(res.body.result.status.state, 'completed');
      const artifact = res.body.result.artifacts[0];
      assert.strictEqual(
        artifact.metadata?.adcp_task_id,
        'tk_async_1',
        'AdCP task_id lives on artifact.metadata (A2A extension convention), not in DataPart data'
      );
      const dataPart = artifact.parts[0];
      assert.strictEqual(dataPart.data.status, 'submitted', 'AdCP response preserved in DataPart');
      assert.strictEqual(dataPart.data.task_id, 'tk_async_1', 'AdCP task_id also on the wire payload per spec');
      // A2A task id is the SDK-generated one, not the AdCP task_id.
      assert.notStrictEqual(res.body.result.id, 'tk_async_1');
      // Transport metadata must NOT leak into DataPart data — that shape
      // is the AdCP tool's typed response and needs to validate cleanly.
      assert.strictEqual(dataPart.data.adcp_task_id, undefined, 'transport metadata stays out of AdCP payload');
    });

    it('Error arm → Task.state=failed with errors[] preserved on artifact', async () => {
      const adcp = createAdcpServer({
        mediaBuy: {
          createMediaBuy: async () => ({
            errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'gone' }],
          }),
        },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(
        app,
        messageSend(
          dataPartMessage('create_media_buy', {
            account: { account_id: 'a1' },
            brand: { brand_id: 'b1' },
            start_time: '2026-01-01T00:00:00Z',
            end_time: '2026-02-01T00:00:00Z',
          })
        )
      );
      assert.strictEqual(res.body.result.status.state, 'failed');
      const dataPart = res.body.result.artifacts[0].parts[0];
      assert.ok(Array.isArray(dataPart.data.errors));
      assert.strictEqual(dataPart.data.errors[0].code, 'PRODUCT_NOT_FOUND');
    });

    it('adcpError envelope → Task.state=failed with adcp_error on artifact', async () => {
      const adcp = createAdcpServer({
        mediaBuy: {
          getProducts: async () => adcpError('RATE_LIMITED', { message: 'slow down', retry_after: 30 }),
        },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'x' })));
      assert.strictEqual(res.body.result.status.state, 'failed');
      const dataPart = res.body.result.artifacts[0].parts[0];
      assert.ok(dataPart.data.adcp_error, 'adcp_error present on artifact');
      assert.strictEqual(dataPart.data.adcp_error.code, 'RATE_LIMITED');
    });

    it('handler returning { isError: true } without adcp_error routes as error_arm', async () => {
      // Classifier coverage: a hand-rolled error envelope (isError: true +
      // structuredContent that doesn't carry adcp_error or a spec errors[])
      // must still surface as Task.state='failed' and preserve whatever
      // structuredContent the handler shipped — no silent Success-path wrap.
      const adcp = createAdcpServer({
        mediaBuy: {
          getProducts: async () => ({
            content: [{ type: 'text', text: 'custom failure' }],
            isError: true,
            structuredContent: { reason: 'custom', detail: 'hand-rolled' },
          }),
        },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'x' })));
      assert.strictEqual(res.body.result.status.state, 'failed');
      const dataPart = res.body.result.artifacts[0].parts[0];
      assert.strictEqual(dataPart.data.reason, 'custom', 'hand-rolled structuredContent preserved');
      assert.strictEqual(dataPart.data.detail, 'hand-rolled');
    });

    it('accepts { skill, parameters } as an alias for { skill, input }', async () => {
      // Backward-compat: the in-tree A2A client at src/lib/protocols/a2a.ts
      // shipped first and uses `parameters`. The adapter tolerates both so
      // same-SDK send/receive works end-to-end.
      let sawBrief;
      const adcp = createAdcpServer({
        mediaBuy: {
          getProducts: async params => {
            sawBrief = params.brief;
            return { products: [] };
          },
        },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: randomUuid(),
            role: 'user',
            parts: [{ kind: 'data', data: { skill: 'get_products', parameters: { brief: 'premium' } } }],
          },
        },
      });
      assert.strictEqual(res.body.result.status.state, 'completed');
      assert.strictEqual(sawBrief, 'premium', 'parameters alias threaded into handler args');
    });

    it('DataPart with null data surfaces as failed with INVALID_INVOCATION (not uncaught TypeError)', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(
        app,
        messageSend({
          kind: 'message',
          messageId: randomUuid(),
          role: 'user',
          parts: [{ kind: 'data', data: null }],
        })
      );
      assert.strictEqual(res.body.result.status.state, 'failed');
      const dataPart = res.body.result.artifacts[0].parts[0];
      assert.strictEqual(dataPart.data.reason, 'INVALID_INVOCATION', 'null data guard fires before destructure');
    });

    it('invalid DataPart (missing skill) surfaces as failed with INVALID_INVOCATION', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const res = await postJsonRpc(
        app,
        messageSend({
          kind: 'message',
          messageId: randomUuid(),
          role: 'user',
          parts: [{ kind: 'data', data: { not_a_skill: true } }],
        })
      );
      assert.strictEqual(res.body.result.status.state, 'failed');
      const dataPart = res.body.result.artifacts[0].parts[0];
      assert.strictEqual(dataPart.data.reason, 'INVALID_INVOCATION');
    });
  });

  describe('tasks/get polling', () => {
    it('returns the completed Task for a prior message/send result', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [{ product_id: 'p1' }] }) },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const send = await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'x' })));
      const taskId = send.body.result.id;
      const get = await postJsonRpc(app, taskGet(taskId));
      assert.strictEqual(get.body.result.id, taskId);
      assert.strictEqual(get.body.result.status.state, 'completed');
    });
  });

  describe('tasks/cancel', () => {
    it('returns TaskNotCancelable when task already completed', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const send = await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'x' })));
      const taskId = send.body.result.id;
      assert.strictEqual(send.body.result.status.state, 'completed', 'task completed synchronously');
      const cancel = await postJsonRpc(app, taskCancel(taskId));
      assert.ok(cancel.body.error, 'cancel on completed task returns a JSON-RPC error');
      const err = cancel.body.error;
      // A2A's TaskNotCancelable spec code is -32002; accept the spec code
      // OR a message mentioning cancellation, since the exact surface
      // depends on the SDK version.
      assert.ok(
        err.code === -32002 || /cancel/i.test(err.message ?? ''),
        `expected TaskNotCancelable-shaped error, got ${JSON.stringify(err)}`
      );
    });

    it('returns an error when canceling an unknown task id', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const cancel = await postJsonRpc(app, taskCancel('00000000-0000-0000-0000-000000000000'));
      assert.ok(cancel.body.error, 'unknown task cancel returns a JSON-RPC error');
    });
  });

  describe('authenticate', () => {
    it('rejects when authenticate returns null', async () => {
      const adcp = createAdcpServer({
        mediaBuy: { getProducts: async () => ({ products: [] }) },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard(),
        async authenticate() {
          return null;
        },
      });
      const app = mountAdapter(a2a);
      const res = await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'x' })));
      // Rejection surfaces as a JSON-RPC error (SDK wraps the thrown Error as -32000).
      assert.ok(res.body.error, 'rejection yields JSON-RPC error envelope');
    });

    it('propagates authInfo into ctx.authInfo', async () => {
      let sawAuth;
      const adcp = createAdcpServer({
        mediaBuy: {
          getProducts: async (_params, ctx) => {
            sawAuth = ctx.authInfo;
            return { products: [] };
          },
        },
      });
      const a2a = createA2AAdapter({
        server: adcp,
        agentCard: baseCard(),
        async authenticate() {
          return { token: 'abc', clientId: 'buyer_1', scopes: ['read'] };
        },
      });
      const app = mountAdapter(a2a);
      await postJsonRpc(app, messageSend(dataPartMessage('get_products', { brief: 'x' })));
      assert.ok(sawAuth, 'authInfo threaded into handler');
      assert.strictEqual(sawAuth.clientId, 'buyer_1');
      assert.deepStrictEqual(sawAuth.scopes, ['read']);
    });
  });

  describe('idempotency replay across A2A transport', () => {
    it('replays a cached response on duplicate idempotency_key', async () => {
      let calls = 0;
      const adcp = createAdcpServer({
        idempotency: createIdempotencyStore({ backend: memoryBackend() }),
        // Idempotency needs a principal-scoping resolver; tenant_a is an
        // arbitrary test value (real deployments scope by authInfo).
        resolveSessionKey: () => 'tenant_a',
        mediaBuy: {
          createMediaBuy: async () => {
            calls += 1;
            return { media_buy_id: `mb_${calls}`, packages: [] };
          },
        },
      });
      const app = mountAdapter(createA2AAdapter({ server: adcp, agentCard: baseCard() }));
      const key = '11111111-1111-1111-1111-111111111111';
      const payload = {
        account: { account_id: 'a1' },
        brand: { brand_id: 'b1' },
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-02-01T00:00:00Z',
        idempotency_key: key,
      };
      const first = await postJsonRpc(app, messageSend(dataPartMessage('create_media_buy', payload)));
      const second = await postJsonRpc(app, messageSend(dataPartMessage('create_media_buy', payload)));
      assert.strictEqual(calls, 1, 'handler ran exactly once');
      const firstId = first.body.result.artifacts[0].parts[0].data.media_buy_id;
      const secondId = second.body.result.artifacts[0].parts[0].data.media_buy_id;
      assert.strictEqual(firstId, secondId, 'replay returns identical media_buy_id');
    });
  });
});
