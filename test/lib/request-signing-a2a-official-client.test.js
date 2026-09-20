const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  captureA2aRequest,
  createCachedA2aCardFetch,
} = require('../../dist/lib/testing/storyboard/request-signing/a2a-dispatch.js');
const { buildPositiveRequest } = require('../../dist/lib/testing/storyboard/request-signing/builder.js');
const { probeSignedRequest } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
const { loadRequestSigningVectors } = require('../../dist/lib/testing/storyboard/request-signing/vector-loader.js');
const { gradeRequestSigning } = require('../../dist/lib/testing/storyboard/request-signing/grader.js');

async function closeServer(server) {
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

test('signs and sends the exact official-client A2A bytes to the card-selected endpoint', async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (req.url.startsWith('/.well-known/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'signing-fixture',
          description: 'Official client signing fixture',
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
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const captured = await captureA2aRequest(
      base,
      { kind: 'sendMessage', operation: 'get_products', args: { brief: 'historical 3.1.1' } },
      { allowPrivateIp: true }
    );
    const loaded = loadRequestSigningVectors();
    const vector = loaded.positive.find(candidate => candidate.id === '001-basic-post');
    assert.ok(vector, 'expected the baseline positive signing vector');

    const signed = buildPositiveRequest(vector, loaded.keys, {
      baseUrl: base,
      transport: 'a2a',
      a2aRequest: captured,
    });
    assert.strictEqual(signed.url, `${base}/card-selected-rpc`);
    assert.strictEqual(signed.body, captured.body, 'signing must not reframe or reserialize the SDK request');
    assert.strictEqual(signed.headers['a2a-version'], '1.0');
    assert.ok(signed.headers.Signature ?? signed.headers.signature);
    assert.ok(signed.headers['Signature-Input'] ?? signed.headers['signature-input']);

    const probe = await probeSignedRequest(signed, { allowPrivateIp: true });
    assert.strictEqual(probe.status, 200, probe.error);
    assert.strictEqual(received.url, '/card-selected-rpc');
    assert.strictEqual(received.body, captured.body, 'wire bytes must be the exact official-client bytes');
    assert.strictEqual(received.headers['a2a-version'], '1.0');
    assert.ok(received.headers.signature);
    const body = JSON.parse(received.body);
    assert.strictEqual(body.method, 'SendMessage');
    assert.strictEqual(body.params.message.role, 'ROLE_USER');
  } finally {
    await closeServer(server);
  }
});

test('refuses a cross-origin card endpoint before signing or dispatch', async () => {
  const cardFetch = async input => {
    assert.match(String(input), /\.well-known/);
    return new Response(
      JSON.stringify({
        protocolVersion: '1.0',
        name: 'cross-origin-signing-fixture',
        description: 'must fail closed',
        version: '1.0.0',
        capabilities: {},
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
        supportedInterfaces: [
          { url: 'https://rpc.seller.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  await assert.rejects(
    captureA2aRequest(
      'https://seller.example/a2a',
      { kind: 'sendMessage', operation: 'get_products', args: { brief: 'must not dispatch' } },
      { cardFetch }
    ),
    /refuse a cross-origin card endpoint/
  );
});

test('caches agent-card discovery across A2A signing vectors', async () => {
  let cardFetches = 0;
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (req.url.startsWith('/.well-known/')) {
      cardFetches++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'cached-card-fixture',
          description: 'Card discovery cache fixture',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          supportedInterfaces: [
            { url: `http://127.0.0.1:${port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
          ],
        })
      );
      return;
    }
    for await (const _chunk of req) void _chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const report = await gradeRequestSigning(base, {
      transport: 'a2a',
      allowPrivateIp: true,
      onlyVectors: ['001-basic-post', '002-post-with-content-digest'],
      skipRateAbuse: true,
    });
    assert.strictEqual(cardFetches, 1);
    assert.strictEqual(report.positive.filter(result => !result.skipped).length, 2);
  } finally {
    await closeServer(server);
  }
});

test('cached card discovery rejects a private cross-origin target from a public configured origin', async () => {
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = async () => {
    globalFetchCalls++;
    return new Response('{}', { status: 200 });
  };
  try {
    const cachedFetch = createCachedA2aCardFetch('https://seller.example');
    await assert.rejects(cachedFetch('http://127.0.0.1:9/.well-known/agent-card.json'), /private or loopback address/);
    assert.strictEqual(globalFetchCalls, 0, 'SSRF refusal must happen before any network fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cached card discovery rejects oversized bodies before retaining them', async () => {
  const oversized = new Uint8Array(1_048_577);
  const cachedFetch = createCachedA2aCardFetch('https://seller.example', {
    cardFetch: async () => new Response(oversized, { status: 200 }),
  });
  await assert.rejects(
    cachedFetch('https://seller.example/.well-known/agent-card.json'),
    /exceeds the 1048576-byte discovery limit/
  );
});

test('official client captures and signs A2A 0.3 message/send bytes', async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    if (req.url.startsWith('/.well-known/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: '0.3.0',
          name: 'legacy-signing-fixture',
          description: 'Official 0.3 client signing fixture',
          version: '1.0.0',
          url: `http://127.0.0.1:${port}/legacy-rpc`,
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
        })
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const captured = await captureA2aRequest(
      base,
      { kind: 'sendMessage', operation: 'get_products', args: { brief: 'legacy' } },
      { allowPrivateIp: true }
    );
    const loaded = loadRequestSigningVectors();
    const vector = loaded.positive.find(candidate => candidate.id === '001-basic-post');
    const signed = buildPositiveRequest(vector, loaded.keys, { baseUrl: base, transport: 'a2a', a2aRequest: captured });
    const probe = await probeSignedRequest(signed, { allowPrivateIp: true });

    assert.strictEqual(probe.status, 200, probe.error);
    assert.strictEqual(received.url, '/legacy-rpc');
    assert.strictEqual(received.body, captured.body);
    const body = JSON.parse(received.body);
    assert.strictEqual(body.method, 'message/send');
    assert.deepStrictEqual(body.params.message.parts[0].data, {
      skill: 'get_products',
      parameters: { brief: 'legacy' },
    });
    assert.ok(received.headers.signature);
  } finally {
    await closeServer(server);
  }
});
