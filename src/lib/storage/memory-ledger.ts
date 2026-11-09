/**
 * Process-local `ReportingLedgerStore` behind `memoryStorage()` (experimental).
 *
 * It keeps every ledger record in maps and implements the same immutability, lease and caller-isolation
 * rules as the PostgreSQL store, so a development seller (and the SDK's own end-to-end tests) can drive the
 * real producer, the real `get_reporting_status` handler and the real `sync_reporting_status` ingest
 * against it. It is lost on restart: `memoryStorage()` is refused outside `NODE_ENV=test|development`.
 *
 * @internal Reached through `memoryStorage().ledger`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- ledger records are validated by the producer before they reach the store. */
import { createHash } from 'node:crypto';
import {
  assertReportingLedgerHistoryDoesNotOverlap,
  evaluateReportingLedgerCoverageV1,
  mergeReportingLedgerOwedSetV1,
  reportingLedgerCoverageClosedV1,
  reportingLedgerScopeClosed,
  reportingLedgerSubscriptionKeyV1,
  reportingLedgerSubscriptionVisibleV1,
} from '../reporting/ledger/coverage';
import { projectReportingObligationHealthV1 } from '../reporting/ledger/health';
import { compareReportingInstants, compareReportingInstantToOffset } from '../reporting/ledger/instant';
import {
  planReportingIssueEventsV1,
  reportingConsumerMismatchOccurrenceV1,
  reportingIssueEscalationV1,
  type ReportingConsumerMismatchOccurrenceV1,
  type ReportingIssueEventLeaseV1,
  type ReportingIssueEventRecordV1,
  type ReportingIssueEventStoreV1,
} from '../reporting/ledger/issue-events';
import { reportingPeriodSchedule } from '../reporting/ledger/schedule';
import {
  ReportingConsumerStatusConflictError,
  ReportingLedgerSnapshotUnavailableError,
  type ReportingLedgerStore,
} from '../reporting/ledger/types';
import { canonicalJsonV1 } from '../reporting/source/manifest';

type Row = any;

/** An occurrence's key: the read path's `issueId` does not name the consumer, and two may share it. */
function issueOccurrenceKey(value: { issueId: string; consumerId: string }): string {
  return `${value.issueId}\u0000${value.consumerId}`;
}

/** One recorded issue event and its delivery state. */
interface MemoryIssueEvent extends ReportingIssueEventRecordV1 {
  seq: number;
  recordedAt: string;
  dueAt: string;
  attempts: number;
  leaseToken?: string;
  leaseExpiresAt?: string;
  deliveredAt?: string;
}

function sha(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** @internal */
export class MemoryReportingLedgerStore implements ReportingLedgerStore, ReportingIssueEventStoreV1 {
  /** Records issue-lifecycle events for the issue observer (see `issue-events.ts`). */
  readonly issueEventsSupported = true as const;
  /** The issue-event outbox, by event id. */
  readonly issueEvents = new Map<string, MemoryIssueEvent>();
  private issueEventSeq = 0;
  readonly configurations = new Map<string, Row>();
  readonly obligations = new Map<string, Row>();
  readonly revisions = new Map<string, Row>();
  readonly adjustments = new Map<string, Row>();
  readonly statuses = new Map<string, Row>();
  readonly issues = new Map<string, Row>();
  readonly transitions = new Map<string, Row>();
  readonly snapshots = new Map<string, Row>();
  readonly leases = new Map<string, Row>();
  /** Counts pre-SDK-14 baseline reconstructions. */
  finalityBaselineReconstructions = 0;
  /** A fixed ledger instant; when unset, `now()` is used. */
  ledgerAsOf: string | undefined;
  consumerStatements: Row[] = [];
  readonly consumerStatusBatches = new Map<string, { requestFingerprint: string; results: Row[] }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private instant(): string {
    return this.ledgerAsOf ?? this.now().toISOString();
  }

  async putConfiguration(value: Row): Promise<{ inserted: boolean; value: Row }> {
    if (value.historyStart !== undefined) {
      const schedule = reportingPeriodSchedule(value);
      if (
        !Number.isSafeInteger(value.historyStartOrdinal) ||
        schedule.boundary(value.historyStartOrdinal) !== Date.parse(value.historyStart)
      ) {
        throw new TypeError('Reporting historyStart must match its schedule ordinal');
      }
      value = { ...value, historyStart: new Date(value.historyStart).toISOString() };
    } else if (value.historyStartOrdinal !== undefined) {
      throw new TypeError('Reporting historyStartOrdinal requires historyStart');
    }
    // Mirrors the PostgreSQL unique key: subscription generations add the owner and offering.
    const existing = [...this.configurations.values()].find(
      item =>
        item.account.account_id === value.account.account_id &&
        item.delivery_config_id === value.delivery_config_id &&
        item.delivery_config_version === value.delivery_config_version &&
        reportingLedgerSubscriptionKeyV1(item) === reportingLedgerSubscriptionKeyV1(value)
    );
    if (existing && existing.semanticFingerprint !== value.semanticFingerprint) throw new Error('immutable conflict');
    if (!existing) {
      assertReportingLedgerHistoryDoesNotOverlap(value, [...this.configurations.values()]);
      this.configurations.set(value.configurationId, clone(value));
    }
    return { inserted: !existing, value: clone(existing ?? value) };
  }

  async extendConfigurationHistory(input: {
    configurationId: string;
    historyStart: string;
    historyStartOrdinal: number;
  }): Promise<Row> {
    input = { ...input, historyStart: new Date(input.historyStart).toISOString() };
    const stored = this.configurations.get(input.configurationId);
    if (!stored) throw new Error('Unknown reporting configuration');
    const schedule = reportingPeriodSchedule(stored);
    const previous =
      stored.historyStart ??
      new Date(
        schedule.boundary(
          Math.max(0, schedule.ceil(Math.max(Date.parse(stored.schedule.anchor), Date.parse(stored.installedAt))))
        )
      ).toISOString();
    if (
      !Number.isSafeInteger(input.historyStartOrdinal) ||
      schedule.boundary(input.historyStartOrdinal) !== Date.parse(input.historyStart)
    ) {
      throw new TypeError('Reporting historyStart must match its schedule ordinal');
    }
    if (Date.parse(input.historyStart) > Date.parse(previous))
      throw new RangeError('Reporting historyStart may only move earlier');
    const value = { ...stored, historyStart: input.historyStart, historyStartOrdinal: input.historyStartOrdinal };
    assertReportingLedgerHistoryDoesNotOverlap(value, [...this.configurations.values()]);
    this.configurations.set(input.configurationId, clone(value));
    return clone(value);
  }

  async recordOwedSetProgress({ configurationId, account_id, ...progress }: Row): Promise<Row> {
    const stored = this.configurations.get(configurationId);
    if (!stored || stored.account.account_id !== account_id || !stored.subscription) {
      throw new Error('Unknown subscription reporting configuration');
    }
    const value = { ...stored, owedSet: mergeReportingLedgerOwedSetV1(stored.owedSet, progress) };
    this.configurations.set(configurationId, clone(value));
    return clone(value);
  }

  async findObligationByOrdinal({
    account_id,
    configurationId,
    periodOrdinal,
  }: {
    account_id: string;
    configurationId: string;
    periodOrdinal: number;
  }): Promise<Row | null> {
    const value = [...this.obligations.values()].find(
      item =>
        item.account.account_id === account_id &&
        item.configurationId === configurationId &&
        item.periodOrdinal === periodOrdinal
    );
    return value ? clone(value) : null;
  }

  async listConfigurations(accountId?: string): Promise<Row[]> {
    return [...this.configurations.values()]
      .filter(value => !accountId || value.account.account_id === accountId)
      .map(value => clone(value));
  }

  async putObligation(value: Row): Promise<{ inserted: boolean; value: Row }> {
    const existing = [...this.obligations.values()].find(
      item => item.configurationId === value.configurationId && item.periodOrdinal === value.periodOrdinal
    );
    if (existing && existing.semanticFingerprint !== value.semanticFingerprint) throw new Error('immutable conflict');
    if (!existing) this.obligations.set(value.reporting_obligation_id, clone(value));
    return { inserted: !existing, value: clone(existing ?? value) };
  }

  async getObligation(id: string): Promise<Row | null> {
    return clone(this.obligations.get(id) ?? null);
  }

  async listObligations(accountId?: string): Promise<Row[]> {
    return [...this.obligations.values()]
      .filter(value => !accountId || value.account.account_id === accountId)
      .map(value => clone(value));
  }

  async listLifecycleDueObligations({
    ledgerAsOf,
    account_id,
    limit,
  }: {
    ledgerAsOf: string;
    account_id?: string;
    limit: number;
  }): Promise<Row[]> {
    const due: Row[] = [];
    for (const obligation of await this.listObligations(account_id)) {
      const latest = (await this.listTransitions(obligation.reporting_obligation_id)).at(-1)?.health ?? 'waiting';
      if (
        (latest === 'waiting' && Date.parse(obligation.expectedAt) <= Date.parse(ledgerAsOf)) ||
        (latest === 'delayed' && Date.parse(obligation.recoveryDeadlineAt) <= Date.parse(ledgerAsOf)) ||
        (obligation.state === 'terminal' &&
          latest !== 'complete' &&
          (await this.listRevisions(obligation.reporting_obligation_id)).length > 0)
      ) {
        due.push(obligation);
      }
      if (due.length >= limit) break;
    }
    return due;
  }

  async updateObligation(value: Row, lease: Row, issue?: Row): Promise<void> {
    if (lease && this.leases.get(value.reporting_obligation_id)?.generation !== lease.generation)
      throw new Error('lease lost');
    this.obligations.set(value.reporting_obligation_id, clone(value));
    if (issue) this.issues.set(issue.issueId, clone(issue));
  }

  async claimObligation({
    owner,
    now,
    leaseMilliseconds,
    account_id,
    excludeHistoryOfferingIds = [],
  }: {
    owner: string;
    now: string;
    leaseMilliseconds: number;
    account_id?: string;
    excludeHistoryOfferingIds?: string[];
  }): Promise<Row | null> {
    const value = [...this.obligations.values()]
      .sort((a, b) => Number(!!a.history) - Number(!!b.history))
      .find(
        item =>
          (!item.history || !excludeHistoryOfferingIds.includes(item.offeringId)) &&
          (!account_id || item.account.account_id === account_id) &&
          item.state === 'pending' &&
          Date.parse(item.nextAttemptAt) <= Date.parse(now) &&
          (!this.leases.has(item.reporting_obligation_id) ||
            Date.parse(this.leases.get(item.reporting_obligation_id).expiresAt) <= Date.parse(now))
      );
    if (!value) return null;
    const generation = (this.leases.get(value.reporting_obligation_id)?.generation ?? 0) + 1;
    const lease = {
      obligation: clone(value),
      owner,
      generation,
      expiresAt: new Date(Date.parse(now) + leaseMilliseconds).toISOString(),
    };
    this.leases.set(value.reporting_obligation_id, lease);
    return clone(lease);
  }

  async releaseObligationLease(lease: Row): Promise<void> {
    const current = this.leases.get(lease.obligation.reporting_obligation_id);
    if (current?.owner === lease.owner && current.generation === lease.generation) {
      this.leases.delete(lease.obligation.reporting_obligation_id);
    }
  }

  async commitRevision(value: Row): Promise<{ inserted: boolean; value: Row }> {
    const existing = [...this.revisions.values()].find(
      item =>
        item.reporting_obligation_id === value.reporting_obligation_id && item.revisionNumber === value.revisionNumber
    );
    if (existing && existing.binding.sha256 !== value.binding.sha256) throw new Error('immutable conflict');
    if (!existing) {
      this.revisions.set(value.reporting_revision_id, clone(value));
      // A restatement can make a leaf conflict (or anchor one filed before any revision), or clear one.
      this.settleIssueObligation(value.reporting_obligation_id, this.instant());
    }
    return { inserted: !existing, value: clone(existing ?? value) };
  }

  async getRevision(id: string, accountId: string): Promise<Row | null> {
    const revision = this.revisions.get(id);
    return revision?.wireRevision.account_id === accountId ? clone(revision) : null;
  }

  /** Revision identity and binding without materializing rows. */
  async getRevisionMetadata(revisionId: string, accountId: string): Promise<Row | null> {
    const revision = await this.getRevision(revisionId, accountId);
    if (!revision) return null;
    const { rows: _rows, ...metadata } = revision;
    return metadata;
  }

  async listRevisions(obligationId: string): Promise<Row[]> {
    return [...this.revisions.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber)
      .map(value => clone(value));
  }

  async commitAdjustment(value: Row): Promise<{ inserted: boolean; value: Row }> {
    const existing = [...this.adjustments.values()].find(
      item =>
        item.reporting_obligation_id === value.reporting_obligation_id &&
        item.adjustmentNumber === value.adjustmentNumber
    );
    if (existing && existing.binding.sha256 !== value.binding.sha256) throw new Error('immutable conflict');
    if (!existing) this.adjustments.set(value.reporting_adjustment_id, clone(value));
    return { inserted: !existing, value: clone(existing ?? value) };
  }

  async listAdjustments(obligationId: string): Promise<Row[]> {
    return [...this.adjustments.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .sort((a, b) => a.adjustmentNumber - b.adjustmentNumber)
      .map(value => clone(value));
  }

  async putConsumerStatus(value: Row): Promise<{ inserted: boolean; value: Row }> {
    const existing = this.statuses.get(value.consumerStatusId);
    if (!existing) this.statuses.set(value.consumerStatusId, clone(value));
    return { inserted: !existing, value: clone(existing ?? value) };
  }

  async listConsumerStatuses(revisionId: string): Promise<Row[]> {
    return [...this.statuses.values()]
      .filter(value => value.reporting_revision_id === revisionId)
      .map(value => clone(value));
  }

  async putIssue(value: Row): Promise<void> {
    this.issues.set(value.issueId, clone(value));
  }

  async resolveIssue(id: string, resolvedAt: string): Promise<void> {
    const value = this.issues.get(id);
    if (value) this.issues.set(id, { ...value, resolvedAt });
  }

  async listIssues(obligationId: string): Promise<Row[]> {
    return [...this.issues.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .map(value => clone(value));
  }

  async appendTransition(value: Row): Promise<{ inserted: boolean }> {
    const inserted = !this.transitions.has(value.transitionId);
    if (inserted) this.transitions.set(value.transitionId, clone(value));
    return { inserted };
  }

  /**
   * The committed finality baseline of the latest transition. This store keeps no commit log, so it
   * cannot say which revisions were already committed when a pre-SDK-14 transition was recorded, and
   * it must not guess from revision timestamps. It persists `'none'` as the baseline and serves every
   * later read from that value.
   */
  async resolveTransitionFinalityBaseline(obligationId: string): Promise<any> {
    const latest = (await this.listTransitions(obligationId)).at(-1);
    if (!latest) return 'none';
    if (latest.finality) return latest.finality;
    this.finalityBaselineReconstructions += 1;
    this.transitions.set(latest.transitionId, { ...this.transitions.get(latest.transitionId), finality: 'none' });
    return 'none';
  }

  async applyLifecycleProjection(input: Row): Promise<{ applied: boolean; transitionInserted: boolean }> {
    const revisionIds = (await this.listRevisions(input.reporting_obligation_id)).map(
      value => value.reporting_revision_id
    );
    const latest = (await this.listTransitions(input.reporting_obligation_id)).at(-1);
    const obligation = await this.getObligation(input.reporting_obligation_id);
    // A store compiled against the pre-finality port has no resolver and ignores expectedPreviousFinality.
    const resolver = (this as { resolveTransitionFinalityBaseline?: (id: string) => Promise<unknown> })
      .resolveTransitionFinalityBaseline;
    const previousFinality = resolver ? await resolver.call(this, input.reporting_obligation_id) : undefined;
    if (
      !obligation ||
      obligation.state !== input.expectedObligationState ||
      obligation.attemptCount !== input.expectedAttemptCount ||
      JSON.stringify(revisionIds) !== JSON.stringify(input.expectedRevisionIds) ||
      (latest?.health ?? 'waiting') !== input.expectedPreviousHealth ||
      (input.expectedPreviousFinality !== undefined &&
        previousFinality !== undefined &&
        previousFinality !== input.expectedPreviousFinality)
    ) {
      return { applied: false, transitionInserted: false };
    }
    let transitionInserted = false;
    if (input.transition) {
      transitionInserted = (await this.appendTransition(input.transition)).inserted;
      if (!transitionInserted) return { applied: false, transitionInserted: false };
    }
    const projectedIds = new Set(input.projectedIssues.map((value: Row) => value.issueId));
    for (const issue of input.projectedIssues) await this.putIssue(issue);
    for (const issue of await this.listIssues(input.reporting_obligation_id)) {
      if (
        !issue.resolvedAt &&
        ['REPORT_OVERDUE', 'REPORTING_COVERAGE_INCOMPLETE'].includes(issue.code) &&
        !projectedIds.has(issue.issueId)
      ) {
        await this.resolveIssue(issue.issueId, input.ledgerAsOf);
      }
    }
    return { applied: true, transitionInserted };
  }

  async markTransitionNotified(transitionId: string, notifiedAt: string): Promise<void> {
    const value = this.transitions.get(transitionId);
    if (value) this.transitions.set(transitionId, { ...value, notifiedAt });
  }

  async listTransitions(obligationId: string): Promise<Row[]> {
    return [...this.transitions.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .map(value => clone(value));
  }

  async listPendingTransitions({ account_id, limit = 100 }: { account_id?: string; limit?: number } = {}): Promise<
    Row[]
  > {
    const obligationIds = new Set(
      [...this.obligations.values()]
        .filter(value => !account_id || value.account.account_id === account_id)
        .map(value => value.reporting_obligation_id)
    );
    return [...this.transitions.values()]
      .filter(value => obligationIds.has(value.reporting_obligation_id) && !value.notifiedAt)
      .slice(0, limit)
      .map(value => clone(value));
  }

  async createSnapshot(query: Row): Promise<Row> {
    // Caller isolation: account generations plus the caller's own subscription generations.
    const visible = (value: Row) => reportingLedgerSubscriptionVisibleV1(value, query.subscription_principal);
    const ledgerAsOf = this.instant();
    let obligations = (await this.listObligations(query.account_id)).filter(
      value =>
        visible(value) &&
        Date.parse(value.period.end) <= Date.parse(ledgerAsOf) &&
        (!query.delivery_config_ids || query.delivery_config_ids.includes(value.delivery_config_id))
    );
    let revisions = (await Promise.all(obligations.map(value => this.listRevisions(value.reporting_obligation_id))))
      .flat()
      .map(({ rows: _rows, ...value }) => value);
    let issues = (await Promise.all(obligations.map(value => this.listIssues(value.reporting_obligation_id)))).flat();
    let adjustments = (await Promise.all(obligations.map(value => this.listAdjustments(value.reporting_obligation_id))))
      .flat()
      .map(({ rows: _rows, ...value }) => value);
    const configurations = (await this.listConfigurations(query.account_id)).filter(visible);
    const coverageOrdinals = (await this.listObligations(query.account_id)).filter(visible).map(value => ({
      configurationId: value.configurationId,
      periodOrdinal: value.periodOrdinal,
      period: { start: value.period.start, end: value.period.end },
    }));
    const ledgerCoverage = evaluateReportingLedgerCoverageV1(query, configurations, coverageOrdinals, ledgerAsOf);
    if (query.view !== 'revision' && !ledgerCoverage.complete) {
      const error = new Error('Reporting ledger is missing an elapsed obligation');
      error.name = 'ReportingLedgerContinuityError';
      throw error;
    }
    if (query.view === 'periods' && query.health) {
      const accepted = new Set(
        obligations
          .filter(value =>
            query.health.includes(
              projectReportingObligationHealthV1(
                value,
                revisions.filter(item => item.reporting_obligation_id === value.reporting_obligation_id),
                ledgerAsOf,
                reportingLedgerScopeClosed(query, ledgerAsOf, reportingLedgerCoverageClosedV1(ledgerCoverage))
              ).health
            )
          )
          .map(value => value.reporting_obligation_id)
      );
      obligations = obligations.filter(value => accepted.has(value.reporting_obligation_id));
      revisions = revisions.filter(value => accepted.has(value.reporting_obligation_id));
      adjustments = adjustments.filter(value => accepted.has(value.reporting_obligation_id));
      issues = issues.filter(value => accepted.has(value.reporting_obligation_id));
    }
    const snapshot = {
      snapshotId: `snapshot-${this.snapshots.size}`,
      ledgerAsOf,
      changesCheckpoint: ledgerAsOf,
      queryFingerprint: sha(query),
      query: clone(query),
      configurations,
      coverageOrdinals,
      obligations,
      revisions,
      adjustments,
      issues,
      // Caller-scoped: `attribution` discloses a status only to the consumer that submitted it.
      consumerStatuses: this.scopedConsumerStatements(query.consumer_id, query.account_id),
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return clone(snapshot);
  }

  async readSnapshotPage(
    snapshotId: string,
    accountId: string,
    cursor: string | undefined,
    limit: number
  ): Promise<Row> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.query.account_id !== accountId) throw new ReportingLedgerSnapshotUnavailableError();
    const offset = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).offset : 0;
    const visibleRevisions: Row[] = snapshot.query.finality
      ? snapshot.revisions.filter((value: Row) => snapshot.query.finality.includes(value.finality))
      : snapshot.revisions;
    const visibleRevisionIds = new Set(visibleRevisions.map(value => value.reporting_revision_id));
    const items: { kind: 'obligation' | 'revision' | 'adjustment'; value: Row }[] = snapshot.obligations.flatMap(
      (obligation: Row) => [
        ...(snapshot.query.view === 'revision' ? [] : [{ kind: 'obligation', value: obligation }]),
        ...visibleRevisions
          .filter(value => value.reporting_obligation_id === obligation.reporting_obligation_id)
          .map(value => ({ kind: 'revision', value })),
        ...snapshot.adjustments
          .filter(
            (value: Row) =>
              value.reporting_obligation_id === obligation.reporting_obligation_id &&
              (!snapshot.query.finality || visibleRevisionIds.has(value.adjusts_reporting_revision_id))
          )
          .map((value: Row) => ({ kind: 'adjustment', value })),
      ]
    );
    const selected = items.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return {
      snapshot: clone(snapshot),
      obligations: selected.filter(value => value.kind === 'obligation').map(value => value.value),
      revisions: selected.filter(value => value.kind === 'revision').map(value => value.value),
      adjustments: selected.filter(value => value.kind === 'adjustment').map(value => value.value),
      // Repeated on every page: the history is the caller's, not a slice of the denominator.
      consumerStatuses: clone(snapshot.consumerStatuses ?? []),
      totalCount: items.length,
      offset,
      limit,
      hasMore: nextOffset < items.length,
      ...(nextOffset < items.length
        ? { nextCursor: Buffer.from(JSON.stringify({ snapshotId, offset: nextOffset })).toString('base64url') }
        : {}),
    };
  }

  // --- consumer-status loop (`sync_reporting_status`) -------------------------

  private scopedConsumerStatements(consumerId: string | undefined, accountId: string): Row[] {
    if (!consumerId) return [];
    return clone(
      this.consumerStatements.filter(value => value.consumerId === consumerId && value.account_id === accountId)
    );
  }

  private consumerChainKey(status: Row): string {
    return [
      status.delivery_config_id,
      status.delivery_config_version,
      status.report_definition_id,
      status.period.start,
      status.period.end,
      status.period.source_timezone,
    ].join('\u0000');
  }

  /** The caller's one unsuperseded statement for a chain, or undefined. */
  private currentConsumerLeaf(status: Row, accountId: string, consumerId: string): Row | undefined {
    const chain = this.consumerStatements.filter(
      value =>
        value.account_id === accountId &&
        value.consumerId === consumerId &&
        this.consumerChainKey(value) === this.consumerChainKey(status)
    );
    const superseded = new Set(chain.map(value => value.supersedes_reporting_status_id).filter(Boolean));
    return chain.find(value => !superseded.has(value.reporting_status_id));
  }

  async getConsumerStatusBatchReplay({
    account_id,
    consumerId,
    idempotencyKey,
    requestFingerprint,
  }: Row): Promise<Row[] | null> {
    const prior = this.consumerStatusBatches.get([account_id, consumerId, idempotencyKey].join('\u0000'));
    if (!prior) return null;
    if (prior.requestFingerprint !== requestFingerprint) {
      throw new ReportingConsumerStatusConflictError('Reporting status idempotency key was reused');
    }
    return clone(prior.results);
  }

  async syncConsumerStatusBatch(input: Row): Promise<Row[]> {
    const batchKey = [input.account_id, input.consumerId, input.idempotencyKey].join('\u0000');
    const prior = this.consumerStatusBatches.get(batchKey);
    if (prior) {
      if (prior.requestFingerprint !== input.requestFingerprint) {
        throw new ReportingConsumerStatusConflictError('Reporting status idempotency key was reused');
      }
      return clone(prior.results);
    }
    const idCounts = new Map<string, number>();
    const chainCounts = new Map<string, number>();
    for (const entry of input.entries) {
      const id = entry.status?.reporting_status_id ?? entry.reporting_status_id;
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      if (entry.status) {
        const chain = this.consumerChainKey(entry.status);
        chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
      }
    }
    const recordedAt = this.instant();
    const results: Row[] = [];
    for (const entry of input.entries) {
      const id = entry.status?.reporting_status_id ?? entry.reporting_status_id;
      const failed = (errorCode: string, safeMessage: string) => ({
        inserted: false,
        reporting_status_id: id,
        errorCode,
        safeMessage,
        ...(entry.validationField ? { errorField: entry.validationField } : {}),
        ...(entry.validationKeyword ? { errorKeyword: entry.validationKeyword } : {}),
      });
      if (entry.validationError) {
        results.push(failed('VALIDATION_ERROR', entry.validationError));
        continue;
      }
      // Duplicate IDs and duplicate chains fail as a group: the batch may not pick a winner.
      if ((idCounts.get(id) ?? 0) > 1 || (chainCounts.get(this.consumerChainKey(entry.status)) ?? 0) > 1) {
        results.push(failed('IDEMPOTENCY_CONFLICT', 'Reporting status batch names the same chain twice'));
        continue;
      }
      const existing = this.consumerStatements.find(
        value =>
          value.reporting_status_id === id &&
          value.account_id === input.account_id &&
          value.consumerId === input.consumerId
      );
      const candidate = { ...entry.status, recorded_at: recordedAt };
      if (existing) {
        const { recorded_at: _existingRecordedAt, ...immutableExisting } = existing;
        const { recorded_at: _candidateRecordedAt, ...immutableCandidate } = candidate;
        if (JSON.stringify(immutableExisting) !== JSON.stringify(immutableCandidate)) {
          results.push(failed('IDEMPOTENCY_CONFLICT', 'Reporting status ID was reused with different content'));
          continue;
        }
        results.push({ inserted: false, value: clone(existing) });
        continue;
      }
      const leaf = this.currentConsumerLeaf(entry.status, input.account_id, input.consumerId);
      if ((leaf?.reporting_status_id ?? undefined) !== (entry.status.supersedes_reporting_status_id ?? undefined)) {
        results.push(failed('IDEMPOTENCY_CONFLICT', 'Reporting status did not name the current leaf'));
        continue;
      }
      this.consumerStatements.push(clone(candidate));
      this.settleIssueChain(candidate);
      results.push({ inserted: true, value: clone(candidate) });
    }
    this.consumerStatusBatches.set(batchKey, { requestFingerprint: input.requestFingerprint, results });
    return clone(results);
  }

  // --- issue-lifecycle events (the issue observer) ----------------------------

  private obligationMatchesStatement(obligation: Row, status: Row): boolean {
    return (
      obligation.account.account_id === status.account_id &&
      status.delivery_config_id === obligation.delivery_config_id &&
      status.delivery_config_version === obligation.delivery_config_version &&
      status.report_definition_id === obligation.report_definition_id &&
      compareReportingInstants(status.period.start, obligation.period.start) === 0 &&
      compareReportingInstants(status.period.end, obligation.period.end) === 0 &&
      status.period.source_timezone === obligation.period.sourceTimezone
    );
  }

  private revisionMetadata(obligationId: string): Row[] {
    return [...this.revisions.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber)
      .map(({ rows: _rows, ...metadata }) => metadata);
  }

  /** Occurrences whose `opened` is recorded and that have not resolved. */
  private openIssueOccurrences(): MemoryIssueEvent[] {
    const resolved = new Set(
      [...this.issueEvents.values()].filter(value => value.kind === 'resolved').map(issueOccurrenceKey)
    );
    return [...this.issueEvents.values()].filter(
      value => value.kind === 'opened' && !resolved.has(issueOccurrenceKey(value))
    );
  }

  private conflictsOn(obligation: Row): ReportingConsumerMismatchOccurrenceV1[] {
    const revisions = this.revisionMetadata(obligation.reporting_obligation_id);
    const chains = new Map<string, Row[]>();
    for (const status of this.consumerStatements) {
      if (!this.obligationMatchesStatement(obligation, status)) continue;
      chains.set(status.consumerId, [...(chains.get(status.consumerId) ?? []), status]);
    }
    return [...chains.values()].flatMap(statements => {
      const superseded = new Set(statements.map(value => value.supersedes_reporting_status_id).filter(Boolean));
      const leaf = statements.find(value => !superseded.has(value.reporting_status_id));
      const occurrence = reportingConsumerMismatchOccurrenceV1(obligation, leaf, revisions);
      return occurrence ? [occurrence] : [];
    });
  }

  private recordIssueEvents(records: readonly ReportingIssueEventRecordV1[]): number {
    let recorded = 0;
    for (const record of records) {
      if (this.issueEvents.has(record.eventId)) continue; // exactly once per (issueId, consumerId, kind)
      const now = this.instant();
      this.issueEventSeq += 1;
      this.issueEvents.set(record.eventId, {
        ...clone(record),
        seq: this.issueEventSeq,
        recordedAt: now,
        dueAt: now,
        attempts: 0,
      });
      recorded += 1;
    }
    return recorded;
  }

  /** Re-derive one obligation's occurrences after a write: open what conflicts, resolve what cleared. */
  private settleIssueObligation(obligationId: string, at: string): void {
    const obligation = this.obligations.get(obligationId);
    this.recordIssueEvents(
      planReportingIssueEventsV1({
        open: this.openIssueOccurrences().filter(value => value.reportingObligationId === obligationId),
        conflicts: obligation ? this.conflictsOn(obligation) : [],
        at,
      })
    );
  }

  /**
   * After a statement lands: resolve the occurrence of the leaf it superseded, open one for it if it
   * conflicts. Scoped to the statement's own chain, so it works before the obligation exists.
   */
  private settleIssueChain(statement: Row): void {
    const chain = new Set(
      this.consumerStatements
        .filter(
          value =>
            value.account_id === statement.account_id &&
            value.consumerId === statement.consumerId &&
            this.consumerChainKey(value) === this.consumerChainKey(statement)
        )
        .map(value => value.reporting_status_id)
    );
    const obligation = [...this.obligations.values()].find(value => this.obligationMatchesStatement(value, statement));
    const occurrence = obligation
      ? reportingConsumerMismatchOccurrenceV1(
          obligation,
          statement,
          this.revisionMetadata(obligation.reporting_obligation_id)
        )
      : undefined;
    this.recordIssueEvents(
      planReportingIssueEventsV1({
        open: this.openIssueOccurrences().filter(
          value =>
            value.accountId === statement.account_id &&
            value.consumerId === statement.consumerId &&
            chain.has(value.reportingStatusId)
        ),
        conflicts: occurrence ? [occurrence] : [],
        at: statement.recorded_at,
      })
    );
  }

  async issueEventsReady(): Promise<boolean> {
    return true;
  }

  async sweepIssueEscalations({
    escalationSeconds,
    accountId,
    limit = 100,
  }: {
    escalationSeconds: number;
    accountId?: string;
    limit?: number;
  }): Promise<number> {
    if (!Number.isSafeInteger(escalationSeconds) || escalationSeconds < 0) {
      throw new RangeError('escalationSeconds must be a non-negative integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    const now = this.instant();
    const escalated = new Set(
      [...this.issueEvents.values()].filter(value => value.kind === 'escalated').map(issueOccurrenceKey)
    );
    const due = (value: MemoryIssueEvent) =>
      (accountId === undefined || value.accountId === accountId) &&
      !escalated.has(issueOccurrenceKey(value)) &&
      compareReportingInstantToOffset(now, value.occurredAt, escalationSeconds * 1_000) >= 0;
    const obligationIds = [
      ...new Set(
        this.openIssueOccurrences()
          .filter(due)
          .sort((a, b) => compareReportingInstants(a.occurredAt, b.occurredAt) || a.seq - b.seq)
          .map(value => value.reportingObligationId)
      ),
    ].slice(0, limit);
    let recorded = 0;
    for (const obligationId of obligationIds) {
      // Settle first, as a write would: a cleared condition resolves instead of escalating.
      this.settleIssueObligation(obligationId, now);
      for (const opened of this.openIssueOccurrences().filter(
        value => value.reportingObligationId === obligationId && due(value)
      )) {
        const escalation = reportingIssueEscalationV1(opened, escalationSeconds, now);
        if (escalation) recorded += this.recordIssueEvents([escalation]);
      }
    }
    return recorded;
  }

  async claimIssueEvents({
    leaseMilliseconds,
    limit,
    accountId,
  }: {
    leaseMilliseconds: number;
    limit: number;
    accountId?: string;
  }): Promise<ReportingIssueEventLeaseV1[]> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new RangeError('leaseMilliseconds must be a positive integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    const now = this.instant();
    const pending = [...this.issueEvents.values()]
      .filter(value => value.deliveredAt === undefined)
      .sort((a, b) => a.seq - b.seq);
    // An occurrence's events go out in recording order: only its earliest undelivered one is claimable.
    const head = new Map<string, number>();
    for (const value of pending) {
      if (!head.has(issueOccurrenceKey(value))) head.set(issueOccurrenceKey(value), value.seq);
    }
    const due = pending
      .filter(
        value =>
          head.get(issueOccurrenceKey(value)) === value.seq &&
          (accountId === undefined || value.accountId === accountId) &&
          Date.parse(value.dueAt) <= Date.parse(now) &&
          (value.leaseExpiresAt === undefined || Date.parse(value.leaseExpiresAt) <= Date.parse(now))
      )
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.seq - b.seq)
      .slice(0, limit);
    const leaseToken = createHash('sha256').update(`${now}:${this.issueEventSeq}:${Math.random()}`).digest('hex');
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMilliseconds).toISOString();
    return due.map(value => {
      value.attempts += 1;
      value.leaseToken = leaseToken;
      value.leaseExpiresAt = leaseExpiresAt;
      const statement = this.consumerStatements.find(
        item =>
          item.account_id === value.accountId &&
          item.consumerId === value.consumerId &&
          item.reporting_status_id === value.reportingStatusId
      );
      const { seq: _seq, dueAt: _dueAt, deliveredAt: _deliveredAt, ...lease } = value;
      return clone({
        ...lease,
        leaseToken,
        leaseExpiresAt,
        ...(statement ? { statement } : {}),
      }) as ReportingIssueEventLeaseV1;
    });
  }

  private leasedIssueEvent(lease: ReportingIssueEventLeaseV1): MemoryIssueEvent | undefined {
    const value = this.issueEvents.get(lease.eventId);
    return value && value.deliveredAt === undefined && value.leaseToken === lease.leaseToken ? value : undefined;
  }

  async completeIssueEvent(lease: ReportingIssueEventLeaseV1): Promise<boolean> {
    const value = this.leasedIssueEvent(lease);
    if (!value) return false;
    value.deliveredAt = this.instant();
    delete value.leaseToken;
    delete value.leaseExpiresAt;
    return true;
  }

  async releaseIssueEvent(
    lease: ReportingIssueEventLeaseV1,
    { retryAfterMilliseconds }: { retryAfterMilliseconds: number }
  ): Promise<boolean> {
    const value = this.leasedIssueEvent(lease);
    if (!value) return false;
    value.dueAt = new Date(Date.parse(this.instant()) + Math.max(0, retryAfterMilliseconds)).toISOString();
    delete value.leaseToken;
    delete value.leaseExpiresAt;
    return true;
  }

  /** Whether an occurrence can never be derived again: its statement is no longer current, or its obligation is gone. */
  private issueOccurrenceClosed(event: MemoryIssueEvent): boolean {
    if (!this.obligations.has(event.reportingObligationId)) return true;
    const statement = this.consumerStatements.find(
      value =>
        value.account_id === event.accountId &&
        value.consumerId === event.consumerId &&
        value.reporting_status_id === event.reportingStatusId
    );
    if (!statement) return true;
    return (
      this.currentConsumerLeaf(statement, event.accountId, event.consumerId)?.reporting_status_id !==
      statement.reporting_status_id
    );
  }

  async pruneIssueEvents({
    olderThanMilliseconds,
    limit = 1_000,
  }: {
    olderThanMilliseconds: number;
    limit?: number;
  }): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    const horizon = Date.parse(this.instant()) - olderThanMilliseconds;
    // The outbox is the occurrence ledger: prune whole occurrences, and only closed ones. Closed means resolved,
    // every event delivered before the horizon, and unable to be derived again: its causing statement is no
    // longer the consumer's current leaf, or its obligation is gone. An open occurrence's `opened` record is
    // what a later write resolves and what the sweep escalates; a resolved one whose statement is still
    // current is the anchor that stops a later write recording its delivered events again.
    const occurrences = new Map<string, MemoryIssueEvent[]>();
    for (const value of this.issueEvents.values()) {
      const key = issueOccurrenceKey(value);
      occurrences.set(key, [...(occurrences.get(key) ?? []), value]);
    }
    const expired = [...occurrences.values()]
      .filter(
        events =>
          events.some(value => value.kind === 'resolved') &&
          events.every(value => value.deliveredAt !== undefined && Date.parse(value.deliveredAt) < horizon) &&
          this.issueOccurrenceClosed(events[0]!)
      )
      .map(events => ({ events, lastDelivered: Math.max(...events.map(value => Date.parse(value.deliveredAt!))) }))
      .sort((a, b) => a.lastDelivered - b.lastDelivered)
      .slice(0, limit);
    let deleted = 0;
    for (const { events } of expired) {
      for (const value of events) this.issueEvents.delete(value.eventId);
      deleted += events.length;
    }
    return deleted;
  }
}
