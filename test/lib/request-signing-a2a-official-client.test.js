const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { generateKeyPairSync } = require('node:crypto');

const {
  captureA2aRequest,
  createCachedA2aCardFetch,
} = require('../../dist/lib/testing/storyboard/request-signing/a2a-dispatch.js');
const { buildPositiveRequest } = require('../../dist/lib/testing/storyboard/request-signing/builder.js');
const { probeSignedRequest } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
const { loadRequestSigningVectors } = require('../../dist/lib/testing/storyboard/request-signing/vector-loader.js');
const { gradeRequestSigning } = require('../../dist/lib/testing/storyboard/request-signing/grader.js');
const { callA2ATool } = require('../../dist/lib/protocols/a2a.js');

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

test('native SendMessage honors always_sign through the actual official-client path', async () => {
  const agentUrl = 'https://seller.example';
  const rpcUrl = `${agentUrl}/rpc`;
  const rpcCalls = [];
  const transportFetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/.well-known/')) {
      return new Response(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'native-signing-fixture',
          description: 'Actual native signing path fixture',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          supportedInterfaces: [{ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    const body = JSON.parse(init.body);
    rpcCalls.push({ body, headers: Object.fromEntries(new Headers(init.headers)) });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          task: {
            id: 'native-signed-task',
            contextId: 'native-signed-context',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'result', parts: [{ data: { status: 'completed' } }] }],
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  const { privateKey } = generateKeyPairSync('ed25519');
  const signing = {
    kid: 'native-test-key',
    alg: 'ed25519',
    private_key: {
      ...privateKey.export({ format: 'jwk' }),
      adcp_use: 'request-signing',
    },
    agent_url: 'https://buyer.example',
    always_sign: ['create_media_buy'],
  };

  await callA2ATool(
    agentUrl,
    'create_media_buy',
    { plan_id: 'native-plan' },
    undefined,
    [],
    undefined,
    undefined,
    { signing, getCapability: () => undefined },
    undefined,
    undefined,
    1_000,
    transportFetch,
    undefined,
    { enabled: false }
  );

  assert.strictEqual(rpcCalls.length, 1);
  assert.strictEqual(rpcCalls[0].body.method, 'SendMessage');
  assert.strictEqual(rpcCalls[0].body.params.message.parts[0].data.skill, 'create_media_buy');
  assert.ok(rpcCalls[0].headers.signature, 'native always_sign call must carry Signature');
  assert.ok(rpcCalls[0].headers['signature-input'], 'native always_sign call must carry Signature-Input');
  assert.ok(rpcCalls[0].headers['content-digest'], 'native always_sign call must bind the official-client body');
});

test('native tool dispatch keeps X-Session same-origin and strips it from card-selected cross-origin targets', async () => {
  for (const crossOrigin of [false, true]) {
    const agentUrl = 'https://seller.example';
    const rpcUrl = crossOrigin ? 'https://rpc.example/a2a' : `${agentUrl}/rpc`;
    let receivedSession;
    const transportFetch = async (input, init = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/.well-known/')) {
        return new Response(
          JSON.stringify({
            protocolVersion: '1.0',
            name: 'custom-header-fixture',
            description: 'Configured header origin binding',
            version: '1.0.0',
            capabilities: {},
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            skills: [],
            supportedInterfaces: [{ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      receivedSession = new Headers(init.headers).get('x-session');
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            task: {
              id: 'native-header-task',
              contextId: 'native-header-context',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [{ artifactId: 'result', parts: [{ data: { status: 'completed' } }] }],
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    };

    await callA2ATool(
      agentUrl,
      'get_products',
      {},
      undefined,
      [],
      undefined,
      { 'X-Session': 'origin-bound-session' },
      undefined,
      undefined,
      undefined,
      1_000,
      transportFetch,
      undefined,
      { enabled: false }
    );
    assert.strictEqual(receivedSession, crossOrigin ? null : 'origin-bound-session');
  }
});

test('native tool dispatch strips X-Session from every cross-origin redirect hop', async () => {
  const calls = [];
  const agentUrl = 'https://seller.example';
  const transportFetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/.well-known/')) {
      return new Response(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'custom-header-redirect-fixture',
          description: 'Configured header redirect origin binding',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          supportedInterfaces: [{ url: `${agentUrl}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    calls.push({ url, session: new Headers(init.headers).get('x-session') });
    if (url === `${agentUrl}/rpc`) {
      return new Response('', { status: 307, headers: { location: 'https://rpc.example/a2a' } });
    }
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          task: {
            id: 'native-redirect-task',
            contextId: 'native-redirect-context',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'result', parts: [{ data: { status: 'completed' } }] }],
          },
        },
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  };

  await callA2ATool(
    agentUrl,
    'get_products',
    {},
    undefined,
    [],
    undefined,
    { 'X-Session': 'redirect-origin-session' },
    undefined,
    undefined,
    undefined,
    1_000,
    transportFetch,
    undefined,
    { enabled: false }
  );
  assert.deepStrictEqual(calls, [
    { url: `${agentUrl}/rpc`, session: 'redirect-origin-session' },
    { url: 'https://rpc.example/a2a', session: null },
  ]);
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

test('agent-card discovery timeout includes a response body that never closes', async () => {
  const stalledCardFetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  const startedAt = Date.now();

  await assert.rejects(
    captureA2aRequest(
      'https://seller.example',
      { kind: 'cancelTask', taskId: 'stalled-card' },
      { timeoutMs: 20, cardFetch: stalledCardFetch }
    ),
    error => {
      assert.equal(error.message, 'A2A agent card discovery failed');
      assert.match(error.cause?.message ?? '', /timed out|timeout/i);
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 1_000, 'discovery must not outlive its body-inclusive deadline');
});

test('agent-card discovery exposes a generic error and retains internal detail only as cause', async () => {
  const internal = new Error('ECONNREFUSED 10.0.0.7:6379');
  await assert.rejects(
    captureA2aRequest(
      'https://seller.example',
      { kind: 'cancelTask', taskId: 'discovery-error' },
      { cardFetch: async () => Promise.reject(internal) }
    ),
    error => {
      assert.strictEqual(error.message, 'A2A agent card discovery failed');
      assert.strictEqual(error.cause, internal);
      assert.doesNotMatch(error.message, /10\.0\.0\.7|6379/);
      return true;
    }
  );
});

test('agent-card discovery rejects invalid timeout values before fetching', async () => {
  for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      captureA2aRequest(
        'https://seller.example',
        { kind: 'cancelTask', taskId: 'invalid-timeout' },
        { timeoutMs, cardFetch: async () => new Response('{}') }
      ),
      /timeoutMs must be a finite positive number/
    );
  }
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

test('vector 027 uses transport push registration on both A2A wire versions', async () => {
  const loaded = loadRequestSigningVectors();
  const vector027 = loaded.negative.find(vector => vector.id === '027-webhook-registration-authentication-unsigned');
  assert.ok(vector027, 'expected vector 027 fixture');
  const vectorArgs = JSON.parse(vector027.request.body);
  const pushNotificationConfig = vectorArgs.push_notification_config;
  const reportingWebhook = {
    url: 'https://buyer.example/reporting',
    authentication: { schemes: ['HMAC-SHA256'], credentials: 'reporting-secret' },
  };

  for (const protocolVersion of ['0.3.0', '1.0']) {
    const agentUrl = 'https://seller.example';
    const cardFetch = async () =>
      new Response(
        JSON.stringify(
          protocolVersion === '0.3.0'
            ? {
                protocolVersion,
                name: 'legacy-vector-027',
                description: 'Legacy push registration fixture',
                version: '1.0.0',
                url: `${agentUrl}/rpc`,
                capabilities: {},
                defaultInputModes: ['application/json'],
                defaultOutputModes: ['application/json'],
                skills: [],
              }
            : {
                protocolVersion,
                name: 'native-vector-027',
                description: 'Native push registration fixture',
                version: '1.0.0',
                capabilities: {},
                defaultInputModes: ['application/json'],
                defaultOutputModes: ['application/json'],
                skills: [],
                supportedInterfaces: [{ url: `${agentUrl}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
              }
        ),
        { headers: { 'content-type': 'application/json' } }
      );
    const captured = await captureA2aRequest(
      agentUrl,
      {
        kind: 'sendMessage',
        operation: 'update_media_buy',
        args: {
          ...vectorArgs,
          reporting_webhook: reportingWebhook,
        },
      },
      { cardFetch }
    );
    const body = JSON.parse(captured.body);
    const skillPayload = body.params.message.parts[0].data;

    assert.strictEqual(skillPayload.skill, 'update_media_buy');
    const skillArgs = protocolVersion === '0.3.0' ? skillPayload.parameters : skillPayload.input;
    assert.strictEqual(skillArgs.push_notification_config, undefined, protocolVersion);
    assert.deepStrictEqual(skillArgs.reporting_webhook, reportingWebhook, protocolVersion);
    if (protocolVersion === '0.3.0') {
      assert.deepStrictEqual(body.params.configuration.pushNotificationConfig, {
        url: pushNotificationConfig.url,
        authentication: { schemes: ['HMAC-SHA256'], credentials: 'shared-secret-placeholder' },
      });
    } else {
      assert.deepStrictEqual(body.params.configuration.taskPushNotificationConfig, {
        url: pushNotificationConfig.url,
        authentication: { scheme: 'HMAC-SHA256', credentials: 'shared-secret-placeholder' },
      });
    }
  }
});
