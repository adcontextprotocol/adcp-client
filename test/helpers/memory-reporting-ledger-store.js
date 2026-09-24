/**
 * In-memory `ReportingLedgerStore`, shared by the ledger tests and the buyer
 * reconciler end-to-end suite.
 *
 * It exists so a test can drive the real producer, the real
 * `get_reporting_status` handler, the real exact-revision delivery reader and
 * the real `sync_reporting_status` ingest against one another — the only way to
 * prove the buyer loop agrees with the seller loop it has to talk to.
 */
const { createHash } = require('node:crypto');

const {
  ReportingConsumerStatusConflictError,
  ReportingLedgerSnapshotUnavailableError,
  evaluateReportingLedgerCoverageV1,
  projectReportingObligationHealthV1,
  reportingLedgerScopeClosed,
} = require('@adcp/sdk/reporting/ledger');
const { canonicalJsonV1 } = require('@adcp/sdk/reporting/source');

function sha(value) {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

class MemoryLedgerStore {
  configurations = new Map();
  obligations = new Map();
  revisions = new Map();
  adjustments = new Map();
  statuses = new Map();
  issues = new Map();
  transitions = new Map();
  snapshots = new Map();
  leases = new Map();
  /** Counts pre-SDK-14 baseline reconstructions so tests can prove it runs once. */
  finalityBaselineReconstructions = 0;

  async putConfiguration(value) {
    const existing = [...this.configurations.values()].find(
      item =>
        item.account.account_id === value.account.account_id &&
        item.delivery_config_id === value.delivery_config_id &&
        item.delivery_config_version === value.delivery_config_version
    );
    if (existing && existing.semanticFingerprint !== value.semanticFingerprint) throw new Error('immutable conflict');
    if (!existing) this.configurations.set(value.configurationId, structuredClone(value));
    return { inserted: !existing, value: structuredClone(existing ?? value) };
  }
  async listConfigurations(accountId) {
    return [...this.configurations.values()].filter(value => !accountId || value.account.account_id === accountId);
  }
  async putObligation(value) {
    const existing = [...this.obligations.values()].find(
      item => item.configurationId === value.configurationId && item.periodOrdinal === value.periodOrdinal
    );
    if (existing && existing.semanticFingerprint !== value.semanticFingerprint) throw new Error('immutable conflict');
    if (!existing) this.obligations.set(value.reporting_obligation_id, structuredClone(value));
    return { inserted: !existing, value: structuredClone(existing ?? value) };
  }
  async getObligation(id) {
    return structuredClone(this.obligations.get(id) ?? null);
  }
  async listObligations(accountId) {
    return [...this.obligations.values()]
      .filter(value => !accountId || value.account.account_id === accountId)
      .map(value => structuredClone(value));
  }
  async listLifecycleDueObligations({ ledgerAsOf, account_id, limit }) {
    const due = [];
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
  async updateObligation(value, lease, issue) {
    if (lease && this.leases.get(value.reporting_obligation_id)?.generation !== lease.generation)
      throw new Error('lease lost');
    this.obligations.set(value.reporting_obligation_id, structuredClone(value));
    if (issue) this.issues.set(issue.issueId, structuredClone(issue));
  }
  async claimObligation({ owner, now, leaseMilliseconds, account_id }) {
    const value = [...this.obligations.values()].find(
      item =>
        (!account_id || item.account.account_id === account_id) &&
        item.state === 'pending' &&
        Date.parse(item.nextAttemptAt) <= Date.parse(now) &&
        (!this.leases.has(item.reporting_obligation_id) ||
          Date.parse(this.leases.get(item.reporting_obligation_id).expiresAt) <= Date.parse(now))
    );
    if (!value) return null;
    const generation = (this.leases.get(value.reporting_obligation_id)?.generation ?? 0) + 1;
    const lease = {
      obligation: structuredClone(value),
      owner,
      generation,
      expiresAt: new Date(Date.parse(now) + leaseMilliseconds).toISOString(),
    };
    this.leases.set(value.reporting_obligation_id, lease);
    return structuredClone(lease);
  }
  async releaseObligationLease(lease) {
    const current = this.leases.get(lease.obligation.reporting_obligation_id);
    if (current?.owner === lease.owner && current.generation === lease.generation) {
      this.leases.delete(lease.obligation.reporting_obligation_id);
    }
  }
  async commitRevision(value) {
    const existing = [...this.revisions.values()].find(
      item =>
        item.reporting_obligation_id === value.reporting_obligation_id && item.revisionNumber === value.revisionNumber
    );
    if (existing && existing.binding.sha256 !== value.binding.sha256) throw new Error('immutable conflict');
    if (!existing) this.revisions.set(value.reporting_revision_id, structuredClone(value));
    return { inserted: !existing, value: structuredClone(existing ?? value) };
  }
  async getRevision(id, accountId) {
    const revision = this.revisions.get(id);
    return revision?.wireRevision.account_id === accountId ? structuredClone(revision) : null;
  }
  async listRevisions(obligationId) {
    return [...this.revisions.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber)
      .map(value => structuredClone(value));
  }
  async commitAdjustment(value) {
    const existing = [...this.adjustments.values()].find(
      item =>
        item.reporting_obligation_id === value.reporting_obligation_id &&
        item.adjustmentNumber === value.adjustmentNumber
    );
    if (existing && existing.binding.sha256 !== value.binding.sha256) throw new Error('immutable conflict');
    if (!existing) this.adjustments.set(value.reporting_adjustment_id, structuredClone(value));
    return { inserted: !existing, value: structuredClone(existing ?? value) };
  }
  async listAdjustments(obligationId) {
    return [...this.adjustments.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .sort((a, b) => a.adjustmentNumber - b.adjustmentNumber)
      .map(value => structuredClone(value));
  }
  async putConsumerStatus(value) {
    const existing = this.statuses.get(value.consumerStatusId);
    if (!existing) this.statuses.set(value.consumerStatusId, structuredClone(value));
    return { inserted: !existing, value: structuredClone(existing ?? value) };
  }
  async listConsumerStatuses(revisionId) {
    return [...this.statuses.values()]
      .filter(value => value.reporting_revision_id === revisionId)
      .map(value => structuredClone(value));
  }
  async putIssue(value) {
    this.issues.set(value.issueId, structuredClone(value));
  }
  async resolveIssue(id, resolvedAt) {
    const value = this.issues.get(id);
    if (value) this.issues.set(id, { ...value, resolvedAt });
  }
  async listIssues(obligationId) {
    return [...this.issues.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .map(value => structuredClone(value));
  }
  async appendTransition(value) {
    const inserted = !this.transitions.has(value.transitionId);
    if (inserted) this.transitions.set(value.transitionId, structuredClone(value));
    return { inserted };
  }
  /**
   * Returns the committed finality baseline of the latest transition.
   *
   * This double keeps no commit log — fixtures are seeded straight into the
   * maps — so it cannot say which revisions were already committed when a
   * pre-SDK-14 transition was recorded, and it must not guess from revision
   * payload timestamps: a revision created before that transition but committed
   * after it would be counted as already observed and would suppress the real
   * snapshot→official change. It therefore declares no reconstruction, persists
   * `'none'` as the baseline, and serves every later read from that value.
   */
  async resolveTransitionFinalityBaseline(obligationId) {
    const latest = (await this.listTransitions(obligationId)).at(-1);
    if (!latest) return 'none';
    if (latest.finality) return latest.finality;
    this.finalityBaselineReconstructions += 1;
    this.transitions.set(latest.transitionId, { ...this.transitions.get(latest.transitionId), finality: 'none' });
    return 'none';
  }

  async applyLifecycleProjection(input) {
    const revisionIds = (await this.listRevisions(input.reporting_obligation_id)).map(
      value => value.reporting_revision_id
    );
    const latest = (await this.listTransitions(input.reporting_obligation_id)).at(-1);
    const obligation = await this.getObligation(input.reporting_obligation_id);
    // A store compiled against the pre-finality port has no resolver and must
    // ignore expectedPreviousFinality; model that faithfully.
    const previousFinality = this.resolveTransitionFinalityBaseline
      ? await this.resolveTransitionFinalityBaseline(input.reporting_obligation_id)
      : undefined;
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
    const projectedIds = new Set(input.projectedIssues.map(value => value.issueId));
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
  async markTransitionNotified(transitionId, notifiedAt) {
    const value = this.transitions.get(transitionId);
    if (value) this.transitions.set(transitionId, { ...value, notifiedAt });
  }
  async listTransitions(obligationId) {
    return [...this.transitions.values()]
      .filter(value => value.reporting_obligation_id === obligationId)
      .map(value => structuredClone(value));
  }
  async listPendingTransitions({ account_id, limit = 100 } = {}) {
    const obligationIds = new Set(
      [...this.obligations.values()]
        .filter(value => !account_id || value.account.account_id === account_id)
        .map(value => value.reporting_obligation_id)
    );
    return [...this.transitions.values()]
      .filter(value => obligationIds.has(value.reporting_obligation_id) && !value.notifiedAt)
      .slice(0, limit)
      .map(value => structuredClone(value));
  }
  async createSnapshot(query) {
    let obligations = (await this.listObligations(query.account_id)).filter(
      value =>
        Date.parse(value.period.end) <= Date.parse(this.ledgerAsOf ?? new Date().toISOString()) &&
        (!query.delivery_config_ids || query.delivery_config_ids.includes(value.delivery_config_id))
    );
    let revisions = (await Promise.all(obligations.map(value => this.listRevisions(value.reporting_obligation_id))))
      .flat()
      .map(({ rows: _rows, ...value }) => value);
    let issues = (await Promise.all(obligations.map(value => this.listIssues(value.reporting_obligation_id)))).flat();
    let adjustments = (await Promise.all(obligations.map(value => this.listAdjustments(value.reporting_obligation_id))))
      .flat()
      .map(({ rows: _rows, ...value }) => value);
    const ledgerAsOf = this.ledgerAsOf ?? new Date().toISOString();
    const configurations = (await this.listConfigurations(query.account_id)).map(value => structuredClone(value));
    const coverageOrdinals = (await this.listObligations(query.account_id)).map(value => ({
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
                reportingLedgerScopeClosed(query, ledgerAsOf, ledgerCoverage.complete)
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
      query: structuredClone(query),
      configurations,
      coverageOrdinals,
      obligations,
      revisions,
      adjustments,
      issues,
      // Caller-scoped: `attribution` discloses a status only to the same
      // authenticated consumer that submitted it.
      consumerStatuses: this.scopedConsumerStatements(query.consumer_id, query.account_id),
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return structuredClone(snapshot);
  }
  async readSnapshotPage(snapshotId, accountId, cursor, limit) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.query.account_id !== accountId) throw new ReportingLedgerSnapshotUnavailableError();
    const offset = cursor ? JSON.parse(Buffer.from(cursor, 'base64url')).offset : 0;
    const visibleRevisions = snapshot.query.finality
      ? snapshot.revisions.filter(value => snapshot.query.finality.includes(value.finality))
      : snapshot.revisions;
    const visibleRevisionIds = new Set(visibleRevisions.map(value => value.reporting_revision_id));
    const items = snapshot.obligations.flatMap(obligation => [
      ...(snapshot.query.view === 'revision' ? [] : [{ kind: 'obligation', value: obligation }]),
      ...visibleRevisions
        .filter(value => value.reporting_obligation_id === obligation.reporting_obligation_id)
        .map(value => ({ kind: 'revision', value })),
      ...snapshot.adjustments
        .filter(
          value =>
            value.reporting_obligation_id === obligation.reporting_obligation_id &&
            (!snapshot.query.finality || visibleRevisionIds.has(value.adjusts_reporting_revision_id))
        )
        .map(value => ({ kind: 'adjustment', value })),
    ]);
    const selected = items.slice(offset, offset + limit);
    const obligations = selected.filter(value => value.kind === 'obligation').map(value => value.value);
    const revisions = selected.filter(value => value.kind === 'revision').map(value => value.value);
    const adjustments = selected.filter(value => value.kind === 'adjustment').map(value => value.value);
    const nextOffset = offset + selected.length;
    return {
      snapshot: {
        ...structuredClone(snapshot),
      },
      obligations,
      revisions,
      adjustments,
      // Repeated on every page: the history is the caller's, not a slice of the
      // obligation denominator `total_count` is computed over.
      consumerStatuses: structuredClone(snapshot.consumerStatuses ?? []),
      totalCount: items.length,
      offset,
      limit,
      hasMore: nextOffset < items.length,
      ...(nextOffset < items.length
        ? { nextCursor: Buffer.from(JSON.stringify({ snapshotId, offset: nextOffset })).toString('base64url') }
        : {}),
    };
  }

  // --- rc.3 consumer-status loop (`sync_reporting_status`) -------------------

  consumerStatements = [];
  consumerStatusBatches = new Map();

  /** Revision identity and binding without materializing rows. */
  async getRevisionMetadata(revisionId, accountId) {
    const revision = await this.getRevision(revisionId, accountId);
    if (!revision) return null;
    const { rows: _rows, ...metadata } = revision;
    return metadata;
  }

  scopedConsumerStatements(consumerId, accountId) {
    if (!consumerId) return [];
    return structuredClone(
      this.consumerStatements.filter(value => value.consumerId === consumerId && value.account_id === accountId)
    );
  }

  consumerChainKey(status) {
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
  currentConsumerLeaf(status, accountId, consumerId) {
    const chain = this.consumerStatements.filter(
      value =>
        value.account_id === accountId &&
        value.consumerId === consumerId &&
        this.consumerChainKey(value) === this.consumerChainKey(status)
    );
    const superseded = new Set(chain.map(value => value.supersedes_reporting_status_id).filter(Boolean));
    return chain.find(value => !superseded.has(value.reporting_status_id));
  }

  async getConsumerStatusBatchReplay({ account_id, consumerId, idempotencyKey, requestFingerprint }) {
    const prior = this.consumerStatusBatches.get([account_id, consumerId, idempotencyKey].join('\u0000'));
    if (!prior) return null;
    if (prior.requestFingerprint !== requestFingerprint) {
      throw new ReportingConsumerStatusConflictError('Reporting status idempotency key was reused');
    }
    return structuredClone(prior.results);
  }

  async syncConsumerStatusBatch(input) {
    const batchKey = [input.account_id, input.consumerId, input.idempotencyKey].join('\u0000');
    const prior = this.consumerStatusBatches.get(batchKey);
    if (prior) {
      if (prior.requestFingerprint !== input.requestFingerprint) {
        throw new ReportingConsumerStatusConflictError('Reporting status idempotency key was reused');
      }
      return structuredClone(prior.results);
    }
    const idCounts = new Map();
    const chainCounts = new Map();
    for (const entry of input.entries) {
      const id = entry.status?.reporting_status_id ?? entry.reporting_status_id;
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      if (entry.status) {
        const chain = this.consumerChainKey(entry.status);
        chainCounts.set(chain, (chainCounts.get(chain) ?? 0) + 1);
      }
    }
    const recordedAt = this.ledgerAsOf ?? new Date().toISOString();
    const results = [];
    for (const entry of input.entries) {
      const id = entry.status?.reporting_status_id ?? entry.reporting_status_id;
      const failed = (errorCode, safeMessage) => ({
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
      // Duplicate IDs and duplicate chains fail as a group: the batch may not
      // pick a winner between two statements competing for one leaf.
      if (idCounts.get(id) > 1 || chainCounts.get(this.consumerChainKey(entry.status)) > 1) {
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
        results.push({ inserted: false, value: structuredClone(existing) });
        continue;
      }
      const leaf = this.currentConsumerLeaf(entry.status, input.account_id, input.consumerId);
      if ((leaf?.reporting_status_id ?? undefined) !== (entry.status.supersedes_reporting_status_id ?? undefined)) {
        results.push(failed('IDEMPOTENCY_CONFLICT', 'Reporting status did not name the current leaf'));
        continue;
      }
      this.consumerStatements.push(structuredClone(candidate));
      results.push({ inserted: true, value: structuredClone(candidate) });
    }
    this.consumerStatusBatches.set(batchKey, { requestFingerprint: input.requestFingerprint, results });
    return structuredClone(results);
  }
}

module.exports = { MemoryLedgerStore };
