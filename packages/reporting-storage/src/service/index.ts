/**
 * The production composition of Reliable Reporting on PostgreSQL: the Core service over
 * `PostgresReportingLedgerStore`, the managed-delivery runtime and store, notification activity and the
 * webhook outbox, with one scheduler.
 *
 * Every export of this subpath is `@experimental` and may change in minor releases.
 *
 * Stability policy: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 *
 * @packageDocumentation
 */
import {
  REPORTING_MANAGED_DELIVERY_COMPOSITION_V1,
  createReliableReportingService,
  rotateReportingRoster,
  reportingDeploymentWideAccountIds,
  warnReportingSchedulerFailure,
  reportingSchedulerDelay,
  reportingSchedulerErrorMessage,
  type CreateReliableReportingServiceOptionsV1,
  type ReliableReportingCycleOptionsV1,
  type ReliableReportingSchedulerOptionsV1,
  type ReliableReportingServiceV1,
} from '@adcp/sdk/reporting/service';
import { withReportingSubscriptionCoverageV1 } from '@adcp/sdk/reporting/advanced';
import {
  composeNotificationDeliveryAttemptCheckpoints,
  composeWebhookAttemptResultObservers,
  createPostgresReportingWebhookActivityV1,
  projectListAccountsReportingWebhookActivityV1,
  type PostgresReportingWebhookActivityV1,
} from '@adcp/sdk';
import { ReportingDeliveryCapabilitiesSchema } from '@adcp/sdk/schemas';
import {
  createPostgresPersistentNotificationRuntime,
  type Account,
  type CreatePostgresPersistentNotificationRuntimeOptions,
  type DecisioningPlatform,
  type PostgresPersistentNotificationRuntime,
  type ReliableReportingPlatform,
  type RequestContext,
  type ResolveContext,
} from '@adcp/sdk/server';
import type { ReportingDeliveryCapabilities } from '@adcp/sdk/types';
import {
  REPORTING_LEDGER_CHANGES_MIGRATION,
  REPORTING_LEDGER_MIGRATION,
  REPORTING_ROW_STORAGE_MIGRATION,
  PostgresReportingLedgerStore,
  sweepExpiredReportingLedgerState,
  runReportingLedgerMaintenance,
  assertReportingLedgerMaintenanceOptions,
  type ReportingChangeFeedMaintenanceOptionsV1,
  type ReportingCompactionOptionsV1,
  type ReportingOrphanCollectionOptionsV1,
  type ReportingOrphanCollectionStateV1,
  type ReportingPgPool,
  type ReportingRetentionOptionsV1,
  type ReportingRowStorageOptionsV1,
} from '../index';
import {
  PostgresReportingManagedDeliveryStore,
  REPORTING_MANAGED_DELIVERY_MIGRATION,
  createReportingManagedDeliveryRuntime,
  createReportingSubscriptionManagedBindingV1,
  type PostgresReportingManagedDeliveryStoreOptions,
  type ReportingManagedDeliveryAdapterV1,
  type ReportingManagedDeliveryRuntimeV1,
} from '../managed';
import {
  createPostgresReportingNotificationActivityRuntime,
  createPostgresReportingNotificationAttemptCheckpoint,
  type PostgresReportingNotificationActivityOptions,
  type PostgresReportingNotificationActivityRuntime,
} from '../notifications';

type ProductionNotificationOptions = Omit<
  CreatePostgresPersistentNotificationRuntimeOptions,
  'db' | 'publisherScope' | 'checkpointDeliveryAttempt' | 'supportedAccountEventTypes'
>;

/**
 * Options for `createPostgresReliableReportingProductionService`: the Core service options plus the PostgreSQL pool, namespace, notifications, managed delivery and maintenance configuration.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type CreatePostgresReliableReportingProductionServiceOptionsV1<TCtxMeta = Record<string, unknown>> = Omit<
  CreateReliableReportingServiceOptionsV1<TCtxMeta>,
  'store' | 'subscribers' | 'maintenance'
> & {
  db: ReportingPgPool;
  /** Stable, non-secret deployment namespace shared by reporting workers. */
  namespace: string;
  /** Stable webhook publisher identity; credentials must never be used here. */
  publisherScope: string;
  /** Explicit acknowledgement required by the authoritative Core store. */
  acknowledgeIsolatedDatabase: true;
  /**
   * Store new revision rows as verified canonical JSONL chunks. Adds
   * `REPORTING_ROW_STORAGE_MIGRATION` (PostgreSQL 13+) to `setup.migrations`
   * and probes it before publishing capabilities.
   */
  rowStorage?: boolean | ReportingRowStorageOptionsV1;
  /**
   * Opt in to period-aligned retention. Each scheduler pass retires whole
   * periods once `max(statusRetentionDays, recordRetentionDays)` has elapsed
   * since both the period end and its latest publication, deleting their
   * rows and ledger records and leaving a tombstone. Abandoned row uploads
   * and expired cursor snapshots are always swept. With `changeFeed`, a
   * period is also held until every live registered feed consumer (updated
   * within `changeFeed.maxFeedHoldDays`, default 7) has read its changes.
   */
  retention?: ReportingRetentionOptionsV1;
  /**
   * Opt in to compacting superseded snapshot revisions to metadata only, as
   * adcontextprotocol/adcp#8100 permits. Off by default. Each scheduler pass
   * drops the row content of snapshots that are superseded, past their
   * recovery grace and not owed to any caller (receipts, current
   * `received` / `unreadable` / `content_mismatch` statements), while every
   * revision's metadata stays. Official revisions are never compacted. Uses
   * this service's `statusRetentionDays` and `automatedRecoveryWindowSeconds`.
   * The protocol takes compaction into effect only in the next eligible minor
   * after November 20, 2026: do not enable this in production before then.
   */
  compaction?: ReportingCompactionOptionsV1;
  /**
   * Opt in to the listing collector for row objects the write-intent sweep cannot see (an upload that
   * succeeded before its intent recorded it, intents for a binding no running host configures, intents
   * lost to a database restore). Off by default. Each scheduler pass lists every configured object
   * binding under `{prefix}/{namespace_key}/`, examines at most `limit` objects per binding, and
   * deletes an object only when it is older than `minAgeSeconds` (default 7 days) and no ledger record
   * or open upload names it. Needs `rowStorage` bindings whose provider can `list`; others are reported
   * as unsupported. Enable it only on the ledger database that owns the namespace, never on a clone or
   * restore that still points at the same bucket. Start with `dryRun: true`.
   */
  orphanCollection?: ReportingOrphanCollectionOptionsV1;
  /**
   * Maintain the host change feed (`changesAfter`, `getCurrentRevision`,
   * `listCurrentRevisions` on `stores.core`). Adds
   * `REPORTING_LEDGER_CHANGES_MIGRATION` (PostgreSQL 13+); the scheduler prunes
   * changes older than `changeRetentionDays` (default 30) unless a registered
   * consumer updated within `maxFeedHoldDays` (default 7) still needs them.
   */
  changeFeed?: ReportingChangeFeedMaintenanceOptionsV1;
  notifications: ProductionNotificationOptions;
  managedDelivery: {
    adapter: ReportingManagedDeliveryAdapterV1;
    resourceRetentionDays: number;
    authorizationRevocationSeconds: number;
    store?: Omit<PostgresReportingManagedDeliveryStoreOptions, 'notificationActivityPort'>;
  };
  activity: Omit<
    PostgresReportingNotificationActivityOptions,
    'db' | 'notifications' | 'namespace' | 'attemptCheckpoint' | 'tenantScopeForAccount'
  > & {
    tenantScopeForAccount(accountId: string): string;
  };
  webhookActivity?: { tableName?: string; retentionDays?: number };
  /** Resolve activity visibility from verified auth/registry state, never request fields. */
  resolveWebhookActivityScope(
    context: ResolveContext
  ): { tenantId: string; principalId: string } | Promise<{ tenantId: string; principalId: string }>;
  /** Trusted complete roster of consumers that owe receipts for an obligation. */
  obligatedConsumers?: (input: {
    reporting_obligation_id: string;
    account_id: string;
  }) => Promise<{ ids: readonly string[]; complete: boolean; version?: string }>;
  /** Optional migration-system bridge. Called before any capability probe. */
  applyMigrations?: (migrations: readonly string[]) => Promise<void>;
};

/**
 * The assembled production service: Core, managed delivery, notifications, activity and one scheduler.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface PostgresReliableReportingProductionServiceV1<TCtxMeta = Record<string, unknown>> {
  readonly setup: {
    readonly component: 'reliable-reporting-production';
    readonly migrations: readonly string[];
  };
  readonly capabilities: ReportingDeliveryCapabilities;
  readonly platform: ReliableReportingPlatform<TCtxMeta>;
  readonly core: ReliableReportingServiceV1<TCtxMeta>;
  readonly managed: ReportingManagedDeliveryRuntimeV1<RequestContext<Account<TCtxMeta>>>;
  readonly notifications: PostgresPersistentNotificationRuntime;
  readonly notificationActivity: PostgresReportingNotificationActivityRuntime;
  readonly webhookActivity: PostgresReportingWebhookActivityV1;
  readonly stores: {
    core: PostgresReportingLedgerStore;
    managed: PostgresReportingManagedDeliveryStore;
  };
  readonly running: boolean;
  installConfiguration: ReliableReportingServiceV1<TCtxMeta>['installConfiguration'];
  extendConfigurationHistory: ReliableReportingServiceV1<TCtxMeta>['extendConfigurationHistory'];
  install<TPlatform extends DecisioningPlatform<unknown, TCtxMeta>>(
    platform: TPlatform
  ): TPlatform & { reporting: ReliableReportingPlatform<TCtxMeta> };
  runCycle(options: ReliableReportingCycleOptionsV1): Promise<{
    core: Awaited<ReturnType<ReliableReportingServiceV1<TCtxMeta>['runCycle']>>;
    managed: Awaited<ReturnType<ReportingManagedDeliveryRuntimeV1['runWorker']>>;
  }>;
  recoverOnce(options: { deploymentWide: true }): Promise<{
    activity: Awaited<ReturnType<PostgresReportingNotificationActivityRuntime['recoverOnce']>>;
    webhookOutbox: Awaited<ReturnType<PostgresPersistentNotificationRuntime['recoverOnce']>>;
  }>;
  start(options: ReliableReportingSchedulerOptionsV1 & { deploymentWide: true }): void;
  stop(): Promise<void>;
}

/**
 * Assemble and probe the complete seller-side Reliable Reporting production
 * chain. Capability publication happens only after every durable component is
 * present and the managed policy has been adopted.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function createPostgresReliableReportingProductionService<TCtxMeta = Record<string, unknown>>(
  options: CreatePostgresReliableReportingProductionServiceOptionsV1<TCtxMeta>
): Promise<PostgresReliableReportingProductionServiceV1<TCtxMeta>> {
  if (!options.db || typeof options.db.query !== 'function' || typeof options.db.connect !== 'function') {
    throw new TypeError('Reliable Reporting production service requires a PostgreSQL pool');
  }
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(options.namespace)) {
    throw new TypeError('Reliable Reporting production namespace must be a bounded non-secret identifier');
  }
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(options.publisherScope)) {
    throw new TypeError('Reliable Reporting publisherScope must be a bounded non-secret identifier');
  }
  if (typeof options.resolveWebhookActivityScope !== 'function') {
    throw new TypeError('Reliable Reporting production service requires resolveWebhookActivityScope');
  }
  if (typeof options.activity?.tenantScopeForAccount !== 'function') {
    throw new TypeError('Reliable Reporting production service requires activity.tenantScopeForAccount');
  }
  assertReportingLedgerMaintenanceOptions(
    { compaction: options.compaction, orphanCollection: options.orphanCollection },
    options.statusRetentionDays
  );
  if (
    Object.values(options.adapters).some(
      adapter => adapter.deliveryOffering.reconciliation_mode === 'consumer_receipt'
    ) &&
    typeof options.obligatedConsumers !== 'function'
  ) {
    throw new TypeError('Reconciled Billing production offerings require a trusted obligatedConsumers roster');
  }

  const recipientCheckpoint = createPostgresReportingNotificationAttemptCheckpoint({
    db: options.db,
    namespace: options.namespace,
    ...(options.activity?.tableName !== undefined ? { tableName: options.activity.tableName } : {}),
  });
  const webhookActivity = createPostgresReportingWebhookActivityV1({
    db: options.db,
    namespace: options.namespace,
    ...(options.webhookActivity?.tableName !== undefined ? { tableName: options.webhookActivity.tableName } : {}),
    ...(options.webhookActivity?.retentionDays !== undefined
      ? { retentionDays: options.webhookActivity.retentionDays }
      : {}),
  });
  const composedAttemptCheckpoint = composeNotificationDeliveryAttemptCheckpoints(
    recipientCheckpoint,
    webhookActivity.checkpointDeliveryAttempt
  );
  const attemptCheckpoint = Object.assign(
    async (input: Parameters<typeof recipientCheckpoint>[0]) => composedAttemptCheckpoint(input),
    { activityStore: recipientCheckpoint.activityStore }
  );
  const adopterAttemptResult = options.notifications.webhooks.onAttemptResult;
  const adopterAttemptObserverError = options.notifications.webhooks.onAttemptObserverError;
  const notifications = createPostgresPersistentNotificationRuntime({
    ...options.notifications,
    db: options.db,
    publisherScope: options.publisherScope,
    checkpointDeliveryAttempt: attemptCheckpoint,
    supportedAccountEventTypes: ['reporting.ledger_changed', 'reporting.status_changed', 'reporting.delivery_ready'],
    webhooks: {
      ...options.notifications.webhooks,
      onAttemptResult: composeWebhookAttemptResultObservers(
        webhookActivity.emitterObservers.onAttemptResult,
        adopterAttemptResult
      ),
      onAttemptObserverError(error, phase) {
        if (adopterAttemptObserverError) {
          try {
            adopterAttemptObserverError(error, phase);
            return;
          } catch (observerError) {
            console.warn(
              `[adcp/reporting] webhook observer-error hook failed: ${reportingSchedulerErrorMessage(observerError)}; original: ${reportingSchedulerErrorMessage(error)}`
            );
            return;
          }
        }
        console.warn(`[adcp/reporting] webhook ${phase} observer failed: ${reportingSchedulerErrorMessage(error)}`);
      },
    },
  });
  const notificationActivity = createPostgresReportingNotificationActivityRuntime({
    ...options.activity,
    db: options.db,
    notifications,
    namespace: options.namespace,
    attemptCheckpoint,
    tenantScopeForAccount: options.activity.tenantScopeForAccount,
  });
  const coreStore = new PostgresReportingLedgerStore(options.db, {
    acknowledgeIsolatedDatabase: options.acknowledgeIsolatedDatabase,
    managedDelivery: true,
    ...(options.obligatedConsumers ? { obligatedConsumers: options.obligatedConsumers } : {}),
    ...(options.consumerMismatchEscalation ? { consumerMismatchEscalation: options.consumerMismatchEscalation } : {}),
    notificationActivityPort: notificationActivity.port,
    ...(options.rowStorage ? { rowStorage: options.rowStorage } : {}),
    ...(options.changeFeed ? { changeFeed: true } : {}),
  });
  // Fail at construction, not on the first scheduled pass (see createReliableReportingService).
  if (options.compaction) coreStore.assertCompactionSafeRowBindings();
  const managedStore = new PostgresReportingManagedDeliveryStore(options.db, {
    ...options.managedDelivery.store,
    statusRetentionDays: options.statusRetentionDays,
    advertisedRecoveryWindowSeconds: options.automatedRecoveryWindowSeconds,
    notificationActivityPort: notificationActivity.port,
  });
  // Principal-level reporting subscriptions (AdCP 3.3): a managed subscription generation is bound
  // to the owner's destination before its first obligation, every delivery re-checks the owner's
  // authority for the account, and reads are scoped to the caller's principal. Without
  // `reportingSubscriptions` nothing here is wired.
  const subscriptions = options.reportingSubscriptions;
  if (subscriptions && typeof subscriptions.engine?.isAuthorized !== 'function') {
    throw new TypeError(
      'reportingSubscriptions on the production service requires an engine with isAuthorized, so every ' +
        'managed delivery re-checks the owner principal’s account authority'
    );
  }
  const bindManagedGeneration =
    subscriptions?.bindManagedGeneration ??
    (subscriptions?.principal
      ? createReportingSubscriptionManagedBindingV1({
          store: managedStore,
          principal: subscriptions.principal as never,
          resourceRetentionDays: options.managedDelivery.resourceRetentionDays,
          verificationProfiles: options.managedDelivery.adapter.verificationProfiles,
        })
      : undefined);
  const coreOptions = {
    ...options,
    ...(subscriptions
      ? {
          reportingSubscriptions: {
            ...subscriptions,
            ...(bindManagedGeneration ? { bindManagedGeneration } : {}),
          },
        }
      : {}),
    store: coreStore,
    // The composer's assertion that this service is served by a managed-delivery runtime: it names the store itself.
    [REPORTING_MANAGED_DELIVERY_COMPOSITION_V1]: coreStore,
  } as CreateReliableReportingServiceOptionsV1<TCtxMeta> & {
    [REPORTING_MANAGED_DELIVERY_COMPOSITION_V1]: PostgresReportingLedgerStore;
  };
  const core = createReliableReportingService(coreOptions);
  const migrations = Object.freeze([
    REPORTING_LEDGER_MIGRATION,
    ...(options.rowStorage ? [REPORTING_ROW_STORAGE_MIGRATION] : []),
    ...(options.changeFeed ? [REPORTING_LEDGER_CHANGES_MIGRATION] : []),
    REPORTING_MANAGED_DELIVERY_MIGRATION,
    ...notifications.migrations.all,
    ...notificationActivity.migrations.all,
    ...webhookActivity.migrations.all,
  ]);
  await options.applyMigrations?.(migrations);
  await coreStore.readyRowStorage();
  await notifications.probe();
  await notificationActivity.probe();
  await webhookActivity.probe();

  const managed = await createReportingManagedDeliveryRuntime<RequestContext<Account<TCtxMeta>>>({
    coreStore,
    ...(options.legacyRevisionReader ? { legacyRevisionReader: options.legacyRevisionReader } : {}),
    store: managedStore,
    adapter: options.managedDelivery.adapter,
    // `standard_dimensions` and `unmapped_dimensions` (published with reporting subscriptions) are
    // defined after the offering schema the managed runtime validates against, which is closed.
    offerings: core.capabilities.offerings.map(offering => {
      const {
        standard_dimensions: _standard,
        unmapped_dimensions: _unmapped,
        ...rest
      } = offering as typeof offering & { standard_dimensions?: unknown; unmapped_dimensions?: unknown };
      void _standard;
      void _unmapped;
      return rest;
    }) as typeof core.capabilities.offerings,
    automatedRecoveryWindowSeconds: options.automatedRecoveryWindowSeconds,
    statusRetentionDays: options.statusRetentionDays,
    resourceRetentionDays: options.managedDelivery.resourceRetentionDays,
    authorizationRevocationSeconds: options.managedDelivery.authorizationRevocationSeconds,
    ...(options.resolveConsumerId ? { resolveConsumerId: options.resolveConsumerId } : {}),
    ...(options.consumerMismatchEscalation ? { consumerMismatchEscalation: options.consumerMismatchEscalation } : {}),
    ...(subscriptions
      ? {
          resolveSubscriptionPrincipal: async (context: RequestContext<Account<TCtxMeta>>) => {
            const principal = await subscriptions.resolvePrincipal(context);
            return { tenantId: principal.tenantId, principalId: principal.principalId };
          },
          authorizeSubscriptionDelivery: ({ principal, account_id }) =>
            subscriptions.engine.isAuthorized!(principal, account_id),
        }
      : {}),
  });
  const capabilities = deepFreeze(
    ReportingDeliveryCapabilitiesSchema.parse({
      ...core.capabilities,
      ...managed.reportingDeliveryCapabilities,
      ledger_notification: 'reporting.ledger_changed',
      status_notification: 'reporting.status_changed',
      readiness_notification: 'reporting.delivery_ready',
      supports_webhook_activity: true,
    }) as ReportingDeliveryCapabilities
  );
  const platform: ReliableReportingPlatform<TCtxMeta> = {
    capabilities,
    getReportingStatus: subscriptions
      ? async (request, context) =>
          withReportingSubscriptionCoverageV1(
            await managed.getReportingStatus(request, context as never),
            context as never,
            subscriptions
          )
      : (request, context) => managed.getReportingStatus(request, context as never),
    getMediaBuyDelivery: (request, context) => managed.getMediaBuyDelivery(request, context as never),
    ...(core.platform.syncReportingStatus
      ? {
          syncReportingStatus: core.platform.syncReportingStatus,
          resolveConsumerId: core.platform.resolveConsumerId,
        }
      : {}),
    ...(managed.syncReportingReceipts
      ? {
          syncReportingReceipts: (request, context) => managed.syncReportingReceipts!(request, context),
        }
      : {}),
    async projectListAccounts(request, response, context) {
      const withoutDiagnostics = () =>
        projectListAccountsReportingWebhookActivityV1({
          request: { ...request, include_webhook_activity: false },
          response,
          tenantId: 'diagnostics-not-requested',
          principalId: 'diagnostics-not-requested',
          activity: webhookActivity,
        });
      if (request.include_webhook_activity !== true) return withoutDiagnostics();
      try {
        const scope = await options.resolveWebhookActivityScope(context);
        return await projectListAccountsReportingWebhookActivityV1({
          request,
          response,
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          activity: webhookActivity,
        });
      } catch (error) {
        // Transport diagnostics are a debug aid. A logging-store outage must
        // not take down the authoritative account roster or leak stale
        // adopter-supplied activity fields.
        console.warn(
          `[adcp/reporting] webhook activity projection unavailable: ${reportingSchedulerErrorMessage(error)}`
        );
        return withoutDiagnostics();
      }
    },
  };

  let auxiliaryAbort: AbortController | undefined;
  let auxiliaryPromise: Promise<void> | undefined;
  let auxiliaryRotation = 0;
  // Where the orphan collector is up to, kept across scheduler passes of this process.
  const orphanState: ReportingOrphanCollectionStateV1 = { cursors: {} };
  const reportAuxiliaryError = async (
    scheduler: ReliableReportingSchedulerOptionsV1,
    error: unknown
  ): Promise<void> => {
    if (scheduler.onError) {
      try {
        await scheduler.onError(error);
        return;
      } catch (observerError) {
        warnReportingSchedulerFailure(scheduler, { phase: 'cycle' }, error, observerError);
        return;
      }
    }
    warnReportingSchedulerFailure(scheduler, { phase: 'cycle' }, error);
  };
  const runAuxiliaryPass = async (
    scheduler: ReliableReportingSchedulerOptionsV1,
    signal: AbortSignal
  ): Promise<void> => {
    signal.throwIfAborted();
    try {
      const totalLimit = scheduler.notificationRecoveryLimit ?? 25;
      const concurrency = Math.min(scheduler.notificationRecoveryConcurrency ?? 4, totalLimit);
      const baseLimit = Math.floor(totalLimit / concurrency);
      const remainder = totalLimit % concurrency;
      await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          notificationActivity.recoverOnce({
            limit: baseLimit + (index < remainder ? 1 : 0),
            signal,
            onError: error => reportAuxiliaryError(scheduler, error),
          })
        )
      );
    } catch (error) {
      if (!signal.aborted) await reportAuxiliaryError(scheduler, error);
    }
    signal.throwIfAborted();
    try {
      await notifications.recoverOnce({ limit: scheduler.webhookRecoveryLimit ?? 10 });
    } catch (error) {
      if (!signal.aborted) await reportAuxiliaryError(scheduler, error);
    }
    signal.throwIfAborted();
    const pruneResults = await Promise.allSettled([
      notificationActivity.pruneProjected({ limit: 1_000 }),
      webhookActivity.pruneCompleted({ limit: 1_000 }),
    ]);
    for (const result of pruneResults) {
      if (result.status === 'rejected' && !signal.aborted) await reportAuxiliaryError(scheduler, result.reason);
    }
    await runReportingLedgerMaintenance({
      store: coreStore,
      sweepSnapshots: limit => sweepExpiredReportingLedgerState(options.db, limit),
      statusRetentionDays: options.statusRetentionDays,
      automatedRecoveryWindowSeconds: options.automatedRecoveryWindowSeconds,
      retention: options.retention,
      compaction: options.compaction,
      changeFeed: options.changeFeed,
      orphanCollection: options.orphanCollection,
      orphanState,
      signal,
      report: error => reportAuxiliaryError(scheduler, error),
    });
    const accountIds = rotateReportingRoster(await reportingDeploymentWideAccountIds(coreStore), auxiliaryRotation);
    auxiliaryRotation += 1;
    for (const accountId of accountIds) {
      signal.throwIfAborted();
      try {
        await managed.runWorker({
          signal,
          ...(accountId ? { account_id: accountId } : {}),
          ...(scheduler.maxWorkerIterationsPerAccount !== undefined
            ? { maxIterations: scheduler.maxWorkerIterationsPerAccount }
            : {}),
        });
        if (accountId) await managedStore.pruneExpiredEvidence?.({ account_id: accountId, limit: 1_000 });
      } catch (error) {
        if (!signal.aborted) await reportAuxiliaryError(scheduler, error);
      }
    }
  };

  const service: PostgresReliableReportingProductionServiceV1<TCtxMeta> = {
    setup: Object.freeze({ component: 'reliable-reporting-production', migrations }),
    capabilities,
    platform,
    core,
    managed,
    notifications,
    notificationActivity,
    webhookActivity,
    stores: Object.freeze({ core: coreStore, managed: managedStore }),
    get running() {
      return core.running || auxiliaryPromise !== undefined;
    },
    installConfiguration: core.installConfiguration.bind(core),
    extendConfigurationHistory: core.extendConfigurationHistory.bind(core),
    install<TPlatform extends DecisioningPlatform<unknown, TCtxMeta>>(target: TPlatform) {
      if (typeof target.accounts.upsert !== 'function') {
        throw new TypeError('Reliable reporting requires accounts.upsert');
      }
      if (typeof target.accounts.list !== 'function') {
        throw new TypeError(
          'Reliable reporting production webhook activity requires accounts.list so list_accounts can serve the advertised diagnostics'
        );
      }
      if (target.reporting && target.reporting !== platform) {
        throw new TypeError('DecisioningPlatform already has a reporting lifecycle installed');
      }
      if (!target.reporting) {
        Object.defineProperty(target, 'reporting', {
          value: platform,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return target as TPlatform & { reporting: ReliableReportingPlatform<TCtxMeta> };
    },
    async runCycle(cycle) {
      const coreResult = await core.runCycle(cycle);
      const managedResult = await managed.runWorker({
        ...(cycle.signal ? { signal: cycle.signal } : {}),
        ...(!cycle.deploymentWide ? { account_id: cycle.accountId } : {}),
        ...(cycle.maxWorkerIterations !== undefined ? { maxIterations: cycle.maxWorkerIterations } : {}),
      });
      return { core: coreResult, managed: managedResult };
    },
    async recoverOnce(recoveryOptions) {
      if (recoveryOptions?.deploymentWide !== true) {
        throw new TypeError('Reliable Reporting production recovery requires deploymentWide: true');
      }
      const activityResult = await notificationActivity.recoverOnce();
      const webhookOutbox = await notifications.recoverOnce();
      return { activity: activityResult, webhookOutbox };
    },
    start(scheduler) {
      if (auxiliaryPromise) throw new Error('Reliable Reporting production scheduler is already running');
      if (scheduler.deploymentWide !== true) {
        throw new TypeError('Reliable Reporting production scheduler requires deploymentWide: true');
      }
      if (
        scheduler.notificationRecoveryLimit !== undefined &&
        (!Number.isSafeInteger(scheduler.notificationRecoveryLimit) ||
          scheduler.notificationRecoveryLimit < 1 ||
          scheduler.notificationRecoveryLimit > 1_000)
      ) {
        throw new TypeError('notificationRecoveryLimit must be an integer from 1 through 1000');
      }
      if (
        scheduler.notificationRecoveryConcurrency !== undefined &&
        (!Number.isSafeInteger(scheduler.notificationRecoveryConcurrency) ||
          scheduler.notificationRecoveryConcurrency < 1 ||
          scheduler.notificationRecoveryConcurrency > 64)
      ) {
        throw new TypeError('notificationRecoveryConcurrency must be an integer from 1 through 64');
      }
      if (
        scheduler.webhookRecoveryLimit !== undefined &&
        (!Number.isSafeInteger(scheduler.webhookRecoveryLimit) ||
          scheduler.webhookRecoveryLimit < 1 ||
          scheduler.webhookRecoveryLimit > 1_000)
      ) {
        throw new TypeError('webhookRecoveryLimit must be an integer from 1 through 1000');
      }
      core.start(scheduler);
      auxiliaryAbort = new AbortController();
      const signal = auxiliaryAbort.signal;
      auxiliaryPromise = (async () => {
        while (!signal.aborted) {
          try {
            await runAuxiliaryPass(scheduler, signal);
          } catch (error) {
            if (!signal.aborted) await reportAuxiliaryError(scheduler, error);
          }
          if (!signal.aborted) await reportingSchedulerDelay(scheduler.intervalMilliseconds, signal);
        }
      })().finally(() => {
        auxiliaryAbort = undefined;
        auxiliaryPromise = undefined;
      });
    },
    async stop() {
      auxiliaryAbort?.abort();
      await Promise.all([core.stop(), auxiliaryPromise]);
    },
  };
  return service;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
