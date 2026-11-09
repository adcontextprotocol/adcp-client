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

// ---------------------------------------------------------------------------
// Round two: authorization and release selection read the PARSED value, and
// every rejection on the custom-tool path echoes the caller's context.
// ---------------------------------------------------------------------------

const { createRequire } = require('node:module');
const path = require('node:path');
const { wrapSdkRequestHandler } = require('../../dist/lib/server/adcp-server');
const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome');
const { adcpError } = require('../../dist/lib/server/errors');
const wba = require('../../dist/lib/signing/web-bot-auth');
const identity = require('../../dist/lib/identity-3.3/index');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');
const { IdentityAuthorizationError } = require('../../dist/lib/identity-3.3/trust');
const wbaVector = require('../fixtures/wba-profile/positive/001-single-signer-request.json');
const wbaKeys = require('../fixtures/wba-profile/keys.json').keys;

/** An identity-established, not-onboarded principal built from a real Web Bot Auth signature. */
async function establishedPrincipal() {
  const v = wbaVector;
  const directory = new wba.SignatureDirectoryResolver({
    now: () => v.reference_now,
    allowTestKeys: true,
    fetchOptions: {
      trustedFetchFn: async url => {
        const origin = new URL(url).origin;
        const refs = v.directories?.[origin]?.keys_ref;
        if (!refs) return new Response('', { status: 404 });
        const d = await wba.createSignedSignatureDirectory(
          origin,
          wbaKeys
            .filter(k => refs.includes(k.kid))
            .map(k => ({
              privateKey: { kty: k.kty, crv: k.crv, x: k.x, kid: k.kid, d: k._private_d_for_test_only },
            })),
          { now: () => v.reference_now }
        );
        return new Response(d.body, { status: 200, headers: d.headers });
      },
    },
  });
  const signers = await wba.verifyWebBotAuth(v.request, {
    now: () => v.reference_now,
    replayStore: new InMemoryReplayStore(),
    allowTestKeys: true,
    isRevoked: async () => false,
    directory,
  });
  const lifecycle = new identity.OriginIdentityLifecycle({
    store: new identity.InMemoryOriginIdentityStore(),
    trust: new identity.TrustEvaluator({
      fetchOptions: { trustedFetchFn: async () => new Response(JSON.stringify({ agents: [] })) },
    }),
  });
  const principal = await identity.createIdentity33PrincipalResolver({ lifecycle })(signers, 'get_products');
  return {
    state: principal.extra.identity33.state,
    authInfo: { token: '', clientId: principal.principal, scopes: [], extra: principal.extra },
    authorize: identity.createIdentity33Authorization({ lifecycle, grants: {}, resolveClaims: async () => [] }),
  };
}

/** Call `get_products` (a custom tool here) as the established principal over a real MCP client. */
async function callAsEstablishedPrincipal(actionSchema, args) {
  const { authInfo, authorize, state } = await establishedPrincipal();
  assert.equal(state, 'identity-established');
  let finalized = 0;
  const server = createAdcpServer({
    name: 'auth-order',
    version: '1.0.0',
    adcpVersion: '3.3.0-beta.5',
    mcpToolProfile: 'all',
    identity33: { authorize },
    validation: { requests: 'off', responses: 'off' },
    customTools: {
      get_products: {
        inputSchema: { refine: z.object({ action: actionSchema }) },
        handler: input => {
          if (input.refine.action === 'finalize') finalized++;
          return toolResult({ finalized: true });
        },
      },
    },
  });
  const sdk = getSdkServer(server);
  wrapSdkRequestHandler(sdk, 'tools/call', (orig, req, extra) => orig(req, { ...extra, authInfo }));
  const client = await connect(server);
  const result = await client.callTool({ name: 'get_products', arguments: args });
  return { result, finalized: () => finalized };
}

describe('identity authorization runs on the PARSED value', () => {
  it('a schema default cannot change what authorization approved (.default("finalize"))', async () => {
    const { result, finalized } = await callAsEstablishedPrincipal(z.literal('finalize').default('finalize'), {
      refine: {},
      context: { trace: 'auth-default' },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.deepEqual(result.structuredContent.context, { trace: 'auth-default' });
    assert.equal(finalized(), 0, 'handler must not run');
  });

  it('a schema transform cannot change what authorization approved (trim + pipe)', async () => {
    const { result, finalized } = await callAsEstablishedPrincipal(z.string().trim().pipe(z.literal('finalize')), {
      refine: { action: 'finalize ' },
      context: { trace: 'auth-trim' },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.deepEqual(result.structuredContent.context, { trace: 'auth-trim' });
    assert.equal(finalized(), 0, 'handler must not run');
  });
});

describe('release selection reads the PARSED value', () => {
  function versionServer(schema, handlerSeen) {
    return createAdcpServer({
      name: 'versions',
      version: '1.0.0',
      adcpVersion: '3.3.0-beta.5',
      capabilities: { supported_versions: ['3.1.31', '3.3.0-beta.5'] },
      toolVersions: { probe: { max: '3.1' } },
      customTools: {
        probe: {
          inputSchema: schema,
          handler: (args, extra) => {
            handlerSeen.push({ args, served: extra.servedAdcpVersion });
            return toolResult();
          },
        },
      },
    });
  }

  it('a defaulted adcp_version selects the release and is what the handler sees', async () => {
    const seen = [];
    const client = await connect(
      versionServer({ adcp_version: z.string().default('3.1.31'), value: z.string() }, seen)
    );
    const result = await client.callTool({ name: 'probe', arguments: { value: 'ok', context: { trace: 'd' } } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(seen[0].args.adcp_version, '3.1.31');
    assert.equal(seen[0].served, '3.1');
  });

  it('a coerced adcp_version (3.1 -> "3.1") selects the release', async () => {
    const seen = [];
    const client = await connect(versionServer({ adcp_version: z.coerce.string(), value: z.string() }, seen));
    const result = await client.callTool({
      name: 'probe',
      arguments: { adcp_version: 3.1, value: 'ok', context: { trace: 'c' } },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(seen[0].args.adcp_version, '3.1');
    assert.equal(seen[0].served, '3.1');
  });

  it('a declared adcp_version the tool does not support -> VERSION_UNSUPPORTED echoing context', async () => {
    const seen = [];
    const client = await connect(versionServer({ adcp_version: z.string().optional(), value: z.string() }, seen));
    const result = await client.callTool({
      name: 'probe',
      arguments: { adcp_version: '3.3-beta.5', value: 'ok', context: { trace: 'u' } },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepEqual(result.structuredContent.adcp_error.details.supported_versions, ['3.1.31']);
    assert.deepEqual(result.structuredContent.context, { trace: 'u' });
    assert.equal(seen.length, 0);
  });

  it('an undeclared adcp_version is stripped, so the default release applies (also VERSION_UNSUPPORTED here)', async () => {
    const seen = [];
    const client = await connect(versionServer({ value: z.string() }, seen));
    const result = await client.callTool({
      name: 'probe',
      arguments: { adcp_version: '3.1', value: 'ok', context: { trace: 'x' } },
    });
    // Documented behavior: the stripped field never selects a release, so the
    // server default (3.3.0-beta.5, outside probe's max 3.1) applies.
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepEqual(result.structuredContent.context, { trace: 'x' });
    assert.equal(seen.length, 0);
  });

  it('a garbage adcp_version -> VERSION_UNSUPPORTED from release selection, context echoed', async () => {
    const seen = [];
    const client = await connect(versionServer({ adcp_version: z.string().optional(), value: z.string() }, seen));
    const result = await client.callTool({
      name: 'probe',
      arguments: { adcp_version: 'nope', value: 'ok', context: { trace: 'g' } },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'VERSION_UNSUPPORTED');
    assert.deepEqual(result.structuredContent.context, { trace: 'g' });
    assert.equal(seen.length, 0);
  });
});

describe('every custom-tool rejection echoes context, even when the schema strips it', () => {
  // `context` is deliberately NOT declared, so it is absent from the parsed args.
  const schema = { value: z.string().optional(), adcp_version: z.string().optional() };
  let mode = 'ok';
  const server = createAdcpServer({
    name: 'rejections',
    version: '1.0.0',
    adcpVersion: '3.3.0-beta.5',
    capabilities: { supported_versions: ['3.1.31', '3.3.0-beta.5'] },
    toolVersions: { restricted: { max: '3.1' } },
    validation: { requests: 'off', responses: 'off' },
    customTools: {
      restricted: { inputSchema: schema, handler: async () => toolResult() },
      open: {
        inputSchema: schema,
        handler: async args => {
          assert.ok(!('context' in args), 'schema strips context from the parsed args');
          if (mode === 'throw-adcp-error') throw new AdcpError('INVALID_REQUEST', { message: 'thrown AdcpError' });
          if (mode === 'throw-response') throw adcpError('NOT_FOUND', { message: 'thrown response' });
          if (mode === 'return-error') {
            return {
              isError: true,
              content: [{ type: 'text', text: '{}' }],
              structuredContent: { adcp_error: { code: 'NOT_FOUND', message: 'returned error' } },
            };
          }
          return toolResult();
        },
      },
    },
  });
  const ctx = { trace: 'echo-me' };
  let sharedClient;
  const cases = [
    ['validation', 'open', { value: 5 }, 'ok', 'INVALID_REQUEST'],
    ['VERSION_UNSUPPORTED (bad version)', 'open', { adcp_version: 'nope' }, 'ok', 'VERSION_UNSUPPORTED'],
    ['VERSION_UNSUPPORTED (tool not in release)', 'restricted', {}, 'ok', 'VERSION_UNSUPPORTED'],
    ['thrown AdcpError', 'open', {}, 'throw-adcp-error', 'INVALID_REQUEST'],
    ['thrown adcpError() response', 'open', {}, 'throw-response', 'NOT_FOUND'],
    ['isError response returned by the handler', 'open', {}, 'return-error', 'NOT_FOUND'],
  ];
  for (const [label, tool, args, handlerMode, code] of cases) {
    it(label, async () => {
      mode = handlerMode;
      sharedClient ??= await connect(server);
      const client = sharedClient;
      const result = await client.callTool({ name: tool, arguments: { ...args, context: ctx } });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.structuredContent.adcp_error.code, code);
      assert.deepEqual(result.structuredContent.context, ctx);
    });
  }

  it('identity authorization rejection (authorize throws IdentityAuthorizationError)', async () => {
    const identityServer = createAdcpServer({
      name: 'identity-reject',
      version: '1.0.0',
      adcpVersion: '3.3.0-beta.5',
      identity33: {
        authorize: async () => {
          throw new IdentityAuthorizationError();
        },
      },
      validation: { requests: 'off', responses: 'off' },
      customTools: { open: { inputSchema: schema, handler: async () => toolResult() } },
    });
    const client = await connect(identityServer);
    const result = await client.callTool({ name: 'open', arguments: { context: ctx } });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.deepEqual(result.structuredContent.context, ctx);
  });
});

describe('platform tools: rejection context and visibility', () => {
  function platform(resolve) {
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
      accounts: { resolve },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] }),
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
  const resolveAny = async ref => ({
    id: ref?.account_id ?? 'acc_1',
    operator: 'comply.example.com',
    ctx_metadata: {},
    authInfo: { kind: 'api_key' },
  });
  const complyTest = {
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
  };
  const build = resolve =>
    createAdcpServerFromPlatform(platform(resolve), {
      name: 'comply-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      complyTest,
    });

  it('comply_test_controller: "Invalid account_id reference" echoes context', async () => {
    const client = await connect(build(resolveAny));
    const result = await client.callTool({
      name: 'comply_test_controller',
      arguments: {
        scenario: 'force_creative_status',
        params: { creative_id: 'cr_1', status: 'approved' },
        account: { account_id: 'x', brand: { domain: 'b.example' } },
        context: { trace: 'bad-ref' },
      },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.match(result.structuredContent.adcp_error.message, /Invalid account_id reference/);
    assert.deepEqual(result.structuredContent.context, { trace: 'bad-ref' });
  });

  it('comply_test_controller: a principal that cannot see it gets MethodNotFound even with invalid args', async () => {
    const saved = process.env.ADCP_SANDBOX;
    delete process.env.ADCP_SANDBOX;
    try {
      // No principal account and no sandbox bridge: the controller is hidden.
      const client = await connect(build(async () => null));
      await assert.rejects(
        client.callTool({ name: 'comply_test_controller', arguments: { context: { trace: 'hidden' } } }),
        err => {
          assert.equal(err.code, -32601, `expected MethodNotFound, got ${err.code}: ${err.message}`);
          return true;
        }
      );
    } finally {
      if (saved === undefined) delete process.env.ADCP_SANDBOX;
      else process.env.ADCP_SANDBOX = saved;
    }
  });

  it('tasks_get returns its own error for an unknown task id, with context echoed', async () => {
    const client = await connect(build(resolveAny));
    const result = await client.callTool({
      name: 'tasks_get',
      arguments: { task_id: 'no-such-task', context: { trace: 'unknown-task' } },
    });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent.adcp_error, JSON.stringify(result.structuredContent));
    assert.notEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.deepEqual(result.structuredContent.context, { trace: 'unknown-task' });
  });
});

describe('modern adapter: declared schema Zod cannot convert', () => {
  it('a Zod v3 custom tool is advertised as exactly an empty object schema', async () => {
    const z3 = require('zod/v3');
    const { serve } = require('../../dist/lib/index.js');
    const { Client: ModernClient, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
    const httpServer = serve(
      () =>
        makeServer({
          legacy_zod: {
            description: 'zod v3 tool',
            inputSchema: { query: z3.string() },
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
      { name: 'modern-zod-v3', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`))
      );
      assert.equal(client.getProtocolEra(), 'modern');
      const tool = (await client.listTools()).tools.find(t => t.name === 'legacy_zod');
      assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
    } finally {
      await client.close().catch(() => {});
      await new Promise(resolve => httpServer.close(() => resolve()));
    }
  });
});
