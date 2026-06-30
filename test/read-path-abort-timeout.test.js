const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AgentClient } = require('../dist/lib/core/AgentClient');
const { TaskExecutor } = require('../dist/lib/core/TaskExecutor');
const { ProtocolClient } = require('../dist/lib/protocols');
const { connectMCPWithFallback } = require('../dist/lib/protocols/mcp');
const { MAX_TIMER_DELAY_MS, resolveClientRequestTimeoutMs } = require('../dist/lib/protocols/abort');
const { callMCPToolWithClient } = require('../dist/lib/protocols/mcp-tasks');
const { getOrDiscoverProfile } = require('../dist/lib/testing/client');

describe('read-path cancellation and timeout', () => {
  let server;
  let baseUrl;
  const sockets = new Set();

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
        assert.ok(err?.name === 'TimeoutError' || err?.code === -32001);
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
        connectMCPWithFallback(
          new URL('http://example.test/mcp'),
          {},
          debugLogs,
          'timeout-test',
          transportFetch,
          { requestTimeoutMs: 25 }
        ),
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
    const timeoutError = new Error('Request timed out');
    timeoutError.code = -32001;
    const client = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: true } } } }),
      listTools: async () => ({ tools: [] }),
      experimental: {
        tasks: {
          callToolStream: (_request, _unused, options) => {
            seenTimeout = options.timeout;
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
