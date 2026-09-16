import type { Account } from '../../server/decisioning/account';
import type { RequestContext } from '../../server/decisioning/context';
import type { DecisioningPlatform } from '../../server/decisioning/platform';
import type { ReliableReportingPlatform } from '../../server/decisioning/specialisms/reporting';
import { scanArgsForCredentials } from '../../server/credential-policy';
import { canonicalize } from '../../utils/jcs';
import type { ReportingDeliveryCapabilities, ReportingDeliveryOffering } from '../../types/tools.generated';
import { ReportingDeliveryOfferingSchema } from '../../types/schemas.generated';
import {
  REPORTING_LEDGER_MIGRATION,
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  type CreateReportingProducerOptionsV1,
  type ReportingConsumerMismatchEscalationV1,
  type ReportingConsumerStatusLedgerStore,
  type ReportingLedgerConfigurationV1,
  type ReportingLedgerStore,
  type ReportingProducerContactV1,
  type ReportingProducerV1,
  type ReportingSourceWithReaderV1,
} from '../ledger';
import {
  ReportingCoverageConstituentIdentityV1Schema,
  SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1,
  ReportingSourceOfferingV1Schema,
  ReportingSourceScopeV1Schema,
  createInlineReportingSourceExecutor,
  reportingIsoDurationMillisecondsV1,
  reportingSourceCapabilitiesV1,
  type InlineReportingDeliveryFetchV1,
  type ReportingSourceExecutorResultV1,
  type ReportingSourceOfferingV1,
} from '../source';

const ADAPTER_SCOPE_KEY = '_adcp_reporting_adapter';

/** The intentionally small provider boundary: one bounded slice fetch plus immutable metadata. */
export interface ReliableReportingAdapterV1 {
  readonly sourceOffering: ReportingSourceOfferingV1;
  readonly deliveryOffering: ReportingDeliveryOffering;
  readonly fetchSlice: InlineReportingDeliveryFetchV1;
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
}

interface ReliableReportingSchedulerBaseOptionsV1 {
  intervalMilliseconds: number;
  maxObligationsPerAccount?: number;
  maxWorkerIterationsPerAccount?: number;
  retryDelayMilliseconds?: number;
  executionDeadlineMilliseconds?: number;
  settlementGraceMilliseconds?: number;
  onError?: (error: unknown) => void | Promise<void>;
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
}

export interface ReliableReportingSetupV1 {
  readonly component: 'reliable-reporting-core';
  readonly migrations: readonly [typeof REPORTING_LEDGER_MIGRATION];
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
  install<TConfig>(platform: DecisioningPlatform<TConfig, TCtxMeta>): DecisioningPlatform<TConfig, TCtxMeta>;
  runCycle(options: ReliableReportingCycleOptionsV1): Promise<{
    planned: number;
    claimed: number;
    revisionsCommitted: number;
    notReady: number;
    failed: number;
  }>;
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
  const adapterEntries = Object.entries(options.adapters);
  if (adapterEntries.length === 0) throw new TypeError('Reliable reporting requires at least one adapter');
  positiveInteger(options.automatedRecoveryWindowSeconds, 'automatedRecoveryWindowSeconds');

  const sources = new Map<string, ReportingSourceWithReaderV1>();
  const offerings = new Map<string, ReportingSourceOfferingV1>();
  const deliveryOfferings: ReportingDeliveryOffering[] = [];
  for (const [adapterId, adapter] of adapterEntries) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(adapterId)) throw new TypeError('Reporting adapter IDs must be bounded IDs');
    const sourceOffering = ReportingSourceOfferingV1Schema.parse(structuredClone(adapter.sourceOffering));
    const deliveryOffering = ReportingDeliveryOfferingSchema.parse(
      structuredClone(adapter.deliveryOffering)
    ) as ReportingDeliveryOffering;
    validateDeliveryOffering(sourceOffering, deliveryOffering);
    if (offerings.has(sourceOffering.offeringId)) throw new TypeError('Reporting offering IDs must be unique');
    const source = createInlineReportingSourceExecutor(adapter.fetchSlice, sourceOffering);
    sources.set(adapterId, source);
    offerings.set(sourceOffering.offeringId, sourceOffering);
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
  if (hasConsumerStatus) assertConsumerStatusStore(options.store);
  const retentionDays = options.statusRetentionDays;
  positiveInteger(retentionDays, 'statusRetentionDays');

  const capabilities = deepFreeze({
    supported: true as const,
    reliable_reporting_version: '1.0' as const,
    configuration_task: 'sync_accounts' as const,
    status_task: 'get_reporting_status' as const,
    ...(hasConsumerStatus ? { consumer_status_task: 'sync_reporting_status' as const } : {}),
    revision_content_task: 'get_media_buy_delivery' as const,
    offerings: deliveryOfferings as [ReportingDeliveryOffering, ...ReportingDeliveryOffering[]],
    automated_recovery_window_seconds: options.automatedRecoveryWindowSeconds,
    status_retention_days: retentionDays,
    ...(options.consumerMismatchEscalation
      ? {
          consumer_mismatch_escalation_seconds: options.consumerMismatchEscalation.escalationSeconds,
          operations_contact: structuredClone(options.consumerMismatchEscalation.operationsContact),
        }
      : {}),
  }) satisfies ReportingDeliveryCapabilities;

  const getReportingStatus = options.resolveConsumerId
    ? createReportingStatusHandler(options.store, {
        resolveConsumerId: options.resolveConsumerId,
        ...(options.consumerMismatchEscalation
          ? { consumerMismatchEscalation: options.consumerMismatchEscalation }
          : {}),
      })
    : createReportingStatusHandler(options.store);
  const getMediaBuyDelivery = createReportingDeliveryHandler(options.store);
  const syncReportingStatus = options.resolveConsumerId
    ? createSyncReportingStatusHandler(options.store as unknown as ReportingConsumerStatusLedgerStore, {
        resolveConsumerId: options.resolveConsumerId,
      })
    : undefined;

  const reportingPlatform: ReliableReportingPlatform<TCtxMeta> = {
    capabilities,
    getReportingStatus: (request, context) => getReportingStatus(request, context as never),
    getMediaBuyDelivery: (request, context) => getMediaBuyDelivery(request, context as never),
    ...(syncReportingStatus && {
      syncReportingStatus: (request, context) => syncReportingStatus(request, context),
    }),
  };

  let schedulerAbort: AbortController | undefined;
  let schedulerPromise: Promise<void> | undefined;

  const service: ReliableReportingServiceV1<TCtxMeta> = {
    setup: Object.freeze({
      component: 'reliable-reporting-core',
      migrations: Object.freeze([REPORTING_LEDGER_MIGRATION]) as readonly [typeof REPORTING_LEDGER_MIGRATION],
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
      assertNoUntrustedLineageFields(configuration as unknown as Record<string, unknown>);
      if (Object.prototype.hasOwnProperty.call(configuration.sourceSettings, 'currency')) {
        throw new TypeError('Reporting configuration must not supply trusted lineage field sourceSettings.currency');
      }
      const frozenInput = structuredClone(configuration);
      const offering = offerings.get(configuration.offeringId);
      if (!offering) throw new TypeError('Reporting configuration selected an unknown offering');
      const deliveryOffering = deliveryOfferings.find(value => value.offering_id === offering.offeringId)!;
      validateConfigurationAgainstDeliveryOffering(
        frozenInput,
        deliveryOffering,
        options.automatedRecoveryWindowSeconds
      );
      const [route, currency, coverage] = await Promise.all([
        options.resolveSource(context.account, frozenInput),
        options.resolveCurrency(context.account, frozenInput),
        options.resolveCoverage(context.account, frozenInput),
      ]);
      if (!route || typeof route !== 'object' || !route.sourceScope || typeof route.sourceScope !== 'object') {
        throw new TypeError('resolveSource must return an adapter, sourceScope, and sourceTimezone');
      }
      const source = sources.get(route.adapterId);
      if (!source) throw new TypeError('resolveSource selected an unknown reporting adapter');
      if (source.capabilities.offerings.every(value => value.offeringId !== offering.offeringId)) {
        throw new TypeError('Resolved reporting adapter does not provide the selected offering');
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
      assertSupportedScheduleSemantics(frozenInput.schedule, deliveryOffering, normalizedTimezone);
      const { constituents, mediaBuyIds } = trustedCoverage(coverage);
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
      const sourceScope =
        (await keylessPredecessorScope(options.store, context.account.id, frozenInput, route.sourceScope)) ??
        routedScope;
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
      return producer.installConfiguration({
        ...ledgerInput,
        account: { account_id: context.account.id },
        sourceScope,
        sourceTimezone: normalizedTimezone,
        sourceSettings: { ...sourceSettings, currency: normalizedCurrency },
        contract: structuredClone(offering.contract),
        constituents,
        mediaBuyIds,
      });
    },

    install<TConfig>(platform: DecisioningPlatform<TConfig, TCtxMeta>) {
      if (typeof platform.accounts.upsert !== 'function') {
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
      return platform;
    },

    async runCycle(cycle) {
      const accountId = cycleAccountId(cycle);
      const planningNow = cycle.now ?? new Date();
      cycle.signal?.throwIfAborted();
      const planned = await producer.planObligations(planningNow.toISOString(), {
        ...(accountId !== undefined ? { account_id: accountId } : {}),
        ...(cycle.maxObligations !== undefined ? { maxObligations: cycle.maxObligations } : {}),
      });
      cycle.signal?.throwIfAborted();
      const result = await producer.runWorker({
        ...(cycle.signal ? { signal: cycle.signal } : {}),
        ...(cycle.now ? { now: () => cycle.now! } : {}),
        ...(accountId !== undefined ? { account_id: accountId } : {}),
        ...(cycle.maxWorkerIterations !== undefined ? { maxIterations: cycle.maxWorkerIterations } : {}),
        ...(cycle.retryDelayMilliseconds !== undefined ? { retryDelayMilliseconds: cycle.retryDelayMilliseconds } : {}),
        ...(cycle.executionDeadlineMilliseconds !== undefined
          ? { executionDeadlineMilliseconds: cycle.executionDeadlineMilliseconds }
          : {}),
        ...(cycle.settlementGraceMilliseconds !== undefined
          ? { settlementGraceMilliseconds: cycle.settlementGraceMilliseconds }
          : {}),
      });
      return { planned: planned.length, ...result };
    },

    start(scheduler) {
      if (schedulerPromise) throw new Error('Reliable reporting scheduler is already running');
      positiveInteger(scheduler.intervalMilliseconds, 'intervalMilliseconds');
      schedulerAbort = new AbortController();
      const signal = schedulerAbort.signal;
      schedulerPromise = schedulerLoop(service, scheduler, signal).finally(() => {
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
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    let accountIds: Array<string | undefined> = [];
    try {
      accountIds = options.deploymentWide
        ? [undefined]
        : validateAccountIds(
            typeof options.accountIds === 'function' ? await options.accountIds() : options.accountIds
          );
    } catch (error) {
      await reportSchedulerError(options, signal, error);
    }
    for (const accountId of accountIds) {
      if (signal.aborted) break;
      try {
        await service.runCycle({
          ...(accountId === undefined ? { deploymentWide: true as const } : { accountId }),
          signal,
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
        await reportSchedulerError(options, signal, error);
      }
    }
    if (!signal.aborted) await abortableDelay(options.intervalMilliseconds, signal);
  }
}

async function reportSchedulerError(
  options: ReliableReportingSchedulerOptionsV1,
  signal: AbortSignal,
  error: unknown
): Promise<void> {
  if (signal.aborted || !options.onError) return;
  try {
    await options.onError(error);
  } catch {
    // Error observers must not terminate the reporting lifecycle.
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
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
async function keylessPredecessorScope(
  store: ReportingLedgerStore,
  accountId: string,
  configuration: Pick<ReliableReportingConfigurationInputV1, 'delivery_config_id' | 'delivery_config_version'>,
  resolvedScope: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const predecessor = (await store.listConfigurations(accountId)).find(
    value =>
      value.delivery_config_id === configuration.delivery_config_id &&
      value.delivery_config_version === configuration.delivery_config_version
  );
  if (!predecessor || Object.prototype.hasOwnProperty.call(predecessor.sourceScope, ADAPTER_SCOPE_KEY)) {
    return undefined;
  }
  if (canonicalize(predecessor.sourceScope) !== canonicalize(resolvedScope)) return undefined;
  return structuredClone(predecessor.sourceScope);
}

function validateDeliveryOffering(source: ReportingSourceOfferingV1, delivery: ReportingDeliveryOffering): void {
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
    delivery.method !== undefined ||
    delivery.reconciliation_mode !== 'delivery_only' ||
    delivery.feed_purpose === 'billing'
  ) {
    throw new TypeError('ReliableReportingService currently installs Core API delivery only');
  }
  if (delivery.supported_finality.includes('official') && source.publicationClass !== 'AUTHORITATIVE') {
    throw new TypeError('Official delivery finality requires an authoritative source offering');
  }
  const period = reportingIsoDurationMillisecondsV1(delivery.schedule.period_duration);
  const min = reportingIsoDurationMillisecondsV1(source.windowing.minimumWindow);
  const max = reportingIsoDurationMillisecondsV1(source.windowing.maximumWindow);
  if (period < min || period > max) throw new TypeError('Delivery schedule is outside source window bounds');
  if (delivery.reporting_profile.primary_keys.length === 0) {
    throw new TypeError('Delivery offering requires at least one reporting primary key');
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
  // `expected_at` derives from `officialAfterMilliseconds ?? deliverySlaMilliseconds`,
  // while discovery only ever publishes the offering's `schedule.delivery_sla`. A
  // divergent official deadline would therefore advertise an availability promise
  // the ledger never intends to meet, so the two must name one truthful value: the
  // offering SLA when the deadline is omitted, and exactly that SLA when it is set.
  if (
    configuration.schedule.officialAfterMilliseconds !== undefined &&
    configuration.schedule.officialAfterMilliseconds !== configuration.schedule.deliverySlaMilliseconds
  ) {
    throw new TypeError('Reporting official deadline must equal the advertised delivery SLA of its offering');
  }
  if (configuration.schedule.recoveryWindowMilliseconds > automatedRecoveryWindowSeconds * 1_000) {
    throw new TypeError('Reporting configuration recovery window exceeds the advertised maximum');
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
function trustedCoverage(coverage: ReliableReportingCoverageV1): {
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
  const constituentIds = new Set(constituents.map(value => value.constituentId));
  if (constituentIds.size !== constituents.length) {
    throw new TypeError('resolveCoverage must return unique constituent identities');
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
/** Long enough to straddle both transitions of any DST-observing zone. */
const OFFSET_PROBE_DAYS = 400;
const OFFSET_PROBE_STEP_DAYS = 10;

/**
 * Refuse a schedule the installed executor could never satisfy.
 *
 * `createInlineReportingSourceExecutor` requires both period boundaries to land
 * exactly on source-local midnight, and the ledger generates periods as
 * `anchor + n * periodMilliseconds`. Without this gate an offering may advertise
 * an alignment, anchor, or timezone the service cannot honor, the generation
 * installs cleanly, and every slice is then refused at execution time — an
 * outage that looks like an upstream failure rather than a configuration one.
 */
function assertSupportedScheduleSemantics(
  schedule: ReliableReportingConfigurationInputV1['schedule'],
  offering: ReportingDeliveryOffering,
  sourceTimezone: string
): void {
  const { alignment } = offering.schedule;
  if (alignment !== 'utc' && alignment !== 'source_timezone') {
    throw new TypeError(
      `ReliableReportingService cannot honor '${alignment}' period alignment; it generates fixed-length ` +
        'periods on source-local day boundaries'
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
  if (offering.schedule.period_anchor !== undefined && Date.parse(offering.schedule.period_anchor) !== anchorMs) {
    throw new TypeError('Reporting configuration anchor does not match the anchor its offering advertises');
  }
  if (!isSourceLocalMidnight(anchorMs, sourceTimezone)) {
    throw new TypeError('Reporting configuration anchor must fall on source-local midnight in the source timezone');
  }
  // A fixed-millisecond period only tracks local days in a zone whose UTC
  // offset never moves. Under DST `anchor + n * 24h` lands at 23:00 or 01:00
  // local, so every period after the transition is refused at execution time.
  const anchorOffset = utcOffsetMinutes(sourceTimezone, anchorMs);
  for (let day = OFFSET_PROBE_STEP_DAYS; day <= OFFSET_PROBE_DAYS; day += OFFSET_PROBE_STEP_DAYS) {
    if (utcOffsetMinutes(sourceTimezone, anchorMs + day * DAY_MILLISECONDS) !== anchorOffset) {
      throw new TypeError(
        'Reporting source timezone changes its UTC offset; fixed-length periods cannot express its local days'
      );
    }
  }
  if (alignment === 'utc' && anchorOffset !== 0) {
    throw new TypeError('UTC-aligned reporting requires a source timezone whose UTC offset is zero');
  }
}

function isSourceLocalMidnight(instantMs: number, timeZone: string): boolean {
  if (instantMs % 1_000 !== 0) return false;
  const parts = localParts(timeZone, instantMs);
  return parts.hour === 0 && parts.minute === 0 && parts.second === 0;
}

function utcOffsetMinutes(timeZone: string, instantMs: number): number {
  const parts = localParts(timeZone, instantMs);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - (instantMs - (instantMs % 1_000))) / 60_000);
}

function localParts(
  timeZone: string,
  instantMs: number
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value);
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
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
    'sourceScope',
    'sourceTimezone',
    'contract',
    'currency',
    'ctx_metadata',
    'constituents',
    'mediaBuyIds',
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

export * from './conformance';
