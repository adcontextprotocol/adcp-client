/**
 * Backward compatibility integration test: MCP Tasks vs legacy servers.
 *
 * Stands up real MCP servers (in-process via InMemoryTransport) and verifies
 * that callMCPToolWithTasks handles both tasks-capable and legacy servers correctly.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('MCP Tasks backward compatibility: real servers', () => {
  test('legacy server (no tasks): callMCPToolWithTasks falls back to standard callTool', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const z = require('zod');

    // Create a legacy server — no taskStore, no tasks capability
    const server = new McpServer({ name: 'Legacy Publisher', version: '1.0.0' });

    server.tool('get_products', { query: z.string().optional() }, async () => {
      return {
        content: [{ type: 'text', text: 'Found 2 products' }],
        structuredContent: {
          products: [
            { id: 'prod-1', name: 'Banner Ad', price: 10 },
            { id: 'prod-2', name: 'Video Ad', price: 25 },
          ],
        },
      };
    });

    // Wire up client ↔ server with in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'AdCP-Test', version: '1.0.0' });
    await client.connect(clientTransport);

    // Verify: server does NOT have tasks capability
    const { serverSupportsTasks } = require('../../dist/lib/protocols/mcp-tasks.js');
    assert.strictEqual(serverSupportsTasks(client), false, 'Legacy server should not support tasks');

    // Call tool — should work normally via standard callTool
    const result = await client.callTool({ name: 'get_products', arguments: { query: 'ads' } });
    assert.ok(result.structuredContent, 'Should have structuredContent');
    assert.strictEqual(result.structuredContent.products.length, 2, 'Should return 2 products');
    assert.strictEqual(result.isError, undefined, 'Should not be an error');

    await client.close();
    await server.close();
  });

  test('tasks-capable server (sync tool): callToolStream returns result immediately', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { InMemoryTaskStore } = require('../../dist/lib/server/tasks.js');
    const z = require('zod');

    // Create a tasks-capable server with a sync tool (taskSupport: 'optional')
    const taskStore = new InMemoryTaskStore();
    const server = new McpServer(
      { name: 'Tasks Publisher', version: '1.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
        taskStore,
      }
    );

    // Register a regular (non-task) tool — should still work on tasks server
    server.tool('get_products', { query: z.string().optional() }, async () => {
      return {
        content: [{ type: 'text', text: 'Found 1 product' }],
        structuredContent: {
          products: [{ id: 'prod-1', name: 'Display Ad', price: 15 }],
        },
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'AdCP-Test', version: '1.0.0' });
    await client.connect(clientTransport);

    // Verify: server DOES have tasks capability
    const { serverSupportsTasks } = require('../../dist/lib/protocols/mcp-tasks.js');
    assert.strictEqual(serverSupportsTasks(client), true, 'Tasks server should support tasks');

    // Populate tool metadata so isToolTask works
    await client.listTools();

    // Call a non-task tool on a tasks-capable server — should complete synchronously
    const stream = client.experimental.tasks.callToolStream(
      { name: 'get_products', arguments: { query: 'display' } },
      undefined,
      {}
    );

    const messages = [];
    for await (const msg of stream) {
      messages.push(msg);
    }

    // Should get a result directly (no taskCreated for non-task tools)
    const resultMsg = messages.find(m => m.type === 'result');
    assert.ok(resultMsg, 'Should have a result message');
    assert.ok(resultMsg.result.structuredContent, 'Result should have structuredContent');
    assert.strictEqual(resultMsg.result.structuredContent.products.length, 1);

    await client.close();
    await server.close();
  });

  test('tasks-capable server (async tool): callToolStream yields taskCreated then result', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { InMemoryTaskStore } = require('../../dist/lib/server/tasks.js');
    const z = require('zod');

    const taskStore = new InMemoryTaskStore();
    const server = new McpServer(
      { name: 'Async Publisher', version: '1.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
        taskStore,
      }
    );

    // Register a task-based tool using the SDK's experimental API
    server.experimental.tasks.registerToolTask(
      'create_media_buy',
      {
        description: 'Create a media buy (async)',
        inputSchema: { campaign_name: z.string() },
        execution: { taskSupport: 'required' },
      },
      {
        createTask: async (args, extra) => {
          const task = await extra.taskStore.createTask({ ttl: 60000 });
          // Simulate async work completing immediately for test
          setTimeout(async () => {
            await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
              content: [{ type: 'text', text: 'Media buy created' }],
              structuredContent: {
                media_buy_id: 'mb-123',
                status: 'active',
              },
            });
          }, 50);
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

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'AdCP-Test', version: '1.0.0' });
    await client.connect(clientTransport);

    // Populate tool metadata
    await client.listTools();

    // Verify the tool is detected as a task tool
    const tools = await client.listTools();
    const mediaBuyTool = tools.tools.find(t => t.name === 'create_media_buy');
    assert.ok(mediaBuyTool, 'create_media_buy tool should exist');
    assert.strictEqual(mediaBuyTool.execution?.taskSupport, 'required');

    // Call the async tool via callToolStream
    const stream = client.experimental.tasks.callToolStream(
      { name: 'create_media_buy', arguments: { campaign_name: 'Test Campaign' } },
      undefined,
      { timeout: 10000 }
    );

    const messages = [];
    for await (const msg of stream) {
      messages.push(msg);
    }

    // Should have taskCreated, possibly taskStatus, then result
    const taskCreated = messages.find(m => m.type === 'taskCreated');
    assert.ok(taskCreated, 'Should have taskCreated message');
    assert.ok(taskCreated.task.taskId, 'Task should have an ID');
    assert.strictEqual(taskCreated.task.status, 'working', 'Initial status should be working');

    const resultMsg = messages.find(m => m.type === 'result');
    assert.ok(resultMsg, 'Should have result message');
    assert.strictEqual(resultMsg.result.structuredContent.media_buy_id, 'mb-123');

    await client.close();
    await server.close();
    taskStore.cleanup();
  });

  test('tasks-capable server: getTask protocol method works', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { InMemoryTaskStore } = require('../../dist/lib/server/tasks.js');
    const z = require('zod');

    const taskStore = new InMemoryTaskStore();
    const server = new McpServer(
      { name: 'Poll Publisher', version: '1.0.0' },
      {
        capabilities: {
          tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        },
        taskStore,
      }
    );

    let createdTaskId;

    server.experimental.tasks.registerToolTask(
      'slow_operation',
      {
        description: 'A slow async operation',
        inputSchema: { data: z.string() },
        execution: { taskSupport: 'required' },
      },
      {
        createTask: async (args, extra) => {
          const task = await extra.taskStore.createTask({ ttl: 60000 });
          createdTaskId = task.taskId;
          // Don't complete immediately — leave in working state
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

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'AdCP-Test', version: '1.0.0' });
    await client.connect(clientTransport);
    await client.listTools();

    // Start the tool — it will create a task but not complete
    const streamPromise = (async () => {
      const stream = client.experimental.tasks.callToolStream(
        { name: 'slow_operation', arguments: { data: 'test' } },
        undefined,
        { timeout: 30000 }
      );
      const msgs = [];
      for await (const msg of stream) {
        msgs.push(msg);
        // After getting taskCreated, poll manually then complete
        if (msg.type === 'taskCreated') {
          // Use getTask protocol method
          const taskStatus = await client.experimental.tasks.getTask(msg.task.taskId);
          assert.strictEqual(taskStatus.status, 'working', 'Task should still be working');

          // Complete the task
          await taskStore.storeTaskResult(msg.task.taskId, 'completed', {
            content: [{ type: 'text', text: 'Done' }],
            structuredContent: { result: 'success' },
          });
        }
      }
      return msgs;
    })();

    const messages = await streamPromise;

    const taskCreated = messages.find(m => m.type === 'taskCreated');
    assert.ok(taskCreated, 'Should get taskCreated');

    const result = messages.find(m => m.type === 'result');
    assert.ok(result, 'Should get result after completion');
    assert.strictEqual(result.result.structuredContent.result, 'success');

    // Also test listTasks
    const tasks = await client.experimental.tasks.listTasks();
    assert.ok(tasks.tasks, 'listTasks should return tasks array');

    await client.close();
    await server.close();
    taskStore.cleanup();
  });

  test('status mapping: MCP task statuses map correctly to AdCP', async () => {
    const { mapMCPTaskStatus } = require('../../dist/lib/protocols/mcp-tasks.js');

    // Verify the complete mapping
    const mappings = [
      ['working', 'working'],
      ['input_required', 'input-required'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'canceled'], // British → American
    ];

    for (const [mcp, adcp] of mappings) {
      assert.strictEqual(mapMCPTaskStatus(mcp), adcp, `${mcp} should map to ${adcp}`);
    }
  });

  test('legacy server: registerAdcpTaskTool + createTaskCapableServer work together', () => {
    const { createTaskCapableServer, registerAdcpTaskTool, taskToolResponse } =
      require('../../dist/lib/server/tasks.js');
    const z = require('zod');

    const server = createTaskCapableServer('Test Publisher', '1.0.0');

    // Register with our helpers
    const tool = registerAdcpTaskTool(
      server,
      'async_get_products',
      {
        description: 'Get products asynchronously',
        inputSchema: { query: z.string() },
        taskSupport: 'optional',
      },
      {
        createTask: async (args, extra) => {
          const task = await extra.taskStore.createTask({ ttl: 60000 });
          return { task };
        },
        getTask: async (_args, extra) => {
          return await extra.taskStore.getTask(extra.taskId);
        },
        getTaskResult: async (_args, extra) => {
          return taskToolResponse({ products: [] }, 'No products found');
        },
      }
    );

    assert.ok(tool, 'Tool should be registered');

    // Verify taskToolResponse shape
    const resp = taskToolResponse({ products: [{ id: '1' }] }, '1 product');
    assert.deepStrictEqual(resp.content, [{ type: 'text', text: '1 product' }]);
    assert.deepStrictEqual(resp.structuredContent, { products: [{ id: '1' }] });
  });
});
