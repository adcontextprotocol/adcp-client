const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { buildAgentSigningFetch } = require('../dist/lib/signing/client.js');
const {
  verifyRequestSignature,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../dist/lib/signing/server.js');

const TARGET_URL = 'https://seller.example/mcp';
const pair = generateKeyPairSync('ed25519');
const publicJwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'protocol-method-key',
  alg: 'EdDSA',
  adcp_use: 'request-signing',
  key_ops: ['verify'],
};
const signing = {
  kid: publicJwk.kid,
  alg: 'ed25519',
  private_key: {
    ...pair.privateKey.export({ format: 'jwk' }),
    ...publicJwk,
    d: pair.privateKey.export({ format: 'jwk' }).d,
    key_ops: ['sign'],
  },
  agent_url: 'https://buyer.example',
};
const capability = extra => ({ supported: true, covers_content_digest: 'required', required_for: [], ...extra });

function capture({ advertised, overrides = {}, provider = false } = {}) {
  const requests = [];
  const config = provider
    ? {
        kind: 'provider',
        kid: signing.kid,
        alg: signing.alg,
        agent_url: signing.agent_url,
        provider: {
          keyid: signing.kid,
          algorithm: signing.alg,
          adcpUse: 'request-signing',
          fingerprint: 'protocol-method-key',
          sign: async bytes => sign(null, bytes, pair.privateKey),
        },
        ...overrides,
      }
    : { ...signing, ...overrides };
  const fetch = buildAgentSigningFetch({
    signing: config,
    adcpVersion: '3.2.6',
    getCapability: () =>
      advertised ? { requestSigning: advertised, adcpVersion: 3, fetchedAt: Date.now() / 1000 } : undefined,
    upstream: async (url, init) => {
      requests.push({ url, ...init, headers: Object.fromEntries(new Headers(init.headers)) });
      return new Response('{}', { status: 200 });
    },
  });
  return {
    requests,
    send: body =>
      fetch(TARGET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer preserved-bearer' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}
const rpc = method => ({ jsonrpc: '2.0', id: 1, method, params: { taskId: 'task-protocol-1' } });
const tool = name => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: { task_id: 'task-protocol-1' } },
});

for (const provider of [false, true]) {
  describe(`${provider ? 'provider' : 'inline'} protocol method signing (#3261)`, () => {
    for (const list of [
      'protocol_methods_required_for',
      'protocol_methods_warn_for',
      'protocol_methods_supported_for',
    ]) {
      for (const method of ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel', 'GetTask', 'CancelTask']) {
        it(`honors ${list} for exact method ${method}`, async () => {
          const c = capture({
            advertised: capability({ [list]: [method] }),
            overrides: { sign_supported: true },
            provider,
          });
          await c.send(rpc(method));
          const request = c.requests[0];
          assert.ok(request.headers['signature-input']);
          assert.ok(request.headers['signature-input'].includes('content-digest'));
          assert.equal(request.headers.authorization, 'Bearer preserved-bearer');
          assert.equal(
            (
              await verifyRequestSignature(
                { method: request.method, url: request.url, body: request.body, headers: request.headers },
                {
                  adcpVersion: '3.2.6',
                  capability: capability({}),
                  jwks: new StaticJwksResolver([publicJwk]),
                  replayStore: new InMemoryReplayStore(),
                  revocationStore: new InMemoryRevocationStore(),
                }
              )
            ).status,
            'verified'
          );
        });
      }
    }

    it('requires sign_supported for supported-only protocol coverage', async () => {
      const c = capture({ advertised: capability({ protocol_methods_supported_for: ['tasks/get'] }), provider });
      await c.send(rpc('tasks/get'));
      assert.equal(c.requests[0].headers.signature, undefined);
    });

    it('keeps A2A spellings case sensitive', async () => {
      const c = capture({ advertised: capability({ protocol_methods_required_for: ['tasks/cancel'] }), provider });
      await c.send(rpc('CancelTask'));
      await c.send(rpc('Tasks/cancel'));
      assert.ok(c.requests.every(r => r.headers.signature === undefined));
    });

    it('matches decoded JSON escapes and signs batches if any method matches', async () => {
      const c = capture({ advertised: capability({ protocol_methods_required_for: ['tasks/cancel'] }), provider });
      await c.send('{"jsonrpc":"2.0","id":1,"method":"tasks\\u002fcancel","params":{"taskId":"task-protocol-1"}}');
      await c.send([rpc('tools/list'), rpc('tasks/cancel')]);
      assert.ok(c.requests.every(r => r.headers.signature));
    });

    it('supports a separate protocol override with a cold capability cache', async () => {
      const c = capture({ overrides: { always_sign_protocol_methods: ['tasks/cancel'] }, provider });
      await c.send(rpc('tasks/cancel'));
      assert.ok(c.requests[0].headers.signature);
    });

    it('keeps tools/call and operation names out of the protocol namespace', async () => {
      const c = capture({
        advertised: capability({ protocol_methods_required_for: ['tools/call', 'tasks/cancel'] }),
        provider,
      });
      await c.send(tool('get_products'));
      await c.send(tool('tasks/cancel'));
      assert.ok(c.requests.every(r => r.headers.signature === undefined));
    });

    it('does not treat an operation override as a protocol method override', async () => {
      const c = capture({ overrides: { always_sign: ['tasks/cancel'] }, provider });
      await c.send(rpc('tasks/cancel'));
      assert.equal(c.requests[0].headers.signature, undefined);
    });

    it('signs legacy SDK task polls only for a seller declaring signing support', async () => {
      const c = capture({ advertised: capability({}), provider });
      await c.send(tool('tasks_get'));
      await c.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'poll-1',
            parts: [{ data: { skill: 'tasks/get', parameters: { task_id: 'task-protocol-1' } } }],
          },
        },
      });
      assert.ok(c.requests.every(r => r.headers.signature));
      assert.notEqual(c.requests[0].headers['signature-input'], c.requests[1].headers['signature-input']);
      const unsupported = capture({ advertised: capability({ supported: false }), provider });
      await unsupported.send(tool('tasks_get'));
      assert.equal(unsupported.requests[0].headers.signature, undefined);
    });

    it('does not substring-match malformed seller method lists', async () => {
      const c = capture({
        advertised: capability({ protocol_methods_required_for: 'tasks/get,CancelTask' }),
        provider,
      });
      await c.send(rpc('Task'));
      assert.equal(c.requests[0].headers.signature, undefined);
    });
  });
}

it('isolates cached transport signing policies and detaches caller override arrays', () => {
  const { buildAgentSigningContext } = require('../dist/lib/signing/client.js');
  const agent = {
    id: 'protocol-methods',
    name: 'Protocol methods',
    protocol: 'mcp',
    agent_uri: TARGET_URL,
    request_signing: { ...signing, always_sign_protocol_methods: ['tasks/get'] },
  };
  const first = buildAgentSigningContext(agent);
  const second = buildAgentSigningContext({
    ...agent,
    request_signing: { ...signing, always_sign_protocol_methods: ['tasks/cancel'] },
  });
  assert.notEqual(first.cacheKey, second.cacheKey);
  assert.equal(
    first.capabilityCacheKey,
    second.capabilityCacheKey,
    'seller advertisements are independent of buyer signing preferences'
  );
  agent.request_signing.always_sign_protocol_methods.push('tasks/cancel');
  assert.deepEqual(first.signing.always_sign_protocol_methods, ['tasks/get']);
});

for (const invalid of ['tasks/cancel', ['tools/call'], ['create_media_buy'], ['CancelTask\n']]) {
  it(`rejects invalid buyer protocol overrides before dispatch: ${JSON.stringify(invalid)}`, () => {
    assert.throws(
      () => capture({ overrides: { always_sign_protocol_methods: invalid } }),
      /always_sign_protocol_methods/
    );
  });
}

it('refuses ambiguous method bodies instead of choosing an unsigned route', async () => {
  const c = capture({ advertised: capability({ protocol_methods_required_for: ['tasks/cancel'] }) });
  await assert.rejects(c.send('{"method":"tasks/cancel","method":"tools/list"}'), /malformed JSON-RPC/);
  assert.equal(c.requests.length, 0);
});

for (const provider of [false, true]) {
  it(`official MCP Tasks client completes signed task methods with ${provider ? 'provider' : 'inline'} signing and no fallback authenticator`, async t => {
    const http = require('node:http');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { CreateTaskResultSchema, CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
    const { createTaskCapableServer, registerAdcpTaskTool, InMemoryTaskStore } = require('../dist/lib/server/tasks.js');
    const taskStore = new InMemoryTaskStore();
    const requiredMethods = ['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'];
    const advertised = capability({
      required_for: ['create_media_buy'],
      protocol_methods_required_for: requiredMethods,
      protocol_methods_supported_for: requiredMethods,
    });
    const replayStore = new InMemoryReplayStore();
    const jwks = new StaticJwksResolver([publicJwk]);
    const revocationStore = new InMemoryRevocationStore();
    const requests = [];
    const authFailures = [];
    let tokenExchanges = 0;
    let onCapabilityRead;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/token') {
        tokenExchanges++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            access_token: 'task-list-token',
            token_type: 'Bearer',
            expires_in: 3600,
          })
        );
        return;
      }
      const url = `http://${req.headers.host}${req.url}`;
      try {
        const parsed = body ? JSON.parse(body) : undefined;
        const operation = parsed?.method === 'tools/call' ? parsed.params.name : undefined;
        const result = await verifyRequestSignature(
          { method: req.method, url, headers: req.headers, body },
          { adcpVersion: '3.2.6', capability: advertised, operation, jwks, replayStore, revocationStore }
        );
        requests.push({ method: parsed?.method, operation, result: result.status, headers: { ...req.headers } });
        const mcp = createTaskCapableServer('signed-task-seller', '1.0.0', { taskStore });
        mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
          onCapabilityRead?.();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  adcp: { major_versions: [3], supported_versions: ['3.2.6'] },
                  supported_protocols: ['media_buy'],
                  request_signing: advertised,
                }),
              },
            ],
          };
        });
        registerAdcpTaskTool(
          mcp,
          'create_media_buy',
          { description: 'Run background work', inputSchema: {}, taskSupport: 'required' },
          {
            createTask: async (_args, extra) => ({ task: await extra.taskStore.createTask({ ttl: 60000 }) }),
            getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
            getTaskResult: async (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
          }
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res, parsed);
        } finally {
          await mcp.close();
        }
      } catch (error) {
        authFailures.push(error.code ?? error.message);
        if (!res.writableEnded)
          res
            .writeHead(401, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: error.code ?? 'verification_failed' }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const config = provider
      ? {
          kind: 'provider',
          agent_url: signing.agent_url,
          provider: {
            keyid: signing.kid,
            algorithm: signing.alg,
            adcpUse: 'request-signing',
            fingerprint: 'protocol-method-key',
            sign: async bytes => sign(null, bytes, pair.privateKey),
          },
        }
      : { ...signing, private_key: { ...signing.private_key } };
    const signedFetch = buildAgentSigningFetch({
      signing: config,
      adcpVersion: '3.2.6',
      getCapability: () => ({ requestSigning: advertised, adcpVersion: 3, fetchedAt: Date.now() / 1000 }),
    });
    const client = new Client({ name: 'signed-task-buyer', version: '1.0.0' });
    t.after(async () => {
      await client.close();
      await require('../dist/lib/protocols/mcp.js').closeMCPConnections();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      taskStore.cleanup();
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: signedFetch }));
    await client.listTools();
    const create = () =>
      client.request(
        { method: 'tools/call', params: { name: 'create_media_buy', arguments: {} } },
        CreateTaskResultSchema,
        { task: { ttl: 60000 } }
      );
    const created = await create();
    const id = created.task.taskId;
    assert.equal((await client.experimental.tasks.getTask(id)).status, 'working');
    assert.equal((await client.experimental.tasks.getTask(id)).status, 'working');
    assert.ok((await client.experimental.tasks.listTasks()).tasks.some(task => task.taskId === id));
    await taskStore.storeTaskResult(id, 'completed', {
      content: [{ type: 'text', text: 'Background work completed' }],
    });
    const result = await client.experimental.tasks.getTaskResult(id, CallToolResultSchema);
    assert.equal(result.content[0].text, 'Background work completed');
    const cancelId = (await create()).task.taskId;
    assert.equal((await client.experimental.tasks.cancelTask(cancelId)).status, 'cancelled');
    const { TaskExecutor } = require('../dist/lib/core/TaskExecutor.js');
    const executor = new TaskExecutor({ adcpVersion: '3.2.6' });
    const callerHeaders = { 'x-buyer-scope': 'native-task-scope' };
    onCapabilityRead = () => {
      callerHeaders['x-buyer-scope'] = 'changed-after-bootstrap';
      if (provider) {
        config.provider.keyid = 'changed-after-bootstrap';
        config.provider.fingerprint = 'changed-after-bootstrap';
        config.provider.sign = async () => {
          throw new Error('mutated signer must not be used');
        };
      } else {
        config.private_key.d = 'changed-after-bootstrap';
      }
    };
    const tracked = await executor.listTasks(
      {
        id: 'signed-native-tasks',
        name: 'Signed native tasks',
        agent_uri: url,
        protocol: 'mcp',
        request_signing: config,
        headers: callerHeaders,
      },
      { allowPrivateIp: true }
    );
    assert.ok(
      tracked.some(task => task.taskId === id),
      'the SDK task-list path must prime and sign native methods'
    );
    assert.ok(
      requests.some(
        request =>
          request.method === 'tasks/list' &&
          request.headers['x-buyer-scope'] === 'native-task-scope' &&
          request.result === 'verified'
      )
    );
    assert.equal(callerHeaders['x-buyer-scope'], 'changed-after-bootstrap', 'priming must exercise caller mutation');
    if (!provider) {
      onCapabilityRead = undefined;
      const credentialOwner = {
        id: 'native-task-oauth',
        name: 'Native task OAuth',
        agent_uri: url,
        protocol: 'mcp',
        request_signing: { ...signing, private_key: { ...signing.private_key } },
        oauth_client_credentials: {
          token_endpoint: url.replace('/mcp', '/token'),
          client_id: 'task-client',
          client_secret: 'task-test-secret',
        },
        oauth_tokens: { access_token: 'expired-token', token_type: 'Bearer', expires_at: '2020-01-01T00:00:00Z' },
      };
      const lists = await Promise.all([
        executor.listTasks(credentialOwner, { allowPrivateIp: true }),
        executor.listTasks(credentialOwner, { allowPrivateIp: true }),
      ]);
      assert.ok(lists.every(tasks => tasks.some(task => task.taskId === id)));
      assert.equal(tokenExchanges, 1, 'concurrent task lists share the credential-owner refresh');
      assert.equal(credentialOwner.oauth_tokens.access_token, 'task-list-token');
      assert.ok(
        requests.some(
          request => request.method === 'tasks/list' && request.headers.authorization === 'Bearer task-list-token'
        )
      );
      const oauthOwner = {
        id: 'native-task-refresh-oauth',
        name: 'Native task refresh OAuth',
        agent_uri: url,
        protocol: 'mcp',
        request_signing: { ...signing, private_key: { ...signing.private_key } },
        oauth_client: { client_id: 'saved-oauth-client', issuer: 'https://issuer.example' },
        oauth_tokens: {
          access_token: 'saved-oauth-token',
          refresh_token: 'saved-refresh-token',
          token_type: 'Bearer',
          issuer: 'https://issuer.example',
        },
      };
      const oauthTasks = await executor.listTasks(oauthOwner, { allowPrivateIp: true });
      assert.ok(oauthTasks.some(task => task.taskId === id));
      const { getNonInteractiveOAuthProvider } = require('../dist/lib/auth/oauth/provider-cache.js');
      const oauthProvider = getNonInteractiveOAuthProvider(oauthOwner);
      assert.equal(
        (await oauthProvider.validateResourceURL(url, url)).href,
        url,
        'listing first must preserve loopback HTTP resource validation for subsequent OAuth refreshes'
      );
    }
    assert.deepEqual(authFailures, []);
    for (const method of requiredMethods) {
      const observed = requests.filter(request => request.method === method);
      assert.ok(observed.length, `${method} must reach the real protocol handler`);
      assert.ok(
        observed.every(
          request => request.result === 'verified' && request.headers['signature-input'].includes('content-digest')
        )
      );
    }
    const polls = requests.filter(request => request.method === 'tasks/get');
    assert.notEqual(
      polls[0].headers['signature-input'],
      polls[1].headers['signature-input'],
      'identical polls need fresh nonces'
    );
    assert.ok(
      requests.filter(request => request.method === 'initialize').every(request => request.result === 'unsigned')
    );
  });
}

for (const provider of [false, true]) {
  it(`protocol overrides preserve the WBA advertisement gate for ${provider ? 'provider' : 'inline'} signing`, async () => {
    const { jwkThumbprint } = require('../dist/lib/signing/web-bot-auth.js');
    const kid = jwkThumbprint(signing.private_key);
    let calls = 0;
    const config = provider
      ? {
          kind: 'provider',
          profile: 'web-bot-auth',
          agent_url: signing.agent_url,
          public_key: publicJwk,
          always_sign_protocol_methods: ['tasks/cancel'],
          provider: {
            keyid: kid,
            algorithm: 'ed25519',
            fingerprint: kid,
            sign: async bytes => sign(null, bytes, pair.privateKey),
          },
        }
      : { ...signing, profile: 'web-bot-auth', kid, always_sign_protocol_methods: ['tasks/cancel'] };
    const fetch = buildAgentSigningFetch({
      signing: config,
      getCapability: () => undefined,
      upstream: async () => {
        calls++;
        return new Response('{}');
      },
    });
    await assert.rejects(
      fetch(TARGET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpc('tasks/cancel')),
      }),
      /did not advertise the Web Bot Auth/
    );
    assert.equal(calls, 0);
  });
}

for (const extra of [
  ',"push_notification_config":{"url":"https://buyer.example/webhook","authentication":{"schemes":["HMAC-SHA256"],"credentials":"test-only"}}',
  ',"padding":"' + 'x'.repeat(1_048_576) + '"',
]) {
  it('refuses ambiguous methods even when webhook credentials or a large body force signing', async () => {
    const c = capture({ advertised: capability({ protocol_methods_required_for: ['tasks/cancel'] }) });
    await assert.rejects(c.send('{"method":"tasks/cancel","method":"tools/list"' + extra + '}'), /malformed JSON-RPC/);
    assert.equal(c.requests.length, 0);
  });
}

for (const overrides of [{ always_sign: 'create_media_buy' }, { sign_supported: 'true' }]) {
  it('refuses malformed legacy signing flags rather than sending an unsigned request', () => {
    assert.throws(() => capture({ overrides }), TypeError);
  });
}

it('opportunistic legacy polls require a mutually supported signing profile', async () => {
  const { jwkThumbprint } = require('../dist/lib/signing/web-bot-auth.js');
  const requests = [];
  const fetch = buildAgentSigningFetch({
    signing: { ...signing, profile: 'web-bot-auth', kid: jwkThumbprint(signing.private_key) },
    getCapability: () => ({ requestSigning: capability({}), adcpVersion: 3, fetchedAt: Date.now() / 1000 }),
    upstream: async (_url, init) => {
      requests.push(init);
      return new Response('{}');
    },
  });
  for (const body of [
    tool('tasks_get'),
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'profile-compatible-poll',
          role: 'ROLE_USER',
          parts: [{ data: { skill: 'tasks/get', parameters: { task_id: 'task-protocol-1' } } }],
        },
      },
    },
  ]) {
    await fetch(TARGET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  assert.ok(requests.every(request => !new Headers(request.headers).has('signature')));
  const rfc = capture({ advertised: capability({ profiles: ['web-bot-auth'] }) });
  await rfc.send(tool('tasks_get'));
  assert.equal(rfc.requests[0].headers.signature, undefined);
});

it('preserves form-encoded OAuth token posts sharing a method-signing fetch', async () => {
  const requests = [];
  const fetch = buildAgentSigningFetch({
    signing,
    getCapability: () => ({
      requestSigning: capability({ protocol_methods_required_for: ['tasks/cancel'] }),
      adcpVersion: 3,
      fetchedAt: Date.now() / 1000,
    }),
    upstream: async (_url, init) => {
      requests.push(init);
      return new Response('{}');
    },
  });
  await fetch('https://issuer.example/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=task-client',
  });
  assert.equal(requests.length, 1);
  assert.equal(new Headers(requests[0].headers).has('signature'), false);
  assert.equal(requests[0].body, 'grant_type=client_credentials&client_id=task-client');
});
