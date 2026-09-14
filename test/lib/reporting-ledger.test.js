const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, test } = require('node:test');

const {
  REPORTING_LEDGER_MIGRATION,
  ReportingLedgerSnapshotUnavailableError,
  aggregateReportingCoverageV1,
  aggregateReportingHealthV1,
  createReportingProducer,
  createReportingDeliveryHandler,
  createReportingStatusHandler,
  evaluateReportingLedgerCoverageV1,
  projectReportingObligationHealthV1,
  reconcileReportingStatusLifecycleV1,
  reconcileReportingStatusDeadlinesV1,
  relevantReportingLedgerConfigurations,
  reportingLedgerScopeClosed,
} = require('../../dist/lib/reporting/ledger/index.js');
const {
  canonicalJsonV1,
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { GetReportingStatusResponseSchema } = require('../../dist/lib/schemas/index.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');

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
      item => item.configurationId === value.configurationId && item.period.start === value.period.start
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
  async applyLifecycleProjection(input) {
    const revisionIds = (await this.listRevisions(input.reporting_obligation_id)).map(
      value => value.reporting_revision_id
    );
    const latest = (await this.listTransitions(input.reporting_obligation_id)).at(-1);
    const obligation = await this.getObligation(input.reporting_obligation_id);
    if (
      !obligation ||
      obligation.state !== input.expectedObligationState ||
      obligation.attemptCount !== input.expectedAttemptCount ||
      JSON.stringify(revisionIds) !== JSON.stringify(input.expectedRevisionIds) ||
      (latest?.health ?? 'waiting') !== input.expectedPreviousHealth
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
        Date.parse(value.period.end) < Date.parse(this.ledgerAsOf ?? new Date().toISOString()) &&
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
      totalCount: items.length,
      offset,
      limit,
      hasMore: nextOffset < items.length,
      ...(nextOffset < items.length
        ? { nextCursor: Buffer.from(JSON.stringify({ snapshotId, offset: nextOffset })).toString('base64url') }
        : {}),
    };
  }
}

function sha(value) {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

function healthObligation() {
  const request = redactedReportingSourceRequestV1();
  return {
    reporting_obligation_id: 'obligation-health',
    configurationId: 'configuration-health',
    account: request.account,
    sourceScope: request.sourceScope,
    delivery_config_id: request.delivery_config_id,
    delivery_config_version: request.delivery_config_version,
    offeringId: request.offeringId,
    report_definition_id: request.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    periodOrdinal: 0,
    period: { start: request.period.start, end: request.period.end, sourceTimezone: 'UTC' },
    schedule: {
      anchor: request.period.start,
      periodMilliseconds: 86_400_000,
      deliverySlaMilliseconds: 3_600_000,
      recoveryWindowMilliseconds: 3_600_000,
    },
    scopeResolvedAt: request.period.end,
    coverage: {
      status: 'full',
      evaluatedAt: request.period.end,
      mediaBuyIds: request.coverage.mediaBuyIds,
      fullyCoveredMediaBuyIds: request.coverage.mediaBuyIds,
      partiallyCoveredMediaBuyIds: [],
      unsupportedMediaBuyIds: [],
      unknownMediaBuyIds: [],
    },
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    constituents: request.coverage.constituents,
    mediaBuyIds: request.coverage.mediaBuyIds,
    sourceSettings: request.sourceSettings,
    contract: request.contract,
    expectedAt: '2026-09-02T01:00:00.000Z',
    recoveryDeadlineAt: '2026-09-02T02:00:00.000Z',
    publicationOffsets: [],
    nextAttemptAt: '2026-09-02T01:00:00.000Z',
    attemptCount: 0,
    state: 'pending',
    semanticFingerprint: `sha256:${'a'.repeat(64)}`,
    createdAt: request.period.end,
  };
}

describe('seller reporting ledger', () => {
  test('projects all five reporting health states including zero-row satisfaction', () => {
    const obligation = healthObligation();
    assert.equal(projectReportingObligationHealthV1(obligation, [], '2026-09-02T00:30:00Z').health, 'waiting');
    assert.equal(projectReportingObligationHealthV1(obligation, [], '2026-09-02T01:30:00Z').health, 'delayed');
    assert.equal(projectReportingObligationHealthV1(obligation, [], '2026-09-02T02:30:00Z').health, 'action_required');
    const revision = { finality: 'snapshot', rows: [], binding: { rowCount: 0 } };
    assert.equal(
      projectReportingObligationHealthV1(obligation, [revision], '2026-09-02T01:30:00Z', false).health,
      'healthy'
    );
    assert.equal(
      projectReportingObligationHealthV1(obligation, [revision], '2026-09-02T01:30:00Z', true).health,
      'complete'
    );
    const incomplete = projectReportingObligationHealthV1(
      { ...obligation, coverage: { ...obligation.coverage, status: 'partial' } },
      [revision],
      '2026-09-02T01:30:00Z',
      true
    );
    assert.equal(incomplete.health, 'action_required');
    assert.equal(incomplete.productionStatus, 'published');
    assert.equal(incomplete.issues[0].code, 'REPORTING_COVERAGE_INCOMPLETE');
    assert.equal(aggregateReportingHealthV1([], { closed: true, coverageComplete: true }), 'complete');
    assert.equal(aggregateReportingHealthV1(['complete'], { closed: true, coverageComplete: true }), 'complete');
    const conflictingCoverage = aggregateReportingCoverageV1(
      [
        obligation.coverage,
        {
          ...obligation.coverage,
          status: 'none',
          fullyCoveredMediaBuyIds: [],
          unsupportedMediaBuyIds: obligation.coverage.mediaBuyIds,
        },
      ],
      obligation.coverage.evaluatedAt
    );
    assert.equal(conflictingCoverage.status, 'partial');
    assert.deepEqual(conflictingCoverage.partially_covered_media_buy_ids, obligation.coverage.mediaBuyIds);
    assert.deepEqual(conflictingCoverage.unsupported_media_buy_ids, []);
  });

  test('requires the obligation ending exactly at ledger_as_of', () => {
    const configuration = {
      configurationId: 'configuration-boundary',
      account: { account_id: 'account-boundary' },
      delivery_config_id: 'delivery-boundary',
      delivery_config_version: 1,
      report_definition_id: 'report-boundary',
      feedPurpose: 'analytics',
      mediaBuyIds: ['buy-boundary'],
      installedAt: '2026-09-01T00:00:00.000Z',
      schedule: { anchor: '2026-09-01T00:00:00.000Z', periodMilliseconds: 86_400_000 },
    };
    const query = {
      account_id: configuration.account.account_id,
      view: 'summary',
      period: { start: configuration.installedAt, end: '2026-09-02T00:00:00.000Z' },
    };
    assert.equal(
      evaluateReportingLedgerCoverageV1(query, [configuration], [], '2026-09-02T00:00:00.000Z').complete,
      false
    );
  });

  test('does not regress lifecycle health when revision evidence changes during projection', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    const listTransitions = store.listTransitions.bind(store);
    let injected = false;
    store.listTransitions = async obligationId => {
      if (!injected) {
        injected = true;
        store.revisions.set('revision-race', {
          reporting_revision_id: 'revision-race',
          reporting_obligation_id: obligationId,
          finality: 'snapshot',
          rows: [],
          binding: { rowCount: 0 },
        });
        store.transitions.set('transition-complete', {
          transitionId: 'transition-complete',
          reporting_obligation_id: obligationId,
          previousHealth: 'waiting',
          health: 'complete',
          issueIds: [],
          occurredAt: '2026-09-02T01:15:00.000Z',
          notifiedAt: '2026-09-02T01:15:00.000Z',
        });
      }
      return listTransitions(obligationId);
    };
    const result = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.equal(result, null);
    assert.equal((await listTransitions(obligation.reporting_obligation_id)).at(-1).health, 'complete');
  });

  test('does not overwrite a concurrent terminal obligation update with a stale lifecycle projection', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    const apply = store.applyLifecycleProjection.bind(store);
    store.applyLifecycleProjection = async input => {
      const current = store.obligations.get(input.reporting_obligation_id);
      store.obligations.set(input.reporting_obligation_id, {
        ...current,
        state: 'terminal',
        attemptCount: current.attemptCount + 1,
      });
      return apply(input);
    };
    const result = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.equal(result, null);
    assert.equal((await store.getObligation(obligation.reporting_obligation_id)).state, 'terminal');
    assert.deepEqual(await store.listTransitions(obligation.reporting_obligation_id), []);
  });

  test('does not freeze a superseded generation until its straddling period closes', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const base = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    await producer.installConfiguration({ ...base, delivery_config_version: request.delivery_config_version });
    await producer.installConfiguration({ ...base, delivery_config_version: request.delivery_config_version + 1 });
    const anchor = Date.parse(request.period.start);
    const generations = [...store.configurations.values()].sort(
      (left, right) => left.delivery_config_version - right.delivery_config_version
    );
    generations[0].installedAt = new Date(anchor).toISOString();
    generations[1].installedAt = new Date(anchor + 12 * 60 * 60 * 1_000).toISOString();
    assert.equal((await producer.planObligations(new Date(anchor + 12 * 60 * 60 * 1_000 + 1).toISOString())).length, 0);
    const planned = await producer.planObligations(new Date(anchor + 86_400_000).toISOString());
    assert.equal(planned.length, 1);
    assert.equal(planned[0].configurationId, generations[0].configurationId);
  });

  test('does not resurrect an explicitly expired generation across a successor gap', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const input = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    await producer.installConfiguration({ ...input, delivery_config_version: 1 });
    await producer.installConfiguration({ ...input, delivery_config_version: 2 });
    const anchor = Date.parse(request.period.start);
    const generations = [...store.configurations.values()].sort(
      (left, right) => left.delivery_config_version - right.delivery_config_version
    );
    generations[0].installedAt = new Date(anchor).toISOString();
    generations[0].supersededAt = new Date(anchor + 86_400_000).toISOString();
    generations[1].installedAt = new Date(anchor + 3 * 86_400_000).toISOString();
    const planned = await producer.planObligations(new Date(anchor + 4 * 86_400_000 + 1).toISOString());
    assert.deepEqual(
      planned.map(value => [value.delivery_config_version, value.periodOrdinal]),
      [
        [1, 0],
        [2, 3],
      ]
    );
    assert.deepEqual(
      relevantReportingLedgerConfigurations(
        generations,
        new Date(anchor + 2 * 86_400_000).toISOString(),
        new Date(anchor + 3 * 86_400_000).toISOString()
      ),
      []
    );
  });

  test('orders configuration generations deterministically when install timestamps tie', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const input = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    await producer.installConfiguration({ ...input, delivery_config_version: 1 });
    await producer.installConfiguration({ ...input, delivery_config_version: 2 });
    const installedAt = request.period.start;
    for (const configuration of store.configurations.values()) configuration.installedAt = installedAt;
    const planned = await producer.planObligations(new Date(Date.parse(installedAt) + 86_400_000).toISOString());
    assert.deepEqual(
      planned.map(value => value.delivery_config_version),
      [2]
    );
    assert.equal(planned[0].scopeResolvedAt, planned[0].period.end);
    assert.equal(planned[0].coverage.evaluatedAt, planned[0].period.end);
  });

  test('rejects malformed configuration boundaries before persistence', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const valid = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: 1,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    await assert.rejects(() =>
      producer.installConfiguration({ ...valid, schedule: { ...valid.schedule, anchor: 'bad' } })
    );
    await assert.rejects(() =>
      producer.installConfiguration({
        ...valid,
        supersededAt: new Date(Date.parse(valid.schedule.anchor) - 1).toISOString(),
      })
    );
    await assert.rejects(() => producer.installConfiguration({ ...valid, delivery_config_version: 0 }));
    await assert.rejects(
      () =>
        producer.installConfiguration({
          ...valid,
          schedule: { ...valid.schedule, periodMilliseconds: 1_000 },
        }),
      /outside its offering window bounds/
    );
    await assert.rejects(
      () => producer.installConfiguration({ ...valid, contract: { ...valid.contract, schemaVersion: 'other' } }),
      /contract does not match/
    );
    await assert.rejects(
      () =>
        producer.installConfiguration({
          ...valid,
          constituents: valid.constituents.map(value => ({ ...value, productId: 'unoffered-product' })),
        }),
      /product is outside/
    );
    await assert.rejects(
      () =>
        producer.installConfiguration({
          ...valid,
          constituents: valid.constituents.map(value => ({ ...value, constituentKind: 'package_item' })),
        }),
      /kind is outside/
    );
    await assert.rejects(
      () =>
        producer.installConfiguration({
          ...valid,
          sourceSettings: { ...valid.sourceSettings, attributionModel: 'unoffered-model' },
        }),
      /attribution model is outside/
    );

    const partialOffering = structuredClone(redactedReportingSourceOfferingV1);
    partialOffering.metrics[0].support = 'partial';
    partialOffering.dimensions[0].support = 'partial';
    const partialProducer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [partialOffering],
      contact: { name: 'Reporting operations' },
    });
    await assert.rejects(() => partialProducer.installConfiguration(valid), /Unsupported reporting metric/);
    await assert.rejects(
      () =>
        partialProducer.installConfiguration({
          ...valid,
          requestedMetrics: [],
        }),
      /Unsupported reporting dimension/
    );
    assert.equal(store.configurations.size, 0);
  });

  test('replays a configuration fingerprinted before instant normalization', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const input = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: 1,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start.replace('.000Z', 'Z'),
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    const legacy = {
      ...structuredClone(input),
      configurationId: 'fixture-pre-normalization-configuration',
      installedAt: request.period.start,
      semanticFingerprint: `sha256:${createHash('sha256').update(canonicalJsonV1(input)).digest('hex')}`,
    };
    store.configurations.set(legacy.configurationId, legacy);
    assert.deepEqual(await producer.installConfiguration(input), legacy);
  });

  test('does not expose obligations before their half-open period closes', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.ledgerAsOf = new Date(Date.parse(obligation.period.end) - 1).toISOString();
    const snapshot = await store.createSnapshot({ account_id: obligation.account.account_id, view: 'periods' });
    assert.equal(snapshot.obligations.length, 0);
  });

  test('bounds concurrent snapshot creation per account', async () => {
    const store = new MemoryLedgerStore();
    const createSnapshot = store.createSnapshot.bind(store);
    let entered = 0;
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    store.createSnapshot = async query => {
      entered += 1;
      await gate;
      return createSnapshot(query);
    };
    const handler = createReportingStatusHandler(store);
    const request = { account: { account_id: 'account-capacity' }, view: 'summary' };
    const context = { account: { account_id: 'account-capacity' } };
    const calls = Array.from({ length: 17 }, () => handler(request, context));
    while (entered < 16) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await calls[16]).failure_kind, 'operational');
    release();
    await Promise.all(calls.slice(0, 16));
  });

  test('advances terminal failures when their recovery deadline elapses', async () => {
    const store = new MemoryLedgerStore();
    const obligation = { ...healthObligation(), state: 'terminal' };
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.transitions.set('rst_fixture_delayed', {
      transitionId: 'rst_fixture_delayed',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'delayed',
      issueIds: [],
      occurredAt: obligation.expectedAt,
      notifiedAt: obligation.expectedAt,
    });
    assert.equal(
      await reconcileReportingStatusDeadlinesV1({
        store,
        ledgerAsOf: new Date(Date.parse(obligation.recoveryDeadlineAt) + 1).toISOString(),
      }),
      1
    );
    assert.equal((await store.listTransitions(obligation.reporting_obligation_id)).at(-1).health, 'action_required');
    await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: new Date(Date.parse(obligation.recoveryDeadlineAt) - 1).toISOString(),
    });
    assert.equal((await store.listIssues(obligation.reporting_obligation_id)).at(-1).severity, 'action_required');
  });

  test('plans, leases, executes, commits, and serves a reporting revision', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    let completeNotificationAttempts = 0;
    const source = createInlineReportingSourceExecutor(
      () => [
        { media_buy_id: 'fixture-media-buy', impressions: 3, spend: '1.2500' },
        { media_buy_id: 'fixture-media-buy', impressions: 0, spend: 0 },
      ],
      redactedReportingSourceOfferingV1
    );
    const producer = createReportingProducer({
      store,
      source,
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
      subscribers: [
        {
          subscriberId: 'subscriber-fixture',
          account_id: request.account.account_id,
          notify(transition) {
            if (transition.health !== 'complete') return;
            completeNotificationAttempts += 1;
            if (completeNotificationAttempts === 1) throw new Error('Fixture transient notification failure');
          },
        },
      ],
    });
    const anchor = Date.parse(request.period.start);
    await producer.installConfiguration({
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
        restatementMilliseconds: [2 * 86_400_000],
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    // The install clock is later than the fixture period; move the immutable
    // test generation to a controlled period without changing its semantics.
    const config = [...store.configurations.values()][0];
    config.installedAt = new Date(anchor).toISOString();
    const planned = await producer.planObligations(new Date(anchor + 86_400_000).toISOString());
    assert.equal(planned.length, 1);
    assert.equal(planned[0].scopeResolvedAt, planned[0].period.end);
    assert.equal(
      (await producer.planObligations(new Date(anchor + 86_400_000 + 60_000).toISOString())).length,
      0,
      'the newly opened period must not be frozen before its end'
    );
    const originalExecute = source.execute.bind(source);
    const callerAbort = new AbortController();
    source.execute = async () => {
      callerAbort.abort();
      return {
        ok: false,
        error: {
          contractVersion: '1.0',
          code: 'CANCELLED',
          retry: 'cancelled',
          scope: 'slice',
          safeMessage: 'Fixture caller cancelled',
        },
      };
    };
    await assert.rejects(
      () =>
        producer.runWorker({
          signal: callerAbort.signal,
          now: () => new Date(anchor + 86_400_001),
          maxIterations: 1,
        }),
      /abort/i
    );
    assert.equal(store.obligations.get(planned[0].reporting_obligation_id).state, 'pending');
    assert.equal(store.obligations.get(planned[0].reporting_obligation_id).attemptCount, 0);
    source.execute = async () => new Promise(() => {});
    const nonSettling = await producer.runWorker({
      now: () => new Date(anchor + 86_400_001),
      maxIterations: 1,
      retryDelayMilliseconds: 10,
      executionDeadlineMilliseconds: 5,
      settlementGraceMilliseconds: 5,
    });
    assert.equal(nonSettling.failed, 1);
    assert.equal(store.leases.size, 0, 'a non-settling adapter must not pin the worker lease forever');
    let deadlineObserved = false;
    source.execute = async (_request, { signal }) =>
      new Promise(resolve => {
        signal.addEventListener(
          'abort',
          () => {
            deadlineObserved = true;
            resolve({
              ok: false,
              error: {
                contractVersion: '1.0',
                code: 'CANCELLED',
                retry: 'cancelled',
                scope: 'slice',
                safeMessage: 'Fixture deadline elapsed',
              },
            });
          },
          { once: true }
        );
      });
    const keepEventLoopAlive = setTimeout(() => {}, 1_000);
    const timedOut = await producer
      .runWorker({
        now: () => new Date(anchor + 86_400_100),
        maxIterations: 1,
        retryDelayMilliseconds: 10,
        executionDeadlineMilliseconds: 5,
      })
      .finally(() => clearTimeout(keepEventLoopAlive));
    assert.equal(timedOut.failed, 1);
    assert.equal(deadlineObserved, true);
    source.execute = originalExecute;
    const outcome = await producer.runWorker({
      now: () => new Date(anchor + 86_400_000 + 60_000),
      maxIterations: 2,
    });
    assert.equal(outcome.revisionsCommitted, 1);
    const revisions = await store.listRevisions(planned[0].reporting_obligation_id);
    assert.equal(revisions[0].binding.rowCount, 2);
    assert.equal(revisions[0].rows[0].impressions, 3);
    assert.equal(revisions[0].wireRevision.control_totals.find(value => value.name === 'spend').value, '1.25');
    assert.equal(completeNotificationAttempts, 2);
    assert.equal((await store.listPendingTransitions()).length, 0);

    store.transitions.clear();
    const replayObligation = store.obligations.get(planned[0].reporting_obligation_id);
    replayObligation.state = 'pending';
    replayObligation.nextAttemptAt = new Date(anchor + 86_400_000).toISOString();
    await producer.runWorker({ now: () => new Date(anchor + 86_400_000 + 120_000), maxIterations: 1 });
    assert.equal(
      (await store.listTransitions(planned[0].reporting_obligation_id)).at(-1).health,
      'complete',
      'recovery after an already-committed revision must reconcile lifecycle state'
    );

    store.ledgerAsOf = new Date(anchor + 86_400_000 + 120_000).toISOString();
    const handler = createReportingStatusHandler(store);
    const context = { account: { account_id: request.account.account_id } };
    const periods = await handler(
      { account: request.account, view: 'periods', pagination: { max_results: 100 } },
      context
    );
    assert.equal(periods.view, 'periods');
    assert.equal(periods.periods.length, 1);
    assert.equal(periods.periods[0].adjustment_count, 0);
    assert.equal(periods.revisions.length, 1);
    const parsedPeriods = GetReportingStatusResponseSchema.safeParse(periods);
    assert.equal(
      parsedPeriods.success,
      true,
      parsedPeriods.success ? undefined : JSON.stringify(parsedPeriods.error.issues)
    );
    const validatedPeriods = validateResponse('get_reporting_status', periods, '3.2.0-rc.2');
    if (!validatedPeriods.valid) throw new Error(JSON.stringify(validatedPeriods));
    const firstPage = await handler(
      { account: request.account, view: 'periods', pagination: { max_results: 1 } },
      context
    );
    assert.equal(firstPage.periods.length, 1);
    assert.equal(firstPage.revisions.length, 0);
    assert.equal(firstPage.pagination.has_more, true);
    const secondPage = await handler(
      {
        account: request.account,
        view: 'periods',
        pagination: { max_results: 1, cursor: firstPage.pagination.cursor },
      },
      context
    );
    assert.equal(secondPage.periods.length, 0);
    assert.equal(secondPage.revisions.length, 1);
    assert.equal(secondPage.pagination.total_count, 2);
    assert.equal(validateResponse('get_reporting_status', secondPage, '3.2.0-rc.2').valid, true);
    const exact = await handler(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revisions[0].reporting_revision_id,
      },
      context
    );
    assert.equal(exact.revision.reporting_revision_id, revisions[0].reporting_revision_id);
    assert.deepEqual(exact.reporting_rows, revisions[0].rows);
    assert.equal(exact.reporting_revision_binding.revision_content_sha256, revisions[0].binding.sha256);
    const parsedExact = GetReportingStatusResponseSchema.safeParse(exact);
    assert.equal(parsedExact.success, true, parsedExact.success ? undefined : JSON.stringify(parsedExact.error.issues));
    assert.equal(validateResponse('get_reporting_status', exact, '3.2.0-rc.2').valid, true);
    const deliveryHandler = createReportingDeliveryHandler(store);
    const delivery = await deliveryHandler(
      {
        account: request.account,
        reporting_revision_id: revisions[0].reporting_revision_id,
        pagination: { max_results: 1 },
      },
      context
    );
    assert.deepEqual(delivery.reporting_rows, revisions[0].rows.slice(0, 1));
    assert.equal(delivery.pagination.has_more, true);
    const remainingDelivery = await deliveryHandler(
      {
        account: request.account,
        reporting_revision_id: revisions[0].reporting_revision_id,
        pagination: { max_results: 1, cursor: delivery.pagination.cursor },
      },
      context
    );
    assert.deepEqual(remainingDelivery.reporting_rows, revisions[0].rows.slice(1));
    assert.equal(remainingDelivery.pagination.has_more, false);
    await assert.rejects(
      () =>
        deliveryHandler(
          {
            account: request.account,
            reporting_revision_id: revisions[0].reporting_revision_id,
            pagination: { cursor: 'invalid-cursor' },
          },
          context
        ),
      /cursor is invalid/
    );
    assert.equal(delivery.reporting_revision_binding.content_sha256, revisions[0].binding.sha256);
    const validatedDelivery = validateResponse('get_media_buy_delivery', delivery, '3.2.0-rc.2');
    if (!validatedDelivery.valid) throw new Error(JSON.stringify(validatedDelivery));
    const missing = await handler(
      { account: request.account, view: 'revision', reporting_revision_id: 'rrev_missing' },
      context
    );
    assert.equal(missing.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', missing, '3.2.0-rc.2').valid, true);
    const summary = await handler({ account: request.account, view: 'summary' }, context);
    const parsedSummary = GetReportingStatusResponseSchema.safeParse(summary);
    assert.equal(
      parsedSummary.success,
      true,
      parsedSummary.success ? undefined : JSON.stringify(parsedSummary.error.issues)
    );
    const unknownMediaBuy = await handler(
      { account: request.account, view: 'summary', media_buy_ids: ['fixture-media-buy-unknown'] },
      context
    );
    assert.equal(unknownMediaBuy.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', summary, '3.2.0-rc.2').valid, true);
    const filteredSummary = await handler({ account: request.account, view: 'summary', health: ['delayed'] }, context);
    assert.equal(filteredSummary.obligation_counts.total, 1, 'health is a periods-only filter');
    assert.equal(filteredSummary.health, summary.health);
    const officialOnly = await handler({ account: request.account, view: 'periods', finality: ['official'] }, context);
    assert.equal(officialOnly.periods[0].health, 'complete', 'display finality must not change obligation health');
    assert.equal(officialOnly.revisions.length, 0);
    assert.equal(officialOnly.pagination.has_more, false, 'filtered revisions must not create empty pages');
    assert.equal(officialOnly.pagination.total_count, 1);
    assert.equal(validateResponse('get_reporting_status', officialOnly, '3.2.0-rc.2').valid, true);
    const completeOnly = await handler({ account: request.account, view: 'periods', health: ['complete'] }, context);
    assert.equal(completeOnly.periods.length, 1);
    const unknownConfiguration = await handler(
      { account: request.account, view: 'summary', delivery_config_ids: ['missing-configuration'] },
      context
    );
    assert.equal(unknownConfiguration.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', unknownConfiguration, '3.2.0-rc.2').valid, true);
    const malformedCursor = await handler(
      { account: request.account, view: 'periods', pagination: { cursor: 'not-json' } },
      context
    );
    assert.equal(malformedCursor.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', malformedCursor, '3.2.0-rc.2').valid, true);
    const restatement = await producer.runWorker({ now: () => new Date(anchor + 3 * 86_400_000), maxIterations: 1 });
    assert.equal(restatement.revisionsCommitted, 1);
    assert.equal((await store.listRevisions(planned[0].reporting_obligation_id)).length, 2);
  });

  test('recovers lifecycle projection after a revision commit interruption', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const source = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: request.coverage.mediaBuyIds[0], impressions: 1, spend: '0.10' }],
      redactedReportingSourceOfferingV1
    );
    const producer = createReportingProducer({
      store,
      source,
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const anchor = Date.parse(request.period.start);
    await producer.installConfiguration({
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    [...store.configurations.values()][0].installedAt = new Date(anchor).toISOString();
    const [obligation] = await producer.planObligations(new Date(anchor + 86_400_000).toISOString());
    const applyLifecycleProjection = store.applyLifecycleProjection.bind(store);
    store.applyLifecycleProjection = async input => {
      if (store.revisions.size > 0) throw new Error('fixture lifecycle interruption');
      return applyLifecycleProjection(input);
    };
    await assert.rejects(
      () => producer.runWorker({ now: () => new Date(anchor + 2 * 86_400_000 + 1), maxIterations: 1 }),
      /lifecycle interruption/
    );
    assert.equal((await store.listRevisions(obligation.reporting_obligation_id)).length, 1);
    store.applyLifecycleProjection = applyLifecycleProjection;
    await producer.runWorker({ now: () => new Date(anchor + 2 * 86_400_000 + 2), maxIterations: 1 });
    assert.equal((await store.listTransitions(obligation.reporting_obligation_id)).at(-1).health, 'complete');
  });

  test('fails closed when closed configuration lineage has a missing obligation', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const anchor = Date.parse(request.period.start);
    const source = createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1);
    const producer = createReportingProducer({
      store,
      source,
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    await producer.installConfiguration({
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    [...store.configurations.values()][0].installedAt = new Date(anchor).toISOString();
    const handler = createReportingStatusHandler(store);
    for (const start of [anchor, anchor + 12 * 60 * 60 * 1_000]) {
      const response = await handler(
        {
          account: request.account,
          view: 'summary',
          period: {
            start: new Date(start).toISOString(),
            end: new Date(anchor + 86_400_000).toISOString(),
          },
        },
        { account: { account_id: request.account.account_id } }
      );
      assert.equal(response.failure_kind, 'operational');
      assert.equal(validateResponse('get_reporting_status', response, '3.2.0-rc.2').valid, true);
    }
  });

  test('keeps an official revision terminal and records later source corrections as adjustments', async () => {
    const store = new MemoryLedgerStore();
    const { cadence, ...offeringBase } = redactedReportingSourceOfferingV1;
    const offering = {
      ...offeringBase,
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'P1D',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P3D',
        correctionPolicy: 'immutable_correction',
      },
    };
    const request = redactedReportingSourceRequestV1();
    const anchor = Date.parse(request.period.start);
    let publication = 0;
    const source = createInlineReportingSourceExecutor(input => {
      publication += 1;
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        media_buy_deliveries: Array.from({ length: publication === 3 ? 2 : 1 }, () => ({
          media_buy_id: request.coverage.mediaBuyIds[0],
          totals: { impressions: publication, spend: `0.${publication}0` },
        })),
        data_through: input.end_date,
        observed_at: publication === 1 ? input.end_date : new Date(anchor + 3 * 86_400_000 + 1).toISOString(),
        is_final: true,
        notification_type: publication === 1 ? 'final' : 'adjusted',
      };
    }, offering);
    let sourceFailure;
    const execute = source.execute.bind(source);
    source.execute = async (...args) => {
      const result = await execute(...args);
      if (!result.ok) sourceFailure = result.error;
      return result;
    };
    const producer = createReportingProducer({
      store,
      source,
      offerings: [offering],
      contact: { name: 'Reporting operations' },
    });
    const officialConfiguration = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: offering.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'billing',
      requiredFinality: 'official',
      finalityPolicy: {
        policyId: 'fixture-source-final-v1',
        basis: 'source_final',
        sourceSignal: 'get_media_buy_delivery.is_final',
      },
      canonicalization: {
        id: 'fixture-jcs-v1',
        uri: request.contract.schemaUri,
        sha256: request.contract.schemaSha256,
        primaryKeys: ['media_buy_id'],
      },
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: request.period.start,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 3 * 86_400_000,
        officialAfterMilliseconds: 0,
        restatementMilliseconds: [2 * 86_400_000, 3 * 86_400_000],
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    const {
      finalityPolicy: _finalityPolicy,
      canonicalization: _canonicalization,
      ...snapshotConfiguration
    } = officialConfiguration;
    await assert.rejects(
      () =>
        producer.installConfiguration({
          ...snapshotConfiguration,
          feedPurpose: 'analytics',
          requiredFinality: 'snapshot',
        }),
      /Authoritative source offerings require official/
    );
    await producer.installConfiguration(officialConfiguration);
    [...store.configurations.values()][0].installedAt = new Date(anchor).toISOString();
    const [obligation] = await producer.planObligations(new Date(anchor + 86_400_000).toISOString());
    const firstOutcome = await producer.runWorker({ now: () => new Date(anchor + 86_400_001), maxIterations: 2 });
    const correctionOutcome = await producer.runWorker({
      now: () => new Date(anchor + 3 * 86_400_000),
      maxIterations: 2,
    });
    const secondCorrectionOutcome = await producer.runWorker({
      now: () => new Date(anchor + 4 * 86_400_000),
      maxIterations: 2,
    });
    assert.equal(
      firstOutcome.revisionsCommitted,
      1,
      JSON.stringify({
        firstOutcome,
        sourceFailure,
        issues: await store.listIssues(obligation.reporting_obligation_id),
      })
    );
    assert.equal(correctionOutcome.failed, 0, JSON.stringify(sourceFailure));
    assert.equal(secondCorrectionOutcome.failed, 1);

    const revisions = await store.listRevisions(obligation.reporting_obligation_id);
    const adjustments = await store.listAdjustments(obligation.reporting_obligation_id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].finality, 'official');
    assert.equal(revisions[0].supersedes_reporting_revision_id, undefined);
    const canonicalRowsDigest = createHash('sha256').update(canonicalJsonV1(revisions[0].rows)).digest('hex');
    assert.equal(revisions[0].wireRevision.canonical_content_digest.value, canonicalRowsDigest);
    assert.notEqual(revisions[0].wireRevision.canonical_content_digest.value, revisions[0].binding.sha256);
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].adjusts_reporting_revision_id, revisions[0].reporting_revision_id);
    assert.equal(adjustments[0].binding.rowCount, 1);
    assert.equal(
      adjustments[0].wireAdjustment.control_total_deltas.find(value => value.name === 'impressions').value,
      '1'
    );

    const handler = createReportingStatusHandler(store);
    const periods = await handler(
      {
        account: request.account,
        view: 'periods',
        period: { start: request.period.start, end: request.period.end },
      },
      { account: { account_id: request.account.account_id } }
    );
    assert.equal(periods.adjustments.length, 1);
    assert.equal(periods.periods[0].adjustment_count, 1);
    const parsed = GetReportingStatusResponseSchema.safeParse(periods);
    assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
    const validatedPeriods = validateResponse('get_reporting_status', periods, '3.2.0-rc.2');
    if (!validatedPeriods.valid) throw new Error(JSON.stringify(validatedPeriods));
    const exact = await handler(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revisions[0].reporting_revision_id,
      },
      { account: { account_id: request.account.account_id } }
    );
    assert.equal(exact.adjustments.length, 1);
    const firstExactPage = await handler(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revisions[0].reporting_revision_id,
        pagination: { max_results: 1 },
      },
      { account: { account_id: request.account.account_id } }
    );
    assert.equal(firstExactPage.adjustments.length, 0);
    assert.equal(firstExactPage.pagination.has_more, true);
    const secondExactPage = await handler(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revisions[0].reporting_revision_id,
        pagination: { max_results: 1, cursor: firstExactPage.pagination.cursor },
      },
      { account: { account_id: request.account.account_id } }
    );
    assert.equal(secondExactPage.adjustments.length, 1);
    assert.equal(secondExactPage.pagination.has_more, false);
    const parsedExact = GetReportingStatusResponseSchema.safeParse(exact);
    assert.equal(parsedExact.success, true, parsedExact.success ? undefined : JSON.stringify(parsedExact.error.issues));
    assert.equal(validateResponse('get_reporting_status', exact, '3.2.0-rc.2').valid, true);
  });

  test('exports one idempotent migration for the complete store surface', () => {
    for (const table of [
      'configurations',
      'obligations',
      'revisions',
      'adjustments',
      'consumer_statuses',
      'issues',
      'snapshots',
      'checkpoints',
    ]) {
      assert.match(REPORTING_LEDGER_MIGRATION, new RegExp(`CREATE TABLE IF NOT EXISTS adcp_reporting_${table}`));
    }
  });
});
