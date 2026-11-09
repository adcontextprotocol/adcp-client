/**
 * Issue-lifecycle events: tell the seller when a reporting issue opens, escalates or resolves
 * (adcp-client#3648, the TypeScript side of adcp-client-python#1874 and #1875).
 *
 * A `CONSUMER_STATUS_MISMATCH` is caller-scoped: only the buyer whose `sync_reporting_status`
 * statement caused it sees it in `get_reporting_status`. Without these events a seller has no
 * supported way to learn that one opened, escalated past `consumer_mismatch_escalation_seconds`, or
 * resolved, and a buyer that files a statement and never polls again is never noticed.
 *
 * A store that opts in ({@link ReportingIssueEventStoreV1}) keeps a transactional outbox:
 *
 * - **`opened`** and **`resolved`** are recorded in the same transaction as the write that changed the
 *   condition: a `sync_reporting_status` statement landing (it can open a mismatch on the new leaf and
 *   resolve the one on the leaf it superseded) or a revision commit (a restatement can make a leaf
 *   conflict, or anchor one filed before any revision existed). The occurrence follows the read path's
 *   own projection, {@link projectReportingConsumerStatusMismatchV1}, with the seller-health suppression
 *   removed: while the seller's own projection is degraded the read stops publishing the mismatch, but
 *   the disagreement still stands, so the occurrence stays open.
 * - **`escalated`** is recorded by the worker turn's sweep once an open occurrence passes `openedAt`
 *   plus the seller's escalation window. The sweep settles the occurrence's obligation first, so a
 *   cleared condition resolves instead of escalating.
 * - **`acknowledged`** and **`waived`** are kinds the Python SDK records for its operator issue-state
 *   API. The TypeScript ledger has no such API yet, so **no TypeScript store emits them**; they are in
 *   the union only so an observer shared across SDKs type-checks.
 *
 * An occurrence is identified by `(issueId, consumerId)`: the read path's `issueId` names the obligation
 * and the causing `reporting_status_id` but not the consumer, and two consumers may legally reuse one
 * status id, so the consumer is part of every key here. Each transition is recorded exactly once, even
 * when replicas make it together: `(issueId, consumerId, kind)` is unique and
 * {@link reportingIssueEventIdV1} derives the event's id from that triple. Delivery
 * ({@link createReportingIssueEventDispatcherV1}) is **at least once**: deduplicate on `eventId`.
 *
 * The outbox is also the occurrence ledger: an occurrence is open while its `opened` record exists and it
 * has no `resolved` one. Pruning therefore removes whole occurrences, and only resolved ones whose every
 * event was delivered.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import {
  projectReportingConsumerStatusMismatchV1,
  projectReportingObligationHealthV1,
  projectReportingUnreadableRevisionHealthV1,
} from './health';
import { addReportingInstantOffset, compareReportingInstantToOffset, compareReportingInstants } from './instant';
import type {
  ReportingConsumerMismatchEscalationV1,
  ReportingLedgerConsumerStatementV1,
  ReportingLedgerIssueV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionSnapshotV1,
  ReportingLedgerStore,
  ReportingLedgerSubscriptionPrincipalV1,
} from './types';

/**
 * One lifecycle transition of one reporting-issue occurrence.
 *
 * `opened`, `acknowledged`, `waived` and `resolved` are the spec's `issue_state` values; `escalated` is
 * the `consumer_mismatch_escalation_seconds` boundary, where the issue turns `action_required` with a
 * `contact_*` action. TypeScript stores never emit `acknowledged` or `waived` yet: the TypeScript ledger
 * has no operator issue-state API (the Python SDK's `set_issue_state`). They are listed for parity.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingIssueEventKindV1 = 'opened' | 'escalated' | 'acknowledged' | 'waived' | 'resolved';

/**
 * Every kind, in lifecycle order.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_ISSUE_EVENT_KINDS_V1: readonly ReportingIssueEventKindV1[] = Object.freeze([
  'opened',
  'escalated',
  'acknowledged',
  'waived',
  'resolved',
]);

/**
 * The stable id of one transition of one issue occurrence:
 * `"rpie_" + sha256(canonical_json_utf8_v1(["reporting-issue-event-v1", issueId, consumerId, kind])).hex()[:40]`.
 * Every redelivery of one transition carries the same id.
 *
 * The Python SDK derives its id from `["reporting-issue-event-v1", issue_id, kind]`. Its `issue_id` is
 * already consumer-scoped (the occurrence key includes the consumer), so the pair is unique there. The
 * TypeScript `issueId` is the one `get_reporting_status` publishes, `hash(obligation, reporting_status_id)`,
 * and two consumers may reuse one `reporting_status_id`, so the consumer is added here. The two SDKs
 * never produce equal ids for one disagreement anyway, since their `issueId`s differ.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingIssueEventIdV1(issueId: string, consumerId: string, kind: ReportingIssueEventKindV1): string {
  const digest = createHash('sha256')
    .update(canonicalJsonV1(['reporting-issue-event-v1', issueId, consumerId, kind]))
    .digest('hex');
  return `rpie_${digest.slice(0, 40)}`;
}

/** One occurrence's key: the issue and the consumer whose statement caused it. */
function occurrenceKey(value: Pick<ReportingIssueEventRecordV1, 'issueId' | 'consumerId'>): string {
  return canonicalJsonV1([value.issueId, value.consumerId]);
}

/**
 * One `CONSUMER_STATUS_MISMATCH` occurrence: a consumer's current statement that conflicts with the
 * seller's record of one obligation.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingConsumerMismatchOccurrenceV1 {
  /** The issue's `issue_id`, as `get_reporting_status` publishes it. */
  issueId: string;
  accountId: string;
  /** The buyer whose statement caused it. */
  consumerId: string;
  reportingObligationId: string;
  /** The causing statement. */
  reportingStatusId: string;
  /** The issue's `opened_at`: fixed from immutable ledger facts, never from the read time. */
  openedAt: string;
}

/**
 * Whether `leaf` conflicts with the seller's record of `obligation`, and the occurrence if it does.
 *
 * The same projection `get_reporting_status` runs, with one difference: the seller-health suppression is
 * removed. While the seller's own projection is degraded the read publishes the seller's issue instead,
 * but the disagreement still stands, so the occurrence stays open (the Python SDK's
 * `consumer_statement_conflicts` makes the same split). An occurrence needs at least one revision: the
 * projection anchors `openedAt` no earlier than the first one, so before it exists the instant is not
 * yet fixed.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingConsumerMismatchOccurrenceV1(
  obligation: ReportingLedgerObligationV1,
  leaf: ReportingLedgerConsumerStatementV1 | undefined,
  revisions: readonly Pick<
    ReportingLedgerRevisionSnapshotV1,
    'reporting_revision_id' | 'revisionNumber' | 'supersedes_reporting_revision_id' | 'createdAt'
  >[]
): ReportingConsumerMismatchOccurrenceV1 | undefined {
  if (!leaf || revisions.length === 0) return undefined;
  // `ledgerAsOf` only decides severity and the recommended action, never identity or `openedAt`.
  const mismatch = projectReportingConsumerStatusMismatchV1(obligation, leaf, revisions, 'healthy', leaf.recorded_at);
  if (!mismatch) return undefined;
  return {
    issueId: mismatch.issue.issueId,
    accountId: leaf.account_id,
    consumerId: leaf.consumerId,
    reportingObligationId: obligation.reporting_obligation_id,
    reportingStatusId: leaf.reporting_status_id,
    openedAt: mismatch.issue.openedAt,
  };
}

/**
 * One event as a store records it: the transition, and the occurrence it belongs to.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventRecordV1 {
  eventId: string;
  kind: ReportingIssueEventKindV1;
  issueId: string;
  accountId: string;
  consumerId: string;
  reportingObligationId: string;
  reportingStatusId: string;
  /** When the transition took effect: `openedAt`, the escalation boundary, or when it resolved. */
  occurredAt: string;
}

function eventRecord(
  occurrence: Omit<ReportingConsumerMismatchOccurrenceV1, 'openedAt'>,
  kind: ReportingIssueEventKindV1,
  occurredAt: string
): ReportingIssueEventRecordV1 {
  return {
    eventId: reportingIssueEventIdV1(occurrence.issueId, occurrence.consumerId, kind),
    kind,
    issueId: occurrence.issueId,
    accountId: occurrence.accountId,
    consumerId: occurrence.consumerId,
    reportingObligationId: occurrence.reportingObligationId,
    reportingStatusId: occurrence.reportingStatusId,
    occurredAt,
  };
}

/**
 * The events one write records over one settled scope: `opened` for each occurrence that conflicts now
 * and is not open, `resolved` for each open occurrence that no longer conflicts.
 *
 * `open` is the `opened` record of every occurrence in the scope that is not yet resolved; `conflicts`
 * is every occurrence that conflicts after the write, over the same scope. `at` is the write's instant:
 * a cleared occurrence resolves then, never before it opened. Resolutions come first, so a statement
 * that supersedes a conflicting one records the old occurrence's `resolved` before the new one's
 * `opened`. Occurrences are matched on `(issueId, consumerId)`. A store inserts each record with "on conflict
 * do nothing" on `(issueId, consumerId, kind)`.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function planReportingIssueEventsV1(input: {
  open: readonly ReportingIssueEventRecordV1[];
  conflicts: readonly ReportingConsumerMismatchOccurrenceV1[];
  at: string;
}): ReportingIssueEventRecordV1[] {
  const conflicting = new Set(input.conflicts.map(occurrenceKey));
  const open = new Set(input.open.map(occurrenceKey));
  const resolved = input.open
    .filter(value => !conflicting.has(occurrenceKey(value)))
    .map(value =>
      eventRecord(
        value,
        'resolved',
        compareReportingInstants(input.at, value.occurredAt) < 0 ? value.occurredAt : input.at
      )
    );
  const opened = input.conflicts
    .filter(value => !open.has(occurrenceKey(value)))
    .map(value => eventRecord(value, 'opened', value.openedAt));
  return [...resolved, ...opened];
}

/**
 * The `escalated` record for an open occurrence once `now` has passed its `openedAt` plus the window,
 * dated at that exact boundary; `undefined` before it.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingIssueEscalationV1(
  opened: ReportingIssueEventRecordV1,
  escalationSeconds: number,
  now: string
): ReportingIssueEventRecordV1 | undefined {
  const window = escalationSeconds * 1_000;
  if (compareReportingInstantToOffset(now, opened.occurredAt, window) < 0) return undefined;
  return eventRecord(opened, 'escalated', addReportingInstantOffset(opened.occurredAt, window));
}

/**
 * One claimed event, as a store hands it to the dispatcher.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventLeaseV1 extends ReportingIssueEventRecordV1 {
  /** When the store recorded the event. */
  recordedAt: string;
  /** Delivery attempts, this one included. */
  attempts: number;
  leaseToken: string;
  leaseExpiresAt: string;
  /** The causing consumer statement, while the store still retains it. Used to render the issue. */
  statement?: ReportingLedgerConsumerStatementV1;
}

/**
 * A ledger store that records issue events beside its writes and serves them under a lease.
 *
 * `issueEventsSupported` is the opt-in: a store that merely has methods of these names is not taken to
 * record events. The in-memory store behind `memoryStorage()` implements it, and so does
 * `PostgresReportingLedgerStore` from `@adcp/reporting-storage` once migration `0012
 * reporting_issue_events` is applied.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventStoreV1 {
  readonly issueEventsSupported: true;
  /** Whether the store can record events now (its schema is installed). */
  issueEventsReady(): Promise<boolean>;
  /**
   * Record `escalated` for open occurrences past `openedAt + escalationSeconds`, settling each
   * occurrence's obligation first so a cleared condition resolves instead. Exactly once per occurrence
   * across replicas. Returns the `escalated` events recorded.
   */
  sweepIssueEscalations(input: { escalationSeconds: number; accountId?: string; limit?: number }): Promise<number>;
  /**
   * Lease up to `limit` due events, at most one per occurrence (`(issueId, consumerId)`), each occurrence's in recording order: an
   * event is claimable only once every earlier event of its occurrence was delivered. An unsettled lease
   * expires after `leaseMilliseconds` and is claimable again.
   */
  claimIssueEvents(input: {
    leaseMilliseconds: number;
    limit: number;
    accountId?: string;
  }): Promise<ReportingIssueEventLeaseV1[]>;
  /** Mark a leased event delivered; `false` when the lease was lost. */
  completeIssueEvent(lease: ReportingIssueEventLeaseV1): Promise<boolean>;
  /** Give back a failed delivery, due again `retryAfterMilliseconds` from now; `false` when the lease was lost. */
  releaseIssueEvent(lease: ReportingIssueEventLeaseV1, input: { retryAfterMilliseconds: number }): Promise<boolean>;
  /**
   * Delete up to `limit` whole occurrences that are resolved and whose every event was delivered more than
   * `olderThanMilliseconds` ago. Returns the events deleted.
   *
   * Never an open occurrence, however old its delivered events: the `opened` record is what a later write
   * resolves and what the escalation sweep escalates, so deleting it would lose both.
   */
  pruneIssueEvents(input: { olderThanMilliseconds: number; limit?: number }): Promise<number>;
}

/**
 * Whether `store` opted in to recording issue events.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function supportsReportingIssueEventsV1(store: unknown): store is ReportingIssueEventStoreV1 {
  if (typeof store !== 'object' || store === null) return false;
  const candidate = store as Partial<Record<keyof ReportingIssueEventStoreV1, unknown>>;
  return (
    candidate.issueEventsSupported === true &&
    typeof candidate.issueEventsReady === 'function' &&
    typeof candidate.sweepIssueEscalations === 'function' &&
    typeof candidate.claimIssueEvents === 'function' &&
    typeof candidate.completeIssueEvent === 'function' &&
    typeof candidate.releaseIssueEvent === 'function' &&
    typeof candidate.pruneIssueEvents === 'function'
  );
}

/**
 * What the issue observer receives: one lifecycle transition of one reporting-issue occurrence.
 *
 * Delivered **at least once**: deduplicate on `eventId`, which is the same on every delivery of this
 * transition.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventV1 {
  /** Stable across redeliveries of this transition: deduplicate on it. */
  eventId: string;
  /** TypeScript stores emit `opened`, `escalated` and `resolved`; never `acknowledged` or `waived` yet. */
  kind: ReportingIssueEventKindV1;
  /** When the transition took effect: the issue's `openedAt`, the escalation boundary, or when it resolved. */
  occurredAt: string;
  accountId: string;
  /** The buyer whose statement caused the caller-scoped issue. */
  consumerId: string;
  /** The owning principal, when the obligation belongs to a reporting subscription. */
  principal?: ReportingLedgerSubscriptionPrincipalV1;
  issueId: string;
  reportingObligationId: string;
  /** The consumer statement that caused the issue. */
  reportingStatusId: string;
  /**
   * The issue as `get_reporting_status` rendered it for `consumerId` at `occurredAt`:
   * `responsibleParty`, `recommendedAction`, `severity`, `openedAt`. `null` for `resolved`, while the
   * seller's own projection suppressed it at that instant, and when the evidence is no longer retained.
   * Rendering is best effort and leaves Managed Delivery out.
   */
  issue: ReportingLedgerIssueV1 | null;
  /** This delivery's attempt number, from 1. */
  attempt: number;
}

/**
 * The seller's callback. Its return value is ignored; a returned promise is awaited up to the
 * dispatcher's timeout.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingIssueObserverV1 = (event: Readonly<ReportingIssueEventV1>) => void | Promise<void>;

/**
 * Evidence the dispatcher reads to render one event's issue.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventRenderContextV1 {
  obligation: ReportingLedgerObligationV1;
  revisions: readonly ReportingLedgerRevisionSnapshotV1[];
  /** The obligation's persisted issues; an open `REVISION_UNREADABLE` degrades the seller's projection. */
  issues: readonly ReportingLedgerIssueV1[];
  statement: ReportingLedgerConsumerStatementV1;
}

/**
 * Build the observer's event, rendering the issue as `get_reporting_status` showed it to `consumerId` at
 * `occurredAt`: revisions created by then, persisted issues open at then, the causing statement, and
 * the seller's escalation window. Anything it cannot reconstruct yields `issue: null` rather than a
 * wrong issue.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function renderReportingIssueEventV1(
  lease: ReportingIssueEventLeaseV1,
  context: ReportingIssueEventRenderContextV1 | undefined,
  escalation?: ReportingConsumerMismatchEscalationV1
): ReportingIssueEventV1 {
  const subscription = context?.obligation.subscription;
  return {
    eventId: lease.eventId,
    kind: lease.kind,
    occurredAt: lease.occurredAt,
    accountId: lease.accountId,
    consumerId: lease.consumerId,
    ...(subscription ? { principal: { tenantId: subscription.tenantId, principalId: subscription.principalId } } : {}),
    issueId: lease.issueId,
    reportingObligationId: lease.reportingObligationId,
    reportingStatusId: lease.reportingStatusId,
    issue: lease.kind === 'resolved' || !context ? null : renderIssueOrNull(lease, context, escalation),
    attempt: lease.attempts,
  };
}

/** Rendering must never block delivery: evidence it cannot project yields `null`, not a thrown event. */
function renderIssueOrNull(
  lease: ReportingIssueEventLeaseV1,
  context: ReportingIssueEventRenderContextV1,
  escalation: ReportingConsumerMismatchEscalationV1 | undefined
): ReportingLedgerIssueV1 | null {
  try {
    return renderIssue(lease, context, escalation);
  } catch {
    return null;
  }
}

function renderIssue(
  lease: ReportingIssueEventLeaseV1,
  context: ReportingIssueEventRenderContextV1,
  escalation: ReportingConsumerMismatchEscalationV1 | undefined
): ReportingLedgerIssueV1 | null {
  const at = lease.occurredAt;
  const revisions = context.revisions.filter(value => compareReportingInstants(value.createdAt, at) <= 0);
  const issues = context.issues.filter(
    value =>
      compareReportingInstants(value.observedAt, at) <= 0 &&
      (value.resolvedAt === undefined || compareReportingInstants(value.resolvedAt, at) > 0)
  );
  const core = projectReportingObligationHealthV1(context.obligation, revisions, at);
  const sellerHealth = projectReportingUnreadableRevisionHealthV1(context.obligation, revisions, issues, core.health);
  const mismatch = projectReportingConsumerStatusMismatchV1(
    context.obligation,
    context.statement,
    revisions,
    sellerHealth,
    at,
    escalation
  );
  return mismatch?.issue.issueId === lease.issueId ? structuredClone(mismatch.issue) : null;
}

/**
 * A failure the issue dispatcher reports instead of throwing: the observer raised or timed out
 * (`issue_observer`), claiming or sweeping failed (`issue_events`), or an event's evidence could not be
 * read for rendering (`issue_events:snapshot`). The scheduler hands each to its `onError`; `runCycle`
 * returns them in `issueEvents.errors`. An event behind an `issue_observer` or `issue_events:snapshot`
 * failure is retried after a backoff.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export class ReportingIssueObserverError extends Error {
  override readonly name = 'ReportingIssueObserverError';
  readonly component: 'issue_observer' | 'issue_events' | 'issue_events:snapshot';
  /** The event being delivered, for `issue_observer` and `issue_events:snapshot`. */
  readonly eventId: string | undefined;

  constructor(component: ReportingIssueObserverError['component'], cause: unknown, eventId?: string) {
    super(
      component === 'issue_observer'
        ? `Reporting issue observer failed for ${eventId}; the event is retried`
        : component === 'issue_events'
          ? 'Reporting issue events could not be swept or claimed'
          : `Reporting issue event ${eventId} could not be rendered yet; it is retried`,
      { cause }
    );
    this.component = component;
    this.eventId = eventId;
  }
}

/**
 * What one dispatcher turn did.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventDeliveryV1 {
  /** `escalated` events this turn's sweep recorded. */
  escalationsRecorded: number;
  /** Events the observer accepted. */
  delivered: number;
  /** Events the observer raised or timed out on, or that could not be rendered; each is retried later. */
  failed: number;
  errors: ReportingIssueObserverError[];
}

/**
 * Options for {@link createReportingIssueEventDispatcherV1}.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventDispatcherOptionsV1 {
  store: ReportingLedgerStore & ReportingIssueEventStoreV1;
  observer: ReportingIssueObserverV1;
  /** The seller's advertised escalation commitment. Without it no `escalated` event is recorded. */
  escalation?: ReportingConsumerMismatchEscalationV1;
  /** Per-call timeout for an async observer. Default 10 s, the subscriber timeout. */
  observerTimeoutMilliseconds?: number;
  /** Events claimed per batch. Default 10. */
  batchSize?: number;
  /** Batches per turn. Default 10. */
  maxBatches?: number;
  /** First retry delay; doubles per attempt. Default 30 s. */
  retryBaseMilliseconds?: number;
  /** Retry delay ceiling. Default 1 h. Retries never stop. */
  retryCapMilliseconds?: number;
  /**
   * A resolved occurrence whose events were all delivered longer ago than this is pruned. Open occurrences
   * are never pruned. Default 7 days; `null` keeps everything.
   */
  retentionMilliseconds?: number | null;
}

/**
 * Delivers a store's recorded issue events to an observer, at least once.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIssueEventDispatcherV1 {
  /** Long enough for a whole batch to time out, so a lease never lapses mid-batch. */
  readonly leaseMilliseconds: number;
  /**
   * One turn: sweep escalations, then claim due events in leased batches (at most one per occurrence at a
   * time), render each, call the observer, and mark it delivered or release it for a retry. Never throws
   * for an observer or store failure: those are returned in `errors`.
   */
  runOnce(input?: { accountId?: string; signal?: AbortSignal }): Promise<ReportingIssueEventDeliveryV1>;
}

/**
 * Build the dispatcher `createReliableReportingService` runs on every `runCycle` when given
 * `issueObserver`. Run it yourself only when you compose the ledger without the service.
 *
 * @experimental Reliable Reporting issue observer: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function createReportingIssueEventDispatcherV1(
  options: ReportingIssueEventDispatcherOptionsV1
): ReportingIssueEventDispatcherV1 {
  const { store, observer, escalation } = options;
  if (!supportsReportingIssueEventsV1(store)) {
    throw new TypeError(
      'The ledger store does not record issue events. Use memoryStorage(), or postgresStorage({ pool }) from @adcp/reporting-storage with migration 0012 applied.'
    );
  }
  if (typeof observer !== 'function') throw new TypeError('The issue observer must be a function');
  const timeout = positive(options.observerTimeoutMilliseconds ?? 10_000, 'observerTimeoutMilliseconds');
  const batchSize = positive(options.batchSize ?? 10, 'batchSize');
  const maxBatches = positive(options.maxBatches ?? 10, 'maxBatches');
  const retryBase = positive(options.retryBaseMilliseconds ?? 30_000, 'retryBaseMilliseconds');
  const retryCap = positive(options.retryCapMilliseconds ?? 3_600_000, 'retryCapMilliseconds');
  if (retryCap < retryBase) throw new RangeError('retryCapMilliseconds must be at least retryBaseMilliseconds');
  const retention =
    options.retentionMilliseconds === null
      ? null
      : nonNegative(options.retentionMilliseconds ?? 7 * 86_400_000, 'retentionMilliseconds');
  const leaseMilliseconds = batchSize * timeout + 30_000;
  const backoff = (attempts: number): number =>
    Math.min(retryCap, retryBase * 2 ** Math.min(Math.max(attempts - 1, 0), 20));

  return {
    leaseMilliseconds,
    async runOnce(input = {}) {
      const result: ReportingIssueEventDeliveryV1 = { escalationsRecorded: 0, delivered: 0, failed: 0, errors: [] };
      const scope = input.accountId !== undefined ? { accountId: input.accountId } : {};
      if (escalation) {
        try {
          result.escalationsRecorded = await store.sweepIssueEscalations({
            escalationSeconds: escalation.escalationSeconds,
            ...scope,
          });
        } catch (error) {
          result.errors.push(new ReportingIssueObserverError('issue_events', error));
        }
      }
      for (let batch = 0; batch < maxBatches && !input.signal?.aborted; batch += 1) {
        let leases: ReportingIssueEventLeaseV1[];
        try {
          leases = await store.claimIssueEvents({ leaseMilliseconds, limit: batchSize, ...scope });
        } catch (error) {
          result.errors.push(new ReportingIssueObserverError('issue_events', error));
          break;
        }
        if (leases.length === 0) break;
        const contexts = new Map<string, Promise<RenderEvidence | undefined>>();
        for (const lease of leases) {
          let context: ReportingIssueEventRenderContextV1 | undefined;
          if (lease.kind !== 'resolved') {
            try {
              let evidence = contexts.get(lease.reportingObligationId);
              if (!evidence) {
                evidence = readEvidence(store, lease);
                contexts.set(lease.reportingObligationId, evidence);
              }
              const read = await evidence;
              context = read && lease.statement ? { ...read, statement: lease.statement } : undefined;
            } catch (error) {
              // Retried rather than delivered unrendered: a transient read must not cost the seller the issue.
              result.failed += 1;
              result.errors.push(new ReportingIssueObserverError('issue_events:snapshot', error, lease.eventId));
              await settle(() => store.releaseIssueEvent(lease, { retryAfterMilliseconds: backoff(lease.attempts) }));
              continue;
            }
          }
          const event = renderReportingIssueEventV1(lease, context, escalation);
          try {
            await withTimeout(
              Promise.resolve().then(() => observer(Object.freeze(event))),
              timeout
            );
          } catch (error) {
            result.failed += 1;
            result.errors.push(new ReportingIssueObserverError('issue_observer', error, lease.eventId));
            await settle(() => store.releaseIssueEvent(lease, { retryAfterMilliseconds: backoff(lease.attempts) }));
            continue;
          }
          try {
            if (await store.completeIssueEvent(lease)) result.delivered += 1;
          } catch (error) {
            // The observer saw it; the lease expires and it is delivered again. That is the at-least-once case.
            result.errors.push(new ReportingIssueObserverError('issue_events', error, lease.eventId));
          }
        }
      }
      if (retention !== null) {
        try {
          await store.pruneIssueEvents({ olderThanMilliseconds: retention });
        } catch (error) {
          result.errors.push(new ReportingIssueObserverError('issue_events', error));
        }
      }
      return result;
    },
  };
}

type RenderEvidence = Omit<ReportingIssueEventRenderContextV1, 'statement'>;

async function readEvidence(
  store: ReportingLedgerStore,
  lease: ReportingIssueEventLeaseV1
): Promise<RenderEvidence | undefined> {
  const obligation = await store.getObligation(lease.reportingObligationId, lease.accountId);
  if (!obligation || obligation.account.account_id !== lease.accountId) return undefined;
  const revisions =
    typeof store.listRevisionMetadata === 'function'
      ? await store.listRevisionMetadata(lease.reportingObligationId, lease.accountId)
      : (await store.listRevisions(lease.reportingObligationId)).map(({ rows: _rows, ...metadata }) => metadata);
  const issues = await store.listIssues(lease.reportingObligationId);
  return { obligation, revisions, issues };
}

/** A failed release only delays the retry until the lease expires; it must not stop the batch. */
async function settle(release: () => Promise<boolean>): Promise<void> {
  try {
    await release();
  } catch {
    // The lease expires and the event is claimable again.
  }
}

async function withTimeout(value: Promise<void>, timeoutMilliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reporting issue observer timed out')), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}
