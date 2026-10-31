/**
 * Reliable Reporting service wiring and conformance runner.
 *
 * `createReliableReportingService` takes any `ReportingLedgerStore`. The PostgreSQL store, the production
 * composition (`createPostgresReliableReportingProductionService`) and ledger maintenance
 * (`reportingLedgerMaintenance`) live in `@adcp/reporting-storage`.
 *
 * The scheduler primitives (`reportingSchedulerDelay`, `rotateReportingRoster`, ...) and
 * `REPORTING_MANAGED_DELIVERY_COMPOSITION_V1` are storage-facing building blocks for compositions such as
 * `@adcp/reporting-storage/service`, covered by the experimental policy below; applications should not use them.
 *
 * Stability policy: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 *
 * @packageDocumentation
 */
import type { Account } from '../../server/decisioning/account';
import type { RequestContext } from '../../server/decisioning/context';
import type { DecisioningPlatform } from '../../server/decisioning/platform';
import type { ReliableReportingPlatform } from '../../server/decisioning/specialisms/reporting';
import { scanArgsForCredentials } from '../../server/credential-policy';
import { PlatformConfigError } from '../../server/decisioning/runtime/validate-platform';
import { canonicalize } from '../../utils/jcs';
import type { ReportingDeliveryCapabilities, ReportingDeliveryOffering } from '../../types/tools.generated';
import { ReportingDeliveryOfferingSchema } from '../../types/schemas.generated';
import {
  assertReportingConsumerMismatchEscalation,
  reportingConsumerStatusCapabilityV1,
  reportingEffectiveConsumerMismatchEscalationV1,
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  type CreateReportingProducerOptionsV1,
  type ReportingConsumerMismatchEscalationV1,
  type ReportingConsumerStatusLedgerStore,
  type ReportingLedgerConfigurationV1,
  type ReportingLedgerStore,
  type ReportingLegacyRevisionReaderV1,
  type ReportingProducerContactV1,
  type ReportingProducerV1,
  type ReportingSourceWithReaderV1,
  type ReportingSubscriptionConfigurationInputV1,
  type ReportingSubscriptionLedgerObligationInputV1,
} from '../ledger';
import {
  reportReportingSchedulerError,
  reportingDeploymentWideAccountIds,
  reportingSchedulerDelay,
  rotateReportingRoster,
} from './scheduler-support';
import type { InlineReportingReplayRetentionV1 } from '../source';
import { listedReportingSourceProductIdsV1 } from '../source/applicability';
import { assertReportingCalendarDaySource, reportingCalendarDayOrigin } from '../ledger/schedule';
import {
  ReportingCoverageConstituentIdentityV1Schema,
  SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1,
  ReportingSourceOfferingV1Schema,
  ReportingSourceScopeV1Schema,
  reportingIsSourceLocalMidnightV1,
  reportingScheduleOriginV1,
  reportingUtcOffsetMinutesV1,
  createInlineReportingSourceExecutor,
  reportingIsoDurationMillisecondsV1,
  reportingSourceCapabilitiesV1,
  type InlineReportingDeliveryFetchV1,
  type ReportingSourceExecutorResultV1,
  type ReportingSourceOfferingV1,
} from '../source';

import type { ReportingSubscriptionFrozenOwedSetV1 } from '../subscriptions/engine';
import type { PrincipalRef } from '../../server/principal/types';
import { reportingConfigurationCapabilitiesV1 } from '../subscriptions/capabilities';
import type { ReportingDeliveryOfferingWithDimensionsV1 } from '../subscriptions/wire';
import { type ReliableReportingSubscriptionsOptionsV1, withReportingSubscriptionCoverageV1 } from './subscriptions';

const ADAPTER_SCOPE_KEY = '_adcp_reporting_adapter';

/** The intentionally small provider boundary: one bounded slice fetch plus immutable metadata. */
export interface ReliableReportingAdapterV1 {
  readonly sourceOffering: ReportingSourceOfferingV1;
  readonly deliveryOffering: ReportingDeliveryOffering;
  /**
   * Adapted through the bounded inline executor, which retains every admitted
   * execution so an admitted key stays replayable — and therefore caps a scope
   * at 100 slices. A scheduled feed that outlives that ceiling must supply
   * `executor`, or opt in to `inlineReplayRetention`; without one of those it
   * terminalizes with QUOTA_EXHAUSTED and does not recover.
   */
  readonly fetchSlice?: InlineReportingDeliveryFetchV1;
  /**
   * Explicit bounded replay window for the inline executor. Trades the lifetime
   * replay guarantee for a feed that keeps producing; never applied silently.
   */
  readonly inlineReplayRetention?: InlineReportingReplayRetentionV1;
  /**
   * Escape hatch for feeds the inline executor cannot serve: pagination,
   * durable staged objects, or replay that must survive process restarts.
   * Mutually exclusive with `fetchSlice`.
   */
  readonly executor?: ReportingSourceWithReaderV1;
}

/**
 * The media-buy/package denominator this account's credential is authorized to
 * report on. `mediaBuyIds` is always derived from `constituents`, so the two
 * can never disagree.
 */
export interface ReliableReportingCoverageV1 {
  constituents: ReportingLedgerConfigurationV1['constituents'];
}

export interface ReliableReportingSourceRouteV1 {
  /** Key in `adapters`; selected by trusted host code, never by buyer input. */
  adapterId: string;
  /** Durable non-secret upstream identifiers used to re-derive authorization per request. */
  sourceScope: Record<string, unknown>;
  /** Trusted upstream reporting clock for this account/scope. */
  sourceTimezone: string;
}

type LedgerInstallInput = Omit<
  ReportingLedgerConfigurationV1,
  | 'configurationId'
  | 'installedAt'
  | 'semanticFingerprint'
  | 'calendarRules'
  | 'historyStart'
  | 'historyStartOrdinal'
  | 'subscription'
  | 'owedSet'
  | 'account'
  | 'sourceScope'
  | 'sourceTimezone'
  | 'sourceSettings'
  | 'contract'
  | 'constituents'
  | 'mediaBuyIds'
>;

/**
 * Seller-resolved configuration facts. `currency`, account identity, source
 * scope, timezone, and source contract are deliberately absent.
 */
export interface ReliableReportingConfigurationInputV1 extends LedgerInstallInput {
  sourceSettings: Omit<ReportingLedgerConfigurationV1['sourceSettings'], 'currency'>;
  /** Optional assertion from the commercial flow; disagreement fails closed. */
  expectedCurrency?: string;
  /** Optional assertion from account setup; disagreement fails closed. */
  expectedSourceTimezone?: string;
  /** Optional assertion of the requested media-buy scope; disagreement fails closed. */
  expectedMediaBuyIds?: readonly string[];
}

export interface ReliableReportingInstallContextV1<TCtxMeta = Record<string, unknown>> {
  /** Must be the framework-resolved account from RequestContext. */
  account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>;
  /** Trusted host history entitlement; never copy from buyer configuration input. */
  historyStart?: string;
}

interface ReliableReportingSchedulerBaseOptionsV1 {
  intervalMilliseconds: number;
  maxObligationsPerAccount?: number;
  maxWorkerIterationsPerAccount?: number;
  maxHistoryObligationsPerSource?: number;
  maxHistorySlicesPerSource?: number;
  /** Bounded transactional notification claims per auxiliary pass. Defaults to 25. */
  notificationRecoveryLimit?: number;
  /** Independent notification recovery workers. Defaults to 4. */
  notificationRecoveryConcurrency?: number;
  /** Bounded webhook-outbox claims per auxiliary pass. Defaults to 10. */
  webhookRecoveryLimit?: number;
  retryDelayMilliseconds?: number;
  executionDeadlineMilliseconds?: number;
  settlementGraceMilliseconds?: number;
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Destination for the scheduler's own warn-level diagnostics. Defaults to
   * `console.warn`.
   *
   * The scheduler is a durable background loop: a roster resolver that keeps
   * throwing runs zero tenants every interval, and a tenant whose cycle keeps
   * failing produces nothing, in both cases indefinitely and by design — the
   * loop must not die. That makes silence the dangerous outcome, so a failure
   * no `onError` was configured to observe is warned here instead of dropped.
   *
   * A configured `onError` owns reporting and nothing is warned alongside it,
   * so an adopter's own pipeline is never duplicated. The one exception is an
   * `onError` that itself throws: it would otherwise take both its own failure
   * and the one it was handed down with it.
   *
   * Messages carry the failure phase, the account when there is one, and the
   * error's `message` passed through credential redaction — never a stack,
   * never the error object. Pass `{ warn: () => {} }` to opt out entirely.
   */
  logger?: { warn: (message: string) => void };
}

export type ReliableReportingSchedulerOptionsV1 = ReliableReportingSchedulerBaseOptionsV1 &
  (
    | { /** Explicit opt-in to scanning every account in the ledger. */ deploymentWide: true; accountIds?: never }
    | {
        deploymentWide?: false;
        accountIds: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
      }
  );

interface ReliableReportingCycleBaseOptionsV1 {
  now?: Date;
  maxObligations?: number;
  maxWorkerIterations?: number;
  /** Per source offering planning budget in this cycle; defaults to maxObligations. Zero pauses planning history. */
  maxHistoryObligationsPerSource?: number;
  /** Per source offering execution budget in this cycle; defaults to 10. Zero pauses executing history. */
  maxHistorySlicesPerSource?: number;
  retryDelayMilliseconds?: number;
  executionDeadlineMilliseconds?: number;
  settlementGraceMilliseconds?: number;
  signal?: AbortSignal;
}

export type ReliableReportingCycleOptionsV1 = ReliableReportingCycleBaseOptionsV1 &
  ({ deploymentWide: true; accountId?: never } | { deploymentWide?: false; accountId: string });

export interface CreateReliableReportingServiceOptionsV1<TCtxMeta = Record<string, unknown>> {
  store: ReportingLedgerStore;
  adapters: Readonly<Record<string, ReliableReportingAdapterV1>>;
  contact: ReportingProducerContactV1;
  resolveSource(
    account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>,
    configuration: Readonly<ReliableReportingConfigurationInputV1>
  ): ReliableReportingSourceRouteV1 | Promise<ReliableReportingSourceRouteV1>;
  resolveCurrency(
    account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>,
    configuration: Readonly<ReliableReportingConfigurationInputV1>
  ): string | Promise<string>;
  /**
   * Authorize and derive the media-buy/package denominator for this account.
   *
   * This is an authorization boundary, not a convenience: `sourceScope` may
   * legitimately resolve to a shared upstream network, so the constituent list
   * is the only thing separating one buyer's orders from another's on that
   * network. It must be derived from the resolved account, never echoed from
   * the buyer's declaration.
   */
  resolveCoverage(
    account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>,
    configuration: Readonly<ReliableReportingConfigurationInputV1>
  ): ReliableReportingCoverageV1 | Promise<ReliableReportingCoverageV1>;
  /** Enables authenticated consumer-scoped status reads and sync_reporting_status. */
  resolveConsumerId?: (context: RequestContext<Account<TCtxMeta>>) => string | Promise<string>;
  consumerMismatchEscalation?: ReportingConsumerMismatchEscalationV1;
  automatedRecoveryWindowSeconds: number;
  /** Ledger metadata retention commitment advertised to buyers. */
  statusRetentionDays: number;
  subscribers?: CreateReportingProducerOptionsV1['subscribers'];
  /**
   * Opt in to scheduled ledger maintenance (retention, compaction, change-feed pruning, abandoned-upload
   * sweeps) for a Core-only deployment. `start()` runs it at most once per `intervalMilliseconds`;
   * `runMaintenance()` runs it on demand for a host with its own scheduler.
   *
   * The SDK does not know what maintenance a store needs: the option takes a factory, called once at
   * construction with the store and the retention and recovery-window commitments this service advertises
   * to buyers, so maintenance can never retire a period earlier than that retention. For the PostgreSQL
   * store, pass `reportingLedgerMaintenance({ ... })` from `@adcp/reporting-storage`. A factory that
   * throws fails service construction, not the first scheduled pass. The production service in
   * `@adcp/reporting-storage/service` runs maintenance itself and does not take this option.
   */
  maintenance?: ReliableReportingMaintenanceFactoryV1;
  /**
   * Serve exact revision reads (`get_media_buy_delivery`) for revisions this
   * ledger does not hold, such as a seller's pre-cutover ledger tables. The
   * SDK ledger answers first; the reader is called with the same request and
   * context only when the SDK has no such revision for the resolved account.
   * It is never called for an SDK-owned revision that is expired or has
   * unavailable or corrupt rows, nor on capacity or other errors. A
   * `null`/`undefined` result becomes the SDK's own nondisclosing
   * `REFERENCE_NOT_FOUND`.
   *
   * The reader owns authorization: it MUST scope its lookup by
   * `context.account` and return `null` for another account's revision. Read
   * only; never write to the SDK ledger from it. See
   * `docs/guides/REPORTING-LEDGER-CUTOVER.md`.
   */
  legacyRevisionReader?: ReportingLegacyRevisionReaderV1;
  /**
   * Opt in to principal-level reporting subscriptions (experimental
   * `media_buy.reporting_subscriptions`, AdCP 3.3). Advertises `configuration_tasks` with
   * `sync_principal` and the `subscriptions` block, and adds `subscription_coverage[]` to
   * `get_reporting_status` summary and periods views. Pair it with a principal runtime
   * created with `reportingSubscriptions` and a reporting subscription engine from
   * `@adcp/sdk/reporting/advanced`, where this option's type is also published. Without it
   * capabilities and responses are unchanged.
   */
  subscriptions?: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>;
  /**
   * @deprecated Renamed `subscriptions`, the service's one reporting-subscription block. Passing both
   * is a configuration error. This alias is removed in a later beta.
   */
  reportingSubscriptions?: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>;
}

/**
 * Outcome of one maintenance task. A task that resolved but could not process some items is `completed`
 * with `partialFailure` set; the pass resumes those items next time.
 */
export type ReliableReportingMaintenanceTaskResultV1 =
  | {
      readonly task: string;
      readonly status: 'completed';
      readonly result: unknown;
      readonly partialFailure?: Error;
    }
  | { readonly task: string; readonly status: 'failed'; readonly error: unknown };

/** One scheduled maintenance pass, as built by a {@link ReliableReportingMaintenanceFactoryV1}. */
export interface ReliableReportingMaintenanceV1 {
  /** Minimum time between scheduled passes. A positive safe integer. */
  readonly intervalMilliseconds: number;
  /**
   * Run one pass. Tasks are isolated: a task failure is reported in its result, never thrown. `report`
   * is awaited, in task order, for every task that rejected or partially failed, unless `signal` has
   * aborted (an abort is shutdown, not a fault).
   */
  run(input: {
    signal?: AbortSignal | undefined;
    report?: (error: unknown) => Promise<void>;
  }): Promise<readonly ReliableReportingMaintenanceTaskResultV1[]>;
}

/** What the service tells a maintenance factory about the store it will maintain. */
export interface ReliableReportingMaintenanceContextV1 {
  readonly store: ReportingLedgerStore;
  /** The `statusRetentionDays` this service advertises. */
  readonly statusRetentionDays: number;
  /** The `automatedRecoveryWindowSeconds` this service advertises. */
  readonly automatedRecoveryWindowSeconds: number;
}

/**
 * Builds the maintenance for one service. Throw from it to refuse a configuration the store cannot
 * serve; the service lets the error reach the caller of `createReliableReportingService`.
 */
export type ReliableReportingMaintenanceFactoryV1 = (
  context: ReliableReportingMaintenanceContextV1
) => ReliableReportingMaintenanceV1;

/**
 * Composition token, for packages that compose this service with a managed-delivery runtime (such as
 * `createPostgresReliableReportingProductionService` in `@adcp/reporting-storage/service`). Such a
 * composition passes `{ [REPORTING_MANAGED_DELIVERY_COMPOSITION_V1]: store }`, naming the very `store` it passes
 * as `store`, so the Core service accepts the managed-delivery and reconciled-billing offerings that only that
 * composition can serve. A plain Core service refuses them.
 *
 * It is an assertion by the composer, not an authentication boundary: it keeps a Core-only service from
 * advertising capabilities it has no runtime for by accident (the value must be the store itself, so a copied
 * `true` does nothing). It is a `Symbol.for` key so it holds across duplicate copies of the SDK. Applications
 * should not use it.
 *
 * @experimental Storage-facing building block: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_MANAGED_DELIVERY_COMPOSITION_V1: unique symbol = Symbol.for(
  '@adcp/sdk/reporting/managed-delivery-composition'
) as never;

export interface ReliableReportingSetupV1 {
  readonly component: 'reliable-reporting-core';
  /** The store's own `migrations`: what to apply before first use. Empty for a store that needs none. */
  readonly migrations: readonly string[];
  readonly requiresIsolatedLedgerDatabaseAcknowledgement: true;
}

export interface ReliableReportingServiceV1<TCtxMeta = Record<string, unknown>> {
  readonly setup: ReliableReportingSetupV1;
  readonly capabilities: ReportingDeliveryCapabilities;
  readonly producer: ReportingProducerV1;
  readonly platform: ReliableReportingPlatform<TCtxMeta>;
  readonly running: boolean;
  installConfiguration(
    configuration: ReliableReportingConfigurationInputV1,
    context: ReliableReportingInstallContextV1<TCtxMeta>
  ): Promise<ReportingLedgerConfigurationV1>;
  /** Trusted host operation; does not change the generation version or installedAt. */
  extendConfigurationHistory(input: {
    configurationId: string;
    historyStart: string;
  }): Promise<ReportingLedgerConfigurationV1>;
  /**
   * Returns the same platform object, narrowed to also carry `reporting`.
   * The input type is preserved: widening to `DecisioningPlatform` would erase
   * literal `capabilities.specialisms` and adopter-declared members, and
   * `createAdcpServerFromPlatform` enforces specialism-required tools off
   * exactly those types.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  install<TPlatform extends DecisioningPlatform<any, TCtxMeta>>(
    platform: TPlatform
  ): TPlatform & { reporting: ReliableReportingPlatform<TCtxMeta> };
  runCycle(options: ReliableReportingCycleOptionsV1): Promise<{
    planned: number;
    claimed: number;
    revisionsCommitted: number;
    notReady: number;
    failed: number;
  }>;
  /**
   * Run one ledger-maintenance pass now and return each task's outcome. For
   * hosts that run their own scheduler instead of `start()`. A task failure is
   * reported in its result, not thrown. Requires the `maintenance` option.
   */
  runMaintenance(options?: { signal?: AbortSignal }): Promise<readonly ReliableReportingMaintenanceTaskResultV1[]>;
  start(options: ReliableReportingSchedulerOptionsV1): void;
  stop(): Promise<void>;
}

/**
 * Compose the existing source executor, ledger producer, protocol handlers,
 * and scheduler into one Reliable Reporting Core lifecycle owner.
 */
export function createReliableReportingService<TCtxMeta = Record<string, unknown>>(
  options: CreateReliableReportingServiceOptionsV1<TCtxMeta>
): ReliableReportingServiceV1<TCtxMeta> {
  const allowManagedDelivery =
    (
      options as CreateReliableReportingServiceOptionsV1<TCtxMeta> & {
        [REPORTING_MANAGED_DELIVERY_COMPOSITION_V1]?: ReportingLedgerStore;
      }
    )[REPORTING_MANAGED_DELIVERY_COMPOSITION_V1] === options.store;
  const adapterEntries = Object.entries(options.adapters);
  if (adapterEntries.length === 0) throw new TypeError('Reliable reporting requires at least one adapter');
  positiveInteger(options.automatedRecoveryWindowSeconds, 'automatedRecoveryWindowSeconds');

  const sources = new Map<string, ReportingSourceWithReaderV1>();
  const adapterOfferings = new Map<string, ReportingSourceOfferingV1>();
  const offerings = new Map<string, ReportingSourceOfferingV1>();
  const deliveryOfferings: ReportingDeliveryOffering[] = [];
  for (const [adapterId, adapter] of adapterEntries) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(adapterId)) throw new TypeError('Reporting adapter IDs must be bounded IDs');
    const sourceOffering = ReportingSourceOfferingV1Schema.parse(structuredClone(adapter.sourceOffering));
    const deliveryOffering = ReportingDeliveryOfferingSchema.parse(
      structuredClone(adapter.deliveryOffering)
    ) as ReportingDeliveryOffering;
    if (offerings.has(sourceOffering.offeringId)) throw new TypeError('Reporting offering IDs must be unique');
    if ((adapter.fetchSlice === undefined) === (adapter.executor === undefined)) {
      throw new TypeError('Each reporting adapter requires exactly one of fetchSlice or executor');
    }
    const source =
      adapter.executor ??
      createInlineReportingSourceExecutor(adapter.fetchSlice!, sourceOffering, {
        ...(adapter.inlineReplayRetention ? { replayRetention: adapter.inlineReplayRetention } : {}),
      });
    // The executor's own offering is the one that governs every request and is
    // stored on each generation, so it — not the declaration beside it — is
    // what the delivery metadata must be validated against. Matching on ID
    // alone would let an injected executor answer with a different contract
    // under the same ID: advertise definition A, store and request B.
    const routed = source.capabilities.offerings.filter(
      candidate => candidate.offeringId === sourceOffering.offeringId
    );
    if (routed.length !== 1) {
      throw new TypeError('Reporting adapter executor must expose exactly one offering with its declared ID');
    }
    const routedOffering = routed[0]!;
    if (canonicalize(routedOffering.contract) !== canonicalize(sourceOffering.contract)) {
      throw new TypeError('Reporting adapter executor offering contract differs from its declared source offering');
    }
    const declaredProducts = listedReportingSourceProductIdsV1(sourceOffering.applicability);
    const routedProducts = listedReportingSourceProductIdsV1(routedOffering.applicability);
    if (declaredProducts !== undefined) {
      const allowed = new Set(declaredProducts);
      if (routedProducts === undefined || routedProducts.some(productId => !allowed.has(productId))) {
        throw new TypeError('Reporting adapter executor must not broaden its declared product applicability');
      }
    }
    // Validated against the routed offering, so the narrowing the inline
    // executor applies (media_buy applicability, one format) is authoritative.
    validateDeliveryOffering(routedOffering, deliveryOffering, allowManagedDelivery);
    sources.set(adapterId, source);
    // Keyed by adapter, not by offering ID: the route must resolve to the exact
    // executor instance whose contract was validated here. A global offering
    // lookup would let an executor that happens to expose another adapter's ID
    // be selected while that other adapter's contract is the one stored.
    adapterOfferings.set(adapterId, routedOffering);
    offerings.set(routedOffering.offeringId, routedOffering);
    deliveryOfferings.push(deliveryOffering);
  }

  const routedSource = createRoutedSource(sources, offerings);
  const producer = createReportingProducer({
    store: options.store,
    source: routedSource,
    offerings: [...offerings.values()],
    contact: options.contact,
    ...(options.subscribers ? { subscribers: options.subscribers } : {}),
  });

  const hasConsumerStatus = options.resolveConsumerId !== undefined;
  if (options.consumerMismatchEscalation && !hasConsumerStatus) {
    throw new TypeError('consumerMismatchEscalation requires resolveConsumerId');
  }
  // The store can carry the escalation window on its own, and the status
  // handler honours it. Advertising only what was passed here published nothing
  // for a store-only deployment while still enforcing the store's clock, so
  // buyers aged issues against a window the capability document denied.
  // Resolve once and use the same value for enforcement and advertisement; two
  // disagreeing values are refused here rather than at the first read.
  const effectiveConsumerMismatchEscalation = assertReportingConsumerMismatchEscalation(
    reportingEffectiveConsumerMismatchEscalationV1(
      options.consumerMismatchEscalation,
      options.store,
      'createReliableReportingService'
    )
  );
  const advertisedConsumerMismatchEscalation = hasConsumerStatus ? effectiveConsumerMismatchEscalation : undefined;
  if (hasConsumerStatus) assertConsumerStatusStore(options.store);
  const retentionDays = options.statusRetentionDays;
  positiveInteger(retentionDays, 'statusRetentionDays');
  // Built here, not on the first scheduled pass: a factory that cannot serve this store or these
  // retention commitments fails service construction.
  let maintenance: ReliableReportingMaintenanceV1 | undefined;
  if (options.maintenance !== undefined) {
    if (typeof options.maintenance !== 'function') {
      throw new TypeError(
        'createReliableReportingService: `maintenance` must be a factory, not an options object. For a PostgreSQL ledger wrap ' +
          'your options with `reportingLedgerMaintenance({ ... })` from the `@adcp/reporting-storage` package, ' +
          'for example `maintenance: reportingLedgerMaintenance({ retention: { enabled: true } })`. ' +
          'See docs/migration-reporting-storage-package.md.'
      );
    }
    maintenance = options.maintenance({
      store: options.store,
      statusRetentionDays: retentionDays,
      automatedRecoveryWindowSeconds: options.automatedRecoveryWindowSeconds,
    });
    if (
      !maintenance ||
      typeof maintenance.run !== 'function' ||
      !Number.isSafeInteger(maintenance.intervalMilliseconds) ||
      maintenance.intervalMilliseconds <= 0
    ) {
      throw new TypeError(
        'maintenance factory must return { intervalMilliseconds: positive integer, run(): Promise<results> }'
      );
    }
  }
  const runLedgerMaintenance = (
    signal: AbortSignal | undefined,
    report?: (error: unknown) => Promise<void>
  ): Promise<readonly ReliableReportingMaintenanceTaskResultV1[]> =>
    maintenance!.run({ signal, ...(report ? { report } : {}) });

  if (options.subscriptions !== undefined && options.reportingSubscriptions !== undefined) {
    throw new PlatformConfigError(
      'Pass subscriptions or the deprecated reportingSubscriptions, not both. Move the block to subscriptions.',
      { configField: 'subscriptions' }
    );
  }
  const subscriptionOptions = options.subscriptions ?? options.reportingSubscriptions;
  if (subscriptionOptions !== undefined) {
    if (
      typeof subscriptionOptions.engine?.subscriptionCoverage !== 'function' ||
      typeof subscriptionOptions.engine.frozenOwedSets !== 'function'
    ) {
      throw new PlatformConfigError(
        'subscriptions requires a reporting subscription engine. Pass engine: createReportingSubscriptionEngineV1(...) from @adcp/sdk/reporting/advanced.',
        { configField: 'subscriptions.engine' }
      );
    }
    if (typeof subscriptionOptions.resolvePrincipal !== 'function') {
      throw new PlatformConfigError(
        "subscriptions requires resolvePrincipal. Pass the principal runtime's authenticated mapping.",
        { configField: 'subscriptions.resolvePrincipal' }
      );
    }
    // A seller that advertises subscriptions owes their obligations: the service writes them into
    // the ledger every cycle, so it must know whose to write.
    if (typeof subscriptionOptions.listSubscriptionPrincipals !== 'function') {
      throw new PlatformConfigError(
        'subscriptions requires listSubscriptionPrincipals. Return engine.listSubscriptionPrincipals(tenantId) across your tenants.',
        { configField: 'subscriptions.listSubscriptionPrincipals' }
      );
    }
    if (typeof subscriptionOptions.resolveSubscriptionConfiguration !== 'function') {
      throw new PlatformConfigError(
        'subscriptions requires resolveSubscriptionConfiguration. Return the metrics, dimensions and source settings for each subscription generation.',
        { configField: 'subscriptions.resolveSubscriptionConfiguration' }
      );
    }
    // Sellers advertising subscriptions MUST publish standard_dimensions on every offering
    // (adcontextprotocol/adcp#8585), so buyers resolve match from the wire as the engine does.
    for (const offering of deliveryOfferings as ReportingDeliveryOfferingWithDimensionsV1[]) {
      if (!Array.isArray(offering.standard_dimensions)) {
        throw new PlatformConfigError(
          `Reporting offering ${JSON.stringify(offering.offering_id)} must publish standard_dimensions when ` +
            'reporting subscriptions are advertised. Publish standard_dimensions (empty for totals-only) on the offering.',
          { code: 'SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS', configField: 'adapters' }
        );
      }
    }
  }
  // Without subscriptions this is exactly the pre-3.3 shape.
  const registration = subscriptionOptions
    ? reportingConfigurationCapabilitiesV1({
        subscriptions: {
          ...(subscriptionOptions.engine.settings.maxAccounts !== undefined
            ? { maxAccounts: subscriptionOptions.engine.settings.maxAccounts }
            : {}),
          backfillOnRegrant: subscriptionOptions.engine.settings.backfillOnRegrant,
          ...(subscriptionOptions.dimensions ? { dimensions: subscriptionOptions.dimensions } : {}),
        },
        ...(subscriptionOptions.accountConfigurations !== undefined
          ? { accountConfigurations: subscriptionOptions.accountConfigurations }
          : {}),
      })
    : ({ configuration_task: 'sync_accounts' } as ReturnType<typeof reportingConfigurationCapabilitiesV1>);
  if (subscriptionOptions && subscriptionOptions.engine.settings.statusRetentionDays !== options.statusRetentionDays) {
    throw new PlatformConfigError(
      'The reporting subscription engine must use the statusRetentionDays this service advertises. Pass the same statusRetentionDays to both.',
      { configField: 'statusRetentionDays' }
    );
  }
  const servesAccountConfigurations = registration.configuration_task === 'sync_accounts';

  const capabilities = deepFreeze({
    supported: true as const,
    reliable_reporting_version: '1.0' as const,
    ...registration,
    status_task: 'get_reporting_status' as const,
    ...(hasConsumerStatus ? { consumer_status_task: 'sync_reporting_status' as const } : {}),
    revision_content_task: 'get_media_buy_delivery' as const,
    offerings: deliveryOfferings as [ReportingDeliveryOffering, ...ReportingDeliveryOffering[]],
    automated_recovery_window_seconds: options.automatedRecoveryWindowSeconds,
    status_retention_days: retentionDays,
    ...(advertisedConsumerMismatchEscalation
      ? reportingConsumerStatusCapabilityV1(advertisedConsumerMismatchEscalation)
      : {}),
  }) satisfies ReportingDeliveryCapabilities;

  // Subscription generations are visible only to their owning principal. Without subscriptions
  // nothing is passed, so every handler is exactly the pre-3.3 one.
  const subscriptionScope = subscriptionOptions
    ? {
        resolveSubscriptionPrincipal: async (context: unknown) => {
          const principal = await subscriptionOptions.resolvePrincipal(context as RequestContext<Account<TCtxMeta>>);
          return { tenantId: principal.tenantId, principalId: principal.principalId };
        },
      }
    : undefined;
  const getReportingStatus = options.resolveConsumerId
    ? createReportingStatusHandler(options.store, {
        resolveConsumerId: options.resolveConsumerId,
        ...(effectiveConsumerMismatchEscalation
          ? { consumerMismatchEscalation: effectiveConsumerMismatchEscalation }
          : {}),
        ...(subscriptionScope ?? {}),
      })
    : subscriptionScope
      ? createReportingStatusHandler(options.store, subscriptionScope)
      : createReportingStatusHandler(options.store);
  const getMediaBuyDelivery = createReportingDeliveryHandler(options.store, {
    ...(options.legacyRevisionReader ? { legacyRevisionReader: options.legacyRevisionReader } : {}),
    ...(subscriptionScope ?? {}),
  });
  const syncReportingStatus = options.resolveConsumerId
    ? createSyncReportingStatusHandler(options.store as unknown as ReportingConsumerStatusLedgerStore, {
        resolveConsumerId: options.resolveConsumerId,
        ...(subscriptionScope ?? {}),
      })
    : undefined;

  const reportingPlatform: ReliableReportingPlatform<TCtxMeta> = {
    capabilities,
    getReportingStatus: subscriptionOptions
      ? async (request, context) => {
          const response = await getReportingStatus(request, context as never);
          return withReportingSubscriptionCoverageV1(response, context as never, subscriptionOptions);
        }
      : (request, context) => getReportingStatus(request, context as never),
    getMediaBuyDelivery: (request, context) => getMediaBuyDelivery(request, context as never),
    ...(syncReportingStatus && {
      syncReportingStatus: (request, context) => syncReportingStatus(request, context),
      // Published so `createAdcpServerFromPlatform` can scope replay by the
      // identity the receipt is actually recorded under, rather than by the
      // caller's credential.
      resolveConsumerId: options.resolveConsumerId!,
    }),
  };

  let schedulerAbort: AbortController | undefined;
  let schedulerPromise: Promise<void> | undefined;

  /**
   * The trusted install path shared by account configurations and subscription generations:
   * offering and delivery-offering checks, the host's source route, currency and authorized
   * coverage, and the frozen schedule identity. An owed-set (subscription) generation takes every
   * period from the engine, so it skips the grid schedule checks and never reuses a keyless
   * predecessor scope.
   */
  async function prepareGeneration(
    configuration: ReliableReportingConfigurationInputV1,
    account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>,
    ownership: 'account' | 'owed_set'
  ) {
    assertNoUntrustedLineageFields(configuration as unknown as Record<string, unknown>);
    if (Object.prototype.hasOwnProperty.call(configuration.sourceSettings, 'currency')) {
      throw new TypeError('Reporting configuration must not supply trusted lineage field sourceSettings.currency');
    }
    const frozenInput = structuredClone(configuration);
    const offering = offerings.get(configuration.offeringId);
    if (!offering) throw new TypeError('Reporting configuration selected an unknown offering');
    const deliveryOffering = deliveryOfferings.find(value => value.offering_id === offering.offeringId)!;
    validateConfigurationAgainstDeliveryOffering(frozenInput, deliveryOffering, options.automatedRecoveryWindowSeconds);
    const [route, currency, coverage] = await Promise.all([
      options.resolveSource(account, frozenInput),
      options.resolveCurrency(account, frozenInput),
      options.resolveCoverage(account, frozenInput),
    ]);
    if (!route || typeof route !== 'object' || !route.sourceScope || typeof route.sourceScope !== 'object') {
      throw new TypeError('resolveSource must return an adapter, sourceScope, and sourceTimezone');
    }
    const source = sources.get(route.adapterId);
    const adapterOffering = adapterOfferings.get(route.adapterId);
    if (!source || !adapterOffering) throw new TypeError('resolveSource selected an unknown reporting adapter');
    // The adapter's own validated offering must be the selected one — not
    // merely an offering its executor happens to expose.
    if (adapterOffering.offeringId !== offering.offeringId) {
      throw new TypeError('Resolved reporting adapter does not provide the selected offering');
    }
    if (canonicalize(adapterOffering.contract) !== canonicalize(offering.contract)) {
      throw new TypeError('Resolved reporting adapter contract differs from the selected offering');
    }
    const normalizedCurrency = trustedCurrency(currency);
    const normalizedTimezone = trustedTimezone(route.sourceTimezone);
    if (configuration.expectedCurrency !== undefined && configuration.expectedCurrency !== normalizedCurrency) {
      throw new TypeError('Trusted reporting currency conflicts with the configuration currency assertion');
    }
    if (
      configuration.expectedSourceTimezone !== undefined &&
      configuration.expectedSourceTimezone !== normalizedTimezone
    ) {
      throw new TypeError('Trusted reporting timezone conflicts with the configuration timezone assertion');
    }
    if (ownership === 'account') {
      assertSupportedScheduleSemantics(frozenInput.schedule, deliveryOffering, normalizedTimezone, offering);
    }
    const { constituents, mediaBuyIds } = trustedCoverage(coverage, frozenInput.requestedMetrics);
    if (
      configuration.expectedMediaBuyIds !== undefined &&
      !sameIdMembers(configuration.expectedMediaBuyIds, mediaBuyIds)
    ) {
      throw new TypeError('Trusted reporting coverage conflicts with the configuration media-buy assertion');
    }
    if (Object.prototype.hasOwnProperty.call(route.sourceScope, ADAPTER_SCOPE_KEY)) {
      throw new TypeError('Reporting sourceScope contains an SDK-reserved key');
    }
    const credentialPaths = scanArgsForCredentials(route.sourceScope);
    if (credentialPaths.length > 0 || containsContextMetadata(route.sourceScope)) {
      throw new TypeError('Reporting sourceScope must contain non-secret routing identifiers only');
    }
    const routedScope = ReportingSourceScopeV1Schema.parse({
      ...structuredClone(route.sourceScope),
      [ADAPTER_SCOPE_KEY]: route.adapterId,
    });
    const predecessor =
      ownership === 'account' ? await predecessorGeneration(options.store, account.id, frozenInput) : undefined;
    const sourceScope = keylessPredecessorScope(predecessor, route.sourceScope, sources.size) ?? routedScope;
    // A generation installed before the identity was stored keeps its shape,
    // or replaying it would change the semantic fingerprint.
    const scheduleIdentity =
      predecessor && predecessor.schedule.alignment === undefined
        ? {}
        : {
            periodDuration: deliveryOffering.schedule.period_duration,
            deliverySlaDuration: deliveryOffering.schedule.delivery_sla,
            alignment: deliveryOffering.schedule.alignment,
            ...(deliveryOffering.schedule.alignment === 'utc' ? {} : { periodTimezone: normalizedTimezone }),
          };
    const {
      expectedCurrency: _currency,
      expectedSourceTimezone: _timezone,
      expectedMediaBuyIds: _mediaBuyIds,
      sourceSettings,
      ...ledgerInput
    } = frozenInput;
    void _currency;
    void _timezone;
    void _mediaBuyIds;
    return {
      input: {
        ...ledgerInput,
        schedule: { ...ledgerInput.schedule, ...scheduleIdentity },
        account: { account_id: account.id },
        sourceScope,
        sourceTimezone: normalizedTimezone,
        sourceSettings: { ...sourceSettings, currency: normalizedCurrency },
        contract: structuredClone(offering.contract),
        constituents,
        mediaBuyIds,
      },
      requestedMetrics: frozenInput.requestedMetrics,
    };
  }

  /**
   * Write every frozen subscription owed set the engine holds (for the cycle's account) into the
   * ledger. Failures are isolated per subscription and returned, never thrown here.
   */
  async function planSubscriptionCycle(
    subscriptions: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>,
    accountId: string | undefined,
    now: Date,
    signal: AbortSignal | undefined
  ): Promise<{
    planned: number;
    failures: Array<{
      error: unknown;
      context: { principal: PrincipalRef; accountId?: string; subscriptionId?: string };
    }>;
  }> {
    const principals = await subscriptions.listSubscriptionPrincipals();
    if (!Array.isArray(principals)) throw new TypeError('listSubscriptionPrincipals must return an array');
    let planned = 0;
    const failures: Awaited<ReturnType<typeof planSubscriptionCycle>>['failures'] = [];
    for (const principal of principals) {
      signal?.throwIfAborted();
      const scope = { tenantId: principal.tenantId, principalId: principal.principalId };
      let sets: ReportingSubscriptionFrozenOwedSetV1[];
      try {
        sets = await subscriptions.engine.frozenOwedSets(scope, accountId !== undefined ? { accountId } : {});
      } catch (error) {
        failures.push({ error, context: { principal: scope, ...(accountId !== undefined ? { accountId } : {}) } });
        continue;
      }
      for (const set of sets) {
        if (accountId !== undefined && set.account_id !== accountId) continue;
        signal?.throwIfAborted();
        try {
          planned += await planFrozenOwedSet(subscriptions, scope, set, now);
        } catch (error) {
          failures.push({
            error,
            context: { principal: scope, accountId: set.account_id, subscriptionId: set.subscription_id },
          });
        }
      }
    }
    return { planned, failures };
  }

  async function planFrozenOwedSet(
    subscriptions: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>,
    principal: PrincipalRef,
    set: ReportingSubscriptionFrozenOwedSetV1,
    now: Date
  ): Promise<number> {
    // Only periods the engine froze, and never past this cycle's clock.
    const owedThroughMs = Math.min(Date.parse(set.through), now.getTime());
    if (!Number.isFinite(owedThroughMs)) throw new TypeError('Frozen owed set has no valid horizon');
    const account = subscriptions.resolveSubscriptionAccount
      ? await subscriptions.resolveSubscriptionAccount(set.account_id)
      : ({ id: set.account_id, ctx_metadata: {} } as Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>);
    if (account?.id !== set.account_id) {
      throw new TypeError('resolveSubscriptionAccount must return the account it was asked for');
    }
    const generations = new Map<string, Awaited<ReturnType<typeof subscriptionGeneration>>>();
    const obligations: ReportingSubscriptionLedgerObligationInputV1[] = [];
    for (const owed of set.obligations) {
      if (Date.parse(owed.period_end) > owedThroughMs) continue;
      const key = `${owed.subscription_version}\0${owed.offering_id}`;
      let generation = generations.get(key);
      if (!generation) {
        const version = set.versions.find(value => value.subscription_version === owed.subscription_version);
        if (!version) {
          throw new TypeError(`Subscription version ${owed.subscription_version} owes periods but is not retained`);
        }
        generation = await subscriptionGeneration(subscriptions, principal, account, version, owed.offering_id);
        generations.set(key, generation);
      }
      if (owed.report_definition_id !== generation.input.report_definition_id) {
        throw new TypeError('Subscription obligation names a report definition its offering does not publish');
      }
      const owedBuys = new Set(owed.media_buy_ids);
      // Each obligation freezes its own denominator: the host-authorized constituents of exactly
      // the media buys owed for that period.
      const constituents = generation.pool.filter(value => value.mediaBuyId && owedBuys.has(value.mediaBuyId));
      const covered = new Set(constituents.map(value => value.mediaBuyId));
      if (owed.media_buy_ids.some(mediaBuyId => !covered.has(mediaBuyId))) {
        throw new TypeError('resolveCoverage did not authorize every media buy the subscription owes');
      }
      if (
        constituents.length * generation.input.requestedMetrics.length >
        SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1
      ) {
        throw new TypeError('Subscription obligation exceeds the per-slice metric availability bound');
      }
      obligations.push({
        delivery_config_version: owed.subscription_version,
        offeringId: owed.offering_id,
        period: { start: owed.period_start, end: owed.period_end },
        mediaBuyIds: [...owed.media_buy_ids],
        constituents: structuredClone(constituents),
      });
    }
    const result = await producer.planSubscriptionObligations({
      account_id: set.account_id,
      principal,
      subscriptionId: set.subscription_id,
      configurations: [...generations.values()].map(value => value.input),
      bindGeneration: async configuration => {
        const generation = [...generations.values()].find(
          value =>
            value.input.delivery_config_version === configuration.delivery_config_version &&
            value.input.offeringId === configuration.offeringId
        );
        if (!generation?.managedOffering) return;
        await subscriptions.bindManagedGeneration!({
          principal,
          configuration,
          subscription: structuredClone(generation.version.configuration),
          ...(generation.version.destination_method
            ? { destinationMethod: structuredClone(generation.version.destination_method) }
            : {}),
          offering: structuredClone(generation.managedOffering),
        });
      },
      obligations,
      owedThrough: new Date(owedThroughMs).toISOString(),
      now: now.toISOString(),
    });
    return result.created.length;
  }

  /** One (version, offering) generation through the same trusted path as installConfiguration. */
  async function subscriptionGeneration(
    subscriptions: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>,
    principal: PrincipalRef,
    account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>,
    version: ReportingSubscriptionFrozenOwedSetV1['versions'][number],
    offeringId: string
  ): Promise<{
    input: ReportingSubscriptionConfigurationInputV1;
    pool: ReportingLedgerConfigurationV1['constituents'];
    /** The resolved offering when it is managed, so the generation needs a managed binding. */
    managedOffering?: ReportingDeliveryOffering;
    version: ReportingSubscriptionFrozenOwedSetV1['versions'][number];
  }> {
    const deliveryOffering = deliveryOfferings.find(value => value.offering_id === offeringId);
    const sourceOffering = offerings.get(offeringId);
    if (!deliveryOffering || !sourceOffering) {
      throw new TypeError(
        `Subscription resolved offering ${JSON.stringify(offeringId)}, which this service does not serve`
      );
    }
    // A managed offering (one with a delivery method) is delivered to the subscription's
    // destination, which only a composition that owns managed delivery can bind. Selection
    // matches the method to the version's destination, so the destination is always present.
    const managed = deliveryOffering.method !== undefined;
    if (managed && typeof subscriptions.bindManagedGeneration !== 'function') {
      throw new TypeError(
        'A managed subscription offering needs a composition that binds managed delivery, such as ' +
          'createPostgresReliableReportingProductionService from @adcp/reporting-storage/service'
      );
    }
    if (!managed && deliveryOffering.reconciliation_mode !== 'delivery_only') {
      throw new TypeError('A consumer-receipt subscription offering must be managed');
    }
    const subscription = version.configuration;
    const policy = await subscriptions.resolveSubscriptionConfiguration({
      principal,
      account,
      subscription: structuredClone(subscription),
      offering: structuredClone(deliveryOffering),
      sourceOffering: structuredClone(sourceOffering),
    });
    if (!policy || !Array.isArray(policy.requestedMetrics) || !Array.isArray(policy.requestedDimensions)) {
      throw new TypeError(
        'resolveSubscriptionConfiguration must return requested metrics, dimensions and source settings'
      );
    }
    const configuration: ReliableReportingConfigurationInputV1 = {
      delivery_config_id: subscription.subscription_id,
      delivery_config_version: version.subscription_version,
      offeringId,
      report_definition_id: deliveryOffering.report_definition_id,
      feedPurpose: subscription.selector.feed_purpose,
      requiredFinality: subscription.selector
        .required_finality as ReliableReportingConfigurationInputV1['requiredFinality'],
      ...(policy.finalityPolicy ? { finalityPolicy: structuredClone(policy.finalityPolicy) } : {}),
      ...(policy.canonicalization ? { canonicalization: structuredClone(policy.canonicalization) } : {}),
      requestedMetrics: [...policy.requestedMetrics],
      requestedDimensions: [...policy.requestedDimensions],
      // Descriptive only: an owed set takes every period from the engine. The offering is
      // authoritative for timing, so expected_at is period end plus its delivery_sla.
      schedule: {
        anchor: '1970-01-01T00:00:00.000Z',
        periodMilliseconds: reportingIsoDurationMillisecondsV1(deliveryOffering.schedule.period_duration),
        deliverySlaMilliseconds: reportingIsoDurationMillisecondsV1(deliveryOffering.schedule.delivery_sla),
        recoveryWindowMilliseconds: options.automatedRecoveryWindowSeconds * 1_000,
      },
      sourceSettings: structuredClone(policy.sourceSettings),
    };
    const { input } = await prepareGeneration(configuration, account, 'owed_set');
    const { constituents, mediaBuyIds: _mediaBuyIds, ...generation } = input;
    void _mediaBuyIds;
    return {
      input: {
        ...generation,
        subscription: {
          tenantId: principal.tenantId,
          principalId: principal.principalId,
          subscriptionId: subscription.subscription_id,
          offeringId,
          ownership: 'owed_set',
        },
      },
      pool: constituents,
      ...(managed ? { managedOffering: structuredClone(deliveryOffering) } : {}),
      version,
    };
  }

  const service: ReliableReportingServiceV1<TCtxMeta> = {
    setup: Object.freeze({
      component: 'reliable-reporting-core',
      migrations: Object.freeze([...(options.store.migrations ?? [])]),
      requiresIsolatedLedgerDatabaseAcknowledgement: true,
    }),
    capabilities,
    producer,
    platform: reportingPlatform,
    get running() {
      return schedulerPromise !== undefined;
    },

    async installConfiguration(configuration, context) {
      if (!context?.account?.id) throw new TypeError('Reporting configuration requires a framework-resolved account');
      const { input } = await prepareGeneration(configuration, context.account, 'account');
      return producer.installConfiguration(input, {
        ...(context.historyStart !== undefined ? { historyStart: context.historyStart } : {}),
      });
    },

    extendConfigurationHistory(input) {
      return producer.extendConfigurationHistory(input);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    install<TPlatform extends DecisioningPlatform<any, TCtxMeta>>(platform: TPlatform) {
      if (servesAccountConfigurations && typeof platform.accounts.upsert !== 'function') {
        throw new TypeError(
          'Reliable reporting requires accounts.upsert so the advertised sync_accounts configuration task is installed'
        );
      }
      if (platform.reporting && platform.reporting !== reportingPlatform) {
        throw new TypeError('DecisioningPlatform already has a reporting lifecycle installed');
      }
      if (!platform.reporting) {
        Object.defineProperty(platform, 'reporting', {
          value: reportingPlatform,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return platform as TPlatform & { reporting: ReliableReportingPlatform<TCtxMeta> };
    },

    async runCycle(cycle) {
      const accountId = cycleAccountId(cycle);
      const planningNow = cycle.now ?? new Date();
      cycle.signal?.throwIfAborted();
      // Subscription obligations first: the engine's frozen owed sets, never grid-filled.
      const subscriptionPlanning = subscriptionOptions
        ? await planSubscriptionCycle(subscriptionOptions, accountId, planningNow, cycle.signal)
        : undefined;
      const planned = await producer.planObligations(planningNow.toISOString(), {
        ...(accountId !== undefined ? { account_id: accountId } : {}),
        ...(cycle.maxObligations !== undefined ? { maxObligations: cycle.maxObligations } : {}),
        ...(cycle.maxHistoryObligationsPerSource !== undefined
          ? { maxHistoryObligationsPerSource: cycle.maxHistoryObligationsPerSource }
          : {}),
      });
      cycle.signal?.throwIfAborted();
      const result = await producer.runWorker({
        ...(cycle.signal ? { signal: cycle.signal } : {}),
        ...(cycle.now ? { now: () => cycle.now! } : {}),
        ...(accountId !== undefined ? { account_id: accountId } : {}),
        ...(cycle.maxWorkerIterations !== undefined ? { maxIterations: cycle.maxWorkerIterations } : {}),
        ...(cycle.maxHistorySlicesPerSource !== undefined
          ? { maxHistorySlicesPerSource: cycle.maxHistorySlicesPerSource }
          : {}),
        ...(cycle.retryDelayMilliseconds !== undefined ? { retryDelayMilliseconds: cycle.retryDelayMilliseconds } : {}),
        ...(cycle.executionDeadlineMilliseconds !== undefined
          ? { executionDeadlineMilliseconds: cycle.executionDeadlineMilliseconds }
          : {}),
        ...(cycle.settlementGraceMilliseconds !== undefined
          ? { settlementGraceMilliseconds: cycle.settlementGraceMilliseconds }
          : {}),
      });
      if (subscriptionPlanning?.failures.length) {
        if (subscriptionOptions!.onPlanningError) {
          for (const failure of subscriptionPlanning.failures) {
            await subscriptionOptions!.onPlanningError(failure.error, failure.context);
          }
        } else {
          throw new AggregateError(
            subscriptionPlanning.failures.map(failure => failure.error),
            `Reporting subscription obligations could not be written for ${subscriptionPlanning.failures.length} subscription(s)`
          );
        }
      }
      return { planned: planned.length + (subscriptionPlanning?.planned ?? 0), ...result };
    },

    async runMaintenance(maintenanceOptions) {
      if (maintenance === undefined) {
        throw new TypeError('runMaintenance requires the maintenance option');
      }
      maintenanceOptions?.signal?.throwIfAborted();
      return runLedgerMaintenance(maintenanceOptions?.signal);
    },

    start(scheduler) {
      if (schedulerPromise) throw new Error('Reliable reporting scheduler is already running');
      positiveInteger(scheduler.intervalMilliseconds, 'intervalMilliseconds');
      schedulerAbort = new AbortController();
      const signal = schedulerAbort.signal;
      const scheduledMaintenance =
        maintenance === undefined
          ? undefined
          : {
              intervalMilliseconds: maintenance.intervalMilliseconds,
              run: () =>
                runLedgerMaintenance(signal, error =>
                  reportReportingSchedulerError(scheduler, signal, error, { phase: 'maintenance' })
                ),
            };
      schedulerPromise = schedulerLoop(service, scheduler, signal, options.store, scheduledMaintenance).finally(() => {
        schedulerPromise = undefined;
        schedulerAbort = undefined;
      });
    },

    async stop() {
      const running = schedulerPromise;
      schedulerAbort?.abort();
      if (running) await running;
    },
  };

  return service;
}

function createRoutedSource(
  sources: ReadonlyMap<string, ReportingSourceWithReaderV1>,
  offerings: ReadonlyMap<string, ReportingSourceOfferingV1>
): ReportingSourceWithReaderV1 {
  const capabilities = reportingSourceCapabilitiesV1([...offerings.values()], 'reliable-reporting-service-v1');
  return {
    capabilities,
    execute(request, context): Promise<ReportingSourceExecutorResultV1> {
      return routeSource(sources, request.sourceScope).execute(request, context);
    },
    read(input) {
      return routeSource(sources, input.sourceScope).read(input);
    },
  };
}

function routeSource(
  sources: ReadonlyMap<string, ReportingSourceWithReaderV1>,
  sourceScope: Record<string, unknown>
): ReportingSourceWithReaderV1 {
  const adapterId = sourceScope[ADAPTER_SCOPE_KEY];
  const source =
    typeof adapterId === 'string'
      ? sources.get(adapterId)
      : sources.size === 1
        ? sources.values().next().value
        : undefined;
  if (!source) throw new TypeError('Reporting sourceScope has no installed adapter route');
  return source;
}

async function schedulerLoop<TCtxMeta>(
  service: ReliableReportingServiceV1<TCtxMeta>,
  options: ReliableReportingSchedulerOptionsV1,
  signal: AbortSignal,
  store: ReportingLedgerStore,
  maintenance?: { intervalMilliseconds: number; run: () => Promise<unknown> }
): Promise<void> {
  // Rotation cursor. Without it the same ledger order runs every interval, so a
  // tenant early in that order can consume the whole per-pass budget and the
  // tenants behind it never produce.
  let rotation = 0;
  let lastMaintenanceAt: number | undefined;
  while (!signal.aborted) {
    let accountIds: Array<string | undefined> = [];
    try {
      accountIds = options.deploymentWide
        ? // A single deployment-wide sweep shares one budget across every
          // tenant, so whichever account the ledger returns first can consume
          // it — the producer's own default cap starves the rest just as an
          // explicit per-account cap would. Enumerate the roster so each tenant
          // gets its own bounded cycle, and rotate the starting point each pass.
          rotateReportingRoster(await reportingDeploymentWideAccountIds(store), rotation)
        : rotateReportingRoster(
            validateAccountIds(
              typeof options.accountIds === 'function' ? await options.accountIds() : options.accountIds
            ),
            rotation
          );
    } catch (error) {
      await reportReportingSchedulerError(options, signal, error, { phase: 'roster' });
    }
    rotation += 1;
    for (const accountId of accountIds) {
      if (signal.aborted) break;
      try {
        await service.runCycle({
          ...(accountId === undefined ? { deploymentWide: true as const } : { accountId }),
          signal,
          ...(options.maxHistoryObligationsPerSource !== undefined
            ? { maxHistoryObligationsPerSource: options.maxHistoryObligationsPerSource }
            : {}),
          ...(options.maxHistorySlicesPerSource !== undefined
            ? { maxHistorySlicesPerSource: options.maxHistorySlicesPerSource }
            : {}),
          ...(options.maxObligationsPerAccount !== undefined
            ? { maxObligations: options.maxObligationsPerAccount }
            : {}),
          ...(options.maxWorkerIterationsPerAccount !== undefined
            ? { maxWorkerIterations: options.maxWorkerIterationsPerAccount }
            : {}),
          ...(options.retryDelayMilliseconds !== undefined
            ? { retryDelayMilliseconds: options.retryDelayMilliseconds }
            : {}),
          ...(options.executionDeadlineMilliseconds !== undefined
            ? { executionDeadlineMilliseconds: options.executionDeadlineMilliseconds }
            : {}),
          ...(options.settlementGraceMilliseconds !== undefined
            ? { settlementGraceMilliseconds: options.settlementGraceMilliseconds }
            : {}),
        });
      } catch (error) {
        // One tenant's cycle failure must not starve the tenants queued behind
        // it: a persistently failing account would otherwise skip every later
        // account on every interval, indefinitely.
        await reportReportingSchedulerError(options, signal, error, { phase: 'cycle', accountId });
      }
    }
    // Maintenance is paced independently of the cycle interval: it runs on the
    // first pass and then at most once per its own interval, after the tenants'
    // cycles so it never delays them.
    if (
      maintenance &&
      !signal.aborted &&
      (lastMaintenanceAt === undefined || Date.now() - lastMaintenanceAt >= maintenance.intervalMilliseconds)
    ) {
      lastMaintenanceAt = Date.now();
      try {
        await maintenance.run();
      } catch (error) {
        // A failing maintenance pass must not stop the producer loop.
        await reportReportingSchedulerError(options, signal, error, { phase: 'maintenance' });
      }
    }
    if (!signal.aborted) await reportingSchedulerDelay(options.intervalMilliseconds, signal);
  }
}

function validateAccountIds(values: readonly string[]): Array<string | undefined> {
  if (!Array.isArray(values)) {
    throw new TypeError('Reporting scheduler accountIds resolver must return an array');
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
      throw new TypeError('Reporting scheduler accountIds must contain bounded non-empty strings');
    }
    unique.add(value);
  }
  return [...unique];
}

/**
 * Resolve the account a cycle may touch, failing closed.
 *
 * `accountId: ''` is a well-typed value that would otherwise fall through the
 * old truthiness test and silently widen one tenant's cycle into a
 * deployment-wide scan. Widening the scope is only ever reachable through the
 * explicit `deploymentWide: true` opt-in.
 */
function cycleAccountId(cycle: ReliableReportingCycleOptionsV1): string | undefined {
  const requested = (cycle as { accountId?: unknown }).accountId;
  if (cycle.deploymentWide === true) {
    if (requested !== undefined) {
      throw new TypeError('Reliable reporting cycles cannot combine deploymentWide with an accountId');
    }
    return undefined;
  }
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 255) {
    throw new TypeError('Reliable reporting cycles require deploymentWide: true or a bounded non-empty accountId');
  }
  return requested;
}

/**
 * Keep pre-service configuration generations replayable.
 *
 * Generations installed through the producer directly stored `sourceScope`
 * exactly as the seller resolved it, without the reserved adapter route key.
 * Adding that key on a same-generation replay would change the semantic
 * fingerprint and surface as `Reporting configuration generation is immutable`,
 * contradicting the documented migration path. Reuse the stored keyless scope
 * when it matches the freshly resolved route; the producer still refuses the
 * install if any other semantic field moved, and a keyless generation can never
 * be created here because only an existing record is ever reused.
 */
/** The stored generation this install would replay, if any. */
async function predecessorGeneration(
  store: ReportingLedgerStore,
  accountId: string,
  configuration: Pick<ReliableReportingConfigurationInputV1, 'delivery_config_id' | 'delivery_config_version'>
): Promise<ReportingLedgerConfigurationV1 | undefined> {
  return (await store.listConfigurations(accountId)).find(
    value =>
      value.subscription === undefined &&
      value.delivery_config_id === configuration.delivery_config_id &&
      value.delivery_config_version === configuration.delivery_config_version
  );
}

function keylessPredecessorScope(
  predecessor: ReportingLedgerConfigurationV1 | undefined,
  resolvedScope: Record<string, unknown>,
  adapterCount: number
): Record<string, unknown> | undefined {
  if (!predecessor || Object.prototype.hasOwnProperty.call(predecessor.sourceScope, ADAPTER_SCOPE_KEY)) {
    return undefined;
  }
  // A keyless scope only routes through the sole-adapter fallback. Replaying
  // one into a multi-adapter deployment would hand back a configuration that
  // cannot name an adapter, so every later execute and read would fail. Refuse
  // the replay instead of succeeding into a permanently broken generation.
  if (adapterCount > 1) {
    throw new TypeError(
      'Reporting configuration generation predates the adapter route key and cannot be routed with ' +
        'multiple adapters installed; install a new generation with an explicit adapter route'
    );
  }
  if (canonicalize(predecessor.sourceScope) !== canonicalize(resolvedScope)) return undefined;
  return structuredClone(predecessor.sourceScope);
}

function validateDeliveryOffering(
  source: ReportingSourceOfferingV1,
  delivery: ReportingDeliveryOffering,
  allowManagedDelivery = false
): void {
  if (delivery.offering_id !== source.offeringId) throw new TypeError('Source and delivery offering IDs differ');
  if (delivery.report_definition_id !== source.contract.report_definition_id) {
    throw new TypeError('Source and delivery report definitions differ');
  }
  if (
    delivery.report_definition_uri !== source.contract.reportDefinitionUri ||
    delivery.report_definition_sha256 !== source.contract.reportDefinitionSha256 ||
    delivery.reporting_profile.id !== source.contract.reportingProfile ||
    delivery.reporting_profile.version !== source.contract.schemaVersion ||
    delivery.reporting_profile.schema_uri !== source.contract.schemaUri ||
    delivery.reporting_profile.schema_sha256 !== source.contract.schemaSha256 ||
    delivery.reporting_profile.schema_dialect !== source.contract.schemaDialect ||
    delivery.reporting_profile.schema_ref_policy !== source.contract.schemaRefPolicy
  ) {
    throw new TypeError('Delivery offering does not describe the source contract');
  }
  if (
    !allowManagedDelivery &&
    (delivery.method !== undefined ||
      delivery.reconciliation_mode !== 'delivery_only' ||
      delivery.feed_purpose === 'billing')
  ) {
    throw new TypeError(
      'Managed Delivery and Reconciled Billing require createPostgresReliableReportingProductionService from @adcp/reporting-storage/service'
    );
  }
  // Refused here rather than at install: capabilities are built from these
  // offerings, so accepting one whose alignment can never be installed would
  // advertise a schedule to every buyer that the service always rejects.
  if (delivery.schedule.alignment !== 'utc' && delivery.schedule.alignment !== 'source_timezone') {
    throw new TypeError(
      `ReliableReportingService cannot honor '${delivery.schedule.alignment}' period alignment; ` +
        'it generates fixed-length periods from the utc and source_timezone origins'
    );
  }
  assertOfferingScheduleShape(delivery);
  // Parse both advertised durations here. A snapshot offering advertising, say,
  // P1M is published happily and then throws `Invalid reporting duration` on
  // every install, because only the official branch parsed the SLA.
  const advertisedSla = parseAdvertisedDuration(delivery.schedule.delivery_sla, 'delivery_sla');
  parseAdvertisedDuration(delivery.schedule.period_duration, 'period_duration');
  const calendarDay =
    delivery.schedule.period_duration === 'P1D' &&
    delivery.schedule.alignment === 'source_timezone' &&
    /^PT/.test(delivery.schedule.delivery_sla);
  if (delivery.supported_finality.includes('official') && source.publicationClass !== 'AUTHORITATIVE') {
    throw new TypeError('Official delivery finality requires an authoritative source offering');
  }
  // The ledger refuses any non-official configuration against an authoritative
  // source, so advertising snapshot for one publishes a finality every install
  // rejects.
  if (source.publicationClass === 'AUTHORITATIVE' && delivery.supported_finality.includes('snapshot')) {
    throw new TypeError(
      'Authoritative source offerings cannot advertise snapshot delivery finality; the ledger installs them ' +
        'as official only'
    );
  }
  if (delivery.supported_finality.includes('official') && source.publicationClass === 'AUTHORITATIVE') {
    // `expected_at` for an official period is period end + delivery_sla, but the
    // source cannot publish before its own declared finalization moment plus the
    // availability lag it expects after it. Advertising a shorter SLA promises a
    // deadline the adapter is structurally unable to meet on any period.
    const { finalization } = source;
    const readyOffset =
      finalization.schedule.daysAfterPeriodEnd * 86_400_000 +
      localTimeOfDayMilliseconds(finalization.schedule.sourceLocalReadyTime);
    // Worst case, not expected: the SLA is a maximum the seller promises for
    // every period, so a deadline only the typical period meets is untruthful.
    const earliest = readyOffset + reportingIsoDurationMillisecondsV1(finalization.worstCaseAvailabilityLag);
    if (advertisedSla < earliest) {
      throw new TypeError(
        'Official reporting delivery SLA is shorter than the source can finalize and publish; ' +
          'the advertised deadline is unreachable for every period'
      );
    }
  }
  if (source.publicationClass === 'PROVISIONAL_SNAPSHOT') {
    // A snapshot SLA is a promise about every period too. Advertising PT0S
    // against a source whose own worst case is PT6H tells buyers data is due at
    // period close while the upstream may still be six hours from having it.
    const worstCase = reportingIsoDurationMillisecondsV1(source.cadence.worstCaseAvailabilityLag);
    if (advertisedSla < worstCase) {
      throw new TypeError(
        'Snapshot reporting delivery SLA is shorter than the source worst-case availability lag; ' +
          'the advertised deadline is unreachable for every period'
      );
    }
  }
  // Decide pinned-zone feasibility before advertising the offering. Civil
  // P1D uses the shared resolver; elapsed grids still require a stable offset.
  const pinnedTimezone =
    delivery.schedule.period_timezone_policy === 'fixed'
      ? delivery.schedule.period_timezone
      : source.sourceTimezone.ianaTimezone;
  if (pinnedTimezone && calendarDay) {
    assertReportingCalendarDaySource(
      {
        anchor: new Date(reportingCalendarDayOrigin(pinnedTimezone)).toISOString(),
        periodMilliseconds: DAY_MILLISECONDS,
        deliverySlaMilliseconds: advertisedSla,
        recoveryWindowMilliseconds: DAY_MILLISECONDS,
        periodDuration: 'P1D',
        alignment: 'source_timezone',
        periodTimezone: pinnedTimezone,
        deliverySlaDuration: delivery.schedule.delivery_sla,
      },
      pinnedTimezone,
      source,
      Date.now()
    );
  } else if (pinnedTimezone) {
    const now = Date.now();
    if (delivery.schedule.alignment === 'utc' && reportingUtcOffsetMinutesV1(pinnedTimezone, now) !== 0) {
      throw new TypeError('UTC-aligned reporting requires a source timezone whose UTC offset is zero');
    }
    // Boundaries are derived from the protocol origin, so the zone has to hold
    // one offset all the way from 1970 — not merely today. Asia/Singapore
    // (+07:30 to +08:00) and Asia/Kathmandu (+05:30 to +05:45) are rock stable
    // now, yet their 1970 grid is half an hour off local midnight, so no P1D
    // anchor is installable and the offering must not be advertised.
    //
    // That is a comparison of two instants, not a scan of the whole span:
    // Asia/Shanghai and Asia/Seoul each ran DST in the 1980s and returned to
    // the offset they had in 1970, so their grid still lands on local midnight
    // and a recent generation installs fine. Scanning from the origin refused
    // them for history no obligation will ever be generated in. Stability is
    // then checked over the same operational horizon installation uses.
    const originMs = reportingScheduleOriginV1(
      delivery.schedule.alignment === 'utc' ? 'utc' : 'source_timezone',
      pinnedTimezone
    );
    if (reportingUtcOffsetMinutesV1(pinnedTimezone, originMs) !== reportingUtcOffsetMinutesV1(pinnedTimezone, now)) {
      throw new TypeError(
        'Reporting source timezone no longer observes its schedule-origin offset; no anchor derived from the ' +
          'protocol origin can land on source-local midnight'
      );
    }
    assertConstantUtcOffset(
      pinnedTimezone,
      now - OFFSET_BACKWARD_HORIZON_DAYS * DAY_MILLISECONDS,
      now + OFFSET_FORWARD_HORIZON_DAYS * DAY_MILLISECONDS
    );
  }
  const period = reportingIsoDurationMillisecondsV1(delivery.schedule.period_duration);
  const min = reportingIsoDurationMillisecondsV1(source.windowing.minimumWindow);
  const max = reportingIsoDurationMillisecondsV1(source.windowing.maximumWindow);
  if (period < min || period > max) throw new TypeError('Delivery schedule is outside source window bounds');
  // Installation requires whole source-local days, so an advertised duration
  // such as PT25H would be published to every buyer and then rejected by every
  // install. Gate it where the capability is built, not only at install.
  if (period % 86_400_000 !== 0) {
    throw new TypeError(
      `Delivery schedule period '${delivery.schedule.period_duration}' is not a whole number of source-local ` +
        'days; the service generates period boundaries only on source-local midnight'
    );
  }
  // The offering's declared window bounds and the executor's per-request
  // ceiling are separate limits. A period inside the window but over the
  // request ceiling would install cleanly and then fail on every execution.
  const executorCeiling = source.sourceExecution.maximumWindowDaysPerRequest * 86_400_000;
  if (period > executorCeiling) {
    throw new TypeError(
      'Delivery schedule period exceeds the source executor maximumWindowDaysPerRequest; ' +
        'no single request could cover one period'
    );
  }
  if (delivery.reporting_profile.primary_keys.length === 0) {
    throw new TypeError('Delivery offering requires at least one reporting primary key');
  }
  if (delivery.reporting_profile.grain !== source.grain) {
    throw new TypeError('Delivery offering grain does not match its source offering grain');
  }
  if (
    delivery.schedule.period_timezone_policy === 'fixed' &&
    source.sourceTimezone.ianaTimezone !== undefined &&
    delivery.schedule.period_timezone !== source.sourceTimezone.ianaTimezone
  ) {
    throw new TypeError('Delivery offering pins a period timezone its source offering does not declare');
  }
  if (delivery.supported_finality.length === 0) {
    throw new TypeError('Delivery offering must advertise at least one supported finality');
  }
  if (new Set(delivery.supported_finality).size !== delivery.supported_finality.length) {
    throw new TypeError('Delivery offering supported finality values must be unique');
  }
}

function validateConfigurationAgainstDeliveryOffering(
  configuration: ReliableReportingConfigurationInputV1,
  offering: ReportingDeliveryOffering,
  automatedRecoveryWindowSeconds: number
): void {
  if (
    configuration.feedPurpose !== offering.feed_purpose ||
    configuration.report_definition_id !== offering.report_definition_id
  ) {
    throw new TypeError('Reporting configuration does not match its delivery offering');
  }
  if (!offering.supported_finality.includes(configuration.requiredFinality)) {
    throw new TypeError('Reporting configuration finality is not supported by its delivery offering');
  }
  if (
    configuration.schedule.periodMilliseconds !==
      reportingIsoDurationMillisecondsV1(offering.schedule.period_duration) ||
    configuration.schedule.deliverySlaMilliseconds !==
      reportingIsoDurationMillisecondsV1(offering.schedule.delivery_sla)
  ) {
    throw new TypeError('Reporting configuration schedule does not match its delivery offering');
  }
  // The public obligation due time always derives from `deliverySlaMilliseconds`.
  // Keep any private official/finalization cutoff aligned with the advertised
  // offering too, so source readiness cannot contradict discovery's availability
  // promise even though it never replaces protocol `expected_at`.
  if (
    configuration.schedule.officialAfterMilliseconds !== undefined &&
    configuration.schedule.officialAfterMilliseconds !== configuration.schedule.deliverySlaMilliseconds
  ) {
    throw new TypeError('Reporting official deadline must equal the advertised delivery SLA of its offering');
  }
  // `automated_recovery_window_seconds` is advertised once for the whole
  // service, and `recoveryDeadlineAt` — which drives the buyer-facing
  // consumer_status_pending signal — is computed from the configured window. A
  // configuration that undercuts the advertised value therefore marks a buyer
  // pending hours before the deadline the capability promised it. The two must
  // be the same number.
  if (configuration.schedule.recoveryWindowMilliseconds !== automatedRecoveryWindowSeconds * 1_000) {
    throw new TypeError(
      'Reporting configuration recovery window must equal the advertised automated recovery window; ' +
        'the advertised value is what buyer-facing deadlines are measured against'
    );
  }
}

/**
 * Validate the seller-resolved denominator and derive its media-buy scope.
 *
 * Deriving `mediaBuyIds` here rather than accepting it keeps the producer's
 * "media-buy scope equals the constituent denominator" invariant unreachable by
 * construction, so no buyer-named ID can ride along beside an authorized
 * constituent and reach `fetchSlice`.
 */
function trustedCoverage(
  coverage: ReliableReportingCoverageV1,
  requestedMetrics: readonly string[]
): {
  constituents: ReportingLedgerConfigurationV1['constituents'];
  mediaBuyIds: string[];
} {
  if (!coverage || typeof coverage !== 'object' || !Array.isArray(coverage.constituents)) {
    throw new TypeError('resolveCoverage must return an authorized constituent denominator');
  }
  const constituents = ReportingCoverageConstituentIdentityV1Schema.array()
    .min(1)
    .max(SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1)
    .parse(structuredClone(coverage.constituents)) as ReportingLedgerConfigurationV1['constituents'];
  // Every slice carries one metric-availability cell per constituent-metric
  // pair, and the source contract bounds that product — not the constituent
  // count alone. 501 constituents against two metrics installed cleanly and
  // then failed every execution.
  if (constituents.length * requestedMetrics.length > SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1) {
    throw new TypeError(
      'Reporting coverage exceeds the per-slice metric availability bound; reduce constituents or metrics'
    );
  }
  const constituentIds = new Set(constituents.map(value => value.constituentId));
  if (constituentIds.size !== constituents.length) {
    throw new TypeError('resolveCoverage must return unique constituent identities');
  }
  // The identity schema types each arm but does not tie the constituent's own
  // ids to the binding it carries. Contradictory lineage would be frozen into
  // the generation and every obligation, so refuse it before it is durable.
  for (const constituent of constituents) {
    const binding = constituent.productBinding as
      | { productId?: string; mediaBuyId?: string; packageId?: string }
      | undefined;
    if (!binding) continue;
    if (binding.productId !== constituent.productId) {
      throw new TypeError('resolveCoverage constituent productId contradicts its product binding');
    }
    if (constituent.constituentKind === 'media_buy' && binding.mediaBuyId !== constituent.mediaBuyId) {
      throw new TypeError('resolveCoverage constituent mediaBuyId contradicts its product binding');
    }
    if (constituent.constituentKind === 'package_item' && binding.packageId !== constituent.packageId) {
      throw new TypeError('resolveCoverage constituent packageId contradicts its product binding');
    }
  }
  const mediaBuyIds = [
    ...new Set(constituents.map(value => value.mediaBuyId).filter((value): value is string => Boolean(value))),
  ].sort();
  return { constituents, mediaBuyIds };
}

function sameIdMembers(left: readonly string[], right: readonly string[]): boolean {
  if (!Array.isArray(left)) throw new TypeError('expectedMediaBuyIds must be an array of media buy IDs');
  const expected = new Set(left);
  return expected.size === right.length && right.every(value => expected.has(value));
}

const DAY_MILLISECONDS = 86_400_000;
/**
 * Shorter than any real IANA offset era, so no offset change can hide between
 * two probes.
 */
const OFFSET_PROBE_STEP_DAYS = 10;
/** Construction-time window when no anchor exists yet. */
const OFFSET_BACKWARD_HORIZON_DAYS = 400;
/** Periods the planner will generate before this configuration is revisited. */
const OFFSET_FORWARD_HORIZON_DAYS = 400;

/**
 * Refuse a schedule the installed executor could never satisfy.
 *
 * The explicit P1D source-calendar path resolves each civil boundary and checks
 * source feasibility. Other supported schedules retain the elapsed grid
 * `anchor + n * periodMilliseconds` and its two existing constraints:
 *
 *  - **Phase.** `core/reporting-schedule.json` fixes interval zero: `utc` uses
 *    1970-01-01T00:00:00Z, `source_timezone` uses local midnight on that date
 *    in the period timezone. A compliant generation anchors on that origin, so
 *    the anchor is validated as "sits on a protocol boundary", not as "is
 *    recent" — a 1970 origin is the compliant case, not a suspect one.
 *  - **Offset stability.** The spec generates calendar durations with local
 *    civil-time arithmetic across DST; this service multiplies fixed
 *    milliseconds. The two agree only while the zone's UTC offset holds still,
 *    so a zone that moves its offset is refused rather than silently drifting
 *    to 23:00 local.
 *
 * Both checks are bounded: the phase test is arithmetic, and the offset scan
 * covers only the operational window around now, never the whole span back to
 * the origin.
 */
function assertSupportedScheduleSemantics(
  schedule: ReliableReportingConfigurationInputV1['schedule'],
  offering: ReportingDeliveryOffering,
  sourceTimezone: string,
  sourceOffering: ReportingSourceOfferingV1
): void {
  const { alignment } = offering.schedule;
  if (alignment !== 'utc' && alignment !== 'source_timezone') {
    throw new TypeError(
      `ReliableReportingService cannot honor '${alignment}' period alignment; it generates fixed-length ` +
        'periods from the utc and source_timezone origins'
    );
  }
  if (offering.schedule.period_timezone_policy === 'fixed' && offering.schedule.period_timezone !== sourceTimezone) {
    throw new TypeError('Reporting offering pins a period timezone that is not the resolved source timezone');
  }
  if (schedule.periodMilliseconds % DAY_MILLISECONDS !== 0) {
    throw new TypeError(
      'Reporting periods must be whole source-local days; a sub-day window has no source-local midnight boundary'
    );
  }
  const anchorMs = Date.parse(schedule.anchor);
  if (!Number.isFinite(anchorMs)) throw new TypeError('Reporting configuration anchor must be a valid instant');

  if (
    alignment === 'source_timezone' &&
    offering.schedule.period_duration === 'P1D' &&
    /^PT/.test(offering.schedule.delivery_sla)
  ) {
    assertReportingCalendarDaySource(
      {
        ...schedule,
        periodDuration: 'P1D',
        alignment,
        periodTimezone: sourceTimezone,
        deliverySlaDuration: offering.schedule.delivery_sla,
      },
      sourceTimezone,
      sourceOffering,
      Date.now()
    );
    return;
  }

  // A property of the alignment/zone pairing rather than of this anchor, so it
  // is reported before any phase or boundary arithmetic derived from it.
  if (alignment === 'utc' && reportingUtcOffsetMinutesV1(sourceTimezone, anchorMs) !== 0) {
    throw new TypeError('UTC-aligned reporting requires a source timezone whose UTC offset is zero');
  }

  const originMs = reportingScheduleOriginV1(alignment, sourceTimezone);
  const phase =
    (((anchorMs - originMs) % schedule.periodMilliseconds) + schedule.periodMilliseconds) % schedule.periodMilliseconds;
  if (phase !== 0) {
    throw new TypeError(
      `Reporting configuration anchor is not on a '${alignment}' period boundary; boundaries are derived from ` +
        'the protocol origin (1970-01-01 local midnight) plus whole periods'
    );
  }

  // Scan the whole span the planner can generate obligations across, from the
  // anchor through the forward horizon. A window around today would miss a zone
  // that changed and changed back: today's offset matches the anchor's, every
  // boundary the window samples is local midnight, and the periods in between
  // silently land at 01:00 local while the planner still schedules them.
  // Default ownership begins at `max(anchor, installedAt)` (producer.ts), with
  // explicit history validated separately. History the planner will not touch
  // must not refuse a configuration. Scanning from the anchor rejected
  // the protocol's own 1970 origin for any zone that ran DST decades ago —
  // Asia/Shanghai, Asia/Seoul — while the same offering accepted a recent
  // anchor, which is the same schedule. Validate the operational span instead,
  // and confirm separately that the grid the anchor sits on still lands on
  // source-local midnight today.
  const now = Date.now();
  const spanStartMs = Math.max(anchorMs, now - OFFSET_BACKWARD_HORIZON_DAYS * DAY_MILLISECONDS);
  const spanEndMs = Math.max(now, anchorMs) + OFFSET_FORWARD_HORIZON_DAYS * DAY_MILLISECONDS;
  if (reportingUtcOffsetMinutesV1(sourceTimezone, originMs) !== reportingUtcOffsetMinutesV1(sourceTimezone, now)) {
    throw new TypeError(
      'Reporting source timezone no longer observes its schedule-origin offset; no anchor derived from the ' +
        'protocol origin can land on source-local midnight'
    );
  }
  assertConstantUtcOffset(sourceTimezone, spanStartMs, spanEndMs);
  if (!reportingIsSourceLocalMidnightV1(spanStartMs === anchorMs ? anchorMs : now, sourceTimezone)) {
    // A boundary in the operational window, not merely the historical anchor.
    const ordinal = Math.ceil((spanStartMs - originMs) / schedule.periodMilliseconds);
    if (!reportingIsSourceLocalMidnightV1(originMs + ordinal * schedule.periodMilliseconds, sourceTimezone)) {
      throw new TypeError('Reporting configuration boundaries do not land on source-local midnight');
    }
  }
}

/**
 * Refuse a zone whose UTC offset moves anywhere in `[startMs, endMs]`.
 *
 * The spec generates calendar durations with local civil-time arithmetic across
 * transitions; this service multiplies fixed milliseconds. The two agree only
 * while the offset holds still, so any change in the operational span means
 * boundaries drift off source-local midnight.
 */
function assertConstantUtcOffset(timeZone: string, startMs: number, endMs: number): void {
  const baseline = reportingUtcOffsetMinutesV1(timeZone, startMs);
  for (let instant = startMs; instant < endMs; instant += OFFSET_PROBE_STEP_DAYS * DAY_MILLISECONDS) {
    if (reportingUtcOffsetMinutesV1(timeZone, instant) !== baseline) {
      throw new TypeError(
        'Reporting source timezone changes its UTC offset; fixed-length periods cannot express its local days'
      );
    }
  }
  if (reportingUtcOffsetMinutesV1(timeZone, endMs) !== baseline) {
    throw new TypeError(
      'Reporting source timezone changes its UTC offset; fixed-length periods cannot express its local days'
    );
  }
}

/**
 * Enforce the conditional field shape `core/reporting-schedule-offering.json`
 * defines per alignment. The generated Zod mirrors the property types but not
 * the `allOf`/`if` branches, so an offering can otherwise advertise a
 * `period_anchor` that the alignment forbids.
 */
function assertOfferingScheduleShape(offering: ReportingDeliveryOffering): void {
  const advertised = offering.schedule as Record<string, unknown>;
  const forbid = (fields: readonly string[]): void => {
    for (const field of fields) {
      if (advertised[field] !== undefined) {
        throw new TypeError(
          `Reporting offering advertises ${field}, which '${offering.schedule.alignment}' alignment forbids`
        );
      }
    }
  };
  if (offering.schedule.alignment === 'utc') {
    forbid(['period_anchor', 'period_anchor_policy', 'period_timezone', 'period_timezone_policy']);
    return;
  }
  forbid(['period_anchor', 'period_anchor_policy']);
  const policy = offering.schedule.period_timezone_policy;
  if (policy === undefined) {
    throw new TypeError('source_timezone reporting offerings must advertise a period_timezone_policy');
  }
  if (policy === 'fixed') {
    if (offering.schedule.period_timezone === undefined) {
      throw new TypeError('A fixed source_timezone reporting offering must advertise its period_timezone');
    }
    return;
  }
  if (offering.schedule.period_timezone !== undefined) {
    forbid(['period_timezone']);
  }
}

function parseAdvertisedDuration(value: string, field: string): number {
  try {
    return reportingIsoDurationMillisecondsV1(value);
  } catch {
    throw new TypeError(
      `Reporting offering advertises a ${field} of '${value}' that this service cannot express as a fixed ` +
        'duration; every installation would reject it'
    );
  }
}

/** `HH:MM` local wall-clock offset from that day's local midnight. */
function localTimeOfDayMilliseconds(value: string): number {
  const [hours = 0, minutes = 0] = value.split(':').map(Number);
  return hours * 3_600_000 + minutes * 60_000;
}

function trustedCurrency(value: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError('resolveCurrency must return an ISO 4217-style three-letter uppercase currency');
  }
  return value;
}

function trustedTimezone(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new TypeError('resolveSource must return a bounded IANA sourceTimezone');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new TypeError('resolveSource must return a valid IANA sourceTimezone');
  }
  return value;
}

function assertNoUntrustedLineageFields(configuration: Record<string, unknown>): void {
  for (const field of [
    'account',
    'historyStart',
    'historyStartOrdinal',
    'sourceScope',
    'sourceTimezone',
    'contract',
    'currency',
    'ctx_metadata',
    'constituents',
    'mediaBuyIds',
    'applicability',
    'products',
    'productIds',
    'subscription',
    'owedSet',
  ]) {
    if (Object.prototype.hasOwnProperty.call(configuration, field)) {
      throw new TypeError(`Reporting configuration must not supply trusted lineage field ${field}`);
    }
  }
}

function containsContextMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsContextMetadata);
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:ctx_metadata|authInfo|auth_info)$/i.test(key) || containsContextMetadata(child)) return true;
  }
  return false;
}

function assertConsumerStatusStore(store: ReportingLedgerStore): void {
  const candidate = store as unknown as Record<string, unknown>;
  for (const method of ['getRevisionMetadata', 'getConsumerStatusBatchReplay', 'syncConsumerStatusBatch']) {
    if (typeof candidate[method] !== 'function') {
      throw new TypeError(`Consumer status requires a reporting ledger store with ${method}()`);
    }
  }
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export { ReportingConfigurationImmutableError, isReportingConfigurationImmutableError } from '../ledger';
export * from './conformance';
export * from './scheduler-support';
