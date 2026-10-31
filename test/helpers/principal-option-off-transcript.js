// Deterministic sync_principal/get_principal transcript for a principal runtime without
// reporting subscription support. The golden output was captured from the runtime before
// AdCP 3.3 subscriptions were added (test/fixtures/reporting-subscriptions/principal-option-off-golden.json).
const {
  InMemoryStateStore,
  createPersistentNotificationRuntime,
  createPrincipalLifecycle,
  createPrincipalStateStore,
  principalNotificationSubscriptionStore,
} = require('../../dist/lib/server/index.js');

async function principalOptionOffTranscript() {
  const store = createPrincipalStateStore({ store: new InMemoryStateStore() });
  const notifications = createPersistentNotificationRuntime({
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
    now: () => new Date('2026-11-01T00:00:00.000Z'),
    declarations: { asyncAdcpVersions: ['3.2'], webhookSigningAlgorithms: ['ed25519'] },
    prepareReportingDestination: ({ destination }) => ({
      state: 'validating',
      configuration: structuredClone(destination),
    }),
  });
  const ctx = { callerMutationScope: { tenant_id: 't', principal_id: 'p', principal_kind: 'buyer_agent' } };
  const scope = { tenantId: 't', principalId: 'p' };
  const destination = {
    pattern: 'file_transfer',
    destination_id: 'archive',
    active: true,
    provider: { domain: 'storage.example' },
    transport: 's3',
    location: 's3://bucket/prefix',
    accepted_formats: ['jsonl'],
    accepted_verification_profiles: ['manifest_checksums'],
  };
  const transcript = [];
  const record = async (label, call) => transcript.push([label, await call()]);
  await record('get-unconfigured', () => lifecycle.protocol.getPrincipal({}, ctx));
  await record('sync-dry-run', () =>
    lifecycle.protocol.syncPrincipal(
      { idempotency_key: 'k-0000000001', dry_run: true, configuration: { reporting_destinations: [destination] } },
      ctx
    )
  );
  await record('sync-destinations', () =>
    lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: 'k-0000000002',
        configuration: { reporting_destinations: [destination], declarations: { async_adcp_versions: ['3.2'] } },
      },
      ctx
    )
  );
  const destinationRef = transcript.at(-1)[1].result.configuration.reporting_destinations[0].destination_ref;
  await record('transition-ready', () =>
    lifecycle.transitionDestination(scope, { destinationId: 'archive', destinationRef, state: 'ready' })
  );
  await record('sync-unchanged', () =>
    lifecycle.protocol.syncPrincipal(
      { idempotency_key: 'k-0000000003', configuration: { declarations: { async_adcp_versions: ['3.2'] } } },
      ctx
    )
  );
  await record('sync-subscriptions-refused', () =>
    lifecycle.protocol.syncPrincipal(
      { idempotency_key: 'k-0000000004', configuration: { reporting_subscriptions: [] } },
      ctx
    )
  );
  await record('sync-stale-version', () =>
    lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: 'k-0000000005',
        expected_configuration_version: 'cfg-0',
        configuration: { reporting_destinations: [] },
      },
      ctx
    )
  );
  await record('sync-remove-destination', () =>
    lifecycle.protocol.syncPrincipal(
      { idempotency_key: 'k-0000000006', configuration: { reporting_destinations: [] } },
      ctx
    )
  );
  await record('get-final', () => lifecycle.protocol.getPrincipal({}, ctx));
  const stored = await store.get(scope);
  transcript.push(['stored-record-keys', Object.keys(stored.record).sort()]);
  return transcript;
}

module.exports = { principalOptionOffTranscript };
