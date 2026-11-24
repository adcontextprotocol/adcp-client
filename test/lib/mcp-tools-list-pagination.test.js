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
const { closeMCPConnections } = require('../../dist/lib/protocols');
const {
  MAX_TOOLS_LIST_PAGES,
  forEachMcpToolsPage,
  listAllMcpTools,
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
    const tools = await listAllMcpTools(pagedFetcher([[tool('a')], [tool('b')], [tool('c'), tool('d')]], requested));
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
    const tools = await listAllMcpTools(async cursor => {
      requested.push(cursor);
      return { tools: [tool('only')], nextCursor: '' };
    });
    assert.deepEqual(requested, [undefined]);
    assert.equal(tools.length, 1);
  });

  it('stops on a repeated cursor instead of looping', async () => {
    const requested = [];
    const tools = await listAllMcpTools(async cursor => {
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
    const tools = await listAllMcpTools(pagedFetcher(pages));
    assert.equal(tools.length, MAX_TOOLS_LIST_PAGES);
  });

  it('keeps the first definition when a tool name repeats on a later page', async () => {
    const first = { ...tool('dup'), description: 'first' };
    const second = { ...tool('dup'), description: 'second' };
    const tools = await listAllMcpTools(pagedFetcher([[first], [second, tool('other')]]));
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
    await forEachMcpToolsPage(pagedFetcher([[tool('a')], [tool('b')], [tool('c')]], requested), page => {
      seen.push(...page.map(t => t.name));
      return page.some(t => t.name === 'b');
    });
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(requested, [undefined, 'c1']);
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

describe('MCP tasks: callToolWithClient pages until it finds the called tool', () => {
  it('creates a task for a task-capable tool that sits on page 2', async t => {
    const { callMCPToolWithClient } = require('../../dist/lib/protocols/mcp-tasks.js');
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { InMemoryTaskStore } = require('../../dist/lib/server/tasks.js');
    const z = require('zod');

    // McpServer paginates nothing itself, so wrap its tools/list handler to
    // serve one tool per page while keeping its task plumbing for tools/call.
    const mcp = new McpServer(
      { name: 'paged-tasks', version: '1.0.0' },
      {
        capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
        taskStore: new InMemoryTaskStore(),
      }
    );
    mcp.registerTool('get_products', { inputSchema: { brief: z.string().optional() } }, async () => ({
      content: [{ type: 'text', text: '{}' }],
    }));
    let taskCreated = false;
    mcp.experimental.tasks.registerToolTask(
      'create_media_buy',
      {
        description: 'async',
        inputSchema: { campaign_name: z.string() },
        execution: { taskSupport: 'required' },
      },
      {
        createTask: async (_args, extra) => {
          taskCreated = true;
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

    // Intercept tools/list on the McpServer's low-level server: page the full list.
    const lowLevel = mcp.server;
    const fullListHandler = lowLevel._requestHandlers.get('tools/list');
    const listCursors = [];
    lowLevel._requestHandlers.set('tools/list', async (request, extra) => {
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

    const result = await callMCPToolWithClient(mcpClient, 'create_media_buy', { campaign_name: 'x' });

    assert.ok(taskCreated, 'the call must go through task creation, not a plain tools/call');
    assert.deepEqual(listCursors, [undefined, 'page-1'], 'paging stops at the page that holds the called tool');
    assert.ok(result, 'a result comes back');
  });
});
