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
const ACC_1_SCOPE = { accountId: 'acc_1', ownerScope: 'account:acc_1' };

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
            assert.deepStrictEqual(taskCtx.taskRef, {
              taskId: FORCED_ID,
              accountId: 'acc_1',
              ownerScope: 'account:acc_1',
              registryId: taskCtx.taskRef.registryId,
            });
            assert.match(taskCtx.taskRef.registryId, /^memory:/);
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
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /registryId|ownerScope|accountId/);

    await server.awaitTask(FORCED_ID, ACC_1_SCOPE);
    const record = await server.getTaskState(FORCED_ID, ACC_1_SCOPE);
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
    const taskRef = await registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_custom' });
    assert.deepStrictEqual(taskRef, {
      taskId: 'task_custom',
      accountId: 'a1',
      ownerScope: 'account:a1',
      registryId: taskRef.registryId,
    });
    assert.match(taskRef.registryId, /^memory:/);
  });

  it('generates a task_ prefixed id when overrideTaskId is omitted', async () => {
    const registry = createInMemoryTaskRegistry();
    const { taskId } = await registry.create({ tool: 't', accountId: 'a1' });
    assert.ok(taskId.startsWith('task_'));
  });

  it('scopes reads and lifecycle writes by account plus principal (#2703)', async () => {
    const registry = createInMemoryTaskRegistry();
    const { taskId } = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acct-owner',
      ownerScope: 'api_key:buyer-owner',
    });
    const owner = { accountId: 'acct-owner', ownerScope: 'api_key:buyer-owner' };
    const otherAccount = { accountId: 'acct-attacker', ownerScope: 'api_key:buyer-owner' };
    const otherPrincipal = { accountId: 'acct-owner', ownerScope: 'api_key:buyer-attacker' };

    assert.ok(await registry.getTask(taskId, owner));
    assert.strictEqual(await registry.getTask(taskId, otherAccount), null);
    assert.strictEqual(await registry.getTask(taskId, otherPrincipal), null);

    await registry.updateProgress(taskId, otherAccount, { percent: 50 });
    await registry.complete(taskId, otherPrincipal, { leaked: true });
    assert.strictEqual((await registry.getTask(taskId, owner)).status, 'submitted');

    await registry.complete(taskId, owner, { media_buy_id: 'mb-owner' });
    const completed = await registry.getTask(taskId, owner);
    assert.strictEqual(completed.status, 'completed');
    assert.deepStrictEqual(completed.result, { media_buy_id: 'mb-owner' });
  });

  it('permits the same public task_id in separate account/principal partitions (#2703)', async () => {
    const registry = createInMemoryTaskRegistry();
    const first = { accountId: 'acct-a', ownerScope: 'api_key:buyer-a' };
    const second = { accountId: 'acct-b', ownerScope: 'api_key:buyer-b' };
    await registry.create({ tool: 't', ...first, overrideTaskId: 'task_shared' });
    await registry.create({ tool: 't', ...second, overrideTaskId: 'task_shared' });

    await registry.complete('task_shared', first, { owner: 'a' });
    await registry.complete('task_shared', second, { owner: 'b' });

    assert.deepStrictEqual((await registry.getTask('task_shared', first)).result, { owner: 'a' });
    assert.deepStrictEqual((await registry.getTask('task_shared', second)).result, { owner: 'b' });
  });

  it('settles one duplicate public id from its persisted scoped handle and reports non-enumerating outcomes', async () => {
    const { completeScopedTask, failScopedTask } = require('../dist/lib/server/decisioning');
    const registry = createInMemoryTaskRegistry();
    const firstRef = await registry.create({
      tool: 't',
      accountId: 'acct-a',
      ownerScope: 'api_key:buyer-a',
      overrideTaskId: 'task_shared_handle',
    });
    const secondRef = await registry.create({
      tool: 't',
      accountId: 'acct-b',
      ownerScope: 'api_key:buyer-b',
      overrideTaskId: 'task_shared_handle',
    });
    const persisted = JSON.parse(JSON.stringify(firstRef));

    assert.deepStrictEqual(await completeScopedTask(registry, persisted, { owner: 'a' }), { outcome: 'applied' });
    assert.deepStrictEqual(await completeScopedTask(registry, persisted, { owner: 'replacement' }), {
      outcome: 'already_terminal',
      status: 'completed',
    });
    assert.deepStrictEqual(
      await failScopedTask(
        registry,
        { ...firstRef, ownerScope: 'api_key:wrong' },
        { code: 'INVALID_STATE', recovery: 'correctable', message: 'wrong scope' }
      ),
      { outcome: 'not_found_in_scope' }
    );

    assert.strictEqual((await registry.getTask(secondRef.taskId, secondRef)).status, 'submitted');
    assert.deepStrictEqual((await registry.getTask(firstRef.taskId, firstRef)).result, { owner: 'a' });
  });

  it('binds persisted handles to the registry that issued them', async () => {
    const { completeScopedTask } = require('../dist/lib/server/decisioning');
    const firstRegistry = createInMemoryTaskRegistry();
    const secondRegistry = createInMemoryTaskRegistry();
    const createOpts = {
      tool: 't',
      accountId: 'acct-shared',
      ownerScope: 'api_key:shared',
      overrideTaskId: 'task_same_tuple',
    };
    const firstRef = await firstRegistry.create(createOpts);
    const secondRef = await secondRegistry.create(createOpts);

    assert.deepStrictEqual(await completeScopedTask(secondRegistry, firstRef, { leaked: true }), {
      outcome: 'not_found_in_scope',
    });
    assert.strictEqual((await secondRegistry.getTask(secondRef.taskId, secondRef)).status, 'submitted');
  });

  it('does not await background work through a handle issued by another registry', async () => {
    const firstRegistry = createInMemoryTaskRegistry();
    const secondRegistry = createInMemoryTaskRegistry();
    const createOpts = {
      tool: 't',
      accountId: 'acct-shared',
      ownerScope: 'api_key:shared',
      overrideTaskId: 'task_same_tuple_await',
    };
    const firstRef = await firstRegistry.create(createOpts);
    await secondRegistry.create(createOpts);
    let release;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    secondRegistry._registerBackground(firstRef.taskId, firstRef, pending);

    try {
      const outcome = await Promise.race([
        secondRegistry.awaitTask(firstRef.taskId, firstRef).then(() => 'resolved'),
        new Promise(resolve => setImmediate(() => resolve('blocked'))),
      ]);
      assert.strictEqual(outcome, 'resolved');
    } finally {
      release();
    }
  });

  it('strips server-only fields from worker-settled artifacts', async () => {
    const { completeScopedTask, failScopedTask } = require('../dist/lib/server/decisioning');
    const registry = createInMemoryTaskRegistry();
    const ref = await registry.create({ tool: 't', accountId: 'acct-a' });
    const result = {
      taskRef: { taskId: ref.taskId, accountId: ref.accountId, ownerScope: ref.ownerScope },
      products: [
        {
          product_id: 'product-1',
          ctx_metadata: { bearer: 'secret' },
          implementation_config: { upstream_id: 'secret' },
        },
      ],
    };

    assert.deepStrictEqual(await completeScopedTask(registry, ref, result), { outcome: 'applied' });
    assert.deepStrictEqual((await registry.getTask(ref.taskId, ref)).result, {
      products: [{ product_id: 'product-1' }],
    });

    const failedRef = await registry.create({ tool: 't', accountId: 'acct-a' });
    const workerError = {
      code: 'AUTHORIZATION_REQUIRED',
      recovery: 'correctable',
      message: 'Reconnect the provider',
      details: { provider: 'example', client_secret: 'must-not-persist' },
    };
    assert.deepStrictEqual(await failScopedTask(registry, failedRef, workerError, { errors: [workerError] }), {
      outcome: 'applied',
    });
    const failedRecord = await registry.getTask(failedRef.taskId, failedRef);
    assert.deepStrictEqual(failedRecord.error.details, { provider: 'example' });
    assert.deepStrictEqual(failedRecord.result.errors[0].details, { provider: 'example' });
  });

  it('rejects registry-only worker settlement for push-notification tasks', async () => {
    const { completeScopedTask, updateScopedTaskProgress } = require('../dist/lib/server/decisioning');
    const registry = createInMemoryTaskRegistry();
    const invalidRef = await registry.create({ tool: 't', accountId: 'acct-a', hasWebhook: true });
    await assert.rejects(
      registry.updateProgress(invalidRef.taskId, invalidRef, { percentage: 101 }),
      /between 0 and 100/
    );
    const unchanged = await registry.getTask(invalidRef.taskId, invalidRef);
    assert.strictEqual(unchanged.status, 'submitted');
    assert.strictEqual(unchanged.progress, undefined);

    const ref = await registry.create({ tool: 't', accountId: 'acct-a', hasWebhook: true });

    assert.deepStrictEqual(await updateScopedTaskProgress(registry, ref, { percentage: 25 }), {
      outcome: 'applied',
    });
    assert.deepStrictEqual(
      await registry.updateProgress(ref.taskId, ref, {
        ...ref,
        message: 'safe',
        creatives_processed: 3,
        accessToken: 'top-level-secret',
        details: {
          bearer: 'secret',
          refreshToken: 'nested-secret',
          id_token: 'nested-id-token',
          authToken: 'nested-auth-token',
          session_token: 'nested-session-token',
          oauth_token: 'nested-oauth-token',
          safe: 'kept',
        },
      }),
      { outcome: 'applied' }
    );
    const progressRecord = await registry.getTask(ref.taskId, ref);
    assert.strictEqual(progressRecord.status, 'working');
    assert.deepStrictEqual(progressRecord.progress, {
      message: 'safe',
      creatives_processed: 3,
      details: { safe: 'kept' },
    });
    assert.deepStrictEqual(
      await registry.updateProgress(ref.taskId, ref, {
        percentage: 100,
        step_number: 1,
        total_steps: 1,
      }),
      { outcome: 'applied' }
    );
    await assert.rejects(registry.updateProgress(ref.taskId, ref, { percentage: 101 }), /between 0 and 100/);
    await assert.rejects(registry.updateProgress(ref.taskId, ref, { step_number: 1.5 }), /integer of at least 1/);
    await assert.rejects(registry.updateProgress(ref.taskId, ref, { total_steps: 0 }), /integer of at least 1/);
    await assert.rejects(
      updateScopedTaskProgress(registry, ref, { message: 'x'.repeat(65 * 1024) }),
      /Task progress JSON exceeds/
    );
    await assert.rejects(
      completeScopedTask(registry, ref, { ok: true }),
      /unavailable for tasks with push notifications/
    );
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'working');
  });

  it('ref-based worker settlement fails closed for legacy custom registries without outcomes', async () => {
    const { completeScopedTask } = require('../dist/lib/server/decisioning');
    const registry = createInMemoryTaskRegistry();
    const ref = await registry.create({ tool: 't', accountId: 'acct-a' });
    const legacyCustomRegistry = { ...registry, complete: async () => {} };

    await assert.rejects(
      completeScopedTask(legacyCustomRegistry, ref, { ok: true }),
      /returned no lifecycle mutation outcome/
    );
  });

  it('threads a registry-authoritative task id while preserving the trusted scope', async () => {
    const inner = createInMemoryTaskRegistry();
    const taskRegistry = {
      ...inner,
      create: opts => inner.create({ ...opts, overrideTaskId: 'task_registry_canonical' }),
    };
    let issuedRef;
    let releaseTask;
    const taskGate = new Promise(resolve => {
      releaseTask = resolve;
    });
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async taskCtx => {
          issuedRef = taskCtx.taskRef;
          assert.strictEqual(taskCtx.taskRef.taskId, 'task_registry_canonical');
          assert.strictEqual(taskCtx.taskRef.ownerScope, 'account:acc_1');
          await taskGate;
          return { media_buy_id: 'mb_canonical', status: 'active' };
        }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskRegistry,
    });

    const response = await dispatchCreate(server);
    let awaitFinished = false;
    const waiting = server.awaitTask(response.structuredContent.task_id, issuedRef).then(() => {
      awaitFinished = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(awaitFinished, false, 'awaitTask must find the authoritative-ref background promise');
    releaseTask();
    await waiting;
    const record = await server.getTaskState(response.structuredContent.task_id, issuedRef);
    assert.strictEqual(record.status, 'completed');
    assert.strictEqual(record.result.media_buy_id, 'mb_canonical');
  });

  it('rejects a custom-registry handle that changes trusted request scope', async () => {
    const inner = createInMemoryTaskRegistry();
    const taskRegistry = {
      ...inner,
      create: opts => inner.create({ ...opts, ownerScope: 'registry:wrong-owner' }),
    };
    let taskRan = false;
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async () => {
          taskRan = true;
          return { media_buy_id: 'mb_wrong_scope', status: 'active' };
        }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskRegistry,
    });

    const response = await dispatchCreate(server);
    assert.strictEqual(response.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.strictEqual(response.structuredContent.task_id, undefined);
    assert.strictEqual(taskRan, false);
  });

  it('rejects an incomplete custom-registry handle before returning a submitted envelope', async () => {
    const inner = createInMemoryTaskRegistry();
    const taskRegistry = {
      ...inner,
      create: async opts => {
        const ref = await inner.create(opts);
        return { taskId: ref.taskId };
      },
    };
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async () => ({ media_buy_id: 'mb_incomplete', status: 'active' })),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskRegistry,
    });

    const response = await dispatchCreate(server);
    assert.strictEqual(response.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.strictEqual(response.structuredContent.task_id, undefined, 'must not acknowledge an unscoped task');
  });

  it('turns invalid handoff progress into a failed task instead of silently ignoring it', async () => {
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(async taskCtx => {
          await taskCtx.update({ percentage: 101 });
          return { media_buy_id: 'mb_invalid_progress', status: 'active' };
        }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const response = await dispatchCreate(server);
    const taskId = response.structuredContent.task_id;
    await server.awaitTask(taskId, ACC_1_SCOPE);
    const record = await server.getTaskState(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.error.code, 'SERVICE_UNAVAILABLE');
  });

  it('clear() removes tasks, preserves the registry instance, and invalidates old handles', async () => {
    const registry = createInMemoryTaskRegistry();
    const registerBackground = registry._registerBackground;
    const oldRef = await registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_clear' });
    registry._registerBackground('task_clear', { accountId: 'a1', ownerScope: 'account:a1' }, new Promise(() => {}));

    registry.clear();

    assert.strictEqual(registry._registerBackground, registerBackground);
    assert.notStrictEqual(registry.registryId, oldRef.registryId);
    assert.strictEqual(await registry.getTask('task_clear', { accountId: 'a1', ownerScope: 'account:a1' }), null);
    const newRef = await registry.create({ tool: 't', accountId: 'a1', overrideTaskId: 'task_clear' });
    assert.deepStrictEqual(await registry.complete(oldRef.taskId, oldRef, { stale: true }), {
      outcome: 'not_found_in_scope',
    });
    assert.strictEqual((await registry.getTask(newRef.taskId, newRef)).status, 'submitted');
  });
});

describe('compliance.reset taskRegistry flush (#2154)', () => {
  it('prevents an in-flight pre-reset task from settling a reused forced task_id', async () => {
    const FORCED_ID = 'task_reset-reusable-abc123';
    const taskRegistry = createInMemoryTaskRegistry();
    let releaseFirst;
    let markFirstStarted;
    let markOldSettlement;
    let invocation = 0;
    const firstGate = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise(resolve => {
      markFirstStarted = resolve;
    });
    const oldSettlement = new Promise(resolve => {
      markOldSettlement = resolve;
    });
    const originalComplete = taskRegistry.complete.bind(taskRegistry);
    taskRegistry.complete = async (taskId, scope, result) => {
      const outcome = await originalComplete(taskId, scope, result);
      if (result?.media_buy_id === 'mb_before_reset') markOldSettlement(outcome);
      return outcome;
    };
    const platform = buildPlatform({
      createMediaBuy: async (_req, ctx) =>
        ctx.handoffToTask(
          async () => {
            invocation += 1;
            if (invocation === 1) {
              markFirstStarted();
              await firstGate;
              return { media_buy_id: 'mb_before_reset', status: 'active' };
            }
            return { media_buy_id: 'mb_after_reset', status: 'active' };
          },
          { task_id: FORCED_ID }
        ),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'test',
      version: '0.0.1',
      taskRegistry,
      validation: { requests: 'off', responses: 'off' },
    });

    const first = await dispatchCreate(server);
    assert.strictEqual(first.structuredContent.task_id, FORCED_ID);
    await firstStarted;
    assert.ok(await taskRegistry.getTask(FORCED_ID, ACC_1_SCOPE), 'pre-reset task is present');

    await server.compliance.reset();

    assert.strictEqual(await taskRegistry.getTask(FORCED_ID, ACC_1_SCOPE), null, 'reset cleared task registry');
    const second = await dispatchCreate(server);
    assert.strictEqual(second.structuredContent.task_id, FORCED_ID);
    assert.notStrictEqual(second.isError, true, JSON.stringify(second.structuredContent));
    await server.awaitTask(FORCED_ID, ACC_1_SCOPE);
    assert.strictEqual((await taskRegistry.getTask(FORCED_ID, ACC_1_SCOPE)).result.media_buy_id, 'mb_after_reset');

    releaseFirst();
    assert.deepStrictEqual(await oldSettlement, { outcome: 'not_found_in_scope' });
    assert.strictEqual((await taskRegistry.getTask(FORCED_ID, ACC_1_SCOPE)).result.media_buy_id, 'mb_after_reset');
  });
});
