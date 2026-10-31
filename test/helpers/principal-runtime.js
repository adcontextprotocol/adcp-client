// In-memory principal runtime for reporting subscription tests.
const {
  InMemoryStateStore,
  createPersistentNotificationRuntime,
  createPrincipalLifecycle,
  createPrincipalStateStore,
  principalNotificationSubscriptionStore,
} = require('../../dist/lib/server/index.js');

/** A notification runtime over a principal store that records each emitted change in `emitted`. */
function createTestNotifications(store, emitted = []) {
  return createPersistentNotificationRuntime({
    store: principalNotificationSubscriptionStore(store),
    proofAdapter: { prove: async () => ({ proved: true }) },
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit(params) {
        emitted.push(params);
        return {
          delivery_id: params.delivery_id,
          idempotency_key: params.delivery_id,
          attempts: 1,
          delivered: true,
          terminal: true,
          errors: [],
        };
      },
      async emitRecovered(params) {
        return this.emit(params);
      },
    }),
  });
}

function createTestPrincipalLifecycle({
  clock = { now: new Date('2026-11-01T12:00:00.000Z') },
  ...lifecycleOptions
} = {}) {
  const store = createPrincipalStateStore({ store: new InMemoryStateStore() });
  const emitted = [];
  const notifications = createTestNotifications(store, emitted);
  let version = 0;
  let ref = 0;
  const lifecycle = createPrincipalLifecycle({
    store,
    notifications,
    agentUrl: 'https://seller.example/mcp',
    resolvePrincipal: ctx => ctx.callerMutationScope,
    issuePrincipalId: scope => `record-${scope.tenantId}-${scope.principalId}`,
    issueConfigurationVersion: () => `cfg-${++version}`,
    issueDestinationRef: () => `dest-ref-${++ref}`,
    now: () => clock.now,
    ...lifecycleOptions,
    ...(lifecycleOptions.reportingSubscriptions
      ? { reportingSubscriptions: { listDeliveryConfigIds: () => [], ...lifecycleOptions.reportingSubscriptions } }
      : {}),
  });
  return { lifecycle, store, emitted, clock };
}

module.exports = { createTestPrincipalLifecycle, createTestNotifications };
