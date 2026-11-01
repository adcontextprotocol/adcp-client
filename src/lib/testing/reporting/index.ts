/**
 * The reporting-subscription test kit (experimental `media_buy.reporting_subscriptions`, AdCP 3.3):
 * an in-process managed seller on a virtual clock, buyers bound to it, and the levers coverage
 * depends on (grants, account timezone, buys, time), with `assertAgreement` checking that what the
 * seller owes equals what the buyer computes.
 *
 * ```ts
 * import { createReportingTestKit, offerings } from '@adcp/sdk/testing/reporting';
 *
 * const kit = createReportingTestKit({
 *   start: reportingTestStart(30), // the virtual clock never passes the real one
 *   offerings: [offerings.dailyAnalytics()],
 *   accounts: [{ account_id: 'acc_a', timezone: 'America/New_York', grants: ['agency-x'] }],
 *   buys: [{ media_buy_id: 'mb_1', account_id: 'acc_a', confirmed_at: '2026-11-01T15:00:00Z',
 *            start_time: '2026-11-02T00:00:00Z', end_time: '2026-11-30T00:00:00Z' }],
 * });
 * const buyer = kit.buyer('agency-x');
 * await buyer.reporting.subscribe(analyticsDaily);
 * await kit.clock.advance('P3D');      // runs the seller's cycle at every boundary crossed
 * await kit.grants.revoke('agency-x', 'acc_a');
 * await kit.assertAgreement('agency-x');
 * ```
 *
 * Every export is experimental: breaking changes may ship in minor releases.
 *
 * @experimental
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { TaskResult } from '../../core/ConversationTypes';
import { ReportingClient } from '../../principal/reporting-facade';
import type { ReconcileReport } from '../../principal/reporting-reconcile';
import { createReliableReportingService, type ReliableReportingServiceV1 } from '../../reporting/service';
import { redactedReportingSourceOfferingV1, redactedReportingSourceRequestV1 } from '../../reporting/source/fixtures';
import { createReportingPeriodCalendarV1 } from '../../reporting/subscriptions/calendar';
import { diffCoverageTraces } from '../../reporting/subscriptions/explain';
import { REPORTING_WIND_DOWN_TASKS } from '../../server/decisioning/account';
import { createAdcpServerFromPlatform } from '../../server/decisioning/runtime/from-platform';
import { memoryStorage, type ReportingStorage } from '../../storage';
import type { ReportingDeliveryOffering } from '../../types/tools.generated';

type Json = Record<string, unknown>;

/** A delivery offering the reference seller serves, built by {@link offerings}. */
export type ReportingTestOffering = ReportingDeliveryOffering;

/** One advertiser account in the kit. */
export interface ReportingTestAccount {
  account_id: string;
  /** IANA zone, served on `list_accounts`. */
  timezone: string;
  operator?: string;
  /** Buyers granted reporting on it at the start (`authorized_at` = the kit's start). */
  grants?: readonly string[];
}

/** One media buy in the kit, as `get_media_buys` returns it. */
export interface ReportingTestBuy {
  media_buy_id: string;
  account_id: string;
  /** Null while not confirmed. */
  confirmed_at: string | null;
  start_time: string;
  end_time: string;
  /** Defaults to one package listing every offering. */
  packages?: Array<{ package_id: string; reporting_delivery_offering_ids?: string[] }>;
}

/** Options for {@link createReportingTestKit} and {@link createReferenceReportingSeller}. */
export interface ReportingTestKitOptions {
  /** The virtual clock's start. */
  start: string;
  offerings?: ReportingTestOffering[];
  accounts?: ReportingTestAccount[];
  buys?: ReportingTestBuy[];
  /** The seller's tenant. Defaults to `reference`. */
  tenantId?: string;
  /** `subscriptions.max_accounts`. Defaults to 100. */
  maxAccounts?: number;
}

/** A buyer bound to the kit's seller: the task methods `client.reporting` needs, plus `reporting`. */
export interface ReportingTestBuyer {
  readonly id: string;
  readonly reporting: ReportingClient;
  call(task: string, args?: Json): Promise<TaskResult<unknown>>;
  getPrincipal(params?: Json): Promise<TaskResult<unknown>>;
  syncPrincipal(params: Json): Promise<TaskResult<unknown>>;
  listAccounts(params?: Json): Promise<TaskResult<unknown>>;
  getAdcpCapabilities(params?: Json): Promise<TaskResult<unknown>>;
  getMediaBuys(params: Json): Promise<TaskResult<unknown>>;
  getReportingStatus(params: Json): Promise<TaskResult<unknown>>;
  syncReportingReceipts(params: Json): Promise<TaskResult<unknown>>;
  getAgentId(): string;
}

/** The reference seller: a managed Reliable Reporting service over `memoryStorage()`. */
export interface ReferenceReportingSeller {
  readonly service: ReliableReportingServiceV1;
  readonly storage: ReportingStorage;
  readonly tenantId: string;
  /** A fresh MCP server per call, as `serve()` wants. */
  createServer(): ReturnType<typeof createAdcpServerFromPlatform>;
  /** Mutable world state the platform serves. */
  readonly state: {
    accounts: Map<
      string,
      Omit<ReportingTestAccount, 'grants'> & { grants: Map<string, { allowed_tasks: string[] } | null> }
    >;
    buys: Map<string, ReportingTestBuy & { canceled_at?: string; completed_at?: string }>;
  };
  readonly clock: { now: Date };
}

const FULL_GRANT = ['get_reporting_status', 'sync_reporting_receipts', 'sync_reporting_status', 'get_media_buys'];

/** Ready-made offerings over the SDK's redacted reference source offering. */
export const offerings = {
  /**
   * A daily analytics feed (`P1D`, snapshot finality, `delivery_sla` `PT0S`) mapped onto the
   * `package` standard dimension.
   */
  dailyAnalytics(options: { offering_id?: string; dimensions?: string[] } = {}): ReportingTestOffering {
    const source = redactedReportingSourceOfferingV1;
    return {
      offering_id: options.offering_id ?? source.offeringId,
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
        primary_keys: ['account_id', 'media_buy_id'],
      },
      schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
      supported_finality: ['snapshot'],
      reconciliation_mode: 'delivery_only',
      standard_dimensions: options.dimensions ?? ['package'],
    } as ReportingTestOffering;
  },
};

/**
 * The reference seller on the managed path: one `subscriptions` block on the Reliable Reporting
 * service, a platform serving `accounts.list` (with timezone and grant) and `getMediaBuys`, and a
 * source adapter that reports one impression per buy per period. Everything is in memory and on
 * `clock`.
 *
 * @experimental
 */
export function createReferenceReportingSeller(options: ReportingTestKitOptions): ReferenceReportingSeller {
  const clock = { now: new Date(options.start) };
  if (!Number.isFinite(clock.now.getTime())) throw new TypeError('start must be an RFC 3339 instant');
  const now = () => clock.now;
  const tenantId = options.tenantId ?? 'reference';
  const deliveryOfferings = options.offerings ?? [offerings.dailyAnalytics()];
  const state: ReferenceReportingSeller['state'] = {
    accounts: new Map(
      (options.accounts ?? []).map(account => [
        account.account_id,
        {
          ...account,
          grants: new Map<string, { allowed_tasks: string[] } | null>(
            (account.grants ?? []).map(buyer => [buyer, { allowed_tasks: [...FULL_GRANT] }])
          ),
        },
      ])
    ),
    buys: new Map((options.buys ?? []).map(buy => [buy.media_buy_id, structuredClone(buy)])),
  };
  const storage = memoryStorage({ now });
  const buyerOf = (ctx: unknown): string | undefined => {
    const context = ctx as { authInfo?: { clientId?: string }; callerMutationScope?: { principal_id?: string } };
    return context?.callerMutationScope?.principal_id ?? context?.authInfo?.clientId;
  };
  const grantOf = (accountId: string, ctx: unknown) => {
    const buyer = buyerOf(ctx);
    return buyer === undefined ? undefined : (state.accounts.get(accountId)?.grants.get(buyer) ?? undefined);
  };
  const toAccount = (account: Omit<ReportingTestAccount, 'grants'>) => ({
    id: account.account_id,
    name: account.account_id,
    status: 'active' as const,
    timezone: account.timezone,
    ...(account.operator ? { operator: account.operator } : {}),
    ctx_metadata: {},
  });
  const request = redactedReportingSourceRequestV1();
  const [template] = request.coverage.constituents;
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1) as unknown as Json & { cadence: Json };
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };

  const service = createReliableReportingService({
    storage,
    adapters: Object.fromEntries(
      deliveryOfferings.map(offering => [
        offering.offering_id,
        {
          sourceOffering: { ...structuredClone(sourceOffering), offeringId: offering.offering_id },
          deliveryOffering: offering,
          fetchSlice: (slice: { start_date: string; end_date: string; media_buy_ids: string[] }) => ({
            reporting_period: { start: slice.start_date, end: slice.end_date },
            currency: 'USD',
            reporting_rows: slice.media_buy_ids.map(media_buy_id => ({ media_buy_id, impressions: 1, spend: '1.00' })),
          }),
        },
      ])
    ),
    contact: { name: 'Reporting operations', email: 'reporting@reference-seller.example' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    resolveSource: (account: { id: string }) => ({
      adapterId: deliveryOfferings[0]!.offering_id,
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    resolveCoverage: (account: { id: string }) => ({
      constituents: [...state.buys.values()]
        .filter(buy => buy.account_id === account.id)
        .map(buy => ({
          ...structuredClone(template!),
          constituentId: `constituent-${buy.media_buy_id}`,
          mediaBuyId: buy.media_buy_id,
          productBinding: {
            ...structuredClone(template!.productBinding),
            mediaBuyId: buy.media_buy_id,
            bindingId: `binding-${buy.media_buy_id}`,
          },
        })),
    }),
    resolveConsumerId: (context: unknown) => buyerOf(context) ?? 'anonymous',
    subscriptions: {
      principal: {
        agentUrl: 'https://reference-seller.example/mcp',
        resolvePrincipal: (ctx: unknown) => {
          const buyer = buyerOf(ctx);
          if (!buyer) throw new Error('authenticated caller required');
          return { tenant_id: tenantId, principal_id: buyer, principal_kind: 'buyer_agent' };
        },
        now,
      },
      maxAccounts: options.maxAccounts ?? 100,
      now,
    },
  } as never) as ReliableReportingServiceV1;

  const platform = service.install({
    capabilities: { specialisms: [], config: {} },
    accounts: {
      resolution: 'explicit',
      resolve: async (ref: { account_id?: string } | undefined, ctx: unknown) => {
        const account = ref?.account_id ? state.accounts.get(ref.account_id) : undefined;
        // A revoked account is unknown to every task.
        return account && grantOf(account.account_id, ctx) ? toAccount(account) : null;
      },
      upsert: async () => [],
      list: async (_request: unknown, ctx: unknown) => ({
        items: [...state.accounts.values()].flatMap(account => {
          const grant = grantOf(account.account_id, ctx);
          return grant ? [{ ...toAccount(account), authorization: { allowed_tasks: [...grant.allowed_tasks] } }] : [];
        }),
      }),
    },
    sales: {
      getMediaBuys: async (input: { account?: { account_id?: string } }) => ({
        media_buys: [...state.buys.values()]
          .filter(buy => buy.account_id === input.account?.account_id)
          .map(buy => ({
            media_buy_id: buy.media_buy_id,
            status: buy.canceled_at ? 'canceled' : buy.completed_at ? 'completed' : 'active',
            currency: 'USD',
            total_budget: 1000,
            revision: 1,
            confirmed_at: buy.confirmed_at,
            start_time: buy.start_time,
            end_time: buy.end_time,
            ...(buy.canceled_at ? { cancellation: { canceled_at: buy.canceled_at, canceled_by: 'buyer' } } : {}),
            ...(buy.completed_at ? { completed_at: buy.completed_at } : {}),
            packages: (buy.packages ?? [{ package_id: 'pkg-1' }]).map(pkg => ({
              package_id: pkg.package_id,
              reporting_delivery_offering_ids:
                pkg.reporting_delivery_offering_ids ?? deliveryOfferings.map(offering => offering.offering_id),
            })),
          })),
      }),
    },
  } as never);

  return {
    service,
    storage,
    tenantId,
    state,
    clock,
    createServer: () =>
      createAdcpServerFromPlatform(
        platform as never,
        {
          name: 'reporting-reference-seller',
          version: '1.0.0',
          protocol: service.principals!.protocol,
          validation: { requests: 'strict', responses: 'strict' },
        } as never
      ),
  };
}

/**
 * A kit start `daysAgo` days before now, at UTC midnight. The virtual clock never passes the real
 * one, so start far enough back for the scenario.
 *
 * @experimental
 */
export function reportingTestStart(daysAgo = 30): string {
  return new Date((Math.floor(Date.now() / 86_400_000) - daysAgo) * 86_400_000).toISOString();
}

/** The kit. See the module documentation. */
export interface ReportingTestKit {
  readonly seller: ReferenceReportingSeller;
  readonly service: ReliableReportingServiceV1;
  readonly clock: {
    now(): Date;
    /** Move forward by an ISO 8601 duration (`PT6H`, `P3D`), running the seller's cycle at every boundary crossed. */
    advance(duration: string): Promise<void>;
    advanceTo(instant: string | Date): Promise<void>;
  };
  /** A buyer authenticated as `id`. */
  buyer(id: string): ReportingTestBuyer;
  readonly grants: {
    revoke(buyer: string, accountId: string): Promise<void>;
    regrant(buyer: string, accountId: string): Promise<void>;
    /** The reconciliation-only grant: coverage continues, buying stops. */
    windDown(buyer: string, accountId: string): Promise<void>;
    reduce(buyer: string, accountId: string, allowedTasks: readonly string[]): Promise<void>;
  };
  readonly accounts: {
    add(account: ReportingTestAccount): void;
    setTimezone(accountId: string, timezone: string): void;
  };
  readonly buys: {
    add(buy: ReportingTestBuy): void;
    cancel(mediaBuyId: string): void;
    complete(mediaBuyId: string): void;
  };
  /** Run one seller cycle now. */
  runCycle(): Promise<void>;
  /**
   * The seller's frozen owed set for the buyer equals the periods the buyer's
   * `client.reporting.reconcile()` computes from the wire, over every period the seller has frozen.
   * Throws with the differing periods and the first differing rule of each.
   */
  assertAgreement(buyer: string): Promise<void>;
}

function durationMs(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match || value === 'P' || value === 'PT')
    throw new TypeError(`${value} is not a fixed-length ISO 8601 duration`);
  const [, days, hours, minutes, seconds] = match.map(part => Number(part ?? 0)) as number[];
  return (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1_000;
}

/**
 * Create the kit: a reference seller over `memoryStorage()` on a virtual clock. Set
 * `NODE_ENV=test` (or `development`): process-local storage is refused elsewhere.
 *
 * @experimental
 */
export function createReportingTestKit(options: ReportingTestKitOptions): ReportingTestKit {
  const seller = createReferenceReportingSeller(options);
  const { service, state, clock } = seller;
  const server = seller.createServer();
  const buyers = new Map<string, ReportingTestBuyer>();
  let keys = 0;

  const runCycle = async () => {
    await service.runCycle({ now: clock.now, deploymentWide: true } as never);
  };
  const principalOf = (buyer: string) => ({ tenantId: seller.tenantId, principalId: buyer });
  const account = (accountId: string) => {
    const found = state.accounts.get(accountId);
    if (!found) throw new TypeError(`No account ${JSON.stringify(accountId)} in the kit`);
    return found;
  };
  const changeGrant = async (buyer: string, accountId: string, tasks: readonly string[] | null) => {
    account(accountId).grants.set(buyer, tasks === null ? null : { allowed_tasks: [...tasks] });
    await service.grants!.changed({
      principal: principalOf(buyer),
      accountId,
      at: clock.now.toISOString(),
      authorized: tasks !== null,
      ...(tasks !== null ? { allowedTasks: [...tasks] } : {}),
    });
    await runCycle();
  };
  const boundaries = (from: number, to: number): number[] => {
    const result = new Set<number>();
    for (const offering of service.capabilities.offerings ?? []) {
      const schedule = offering.schedule as { period_duration: string; alignment: string };
      const zones =
        schedule.alignment === 'account_timezone' ? [...state.accounts.values()].map(item => item.timezone) : ['UTC'];
      for (const timezone of zones) {
        try {
          const calendar = createReportingPeriodCalendarV1({
            period_duration: schedule.period_duration,
            alignment: schedule.alignment === 'account_timezone' ? 'account_timezone' : 'utc',
            ...(schedule.alignment === 'account_timezone' ? { timezone } : {}),
          });
          for (let at = calendar.next(from); at <= to && result.size < 2_000; at = calendar.next(at)) result.add(at);
        } catch {
          // A schedule this calendar cannot evaluate is advanced in one step.
        }
      }
    }
    return [...result].sort((left, right) => left - right);
  };
  const advanceTo = async (target: number) => {
    if (!(target > clock.now.getTime())) throw new RangeError('The clock only moves forward');
    if (target > Date.now()) {
      throw new RangeError(
        'The virtual clock cannot pass the real clock: the reporting source refuses periods that have not ended in real time. Start the kit in the past, for example start: reportingTestStart(30).'
      );
    }
    for (const at of boundaries(clock.now.getTime(), target)) {
      clock.now = new Date(at);
      await runCycle();
    }
    clock.now = new Date(target);
    await runCycle();
  };

  const buyer = (id: string): ReportingTestBuyer => {
    const existing = buyers.get(id);
    if (existing) return existing;
    const call = async (task: string, args: Json = {}): Promise<TaskResult<unknown>> => {
      const response = (await server.dispatchTestRequest(
        { method: 'tools/call', params: { name: task, arguments: args } },
        { authInfo: { clientId: id } } as never
      )) as { isError?: boolean; structuredContent?: unknown };
      return (
        response.isError
          ? { success: false, status: 'failed', error: JSON.stringify(response.structuredContent), data: undefined }
          : { success: true, status: 'completed', data: response.structuredContent }
      ) as TaskResult<unknown>;
    };
    const client = {
      id,
      call,
      getPrincipal: (params: Json = {}) => call('get_principal', params),
      syncPrincipal: (params: Json) => call('sync_principal', params),
      listAccounts: (params: Json = {}) => call('list_accounts', params),
      getAdcpCapabilities: (params: Json = {}) => call('get_adcp_capabilities', params),
      getMediaBuys: (params: Json) => call('get_media_buys', params),
      getReportingStatus: (params: Json) => call('get_reporting_status', params),
      syncReportingReceipts: (params: Json) => call('sync_reporting_receipts', params),
      getAgentId: () => 'reference-seller',
    } as unknown as ReportingTestBuyer;
    Object.defineProperty(client, 'reporting', {
      value: new ReportingClient(client as never, {
        createIdempotencyKey: () =>
          `kit-${createHash('sha256').update(`${id}:${++keys}:${Math.random()}`).digest('hex').slice(0, 24)}`,
      }),
    });
    buyers.set(id, client);
    return client;
  };

  async function assertAgreement(buyerId: string): Promise<void> {
    const principal = principalOf(buyerId);
    const engine = service.subscriptionWiring!.engine as unknown as {
      frozenOwedSets(principal: unknown): Promise<
        Array<{
          account_id: string;
          subscription_id: string;
          through: string;
          obligations: Array<{
            subscription_version: number;
            offering_id: string;
            period_start: string;
            period_end: string;
            media_buy_ids: string[];
          }>;
        }>
      >;
    };
    const frozen = await engine.frozenOwedSets(principal);
    const through = new Map(frozen.map(set => [`${set.account_id}\n${set.subscription_id}`, Date.parse(set.through)]));
    const key = (
      accountId: string,
      subscriptionId: string,
      version: number,
      offering: string,
      start: string,
      end: string,
      buys: readonly string[]
    ) =>
      JSON.stringify([
        accountId,
        subscriptionId,
        version,
        offering,
        Date.parse(start),
        Date.parse(end),
        [...buys].sort(),
      ]);
    const sellerKeys = new Set(
      frozen.flatMap(set =>
        set.obligations.map(item =>
          key(
            set.account_id,
            set.subscription_id,
            item.subscription_version,
            item.offering_id,
            item.period_start,
            item.period_end,
            item.media_buy_ids
          )
        )
      )
    );
    const report: ReconcileReport = await buyer(buyerId).reporting.reconcile({
      now: clock.now,
      since: '1970-01-01T00:00:00Z',
    });
    if (!report.definitive) {
      throw new Error(
        `The buyer's reconcile was not definitive: ${JSON.stringify(report.accounts.filter(item => item.status === 'failed'))}`
      );
    }
    const buyerLines = report.periods.filter(line => {
      if (line.status === 'not_owed') return false;
      const horizon = through.get(`${line.account_id}\n${line.subscription_id}`);
      return horizon !== undefined && Date.parse(line.period.end) <= horizon;
    });
    const buyerKeys = new Set(
      buyerLines.map(line =>
        key(
          line.account_id,
          line.subscription_id,
          line.subscription_version,
          line.offering_id,
          line.period.start,
          line.period.end,
          line.media_buy_ids
        )
      )
    );
    const missing = [...sellerKeys].filter(item => !buyerKeys.has(item));
    const extra = [...buyerKeys].filter(item => !sellerKeys.has(item));
    if (missing.length === 0 && extra.length === 0) return;
    const details: string[] = [];
    for (const item of [...missing, ...extra].slice(0, 3)) {
      const [accountId, subscriptionId, , offeringId, start] = JSON.parse(item) as [
        string,
        string,
        number,
        string,
        number,
      ];
      const period = new Date(start).toISOString();
      const [sellerTrace] =
        (await service.explainCoverage!({ principal, accountId, subscriptionId, offeringId, period })) ?? [];
      const [buyerTrace] = await buyer(buyerId).reporting.explain({
        accountId,
        subscriptionId,
        offeringId,
        period,
        now: clock.now,
      });
      const difference = sellerTrace && buyerTrace ? diffCoverageTraces(buyerTrace, sellerTrace) : null;
      details.push(
        `${item}: ${difference ? difference.description : 'the traces agree; the owed sets differ in grouping'}`
      );
    }
    throw new Error(
      `The seller and the buyer disagree on what ${buyerId} is owed. Only the seller owes: ${missing.length}; only the buyer computes: ${extra.length}.\n${details.join('\n')}`
    );
  }

  return {
    seller,
    service,
    clock: {
      now: () => new Date(clock.now),
      advance: duration => advanceTo(clock.now.getTime() + durationMs(duration)),
      advanceTo: instant => advanceTo(instant instanceof Date ? instant.getTime() : Date.parse(instant)),
    },
    buyer,
    grants: {
      revoke: (buyerId, accountId) => changeGrant(buyerId, accountId, null),
      regrant: (buyerId, accountId) => changeGrant(buyerId, accountId, FULL_GRANT),
      windDown: (buyerId, accountId) => changeGrant(buyerId, accountId, REPORTING_WIND_DOWN_TASKS),
      reduce: (buyerId, accountId, tasks) => changeGrant(buyerId, accountId, tasks),
    },
    accounts: {
      add(item) {
        state.accounts.set(item.account_id, {
          ...item,
          grants: new Map<string, { allowed_tasks: string[] } | null>(
            (item.grants ?? []).map(id => [id, { allowed_tasks: [...FULL_GRANT] }])
          ),
        });
      },
      setTimezone(accountId, timezone) {
        account(accountId).timezone = timezone;
      },
    },
    buys: {
      add(item) {
        state.buys.set(item.media_buy_id, structuredClone(item));
      },
      cancel(mediaBuyId) {
        const found = state.buys.get(mediaBuyId);
        if (!found) throw new TypeError(`No buy ${JSON.stringify(mediaBuyId)} in the kit`);
        found.canceled_at = clock.now.toISOString();
      },
      complete(mediaBuyId) {
        const found = state.buys.get(mediaBuyId);
        if (!found) throw new TypeError(`No buy ${JSON.stringify(mediaBuyId)} in the kit`);
        found.completed_at = clock.now.toISOString();
      },
    },
    runCycle,
    assertAgreement,
  };
}

/**
 * Run `fn` with a fresh kit, for `node:test` or vitest.
 *
 * @experimental
 */
export async function withReportingTestKit<T>(
  options: ReportingTestKitOptions,
  fn: (kit: ReportingTestKit) => Promise<T> | T
): Promise<T> {
  return fn(createReportingTestKit(options));
}
