const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const { ADCPMultiAgentClient } = require('../dist/lib/index.js');
const { AuthenticationRequiredError } = require('../dist/lib/errors');
const { closeConnections } = require('../dist/lib/protocols/index.js');
const { defaultCapabilityCache } = require('../dist/lib/signing/client.js');

const keys = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', 'compliance', 'cache', 'latest', 'test-vectors', 'request-signing', 'keys.json'),
    'utf8'
  )
).keys;
const ed = keys.find(k => k.kid === 'test-ed25519-2026');
const privateJwk = { ...ed, d: ed._private_d_for_test_only };
delete privateJwk._private_d_for_test_only;
delete privateJwk.key_ops;
delete privateJwk.use;

const CHALLENGE = 'Signature error="request_signature_key_unknown", realm="seller.example"';
const capability = { supported: true, required_for: ['create_media_buy'] };
const capabilitiesPayload = {
  adcp: { major_versions: [3] },
  supported_protocols: ['media_buy'],
  request_signing: capability,
};

const mediaBuyRequest = () => ({
  account: { account_id: 'acct' },
  brand: { domain: 'acme.example' },
  start_time: 'asap',
  end_time: '2027-01-01T00:00:00Z',
  packages: [],
  idempotency_key: `signed-401-${Date.now()}-abcdefabcdef`,
});

function reject(res) {
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': CHALLENGE });
  res.end(JSON.stringify({ error: 'Seller could not discover the signing key' }));
}

/** MCP stub that 401s every request carrying a `signature` header. */
async function startMcpStub() {
  const server = http.createServer(async (req, res) => {
    if (req.headers.signature) {
      for await (const [] of req) {
        /* Drain the rejected request. */
      }
      return reject(res);
    }
    const mcp = new McpServer({ name: 'signing-stub', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: JSON.stringify(capabilitiesPayload) }],
    }));
    mcp.registerTool('create_media_buy', { inputSchema: { x: z.any().optional() } }, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });
  return listen(server, '/mcp');
}

/** A2A stub that 401s every JSON-RPC request carrying a `signature` header. */
async function startA2aStub() {
  const server = http.createServer(async (req, res) => {
    const { port } = server.address();
    if (req.method === 'GET' && req.url.startsWith('/.well-known/')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          protocolVersion: '0.3.0',
          name: 'signing-a2a-stub',
          description: 'A2A stub for auth error class tests',
          url: `http://127.0.0.1:${port}/rpc`,
          preferredTransport: 'JSONRPC',
          version: '1.0.0',
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          capabilities: { streaming: false, pushNotifications: false },
          skills: ['get_adcp_capabilities', 'create_media_buy'].map(id => ({
            id,
            name: id,
            description: 'AdCP op',
            tags: ['adcp'],
          })),
        })
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.headers.signature) return reject(res);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: {
          id: `task_${Date.now()}`,
          contextId: `ctx_${Date.now()}`,
          kind: 'task',
          status: { state: 'completed', timestamp: new Date().toISOString() },
          history: [parsed.params.message],
          artifacts: [{ artifactId: 'artifact-1', parts: [{ kind: 'data', data: capabilitiesPayload }] }],
        },
      })
    );
  });
  return listen(server, '');
}

async function listen(server, suffix) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${suffix}`,
    stop: () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

const stubs = { mcp: startMcpStub, a2a: startA2aStub };

async function withAgent(protocol, requestSigning, fn) {
  await closeConnections(protocol);
  defaultCapabilityCache.clear();
  const stub = await stubs[protocol]();
  try {
    const client = new ADCPMultiAgentClient([
      {
        id: 'signed-agent',
        name: 'Signed agent',
        agent_uri: stub.url,
        protocol,
        request_signing: {
          kid: 'test-ed25519-2026',
          alg: 'ed25519',
          private_key: privateJwk,
          agent_url: 'https://buyer.example.com',
          ...requestSigning,
        },
      },
    ]);
    await fn(client.agent('signed-agent'));
  } finally {
    await closeConnections(protocol);
    await stub.stop();
  }
}

function assertSignedAuthError(error) {
  assert.ok(
    error instanceof AuthenticationRequiredError,
    `expected AuthenticationRequiredError, got ${error?.constructor?.name}`
  );
  assert.strictEqual(error.requestSigned, true);
  assert.strictEqual(error.status, 401);
  assert.strictEqual(error.signatureErrorCode, 'request_signature_key_unknown');
  assert.strictEqual(error.challenge?.scheme, 'signature');
  assert.ok(error.stack, 'keeps a stack');

  assert.match(error.responseBody, /could not discover the signing key/);
  assert.strictEqual(Object.getOwnPropertyDescriptor(error, 'responseBody').enumerable, false);
  assert.doesNotMatch(JSON.stringify(error), /could not discover the signing key/);

  const diagnostics = error.authDiagnostics;
  assert.strictEqual(diagnostics.status, 401);
  assert.strictEqual(diagnostics.requestSignature.noncePresent, true);
  assert.match(diagnostics.adcpVersion, /^\d+\.\d+/);
  assert.strictEqual(diagnostics.wwwAuthenticate.realm, 'seller.example');
  assert.strictEqual(Object.getOwnPropertyDescriptor(diagnostics.wwwAuthenticate, 'realm').enumerable, false);
}

for (const protocol of ['mcp', 'a2a']) {
  test(`${protocol.toUpperCase()}: signed create_media_buy 401 keeps AuthenticationRequiredError on the failed result`, async () => {
    await withAgent(protocol, {}, async agent => {
      const result = await agent.createMediaBuy(mediaBuyRequest());
      assert.strictEqual(result.success, false);
      assertSignedAuthError(result.errorInstance);
    });
  });

  test(`${protocol.toUpperCase()}: signed get_adcp_capabilities 401 carries the same typed error`, async () => {
    // always_sign signs the capabilities call itself (discovery fails open first).
    await withAgent(protocol, { always_sign: ['get_adcp_capabilities'] }, async agent => {
      let error;
      try {
        const result = await agent.getAdcpCapabilities({});
        assert.strictEqual(result.success, false, 'a refused capabilities call must not succeed');
        error = result.errorInstance;
      } catch (thrown) {
        error = thrown;
      }
      assertSignedAuthError(error);
    });
  });
}
