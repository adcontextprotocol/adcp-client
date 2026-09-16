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
    // The inline executor narrows the offering it will actually honor — most
    // importantly to `media_buy` constituent applicability. Publish and validate
    // against that narrowed view, or a `package_item` denominator installs
    // cleanly against the declared applicability and then fails every execute.
    const routedOffering = source.capabilities.offerings.find(
      candidate => candidate.offeringId === sourceOffering.offeringId
    );
    if (!routedOffering) throw new TypeError('Reporting adapter executor did not expose its own offering');
    sources.set(adapterId, source);
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
      const predecessor = await predecessorGeneration(options.store, context.account.id, frozenInput);
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
      return producer.installConfiguration({
        ...ledgerInput,
        schedule: { ...ledgerInput.schedule, ...scheduleIdentity },
        account: { account_id: context.account.id },
        sourceScope,
        sourceTimezone: normalizedTimezone,
        sourceSettings: { ...sourceSettings, currency: normalizedCurrency },
        contract: structuredClone(offering.contract),
        constituents,
        mediaBuyIds,
      });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    install<TPlatform extends DecisioningPlatform<any, TCtxMeta>>(platform: TPlatform) {
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
      return platform as TPlatform & { reporting: ReliableReportingPlatform<TCtxMeta> };
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
      schedulerPromise = schedulerLoop(service, scheduler, signal, options.store).finally(() => {
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
  store: ReportingLedgerStore
): Promise<void> {
  // Rotation cursor. Without it the same ledger order runs every interval, so a
  // tenant early in that order can consume the whole per-pass budget and the
  // tenants behind it never produce.
  let rotation = 0;
  while (!signal.aborted) {
    let accountIds: Array<string | undefined> = [];
    try {
      accountIds = options.deploymentWide
        ? // A single deployment-wide sweep shares one budget across every
          // tenant, so whichever account the ledger returns first can consume
          // it — the producer's own default cap starves the rest just as an
          // explicit per-account cap would. Enumerate the roster so each tenant
          // gets its own bounded cycle, and rotate the starting point each pass.
          rotate(await deploymentWideAccountIds(store), rotation)
        : rotate(
            validateAccountIds(
              typeof options.accountIds === 'function' ? await options.accountIds() : options.accountIds
            ),
            rotation
          );
    } catch (error) {
      await reportSchedulerError(options, signal, error);
    }
    rotation += 1;
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

/** Start each pass one tenant further along so no fixed order can starve. */
function rotate<T>(values: readonly T[], by: number): T[] {
  if (values.length < 2) return [...values];
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

/**
 * Every account the ledger currently holds a configuration for. This is the
 * roster a deployment-wide worker is authorized over, so it is also the roster
 * the per-account budgets apply to.
 */
async function deploymentWideAccountIds(store: ReportingLedgerStore): Promise<string[]> {
  const configurations = await store.listConfigurations();
  return [...new Set(configurations.map(value => value.account.account_id))].sort();
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
  // Refused here rather than at install: capabilities are built from these
  // offerings, so accepting one whose alignment can never be installed would
  // advertise a schedule to every buyer that the service always rejects.
  if (delivery.schedule.alignment !== 'utc' && delivery.schedule.alignment !== 'source_timezone') {
    throw new TypeError(
      `ReliableReportingService cannot honor '${delivery.schedule.alignment}' period alignment; ` +
        'it generates fixed-length periods from the utc and source_timezone origins'
    );
  }
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
    if (reportingIsoDurationMillisecondsV1(delivery.schedule.delivery_sla) < earliest) {
      throw new TypeError(
        'Official reporting delivery SLA is shorter than the source can finalize and publish; ' +
          'the advertised deadline is unreachable for every period'
      );
    }
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
/** Periods the planner may still backfill inside a recovery window. */
const OFFSET_BACKWARD_HORIZON_DAYS = 400;
/** Periods the planner will generate before this configuration is revisited. */
const OFFSET_FORWARD_HORIZON_DAYS = 400;

/**
 * Refuse a schedule the installed executor could never satisfy.
 *
 * `createInlineReportingSourceExecutor` requires both period boundaries to land
 * exactly on source-local midnight, and the ledger generates boundaries as
 * `anchor + n * periodMilliseconds`. Two things therefore have to hold, and the
 * spec decides both:
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
  sourceTimezone: string
): void {
  const { alignment } = offering.schedule;
  if (alignment !== 'utc' && alignment !== 'source_timezone') {
    throw new TypeError(
      `ReliableReportingService cannot honor '${alignment}' period alignment; it generates fixed-length ` +
        'periods from the utc and source_timezone origins'
    );
  }
  assertOfferingScheduleShape(offering, sourceTimezone);
  if (schedule.periodMilliseconds % DAY_MILLISECONDS !== 0) {
    throw new TypeError(
      'Reporting periods must be whole source-local days; a sub-day window has no source-local midnight boundary'
    );
  }
  const anchorMs = Date.parse(schedule.anchor);
  if (!Number.isFinite(anchorMs)) throw new TypeError('Reporting configuration anchor must be a valid instant');

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

  // Only the window the planner actually touches needs scanning. The boundary
  // check below is what catches an offset change between the origin and today.
  const now = Date.now();
  const spanStartMs = Math.max(anchorMs, now - OFFSET_BACKWARD_HORIZON_DAYS * DAY_MILLISECONDS);
  // Anchor from the later of now and the anchor itself. Ending the span at
  // `now + horizon` would put spanEnd before spanStart for a future-dated
  // generation, so the scan body would never run and a DST zone would install.
  const spanEndMs = Math.max(now, anchorMs) + OFFSET_FORWARD_HORIZON_DAYS * DAY_MILLISECONDS;
  const ordinal = Math.ceil((spanStartMs - originMs) / schedule.periodMilliseconds);
  const firstBoundaryMs = originMs + ordinal * schedule.periodMilliseconds;
  if (!reportingIsSourceLocalMidnightV1(firstBoundaryMs, sourceTimezone)) {
    throw new TypeError(
      'Reporting source timezone has changed its UTC offset since the schedule origin; the periods being ' +
        'generated now do not land on source-local midnight'
    );
  }
  const spanOffset = reportingUtcOffsetMinutesV1(sourceTimezone, spanStartMs);
  for (let instant = spanStartMs; instant < spanEndMs; instant += OFFSET_PROBE_STEP_DAYS * DAY_MILLISECONDS) {
    if (reportingUtcOffsetMinutesV1(sourceTimezone, instant) !== spanOffset) {
      throw new TypeError(
        'Reporting source timezone changes its UTC offset; fixed-length periods cannot express its local days'
      );
    }
  }
  if (reportingUtcOffsetMinutesV1(sourceTimezone, spanEndMs) !== spanOffset) {
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
function assertOfferingScheduleShape(offering: ReportingDeliveryOffering, sourceTimezone: string): void {
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
    if (offering.schedule.period_timezone !== sourceTimezone) {
      throw new TypeError('Reporting offering pins a period timezone that is not the resolved source timezone');
    }
    return;
  }
  if (offering.schedule.period_timezone !== undefined) {
    forbid(['period_timezone']);
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
