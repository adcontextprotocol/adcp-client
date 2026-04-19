const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { ProtocolClient } = require('../dist/lib/protocols/index.js');
const { closeConnections } = require('../dist/lib/protocols/index.js');
const { defaultCapabilityCache } = require('../dist/lib/signing/client.js');

const KEYS_PATH = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);

const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
const ed = keys.find(k => k.kid === 'test-ed25519-2026');
const privateJwk = { ...ed, d: ed._private_d_for_test_only };
delete privateJwk._private_d_for_test_only;
delete privateJwk.key_ops;
delete privateJwk.use;

/**
 * Minimal A2A-speaking stub. Implements two endpoints:
 *
 * - GET `/.well-known/agent.json` — returns an AgentCard whose `url` points
 *   back at `/rpc` on the same host, so the A2A client sends JSON-RPC
 *   `message/send` calls there.
 * - POST `/rpc` — accepts JSON-RPC; for `message/send` it pulls the first
 *   data-kind part (which is where AdCP puts `{skill, parameters}`) and
 *   synthesizes a completed Task result whose artifact echoes JSON payload.
 *
 * Every inbound JSON-RPC request is recorded alongside the skill the
 * handler observed, so tests can assert whether the Signature-Input /
 * Signature / Content-Digest headers were present per skill.
 */
async function startA2aStub(initialCapability) {
  const state = {
    capability: initialCapability,
    rpcCalls: [],
  };

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
      const { port } = httpServer.address();
      const card = {
        protocolVersion: '0.3.0',
        name: 'signing-a2a-stub',
        description: 'A2A stub for request-signing integration tests',
        url: `http://127.0.0.1:${port}/rpc`,
        preferredTransport: 'JSONRPC',
        version: '1.0.0',
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        capabilities: { streaming: false, pushNotifications: false },
        skills: [
          {
            id: 'get_adcp_capabilities',
            name: 'get_adcp_capabilities',
            description: 'AdCP capability discovery',
            tags: ['adcp'],
          },
          { id: 'create_media_buy', name: 'create_media_buy', description: 'AdCP op', tags: ['adcp'] },
          { id: 'another_op', name: 'another_op', description: 'AdCP op', tags: ['adcp'] },
        ],
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(card));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);
    let parsed;
    try {
      parsed = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      res.statusCode = 400;
      res.end('bad json');
      return;
    }

    const skill =
      parsed?.params?.message?.parts?.find(p => p?.kind === 'data' && typeof p?.data?.skill === 'string')?.data
        ?.skill ?? '<unknown>';

    state.rpcCalls.push({ headers: { ...req.headers }, skill, method: parsed.method });

    const resultPayload =
      skill === 'get_adcp_capabilities'
        ? {
            adcp: { major_versions: [3] },
            supported_protocols: ['media_buy'],
            request_signing: state.capability,
          }
        : { ok: true };

    const response = {
      jsonrpc: '2.0',
      id: parsed.id,
      result: {
        id: `task_${Date.now()}`,
        contextId: `ctx_${Date.now()}`,
        kind: 'task',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        history: [parsed.params.message],
        artifacts: [
          {
            artifactId: 'artifact-1',
            parts: [{ kind: 'data', data: resultPayload }],
          },
        ],
      },
    };

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  return {
    url: `http://127.0.0.1:${addr.port}`,
    state,
    stop: () => {
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      return new Promise(resolve => httpServer.close(() => resolve()));
    },
  };
}

function agentFor(url) {
  return {
    id: 'test-agent-a2a',
    name: 'Test A2A Agent',
    agent_uri: url,
    protocol: 'a2a',
    request_signing: {
      kid: 'test-ed25519-2026',
      alg: 'ed25519',
      private_key: privateJwk,
      agent_url: 'https://buyer.example.com',
    },
  };
}

async function resetGlobalState() {
  await closeConnections('a2a');
  defaultCapabilityCache.clear();
}

async function cleanup(stub) {
  await closeConnections('a2a');
  await stub.stop();
}

test('A2A: priming get_adcp_capabilities is sent unsigned', async () => {
  await resetGlobalState();
  const stub = await startA2aStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'get_adcp_capabilities', {});
    const caps = stub.state.rpcCalls.filter(r => r.skill === 'get_adcp_capabilities');
    assert.ok(caps.length >= 1, 'at least one get_adcp_capabilities hit the stub');
    for (const call of caps) {
      assert.strictEqual(call.headers['signature-input'], undefined, 'discovery is never signed on A2A');
    }
  } finally {
    await cleanup(stub);
  }
});

test('A2A: create_media_buy in required_for gets signed — skill extracted from message/send body', async () => {
  await resetGlobalState();
  const stub = await startA2aStub({
    supported: true,
    covers_content_digest: 'required',
    required_for: ['create_media_buy'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'create_media_buy', { plan_id: 'plan_a2a_001' });
    const cmb = stub.state.rpcCalls.filter(r => r.skill === 'create_media_buy');
    assert.strictEqual(cmb.length, 1, 'one create_media_buy reached the stub');
    const headers = cmb[0].headers;
    assert.match(headers['signature-input'] || '', /^sig1=/, 'Signature-Input present on A2A signed call');
    assert.match(headers['signature'] || '', /^sig1=:/, 'Signature present with sig1 label');
    assert.match(
      headers['content-digest'] || '',
      /sha-256=/,
      'Content-Digest present (covers_content_digest: required)'
    );
    assert.match(
      headers['signature-input'],
      /"content-digest"/,
      'Signature-Input lists content-digest as covered component'
    );
  } finally {
    await cleanup(stub);
  }
});

test('A2A: ops outside the seller advertisement pass through unsigned', async () => {
  await resetGlobalState();
  const stub = await startA2aStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'another_op', {});
    const call = stub.state.rpcCalls.filter(r => r.skill === 'another_op')[0];
    assert.ok(call, 'another_op reached the stub');
    assert.strictEqual(call.headers['signature-input'], undefined, 'another_op unsigned on A2A');
  } finally {
    await cleanup(stub);
  }
});

test('A2A: teardown', async () => {
  await resetGlobalState();
});
