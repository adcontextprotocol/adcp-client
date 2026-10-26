const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { AgentClient, SingleAgentClient, TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');

const status = (state = 'completed') => ({
  task_id: 'work-1',
  task_type: 'sync_catalogs',
  protocol: 'media-buy',
  status: state,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...(state === 'completed' && { result: { catalogs: [] } }),
});

describe('advertised AdCP task-status tool (#3446)', () => {
  afterEach(() => mock.restoreAll());

  for (const protocol of ['mcp', 'a2a']) {
    for (const method of ['track', 'waitForCompletion']) {
      test(`${protocol}: submitted.${method} polls the advertised protocol tool`, async () => {
        const agent = { id: 'seller', name: 'Seller', protocol, agent_uri: 'https://seller.example/mcp' };
        const client = new SingleAgentClient(agent, {
          adcpVersion: '3.2.7',
          validateFeatures: false,
          validation: { requests: 'off', responses: 'off' },
        });
        mock.method(client, 'ensureEndpointDiscovered', async () => agent);
        mock.method(client, 'ensureCanonicalUrlResolved', async () => agent);
        mock.method(client, 'getCapabilities', async () => ({
          version: 'v3',
          majorVersions: [3],
          supportedVersions: ['3.2.7'],
          protocols: ['media_buy'],
          features: {},
          extensions: [],
          discoveredTools: ['get_task_status'],
          _synthetic: false,
        }));
        const calls = [];
        mock.method(ProtocolClient, 'callTool', async (_agent, tool) => {
          calls.push(tool);
          return tool === 'seller_work'
            ? { structuredContent: { status: 'submitted', task_id: 'work-1' }, content: [] }
            : { ...status(), task_type: 'seller_work' };
        });
        const submitted = await client.executeCustomTask('seller_work', {});
        assert.equal(submitted.status, 'submitted');
        const completed = await submitted.submitted[method](0);
        assert.equal(completed.status, 'completed');
        assert.deepEqual(calls, ['seller_work', 'get_task_status']);
      });
    }

    for (const advertised of [true, false]) {
      const expected = advertised ? 'get_task_status' : protocol === 'mcp' ? 'tasks_get' : 'tasks/get';
      test(`${protocol}: status, tracking, and completion use ${expected}`, async () => {
        const agent = { id: 'seller', name: 'Seller', protocol, agent_uri: 'https://seller.example/mcp' };
        const client = new SingleAgentClient(agent, { validateFeatures: false });
        mock.method(client, 'ensureEndpointDiscovered', async () => agent);
        mock.method(client, 'ensureCanonicalUrlResolved', async () => agent);
        const discoveries = mock.method(client, 'getCapabilities', async options => {
          assert.equal(options.transport.allowPrivateIp, false);
          return { discoveredTools: advertised ? ['get_task_status', 'tasks_get', 'tasks/get'] : [] };
        });
        const calls = mock.method(ProtocolClient, 'callTool', async (_agent, tool, params) => {
          assert.equal(tool, expected);
          assert.deepEqual(params, { task_id: 'work-1', include_result: true });
          return status();
        });
        const transport = { allowPrivateIp: false };
        const task = await client.getTaskStatus('work-1', transport);
        assert.equal(task.status, 'completed');
        const tracked = await client.trackTask({ taskId: 'work-1', taskType: 'sync_catalogs', transport });
        const completed = await tracked.waitForCompletion(0);
        assert.equal(completed.success, true);
        assert.deepEqual(completed.data, { catalogs: [] });
        const wrapper = new AgentClient(agent);
        wrapper.client = client;
        assert.equal((await wrapper.getTaskStatus('work-1', transport)).taskId, 'work-1');
        assert.equal(calls.mock.callCount(), 3);
        assert.equal(discoveries.mock.callCount(), 3);
      });
    }

    test(`${protocol}: polling keeps the existing response and terminal-error mapping`, async () => {
      const executor = new TaskExecutor({ resolveTaskStatusTool: async () => 'get_task_status' });
      mock.method(ProtocolClient, 'callTool', async (_agent, tool) => {
        assert.equal(tool, 'get_task_status');
        return { ...status('failed'), error: { code: 'FAILED', message: 'Seller could not complete work' } };
      });
      const result = await executor.pollTaskCompletion(
        { id: 'seller', name: 'Seller', protocol, agent_uri: 'https://seller.example' },
        'work-1',
        0
      );
      assert.equal(result.success, false);
      assert.match(result.error, /Seller could not complete work/);
    });
  }

  test('discovery cancellation never dispatches a fallback poll', async () => {
    const controller = new AbortController();
    const executor = new TaskExecutor({
      resolveTaskStatusTool: async () => {
        controller.abort();
        return 'get_task_status';
      },
    });
    const calls = mock.method(ProtocolClient, 'callTool', async () => status());
    await assert.rejects(executor.getTaskStatus({ protocol: 'mcp' }, 'work-1', undefined, controller.signal), {
      name: 'AbortError',
    });
    assert.equal(calls.mock.callCount(), 0);
  });

  test('official MCP client discovers and polls a seller that registers only get_task_status', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { z } = require('zod');
    const server = new McpServer({ name: 'Protocol-only seller', version: '1.0.0' });
    const response = data => ({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
    server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () =>
      response({
        adcp: { major_versions: [3], supported_versions: ['3.2.7'] },
        supported_protocols: ['media_buy'],
        specialisms: [],
      })
    );
    let polls = 0;
    server.registerTool(
      'get_task_status',
      { inputSchema: { task_id: z.string(), include_result: z.boolean().optional() } },
      async () => {
        polls++;
        return response(status());
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'Buyer', version: '1.0.0' });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    try {
      const client = AgentClient.fromMCPClient(mcp, {
        adcpVersion: '3.2.7',
        validateFeatures: false,
        validation: { requests: 'off', responses: 'off' },
      });
      assert.equal((await client.getTaskStatus('work-1')).status, 'completed');
      const task = await client.trackTask({ taskId: 'work-1', taskType: 'sync_catalogs' });
      assert.equal((await task.waitForCompletion(0)).success, true);
      assert.equal(polls, 2);
    } finally {
      await mcp.close();
      await server.close();
    }
  });

  for (const envelope of ['flat', 'a2a']) {
    for (const state of ['working', 'failed']) {
      test(`typed status query preserves ${state} in a ${envelope} response`, async () => {
        const data = {
          ...status(state),
          ...(state === 'failed' && { error: { code: 'FAILED', message: 'Work failed' } }),
        };
        mock.method(ProtocolClient, 'callTool', async () =>
          envelope === 'flat'
            ? data
            : {
                result: {
                  kind: 'task',
                  id: 'transport-task',
                  status: { state: 'completed' },
                  artifacts: [{ artifactId: 'status', parts: [{ kind: 'data', data }] }],
                },
              }
        );
        const executor = new TaskExecutor({ validation: { requests: 'off', responses: 'off' } });
        const result = await executor.executeTask(
          { id: 'seller', name: 'Seller', protocol: 'a2a', agent_uri: 'https://seller.example' },
          'get_task_status',
          { task_id: 'work-1' }
        );
        assert.equal(result.success, true, result.error);
        assert.equal(result.status, 'completed');
        assert.deepEqual(result.data, data);
      });
    }
  }
});
