/**
 * Seller-side reporting subscription engine (experimental `media_buy.reporting_subscriptions`,
 * AdCP 3.3).
 *
 * The host supplies only the facts it alone knows, through three hooks: which accounts a
 * principal may read (`listAuthorizedAccounts`), which buys an account holds
 * (`listAccountBuys`), and the caller's own account-level configurations, for precedence
 * (`listAccountDeliveryConfigs`). The engine maintains everything else (grant history,
 * coverage exceptions, `max_accounts` slots, timezone cutovers, lost authority) and derives:
 *
 * - `subscription_coverage[]` for `get_reporting_status` summary and periods views;
 * - `accounts_with_exceptions[]` and `accounts_unauthorized[]` in the principal readback,
 *   with `principal.changed` (`reporting_subscription_changed`) on every change;
 * - the owed periods and obligations, computed with the same pure
 *   {@link expectedSubscriptionPeriods} rule a buyer runs, so seller and buyer agree by
 *   construction when they agree on the facts;
 * - the receipt roster and the post-loss receipt window.
 */
import type { PendingAction } from '../../types/core.generated';
import type {
  PrincipalLifecycleRuntimeSubscriptions,
  PrincipalReportingSubscriptionState,
  PrincipalStoreScope,
} from '../../server/principal/types';
import type {
  StoredReportingSubscriptionHistory,
  StoredReportingSubscriptionVersion,
} from '../../server/principal/reporting-subscriptions';
import { createReportingPeriodCalendarV1, type ReportingPeriodCalendarV1 } from './calendar';
import {
  expectedSubscriptionPeriods,
  groupExpectedSubscriptionPeriodsV1,
  type ExpectedSubscriptionObligationV1,
  type ExpectedSubscriptionPeriodV1,
  type ReportingSubscriptionBuyV1,
  type ReportingSubscriptionGrantV1,
  type ReportingSubscriptionVersionRecordV1,
} from './coverage';
import {
  compareReportingIdsByteOrderV1,
  reportingSubscriptionScopeIncludesV1,
  resolveReportingSubscriptionOfferingsV1,
  type ReportingSubscriptionOfferingV1,
} from './selection';

type MaybePromise<T> = T | Promise<T>;
const DAY_MS = 86_400_000;

export type ReportingSubscriptionExclusionReasonV1 =
  | 'offering_unsupported'
  | 'capacity'
  | 'overridden'
  | 'excluded_by_buyer'
  | 'action_required';

/** One `subscription_coverage[].excluded[]` entry. */
export interface ReportingSubscriptionExclusionV1 {
  media_buy_id?: string;
  reason: ReportingSubscriptionExclusionReasonV1;
  from: string;
  until?: string;
  package_ids?: string[];
  overridden_by?: { subscription_id: string } | { delivery_config_id: string };
}

/** One `subscription_coverage[]` entry, typed. */
export interface ReportingSubscriptionCoverageEntryV1 {
  subscription_id: string;
  subscription_version: number;
  status: 'active' | 'excluded' | 'action_required';
  pending_action?: PendingAction;
  excluded: ReportingSubscriptionExclusionV1[];
  timezone_cutovers?: Array<{ effective_at: string; timezone: string }>;
  gaps?: Array<{ from: string; until: string; reason: 'unauthorized' }>;
}

/** Facts about one account the principal may currently read. */
export interface ReportingSubscriptionAccountFactV1 {
  account_id: string;
  /** `authorization.authorized_at`: when the current grant began. */
  authorized_at: string;
  operator?: string;
  /** The account's IANA timezone as `list_accounts` shows it. */
  timezone?: string;
  /** Seller-resolved upstream reporting timezone, for account-resolved source_timezone offerings. */
  source_timezone?: string;
  /** The seller serves this account only after this completes (`action_required`). */
  pending_action?: PendingAction;
}

/** One of the caller's own `sync_accounts` `reporting_delivery_configs` entries, for precedence. */
export interface ReportingSubscriptionAccountConfigV1 {
  delivery_config_id: string;
  feed_purpose: 'pacing' | 'analytics' | 'billing';
  /** When it became active. */
  active_from: string;
  /** When it ended (for example through `replace_account_configs`). Absent while active. */
  active_until?: string;
  /** Its schedule, so a handoff back to the subscription uses its own period end. */
  schedule?: {
    period_duration: string;
    alignment: 'utc' | 'account_timezone' | 'source_timezone' | 'billing_cycle';
    timezone?: string;
    period_anchor?: string;
  };
}

export interface ReportingSubscriptionEngineHooksV1 {
  /** The accounts this principal may read, paged. The host owns the answer; the SDK never infers it. */
  listAuthorizedAccounts(
    principal: Readonly<PrincipalStoreScope>,
    options: { cursor?: string; signal?: AbortSignal }
  ): MaybePromise<{ accounts: ReportingSubscriptionAccountFactV1[]; nextCursor?: string }>;
  /**
   * The media buys in this account the principal can see through `get_media_buys`, with each
   * package's product `reporting_delivery_offering_ids`, and earlier flight values when an
   * update changed them.
   */
  listAccountBuys(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    options: { signal?: AbortSignal }
  ): MaybePromise<ReportingSubscriptionBuyV1[]>;
  /** The principal's own account-level configurations on the account. Omit when the seller lists sync_principal alone. */
  listAccountDeliveryConfigs?(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    options: { signal?: AbortSignal }
  ): MaybePromise<ReportingSubscriptionAccountConfigV1[]>;
  /**
   * Whether an owed period was delivered, for `withheld_period_count`. Without it the engine
   * counts owed periods not yet due (`period_end + delivery_sla`) at `unauthorized_at`.
   */
  isPeriodDelivered?(period: ExpectedSubscriptionPeriodV1): MaybePromise<boolean>;
}

interface StoredExclusion extends ReportingSubscriptionExclusionV1 {
  /** Stable identity of the condition, so reconcile opens and closes it exactly once. */
  key: string;
  pending_action?: PendingAction;
}

interface AccountState {
  operator?: string;
  timezone?: string;
  /** Timezone in effect before the first recorded cutover. */
  initialTimezone?: string;
  sourceTimezone?: string;
  grants: ReportingSubscriptionGrantV1[];
}

interface SubscriptionAccountState {
  exclusions: StoredExclusion[];
  gaps: Array<{ from: string; until: string; reason: 'unauthorized' }>;
  timezoneCutovers: Array<{ effective_at: string; timezone: string }>;
  /** The subscription covered this account at some point (for accounts_unauthorized). */
  covered: boolean;
}

/** Durable engine state for one principal. */
export interface ReportingSubscriptionEngineStateV1 {
  accounts: Record<string, AccountState>;
  subscriptions: Record<string, { accounts: Record<string, SubscriptionAccountState>; served: string[] }>;
}

/** Engine persistence. Each principal's state is one atomic document. */
export interface ReportingSubscriptionEngineStoreV1 {
  readonly durability: 'process-local' | 'durable';
  get(
    principal: Readonly<PrincipalStoreScope>
  ): MaybePromise<{ state: ReportingSubscriptionEngineStateV1; revision: string } | null>;
  put(
    principal: Readonly<PrincipalStoreScope>,
    state: ReportingSubscriptionEngineStateV1,
    expectedRevision: string | null
  ): MaybePromise<{ outcome: 'applied'; revision: string } | { outcome: 'conflict' }>;
  listPrincipals(): MaybePromise<PrincipalStoreScope[]>;
}

/** Process-local engine store for tests and single-process sellers. */
export function createInMemoryReportingSubscriptionEngineStoreV1(): ReportingSubscriptionEngineStoreV1 {
  const rows = new Map<
    string,
    { scope: PrincipalStoreScope; state: ReportingSubscriptionEngineStateV1; revision: number }
  >();
  const key = (scope: Readonly<PrincipalStoreScope>) => JSON.stringify([scope.tenantId, scope.principalId]);
  return {
    durability: 'process-local',
    get(scope) {
      const row = rows.get(key(scope));
      return row ? { state: structuredClone(row.state), revision: String(row.revision) } : null;
    },
    put(scope, state, expectedRevision) {
      const row = rows.get(key(scope));
      if ((row ? String(row.revision) : null) !== expectedRevision) return { outcome: 'conflict' };
      const revision = (row?.revision ?? 0) + 1;
      rows.set(key(scope), {
        scope: { tenantId: scope.tenantId, principalId: scope.principalId },
        state: structuredClone(state),
        revision,
      });
      return { outcome: 'applied', revision: String(revision) };
    },
    listPrincipals() {
      return [...rows.values()].map(row => ({ ...row.scope }));
    },
  };
}

export interface CreateReportingSubscriptionEngineOptionsV1 {
  principal: PrincipalLifecycleRuntimeSubscriptions;
  hooks: ReportingSubscriptionEngineHooksV1;
  /** The seller's offerings with their standard-dimension mapping. */
  offerings: readonly ReportingSubscriptionOfferingV1[];
  /** Defaults to a process-local store; production sellers pass a durable one. */
  store?: ReportingSubscriptionEngineStoreV1;
  /** `subscriptions.max_accounts`. */
  maxAccounts?: number;
  /** `subscriptions.backfill_on_regrant`. */
  backfillOnRegrant?: boolean;
  /** `status_retention_days`. */
  statusRetentionDays: number;
  now?: () => Date;
  maxCasAttempts?: number;
}

export interface ReportingSubscriptionEngineV1 {
  /** The commitments a capability document advertises for this engine. */
  readonly settings: { maxAccounts?: number; backfillOnRegrant: boolean; statusRetentionDays: number };
  /**
   * Reconcile one principal: read its authorized accounts and buys, stamp grants and
   * revocations, open and close exceptions, and publish the readback. Idempotent.
   */
  reconcile(principal: Readonly<PrincipalStoreScope>, options?: { signal?: AbortSignal }): Promise<void>;
  /** Record an authority change the host observed, at the instant it happened. */
  authorizationChanged(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    change: {
      authorized: boolean;
      at: string;
      account?: Omit<ReportingSubscriptionAccountFactV1, 'account_id' | 'authorized_at'>;
    }
  ): Promise<void>;
  /**
   * `subscription_coverage[]` for `get_reporting_status`. Empty for an account the principal
   * is not currently authorized for: caller isolation is unchanged.
   */
  subscriptionCoverage(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string
  ): Promise<ReportingSubscriptionCoverageEntryV1[]>;
  /** Every owed (buy, offering, period) of this principal's subscriptions on the account. */
  owedPeriods(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    options?: { now?: string; signal?: AbortSignal }
  ): Promise<ExpectedSubscriptionPeriodV1[]>;
  /** The owed periods grouped into obligations with frozen `media_buy_ids`. */
  owedObligations(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    options?: { now?: string; signal?: AbortSignal }
  ): Promise<ExpectedSubscriptionObligationV1[]>;
  /** Principals whose active subscriptions cover the account: the consumers that owe receipts. */
  receiptRoster(accountId: string): Promise<PrincipalStoreScope[]>;
  /**
   * Whether `sync_reporting_receipts`/`sync_reporting_status` from this principal may still be
   * accepted for a revision it read at `readAt`: always while authorized; after a loss only
   * for revisions read before `unauthorized_at`, for `status_retention_days`.
   */
  acceptsReceipt(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    input: { readAt: string; now?: string }
  ): Promise<boolean>;
  /** The engine state, for inspection and conformance. */
  inspect(principal: Readonly<PrincipalStoreScope>): Promise<ReportingSubscriptionEngineStateV1>;
}

function emptyState(): ReportingSubscriptionEngineStateV1 {
  return { accounts: {}, subscriptions: {} };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function lastGrant(account: AccountState | undefined): ReportingSubscriptionGrantV1 | undefined {
  return account?.grants.at(-1);
}

function isAuthorized(account: AccountState | undefined): boolean {
  const grant = lastGrant(account);
  return grant !== undefined && grant.unauthorized_at === undefined;
}

/** Versions in the coverage function's input shape. */
function versionRecords(history: StoredReportingSubscriptionHistory): ReportingSubscriptionVersionRecordV1[] {
  return history.versions.map((version, index) => {
    const isCurrent = index === history.versions.length - 1;
    const inactive = history.inactiveIntervals.filter(
      interval =>
        Date.parse(interval.from) >= Date.parse(version.acceptedAt) &&
        (version.supersededAt === undefined || Date.parse(interval.from) < Date.parse(version.supersededAt))
    );
    return {
      subscription_version: version.subscriptionVersion,
      accepted_at: version.acceptedAt,
      ...(version.supersededAt !== undefined ? { superseded_at: version.supersededAt } : {}),
      ...(isCurrent && history.deactivatedAt !== undefined ? { deactivated_at: history.deactivatedAt } : {}),
      ...(inactive.length > 0 ? { inactive_intervals: inactive } : {}),
      configuration: { ...version.configuration, active: !(isCurrent && history.deactivatedAt !== undefined) },
      ...(version.destinationMethod ? { destination_method: version.destinationMethod } : {}),
    };
  });
}

export function createReportingSubscriptionEngineV1(
  options: CreateReportingSubscriptionEngineOptionsV1
): ReportingSubscriptionEngineV1 {
  if (!options?.principal?.listReportingSubscriptions) {
    throw new TypeError(
      'createReportingSubscriptionEngineV1 requires a principal runtime with reporting subscriptions'
    );
  }
  if (
    typeof options.hooks?.listAuthorizedAccounts !== 'function' ||
    typeof options.hooks.listAccountBuys !== 'function'
  ) {
    throw new TypeError(
      'createReportingSubscriptionEngineV1 requires listAuthorizedAccounts and listAccountBuys hooks'
    );
  }
  if (!Number.isSafeInteger(options.statusRetentionDays) || options.statusRetentionDays < 1) {
    throw new TypeError('statusRetentionDays must be a positive integer');
  }
  if (options.maxAccounts !== undefined && (!Number.isSafeInteger(options.maxAccounts) || options.maxAccounts < 1)) {
    throw new TypeError('maxAccounts must be a positive integer');
  }
  const production = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';
  const store = options.store ?? createInMemoryReportingSubscriptionEngineStoreV1();
  if (production && store.durability !== 'durable') {
    throw new TypeError('Production reporting subscription engines require a durable store');
  }
  const now = options.now ?? (() => new Date());
  const maxCasAttempts = options.maxCasAttempts ?? 8;
  const retentionMs = options.statusRetentionDays * DAY_MS;
  const offeringsById = new Map(options.offerings.map(offering => [offering.offering_id, offering]));
  if (offeringsById.size !== options.offerings.length) throw new TypeError('offering_id values must be unique');

  async function mutate(
    principal: Readonly<PrincipalStoreScope>,
    change: (state: ReportingSubscriptionEngineStateV1) => void | Promise<void>
  ): Promise<ReportingSubscriptionEngineStateV1> {
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const current = await store.get(principal);
      const state = current ? structuredClone(current.state) : emptyState();
      await change(state);
      const result = await store.put(principal, state, current?.revision ?? null);
      if (result.outcome === 'applied') return state;
    }
    throw new Error('Reporting subscription engine state conflicted repeatedly');
  }

  /** Calendars an account resolves for a version at `at`, across the given buys. */
  function accountCalendars(
    version: StoredReportingSubscriptionVersion,
    account: AccountState,
    buys: readonly ReportingSubscriptionBuyV1[],
    at: number,
    timezone = account.timezone
  ): ReportingPeriodCalendarV1[] {
    const calendars = new Map<string, ReportingPeriodCalendarV1>();
    for (const buy of buys) {
      for (const pkg of buy.packages) {
        for (const id of resolveReportingSubscriptionOfferingsV1({
          selector: version.configuration.selector,
          reconciliation_mode: version.configuration.reconciliation_mode,
          ...(version.destinationMethod ? { destination_method: version.destinationMethod } : {}),
          offerings: [...offeringsById.values()],
          eligible_offering_ids: pkg.reporting_delivery_offering_ids,
          at,
        })) {
          const calendar = calendarFor(offeringsById.get(id)!, version, account, timezone);
          if (calendar) calendars.set(calendar.key, calendar);
        }
      }
    }
    return [...calendars.values()];
  }

  function calendarFor(
    offering: ReportingSubscriptionOfferingV1,
    version: StoredReportingSubscriptionVersion,
    account: AccountState,
    timezone: string | undefined
  ): ReportingPeriodCalendarV1 | undefined {
    const schedule = offering.schedule;
    const override = version.configuration.selector.period_timezone;
    try {
      switch (schedule.alignment) {
        case 'utc':
          return createReportingPeriodCalendarV1({ period_duration: schedule.period_duration, alignment: 'utc' });
        case 'account_timezone':
          return createReportingPeriodCalendarV1({
            period_duration: schedule.period_duration,
            alignment: 'account_timezone',
            timezone: (override ?? timezone)!,
          });
        case 'source_timezone':
          return createReportingPeriodCalendarV1({
            period_duration: schedule.period_duration,
            alignment: 'source_timezone',
            timezone: (schedule.period_timezone_policy === 'fixed'
              ? schedule.period_timezone
              : (override ?? account.sourceTimezone))!,
          });
        case 'billing_cycle':
          return createReportingPeriodCalendarV1({
            period_duration: schedule.period_duration,
            alignment: 'billing_cycle',
            timezone: schedule.period_timezone!,
            period_anchor: schedule.period_anchor!,
          });
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  /** E for a change at T: the latest end of an outgoing period that started before T. */
  function cutoverInstant(calendars: readonly ReportingPeriodCalendarV1[], at: number): number {
    return calendars.length === 0 ? at : Math.max(...calendars.map(calendar => calendar.ceil(at)));
  }

  function primaryCalendar(calendars: readonly ReportingPeriodCalendarV1[]): ReportingPeriodCalendarV1 | undefined {
    return [...calendars].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))[0];
  }

  /** Open newly desired conditions and close vanished ones, both at E instants. */
  function settleExclusions(
    target: SubscriptionAccountState,
    desired: ReadonlyArray<Omit<StoredExclusion, 'from'> & { at: number }>,
    calendars: readonly ReportingPeriodCalendarV1[],
    nowMs: number
  ): boolean {
    let changed = false;
    const open = target.exclusions.filter(entry => entry.until === undefined);
    for (const entry of open) {
      if (desired.some(item => item.key === entry.key)) continue;
      entry.until = iso(Math.max(Date.parse(entry.from), cutoverInstant(calendars, nowMs)));
      changed = true;
    }
    for (const item of desired) {
      if (open.some(entry => entry.key === item.key)) continue;
      const { at, ...rest } = item;
      target.exclusions.push({
        ...rest,
        from: iso(item.reason === 'offering_unsupported' ? at : cutoverInstant(calendars, at)),
      });
      changed = true;
    }
    // Retain closed entries for status_retention_days after until.
    const kept = target.exclusions.filter(
      entry => entry.until === undefined || Date.parse(entry.until) + retentionMs > nowMs
    );
    if (kept.length !== target.exclusions.length) changed = true;
    target.exclusions = kept;
    target.gaps = target.gaps.filter(gap => Date.parse(gap.until) + retentionMs > nowMs);
    target.timezoneCutovers = target.timezoneCutovers.filter(cut => Date.parse(cut.effective_at) + retentionMs > nowMs);
    return changed;
  }

  async function readFacts(principal: Readonly<PrincipalStoreScope>, signal?: AbortSignal) {
    const accounts = new Map<string, ReportingSubscriptionAccountFactV1>();
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page += 1) {
      signal?.throwIfAborted();
      const result = await options.hooks.listAuthorizedAccounts(principal, {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(signal ? { signal } : {}),
      });
      for (const account of result.accounts) accounts.set(account.account_id, account);
      if (result.nextCursor === undefined) break;
      if (result.nextCursor === cursor) throw new Error('listAuthorizedAccounts returned a repeating cursor');
      cursor = result.nextCursor;
    }
    return accounts;
  }

  function applyGrant(
    state: ReportingSubscriptionEngineStateV1,
    accountId: string,
    authorized: boolean,
    at: number,
    fact?: Partial<ReportingSubscriptionAccountFactV1>
  ) {
    const account = (state.accounts[accountId] ??= { grants: [] });
    if (fact?.operator !== undefined) account.operator = fact.operator;
    if (fact?.source_timezone !== undefined) account.sourceTimezone = fact.source_timezone;
    const last = lastGrant(account);
    if (authorized) {
      if (last && last.unauthorized_at === undefined) return false;
      const start = last?.unauthorized_at !== undefined ? Math.max(at, Date.parse(last.unauthorized_at)) : at;
      account.grants.push({ authorized_at: iso(start) });
      return true;
    }
    if (!last || last.unauthorized_at !== undefined) return false;
    last.unauthorized_at = iso(Math.max(at, Date.parse(last.authorized_at)));
    return true;
  }

  async function reconcile(principal: Readonly<PrincipalStoreScope>, reconcileOptions: { signal?: AbortSignal } = {}) {
    const signal = reconcileOptions.signal;
    const nowMs = now().getTime();
    const { history } = await options.principal.listReportingSubscriptions(principal);
    const facts = await readFacts(principal, signal);
    const buysByAccount = new Map<string, ReportingSubscriptionBuyV1[]>();
    const configsByAccount = new Map<string, ReportingSubscriptionAccountConfigV1[]>();
    for (const accountId of facts.keys()) {
      signal?.throwIfAborted();
      buysByAccount.set(accountId, await options.hooks.listAccountBuys(principal, accountId, signal ? { signal } : {}));
      configsByAccount.set(
        accountId,
        (await options.hooks.listAccountDeliveryConfigs?.(principal, accountId, signal ? { signal } : {})) ?? []
      );
    }
    // Accounts whose authority ended inside retention: their buys, as they stood, give the
    // withheld periods. The host answers from its own records; nothing is disclosed to the caller.
    const previous = await store.get(principal);
    for (const [accountId, account] of Object.entries(previous?.state.accounts ?? {})) {
      const grant = lastGrant(account);
      if (facts.has(accountId) || grant === undefined) continue;
      // Revoked in this pass (still open in the stored state), or inside retention.
      if (grant.unauthorized_at !== undefined && Date.parse(grant.unauthorized_at) + retentionMs <= nowMs) continue;
      buysByAccount.set(accountId, await options.hooks.listAccountBuys(principal, accountId, signal ? { signal } : {}));
    }
    let notify = false;
    const state = await mutate(principal, current => {
      notify = false;
      // 1. Authority and account facts.
      for (const [accountId, fact] of facts) {
        if (applyGrant(current, accountId, true, Date.parse(fact.authorized_at), fact)) notify = true;
        const account = current.accounts[accountId]!;
        if (fact.timezone !== undefined && fact.timezone !== account.timezone) {
          if (account.timezone !== undefined)
            recordTimezoneChange(
              current,
              history,
              accountId,
              account,
              fact.timezone,
              nowMs,
              buysByAccount.get(accountId) ?? []
            );
          else account.initialTimezone = fact.timezone;
          account.timezone = fact.timezone;
        }
      }
      for (const [accountId, account] of Object.entries(current.accounts)) {
        if (!facts.has(accountId) && isAuthorized(account)) {
          applyGrant(current, accountId, false, nowMs);
          notify = true;
        }
      }
      // 2. Exceptions per subscription and account.
      for (const entry of history) {
        const sub = (current.subscriptions[entry.subscriptionId] ??= { accounts: {}, served: [] });
        const version = entry.versions.at(-1)!;
        const active = entry.deactivatedAt === undefined;
        const configuration = version.configuration;
        const inScope = [...facts.keys()]
          .filter(accountId => {
            const account = current.accounts[accountId]!;
            return reportingSubscriptionScopeIncludesV1(
              {
                scope: configuration.scope,
                ...(configuration.operator_domains ? { operator_domains: configuration.operator_domains } : {}),
              },
              { account_id: accountId, ...(account.operator !== undefined ? { operator: account.operator } : {}) }
            );
          })
          .sort(compareReportingIdsByteOrderV1);
        // Precedence: the caller's own account-level configuration, then its own account_ids subscription.
        const overriddenBy = new Map<
          string,
          {
            by: StoredExclusion['overridden_by'];
            at: number;
            until?: { at: number; calendar?: ReportingPeriodCalendarV1 };
          }
        >();
        for (const accountId of inScope) {
          const configs = (configsByAccount.get(accountId) ?? []).filter(
            item =>
              item.feed_purpose === configuration.selector.feed_purpose &&
              (item.active_until === undefined || Date.parse(item.active_until) > nowMs)
          );
          const winner = configs.sort((left, right) =>
            compareReportingIdsByteOrderV1(left.delivery_config_id, right.delivery_config_id)
          )[0];
          if (winner) {
            overriddenBy.set(accountId, {
              by: { delivery_config_id: winner.delivery_config_id },
              at: Date.parse(winner.active_from),
            });
            continue;
          }
          if (configuration.scope.all_authorized_accounts) {
            const specific = history.find(
              other =>
                other.subscriptionId !== entry.subscriptionId &&
                other.deactivatedAt === undefined &&
                other.versions.at(-1)!.configuration.selector.feed_purpose === configuration.selector.feed_purpose &&
                other.versions.at(-1)!.configuration.scope.account_ids?.includes(accountId)
            );
            if (specific) {
              overriddenBy.set(accountId, {
                by: { subscription_id: specific.subscriptionId },
                at: Date.parse(specific.versions.at(-1)!.acceptedAt),
              });
            }
          }
        }
        // max_accounts: previously served accounts keep their slots, then byte order.
        const eligible = inScope.filter(
          accountId => !overriddenBy.has(accountId) && !facts.get(accountId)!.pending_action
        );
        const ordered = [
          ...sub.served.filter(accountId => eligible.includes(accountId)),
          ...eligible.filter(accountId => !sub.served.includes(accountId)),
        ];
        const served = options.maxAccounts === undefined ? ordered : ordered.slice(0, options.maxAccounts);
        const capacity = new Set(ordered.slice(served.length));
        sub.served = active ? served : sub.served;

        const allAccounts = new Set([...inScope, ...Object.keys(sub.accounts)]);
        if (configuration.exclude_account_ids) {
          for (const accountId of configuration.exclude_account_ids)
            if (facts.has(accountId)) allAccounts.add(accountId);
        }
        for (const accountId of allAccounts) {
          const account = current.accounts[accountId];
          if (!account) continue;
          const target = (sub.accounts[accountId] ??= {
            exclusions: [],
            gaps: [],
            timezoneCutovers: [],
            covered: false,
          });
          const buys = buysByAccount.get(accountId) ?? [];
          const calendars = accountCalendars(version, account, buys, nowMs);
          const desired: Array<Omit<StoredExclusion, 'from'> & { at: number }> = [];
          const accepted = Date.parse(version.acceptedAt);
          if (facts.has(accountId) && active) {
            if (configuration.exclude_account_ids?.includes(accountId)) {
              desired.push({ key: 'excluded_by_buyer', reason: 'excluded_by_buyer', at: accepted });
            } else if (inScope.includes(accountId)) {
              const pending = facts.get(accountId)!.pending_action;
              const override = overriddenBy.get(accountId);
              if (pending) {
                desired.push({
                  key: 'action_required',
                  reason: 'action_required',
                  at: nowMs,
                  pending_action: structuredClone(pending),
                });
              } else if (override) {
                desired.push({
                  key: `overridden:${JSON.stringify(override.by)}`,
                  reason: 'overridden',
                  overridden_by: override.by!,
                  at: Math.max(override.at, accepted),
                });
              } else if (capacity.has(accountId)) {
                desired.push({ key: 'capacity', reason: 'capacity', at: nowMs });
              }
              for (const buy of buys) {
                if (buy.confirmed_at === undefined || buy.confirmed_at === null) continue;
                const unsupported = buy.packages
                  .filter(
                    pkg =>
                      resolveReportingSubscriptionOfferingsV1({
                        selector: configuration.selector,
                        reconciliation_mode: configuration.reconciliation_mode,
                        ...(version.destinationMethod ? { destination_method: version.destinationMethod } : {}),
                        offerings: [...offeringsById.values()],
                        eligible_offering_ids: pkg.reporting_delivery_offering_ids,
                        at: nowMs,
                      }).length === 0
                  )
                  .map(pkg => pkg.package_id)
                  .sort(compareReportingIdsByteOrderV1);
                if (unsupported.length === 0) continue;
                const at = Math.max(accepted, Date.parse(buy.confirmed_at));
                desired.push(
                  unsupported.length === buy.packages.length
                    ? {
                        key: `offering_unsupported:${buy.media_buy_id}`,
                        reason: 'offering_unsupported',
                        media_buy_id: buy.media_buy_id,
                        at,
                      }
                    : {
                        key: `offering_unsupported:${buy.media_buy_id}:${unsupported.join(',')}`,
                        reason: 'offering_unsupported',
                        media_buy_id: buy.media_buy_id,
                        package_ids: unsupported,
                        at,
                      }
                );
              }
            }
          }
          if (!facts.has(accountId)) {
            // No current authority: keep the exception history frozen; lost authority is
            // reported in accounts_unauthorized instead.
            continue;
          }
          // Only accounts the subscription actually served can later appear in accounts_unauthorized.
          if (inScope.includes(accountId) && !desired.some(item => item.media_buy_id === undefined)) {
            target.covered = true;
          }
          // Lost-authority gaps on re-grant inside retention, without backfill.
          if (!options.backfillOnRegrant) recordRegrantGaps(target, account, calendars);
          if (settleExclusions(target, desired, calendars, nowMs)) notify = true;
        }
      }
    });

    // 3. Readback: accounts_with_exceptions and accounts_unauthorized. An exception that
    // opened or closed fires principal.changed even when the summary is unchanged.
    const updates = [];
    for (const entry of history) updates.push(await readbackFor(entry, state, nowMs, buysByAccount));
    await options.principal.recordReportingSubscriptionCoverage(principal, updates, { forceNotification: notify });
  }

  function recordTimezoneChange(
    state: ReportingSubscriptionEngineStateV1,
    history: readonly StoredReportingSubscriptionHistory[],
    accountId: string,
    account: AccountState,
    timezone: string,
    nowMs: number,
    buys: readonly ReportingSubscriptionBuyV1[]
  ) {
    for (const entry of history) {
      const version = entry.versions.at(-1)!;
      if (version.configuration.selector.period_timezone !== undefined) continue;
      const calendars = accountCalendars(version, account, buys, nowMs).filter(
        calendar => calendar.spec.alignment === 'account_timezone'
      );
      if (calendars.length === 0) continue;
      const sub = (state.subscriptions[entry.subscriptionId] ??= { accounts: {}, served: [] });
      const target = (sub.accounts[accountId] ??= { exclusions: [], gaps: [], timezoneCutovers: [], covered: false });
      target.timezoneCutovers.push({ effective_at: iso(cutoverInstant(calendars, nowMs)), timezone });
    }
  }

  function recordRegrantGaps(
    target: SubscriptionAccountState,
    account: AccountState,
    calendars: readonly ReportingPeriodCalendarV1[]
  ) {
    const calendar = primaryCalendar(calendars);
    for (let index = 1; index < account.grants.length; index += 1) {
      const previous = account.grants[index - 1]!;
      const grant = account.grants[index]!;
      if (previous.unauthorized_at === undefined) continue;
      const revokedAt = Date.parse(previous.unauthorized_at);
      const regrantedAt = Date.parse(grant.authorized_at);
      if (regrantedAt >= revokedAt + retentionMs) continue; // a fresh start, no gap claimed
      const from = calendar ? calendar.floor(revokedAt) : revokedAt;
      const until = calendar ? calendar.ceil(regrantedAt) : regrantedAt;
      if (until <= from) continue;
      if (target.gaps.some(gap => Date.parse(gap.from) === from && Date.parse(gap.until) === until)) continue;
      if (target.gaps.some(gap => Date.parse(gap.from) <= revokedAt && Date.parse(gap.until) >= regrantedAt)) continue;
      target.gaps.push({ from: iso(from), until: iso(until), reason: 'unauthorized' });
    }
  }

  async function readbackFor(
    entry: StoredReportingSubscriptionHistory,
    state: ReportingSubscriptionEngineStateV1,
    nowMs: number,
    buysByAccount: ReadonlyMap<string, ReportingSubscriptionBuyV1[]>
  ) {
    const sub = state.subscriptions[entry.subscriptionId];
    const accountsWithExceptions: NonNullable<PrincipalReportingSubscriptionState['accounts_with_exceptions']> = [];
    const accountsUnauthorized: NonNullable<PrincipalReportingSubscriptionState['accounts_unauthorized']> = [];
    for (const [accountId, target] of Object.entries(sub?.accounts ?? {})) {
      const account = state.accounts[accountId];
      if (isAuthorized(account)) {
        const reasons = [
          ...new Set(target.exclusions.filter(item => item.until === undefined).map(item => item.reason)),
        ].sort();
        if (reasons.length > 0) accountsWithExceptions.push({ account_id: accountId, reasons: reasons as never });
        continue;
      }
      const grant = lastGrant(account);
      if (!target.covered || grant?.unauthorized_at === undefined) continue;
      const unauthorizedAt = Date.parse(grant.unauthorized_at);
      if (unauthorizedAt + retentionMs <= nowMs) continue;
      const version = entry.versions.at(-1)!;
      const buys = buysByAccount.get(accountId) ?? [];
      const calendar = primaryCalendar(accountCalendars(version, account!, buys, unauthorizedAt));
      const owed = await withheldPeriods(entry, state, accountId, unauthorizedAt, buys);
      accountsUnauthorized.push({
        account_id: accountId,
        unauthorized_at: grant.unauthorized_at,
        ...(calendar
          ? { last_owed_period_end: iso(calendar.floor(unauthorizedAt)) }
          : owed.lastEnd
            ? { last_owed_period_end: owed.lastEnd }
            : {}),
        withheld_period_count: owed.count,
      });
    }
    return { subscriptionId: entry.subscriptionId, accountsWithExceptions, accountsUnauthorized };
  }

  /** Owed periods that ended at or before `unauthorizedAt` and were not delivered by then. */
  async function withheldPeriods(
    entry: StoredReportingSubscriptionHistory,
    state: ReportingSubscriptionEngineStateV1,
    accountId: string,
    unauthorizedAt: number,
    buys: readonly ReportingSubscriptionBuyV1[]
  ): Promise<{ count: number; lastEnd?: string }> {
    const periods = computeOwed(entry, state, accountId, buys, iso(unauthorizedAt));
    let count = 0;
    for (const period of periods) {
      const delivered = options.hooks.isPeriodDelivered
        ? await options.hooks.isPeriodDelivered(period)
        : Date.parse(period.period_end) + slaMs(period.offering_id) <= unauthorizedAt;
      if (!delivered) count += 1;
    }
    return { count, ...(periods.length ? { lastEnd: periods.at(-1)!.period_end } : {}) };
  }

  function slaMs(offeringId: string): number {
    const sla = offeringsById.get(offeringId)?.schedule.delivery_sla;
    const match = sla ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(sla) : null;
    if (!match) return 0;
    return (
      ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3_600 +
        Number(match[3] ?? 0) * 60 +
        Number(match[4] ?? 0)) *
      1_000
    );
  }

  function computeOwed(
    entry: StoredReportingSubscriptionHistory,
    state: ReportingSubscriptionEngineStateV1,
    accountId: string,
    buys: readonly ReportingSubscriptionBuyV1[],
    nowIso: string
  ): ExpectedSubscriptionPeriodV1[] {
    const account = state.accounts[accountId];
    if (!account) return [];
    const target = state.subscriptions[entry.subscriptionId]?.accounts[accountId];
    const cutovers = target?.timezoneCutovers ?? [];
    return expectedSubscriptionPeriods({
      subscription_id: entry.subscriptionId,
      versions: versionRecords(entry),
      account: {
        account_id: accountId,
        ...(account.operator !== undefined ? { operator: account.operator } : {}),
        ...((cutovers.length > 0 ? account.initialTimezone : account.timezone) !== undefined
          ? { timezone: (cutovers.length > 0 ? account.initialTimezone : account.timezone)! }
          : {}),
        ...(account.sourceTimezone !== undefined ? { source_timezone: account.sourceTimezone } : {}),
        grants: account.grants,
      },
      buys,
      offerings: [...offeringsById.values()],
      coverage: {
        excluded: (target?.exclusions ?? []).map(stripExclusion) as never,
        ...(target?.gaps.length ? { gaps: target.gaps } : {}),
        ...(cutovers.length ? { timezone_cutovers: cutovers } : {}),
      },
      backfill_on_regrant: options.backfillOnRegrant === true,
      status_retention_days: options.statusRetentionDays,
      now: nowIso,
    });
  }

  async function owedPeriods(
    principal: Readonly<PrincipalStoreScope>,
    accountId: string,
    owedOptions: { now?: string; signal?: AbortSignal } = {}
  ): Promise<ExpectedSubscriptionPeriodV1[]> {
    const current = await store.get(principal);
    if (!current) return [];
    const { history } = await options.principal.listReportingSubscriptions(principal);
    const buys = await options.hooks.listAccountBuys(
      principal,
      accountId,
      owedOptions.signal ? { signal: owedOptions.signal } : {}
    );
    const nowIso = owedOptions.now ?? now().toISOString();
    return history.flatMap(entry => computeOwed(entry, current.state, accountId, buys, nowIso));
  }

  return {
    settings: Object.freeze({
      ...(options.maxAccounts !== undefined ? { maxAccounts: options.maxAccounts } : {}),
      backfillOnRegrant: options.backfillOnRegrant === true,
      statusRetentionDays: options.statusRetentionDays,
    }),
    reconcile: (principal, reconcileOptions) => reconcile(principal, reconcileOptions ?? {}),
    async authorizationChanged(principal, accountId, change) {
      const at = Date.parse(change.at);
      if (!Number.isFinite(at)) throw new TypeError('authorizationChanged requires an RFC 3339 instant');
      let changed = false;
      await mutate(principal, state => {
        changed = applyGrant(state, accountId, change.authorized, at, change.account);
      });
      if (changed) await reconcile(principal, {});
    },
    async subscriptionCoverage(principal, accountId) {
      const current = await store.get(principal);
      if (!current || !isAuthorized(current.state.accounts[accountId])) return [];
      const { history } = await options.principal.listReportingSubscriptions(principal);
      const entries: ReportingSubscriptionCoverageEntryV1[] = [];
      for (const entry of history) {
        const target = current.state.subscriptions[entry.subscriptionId]?.accounts[accountId];
        if (!target) continue;
        const open = target.exclusions.filter(item => item.until === undefined && item.media_buy_id === undefined);
        const pending = open.find(item => item.reason === 'action_required');
        entries.push({
          subscription_id: entry.subscriptionId,
          subscription_version: entry.versions.at(-1)!.subscriptionVersion,
          status: pending ? 'action_required' : open.length > 0 ? 'excluded' : 'active',
          ...(pending?.pending_action ? { pending_action: structuredClone(pending.pending_action) } : {}),
          excluded: target.exclusions.map(stripExclusion),
          ...(target.timezoneCutovers.length ? { timezone_cutovers: structuredClone(target.timezoneCutovers) } : {}),
          ...(target.gaps.length ? { gaps: structuredClone(target.gaps) } : {}),
        });
      }
      return entries;
    },
    owedPeriods,
    async owedObligations(principal, accountId, owedOptions) {
      return groupExpectedSubscriptionPeriodsV1(await owedPeriods(principal, accountId, owedOptions));
    },
    async receiptRoster(accountId) {
      const roster: PrincipalStoreScope[] = [];
      for (const principal of await store.listPrincipals()) {
        const current = await store.get(principal);
        if (!current || !isAuthorized(current.state.accounts[accountId])) continue;
        const { history } = await options.principal.listReportingSubscriptions(principal);
        const covers = history.some(entry => {
          if (entry.deactivatedAt !== undefined) return false;
          const target = current.state.subscriptions[entry.subscriptionId]?.accounts[accountId];
          return (
            target?.covered === true &&
            !target.exclusions.some(item => item.until === undefined && item.media_buy_id === undefined)
          );
        });
        if (covers) roster.push(principal);
      }
      return roster.sort((left, right) =>
        compareReportingIdsByteOrderV1(
          `${left.tenantId}\u0000${left.principalId}`,
          `${right.tenantId}\u0000${right.principalId}`
        )
      );
    },
    async acceptsReceipt(principal, accountId, input) {
      const current = await store.get(principal);
      const account = current?.state.accounts[accountId];
      if (isAuthorized(account)) return true;
      const grant = lastGrant(account);
      if (grant?.unauthorized_at === undefined) return false;
      const unauthorizedAt = Date.parse(grant.unauthorized_at);
      const nowMs = input.now !== undefined ? Date.parse(input.now) : now().getTime();
      return Date.parse(input.readAt) < unauthorizedAt && nowMs < unauthorizedAt + retentionMs;
    },
    async inspect(principal) {
      return structuredClone((await store.get(principal))?.state ?? emptyState());
    },
  };
}

function stripExclusion(entry: StoredExclusion | ReportingSubscriptionExclusionV1): ReportingSubscriptionExclusionV1 {
  const { key: _key, pending_action: _pending, ...rest } = entry as StoredExclusion;
  void _key;
  void _pending;
  return structuredClone(rest);
}
