/**
 * Seller-side reporting subscription engine (experimental `media_buy.reporting_subscriptions`,
 * AdCP 3.3).
 *
 * The host supplies only the facts it alone knows:
 *
 * - `listAuthorizedAccounts`: which accounts a principal may read now, with each account's
 *   chain-start `authorized_at`, and `granted_at` / `timezone_changed_at` when those changed;
 * - `listAccountBuys`: which buys an account holds, with each package's offering ids;
 * - `resolveRevocationInstant`: when a principal's authority over an account ended;
 * - `isPeriodDelivered`: whether an owed period was delivered, for `withheld_period_count`;
 * - optionally `listAccountDeliveryConfigs`: the caller's own account-level configurations,
 *   for precedence, including ended ones with their `active_until`.
 *
 * The engine keeps everything else: grant history, coverage exceptions opened and closed at
 * the instant each change took effect, `max_accounts` slots, timezone cutovers, re-grant gaps
 * and lost authority. It derives:
 *
 * - `subscription_coverage[]` for `get_reporting_status` summary and periods views;
 * - `accounts_with_exceptions[]` and `accounts_unauthorized[]` in the principal readback,
 *   with `principal.changed` (`reporting_subscription_changed`) on every change;
 * - the owed periods and obligations. Each reconcile freezes the periods that elapsed since
 *   the previous one, computed with the same pure {@link owedSubscriptionPeriodsV1} rule a
 *   buyer runs. Frozen periods are never recomputed, so later host changes (a withdrawn
 *   offering, an edited product) or pruning retained exceptions never change an elapsed
 *   owed set. Reconcile at least once per period so each period is frozen with the facts in
 *   force when it was resolved;
 * - the tenant-scoped receipt roster (there is no post-loss receipt window, adcp#8607).
 *
 * State is sharded: one document per principal for `max_accounts` slots, and one per
 * (principal, account), each updated with compare-and-set.
 */
import { canonicalize } from '../../utils/jcs';
import { ReportingSubscriptionEngineError } from '../../errors';
import { PlatformConfigError } from '../../server/decisioning/runtime/validate-platform';
import type { PendingAction } from '../../types/core.generated';
import type {
  PrincipalLifecycleRuntimeSubscriptions,
  PrincipalReportingSubscriptionState,
  PrincipalRef,
} from '../../server/principal/types';
import type {
  StoredReportingSubscriptionHistory,
  StoredReportingSubscriptionVersion,
} from '../../server/principal/reporting-subscriptions';
import { createReportingPeriodCalendarV1, type ReportingPeriodCalendarV1 } from './calendar';
import type {
  ReportingSubscriptionGapV1,
  ReportingSubscriptionInactiveIntervalV1,
  ReportingSubscriptionTimezoneCutoverV1,
} from './wire';
import {
  owedSubscriptionPeriodsV1,
  groupOwedSubscriptionPeriodsV1,
  type OwedSubscriptionObligationV1,
  type OwedSubscriptionPeriodV1,
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
const MAX_AUTHORIZED_ACCOUNT_PAGES = 10_000;
const PRINCIPAL_KEY = 'principal';
const ACCOUNT_KEY_PREFIX = 'account:';

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export type ReportingSubscriptionExclusionReasonV1 =
  | 'offering_unsupported'
  | 'capacity'
  | 'overridden'
  | 'excluded_by_buyer'
  | 'action_required';

/**
 * One `subscription_coverage[].excluded[]` entry.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionExclusionV1 {
  media_buy_id?: string;
  /** The offering whose periods it removes; absent for every offering. */
  offering_id?: string;
  reason: ReportingSubscriptionExclusionReasonV1;
  from: string;
  until?: string;
  package_ids?: string[];
  overridden_by?: { subscription_id: string } | { delivery_config_id: string };
}

/**
 * One `subscription_coverage[]` entry, typed.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionCoverageEntryV1 {
  subscription_id: string;
  subscription_version: number;
  /**
   * `inactive` (adcp#8613) for a deactivated subscription; it takes precedence. Callers served
   * a release without that value see the account-level state instead.
   */
  status: 'active' | 'excluded' | 'action_required' | 'inactive';
  /** Present when and only when `status` is `inactive`. */
  deactivated_at?: string;
  pending_action?: PendingAction;
  excluded: ReportingSubscriptionExclusionV1[];
  timezone_cutovers?: ReportingSubscriptionTimezoneCutoverV1[];
  gaps?: ReportingSubscriptionGapV1[];
}

/**
 * Facts about one account the principal may currently read.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionAccountFactV1 {
  account_id: string;
  /**
   * `authorization.authorized_at`: when the caller's current authorization chain began. A
   * re-grant inside retention keeps it; a later value is a new chain.
   */
  authorized_at: string;
  /**
   * When the current grant began, when it differs from `authorized_at` (a re-grant inside the
   * chain). Required once the engine has recorded a revocation that the chain continues past.
   */
  granted_at?: string;
  operator?: string;
  /** The account's IANA timezone as `list_accounts` shows it. */
  timezone?: string;
  /** When `timezone` last changed. Required when it differs from the zone the engine recorded. */
  timezone_changed_at?: string;
  /** Seller-resolved upstream reporting timezone, for account-resolved source_timezone offerings. */
  source_timezone?: string;
  /** The seller serves this account only after this completes (`action_required`). */
  pending_action?: PendingAction;
  /** When `pending_action` began. Defaults to the account's coverage start when first observed. */
  pending_action_since?: string;
  /**
   * The grant's `authorization.allowed_tasks`, as `list_accounts` shows it, when the seller
   * advertises it. Coverage requires `get_reporting_status`; absent means the grant restricts no
   * task. See {@link reportingSubscriptionCoverageGrantedV1}.
   */
  allowed_tasks?: readonly string[];
}

/**
 * Whether a grant authorizes reporting subscription coverage (`core/reporting-subscription.json`
 * `x-adcp-validation.coverage`): "the caller is authorized for it: its authorization object, when
 * advertised, lists get_reporting_status in allowed_tasks". A grant that restricts no task counts
 * as all tasks. A reduced reconciliation grant (for example `get_reporting_status`,
 * `sync_reporting_receipts` and `sync_reporting_status`) keeps coverage; dropping
 * `get_reporting_status` from the grant ends it at that instant, as a loss of authority with an
 * `accounts_unauthorized` entry. The one place this rule lives.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingSubscriptionCoverageGrantedV1(grant: {
  allowed_tasks?: readonly string[] | undefined;
}): boolean {
  return grant.allowed_tasks === undefined || grant.allowed_tasks.includes('get_reporting_status');
}

/**
 * One of the caller's own `sync_accounts` `reporting_delivery_configs` entries, for precedence.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionAccountConfigV1 {
  delivery_config_id: string;
  feed_purpose: 'pacing' | 'analytics' | 'billing';
  /** When it became active. */
  active_from: string;
  /**
   * When it ended (for example through `replace_account_configs`). Keep returning an ended
   * configuration with `active_until` for `status_retention_days`, so the override closes at
   * that instant rather than when the engine notices.
   */
  active_until?: string;
  /** Its schedule, so a handoff back to the subscription uses the configuration's own period end. */
  schedule?: {
    period_duration: string;
    alignment: 'utc' | 'account_timezone' | 'source_timezone' | 'billing_cycle';
    timezone?: string;
    period_anchor?: string;
  };
}

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface ReportingSubscriptionEngineHooksV1 {
  /** The accounts this principal may read now, paged. The host owns the answer; the SDK never infers it. */
  listAuthorizedAccounts(
    principal: Readonly<PrincipalRef>,
    options: { cursor?: string; signal?: AbortSignal }
  ): MaybePromise<{ accounts: ReportingSubscriptionAccountFactV1[]; nextCursor?: string }>;
  /**
   * The media buys in this account the principal can see through `get_media_buys`, with each
   * package's product `reporting_delivery_offering_ids`, and earlier flight values when an
   * update changed them.
   */
  listAccountBuys(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    options: { signal?: AbortSignal }
  ): MaybePromise<ReportingSubscriptionBuyV1[]>;
  /**
   * When the principal's authority over the account ended. Called when an account leaves the
   * authorized list, or reappears under a later chain without the revocation being observed.
   * The answer is clamped to `[lastObservedAt, observedAt]`.
   */
  resolveRevocationInstant(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    input: { lastObservedAt?: string; observedAt: string }
  ): MaybePromise<string>;
  /** Whether an owed period was delivered, for `withheld_period_count`. */
  isPeriodDelivered(principal: Readonly<PrincipalRef>, period: OwedSubscriptionPeriodV1): MaybePromise<boolean>;
  /** The principal's own account-level configurations on the account. Omit when the seller lists sync_principal alone. */
  listAccountDeliveryConfigs?(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    options: { signal?: AbortSignal }
  ): MaybePromise<ReportingSubscriptionAccountConfigV1[]>;
}

interface StoredExclusion extends ReportingSubscriptionExclusionV1 {
  /** Stable identity of the condition, so reconcile opens and closes it exactly once. */
  key: string;
  pending_action?: PendingAction;
}

/** An owed period frozen when it was resolved. */
type FrozenPeriod = Omit<OwedSubscriptionPeriodV1, 'subscription_id' | 'account_id'>;

interface AccountState {
  operator?: string;
  /** The account's current timezone. Earlier zones are in each cutover's previous_timezone. */
  timezone?: string;
  sourceTimezone?: string;
  grants: ReportingSubscriptionGrantV1[];
  /** The chain-start authorized_at last reported. */
  chainStart?: string;
  /** Last reconcile that saw the account authorized. */
  lastObservedAt?: string;
}

interface SubscriptionAccountState {
  exclusions: StoredExclusion[];
  gaps: ReportingSubscriptionGapV1[];
  timezoneCutovers: ReportingSubscriptionTimezoneCutoverV1[];
  /** The subscription served this account at some point (for accounts_unauthorized). */
  covered: boolean;
  /** Offerings each buy resolved at the previous reconcile, to date resolution changes. */
  resolvedBuys: Record<string, string[]>;
  /** Owed periods resolved so far, never recomputed, and the instant through which they are complete. */
  frozen: { through?: string; periods: FrozenPeriod[] };
  /**
   * Buys whose resolution changed (a product dropped or gained an offering, a package came or
   * went, the buy disappeared): the buy as it was, and the E from which the new facts apply.
   * Periods of that buy starting before E keep resolving from the earlier snapshot, so an edit
   * never rewrites a period that was already owed.
   */
  buyRevisions?: BuyRevision[];
}

interface BuyRevision {
  media_buy_id: string;
  effective_at: string;
  previous: ReportingSubscriptionBuyV1;
}

/**
 * Durable engine state for one (principal, account).
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionEngineAccountDocumentV1 {
  account: AccountState;
  subscriptions: Record<string, SubscriptionAccountState>;
  /** The buys as of the previous reconcile, so a product or package edit is dated, not retroactive. */
  lastBuys?: ReportingSubscriptionBuyV1[];
}

/**
 * Durable engine state for one principal: `max_accounts` slots per subscription.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionEnginePrincipalDocumentV1 {
  served: Record<string, string[]>;
}

/**
 * Everything the engine holds for one principal, for inspection and conformance.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionEngineStateV1 {
  principal: ReportingSubscriptionEnginePrincipalDocumentV1;
  accounts: Record<string, ReportingSubscriptionEngineAccountDocumentV1>;
}

/**
 * Engine persistence: small documents keyed per principal (`principal`) and per account
 * (`account:<id>`), each with its own compare-and-set revision.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionEngineStoreV1 {
  readonly durability: 'process-local' | 'durable';
  get(
    principal: Readonly<PrincipalRef>,
    key: string
  ): MaybePromise<{ value: Record<string, unknown>; revision: string } | null>;
  put(
    principal: Readonly<PrincipalRef>,
    key: string,
    value: Record<string, unknown>,
    expectedRevision: string | null
  ): MaybePromise<{ outcome: 'applied'; revision: string } | { outcome: 'conflict' }>;
  /** Every key stored for the principal. */
  listKeys(principal: Readonly<PrincipalRef>): MaybePromise<string[]>;
  /** Principals with engine state in one tenant. */
  listPrincipals(tenantId: string): MaybePromise<PrincipalRef[]>;
}

/**
 * Process-local engine store for tests and single-process sellers.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function createInMemoryReportingSubscriptionEngineStoreV1(): ReportingSubscriptionEngineStoreV1 {
  const rows = new Map<
    string,
    { scope: PrincipalRef; key: string; value: Record<string, unknown>; revision: number }
  >();
  const id = (scope: Readonly<PrincipalRef>, key: string) => JSON.stringify([scope.tenantId, scope.principalId, key]);
  return {
    durability: 'process-local',
    get(scope, key) {
      const row = rows.get(id(scope, key));
      return row ? { value: structuredClone(row.value), revision: String(row.revision) } : null;
    },
    put(scope, key, value, expectedRevision) {
      const row = rows.get(id(scope, key));
      if ((row ? String(row.revision) : null) !== expectedRevision) return { outcome: 'conflict' };
      const revision = (row?.revision ?? 0) + 1;
      rows.set(id(scope, key), {
        scope: { tenantId: scope.tenantId, principalId: scope.principalId },
        key,
        value: structuredClone(value),
        revision,
      });
      return { outcome: 'applied', revision: String(revision) };
    },
    listKeys(scope) {
      return [...rows.values()]
        .filter(row => row.scope.tenantId === scope.tenantId && row.scope.principalId === scope.principalId)
        .map(row => row.key);
    },
    listPrincipals(tenantId) {
      const seen = new Map<string, PrincipalRef>();
      for (const row of rows.values()) {
        if (row.scope.tenantId === tenantId) seen.set(row.scope.principalId, { ...row.scope });
      }
      return [...seen.values()];
    },
  };
}

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface CreateReportingSubscriptionEngineOptionsV1 {
  principal: PrincipalLifecycleRuntimeSubscriptions;
  hooks: ReportingSubscriptionEngineHooksV1;
  /** The seller's offerings as published, with `standard_dimensions`. Keep withdrawn ones with `withdrawn_at`. */
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
  /**
   * Called when a subscription has more accounts to list in `accounts_with_exceptions` or
   * `accounts_unauthorized` than the readback's 1000-entry limit (for example a small
   * `max_accounts` against a large roster, where every account past the cap carries
   * `capacity`). That subscription keeps its previous readback lists rather than publishing a
   * silently cut one; every other subscription and all coverage state are still updated.
   */
  onReadbackOverflow?: (
    principal: Readonly<PrincipalRef>,
    overflow: readonly ReportingSubscriptionReadbackOverflowV1[]
  ) => void | Promise<void>;
}

/**
 * A subscription whose readback lists exceed the 1000-entry limit.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionReadbackOverflowV1 {
  subscription_id: string;
  accounts_with_exceptions: number;
  accounts_unauthorized: number;
}

/**
 * What a reconcile pass could not publish.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionReconcileResultV1 {
  readback_overflow: ReportingSubscriptionReadbackOverflowV1[];
}

/** The readback's `maxItems` for `accounts_with_exceptions` and `accounts_unauthorized`. */
const MAX_READBACK_ACCOUNTS = 1000;

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface ReportingSubscriptionEngineV1 {
  /** The commitments a capability document advertises for this engine. */
  readonly settings: { maxAccounts?: number; backfillOnRegrant: boolean; statusRetentionDays: number };
  /**
   * Reconcile one principal: read its authorized accounts and buys, record grants and
   * revocations at the instants they happened, open and close exceptions at the instant each
   * change took effect, freeze newly elapsed owed periods, and publish the readback.
   */
  reconcile(
    principal: Readonly<PrincipalRef>,
    options?: { signal?: AbortSignal }
  ): Promise<ReportingSubscriptionReconcileResultV1>;
  /** Record an authority change the host observed, at the instant it happened. */
  authorizationChanged(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    change: {
      authorized: boolean;
      at: string;
      account?: Omit<ReportingSubscriptionAccountFactV1, 'account_id' | 'authorized_at'>;
    }
  ): Promise<void>;
  /**
   * `subscription_coverage[]` for `get_reporting_status`: active subscriptions whose current
   * scope includes the account, and deactivated ones (`status: "inactive"`, `deactivated_at`)
   * only while they still have retained obligations for the account (adcp#8613). Empty for an
   * account the principal is not currently authorized for: caller isolation is unchanged.
   */
  subscriptionCoverage(
    principal: Readonly<PrincipalRef>,
    accountId: string
  ): Promise<ReportingSubscriptionCoverageEntryV1[]>;
  /**
   * Every owed (buy, offering, period) of this principal's subscriptions on the account:
   * the frozen elapsed periods, plus any that elapsed since the last reconcile.
   */
  owedPeriods(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    options?: { now?: string; signal?: AbortSignal }
  ): Promise<OwedSubscriptionPeriodV1[]>;
  /** The owed periods grouped into obligations with frozen `media_buy_ids`. */
  owedObligations(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    options?: { now?: string; signal?: AbortSignal }
  ): Promise<OwedSubscriptionObligationV1[]>;
  /**
   * The frozen owed set of each of this principal's subscriptions on each account the engine holds
   * (or on one account), for writing into the reporting ledger: obligations whose periods ended at
   * or before the subscription's frozen horizon `through`, never the provisional periods computed
   * past it. Every owed period ending at or before `through` is in `obligations` unless retention
   * already pruned it.
   */
  frozenOwedSets(
    principal: Readonly<PrincipalRef>,
    options?: { accountId?: string }
  ): Promise<ReportingSubscriptionFrozenOwedSetV1[]>;
  /**
   * Principals with engine state in one tenant, from the engine store: what the service's
   * `listSubscriptionPrincipals` returns across your tenants.
   */
  listSubscriptionPrincipals(tenantId: string): Promise<PrincipalRef[]>;
  /** @deprecated Renamed {@link ReportingSubscriptionEngineV1.listSubscriptionPrincipals}. This alias is removed in a later beta. */
  listPrincipals(tenantId: string): Promise<PrincipalRef[]>;
  /**
   * Whether the principal is authorized for the account now: its latest grant has no
   * `unauthorized_at`. Every managed delivery of a subscription obligation re-checks it.
   */
  isAuthorized(principal: Readonly<PrincipalRef>, accountId: string): Promise<boolean>;
  /** Principals in the tenant whose active subscriptions cover the account: the consumers that owe receipts. */
  receiptRoster(tenantId: string, accountId: string): Promise<PrincipalRef[]>;
  /**
   * Accounts whose own `reporting_delivery_configs` a `replace_account_configs` application
   * may deactivate: in scope and served, resolving an offering, and not excluded,
   * `capacity` or `offering_unsupported`. For the principal runtime's `replaceAccountConfigs` hook.
   */
  replaceAccountConfigTargets(principal: Readonly<PrincipalRef>, subscriptionId: string): Promise<string[]>;
  /** The engine state, for inspection and conformance. */
  inspect(principal: Readonly<PrincipalRef>): Promise<ReportingSubscriptionEngineStateV1>;
}

/**
 * One subscription's frozen owed set on one account.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionFrozenOwedSetV1 {
  account_id: string;
  subscription_id: string;
  /** The frozen horizon: every owed period ending at or before it is resolved and never recomputed. */
  through: string;
  /** Frozen obligations, grouped as the ledger carries them, with byte-sorted `media_buy_ids`. */
  obligations: OwedSubscriptionObligationV1[];
  /** Every retained version's configuration, oldest first, for the generation each obligation names. */
  versions: Array<{
    subscription_version: number;
    configuration: StoredReportingSubscriptionVersion['configuration'];
    /** The destination's pattern and transport, frozen when the version was accepted. */
    destination_method?: StoredReportingSubscriptionVersion['destinationMethod'];
  }>;
}

/**
 * The latest `period_end` among periods. Frozen periods are not stored in end order: they are
 * appended across reconciles, and offerings with different calendars interleave.
 */
function latestPeriodEnd(periods: ReadonlyArray<{ period_end: string }>): string {
  let latest = periods[0]!;
  for (const period of periods) if (Date.parse(period.period_end) > Date.parse(latest.period_end)) latest = period;
  return latest.period_end;
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

function emptyAccountDocument(): ReportingSubscriptionEngineAccountDocumentV1 {
  return { account: { grants: [] }, subscriptions: {} };
}

function emptySubscriptionAccount(): SubscriptionAccountState {
  return { exclusions: [], gaps: [], timezoneCutovers: [], covered: false, resolvedBuys: {}, frozen: { periods: [] } };
}

function parseInstant(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new ReportingSubscriptionEngineError(
      'SUBSCRIPTION_HOST_FACT_INVALID',
      `${field} must be an RFC 3339 date-time. Return an RFC 3339 timestamp from the hook.`
    );
  }
  return parsed;
}

/** Versions in the coverage function's input shape. */
function versionRecords(history: StoredReportingSubscriptionHistory): ReportingSubscriptionVersionRecordV1[] {
  return history.versions.map((version, index) => {
    const isCurrent = index === history.versions.length - 1;
    return {
      subscription_version: version.subscriptionVersion,
      accepted_at: version.acceptedAt,
      ...(version.supersededAt !== undefined ? { superseded_at: version.supersededAt } : {}),
      ...(isCurrent && history.deactivatedAt !== undefined ? { deactivated_at: history.deactivatedAt } : {}),
      configuration: { ...version.configuration, active: !(isCurrent && history.deactivatedAt !== undefined) },
      ...(version.destinationMethod ? { destination_method: version.destinationMethod } : {}),
    };
  });
}

/** Reversed deactivations, as the readback's `inactive_intervals` lists them. */
function inactiveIntervals(history: StoredReportingSubscriptionHistory): ReportingSubscriptionInactiveIntervalV1[] {
  return history.inactiveIntervals.map(interval => ({ deactivated_at: interval.from, reactivated_at: interval.until }));
}

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export function createReportingSubscriptionEngineV1(
  options: CreateReportingSubscriptionEngineOptionsV1
): ReportingSubscriptionEngineV1 {
  if (!options?.principal?.listReportingSubscriptions) {
    throw new PlatformConfigError(
      'createReportingSubscriptionEngineV1 requires a principal runtime with reporting subscriptions. Pass a runtime from createPrincipalLifecycle({ reportingSubscriptions }) as principal.',
      { configField: 'principal' }
    );
  }
  for (const hook of [
    'listAuthorizedAccounts',
    'listAccountBuys',
    'resolveRevocationInstant',
    'isPeriodDelivered',
  ] as const) {
    if (typeof options.hooks?.[hook] !== 'function') {
      throw new PlatformConfigError(
        `createReportingSubscriptionEngineV1 requires the ${hook} hook. Supply hooks.${hook}.`,
        { configField: `hooks.${hook}` }
      );
    }
  }
  if (!Number.isSafeInteger(options.statusRetentionDays) || options.statusRetentionDays < 1) {
    throw new PlatformConfigError('statusRetentionDays must be a positive integer. Set it to the service value.', {
      configField: 'statusRetentionDays',
    });
  }
  if (options.maxAccounts !== undefined && (!Number.isSafeInteger(options.maxAccounts) || options.maxAccounts < 1)) {
    throw new PlatformConfigError('maxAccounts must be a positive integer. Set a positive integer or omit it.', {
      configField: 'maxAccounts',
    });
  }
  const production = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';
  const store = options.store ?? createInMemoryReportingSubscriptionEngineStoreV1();
  if (production && store.durability !== 'durable') {
    throw new PlatformConfigError(
      'Production reporting subscription engines require a durable store. Pass store: createReportingSubscriptionEngineStateStoreV1({ store, durability: "durable" }) over durable storage, or run with NODE_ENV=test or development.',
      { code: 'REPORTING_STORAGE_NOT_DURABLE', configField: 'store' }
    );
  }
  const now = options.now ?? (() => new Date());
  const maxCasAttempts = options.maxCasAttempts ?? 8;
  const retentionMs = options.statusRetentionDays * DAY_MS;
  const offeringsById = new Map(options.offerings.map(offering => [offering.offering_id, offering]));
  if (offeringsById.size !== options.offerings.length) {
    throw new PlatformConfigError('offering_id values must be unique. Remove the duplicate offering.', {
      configField: 'offerings',
    });
  }

  async function mutate<T extends Record<string, unknown>>(
    principal: Readonly<PrincipalRef>,
    key: string,
    empty: () => T,
    change: (value: T) => void | Promise<void>
  ): Promise<T> {
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const current = await store.get(principal, key);
      const value = current ? (structuredClone(current.value) as T) : empty();
      await change(value);
      const result = await store.put(principal, key, value, current?.revision ?? null);
      if (result.outcome === 'applied') return value;
    }
    throw new ReportingSubscriptionEngineError(
      'SUBSCRIPTION_STATE_CONFLICT',
      `Reporting subscription engine state conflicted on ${maxCasAttempts} attempts. Another reconcile of this principal is running; retry.`
    );
  }

  async function readAccount(
    principal: Readonly<PrincipalRef>,
    accountId: string
  ): Promise<ReportingSubscriptionEngineAccountDocumentV1 | undefined> {
    const row = await store.get(principal, `${ACCOUNT_KEY_PREFIX}${accountId}`);
    return row ? (structuredClone(row.value) as unknown as ReportingSubscriptionEngineAccountDocumentV1) : undefined;
  }

  async function accountIds(principal: Readonly<PrincipalRef>): Promise<string[]> {
    return (await store.listKeys(principal))
      .filter(key => key.startsWith(ACCOUNT_KEY_PREFIX))
      .map(key => key.slice(ACCOUNT_KEY_PREFIX.length))
      .sort(compareReportingIdsByteOrderV1);
  }

  /** The calendar of each offering an account resolves for a version at `at`, by offering_id. */
  function offeringCalendars(
    version: StoredReportingSubscriptionVersion,
    account: AccountState,
    buys: readonly ReportingSubscriptionBuyV1[],
    at: number,
    timezone = account.timezone
  ): Map<string, ReportingPeriodCalendarV1> {
    const calendars = new Map<string, ReportingPeriodCalendarV1>();
    for (const buy of buys) {
      for (const id of resolveBuy(version, buy, at)) {
        const calendar = calendarFor(offeringsById.get(id)!, version, account, timezone);
        if (calendar) calendars.set(id, calendar);
      }
    }
    return new Map([...calendars].sort(([left], [right]) => compareReportingIdsByteOrderV1(left, right)));
  }

  function resolvePackage(version: StoredReportingSubscriptionVersion, offeringIds: readonly string[], at: number) {
    return resolveReportingSubscriptionOfferingsV1({
      selector: version.configuration.selector,
      reconciliation_mode: version.configuration.reconciliation_mode,
      ...(version.destinationMethod ? { destination_method: version.destinationMethod } : {}),
      offerings: [...offeringsById.values()],
      eligible_offering_ids: offeringIds,
      at,
    });
  }

  function resolveBuy(version: StoredReportingSubscriptionVersion, buy: ReportingSubscriptionBuyV1, at: number) {
    const ids = new Set<string>();
    for (const pkg of buy.packages) {
      for (const id of resolvePackage(version, pkg.reporting_delivery_offering_ids, at)) ids.add(id);
    }
    return [...ids].sort(compareReportingIdsByteOrderV1);
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
              : account.sourceTimezone)!,
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

  /**
   * E for a change at T: the latest end of an outgoing period that started before T. With
   * several calendars this is one account-wide instant (`excluded[]` carries no
   * `offering_id`), so an offering whose period ends earlier is cut at the latest end.
   */
  function cutoverInstant(calendars: Iterable<ReportingPeriodCalendarV1>, at: number): number {
    const list = [...calendars];
    return list.length === 0 ? at : Math.max(...list.map(calendar => calendar.ceil(at)));
  }

  function primaryCalendar(calendars: Iterable<ReportingPeriodCalendarV1>): ReportingPeriodCalendarV1 | undefined {
    return [...calendars].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))[0];
  }

  interface DesiredExclusion extends Omit<StoredExclusion, 'from'> {
    /** The instant the condition took effect. */
    at: number;
    /** Calendars whose E opens it; `from` is the raw instant when absent. */
    openCalendars?: Iterable<ReportingPeriodCalendarV1>;
  }

  /**
   * Open newly desired conditions and close vanished ones, both at the E of the instant the
   * change took effect. `closeAt` supplies that instant for a closing condition (for example
   * the overriding configuration's `active_until`); it defaults to the observation time.
   */
  function settleExclusions(
    target: SubscriptionAccountState,
    desired: readonly DesiredExclusion[],
    calendars: Iterable<ReportingPeriodCalendarV1>,
    nowMs: number,
    closeAt: (entry: StoredExclusion) => number | undefined
  ): boolean {
    let changed = false;
    const calendarList = [...calendars];
    const open = target.exclusions.filter(entry => entry.until === undefined);
    for (const entry of open) {
      if (desired.some(item => item.key === entry.key)) continue;
      entry.until = iso(Math.max(Date.parse(entry.from), closeAt(entry) ?? cutoverInstant(calendarList, nowMs)));
      changed = true;
    }
    for (const item of desired) {
      const current = open.find(entry => entry.key === item.key);
      if (current) {
        // An open condition keeps its from. When the host's pending action changed (a new url,
        // message or reason), the entry carries the current one, and the change notifies.
        if (canonicalize(current.pending_action ?? null) !== canonicalize(item.pending_action ?? null)) {
          if (item.pending_action === undefined) delete current.pending_action;
          else current.pending_action = structuredClone(item.pending_action);
          changed = true;
        }
        continue;
      }
      const { at, openCalendars, ...rest } = item;
      target.exclusions.push({ ...rest, from: iso(openCalendars ? cutoverInstant(openCalendars, at) : at) });
      changed = true;
    }
    // Wire retention: closed entries, gaps and cutovers are listed for status_retention_days.
    // Elapsed owed periods are frozen, so pruning never changes them.
    const kept = target.exclusions.filter(
      entry => entry.until === undefined || Date.parse(entry.until) + retentionMs > nowMs
    );
    if (kept.length !== target.exclusions.length) changed = true;
    target.exclusions = kept;
    target.gaps = target.gaps.filter(gap => Date.parse(gap.until) + retentionMs > nowMs);
    target.timezoneCutovers = target.timezoneCutovers.filter(cut => Date.parse(cut.effective_at) + retentionMs > nowMs);
    return changed;
  }

  async function readFacts(principal: Readonly<PrincipalRef>, signal?: AbortSignal) {
    const accounts = new Map<string, ReportingSubscriptionAccountFactV1>();
    let cursor: string | undefined;
    // A partial roster would read as revocations, so every incomplete walk fails closed.
    for (let page = 0; page < MAX_AUTHORIZED_ACCOUNT_PAGES; page += 1) {
      signal?.throwIfAborted();
      const result = await options.hooks.listAuthorizedAccounts(principal, {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(signal ? { signal } : {}),
      });
      // A grant without get_reporting_status does not authorize subscription coverage; the
      // account then reads exactly as if it had left the list.
      for (const account of result.accounts) {
        if (reportingSubscriptionCoverageGrantedV1(account)) accounts.set(account.account_id, account);
      }
      if (result.nextCursor === undefined) return accounts;
      if (result.nextCursor === cursor) {
        throw new ReportingSubscriptionEngineError(
          'SUBSCRIPTION_ROSTER_INCOMPLETE',
          'listAuthorizedAccounts returned a repeating cursor. Return a new cursor per page, or none on the last page.'
        );
      }
      cursor = result.nextCursor;
    }
    throw new ReportingSubscriptionEngineError(
      'SUBSCRIPTION_ROSTER_INCOMPLETE',
      `listAuthorizedAccounts did not finish within ${MAX_AUTHORIZED_ACCOUNT_PAGES} pages; refusing a partial roster. Return larger pages.`
    );
  }

  /** When authority ended, from the host, clamped to what the engine observed. */
  async function revocationInstant(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    account: AccountState,
    upperBound: number
  ): Promise<number> {
    const answer = await options.hooks.resolveRevocationInstant(principal, accountId, {
      ...(account.lastObservedAt !== undefined ? { lastObservedAt: account.lastObservedAt } : {}),
      observedAt: iso(upperBound),
    });
    const at = parseInstant(answer, 'resolveRevocationInstant result');
    const lower = Math.max(
      Date.parse(lastGrant(account)!.authorized_at),
      account.lastObservedAt !== undefined ? Date.parse(account.lastObservedAt) : Number.NEGATIVE_INFINITY
    );
    return Math.min(Math.max(at, lower), upperBound);
  }

  /** Apply what the host reports about one account's authority, at the instants it happened. */
  async function applyAuthority(
    principal: Readonly<PrincipalRef>,
    accountId: string,
    account: AccountState,
    fact: ReportingSubscriptionAccountFactV1 | undefined,
    nowMs: number
  ): Promise<boolean> {
    const last = lastGrant(account);
    if (!fact) {
      if (!last || last.unauthorized_at !== undefined) return false;
      last.unauthorized_at = iso(await revocationInstant(principal, accountId, account, nowMs));
      return true;
    }
    if (fact.operator !== undefined) account.operator = fact.operator;
    if (fact.source_timezone !== undefined) account.sourceTimezone = fact.source_timezone;
    const chainStart = parseInstant(fact.authorized_at, `${accountId} authorized_at`);
    let changed = false;
    if (!last) {
      account.grants.push({ authorized_at: iso(chainStart) });
      changed = true;
    } else if (last.unauthorized_at === undefined) {
      if (account.chainStart !== undefined && chainStart > Date.parse(account.chainStart)) {
        // A later chain start while the engine still holds the grant open: the revocation was
        // never observed. Close the old chain when it ended and open the new one.
        last.unauthorized_at = iso(await revocationInstant(principal, accountId, account, chainStart));
        account.grants.push({ authorized_at: iso(chainStart) });
        changed = true;
      }
    } else {
      const revokedAt = Date.parse(last.unauthorized_at);
      if (chainStart > revokedAt) {
        account.grants.push({ authorized_at: iso(chainStart) });
      } else {
        // The chain continues past a recorded revocation; only the host knows when.
        if (fact.granted_at === undefined) {
          throw new ReportingSubscriptionEngineError(
            'SUBSCRIPTION_HOST_FACT_INVALID',
            `Account ${JSON.stringify(accountId)} was re-granted inside its authorization chain. Report granted_at on the account fact.`
          );
        }
        const grantedAt = parseInstant(fact.granted_at, `${accountId} granted_at`);
        account.grants.push({ authorized_at: iso(Math.min(Math.max(grantedAt, revokedAt), nowMs)) });
      }
      changed = true;
    }
    account.chainStart = iso(chainStart);
    account.lastObservedAt = iso(nowMs);
    return changed;
  }

  async function reconcile(
    principal: Readonly<PrincipalRef>,
    reconcileOptions: { signal?: AbortSignal } = {}
  ): Promise<ReportingSubscriptionReconcileResultV1> {
    const signal = reconcileOptions.signal;
    const nowMs = now().getTime();
    const hookOptions = signal ? { signal } : {};
    const { history } = await options.principal.listReportingSubscriptions(principal);
    const facts = await readFacts(principal, signal);
    const known = new Set([...facts.keys(), ...(await accountIds(principal))]);
    const documents = new Map<string, ReportingSubscriptionEngineAccountDocumentV1>();
    for (const accountId of known)
      documents.set(accountId, (await readAccount(principal, accountId)) ?? emptyAccountDocument());

    // Host facts for accounts the principal reads now, or lost inside retention (their buys,
    // as they stood, give the withheld periods; nothing is disclosed to the caller).
    const buysByAccount = new Map<string, ReportingSubscriptionBuyV1[]>();
    const configsByAccount = new Map<string, ReportingSubscriptionAccountConfigV1[]>();
    for (const accountId of [...known].sort(compareReportingIdsByteOrderV1)) {
      signal?.throwIfAborted();
      const grant = lastGrant(documents.get(accountId)!.account);
      const retained =
        facts.has(accountId) ||
        (grant !== undefined &&
          (grant.unauthorized_at === undefined || Date.parse(grant.unauthorized_at) + retentionMs > nowMs));
      if (!retained) continue;
      buysByAccount.set(accountId, await options.hooks.listAccountBuys(principal, accountId, hookOptions));
      if (facts.has(accountId)) {
        configsByAccount.set(
          accountId,
          (await options.hooks.listAccountDeliveryConfigs?.(principal, accountId, hookOptions)) ?? []
        );
      }
    }

    // max_accounts slots (principal document): served accounts keep their slots, then byte order.
    const precedence = new Map<
      string,
      Map<string, { by: StoredExclusion['overridden_by']; at: number; config?: ReportingSubscriptionAccountConfigV1 }>
    >();
    const inScopeBySubscription = new Map<string, string[]>();
    const capacityBySubscription = new Map<string, Set<string>>();
    await mutate<ReportingSubscriptionEnginePrincipalDocumentV1 & Record<string, unknown>>(
      principal,
      PRINCIPAL_KEY,
      () => ({ served: {} }),
      document => {
        for (const entry of history) {
          const version = entry.versions.at(-1)!;
          const configuration = version.configuration;
          const inScope = [...facts.keys()]
            .filter(accountId => {
              const fact = facts.get(accountId)!;
              const operator = fact.operator ?? documents.get(accountId)!.account.operator;
              return reportingSubscriptionScopeIncludesV1(
                {
                  scope: configuration.scope,
                  ...(configuration.operator_domains ? { operator_domains: configuration.operator_domains } : {}),
                },
                { account_id: accountId, ...(operator !== undefined ? { operator } : {}) }
              );
            })
            .sort(compareReportingIdsByteOrderV1);
          inScopeBySubscription.set(entry.subscriptionId, inScope);
          const overrides = new Map<
            string,
            { by: StoredExclusion['overridden_by']; at: number; config?: ReportingSubscriptionAccountConfigV1 }
          >();
          for (const accountId of inScope) {
            const winner = (configsByAccount.get(accountId) ?? [])
              .filter(
                item =>
                  item.feed_purpose === configuration.selector.feed_purpose &&
                  (item.active_until === undefined || Date.parse(item.active_until) > nowMs)
              )
              .sort((left, right) =>
                compareReportingIdsByteOrderV1(left.delivery_config_id, right.delivery_config_id)
              )[0];
            if (winner) {
              overrides.set(accountId, {
                by: { delivery_config_id: winner.delivery_config_id },
                at: parseInstant(winner.active_from, `${winner.delivery_config_id} active_from`),
                config: winner,
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
                overrides.set(accountId, {
                  by: { subscription_id: specific.subscriptionId },
                  at: Date.parse(specific.versions.at(-1)!.acceptedAt),
                });
              }
            }
          }
          precedence.set(entry.subscriptionId, overrides);
          const eligible = inScope.filter(
            accountId => !overrides.has(accountId) && !facts.get(accountId)!.pending_action
          );
          const previous = document.served[entry.subscriptionId] ?? [];
          const ordered = [
            ...previous.filter(accountId => eligible.includes(accountId)),
            ...eligible.filter(accountId => !previous.includes(accountId)),
          ];
          const served = options.maxAccounts === undefined ? ordered : ordered.slice(0, options.maxAccounts);
          capacityBySubscription.set(entry.subscriptionId, new Set(ordered.slice(served.length)));
          if (entry.deactivatedAt === undefined) document.served[entry.subscriptionId] = served;
        }
      }
    );

    let notify = false;
    for (const accountId of [...known].sort(compareReportingIdsByteOrderV1)) {
      signal?.throwIfAborted();
      const buys = buysByAccount.get(accountId) ?? [];
      const fact = facts.get(accountId);
      const document = await mutate<ReportingSubscriptionEngineAccountDocumentV1 & Record<string, unknown>>(
        principal,
        `${ACCOUNT_KEY_PREFIX}${accountId}`,
        () => emptyAccountDocument() as ReportingSubscriptionEngineAccountDocumentV1 & Record<string, unknown>,
        async current => {
          let changed = await applyAuthority(principal, accountId, current.account, fact, nowMs);
          const account = current.account;
          if (fact?.timezone !== undefined && fact.timezone !== account.timezone) {
            if (account.timezone !== undefined) {
              if (fact.timezone_changed_at === undefined) {
                throw new ReportingSubscriptionEngineError(
                  'SUBSCRIPTION_HOST_FACT_INVALID',
                  `Account ${JSON.stringify(accountId)} changed timezone. Report timezone_changed_at on the account fact.`
                );
              }
              const changedAt = Math.min(
                parseInstant(fact.timezone_changed_at, `${accountId} timezone_changed_at`),
                nowMs
              );
              recordTimezoneChange(current, history, account, fact.timezone, changedAt, buys);
            }
            account.timezone = fact.timezone;
            changed = true;
          }
          for (const entry of history) {
            if (settleSubscription(current, entry, accountId, fact, buys, nowMs)) changed = true;
          }
          if (changed) notify = true;
        }
      );
      // Freeze periods that elapsed since the previous reconcile, with the facts now in force.
      await mutate<ReportingSubscriptionEngineAccountDocumentV1 & Record<string, unknown>>(
        principal,
        `${ACCOUNT_KEY_PREFIX}${accountId}`,
        () => structuredClone(document) as ReportingSubscriptionEngineAccountDocumentV1 & Record<string, unknown>,
        current => {
          for (const entry of history) {
            const target = current.subscriptions[entry.subscriptionId];
            if (target) target.buyRevisions = buyRevisionsFor(current, entry, buys, nowMs);
            freeze(current, entry, accountId, buys, nowMs);
          }
          current.lastBuys = structuredClone(buys);
        }
      );
    }

    // Readback: accounts_with_exceptions and accounts_unauthorized. An exception that
    // opened or closed fires principal.changed even when the summary is unchanged.
    const state = await inspect(principal);
    const updates = [];
    const overflow: ReportingSubscriptionReadbackOverflowV1[] = [];
    for (const entry of history) {
      const update = await readbackFor(principal, entry, state, nowMs, buysByAccount);
      if (
        update.accountsWithExceptions.length > MAX_READBACK_ACCOUNTS ||
        update.accountsUnauthorized.length > MAX_READBACK_ACCOUNTS
      ) {
        // Isolate the oversized subscription: it keeps its last published lists.
        overflow.push({
          subscription_id: update.subscriptionId,
          accounts_with_exceptions: update.accountsWithExceptions.length,
          accounts_unauthorized: update.accountsUnauthorized.length,
        });
        continue;
      }
      updates.push(update);
    }
    await options.principal.recordSubscriptionReadback(principal, updates, { forceNotification: notify });
    if (overflow.length > 0) await options.onReadbackOverflow?.(principal, overflow);
    return { readback_overflow: overflow };

    function settleSubscription(
      current: ReportingSubscriptionEngineAccountDocumentV1,
      entry: StoredReportingSubscriptionHistory,
      accountId: string,
      fact: ReportingSubscriptionAccountFactV1 | undefined,
      buys: readonly ReportingSubscriptionBuyV1[],
      nowMs: number
    ): boolean {
      const version = entry.versions.at(-1)!;
      const configuration = version.configuration;
      const active = entry.deactivatedAt === undefined;
      const inScope = inScopeBySubscription.get(entry.subscriptionId) ?? [];
      const excludedByBuyer = configuration.exclude_account_ids?.includes(accountId) === true;
      if (!current.subscriptions[entry.subscriptionId] && !inScope.includes(accountId) && !excludedByBuyer)
        return false;
      const isNew = current.subscriptions[entry.subscriptionId] === undefined;
      const target = (current.subscriptions[entry.subscriptionId] ??= emptySubscriptionAccount());
      if (!fact) return false; // no current authority: lost authority is reported in accounts_unauthorized
      const account = current.account;
      const calendars = offeringCalendars(version, account, buys, nowMs);
      const accepted = Date.parse(version.acceptedAt);
      // A condition first observed for an account this subscription had not yet served began
      // with that account's coverage, not at this reconcile.
      const coverageStart = Math.max(accepted, Date.parse(account.chainStart ?? lastGrant(account)!.authorized_at));
      const firstObserved = isNew || (!target.covered && target.exclusions.length === 0);
      const desired: DesiredExclusion[] = [];
      if (active) {
        if (excludedByBuyer) {
          desired.push({
            key: 'excluded_by_buyer',
            reason: 'excluded_by_buyer',
            at: accepted,
            openCalendars: calendars.values(),
          });
        } else if (inScope.includes(accountId)) {
          const override = precedence.get(entry.subscriptionId)?.get(accountId);
          if (fact.pending_action) {
            const since =
              fact.pending_action_since !== undefined
                ? parseInstant(fact.pending_action_since, `${accountId} pending_action_since`)
                : firstObserved
                  ? coverageStart
                  : nowMs;
            desired.push({
              key: 'action_required',
              reason: 'action_required',
              at: since,
              openCalendars: calendars.values(),
              pending_action: structuredClone(fact.pending_action),
            });
          } else if (override) {
            desired.push({
              key: `overridden:${JSON.stringify(override.by)}`,
              reason: 'overridden',
              overridden_by: override.by!,
              at: Math.max(override.at, accepted),
              openCalendars: calendars.values(),
            });
          } else if (capacityBySubscription.get(entry.subscriptionId)?.has(accountId)) {
            desired.push({
              key: 'capacity',
              reason: 'capacity',
              at: firstObserved ? coverageStart : nowMs,
              openCalendars: calendars.values(),
            });
          }
          desired.push(...unsupportedBuys(version, target, account, buys, accepted, nowMs));
        }
      }
      // Only accounts the subscription actually served can later appear in accounts_unauthorized.
      if (inScope.includes(accountId) && !desired.some(item => item.media_buy_id === undefined)) target.covered = true;
      if (!options.backfillOnRegrant) recordRegrantGaps(target, account, calendars);
      return settleExclusions(target, desired, calendars.values(), nowMs, closing => {
        if (
          closing.reason !== 'overridden' ||
          !closing.overridden_by ||
          !('delivery_config_id' in closing.overridden_by)
        ) {
          return undefined;
        }
        const id = closing.overridden_by.delivery_config_id;
        const config = configsByAccount.get(accountId)?.find(item => item.delivery_config_id === id);
        return closingInstantFor(config, calendars, account);
      });
    }
  }

  /**
   * A buy-level `offering_unsupported` condition and the instant it took effect: when the
   * buy resolved before (a resolution change), the withdrawal instant of what it resolved, or
   * the observation instant for a product edit, opened at that change's E; when it never
   * resolved, from its own coverage start.
   */
  function unsupportedBuys(
    version: StoredReportingSubscriptionVersion,
    target: SubscriptionAccountState,
    account: AccountState,
    buys: readonly ReportingSubscriptionBuyV1[],
    accepted: number,
    nowMs: number
  ): DesiredExclusion[] {
    const desired: DesiredExclusion[] = [];
    const resolvedNow: Record<string, string[]> = {};
    for (const buy of buys) {
      if (buy.confirmed_at === undefined || buy.confirmed_at === null) continue;
      const resolved = resolveBuy(version, buy, nowMs);
      resolvedNow[buy.media_buy_id] = resolved;
      const unsupported = buy.packages
        .filter(pkg => resolvePackage(version, pkg.reporting_delivery_offering_ids, nowMs).length === 0)
        .map(pkg => pkg.package_id)
        .sort(compareReportingIdsByteOrderV1);
      if (unsupported.length === 0) continue;
      const before = target.resolvedBuys[buy.media_buy_id] ?? [];
      let at: number;
      let openCalendars: ReportingPeriodCalendarV1[] | undefined;
      if (before.length > 0) {
        const withdrawals = before
          .map(id => offeringsById.get(id)?.withdrawn_at)
          .filter((value): value is string => value !== undefined)
          .map(value => Date.parse(value))
          .filter(value => Number.isFinite(value) && value <= nowMs);
        at = withdrawals.length > 0 ? Math.min(...withdrawals) : nowMs;
        openCalendars = before
          .map(id => offeringsById.get(id))
          .filter((offering): offering is ReportingSubscriptionOfferingV1 => offering !== undefined)
          .map(offering => calendarFor(offering, version, account, account.timezone))
          .filter((calendar): calendar is ReportingPeriodCalendarV1 => calendar !== undefined);
      } else {
        at = Math.max(accepted, Date.parse(buy.confirmed_at));
      }
      desired.push(
        unsupported.length === buy.packages.length
          ? {
              key: `offering_unsupported:${buy.media_buy_id}`,
              reason: 'offering_unsupported',
              media_buy_id: buy.media_buy_id,
              at,
              ...(openCalendars ? { openCalendars } : {}),
            }
          : {
              key: `offering_unsupported:${buy.media_buy_id}:${unsupported.join(',')}`,
              reason: 'offering_unsupported',
              media_buy_id: buy.media_buy_id,
              package_ids: unsupported,
              at,
              ...(openCalendars ? { openCalendars } : {}),
            }
      );
    }
    target.resolvedBuys = resolvedNow;
    return desired;
  }

  /** When an override ends: the configuration's own `active_until`, on its own schedule when given. */
  function closingInstantFor(
    config: ReportingSubscriptionAccountConfigV1 | undefined,
    subscriptionCalendars: ReadonlyMap<string, ReportingPeriodCalendarV1>,
    account: AccountState
  ): number | undefined {
    if (!config?.active_until) return undefined;
    const until = parseInstant(config.active_until, `${config.delivery_config_id} active_until`);
    if (config.schedule) {
      try {
        const timezone =
          config.schedule.timezone ?? (config.schedule.alignment === 'account_timezone' ? account.timezone : undefined);
        return createReportingPeriodCalendarV1({
          period_duration: config.schedule.period_duration,
          alignment: config.schedule.alignment,
          ...(timezone !== undefined ? { timezone } : {}),
          ...(config.schedule.period_anchor !== undefined ? { period_anchor: config.schedule.period_anchor } : {}),
        }).ceil(until);
      } catch {
        // Fall through to the subscription's calendars.
      }
    }
    return cutoverInstant(subscriptionCalendars.values(), until);
  }

  function recordTimezoneChange(
    current: ReportingSubscriptionEngineAccountDocumentV1,
    history: readonly StoredReportingSubscriptionHistory[],
    account: AccountState,
    timezone: string,
    changedAt: number,
    buys: readonly ReportingSubscriptionBuyV1[]
  ) {
    for (const entry of history) {
      const version = entry.versions.at(-1)!;
      if (version.configuration.selector.period_timezone !== undefined) continue;
      const calendars = [...offeringCalendars(version, account, buys, changedAt)].filter(
        ([, calendar]) => calendar.spec.alignment === 'account_timezone'
      );
      if (calendars.length === 0) continue;
      const target = (current.subscriptions[entry.subscriptionId] ??= emptySubscriptionAccount());
      // E per offering: the end of its last old-timezone period that started before the change.
      // One account-wide entry when the offerings agree, one per offering_id otherwise.
      const ends = calendars.map(([offeringId, calendar]) => ({ offeringId, at: calendar.ceil(changedAt) }));
      const uniform = ends.every(end => end.at === ends[0]!.at);
      for (const end of uniform ? [ends[0]!] : ends) {
        target.timezoneCutovers.push({
          ...(uniform ? {} : { offering_id: end.offeringId }),
          effective_at: iso(end.at),
          timezone,
          previous_timezone: account.timezone!,
        });
      }
    }
  }

  function recordRegrantGaps(
    target: SubscriptionAccountState,
    account: AccountState,
    calendars: ReadonlyMap<string, ReportingPeriodCalendarV1>
  ) {
    for (let index = 1; index < account.grants.length; index += 1) {
      const previous = account.grants[index - 1]!;
      const grant = account.grants[index]!;
      if (previous.unauthorized_at === undefined) continue;
      const revokedAt = Date.parse(previous.unauthorized_at);
      const regrantedAt = Date.parse(grant.authorized_at);
      if (regrantedAt >= revokedAt + retentionMs) continue; // a fresh start, no gap claimed
      // Each offering's own boundaries; one account-wide entry when they agree.
      const bounds =
        calendars.size === 0
          ? [{ offeringId: undefined as string | undefined, from: revokedAt, until: regrantedAt }]
          : [...calendars].map(([offeringId, calendar]) => ({
              offeringId: offeringId as string | undefined,
              from: calendar.floor(revokedAt),
              until: calendar.ceil(regrantedAt),
            }));
      const uniform = bounds.every(bound => bound.from === bounds[0]!.from && bound.until === bounds[0]!.until);
      for (const bound of uniform ? [{ ...bounds[0]!, offeringId: undefined }] : bounds) {
        if (bound.until <= bound.from) continue;
        if (
          target.gaps.some(
            gap =>
              gap.offering_id === bound.offeringId &&
              Date.parse(gap.from) <= bound.from &&
              Date.parse(gap.until) >= bound.until
          )
        ) {
          continue;
        }
        target.gaps.push({
          ...(bound.offeringId !== undefined ? { offering_id: bound.offeringId } : {}),
          from: iso(bound.from),
          until: iso(bound.until),
          reason: 'unauthorized',
        });
      }
    }
  }

  /**
   * The subscription's buy revisions including any change since the previous reconcile, dated
   * at the E of the observation, and without revisions every period of which has left retention.
   */
  function buyRevisionsFor(
    current: ReportingSubscriptionEngineAccountDocumentV1,
    entry: StoredReportingSubscriptionHistory,
    buys: readonly ReportingSubscriptionBuyV1[],
    nowMs: number
  ): BuyRevision[] {
    const target = current.subscriptions[entry.subscriptionId];
    const revisions = (target?.buyRevisions ?? []).filter(
      revision => Date.parse(revision.effective_at) + retentionMs > nowMs
    );
    const previousBuys = current.lastBuys;
    if (!previousBuys) return revisions;
    const version = entry.versions.at(-1)!;
    const after = new Map(buys.map(buy => [buy.media_buy_id, buy]));
    for (const previous of previousBuys) {
      const next = after.get(previous.media_buy_id);
      const resolvedBefore = resolveBuy(version, previous, nowMs);
      const resolvedAfter = next ? resolveBuy(version, next, nowMs) : [];
      if (JSON.stringify(resolvedBefore) === JSON.stringify(resolvedAfter)) continue;
      const calendars = offeringCalendars(version, current.account, [previous], nowMs).values();
      revisions.push({
        media_buy_id: previous.media_buy_id,
        effective_at: iso(cutoverInstant(calendars, nowMs)),
        previous: structuredClone(previous),
      });
    }
    return revisions;
  }

  /**
   * Owed periods from the current buys, except that a period of a revised buy starting before
   * a revision's E resolves from the snapshot in force then, so periods owed before an edit
   * stay owed and periods the edit adds start at its E.
   */
  function owedWithRevisions(
    current: ReportingSubscriptionEngineAccountDocumentV1,
    entry: StoredReportingSubscriptionHistory,
    accountId: string,
    buys: readonly ReportingSubscriptionBuyV1[],
    revisions: readonly BuyRevision[],
    nowMs: number
  ): OwedSubscriptionPeriodV1[] {
    const owed = computeOwed(entry, current, accountId, buys, iso(nowMs));
    if (revisions.length === 0) return owed;
    const byBuy = new Map<string, BuyRevision[]>();
    for (const revision of revisions) {
      const list = byBuy.get(revision.media_buy_id) ?? [];
      list.push(revision);
      byBuy.set(revision.media_buy_id, list);
    }
    const periods = owed.filter(period => {
      const list = byBuy.get(period.media_buy_id);
      return !list || Date.parse(period.period_start) >= Date.parse(list.at(-1)!.effective_at);
    });
    for (const list of byBuy.values()) {
      let floor = Number.NEGATIVE_INFINITY;
      for (const revision of list) {
        const until = Date.parse(revision.effective_at);
        for (const period of computeOwed(entry, current, accountId, [revision.previous], iso(nowMs))) {
          const start = Date.parse(period.period_start);
          if (start >= floor && start < until) periods.push(period);
        }
        floor = Math.max(floor, until);
      }
    }
    return periods;
  }

  /**
   * Whether a deactivated subscription still has retained obligations on the account: an owed
   * period, frozen or still running, that ends less than `status_retention_days` ago. Only
   * periods that started before the deactivation are owed, so the set is finite.
   */
  async function hasRetainedObligations(
    principal: Readonly<PrincipalRef>,
    document: ReportingSubscriptionEngineAccountDocumentV1,
    entry: StoredReportingSubscriptionHistory,
    accountId: string,
    nowMs: number
  ): Promise<boolean> {
    const target = document.subscriptions[entry.subscriptionId]!;
    const retained = (periodEnd: string) => Date.parse(periodEnd) + retentionMs > nowMs;
    if (target.frozen.periods.some(period => retained(period.period_end))) return true;
    if (!target.covered) return false;
    // Periods not frozen yet, including one still running at the deactivation instant.
    const horizon = Math.max(nowMs, Date.parse(entry.deactivatedAt!) + 400 * DAY_MS);
    const buys = await options.hooks.listAccountBuys(principal, accountId, {});
    return computeOwed(entry, document, accountId, buys, iso(horizon)).some(period => retained(period.period_end));
  }

  /** Append periods resolved since the last freeze; never recompute earlier ones. */
  function freeze(
    current: ReportingSubscriptionEngineAccountDocumentV1,
    entry: StoredReportingSubscriptionHistory,
    accountId: string,
    buys: readonly ReportingSubscriptionBuyV1[],
    nowMs: number
  ): void {
    const target = current.subscriptions[entry.subscriptionId];
    if (!target) return;
    const through = target.frozen.through !== undefined ? Date.parse(target.frozen.through) : Number.NEGATIVE_INFINITY;
    if (nowMs > through) {
      const revisions = target.buyRevisions ?? [];
      for (const period of owedWithRevisions(current, entry, accountId, buys, revisions, nowMs)) {
        if (Date.parse(period.period_end) <= through) continue;
        const { subscription_id: _subscription, account_id: _account, ...frozen } = period;
        target.frozen.periods.push(frozen);
      }
      target.frozen.through = iso(nowMs);
    }
    // Obligation retention: periods past status_retention_days leave the queryable set. They
    // are never re-owed, because only periods ending after `through` are ever added.
    target.frozen.periods = target.frozen.periods.filter(period => Date.parse(period.period_end) + retentionMs > nowMs);
  }

  async function readbackFor(
    principal: Readonly<PrincipalRef>,
    entry: StoredReportingSubscriptionHistory,
    state: ReportingSubscriptionEngineStateV1,
    nowMs: number,
    buysByAccount: ReadonlyMap<string, ReportingSubscriptionBuyV1[]>
  ) {
    const accountsWithExceptions: NonNullable<PrincipalReportingSubscriptionState['accounts_with_exceptions']> = [];
    const accountsUnauthorized: NonNullable<PrincipalReportingSubscriptionState['accounts_unauthorized']> = [];
    for (const [accountId, document] of Object.entries(state.accounts)) {
      const target = document.subscriptions[entry.subscriptionId];
      if (!target) continue;
      const account = document.account;
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
      const calendar = primaryCalendar(offeringCalendars(version, account, buys, unauthorizedAt).values());
      const withheld = target.frozen.periods
        .filter(period => Date.parse(period.period_end) <= unauthorizedAt)
        .map(period => ({ ...period, subscription_id: entry.subscriptionId, account_id: accountId }));
      let count = 0;
      for (const period of withheld) if (!(await options.hooks.isPeriodDelivered(principal, period))) count += 1;
      accountsUnauthorized.push({
        account_id: accountId,
        unauthorized_at: grant.unauthorized_at,
        ...(calendar
          ? { last_owed_period_end: iso(calendar.floor(unauthorizedAt)) }
          : withheld.length
            ? { last_owed_period_end: latestPeriodEnd(withheld) }
            : {}),
        withheld_period_count: count,
      });
    }
    return { subscriptionId: entry.subscriptionId, accountsWithExceptions, accountsUnauthorized };
  }

  function computeOwed(
    entry: StoredReportingSubscriptionHistory,
    current: ReportingSubscriptionEngineAccountDocumentV1,
    accountId: string,
    buys: readonly ReportingSubscriptionBuyV1[],
    nowIso: string
  ): OwedSubscriptionPeriodV1[] {
    const account = current.account;
    if (account.grants.length === 0) return [];
    const target = current.subscriptions[entry.subscriptionId];
    const cutovers = target?.timezoneCutovers ?? [];
    return owedSubscriptionPeriodsV1({
      subscription_id: entry.subscriptionId,
      versions: versionRecords(entry),
      account: {
        account_id: accountId,
        ...(account.operator !== undefined ? { operator: account.operator } : {}),
        ...(account.timezone !== undefined ? { timezone: account.timezone } : {}),
        ...(account.sourceTimezone !== undefined ? { source_timezone: account.sourceTimezone } : {}),
        grants: account.grants,
      },
      buys,
      offerings: [...offeringsById.values()],
      ...(entry.inactiveIntervals.length > 0 ? { inactive_intervals: inactiveIntervals(entry) } : {}),
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
    principal: Readonly<PrincipalRef>,
    accountId: string,
    owedOptions: { now?: string; signal?: AbortSignal } = {}
  ): Promise<OwedSubscriptionPeriodV1[]> {
    const document = await readAccount(principal, accountId);
    if (!document) return [];
    const { history } = await options.principal.listReportingSubscriptions(principal);
    const nowMs = owedOptions.now !== undefined ? parseInstant(owedOptions.now, 'now') : now().getTime();
    const periods: OwedSubscriptionPeriodV1[] = [];
    let buys: ReportingSubscriptionBuyV1[] | undefined;
    for (const entry of history) {
      const target = document.subscriptions[entry.subscriptionId];
      if (!target) continue;
      for (const period of target.frozen.periods) {
        if (Date.parse(period.period_end) <= nowMs) {
          periods.push({ ...period, subscription_id: entry.subscriptionId, account_id: accountId });
        }
      }
      const through =
        target.frozen.through !== undefined ? Date.parse(target.frozen.through) : Number.NEGATIVE_INFINITY;
      if (nowMs > through) {
        buys ??= await options.hooks.listAccountBuys(
          principal,
          accountId,
          owedOptions.signal ? { signal: owedOptions.signal } : {}
        );
        const revisions = buyRevisionsFor(document, entry, buys, nowMs);
        for (const period of owedWithRevisions(document, entry, accountId, buys, revisions, nowMs)) {
          if (Date.parse(period.period_end) > through) periods.push(period);
        }
      }
    }
    return periods.sort(
      (left, right) =>
        Date.parse(left.period_start) - Date.parse(right.period_start) ||
        compareReportingIdsByteOrderV1(left.subscription_id, right.subscription_id) ||
        left.subscription_version - right.subscription_version ||
        compareReportingIdsByteOrderV1(left.offering_id, right.offering_id) ||
        compareReportingIdsByteOrderV1(left.media_buy_id, right.media_buy_id)
    );
  }

  async function inspect(principal: Readonly<PrincipalRef>): Promise<ReportingSubscriptionEngineStateV1> {
    const principalRow = await store.get(principal, PRINCIPAL_KEY);
    const accounts: Record<string, ReportingSubscriptionEngineAccountDocumentV1> = {};
    for (const accountId of await accountIds(principal)) {
      const document = await readAccount(principal, accountId);
      if (document) accounts[accountId] = document;
    }
    return {
      principal: principalRow
        ? (structuredClone(principalRow.value) as unknown as ReportingSubscriptionEnginePrincipalDocumentV1)
        : { served: {} },
      accounts,
    };
  }

  const engine: ReportingSubscriptionEngineV1 = {
    settings: Object.freeze({
      ...(options.maxAccounts !== undefined ? { maxAccounts: options.maxAccounts } : {}),
      backfillOnRegrant: options.backfillOnRegrant === true,
      statusRetentionDays: options.statusRetentionDays,
    }),
    reconcile: (principal, reconcileOptions) => reconcile(principal, reconcileOptions ?? {}),
    async authorizationChanged(principal, accountId, reported) {
      // A grant that leaves out get_reporting_status is no authority for coverage.
      const change =
        reported.authorized && reported.account && !reportingSubscriptionCoverageGrantedV1(reported.account)
          ? { ...reported, authorized: false }
          : reported;
      const at = parseInstant(change.at, 'authorizationChanged at');
      let changed = false;
      await mutate<ReportingSubscriptionEngineAccountDocumentV1 & Record<string, unknown>>(
        principal,
        `${ACCOUNT_KEY_PREFIX}${accountId}`,
        () => emptyAccountDocument() as ReportingSubscriptionEngineAccountDocumentV1 & Record<string, unknown>,
        current => {
          changed = false;
          const account = current.account;
          if (change.account?.operator !== undefined) account.operator = change.account.operator;
          if (change.account?.source_timezone !== undefined) account.sourceTimezone = change.account.source_timezone;
          const last = lastGrant(account);
          if (change.authorized) {
            if (last && last.unauthorized_at === undefined) return;
            account.grants.push({
              authorized_at: iso(Math.max(at, last?.unauthorized_at ? Date.parse(last.unauthorized_at) : at)),
            });
            account.chainStart ??= iso(at);
            changed = true;
          } else {
            if (!last || last.unauthorized_at !== undefined) return;
            last.unauthorized_at = iso(Math.max(at, Date.parse(last.authorized_at)));
            changed = true;
          }
        }
      );
      if (changed) await engine.reconcile(principal);
    },
    async subscriptionCoverage(principal, accountId) {
      const document = await readAccount(principal, accountId);
      if (!document || !isAuthorized(document.account)) return [];
      const { history } = await options.principal.listReportingSubscriptions(principal);
      const entries: ReportingSubscriptionCoverageEntryV1[] = [];
      for (const entry of history) {
        const target = document.subscriptions[entry.subscriptionId];
        if (!target) continue;
        const configuration = entry.versions.at(-1)!.configuration;
        const inScope =
          reportingSubscriptionScopeIncludesV1(
            {
              scope: configuration.scope,
              ...(configuration.exclude_account_ids ? { exclude_account_ids: configuration.exclude_account_ids } : {}),
              ...(configuration.operator_domains ? { operator_domains: configuration.operator_domains } : {}),
            },
            {
              account_id: accountId,
              ...(document.account.operator !== undefined ? { operator: document.account.operator } : {}),
            }
          ) || configuration.exclude_account_ids?.includes(accountId) === true;
        const deactivatedAt = entry.deactivatedAt;
        if (deactivatedAt !== undefined) {
          // adcp#8613: listed only while it still has retained obligations for the account.
          if (!(await hasRetainedObligations(principal, document, entry, accountId, now().getTime()))) continue;
        } else if (!inScope) {
          continue;
        }
        const open = target.exclusions.filter(item => item.until === undefined && item.media_buy_id === undefined);
        const pending = open.find(item => item.reason === 'action_required');
        entries.push({
          subscription_id: entry.subscriptionId,
          subscription_version: entry.versions.at(-1)!.subscriptionVersion,
          status:
            deactivatedAt !== undefined
              ? 'inactive'
              : pending
                ? 'action_required'
                : open.length > 0
                  ? 'excluded'
                  : 'active',
          ...(deactivatedAt !== undefined ? { deactivated_at: deactivatedAt } : {}),
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
      return groupOwedSubscriptionPeriodsV1(await owedPeriods(principal, accountId, owedOptions));
    },
    async frozenOwedSets(principal, frozenOptions = {}) {
      const { history } = await options.principal.listReportingSubscriptions(principal);
      const ids = frozenOptions.accountId !== undefined ? [frozenOptions.accountId] : await accountIds(principal);
      const sets: ReportingSubscriptionFrozenOwedSetV1[] = [];
      for (const accountId of ids) {
        const document = await readAccount(principal, accountId);
        if (!document) continue;
        for (const entry of history) {
          const target = document.subscriptions[entry.subscriptionId];
          if (!target || target.frozen.through === undefined) continue;
          const through = Date.parse(target.frozen.through);
          const periods = target.frozen.periods
            .filter(period => Date.parse(period.period_end) <= through)
            .map(period => ({ ...period, subscription_id: entry.subscriptionId, account_id: accountId }));
          sets.push({
            account_id: accountId,
            subscription_id: entry.subscriptionId,
            through: target.frozen.through,
            obligations: groupOwedSubscriptionPeriodsV1(periods),
            versions: entry.versions.map(version => ({
              subscription_version: version.subscriptionVersion,
              configuration: structuredClone(version.configuration),
              ...(version.destinationMethod ? { destination_method: structuredClone(version.destinationMethod) } : {}),
            })),
          });
        }
      }
      return sets;
    },
    async isAuthorized(principal, accountId) {
      return isAuthorized((await readAccount(principal, accountId))?.account);
    },
    async listSubscriptionPrincipals(tenantId) {
      return (await store.listPrincipals(tenantId)).filter(principal => principal.tenantId === tenantId);
    },
    async listPrincipals(tenantId) {
      return (await store.listPrincipals(tenantId)).filter(principal => principal.tenantId === tenantId);
    },
    async receiptRoster(tenantId, accountId) {
      const roster: PrincipalRef[] = [];
      for (const principal of await store.listPrincipals(tenantId)) {
        if (principal.tenantId !== tenantId) continue;
        const document = await readAccount(principal, accountId);
        if (!document || !isAuthorized(document.account)) continue;
        const { history } = await options.principal.listReportingSubscriptions(principal);
        const covers = history.some(entry => {
          if (entry.deactivatedAt !== undefined) return false;
          const target = document.subscriptions[entry.subscriptionId];
          return (
            target?.covered === true &&
            !target.exclusions.some(item => item.until === undefined && item.media_buy_id === undefined)
          );
        });
        if (covers) roster.push(principal);
      }
      return roster.sort((left, right) => compareReportingIdsByteOrderV1(left.principalId, right.principalId));
    },
    async replaceAccountConfigTargets(principal, subscriptionId) {
      const targets: string[] = [];
      for (const accountId of await accountIds(principal)) {
        const document = await readAccount(principal, accountId);
        const target = document?.subscriptions[subscriptionId];
        if (!document || !target || !isAuthorized(document.account) || !target.covered) continue;
        const blocked = target.exclusions.some(
          item =>
            item.until === undefined &&
            item.media_buy_id === undefined &&
            (item.reason === 'excluded_by_buyer' || item.reason === 'capacity' || item.reason === 'action_required')
        );
        const resolves = Object.values(target.resolvedBuys).some(ids => ids.length > 0);
        if (!blocked && resolves) targets.push(accountId);
      }
      return targets;
    },
    inspect,
  };
  return engine;
}

function stripExclusion(entry: StoredExclusion | ReportingSubscriptionExclusionV1): ReportingSubscriptionExclusionV1 {
  const { key: _key, pending_action: _pending, ...rest } = entry as StoredExclusion;
  void _key;
  void _pending;
  return structuredClone(rest);
}
