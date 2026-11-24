/**
 * Regression tests for adcp-client#3717.
 *
 * `SingleAgentClient.getAgentInfo()` read only the first MCP `tools/list` page.
 * Capability discovery checks for `get_adcp_capabilities` in that list, so a
 * seller that paginates with the tool on a later page read as not AdCP 3
 * (`VersionUnsupportedError`), and tools on later pages went missing.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { SingleAgentClient } = require('../../dist/lib/index.js');
const { ProtocolClient, closeMCPConnections } = require('../../dist/lib/protocols');
const { callMCPToolWithClient } = require('../../dist/lib/protocols/mcp-tasks.js');
const {
  DEFAULT_MAX_RESPONSE_BYTES,
  responseSizeLimitStorage,
  withPageResponseSizeLimit,
  withResponseSizeLimit,
} = require('../../dist/lib/protocols/responseSizeLimit.js');
const {
  MAX_TOOLS_LIST_PAGES,
  forEachMcpToolsPage,
  listAllMcpTools,
  listMcpToolCatalog,
  toolsListPageParams,
} = require('../../dist/lib/protocols/mcp-tools-list.js');

const tool = name => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } });

/** Build a page fetcher over fixed pages; page i's cursor is `c<i>`. Records requested cursors. */
function pagedFetcher(pages, requested = []) {
  return async cursor => {
    requested.push(cursor);
    const index = cursor === undefined ? 0 : Number(cursor.slice(1));
    const next = index + 1 < pages.length ? `c${index + 1}` : undefined;
    return { tools: pages[index], ...(next !== undefined && { nextCursor: next }) };
  };
}

describe('mcp-tools-list: forEachMcpToolsPage / listAllMcpTools', () => {
  it('returns the union of tools across pages and sends each cursor in order', async () => {
    const requested = [];
    const { tools, pages } = await listAllMcpTools(
      pagedFetcher([[tool('a')], [tool('b')], [tool('c'), tool('d')]], requested)
    );
    assert.equal(pages, 3);
    assert.deepEqual(
      tools.map(t => t.name),
      ['a', 'b', 'c', 'd']
    );
    assert.deepEqual(requested, [undefined, 'c1', 'c2']);
  });

  it('stops when nextCursor is absent', async () => {
    const requested = [];
    await listAllMcpTools(async cursor => {
      requested.push(cursor);
      return { tools: [tool('only')] };
    });
    assert.deepEqual(requested, [undefined]);
  });

  it('stops on an empty-string nextCursor', async () => {
    const requested = [];
    const { tools } = await listAllMcpTools(async cursor => {
      requested.push(cursor);
      return { tools: [tool('only')], nextCursor: '' };
    });
    assert.deepEqual(requested, [undefined]);
    assert.equal(tools.length, 1);
  });

  it('stops on a repeated cursor instead of looping', async () => {
    const requested = [];
    const { tools } = await listAllMcpTools(async cursor => {
      requested.push(cursor);
      // Always points at the same cursor, so page 2 repeats what page 1 returned.
      return { tools: [tool(`t${requested.length}`)], nextCursor: 'same' };
    });
    assert.deepEqual(requested, [undefined, 'same']);
    assert.deepEqual(
      tools.map(t => t.name),
      ['t1', 't2']
    );
  });

  it(`throws after ${MAX_TOOLS_LIST_PAGES} pages when the server never stops paginating`, async () => {
    let fetched = 0;
    await assert.rejects(
      () =>
        listAllMcpTools(async () => {
          fetched++;
          return { tools: [tool(`t${fetched}`)], nextCursor: `cursor-${fetched}` };
        }),
      /did not finish within 64 pages/
    );
    assert.equal(fetched, MAX_TOOLS_LIST_PAGES);
  });

  it(`reads exactly ${MAX_TOOLS_LIST_PAGES} pages when the last one ends the list`, async () => {
    const pages = Array.from({ length: MAX_TOOLS_LIST_PAGES }, (_, i) => [tool(`t${i}`)]);
    const { tools } = await listAllMcpTools(pagedFetcher(pages));
    assert.equal(tools.length, MAX_TOOLS_LIST_PAGES);
  });

  it('keeps the first definition when a tool name repeats on a later page', async () => {
    const first = { ...tool('dup'), description: 'first' };
    const second = { ...tool('dup'), description: 'second' };
    const { tools } = await listAllMcpTools(pagedFetcher([[first], [second, tool('other')]]));
    assert.deepEqual(
      tools.map(t => [t.name, t.description]),
      [
        ['dup', 'first'],
        ['other', 'other tool'],
      ]
    );
  });

  it('stops early, without fetching further pages, when onPage returns true', async () => {
    const requested = [];
    const seen = [];
    const pagesRead = await forEachMcpToolsPage(
      pagedFetcher([[tool('a')], [tool('b')], [tool('c')]], requested),
      page => {
        seen.push(...page.map(t => t.name));
        return page.some(t => t.name === 'b');
      }
    );
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(requested, [undefined, 'c1']);
    assert.equal(pagesRead, 2);
  });

  it('forEachMcpToolsPage returns the number of pages read', async () => {
    assert.equal(await forEachMcpToolsPage(pagedFetcher([[tool('a')]]), () => {}), 1);
    assert.equal(await forEachMcpToolsPage(pagedFetcher([[tool('a')], [tool('b')], [tool('c')]]), () => {}), 3);
  });

  it('listAllMcpTools returns the deduplicated union and the number of pages read', async () => {
    const { tools, pages } = await listAllMcpTools(pagedFetcher([[tool('a')], [tool('b'), tool('a')]]));
    assert.deepEqual(
      tools.map(t => t.name),
      ['a', 'b']
    );
    assert.equal(pages, 2);
  });

  describe('listMcpToolCatalog', () => {
    const PARAMS = { _meta: { adcp_version: '3.0' } };
    const OPTIONS = { timeout: 1234 };
    const PAGES = [[tool('a')], [tool('b'), tool('a')], [tool('c')]];

    /** A fake legacy client over `pages`; `log` records every call in order. */
    function fakeClient(pages, { commit = true, failOnPage } = {}) {
      const log = [];
      const result = cursor => {
        const index = cursor === undefined ? 0 : Number(cursor.slice(1));
        if (failOnPage === index) throw new Error(`page ${index} failed`);
        return { tools: pages[index], ...(index + 1 < pages.length && { nextCursor: `c${index + 1}` }) };
      };
      const client = {
        async listTools(params, options) {
          log.push({ via: 'listTools', cursor: params?.cursor, params, options });
          return result(params?.cursor);
        },
        async request(req, schema, options) {
          log.push({
            via: 'request',
            method: req.method,
            cursor: req.params?.cursor,
            params: req.params,
            options,
            schema,
          });
          return result(req.params?.cursor);
        },
        ...(commit && { cacheToolMetadata: tools => log.push({ via: 'commit', names: tools.map(t => t.name) }) }),
      };
      return { client, log };
    }

    it('fetches every page through request() and commits the deduplicated union once, at the end', async () => {
      const { client, log } = fakeClient(PAGES);
      const { tools, metadataCached } = await listMcpToolCatalog(client, PARAMS, OPTIONS);

      assert.deepEqual(
        tools.map(t => t.name),
        ['a', 'b', 'c']
      );
      assert.equal(metadataCached, true);
      assert.deepEqual(
        log.map(entry => entry.via),
        ['request', 'request', 'request', 'commit'],
        'no listTools() call (it would replace the SDK cache with one page), and the commit comes last'
      );
      assert.deepEqual(
        log.slice(0, 3).map(entry => entry.cursor),
        [undefined, 'c1', 'c2']
      );
      for (const entry of log.slice(0, 3)) {
        assert.equal(entry.method, 'tools/list');
        assert.equal(entry.options, OPTIONS);
        assert.deepEqual(entry.params._meta, PARAMS._meta, '_meta rides on every page');
        assert.ok(entry.schema, 'the result schema is passed');
      }
      assert.deepEqual(log[3].names, ['a', 'b', 'c']);
    });

    it('commits a single page once, also without listTools()', async () => {
      const { client, log } = fakeClient([[tool('a')]]);
      const { metadataCached } = await listMcpToolCatalog(client, PARAMS, OPTIONS);
      assert.equal(metadataCached, true);
      assert.deepEqual(
        log.map(entry => entry.via),
        ['request', 'commit']
      );
    });

    it('never commits when a page fails mid-read, leaving the previous cache intact', async () => {
      const { client, log } = fakeClient(PAGES, { failOnPage: 1 });
      await assert.rejects(() => listMcpToolCatalog(client, PARAMS, OPTIONS), /page 1 failed/);
      assert.deepEqual(
        log.map(entry => entry.via),
        ['request', 'request'],
        'page 1 was fetched, page 2 failed, nothing committed'
      );
    });

    it('wraps every page fetch with wrapPage', async () => {
      const { client } = fakeClient(PAGES);
      let wrapped = 0;
      await listMcpToolCatalog(client, PARAMS, OPTIONS, async fetch => {
        wrapped++;
        return fetch();
      });
      assert.equal(wrapped, 3);
    });

    describe('when the SDK has no cacheToolMetadata', () => {
      it('reads page 1 through listTools() and later pages through request(); metadataCached is false for several pages', async () => {
        const { client, log } = fakeClient(PAGES, { commit: false });
        const { tools, metadataCached } = await listMcpToolCatalog(client, PARAMS, OPTIONS);

        assert.deepEqual(
          tools.map(t => t.name),
          ['a', 'b', 'c'],
          'the tool list itself is still complete'
        );
        assert.equal(metadataCached, false);
        assert.deepEqual(
          log.map(entry => `${entry.via}:${entry.cursor}`),
          ['listTools:undefined', 'request:c1', 'request:c2'],
          'the SDK cache is left holding page 1, as it did before pagination was followed'
        );
      });

      it('is metadataCached for a single page, read through listTools() alone', async () => {
        const { client, log } = fakeClient([[tool('a')]], { commit: false });
        const { metadataCached } = await listMcpToolCatalog(client, PARAMS, OPTIONS);
        assert.equal(metadataCached, true);
        assert.deepEqual(
          log.map(entry => entry.via),
          ['listTools']
        );
      });
    });
  });

  it('toolsListPageParams adds the cursor without dropping base params', () => {
    const base = { _meta: { adcp_version: '3.0' } };
    assert.equal(toolsListPageParams(base, undefined), base);
    assert.equal(toolsListPageParams(undefined, undefined), undefined);
    assert.deepEqual(toolsListPageParams(base, 'c1'), { _meta: { adcp_version: '3.0' }, cursor: 'c1' });
    assert.deepEqual(toolsListPageParams(undefined, 'c1'), { cursor: 'c1' });
  });
});

/** In-process v1 MCP server that serves one tool per `tools/list` page. */
async function createPagedServer({ toolNames, capabilitiesTool = 'get_adcp_capabilities', tasks = false }) {
  const listRequests = [];
  const calls = [];
  const server = new Server(
    { name: 'paged-seller', version: '1.0.0' },
    { capabilities: { tools: {}, ...(tasks && { tasks: { requests: { tools: { call: {} } } } }) } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async request => {
    listRequests.push({ cursor: request.params?.cursor, meta: request.params?._meta });
    const index = request.params?.cursor === undefined ? 0 : Number(request.params.cursor.slice('page-'.length));
    const name = toolNames[index];
    return {
      tools: [{ ...tool(name), ...(tasks && { execution: { taskSupport: 'optional' } }) }],
      ...(index + 1 < toolNames.length && { nextCursor: `page-${index + 1}` }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params.name);
    if (request.params.name === capabilitiesTool) {
      const payload = {
        adcp: {
          major_versions: [3],
          supported_versions: ['3.2.1'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }
    return { content: [{ type: 'text', text: '{}' }], structuredContent: {} };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'pagination-test', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  return {
    listRequests,
    calls,
    mcpClient,
    async close() {
      await mcpClient.close();
      await server.close();
    },
  };
}

describe('SingleAgentClient.getAgentInfo() follows every tools/list page (in-process v1 client)', () => {
  const toolNames = ['sync_accounts', 'get_products', 'get_adcp_capabilities', 'create_media_buy'];

  async function setup(t) {
    const harness = await createPagedServer({ toolNames });
    t.after(() => harness.close());
    const client = new SingleAgentClient(
      {
        id: 'paged-agent',
        name: 'paged agent',
        agent_uri: 'in-process://paged-agent',
        protocol: 'mcp',
        _inProcessMcpClient: harness.mcpClient,
      },
      { validateFeatures: false }
    );
    return { harness, client };
  }

  it('returns the tools from every page', async t => {
    const { client } = await setup(t);
    const info = await client.getAgentInfo();
    assert.deepEqual(
      info.tools.map(x => x.name),
      toolNames
    );
  });

  it('sends the cursor and _meta.adcp_version on every page request', async t => {
    const { harness, client } = await setup(t);
    await client.getAgentInfo();

    assert.deepEqual(
      harness.listRequests.map(r => r.cursor),
      [undefined, 'page-1', 'page-2', 'page-3']
    );
    for (const request of harness.listRequests) {
      assert.match(
        String(request.meta?.adcp_version),
        /^3(\.\d+)?/,
        'adcp_version rides on every page, not just the first'
      );
    }
  });

  it('discovers get_adcp_capabilities on a later page instead of throwing VersionUnsupportedError', async t => {
    const { harness, client } = await setup(t);
    const capabilities = await client.getCapabilities();
    assert.deepEqual(capabilities.majorVersions, [3]);
    assert.ok(harness.calls.includes('get_adcp_capabilities'), 'discovery must call get_adcp_capabilities');
  });

  it('still throws VersionUnsupportedError when no page advertises get_adcp_capabilities', async t => {
    const harness = await createPagedServer({ toolNames: ['sync_accounts', 'get_products', 'create_media_buy'] });
    t.after(() => harness.close());
    const client = new SingleAgentClient(
      {
        id: 'no-caps-agent',
        name: 'no caps',
        agent_uri: 'in-process://no-caps-agent',
        protocol: 'mcp',
        _inProcessMcpClient: harness.mcpClient,
      },
      { validateFeatures: false }
    );
    await assert.rejects(
      () => client.getCapabilities(),
      err => err.name === 'VersionUnsupportedError'
    );
    assert.equal(harness.listRequests.length, 3, 'every page was read before concluding the tool is absent');
  });
});

describe('SingleAgentClient.getAgentInfo() follows every tools/list page (HTTP, legacy connect path)', () => {
  let server;
  let baseUrl;
  const listRequests = [];
  const toolNames = ['sync_accounts', 'get_adcp_capabilities', 'create_media_buy'];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        const msg = body ? JSON.parse(body) : null;
        const reply = result => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'paged-session' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg?.method === 'initialize') {
          return reply({
            protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'paged-http', version: '0.0.1' },
          });
        }
        if (msg?.method === 'tools/list') {
          listRequests.push({ cursor: msg.params?.cursor, meta: msg.params?._meta });
          const index = msg.params?.cursor === undefined ? 0 : Number(msg.params.cursor.slice('page-'.length));
          return reply({
            tools: [tool(toolNames[index])],
            ...(index + 1 < toolNames.length && { nextCursor: `page-${index + 1}` }),
          });
        }
        if (msg?.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        reply({});
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await closeMCPConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('returns the tools from every page and sends the cursor on later requests', async () => {
    await closeMCPConnections();
    listRequests.length = 0;

    const client = new SingleAgentClient(
      { id: 'paged-http', name: 'paged http', agent_uri: baseUrl, protocol: 'mcp' },
      { validateFeatures: false }
    );
    const info = await client.getAgentInfo();

    assert.deepEqual(
      info.tools.map(x => x.name),
      toolNames
    );
    assert.deepEqual(
      listRequests.map(r => r.cursor),
      [undefined, 'page-1', 'page-2']
    );
    for (const request of listRequests) {
      assert.match(String(request.meta?.adcp_version), /^3(\.\d+)?/);
    }
  });
});

/**
 * A tasks-capable in-process `McpServer` whose `tools/list` serves one tool per
 * page, in registration order: a required-task `create_media_buy` on page 1 and
 * a plain `get_products` on page 2 (the shape of adcp-client#3717's review
 * findings). `createdTasks()` counts task creations.
 */
async function createPagedTasksServer(t, { taskToolPage = 1, thirdPage = false } = {}) {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTaskStore } = require('../../dist/lib/server/tasks.js');
  const z = require('zod');

  const mcp = new McpServer(
    { name: 'paged-tasks', version: '1.0.0' },
    {
      capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
      taskStore: new InMemoryTaskStore(),
    }
  );
  let createdTasks = 0;
  const registerTaskTool = () =>
    mcp.experimental.tasks.registerToolTask(
      'create_media_buy',
      {
        description: 'async',
        inputSchema: { campaign_name: z.string() },
        execution: { taskSupport: 'required' },
      },
      {
        createTask: async (_args, extra) => {
          createdTasks++;
          // A short ttl: the store's expiry timer would otherwise keep the test process alive.
          const task = await extra.taskStore.createTask({ ttl: 1000 });
          await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { media_buy_id: 'mb-1', status: 'active' },
          });
          return { task };
        },
        getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
        getTaskResult: async (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
      }
    );
  const registerPlainTool = () =>
    mcp.registerTool('get_products', { inputSchema: { brief: z.string().optional() } }, async () => ({
      content: [{ type: 'text', text: '{}' }],
    }));
  if (taskToolPage === 1) {
    registerTaskTool();
    registerPlainTool();
  } else {
    registerPlainTool();
    registerTaskTool();
  }
  if (thirdPage) {
    mcp.registerTool('get_formats', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: '{}' }] }));
  }

  // McpServer does not paginate, so wrap its tools/list handler to serve one
  // tool per page while keeping its task plumbing for tools/call.
  const lowLevel = mcp.server;
  const fullListHandler = lowLevel._requestHandlers.get('tools/list');
  const listCursors = [];
  // `hold(cursor)` parks the next tools/list request for that cursor until released.
  let gate;
  lowLevel._requestHandlers.set('tools/list', async (request, extra) => {
    if (gate && request.params?.cursor === gate.cursor) {
      gate.reached();
      await gate.released;
    }
    const full = await fullListHandler(request, extra);
    const index = request.params?.cursor === undefined ? 0 : Number(request.params.cursor.slice('page-'.length));
    listCursors.push(request.params?.cursor);
    return {
      tools: [full.tools[index]],
      ...(index + 1 < full.tools.length && { nextCursor: `page-${index + 1}` }),
    };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const mcpClient = new Client({ name: 'pagination-test', version: '1.0.0' });
  await mcpClient.connect(clientTransport);
  t.after(async () => {
    await mcpClient.close();
    await mcp.close();
  });

  const agent = {
    id: 'tasks-agent',
    name: 'tasks',
    agent_uri: 'in-process://tasks',
    protocol: 'mcp',
    _inProcessMcpClient: mcpClient,
  };
  const hold = cursor => {
    let release;
    let reached;
    const held = {
      reached: new Promise(resolve => (reached = resolve)),
      release: () => release(),
    };
    gate = { cursor, reached, released: new Promise(resolve => (release = resolve)) };
    return held;
  };
  return { mcpClient, agent, listCursors, hold, createdTasks: () => createdTasks };
}

describe('MCP tasks: ensureToolsListed reads the whole catalog (callMCPToolWithClient)', () => {
  it('creates a task for a task-capable tool that sits on page 2', async t => {
    const harness = await createPagedTasksServer(t, { taskToolPage: 2 });

    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'x' });

    assert.equal(harness.createdTasks(), 1, 'the call must go through task creation, not a plain tools/call');
    assert.deepEqual(harness.listCursors, [undefined, 'page-1'], 'the whole (two-page) catalog was listed once');
  });

  it('lists the catalog once for later calls on the same client', async t => {
    const harness = await createPagedTasksServer(t);

    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'x' });
    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'y' });

    assert.equal(harness.createdTasks(), 2);
    assert.deepEqual(harness.listCursors, [undefined, 'page-1']);
  });

  it('keeps task augmentation after capability discovery re-lists a multi-page catalog on the same client', async t => {
    // Review finding 1: each v1 `listTools()` page replaces the SDK's cached
    // task metadata, so a multi-page getAgentInfo() left only the last page
    // described and a required-task tool on an earlier page lost augmentation.
    const harness = await createPagedTasksServer(t, { taskToolPage: 1 });

    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'first' });
    assert.equal(harness.createdTasks(), 1);

    const client = new SingleAgentClient(harness.agent, { validateFeatures: false });
    const info = await client.getAgentInfo();
    assert.deepEqual(info.tools.map(x => x.name).sort(), ['create_media_buy', 'get_products']);

    // Previously: "Server requires task augmentation for tool 'create_media_buy'".
    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'second' });
    assert.equal(harness.createdTasks(), 2, 'the second call must also be a task');
  });
});

describe('MCP tasks: discovery never disturbs the SDK metadata cache mid-read', () => {
  it('keeps task augmentation for concurrent calls while discovery is held on page 3, and after it fails', async t => {
    // Re-review finding 1: discovery used to page through listTools(), which
    // replaces the SDK's cached task metadata on every page. A call made while
    // discovery was between pages (or after a page failed) saw a cache holding
    // only some pages, and a required-task tool lost task augmentation.
    const harness = await createPagedTasksServer(t, { taskToolPage: 1, thirdPage: true });

    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'warm-up' });
    assert.equal(harness.createdTasks(), 1);

    const held = harness.hold('page-2');
    const controller = new AbortController();
    const client = new SingleAgentClient(harness.agent, { validateFeatures: false });
    const discovery = client.getAgentInfo({ signal: controller.signal });
    const discoveryOutcome = discovery.then(
      () => 'resolved',
      () => 'rejected'
    );
    await held.reached; // pages 1 and 2 are read; the page-3 response is held

    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'during-discovery' });
    assert.equal(harness.createdTasks(), 2, 'a call made mid-discovery must still be a task');

    controller.abort();
    held.release();
    assert.equal(await discoveryOutcome, 'rejected', 'the aborted discovery fails');

    await callMCPToolWithClient(harness.mcpClient, 'create_media_buy', { campaign_name: 'after-failed-discovery' });
    assert.equal(harness.createdTasks(), 3, 'a call after the failed discovery must still be a task');
  });
});

describe('listMcpToolCatalog without cacheToolMetadata on a real v1 client', () => {
  it('still validates a page-1 tool output after two-page discovery', async t => {
    // Re-review finding 2: with the private method hidden, the fallback must
    // leave page 1's metadata (its output validator) cached, as before pagination.
    const server = new Server({ name: 'paged-validated', version: '1.0.0' }, { capabilities: { tools: {} } });
    const valueTool = {
      ...tool('get_value'),
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    };
    const pages = [valueTool, tool('other_tool')];
    server.setRequestHandler(ListToolsRequestSchema, async request => {
      const index = request.params?.cursor === undefined ? 0 : Number(request.params.cursor.slice('page-'.length));
      return { tools: [pages[index]], ...(index + 1 < pages.length && { nextCursor: `page-${index + 1}` }) };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: '{"value":123}' }],
      structuredContent: { value: 123 },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'pagination-test', version: '1.0.0' });
    await mcpClient.connect(clientTransport);
    t.after(async () => {
      await mcpClient.close();
      await server.close();
    });

    // Hide only the private method; every other member is bound to the real client.
    const hidden = new Proxy(mcpClient, {
      get(target, prop) {
        if (prop === 'cacheToolMetadata') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const { tools, metadataCached } = await listMcpToolCatalog(hidden, {}, undefined);
    assert.deepEqual(
      tools.map(x => x.name),
      ['get_value', 'other_tool']
    );
    assert.equal(metadataCached, false);

    await assert.rejects(
      () => mcpClient.callTool({ name: 'get_value', arguments: {} }),
      /structured content|output schema/i,
      'the page-1 output validator must survive the fallback read'
    );
  });
});

describe('getAgentInfo() keeps output validators for tools on earlier pages (non-Tasks server)', () => {
  it('still rejects an output-schema violation from a page-1 tool after multi-page discovery', async t => {
    // Review finding 3: the last page listed replaced the SDK's output
    // validators, so a page-1 tool's structuredContent was no longer validated.
    const server = new Server({ name: 'paged-validated', version: '1.0.0' }, { capabilities: { tools: {} } });
    const valueTool = {
      ...tool('get_value'),
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    };
    const pages = [valueTool, tool('other_tool')];
    server.setRequestHandler(ListToolsRequestSchema, async request => {
      const index = request.params?.cursor === undefined ? 0 : Number(request.params.cursor.slice('page-'.length));
      return { tools: [pages[index]], ...(index + 1 < pages.length && { nextCursor: `page-${index + 1}` }) };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: '{"value":123}' }],
      structuredContent: { value: 123 },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'pagination-test', version: '1.0.0' });
    await mcpClient.connect(clientTransport);
    t.after(async () => {
      await mcpClient.close();
      await server.close();
    });

    const client = new SingleAgentClient(
      {
        id: 'validated-agent',
        name: 'validated',
        agent_uri: 'in-process://validated',
        protocol: 'mcp',
        _inProcessMcpClient: mcpClient,
      },
      { validateFeatures: false }
    );
    await client.getAgentInfo();

    await assert.rejects(
      () => mcpClient.callTool({ name: 'get_value', arguments: {} }),
      /structured content|output schema/i,
      'page-1 tool output must still be validated against its outputSchema'
    );
  });
});

describe('withPageResponseSizeLimit', () => {
  const slot = () => responseSizeLimitStorage.getStore();

  it('gives each page a fresh cumulative meter under the enclosing call cap', async () => {
    await withResponseSizeLimit(1000, async () => {
      const outer = slot();
      outer.streamMeter.consumed = 1500; // the enclosing call already streamed 1500 of its 2000 allowance
      const pages = [];
      for (let i = 0; i < 2; i++) await withPageResponseSizeLimit(undefined, async () => pages.push({ ...slot() }));

      for (const page of pages) {
        assert.equal(page.maxResponseBytes, 1000, 'the per-response cap is inherited');
        assert.equal(page.streamLimit, outer.streamLimit, 'the cumulative allowance is the same size');
        assert.equal(page.streamMeter.consumed, 0, 'but the meter starts at zero');
        assert.notEqual(page.streamMeter, outer.streamMeter, 'and is not the call-wide meter');
      }
      assert.notEqual(pages[0].streamMeter, pages[1].streamMeter, 'each page has its own meter');
      assert.equal(outer.streamMeter.consumed, 1500, 'the enclosing meter is untouched');
    });
  });

  it('narrows the cap like withResponseSizeLimit and never widens it', async () => {
    await withResponseSizeLimit(1000, async () => {
      await withPageResponseSizeLimit(5000, async () => assert.equal(slot().maxResponseBytes, 1000));
      await withPageResponseSizeLimit(500, async () => assert.equal(slot().maxResponseBytes, 500));
    });
  });

  it('installs the default cap when there is no enclosing scope', async () => {
    await withPageResponseSizeLimit(undefined, async () => {
      assert.equal(slot().maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
      assert.equal(slot().streamMeter.consumed, 0);
    });
  });

  it('treats 0 as an opt-out, with no meter', async () => {
    await withResponseSizeLimit(1000, async () => {
      await withPageResponseSizeLimit(0, async () => {
        assert.equal(slot().maxResponseBytes, null);
        assert.equal(slot().streamMeter, undefined);
      });
    });
  });

  it('inherits an enclosing opt-out when given undefined', async () => {
    await withResponseSizeLimit(0, async () => {
      await withPageResponseSizeLimit(undefined, async () => {
        assert.equal(slot().maxResponseBytes, null);
        assert.equal(slot().streamMeter, undefined);
      });
    });
  });
});

describe('MCP tools/list over SSE: the response-size allowance is per page', () => {
  let server;
  let baseUrl;
  const PAGE_PADDING = 50 * 1024;
  const CAP = 64 * 1024;
  const pageNames = ['sync_accounts', 'create_media_buy', 'get_products'];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          return res.end();
        }
        const msg = JSON.parse(body);
        const json = result => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'sse-pages' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') {
          return json({
            protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
            serverInfo: { name: 'sse-pages', version: '0.0.1' },
          });
        }
        if (msg.method === 'tools/list') {
          // Each page is one SSE frame: under the per-response cap, but the
          // three together exceed the call's whole cumulative SSE allowance.
          const index = msg.params?.cursor === undefined ? 0 : Number(msg.params.cursor.slice('page-'.length));
          const result = {
            tools: [{ ...tool(pageNames[index]), description: 'x'.repeat(PAGE_PADDING) }],
            ...(index + 1 < pageNames.length && { nextCursor: `page-${index + 1}` }),
          };
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sse-pages' });
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        }
        if (msg.method === 'tools/call') return json({ content: [{ type: 'text', text: 'ok' }] });
        if (msg.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        json({});
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await closeMCPConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('calls a tool whose catalog streams more SSE bytes across pages than one call may', async () => {
    await closeMCPConnections();
    // Review finding 2: every page shared the tool call's cumulative allowance
    // (2 x cap), so a multi-page catalog exhausted it before the call ran.
    const result = await ProtocolClient.callTool(
      { id: 'sse-pages', name: 'sse pages', protocol: 'mcp', agent_uri: baseUrl },
      'get_products',
      {},
      { transport: { maxResponseBytes: CAP } }
    );
    assert.ok(result, 'the call succeeds');
  });
});
