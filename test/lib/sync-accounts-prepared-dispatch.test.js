const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { ADCP_VERSION, AgentClient, SingleAgentClient, canonicalJsonSha256 } = require('../../dist/lib/index.js');

async function seller(config = {}) {
  const calls = [];
  const server = new Server({ name: 'account-seller', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'get_adcp_capabilities', inputSchema: { type: 'object', additionalProperties: true } },
      { name: 'sync_accounts', inputSchema: { type: 'object', additionalProperties: true } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result =
      request.params.name === 'get_adcp_capabilities'
        ? {
            status: 'completed',
            adcp_version: ADCP_VERSION,
            adcp: {
              major_versions: [3],
              supported_versions: [ADCP_VERSION],
              idempotency: { supported: true, replay_ttl_seconds: 86400 },
            },
            supported_protocols: ['media_buy'],
            specialisms: [],
          }
        : { status: 'completed', accounts: [] };
    if (request.params.name === 'sync_accounts') calls.push(request.params.arguments);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(sellerTransport);
  const mcp = new Client({ name: 'account-buyer', version: '1.0.0' });
  await mcp.connect(buyerTransport);
  const agent = AgentClient.fromMCPClient(mcp, {
    adcpVersion: ADCP_VERSION,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    ...config,
  });
  return {
    agent,
    calls,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

test('syncAccounts gates the exact seller arguments on a durable digest', async () => {
  const { agent, calls, close } = await seller();
  const saved = [];
  try {
    const result = await agent.syncAccounts(
      {
        idempotency_key: 'original-key',
        accounts: [],
        context: { trace_id: 'trace-a' },
        ext: { apostra: { account_write: { generation: 2 } } },
      },
      undefined,
      {
        beforePreparedDispatch: async identity => {
          saved.push(identity);
          assert.equal(calls.length, 0);
        },
      }
    );
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(saved, [
      {
        hash_algorithm: 'sync_accounts_arguments_jcs_sha256_v1',
        request_sha256: canonicalJsonSha256(calls[0]),
      },
    ]);
    assert.equal(calls[0].idempotency_key, 'original-key');
    assert.deepEqual(calls[0].accounts, []);
    assert.equal(typeof calls[0].adcp_version, 'string');
    assert.deepEqual(calls[0].context, { trace_id: 'trace-a' });
    assert.deepEqual(calls[0].ext.apostra.account_write, { generation: 2 });
  } finally {
    await close();
  }
});

test('syncAccounts does not send when durable digest storage rejects', async () => {
  const { agent, calls, close } = await seller();
  const saveError = Object.assign(new Error('digest save failed'), { name: 'AbortError' });
  try {
    await assert.rejects(
      agent.syncAccounts({ idempotency_key: 'original-key', accounts: [] }, undefined, {
        beforePreparedDispatch: async () => {
          throw saveError;
        },
      }),
      error => error === saveError
    );
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('syncAccounts keeps the original digest callback while discovery is pending', async () => {
  const { agent, calls, close } = await seller();
  const client = agent.client;
  const originalDiscovery = client.ensureEndpointDiscovered;
  const saveError = new Error('durable save failed');
  let releaseDiscovery;
  let discoveryStarted;
  const discoveryStartedPromise = new Promise(resolve => {
    discoveryStarted = resolve;
  });
  const discoveryGate = new Promise(resolve => {
    releaseDiscovery = resolve;
  });
  let originalCalls = 0;
  let replacementCalls = 0;
  client.ensureEndpointDiscovered = async function (...args) {
    discoveryStarted();
    await discoveryGate;
    return originalDiscovery.apply(this, args);
  };
  try {
    const options = {
      beforePreparedDispatch: async () => {
        originalCalls++;
        throw saveError;
      },
    };
    const pending = client.syncAccounts({ idempotency_key: 'original-key', accounts: [] }, undefined, options);
    await discoveryStartedPromise;
    options.beforePreparedDispatch = async () => {
      replacementCalls++;
    };
    releaseDiscovery();
    await assert.rejects(pending, error => error === saveError);
    assert.equal(originalCalls, 1);
    assert.equal(replacementCalls, 0);
    assert.equal(calls.length, 0);
  } finally {
    releaseDiscovery();
    client.ensureEndpointDiscovered = originalDiscovery;
    await close();
  }
});

test('registry dispatch refuses a prepared digest callback instead of silently skipping it', async () => {
  const { agent, calls, close } = await seller();
  let registryCallbackCalled = false;
  try {
    await assert.rejects(
      agent.client.syncAccounts(
        { idempotency_key: 'registry-key', accounts: [] },
        undefined,
        {
          beforePreparedDispatch: async () => {
            throw new Error('digest save failed');
          },
        },
        {
          idempotencyKey: 'registry-key',
          beforeDispatch: async () => {
            registryCallbackCalled = true;
          },
        }
      ),
      /beforePreparedDispatch/
    );
    assert.equal(registryCallbackCalled, false);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('syncAccounts refuses invalid JCS text before saving identity or sending', async () => {
  const { agent, calls, close } = await seller();
  let saved = false;
  try {
    await assert.rejects(
      agent.syncAccounts({ idempotency_key: 'original-key', accounts: [], ext: { note: '\ud800' } }, undefined, {
        beforePreparedDispatch: async () => {
          saved = true;
        },
      }),
      error => /surrogate|I-JSON/i.test(error.message)
    );
    assert.equal(saved, false);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('syncAccounts refuses values that JSON serialization would silently change', async () => {
  for (const invalid of [{ note: undefined }, { note: [undefined] }, { note: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { agent, calls, close } = await seller();
    let saved = false;
    try {
      await assert.rejects(
        agent.syncAccounts({ idempotency_key: 'original-key', accounts: [], ext: invalid }, undefined, {
          beforePreparedDispatch: async () => {
            saved = true;
          },
        })
      );
      assert.equal(saved, false);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  }
});

test('the digest callback requires an original public idempotency key', async () => {
  const { agent, calls, close } = await seller();
  let saved = false;
  try {
    await assert.rejects(
      agent.syncAccounts({ accounts: [] }, undefined, {
        beforePreparedDispatch: async () => {
          saved = true;
        },
      }),
      /idempotency.key/i
    );
    assert.equal(saved, false);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('a transformed prepared key cannot be saved under the original public key', async () => {
  const { agent, calls, close } = await seller();
  let saved = false;
  const executor = agent.client.executor;
  const executeTask = executor.executeTask.bind(executor);
  executor.executeTask = (...args) => {
    args[2] = { ...args[2], idempotency_key: 'transformed-key' };
    return executeTask(...args);
  };
  try {
    await assert.rejects(
      agent.syncAccounts({ idempotency_key: 'original-key', accounts: [] }, undefined, {
        beforePreparedDispatch: async () => {
          saved = true;
        },
      }),
      error => /idempotency.key/i.test(error.message)
    );
    assert.equal(saved, false);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test('a same-key rebuild with an explicit empty replacement cannot pass a saved digest', async () => {
  const { agent, calls, close } = await seller();
  let durableDigest;
  const beforePreparedDispatch = async identity => {
    if (durableDigest && durableDigest !== identity.request_sha256) throw new Error('request identity changed');
    durableDigest = identity.request_sha256;
  };
  try {
    const base = { idempotency_key: 'original-key', accounts: [{ account_id: 'a' }] };
    await agent.syncAccounts(base, undefined, { beforePreparedDispatch });
    assert.equal(calls.length, 1);
    await assert.rejects(
      agent.syncAccounts({ ...base, accounts: [{ account_id: 'a', notification_subscribers: [] }] }, undefined, {
        beforePreparedDispatch,
      }),
      error => error.message === 'request identity changed'
    );
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test('a default SDK webhook operation ID changes the complete same-key digest', async () => {
  const { agent, calls, close } = await seller({
    webhookUrlTemplate: 'https://buyer.example/webhooks/{task_type}/{operation_id}',
  });
  let durableDigest;
  const beforePreparedDispatch = async identity => {
    if (durableDigest && durableDigest !== identity.request_sha256) throw new Error('request identity changed');
    durableDigest = identity.request_sha256;
  };
  try {
    const request = { idempotency_key: 'original-key', accounts: [] };
    await agent.syncAccounts(request, undefined, { beforePreparedDispatch });
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0].push_notification_config.operation_id, 'string');
    assert.equal(durableDigest, canonicalJsonSha256(calls[0]));
    await assert.rejects(
      agent.syncAccounts(request, undefined, { beforePreparedDispatch }),
      error => error.message === 'request identity changed'
    );
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test('the prepared identity and dispatched arguments stay fixed across the callback await', async () => {
  const { agent, calls, close } = await seller();
  const request = {
    idempotency_key: 'original-key',
    accounts: [],
    ext: { apostra: { account_write: { generation: 2 } } },
  };
  let identity;
  try {
    await agent.syncAccounts(request, undefined, {
      beforePreparedDispatch: async value => {
        identity = value;
        assert.equal(Object.isFrozen(value), true);
        await Promise.resolve();
        request.ext.apostra.account_write.generation = 3;
        value.request_sha256 = '0'.repeat(64);
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ext.apostra.account_write.generation, 2);
    assert.equal(identity.request_sha256, canonicalJsonSha256(calls[0]));
  } finally {
    await close();
  }
});

test('A2A tool input has the same identity as the pre-dispatch digest', async () => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url.startsWith('/.well-known/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'account-seller',
          description: 'test seller',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          securityRequirements: [],
          supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        })
      );
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: calls.length, error: { code: -32603, message: 'test stop' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const agent = new SingleAgentClient(
      {
        id: 'account-a2a',
        name: 'Account seller',
        protocol: 'a2a',
        agent_uri: `http://127.0.0.1:${server.address().port}`,
      },
      {
        adcpVersion: ADCP_VERSION,
        validateFeatures: false,
        validation: { requests: 'off', responses: 'off' },
        webhookUrlTemplate: 'https://buyer.example/webhooks/{task_type}/{operation_id}',
      }
    );
    agent.ensureEndpointDiscovered = async () => agent.agent;
    agent.getCapabilities = async () => ({
      version: 'v3',
      majorVersions: [3],
      supportedVersions: [ADCP_VERSION],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: false,
    });
    let identity;
    const request = {
      idempotency_key: 'a2a-key',
      accounts: [],
      context: { trace_id: 'trace-a2a' },
      ext: { apostra: { account_write: { generation: 2 } } },
    };
    await assert.rejects(
      agent.syncAccounts(request, undefined, {
        transport: { allowPrivateIp: true },
        beforePreparedDispatch: async () => {
          throw new Error('digest save failed');
        },
      }),
      error => error.message === 'digest save failed'
    );
    assert.equal(calls.length, 0);
    const result = await agent.syncAccounts(request, undefined, {
      transport: { allowPrivateIp: true },
      beforePreparedDispatch: async value => {
        identity = value;
        assert.equal(calls.length, 0);
      },
    });
    assert.equal(result.success, false);
    assert.equal(calls.length, 1);
    const sent = calls[0].params.message.parts[0].data.input;
    assert.equal(identity.request_sha256, canonicalJsonSha256(sent));
    assert.ok(calls[0].params.configuration?.taskPushNotificationConfig);
    assert.notEqual(identity.request_sha256, canonicalJsonSha256(calls[0].params));
    assert.deepEqual(sent.accounts, []);
    assert.equal(typeof sent.adcp_version, 'string');
    assert.deepEqual(sent.context, { trace_id: 'trace-a2a' });
    assert.deepEqual(sent.ext.apostra.account_write, { generation: 2 });
    assert.equal(typeof sent.push_notification_config.operation_id, 'string');
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});
