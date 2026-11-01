/**
 * `client.reporting.reconcile()` and `client.reporting.explain()` (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3): what the seller owes this buyer, period by period,
 * and why, computed from wire reads only.
 *
 * Inputs, all read under the caller's identity: `get_principal` (versions, `prior_versions[]`,
 * `inactive_intervals`, `accounts_unauthorized`), `get_adcp_capabilities` (offerings,
 * `status_retention_days`, `backfill_on_regrant`), `list_accounts` (the roster, `authorized_at`,
 * timezone, operator), `get_media_buys` per account, and `get_reporting_status` per account (the
 * `subscription_coverage` exceptions and the periods view of the ledger). Nothing is cached: the
 * roster follows the subscriptions on every run.
 *
 * Loaded on demand from `client.reporting`, so coverage stays out of the focused client's graph.
 */
import type { InputHandler, TaskOptions, TaskResult } from '../core/ConversationTypes';
import { CoverageInputError, ReportingSubscriptionError } from '../errors';
import { loadReportingLedger, type ReportingLedger } from '../reporting/reconciliation';
import {
  groupOwedSubscriptionPeriodsV1,
  owedSubscriptionPeriodsV1,
  type OwedSubscriptionObligationV1,
  type OwedSubscriptionPeriodsInputV1,
  type ReportingSubscriptionBuyV1,
} from '../reporting/subscriptions/coverage';
import {
  classifySubscriptionPeriodsV1,
  explainSubscriptionCoverageV1,
  renderCoverageExplanation,
  type CoveragePeriodSelector,
  type CoverageTrace,
} from '../reporting/subscriptions/explain';
import { reportingSubscriptionVersionRecordsV1 } from '../reporting/subscriptions/expectations';
import type { CoverageReason } from '../reporting/subscriptions/reason-codes';
import {
  compareReportingIdsByteOrderV1,
  reportingSubscriptionScopeIncludesV1,
  type ReportingSubscriptionOfferingV1,
} from '../reporting/subscriptions/selection';
import type { ReportingSubscriptionState } from '../types/core.generated';

type Json = Record<string, unknown>;
type Read = (params: Json, inputHandler?: InputHandler, options?: TaskOptions) => Promise<TaskResult<unknown>>;

/** The read tasks reconcile and explain call. Every method is a plain AdCP task on `AgentClient`. */
export interface ReportingReadClient {
  getPrincipal(params?: Json, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<unknown>>;
  listAccounts?: Read;
  getAdcpCapabilities?: Read;
  getMediaBuys?: Read;
  getReportingStatus?: Read;
  getAgentId?(): string;
}

/** Where a period stands. */
export type PeriodStatus = 'delivered' | 'pending' | 'late' | 'missing_obligation' | 'withheld' | 'not_owed';

/**
 * One period of one subscription on one account: an owed obligation with its status, or (with
 * `includeNotOwed`) a period that is not owed, with why. Keys are wire-style so exports match across
 * SDKs.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface PeriodLine {
  account_id: string;
  subscription_id: string;
  subscription_version: number;
  offering_id: string;
  report_definition_id: string;
  /** Byte-sorted, the obligation's frozen `media_buy_ids`. */
  media_buy_ids: string[];
  period: { start: string; end: string; timezone: string };
  status: PeriodStatus;
  /** The coverage reason code (`reason-codes.json`). */
  reason: CoverageReason;
  /** Who has to act: the seller for `late` and `missing_obligation`, the buyer for `withheld`. */
  responsible_party: 'seller' | 'buyer' | 'none';
  /** One sentence for a person; the same template text `explain` uses. */
  message: string;
  /** A billing cutover stub (adcp#8617). */
  stub?: true;
  /** The seller's `expected_at` for the obligation, when it has one. */
  expected_at?: string;
  reporting_obligation_id?: string;
  /** The current revision of the required finality, when delivered. */
  reporting_revision_id?: string;
  finality?: 'snapshot' | 'official';
}

/** One account the run reconciled, or could not. */
export interface ReconcileAccount {
  account_id: string;
  subscription_ids: string[];
  status: 'reconciled' | 'unauthorized' | 'failed';
  /** For `unauthorized`: when authority ended, and the seller's count of withheld periods. */
  unauthorized_at?: string;
  withheld_period_count?: number;
  /** For `failed`: what could not be read. */
  error?: { task: string; code: string; message: string };
}

/**
 * The owed set and its status for one seller.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface ReconcileReport {
  agent_id?: string;
  /** The instant the run evaluated against. */
  as_of: string;
  /** The start of the window: periods ending at or before it are left out. */
  since: string;
  /** Every account's reads completed: the roster walk, the buys and the ledger. */
  definitive: boolean;
  summary: Record<PeriodStatus, number> & { owed: number };
  periods: PeriodLine[];
  accounts: ReconcileAccount[];
}

/** Options for {@link reconcileReportingSubscriptions}. */
export interface ReconcileOptions {
  /**
   * The window start: a date (read as UTC midnight) or an instant. Defaults to the earliest
   * `accepted_at` among the subscriptions' versions, the start of retained coverage.
   */
  since?: string;
  /** `'covered'` (default): every listed account a subscription selects. Or explicit account ids. */
  accounts?: 'covered' | readonly string[];
  /** Only these subscriptions. Default: every subscription on the principal. */
  subscriptionIds?: readonly string[];
  /**
   * How long after a period ends the seller may take to plan its obligation before the period is
   * `missing_obligation`. An ISO 8601 duration; defaults to `PT1H`.
   */
  grace?: string;
  /** Add `not_owed` lines, each with its reason, for the audit trail. */
  includeNotOwed?: boolean;
  /**
   * The previous report. Accounts that have since become unauthorized are unknown to every task, so
   * their undelivered periods that ended before `unauthorized_at` are carried over from it as
   * `withheld`.
   */
  previous?: ReconcileReport;
  /** Evaluate as of this instant. Defaults to now. */
  now?: string | Date;
  /** Bounds each read, so one unresponsive seller cannot stall the report. Defaults to 30 seconds. */
  readTimeoutMilliseconds?: number;
}

/** Input to {@link explainReportingSubscriptionCoverage}. */
export interface ExplainOptions {
  accountId: string;
  /** Only this subscription. Default: every subscription that covers the account. */
  subscriptionId?: string;
  mediaBuyId?: string;
  offeringId?: string;
  /** A plain date read in the offering's zone, an instant, or `{ start, end }`. */
  period: CoveragePeriodSelector;
  now?: string | Date;
  /** Bounds each read. Defaults to 30 seconds. */
  readTimeoutMilliseconds?: number;
}

const MAX_PAGES = 1_000;
const BUY_STATUSES = ['pending_creatives', 'pending_start', 'active', 'paused', 'completed', 'rejected', 'canceled'];
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function durationMs(value: string): number {
  const match = DURATION.exec(value);
  if (!match || value === 'P' || value === 'PT') {
    throw new ReportingSubscriptionError(
      'INVALID_REQUEST',
      `grace ${JSON.stringify(value)} is not a fixed-length ISO 8601 duration. Pass one such as PT1H or P1D.`,
      { dispatched: false }
    );
  }
  const [, days, hours, minutes, seconds] = match.map(part => Number(part ?? 0)) as number[];
  return (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1_000;
}

function instantOf(value: string | Date | undefined, field: string): number {
  if (value === undefined) return Date.now();
  const parsed =
    value instanceof Date
      ? value.getTime()
      : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(parsed)) {
    throw new ReportingSubscriptionError('INVALID_REQUEST', `${field} must be a date or an RFC 3339 instant.`, {
      dispatched: false,
    });
  }
  return parsed;
}

const iso = (value: number): string => new Date(value).toISOString();

class ReadFailure extends Error {
  constructor(
    readonly task: string,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const TASK_METHODS = [
  'getPrincipal',
  'listAccounts',
  'getAdcpCapabilities',
  'getMediaBuys',
  'getReportingStatus',
] as const;

/** The client with every read bounded: a read that does not answer in time fails as `TIMEOUT`. */
function withReadTimeout(client: ReportingReadClient, milliseconds: number | undefined): ReportingReadClient {
  const limit = milliseconds ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ReportingSubscriptionError('INVALID_REQUEST', 'readTimeoutMilliseconds must be a positive integer.', {
      dispatched: false,
    });
  }
  const bounded: Record<string, unknown> = { getAgentId: client.getAgentId?.bind(client) };
  for (const name of TASK_METHODS) {
    const method = client[name] as Read | undefined;
    if (!method) continue;
    bounded[name] = async (params: Json) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          method.call(client, params),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const task = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
              reject(new ReadFailure(task, 'TIMEOUT', `${task} did not answer within ${limit} ms`));
            }, limit);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
  }
  return bounded as unknown as ReportingReadClient;
}

async function read(task: string, method: Read | undefined, client: unknown, params: Json): Promise<Json> {
  if (!method) throw new ReadFailure(task, 'UNSUPPORTED_FEATURE', `The client has no ${task} method`);
  const result = await method.call(client, params);
  if (!result.success || !result.data) {
    throw new ReadFailure(task, 'TASK_FAILED', `${task} failed: ${result.error ?? 'no response'}`);
  }
  const data = result.data as Json;
  if (data.status === 'failed' || (Array.isArray(data.errors) && data.errors.length > 0 && !('accounts' in data))) {
    const first = (data.errors as Json[] | undefined)?.[0];
    throw new ReadFailure(
      task,
      String(first?.code ?? 'TASK_FAILED'),
      `${task} failed: ${String(first?.message ?? 'error')}`
    );
  }
  return data;
}

interface Principal {
  subscriptions: ReportingSubscriptionState[];
  destinations: Map<string, { pattern: string; transport: string }>;
}

async function readPrincipal(client: ReportingReadClient): Promise<Principal> {
  let data: Json;
  try {
    data = await read('get_principal', client.getPrincipal as Read, client, {});
  } catch (error) {
    throw new ReportingSubscriptionError(
      error instanceof ReadFailure ? error.code : 'INVALID_REQUEST',
      `${error instanceof Error ? error.message : String(error)}. Retry once the seller is reachable.`,
      { recovery: 'transient', cause: error }
    );
  }
  const outcome = (data.result ?? {}) as Json;
  const configuration = (outcome.configuration ?? {}) as Json;
  const destinations = new Map<string, { pattern: string; transport: string }>();
  for (const item of (configuration.reporting_destinations as Json[] | undefined) ?? []) {
    const destination = ((item.configuration as Json | undefined) ?? item) as Json;
    if (typeof destination.destination_id === 'string') {
      destinations.set(destination.destination_id, {
        pattern: String(destination.pattern),
        transport: String(destination.transport),
      });
    }
  }
  return {
    subscriptions: [...((configuration.reporting_subscriptions as ReportingSubscriptionState[] | undefined) ?? [])],
    destinations,
  };
}

interface Seller {
  offerings: ReportingSubscriptionOfferingV1[];
  statusRetentionDays?: number;
  backfillOnRegrant: boolean;
}

async function readSeller(client: ReportingReadClient): Promise<Seller> {
  const data = await read('get_adcp_capabilities', client.getAdcpCapabilities, client, {});
  const delivery = ((data.media_buy as Json | undefined)?.reporting_delivery ?? {}) as Json;
  return {
    offerings: ((delivery.offerings as ReportingSubscriptionOfferingV1[] | undefined) ?? []).filter(offering =>
      Array.isArray(offering.standard_dimensions)
    ),
    ...(typeof delivery.status_retention_days === 'number'
      ? { statusRetentionDays: delivery.status_retention_days }
      : {}),
    backfillOnRegrant: (delivery.subscriptions as Json | undefined)?.backfill_on_regrant === true,
  };
}

/** Every listed account, or a ReadFailure: a partial roster is never used. */
async function readRoster(client: ReportingReadClient): Promise<Json[]> {
  const accounts: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await read('list_accounts', client.listAccounts, client, cursor ? { pagination: { cursor } } : {});
    accounts.push(...((data.accounts as Json[] | undefined) ?? []));
    const pagination = data.pagination as { has_more?: boolean; cursor?: string } | undefined;
    cursor = pagination?.has_more ? pagination.cursor : undefined;
    if (!cursor) return accounts;
  }
  throw new ReadFailure('list_accounts', 'LIMIT_EXCEEDED', `list_accounts did not finish within ${MAX_PAGES} pages`);
}

function toBuy(
  raw: Json,
  offerings: readonly ReportingSubscriptionOfferingV1[]
): ReportingSubscriptionBuyV1 | undefined {
  if (typeof raw.media_buy_id !== 'string' || typeof raw.start_time !== 'string' || typeof raw.end_time !== 'string') {
    return undefined;
  }
  const cancellation = (raw.cancellation ?? {}) as { canceled_at?: string };
  const every = offerings.map(offering => offering.offering_id);
  const history = Array.isArray(raw.flight_history)
    ? (raw.flight_history as Json[]).filter(
        entry =>
          typeof entry.recorded_at === 'string' &&
          typeof entry.start_time === 'string' &&
          typeof entry.stop_time === 'string'
      )
    : [];
  return {
    media_buy_id: raw.media_buy_id,
    confirmed_at: (raw.confirmed_at as string | null | undefined) ?? null,
    start_time: raw.start_time,
    end_time: raw.end_time,
    ...(cancellation.canceled_at ? { canceled_at: cancellation.canceled_at } : {}),
    ...(typeof raw.cancellation_effective_at === 'string'
      ? { cancellation_effective_at: raw.cancellation_effective_at }
      : {}),
    ...(typeof raw.completed_at === 'string' ? { completed_at: raw.completed_at } : {}),
    ...(history.length > 0
      ? {
          flight_history: history.map(entry => ({
            recorded_at: entry.recorded_at as string,
            start_time: entry.start_time as string,
            stop_time: entry.stop_time as string,
          })),
        }
      : {}),
    // adcp#8618: each package's offering snapshot; a seller that omits it is read as every offering.
    packages: ((raw.packages as Json[] | undefined) ?? [])
      .filter(item => typeof item.package_id === 'string')
      .map(item => ({
        package_id: item.package_id as string,
        reporting_delivery_offering_ids: Array.isArray(item.reporting_delivery_offering_ids)
          ? [...(item.reporting_delivery_offering_ids as string[])]
          : every,
      })),
  };
}

async function readBuys(
  client: ReportingReadClient,
  accountId: string,
  offerings: readonly ReportingSubscriptionOfferingV1[]
): Promise<ReportingSubscriptionBuyV1[]> {
  const buys: ReportingSubscriptionBuyV1[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await read('get_media_buys', client.getMediaBuys, client, {
      account: { account_id: accountId },
      status_filter: BUY_STATUSES,
      ...(cursor ? { pagination: { cursor } } : {}),
    });
    for (const raw of (data.media_buys as Json[] | undefined) ?? []) {
      const buy = toBuy(raw, offerings);
      if (buy && !buys.some(item => item.media_buy_id === buy.media_buy_id)) buys.push(buy);
    }
    const pagination = data.pagination as { has_more?: boolean; cursor?: string } | undefined;
    cursor = pagination?.has_more ? pagination.cursor : undefined;
    if (!cursor) return buys;
  }
  throw new ReadFailure('get_media_buys', 'LIMIT_EXCEEDED', `get_media_buys did not finish within ${MAX_PAGES} pages`);
}

async function readCoverage(client: ReportingReadClient, accountId: string): Promise<Map<string, Json>> {
  const data = await read('get_reporting_status', client.getReportingStatus, client, {
    account: { account_id: accountId },
    view: 'summary',
  });
  return new Map(
    ((data.subscription_coverage as Json[] | undefined) ?? []).map(entry => [String(entry.subscription_id), entry])
  );
}

function ledgerClient(client: ReportingReadClient) {
  return {
    getReportingStatus: async (params: unknown) => {
      if (!client.getReportingStatus) throw new ReadFailure('get_reporting_status', 'UNSUPPORTED_FEATURE', 'no method');
      const result = await client.getReportingStatus(params as Json);
      if (!result.success || !result.data) {
        throw new ReadFailure('get_reporting_status', 'TASK_FAILED', `get_reporting_status failed: ${result.error}`);
      }
      return result.data as never;
    },
    syncReportingReceipts: async () => {
      throw new Error('reconcile never writes receipts');
    },
  };
}

/** The coverage input for one subscription on one account, from wire reads. */
function coverageInput(
  state: ReportingSubscriptionState,
  principal: Principal,
  seller: Seller,
  account: Json,
  buys: ReportingSubscriptionBuyV1[],
  coverage: Json | undefined,
  now: number
): OwedSubscriptionPeriodsInputV1 {
  const authorization = (account.authorization ?? {}) as { authorized_at?: string };
  const unauthorized = (state.accounts_unauthorized ?? []).find(item => item.account_id === account.account_id) as
    | { unauthorized_at?: string }
    | undefined;
  const destinationMethods: Record<number, { pattern: string; transport: string }> = {};
  const versions = [
    ...(state.prior_versions ?? []).map(prior => ({
      version: prior.subscription_version,
      configuration: prior.configuration,
    })),
    { version: state.subscription_version, configuration: state.configuration },
  ];
  for (const { version, configuration } of versions) {
    const id = (configuration as { destination?: { destination_id?: string } } | undefined)?.destination
      ?.destination_id;
    const method = id ? principal.destinations.get(id) : undefined;
    if (method) destinationMethods[version] = method;
  }
  return {
    subscription_id: state.subscription_id,
    versions: reportingSubscriptionVersionRecordsV1({ state, destinationMethods }),
    account: {
      account_id: String(account.account_id),
      ...(typeof account.operator === 'string' ? { operator: account.operator } : {}),
      ...(typeof account.timezone === 'string' ? { timezone: account.timezone } : {}),
      grants: authorization.authorized_at
        ? [
            {
              authorized_at: authorization.authorized_at,
              ...(unauthorized?.unauthorized_at ? { unauthorized_at: unauthorized.unauthorized_at } : {}),
            },
          ]
        : [],
    },
    buys,
    offerings: seller.offerings,
    ...(state.inactive_intervals ? { inactive_intervals: state.inactive_intervals } : {}),
    ...(coverage
      ? {
          coverage: {
            ...(coverage.excluded ? { excluded: coverage.excluded } : {}),
            ...(coverage.gaps ? { gaps: coverage.gaps } : {}),
            ...(coverage.timezone_cutovers ? { timezone_cutovers: coverage.timezone_cutovers } : {}),
          } as OwedSubscriptionPeriodsInputV1['coverage'],
        }
      : {}),
    backfill_on_regrant: seller.backfillOnRegrant,
    ...(seller.statusRetentionDays !== undefined ? { status_retention_days: seller.statusRetentionDays } : {}),
    now: iso(now),
  };
}

/** Whether any version of a subscription selects the account (its operator included). */
function selects(state: ReportingSubscriptionState, account: Json): boolean {
  const scopeAccount = {
    account_id: String(account.account_id),
    ...(typeof account.operator === 'string' ? { operator: account.operator } : {}),
  };
  return [state.configuration, ...(state.prior_versions ?? []).map(prior => prior.configuration)].some(
    configuration => configuration !== undefined && reportingSubscriptionScopeIncludesV1(configuration, scopeAccount)
  );
}

function timezoneOf(
  offering: ReportingSubscriptionOfferingV1 | undefined,
  account: Json,
  periodTimezone: string | undefined
): string {
  const schedule = offering?.schedule as { alignment?: string; period_timezone?: string } | undefined;
  if (!schedule || schedule.alignment === 'utc') return 'UTC';
  if (schedule.alignment === 'account_timezone') return periodTimezone ?? String(account.timezone ?? 'UTC');
  return schedule.period_timezone ?? 'UTC';
}

interface Revision {
  reporting_revision_id: string;
  finality: 'snapshot' | 'official';
  created_at?: string;
  supersedes_reporting_revision_id?: string;
}

/** Status of one owed obligation against the seller's ledger. */
function statusOf(
  owed: OwedSubscriptionObligationV1,
  ledger: ReportingLedger | undefined,
  now: number,
  graceMs: number
): Pick<
  PeriodLine,
  'status' | 'responsible_party' | 'expected_at' | 'reporting_obligation_id' | 'reporting_revision_id' | 'finality'
> {
  const start = Date.parse(owed.period_start);
  const end = Date.parse(owed.period_end);
  const obligation = ledger?.obligations.find(
    item =>
      item.delivery_config_id === owed.subscription_id &&
      item.delivery_config_version === owed.subscription_version &&
      (item.offering_id === undefined || item.offering_id === owed.offering_id) &&
      Date.parse(item.period.start) === start &&
      Date.parse(item.period.end) === end
  );
  if (!obligation) {
    return now < end + graceMs
      ? { status: 'pending', responsible_party: 'none' }
      : { status: 'missing_obligation', responsible_party: 'seller' };
  }
  const buys = [...obligation.media_buy_ids].sort().join('\n');
  const revisions = ((ledger?.revisions ?? []) as unknown as Array<Revision & Json>).filter(
    revision =>
      revision.report_definition_id === obligation.report_definition_id &&
      Array.isArray(revision.media_buy_ids) &&
      [...(revision.media_buy_ids as string[])].sort().join('\n') === buys &&
      Date.parse((revision.period as { start: string }).start) === start &&
      Date.parse((revision.period as { end: string }).end) === end
  );
  const superseded = new Set(revisions.map(revision => revision.supersedes_reporting_revision_id).filter(Boolean));
  const current = revisions
    .filter(revision => !superseded.has(revision.reporting_revision_id))
    .filter(revision => obligation.required_finality !== 'official' || revision.finality === 'official')
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0];
  const base = { reporting_obligation_id: obligation.reporting_obligation_id, expected_at: obligation.expected_at };
  if (current) {
    return {
      ...base,
      status: 'delivered',
      responsible_party: 'none',
      reporting_revision_id: current.reporting_revision_id,
      finality: current.finality,
    };
  }
  if (obligation.health === 'action_required') {
    const party = (obligation.issues ?? [])[0] as { responsible_party?: string } | undefined;
    return { ...base, status: 'late', responsible_party: party?.responsible_party === 'buyer' ? 'buyer' : 'seller' };
  }
  if (now > Date.parse(obligation.expected_at) || obligation.health === 'delayed') {
    return { ...base, status: 'late', responsible_party: 'seller' };
  }
  return { ...base, status: 'pending', responsible_party: 'none' };
}

/** The period end plus the offering's `delivery_sla`, when no obligation states `expected_at`. */
function expectedAt(offering: ReportingSubscriptionOfferingV1 | undefined, periodEnd: string): string | null {
  try {
    return offering ? iso(Date.parse(periodEnd) + durationMs(offering.schedule.delivery_sla)) : null;
  } catch {
    return null;
  }
}

function emptySummary(): ReconcileReport['summary'] {
  return { owed: 0, delivered: 0, pending: 0, late: 0, missing_obligation: 0, withheld: 0, not_owed: 0 };
}

function failure(error: unknown, fallbackTask: string): NonNullable<ReconcileAccount['error']> {
  if (error instanceof ReadFailure) return { task: error.task, code: error.code, message: error.message };
  if (error instanceof CoverageInputError) return { task: 'coverage', code: error.code, message: error.message };
  return { task: fallbackTask, code: 'TASK_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Reconcile one seller: the owed periods of every subscription on every covered account, each with
 * its status, reason and responsible party.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export async function reconcileReportingSubscriptions(
  wireClient: ReportingReadClient,
  options: ReconcileOptions = {}
): Promise<ReconcileReport> {
  return reconcileObserved(wireClient, options);
}

/**
 * What a reconcile run read besides its report: the subscriptions, and per account the
 * `list_accounts` authorization and the `subscription_coverage[]` entries. Events derive from it.
 *
 * @internal
 */
export interface ReconcileObservation {
  subscriptions: ReportingSubscriptionState[];
  accounts: Map<string, { authorization?: Json; coverage: Map<string, Json> }>;
}

/** @internal `reconcileReportingSubscriptions`, also filling `observation`. */
export async function reconcileObserved(
  wireClient: ReportingReadClient,
  options: ReconcileOptions = {},
  observation?: ReconcileObservation
): Promise<ReconcileReport> {
  const client = withReadTimeout(wireClient, options.readTimeoutMilliseconds);
  const now = instantOf(options.now, 'now');
  const graceMs = durationMs(options.grace ?? 'PT1H');
  const principal = await readPrincipal(client);
  const subscriptions = principal.subscriptions.filter(
    state => options.subscriptionIds === undefined || options.subscriptionIds.includes(state.subscription_id)
  );
  if (observation) observation.subscriptions = subscriptions;
  const earliest = Math.min(
    ...subscriptions.flatMap(state => [
      Date.parse(state.accepted_at),
      ...(state.prior_versions ?? []).map(prior => Date.parse(prior.accepted_at)),
    ])
  );
  const since =
    options.since !== undefined ? instantOf(options.since, 'since') : Number.isFinite(earliest) ? earliest : now;
  const agentId = client.getAgentId?.();
  const report: ReconcileReport = {
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    as_of: iso(now),
    since: iso(since),
    definitive: true,
    summary: emptySummary(),
    periods: [],
    accounts: [],
  };
  if (subscriptions.length === 0) return report;

  let seller: Seller;
  let roster: Json[];
  try {
    seller = await readSeller(client);
    roster = await readRoster(client);
  } catch (error) {
    report.definitive = false;
    report.accounts.push({
      account_id: '*',
      subscription_ids: [],
      status: 'failed',
      error: failure(error, 'list_accounts'),
    });
    return report;
  }

  const wanted = (accountId: string) =>
    options.accounts === undefined || options.accounts === 'covered' || options.accounts.includes(accountId);
  const covered = roster
    .filter(account => typeof account.account_id === 'string' && wanted(account.account_id))
    .map(account => ({ account, states: subscriptions.filter(state => selects(state, account)) }))
    .filter(entry => entry.states.length > 0)
    .sort((left, right) =>
      compareReportingIdsByteOrderV1(String(left.account.account_id), String(right.account.account_id))
    );

  for (const { account, states } of covered) {
    const accountId = String(account.account_id);
    const entry: ReconcileAccount = {
      account_id: accountId,
      subscription_ids: states.map(state => state.subscription_id).sort(compareReportingIdsByteOrderV1),
      status: 'reconciled',
    };
    try {
      const buys = await readBuys(client, accountId, seller.offerings);
      const coverage = await readCoverage(client, accountId);
      observation?.accounts.set(accountId, {
        ...(account.authorization && typeof account.authorization === 'object'
          ? { authorization: account.authorization as Json }
          : {}),
        coverage,
      });
      // The whole window, not the seller's default horizon; no delivery_config_ids filter, which a
      // seller refuses for a subscription with no obligation yet.
      const ledger = await loadReportingLedger(ledgerClient(client), {
        account: { account_id: accountId },
        period: { start: iso(since), end: iso(Math.max(now, since + 1)) },
      } as never);
      for (const state of states) {
        const input = coverageInput(state, principal, seller, account, buys, coverage.get(state.subscription_id), now);
        const owed = owedSubscriptionPeriodsV1(input).filter(row => Date.parse(row.period_end) > since);
        for (const obligation of groupOwedSubscriptionPeriodsV1(owed)) {
          const offering = seller.offerings.find(item => item.offering_id === obligation.offering_id);
          const version = input.versions.find(item => item.subscription_version === obligation.subscription_version);
          const timezone = timezoneOf(offering, account, version?.configuration.selector.period_timezone);
          const status = statusOf(obligation, ledger, now, graceMs);

          report.periods.push({
            account_id: accountId,
            subscription_id: obligation.subscription_id,
            subscription_version: obligation.subscription_version,
            offering_id: obligation.offering_id,
            report_definition_id: obligation.report_definition_id,
            media_buy_ids: obligation.media_buy_ids,
            period: { start: obligation.period_start, end: obligation.period_end, timezone },
            ...status,
            reason: 'owed',
            message: statusMessage(
              status.status,
              renderCoverageExplanation(
                'owed',
                {
                  account_id: accountId,
                  subscription_id: obligation.subscription_id,
                  subscription_version: obligation.subscription_version,
                  media_buy_id: obligation.media_buy_ids.join(', '),
                  offering_id: obligation.offering_id,
                  period: { start: obligation.period_start, end: obligation.period_end, timezone },
                },
                { expected_at: status.expected_at ?? expectedAt(offering, obligation.period_end) }
              ),
              status,
              obligation
            ),
            ...(obligation.stub ? { stub: true as const } : {}),
          });
        }
        if (options.includeNotOwed) {
          const seen = new Set<string>();
          for (const row of classifySubscriptionPeriodsV1({ ...input, from: iso(since) })) {
            if (row.verdict === 'owed') continue;
            const key = JSON.stringify([
              row.subscription_version,
              row.offering_id,
              row.period_start,
              row.period_end,
              row.reason,
            ]);
            const line = report.periods.find(
              item =>
                item.status === 'not_owed' &&
                JSON.stringify([
                  item.subscription_version,
                  item.offering_id,
                  item.period.start,
                  item.period.end,
                  item.reason,
                ]) === key &&
                item.account_id === accountId &&
                item.subscription_id === row.subscription_id
            );
            if (line) {
              if (!line.media_buy_ids.includes(row.media_buy_id)) {
                line.media_buy_ids = [...line.media_buy_ids, row.media_buy_id].sort(compareReportingIdsByteOrderV1);
              }
              continue;
            }
            if (seen.has(`${key}|${row.media_buy_id}`)) continue;
            seen.add(`${key}|${row.media_buy_id}`);
            report.periods.push({
              account_id: accountId,
              subscription_id: row.subscription_id,
              subscription_version: row.subscription_version,
              offering_id: row.offering_id,
              report_definition_id: row.report_definition_id,
              media_buy_ids: [row.media_buy_id],
              period: { start: row.period_start, end: row.period_end, timezone: row.timezone },
              status: 'not_owed',
              reason: row.reason,
              responsible_party: 'none',
              message: row.explanation,
            });
          }
        }
      }
    } catch (error) {
      report.definitive = false;
      entry.status = 'failed';
      entry.error = failure(error, 'get_reporting_status');
    }
    report.accounts.push(entry);
  }

  // Accounts whose authority ended are unknown to every task: report them, and carry their
  // undelivered periods over from the previous report as withheld.
  for (const state of subscriptions) {
    for (const lost of state.accounts_unauthorized ?? []) {
      const item = lost as { account_id: string; unauthorized_at: string; withheld_period_count?: number };
      if (!wanted(item.account_id) || covered.some(entry => entry.account.account_id === item.account_id)) continue;
      let entry = report.accounts.find(candidate => candidate.account_id === item.account_id);
      if (!entry) {
        entry = {
          account_id: item.account_id,
          subscription_ids: [],
          status: 'unauthorized',
          unauthorized_at: item.unauthorized_at,
          withheld_period_count: 0,
        };
        report.accounts.push(entry);
      }
      entry.subscription_ids = [...new Set([...entry.subscription_ids, state.subscription_id])].sort(
        compareReportingIdsByteOrderV1
      );
      entry.withheld_period_count = (entry.withheld_period_count ?? 0) + (item.withheld_period_count ?? 0);
      const unauthorizedAt = Date.parse(item.unauthorized_at);
      for (const line of options.previous?.periods ?? []) {
        if (
          line.account_id !== item.account_id ||
          line.subscription_id !== state.subscription_id ||
          line.status === 'delivered' ||
          line.status === 'not_owed' ||
          Date.parse(line.period.end) > unauthorizedAt ||
          Date.parse(line.period.end) <= since
        ) {
          continue;
        }
        report.periods.push({
          ...structuredClone(line),
          status: 'withheld',
          reason: 'owed:withheld',
          responsible_party: 'buyer',
          message: renderCoverageExplanation(
            'owed:withheld',
            {
              account_id: item.account_id,
              subscription_id: line.subscription_id,
              subscription_version: line.subscription_version,
              media_buy_id: line.media_buy_ids.join(', '),
              offering_id: line.offering_id,
              period: line.period,
            },
            { unauthorized_at: item.unauthorized_at }
          ),
        });
      }
    }
  }

  report.accounts.sort((left, right) => compareReportingIdsByteOrderV1(left.account_id, right.account_id));
  report.periods.sort(
    (left, right) =>
      compareReportingIdsByteOrderV1(left.account_id, right.account_id) ||
      Date.parse(left.period.start) - Date.parse(right.period.start) ||
      compareReportingIdsByteOrderV1(left.subscription_id, right.subscription_id) ||
      left.subscription_version - right.subscription_version ||
      compareReportingIdsByteOrderV1(left.offering_id, right.offering_id)
  );
  for (const line of report.periods) {
    report.summary[line.status] += 1;
    if (line.status !== 'not_owed') report.summary.owed += 1;
  }
  return report;
}

function statusMessage(
  status: PeriodStatus,
  owed: string,
  facts: { expected_at?: string; responsible_party: string },
  obligation: OwedSubscriptionObligationV1
): string {
  switch (status) {
    case 'delivered':
      return `${owed} Delivered.`;
    case 'pending':
      return facts.expected_at
        ? `${owed} The seller expects to deliver it by ${facts.expected_at}.`
        : `${owed} The seller has not planned it yet, inside the grace period.`;
    case 'late':
      return facts.responsible_party === 'buyer'
        ? `${owed} The seller is waiting on an action from the buyer.`
        : `${owed} It was due at ${facts.expected_at} and has not been delivered.`;
    case 'missing_obligation':
      return `${owed} The seller has no obligation for it, past the grace period after ${obligation.period_end}.`;
    default:
      return owed;
  }
}

/**
 * Explain one account's coverage for a period: one `CoverageTrace` (with `side: 'buyer'`) per
 * subscription, buy and offering the selection names.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export async function explainReportingSubscriptionCoverage(
  wireClient: ReportingReadClient,
  options: ExplainOptions
): Promise<CoverageTrace[]> {
  const client = withReadTimeout(wireClient, options.readTimeoutMilliseconds);
  if (typeof options.accountId !== 'string' || options.accountId.length === 0) {
    throw new ReportingSubscriptionError('INVALID_REQUEST', 'explain needs accountId. Pass the account to explain.', {
      dispatched: false,
    });
  }
  const now = instantOf(options.now, 'now');
  const principal = await readPrincipal(client);
  const states = principal.subscriptions.filter(
    state => options.subscriptionId === undefined || state.subscription_id === options.subscriptionId
  );
  if (options.subscriptionId !== undefined && states.length === 0) {
    throw new ReportingSubscriptionError(
      'INVALID_REQUEST',
      `No subscription ${JSON.stringify(options.subscriptionId)} exists for this principal. Check listSubscriptions() for the ids.`,
      { dispatched: false }
    );
  }
  try {
    const seller = await readSeller(client);
    const account = (await readRoster(client)).find(item => item.account_id === options.accountId);
    if (!account) {
      throw new ReportingSubscriptionError(
        'INVALID_REQUEST',
        `Account ${JSON.stringify(options.accountId)} is not listed by list_accounts for this caller. Check the account id, or whether authority was revoked.`
      );
    }
    const buys = await readBuys(client, options.accountId, seller.offerings);
    const coverage = await readCoverage(client, options.accountId);
    const traces: CoverageTrace[] = [];
    for (const state of states) {
      if (!selects(state, account) && options.subscriptionId === undefined) continue;
      const input = coverageInput(state, principal, seller, account, buys, coverage.get(state.subscription_id), now);
      traces.push(
        ...explainSubscriptionCoverageV1({
          ...input,
          period: options.period,
          ...(options.mediaBuyId !== undefined ? { media_buy_id: options.mediaBuyId } : {}),
          ...(options.offeringId !== undefined ? { offering_id: options.offeringId } : {}),
          side: 'buyer',
        })
      );
    }
    return traces;
  } catch (error) {
    if (error instanceof ReadFailure) {
      throw new ReportingSubscriptionError(error.code, `${error.message}. Retry once the seller is reachable.`, {
        recovery: 'transient',
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Reconcile across sellers: one report per agent, and the summed summary.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface FleetReconcileReport {
  bySeller: Record<string, ReconcileReport>;
  /** Agents whose principal could not be read; their periods are not in the summary. */
  failures: Record<string, { code: string; message: string }>;
  /** Every seller's report is definitive and none failed. */
  definitive: boolean;
  summary: ReconcileReport['summary'];
}

/** Options for {@link reconcileReportingFleet}. */
export interface FleetReconcileOptions extends Omit<ReconcileOptions, 'previous'> {
  /** Only these agents. Default: every configured agent. */
  agentIds?: readonly string[];
  /** Sellers reconciled at once. Defaults to 4. */
  concurrency?: number;
  previous?: FleetReconcileReport;
}

/**
 * `multiClient.reporting.reconcile()`: reconcile each seller with bounded concurrency.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export async function reconcileReportingFleet(
  clients: ReadonlyArray<readonly [string, ReportingReadClient]>,
  options: FleetReconcileOptions = {}
): Promise<FleetReconcileReport> {
  const { agentIds, concurrency = 4, previous, ...rest } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new ReportingSubscriptionError('INVALID_REQUEST', 'concurrency must be a positive integer.', {
      dispatched: false,
    });
  }
  const selected = clients.filter(([id]) => agentIds === undefined || agentIds.includes(id));
  const fleet: FleetReconcileReport = { bySeller: {}, failures: {}, definitive: true, summary: emptySummary() };
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const [id, client] = selected[next++]!;
      try {
        const prior = previous?.bySeller[id];
        fleet.bySeller[id] = await reconcileReportingSubscriptions(client, {
          ...rest,
          ...(prior ? { previous: prior } : {}),
        });
      } catch (error) {
        fleet.failures[id] = {
          code: (error as { code?: string }).code ?? 'TASK_FAILED',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
  for (const report of Object.values(fleet.bySeller)) {
    if (!report.definitive) fleet.definitive = false;
    for (const key of Object.keys(fleet.summary) as Array<keyof ReconcileReport['summary']>) {
      fleet.summary[key] += report.summary[key];
    }
  }
  if (Object.keys(fleet.failures).length > 0) fleet.definitive = false;
  return fleet;
}
