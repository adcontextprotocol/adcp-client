/**
 * `client.reporting`: patch-shaped reporting-subscription writes over the replace-shaped
 * `sync_principal` wire (experimental `media_buy.reporting_subscriptions`, AdCP 3.3), and the guard
 * every raw `syncPrincipal` call goes through. Names follow the Python SDK's `ReportingClient`.
 */
import { randomUUID } from 'node:crypto';

import type { InputHandler, TaskOptions, TaskResult } from '../core/ConversationTypes';
import { ReportingSubscriptionError } from '../errors';
import type { ReportingSubscriptionOfferingV1 } from '../reporting/subscriptions/selection';
import type { ReportingSubscription, ReportingSubscriptionState } from '../types/core.generated';
import type {
  ReportingAdjustmentReceipt,
  ReportingReceipt,
  GetPrincipalRequest,
  GetPrincipalResponse,
  SyncPrincipalRequest,
  SyncPrincipalResponse,
} from '../types/tools.generated';
import type { MutatingRequestInput } from '../utils/idempotency';
import type { CoverageTrace } from '../reporting/subscriptions/explain';
import type { ExplainOptions, ReconcileOptions, ReconcileReport, ReportingReadClient } from './reporting-reconcile';
import type {
  EventsOptions,
  PollOptions,
  ReportingEvent,
  EventBatch,
  ReportingEvents,
  ReportingEventStore,
  VerifiedWebhook,
} from './reporting-events';

type Json = Record<string, unknown>;

/** What a facade write did to one subscription. */
export type SubscribeAction = 'created' | 'updated' | 'unchanged' | 'reactivated' | 'deactivated';

/** The caller's subscriptions as the seller reports them. */
export interface ReportingSubscriptionReadback {
  configurationVersion?: string;
  subscriptions: ReportingSubscriptionState[];
}

/** The outcome of a facade write for one subscription. */
export interface SubscribeResult {
  action: SubscribeAction;
  /** The seller's readback for this subscription. */
  state?: ReportingSubscriptionState;
  /** The version the SDK chose or kept. */
  subscriptionVersion: number;
  /** The readback of the destination the subscription names, if any. */
  destination?: Json;
  readback: ReportingSubscriptionReadback;
}

/** What `subscribe` would do, validated by the seller as a dry run. */
export interface SubscriptionPreviewResult {
  wouldBe: SubscribeAction;
  subscriptionVersion: number;
  /** Offerings the selector resolves to among the seller's advertised ones. */
  offeringIds: string[];
}

/** A facade subscription: `subscription_version` and `active` are optional. */
export type SubscriptionInput = Omit<ReportingSubscription, 'subscription_version' | 'active'> & {
  subscription_version?: number;
  active?: boolean;
};

/** The client calls `client.reporting` needs; `listAccounts` and `getAdcpCapabilities` enable more checks. */
export interface ReportingFacadeClient {
  getPrincipal(
    params?: GetPrincipalRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetPrincipalResponse>>;
  syncPrincipal(
    params: MutatingRequestInput<SyncPrincipalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions & SyncPrincipalGuardOptions
  ): Promise<TaskResult<SyncPrincipalResponse>>;
  listAccounts?(params: Json, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<unknown>>;
  getAdcpCapabilities?(params?: Json, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<unknown>>;
  /** Needed by `reconcile()` and `explain()`. */
  getMediaBuys?(params: Json, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<unknown>>;
  /** Needed by `reconcile()` and `explain()`. */
  getReportingStatus?(params: Json, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<unknown>>;
  /** Needed by `submitReceipts()` and the `receipts` policy. */
  syncReportingReceipts?(
    params: Json,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<unknown>>;
  getAgentId?(): string;
}

/** Options for {@link ReportingClient}. */
export interface ReportingClientOptions {
  /** Write attempts under compare-and-set, 1..10. Default 3. */
  maxAttempts?: number;
  createIdempotencyKey?: () => string;
  /**
   * Where `poll()` keeps the acknowledged snapshot. Defaults to a process-local store, which a
   * serverless consumer loses between invocations: pass `postgresStorage({ pool }).events` or
   * `createReportingEventStore({ store })` there.
   */
  eventStore?: ReportingEventStore;
}

/** Options that let a raw `syncPrincipal` call deactivate subscriptions or revoke destinations. */
export interface SyncPrincipalGuardOptions {
  /** Let a write that omits (or sends `active: false` for) an active subscription deactivate it. */
  allowDeactivation?: boolean;
  /** Let a write that omits an active destination revoke it for every account. */
  allowRevocation?: boolean;
}

interface Principal {
  kind: string;
  configurationVersion?: string;
  principalKind?: string;
  subscriptions: ReportingSubscriptionState[];
  destinations: Json[];
}

// adcp#8619: membership (scope.account_ids, exclude_account_ids) changes in place; the scope kind does
// not. destination_overrides is a destination change.
const SEMANTIC = [
  'selector',
  'reconciliation_mode',
  'destination',
  'destination_overrides',
  'scope',
  'operator_domains',
];
const ROSTER_PAGES = 10;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  );

const semantic = (subscription: Json): string =>
  canonical(
    Object.fromEntries(
      SEMANTIC.map(key => [
        key,
        key === 'scope'
          ? (subscription.scope as Json | undefined)?.all_authorized_accounts === true
            ? 'all_authorized_accounts'
            : 'account_ids'
          : (subscription[key] ?? null),
      ])
    )
  );

/** The membership a subscription names: its `account_ids` or its `exclude_account_ids`, as sorted sets. */
const membershipOf = (subscription: Json): Json => ({
  account_ids: [...(((subscription.scope as Json | undefined)?.account_ids as string[] | undefined) ?? [])].sort(),
  exclude_account_ids: [...((subscription.exclude_account_ids as string[] | undefined) ?? [])].sort(),
});

const activeSubscription = (state: ReportingSubscriptionState | undefined): boolean =>
  state !== undefined && state.state !== 'inactive';

const activeDestination = (configuration: Json): boolean => configuration.active !== false;

const invalid = (message: string): ReportingSubscriptionError =>
  new ReportingSubscriptionError('INVALID_REQUEST', message, { dispatched: false });

function submittedSubscriptions(principal: Principal): Json[] {
  return principal.subscriptions.map(state => ({ ...(state.configuration as unknown as Json) }));
}

function submittedDestinations(principal: Principal): Json[] {
  return principal.destinations.map(item => ({ ...((item.configuration as Json | undefined) ?? item) }));
}

async function readPrincipal(client: ReportingFacadeClient): Promise<Principal> {
  const result = await client.getPrincipal({});
  if (!result.success || !result.data) {
    throw new ReportingSubscriptionError(
      'INVALID_REQUEST',
      `get_principal failed: ${result.error ?? 'no response'}. Retry once the seller is reachable.`,
      { recovery: 'transient' }
    );
  }
  const outcome = result.data.result as unknown as Json;
  if (outcome.kind === 'failed') {
    const first = (outcome.errors as Json[] | undefined)?.[0];
    throw new ReportingSubscriptionError(
      String(first?.code ?? 'INVALID_REQUEST'),
      `get_principal was rejected: ${String(first?.message ?? 'unknown error')}`
    );
  }
  const configuration = (outcome.configuration ?? {}) as Json;
  return {
    kind: String(outcome.kind),
    ...(typeof outcome.configuration_version === 'string'
      ? { configurationVersion: outcome.configuration_version }
      : {}),
    ...(typeof outcome.principal_kind === 'string' ? { principalKind: outcome.principal_kind } : {}),
    subscriptions: [...((configuration.reporting_subscriptions as ReportingSubscriptionState[] | undefined) ?? [])],
    destinations: [...((configuration.reporting_destinations as Json[] | undefined) ?? [])],
  };
}

function checkCompleteSet(principal: Principal, configuration: Json, options: SyncPrincipalGuardOptions): void {
  if (Array.isArray(configuration.reporting_subscriptions) && !options.allowDeactivation) {
    const sent = configuration.reporting_subscriptions as Json[];
    const sentIds = new Set(sent.map(item => item.subscription_id));
    const omitted = principal.subscriptions
      .filter(
        state =>
          activeSubscription(state) &&
          (!sentIds.has(state.subscription_id) ||
            sent.some(item => item.subscription_id === state.subscription_id && item.active === false))
      )
      .map(state => state.subscription_id);
    if (omitted.length > 0) {
      throw new ReportingSubscriptionError(
        'SUBSCRIPTION_WOULD_DEACTIVATE',
        `This write deactivates active subscriptions ${omitted.map(id => JSON.stringify(id)).join(', ')}, because reporting_subscriptions is the complete set. Use client.reporting.subscribe() or unsubscribe(), or pass allowDeactivation: true.`,
        { wouldDeactivate: omitted }
      );
    }
  }
  if (Array.isArray(configuration.reporting_destinations) && !options.allowRevocation) {
    const sentIds = new Set((configuration.reporting_destinations as Json[]).map(item => item.destination_id));
    const revoked = submittedDestinations(principal)
      .filter(item => activeDestination(item) && !sentIds.has(item.destination_id))
      .map(item => String(item.destination_id));
    if (revoked.length > 0) {
      throw new ReportingSubscriptionError(
        'DESTINATION_WOULD_REVOKE',
        `This write omits destinations ${revoked.map(id => JSON.stringify(id)).join(', ')}. Omitting a destination revokes it for every account. Pass allowRevocation: true.`,
        { wouldRevoke: revoked }
      );
    }
  }
}

/**
 * The raw `syncPrincipal` guard: before a write that submits `reporting_subscriptions` or
 * `reporting_destinations`, read the current principal (one read) and refuse, before sending, a
 * write that would deactivate an active subscription (`SUBSCRIPTION_WOULD_DEACTIVATE`) or revoke a
 * destination (`DESTINATION_WOULD_REVOKE`) unless the caller allows it. Dry runs are not guarded.
 */
export async function guardSyncPrincipal(
  client: Pick<ReportingFacadeClient, 'getPrincipal'>,
  params: { configuration?: unknown; dry_run?: boolean },
  options: SyncPrincipalGuardOptions = {}
): Promise<void> {
  const configuration = (params.configuration ?? {}) as Json;
  const touchesSubscriptions = Array.isArray(configuration.reporting_subscriptions) && !options.allowDeactivation;
  const touchesDestinations = Array.isArray(configuration.reporting_destinations) && !options.allowRevocation;
  if (params.dry_run === true || (!touchesSubscriptions && !touchesDestinations)) return;
  checkCompleteSet(await readPrincipal(client as ReportingFacadeClient), configuration, options);
}

interface Plan {
  configuration?: Json;
  action: SubscribeAction;
  version: number;
  subscriptionId?: string;
  verify: Json[];
  offeringIds: string[];
}

/**
 * `client.reporting`: patch-shaped reporting-subscription writes.
 *
 * - `subscribe(subscription, { registerDestination })` upserts one subscription and keeps every
 *   other entry. `subscription_version` is optional: it is kept when only `active`,
 *   `replace_account_configs` or membership (`scope.account_ids`, `exclude_account_ids`; adcp#8619)
 *   change, and bumped when the selector, the scope kind, the destination (including
 *   `destination_overrides`), `reconciliation_mode` or `operator_domains` change.
 * - `unsubscribe(id)` is the only way to deactivate (`active: false`; obligations are retained).
 * - `replaceSubscriptions(list, { deactivateOmitted })` replaces the complete set (expert).
 * - `listSubscriptions()` and `preview(subscription)` (a seller dry run).
 *
 * Writes use `expected_configuration_version`; on `CONFLICT` the SDK re-reads, re-merges and retries
 * with a fresh idempotency key (3 attempts by default), then throws `SUBSCRIPTION_CONFLICT_EXHAUSTED`.
 * Every submitted subscription must read back unchanged, or `SUBSCRIPTION_READBACK_MISMATCH`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class ReportingClient {
  private readonly maxAttempts: number;
  private readonly createIdempotencyKey: () => string;
  private readonly eventStore?: ReportingEventStore;
  private eventsRuntime?: ReportingEvents;

  constructor(
    private readonly client: ReportingFacadeClient,
    options: ReportingClientOptions = {}
  ) {
    if (options.eventStore !== undefined) this.eventStore = options.eventStore;
    const attempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
      throw new TypeError('maxAttempts must be an integer in 1..10');
    }
    this.maxAttempts = attempts;
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => `rsub-${randomUUID()}`);
  }

  /** The caller's subscriptions as the seller reports them (`get_principal`). */
  async listSubscriptions(): Promise<ReportingSubscriptionReadback> {
    const principal = await readPrincipal(this.client);
    return readbackOf(principal);
  }

  /** Create or update one subscription, keeping every other entry unchanged. */
  async subscribe(
    subscription: SubscriptionInput,
    options: { registerDestination?: Json; acknowledgeCrossOperator?: boolean } = {}
  ): Promise<SubscribeResult> {
    return this.write(principal => this.planSubscribe(principal, structuredClone(subscription) as Json, options));
  }

  /** Deactivate one subscription (`active: false`); its obligations are retained. */
  async unsubscribe(subscriptionId: string): Promise<SubscribeResult> {
    return this.write(async principal => {
      const state = principal.subscriptions.find(item => item.subscription_id === subscriptionId);
      if (!state) {
        throw invalid(
          `No subscription ${JSON.stringify(subscriptionId)} exists for this principal. Check listSubscriptions() for the ids.`
        );
      }
      const current = { ...(state.configuration as unknown as Json) };
      if (!activeSubscription(state)) return unchanged(current);
      return replaceOne(principal, { ...current, active: false }, 'deactivated');
    });
  }

  /**
   * What the seller owes this buyer, period by period: every owed obligation of every subscription on
   * every covered account, with `status` (`delivered`, `pending`, `late`, `missing_obligation`,
   * `withheld`), the coverage `reason`, the `responsible_party` and a `message`. The roster is
   * `list_accounts` intersected with the subscriptions' scopes, read on every run. `grace` (default
   * `PT1H`) is how long after a period ends the seller may take to plan its obligation.
   * `includeNotOwed` adds `not_owed` lines with their reasons. Reads only; never writes.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileReport> {
    const { reconcileReportingSubscriptions } = await import('./reporting-reconcile');
    return reconcileReportingSubscriptions(this.client as unknown as ReportingReadClient, options);
  }

  /**
   * Why a period is or is not owed: one `CoverageTrace` (`side: 'buyer'`) per subscription, buy and
   * offering, in the same JSON the seller's `reporting.explainCoverage` returns. A plain date
   * (`'2026-11-03'`) is read in the offering's zone. Reads only.
   */
  async explain(options: ExplainOptions): Promise<CoverageTrace[]> {
    const { explainReportingSubscriptionCoverage } = await import('./reporting-reconcile');
    return explainReportingSubscriptionCoverage(this.client as unknown as ReportingReadClient, options);
  }

  /**
   * One batch of events since the last acknowledgement, derived by comparing what the seller reports
   * now (`reconcile`, the subscription readback, `subscription_coverage[]`) with the snapshot saved by
   * the last `ack()`. Handle `batch.events`, then `await batch.ack()`; until then the same events
   * come again with the same ids. Serverless-safe with a durable `eventStore`. `baseline: true` on a
   * consumer with no snapshot records the present without emitting it.
   */
  async poll(options: PollOptions = {}): Promise<EventBatch> {
    return (await this.eventRuntime()).poll(options);
  }

  /**
   * Every event, until `signal` aborts. Each batch is acknowledged once the loop body has run for all
   * of its events, so a throw in the body redelivers the batch. `handleWebhook` wakes it early.
   */
  async *events(options: EventsOptions = {}): AsyncGenerator<ReportingEvent, void, undefined> {
    yield* (await this.eventRuntime()).events(options);
  }

  /**
   * A verified seller webhook (`principal.changed` and friends) is a doorbell, never event content.
   * With an `events()` loop running this wakes it and returns `null`; otherwise it polls inline and
   * returns the batch for the caller to handle and `ack()`. Only a {@link VerifiedWebhook} is accepted.
   */
  async handleWebhook(verified: VerifiedWebhook): Promise<EventBatch | null> {
    return (await this.eventRuntime()).handleWebhook(verified);
  }

  private async eventRuntime(): Promise<ReportingEvents> {
    if (!this.eventsRuntime) {
      const { ReportingEvents } = await import('./reporting-events');
      this.eventsRuntime ??= new ReportingEvents(this.client as unknown as ReportingReadClient, this.eventStore);
    }
    return this.eventsRuntime;
  }

  /**
   * The manual receipts path: a typed wrapper over `sync_reporting_receipts` for one account.
   * Returns the seller's item results. A receipt states that you verified and committed the data, so
   * send one only after your load committed; the `receipts` policy on `reconcile` does this for you.
   * Accepting an adjustment always goes through here: billing never auto-accepts.
   */
  async submitReceipts(
    accountId: string,
    items: { receipts?: readonly ReportingReceipt[]; adjustmentReceipts?: readonly ReportingAdjustmentReceipt[] }
  ): Promise<{ receipts: Json[]; adjustmentReceipts: Json[] }> {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw invalid('submitReceipts needs the account_id the receipts belong to.');
    }
    if (!items?.receipts?.length && !items?.adjustmentReceipts?.length) {
      throw invalid('submitReceipts needs at least one receipt or adjustment receipt.');
    }
    const { writeReceipts } = await import('./reporting-receipts');
    const data = await writeReceipts(this.client as never, accountId, items);
    return {
      receipts: [...((data.receipts as Json[] | undefined) ?? [])],
      adjustmentReceipts: [...((data.adjustment_receipts as Json[] | undefined) ?? [])],
    };
  }

  /** Validate what `subscribe` would write, as a seller dry run. */
  async preview(
    subscription: SubscriptionInput,
    options: { registerDestination?: Json; acknowledgeCrossOperator?: boolean } = {}
  ): Promise<SubscriptionPreviewResult> {
    const principal = await readPrincipal(this.client);
    const plan = await this.planSubscribe(principal, structuredClone(subscription) as Json, options);
    if (plan.configuration) await this.send(principal, plan.configuration, this.createIdempotencyKey(), true);
    return { wouldBe: plan.action, subscriptionVersion: plan.version, offeringIds: plan.offeringIds };
  }

  /**
   * Replace the complete subscription set (expert). Omitting an active subscription deactivates it,
   * which needs `deactivateOmitted: true`; an empty list needs `deactivateAll: true`. Versions are
   * taken as given.
   */
  async replaceSubscriptions(
    subscriptions: readonly ReportingSubscription[],
    options: {
      deactivateOmitted?: boolean;
      deactivateAll?: boolean;
      reportingDestinations?: readonly Json[];
      allowRevocation?: boolean;
    } = {}
  ): Promise<ReportingSubscriptionReadback> {
    const sent = subscriptions.map(item => structuredClone(item) as unknown as Json);
    if (sent.length === 0 && !options.deactivateAll) {
      throw invalid('An empty subscription list deactivates every subscription. Pass deactivateAll: true.');
    }
    const result = await this.write(async principal => {
      const configuration: Json = { reporting_subscriptions: sent };
      if (options.reportingDestinations) configuration.reporting_destinations = [...options.reportingDestinations];
      checkCompleteSet(principal, configuration, {
        allowDeactivation: options.deactivateOmitted === true || options.deactivateAll === true,
        allowRevocation: options.allowRevocation === true,
      });
      return { configuration, action: 'updated', version: 0, verify: sent, offeringIds: [] };
    });
    return result.readback;
  }

  private async planSubscribe(
    principal: Principal,
    wanted: Json,
    options: { registerDestination?: Json; acknowledgeCrossOperator?: boolean }
  ): Promise<Plan> {
    const subscriptionId = wanted.subscription_id;
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
      throw invalid('subscribe() needs a subscription_id. Name the subscription.');
    }
    wanted.active ??= true;
    const state = principal.subscriptions.find(item => item.subscription_id === subscriptionId);
    const current = state ? ({ ...(state.configuration as unknown as Json) } as Json) : undefined;
    const { version, action } = chooseVersion(wanted, current, state);
    wanted.subscription_version = version;
    let destinations = submittedDestinations(principal);
    let destinationsChanged = false;
    if (options.registerDestination) {
      const register = structuredClone(options.registerDestination);
      const others = destinations.filter(item => item.destination_id !== register.destination_id);
      const existing = destinations.find(item => item.destination_id === register.destination_id);
      if (!existing || canonical(existing) !== canonical(register)) {
        destinations = [...others, register];
        destinationsChanged = true;
      }
    }
    checkScope(wanted);
    const named = checkDestination(wanted, destinations);
    const offeringIds = await this.checkSeller(wanted, named, options.acknowledgeCrossOperator === true);
    if (action === 'unchanged' && !destinationsChanged) return { ...unchanged(wanted), offeringIds };
    const plan = replaceOne(principal, wanted, action);
    if (destinationsChanged) plan.configuration!.reporting_destinations = destinations;
    return { ...plan, offeringIds };
  }

  /** Checks that need the seller's roster or capabilities; skipped when unavailable. */
  private async checkSeller(
    wanted: Json,
    destination: Json | undefined,
    acknowledgeCrossOperator: boolean
  ): Promise<string[]> {
    const subscriptionId = wanted.subscription_id as string;
    for (const account of (await this.roster()) ?? []) {
      const configs = (account.reporting_delivery_configs as Json[] | undefined) ?? [];
      const clash = configs.some(
        config =>
          config.delivery_config_id === subscriptionId ||
          (config.configuration as Json | undefined)?.delivery_config_id === subscriptionId
      );
      if (clash) {
        throw new ReportingSubscriptionError(
          'SUBSCRIPTION_ID_CLASH',
          `subscription_id ${JSON.stringify(subscriptionId)} is already a delivery_config_id on account ${JSON.stringify(account.account_id)}. Choose a subscription_id that no account-level delivery config uses.`,
          { deliveryConfigId: subscriptionId, accountId: String(account.account_id) }
        );
      }
    }
    const scope = (wanted.scope ?? {}) as Json;
    if (
      scope.all_authorized_accounts === true &&
      destination &&
      !(wanted.operator_domains as unknown[] | undefined)?.length &&
      !acknowledgeCrossOperator
    ) {
      throw new ReportingSubscriptionError(
        'SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED',
        'An all-accounts subscription follows every grant, including accounts another operator grants later, into one destination. Add operator_domains, or pass acknowledgeCrossOperator: true.'
      );
    }
    return this.resolveSelector(wanted, destination);
  }

  private async roster(): Promise<Json[] | undefined> {
    if (!this.client.listAccounts) return undefined;
    const accounts: Json[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < ROSTER_PAGES; page += 1) {
        const result = await this.client.listAccounts(cursor ? { pagination: { cursor } } : {});
        if (!result.success || !result.data) return undefined;
        const data = result.data as { accounts?: Json[]; pagination?: { cursor?: string; has_more?: boolean } };
        accounts.push(...(data.accounts ?? []));
        cursor = data.pagination?.has_more ? data.pagination.cursor : undefined;
        if (!cursor) return accounts;
      }
    } catch {
      return undefined; // the roster checks are best effort
    }
    return undefined; // a partial roster is never used
  }

  private async resolveSelector(wanted: Json, destination: Json | undefined): Promise<string[]> {
    if (!this.client.getAdcpCapabilities) return [];
    let offerings: ReportingSubscriptionOfferingV1[];
    try {
      const result = await this.client.getAdcpCapabilities({});
      const data = (result.success ? result.data : undefined) as Json | undefined;
      offerings =
        (((data?.media_buy as Json | undefined)?.reporting_delivery as Json | undefined)?.offerings as
          | ReportingSubscriptionOfferingV1[]
          | undefined) ?? [];
    } catch {
      return []; // the selector check is best effort
    }
    offerings = offerings.filter(item => Array.isArray(item.standard_dimensions));
    if (offerings.length === 0) return [];
    const destinationMethod = destination
      ? { pattern: String(destination.pattern), transport: String(destination.transport) }
      : undefined;
    const input = {
      selector: wanted.selector as ReportingSubscription['selector'],
      reconciliation_mode: (wanted.reconciliation_mode ??
        'delivery_only') as ReportingSubscription['reconciliation_mode'],
      ...(destinationMethod ? { destination_method: destinationMethod as never } : {}),
      offerings,
      eligible_offering_ids: offerings.map(item => item.offering_id),
    };
    let resolved: string[];
    try {
      // Loaded on demand: offering selection stays out of the focused client's eager graph.
      const { resolveReportingSubscriptionOfferingsV1 } = await import('../reporting/subscriptions/selection');
      resolved = resolveReportingSubscriptionOfferingsV1(input);
    } catch {
      return [];
    }
    if (resolved.length > 0) return resolved;
    const failing = offerings
      .map(offering => ({ offering_id: offering.offering_id, failed: mismatches(offering, wanted, destination) }))
      .sort((a, b) => a.failed.length - b.failed.length || (a.offering_id < b.offering_id ? -1 : 1));
    const fewest = failing[0]?.failed.length ?? 0;
    const nearest = failing.filter(item => item.failed.length === fewest).slice(0, 5);
    throw new ReportingSubscriptionError(
      'SUBSCRIPTION_SELECTOR_UNMATCHED',
      `No advertised offering matches this selector. Nearest: ${nearest.map(item => `${item.offering_id} (${item.failed.join(', ')})`).join(', ')}. Change the selector; the nearest offerings and the attributes each one failed are listed.`,
      { nearest }
    );
  }

  private async write(build: (principal: Principal) => Promise<Plan>): Promise<SubscribeResult> {
    let principal = await readPrincipal(this.client);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const plan = await build(principal);
      if (!plan.configuration) return resultOf(plan, principal);
      const outcome = await this.send(principal, plan.configuration, this.createIdempotencyKey(), false);
      if (outcome) {
        const configuration = (outcome.configuration ?? {}) as Json;
        const after: Principal = {
          kind: 'current',
          ...(typeof outcome.configuration_version === 'string'
            ? { configurationVersion: outcome.configuration_version }
            : {}),
          ...(principal.principalKind ? { principalKind: principal.principalKind } : {}),
          subscriptions: [
            ...((configuration.reporting_subscriptions as ReportingSubscriptionState[] | undefined) ?? []),
          ],
          destinations: [...((configuration.reporting_destinations as Json[] | undefined) ?? [])],
        };
        verify(plan, after);
        return resultOf(plan, after);
      }
      if (attempt < this.maxAttempts) principal = await readPrincipal(this.client);
    }
    throw new ReportingSubscriptionError(
      'SUBSCRIPTION_CONFLICT_EXHAUSTED',
      `The principal configuration changed during all ${this.maxAttempts} attempts; nothing was applied by the last one. Another writer is updating this principal; retry later.`
    );
  }

  /** One attempt; undefined on CONFLICT. A transport failure retries the same key and body once. */
  private async send(
    principal: Principal,
    configuration: Json,
    key: string,
    dryRun: boolean
  ): Promise<Json | undefined> {
    const request = {
      idempotency_key: key,
      configuration,
      ...(principal.kind === 'current' && principal.configurationVersion
        ? { expected_configuration_version: principal.configurationVersion }
        : {}),
      ...(principal.principalKind && (principal.kind === 'current' || principal.kind === 'recognized')
        ? { expected_principal_kind: principal.principalKind }
        : {}),
      ...(dryRun ? { dry_run: true } : {}),
    } as unknown as MutatingRequestInput<SyncPrincipalRequest>;
    // The facade checks the complete set itself; the raw guard would only re-read.
    const unguarded = { allowDeactivation: true, allowRevocation: true };
    let result: TaskResult<SyncPrincipalResponse>;
    try {
      result = await this.client.syncPrincipal(request, undefined, unguarded);
    } catch {
      result = await this.client.syncPrincipal(request, undefined, unguarded); // same key and body: the seller replays
    }
    if (!result.success || !result.data) {
      throw new ReportingSubscriptionError(
        'INVALID_REQUEST',
        `sync_principal failed: ${result.error ?? 'no response'}. Retry the same call.`,
        { recovery: 'transient' }
      );
    }
    const outcome = result.data.result as unknown as Json;
    if (outcome.kind === 'failed') {
      const errors = (outcome.errors as Json[] | undefined) ?? [];
      if (errors.some(error => error.code === 'CONFLICT')) return undefined;
      const first = errors[0];
      throw new ReportingSubscriptionError(
        String(first?.code ?? 'INVALID_REQUEST'),
        `sync_principal was rejected: ${String(first?.message ?? 'unknown error')}`,
        typeof first?.recovery === 'string' ? { recovery: first.recovery as never } : {}
      );
    }
    return outcome;
  }
}

function readbackOf(principal: Principal): ReportingSubscriptionReadback {
  return {
    ...(principal.configurationVersion ? { configurationVersion: principal.configurationVersion } : {}),
    subscriptions: principal.subscriptions,
  };
}

function unchanged(wanted: Json): Plan {
  return {
    action: 'unchanged',
    version: Number(wanted.subscription_version ?? 1),
    subscriptionId: String(wanted.subscription_id),
    verify: [],
    offeringIds: [],
  };
}

function replaceOne(principal: Principal, wanted: Json, action: SubscribeAction): Plan {
  const subscriptions = submittedSubscriptions(principal).map(item =>
    item.subscription_id === wanted.subscription_id ? wanted : item
  );
  if (!subscriptions.includes(wanted)) subscriptions.push(wanted);
  return {
    configuration: { reporting_subscriptions: subscriptions },
    action,
    version: Number(wanted.subscription_version),
    subscriptionId: String(wanted.subscription_id),
    verify: [wanted],
    offeringIds: [],
  };
}

function chooseVersion(
  wanted: Json,
  current: Json | undefined,
  state: ReportingSubscriptionState | undefined
): { version: number; action: SubscribeAction } {
  const supplied = wanted.subscription_version as number | undefined;
  if (supplied !== undefined && (!Number.isSafeInteger(supplied) || supplied < 1)) {
    throw invalid('subscription_version must be a positive integer. Omit it to auto-version.');
  }
  if (!current || !state) return { version: supplied ?? 1, action: 'created' };
  const version = Number(state.subscription_version ?? current.subscription_version ?? 1);
  const reactivating = !activeSubscription(state) && wanted.active !== false;
  if (semantic({ ...current, subscription_id: wanted.subscription_id }) !== semantic(wanted)) {
    if (supplied !== undefined && supplied <= version) {
      throw invalid(
        `Subscription ${JSON.stringify(wanted.subscription_id)} changes its content, so its version must exceed ${version}. Omit subscription_version to auto-version.`
      );
    }
    return { version: supplied ?? version + 1, action: reactivating ? 'reactivated' : 'updated' };
  }
  if (supplied !== undefined && supplied !== version) {
    throw invalid(
      `Subscription ${JSON.stringify(wanted.subscription_id)} is unchanged at version ${version}. Omit subscription_version, or change the content.`
    );
  }
  if (reactivating) return { version, action: 'reactivated' };
  if (
    (wanted.active === false) !== !activeSubscription(state) ||
    (wanted.replace_account_configs ?? null) !== (current.replace_account_configs ?? null) ||
    // adcp#8619: a membership edit is written under the same version.
    canonical(membershipOf(wanted)) !== canonical(membershipOf(current))
  ) {
    return { version, action: 'updated' };
  }
  return { version, action: 'unchanged' };
}

function checkScope(wanted: Json): void {
  const scope = (wanted.scope ?? {}) as Json;
  if (scope.all_authorized_accounts !== true && !(scope.account_ids as unknown[] | undefined)?.length) {
    throw invalid(
      'The subscription scope must be explicit. Pass { all_authorized_accounts: true } or { account_ids: [...] }.'
    );
  }
}

function checkDestination(wanted: Json, destinations: readonly Json[]): Json | undefined {
  const target = wanted.destination as Json | undefined;
  if (!target) return undefined;
  const named = destinations.find(item => item.destination_id === target.destination_id);
  if (!named || !activeDestination(named)) {
    throw invalid(
      `Destination ${JSON.stringify(target.destination_id)} is not registered and active. Pass it as registerDestination.`
    );
  }
  const scope = (wanted.scope ?? {}) as Json;
  const several =
    scope.all_authorized_accounts === true || ((scope.account_ids as unknown[] | undefined)?.length ?? 0) > 1;
  if (several && typeof target.path_template === 'string' && !target.path_template.includes('{account_id}')) {
    throw invalid(
      'This subscription can cover several accounts, so its path_template must contain {account_id}. Add it to the template.'
    );
  }
  return named;
}

function verify(plan: Plan, after: Principal): void {
  for (const sent of plan.verify) {
    const state = after.subscriptions.find(item => item.subscription_id === sent.subscription_id);
    const fail = (detail: string) =>
      new ReportingSubscriptionError(
        'SUBSCRIPTION_READBACK_MISMATCH',
        `The seller's readback for subscription ${JSON.stringify(sent.subscription_id)} ${detail}. The seller altered a submitted field; contact the seller.`,
        { readback: state }
      );
    if (!state || state.subscription_version !== sent.subscription_version) {
      throw fail(`does not carry version ${String(sent.subscription_version)}`);
    }
    if ((sent.active === false) !== (state.state === 'inactive'))
      throw fail(`does not reflect active: ${String(sent.active)}`);
    const { active: _sentActive, ...submitted } = sent;
    const { active: _readActive, ...stored } = (state.configuration ?? {}) as unknown as Json;
    const found = differingPath(submitted, stored, '');
    if (found !== undefined) throw fail(`stores a different configuration at ${found || '/'}`);
  }
}

function resultOf(plan: Plan, principal: Principal): SubscribeResult {
  const state = plan.subscriptionId
    ? principal.subscriptions.find(item => item.subscription_id === plan.subscriptionId)
    : undefined;
  const target = (state?.configuration as unknown as Json | undefined)?.destination as Json | undefined;
  const destination = target
    ? principal.destinations.find(
        item =>
          (item.destination_id ?? (item.configuration as Json | undefined)?.destination_id) === target.destination_id
      )
    : undefined;
  return {
    action: plan.action,
    ...(state ? { state } : {}),
    subscriptionVersion: plan.version,
    ...(destination ? { destination } : {}),
    readback: readbackOf(principal),
  };
}

function mismatches(offering: ReportingSubscriptionOfferingV1, wanted: Json, destination: Json | undefined): string[] {
  const selector = (wanted.selector ?? {}) as Json;
  const raw = offering as unknown as Json;
  const schedule = (raw.schedule ?? {}) as Json;
  const method = raw.method as Json | undefined;
  const failed: string[] = [];
  if (raw.feed_purpose !== selector.feed_purpose) failed.push('feed_purpose');
  if (schedule.period_duration !== selector.period_duration) failed.push('period_duration');
  if (raw.reconciliation_mode !== (wanted.reconciliation_mode ?? 'delivery_only')) failed.push('reconciliation_mode');
  if (!((raw.supported_finality as unknown[] | undefined) ?? []).includes(selector.required_finality)) {
    failed.push('required_finality');
  }
  if (selector.alignment !== undefined && schedule.alignment !== selector.alignment) failed.push('alignment');
  if (
    (method?.pattern ?? undefined) !== (destination?.pattern ?? undefined) ||
    (destination && method?.transport !== destination.transport)
  ) {
    failed.push('destination method');
  }
  const dimensions = new Set((offering.standard_dimensions ?? []) as string[]);
  if (((selector.dimensions as string[] | undefined) ?? []).some(item => !dimensions.has(item)))
    failed.push('dimensions');
  return failed;
}

/**
 * The first path at which `stored` lacks or changes a value the buyer sent. Fields the seller adds
 * are ignored; arrays must match element for element.
 */
function differingPath(sent: unknown, stored: unknown, path: string): string | undefined {
  if (Array.isArray(sent)) {
    if (!Array.isArray(stored) || stored.length !== sent.length) return path;
    for (let index = 0; index < sent.length; index += 1) {
      const differing = differingPath(sent[index], stored[index], `${path}/${index}`);
      if (differing !== undefined) return differing;
    }
    return undefined;
  }
  if (sent !== null && typeof sent === 'object') {
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return path;
    for (const [key, value] of Object.entries(sent)) {
      if (value === undefined) continue;
      const differing = differingPath(value, (stored as Record<string, unknown>)[key], `${path}/${key}`);
      if (differing !== undefined) return differing;
    }
    return undefined;
  }
  return Object.is(sent, stored) ? undefined : path;
}
