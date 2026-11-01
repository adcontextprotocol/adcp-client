/**
 * Buyer events for reporting subscriptions: `poll`, `events`, `handleWebhook` (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3). Names and event ids follow the Python SDK's
 * `adcp.reporting.subscriptions.events`.
 *
 * Events are derived from durable state, never taken from a webhook body:
 *
 * 1. `client.reporting.poll()` runs `reconcile` and reads the subscription readback and each
 *    account's `subscription_coverage[]`.
 * 2. It compares that snapshot with the one this consumer last acknowledged, and emits one
 *    {@link ReportingEvent} per difference.
 * 3. `await batch.ack()` saves the new snapshot under compare-and-set. Until then nothing moves: a
 *    crash before the ack replays the same events, with the same ids, on the next poll. Delivery is
 *    at least once; deduplicate on `event.id`.
 *
 * Event ids are `rse_` + `sha256(agent, type, natural key, version)`, so a replay after a crash, or
 * the same change seen by two workers, produces the same id, in either SDK.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import { ReportingSubscriptionError } from '../errors';
import { canonicalJsonV1 } from '../reporting/source/manifest';
import type { AdcpStateStore } from '../server/state-store';
import type { VerifyWebhookResult } from '../signing/webhook-verifier';
import type { VerifyWebhookRequestResult } from '../webhooks';
import {
  reconcileObserved,
  type ReconcileObservation,
  type ReconcileReport,
  type ReportingReadClient,
} from './reporting-reconcile';

type Json = Record<string, unknown>;

/** Version of the saved snapshot document; a snapshot of another version is ignored. */
export const SNAPSHOT_VERSION = 1;

/** Every event type `poll` emits. */
export const EVENT_TYPES = [
  'revision.available',
  'revision.adjusted',
  'period.late',
  'period.missing_obligation',
  'period.withheld',
  'coverage.exception_opened',
  'coverage.exception_closed',
  'account.covered',
  'account.unauthorized',
  'account.regranted',
  'subscription.state_changed',
  'timezone.cutover',
] as const;

export type ReportingEventType = (typeof EVENT_TYPES)[number];

/**
 * One change this consumer has not acknowledged yet. `data` carries the event's facts with wire-style
 * keys (`account_id`, `subscription_id`, `reporting_revision_id`, `period`, ...).
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface ReportingEvent {
  /** `rse_` + 40 hex: equal for the same change on every replay, in both SDKs. */
  id: string;
  type: ReportingEventType;
  agent_id: string;
  /** When the change happened, when the seller's state says; otherwise `observed_at`. */
  occurred_at: string;
  /** The poll that saw it. */
  observed_at: string;
  data: Json;
}

/**
 * Where a consumer's acknowledged snapshot lives, one per agent. `save` must refuse (throw
 * {@link ReportingEventConflictError}) when the stored revision is no longer `expectedRevision`, so
 * two workers never both acknowledge. Use a durable store for serverless consumers: each invocation
 * starts with an empty process.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface ReportingEventStore {
  /** `'durable'` when the snapshot survives a restart. Absent reads as `'process-local'`. */
  readonly durability?: 'process-local' | 'durable';
  load(agentId: string): Promise<{ snapshot: Json; revision: number } | null>;
  save(agentId: string, snapshot: Json, options: { expectedRevision: number | null }): Promise<number>;
}

/**
 * Another worker acknowledged first; poll again. `code` is `REPORTING_EVENTS_CONFLICT`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class ReportingEventConflictError extends ReportingSubscriptionError {
  constructor(message = 'Another worker acknowledged these events first. Poll again.') {
    super('REPORTING_EVENTS_CONFLICT', message, { recovery: 'transient' });
    this.name = 'ReportingEventConflictError';
  }
}

/**
 * Process-local snapshots: development and tests only.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class InMemoryReportingEventStore implements ReportingEventStore {
  readonly durability = 'process-local' as const;
  private readonly items = new Map<string, { snapshot: string; revision: number }>();

  async load(agentId: string): Promise<{ snapshot: Json; revision: number } | null> {
    const item = this.items.get(agentId);
    return item ? { snapshot: JSON.parse(item.snapshot) as Json, revision: item.revision } : null;
  }

  async save(agentId: string, snapshot: Json, options: { expectedRevision: number | null }): Promise<number> {
    const current = this.items.get(agentId);
    if ((current?.revision ?? null) !== options.expectedRevision) throw new ReportingEventConflictError();
    const revision = (current?.revision ?? 0) + 1;
    this.items.set(agentId, { snapshot: JSON.stringify(snapshot), revision });
    return revision;
  }
}

const EVENT_COLLECTION = 'adcp_reporting_event_snapshots';

/**
 * A {@link ReportingEventStore} over an `AdcpStateStore` with `getWithVersion` and `putIfMatch`
 * (`PostgresStateStore`, `InMemoryStateStore`). It inherits the state store's durability, so a
 * `PostgresStateStore` (the `adcp_state` table, migration 0001) keeps snapshots across invocations.
 * `memoryStorage().events` and `postgresStorage({ pool }).events` are built with it.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export function createReportingEventStore(options: { store: AdcpStateStore }): ReportingEventStore {
  const { store } = options ?? ({} as { store: AdcpStateStore });
  if (!store || typeof store.getWithVersion !== 'function' || typeof store.putIfMatch !== 'function') {
    throw new TypeError(
      'createReportingEventStore needs a state store with getWithVersion and putIfMatch, such as PostgresStateStore.'
    );
  }
  return {
    durability: store.durability ?? 'process-local',
    async load(agentId) {
      const item = await store.getWithVersion!<{ snapshot: Json }>(EVENT_COLLECTION, agentId);
      return item ? { snapshot: item.data.snapshot, revision: item.version } : null;
    },
    async save(agentId, snapshot, { expectedRevision }) {
      const result = await store.putIfMatch!(EVENT_COLLECTION, agentId, { snapshot }, expectedRevision);
      if (!result.ok) throw new ReportingEventConflictError();
      return result.version;
    },
  };
}

/**
 * One poll: the events since the last acknowledgement, the report they came from, and `ack()`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface EventBatch {
  events: ReportingEvent[];
  report: ReconcileReport;
  /** Whether `ack()` has saved this batch. */
  readonly acked: boolean;
  /**
   * Save this poll's snapshot, so its events are not delivered again. Throws
   * {@link ReportingEventConflictError} when another worker acknowledged first.
   */
  ack(): Promise<void>;
}

const VERIFIED: unique symbol = Symbol('adcp.verifiedWebhook');
const minted = new WeakSet<object>();

/**
 * A webhook delivery whose signature the SDK verified. Build it with {@link VerifiedWebhook.fromOutcome}
 * from a successful `verifyWebhookSignature` / `createWebhookVerifier` result (RFC 9421) or a
 * `verifyWebhookRequest` result with `ok: true`. `handleWebhook` takes only this type, and checks at
 * runtime that the SDK built it, so an unverified body never reaches the poller.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class VerifiedWebhook {
  declare readonly [VERIFIED]: true;

  private constructor(
    /** The delivery body. Never event content: it only says that something changed. */
    readonly payload: unknown,
    /** Who signed it: the RFC 9421 `agent_url` or `keyid`, or `'hmac'` for the legacy profile. */
    readonly senderIdentity: string
  ) {
    minted.add(this);
    Object.freeze(this);
  }

  /** From a verification that succeeded; anything else throws. */
  static fromOutcome(
    verification: VerifyWebhookResult | VerifyWebhookRequestResult,
    payload: unknown
  ): VerifiedWebhook {
    const value = verification as Partial<VerifyWebhookResult> & { ok?: boolean };
    if (value?.status === 'verified' && typeof value.keyid === 'string') {
      return new VerifiedWebhook(payload, value.agent_url ?? value.keyid);
    }
    if (value?.ok === true) return new VerifiedWebhook(payload, 'hmac');
    throw new TypeError('The webhook was not verified, so it cannot wake the poller. Verify its signature first.');
  }

  /** Whether `value` is a `VerifiedWebhook` the SDK built. */
  static is(value: unknown): value is VerifiedWebhook {
    return typeof value === 'object' && value !== null && minted.has(value);
  }
}

// -- snapshots -----------------------------------------------------------------------------------

/** Python's `json.dumps([str(part), ...])`: ", " separators, non-ASCII escaped. Ids depend on it. */
function key(...parts: unknown[]): string {
  const items = parts.map(part =>
    part === null || part === undefined
      ? 'null'
      : JSON.stringify(String(part)).replace(
          /[\u0080-￿]/g,
          char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        )
  );
  return `[${items.join(', ')}]`;
}

function isoZ(value: number): string {
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

const isoOf = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? isoZ(Date.parse(value)) : null;

/** The state events are derived from, as a JSON document. */
function snapshotOf(report: ReconcileReport, observation: ReconcileObservation): Json {
  const periods: Record<string, Json> = {};
  for (const line of report.periods) {
    if (line.status === 'not_owed') continue;
    periods[
      key(
        line.account_id,
        line.subscription_id,
        line.subscription_version,
        line.offering_id,
        line.period.start,
        line.period.end
      )
    ] = {
      status: line.status,
      reporting_revision_id: line.reporting_revision_id ?? null,
      reporting_obligation_id: line.reporting_obligation_id ?? null,
      finality: line.finality ?? null,
      expected_at: line.expected_at ?? null,
      period: { ...line.period },
      account_id: line.account_id,
      subscription_id: line.subscription_id,
      subscription_version: line.subscription_version,
      offering_id: line.offering_id,
      media_buy_ids: [...line.media_buy_ids],
    };
  }
  const subscriptions: Record<string, Json> = {};
  const unauthorized: Record<string, string> = {};
  for (const state of observation.subscriptions) {
    const issues = (state as { issues?: Json[] }).issues ?? [];
    subscriptions[state.subscription_id] = {
      state: state.state ?? null,
      subscription_version: state.subscription_version ?? null,
      pending_action: issues[0] ?? null,
    };
    for (const entry of state.accounts_unauthorized ?? []) {
      unauthorized[entry.account_id] = entry.unauthorized_at;
    }
  }
  const covered = new Set(report.periods.map(line => key(line.subscription_id, line.account_id)));
  const exceptions: Record<string, Json> = {};
  const cutovers: Record<string, Json> = {};
  const authorizations: Record<string, Json> = {};
  for (const account of report.accounts) {
    const record = observation.accounts.get(account.account_id);
    if (!record) continue;
    if (record.authorization) {
      authorizations[account.account_id] = {
        authorized_at: isoOf(record.authorization.authorized_at),
        regranted_at: isoOf(record.authorization.regranted_at),
      };
    }
    for (const [subscriptionId, entry] of record.coverage) {
      covered.add(key(subscriptionId, account.account_id));
      for (const item of (entry.excluded as Json[] | undefined) ?? []) {
        const packageIds = (item.package_ids as string[] | undefined) ?? [];
        exceptions[
          key(
            subscriptionId,
            account.account_id,
            item.reason ?? null,
            item.media_buy_id ?? null,
            item.from ?? null,
            packageIds.join(',')
          )
        ] = {
          subscription_id: subscriptionId,
          account_id: account.account_id,
          reason: item.reason ?? null,
          media_buy_id: item.media_buy_id ?? null,
          from: item.from ?? null,
          until: item.until ?? null,
          package_ids: [...packageIds],
        };
      }
      for (const item of (entry.timezone_cutovers as Json[] | undefined) ?? []) {
        cutovers[key(subscriptionId, account.account_id, item.offering_id ?? null, item.effective_at ?? null)] = {
          subscription_id: subscriptionId,
          account_id: account.account_id,
          offering_id: item.offering_id ?? null,
          effective_at: item.effective_at ?? null,
          timezone: item.timezone ?? null,
          previous_timezone: item.previous_timezone ?? null,
        };
      }
    }
  }
  return {
    snapshot_version: SNAPSHOT_VERSION,
    periods,
    subscriptions,
    covered: [...covered].sort(),
    unauthorized,
    authorizations,
    exceptions,
    cutovers,
  };
}

function eventId(agentId: string, type: string, naturalKey: string, version: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalJsonV1([agentId, type, naturalKey, version]), 'utf8')
    .digest('hex');
  return `rse_${digest.slice(0, 40)}`;
}

const entries = (value: unknown): Array<[string, Json]> =>
  Object.entries((value as Record<string, Json> | undefined) ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );

/**
 * The events between two snapshots, in a deterministic order. With no `previous` snapshot every
 * present fact is new: each delivered revision, open exception, covered account and so on is emitted
 * once. Records each account's join count in `current.covered_generations`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export function deriveEvents(
  previous: Json | null,
  current: Json,
  options: { agentId: string; observedAt: number; graceMs?: number }
): ReportingEvent[] {
  const before = previous ?? {};
  const observed = isoZ(options.observedAt);
  const grace = options.graceMs ?? 3_600_000;
  const events: ReportingEvent[] = [];
  const emit = (type: ReportingEventType, naturalKey: string, version: unknown, occurred: unknown, data: Json) => {
    events.push({
      id: eventId(options.agentId, type, naturalKey, version),
      type,
      agent_id: options.agentId,
      occurred_at: typeof occurred === 'string' ? occurred : observed,
      observed_at: observed,
      data: { ...data },
    });
  };

  const oldSubscriptions = (before.subscriptions as Record<string, Json> | undefined) ?? {};
  for (const [subscriptionId, value] of entries(current.subscriptions)) {
    const old = oldSubscriptions[subscriptionId];
    if (old === undefined || old.state !== value.state) {
      emit('subscription.state_changed', key(subscriptionId), [value.subscription_version, value.state], null, {
        subscription_id: subscriptionId,
        state: value.state,
        previous_state: old === undefined ? null : old.state,
        subscription_version: value.subscription_version,
        pending_action: value.pending_action,
      });
    }
  }

  const oldCovered = new Set((before.covered as string[] | undefined) ?? []);
  // Each time an account (re)joins a subscription is a new occurrence, so a rejoin is never
  // deduplicated against the first join.
  const generations: Record<string, number> = { ...((before.covered_generations as Record<string, number>) ?? {}) };
  for (const item of (current.covered as string[] | undefined) ?? []) {
    if (oldCovered.has(item)) continue;
    generations[item] = Number(generations[item] ?? 0) + 1;
    const [subscriptionId, accountId] = JSON.parse(item) as [string, string];
    emit('account.covered', item, generations[item], null, { subscription_id: subscriptionId, account_id: accountId });
  }
  current.covered_generations = generations;

  const oldUnauthorized = (before.unauthorized as Record<string, string> | undefined) ?? {};
  const newUnauthorized = (current.unauthorized as Record<string, string> | undefined) ?? {};
  for (const [accountId, lost] of entries(newUnauthorized) as unknown as Array<[string, string]>) {
    if (oldUnauthorized[accountId] !== lost) {
      emit('account.unauthorized', key(accountId), lost, lost, { account_id: accountId, unauthorized_at: lost });
    }
  }
  const oldAuthorizations = (before.authorizations as Record<string, Json> | undefined) ?? {};
  const newAuthorizations = (current.authorizations as Record<string, Json> | undefined) ?? {};
  for (const [accountId, lost] of entries(oldUnauthorized) as unknown as Array<[string, string]>) {
    if (accountId in newUnauthorized) continue;
    const granted = newAuthorizations[accountId];
    if (granted === undefined) continue;
    const regranted = (granted.regranted_at ?? granted.authorized_at ?? null) as string | null;
    emit('account.regranted', key(accountId), [lost, regranted], regranted, {
      account_id: accountId,
      unauthorized_at: lost,
      regranted_at: regranted,
      authorized_at: granted.authorized_at ?? null,
      chain: granted.authorized_at === oldAuthorizations[accountId]?.authorized_at ? 'continued' : 'new',
    });
  }

  const oldExceptions = (before.exceptions as Record<string, Json> | undefined) ?? {};
  const newExceptions = (current.exceptions as Record<string, Json> | undefined) ?? {};
  for (const [itemKey, value] of entries(newExceptions)) {
    const old = oldExceptions[itemKey];
    const open = value.until === null || value.until === undefined;
    const wasOpen = old !== undefined && (old.until === null || old.until === undefined);
    if (open && (old === undefined || !wasOpen)) {
      emit('coverage.exception_opened', itemKey, value.from ?? null, value.from, value);
    }
    if (!open && wasOpen) emit('coverage.exception_closed', itemKey, value.until, value.until, value);
  }
  for (const [itemKey, old] of entries(oldExceptions)) {
    if (!(itemKey in newExceptions) && (old.until === null || old.until === undefined)) {
      emit('coverage.exception_closed', itemKey, 'gone', null, { ...old, until: null });
    }
  }

  const oldCutovers = (before.cutovers as Record<string, Json> | undefined) ?? {};
  for (const [itemKey, value] of entries(current.cutovers)) {
    if (!(itemKey in oldCutovers)) emit('timezone.cutover', itemKey, 1, value.effective_at, value);
  }

  const oldPeriods = (before.periods as Record<string, Json> | undefined) ?? {};
  for (const [itemKey, value] of entries(current.periods)) {
    const old = oldPeriods[itemKey] ?? {};
    const { status, ...line } = value;
    const revision = (value.reporting_revision_id ?? null) as string | null;
    const oldRevision = (old.reporting_revision_id ?? null) as string | null;
    if (revision !== null && revision !== oldRevision) {
      emit(oldRevision !== null ? 'revision.adjusted' : 'revision.available', itemKey, revision, null, {
        ...line,
        superseded_reporting_revision_id: oldRevision,
      });
    }
    if (status !== old.status && (status === 'late' || status === 'missing_obligation' || status === 'withheld')) {
      let occurred: string | null = null;
      if (status === 'late' && typeof value.expected_at === 'string') {
        occurred = isoZ(Date.parse(value.expected_at) + grace);
      } else if (status === 'missing_obligation') {
        occurred = isoZ(Date.parse((value.period as { end: string }).end) + grace);
      }
      emit(`period.${status}`, itemKey, status, occurred, line);
    }
  }
  return events;
}

/** Keep the previous view of what a partial run could not read, so nothing unread reads as changed. */
function mergePartial(previous: Json, current: Json, report: ReconcileReport): Json {
  const unread = new Set(
    report.accounts.filter(item => item.status === 'failed' && item.account_id !== '*').map(item => item.account_id)
  );
  const everything =
    report.accounts.length === 0 || report.accounts.some(item => item.status === 'failed' && item.account_id === '*');
  const merged: Json = { ...current };
  for (const section of ['periods', 'exceptions', 'cutovers']) {
    const values: Record<string, Json> = { ...((current[section] as Record<string, Json> | undefined) ?? {}) };
    for (const [itemKey, value] of Object.entries((previous[section] as Record<string, Json> | undefined) ?? {})) {
      if ((everything || unread.has(String(value.account_id))) && !(itemKey in values)) values[itemKey] = value;
    }
    merged[section] = values;
  }
  if (everything) {
    // A run that could not read the roster keeps the previous subscriptions and losses.
    for (const section of ['subscriptions', 'unauthorized', 'authorizations']) {
      merged[section] = { ...((previous[section] as Json | undefined) ?? {}), ...((current[section] as Json) ?? {}) };
    }
    merged.covered = [
      ...new Set([...((current.covered as string[]) ?? []), ...((previous.covered as string[]) ?? [])]),
    ].sort();
  }
  return merged;
}

/**
 * An unauthorized account is unknown to `list_accounts`, so the snapshot keeps its last known
 * authorization: a re-grant then reads as continuing the chain or starting a new one.
 */
function rememberAuthorizations(previous: Json, current: Json): void {
  const known = (previous.authorizations as Record<string, Json> | undefined) ?? {};
  const authorizations = { ...((current.authorizations as Record<string, Json> | undefined) ?? {}) };
  for (const accountId of Object.keys((current.unauthorized as Record<string, string> | undefined) ?? {})) {
    if (!(accountId in authorizations) && known[accountId] !== undefined) authorizations[accountId] = known[accountId];
  }
  current.authorizations = authorizations;
}

// -- the consumer --------------------------------------------------------------------------------

/** Options for `client.reporting.poll`. */
export interface PollOptions {
  /** How long after a period ends the seller may take to plan it; an ISO 8601 duration, default `PT1H`. */
  grace?: string;
  /** On a consumer with no snapshot yet, record the present without emitting it (cold start). */
  baseline?: boolean;
  /** Evaluate as of this instant. Defaults to now. */
  now?: string | Date;
  /** Bounds each read. Defaults to 30 seconds. */
  readTimeoutMilliseconds?: number;
}

/** Options for `client.reporting.events`. */
export interface EventsOptions extends Omit<PollOptions, 'baseline' | 'now'> {
  /** How often to poll without a doorbell: an ISO 8601 duration or milliseconds. Default `PT5M`. */
  pollEvery?: string | number;
  /** Stops the loop. */
  signal?: AbortSignal;
  /**
   * Hears a transient poll failure (`recovery: 'transient'`, such as an unreachable seller). The loop
   * keeps going and polls again at the next tick or doorbell. Other errors end the loop.
   */
  onError?: (error: Error) => void;
}

const DURATION = /^PT?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;

function milliseconds(value: string | number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) return value;
  } else {
    const match = DURATION.exec(value);
    if (match && value !== 'P' && value !== 'PT') {
      const [, d, h, m, s] = match;
      const total = (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1_000;
      if (total > 0) return total;
    }
  }
  throw new ReportingSubscriptionError(
    'INVALID_REQUEST',
    `${field} must be a positive ISO 8601 duration such as PT5M.`,
    {
      dispatched: false,
    }
  );
}

/**
 * `poll`, `events` and `handleWebhook` for one client. `client.reporting` owns one.
 *
 * @internal
 */
export class ReportingEvents {
  private doorbell: (() => void) | undefined;
  private rung = false;
  private listening = 0;

  constructor(
    private readonly client: ReportingReadClient,
    readonly store: ReportingEventStore = new InMemoryReportingEventStore(),
    private readonly fixedAgentId?: string
  ) {}

  get agentId(): string {
    return this.fixedAgentId ?? this.client.getAgentId?.() ?? 'default';
  }

  async poll(options: PollOptions = {}): Promise<EventBatch> {
    const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
    if (!Number.isFinite(now)) {
      throw new ReportingSubscriptionError('INVALID_REQUEST', 'now must be an RFC 3339 instant.', {
        dispatched: false,
      });
    }
    const graceMs = milliseconds(options.grace ?? 'PT1H', 3_600_000, 'grace');
    const observation: ReconcileObservation = { subscriptions: [], accounts: new Map() };
    const report = await reconcileObserved(
      this.client,
      {
        grace: options.grace ?? 'PT1H',
        now: new Date(now),
        ...(options.readTimeoutMilliseconds !== undefined
          ? { readTimeoutMilliseconds: options.readTimeoutMilliseconds }
          : {}),
      },
      observation
    );
    let current = snapshotOf(report, observation);
    const agentId = this.agentId;
    const loaded = await this.store.load(agentId);
    let previous = loaded?.snapshot ?? null;
    if (previous !== null && previous.snapshot_version !== SNAPSHOT_VERSION) previous = null;
    if (!report.definitive && previous !== null) current = mergePartial(previous, current, report);
    if (previous !== null) rememberAuthorizations(previous, current);
    const events =
      loaded === null && options.baseline ? [] : deriveEvents(previous, current, { agentId, observedAt: now, graceMs });
    const store = this.store;
    const revision = loaded?.revision ?? null;
    let acked = false;
    return {
      events,
      report,
      get acked() {
        return acked;
      },
      async ack() {
        if (acked) return;
        await store.save(agentId, current, { expectedRevision: revision });
        acked = true;
      },
    };
  }

  async *events(options: EventsOptions = {}): AsyncGenerator<ReportingEvent, void, undefined> {
    const every = milliseconds(options.pollEvery, 300_000, 'pollEvery');
    const { signal } = options;
    this.listening += 1;
    try {
      while (!signal?.aborted) {
        // Consume the ring before polling: one that lands during the poll, the loop body or the
        // ack survives and polls again at once.
        this.rung = false;
        let batch: EventBatch;
        try {
          batch = await this.poll({
            ...(options.grace !== undefined ? { grace: options.grace } : {}),
            ...(options.readTimeoutMilliseconds !== undefined
              ? { readTimeoutMilliseconds: options.readTimeoutMilliseconds }
              : {}),
          });
        } catch (error) {
          // A transient read failure (the seller unreachable, a timeout) waits for the next tick or
          // doorbell instead of ending the loop; anything else is a bug or a misconfiguration.
          if ((error as { recovery?: unknown })?.recovery !== 'transient') throw error;
          options.onError?.(error as Error);
          await this.wait(every, signal);
          continue;
        }
        for (const event of batch.events) {
          if (signal?.aborted) return;
          yield event;
        }
        try {
          await batch.ack();
        } catch (error) {
          // Another worker acknowledged first: poll again at once.
          if (error instanceof ReportingEventConflictError) continue;
          throw error;
        }
        await this.wait(every, signal);
      }
    } finally {
      this.listening -= 1;
    }
  }

  /** Until `every` elapses, the doorbell rings or `signal` aborts. */
  private wait(every: number, signal: AbortSignal | undefined): Promise<void> {
    if (this.rung || signal?.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.doorbell = undefined;
        resolve();
      };
      const timer = setTimeout(done, every);
      this.doorbell = done;
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async handleWebhook(verified: VerifiedWebhook): Promise<EventBatch | null> {
    if (!VerifiedWebhook.is(verified)) {
      throw new ReportingSubscriptionError(
        'INVALID_REQUEST',
        'handleWebhook takes a verified delivery: VerifiedWebhook.fromOutcome(await verifier(request), body). Verify the signature first.',
        { dispatched: false }
      );
    }
    if (this.listening > 0) {
      this.rung = true;
      this.doorbell?.();
      return null;
    }
    return this.poll();
  }
}
