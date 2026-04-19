const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { ProtocolClient } = require('../dist/lib/protocols/index.js');
const { closeMCPConnections } = require('../dist/lib/protocols/mcp.js');
const { defaultCapabilityCache, buildAgentSigningContext } = require('../dist/lib/signing/client.js');

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
 * Minimal MCP-speaking stub. Records the raw headers from each inbound
 * tool-call request so tests can assert whether Signature-Input / Signature /
 * Content-Digest headers are present. The server's advertised capability is
 * mutable so tests can exercise the "seller rotates required_for mid-session"
 * case. Every inbound POST is tagged with the tool name the handler observes
 * by closing `entry` over the per-request MCP server instance.
 */
async function startMcpStub(initialCapability) {
  const state = {
    capability: initialCapability,
    toolCallHeaders: [],
  };

  const createServer = entry => {
    const mcp = new McpServer({ name: 'signing-stub', version: '1.0.0' });

    mcp.tool('get_adcp_capabilities', {}, async () => {
      entry.toolName = 'get_adcp_capabilities';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              adcp: { major_versions: [3] },
              supported_protocols: ['media_buy'],
              request_signing: state.capability,
            }),
          },
        ],
      };
    });

    const echoAs = name => async () => {
      entry.toolName = name;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    };

    mcp.tool('create_media_buy', {}, echoAs('create_media_buy'));
    mcp.tool('another_op', {}, echoAs('another_op'));
    mcp.tool('unsigned_op', {}, echoAs('unsigned_op'));

    return mcp;
  };

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || (req.url !== '/mcp' && req.url !== '/mcp/')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const entry = { headers: { ...req.headers }, toolName: undefined };
    state.toolCallHeaders.push(entry);

    const mcp = createServer(entry);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    state,
    stop: () => {
      // MCP clients hold a persistent connection; close it forcibly so
      // httpServer.close() doesn't wait for the keep-alive to drain.
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      return new Promise(resolve => httpServer.close(() => resolve()));
    },
  };
}

function agentFor(url) {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    agent_uri: url,
    protocol: 'mcp',
    request_signing: {
      kid: 'test-ed25519-2026',
      alg: 'ed25519',
      private_key: privateJwk,
      agent_url: 'https://buyer.example/.well-known/adcp-jwks.json',
    },
  };
}

async function resetGlobalState() {
  await closeMCPConnections();
  defaultCapabilityCache.clear();
}

async function cleanup(stub) {
  await closeMCPConnections();
  await stub.stop();
}

test('priming: unsigned get_adcp_capabilities succeeds when required_for does not cover it', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    const result = await ProtocolClient.callTool(agentFor(stub.url), 'get_adcp_capabilities', {});
    assert.ok(result, 'capabilities call returned a response');

    const capsCalls = stub.state.toolCallHeaders.filter(r => r.toolName === 'get_adcp_capabilities');
    assert.ok(capsCalls.length >= 1, 'at least one get_adcp_capabilities tools/call hit the stub');
    for (const call of capsCalls) {
      assert.strictEqual(
        call.headers['signature-input'],
        undefined,
        'get_adcp_capabilities must be sent unsigned — it is the discovery op'
      );
    }
  } finally {
    await cleanup(stub);
  }
});

test('create_media_buy in required_for gets signed with Signature-Input / Signature / Content-Digest', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'required',
    required_for: ['create_media_buy'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'create_media_buy', { plan_id: 'plan_001' });
    const cmbCalls = stub.state.toolCallHeaders.filter(r => r.toolName === 'create_media_buy');
    assert.strictEqual(cmbCalls.length, 1, 'one create_media_buy tools/call hit the stub');
    const headers = cmbCalls[0].headers;
    assert.match(headers['signature-input'] || '', /^sig1=/, 'Signature-Input is present with sig1 label');
    assert.match(headers['signature'] || '', /^sig1=:/, 'Signature header is present with sig1 label');
    assert.ok(headers['content-digest'], 'Content-Digest header is present (covers_content_digest: required)');
    assert.match(headers['content-digest'], /sha-256=/, 'Content-Digest is sha-256');
  } finally {
    await cleanup(stub);
  }
});

test('ops outside required_for / supported_for / always_sign pass through unsigned', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'unsigned_op', {});
    const calls = stub.state.toolCallHeaders.filter(r => r.toolName === 'unsigned_op');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].headers['signature-input'], undefined);
  } finally {
    await cleanup(stub);
  }
});

test('covers_content_digest: forbidden → signer omits content-digest coverage', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'forbidden',
    required_for: ['create_media_buy'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'create_media_buy', { plan_id: 'plan_001' });
    const cmb = stub.state.toolCallHeaders.filter(r => r.toolName === 'create_media_buy')[0];
    assert.ok(cmb.headers['signature-input'], 'request is still signed');
    assert.strictEqual(
      cmb.headers['content-digest'],
      undefined,
      "Content-Digest MUST NOT be attached when seller policy is 'forbidden'"
    );
    // And the Signature-Input MUST NOT list content-digest as a covered component.
    assert.doesNotMatch(
      cmb.headers['signature-input'],
      /"content-digest"/,
      'Signature-Input does not cover content-digest'
    );
  } finally {
    await cleanup(stub);
  }
});

test('capability rotation: seller adds op to required_for → cache refresh picks it up', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    const agent = agentFor(stub.url);

    // First call: another_op is NOT in required_for → unsigned.
    await ProtocolClient.callTool(agent, 'another_op', {});
    let call = stub.state.toolCallHeaders.filter(r => r.toolName === 'another_op')[0];
    assert.strictEqual(call.headers['signature-input'], undefined, 'another_op sent unsigned initially');

    // Seller rotates capability.
    stub.state.capability = {
      supported: true,
      covers_content_digest: 'either',
      required_for: ['create_media_buy', 'another_op'],
    };
    // Simulate the cache TTL expiry / explicit invalidation that would
    // force a re-fetch on the next outbound call. The context derives its
    // own cache key from the agent's signing identity — using it guarantees
    // the test invalidates the exact entry the transport reads from.
    const signingContext = buildAgentSigningContext(agent);
    defaultCapabilityCache.invalidate(signingContext.capabilityCacheKey);

    // Second call: capability re-fetched, another_op now in required_for → signed.
    await ProtocolClient.callTool(agent, 'another_op', {});
    const newerCall = stub.state.toolCallHeaders.filter(r => r.toolName === 'another_op').slice(-1)[0];
    assert.ok(
      newerCall.headers['signature-input'],
      'another_op is signed after capability rotation + cache invalidation'
    );
  } finally {
    await cleanup(stub);
  }
});

test('always_sign override forces signing even when seller has not listed the op', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    const agent = agentFor(stub.url);
    agent.request_signing.always_sign = ['another_op'];
    await ProtocolClient.callTool(agent, 'another_op', {});
    const call = stub.state.toolCallHeaders.filter(r => r.toolName === 'another_op')[0];
    assert.ok(call.headers['signature-input'], 'always_sign forces signing');
  } finally {
    await cleanup(stub);
  }
});

test('warn_for: shadow-mode op is signed so the seller can surface failure rates', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: [],
    warn_for: ['another_op'],
  });
  try {
    await ProtocolClient.callTool(agentFor(stub.url), 'another_op', {});
    const call = stub.state.toolCallHeaders.filter(r => r.toolName === 'another_op')[0];
    assert.ok(call.headers['signature-input'], 'warn_for ops SHOULD be signed so sellers get shadow-mode telemetry');
  } finally {
    await cleanup(stub);
  }
});

test('customHeaders signing-reserved keys are stripped before signing', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    const agent = agentFor(stub.url);
    // Malicious or misconfigured caller tries to pre-set Signature-Input +
    // Content-Digest. The signer must overwrite both — a silent pass-through
    // would break verification at the seller.
    agent.headers = {
      'signature-input': 'sig1=("@method");created=0;expires=0;keyid="attacker";alg="ed25519"',
      'content-digest': 'sha-256=:AAAA:',
      'x-benign-header': 'yes',
    };
    await ProtocolClient.callTool(agent, 'create_media_buy', {});
    const call = stub.state.toolCallHeaders.filter(r => r.toolName === 'create_media_buy')[0];
    assert.match(call.headers['signature-input'], /keyid="test-ed25519-2026"/, 'signer produced the Signature-Input');
    assert.doesNotMatch(
      call.headers['signature-input'],
      /keyid="attacker"/,
      'attacker-supplied Signature-Input was overwritten'
    );
    assert.match(
      call.headers['content-digest'],
      /sha-256=:[^A]/,
      'signer recomputed Content-Digest from the real body'
    );
    assert.strictEqual(call.headers['x-benign-header'], 'yes', 'non-reserved customHeaders still pass through');
  } finally {
    await cleanup(stub);
  }
});

test('concurrent cold-cache calls share a single get_adcp_capabilities fetch', async () => {
  await resetGlobalState();
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  try {
    const agent = agentFor(stub.url);
    // Fire three concurrent create_media_buy calls against a cold cache.
    // The priming dedupe in capability-priming.ts must collapse them to
    // exactly one get_adcp_capabilities fetch — otherwise a seller with
    // low quota for discovery could be hammered every time a caller
    // fans out.
    await Promise.all([
      ProtocolClient.callTool(agent, 'create_media_buy', {}),
      ProtocolClient.callTool(agent, 'create_media_buy', {}),
      ProtocolClient.callTool(agent, 'create_media_buy', {}),
    ]);
    const primingCalls = stub.state.toolCallHeaders.filter(r => r.toolName === 'get_adcp_capabilities');
    assert.strictEqual(primingCalls.length, 1, 'priming dedupe folded 3 cold-cache calls into 1 discovery call');
  } finally {
    await cleanup(stub);
  }
});

test('priming failure → fail-open: next call proceeds unsigned, always_sign still forces signing', async () => {
  await resetGlobalState();
  // Stand up a stub that rejects get_adcp_capabilities with a 500-equivalent
  // error. create_media_buy still succeeds. The client should NOT wedge —
  // it should cache a negative entry and let the call proceed.
  const stub = await startMcpStub({
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  });
  // Monkey-patch the capability to throw.
  Object.defineProperty(stub.state, 'capability', {
    get() {
      throw new Error('simulated discovery outage');
    },
  });
  try {
    const agent = agentFor(stub.url);
    agent.request_signing.always_sign = ['create_media_buy'];
    // Fail-open: the call must not throw on priming failure, and always_sign
    // ops still get signed with sensible content-digest defaults.
    await ProtocolClient.callTool(agent, 'create_media_buy', {});
    const call = stub.state.toolCallHeaders.filter(r => r.toolName === 'create_media_buy')[0];
    assert.ok(call.headers['signature-input'], 'always_sign forces signing even when seller discovery failed');
  } finally {
    await cleanup(stub);
  }
});

test('ensureCapabilityLoaded: network-level fetch rejection → 60s negative cache', async () => {
  await resetGlobalState();
  const { ensureCapabilityLoaded } = require('../dist/lib/signing/client.js');
  // Synthesize an agent + signing context without a live server so we can
  // drive ensureCapabilityLoaded with a rejecting fetchRaw directly — the
  // integration test above only exercises the error-response path (tool
  // handler throws → CallToolResult.isError). This test covers the
  // transport-level rejection that maps to .catch in capability-priming.ts.
  const agent = agentFor('http://127.0.0.1:0/mcp');
  const signingContext = buildAgentSigningContext(agent);
  const before = Math.floor(Date.now() / 1000);
  const entry = await ensureCapabilityLoaded(agent, signingContext, async () => {
    throw new Error('ECONNREFUSED');
  });
  const after = Math.floor(Date.now() / 1000);
  assert.strictEqual(entry.requestSigning, undefined, 'failed priming caches an empty capability');
  assert.ok(entry.staleAt !== undefined, 'failed priming sets an explicit staleAt');
  const window = entry.staleAt - entry.fetchedAt;
  assert.strictEqual(window, 60, 'negative-cache window is 60s (shorter than the 300s positive TTL)');
  assert.ok(entry.fetchedAt >= before && entry.fetchedAt <= after, 'fetchedAt is "now"');
});

test('teardown: close pooled MCP connections', async () => {
  await resetGlobalState();
});
