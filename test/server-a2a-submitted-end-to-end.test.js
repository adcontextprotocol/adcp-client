// Integration test: drives a full A2A submitted → completed
// roundtrip through the SDK, exercising:
//
//   1. `responseParser.getStatus` correctly classifies the seller's
//      submitted-arm response as `'submitted'` (not `'completed'`)
//      via the artifact's `data.status` (#973).
//   2. `responseParser.getTaskId` extracts the AdCP work handle from
//      `artifact.metadata.adcp_task_id` (not the A2A Task.id).
//   3. `setupSubmittedTask` plumbs the AdCP handle into
//      `SubmittedContinuation.taskId` (#966).
//   4. `pollTaskCompletion` dispatches AdCP `tasks/get` with snake_case
//      `task_id` (#967).
//   5. The seller's AdCP `tasks/get` tool returns the spec-shape
//      response, which the SDK maps to `TaskInfo` and resolves on
//      `waitForCompletion`.
//
// This is the regression-class anchor for the entire A2A submitted-arm
// polling cycle end-to-end. Before #966/#967/#973 it didn't work for
// any spec-conformant seller.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { TaskExecutor } = require('../dist/lib/index');

function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    stateStore: config?.stateStore ?? new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

async function startA2aFixture(handlers) {
  const adcp = createAdcpServer(handlers);
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const cardUrl = `http://127.0.0.1:${port}/a2a`;
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: {
      name: 'Async A2A seller',
      description: 'submitted → completed roundtrip',
      url: cardUrl,
      version: '1.0.0',
      provider: { organization: 'Test', url: 'https://test.example' },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  });
  a2a.mount(app);
  return {
    server,
    url: cardUrl,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

describe('A2A submitted → completed end-to-end (#966 + #967 + #973)', () => {
  it('SDK classifies submitted, polls with AdCP task_id, and resolves on completion', async () => {
    const SELLER_TASK_ID = 'tk_seller_async_1';
    const SELLER_MEDIA_BUY_ID = 'mb_completed_42';
    let pollCount = 0;
    let observedPollParam;
    let observedPollSkill;

    const fixture = await startA2aFixture({
      mediaBuy: {
        createMediaBuy: async () => ({
          status: 'submitted',
          task_id: SELLER_TASK_ID,
          message: 'IO signature pending',
        }),
      },
      // Custom AdCP `tasks/get` tool dispatched as a buyer-callable
      // tool over `message/send`. First two polls return working;
      // third returns completed with the result data.
    });
    // Drive polls via a `ProtocolClient.callTool` monkey-patch
    // rather than registering a `tasks/get` tool on the seller —
    // we want to assert on the exact arguments the SDK dispatches
    // (snake_case `task_id`), and a real seller-side tool
    // registration would obscure that surface.
    const { ProtocolClient } = require('../dist/lib/index');
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (agent, toolName, params, ...rest) => {
      if (toolName === 'tasks/get') {
        observedPollSkill = toolName;
        observedPollParam = params;
        pollCount += 1;
        if (pollCount < 3) {
          return {
            task_id: params.task_id,
            task_type: 'create_media_buy',
            protocol: 'media-buy',
            status: 'working',
            created_at: '2026-04-25T10:00:00Z',
            updated_at: new Date().toISOString(),
          };
        }
        return {
          task_id: params.task_id,
          task_type: 'create_media_buy',
          protocol: 'media-buy',
          status: 'completed',
          created_at: '2026-04-25T10:00:00Z',
          updated_at: new Date().toISOString(),
          result: { media_buy_id: SELLER_MEDIA_BUY_ID, packages: [] },
        };
      }
      return originalCallTool.call(ProtocolClient, agent, toolName, params, ...rest);
    };

    try {
      const executor = new TaskExecutor({ pollingInterval: 5 });
      const submittedResult = await executor.executeTask(
        { id: 't', name: 't', agent_uri: fixture.url, protocol: 'a2a' },
        'create_media_buy',
        {
          brand: { brand_id: 'b' },
          account: { account_id: 'a' },
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-02-01T00:00:00Z',
        }
      );

      // (1) + (2) + (3): SDK saw the response as submitted, with
      // the AdCP handle (not the A2A Task.id).
      assert.strictEqual(submittedResult.status, 'submitted', 'SDK classifies as submitted');
      assert.ok(submittedResult.submitted, 'submitted continuation present');
      assert.strictEqual(
        submittedResult.submitted.taskId,
        SELLER_TASK_ID,
        'continuation surfaces the AdCP task handle, not the A2A Task.id'
      );

      // Poll through to completion.
      const completion = await submittedResult.submitted.waitForCompletion(5);

      // (4): poll dispatched `tasks/get` with snake_case `task_id`
      // carrying the AdCP handle.
      assert.strictEqual(observedPollSkill, 'tasks/get');
      assert.strictEqual(
        observedPollParam.task_id,
        SELLER_TASK_ID,
        'poll addresses the AdCP task handle (snake_case task_id)'
      );
      assert.strictEqual(observedPollParam.taskId, undefined, 'no legacy camelCase taskId');

      // (5): SDK mapped the spec-shape response and resolved.
      assert.strictEqual(completion.success, true);
      assert.strictEqual(completion.status, 'completed');
      assert.deepStrictEqual(completion.data, { media_buy_id: SELLER_MEDIA_BUY_ID, packages: [] });
      assert.ok(pollCount >= 3, `expected ≥3 polls (working/working/completed), got ${pollCount}`);
    } finally {
      ProtocolClient.callTool = originalCallTool;
      await fixture.close();
    }
  });
});
