// Tests for ctx.handoffToTask options.task_id — adcp-client#1554.
//
// Contract: when a caller passes `options.task_id`, the framework uses that
// exact string as the task_id on the wire instead of minting a fresh one.
// Motivated by `force_create_media_buy_arm` which requires the seller to echo
// a directive-supplied task_id verbatim.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');

function buildPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      getMediaBuy: async () => {
        throw new Error('not implemented');
      },
      listMediaBuys: async () => ({ media_buys: [] }),
      ...overrides,
    },
  };
}

async function dispatchCreate(server, extra = {}) {
  // Spec idempotency_key pattern: ^[A-Za-z0-9_.:-]{16,255}$. Pad with the
  // call timestamp so each test run gets a unique value above the minimum.
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'create_media_buy',
      arguments: {
        idempotency_key: 'ik-handoff-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        packages: [],
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-06-01T00:00:00Z',
        account: { account_id: 'acc_1' },
        ...extra,
      },
    },
  });
}

describe('ctx.handoffToTask options.task_id (#1554)', () => {
  it('emits the caller-supplied task_id on the wire verbatim', async () => {
    const FORCED_ID = 'task_forced-by-directive-abc123';
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(
          async taskCtx => {
            assert.strictEqual(taskCtx.id, FORCED_ID, 'taskCtx.id reflects the supplied task_id');
            return { media_buy_id: 'mb_1', status: 'active' };
          },
          { task_id: FORCED_ID }
        ),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.strictEqual(result.structuredContent.task_id, FORCED_ID);

    await server.awaitTask(FORCED_ID);
    const record = await server.getTaskState(FORCED_ID);
    assert.strictEqual(record.status, 'completed');
    assert.strictEqual(record.result.media_buy_id, 'mb_1');
  });

  it('without options, framework mints a fresh task_ prefixed id', async () => {
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async () => ({ media_buy_id: 'mb_auto', status: 'active' })),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    assert.strictEqual(result.structuredContent.status, 'submitted');
    assert.ok(result.structuredContent.task_id.startsWith('task_'), 'framework-minted id starts with task_');
  });

  it('rejects empty string task_id at call time', async () => {
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async () => ({ media_buy_id: 'mb_1', status: 'active' }), { task_id: '' }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    assert.strictEqual(result.isError, true);
    assert.match(JSON.stringify(result.structuredContent), /non-empty/);
  });

  it('rejects task_id longer than 128 characters at call time', async () => {
    const longId = 'a'.repeat(129);
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async () => ({ media_buy_id: 'mb_1', status: 'active' }), { task_id: longId }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await dispatchCreate(server);
    assert.strictEqual(result.isError, true);
    assert.match(JSON.stringify(result.structuredContent), /128/);
  });
});

describe('createInMemoryTaskRegistry overrideTaskId collision guard (#1554)', () => {
  it('throws when the same overrideTaskId is registered twice', async () => {
    const registry = createInMemoryTaskRegistry();
    await registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_dup' });
    await assert.rejects(
      () => registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_dup' }),
      /already registered/
    );
  });

  it('uses overrideTaskId as the returned taskId', async () => {
    const registry = createInMemoryTaskRegistry();
    const { taskId } = await registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_custom' });
    assert.strictEqual(taskId, 'task_custom');
  });

  it('generates a task_ prefixed id when overrideTaskId is omitted', async () => {
    const registry = createInMemoryTaskRegistry();
    const { taskId } = await registry.create({ tool: 't', accountId: 'a1' });
    assert.ok(taskId.startsWith('task_'));
  });

  it('clear() removes existing tasks and preserves the registry instance', async () => {
    const registry = createInMemoryTaskRegistry();
    const registerBackground = registry._registerBackground;
    await registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_clear' });
    registry._registerBackground('task_clear', new Promise(() => {}));

    registry.clear();

    assert.strictEqual(registry._registerBackground, registerBackground);
    assert.strictEqual(await registry.getTask('task_clear'), null);
    await assert.doesNotReject(() => registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_clear' }));
  });
});

describe('compliance.reset taskRegistry flush (#2154)', () => {
  it('allows a forced task_id to be reused after compliance.reset()', async () => {
    const FORCED_ID = 'task_reset-reusable-abc123';
    const taskRegistry = createInMemoryTaskRegistry();
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async () => ({ media_buy_id: 'mb_reset', status: 'active' }), { task_id: FORCED_ID }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      taskRegistry,
      validation: { requests: 'off', responses: 'off' },
    });

    const first = await dispatchCreate(server);
    assert.strictEqual(first.structuredContent.task_id, FORCED_ID);
    await server.awaitTask(FORCED_ID);
    assert.ok(await taskRegistry.getTask(FORCED_ID), 'pre-reset task is present');

    await server.compliance.reset();

    assert.strictEqual(await taskRegistry.getTask(FORCED_ID), null, 'reset cleared task registry');
    const second = await dispatchCreate(server);
    assert.strictEqual(second.structuredContent.task_id, FORCED_ID);
    assert.notStrictEqual(second.isError, true, JSON.stringify(second.structuredContent));
  });
});
