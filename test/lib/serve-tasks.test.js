/**
 * Integration test: MCP Tasks lifecycle over stateless HTTP via serve().
 *
 * Verifies that task creation + tasks/get works across multiple HTTP requests
 * when serve() creates a new McpServer per request but shares a task store.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

describe('serve() task store sharing', () => {
  let serve, createTaskCapableServer, registerAdcpTaskTool, taskToolResponse, InMemoryTaskStore;
  let Client, StreamableHTTPClientTransport;
  let z;

  test('setup', () => {
    const lib = require('../../dist/lib/index.js');
    serve = lib.serve;
    createTaskCapableServer = lib.createTaskCapableServer;
    registerAdcpTaskTool = lib.registerAdcpTaskTool;
    taskToolResponse = lib.taskToolResponse;
    InMemoryTaskStore = lib.InMemoryTaskStore;

    Client = require('@modelcontextprotocol/sdk/client/index.js').Client;
    StreamableHTTPClientTransport =
      require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
    z = require('zod');
  });

  test('sync tool works across stateless HTTP requests', async () => {
    const factory = ({ taskStore }) => {
      const server = createTaskCapableServer('Test Agent', '1.0.0', { taskStore });
      server.tool('get_products', { query: z.string().optional() }, async () => {
        return taskToolResponse({ products: [{ id: 'p1', name: 'Banner' }] }, 'Found 1 product');
      });
      return server;
    };

    const httpServer = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`)
      );
      const client = new Client({ name: 'Test', version: '1.0.0' });
      await client.connect(transport);

      const result = await client.callTool({ name: 'get_products', arguments: { query: 'test' } });
      assert.ok(result.structuredContent, 'Should have structuredContent');
      assert.strictEqual(result.structuredContent.products.length, 1);

      await client.close();
    } finally {
      httpServer.close();
    }
  });

  test('async task tool: task persists across stateless HTTP requests', async () => {
    const factory = ({ taskStore }) => {
      const server = createTaskCapableServer('Async Agent', '1.0.0', { taskStore });

      registerAdcpTaskTool(
        server,
        'create_media_buy',
        {
          description: 'Create a media buy (async)',
          inputSchema: { campaign_name: z.string() },
          taskSupport: 'required',
        },
        {
          createTask: async (_args, extra) => {
            const task = await extra.taskStore.createTask({ ttl: 60000 });
            // Store result immediately (simulating fast async completion)
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text', text: 'Media buy created' }],
              structuredContent: { media_buy_id: 'mb-456', status: 'active' },
            });
            return { task };
          },
          getTask: async (_args, extra) => {
            return await extra.taskStore.getTask(extra.taskId);
          },
          getTaskResult: async (_args, extra) => {
            return await extra.taskStore.getTaskResult(extra.taskId);
          },
        }
      );

      return server;
    };

    const httpServer = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`)
      );
      const client = new Client({ name: 'Test', version: '1.0.0' });
      await client.connect(transport);

      // Populate tool metadata (required for callToolStream)
      await client.listTools();

      // Use callToolStream which creates a task then polls tasks/get
      const stream = client.experimental.tasks.callToolStream(
        { name: 'create_media_buy', arguments: { campaign_name: 'Test Campaign' } },
        undefined,
        { timeout: 10000 }
      );

      const messages = [];
      for await (const msg of stream) {
        messages.push(msg);
      }

      // Should have taskCreated then result
      const taskCreated = messages.find(m => m.type === 'taskCreated');
      assert.ok(taskCreated, 'Should have taskCreated message');
      assert.ok(taskCreated.task.taskId, 'Task should have an ID');

      const result = messages.find(m => m.type === 'result');
      assert.ok(result, 'Should have result message');
      assert.strictEqual(result.result.structuredContent.media_buy_id, 'mb-456');

      await client.close();
    } finally {
      httpServer.close();
    }
  });

  test('custom taskStore in ServeOptions is used', async () => {
    const customStore = new InMemoryTaskStore();
    let factoryReceivedStore;

    const factory = ({ taskStore }) => {
      factoryReceivedStore = taskStore;
      const server = createTaskCapableServer('Custom Store Agent', '1.0.0', { taskStore });
      server.tool('ping', {}, async () => taskToolResponse({ pong: true }));
      return server;
    };

    const httpServer = serve(factory, { port: 0, taskStore: customStore, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`)
      );
      const client = new Client({ name: 'Test', version: '1.0.0' });
      await client.connect(transport);

      await client.callTool({ name: 'ping', arguments: {} });

      assert.strictEqual(factoryReceivedStore, customStore, 'Factory should receive custom taskStore');

      await client.close();
    } finally {
      httpServer.close();
    }
  });

  test('factory receives same taskStore on every request', async () => {
    const stores = [];

    const factory = ({ taskStore }) => {
      stores.push(taskStore);
      const server = createTaskCapableServer('Shared Store', '1.0.0', { taskStore });
      server.tool('ping', {}, async () => taskToolResponse({ ok: true }));
      return server;
    };

    const httpServer = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;

    try {
      // Make two separate requests (each creates a new server instance)
      for (let i = 0; i < 2; i++) {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://localhost:${port}/mcp`)
        );
        const client = new Client({ name: 'Test', version: '1.0.0' });
        await client.connect(transport);
        await client.callTool({ name: 'ping', arguments: {} });
        await client.close();
      }

      assert.ok(stores.length >= 2, 'Factory should be called at least twice');
      // Every invocation should receive the exact same taskStore reference
      for (let i = 1; i < stores.length; i++) {
        assert.strictEqual(stores[i], stores[0], `Request ${i} should receive the same taskStore`);
      }
    } finally {
      httpServer.close();
    }
  });

  test('regression #442: task created on connection A retrievable on connection B', async () => {
    const factory = ({ taskStore }) => {
      const server = createTaskCapableServer('Cross-Conn Agent', '1.0.0', { taskStore });

      registerAdcpTaskTool(
        server,
        'start_job',
        {
          description: 'Start a background job',
          inputSchema: { name: z.string() },
          taskSupport: 'required',
        },
        {
          createTask: async (_args, extra) => {
            const task = await extra.taskStore.createTask({ ttl: 60000 });
            // Store result immediately
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text', text: 'Job done' }],
              structuredContent: { job_id: 'j-789', status: 'done' },
            });
            return { task };
          },
          getTask: async (_args, extra) => {
            return await extra.taskStore.getTask(extra.taskId);
          },
          getTaskResult: async (_args, extra) => {
            return await extra.taskStore.getTaskResult(extra.taskId);
          },
        }
      );

      return server;
    };

    const httpServer = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;
    const baseUrl = new URL(`http://localhost:${port}/mcp`);

    try {
      // Connection A: create a task, capture the taskId, then disconnect
      const transportA = new StreamableHTTPClientTransport(baseUrl);
      const clientA = new Client({ name: 'ClientA', version: '1.0.0' });
      await clientA.connect(transportA);
      await clientA.listTools();

      const stream = clientA.experimental.tasks.callToolStream(
        { name: 'start_job', arguments: { name: 'test' } },
        undefined,
        { timeout: 10000 }
      );

      let capturedTaskId;
      for await (const msg of stream) {
        if (msg.type === 'taskCreated') capturedTaskId = msg.task.taskId;
      }
      assert.ok(capturedTaskId, 'Should have captured a taskId from connection A');
      await clientA.close();

      // Connection B: retrieve the task by ID on a fresh connection
      const transportB = new StreamableHTTPClientTransport(baseUrl);
      const clientB = new Client({ name: 'ClientB', version: '1.0.0' });
      await clientB.connect(transportB);

      const task = await clientB.experimental.tasks.getTask(capturedTaskId);
      assert.ok(task, 'Connection B should find the task created by connection A');
      assert.strictEqual(task.taskId, capturedTaskId);
      assert.strictEqual(task.status, 'completed');

      await clientB.close();
    } finally {
      httpServer.close();
    }
  });

  test('backward compat: no-arg factory still works', async () => {
    // Old-style factory that ignores the context argument
    let callCount = 0;
    const factory = () => {
      callCount++;
      const server = createTaskCapableServer('Legacy', '1.0.0');
      server.tool('ping', {}, async () => taskToolResponse({ ok: true }));
      return server;
    };

    const httpServer = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(httpServer);
    const port = httpServer.address().port;

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`)
      );
      const client = new Client({ name: 'Test', version: '1.0.0' });
      await client.connect(transport);

      // Should connect and call tools fine even without using the context
      const result = await client.callTool({ name: 'ping', arguments: {} });
      assert.ok(result.structuredContent);
      assert.ok(callCount >= 1, 'Factory should have been called');

      await client.close();
    } finally {
      httpServer.close();
    }
  });
});
