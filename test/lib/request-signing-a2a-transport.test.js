const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { resolveVectorTransport } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');
const {
  buildAdcpA2aInvocation,
  loadA2aEnvelopeCodec,
  buildPositiveRequest,
  A2A_WIRE_VERSION,
} = require('../../dist/lib/testing/storyboard/request-signing/builder.js');
const {
  resolveA2aInterface,
  loadRequestSigningVectors,
} = require('../../dist/lib/testing/storyboard/request-signing/index.js');

// ── transport resolution ────────────────────────────────────────────────────

test('an A2A run frames its vectors as A2A, not as MCP', () => {
  assert.strictEqual(resolveVectorTransport({}, 'a2a'), 'a2a');
  assert.strictEqual(resolveVectorTransport({}, 'mcp'), 'mcp');
  assert.strictEqual(resolveVectorTransport({}), 'mcp');
});

test('an explicit transport still wins over the run protocol', () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'raw' }, 'a2a'), 'raw');
  assert.strictEqual(resolveVectorTransport({ transport: 'mcp' }, 'a2a'), 'mcp');
});

// ── the invocation shape follows the declared version ───────────────────────

test('the payload key follows the declared protocol version', () => {
  assert.deepStrictEqual(buildAdcpA2aInvocation('create_media_buy', { a: 1 }, '1.0'), {
    skill: 'create_media_buy',
    input: { a: 1 },
  });
  assert.deepStrictEqual(buildAdcpA2aInvocation('create_media_buy', { a: 1 }, '0.3'), {
    skill: 'create_media_buy',
    parameters: { a: 1 },
  });
});

// ── the envelope is proto JSON, serialized by the SDK ───────────────────────

test('the SendMessage envelope is proto JSON and carries the version header', async () => {
  await loadA2aEnvelopeCodec();
  const { positive } = loadRequestSigningVectors();
  const vector = positive.find(v => v.id.includes('001'));
  assert.ok(vector, 'positive/001 should exist');

  const signed = buildPositiveRequest(vector, loadRequestSigningVectors().keys, {
    transport: 'a2a',
    baseUrl: 'https://agent.example/rpc',
    mcpJsonRpcId: 'fixed-id',
  });

  assert.strictEqual(signed.url, 'https://agent.example/rpc', 'posts to the card-named endpoint verbatim');
  assert.strictEqual(signed.headers['A2A-Version'], A2A_WIRE_VERSION);

  const body = JSON.parse(signed.body);
  assert.strictEqual(body.method, 'SendMessage');
  assert.strictEqual(body.id, 'fixed-id');
  // `Role.ROLE_USER` is the numeric 1 in the generated enum; the wire form is
  // the string. A plain JSON.stringify of the request object would emit 1.
  assert.strictEqual(body.params.message.role, 'ROLE_USER');
  const part = body.params.message.parts[0];
  assert.ok('input' in part.data, 'a 1.0 envelope carries `input`, not `parameters`');
  assert.strictEqual(part.data.skill, 'create_media_buy');
});

test('the A2A transport refuses to invent an endpoint', () => {
  const { positive, keys } = loadRequestSigningVectors();
  const vector = positive.find(v => v.id.includes('001'));
  assert.throws(() => buildPositiveRequest(vector, keys, { transport: 'a2a' }), /requires a baseUrl/);
});

// ── the endpoint comes off the card ─────────────────────────────────────────

function cardServer(card) {
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json' && card) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(card));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('the RPC endpoint is read from the card, at any mount', async () => {
  const server = await cardServer({
    supportedInterfaces: [
      { url: 'https://elsewhere.example:9443/rpc/v1/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
  });
  const { port } = server.address();
  try {
    const iface = await resolveA2aInterface(`http://127.0.0.1:${port}`, { allowPrivateIp: true });
    // Scheme, host, port AND path all come from the card — none is derived
    // from the agent URL the run was given.
    assert.strictEqual(iface.url, 'https://elsewhere.example:9443/rpc/v1/a2a');
    assert.strictEqual(iface.protocolVersion, '1.0');
  } finally {
    server.close();
  }
});

test('a card naming no JSONRPC interface fails instead of guessing a mount', async () => {
  const server = await cardServer({
    supportedInterfaces: [{ url: 'https://agent.example/grpc', protocolBinding: 'GRPC' }],
  });
  const { port } = server.address();
  try {
    await assert.rejects(
      () => resolveA2aInterface(`http://127.0.0.1:${port}`, { allowPrivateIp: true }),
      /no supportedInterfaces entry with protocolBinding JSONRPC/
    );
  } finally {
    server.close();
  }
});
