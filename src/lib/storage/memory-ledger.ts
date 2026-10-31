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
import { reportingPeriodSchedule } from '../reporting/ledger/schedule';
import {
  ReportingConsumerStatusConflictError,
  ReportingLedgerSnapshotUnavailableError,
  type ReportingLedgerStore,
} from '../reporting/ledger/types';
import { canonicalJsonV1 } from '../reporting/source/manifest';

type Row = any;

function sha(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** @internal */
export class MemoryReportingLedgerStore implements ReportingLedgerStore {
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
    if (!existing) this.revisions.set(value.reporting_revision_id, clone(value));
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
      results.push({ inserted: true, value: clone(candidate) });
    }
    this.consumerStatusBatches.set(batchKey, { requestFingerprint: input.requestFingerprint, results });
    return clone(results);
  }
}
