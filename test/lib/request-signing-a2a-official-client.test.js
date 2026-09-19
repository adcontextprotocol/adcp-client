/**
 * A2A request-signing dispatch goes through the OFFICIAL `@a2a-js/sdk` client.
 *
 * The point of these tests is not that "an A2A request is produced" — it is
 * that every protocol decision in that request was made by the SDK rather than
 * by this repo. adcp-client#2964 was closed because it hand-built the envelope;
 * the objection was fair, and these assertions are what make it no longer
 * apply.
 *
 * Each test serves a real agent card over loopback HTTP and lets the SDK's own
 * `ClientFactory` resolve it. Nothing about the endpoint, the JSON-RPC method
 * name, the version header or the proto-JSON encoding is written down by the
 * caller, so a test that passes is evidence the SDK decided all four.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  captureA2aRequest,
  operationFromVectorUrl,
} = require('../../dist/lib/testing/storyboard/request-signing/a2a-dispatch.js');

/** Serve an agent card declaring one JSONRPC interface at *protocolVersion*. */
async function withCardServer(protocolVersion, run) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/.well-known/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        protocolVersion,
        name: 'conformance-fixture-agent',
        description: 'card fixture',
        version: '1.0.0',
        capabilities: {},
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        securityRequirements: [],
        supportedInterfaces: [
          {
            url: `http://127.0.0.1:${port}/the-card-named-this-path`,
            protocolBinding: 'JSONRPC',
            protocolVersion,
            tenant: '',
          },
        ],
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('the endpoint comes from the agent card, not from the URL we were given', async () => {
  const captured = await withCardServer('1.0', base =>
    captureA2aRequest(base, { kind: 'sendMessage', operation: 'get_products', args: { brief: 'x' } })
  );

  // The caller passed the card's base URL; the request went to the path the
  // card named. A dispatcher that derived the endpoint would have posted to
  // the base, or to an assumed `/a2a`.
  assert.match(captured.url, /\/the-card-named-this-path$/);
  assert.strictEqual(captured.method, 'POST');
});

test('the SDK proto-JSON encodes the message; the enum never reaches the wire as a number', async () => {
  const captured = await withCardServer('1.0', base =>
    captureA2aRequest(base, { kind: 'sendMessage', operation: 'get_products', args: { brief: 'x' } })
  );
  const body = JSON.parse(captured.body);

  // `Role.ROLE_USER` is `1` in the generated TypeScript enum and `"ROLE_USER"`
  // on the wire. A hand-rolled `JSON.stringify` of the request object emits
  // `"role":1`, which is the class of encoding bug that makes hand-built
  // envelopes unsafe to grade against.
  assert.strictEqual(body.params.message.role, 'ROLE_USER');
  assert.deepStrictEqual(body.params.message.parts[0].data, {
    skill: 'get_products',
    input: { brief: 'x' },
  });
});

test('the JSON-RPC method and version header follow the card, for both protocol families', async () => {
  const modern = await withCardServer('1.0', base => captureA2aRequest(base, { kind: 'cancelTask', taskId: 't1' }));
  const legacy = await withCardServer('0.3.0', base => captureA2aRequest(base, { kind: 'cancelTask', taskId: 't1' }));

  // One call, two wires, chosen by the card alone. `tasks/cancel` is the
  // method AdCP's `protocol_methods_*` namespace names (security.mdx @ 3.1.1
  // :1045 cites "A2A 0.3.0 §7.x"), and the official client emits it natively
  // for a 0.3 agent — no envelope is framed here to produce it.
  assert.strictEqual(JSON.parse(modern.body).method, 'CancelTask');
  assert.strictEqual(JSON.parse(legacy.body).method, 'tasks/cancel');

  assert.strictEqual(modern.headers['a2a-version'], '1.0');
  assert.strictEqual(legacy.headers['a2a-version'], '0.3');
});

test('the version header is present at capture time, so signing covers it', async () => {
  const captured = await withCardServer('1.0', base =>
    captureA2aRequest(base, { kind: 'sendMessage', operation: 'get_products', args: {} })
  );

  // Capture happens before signing. A verifier rebuilds the signature base
  // from the headers it received, so a version header added after the
  // signature was computed would sit outside that base and fail every vector
  // for a reason unrelated to the agent's verifier.
  assert.ok(
    Object.prototype.hasOwnProperty.call(captured.headers, 'a2a-version'),
    `expected a2a-version among captured headers, got ${JSON.stringify(captured.headers)}`
  );
});

test('the operation is read off the vector URL, identically to the MCP path', () => {
  assert.strictEqual(operationFromVectorUrl('https://seller.example.com/adcp/create_media_buy'), 'create_media_buy');
  assert.throws(() => operationFromVectorUrl('https://seller.example.com/adcp/Not-An-Operation'), /operation name/i);
});

const { resolveA2aDispatchTarget } = require('../../dist/lib/testing/storyboard/request-signing/a2a-dispatch.js');

test('a resolvable card makes A2A dispatch available, and names the endpoint it resolved', async () => {
  const target = await withCardServer('1.0', base => resolveA2aDispatchTarget(base));
  assert.match(target.endpoint, /\/the-card-named-this-path$/);
});

test('an agent with no resolvable card leaves A2A dispatch unavailable, rather than framing a guess', async () => {
  // Nothing is listening here. This is the fallback #2958 built for, and it
  // stays reachable: the gate reports unavailable instead of inventing an
  // endpoint from the agent URL.
  await assert.rejects(() => resolveA2aDispatchTarget('http://127.0.0.1:1/'), /.*/);
});
