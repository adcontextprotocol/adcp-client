const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AgentClient } = require('../dist/lib/core/AgentClient');
const { TaskExecutor, TaskTimeoutError: ExecutorTaskTimeoutError } = require('../dist/lib/core/TaskExecutor');
const { TaskTimeoutError } = require('../dist/lib/errors');
const { ProtocolClient } = require('../dist/lib/protocols');
const { connectMCPWithFallback } = require('../dist/lib/protocols/mcp');
const { MAX_TIMER_DELAY_MS, resolveClientRequestTimeoutMs } = require('../dist/lib/protocols/abort');
const { callMCPToolWithClient, callMCPToolWithTasks } = require('../dist/lib/protocols/mcp-tasks');
const { getOrDiscoverProfile } = require('../dist/lib/testing/client');
const { CapabilityCache, ensureCapabilityLoaded } = require('../dist/lib/signing/client');

describe('read-path cancellation and timeout', () => {
  let server;
  let baseUrl;
  const sockets = new Set();

  it('uses one typed TaskTimeoutError across package and TaskExecutor exports', () => {
    assert.strictEqual(ExecutorTaskTimeoutError, TaskTimeoutError);
  });

  before(async () => {
    server = http.createServer((req, res) => {
      if (
        req.url === '/.well-known/agent.json' ||
        req.url === '/.well-known/agent-card.json' ||
        req.url?.startsWith('/mcp')
      ) {
        // Deliberately hold the connection open. The client-side signal or
        // timeout must reclaim the fetch rather than waiting for the server.
        req.on('close', () => {
          res.destroy();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  it('bounds A2A getAgentInfo agent-card discovery with requestTimeoutMs', async () => {
    const client = new AgentClient(
      { id: 'hanging-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { requestTimeoutMs: 25 } }
    );

    await assert.rejects(
      () => client.getAgentInfo(),
      err => {
        assert.strictEqual(err?.name, 'TimeoutError');
        assert.match(err.message, /25 ms/);
        return true;
      }
    );
  });

  it('forwards custom headers during A2A getAgentInfo agent-card discovery', async () => {
    const headerServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/agent.json' || req.url === '/.well-known/agent-card.json') {
        if (req.headers['x-adcp-tenant'] !== 'tenant-1') {
          res.writeHead(403);
          res.end('missing tenant header');
          return;
        }
        const { port } = headerServer.address();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocolVersion: '0.3.0',
            name: 'tenant-card',
            description: 'tenant scoped card',
            url: `http://127.0.0.1:${port}/rpc`,
            preferredTransport: 'JSONRPC',
            version: '1.0.0',
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            capabilities: { streaming: false, pushNotifications: false },
            skills: [{ id: 'get_products', name: 'get_products', description: 'discover', tags: ['adcp'] }],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => headerServer.listen(0, '127.0.0.1', resolve));
    const { port } = headerServer.address();

    try {
      const client = new AgentClient({
        id: 'tenant-a2a',
        agent_uri: `http://127.0.0.1:${port}`,
        protocol: 'a2a',
        name: 'test',
        headers: { 'x-adcp-tenant': 'tenant-1' },
      });

      const info = await client.getAgentInfo();
      assert.strictEqual(info.name, 'tenant-card');
      assert.ok(info.tools.some(tool => tool.name === 'get_products'));
    } finally {
      await new Promise(resolve => headerServer.close(resolve));
    }
  });

  it('lets callers abort getProducts while it is still in read-path discovery', async () => {
    const client = new AgentClient({ id: 'abort-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    await assert.rejects(
      () =>
        client.getProducts({ buying_mode: 'brief', brief: 'coffee' }, undefined, {
          signal: controller.signal,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.strictEqual(err?.name, 'AbortError');
        return true;
      }
    );
  });

  it('normalizes primitive abort reasons to AbortError', async () => {
    const client = new AgentClient({ id: 'primitive-abort-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' });
    const controller = new AbortController();
    setTimeout(() => controller.abort('cancelled'), 25);

    await assert.rejects(
      () =>
        client.getProducts({ buying_mode: 'brief', brief: 'coffee' }, undefined, {
          signal: controller.signal,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.strictEqual(err?.name, 'AbortError');
        assert.match(err.message, /cancelled/);
        return true;
      }
    );
  });

  it('normalizes Error abort reasons to AbortError', async () => {
    const client = new AgentClient({ id: 'error-abort-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled by caller')), 25);

    await assert.rejects(
      () =>
        client.getProducts({ buying_mode: 'brief', brief: 'coffee' }, undefined, {
          signal: controller.signal,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.strictEqual(err?.name, 'AbortError');
        assert.match(err.message, /cancelled by caller/);
        return true;
      }
    );
  });

  it('preserves MCP discovery timeout errors instead of generic endpoint failure', async () => {
    const client = new AgentClient(
      { id: 'hanging-mcp', agent_uri: `${baseUrl}/mcp`, protocol: 'mcp', name: 'test' },
      { transport: { requestTimeoutMs: 25 } }
    );

    await assert.rejects(
      () => client.getAgentInfo(),
      err => {
        assert.ok(err?.name === 'TimeoutError' || err?.code === -32001 || err?.code === 'REQUEST_TIMEOUT');
        assert.doesNotMatch(err.message, /Failed to discover MCP endpoint/);
        return true;
      }
    );
  });

  it('lets generic executeTask callers abort during read-path preflight', async () => {
    const client = new AgentClient({ id: 'generic-abort-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    await assert.rejects(
      () =>
        client.executeTask('get_products', { buying_mode: 'brief', brief: 'coffee' }, undefined, {
          signal: controller.signal,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.strictEqual(err?.name, 'AbortError');
        return true;
      }
    );
  });

  it('enforces TaskOptions.timeout across A2A endpoint discovery', async () => {
    const client = new AgentClient({ id: 'deadline-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' });

    await assert.rejects(
      () =>
        client.getProducts({ buying_mode: 'brief', brief: 'coffee' }, undefined, {
          timeout: 25,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.ok(err instanceof TaskTimeoutError);
        assert.strictEqual(err.timeout, 25);
        assert.strictEqual(err.code, 'TASK_TIMEOUT');
        return true;
      }
    );
  });

  it('aborts a hanging OAuth diagnostic probe after an MCP 401', async () => {
    let resolveProbeStarted;
    let resolveProbeClosed;
    const probeStarted = new Promise(resolve => {
      resolveProbeStarted = resolve;
    });
    const probeClosed = new Promise(resolve => {
      resolveProbeClosed = resolve;
    });
    const liveSockets = new Set();
    const authServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(401, { 'www-authenticate': 'Bearer realm="deadline-test"' });
        res.end();
        return;
      }
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        let method;
        try {
          method = JSON.parse(Buffer.concat(chunks).toString('utf8')).method;
        } catch {}
        if (method === 'tools/list') {
          resolveProbeStarted();
          res.on('close', () => {
            if (!res.writableEnded) resolveProbeClosed();
          });
          return;
        }
        res.writeHead(401, { 'www-authenticate': 'Bearer realm="deadline-test"' });
        res.end();
      });
    });
    authServer.on('connection', socket => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });
    await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
    const { port } = authServer.address();

    try {
      const executor = new TaskExecutor();
      await assert.rejects(
        () =>
          executor.executeTask(
            {
              id: 'deadline-mcp-auth-probe',
              agent_uri: `http://127.0.0.1:${port}`,
              protocol: 'mcp',
              name: 'test',
            },
            'custom_unauthorized',
            {},
            undefined,
            { timeout: 150, transport: { requestTimeoutMs: 0 } }
          ),
        err => err instanceof TaskTimeoutError
      );
      await Promise.race([
        probeStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('OAuth diagnostic probe did not start')), 1_000)),
      ]);
      await Promise.race([
        probeClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('OAuth diagnostic probe did not close')), 500)),
      ]);
    } finally {
      for (const socket of liveSockets) socket.destroy();
      await new Promise(resolve => authServer.close(resolve));
    }
  });

  it('enforces TaskOptions.timeout across getAdcpCapabilities MCP discovery', async () => {
    const client = new AgentClient({ id: 'deadline-mcp-caps', agent_uri: baseUrl, protocol: 'mcp', name: 'test' });

    await assert.rejects(
      () =>
        client.getAdcpCapabilities({}, undefined, {
          timeout: 25,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.ok(err instanceof TaskTimeoutError);
        assert.strictEqual(err.timeout, 25);
        return true;
      }
    );
  });

  it('preserves caller-abort semantics when cancellation beats the task deadline', async () => {
    const client = new AgentClient({ id: 'abort-before-deadline', agent_uri: baseUrl, protocol: 'a2a', name: 'test' });
    const controller = new AbortController();
    setTimeout(() => controller.abort('caller stopped'), 20);

    await assert.rejects(
      () =>
        client.getProducts({ buying_mode: 'brief', brief: 'coffee' }, undefined, {
          timeout: 200,
          signal: controller.signal,
          transport: { requestTimeoutMs: 0 },
        }),
      err => {
        assert.strictEqual(err?.name, 'AbortError');
        assert.match(err.message, /caller stopped/);
        assert.ok(!(err instanceof TaskTimeoutError));
        return true;
      }
    );
  });

  it('aborts and closes an actual A2A sendMessage request at the task deadline', async () => {
    let resolveToolStarted;
    let resolveResponseClosed;
    const toolStarted = new Promise(resolve => {
      resolveToolStarted = resolve;
    });
    const responseClosed = new Promise(resolve => {
      resolveResponseClosed = resolve;
    });
    const liveSockets = new Set();
    const a2aServer = http.createServer((req, res) => {
      if (
        req.method === 'GET' &&
        (req.url === '/.well-known/agent.json' || req.url === '/.well-known/agent-card.json')
      ) {
        const { port } = a2aServer.address();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocolVersion: '0.3.0',
            name: 'deadline-a2a',
            description: 'deadline fixture',
            url: `http://127.0.0.1:${port}/rpc`,
            preferredTransport: 'JSONRPC',
            version: '1.0.0',
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            capabilities: { streaming: false, pushNotifications: false },
            skills: [{ id: 'custom_hanging', name: 'custom_hanging', description: 'hang', tags: ['test'] }],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/rpc') {
        resolveToolStarted();
        res.on('close', () => {
          if (!res.writableEnded) resolveResponseClosed();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    a2aServer.on('connection', socket => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });
    await new Promise(resolve => a2aServer.listen(0, '127.0.0.1', resolve));
    const { port } = a2aServer.address();

    try {
      const executor = new TaskExecutor();
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'a2a-send-deadline', name: 'test', protocol: 'a2a', agent_uri: `http://127.0.0.1:${port}` },
            'custom_hanging',
            {},
            undefined,
            { timeout: 100 }
          ),
        err => err instanceof TaskTimeoutError
      );
      await Promise.race([
        toolStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('A2A tool did not start')), 1_000)),
      ]);
      await Promise.race([
        responseClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('A2A response did not close')), 500)),
      ]);
    } finally {
      for (const socket of liveSockets) socket.destroy();
      await new Promise(resolve => a2aServer.close(resolve));
    }
  });

  it('aborts and closes an actual modern MCP tool request at the task deadline', async () => {
    const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
    const { toNodeHandler } = require('@modelcontextprotocol/node');
    const { closeMCPConnections } = require('../dist/lib/protocols/mcp');
    let resolveToolStarted;
    let resolveResponseClosed;
    const toolStarted = new Promise(resolve => {
      resolveToolStarted = resolve;
    });
    const responseClosed = new Promise(resolve => {
      resolveResponseClosed = resolve;
    });
    const handler = createMcpHandler(
      () => {
        const mcp = new McpServer({ name: 'deadline-modern', version: '1.0.0' });
        mcp.registerTool('custom_hanging', { description: 'hang' }, async () => {
          resolveToolStarted();
          return new Promise(() => {});
        });
        return mcp;
      },
      { legacy: 'reject' }
    );
    const nodeHandler = toNodeHandler(handler);
    const liveSockets = new Set();
    const mcpServer = http.createServer(async (req, res) => {
      res.on('close', () => {
        if (!res.writableEnded) resolveResponseClosed();
      });
      await nodeHandler(req, res);
    });
    mcpServer.on('connection', socket => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });
    await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
    const { port } = mcpServer.address();

    try {
      const executor = new TaskExecutor();
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'modern-mcp-deadline', name: 'test', protocol: 'mcp', agent_uri: `http://127.0.0.1:${port}` },
            'custom_hanging',
            {},
            undefined,
            { timeout: 2_000 }
          ),
        err => err instanceof TaskTimeoutError
      );
      await Promise.race([
        toolStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('modern MCP tool did not start')), 5_000)),
      ]);
      await Promise.race([
        responseClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('modern MCP response did not close')), 500)),
      ]);
    } finally {
      for (const socket of liveSockets) socket.destroy();
      await Promise.race([closeMCPConnections(), new Promise(resolve => setTimeout(resolve, 1_000))]);
      await Promise.race([handler.close(), new Promise(resolve => setTimeout(resolve, 1_000))]);
      await new Promise(resolve => mcpServer.close(resolve));
    }
  });

  it('aborts and closes an actual legacy MCP fallback tool request at the task deadline', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { closeMCPConnections } = require('../dist/lib/protocols/mcp');
    let resolveToolStarted;
    let resolveResponseClosed;
    const toolStarted = new Promise(resolve => {
      resolveToolStarted = resolve;
    });
    const responseClosed = new Promise(resolve => {
      resolveResponseClosed = resolve;
    });
    const liveSockets = new Set();
    const legacyServer = http.createServer(async (req, res) => {
      let isToolRequest = false;
      res.on('close', () => {
        if (isToolRequest) resolveResponseClosed();
      });
      const mcp = new McpServer({ name: 'deadline-legacy', version: '1.0.0' });
      mcp.registerTool('custom_hanging', { description: 'hang' }, async () => {
        isToolRequest = true;
        resolveToolStarted();
        return new Promise(() => {});
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        await mcp.close();
      }
    });
    legacyServer.on('connection', socket => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });
    await new Promise(resolve => legacyServer.listen(0, '127.0.0.1', resolve));
    const { port } = legacyServer.address();

    try {
      const executor = new TaskExecutor();
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'legacy-mcp-deadline', name: 'test', protocol: 'mcp', agent_uri: `http://127.0.0.1:${port}` },
            'custom_hanging',
            {},
            undefined,
            { timeout: 2_000 }
          ),
        err => err instanceof TaskTimeoutError
      );
      await Promise.race([
        toolStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('legacy MCP tool did not start')), 5_000)),
      ]);
      await Promise.race([
        responseClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('legacy MCP response did not close')), 500)),
      ]);
    } finally {
      for (const socket of liveSockets) socket.destroy();
      await Promise.race([closeMCPConnections(), new Promise(resolve => setTimeout(resolve, 1_000))]);
      await new Promise(resolve => legacyServer.close(resolve));
    }
  });

  it('keeps legacy MCP Tasks progress alive beyond requestTimeoutMs', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { InMemoryTaskStore } = require('../dist/lib/server/tasks.js');
    const { closeMCPConnections } = require('../dist/lib/protocols/mcp');
    const taskStore = new InMemoryTaskStore();
    const liveSockets = new Set();
    const progressServer = http.createServer(async (req, res) => {
      const mcp = new McpServer(
        { name: 'progress-legacy', version: '1.0.0' },
        {
          capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
          taskStore,
        }
      );
      mcp.experimental.tasks.registerToolTask(
        'custom_progress_task',
        {
          description: 'complete after several progress polls',
          inputSchema: {},
          execution: { taskSupport: 'required' },
        },
        {
          createTask: async (_args, extra) => {
            const task = await extra.taskStore.createTask({ ttl: 60_000, pollInterval: 20 });
            setTimeout(() => {
              taskStore.storeTaskResult(task.taskId, 'completed', {
                content: [{ type: 'text', text: 'done' }],
                structuredContent: { status: 'completed', ok: true },
              });
            }, 600);
            return { task };
          },
          getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
          getTaskResult: async (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
        }
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        await mcp.close();
      }
    });
    progressServer.on('connection', socket => {
      liveSockets.add(socket);
      socket.on('close', () => liveSockets.delete(socket));
    });
    await new Promise(resolve => progressServer.listen(0, '127.0.0.1', resolve));
    const { port } = progressServer.address();

    try {
      const startedAt = Date.now();
      const result = await callMCPToolWithTasks(
        `http://127.0.0.1:${port}`,
        'custom_progress_task',
        {},
        undefined,
        [],
        undefined,
        { requestTimeoutMs: 250, workingTimeout: 2_000 }
      );
      assert.ok(Date.now() - startedAt > 400, 'task should outlive the one-shot request timeout');
      assert.strictEqual(result.structuredContent.status, 'completed');
      assert.strictEqual(result.structuredContent.ok, true);
    } finally {
      for (const socket of liveSockets) socket.destroy();
      await Promise.race([closeMCPConnections(), new Promise(resolve => setTimeout(resolve, 1_000))]);
      await new Promise(resolve => progressServer.close(resolve));
    }
  });

  it('rejects invalid requestTimeoutMs values instead of treating them as disabled', async () => {
    const client = new AgentClient(
      { id: 'invalid-timeout-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { requestTimeoutMs: -1 } }
    );

    await assert.rejects(
      () => client.getAgentInfo(),
      err => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /requestTimeoutMs/);
        return true;
      }
    );
  });

  it('rejects requestTimeoutMs values above the platform timer cap', async () => {
    const client = new AgentClient(
      { id: 'too-large-timeout-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { requestTimeoutMs: MAX_TIMER_DELAY_MS + 1 } }
    );

    await assert.rejects(
      () => client.getAgentInfo(),
      err => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /requestTimeoutMs/);
        return true;
      }
    );
  });

  it('does not retry or fall back to SSE after an MCP connect timeout', async () => {
    const debugLogs = [];
    const transportFetch = async (_input, init = {}) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };

    await assert.rejects(
      () =>
        connectMCPWithFallback(new URL('http://example.test/mcp'), {}, debugLogs, 'timeout-test', transportFetch, {
          requestTimeoutMs: 25,
        }),
      err => {
        assert.ok(err?.name === 'TimeoutError' || err?.code === -32001);
        return true;
      }
    );
    assert.ok(!debugLogs.some(log => /retry|Falling back to SSE/i.test(log.message)));
  });

  it('keeps MCP Tasks stream timeout pollable after a task id is captured', async () => {
    const timeoutError = new Error('Request timed out');
    timeoutError.code = -32001;
    const client = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: true } } } }),
      listTools: async () => ({ tools: [] }),
      experimental: {
        tasks: {
          callToolStream: async function* () {
            yield { type: 'taskCreated', task: { taskId: 'task-1', status: 'working', pollInterval: 123 } };
            throw timeoutError;
          },
        },
      },
    };

    const response = await callMCPToolWithClient(client, 'get_products', {}, [], { workingTimeout: 1 });

    assert.deepStrictEqual(response.structuredContent, {
      status: 'working',
      task_id: 'task-1',
      poll_interval: 123,
    });
  });

  it('passes requestTimeoutMs to MCP Tasks before a task id is captured', async () => {
    let seenTimeout;
    let seenMaxTotalTimeout;
    const timeoutError = new Error('Request timed out');
    timeoutError.code = -32001;
    const client = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: true } } } }),
      listTools: async () => ({ tools: [] }),
      experimental: {
        tasks: {
          callToolStream: (_request, _unused, options) => {
            seenTimeout = options.timeout;
            seenMaxTotalTimeout = options.maxTotalTimeout;
            return (async function* () {
              throw timeoutError;
            })();
          },
        },
      },
    };

    await assert.rejects(() =>
      callMCPToolWithClient(client, 'get_products', {}, [], { workingTimeout: 120000, requestTimeoutMs: 25 })
    );
    assert.strictEqual(seenTimeout, 25);
    assert.strictEqual(seenMaxTotalTimeout, undefined);
  });

  it('keeps TaskOptions.timeout absolute while MCP Tasks emits continuous progress', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let progressCount = 0;
    let transportObservedAbort = false;
    let resolveAbortObserved;
    const abortObserved = new Promise(resolve => {
      resolveAbortObserved = resolve;
    });
    const client = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: true } } } }),
      listTools: async () => ({ tools: [] }),
      experimental: {
        tasks: {
          callToolStream: (_request, _unused, options) =>
            (async function* () {
              yield { type: 'taskCreated', task: { taskId: 'chatty-task', status: 'working' } };
              while (true) {
                await new Promise(resolve => setImmediate(resolve));
                if (options.signal?.aborted) {
                  transportObservedAbort = true;
                  resolveAbortObserved();
                  throw options.signal.reason;
                }
                progressCount += 1;
                yield { type: 'taskStatus', task: { taskId: 'chatty-task', status: 'working' } };
              }
            })(),
        },
      },
    };

    ProtocolClient.callTool = (_agent, toolName, params, options) =>
      callMCPToolWithClient(client, toolName, params, [], {
        workingTimeout: 1_000,
        signal: options.signal,
      });

    try {
      const executor = new TaskExecutor({ workingTimeout: 1_000 });
      const startedAt = Date.now();
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'chatty-mcp', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'custom_chatty_task',
            {},
            undefined,
            { timeout: 100 }
          ),
        err => {
          assert.ok(err instanceof TaskTimeoutError);
          assert.strictEqual(err.timeout, 100);
          return true;
        }
      );
      assert.ok(Date.now() - startedAt < 2_000, 'deadline should not reset on progress');
      assert.ok(progressCount > 1, 'test stream should emit repeated progress');
      await Promise.race([
        abortObserved,
        new Promise((_, reject) => setTimeout(() => reject(new Error('transport did not observe abort')), 500)),
      ]);
      assert.strictEqual(transportObservedAbort, true);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('compacts active task state when underlying work ignores cancellation', async () => {
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async () => new Promise(() => {});

    try {
      const executor = new TaskExecutor();
      let timeoutError;
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'ignored-cancel', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'custom_never_settles',
            { private_payload: 'must-be-released' },
            undefined,
            { timeout: 25 }
          ),
        err => {
          timeoutError = err;
          return err instanceof TaskTimeoutError;
        }
      );

      const retained = executor.getActiveTasks().find(task => task.taskId === timeoutError.taskId);
      assert.ok(retained, 'terminal metadata remains briefly inspectable');
      assert.strictEqual(retained.status, 'aborted');
      assert.strictEqual(retained.params, undefined);
      assert.deepStrictEqual(retained.messages, []);
      assert.deepStrictEqual(retained.options, {});
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('does not resurrect an aborted task when cancellation-ignoring work resolves late', async () => {
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { structuredContent: { status: 'completed', ok: true } };
    };
    const statuses = [];

    try {
      const executor = new TaskExecutor({
        onActivity: activity => {
          if (activity.type === 'status_change') statuses.push(activity.status);
        },
      });
      let timeoutError;
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'late-result', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'custom_late_result',
            {},
            undefined,
            { timeout: 20 }
          ),
        err => {
          timeoutError = err;
          return err instanceof TaskTimeoutError;
        }
      );
      await new Promise(resolve => setTimeout(resolve, 80));

      const retained = executor.getActiveTasks().find(task => task.taskId === timeoutError.taskId);
      assert.strictEqual(retained?.status, 'aborted');
      assert.strictEqual(statuses.includes('completed'), false);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('does not persist a late deferral after the absolute deadline', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const stored = new Map();
    ProtocolClient.callTool = async () => ({
      result: {
        kind: 'task',
        id: 'late-deferral-seller-task',
        contextId: 'late-deferral-context',
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            messageId: 'late-deferral-question',
            role: 'agent',
            parts: [{ kind: 'data', data: { question: 'Defer this?', field: 'approval' } }],
          },
        },
        artifacts: [],
      },
    });

    try {
      const executor = new TaskExecutor({
        deferredStorage: {
          set: async (token, value) => stored.set(token, value),
          get: async token => stored.get(token),
          delete: async token => stored.delete(token),
          has: async token => stored.has(token),
        },
      });
      const slowHandler = async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return { defer: true, token: 'late-token' };
      };

      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'late-deferral', name: 'test', protocol: 'a2a', agent_uri: 'http://example.test/a2a' },
            'custom_input_task',
            { secret_payload: 'must-not-be-retained' },
            slowHandler,
            { timeout: 20 }
          ),
        err => err instanceof TaskTimeoutError
      );
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.strictEqual(stored.size, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('clears the task deadline after a fast successful call', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let receivedSignal;
    let receivedLateAbort = false;
    const caller = new AbortController();
    const callerSignal = caller.signal;
    const originalAddEventListener = callerSignal.addEventListener.bind(callerSignal);
    const originalRemoveEventListener = callerSignal.removeEventListener.bind(callerSignal);
    let callerAbortListenersAdded = 0;
    let callerAbortListenersRemoved = 0;
    callerSignal.addEventListener = (type, listener, options) => {
      if (type === 'abort') callerAbortListenersAdded += 1;
      return originalAddEventListener(type, listener, options);
    };
    callerSignal.removeEventListener = (type, listener, options) => {
      if (type === 'abort') callerAbortListenersRemoved += 1;
      return originalRemoveEventListener(type, listener, options);
    };
    ProtocolClient.callTool = async (_agent, _toolName, _params, options) => {
      receivedSignal = options.signal;
      options.signal?.addEventListener('abort', () => {
        receivedLateAbort = true;
      });
      return { structuredContent: { status: 'completed', ok: true } };
    };

    try {
      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        { id: 'fast-mcp', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
        'custom_fast_task',
        {},
        undefined,
        { timeout: 20, signal: callerSignal }
      );
      assert.strictEqual(result.status, 'completed');
      assert.ok(receivedSignal);
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.strictEqual(receivedLateAbort, false);
      assert.strictEqual(receivedSignal.aborted, false);
      assert.strictEqual(callerAbortListenersAdded, callerAbortListenersRemoved);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('treats TaskOptions.timeout 0 as disabled while preserving cancellation', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls += 1;
      return { structuredContent: { status: 'completed', ok: true } };
    };

    try {
      const executor = new TaskExecutor();
      const agent = { id: 'zero-timeout', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' };
      const result = await executor.executeTask(agent, 'custom_fast_task', {}, undefined, { timeout: 0 });
      assert.strictEqual(result.status, 'completed');

      const controller = new AbortController();
      controller.abort('already cancelled');
      await assert.rejects(
        () => executor.executeTask(agent, 'custom_fast_task', {}, undefined, { timeout: 0, signal: controller.signal }),
        err => err?.name === 'AbortError' && /already cancelled/.test(err.message)
      );
      assert.strictEqual(calls, 1, 'pre-aborted zero-timeout call must not dispatch');
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('aborts governance preflight at the absolute deadline', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let governanceSignal;
    let resolveGovernanceAbort;
    const governanceAbort = new Promise(resolve => {
      resolveGovernanceAbort = resolve;
    });
    ProtocolClient.callTool = async (_agent, toolName, _params, options) => {
      assert.strictEqual(toolName, 'check_governance');
      governanceSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            resolveGovernanceAbort();
            reject(options.signal.reason);
          },
          { once: true }
        );
      });
    };

    try {
      const executor = new TaskExecutor({
        governance: {
          campaign: {
            agent: { id: 'governance', name: 'governance', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            planId: 'plan-1',
            callerUrl: 'https://buyer.example',
          },
        },
      });
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'seller', name: 'seller', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'create_media_buy',
            {},
            undefined,
            { timeout: 30 },
            undefined,
            {
              experimental_features: ['governance.campaign'],
              adcp: { governance_enforcement: { tasks: [{ task: 'create_media_buy', modes: ['signed_context'] }] } },
            }
          ),
        err => err instanceof TaskTimeoutError
      );
      await Promise.race([
        governanceAbort,
        new Promise((_, reject) => setTimeout(() => reject(new Error('governance did not observe abort')), 500)),
      ]);
      assert.strictEqual(governanceSignal.aborted, true);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('exposes governance postflight retry identity on deadline errors', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const outcomeRequests = [];
    const statuses = [];
    ProtocolClient.callTool = async (_agent, toolName, params) => {
      if (toolName === 'check_governance') {
        return {
          structuredContent: {
            check_id: 'check-recovery-1',
            check_type: 'intent',
            verdict: 'approved',
            explanation: 'Approved',
            governance_context: 'governance-context-1',
            expires_at: '2026-08-18T12:00:00Z',
          },
        };
      }
      if (toolName === 'report_plan_outcome') {
        outcomeRequests.push(params);
        if (outcomeRequests.length === 1) return new Promise(() => {});
        return { structuredContent: { outcome_id: 'outcome-1', outcome_state: 'accepted' } };
      }
      return { structuredContent: { status: 'completed', ok: true } };
    };

    try {
      const executor = new TaskExecutor({
        onActivity: activity => {
          if (activity.type === 'status_change') statuses.push(activity.status);
        },
        governance: {
          campaign: {
            agent: { id: 'governance', name: 'governance', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            planId: 'plan-1',
            callerUrl: 'https://buyer.example',
          },
        },
      });
      let recovery;
      let timeoutError;
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'seller', name: 'seller', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'custom_governed_mutation',
            {},
            undefined,
            { timeout: 30 },
            undefined,
            {
              experimental_features: ['governance.campaign'],
              adcp: {
                governance_enforcement: {
                  tasks: [{ task: 'custom_governed_mutation', modes: ['signed_context'] }],
                },
              },
            }
          ),
        err => {
          assert.ok(err instanceof TaskTimeoutError);
          timeoutError = err;
          recovery = err.governanceRecovery;
          return true;
        }
      );

      assert.deepStrictEqual(recovery, {
        checkId: 'check-recovery-1',
        outcome: 'completed',
        outcomeIdempotencyKey: outcomeRequests[0].idempotency_key,
      });
      assert.strictEqual(statuses.includes('aborted'), false);
      assert.strictEqual(
        executor.getActiveTasks().find(task => task.taskId === timeoutError?.taskId)?.status,
        'completed'
      );
      const middleware = executor.getGovernanceMiddleware();
      const retried = await middleware.reportOutcome(
        recovery.checkId,
        recovery.outcome,
        { status: 'completed', ok: true },
        undefined,
        [],
        'governance-context-1',
        undefined,
        recovery.outcomeIdempotencyKey
      );
      assert.strictEqual(retried.status, 'accepted');
      assert.strictEqual(outcomeRequests[1].idempotency_key, recovery.outcomeIdempotencyKey);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('preserves the governance check id when response processing exceeds the deadline', async () => {
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agent, toolName) => {
      if (toolName === 'check_governance') {
        return {
          structuredContent: {
            check_id: 'check-before-response-processing',
            check_type: 'intent',
            verdict: 'approved',
            explanation: 'Approved',
            governance_context: 'governance-context-2',
            expires_at: '2026-08-18T12:00:00Z',
          },
        };
      }
      return { structuredContent: { status: 'completed', ok: true } };
    };

    try {
      const executor = new TaskExecutor({
        onActivity: async activity => {
          if (activity.type === 'protocol_response') {
            await new Promise(resolve => setTimeout(resolve, 60));
          }
        },
        governance: {
          campaign: {
            agent: { id: 'governance', name: 'governance', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            planId: 'plan-1',
            callerUrl: 'https://buyer.example',
          },
        },
      });

      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'seller', name: 'seller', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'custom_governed_mutation',
            {},
            undefined,
            { timeout: 20 },
            undefined,
            {
              experimental_features: ['governance.campaign'],
              adcp: {
                governance_enforcement: {
                  tasks: [{ task: 'custom_governed_mutation', modes: ['signed_context'] }],
                },
              },
            }
          ),
        err => {
          assert.ok(err instanceof TaskTimeoutError);
          assert.deepStrictEqual(err.governanceRecovery, { checkId: 'check-before-response-processing' });
          return true;
        }
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('attaches idempotency keys to TaskOptions deadline errors', async () => {
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agent, _toolName, _params, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });

    try {
      const executor = new TaskExecutor();
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'deadline-mutating', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'create_media_buy',
            { buyer_ref: 'buyer-1', packages: [] },
            undefined,
            { timeout: 25 }
          ),
        err => {
          assert.ok(err instanceof TaskTimeoutError);
          assert.match(err.taskId, /^[0-9a-f-]{36}$/);
          assert.ok(err.idempotency_key);
          assert.strictEqual(err.idempotencyKey, err.idempotency_key);
          return true;
        }
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('attaches generated idempotency keys to mutating timeout errors', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const timeoutError = new Error('Request timed out');
    timeoutError.name = 'TimeoutError';
    ProtocolClient.callTool = async () => {
      throw timeoutError;
    };

    try {
      const executor = new TaskExecutor();
      await assert.rejects(
        () =>
          executor.executeTask(
            { id: 'timeout-mutating', name: 'test', protocol: 'mcp', agent_uri: 'http://example.test/mcp' },
            'create_media_buy',
            { buyer_ref: 'buyer-1', packages: [] }
          ),
        err => {
          assert.strictEqual(err.name, 'TimeoutError');
          assert.ok(err.idempotency_key);
          assert.strictEqual(err.idempotencyKey, err.idempotency_key);
          return true;
        }
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  it('does not negative-cache request-signing capability after timeout', async () => {
    const cache = new CapabilityCache();
    const capabilityCacheKey = 'agent::sig=test';
    const signingContext = {
      cache,
      capabilityCacheKey,
      getCapability: () => cache.get(capabilityCacheKey),
      invalidate: () => cache.invalidate(capabilityCacheKey),
    };
    const timeoutError = new Error('Request timed out');
    timeoutError.name = 'TimeoutError';

    await assert.rejects(
      () => ensureCapabilityLoaded({}, signingContext, async () => Promise.reject(timeoutError)),
      err => err === timeoutError
    );
    assert.strictEqual(cache.get(capabilityCacheKey), undefined);

    const recovered = await ensureCapabilityLoaded({}, signingContext, async () => ({
      request_signing: { required_for: ['create_media_buy'] },
      adcp: { major_versions: [3] },
    }));

    assert.deepStrictEqual(recovered.requestSigning, { required_for: ['create_media_buy'] });
    assert.strictEqual(cache.get(capabilityCacheKey), recovered);
  });

  it('forwards getOrDiscoverProfile signal into profile discovery', async () => {
    const controller = new AbortController();
    let receivedSignal;
    const client = {
      getAgentInfo: async options => {
        receivedSignal = options?.signal;
        return { name: 'stub-agent', tools: [] };
      },
    };

    const { profile } = await getOrDiscoverProfile(client, { signal: controller.signal });

    assert.strictEqual(receivedSignal, controller.signal);
    assert.strictEqual(profile.name, 'stub-agent');
  });

  it('maps requestTimeoutMs 0 to the MCP client timeout disable sentinel', () => {
    assert.strictEqual(resolveClientRequestTimeoutMs(0), MAX_TIMER_DELAY_MS);
  });
});
