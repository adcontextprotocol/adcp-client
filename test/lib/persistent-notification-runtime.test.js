const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
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
  emitterFactory,
} = {}) {
  const store = memoryNotificationSubscriptionStore();
  const runtime = createPersistentNotificationRuntime({
    store,
    proofAdapter: { prove: proof },
    authorizeDelivery: authorize,
    validateDestination: async () => ({ allowed: true }),
    credentialAdapter,
    ...runtimeOptions,
    createEmitter:
      emitterFactory ??
      (authorizeAttempt =>
        createWebhookEmitter({
          signerKey: signerKey(),
          fetch,
          retries,
          sleep,
          authorizeAttempt,
        })),
  });
  return { runtime, store, fetch };
}

function createVersionedCredentialAdapter() {
  let sequence = 0;
  const bindings = new Map();
  const calls = { previews: [], stages: [], commits: [], discards: [], resolves: [] };
  const adapter = {
    preview(input) {
      calls.previews.push(input);
      const previous = input.previousBindingId && bindings.get(input.previousBindingId);
      return { outcome: previous?.credential === input.credential ? 'unchanged' : 'changed' };
    },
    stage(input) {
      const previous = input.previousBindingId && bindings.get(input.previousBindingId);
      if (previous?.credential === input.credential) {
        const result = { outcome: 'unchanged', bindingId: input.previousBindingId };
        calls.stages.push({ ...input, ...result });
        return result;
      }
      sequence++;
      const bindingId = `vault-binding-${sequence}`;
      const stageId = `vault-stage-${sequence}`;
      const record = { bindingId, stageId, credential: input.credential, committed: false };
      bindings.set(bindingId, record);
      const result = { outcome: 'staged', bindingId, stageId };
      calls.stages.push({ ...input, ...result });
      return result;
    },
    commit(input) {
      calls.commits.push(input);
      const record = bindings.get(input.bindingId);
      if (!record || record.stageId !== input.stageId) throw new Error('unknown stage');
      record.committed = true;
    },
    discard(input) {
      calls.discards.push(input);
      const record = bindings.get(input.bindingId);
      if (!record || record.committed) return;
      bindings.delete(input.bindingId);
    },
    resolve(input) {
      calls.resolves.push(input);
      const record = bindings.get(input.bindingId);
      if (!record) throw new Error('unknown binding');
      return input.mode === 'bearer'
        ? { type: 'bearer', token: record.credential }
        : { type: 'hmac_sha256', secret: record.credential };
    },
  };
  return { adapter, bindings, calls };
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
  const attemptsByUrl = new Map();
  const calls = [];
  const retryingFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const attempt = (attemptsByUrl.get(url) ?? 0) + 1;
    attemptsByUrl.set(url, attempt);
    return { status: attempt === 1 ? 500 : 204, headers: { get: () => undefined } };
  };
  retryingFetch.calls = calls;
  let authorizationChecks = 0;
  const { runtime } = makeRuntime({
    fetch: retryingFetch,
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
  assert.equal(retryingFetch.calls.length, 4);
  assert.equal(authorizationChecks, 4, 'authorization is re-evaluated before every retry');
  assert.deepEqual(new Set(retryingFetch.calls.map(call => call.body.notification_id)), new Set(['change-42']));
  assert.equal(new Set(retryingFetch.calls.map(call => call.body.subscriber_id)).size, 2);
  for (const subscriber of ['account-hook', 'principal-hook']) {
    const subscriberCalls = retryingFetch.calls.filter(call => call.body.subscriber_id === subscriber);
    assert.equal(subscriberCalls.length, 2);
    assert.equal(subscriberCalls[0].body.idempotency_key, subscriberCalls[1].body.idempotency_key);
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
  const credentials = createVersionedCredentialAdapter();
  const { runtime, store } = makeRuntime({ credentialAdapter: credentials.adapter });
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
  assert.equal(credentials.calls.resolves.length, 1);
  assert.equal(credentials.calls.resolves[0].mode, 'bearer');
});

test('legacy credential dry-run previews use the stable binding without writing', async () => {
  const secret = 'secret-material-with-at-least-32-characters';
  const rotatedSecret = 'rotated-material-with-at-least-32-characters';
  const credentials = createVersionedCredentialAdapter();
  const { runtime } = makeRuntime({ credentialAdapter: credentials.adapter });
  const config = credential => ({
    subscriber_id: 'legacy-preview',
    url: 'https://buyer.example/legacy-preview',
    event_types: ['reporting.delivery_ready'],
    authentication: { schemes: ['Bearer'], credentials: credential },
  });

  const applied = await runtime.replace(accountA, [config(secret)]);
  assert.equal(applied.outcome, 'applied');
  assert.equal(credentials.calls.stages.length, 1);
  assert.equal(credentials.calls.commits.length, 1);

  const unchanged = await runtime.replace(accountA, [config(secret)], { dryRun: true });
  assert.equal(unchanged.outcome, 'validated');
  assert.equal(unchanged.wouldChange, false);
  assert.equal(credentials.calls.stages.length, 1, 'dry-run must not stage or rotate a credential');

  const changed = await runtime.replace(accountA, [config(rotatedSecret)], { dryRun: true });
  assert.equal(changed.outcome, 'validated');
  assert.equal(changed.wouldChange, true);
  assert.equal(credentials.calls.stages.length, 1);
  assert.equal(credentials.calls.previews.length, 2);
});

test('legacy credential dry-run reports a missing preview adapter precisely', async () => {
  const secret = 'secret-material-with-at-least-32-characters';
  const { runtime } = makeRuntime({
    credentialAdapter: {
      stage() {
        return { outcome: 'staged', bindingId: 'vault-binding', stageId: 'vault-stage' };
      },
      commit() {},
      discard() {},
      resolve() {
        return { type: 'bearer', token: secret };
      },
    },
  });

  await assert.rejects(
    () =>
      runtime.replace(
        accountA,
        [
          {
            subscriber_id: 'legacy-preview',
            url: 'https://buyer.example/legacy-preview',
            event_types: ['reporting.delivery_ready'],
            authentication: { schemes: ['Bearer'], credentials: secret },
          },
        ],
        { dryRun: true }
      ),
    error =>
      error instanceof NotificationSubscriptionValidationError &&
      error.message === 'credentialAdapter.preview is required for dry-run legacy authentication'
  );
});

test('credential rotation stages an immutable version and discards it when proof fails', async () => {
  const initialSecret = 'initial-secret-material-with-32-characters';
  const rotatedSecret = 'rotated-secret-material-with-32-characters';
  const credentials = createVersionedCredentialAdapter();
  let rejectProof = false;
  const { runtime, store } = makeRuntime({
    credentialAdapter: credentials.adapter,
    proof: async () => ({ proved: !rejectProof }),
  });
  const config = credential => ({
    subscriber_id: 'immutable-credential',
    url: 'https://buyer.example/immutable-credential',
    event_types: ['reporting.delivery_ready'],
    authentication: { schemes: ['Bearer'], credentials: credential },
  });

  const applied = await runtime.replace(accountA, [config(initialSecret)]);
  const before = await store.get(accountA);
  const initialBindingId = before.subscriptions[0].authentication.bindingId;
  assert.equal(applied.outcome, 'applied');
  assert.equal(initialBindingId, 'vault-binding-1');

  rejectProof = true;
  const rejected = await runtime.replace(accountA, [config(rotatedSecret)], {
    expectedGeneration: applied.generation,
  });
  assert.deepEqual(rejected, { outcome: 'proof_failed', subscriberId: 'immutable-credential' });
  assert.equal(credentials.calls.stages[1].previousBindingId, initialBindingId);
  assert.equal(credentials.calls.discards.length, 1);
  assert.equal(credentials.calls.discards[0].bindingId, 'vault-binding-2');
  assert.notEqual(credentials.calls.discards[0].bindingId, initialBindingId);
  assert.deepEqual([...credentials.bindings.keys()], [initialBindingId]);
  assert.deepEqual(await store.get(accountA), before, 'failed proof preserves the prior binding and generation');
});

test('post-CAS credential commit failure is observable without reversing the replacement', async () => {
  const secret = 'observable-commit-secret-material-32-characters';
  const credentials = createVersionedCredentialAdapter();
  const observed = [];
  credentials.adapter.commit = input => {
    credentials.calls.commits.push(input);
    throw new Error('vault bookkeeping unavailable');
  };
  const { runtime, store } = makeRuntime({
    credentialAdapter: credentials.adapter,
    runtimeOptions: { onCredentialStageError: event => observed.push(event) },
  });

  const result = await runtime.replace(accountA, [
    {
      subscriber_id: 'observable-commit',
      url: 'https://buyer.example/observable-commit',
      event_types: ['reporting.delivery_ready'],
      authentication: { schemes: ['Bearer'], credentials: secret },
    },
  ]);

  assert.equal(result.outcome, 'applied');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].operation, 'commit');
  assert.equal(observed[0].subscriberId, 'observable-commit');
  assert.match(observed[0].error.message, /bookkeeping unavailable/);
  const stored = await store.get(accountA);
  assert.equal(stored.subscriptions[0].authentication.bindingId, observed[0].bindingId);
  assert.equal(credentials.bindings.has(observed[0].bindingId), true, 'the staged binding remains resolvable');
});

test('concurrent credential replacements commit only the CAS winner and discard the loser', async () => {
  const initialSecret = 'initial-secret-material-with-32-characters';
  const replacementA = 'replacement-a-material-with-32-characters';
  const replacementB = 'replacement-b-material-with-32-characters';
  const credentials = createVersionedCredentialAdapter();
  let rotating = false;
  let proofArrivals = 0;
  let releaseProofs;
  const proofBarrier = new Promise(resolve => {
    releaseProofs = resolve;
  });
  const { runtime, store } = makeRuntime({
    credentialAdapter: credentials.adapter,
    proof: async () => {
      if (!rotating) return { proved: true };
      proofArrivals++;
      if (proofArrivals === 2) releaseProofs();
      await proofBarrier;
      return { proved: true };
    },
  });
  const config = credential => ({
    subscriber_id: 'credential-race',
    url: 'https://buyer.example/credential-race',
    event_types: ['reporting.delivery_ready'],
    authentication: { schemes: ['Bearer'], credentials: credential },
  });
  const initial = await runtime.replace(accountA, [config(initialSecret)]);
  rotating = true;

  const [first, second] = await Promise.all([
    runtime.replace(accountA, [config(replacementA)], { expectedGeneration: initial.generation }),
    runtime.replace(accountA, [config(replacementB)], { expectedGeneration: initial.generation }),
  ]);

  assert.deepEqual([first.outcome, second.outcome].sort(), ['applied', 'conflict']);
  const rotatedStages = credentials.calls.stages.slice(1);
  assert.equal(rotatedStages.length, 2);
  assert.notEqual(rotatedStages[0].credential, rotatedStages[1].credential);
  const committed = credentials.calls.commits.at(-1).bindingId;
  const discarded = credentials.calls.discards.at(-1).bindingId;
  assert.notEqual(committed, discarded);
  assert.equal(credentials.bindings.has(committed), true);
  assert.equal(credentials.bindings.has(discarded), false);
  const final = await store.get(accountA);
  assert.equal(final.subscriptions[0].authentication.bindingId, committed);
  assert.equal(final.subscriptions[0].proofGeneration, final.subscriptions[0].destinationGeneration);
});

test('concurrent equal credential replacements use independent stages', async () => {
  const initialSecret = 'initial-equal-race-secret-with-32-characters';
  const replacement = 'shared-race-secret-material-with-32-characters';
  const credentials = createVersionedCredentialAdapter();
  let rotating = false;
  let proofArrivals = 0;
  let releaseProofs;
  const proofBarrier = new Promise(resolve => {
    releaseProofs = resolve;
  });
  const { runtime, store } = makeRuntime({
    credentialAdapter: credentials.adapter,
    proof: async () => {
      if (!rotating) return { proved: true };
      proofArrivals++;
      if (proofArrivals === 2) releaseProofs();
      await proofBarrier;
      return { proved: true };
    },
  });
  const config = credential => ({
    subscriber_id: 'equal-credential-race',
    url: 'https://buyer.example/equal-credential-race',
    event_types: ['reporting.delivery_ready'],
    authentication: { schemes: ['Bearer'], credentials: credential },
  });
  const initial = await runtime.replace(accountA, [config(initialSecret)]);
  rotating = true;

  const results = await Promise.all([
    runtime.replace(accountA, [config(replacement)], { expectedGeneration: initial.generation }),
    runtime.replace(accountA, [config(replacement)], { expectedGeneration: initial.generation }),
  ]);

  assert.deepEqual(results.map(result => result.outcome).sort(), ['applied', 'conflict']);
  const rotatedBindings = credentials.calls.stages.slice(1).map(stage => stage.bindingId);
  const committed = credentials.calls.commits.at(-1).bindingId;
  const discarded = credentials.calls.discards.at(-1).bindingId;
  assert.notEqual(committed, discarded);
  assert.equal(credentials.bindings.has(committed), true);
  assert.equal(credentials.bindings.has(discarded), false);
  assert.deepEqual(new Set(rotatedBindings), new Set([committed, discarded]));
  const final = await store.get(accountA);
  assert.equal(final.subscriptions[0].authentication.bindingId, committed);
});

test('adopter callbacks time out fail closed and receive an aborted signal', async () => {
  let authorizationSignal;
  const { runtime, fetch } = makeRuntime({
    runtimeOptions: { adopterCallbackTimeoutMs: 10 },
    authorize: ({ signal }) => {
      authorizationSignal = signal;
      return new Promise(() => {});
    },
  });
  await runtime.replace(callerA, [
    {
      subscriber_id: 'timed-out-authority',
      url: 'https://buyer.example/timed-out-authority',
      event_types: ['capabilities.changed'],
    },
  ]);

  const result = await runtime.emit({
    emissionId: 'emission-timeout',
    notificationId: 'notification-timeout',
    notificationType: 'capabilities.changed',
    anchor: 'caller',
    tenantId: callerA.tenantId,
    principalId: callerA.principalId,
    payload: { repair: '/capabilities' },
  });
  assert.equal(fetch.calls.length, 0);
  assert.equal(authorizationSignal.aborted, true);
  assert.deepEqual(result.deliveries[0].result.suppression, { reason: 'authorization_error' });
});

test('fanout runs subscriber retry cycles with bounded concurrency and stable ordering', async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { status: 204, headers: { get: () => undefined } };
  };
  fetch.calls = calls;
  const { runtime } = makeRuntime({ fetch, runtimeOptions: { fanoutConcurrency: 2 } });
  await runtime.replace(
    callerA,
    Array.from({ length: 4 }, (_, index) => ({
      subscriber_id: `parallel-${index}`,
      url: `https://buyer.example/parallel-${index}`,
      event_types: ['capabilities.changed'],
    }))
  );

  const result = await runtime.emit({
    emissionId: 'emission-parallel',
    notificationId: 'notification-parallel',
    notificationType: 'capabilities.changed',
    anchor: 'caller',
    tenantId: callerA.tenantId,
    principalId: callerA.principalId,
    payload: { repair: '/capabilities' },
  });
  assert.equal(calls.length, 4);
  assert.equal(peak, 2);
  assert.deepEqual(
    result.deliveries.map(delivery => delivery.subscriberId),
    ['parallel-0', 'parallel-1', 'parallel-2', 'parallel-3']
  );
});

test('fanout isolates an emitter failure to its subscriber result', async () => {
  const emitterFactory = () => {
    const emitter = {
      async emit(params) {
        if (params.url.includes('/fails')) throw new Error('delivery binding mismatch with private details');
        return {
          delivery_id: params.delivery_id,
          idempotency_key: 'isolated-fanout-idempotency-key',
          attempts: 1,
          delivered: true,
          terminal: true,
          final_status: 204,
          errors: [],
        };
      },
      async emitRecovered() {
        throw new Error('unused');
      },
      forTenantScope() {
        return emitter;
      },
    };
    return emitter;
  };
  const { runtime } = makeRuntime({ emitterFactory });
  await runtime.replace(callerA, [
    {
      subscriber_id: 'a-fails',
      url: 'https://buyer.example/fails',
      event_types: ['capabilities.changed'],
    },
    {
      subscriber_id: 'b-succeeds',
      url: 'https://buyer.example/succeeds',
      event_types: ['capabilities.changed'],
    },
  ]);

  const result = await runtime.emit({
    emissionId: 'emission-isolated-failure',
    notificationId: 'notification-isolated-failure',
    notificationType: 'capabilities.changed',
    anchor: 'caller',
    tenantId: callerA.tenantId,
    principalId: callerA.principalId,
    payload: { changed: true },
  });

  assert.equal(result.matched, 2);
  assert.deepEqual(result.deliveries[0].failure, { reason: 'delivery_runtime_error' });
  assert.equal(result.deliveries[0].result, undefined);
  assert.equal(result.deliveries[1].result.delivered, true);
  assert.equal(result.deliveries[1].failure, undefined);
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
