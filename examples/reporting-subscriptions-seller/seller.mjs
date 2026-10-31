/**
 * Reference seller for principal-level reporting subscriptions (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3). It passes
 * `examples/storyboards/reporting-subscriptions.yaml`.
 *
 * The composition is the production one: a principal runtime created with
 * `reportingSubscriptions`, the coverage engine, and the Reliable Reporting service, served by
 * `createAdcpServerFromPlatform`. Only the state is in memory and the sample offering is the SDK's
 * redacted reference offering. The seller serves principal-level subscriptions only
 * (`configuration_tasks: ['sync_principal']`), accepts no reporting destinations, and makes no
 * outbound calls.
 *
 * Pass a `ReportingLedgerStore` as `store` (`PostgresReportingLedgerStore` from
 * `@adcp/reporting-storage` in production) and a durable `stateStore` (`PostgresStateStore`).
 * The in-memory default state store is refused outside `NODE_ENV=test` or `development`.
 */
import { randomUUID } from 'node:crypto';
import {
  InMemoryStateStore,
  createAdcpServerFromPlatform,
  createPersistentNotificationRuntime,
  createPrincipalLifecycle,
  createPrincipalStateStore,
  principalNotificationSubscriptionStore,
} from '@adcp/sdk/server';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';
import {
  createReportingSubscriptionEngineStateStoreV1,
  createReportingSubscriptionEngineV1,
} from '@adcp/sdk/reporting/advanced';
import { redactedReportingSourceOfferingV1, redactedReportingSourceRequestV1 } from '@adcp/sdk/reporting/source';

export const REFERENCE_TENANT = 'reference-seller';
/** The one advertiser account every authenticated buyer is authorized on. */
export const REFERENCE_ACCOUNT_ID = 'acct-reference';

/** The delivery offering the redacted source offering serves, with the dimensions subscriptions match on. */
function deliveryOffering() {
  const source = redactedReportingSourceOfferingV1;
  return {
    offering_id: source.offeringId,
    feed_purpose: 'analytics',
    report_definition_id: source.contract.report_definition_id,
    report_definition_uri: source.contract.reportDefinitionUri,
    report_definition_sha256: source.contract.reportDefinitionSha256,
    reporting_profile: {
      id: source.contract.reportingProfile,
      version: source.contract.schemaVersion,
      schema_uri: source.contract.schemaUri,
      schema_sha256: source.contract.schemaSha256,
      schema_dialect: source.contract.schemaDialect,
      schema_ref_policy: source.contract.schemaRefPolicy,
      grain: source.grain,
      primary_keys: ['media_buy_id'],
    },
    schedule: {
      period_duration: 'P1D',
      alignment: 'source_timezone',
      period_timezone_policy: 'fixed',
      period_timezone: 'UTC',
      delivery_sla: 'PT0S',
    },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: ['package'],
  };
}

/** A dropping emitter: this seller has no outbound network path. */
function noOutboundNotifications(store) {
  return createPersistentNotificationRuntime({
    store: principalNotificationSubscriptionStore(store),
    proofAdapter: { prove: async () => ({ proved: false }) },
    validateDestination: async () => ({ allowed: false, reason: 'This reference seller makes no outbound calls' }),
    authorizeDelivery: async () => ({ authorized: false }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit(params) {
        return {
          delivery_id: params.delivery_id,
          idempotency_key: params.delivery_id,
          attempts: 0,
          delivered: false,
          terminal: true,
          errors: ['outbound delivery is disabled'],
        };
      },
      async emitRecovered(params) {
        return this.emit(params);
      },
    }),
  });
}

/**
 * @param {object} options
 * @param {import('@adcp/sdk/reporting/ledger').ReportingLedgerStore} options.store
 * @param {import('@adcp/sdk/server').AdcpStateStore} [options.stateStore] Principal and engine state;
 *   the store declares its own durability (`PostgresStateStore` is durable).
 * @param {() => Date} [options.now]
 * @param {(protocol: object) => object} [options.wrapProtocol] Test seam: wrap the principal protocol handlers.
 */
export function createReportingSubscriptionsSeller({
  store,
  stateStore = new InMemoryStateStore(),
  now = () => new Date(),
  wrapProtocol = protocol => protocol,
} = {}) {
  if (!store) throw new TypeError('store is required: pass a ReportingLedgerStore');
  // Identity comes from authentication only; the request cannot name its own principal.
  const principalOf = ctx => {
    const clientId = ctx.authInfo?.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0) throw new Error('authenticated caller required');
    return { tenantId: REFERENCE_TENANT, principalId: clientId };
  };
  // Durability is read from the state store itself (InMemoryStateStore is process-local).
  const principalStore = createPrincipalStateStore({ store: stateStore });
  const lifecycle = createPrincipalLifecycle({
    store: principalStore,
    notifications: noOutboundNotifications(principalStore),
    agentUrl: 'https://reference-seller.example/mcp',
    resolvePrincipal: ctx => {
      const { tenantId, principalId } = principalOf(ctx);
      return { tenant_id: tenantId, principal_id: principalId, principal_kind: 'buyer_agent' };
    },
    issuePrincipalId: () => `principal-${randomUUID()}`,
    issueConfigurationVersion: () => `cfg-${randomUUID()}`,
    now,
    // notification_configs is always a principal section, and the server pairs it with this task.
    includeCompatibilityNotificationTask: true,
    // Principal-level registrations only: no sync_accounts delivery configs exist to clash with.
    reportingSubscriptions: { accountConfigurations: false },
  });

  const offering = deliveryOffering();
  const engine = createReportingSubscriptionEngineV1({
    principal: lifecycle,
    offerings: [offering],
    store: createReportingSubscriptionEngineStateStoreV1({ store: stateStore }),
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    maxAccounts: 100,
    now,
    hooks: {
      listAuthorizedAccounts: () => ({
        accounts: [{ account_id: REFERENCE_ACCOUNT_ID, authorized_at: '2026-01-01T00:00:00.000Z' }],
      }),
      listAccountBuys: () => [],
      resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
      isPeriodDelivered: () => false,
    },
  });

  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  const request = redactedReportingSourceRequestV1();
  // The currency comes from resolveCurrency, not from per-generation source settings.
  const sourceSettings = { ...request.sourceSettings };
  delete sourceSettings.currency;
  const service = createReliableReportingService({
    store,
    adapters: {
      reference: {
        sourceOffering,
        deliveryOffering: offering,
        // No upstream: every period is observed with zero rows.
        fetchSlice: (slice, context) => ({
          reporting_period: { start: slice.start_date, end: slice.end_date },
          currency: context.sourceSettings.currency,
          reporting_rows: [],
        }),
      },
    },
    contact: { name: 'Reporting operations', email: 'reporting@reference-seller.example' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    resolveSource: account => ({
      adapterId: 'reference',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    resolveCoverage: () => ({ constituents: [] }),
    subscriptions: {
      engine,
      principal: lifecycle,
      resolvePrincipal: principalOf,
      listSubscriptionPrincipals: () => engine.listSubscriptionPrincipals(REFERENCE_TENANT),
      dimensions: ['package'],
      accountConfigurations: false,
      resolveSubscriptionConfiguration: () => ({
        requestedMetrics: request.requestedMetrics,
        requestedDimensions: request.requestedDimensions,
        sourceSettings,
      }),
    },
  });

  // Coverage follows configuration: reconcile the caller's subscriptions after every applied change.
  const protocol = wrapProtocol({
    ...lifecycle.protocol,
    async syncPrincipal(params, ctx) {
      const response = await lifecycle.protocol.syncPrincipal(params, ctx);
      if (response?.result?.kind === 'applied' && ctx.callerMutationScope) {
        await engine.reconcile({
          tenantId: ctx.callerMutationScope.tenant_id,
          principalId: ctx.callerMutationScope.principal_id,
        });
      }
      return response;
    },
  });

  const platform = service.install({
    capabilities: {
      specialisms: [],
      config: {},
      principal: lifecycle.capabilities,
      // A seller exposing sync_principal advertises how buyers learn its capabilities changed.
      capability_changes: {
        capabilities_version: 'reference-1',
        cache_ttl_seconds: 3600,
        notifications: { supported: true, registration_task: 'sync_principal', event_types: ['capabilities.changed'] },
      },
    },
    accounts: {
      resolution: 'explicit',
      resolve: async ref =>
        ref?.account_id === REFERENCE_ACCOUNT_ID ? { id: REFERENCE_ACCOUNT_ID, ctx_metadata: {} } : null,
      upsert: async () => [],
    },
  });
  const createServer = () =>
    createAdcpServerFromPlatform(platform, {
      name: 'reporting-subscriptions-reference-seller',
      version: '1.0.0',
      protocol,
      validation: { requests: 'strict', responses: 'strict' },
    });
  return { createServer, lifecycle, engine, service };
}
