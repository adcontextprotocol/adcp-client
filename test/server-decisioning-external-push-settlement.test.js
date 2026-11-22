/**
 * Externally settled task handoffs with push_notification_config (#3761).
 *
 * The SDK binds the buyer's validated push route to the task at handoff;
 * a trusted worker settles through the bound helpers, which read that route.
 *
 * The PostgreSQL suite requires a running database and is skipped when
 * DATABASE_URL is unset:
 *   DATABASE_URL=postgres://localhost/test node --test test/server-decisioning-external-push-settlement.test.js
 */

process.env.NODE_ENV = 'test';

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { PlatformConfigError } = require('../dist/lib/server/decisioning/runtime/validate-platform');
const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');

const DATABASE_URL = process.env.DATABASE_URL;
const NAMESPACE = 'external-push-test';
const STORAGE_ID = 'store:external-push';
const TABLE = 'adcp_ext_push_tasks';
const OUTBOX = 'adcp_ext_push_outbox';
const DELIVERIES = 'adcp_ext_push_deliveries';
const UNMIGRATED = 'adcp_ext_push_unmigrated';
const PUBLISHER = 'external-push-seller';

const PUSH = {
  url: 'https://buyer.example/hook',
  token: 'buyer-validation-token-0123456789',
  operation_id: 'op-1',
};

// Reversible stand-in for a KMS adapter. The ciphertext never contains the
// cleartext token, so a raw table read must not find it.
const ADAPTER = {
  protect(authentication, context) {
    const secret = authentication.token ?? authentication.secret;
    return {
      protectedValue: { ciphertext: Buffer.from(`${context.purpose}:${secret}`, 'utf8').toString('base64') },
      fingerprint: createHash('sha256').update(`${context.purpose}:${secret}`).digest('hex'),
    };
  },
  resolve(protectedValue, context) {
    const cleartext = Buffer.from(protectedValue.ciphertext, 'base64').toString('utf8');
    const prefix = `${context.purpose}:`;
    assert.ok(cleartext.startsWith(prefix));
    return { type: 'bearer', token: cleartext.slice(prefix.length) };
  },
};

function buildPlatform(createMediaBuy) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      features: { canonicalCreatives: true },
      config: {},
    },
    accounts: {
      resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [], cache_scope: 'account' }),
      createMediaBuy,
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
}

let idempotencyCounter = 0;
function dispatchCreate(server, overrides = {}) {
  idempotencyCounter += 1;
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'create_media_buy',
      arguments: {
        buyer_ref: 'b1',
        idempotency_key: `00000000-0000-4000-8000-${String(idempotencyCounter).padStart(12, '0')}`,
        packages: [],
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-06-01T00:00:00Z',
        account: { account_id: 'acc_1' },
        ...overrides,
      },
    },
  });
}

/** A handler that proxies to a "remote agent" and hands off to a durable worker. */
function externalProducer(state) {
  return async (_req, ctx) =>
    ctx.handoffToTask(
      async taskCtx => {
        state.queued.push(structuredClone(taskCtx.taskRef));
      },
      { settlement: 'external' }
    );
}

describe('external push settlement without a durable coordinator', () => {
  test('in-memory and coordinator-less setups still refuse at ctx.handoffToTask', async () => {
    for (const taskRegistry of [
      { ...createInMemoryTaskRegistry(), durability: 'durable' },
      createInMemoryTaskRegistry(),
    ]) {
      let afterHandoff = false;
      const server = createAdcpServerFromPlatform(
        buildPlatform(async (_req, ctx) => {
          const handoff = ctx.handoffToTask(async () => {}, { settlement: 'external' });
          afterHandoff = true;
          return handoff;
        }),
        { name: 'no-coordinator', version: '0.0.1', validation: { requests: 'off', responses: 'off' }, taskRegistry }
      );
      const result = await dispatchCreate(server, { push_notification_config: PUSH });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(afterHandoff, false, 'refused before later handler code');
      const error = result.structuredContent.adcp_error;
      assert.strictEqual(error.code, 'UNSUPPORTED_FEATURE');
      assert.strictEqual(error.field, 'push_notification_config');
      assert.match(error.message, /no durable push settlement/);
    }
  });

  test('a taskSettlementCoordinator not created by the SDK factory is rejected at construction', () => {
    assert.throws(
      () =>
        createAdcpServerFromPlatform(
          buildPlatform(async () => ({ media_buy_id: 'x' })),
          {
            name: 'fake-coordinator',
            version: '0.0.1',
            taskRegistry: { ...createInMemoryTaskRegistry(), durability: 'durable' },
            taskSettlementCoordinator: { durability: 'durable', settle: async () => ({}) },
          }
        ),
      error => error instanceof PlatformConfigError && /createPostgresTaskSettlementCoordinator/.test(error.message)
    );
  });
});

describe('projectBoundTaskResultForRelease', () => {
  const { projectBoundTaskResultForRelease } = require('../dist/lib/server/decisioning/runtime/task-result-release');
  const result = () => ({
    media_buy_id: 'mb_1',
    media_buy_status: 'pending_creatives',
    confirmed_at: '2026-04-29T00:00:00Z',
    revision: 1,
    packages: [
      { package_id: 'pk', targeting_overlay: { collection_lists: [{ agent_url: 'https://g.example', list_id: 'l' }] } },
    ],
  });

  test('a recorded release with no packaged schemas throws instead of converting from a sibling preview', () => {
    assert.throws(() => projectBoundTaskResultForRelease('create_media_buy', result(), '3.3.0-beta.6', '3.2'));
  });

  test('a stable recorded release with a patch resolves through its line bundle', () => {
    assert.doesNotThrow(() => projectBoundTaskResultForRelease('create_media_buy', result(), '3.2.0', '3.1'));
  });

  test('no minor-line step returns the same reference', () => {
    const input = result();
    assert.strictEqual(
      projectBoundTaskResultForRelease('create_media_buy', input, '3.3.0-beta.6', '3.3.0-beta.6'),
      input
    );
  });

  test('a recorded release with no schemas on its minor line throws', () => {
    assert.throws(() => projectBoundTaskResultForRelease('create_media_buy', result(), '3.9.0-beta.1', '3.2'));
  });
});

describe('external push settlement with PostgreSQL', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let pool;
  let lib;
  let serverLib;

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL });
    lib = require('../dist/lib/server/decisioning');
    serverLib = require('../dist/lib/server');
    for (const table of [TABLE, OUTBOX, DELIVERIES, UNMIGRATED]) {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await pool.query(lib.getDecisioningTaskRegistryBootstrap({ tableName: TABLE, namespace: NAMESPACE }));
    await pool.query(serverLib.getWebhookDeliveryRecoveryMigration({ tableName: OUTBOX }));
    await pool.query(serverLib.getWebhookDeliveryMigration({ tableName: DELIVERIES }));
    // The upgrade is idempotent on a bootstrap that already has the column.
    await pool.query(lib.getTaskPushBindingMigration({ tableName: TABLE }));
    // A registry table that predates the push_binding column.
    await pool.query(lib.getDecisioningTaskRegistryBootstrap({ tableName: UNMIGRATED, namespace: NAMESPACE }));
    await pool.query(`ALTER TABLE ${UNMIGRATED} DROP COLUMN push_binding`);
  });

  afterEach(async () => {
    for (const table of [TABLE, OUTBOX, DELIVERIES, UNMIGRATED]) await pool.query(`DELETE FROM ${table}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  function stack({
    adapter = ADAPTER,
    publisherScope = PUBLISHER,
    tableName = TABLE,
    storageId = STORAGE_ID,
    recovery = { defaultLeaseMs: 1000 },
  } = {}) {
    const registry = lib.createPostgresTaskRegistry({ pool, namespace: NAMESPACE, storageId, tableName });
    const coordinator = lib.createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope,
      outbox: { tableName: OUTBOX },
      ...(adapter && { authenticationAdapter: adapter }),
      recovery,
    });
    return { registry, coordinator };
  }

  function serverFor(registry, coordinator, state, extra = {}) {
    return createAdcpServerFromPlatform(buildPlatform(extra.createMediaBuy ?? externalProducer(state)), {
      name: 'external-push',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      taskRegistry: registry,
      taskSettlementCoordinator: coordinator,
      ...extra.serverOptions,
    });
  }

  async function count(table) {
    return (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
  }

  async function boundCount() {
    const found = await pool.query(`SELECT count(*)::int AS count FROM ${TABLE} WHERE push_binding IS NOT NULL`);
    return found.rows[0].count;
  }

  /** Deliver every pending outbox row through a real signing emitter; returns the POSTs it made. */
  async function deliverPending(coordinator) {
    const posts = [];
    const { privateKey } = require('node:crypto').generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    for (;;) {
      const [lease] = await coordinator.recovery.claimPending({ ownerToken: 'external-push-worker', limit: 1 });
      if (!lease) break;
      const emitter = serverLib.createWebhookEmitter({
        signerKey: {
          keyid: 'external-push-key',
          alg: 'ed25519',
          privateKey: {
            ...jwk,
            kid: 'external-push-key',
            alg: 'EdDSA',
            key_ops: ['sign'],
            adcp_use: 'request-signing',
          },
        },
        publisherScope: lease.key.publisherScope,
        tenantScope: lease.key.tenantScope,
        deliveryStore: serverLib.pgWebhookDeliveryStore(pool, { tableName: DELIVERIES }),
        deliveryRecovery: coordinator.recovery,
        fetch: async (url, init) => {
          posts.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
          return { status: 204, headers: { get: () => undefined } };
        },
      });
      const outcome = await emitter.emitRecovered(lease);
      assert.strictEqual(outcome.delivered, true, JSON.stringify(outcome.errors));
    }
    return posts;
  }

  test('external settlement with push completes and delivers exactly one terminal webhook to the bound route', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    const server = serverFor(registry, coordinator, state);

    const submitted = await dispatchCreate(server, { push_notification_config: PUSH });
    assert.notStrictEqual(submitted.isError, true, JSON.stringify(submitted.structuredContent));
    assert.strictEqual(submitted.structuredContent.status, 'submitted');
    const [ref] = state.queued;
    assert.strictEqual(ref.taskId, submitted.structuredContent.task_id);

    const task = await registry.getTask(ref.taskId, ref);
    assert.strictEqual(task.status, 'submitted');
    assert.strictEqual(task.hasWebhook, true, 'the submitted task reports has_webhook truthfully');
    assert.strictEqual(await boundCount(), 1);
    const raw = await pool.query(`SELECT push_binding::text AS binding FROM ${TABLE} WHERE push_binding IS NOT NULL`);
    assert.match(raw.rows[0].binding, /buyer\.example\/hook/);
    assert.doesNotMatch(raw.rows[0].binding, new RegExp(PUSH.token), 'the token is protected at rest');
    assert.strictEqual(await count(OUTBOX), 0, 'nothing is delivered before settlement');

    const result = { media_buy_id: 'mb_external', ctx_metadata: { secret: 'must-strip' } };
    assert.deepStrictEqual(await lib.completeBoundPushTask(coordinator, ref, result), {
      outcome: 'applied',
      delivery: 'durably_bound',
    });
    assert.deepStrictEqual(await lib.completeBoundPushTask(coordinator, ref, result), {
      outcome: 'already_terminal',
      status: 'completed',
      compatibility: 'compatible',
      delivery: 'recoverable',
    });
    assert.strictEqual(await count(OUTBOX), 1);
    assert.deepStrictEqual((await registry.getTask(ref.taskId, ref)).result, { media_buy_id: 'mb_external' });

    const posts = await deliverPending(coordinator);
    assert.strictEqual(posts.length, 1, 'exactly one terminal webhook');
    assert.strictEqual(posts[0].url, PUSH.url);
    assert.strictEqual(posts[0].body.task_id, ref.taskId);
    assert.strictEqual(posts[0].body.status, 'completed');
    assert.strictEqual(posts[0].body.operation_id, PUSH.operation_id);
    assert.strictEqual(posts[0].body.token, PUSH.token);
    assert.deepStrictEqual(posts[0].body.result, { media_buy_id: 'mb_external' });
    assert.ok(posts[0].headers.signature ?? posts[0].headers.Signature, 'delivered through the signing emitter');
    assert.strictEqual((await deliverPending(coordinator)).length, 0, 'no second delivery');
  });

  test('a worker cannot redirect the webhook: a different URL, token or operation id is refused', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    const server = serverFor(registry, coordinator, state);
    await dispatchCreate(server, { push_notification_config: PUSH });
    const [ref] = state.queued;
    const bound = { url: PUSH.url, token: PUSH.token, operationId: PUSH.operation_id };
    const result = { media_buy_id: 'mb_redirect' };

    for (const attempt of [
      { ...bound, url: 'https://attacker.example/hook' },
      { ...bound, token: 'attacker-token-0123456789abcdef' },
      { url: PUSH.url, operationId: PUSH.operation_id },
      { ...bound, operationId: 'other-op' },
      { ...bound, signingProfile: 'web-bot-auth' },
      { ...bound, authentication: { type: 'bearer', token: 'x'.repeat(40) } },
    ]) {
      await assert.rejects(
        lib.completeScopedPushTask(coordinator, ref, attempt, result),
        error => error instanceof lib.TaskPushBindingMismatchError,
        JSON.stringify({ ...attempt, token: attempt.token && '[redacted]' })
      );
    }
    assert.strictEqual(await count(OUTBOX), 0, 'a refused attempt writes nothing');
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');

    // The pre-existing helper still works when it names the bound route exactly.
    assert.deepStrictEqual(await lib.completeScopedPushTask(coordinator, ref, bound, result), {
      outcome: 'applied',
      delivery: 'durably_bound',
    });
    const posts = await deliverPending(coordinator);
    assert.deepStrictEqual(
      posts.map(post => post.url),
      [PUSH.url]
    );

    // Registry-only settlement cannot bypass the webhook.
    const second = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, second), { push_notification_config: PUSH });
    await assert.rejects(lib.completeScopedTask(registry, second.queued[0], { media_buy_id: 'mb_polling' }));
  });

  test('a binding is immutable once written', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, state), { push_notification_config: PUSH });
    const [ref] = state.queued;
    const support = require('../dist/lib/server/decisioning/runtime/postgres-task-settlement')._taskPushBindingSupport(
      coordinator
    );
    const bound = { url: PUSH.url, token: PUSH.token, operationId: PUSH.operation_id, servedAdcpVersion: undefined };
    await assert.rejects(
      support.bind(ref, { ...bound, url: 'https://attacker.example/hook' }),
      error => error instanceof lib.TaskPushBindingMismatchError
    );
    assert.strictEqual(await boundCount(), 1);
  });

  test('failed and rejected settlements deliver to the bound route', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    const server = serverFor(registry, coordinator, state);
    await dispatchCreate(server, { push_notification_config: PUSH });
    await dispatchCreate(server, { push_notification_config: { ...PUSH, operation_id: 'op-2' } });
    const [failedRef, rejectedRef] = state.queued;

    assert.strictEqual(
      (
        await lib.failBoundPushTask(coordinator, failedRef, {
          code: 'SERVICE_UNAVAILABLE',
          recovery: 'transient',
          message: 'remote agent failed',
        })
      ).outcome,
      'applied'
    );
    assert.strictEqual(
      (await lib.rejectBoundPushTask(coordinator, rejectedRef, { decision: 'declined' }, 'Inventory sold out')).outcome,
      'applied'
    );
    const posts = await deliverPending(coordinator);
    assert.strictEqual(posts.length, 2);
    const byTask = Object.fromEntries(posts.map(post => [post.body.task_id, post]));
    assert.strictEqual(byTask[failedRef.taskId].url, PUSH.url);
    assert.strictEqual(byTask[failedRef.taskId].body.status, 'failed');
    assert.strictEqual(byTask[failedRef.taskId].body.operation_id, 'op-1');
    assert.strictEqual(byTask[failedRef.taskId].body.message, 'remote agent failed');
    assert.strictEqual(byTask[rejectedRef.taskId].body.status, 'rejected');
    assert.strictEqual(byTask[rejectedRef.taskId].body.operation_id, 'op-2');
    assert.strictEqual(byTask[rejectedRef.taskId].body.message, 'Inventory sold out');
    assert.strictEqual((await registry.getTask(rejectedRef.taskId, rejectedRef)).status, 'rejected');
  });

  describe('release projection of bound settlement webhooks (DR-0024)', () => {
    const { ADCP_VERSION, toReleasePrecisionVersion } = require('../dist/lib/version');
    const { projectToolPayload } = require('../dist/lib/adapters/version');
    const { validateResponse } = require('../dist/lib/validation/schema-validator');
    const SERVED = toReleasePrecisionVersion(ADCP_VERSION);
    const BUYER_REASON = { code: 'X', message: 'y' };
    const COLLECTION_LISTS = [{ agent_url: 'https://g.example', list_id: 'l' }];
    const COMPLETED = () => ({
      media_buy_id: 'mb_1',
      media_buy_status: 'pending_creatives',
      confirmed_at: '2026-04-29T00:00:00Z',
      revision: 1,
      packages: [{ package_id: 'pk', targeting_overlay: { collection_lists: structuredClone(COLLECTION_LISTS) } }],
    });

    async function handoff(release) {
      const { registry, coordinator } = stack();
      const state = { queued: [] };
      const server = serverFor(registry, coordinator, state);
      await dispatchCreate(server, { push_notification_config: PUSH, adcp_version: release });
      return { registry, coordinator, ref: state.queued[0] };
    }

    test('a 3.2 caller gets a completed webhook without 3.3-only fields while the task row keeps them', async () => {
      const { registry, coordinator, ref } = await handoff('3.2');
      assert.strictEqual((await lib.completeBoundPushTask(coordinator, ref, COMPLETED())).outcome, 'applied');
      const [post] = await deliverPending(coordinator);
      assert.strictEqual(post.body.status, 'completed');
      assert.strictEqual(post.body.result.packages[0].targeting_overlay?.collection_lists, undefined);
      const { dropped } = projectToolPayload('create_media_buy', 'sync', post.body.result, ADCP_VERSION, '3.2');
      assert.deepStrictEqual(dropped, []);
      const validated = validateResponse('create_media_buy', post.body.result, '3.2');
      assert.strictEqual(validated.valid, true, JSON.stringify(validated.issues));
      const stored = (await registry.getTask(ref.taskId, ref)).result;
      assert.deepStrictEqual(stored.packages[0].targeting_overlay.collection_lists, COLLECTION_LISTS);
    });

    test('a caller at the served release keeps 3.3-only fields in the completed webhook', async () => {
      const { coordinator, ref } = await handoff(SERVED);
      await lib.completeBoundPushTask(coordinator, ref, COMPLETED());
      const [post] = await deliverPending(coordinator);
      assert.deepStrictEqual(post.body.result.packages[0].targeting_overlay.collection_lists, COLLECTION_LISTS);
    });

    test('a 3.2 caller gets a rejection webhook without mutation_outcome but with buyer_reason', async () => {
      const { coordinator, ref } = await handoff('3.2');
      const errors = [
        { code: 'POLICY_VIOLATION', message: 'no', mutation_outcome: 'not_applied', buyer_reason: BUYER_REASON },
      ];
      assert.strictEqual((await lib.rejectBoundPushTask(coordinator, ref, { errors }, 'no')).outcome, 'applied');
      const [post] = await deliverPending(coordinator);
      assert.strictEqual(post.body.status, 'rejected');
      const [error] = post.body.result.errors;
      assert.strictEqual(error.mutation_outcome, undefined);
      assert.deepStrictEqual(error.buyer_reason, BUYER_REASON);
    });

    test('a caller at the served release keeps mutation_outcome in the rejection webhook', async () => {
      const { coordinator, ref } = await handoff(SERVED);
      const errors = [
        { code: 'POLICY_VIOLATION', message: 'no', mutation_outcome: 'not_applied', buyer_reason: BUYER_REASON },
      ];
      await lib.rejectBoundPushTask(coordinator, ref, { errors }, 'no');
      const [post] = await deliverPending(coordinator);
      assert.strictEqual(post.body.result.errors[0].mutation_outcome, 'not_applied');
      assert.deepStrictEqual(post.body.result.errors[0].buyer_reason, BUYER_REASON);
    });

    const NO_TOKEN_PUSH = { url: PUSH.url, operation_id: PUSH.operation_id };

    async function handoffNoToken(release) {
      const { registry, coordinator } = stack();
      const state = { queued: [] };
      const server = serverFor(registry, coordinator, state);
      await dispatchCreate(server, { push_notification_config: NO_TOKEN_PUSH, adcp_version: release });
      return { registry, coordinator, ref: state.queued[0] };
    }

    /** Rewrite the recorded server release of the stored binding, keeping its fingerprint valid. */
    async function rewriteServerRelease(ref, serverAdcpVersion) {
      const { canonicalJsonSha256 } = require('../dist/lib/utils/jcs');
      const { rows } = await pool.query(`SELECT push_binding FROM ${TABLE} WHERE task_id = $1`, [ref.taskId]);
      const binding = { ...rows[0].push_binding, serverAdcpVersion };
      const { url, operationId, servedAdcpVersion, signingProfile } = binding;
      binding.fingerprint = canonicalJsonSha256({
        url,
        ...(operationId !== undefined && { operationId }),
        ...(servedAdcpVersion !== undefined && { servedAdcpVersion }),
        serverAdcpVersion,
        ...(signingProfile !== undefined && { signingProfile }),
      });
      await pool.query(`UPDATE ${TABLE} SET push_binding = $2::jsonb WHERE task_id = $1`, [
        ref.taskId,
        JSON.stringify(binding),
      ]);
    }

    for (const recorded of ['3.3.0-beta.6', '3.9.0-beta.1']) {
      test(`an unconvertible recorded release (${recorded}) refuses settlement and writes nothing`, async () => {
        const { registry, coordinator, ref } = await handoffNoToken('3.2');
        await rewriteServerRelease(ref, recorded);
        await assert.rejects(
          lib.completeBoundPushTask(coordinator, ref, COMPLETED()),
          error => error instanceof lib.TaskPushSettlementConfigurationError
        );
        assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');
        assert.strictEqual(await count(OUTBOX), 0);
      });
    }

    test('a retry of a checkpoint whose source exceeds the snapshot limit stays compatible once the release is unconvertible', async () => {
      const { registry, coordinator } = stack({ recovery: { defaultLeaseMs: 1000, maxSnapshotBytes: 1024 } });
      const state = { queued: [] };
      const server = serverFor(registry, coordinator, state);
      await dispatchCreate(server, { push_notification_config: NO_TOKEN_PUSH, adcp_version: '3.2' });
      const [ref] = state.queued;
      const big = COMPLETED();
      big.packages[0].targeting_overlay.collection_lists = Array.from({ length: 40 }, (_, i) => ({
        agent_url: 'https://g.example',
        list_id: `list-${i}-${'x'.repeat(20)}`,
      }));
      assert.ok(Buffer.byteLength(JSON.stringify(big)) > 1024, 'the source exceeds the limit');
      assert.strictEqual((await lib.completeBoundPushTask(coordinator, ref, big)).outcome, 'applied');
      await rewriteServerRelease(ref, '3.9.0-beta.1');
      const retried = () => lib.completeBoundPushTask(coordinator, ref, big);
      const expectCompatible = async () => {
        const outcome = await retried();
        assert.strictEqual(outcome.outcome, 'already_terminal');
        assert.strictEqual(outcome.compatibility, 'compatible');
      };
      await expectCompatible();
      const [post] = await deliverPending(coordinator);
      assert.ok(Buffer.byteLength(JSON.stringify(post.body)) < 1024, 'the projected payload fits');
      assert.strictEqual(post.body.result.packages[0].targeting_overlay?.collection_lists, undefined);
      await expectCompatible();
    });

    test('an exact retry stays compatible after the recorded release becomes unconvertible', async () => {
      const { coordinator, ref } = await handoffNoToken('3.2');
      assert.strictEqual((await lib.completeBoundPushTask(coordinator, ref, COMPLETED())).outcome, 'applied');
      await rewriteServerRelease(ref, '3.9.0-beta.1');
      const retried = async result => lib.completeBoundPushTask(coordinator, ref, result);
      const compatible = { outcome: 'already_terminal', status: 'completed', compatibility: 'compatible' };

      assert.deepStrictEqual(
        { ...(await retried(COMPLETED())), delivery: undefined },
        { ...compatible, delivery: undefined }
      );
      const differing = { ...COMPLETED(), media_buy_id: 'mb_other' };
      assert.strictEqual((await retried(differing)).compatibility, 'conflicting');

      assert.strictEqual((await deliverPending(coordinator)).length, 1);
      assert.strictEqual((await retried(COMPLETED())).compatibility, 'compatible');
      assert.strictEqual((await retried(differing)).compatibility, 'conflicting');
    });
  });

  test('a separate worker process reconstructs the coordinator and still delivers after a restart', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, state), { push_notification_config: PUSH });
    const [ref] = state.queued;

    const script = `
      const assert = require('node:assert');
      const { createHash } = require('node:crypto');
      const { Pool } = require('pg');
      const lib = require('./dist/lib/server/decisioning');
      const adapter = {
        protect(authentication, context) {
          const secret = authentication.token ?? authentication.secret;
          return {
            protectedValue: { ciphertext: Buffer.from(context.purpose + ':' + secret, 'utf8').toString('base64') },
            fingerprint: createHash('sha256').update(context.purpose + ':' + secret).digest('hex'),
          };
        },
        resolve(protectedValue, context) {
          const cleartext = Buffer.from(protectedValue.ciphertext, 'base64').toString('utf8');
          return { type: 'bearer', token: cleartext.slice((context.purpose + ':').length) };
        },
      };
      (async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const registry = lib.createPostgresTaskRegistry({
          pool, namespace: process.env.TASK_NAMESPACE, storageId: process.env.TASK_STORAGE_ID, tableName: process.env.TASK_TABLE,
        });
        const coordinator = lib.createPostgresTaskSettlementCoordinator({
          registry,
          publisherScope: process.env.TASK_PUBLISHER,
          outbox: { tableName: process.env.TASK_OUTBOX },
          authenticationAdapter: adapter,
        });
        // The worker holds only the queued ref and its result.
        const outcome = await lib.completeBoundPushTask(coordinator, JSON.parse(process.env.TASK_REF), { media_buy_id: 'mb_restart' });
        process.stdout.write(JSON.stringify(outcome));
        await pool.end();
      })().catch(error => { process.stderr.write(error.stack || String(error)); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TASK_NAMESPACE: NAMESPACE,
        TASK_STORAGE_ID: STORAGE_ID,
        TASK_TABLE: TABLE,
        TASK_PUBLISHER: PUBLISHER,
        TASK_OUTBOX: OUTBOX,
        TASK_REF: JSON.stringify(ref),
      },
    });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.deepStrictEqual(JSON.parse(child.stdout), { outcome: 'applied', delivery: 'durably_bound' });

    // A freshly constructed coordinator (another restart) runs the recovery worker.
    const restarted = stack().coordinator;
    const posts = await deliverPending(restarted);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].url, PUSH.url);
    assert.strictEqual(posts[0].body.token, PUSH.token);
    assert.deepStrictEqual(posts[0].body.result, { media_buy_id: 'mb_restart' });
  });

  test('applyTaskSettlementIntent settles a bound task without a push argument', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, state), { push_notification_config: PUSH });
    const intent = lib.canonicalizeTaskSettlementIntent({
      taskRef: state.queued[0],
      action: 'complete',
      result: { media_buy_id: 'mb_intent' },
    });
    assert.strictEqual(await lib.applyTaskSettlementIntent(intent, { coordinator }), 'settled');
    assert.strictEqual(await lib.applyTaskSettlementIntent(intent, { coordinator }), 'settled');
    assert.strictEqual((await deliverPending(coordinator)).length, 1);
  });

  test('a push token is refused at the call when the coordinator cannot protect it', async () => {
    const { registry, coordinator } = stack({ adapter: null });
    const state = { queued: [] };
    let afterHandoff = false;
    const server = serverFor(registry, coordinator, state, {
      createMediaBuy: async (_req, ctx) => {
        const handoff = ctx.handoffToTask(async () => {}, { settlement: 'external' });
        afterHandoff = true;
        return handoff;
      },
    });
    const refused = await dispatchCreate(server, { push_notification_config: PUSH });
    assert.strictEqual(refused.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
    assert.strictEqual(afterHandoff, false);

    // Without a token the same coordinator binds and delivers.
    const { token: _token, ...tokenless } = PUSH;
    const accepted = await dispatchCreate(serverFor(registry, coordinator, state), {
      push_notification_config: tokenless,
    });
    assert.strictEqual(accepted.structuredContent.status, 'submitted', JSON.stringify(accepted.structuredContent));
    await lib.completeBoundPushTask(coordinator, state.queued[0], { media_buy_id: 'mb_tokenless' });
    const posts = await deliverPending(coordinator);
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].body.token, undefined);
  });

  test('polling-only external settlement and framework settlement are unchanged with a coordinator', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    const polling = await dispatchCreate(serverFor(registry, coordinator, state));
    assert.strictEqual(polling.structuredContent.status, 'submitted');
    assert.strictEqual((await registry.getTask(state.queued[0].taskId, state.queued[0])).hasWebhook, undefined);
    assert.strictEqual(
      (await lib.completeScopedTask(registry, state.queued[0], { media_buy_id: 'mb_poll' })).outcome,
      'applied'
    );
    await assert.rejects(
      lib.completeBoundPushTask(coordinator, state.queued[0], { media_buy_id: 'mb_poll' }),
      /hasWebhook|no SDK push binding/
    );

    const emitted = [];
    const framework = serverFor(registry, coordinator, state, {
      createMediaBuy: async (_req, ctx) => ctx.handoffToTask(async () => ({ media_buy_id: 'mb_framework' })),
      serverOptions: {
        taskWebhookEmitter: {
          emit: async params => {
            emitted.push(params);
            return { delivery_id: params.delivery_id, idempotency_key: 'k', attempts: 1, delivered: true, errors: [] };
          },
        },
      },
    });
    const result = await dispatchCreate(framework, { push_notification_config: PUSH });
    await framework.awaitTaskUnsafe(result.structuredContent.task_id);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].url, PUSH.url);
    assert.strictEqual(await boundCount(), 0, 'framework settlement does not bind');
    assert.strictEqual(await count(OUTBOX), 0, 'framework settlement uses its own emitter path');
  });

  test('a coordinator bound to a different registry is rejected at construction', () => {
    const { coordinator } = stack();
    const otherRegistry = lib.createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:other',
      tableName: TABLE,
    });
    assert.throws(
      () => serverFor(otherRegistry, coordinator, { queued: [] }),
      error => error instanceof PlatformConfigError && /bound to this server's taskRegistry/.test(error.message)
    );
  });

  test('no coordinator configuration can redirect a bound task', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, state), { push_notification_config: PUSH });
    const [ref] = state.queued;
    const evil = {
      url: 'https://attacker.example/hook',
      token: 'attacker-chosen-token-0123456789',
      operationId: 'op-evil',
    };
    const result = { media_buy_id: 'x' };

    // Same registry, different publisherScope and no adapter: the binding lives on the task row, so it is
    // still found, and the scoped helper is refused rather than falling back to the caller's route.
    for (const worker of [stack({ publisherScope: 'some-other-scope' }), stack({ adapter: null })]) {
      await assert.rejects(
        lib.completeScopedPushTask(worker.coordinator, ref, evil, result),
        error => error instanceof lib.TaskPushSettlementConfigurationError
      );
    }
    // A coordinator over another registry table or storage identity cannot address the task at all.
    for (const other of [stack({ tableName: UNMIGRATED }), stack({ storageId: 'store:other' })]) {
      assert.deepStrictEqual(await lib.completeScopedPushTask(other.coordinator, ref, evil, result), {
        outcome: 'not_found_in_scope',
        delivery: 'not_applicable',
      });
    }
    assert.strictEqual(await count(OUTBOX), 0, 'nothing was checkpointed for any redirect attempt');
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');

    // The server's recovery worker never sees an attacker route.
    await lib.completeBoundPushTask(coordinator, ref, result);
    const posts = await deliverPending(coordinator);
    assert.deepStrictEqual(
      posts.map(post => [post.url, post.body.token, post.body.operation_id]),
      [[PUSH.url, PUSH.token, PUSH.operation_id]]
    );
  });

  test('a corrupted or partially edited binding fails closed', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, state), { push_notification_config: PUSH });
    const [ref] = state.queued;
    await pool.query(
      `UPDATE ${TABLE} SET push_binding = jsonb_set(push_binding, '{url}', '"https://attacker.example/hook"') WHERE task_id = $1`,
      [ref.taskId]
    );
    await assert.rejects(lib.completeBoundPushTask(coordinator, ref, { media_buy_id: 'x' }), /consistency check/);
    await assert.rejects(
      lib.completeScopedPushTask(
        coordinator,
        ref,
        { url: 'https://attacker.example/hook', token: PUSH.token, operationId: PUSH.operation_id },
        { media_buy_id: 'x' }
      ),
      /consistency check/
    );
    assert.strictEqual(await count(OUTBOX), 0);
  });

  test('an unmigrated registry refuses before creating a task, calling the producer, or logging the token', async () => {
    const { registry, coordinator } = stack({ tableName: UNMIGRATED, storageId: 'store:unmigrated' });
    const state = { queued: [] };
    const logged = [];
    const logger = {
      debug: m => logged.push(String(m)),
      info: m => logged.push(String(m)),
      warn: m => logged.push(String(m)),
      error: m => logged.push(String(m)),
    };
    const server = serverFor(registry, coordinator, state, { serverOptions: { logger } });
    const result = await dispatchCreate(server, { push_notification_config: PUSH });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.strictEqual(result.structuredContent.status, 'failed');
    assert.strictEqual(state.queued.length, 0, 'the producer was not called');
    assert.strictEqual(await count(UNMIGRATED), 0, 'no orphaned has_webhook task');
    assert.ok(
      logged.some(line => /getTaskPushBindingMigration/.test(line)),
      logged.join('\n')
    );
    assert.ok(!logged.some(line => line.includes(PUSH.token)), 'the token is never logged');
    assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(PUSH.token));

    // Application-managed push settlement keeps working on the unmigrated table.
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    assert.deepStrictEqual(
      await lib.completeScopedPushTask(
        coordinator,
        ref,
        { url: 'https://buyer.example/app-managed', operationId: 'app-op' },
        { media_buy_id: 'mb_app' }
      ),
      { outcome: 'applied', delivery: 'durably_bound' }
    );
  });

  test('concurrent bound and scoped settlements commit one terminal result and one outbox row', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    await dispatchCreate(serverFor(registry, coordinator, state), { push_notification_config: PUSH });
    const [ref] = state.queued;
    const result = { media_buy_id: 'mb_concurrent' };
    const bound = { url: PUSH.url, token: PUSH.token, operationId: PUSH.operation_id };
    const outcomes = await Promise.allSettled([
      lib.completeBoundPushTask(coordinator, ref, result),
      lib.completeBoundPushTask(stack().coordinator, ref, result),
      lib.completeScopedPushTask(coordinator, ref, bound, result),
      lib.completeScopedPushTask(coordinator, ref, { ...bound, url: 'https://attacker.example/hook' }, result),
    ]);
    assert.strictEqual(outcomes[3].status, 'rejected');
    const settled = outcomes
      .slice(0, 3)
      .filter(o => o.status === 'fulfilled')
      .map(o => o.value);
    assert.strictEqual(settled.filter(o => o.outcome === 'applied').length, 1, JSON.stringify(outcomes));
    assert.strictEqual(await count(OUTBOX), 1);
    assert.deepStrictEqual(
      (await deliverPending(coordinator)).map(post => post.url),
      [PUSH.url]
    );
  });

  test('a web-bot-auth signing profile is bound and checkpointed with the delivery', async () => {
    // The server accepts signing_profile: 'web-bot-auth' only when the seller advertises it (identity 3.3),
    // so bind directly through the framework's internal binding capability, as dispatch does.
    const { registry, coordinator } = stack();
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const support = require('../dist/lib/server/decisioning/runtime/postgres-task-settlement')._taskPushBindingSupport(
      coordinator
    );
    await support.bind(ref, {
      url: PUSH.url,
      token: PUSH.token,
      operationId: PUSH.operation_id,
      signingProfile: 'web-bot-auth',
    });
    await assert.rejects(
      lib.completeScopedPushTask(
        coordinator,
        ref,
        { url: PUSH.url, token: PUSH.token, operationId: PUSH.operation_id },
        { media_buy_id: 'x' }
      ),
      error => error instanceof lib.TaskPushBindingMismatchError,
      'omitting the bound profile is a mismatch'
    );
    await lib.completeBoundPushTask(coordinator, ref, { media_buy_id: 'mb_wba' });
    const [lease] = await coordinator.recovery.claimPending({ ownerToken: 'web-bot-auth-check', limit: 1 });
    assert.strictEqual(lease.snapshot.signingProfile, 'web-bot-auth');
    assert.strictEqual(lease.snapshot.url, PUSH.url);
  });

  test('a pre-3.2.0-beta.5 request binds without operation_id and derives it from the task', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    const server = serverFor(registry, coordinator, state, { serverOptions: { adcpVersion: '3.1.0' } });
    const { operation_id: _op, ...legacyPush } = PUSH;
    const result = await dispatchCreate(server, { push_notification_config: legacyPush, adcp_version: '3.1' });
    assert.strictEqual(result.structuredContent.status, 'submitted', JSON.stringify(result.structuredContent));
    const [ref] = state.queued;
    await lib.completeBoundPushTask(coordinator, ref, { media_buy_id: 'mb_legacy' });
    const posts = await deliverPending(coordinator);
    assert.strictEqual(posts[0].body.operation_id, `create_media_buy.${ref.taskId}`);
  });

  test('a modern request without operation_id is refused before any task or producer', async () => {
    const { registry, coordinator } = stack();
    const state = { queued: [] };
    let afterHandoff = false;
    const server = serverFor(registry, coordinator, state, {
      createMediaBuy: async (_req, ctx) => {
        const handoff = ctx.handoffToTask(async taskCtx => state.queued.push(taskCtx.taskRef), {
          settlement: 'external',
        });
        afterHandoff = true;
        return handoff;
      },
    });
    const { operation_id: _op, ...noOperation } = PUSH;
    const result = await dispatchCreate(server, { push_notification_config: noOperation });
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'push_notification_config.operation_id');
    assert.strictEqual(afterHandoff, false);
    assert.strictEqual(state.queued.length, 0);
    assert.strictEqual(await count(TABLE), 0);
  });

  test('a coordinator that has seen the push_binding column fails closed if it disappears', async () => {
    const DROPPED = 'adcp_ext_push_dropped';
    await pool.query(`DROP TABLE IF EXISTS ${DROPPED} CASCADE`);
    await pool.query(lib.getDecisioningTaskRegistryBootstrap({ tableName: DROPPED, namespace: NAMESPACE }));
    try {
      const { registry, coordinator } = stack({ tableName: DROPPED, storageId: 'store:dropped' });
      const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
      const support =
        require('../dist/lib/server/decisioning/runtime/postgres-task-settlement')._taskPushBindingSupport(coordinator);
      await support.ensureReady();
      await support.bind(ref, { url: PUSH.url, operationId: PUSH.operation_id });
      await pool.query(`ALTER TABLE ${DROPPED} DROP COLUMN push_binding`);
      await assert.rejects(
        lib.completeScopedPushTask(
          coordinator,
          ref,
          { url: 'https://attacker.example/hook', operationId: 'op-evil' },
          { media_buy_id: 'x' }
        ),
        /push_binding column disappeared/
      );
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${DROPPED} CASCADE`);
    }
  });
});
