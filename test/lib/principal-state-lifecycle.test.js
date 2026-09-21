const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  InMemoryStateStore,
  createPersistentNotificationRuntime,
  createPrincipalLifecycle,
  createPrincipalStateStore,
  principalNotificationSubscriptionStore,
} = require('../../dist/lib/server/index.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');

function assertSchemaValid(toolName, response) {
  const outcome = validateResponse(toolName, response, '3.2.0-rc.4');
  assert.equal(outcome.valid, true, JSON.stringify(outcome.issues));
}

function setup({
  proof = async () => ({ proved: true }),
  credentialAdapter,
  lifecycleOptions = {},
  emit = async params => ({
    delivery_id: params.delivery_id,
    idempotency_key: params.delivery_id,
    attempts: 1,
    delivered: true,
    terminal: true,
    errors: [],
  }),
} = {}) {
  const backing = new InMemoryStateStore();
  const store = createPrincipalStateStore({ store: backing });
  const notificationStore = principalNotificationSubscriptionStore(store);
  const emitted = [];
  const notifications = createPersistentNotificationRuntime({
    store: notificationStore,
    proofAdapter: { prove: proof },
    ...(credentialAdapter ? { credentialAdapter } : {}),
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit(params) {
        emitted.push(params);
        return emit(params);
      },
      async emitRecovered(params) {
        return this.emit(params);
      },
    }),
  });
  const declarationSupport = {
    asyncAdcpVersions: ['3.1', '3.2'],
    webhookSigningAlgorithms: ['ed25519'],
    experimentalFeatures: ['seller.feature'],
  };
  const lifecycle = createPrincipalLifecycle({
    store,
    notifications,
    agentUrl: 'https://seller.example/mcp',
    resolvePrincipal: ctx => ctx.callerMutationScope,
    issuePrincipalId: scope => `record-${scope.tenantId}-${scope.principalId}`,
    issueConfigurationVersion: (() => {
      let value = 0;
      return () => `cfg-${++value}`;
    })(),
    issueDestinationRef: (() => {
      let value = 0;
      return () => `dest-ref-${++value}`;
    })(),
    declarations: declarationSupport,
    prepareReportingDestination: ({ destination }) => ({
      state: 'action_required',
      configuration: structuredClone(destination),
      setup: { action: 'prove_control' },
    }),
    includeCompatibilityNotificationTask: true,
    ...lifecycleOptions,
  });
  return { backing, store, notifications, lifecycle, emitted, declarationSupport };
}

function ctx(tenant = 'tenant-a', principal = 'subject-a', extra = {}) {
  return {
    callerMutationScope: {
      tenant_id: tenant,
      principal_id: principal,
      principal_kind: 'buyer_agent',
      ...extra,
    },
  };
}

function destination(destinationId = 'warehouse', active = true) {
  return {
    pattern: 'warehouse_materialization',
    destination_id: destinationId,
    active,
    provider: { domain: 'warehouse.example' },
    transport: 'bigquery',
    location: 'project.dataset',
    accepted_verification_profiles: ['native_commit'],
  };
}

test('reads unconfigured, recognized, and current principal states without minting on read', async () => {
  const { lifecycle, store } = setup();
  const unconfigured = await lifecycle.protocol.getPrincipal({}, ctx());
  assert.deepEqual(unconfigured, { result: { kind: 'unconfigured' } });
  assertSchemaValid('get_principal', unconfigured);
  assert.equal(await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' }), null);

  const recognizedContext = ctx('tenant-a', 'subject-recognized', {
    principal_record_id: 'existing-record',
  });
  assert.deepEqual(await lifecycle.protocol.getPrincipal({}, recognizedContext), {
    result: {
      kind: 'recognized',
      principal_id: 'existing-record',
      principal_kind: 'buyer_agent',
    },
  });
  assert.equal(await store.get({ tenantId: 'tenant-a', principalId: 'subject-recognized' }), null);

  const applied = await lifecycle.protocol.syncPrincipal(
    { idempotency_key: 'principal-create-0001', configuration: { notification_configs: [] } },
    ctx()
  );
  assert.equal(applied.result.kind, 'applied');
  assert.equal(applied.result.action, 'cleared');
  assert.equal(applied.result.principal_id, 'record-tenant-a-subject-a');
  assertSchemaValid('sync_principal', applied);

  const read = await lifecycle.protocol.getPrincipal({}, ctx());
  assert.equal(read.result.kind, 'current');
  assert.equal(read.result.configuration_version, applied.result.configuration_version);
  assert.deepEqual(read.result.configuration.notification_configs, []);
  assert.deepEqual(read.result.configuration.reporting_destinations, []);
  assert.deepEqual(read.result.configuration.retired_destinations, []);
  assert.deepEqual(read.result.configuration.declarations, { declared: {}, accepted: {} });
  assertSchemaValid('get_principal', read);
});

test('commits all submitted sections atomically and rejects stale shared versions', async () => {
  let prove = true;
  const { lifecycle } = setup({ proof: async () => ({ proved: prove }) });
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-sections-0001',
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'events',
            url: 'https://buyer.example/events',
            event_types: ['principal.changed'],
          },
        ],
        reporting_destinations: [destination()],
        declarations: {
          async_adcp_versions: ['3.2', '4.0'],
          webhook_signing_algorithms: ['ed25519'],
          experimental_features: ['seller.feature', 'unknown.feature'],
        },
      },
    },
    ctx()
  );
  assert.equal(initial.result.kind, 'applied');
  assert.equal(initial.result.configuration.reporting_destinations[0].state, 'action_required');
  assert.deepEqual(initial.result.configuration.declarations.accepted, {
    async_adcp_versions: ['3.2'],
    webhook_signing_algorithms: ['ed25519'],
    experimental_features: ['seller.feature'],
  });
  assert.equal(initial.result.configuration.declarations.selected_async_adcp_version, '3.2');
  assert.equal(initial.result.configuration.declarations.exclusions.length, 2);

  const stale = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-sections-0002',
      expected_configuration_version: 'cfg-stale',
      configuration: { reporting_destinations: [] },
    },
    ctx()
  );
  assert.equal(stale.result.kind, 'failed');
  assert.equal(stale.status, 'failed');
  assert.equal(stale.result.errors[0].code, 'CONFLICT');
  assertSchemaValid('sync_principal', stale);

  prove = false;
  const proofFailure = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-sections-0003',
      expected_configuration_version: initial.result.configuration_version,
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'events',
            url: 'https://buyer.example/changed',
            event_types: ['principal.changed'],
          },
        ],
        reporting_destinations: [],
      },
    },
    ctx()
  );
  assert.equal(proofFailure.result.kind, 'failed');
  const after = await lifecycle.protocol.getPrincipal({}, ctx());
  assert.equal(after.result.configuration_version, initial.result.configuration_version);
  assert.equal(after.result.configuration.reporting_destinations.length, 1);
  assert.equal(after.result.configuration.notification_configs[0].url, 'https://buyer.example/events');
});

test('allows only one concurrent CAS winner for the same configuration version', async () => {
  const { lifecycle } = setup();
  const initial = await lifecycle.protocol.syncPrincipal(
    { idempotency_key: 'principal-race-init', configuration: { declarations: {} } },
    ctx()
  );
  assert.equal(initial.result.action, 'updated');
  const request = feature =>
    lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: `principal-race-${feature}`,
        expected_configuration_version: initial.result.configuration_version,
        configuration: { declarations: { experimental_features: [feature] } },
      },
      ctx()
    );
  const results = await Promise.all([request('one.feature'), request('two.feature')]);
  assert.equal(results.filter(result => result.result.kind === 'applied').length, 1);
  assert.equal(results.filter(result => result.result.kind === 'failed').length, 1);
});

test('shares notification state with the compatibility task and advances one version', async () => {
  const { lifecycle } = setup();
  const initial = await lifecycle.protocol.syncPrincipal(
    { idempotency_key: 'principal-notify-init', configuration: { notification_configs: [] } },
    ctx()
  );
  const compatibility = await lifecycle.protocol.syncAgentNotificationConfigs(
    {
      idempotency_key: 'principal-notify-compat',
      notification_configs: [
        {
          subscriber_id: 'compat',
          url: 'https://buyer.example/compat',
          event_types: ['principal.changed'],
        },
      ],
    },
    ctx()
  );
  assert.equal(compatibility.action, 'updated');
  assertSchemaValid('sync_agent_notification_configs', compatibility);
  const read = await lifecycle.protocol.getPrincipal({}, ctx());
  assert.notEqual(read.result.configuration_version, initial.result.configuration_version);
  assert.equal(read.result.configuration.notification_configs[0].subscriber_id, 'compat');
});

test('persists destination transitions before durable principal.changed emission', async () => {
  const { lifecycle, store, emitted } = setup();
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-init',
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'principal-events',
            url: 'https://buyer.example/principal-events',
            event_types: ['principal.changed'],
          },
        ],
        reporting_destinations: [destination()],
        declarations: { webhook_signing_algorithms: ['ed25519'] },
      },
    },
    ctx()
  );
  const currentDestination = initial.result.configuration.reporting_destinations[0];
  await lifecycle.transitionDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    {
      destinationId: currentDestination.destination_id,
      destinationRef: currentDestination.destination_ref,
      state: 'ready',
    },
    { deferNotification: true }
  );
  assert.equal(emitted.length, 0);
  const committed = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(committed.record.configuration.reporting_destinations[0].state, 'ready');
  assert.equal(committed.record.configurationVersion, initial.result.configuration_version);
  assert.equal(committed.record.pendingNotifications.length, 1);
  const resolved = await lifecycle.resolveReportingDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    currentDestination.destination_ref
  );
  assert.equal(resolved.deliveryEligible, true);

  const recovery = await lifecycle.recoverPrincipalNotifications({ limit: 10 });
  assert.deepEqual(recovery, { processedScopes: 1, failedScopes: 0, hasMore: false });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.notification_type, 'principal.changed');
  const drained = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(drained.record.pendingNotifications.length, 0);
});

test('recovers committed principal notifications across bounded cursor pages', async () => {
  const { lifecycle, emitted } = setup();
  for (const tenant of ['tenant-recovery-a', 'tenant-recovery-b']) {
    const context = ctx(tenant, 'subject');
    const applied = await lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: `principal-recovery-${tenant}`,
        configuration: {
          notification_configs: [
            {
              subscriber_id: 'principal-events',
              url: `https://${tenant}.example/events`,
              event_types: ['principal.changed'],
            },
          ],
          reporting_destinations: [destination()],
          declarations: { webhook_signing_algorithms: ['ed25519'] },
        },
      },
      context
    );
    const current = applied.result.configuration.reporting_destinations[0];
    await lifecycle.transitionDestination(
      { tenantId: tenant, principalId: 'subject' },
      {
        destinationId: current.destination_id,
        destinationRef: current.destination_ref,
        state: 'ready',
      },
      { deferNotification: true }
    );
  }

  const first = await lifecycle.recoverPrincipalNotifications({ limit: 1 });
  assert.equal(first.processedScopes, 1);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await lifecycle.recoverPrincipalNotifications({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second, { processedScopes: 1, failedScopes: 0, hasMore: false });
  assert.equal(emitted.length, 2);
});

test('suspends, revokes, and freshly reauthorizes reporting destinations', async () => {
  const { lifecycle } = setup();
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-cycle-1',
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  const firstRef = initial.result.configuration.reporting_destinations[0].destination_ref;
  const suspended = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-cycle-2',
      expected_configuration_version: initial.result.configuration_version,
      configuration: { reporting_destinations: [destination('warehouse', false)] },
    },
    ctx()
  );
  assert.equal(suspended.result.configuration.reporting_destinations[0].state, 'inactive');
  const suspendedGeneration = await lifecycle.resolveReportingDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    firstRef
  );
  assert.equal(suspendedGeneration.deliveryEligible, false);
  await assert.rejects(
    lifecycle.transitionDestination(
      { tenantId: 'tenant-a', principalId: 'subject-a' },
      { destinationId: 'warehouse', destinationRef: firstRef, state: 'ready' }
    ),
    /Suspended/
  );

  const revoked = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-cycle-3',
      expected_configuration_version: suspended.result.configuration_version,
      configuration: { reporting_destinations: [] },
    },
    ctx()
  );
  assert.equal(revoked.result.configuration.reporting_destinations.length, 0);
  assert.deepEqual(revoked.result.configuration.retired_destinations[0].destination_refs, [firstRef]);
  const retiredGeneration = await lifecycle.resolveReportingDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    firstRef
  );
  assert.equal(retiredGeneration.lifecycle, 'retired');
  assert.equal(retiredGeneration.deliveryEligible, false);

  const restored = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-cycle-4',
      expected_configuration_version: revoked.result.configuration_version,
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  assert.notEqual(restored.result.configuration.reporting_destinations[0].destination_ref, firstRef);
  assert.equal(restored.result.configuration.reporting_destinations[0].state, 'action_required');
  const oldGeneration = await lifecycle.resolveReportingDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    firstRef
  );
  assert.equal(oldGeneration.deliveryEligible, false);
});

test('issues a fresh destination generation after a rejected proof attempt', async () => {
  const { lifecycle } = setup();
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-rejected-1',
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  const first = initial.result.configuration.reporting_destinations[0];
  await lifecycle.transitionDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    {
      destinationId: first.destination_id,
      destinationRef: first.destination_ref,
      state: 'rejected',
    }
  );
  await assert.rejects(
    lifecycle.transitionDestination(
      { tenantId: 'tenant-a', principalId: 'subject-a' },
      {
        destinationId: first.destination_id,
        destinationRef: first.destination_ref,
        state: 'ready',
      }
    ),
    /Rejected/
  );
  const rejected = await lifecycle.protocol.getPrincipal({}, ctx());
  const retried = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-destination-rejected-2',
      expected_configuration_version: rejected.result.configuration_version,
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  assert.notEqual(retried.result.configuration.reporting_destinations[0].destination_ref, first.destination_ref);
});

test('isolates identical stable subjects across tenants', async () => {
  const { lifecycle } = setup();
  await lifecycle.protocol.syncPrincipal(
    { idempotency_key: 'principal-tenant-alpha', configuration: { declarations: {} } },
    ctx('tenant-alpha', 'same-subject')
  );
  assert.deepEqual(await lifecycle.protocol.getPrincipal({}, ctx('tenant-beta', 'same-subject')), {
    result: { kind: 'unconfigured' },
  });
  assert.equal(
    await lifecycle.resolveReportingDestination({ tenantId: 'tenant-beta', principalId: 'same-subject' }, 'dest-ref-1'),
    null
  );
});

test('reconciles seller-side declaration support without advancing the caller configuration version', async () => {
  const { lifecycle, declarationSupport, store } = setup();
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-declaration-reconcile',
      configuration: {
        declarations: {
          webhook_signing_algorithms: ['ed25519'],
          experimental_features: ['future.feature'],
        },
      },
    },
    ctx()
  );
  assert.equal(initial.result.configuration.declarations.accepted.experimental_features, undefined);
  declarationSupport.experimentalFeatures.push('future.feature');
  const reconciled = await lifecycle.reconcileDeclarations(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    { deferNotification: true }
  );
  assert.deepEqual(reconciled.declarations.accepted.experimental_features, ['future.feature']);
  const stored = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(stored.record.configurationVersion, initial.result.configuration_version);
  assert.equal(stored.record.pendingNotifications[0].reason, 'declarations_intersection_changed');
});

test('fails closed when active webhooks have no accepted signing algorithm', async () => {
  const { lifecycle } = setup();
  const result = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-signing-intersection',
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'events',
            url: 'https://buyer.example/events',
            event_types: ['principal.changed'],
          },
        ],
        declarations: { webhook_signing_algorithms: ['ecdsa-p256-sha256'] },
      },
    },
    ctx()
  );
  assert.equal(result.result.kind, 'failed');
  assert.equal(result.result.errors[0].code, 'UNSUPPORTED_FEATURE');
});

test('delivers signing-support invalidation before subscriber deactivation settles', async () => {
  const { lifecycle, declarationSupport, emitted, store } = setup();
  await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-signing-removal-1',
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'events',
            url: 'https://buyer.example/events',
            event_types: ['principal.changed'],
          },
        ],
        declarations: { webhook_signing_algorithms: ['ed25519'] },
      },
    },
    ctx()
  );
  declarationSupport.webhookSigningAlgorithms.length = 0;
  const reconciled = await lifecycle.reconcileDeclarations({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(reconciled.notification_configs[0].active, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.reason, 'declarations_intersection_changed');
  const stored = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(stored.record.notificationSubscriptions[0].active, false);
  assert.equal(stored.record.pendingNotifications.length, 0);
});

test('never evicts a required deactivation invalidation from the bounded outbox', async () => {
  let deliveries = 0;
  const { lifecycle, declarationSupport, store } = setup({
    lifecycleOptions: { maxPendingNotifications: 1 },
    emit: async params => {
      deliveries++;
      return {
        delivery_id: params.delivery_id,
        idempotency_key: params.delivery_id,
        attempts: 1,
        delivered: deliveries > 1,
        ...(deliveries > 1 ? { terminal: true } : {}),
        errors: deliveries > 1 ? [] : ['http_503'],
      };
    },
  });
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-signing-outbox-bound-1',
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'events',
            url: 'https://buyer.example/events',
            event_types: ['principal.changed'],
          },
        ],
        reporting_destinations: [destination()],
        declarations: { webhook_signing_algorithms: ['ed25519'] },
      },
    },
    ctx()
  );
  declarationSupport.webhookSigningAlgorithms.length = 0;
  await lifecycle.reconcileDeclarations({ tenantId: 'tenant-a', principalId: 'subject-a' });
  const destinationState = initial.result.configuration.reporting_destinations[0];
  await lifecycle.transitionDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    {
      destinationId: destinationState.destination_id,
      destinationRef: destinationState.destination_ref,
      state: 'ready',
    },
    { deferNotification: true }
  );
  const pending = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(pending.record.pendingNotifications.length, 1);
  assert.equal(pending.record.pendingNotifications[0].reason, 'declarations_intersection_changed');
  await lifecycle.flushPrincipalNotifications({ tenantId: 'tenant-a', principalId: 'subject-a' });
  const settled = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(settled.record.pendingNotifications.length, 0);
  assert.equal(settled.record.notificationSubscriptions[0].active, false);
});

test('commits credential-only notification rotations as configuration changes', async () => {
  let sequence = 0;
  const bindings = new Map();
  const committed = [];
  const credentialAdapter = {
    preview({ credential, previousBindingId }) {
      return { outcome: bindings.get(previousBindingId)?.credential === credential ? 'unchanged' : 'changed' };
    },
    stage({ credential, previousBindingId }) {
      if (bindings.get(previousBindingId)?.credential === credential) {
        return { outcome: 'unchanged', bindingId: previousBindingId };
      }
      sequence++;
      const bindingId = `binding-${sequence}`;
      const stageId = `stage-${sequence}`;
      bindings.set(bindingId, { credential, stageId });
      return { outcome: 'staged', bindingId, stageId };
    },
    commit(input) {
      committed.push(input.bindingId);
    },
    discard() {},
    resolve({ bindingId }) {
      return { type: 'bearer', token: bindings.get(bindingId).credential };
    },
  };
  const { lifecycle, store } = setup({ credentialAdapter });
  const config = secret => ({
    subscriber_id: 'events',
    url: 'https://buyer.example/events',
    event_types: ['principal.changed'],
    authentication: { schemes: ['Bearer'], credentials: secret },
  });
  const first = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-credential-rotation-1',
      configuration: {
        notification_configs: [config('first-secret-value-at-least-32-chars')],
        declarations: { webhook_signing_algorithms: ['ed25519'] },
      },
    },
    ctx()
  );
  const rotated = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-credential-rotation-2',
      expected_configuration_version: first.result.configuration_version,
      configuration: { notification_configs: [config('rotated-secret-value-at-least-32-chars')] },
    },
    ctx()
  );
  assert.equal(rotated.result.action, 'updated');
  assert.notEqual(rotated.result.configuration_version, first.result.configuration_version);
  const stored = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(stored.record.notificationSubscriptions[0].authentication.bindingId, 'binding-2');
  assert.deepEqual(committed, ['binding-1', 'binding-2']);
});

test('retains retryable principal notifications until delivery recovers', async () => {
  let attempts = 0;
  const { lifecycle, store } = setup({
    emit: async params => {
      attempts++;
      return {
        delivery_id: params.delivery_id,
        idempotency_key: params.delivery_id,
        attempts: 1,
        delivered: attempts > 1,
        ...(attempts > 1 ? { terminal: true } : {}),
        errors: attempts > 1 ? [] : ['http_503'],
      };
    },
  });
  const initial = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-retryable-outbox-1',
      configuration: {
        notification_configs: [
          {
            subscriber_id: 'events',
            url: 'https://buyer.example/events',
            event_types: ['principal.changed'],
          },
        ],
        reporting_destinations: [destination()],
        declarations: { webhook_signing_algorithms: ['ed25519'] },
      },
    },
    ctx()
  );
  const current = initial.result.configuration.reporting_destinations[0];
  await lifecycle.transitionDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    { destinationId: current.destination_id, destinationRef: current.destination_ref, state: 'ready' },
    { deferNotification: true }
  );
  await lifecycle.flushPrincipalNotifications({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(
    (await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' })).record.pendingNotifications.length,
    1
  );
  await lifecycle.flushPrincipalNotifications({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(
    (await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' })).record.pendingNotifications.length,
    0
  );
});

test('suspending a replacement destination also suspends superseded generations', async () => {
  const { lifecycle } = setup();
  const first = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-multi-generation-1',
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  const firstRef = first.result.configuration.reporting_destinations[0].destination_ref;
  const changedDestination = { ...destination(), location: 'project.other_dataset' };
  const second = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-multi-generation-2',
      expected_configuration_version: first.result.configuration_version,
      configuration: { reporting_destinations: [changedDestination] },
    },
    ctx()
  );
  const suspended = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-multi-generation-3',
      expected_configuration_version: second.result.configuration_version,
      configuration: { reporting_destinations: [{ ...changedDestination, active: false }] },
    },
    ctx()
  );
  assert.equal(suspended.result.kind, 'applied');
  const old = await lifecycle.resolveReportingDestination({ tenantId: 'tenant-a', principalId: 'subject-a' }, firstRef);
  assert.equal(old.lifecycle, 'superseded');
  assert.equal(old.deliveryEligible, false);
});

test('rejects a notification runtime backed by a different principal store', () => {
  const firstStore = createPrincipalStateStore({ store: new InMemoryStateStore() });
  const secondStore = createPrincipalStateStore({ store: new InMemoryStateStore() });
  const notifications = createPersistentNotificationRuntime({
    store: principalNotificationSubscriptionStore(firstStore),
    proofAdapter: { prove: async () => ({ proved: true }) },
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit() {
        throw new Error('not reached');
      },
      async emitRecovered() {
        throw new Error('not reached');
      },
    }),
  });
  assert.throws(
    () =>
      createPrincipalLifecycle({
        store: secondStore,
        notifications,
        agentUrl: 'https://seller.example/mcp',
        resolvePrincipal: () => ({ tenant_id: 'tenant', principal_id: 'buyer', principal_kind: 'buyer_agent' }),
      }),
    /same principal store/
  );
});

test('initializes an empty notification generation without a null readback crash', async () => {
  const { lifecycle, notifications } = setup();
  await lifecycle.recognizePrincipal({
    scope: { tenantId: 'tenant-empty', principalId: 'subject-empty' },
    principalId: 'record-empty',
    principalKind: 'buyer_agent',
  });
  const result = await notifications.replace(
    { kind: 'caller', tenantId: 'tenant-empty', principalId: 'subject-empty' },
    []
  );
  assert.equal(result.outcome, 'cleared');
  assert.equal(typeof result.generation, 'string');
});

test('backpressures reporting history without deleting retained references', async () => {
  const { lifecycle, store } = setup({ lifecycleOptions: { maxReportingGenerations: 2 } });
  const first = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-generation-bound-1',
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  const firstRef = first.result.configuration.reporting_destinations[0].destination_ref;
  const second = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-generation-bound-2',
      expected_configuration_version: first.result.configuration_version,
      configuration: { reporting_destinations: [{ ...destination(), location: 'project.dataset_2' }] },
    },
    ctx()
  );
  const secondRef = second.result.configuration.reporting_destinations[0].destination_ref;
  const third = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-generation-bound-3',
      expected_configuration_version: second.result.configuration_version,
      configuration: { reporting_destinations: [{ ...destination(), location: 'project.dataset_3' }] },
    },
    ctx()
  );
  assert.equal(third.result.kind, 'failed');
  assert.equal(third.result.errors[0].code, 'CONFLICT');
  assertSchemaValid('sync_principal', third);
  const stored = await store.get({ tenantId: 'tenant-a', principalId: 'subject-a' });
  assert.equal(stored.record.reportingGenerations.length, 2);
  assert.equal(
    (await lifecycle.resolveReportingDestination({ tenantId: 'tenant-a', principalId: 'subject-a' }, firstRef))
      .destinationRef,
    firstRef
  );
  assert.equal(
    (await lifecycle.resolveReportingDestination({ tenantId: 'tenant-a', principalId: 'subject-a' }, secondRef))
      .destinationRef,
    secondRef
  );
  const cleared = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-generation-bound-clear',
      expected_configuration_version: second.result.configuration_version,
      configuration: { reporting_destinations: [] },
    },
    ctx()
  );
  assert.equal(cleared.result.kind, 'applied');
  assert.deepEqual(cleared.result.configuration.retired_destinations[0].destination_refs, [secondRef, firstRef]);
});

test('backpressures reporting rotation instead of pruning delivery-eligible generations', async () => {
  const { lifecycle } = setup({ lifecycleOptions: { maxReportingGenerations: 2 } });
  const first = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-eligible-bound-1',
      configuration: { reporting_destinations: [destination()] },
    },
    ctx()
  );
  const firstDestination = first.result.configuration.reporting_destinations[0];
  await lifecycle.transitionDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    {
      destinationId: firstDestination.destination_id,
      destinationRef: firstDestination.destination_ref,
      state: 'ready',
    }
  );
  const second = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-eligible-bound-2',
      expected_configuration_version: first.result.configuration_version,
      configuration: { reporting_destinations: [{ ...destination(), location: 'project.dataset_2' }] },
    },
    ctx()
  );
  const secondDestination = second.result.configuration.reporting_destinations[0];
  await lifecycle.transitionDestination(
    { tenantId: 'tenant-a', principalId: 'subject-a' },
    {
      destinationId: secondDestination.destination_id,
      destinationRef: secondDestination.destination_ref,
      state: 'ready',
    }
  );
  const third = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-eligible-bound-3',
      expected_configuration_version: second.result.configuration_version,
      configuration: { reporting_destinations: [{ ...destination(), location: 'project.dataset_3' }] },
    },
    ctx()
  );
  assert.equal(third.result.kind, 'failed');
  assert.equal(third.result.errors[0].code, 'CONFLICT');
  assert.equal(
    (
      await lifecycle.resolveReportingDestination(
        { tenantId: 'tenant-a', principalId: 'subject-a' },
        firstDestination.destination_ref
      )
    ).deliveryEligible,
    true
  );
});

test('rejects submitted sections that the seller does not support', async () => {
  const { lifecycle } = setup({
    lifecycleOptions: { declarations: undefined, prepareReportingDestination: undefined },
  });
  const declarations = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-unsupported-declarations',
      configuration: { declarations: {} },
    },
    ctx()
  );
  assert.equal(declarations.result.errors[0].code, 'UNSUPPORTED_FEATURE');
  const reporting = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'principal-unsupported-reporting',
      configuration: { reporting_destinations: [] },
    },
    ctx()
  );
  assert.equal(reporting.result.errors[0].code, 'UNSUPPORTED_FEATURE');
});

test('rejects false durability claims and missing delivery-attempt checkpoints', () => {
  assert.throws(
    () => createPrincipalStateStore({ store: new InMemoryStateStore(), durability: 'durable' }),
    /cannot be declared durable/
  );
  const store = createPrincipalStateStore({ store: new InMemoryStateStore() });
  const notifications = createPersistentNotificationRuntime({
    store: principalNotificationSubscriptionStore(store),
    proofAdapter: { prove: async () => ({ proved: true }) },
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit() {
        throw new Error('not reached');
      },
      async emitRecovered() {
        throw new Error('not reached');
      },
    }),
  });
  assert.throws(
    () =>
      createPrincipalLifecycle({
        store,
        notifications,
        agentUrl: 'https://seller.example/mcp',
        resolvePrincipal: () => ({ tenant_id: 'tenant', principal_id: 'buyer', principal_kind: 'buyer_agent' }),
      }),
    /delivery-attempt checkpoint/
  );
});
