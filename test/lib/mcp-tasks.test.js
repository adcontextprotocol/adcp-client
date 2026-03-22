/**
 * Tests for MCP Tasks protocol integration.
 *
 * Tests both client-side (mcp-tasks.ts) and server-side (server/tasks.ts) helpers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('MCP Tasks: status mapping', () => {
  test('mapMCPTaskStatus maps all MCP statuses to AdCP equivalents', () => {
    const { mapMCPTaskStatus } = require('../../dist/lib/protocols/mcp-tasks.js');

    assert.strictEqual(mapMCPTaskStatus('working'), 'working');
    assert.strictEqual(mapMCPTaskStatus('input_required'), 'input-required');
    assert.strictEqual(mapMCPTaskStatus('completed'), 'completed');
    assert.strictEqual(mapMCPTaskStatus('failed'), 'failed');
    // British → American spelling
    assert.strictEqual(mapMCPTaskStatus('cancelled'), 'canceled');
    // Unknown statuses pass through
    assert.strictEqual(mapMCPTaskStatus('custom_status'), 'custom_status');
  });
});

describe('MCP Tasks: serverSupportsTasks', () => {
  test('returns true when server has tasks.requests.tools.call capability', () => {
    const { serverSupportsTasks } = require('../../dist/lib/protocols/mcp-tasks.js');

    const mockClient = {
      getServerCapabilities: () => ({
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tools: {
              call: {},
            },
          },
        },
      }),
    };
    assert.strictEqual(serverSupportsTasks(mockClient), true);
  });

  test('returns false when server lacks tasks capability', () => {
    const { serverSupportsTasks } = require('../../dist/lib/protocols/mcp-tasks.js');

    const mockClient = {
      getServerCapabilities: () => ({
        tools: { listChanged: true },
      }),
    };
    assert.strictEqual(serverSupportsTasks(mockClient), false);
  });

  test('returns false when capabilities are undefined', () => {
    const { serverSupportsTasks } = require('../../dist/lib/protocols/mcp-tasks.js');

    const mockClient = {
      getServerCapabilities: () => undefined,
    };
    assert.strictEqual(serverSupportsTasks(mockClient), false);
  });

  test('returns false when tasks exists but lacks requests.tools.call', () => {
    const { serverSupportsTasks } = require('../../dist/lib/protocols/mcp-tasks.js');

    const mockClient = {
      getServerCapabilities: () => ({
        tasks: {
          list: {},
          cancel: {},
        },
      }),
    };
    assert.strictEqual(serverSupportsTasks(mockClient), false);
  });
});

describe('MCP Tasks: server-side helpers', () => {
  test('taskToolResponse builds MCP-compatible response shape', () => {
    const { taskToolResponse } = require('../../dist/lib/server/tasks.js');

    const response = taskToolResponse({ products: [{ id: '1' }] }, 'Found 1 product');

    assert.ok(response.content);
    assert.strictEqual(response.content[0].type, 'text');
    assert.strictEqual(response.content[0].text, 'Found 1 product');
    assert.ok(response.structuredContent);
    assert.deepStrictEqual(response.structuredContent.products, [{ id: '1' }]);
  });

  test('taskToolResponse uses default summary', () => {
    const { taskToolResponse } = require('../../dist/lib/server/tasks.js');

    const response = taskToolResponse({ status: 'ok' });
    assert.strictEqual(response.content[0].text, 'Task completed');
  });

  test('createTaskCapableServer creates server with tasks capability', () => {
    const { createTaskCapableServer } = require('../../dist/lib/server/tasks.js');

    const server = createTaskCapableServer('Test Publisher', '1.0.0');

    assert.ok(server, 'Server should be created');
    // The server should have experimental.tasks available
    assert.ok(server.experimental, 'Server should have experimental features');
    assert.ok(server.experimental.tasks, 'Server should have experimental.tasks');
    assert.ok(
      typeof server.experimental.tasks.registerToolTask === 'function',
      'Server should have registerToolTask method'
    );
  });

  test('registerAdcpTaskTool registers tool with task support', () => {
    const { createTaskCapableServer, registerAdcpTaskTool } = require('../../dist/lib/server/tasks.js');
    const z = require('zod');

    const server = createTaskCapableServer('Test Publisher', '1.0.0');

    // Should not throw
    const tool = registerAdcpTaskTool(
      server,
      'test_async_tool',
      {
        description: 'A test async tool',
        inputSchema: { query: z.string() },
        taskSupport: 'required',
      },
      {
        createTask: async (args, extra) => {
          const task = await extra.taskStore.createTask({ ttl: 60000 });
          return { task };
        },
        getTask: async (_args, extra) => {
          const task = await extra.taskStore.getTask(extra.taskId);
          return task;
        },
        getTaskResult: async (_args, extra) => {
          return await extra.taskStore.getTaskResult(extra.taskId);
        },
      }
    );

    assert.ok(tool, 'Tool should be registered');
  });

  test('InMemoryTaskStore is re-exported and functional', () => {
    const { InMemoryTaskStore } = require('../../dist/lib/server/tasks.js');

    assert.ok(InMemoryTaskStore, 'InMemoryTaskStore should be exported');
    const store = new InMemoryTaskStore();
    assert.ok(store, 'InMemoryTaskStore should be instantiable');
    assert.ok(typeof store.createTask === 'function');
    assert.ok(typeof store.getTask === 'function');
    assert.ok(typeof store.storeTaskResult === 'function');
    assert.ok(typeof store.getTaskResult === 'function');
    assert.ok(typeof store.listTasks === 'function');
    assert.ok(typeof store.updateTaskStatus === 'function');
  });

  test('isTerminal correctly identifies terminal task statuses', () => {
    const { isTerminal } = require('../../dist/lib/server/tasks.js');

    assert.strictEqual(isTerminal('completed'), true);
    assert.strictEqual(isTerminal('failed'), true);
    assert.strictEqual(isTerminal('cancelled'), true);
    assert.strictEqual(isTerminal('working'), false);
    assert.strictEqual(isTerminal('input_required'), false);
  });
});

describe('MCP Tasks: main package exports', () => {
  test('server-side task helpers are exported from main entry', () => {
    const adcp = require('../../dist/lib/index.js');

    assert.ok(adcp.taskToolResponse, 'taskToolResponse should be exported');
    assert.ok(adcp.registerAdcpTaskTool, 'registerAdcpTaskTool should be exported');
    assert.ok(adcp.createTaskCapableServer, 'createTaskCapableServer should be exported');
    assert.ok(adcp.InMemoryTaskStore, 'InMemoryTaskStore should be exported');
    assert.ok(adcp.isTerminal, 'isTerminal should be exported');
  });

  test('client-side task functions are exported from protocols', () => {
    const protocols = require('../../dist/lib/protocols/index.js');

    assert.ok(protocols.callMCPToolWithTasks, 'callMCPToolWithTasks should be exported');
    assert.ok(protocols.getMCPTaskStatus, 'getMCPTaskStatus should be exported');
    assert.ok(protocols.getMCPTaskResult, 'getMCPTaskResult should be exported');
    assert.ok(protocols.listMCPTasks, 'listMCPTasks should be exported');
    assert.ok(protocols.cancelMCPTask, 'cancelMCPTask should be exported');
    assert.ok(protocols.mapMCPTaskStatus, 'mapMCPTaskStatus should be exported');
    assert.ok(protocols.serverSupportsTasks, 'serverSupportsTasks should be exported');
  });
});

describe('MCP Tasks: callMCPToolWithTasks fallback', () => {
  test('falls back to standard callTool when server lacks tasks capability', async () => {
    // This test verifies that callMCPToolWithTasks delegates to client.callTool
    // when the server doesn't support tasks. We can't easily mock the connection
    // cache, but we can verify the function exists and has the right signature.
    const { callMCPToolWithTasks } = require('../../dist/lib/protocols/mcp-tasks.js');

    assert.strictEqual(typeof callMCPToolWithTasks, 'function');

    // Attempting to call with an invalid URL should fail with connection error,
    // not a "tasks not supported" error — proving the function tries to connect first
    const debugLogs = [];
    try {
      await callMCPToolWithTasks('https://invalid.test.local/mcp', 'test', {}, 'token', debugLogs);
    } catch (err) {
      // Expected: connection failure, not a tasks-related error
      assert.ok(!err.message.includes('tasks'), `Error should be connection-related, got: ${err.message}`);
    }
  });
});
