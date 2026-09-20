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
const { probeRequestSigningVector } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');

async function closeServer(server) {
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

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
    await closeServer(server);
  }
}

/** Serve the genuine A2A v0.3 card shape (no supportedInterfaces array). */
async function withLegacyCardServer(run) {
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/.well-known/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: 'legacy-conformance-fixture-agent',
        description: 'legacy card fixture',
        url: `http://127.0.0.1:${port}/legacy-a2a`,
        version: '1.0.0',
        capabilities: {},
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        preferredTransport: 'JSONRPC',
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await closeServer(server);
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

test('a storyboard probe reports the card-selected endpoint as its provenance', async () => {
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (req.url.startsWith('/.well-known/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'provenance-fixture-agent',
          description: 'card fixture',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          supportedInterfaces: [
            {
              url: `http://127.0.0.1:${port}/card-selected-rpc`,
              protocolBinding: 'JSONRPC',
              protocolVersion: '1.0',
            },
          ],
        })
      );
      return;
    }
    for await (const _chunk of req) {
      // Drain the signed request before replying.
    }
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Signature error="request_signature_required"',
    });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await probeRequestSigningVector('negative-001-no-signature-header', base, {
      protocol: 'a2a',
      allow_http: true,
    });
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.url, `${base}/card-selected-rpc`);
  } finally {
    await closeServer(server);
  }
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

test('a genuine v0.3 card resolves and uses the legacy AdCP invocation shape', async () => {
  const cancel = await withLegacyCardServer(base =>
    captureA2aRequest(base, { kind: 'cancelTask', taskId: 'legacy-task' })
  );
  assert.strictEqual(JSON.parse(cancel.body).method, 'tasks/cancel');
  assert.strictEqual(cancel.headers['a2a-version'], '0.3');

  const send = await withLegacyCardServer(base =>
    captureA2aRequest(base, { kind: 'sendMessage', operation: 'get_products', args: { brief: 'x' } })
  );
  assert.deepStrictEqual(JSON.parse(send.body).params.message.parts[0].data, {
    skill: 'get_products',
    parameters: { brief: 'x' },
  });
});

test('modern SendMessage activates the AdCP extension like the production buyer path', async () => {
  const captured = await withCardServer('1.0', base =>
    captureA2aRequest(base, { kind: 'sendMessage', operation: 'get_products', args: {} })
  );
  const body = JSON.parse(captured.body);
  assert.deepStrictEqual(body.params.message.extensions, ['https://adcontextprotocol.org/extensions/adcp/v3']);
  assert.strictEqual(captured.headers['a2a-extensions'], 'https://adcontextprotocol.org/extensions/adcp/v3');
});

test('path-scoped agent URLs discover a card beneath the full configured path', async () => {
  const requested = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    if (req.url !== '/tenant-a/a2a/.well-known/agent-card.json') {
      res.writeHead(404);
      res.end();
      return;
    }
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        protocolVersion: '1.0',
        name: 'path-scoped-agent',
        description: 'card fixture',
        version: '1.0.0',
        capabilities: {},
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        securityRequirements: [],
        supportedInterfaces: [
          {
            url: `http://127.0.0.1:${port}/tenant-a/rpc`,
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
            tenant: '',
          },
        ],
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/tenant-a/a2a`;
    const target = await resolveA2aDispatchTarget(base);
    assert.match(target.endpoint, /\/tenant-a\/rpc$/);
    assert.strictEqual(requested[0], '/tenant-a/a2a/.well-known/agent-card.json');
  } finally {
    server.close();
  }
});

test('the legacy-compat policy defers to the card, and turning it off would not', async () => {
  // adcp-client#2973 asked whether `legacyCompat: true` means "also accept
  // 0.3" or "speak 0.3". It is the former, and this test is the measurement
  // that settles it — the dispatch emits 1.0 framing for a 1.0 card while that
  // policy is in force, so the policy is not a downgrade.
  const modern = await withCardServer('1.0', base => captureA2aRequest(base, { kind: 'cancelTask', taskId: 't1' }));
  assert.strictEqual(JSON.parse(modern.body).method, 'CancelTask');
  assert.strictEqual(modern.headers['a2a-version'], '1.0');

  // And the converse, which is why the policy must not be flipped or exposed
  // as a knob: with it OFF, a card declaring 0.3 is answered in 1.0 framing.
  // The SDK does not refuse the card, it silently speaks a dialect the agent
  // never advertised — a verdict about an agent that does not exist.
  const { ClientFactory, JsonRpcTransportFactory } = await import('@a2a-js/sdk/client');
  const downgradeBlind = await withCardServer('0.3.0', async base => {
    let sent;
    const capture = async (input, init) => {
      const req = new Request(input, init);
      sent = { method: JSON.parse(await req.text()).method, version: req.headers.get('a2a-version') };
      throw new Error('captured');
    };
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: capture, legacyCompat: { enabled: false } })],
    });
    const client = await factory.createFromUrl(base);
    await client.cancelTask({ tenant: '', id: 't1', metadata: undefined }).catch(() => {});
    return sent;
  });
  assert.strictEqual(downgradeBlind.method, 'CancelTask', 'legacyCompat off ignores a 0.3 card');
  assert.strictEqual(downgradeBlind.version, '1.0');

  // The dispatch under test keeps the card-following policy: same 0.3 card,
  // the spec-named `tasks/*` method.
  const legacy = await withCardServer('0.3.0', base => captureA2aRequest(base, { kind: 'cancelTask', taskId: 't1' }));
  assert.strictEqual(JSON.parse(legacy.body).method, 'tasks/cancel');
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

test('agent-card discovery honors its timeout even when an injected fetch ignores abort', async () => {
  const neverSettles = () => new Promise(() => {});
  await assert.rejects(
    () =>
      captureA2aRequest(
        'https://hung-card.example',
        { kind: 'sendMessage', operation: 'get_products', args: {} },
        { cardFetch: neverSettles, timeoutMs: 10 }
      ),
    /timed out after 10 ms/i
  );
});

test('production agent-card discovery rejects always-blocked metadata addresses', async () => {
  await assert.rejects(() => resolveA2aDispatchTarget('http://169.254.169.254/'), /always-blocked address/i);
});

const {
  buildPositiveRequest,
  buildNegativeRequest,
} = require('../../dist/lib/testing/storyboard/request-signing/builder.js');
const { loadRequestSigningVectors } = require('../../dist/lib/testing/storyboard/request-signing/vector-loader.js');

test('a header the fixture and the client both set goes on the wire ONCE', () => {
  const loaded = loadRequestSigningVectors({});
  // A fixture carrying `Content-Type` capitalised, against a client emitting
  // `content-type` lowercase. A case-sensitive merge keeps both, the request
  // carries the header twice, and a conformant verifier refuses it at
  // checklist step 1 — before anything the vector grades is reached.
  const vector = loaded.positive.find(v => Object.keys(v.request.headers || {}).some(h => /^content-type$/i.test(h)));
  assert.ok(vector, 'expected a positive vector whose fixture sets Content-Type');

  const signed = buildPositiveRequest(vector, loaded.keys, {
    baseUrl: 'https://agent.example.com',
    transport: 'a2a',
    a2aRequest: {
      url: 'https://agent.example.com/a2a',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: '{"jsonrpc":"2.0","method":"SendMessage","params":{},"id":1}',
    },
  });

  const contentTypeNames = Object.keys(signed.headers).filter(h => /^content-type$/i.test(h));
  assert.deepStrictEqual(
    contentTypeNames.length,
    1,
    `Content-Type must appear once; got ${JSON.stringify(contentTypeNames)}`
  );
  assert.strictEqual(signed.headers[contentTypeNames[0]], 'application/json');
});

test("a header the FIXTURE deliberately malforms survives the transport's clean one", () => {
  const loaded = loadRequestSigningVectors({});
  // Guards the MERGE ORDER, and must fail if it is flipped. The transport is
  // handed a `content-type` that differs from the fixture's, so whichever side
  // wins is visible in the result: under the correct order the fixture's value
  // survives, under the buggy one the transport's replaces it.
  //
  // This is why order matters at all. Vector 022 presents a deliberately
  // multi-valued Content-Type and THAT HEADER IS THE FAULT UNDER TEST; a
  // transport that overwrites it makes the agent answer about some other defect
  // and the vector grades nothing.
  const vector = loaded.positive.find(v => Object.keys(v.request.headers || {}).some(h => /^content-type$/i.test(h)));
  assert.ok(vector, 'expected a positive vector whose fixture sets Content-Type');
  const [, fixtureValue] = Object.entries(vector.request.headers).find(([h]) => /^content-type$/i.test(h));

  const built = buildPositiveRequest(vector, loaded.keys, {
    baseUrl: 'https://agent.example.com',
    transport: 'a2a',
    a2aRequest: {
      url: 'https://agent.example.com/a2a',
      method: 'POST',
      // Deliberately NOT what the fixture says, and not a value any fixture
      // uses, so the assertion below can only pass one way.
      headers: {
        'content-type': 'application/vnd.transport-must-not-win',
        'a2a-version': '1.0',
        accept: 'application/json',
      },
      body: '{}',
    },
  });

  const names = Object.keys(built.headers).filter(h => /^content-type$/i.test(h));
  assert.strictEqual(names.length, 1, `Content-Type must appear once; got ${JSON.stringify(names)}`);
  assert.strictEqual(
    built.headers[names[0]],
    fixtureValue,
    "the fixture's Content-Type must survive: it is the fault under test, and the transport only fills gaps"
  );

  // ...while the transport still supplies what the fixture does not set.
  assert.strictEqual(built.headers['a2a-version'], '1.0');
  assert.strictEqual(built.headers['accept'], 'application/json');
});

test('the protocol-method vector uses the captured A2A endpoint, headers, and body', () => {
  const loaded = loadRequestSigningVectors({});
  const vector = loaded.negative.find(v => v.id === '028-unsigned-protocol-method-required');
  assert.ok(vector, 'expected vector 028');
  const capturedBody = '{"id":1,"jsonrpc":"2.0","method":"tasks/cancel","params":{"id":"official"}}';
  const built = buildNegativeRequest(vector, loaded.keys, {
    baseUrl: 'https://agent.example/card-base',
    transport: 'a2a',
    a2aRequest: {
      url: 'https://agent.example/card-selected-rpc',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '0.3' },
      body: capturedBody,
    },
  });
  assert.strictEqual(built.url, 'https://agent.example/card-selected-rpc');
  assert.strictEqual(built.headers['a2a-version'], '0.3');
  assert.strictEqual(built.body, capturedBody);
});

const { selectAgentByUrl } = require('../../dist/lib/signing/agent-resolver/select-agent.js');

test('brand.json matching uses the PROTOCOL ENDPOINT, not the card base', async () => {
  // security.mdx @ 3.1.1 :1142 step 1 — "The agent URL is the protocol endpoint, not a
  // JSON capabilities document"; :1104 step 5 byte-equals agents[].url against that A.
  // A conformant seller publishes the RPC endpoint, so matching the base finds nothing.
  const brand = {
    agents: [
      {
        type: 'sales',
        url: 'https://seller.example:8443/a2a',
        jwks_uri: 'https://seller.example:8443/.well-known/jwks.json',
      },
      {
        type: 'sales',
        url: 'https://seller.example:8443/mcp/',
        jwks_uri: 'https://seller.example:8443/.well-known/jwks.json',
      },
    ],
  };
  // The base the runner is handed for card discovery matches nothing — this is the bug.
  assert.throws(() => selectAgentByUrl(brand, 'https://seller.example:8443/'), /byte-equal/i);
  // The card-resolved protocol endpoint matches exactly one.
  const agent = selectAgentByUrl(brand, 'https://seller.example:8443/a2a');
  assert.strictEqual(agent.jwks_uri, 'https://seller.example:8443/.well-known/jwks.json');
});
