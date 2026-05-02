'use strict';

// Symmetric follow-up: `tasks_get` calls `platform.accounts.resolve` from
// the custom-tool path, which historically bypassed `BuyerAgentRegistry`
// resolution and threaded `ctx.agent: undefined` through to adopters'
// resolve impls. PR #1315 + #1321 documented the contract that `ctx.agent`
// reaches every account-store method when an `agentRegistry` is configured;
// this test file pins the same contract on the tasks_get polling surface.
//
// Two policies the tests anchor:
//   1. Agent IS resolved and threaded through to `accounts.resolve`.
//   2. Agent-status enforcement (suspended/blocked → 403) is DELIBERATELY
//      skipped on tasks_get polls so a buyer suspended after kicking off
//      an HITL task can still learn the terminal state. Hard cutoff is the
//      adopter's choice via `ctx.agent.status` checks inside their resolver.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

const sampleAgent = (overrides = {}) => ({
  agent_url: 'https://agent.scope3.com',
  display_name: 'Scope3',
  status: 'active',
  billing_capabilities: new Set(['operator']),
  ...overrides,
});

function buildHitlPlatform(captures, overrides = {}) {
  const taskFn = overrides.taskFn ?? (async () => ({ media_buy_id: 'mb_42', status: 'active' }));
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async (ref, ctx) => {
        captures.lastResolveCtx = ctx;
        return {
          id: ref?.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        };
      },
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: (_req, ctx) => ctx.handoffToTask(async () => taskFn()),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_42' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...(overrides.agentRegistry !== undefined && { agentRegistry: overrides.agentRegistry }),
  };
}

async function createCompletedTask(server, accountId) {
  const result = await server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'create_media_buy',
      arguments: {
        buyer_ref: 'b1',
        idempotency_key: '11111111-1111-1111-1111-111111111111',
        packages: [],
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-06-01T00:00:00Z',
        account: { account_id: accountId },
      },
    },
  });
  await server.awaitTask(result.structuredContent.task_id);
  return result.structuredContent.task_id;
}

const dispatchTasksGet = (server, taskId, accountId) =>
  server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'tasks_get',
      arguments: { task_id: taskId, account: { account_id: accountId } },
    },
  });

describe('tasks_get — agent forwarding to accounts.resolve', () => {
  it('forwards resolved BuyerAgent to accounts.resolve when agentRegistry is configured', async () => {
    const captures = {};
    const agent = sampleAgent();
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(captures, {
        agentRegistry: {
          async resolve() {
            return agent;
          },
        },
      }),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createCompletedTask(server, 'acc_owner');
    // Reset captures so the assertion targets the tasks_get call, not
    // create_media_buy's earlier resolve.
    captures.lastResolveCtx = undefined;
    const result = await dispatchTasksGet(server, taskId, 'acc_owner');
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(captures.lastResolveCtx, 'tasks_get must call accounts.resolve');
    assert.ok(captures.lastResolveCtx.agent, 'accounts.resolve MUST receive ctx.agent from tasks_get');
    assert.strictEqual(captures.lastResolveCtx.agent.agent_url, 'https://agent.scope3.com');
    assert.strictEqual(captures.lastResolveCtx.toolName, 'tasks_get');
  });

  it('omits ctx.agent when no agentRegistry is configured (no regression)', async () => {
    const captures = {};
    const server = createAdcpServerFromPlatform(buildHitlPlatform(captures), {
      name: 'p',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createCompletedTask(server, 'acc_owner');
    captures.lastResolveCtx = undefined;
    const result = await dispatchTasksGet(server, taskId, 'acc_owner');
    assert.notStrictEqual(result.isError, true);
    assert.ok(captures.lastResolveCtx, 'tasks_get must call accounts.resolve');
    assert.strictEqual(captures.lastResolveCtx.agent, undefined);
    assert.strictEqual(captures.lastResolveCtx.toolName, 'tasks_get');
  });

  it('freezes the resolved BuyerAgent before threading to resolve', async () => {
    const captures = {};
    const agent = sampleAgent();
    const server = createAdcpServerFromPlatform(
      buildHitlPlatform(captures, {
        agentRegistry: {
          async resolve() {
            return agent;
          },
        },
      }),
      { name: 'p', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const taskId = await createCompletedTask(server, 'acc_owner');
    await dispatchTasksGet(server, taskId, 'acc_owner');
    assert.equal(Object.isFrozen(agent), true, 'resolved BuyerAgent must be frozen by tasks_get path');
    assert.equal(Object.isFrozen(agent.billing_capabilities), true);
  });

  it('registry resolve throwing on the poll does not break the poll (agent stays undefined)', async () => {
    const captures = {};
    const registry = {
      async resolve() {
        return sampleAgent();
      },
    };
    const server = createAdcpServerFromPlatform(buildHitlPlatform(captures, { agentRegistry: registry }), {
      name: 'p',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createCompletedTask(server, 'acc_owner');
    // Flip the registry to throw AFTER the task is created (registry must
    // succeed during create_media_buy for the dispatcher's main path).
    registry.resolve = async () => {
      throw new Error('upstream-id-provider-down');
    };
    captures.lastResolveCtx = undefined;
    const result = await dispatchTasksGet(server, taskId, 'acc_owner');
    assert.notStrictEqual(
      result.isError,
      true,
      `registry failure must not break the poll, got ${JSON.stringify(result.structuredContent)}`
    );
    assert.strictEqual(captures.lastResolveCtx.agent, undefined);
  });
});

describe('tasks_get — agent status policy (suspended/blocked agents can still poll)', () => {
  // Pinned policy: the dispatcher's status-enforcement seam at
  // `create-adcp-server.ts:2796-2802` deliberately skips status checks on
  // tasks_get polls. A buyer agent suspended/blocked AFTER kicking off an
  // HITL task must still be able to retrieve the terminal state — refusing
  // the poll would strand work with no visibility. This anchor catches a
  // future refactor that would tighten status enforcement onto the polling
  // path and break that contract.

  it('suspended agent can still poll tasks_get', async () => {
    const captures = {};
    const agent = sampleAgent();
    const registry = {
      async resolve() {
        return agent;
      },
    };
    const server = createAdcpServerFromPlatform(buildHitlPlatform(captures, { agentRegistry: registry }), {
      name: 'p',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createCompletedTask(server, 'acc_owner');
    // Status flip happens AFTER the task is created. Ordering matters: the
    // create_media_buy flow runs through the dispatcher's status seam (which
    // would 403 if the agent were suspended at that moment) and freezes the
    // agent record. We mutate `status` via a fresh object reference returned
    // from the registry for subsequent calls — Object.freeze locks the
    // previously-resolved record, but new resolve() calls return a new value.
    registry.resolve = async () => sampleAgent({ status: 'suspended' });
    const result = await dispatchTasksGet(server, taskId, 'acc_owner');
    assert.notStrictEqual(
      result.isError,
      true,
      `suspended agents must still be able to poll tasks_get, got ${JSON.stringify(result.structuredContent)}`
    );
    assert.strictEqual(result.structuredContent.task_id, taskId);
    assert.strictEqual(result.structuredContent.status, 'completed');
  });

  it('blocked agent can still poll tasks_get', async () => {
    const captures = {};
    const registry = {
      async resolve() {
        return sampleAgent();
      },
    };
    const server = createAdcpServerFromPlatform(buildHitlPlatform(captures, { agentRegistry: registry }), {
      name: 'p',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const taskId = await createCompletedTask(server, 'acc_owner');
    registry.resolve = async () => sampleAgent({ status: 'blocked' });
    const result = await dispatchTasksGet(server, taskId, 'acc_owner');
    assert.notStrictEqual(
      result.isError,
      true,
      `blocked agents must still be able to poll tasks_get, got ${JSON.stringify(result.structuredContent)}`
    );
    assert.strictEqual(result.structuredContent.task_id, taskId);
  });
});
