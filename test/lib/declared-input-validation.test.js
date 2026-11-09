/**
 * adcp-client#3666: tools registered with a zod input schema (`customTools`,
 * `tasks_get`, `comply_test_controller`) validate their arguments at the AdCP
 * layer, so a rejected call returns an `INVALID_REQUEST` `adcp_error` that
 * echoes `context` instead of the MCP SDK's bare `-32602` text result.
 *
 * Wire-level cases use a real MCP Client over InMemoryTransport:
 * `dispatchTestRequest` bypasses the SDK's tools/call and tools/list handlers,
 * so it cannot prove the -32602 gap is closed.
 */

process.env.NODE_ENV = 'test';
process.env.ADCP_SANDBOX = '1'; // legacy conformance visibility bridge for complyTest

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { getSdkServer } = require('../../dist/lib/server/adcp-server');
const { registerTestController } = require('../../dist/lib/server/test-controller');
const { createComplyController } = require('../../dist/lib/testing/comply-controller');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform');

const toolResult = (structured = { ok: true }) => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structuredContent: structured,
});

const open = [];
after(async () => {
  for (const close of open) await close().catch(() => {});
});

/** Connect a real MCP client to `server` (an AdcpServer or bare McpServer). */
async function connect(server) {
  const sdk = server instanceof McpServer ? server : getSdkServer(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await sdk.connect(st);
  const client = new Client({ name: 'declared-input-test', version: '1.0.0' });
  await client.connect(ct);
  open.push(() => client.close());
  return client;
}

function makeServer(customTools) {
  return createAdcpServer({
    name: 'declared-input',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    customTools,
  });
}

async function advertised(client, name) {
  return (await client.listTools()).tools.find(t => t.name === name);
}

/** What a bare McpServer advertises for the same declared schema. */
async function bareAdvertised(name, inputSchema) {
  const bare = new McpServer({ name: 'bare', version: '1.0.0' });
  bare.registerTool(name, { inputSchema }, async () => ({ content: [] }));
  const client = await connect(bare);
  return advertised(client, name);
}

function assertInvalidRequest(result, { field, pointer, context }) {
  assert.equal(result.isError, true);
  const sc = result.structuredContent;
  assert.ok(sc, `expected structuredContent, got ${JSON.stringify(result)}`);
  assert.equal(sc.adcp_error.code, 'INVALID_REQUEST');
  assert.equal(sc.adcp_error.field, field);
  assert.equal(sc.adcp_error.issues[0].pointer, pointer);
  assert.deepEqual(sc.context, context);
  assert.equal(sc.status, 'failed');
  assert.ok(sc.adcp_version, 'adcp_version should be stamped');
  const text = result.content.find(c => c.type === 'text');
  assert.ok(text, 'text content present');
  assert.deepEqual(JSON.parse(text.text), sc, 'text content mirrors structuredContent');
}

describe('customTools: declared-input validation over MCP', () => {
  const shape = { query: z.string(), context: z.record(z.string(), z.unknown()).optional() };

  it('missing required field returns INVALID_REQUEST echoing context; handler not called', async () => {
    let calls = 0;
    const server = makeServer({
      search: {
        description: 'search',
        inputSchema: shape,
        handler: async () => {
          calls++;
          return toolResult();
        },
      },
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'search', arguments: { context: { trace: 'tr-1' } } });
    assertInvalidRequest(result, { field: 'query', pointer: '/query', context: { trace: 'tr-1' } });
    assert.equal(result.structuredContent.adcp_error.issues[0].keyword, 'required');
    assert.equal(calls, 0);
  });

  it('wrong type reports the failing path with context echoed', async () => {
    const server = makeServer({
      search: { description: 's', inputSchema: shape, handler: async () => toolResult() },
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'search', arguments: { query: 5, context: { trace: 'tr-2' } } });
    assertInvalidRequest(result, { field: 'query', pointer: '/query', context: { trace: 'tr-2' } });
  });

  for (const [label, schema] of [
    [
      'raw shape',
      {
        query: z.string(),
        limit: z.coerce.number(),
        page: z.number().default(10),
        label: z.string().transform(s => s.toUpperCase()),
      },
    ],
    [
      'z.object',
      z.object({
        query: z.string(),
        limit: z.coerce.number(),
        page: z.number().default(10),
        label: z.string().transform(s => s.toUpperCase()),
      }),
    ],
  ]) {
    it(`valid call reaches the handler with the PARSED value (${label})`, async () => {
      let seen;
      const server = makeServer({
        search: {
          description: 's',
          inputSchema: schema,
          handler: async args => {
            seen = args;
            return toolResult();
          },
        },
      });
      const client = await connect(server);
      const result = await client.callTool({
        name: 'search',
        arguments: { query: 'acme', limit: '5', label: 'abc', undeclared: 1 },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(seen, { query: 'acme', limit: 5, page: 10, label: 'ABC' });
      assert.ok(!('undeclared' in seen), 'undeclared key stripped');
    });
  }

  for (const [label, schema] of [
    ['raw shape', shape],
    ['z.object', z.object(shape)],
  ]) {
    it(`tools/list advertises the declared schema, not passthrough (${label})`, async () => {
      const server = makeServer({
        search: { description: 's', inputSchema: schema, handler: async () => toolResult() },
      });
      const client = await connect(server);
      const ours = (await advertised(client, 'search')).inputSchema;
      const bare = (await bareAdvertised('search', schema)).inputSchema;
      assert.deepEqual(ours, bare);
      assert.ok(ours.properties.query, 'query advertised');
      assert.deepEqual(ours.required, ['query']);
      assert.notDeepEqual(ours, {});
    });
  }

  it('unknown keys on a strict object each get an additionalProperties issue', async () => {
    const server = makeServer({
      strict: {
        description: 's',
        inputSchema: z.object({ a: z.string() }).strict(),
        handler: async () => toolResult(),
      },
    });
    const client = await connect(server);
    const result = await client.callTool({ name: 'strict', arguments: { a: 'x', b: 1, c: 2, context: { k: 1 } } });
    assert.equal(result.isError, true);
    const issues = result.structuredContent.adcp_error.issues;
    assert.deepEqual(
      issues.map(i => [i.pointer, i.keyword]),
      [
        ['/b', 'additionalProperties'],
        ['/c', 'additionalProperties'],
        // `context` is undeclared on this strict schema, so it is rejected too
        // (and is still echoed below).
        ['/context', 'additionalProperties'],
      ]
    );
    assert.deepEqual(result.structuredContent.context, { k: 1 });
  });
});

describe('invoke() and dispatchTestRequest() on custom tools', () => {
  function build(onCall) {
    return makeServer({
      search: {
        description: 's',
        inputSchema: { query: z.string(), limit: z.coerce.number().default(10) },
        handler: async args => {
          onCall(args);
          return toolResult();
        },
      },
    });
  }

  it('invoke: invalid args -> INVALID_REQUEST with context; handler not called', async () => {
    let calls = 0;
    const server = build(() => calls++);
    const result = await server.invoke({ toolName: 'search', args: { context: { trace: 'inv' } } });
    assertInvalidRequest(result, { field: 'query', pointer: '/query', context: { trace: 'inv' } });
    assert.equal(calls, 0);
  });

  it('invoke: valid args -> handler gets the parsed value', async () => {
    let seen;
    const server = build(a => (seen = a));
    const result = await server.invoke({ toolName: 'search', args: { query: 'q', extra: true } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(seen, { query: 'q', limit: 10 });
  });

  it('dispatchTestRequest: invalid args -> INVALID_REQUEST with context', async () => {
    let calls = 0;
    const server = build(() => calls++);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'search', arguments: { context: { trace: 'dt' } } },
    });
    assertInvalidRequest(result, { field: 'query', pointer: '/query', context: { trace: 'dt' } });
    assert.equal(calls, 0);
  });

  it('dispatchTestRequest: valid args -> handler gets the parsed value', async () => {
    let seen;
    const server = build(a => (seen = a));
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'q', limit: '3', extra: true } },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(seen, { query: 'q', limit: 3 });
  });
});

describe('comply_test_controller declared-input validation', () => {
  const store = {
    forceAccountStatus: async () => ({ success: true, previous_state: 'active', current_state: 'suspended' }),
  };

  async function bareController() {
    // registerTestController's shape, advertised by a bare server for comparison
    const bare = createAdcpServer({ name: 'x', version: '1.0.0' });
    registerTestController(bare, store);
    return bare;
  }

  const variants = [
    [
      'registerTestController',
      async () => {
        const server = createAdcpServer({ name: 'ctl', version: '1.0.0' });
        registerTestController(server, store);
        return server;
      },
    ],
    [
      'createComplyController().register on AdcpServer',
      async () => {
        const server = createAdcpServer({ name: 'ctl', version: '1.0.0' });
        createComplyController({ sandboxGate: () => true }).register(server);
        return server;
      },
    ],
    [
      'createComplyController().register on bare McpServer',
      async () => {
        const server = new McpServer({ name: 'ctl', version: '1.0.0' });
        createComplyController({ sandboxGate: () => true }).register(server);
        return server;
      },
    ],
  ];

  for (const [label, build] of variants) {
    describe(label, () => {
      it('missing scenario/account -> INVALID_REQUEST echoing context', async () => {
        const client = await connect(await build());
        const result = await client.callTool({
          name: 'comply_test_controller',
          arguments: { context: { trace: 'ctl-1' } },
        });
        assert.equal(result.isError, true, JSON.stringify(result));
        const sc = result.structuredContent;
        assert.ok(sc, JSON.stringify(result));
        assert.equal(sc.adcp_error.code, 'INVALID_REQUEST');
        assert.deepEqual(sc.context, { trace: 'ctl-1' });
        const pointers = sc.adcp_error.issues.map(i => i.pointer);
        assert.ok(pointers.includes('/scenario'), `pointers: ${pointers}`);
        assert.ok(pointers.includes('/account'), `pointers: ${pointers}`);
        assert.ok(JSON.parse(result.content.find(c => c.type === 'text').text));
      });

      it('tools/list advertises scenario and account as required', async () => {
        const client = await connect(await build());
        const tool = await advertised(client, 'comply_test_controller');
        assert.ok(tool.inputSchema.properties.scenario);
        assert.ok(tool.inputSchema.properties.account);
        assert.ok(tool.inputSchema.required.includes('scenario'));
        assert.ok(tool.inputSchema.required.includes('account'));
      });
    });
  }

  it('AdcpServer variants stamp status and adcp_version on the error', async () => {
    const server = await bareController();
    const client = await connect(server);
    const result = await client.callTool({
      name: 'comply_test_controller',
      arguments: { context: { trace: 'ctl-2' } },
    });
    assert.equal(result.structuredContent.status, 'failed');
    assert.ok(result.structuredContent.adcp_version);
  });

  it('a valid list_scenarios call still works', async () => {
    const server = createAdcpServer({ name: 'ctl', version: '1.0.0' });
    registerTestController(server, store);
    const client = await connect(server);
    const tool = await advertised(client, 'comply_test_controller');
    assert.ok(tool);
    const scope = { brand: { domain: 'acme.example' }, operator: 'op.example', sandbox: true };
    const result = await client.callTool({
      name: 'comply_test_controller',
      arguments: { scenario: 'list_scenarios', account: scope },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(Array.isArray(result.structuredContent.scenarios), JSON.stringify(result.structuredContent));
  });
});

describe('tasks_get on createAdcpServerFromPlatform', () => {
  function platform() {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
      },
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'account' }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    };
  }
  const build = () =>
    createAdcpServerFromPlatform(platform(), {
      name: 'p',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

  it('missing task_id -> INVALID_REQUEST, field task_id, context echoed', async () => {
    const client = await connect(build());
    const result = await client.callTool({ name: 'tasks_get', arguments: { context: { trace: 'tg-1' } } });
    assertInvalidRequest(result, { field: 'task_id', pointer: '/task_id', context: { trace: 'tg-1' } });
  });

  it('unknown key inside strict account -> additionalProperties at /account/<key>', async () => {
    const client = await connect(build());
    const result = await client.callTool({
      name: 'tasks_get',
      arguments: { task_id: 't1', account: { account_id: 'a1', bogus: 1 }, context: { trace: 'tg-2' } },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    const issue = result.structuredContent.adcp_error.issues.find(i => i.pointer === '/account/bogus');
    assert.ok(issue, JSON.stringify(result.structuredContent.adcp_error));
    assert.equal(issue.keyword, 'additionalProperties');
    assert.equal(result.structuredContent.adcp_error.field, 'account.bogus');
    assert.deepEqual(result.structuredContent.context, { trace: 'tg-2' });
  });

  it('tools/list advertises task_id as required', async () => {
    const client = await connect(build());
    const tool = await advertised(client, 'tasks_get');
    assert.ok(tool.inputSchema.properties.task_id);
    assert.ok(tool.inputSchema.required.includes('task_id'));
  });
});

describe('comply_test_controller via createAdcpServerFromPlatform({ complyTest })', () => {
  function platform() {
    return {
      capabilities: {
        specialisms: ['sales-non-guaranteed'],
        creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
        compliance_testing: {},
      },
      statusMappers: {},
      accounts: {
        resolve: async ref => ({
          id: ref?.account_id ?? 'comply_acc_1',
          operator: 'comply.example.com',
          ctx_metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({
          media_buy_id: 'mb_1',
          status: 'pending_creatives',
          confirmed_at: '2026-04-28T00:00:00Z',
          packages: [],
        }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({
          currency: 'USD',
          reporting_period: { start: '2026-04-01', end: '2026-04-30' },
          media_buy_deliveries: [],
        }),
      },
    };
  }
  const build = () =>
    createAdcpServerFromPlatform(platform(), {
      name: 'comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest: {
        force: {
          creative_status: async params => ({
            success: true,
            transition: 'forced',
            resource_type: 'creative',
            resource_id: params.creative_id,
            previous_state: 'pending_review',
            current_state: params.status,
          }),
        },
      },
    });

  it('invalid args -> INVALID_REQUEST echoing context once the principal can see the controller', async () => {
    const client = await connect(build());
    const result = await client.callTool({
      name: 'comply_test_controller',
      arguments: { context: { trace: 'ct-1' } },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.adcp_error.code, 'INVALID_REQUEST', JSON.stringify(result.structuredContent));
    assert.deepEqual(result.structuredContent.context, { trace: 'ct-1' });
    assert.equal(result.structuredContent.status, 'failed');
  });

  it('a valid call still reaches the adapter', async () => {
    const client = await connect(build());
    const result = await client.callTool({
      name: 'comply_test_controller',
      arguments: { scenario: 'force_creative_status', params: { creative_id: 'cr_1', status: 'approved' } },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.current_state, 'approved');
  });
});

describe('modern 2026-07-28 adapter', () => {
  it("advertises a custom tool's declared schema, not empty passthrough, and returns the context-echoing error", async () => {
    const { serve } = require('../../dist/lib/index.js');
    const { Client: ModernClient, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
    const httpServer = serve(
      () =>
        makeServer({
          search: {
            description: 's',
            inputSchema: { query: z.string(), limit: z.number().optional() },
            handler: async () => toolResult(),
          },
        }),
      { port: 0, onListening: () => {} }
    );
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      if (httpServer.listening) resolve();
      else httpServer.once('listening', resolve);
    });
    const client = new ModernClient(
      { name: 'modern-declared-input', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`))
      );
      assert.equal(client.getProtocolEra(), 'modern');
      const tool = (await client.listTools()).tools.find(t => t.name === 'search');
      assert.ok(tool.inputSchema.properties?.query, JSON.stringify(tool.inputSchema));
      assert.ok(tool.inputSchema.properties?.limit);
      assert.deepEqual(tool.inputSchema.required, ['query']);

      const result = await client.callTool({ name: 'search', arguments: { context: { trace: 'mod-1' } } });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.equal(result.structuredContent.adcp_error.field, 'query');
      assert.deepEqual(result.structuredContent.context, { trace: 'mod-1' });
    } finally {
      await client.close().catch(() => {});
      await new Promise(resolve => httpServer.close(() => resolve()));
    }
  });
});
