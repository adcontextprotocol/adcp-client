/**
 * The managed reporting-subscription path (experimental `media_buy.reporting_subscriptions`, AdCP
 * 3.3): a `subscriptions` block on `createReliableReportingService` whose presence enables the
 * feature. The service builds the coverage engine, installs the `reporting_subscriptions` section on
 * the principal runtime, advertises the principal capability, reconciles on writes and sweeps
 * period boundaries in `runCycle`. Every host input is an optional override of something the
 * service derives.
 *
 * Internal to the service: `SubscriptionOptions` is published from `@adcp/sdk/reporting/service`.
 */
import { createHash } from 'node:crypto';

import { PlatformConfigError } from '../../server/decisioning/runtime/validate-platform';
import type { Account } from '../../server/decisioning/account';
import type { RequestContext } from '../../server/decisioning/context';
import {
  createPrincipalLifecycle,
  type CreatePrincipalLifecycleOptions,
  type PrincipalLifecycleRuntime,
} from '../../server/principal/runtime';
import type { ReportingStorage } from '../../storage';
import type {
  PrincipalLifecycleRuntimeSubscriptions,
  PrincipalRef,
  PrincipalReportingSubscriptionSupport,
} from '../../server/principal/types';
import type { ReportingDeliveryOffering } from '../../types/tools.generated';
import type { ReportingLedgerStore } from '../ledger/types';
import { canonicalJsonV1 } from '../source/manifest';
import { reportingIsoDurationMillisecondsV1 } from '../source/source';
import { createReportingPeriodCalendarV1 } from '../subscriptions/calendar';
import {
  createInMemoryReportingSubscriptionEngineStoreV1,
  createReportingSubscriptionEngineV1,
  type ReportingSubscriptionAccountConfigV1,
  type ReportingSubscriptionAccountFactV1,
  type ReportingSubscriptionEngineStoreV1,
  type ReportingSubscriptionEngineV1,
} from '../subscriptions/engine';
import type { OwedSubscriptionPeriodV1, ReportingSubscriptionBuyV1 } from '../subscriptions/coverage';
import type {
  ReliableReportingSubscriptionBindingInputV1,
  ReliableReportingSubscriptionGenerationContextV1,
  ReliableReportingSubscriptionPolicyV1,
  ReliableReportingSubscriptionsOptionsV1,
} from './subscriptions';

type MaybePromise<T> = T | Promise<T>;

/** A page of the accounts a principal may read now. */
export interface SubscriptionAccountsPage {
  accounts: ReportingSubscriptionAccountFactV1[];
  nextCursor?: string;
}

/** One planning or reconcile failure, recorded instead of rejecting the whole cycle. */
export interface SubscriptionPlanningFailure {
  principal: PrincipalRef;
  accountId?: string;
  subscriptionId?: string;
  error: unknown;
}

/**
 * Serve `media_buy.reporting_subscriptions` from the Reliable Reporting service. The block's
 * presence enables the feature; `maxAccounts` and `backfillOnRegrant` are advertised as
 * `subscriptions.max_accounts` and `subscriptions.backfill_on_regrant`.
 *
 * Every other field is an optional override of something the service derives:
 *
 * - `accounts(principal, { cursor })`: the roster, instead of the platform's `accounts.list` read
 *   under the principal's identity. Required when account access depends on a live upstream token.
 * - `buys(principal, accountId)`: an account's buys, instead of the platform's `getMediaBuys`.
 * - `buyOfferings(mediaBuy)`: each package's offering ids, keyed by `package_id`. Without it the
 *   package's own `reporting_delivery_offering_ids` snapshot from `get_media_buys` is used
 *   (adcp#8618), and a package without one is reported by every offering the service registered.
 * - `accountDeliveryConfigs(principal, accountId)`: the caller's own active `sync_accounts`
 *   configurations, so they take precedence and their ids never clash with a `subscription_id`.
 * - `endAccountConfigs(principal, accountId, ids, { at })`: ends them for `replace_account_configs`
 *   (needs `accountDeliveryConfigs`). Without it the flag is refused with `UNSUPPORTED_FEATURE`.
 * - `isPeriodDelivered(principal, period)`: whether an owed period was delivered, for
 *   `withheld_period_count`. By default the service's own ledger answers: a period is delivered when
 *   its obligation has a committed revision.
 * - `configure(generation)`: the report content for a subscription generation. By default it is
 *   derived from the resolved source offering (see {@link defaultSubscriptionConfiguration}).
 * - `resolvePrincipal(ctx)`: the authenticated principal. By default the request's
 *   `callerMutationScope`.
 *
 * `reconcileOnWrite` (default on) reconciles a principal after a `sync_principal` write that
 * submitted `reporting_subscriptions`; the boundary sweep in `runCycle` catches anything it misses.
 * The sweep reconciles a principal only when it is due: a period boundary of one of its schedules
 * passed since its last reconcile, its last reconcile failed, or `maxSweepIntervalMilliseconds`
 * elapsed. A write or a pushed grant change makes it due again.
 *
 * With the service's `storage`, the engine state lives in `storage.subscriptions` and the service
 * builds the principal runtime over `storage.principals` from `principal`, so `principals` and
 * `stateStore` are both optional; serve it with `protocol: service.principals.protocol`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3). See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface SubscriptionOptions<TCtxMeta = Record<string, unknown>> {
  /**
   * The server's principal runtime, created with `createPrincipalLifecycle` and without
   * `reportingSubscriptions`: the service installs that section on it. Optional when the service has
   * `storage`: pass `principal` instead and the service builds the runtime over `storage.principals`.
   */
  principals?: PrincipalLifecycleRuntime & PrincipalLifecycleRuntimeSubscriptions;
  /**
   * With the service's `storage` and without `principals`: the principal runtime's options, minus the
   * store (`storage.principals`) and the `reportingSubscriptions` section (the service installs it).
   * The built runtime is `service.principals`; serve it with `protocol: service.principals.protocol`.
   */
  principal?: Omit<CreatePrincipalLifecycleOptions<Account<TCtxMeta>>, 'store' | 'reportingSubscriptions'>;
  /**
   * Engine state. Defaults to the service's `storage.subscriptions`, else process memory, which is
   * refused outside `NODE_ENV=test|development`.
   */
  stateStore?: ReportingSubscriptionEngineStoreV1;
  /**
   * Tenants whose principals each cycle plans. Defaults to every tenant a principal was resolved
   * in, recorded in the engine state store.
   */
  tenants?: readonly string[] | (() => MaybePromise<readonly string[]>);
  /** Advertised as `subscriptions.max_accounts`. */
  maxAccounts?: number;
  /** Advertised as `subscriptions.backfill_on_regrant`. Defaults to false. */
  backfillOnRegrant?: boolean;
  /** Standard dimensions the seller maps its report definitions onto (`subscriptions.dimensions`). */
  dimensions?: readonly string[];
  /** Most subscriptions per principal. Defaults to 64. */
  maxSubscriptions?: number;
  accounts?(
    principal: PrincipalRef,
    options: { cursor?: string; signal?: AbortSignal }
  ): MaybePromise<SubscriptionAccountsPage>;
  buys?(
    principal: PrincipalRef,
    accountId: string,
    options: { signal?: AbortSignal }
  ): MaybePromise<ReportingSubscriptionBuyV1[]>;
  buyOfferings?(mediaBuy: Readonly<Record<string, unknown>>): Readonly<Record<string, readonly string[]>>;
  /**
   * The report content for a subscription generation: requested metrics and dimensions, source
   * settings, and the finality policy or canonicalization an official or billing subscription needs.
   * Optional: without it the content is derived from the resolved source offering
   * ({@link defaultSubscriptionConfiguration}). Supply it for billing feeds, which need a
   * canonicalization, or to choose metrics, dimensions or attribution settings yourself.
   */
  configure?(
    generation: ReliableReportingSubscriptionGenerationContextV1<TCtxMeta>
  ): MaybePromise<ReliableReportingSubscriptionPolicyV1>;
  accountDeliveryConfigs?(
    principal: PrincipalRef,
    accountId: string
  ): MaybePromise<ReportingSubscriptionAccountConfigV1[]>;
  endAccountConfigs?(
    principal: PrincipalRef,
    accountId: string,
    deliveryConfigIds: readonly string[],
    options: { at: string }
  ): MaybePromise<void>;
  isPeriodDelivered?(principal: PrincipalRef, period: OwedSubscriptionPeriodV1): MaybePromise<boolean>;
  resolvePrincipal?(ctx: RequestContext<Account<TCtxMeta>>): MaybePromise<PrincipalRef>;
  /** Reconcile a principal after a write that submitted `reporting_subscriptions`. Defaults to true. */
  reconcileOnWrite?: boolean;
  /**
   * The longest the boundary sweep leaves a subscribed principal unreconciled, so grant and buy
   * changes the platform never pushes are still seen. Defaults to one hour.
   */
  maxSweepIntervalMilliseconds?: number;
  /** Bounds each read of the platform's `accounts.list` and `getMediaBuys`. Defaults to 30 seconds. */
  readTimeoutMilliseconds?: number;
  /** Keep serving `sync_accounts` `reporting_delivery_configs` (`configuration_tasks`). Defaults to true. */
  accountConfiguration?: boolean;
  /** Supplied by a composition that owns managed delivery, such as the production service. */
  bindManagedGeneration?(input: ReliableReportingSubscriptionBindingInputV1): Promise<void>;
  /** Called for each planning or reconcile failure. Failures are also returned by `runCycle`. */
  planningErrorHandler?(failure: SubscriptionPlanningFailure): MaybePromise<void>;
  /** Test clock. */
  now?: () => Date;
}

/** Whether a `subscriptions` block is the managed shape rather than the advanced engine shape. */
export function isManagedSubscriptionOptions<TCtxMeta>(
  value: SubscriptionOptions<TCtxMeta> | ReliableReportingSubscriptionsOptionsV1<TCtxMeta>
): value is SubscriptionOptions<TCtxMeta> {
  return !('engine' in value) || (value as { engine?: unknown }).engine === undefined;
}

/** The pieces of an installed platform the managed path reads. */
interface PlatformReads {
  accounts?: {
    list?(request: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<unknown>;
    resolve?(ref: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<unknown>;
  };
  sales?: { getMediaBuys?(request: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> };
  capabilities?: Record<string, unknown>;
}

const TENANT_INDEX: PrincipalRef = { tenantId: '@adcp-reporting-subscriptions', principalId: '@tenants' };
const TENANT_KEY = 'tenants';
const BINDING_KEY = 'binding';
/** When the boundary sweep next reconciles the principal (`{ due_at }`, epoch milliseconds). */
const SWEEP_KEY = 'sweep';
const MAX_PAGES = 1_000;
/** The authInfo fields a service-context read restores: identity only, never secrets. */
const SNAPSHOT_AUTH_FIELDS: ReadonlySet<string> = new Set(['clientId', 'scopes', 'resource', 'expiresAt']);
const ALL_BUY_STATUSES = ['pending_activation', 'active', 'paused', 'completed', 'canceled', 'rejected'];

/** The managed block, resolved into the engine and the advanced options the service runs. */
export interface ManagedReportingSubscriptions<TCtxMeta> {
  readonly engine: ReportingSubscriptionEngineV1;
  /** The principal runtime the section is installed on: the one passed, or the one built over storage. */
  readonly principals: PrincipalLifecycleRuntime & PrincipalLifecycleRuntimeSubscriptions;
  readonly advanced: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>;
  /** Called by `service.install(platform)`: the platform the roster and buys are read from. */
  bindPlatform(platform: unknown): void;
  /** The boundary sweep `runCycle` runs before planning. */
  sweep(signal?: AbortSignal): Promise<SubscriptionPlanningFailure[]>;
  report(failure: SubscriptionPlanningFailure): Promise<void>;
  /** Push grant changes into the grant journal: `service.grants`. */
  readonly grants: SubscriptionGrants;
  /**
   * Serve the journal's `authorized_at` and `regranted_at` (adcp#8618) on accounts a caller is shown
   * (`list_accounts`, `sync_accounts`). Only callers holding subscriptions are touched; never fails
   * the read.
   */
  projectAccounts<T>(items: T[], ctx: unknown): Promise<T[]>;
}

/**
 * Push grant changes into the grant journal, for sellers whose entitlement service emits events:
 * a pushed change is dated exactly, where a listing can only observe it. Later listings must
 * agree with what was pushed.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface SubscriptionGrants {
  /**
   * Record that a principal's grant on an account changed at `at`. `authorized: false` is a
   * revocation: no access at all from `at`. `allowedTasks` is the new grant's task list (absent
   * restricts no task); a grant without `get_reporting_status` ends coverage like a revocation, and
   * `windDownGrant()`'s tasks keep it. A re-grant inside `status_retention_days` continues the
   * chain, so the `authorized_at` served on `list_accounts` does not move.
   */
  changed(input: {
    principal: PrincipalRef;
    accountId: string;
    at: string;
    authorized: boolean;
    allowedTasks?: readonly string[];
    timezone?: string;
    operator?: string;
  }): Promise<void>;
}

function managedPrincipals<TCtxMeta>(
  options: SubscriptionOptions<TCtxMeta>,
  storage: ReportingStorage | undefined
): PrincipalLifecycleRuntime & PrincipalLifecycleRuntimeSubscriptions {
  if (options.principals !== undefined && options.principal !== undefined) {
    throw new PlatformConfigError(
      'Pass subscriptions.principals or subscriptions.principal, not both. principal builds the runtime over storage.principals.',
      { configField: 'subscriptions.principal' }
    );
  }
  if (options.principal !== undefined) {
    if (!storage) {
      throw new PlatformConfigError(
        "subscriptions.principal builds the principal runtime over the service's storage. Pass storage: memoryStorage() or postgresStorage({ pool }), or pass subscriptions.principals.",
        { configField: 'storage' }
      );
    }
    return createPrincipalLifecycle({ ...options.principal, store: storage.principals }) as PrincipalLifecycleRuntime &
      PrincipalLifecycleRuntimeSubscriptions;
  }
  const principals = options.principals;
  if (typeof principals?.installReportingSubscriptions !== 'function' || !principals.listReportingSubscriptions) {
    throw new PlatformConfigError(
      storage
        ? 'subscriptions needs the principal runtime. Pass principal: { agentUrl, notifications, resolvePrincipal } to build it over storage.principals, or principals: the runtime your server serves get_principal and sync_principal with.'
        : 'subscriptions.principals must be a principal runtime from createPrincipalLifecycle. Pass the runtime your server serves get_principal and sync_principal with, or give the service storage and pass subscriptions.principal.',
      { configField: 'subscriptions.principals' }
    );
  }
  return principals;
}

export function createManagedReportingSubscriptions<TCtxMeta>(
  options: SubscriptionOptions<TCtxMeta>,
  service: {
    offerings: readonly ReportingDeliveryOffering[];
    statusRetentionDays: number;
    storage?: ReportingStorage;
    /** The service's ledger: the default `isPeriodDelivered` reads it. */
    ledger?: Pick<ReportingLedgerStore, 'listObligations' | 'listRevisions' | 'listRevisionMetadata'>;
  }
): ManagedReportingSubscriptions<TCtxMeta> {
  const principals = managedPrincipals(options, service.storage);
  if (options.configure !== undefined && typeof options.configure !== 'function') {
    throw new PlatformConfigError(
      'subscriptions.configure must be a function returning the metrics, dimensions and source settings for a subscription generation. Omit it to derive them from the source offering.',
      { configField: 'subscriptions.configure' }
    );
  }
  const maxSweepInterval = options.maxSweepIntervalMilliseconds ?? 3_600_000;
  if (!Number.isSafeInteger(maxSweepInterval) || maxSweepInterval < 1) {
    throw new PlatformConfigError('subscriptions.maxSweepIntervalMilliseconds must be a positive integer.', {
      configField: 'subscriptions.maxSweepIntervalMilliseconds',
    });
  }
  if (options.endAccountConfigs && !options.accountDeliveryConfigs) {
    throw new PlatformConfigError(
      'subscriptions.endAccountConfigs needs accountDeliveryConfigs, which names the configurations replace_account_configs ends.',
      { configField: 'subscriptions.endAccountConfigs' }
    );
  }
  const readTimeout = options.readTimeoutMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(readTimeout) || readTimeout < 1) {
    throw new PlatformConfigError('subscriptions.readTimeoutMilliseconds must be a positive integer.', {
      configField: 'subscriptions.readTimeoutMilliseconds',
    });
  }
  const store =
    options.stateStore ?? service.storage?.subscriptions ?? createInMemoryReportingSubscriptionEngineStoreV1();
  const now = options.now ?? (() => new Date());
  let platform: PlatformReads | undefined;

  async function withTimeout<T>(task: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${task} did not answer within subscriptions.readTimeoutMilliseconds`)),
            readTimeout
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function binding(principal: PrincipalRef): Promise<Record<string, unknown> | undefined> {
    return (await store.get(principal, BINDING_KEY))?.value as Record<string, unknown> | undefined;
  }

  /** A request context for reads made on the principal's behalf outside a request; never a token. */
  async function serviceContext(principal: PrincipalRef): Promise<Record<string, unknown>> {
    const auth = (await binding(principal))?.authInfo as Record<string, unknown> | undefined;
    return {
      ...(auth ? { authInfo: Object.freeze({ ...auth }) } : {}),
      callerMutationScope: Object.freeze({ tenant_id: principal.tenantId, principal_id: principal.principalId }),
      reportingServiceContext: true,
    };
  }

  function rosterUnavailable(principal: PrincipalRef, cause: string): PlatformConfigError {
    return new PlatformConfigError(
      `The account roster for principal ${JSON.stringify(principal.principalId)} could not be read (${cause}). ` +
        'Supply subscriptions.accounts when account access depends on a live upstream credential.',
      { code: 'SUBSCRIPTION_ROSTER_UNAVAILABLE', configField: 'subscriptions.accounts' }
    );
  }

  async function platformAccounts(
    principal: PrincipalRef,
    cursor: string | undefined,
    signal?: AbortSignal
  ): Promise<SubscriptionAccountsPage> {
    signal?.throwIfAborted();
    const list = platform?.accounts?.list;
    if (!list) throw rosterUnavailable(principal, 'the platform has no accounts.list');
    let page: { items?: unknown[]; nextCursor?: string };
    try {
      page = (await withTimeout(
        'accounts.list',
        list.call(platform!.accounts, cursor ? { pagination: { cursor } } : {}, await serviceContext(principal))
      )) as typeof page;
    } catch (error) {
      throw rosterUnavailable(principal, error instanceof Error ? error.message : String(error));
    }
    // The grant journal is the one source of authorized_at: observe every listed grant first.
    const served = await engine.observeGrants(
      principal,
      (page?.items ?? []).flatMap(raw => {
        const account = raw as Record<string, unknown>;
        const accountId = typeof account.id === 'string' ? account.id : (account.account_id as string | undefined);
        const authorization = account.authorization as
          | { allowed_tasks?: string[]; authorized_at?: string; regranted_at?: string }
          | undefined;
        return accountId
          ? [
              {
                account_id: accountId,
                ...(authorization?.authorized_at ? { authorized_at: authorization.authorized_at } : {}),
                ...(authorization?.regranted_at ? { regranted_at: authorization.regranted_at } : {}),
                ...(authorization?.allowed_tasks ? { allowed_tasks: authorization.allowed_tasks } : {}),
              },
            ]
          : [];
      })
    );
    const accounts: ReportingSubscriptionAccountFactV1[] = [];
    for (const raw of page?.items ?? []) {
      const account = raw as Record<string, unknown>;
      const accountId = typeof account.id === 'string' ? account.id : (account.account_id as string | undefined);
      if (!accountId) continue;
      const authorization = account.authorization as { allowed_tasks?: string[]; authorized_at?: string } | undefined;
      const grant = served.get(accountId);
      accounts.push({
        account_id: accountId,
        authorized_at: grant?.authorized_at ?? authorization?.authorized_at ?? now().toISOString(),
        // adcp#8618: the journal's re-grant instant is the wire's authorization.regranted_at.
        ...(grant?.regranted_at !== undefined ? { regranted_at: grant.regranted_at } : {}),
        ...(typeof account.timezone === 'string' ? { timezone: account.timezone } : {}),
        ...(typeof account.operator === 'string' ? { operator: account.operator } : {}),
        ...(authorization?.allowed_tasks ? { allowed_tasks: [...authorization.allowed_tasks] } : {}),
      });
    }
    return { accounts, ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  function toBuy(raw: Record<string, unknown>): ReportingSubscriptionBuyV1 | undefined {
    if (typeof raw.start_time !== 'string' || typeof raw.end_time !== 'string') return undefined;
    const cancellation = (raw.cancellation ?? {}) as { canceled_at?: string };
    const every = service.offerings.map(item => item.offering_id);
    // adcp#8618: get_media_buys carries each package's offering snapshot, fixed at confirmation.
    const byPackage = options.buyOfferings
      ? options.buyOfferings(raw)
      : Object.fromEntries(
          (
            (raw.packages as Array<{ package_id?: string; reporting_delivery_offering_ids?: unknown }> | undefined) ??
            []
          )
            .filter(item => typeof item.package_id === 'string')
            .map(item => [
              item.package_id!,
              Array.isArray(item.reporting_delivery_offering_ids)
                ? (item.reporting_delivery_offering_ids as string[])
                : every,
            ])
        );
    const history = Array.isArray(raw.flight_history)
      ? (raw.flight_history as Array<Record<string, unknown>>).filter(
          entry =>
            typeof entry.recorded_at === 'string' &&
            typeof entry.start_time === 'string' &&
            typeof entry.stop_time === 'string'
        )
      : [];
    return {
      media_buy_id: String(raw.media_buy_id),
      confirmed_at: (raw.confirmed_at as string | null | undefined) ?? null,
      start_time: raw.start_time,
      end_time: raw.end_time,
      ...(cancellation.canceled_at ? { canceled_at: cancellation.canceled_at } : {}),
      // adcp#8617: the delivery stop under a cancellation, which ends the flight.
      ...(typeof raw.cancellation_effective_at === 'string'
        ? { cancellation_effective_at: raw.cancellation_effective_at }
        : {}),
      ...(typeof raw.completed_at === 'string' ? { completed_at: raw.completed_at } : {}),
      // adcp#8618: the buy's retroactive flight edits.
      ...(history.length > 0
        ? {
            flight_history: history.map(entry => ({
              recorded_at: entry.recorded_at as string,
              start_time: entry.start_time as string,
              stop_time: entry.stop_time as string,
            })),
          }
        : {}),
      packages: Object.entries(byPackage)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([package_id, ids]) => ({ package_id, reporting_delivery_offering_ids: [...ids] })),
    };
  }

  async function platformBuys(
    principal: PrincipalRef,
    accountId: string,
    signal?: AbortSignal
  ): Promise<ReportingSubscriptionBuyV1[]> {
    signal?.throwIfAborted();
    const getMediaBuys = platform?.sales?.getMediaBuys;
    if (!getMediaBuys) {
      throw new PlatformConfigError(
        'Reporting subscriptions derive buys from the platform getMediaBuys, which it does not implement. Supply subscriptions.buys.',
        { configField: 'subscriptions.buys' }
      );
    }
    const base = await serviceContext(principal);
    const account = platform?.accounts?.resolve
      ? await withTimeout('accounts.resolve', platform.accounts.resolve({ account_id: accountId }, base))
      : { id: accountId };
    const ctx = { ...base, account: account ?? { id: accountId } };
    const buys: ReportingSubscriptionBuyV1[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      signal?.throwIfAborted();
      const response = (await withTimeout(
        'getMediaBuys',
        getMediaBuys.call(
          platform!.sales,
          {
            account: { account_id: accountId },
            status_filter: ALL_BUY_STATUSES,
            ...(cursor ? { pagination: { cursor } } : {}),
          },
          ctx
        )
      )) as { media_buys?: Array<Record<string, unknown>>; pagination?: { cursor?: string; has_more?: boolean } };
      for (const raw of response?.media_buys ?? []) {
        const buy = toBuy(raw);
        if (buy) buys.push(buy);
      }
      cursor = response?.pagination?.has_more ? response.pagination.cursor : undefined;
      if (!cursor) return buys;
    }
    throw new Error(`getMediaBuys for account ${JSON.stringify(accountId)} did not finish paging`);
  }

  // One ledger read per account serves every period the engine asks about in the same tick.
  const obligationReads = new Map<string, Promise<Awaited<ReturnType<ReportingLedgerStore['listObligations']>>>>();
  /** The default `isPeriodDelivered`: the period's obligation in the service's ledger has a revision. */
  async function ledgerDelivered(principal: PrincipalRef, period: OwedSubscriptionPeriodV1): Promise<boolean> {
    const ledger = service.ledger;
    if (!ledger) return false;
    let read = obligationReads.get(period.account_id);
    if (!read) {
      read = ledger.listObligations(period.account_id);
      obligationReads.set(period.account_id, read);
      read.then(
        () => setImmediate(() => obligationReads.delete(period.account_id)),
        () => obligationReads.delete(period.account_id)
      );
    }
    const start = Date.parse(period.period_start);
    const end = Date.parse(period.period_end);
    for (const obligation of await read) {
      const owner = obligation.subscription;
      if (
        owner?.tenantId !== principal.tenantId ||
        owner.principalId !== principal.principalId ||
        owner.subscriptionId !== period.subscription_id ||
        owner.offeringId !== period.offering_id ||
        obligation.delivery_config_version !== period.subscription_version ||
        Date.parse(obligation.period.start) !== start ||
        Date.parse(obligation.period.end) !== end ||
        !obligation.mediaBuyIds.includes(period.media_buy_id)
      ) {
        continue;
      }
      // Existence only: read metadata when the store can, never the revision rows.
      const revisions = ledger.listRevisionMetadata
        ? await ledger.listRevisionMetadata(obligation.reporting_obligation_id, period.account_id)
        : await ledger.listRevisions(obligation.reporting_obligation_id);
      if (revisions.length > 0) return true;
    }
    return false;
  }

  /**
   * When the sweep next needs this principal: the first boundary after `at` of any schedule its
   * accounts use, capped by `maxSweepIntervalMilliseconds`. A schedule whose zone is not known here
   * (`source_timezone`, `billing_cycle`) is left to the cap.
   */
  async function nextDue(principal: PrincipalRef, at: number): Promise<number> {
    let due = at + maxSweepInterval;
    const zones = new Set<string>();
    try {
      const state = await engine.inspect(principal);
      for (const document of Object.values(state.accounts)) {
        if (document.account.timezone) zones.add(document.account.timezone);
      }
    } catch {
      return due;
    }
    for (const offering of service.offerings) {
      const { alignment, period_duration } = offering.schedule as { alignment: string; period_duration: string };
      const timezones = alignment === 'utc' ? ['UTC'] : alignment === 'account_timezone' ? [...zones] : [];
      for (const timezone of timezones) {
        try {
          const calendar = createReportingPeriodCalendarV1({
            period_duration,
            alignment: alignment as 'utc' | 'account_timezone',
            ...(alignment === 'utc' ? {} : { timezone }),
          });
          due = Math.min(due, calendar.next(at));
        } catch {
          // An offering this calendar cannot evaluate is left to the cap.
        }
      }
    }
    return due;
  }

  async function markDue(principal: PrincipalRef, dueAt: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.get(principal, SWEEP_KEY);
      const result = await store.put(principal, SWEEP_KEY, { due_at: dueAt }, current?.revision ?? null);
      if (result.outcome === 'applied') return;
    }
  }

  async function isDue(principal: PrincipalRef, at: number): Promise<boolean> {
    try {
      const dueAt = (await store.get(principal, SWEEP_KEY))?.value?.due_at;
      return typeof dueAt !== 'number' || at >= dueAt;
    } catch {
      // A store hiccup never rejects the cycle: reconcile the principal, which records its own failure.
      return true;
    }
  }

  const engine = createReportingSubscriptionEngineV1({
    principal: principals,
    offerings: service.offerings as never,
    store,
    statusRetentionDays: service.statusRetentionDays,
    ...(options.maxAccounts !== undefined ? { maxAccounts: options.maxAccounts } : {}),
    backfillOnRegrant: options.backfillOnRegrant ?? false,
    now,
    hooks: {
      listAuthorizedAccounts: (principal, { cursor, signal }) =>
        options.accounts
          ? options.accounts(principal, { ...(cursor !== undefined ? { cursor } : {}), ...(signal ? { signal } : {}) })
          : platformAccounts(principal, cursor, signal),
      listAccountBuys: (principal, accountId, { signal }) =>
        options.buys
          ? options.buys(principal, accountId, { ...(signal ? { signal } : {}) })
          : platformBuys(principal, accountId, signal),
      resolveRevocationInstant: (_principal, _accountId, input) => input.observedAt,
      isPeriodDelivered: (principal, period) =>
        options.isPeriodDelivered ? options.isPeriodDelivered(principal, period) : ledgerDelivered(principal, period),
      ...(options.accountDeliveryConfigs
        ? {
            listAccountDeliveryConfigs: (principal: PrincipalRef, accountId: string) =>
              options.accountDeliveryConfigs!(principal, accountId),
          }
        : {}),
    },
  });

  async function rememberTenant(tenantId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await store.get(TENANT_INDEX, TENANT_KEY);
      const tenants = new Set<string>((current?.value as { tenants?: string[] } | undefined)?.tenants ?? []);
      if (tenants.has(tenantId)) return;
      tenants.add(tenantId);
      const result = await store.put(
        TENANT_INDEX,
        TENANT_KEY,
        { tenants: [...tenants].sort() },
        current?.revision ?? null
      );
      if (result.outcome === 'applied') return;
    }
  }

  async function remember(principal: PrincipalRef, ctx: RequestContext<Account<TCtxMeta>>): Promise<void> {
    await rememberTenant(principal.tenantId);
    // The binding keeps a non-secret identity snapshot for reads outside a request; never a token.
    const auth = ctx.authInfo as Record<string, unknown> | undefined;
    // Fail closed: keep only the non-secret identity fields, never a token or credential, whatever
    // other keys an adopter's authInfo carries.
    const snapshot = auth
      ? Object.fromEntries(Object.entries(auth).filter(([key]) => SNAPSHOT_AUTH_FIELDS.has(key)))
      : undefined;
    const current = await store.get(principal, BINDING_KEY);
    const value = { tenantId: principal.tenantId, ...(snapshot ? { authInfo: snapshot } : {}) };
    if (JSON.stringify(current?.value) === JSON.stringify(value)) return;
    await store.put(principal, BINDING_KEY, value, current?.revision ?? null);
  }

  /**
   * Make a subscribed principal discoverable by the boundary sweep even when its first reconcile
   * fails: the engine store's principal index lists it from its binding document.
   */
  async function rememberPrincipal(principal: PrincipalRef): Promise<void> {
    await rememberTenant(principal.tenantId);
    const current = await store.get(principal, BINDING_KEY);
    if (current) return;
    await store.put(principal, BINDING_KEY, { tenantId: principal.tenantId }, null);
  }

  async function tenants(): Promise<readonly string[]> {
    if (typeof options.tenants === 'function') return options.tenants();
    if (options.tenants) return options.tenants;
    return ((await store.get(TENANT_INDEX, TENANT_KEY))?.value as { tenants?: string[] } | undefined)?.tenants ?? [];
  }

  async function listSubscriptionPrincipals(): Promise<PrincipalRef[]> {
    const all: PrincipalRef[] = [];
    for (const tenantId of await tenants()) all.push(...(await engine.listSubscriptionPrincipals(tenantId)));
    return all;
  }

  async function report(failure: SubscriptionPlanningFailure): Promise<void> {
    try {
      await options.planningErrorHandler?.(failure);
    } catch {
      // A failing handler never stops the cycle.
    }
  }

  async function reconcile(
    principal: PrincipalRef,
    signal?: AbortSignal
  ): Promise<SubscriptionPlanningFailure | undefined> {
    const at = now().getTime();
    try {
      const { states } = await principals.listReportingSubscriptions(principal);
      if (states.length === 0) return undefined;
      await engine.reconcile(principal, signal ? { signal } : {});
      await markDue(principal, await nextDue(principal, at));
      return undefined;
    } catch (error) {
      // A failed reconcile is due again at the next sweep.
      await markDue(principal, 0).catch(() => undefined);
      return { principal, error };
    }
  }

  const accountConfiguration = options.accountConfiguration ?? true;
  const support: PrincipalReportingSubscriptionSupport = {
    ...(options.maxSubscriptions !== undefined ? { maxSubscriptions: options.maxSubscriptions } : {}),
    accountConfigurations: accountConfiguration,
    // subscription_id and the caller's delivery_config_id values share one namespace.
    listDeliveryConfigIds: async scope => {
      if (!options.accountDeliveryConfigs) return [];
      const ids = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await engineRoster(scope, cursor);
        for (const account of result.accounts) {
          for (const config of await options.accountDeliveryConfigs(scope, account.account_id))
            ids.add(config.delivery_config_id);
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return [...ids];
    },
    ...(options.endAccountConfigs
      ? {
          replaceAccountConfigs: async input => {
            const scope = { tenantId: input.scope.tenantId, principalId: input.scope.principalId };
            for (const accountId of await engine.replaceAccountConfigTargets(scope, input.subscriptionId)) {
              const ids = (await options.accountDeliveryConfigs!(scope, accountId))
                .filter(config => config.feed_purpose === input.feedPurpose && config.active_until === undefined)
                .map(config => config.delivery_config_id);
              if (ids.length > 0) await options.endAccountConfigs!(scope, accountId, ids, { at: input.at });
            }
          },
        }
      : {}),
    ...(options.reconcileOnWrite !== false
      ? {
          onApplied: async scope => {
            await rememberPrincipal({ tenantId: scope.tenantId, principalId: scope.principalId });
            const failure = await reconcile({ tenantId: scope.tenantId, principalId: scope.principalId });
            if (failure) await report(failure);
          },
        }
      : {}),
  };
  function engineRoster(scope: PrincipalRef, cursor: string | undefined): Promise<SubscriptionAccountsPage> {
    return Promise.resolve(
      options.accounts
        ? options.accounts(scope, cursor !== undefined ? { cursor } : {})
        : platformAccounts(scope, cursor)
    );
  }
  principals.installReportingSubscriptions!(support);

  const resolvePrincipal = async (ctx: RequestContext<Account<TCtxMeta>>): Promise<PrincipalRef> => {
    let principal: PrincipalRef;
    if (options.resolvePrincipal) {
      principal = await options.resolvePrincipal(ctx);
    } else {
      // The same authenticated mapping the principal runtime uses for get_principal and
      // sync_principal, so a caller's subscriptions and its reporting reads are one principal.
      let scope = ctx.callerMutationScope as { tenant_id?: string; principal_id?: string } | undefined;
      if (!scope?.tenant_id && principals.protocol.resolvePrincipalScope) {
        scope = (await principals.protocol.resolvePrincipalScope(ctx as never, {} as never)) as typeof scope;
      }
      if (!scope?.tenant_id || !scope.principal_id) {
        throw new PlatformConfigError(
          'Reporting subscriptions need an authenticated caller. Serve the reporting tasks with authentication, or supply subscriptions.resolvePrincipal for another trust model.',
          { configField: 'subscriptions.resolvePrincipal' }
        );
      }
      principal = { tenantId: scope.tenant_id, principalId: scope.principal_id };
    }
    await remember(principal, ctx);
    return principal;
  };

  const advanced: ReliableReportingSubscriptionsOptionsV1<TCtxMeta> = {
    engine,
    principal: principals,
    resolvePrincipal,
    listSubscriptionPrincipals,
    resolveSubscriptionConfiguration: generation =>
      options.configure ? options.configure(generation) : defaultSubscriptionConfiguration(generation),
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    accountConfigurations: accountConfiguration,
    ...(options.bindManagedGeneration ? { bindManagedGeneration: options.bindManagedGeneration } : {}),
    // Planning failures are recorded and returned by runCycle, never thrown as an AggregateError.
    onPlanningError: (error, context) => report({ ...context, error }),
  };

  return {
    engine,
    principals,
    advanced,
    bindPlatform(value) {
      platform = value as PlatformReads;
    },
    async sweep(signal) {
      const failures: SubscriptionPlanningFailure[] = [];
      for (const principal of await listSubscriptionPrincipals()) {
        signal?.throwIfAborted();
        // Boundary-due: a principal is reconciled when a period of one of its schedules ended since
        // its last reconcile, its last reconcile failed, or the interval cap elapsed.
        if (!(await isDue(principal, now().getTime()))) continue;
        const failure = await reconcile(principal, signal);
        if (failure) {
          failures.push(failure);
          await report(failure);
        }
      }
      return failures;
    },
    report,
    grants: {
      async changed(input) {
        const principal = { tenantId: input.principal.tenantId, principalId: input.principal.principalId };
        await rememberPrincipal(principal);
        // A pushed change makes the principal due at the next sweep.
        await markDue(principal, 0);
        await engine.authorizationChanged(principal, input.accountId, {
          authorized: input.authorized,
          at: input.at,
          account: {
            ...(input.allowedTasks ? { allowed_tasks: [...input.allowedTasks] } : {}),
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.operator ? { operator: input.operator } : {}),
          },
        });
      },
    },
    async projectAccounts(items, ctx) {
      const context = ctx as { reportingServiceContext?: boolean } | undefined;
      if (!Array.isArray(items) || items.length === 0 || context?.reportingServiceContext) return items;
      let projected: PrincipalRef | undefined;
      try {
        const principal = await resolvePrincipal(ctx as RequestContext<Account<TCtxMeta>>);
        projected = principal;
        const { states } = await principals.listReportingSubscriptions(principal);
        if (states.length === 0) return items;
        const observations = items.flatMap(raw => {
          const account = raw as Record<string, unknown>;
          const accountId = typeof account.id === 'string' ? account.id : (account.account_id as string | undefined);
          const authorization = account.authorization as
            | { allowed_tasks?: string[]; authorized_at?: string; regranted_at?: string }
            | undefined;
          return accountId && authorization
            ? [
                {
                  account_id: accountId,
                  ...(authorization.authorized_at ? { authorized_at: authorization.authorized_at } : {}),
                  ...(authorization.regranted_at ? { regranted_at: authorization.regranted_at } : {}),
                  ...(authorization.allowed_tasks ? { allowed_tasks: authorization.allowed_tasks } : {}),
                },
              ]
            : [];
        });
        const served = await engine.observeGrants(principal, observations);
        return items.map(raw => {
          const account = raw as Record<string, unknown>;
          const accountId = typeof account.id === 'string' ? account.id : (account.account_id as string | undefined);
          const grant = accountId ? served.get(accountId) : undefined;
          if (grant === undefined) return raw;
          // The journal is the one source of authorized_at and regranted_at (adcp#8618): serve both.
          const { regranted_at: _hostRegrant, ...authorization } = account.authorization as Record<string, unknown>;
          return {
            ...account,
            authorization: {
              ...authorization,
              authorized_at: grant.authorized_at,
              ...(grant.regranted_at !== undefined ? { regranted_at: grant.regranted_at } : {}),
            },
          } as typeof raw;
        });
      } catch (error) {
        // The projection never fails the read, but a journal write that failed is reported: the
        // buyer was served the host's value, which coverage may not use.
        console.warn(
          `[adcp/reporting] authorized_at projection failed; served the platform's values: ${error instanceof Error ? error.message : String(error)}`
        );
        if (projected) await report({ principal: projected, error });
        return items;
      }
    },
  };
}

/**
 * The report content a subscription generation gets without `subscriptions.configure`, derived from
 * the resolved source offering:
 *
 * - every metric and dimension the source offering supports exactly;
 * - its first attribution model and window, with a settings digest over them;
 * - for `required_finality: 'official'`, a contractual cutoff at the offering's `delivery_sla`.
 *
 * Billing feeds need a canonicalization, which no default can supply: their generations fail to plan
 * with `PlatformConfigError` naming `subscriptions.configure`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3). See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function defaultSubscriptionConfiguration(
  generation: Pick<ReliableReportingSubscriptionGenerationContextV1, 'subscription' | 'offering' | 'sourceOffering'>
): ReliableReportingSubscriptionPolicyV1 {
  const { subscription, offering, sourceOffering } = generation;
  if (subscription.selector.feed_purpose === 'billing') {
    throw new PlatformConfigError(
      `Subscription ${JSON.stringify(subscription.subscription_id)} resolved billing offering ${JSON.stringify(offering.offering_id)}, which needs a canonicalization. Supply subscriptions.configure for billing feeds.`,
      { configField: 'subscriptions.configure' }
    );
  }
  const exact = (items: ReadonlyArray<{ name: string; support: string }>) =>
    items.filter(item => item.support === 'exact').map(item => item.name);
  const settings = {
    attributionModel: sourceOffering.sourceSettings.attributionModels[0]!,
    attributionWindow: sourceOffering.sourceSettings.attributionWindows[0]!,
  };
  const digest = createHash('sha256').update(canonicalJsonV1(settings)).digest('hex');
  const policy: ReliableReportingSubscriptionPolicyV1 = {
    requestedMetrics: exact(sourceOffering.metrics),
    requestedDimensions: exact(sourceOffering.dimensions),
    sourceSettings: {
      ...settings,
      sourceSettingsVersion: '1',
      sourceSettingsSha256: digest,
      settingsSnapshotRef: `adcp-default.${sourceOffering.offeringId}`.slice(0, 255).replace(/[^A-Za-z0-9_.-]/g, '_'),
    },
  };
  if (subscription.selector.required_finality === 'official') {
    policy.finalityPolicy = {
      policyId: `adcp-default-cutoff:${offering.offering_id}`.slice(0, 255).replace(/[^A-Za-z0-9_.:-]/g, '_'),
      basis: 'contractual_cutoff',
      durationAfterPeriodEndMilliseconds: reportingIsoDurationMillisecondsV1(offering.schedule.delivery_sla),
    };
  }
  return policy;
}
