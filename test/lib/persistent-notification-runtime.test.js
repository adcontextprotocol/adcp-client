const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  createPersistentNotificationRuntime,
  createWebhookEmitter,
  createWebhookDeliveryRecovery,
  memoryNotificationSubscriptionStore,
  memoryWebhookDeliveryRecoveryBackend,
  memoryWebhookDeliveryStore,
  getNotificationSubscriptionMigration,
  pgNotificationSubscriptionStore,
  createPostgresPersistentNotificationRuntime,
  NotificationSubscriptionValidationError,
} = require('../../dist/lib/server/index.js');
const { canonicalJsonSha256 } = require('../../dist/lib/utils/jcs.js');

function signerKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    keyid: 'notification-runtime-test',
    alg: 'ed25519',
    privateKey: {
      ...jwk,
      kid: 'notification-runtime-test',
      alg: 'ed25519',
      adcp_use: 'request-signing',
      key_ops: ['sign'],
    },
  };
}

function scriptedFetch(statuses) {
  const queue = [...statuses];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      status: queue.shift() ?? 204,
      headers: { get: () => undefined },
    };
  };
  fetch.calls = calls;
  return fetch;
}

function makeRuntime({
  fetch = scriptedFetch([204]),
  proof = async () => ({ proved: true }),
  authorize = async () => ({ authorized: true }),
  credentialAdapter,
  retries = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  sleep = async () => {},
  runtimeOptions = {},
} = {}) {
  const store = memoryNotificationSubscriptionStore();
  const runtime = createPersistentNotificationRuntime({
    store,
    proofAdapter: { prove: proof },
    authorizeDelivery: authorize,
    validateDestination: async () => ({ allowed: true }),
    credentialAdapter,
    ...runtimeOptions,
    createEmitter: authorizeAttempt =>
      createWebhookEmitter({
        signerKey: signerKey(),
        fetch,
        retries,
        sleep,
        authorizeAttempt,
      }),
  });
  return { runtime, store, fetch };
}

const callerA = { kind: 'caller', tenantId: 'seller-us', principalId: 'buyer-a' };
const callerB = { kind: 'caller', tenantId: 'seller-us', principalId: 'buyer-b' };
const accountA = { ...callerA, kind: 'account', accountId: 'account-1' };

test('caller-scoped full-set replacement is isolated, idempotent, and generation fenced', async () => {
  const { runtime } = makeRuntime();
  const config = {
    subscriber_id: 'primary',
    url: 'https://buyer.example/capabilities',
    event_types: ['capabilities.changed'],
  };

  const first = await runtime.replace(callerA, [config]);
  const secondCaller = await runtime.replace(callerB, [config]);
  assert.equal(first.outcome, 'applied');
  assert.equal(secondCaller.outcome, 'applied');
  assert.notEqual(first.generation, secondCaller.generation);

  const replay = await runtime.replace(callerA, [config], { expectedGeneration: first.generation });
  assert.equal(replay.outcome, 'unchanged');
  assert.equal(replay.generation, first.generation);

  const stale = await runtime.replace(callerA, [], { expectedGeneration: 'cfg_stale' });
  assert.deepEqual(stale, { outcome: 'conflict', currentGeneration: first.generation });

  const cleared = await runtime.replace(callerA, [], { expectedGeneration: first.generation });
  assert.equal(cleared.outcome, 'cleared');
  assert.deepEqual((await runtime.read(callerA)).notificationConfigs, []);
  assert.equal((await runtime.read(callerB)).notificationConfigs.length, 1);
});

test('replacement enforces the protocol subscriber cap', async () => {
  const { runtime } = makeRuntime();
  await assert.rejects(
    () =>
      runtime.replace(
        callerA,
        Array.from({ length: 17 }, (_, index) => ({
          subscriber_id: `subscriber-${index}`,
          url: `https://buyer.example/hooks/${index}`,
          event_types: ['capabilities.changed'],
        }))
      ),
    error =>
      error instanceof NotificationSubscriptionValidationError &&
      error.field === 'notification_configs' &&
      /at most 16/.test(error.message)
  );
});

test('fanout delivery cap fails closed before sending any partial set', async () => {
  const { runtime, fetch } = makeRuntime({ runtimeOptions: { maxFanoutCandidates: 1 } });
  await runtime.replace(callerA, [
    {
      subscriber_id: 'first',
      url: 'https://buyer.example/first',
      event_types: ['capabilities.changed'],
    },
    {
      subscriber_id: 'second',
      url: 'https://buyer.example/second',
      event_types: ['capabilities.changed'],
    },
  ]);

  await assert.rejects(
    () =>
      runtime.emit({
        emissionId: 'emission-overflow',
        notificationId: 'notification-overflow',
        notificationType: 'capabilities.changed',
        anchor: 'caller',
        tenantId: callerA.tenantId,
        principalId: callerA.principalId,
        payload: { repair: '/capabilities' },
      }),
    /fanout exceeded maxFanoutCandidates/
  );
  assert.equal(fetch.calls.length, 0);
});

test('paused subscriptions do not consume the active fanout candidate cap', async () => {
  const { runtime, fetch } = makeRuntime({ runtimeOptions: { maxFanoutCandidates: 1 } });
  await runtime.replace(callerA, [
    {
      subscriber_id: 'paused',
      url: 'https://buyer.example/paused',
      event_types: ['capabilities.changed'],
      active: false,
    },
  ]);
  await runtime.replace(callerB, [
    {
      subscriber_id: 'live',
      url: 'https://buyer.example/live',
      event_types: ['capabilities.changed'],
    },
  ]);

  const result = await runtime.emit({
    emissionId: 'emission-live-only',
    notificationId: 'notification-live-only',
    notificationType: 'capabilities.changed',
    anchor: 'caller',
    tenantId: callerA.tenantId,
    payload: { repair: '/capabilities' },
  });
  assert.equal(result.matched, 1);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.subscriber_id, 'live');
});

test('anchor validation rejects incompatible event types and requires all-account acknowledgement', async () => {
  const { runtime } = makeRuntime();
  await assert.rejects(
    () =>
      runtime.replace(accountA, [
        {
          subscriber_id: 'wrong-anchor',
          url: 'https://buyer.example/hook',
          event_types: ['capabilities.changed'],
        },
      ]),
    error =>
      error instanceof NotificationSubscriptionValidationError &&
      /(caller-anchored|not supported on this anchor)/.test(error.message)
  );
  await assert.rejects(
    () =>
      runtime.replace(callerA, [
        {
          subscriber_id: 'all-accounts',
          url: 'https://buyer.example/hook',
          event_types: ['account.change_recorded'],
        },
      ]),
    error => error instanceof NotificationSubscriptionValidationError && /all_authorized_accounts/.test(error.message)
  );
});

test('future event opt-in delivers only explicitly classified caller invalidations', async () => {
  const { runtime, fetch } = makeRuntime({
    runtimeOptions: { futureCallerInvalidationEventTypes: ['catalog.invalidated'] },
  });
  await runtime.replace(callerA, [
    {
      subscriber_id: 'future-aware',
      url: 'https://buyer.example/future',
      event_types: ['capabilities.changed'],
      include_future_event_types: true,
    },
    {
      subscriber_id: 'current-only',
      url: 'https://buyer.example/current',
      event_types: ['capabilities.changed'],
    },
  ]);

  const result = await runtime.emit({
    emissionId: 'emission-future',
    notificationId: 'notification-future',
    notificationType: 'catalog.invalidated',
    anchor: 'caller',
    tenantId: callerA.tenantId,
    principalId: callerA.principalId,
    payload: { repair: '/catalog' },
  });

  assert.equal(result.matched, 1);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.subscriber_id, 'future-aware');
});

test('changed active tuple is proved before CAS and proof failure preserves the prior set', async () => {
  const proofInputs = [];
  const { runtime } = makeRuntime({
    proof: async input => {
      proofInputs.push(input);
      return { proved: !input.url.includes('/reject') };
    },
  });
  const initial = await runtime.replace(accountA, [
    {
      subscriber_id: 'feed',
      url: 'https://buyer.example/accept',
      event_types: ['account.change_recorded'],
    },
  ]);
  assert.equal(initial.outcome, 'applied');
  assert.equal(proofInputs.length, 1);

  const rejected = await runtime.replace(accountA, [
    {
      subscriber_id: 'feed',
      url: 'https://buyer.example/reject',
      event_types: ['account.change_recorded', 'account.status_changed'],
    },
  ]);
  assert.deepEqual(rejected, { outcome: 'proof_failed', subscriberId: 'feed' });
  const readback = await runtime.read(accountA);
  assert.equal(readback.generation, initial.generation);
  assert.equal(readback.notificationConfigs[0].url, 'https://buyer.example/accept');
  assert.equal(
    readback.notificationConfigs[0].proof_generation,
    readback.notificationConfigs[0].destination_generation
  );
});

test('account event fans out independently to account and all-authorized caller subscribers', async () => {
  const fetch = scriptedFetch([500, 204, 500, 204]);
  let authorizationChecks = 0;
  const { runtime } = makeRuntime({
    fetch,
    retries: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    authorize: async () => {
      authorizationChecks++;
      return { authorized: true };
    },
  });
  await runtime.replace(accountA, [
    {
      subscriber_id: 'account-hook',
      url: 'https://buyer.example/account',
      event_types: ['account.change_recorded'],
    },
  ]);
  await runtime.replace(callerA, [
    {
      subscriber_id: 'principal-hook',
      url: 'https://buyer.example/principal',
      event_types: ['account.change_recorded'],
      all_authorized_accounts: true,
    },
  ]);

  const result = await runtime.emit({
    emissionId: 'emit-account-change-0001',
    notificationId: 'change-42',
    notificationType: 'account.change_recorded',
    anchor: 'account',
    tenantId: 'seller-us',
    principalId: 'buyer-a',
    accountId: 'account-1',
    payload: { change_id: 'change-42', through_cursor: 'cursor-advisory' },
  });
  assert.equal(result.matched, 2);
  assert.equal(result.deliveries.length, 2);
  assert.equal(fetch.calls.length, 4);
  assert.equal(authorizationChecks, 4, 'authorization is re-evaluated before every retry');
  assert.deepEqual(new Set(fetch.calls.map(call => call.body.notification_id)), new Set(['change-42']));
  assert.equal(new Set(fetch.calls.map(call => call.body.subscriber_id)).size, 2);
  for (const subscriber of ['account-hook', 'principal-hook']) {
    const calls = fetch.calls.filter(call => call.body.subscriber_id === subscriber);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.idempotency_key, calls[1].body.idempotency_key);
  }
});

test('deactivation during retry suppresses old work before the second external attempt', async () => {
  const fetch = scriptedFetch([500, 204]);
  let runtime;
  let deactivated = false;
  ({ runtime } = makeRuntime({
    fetch,
    retries: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    sleep: async () => {
      if (deactivated) return;
      deactivated = true;
      await runtime.replace(accountA, [
        {
          subscriber_id: 'revocable',
          url: 'https://buyer.example/revocable',
          event_types: ['account.status_changed'],
          active: false,
        },
      ]);
    },
  }));
  await runtime.replace(accountA, [
    {
      subscriber_id: 'revocable',
      url: 'https://buyer.example/revocable',
      event_types: ['account.status_changed'],
    },
  ]);

  const result = await runtime.emit({
    emissionId: 'emit-account-status-0001',
    notificationId: 'account-status-7',
    notificationType: 'account.status_changed',
    anchor: 'account',
    tenantId: 'seller-us',
    principalId: 'buyer-a',
    accountId: 'account-1',
    payload: { status: 'suspended' },
  });
  assert.equal(fetch.calls.length, 1);
  assert.equal(result.deliveries[0].result.attempts, 1);
  assert.deepEqual(result.deliveries[0].result.suppression, { reason: 'subscription_inactive' });
  assert.equal(result.deliveries[0].result.terminal, true);
});

test('legacy credentials remain write-only and resolve only after per-attempt authorization', async () => {
  const secret = 'secret-material-with-at-least-32-characters';
  let resolves = 0;
  const credentialAdapter = {
    bind({ credential }) {
      return { bindingId: `vault_${createHash('sha256').update(credential).digest('hex')}` };
    },
    resolve({ mode }) {
      resolves++;
      assert.equal(mode, 'bearer');
      return { type: 'bearer', token: secret };
    },
  };
  const { runtime, store } = makeRuntime({ credentialAdapter });
  await runtime.replace(accountA, [
    {
      subscriber_id: 'legacy',
      url: 'https://buyer.example/legacy',
      event_types: ['reporting.delivery_ready'],
      authentication: { schemes: ['Bearer'], credentials: secret },
    },
  ]);
  const stored = await store.get(accountA);
  assert.ok(!JSON.stringify(stored).includes(secret));
  const readback = await runtime.read(accountA);
  assert.deepEqual(readback.notificationConfigs[0].authentication, { schemes: ['Bearer'] });

  await runtime.emit({
    emissionId: 'emit-report-ready-0001',
    notificationId: 'report-ready-1',
    notificationType: 'reporting.delivery_ready',
    anchor: 'account',
    tenantId: 'seller-us',
    principalId: 'buyer-a',
    accountId: 'account-1',
    payload: { reporting_run_id: 'run-1' },
  });
  assert.equal(resolves, 1);
});

test('durable recovery round-trips non-secret authorization context and suppresses stale work', async () => {
  const backend = { ...memoryWebhookDeliveryRecoveryBackend(), durability: 'durable' };
  const recovery = createWebhookDeliveryRecovery({ backend });
  const deliveryStore = memoryWebhookDeliveryStore();
  const firstFetch = scriptedFetch([503]);
  const first = createWebhookEmitter({
    signerKey: signerKey(),
    fetch: firstFetch,
    sleep: async () => {},
    retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryStore,
    deliveryRecovery: recovery,
    authorizeAttempt: async () => ({ decision: 'allow' }),
  });
  const authorizationContext = {
    kind: 'adcp_notification_subscription',
    version: 1,
    destinationGeneration: 'dest_old',
  };
  const initial = await first.emit({
    url: 'https://buyer.example/recovery',
    payload: { notification_id: 'logical-1' },
    delivery_id: 'durable-notification-delivery',
    attemptAuthorizationContext: authorizationContext,
  });
  assert.equal(initial.delivered, false);

  const [lease] = await recovery.claimPending({ ownerToken: 'recovery-worker', limit: 1 });
  assert.deepEqual(lease.snapshot.attemptAuthorizationContext, authorizationContext);
  const recoveredFetch = scriptedFetch([204]);
  const recovered = createWebhookEmitter({
    signerKey: signerKey(),
    fetch: recoveredFetch,
    sleep: async () => {},
    publisherScope: 'publisher',
    tenantScope: 'tenant',
    deliveryStore,
    deliveryRecovery: recovery,
    authorizeAttempt: async info => {
      assert.deepEqual(info.attemptAuthorizationContext, authorizationContext);
      return { decision: 'suppress', reason: 'subscription_stale' };
    },
  });
  const result = await recovered.emitRecovered(lease);
  assert.equal(recoveredFetch.calls.length, 0);
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.suppression, { reason: 'subscription_stale' });
});

test('PostgreSQL store migration and replacement use scoped generation CAS', async () => {
  const migration = getNotificationSubscriptionMigration({ tableName: 'seller_notification_subs' });
  assert.match(migration, /PRIMARY KEY \(tenant_scope, principal_id, anchor_kind, account_id\)/);
  assert.match(migration, /anchor_kind = 'caller' AND account_id = ''/);
  assert.match(migration, /jsonb_typeof\(subscriptions\) = 'array'/);

  const queries = [];
  const subscriptions = [
    {
      subscriberId: 'primary',
      url: 'https://buyer.example/hook',
      eventTypes: ['capabilities.changed'],
      active: true,
      allAuthorizedAccounts: false,
      includeFutureEventTypes: false,
      authentication: { mode: 'rfc9421' },
      destinationGeneration: 'dest_1',
      proofGeneration: 'dest_1',
    },
  ];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [
          {
            tenant_scope: 'seller-us',
            principal_id: 'buyer-a',
            anchor_kind: 'caller',
            account_id: '',
            generation: 'cfg_next',
            subscriptions,
            content_fingerprint: canonicalJsonSha256(subscriptions),
          },
        ],
        rowCount: 1,
      };
    },
  };
  const store = pgNotificationSubscriptionStore(db, { tableName: 'seller_notification_subs' });
  const result = await store.replace({
    scope: callerA,
    expectedGeneration: 'cfg_previous',
    nextGeneration: 'cfg_next',
    subscriptions,
  });
  assert.equal(result.outcome, 'applied');
  assert.match(queries[0].sql, /ON CONFLICT \(tenant_scope, principal_id, anchor_kind, account_id\)/);
  assert.match(queries[0].sql, /WHERE \$8::text IS NOT NULL/);
  assert.deepEqual(queries[0].params.slice(0, 5), ['seller-us', 'buyer-a', 'caller', '', 'cfg_next']);
  assert.equal(queries[0].params[7], 'cfg_previous');
});

test('PostgreSQL persistent runtime never exposes its guarded emitter as server-wide config', () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  const runtime = createPostgresPersistentNotificationRuntime({
    db,
    publisherScope: 'notification-only',
    subscriptions: { tableName: 'notification_only_subscriptions' },
    webhooks: {
      signerKey: signerKey(),
      deliveries: { tableName: 'notification_only_deliveries' },
      outbox: { tableName: 'notification_only_outbox' },
    },
    proofAdapter: { prove: async () => ({ proved: true }) },
    authorizeDelivery: async () => ({ authorized: true }),
    validateDestination: async () => ({ allowed: true }),
  });

  assert.equal(Object.hasOwn(runtime.webhooks, 'serverConfig'), false);
});

test('PostgreSQL notification store requires deployment isolation in production', () => {
  const script = `
    const { pgNotificationSubscriptionStore } = require(${JSON.stringify(
      require.resolve('../../dist/lib/server/index.js')
    )});
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    try { pgNotificationSubscriptionStore(db); process.exit(8); }
    catch (error) { if (!/deployment-unique tableName/.test(error.message)) throw error; }
    pgNotificationSubscriptionStore(db, { tableName: 'seller_prod_notification_subs' });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// Optional live multi-replica contract. CI environments that provide PostgreSQL
// exercise subscription CAS and webhook recovery through separate runtime
// instances sharing only durable state.
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const suffix = randomBytes(4).toString('hex');
  const subscriptionTable = `adcp_ns_sub_${suffix}`;
  const deliveryTable = `adcp_ns_delivery_${suffix}`;
  const outboxTable = `adcp_ns_outbox_${suffix}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  after(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${outboxTable}", "${deliveryTable}", "${subscriptionTable}"`);
    await pool.end();
  });

  test('PostgreSQL runtimes preserve subscription, proof, CAS, and delivery state across replicas', async () => {
    const firstFetch = scriptedFetch([503]);
    const key = signerKey();
    const common = {
      db: pool,
      publisherScope: `notification-test-${suffix}`,
      subscriptions: { tableName: subscriptionTable },
      proofAdapter: { prove: async () => ({ proved: true }) },
      authorizeDelivery: async () => ({ authorized: true }),
      validateDestination: async () => ({ allowed: true }),
    };
    const first = createPostgresPersistentNotificationRuntime({
      ...common,
      webhooks: {
        signerKey: key,
        fetch: firstFetch,
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        deliveries: { tableName: deliveryTable },
        outbox: { tableName: outboxTable },
      },
    });
    for (const migration of first.migrations.all) await pool.query(migration);
    await first.probe();

    const config = {
      subscriber_id: 'replicated',
      url: 'https://receiver.example/events',
      event_types: ['capabilities.changed'],
    };
    const applied = await first.replace(callerA, [config]);
    assert.equal(applied.outcome, 'applied');
    const initialDelivery = await first.emit({
      emissionId: 'emission-pg-restart',
      notificationId: 'notification-pg-restart',
      notificationType: 'capabilities.changed',
      anchor: 'caller',
      tenantId: callerA.tenantId,
      principalId: callerA.principalId,
      payload: { repair: '/capabilities' },
    });
    assert.equal(initialDelivery.deliveries[0].result.delivered, false);

    const recoveredFetch = scriptedFetch([204]);
    const second = createPostgresPersistentNotificationRuntime({
      ...common,
      webhooks: {
        signerKey: key,
        fetch: recoveredFetch,
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        deliveries: { tableName: deliveryTable },
        outbox: { tableName: outboxTable },
      },
    });
    await second.probe();
    const readAfterRestart = await second.read(callerA);
    assert.equal(readAfterRestart.generation, applied.generation);
    assert.equal(
      readAfterRestart.notificationConfigs[0].proof_generation,
      readAfterRestart.notificationConfigs[0].destination_generation
    );

    const recovery = await second.recoverOnce({ ownerToken: `worker-${suffix}`, leaseMs: 5_000 });
    assert.deepEqual(recovery, { claimed: 1, settled: 1, released: 0 });
    assert.equal(recoveredFetch.calls.length, 1);
    assert.equal(recoveredFetch.calls[0].body.idempotency_key, firstFetch.calls[0].body.idempotency_key);
    assert.equal(recoveredFetch.calls[0].body.notification_id, 'notification-pg-restart');

    const replacementA = { ...config, url: 'https://receiver-a.example/events' };
    const replacementB = { ...config, url: 'https://receiver-b.example/events' };
    const [raceA, raceB] = await Promise.all([
      first.replace(callerA, [replacementA], { expectedGeneration: applied.generation }),
      second.replace(callerA, [replacementB], { expectedGeneration: applied.generation }),
    ]);
    assert.deepEqual([raceA.outcome, raceB.outcome].sort(), ['applied', 'conflict']);
    const finalState = await second.read(callerA);
    assert.equal(finalState.notificationConfigs.length, 1);
    assert.ok(
      ['https://receiver-a.example/events', 'https://receiver-b.example/events'].includes(
        finalState.notificationConfigs[0].url
      )
    );
  });
}
