const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, test } = require('node:test');

const {
  REPORTING_LEDGER_MIGRATION,
  REPORTING_NOTIFICATION_ACTIVITY_MIGRATION,
  ReportingLedgerSnapshotUnavailableError,
  aggregateReportingCoverageV1,
  aggregateReportingHealthV1,
  createReportingProducer,
  createReportingDeliveryHandler,
  createReportingStatusHandler,
  evaluateReportingLedgerCoverageV1,
  projectReportingObligationHealthV1,
  reconcileReportingStatusLifecycleV1,
  reportingManagedDeliveryBindingV1,
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

const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

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

  test('keeps lifecycle health stable and records finality when revision evidence changes during projection', async () => {
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
    assert.deepEqual(
      [result.previousHealth, result.health, result.previousFinality, result.finality],
      ['complete', 'complete', 'none', 'snapshot'],
      'the CAS retry observes finality without regressing the concurrently committed health'
    );
    assert.equal((await listTransitions(obligation.reporting_obligation_id)).at(-1).health, 'complete');
  });

  test('honours a backdated cutoff on a store that has no clock of its own', async () => {
    const store = new MemoryLedgerStore();
    assert.equal(store.readLedgerInstant, undefined, 'sanity: this store has no authoritative clock');
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    // The caller is replaying a moment inside the recovery window while the
    // host clock has already passed the recovery deadline. Clamping the pin
    // against the host clock reconciled a moment the caller never asked
    // about, persisting `action_required` at 03:00 where the obligation was
    // `delayed` at 01:30. There is nothing to clamp against here: `now` is
    // precisely what a pinned cutoff overrides.
    const transition = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
      now: () => new Date('2026-09-02T03:00:00.000Z'),
    });
    assert.equal(transition.health, 'delayed');
    assert.equal(transition.occurredAt, '2026-09-02T01:30:00.000Z');
    assert.equal((await store.listTransitions(obligation.reporting_obligation_id)).at(-1).health, 'delayed');
  });

  test('reconciles at the instant the store resolved, not the one it was asked for', async () => {
    const store = new MemoryLedgerStore();
    assert.equal(store.readLedgerInstant, undefined, 'sanity: this store has no authoritative clock');
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    // A store that resolves its own cutoff at a precision the caller cannot
    // express. The contract says that resolved instant is what the projection
    // was computed at, so the transition and the watermark have to use it —
    // leaving the caller's value in place stamped a moment later than the
    // read and buried everything in between.
    const resolved = '2026-09-02T01:30:00.499900Z';
    store.getManagedLifecycleProjection = async () => ({
      binding: reportingManagedDeliveryBindingV1({
        configurationId: obligation.configurationId,
        account_id: obligation.account.account_id,
        delivery_config_id: obligation.delivery_config_id,
        delivery_config_version: obligation.delivery_config_version,
        destination_ref: 'destination-resolved-1',
        authorization_generation: 1,
        feed_purpose: 'analytics',
        method: 'file_transfer',
        verification_profile: 'canonical_digest',
        reconciliation_mode: 'delivery_only',
        resource_retention_days: 30,
        created_at: obligation.period.end,
      }),
      materializations: [],
      materializationHistory: [],
      consumers: [],
      obligatedConsumerIds: [],
      obligatedConsumerRosterComplete: true,
      resolvedLedgerAsOf: resolved,
    });
    const applied = [];
    const apply = store.applyLifecycleProjection.bind(store);
    store.applyLifecycleProjection = async input => {
      applied.push(input.ledgerAsOf);
      return apply(input);
    };
    const transition = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.500000Z',
    });
    assert.equal(transition.occurredAt, resolved);
    assert.deepEqual(applied, [resolved], 'the watermark is the instant the projection read at');
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

  test('records a finality-only transition with stable predecessor finality', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.revisions.set('revision-snapshot', {
      reporting_revision_id: 'revision-snapshot',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      createdAt: '2026-09-02T01:15:00.000Z',
    });
    const first = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.equal(first.previousFinality, 'none');
    assert.equal(first.finality, 'snapshot');
    store.revisions.set('revision-official', {
      reporting_revision_id: 'revision-official',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 2,
      finality: 'official',
      createdAt: '2026-09-02T01:45:00.000Z',
    });
    const second = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.equal(second.previousHealth, 'complete');
    assert.equal(second.health, 'complete');
    assert.equal(second.previousFinality, 'snapshot');
    assert.equal(second.finality, 'official');
  });

  test('does not claim a pre-v14 finality baseline it cannot commit, and fires no health subscriber', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.revisions.set('revision-snapshot-upgrade', {
      reporting_revision_id: 'revision-snapshot-upgrade',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      createdAt: '2026-09-02T01:15:00.000Z',
    });
    store.transitions.set('transition-before-v14', {
      transitionId: 'transition-before-v14',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'complete',
      issueIds: [],
      occurredAt: '2026-09-02T01:30:00.000Z',
      notifiedAt: '2026-09-02T01:30:00.000Z',
    });
    store.revisions.set('revision-official-upgrade', {
      reporting_revision_id: 'revision-official-upgrade',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 2,
      finality: 'official',
      createdAt: '2026-09-02T01:45:00.000Z',
    });
    let notifications = 0;
    const transition = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
      subscribers: [
        {
          subscriberId: 'upgrade-subscriber',
          account_id: obligation.account.account_id,
          notify: () => {
            notifications += 1;
          },
        },
      ],
    });
    // A store with no commit log cannot say the snapshot was already observed,
    // so it commits 'none' rather than guessing from payload timestamps.
    assert.equal(transition.previousFinality, 'none');
    assert.equal(transition.finality, 'official');
    assert.equal(transition.previousHealth, transition.health);
    assert.equal(transition.notifiedAt, '2026-09-02T02:00:00.000Z');
    assert.equal(notifications, 0);
  });

  test('derives a pre-v14 finality baseline once and reuses the committed value', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.transitions.set('transition-before-v14', {
      transitionId: 'transition-before-v14',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'delayed',
      issueIds: [],
      occurredAt: '2026-09-02T01:20:00.000Z',
      notifiedAt: '2026-09-02T01:20:00.000Z',
    });
    store.revisions.set('revision-baseline-official', {
      reporting_revision_id: 'revision-baseline-official',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      createdAt: '2026-09-02T01:45:00.000Z',
    });
    const transition = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.equal(transition.previousHealth, 'delayed');
    assert.equal(transition.health, 'complete');
    assert.equal(transition.previousFinality, 'none');
    assert.equal(transition.finality, 'official');
    assert.equal(store.finalityBaselineReconstructions, 1, 'the baseline is derived once, not once per reader');
    assert.equal(store.transitions.get('transition-before-v14').finality, 'none');
    assert.equal(
      await reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: obligation.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T02:15:00.000Z',
      }),
      null
    );
    assert.equal(store.finalityBaselineReconstructions, 1);
  });

  test('defers to the committed store baseline instead of recomputing it locally', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.revisions.set('revision-authority-snapshot', {
      reporting_revision_id: 'revision-authority-snapshot',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      createdAt: '2026-09-02T01:15:00.000Z',
    });
    store.transitions.set('transition-before-v14', {
      transitionId: 'transition-before-v14',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'complete',
      issueIds: [],
      occurredAt: '2026-09-02T01:30:00.000Z',
      notifiedAt: '2026-09-02T01:30:00.000Z',
    });
    // The store reports a baseline no local view of the revisions could produce.
    // It must still decide, because two independent derivations are exactly what
    // a clock or ordering difference turns into a permanent CAS wedge.
    store.resolveTransitionFinalityBaseline = async () => 'official';
    const transition = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.equal(transition.previousFinality, 'official');
    assert.equal(transition.finality, 'snapshot');
    assert.equal(transition.previousHealth, transition.health);
  });

  test('does not emit a finality transition every tick for a store that cannot persist a baseline', async () => {
    // A pre-finality custom store neither implements the baseline port nor keeps
    // the optional finality fields. Resolving 'none' every tick would make every
    // reconciliation observe none -> official and append another finality-only
    // transition forever.
    const store = new MemoryLedgerStore();
    // A pre-finality store: no baseline resolver, and unknown fields are not
    // round-tripped through its storage.
    store.resolveTransitionFinalityBaseline = undefined;
    const stripFinality = ({ finality, previousFinality, ...rest }) => rest;
    const appendTransition = store.appendTransition.bind(store);
    store.appendTransition = value => appendTransition(stripFinality(value));
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.revisions.set('revision-compat-official', {
      reporting_revision_id: 'revision-compat-official',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      createdAt: '2026-09-02T01:15:00.000Z',
    });

    const first = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.equal(first.previousHealth, 'waiting');
    assert.equal(first.health, 'complete', 'the health transition still fires');

    // Every later tick must be a no-op, not another finality-only transition.
    for (const ledgerAsOf of [
      '2026-09-02T01:45:00.000Z',
      '2026-09-02T02:00:00.000Z',
      '2026-09-02T02:15:00.000Z',
      '2026-09-02T02:30:00.000Z',
    ]) {
      assert.equal(
        await reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf,
        }),
        null,
        `${ledgerAsOf}: no repeated finality-only transition`
      );
    }
    assert.equal(
      (await store.listTransitions(obligation.reporting_obligation_id)).length,
      1,
      'exactly one transition, and it is the health change'
    );
  });

  test('still records finality-only transitions for a store that persists the baseline', async () => {
    // The compatibility path must not weaken a store that does implement the
    // port: finality remains observable there.
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.revisions.set('revision-supported-official', {
      reporting_revision_id: 'revision-supported-official',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      createdAt: '2026-09-02T01:15:00.000Z',
    });
    store.transitions.set('transition-before-v14', {
      transitionId: 'transition-before-v14',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'complete',
      issueIds: [],
      occurredAt: '2026-09-02T01:20:00.000Z',
      notifiedAt: '2026-09-02T01:20:00.000Z',
    });
    const first = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.equal(first.previousFinality, 'none');
    assert.equal(first.finality, 'official');
    assert.equal(
      await reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: obligation.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T01:45:00.000Z',
      }),
      null,
      'and it happens once'
    );
  });

  test('treats a legacy transition with no configured recipient as disposition complete', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    const transition = await reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.equal(transition.notifiedAt, '2026-09-02T01:30:00.000Z');
    assert.deepEqual(await store.listPendingTransitions(), []);
  });

  test('fails closed when transactional notification activity is enabled before legacy pending work is drained', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.transitions.set('legacy-pending-transition', {
      transitionId: 'legacy-pending-transition',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'delayed',
      issueIds: [],
      occurredAt: '2026-09-02T01:15:00.000Z',
    });
    store.transactionalNotificationActivity = true;
    await assert.rejects(
      () =>
        reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
        }),
      /Drain or explicitly resolve legacy pending reporting transitions/
    );
  });

  test('deadline sweeps back off legacy pending residue without starving a clean sibling account', async () => {
    const store = new MemoryLedgerStore();
    const residue = {
      ...healthObligation(),
      reporting_obligation_id: 'obligation-a-residue',
      configurationId: 'configuration-a-residue',
      account: { account_id: 'account-a-residue' },
    };
    const clean = {
      ...healthObligation(),
      reporting_obligation_id: 'obligation-b-clean',
      configurationId: 'configuration-b-clean',
      account: { account_id: 'account-b-clean' },
    };
    store.obligations.set(residue.reporting_obligation_id, residue);
    store.obligations.set(clean.reporting_obligation_id, clean);
    store.transitions.set('legacy-pending-transition', {
      transitionId: 'legacy-pending-transition',
      reporting_obligation_id: residue.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'delayed',
      issueIds: [],
      occurredAt: '2026-09-02T01:15:00.000Z',
    });
    store.transactionalNotificationActivity = true;
    const failures = [];
    store.recordLifecycleFailure = async input => void failures.push(input.reporting_obligation_id);

    assert.equal(
      await reconcileReportingStatusDeadlinesV1({
        store,
        ledgerAsOf: '2026-09-02T02:30:00.000Z',
      }),
      2
    );
    assert.deepEqual(failures, [residue.reporting_obligation_id], 'only the poisoned obligation is backed off');
    assert.equal((await store.listTransitions(residue.reporting_obligation_id)).length, 1);
    assert.equal((await store.listTransitions(clean.reporting_obligation_id)).at(-1).health, 'action_required');
  });

  test('deadline sweeps fail loud when transactional notification activity conflicts with legacy subscribers', async () => {
    const store = new MemoryLedgerStore();
    const obligation = healthObligation();
    store.obligations.set(obligation.reporting_obligation_id, obligation);
    store.transactionalNotificationActivity = true;
    const failures = [];
    store.recordLifecycleFailure = async input => void failures.push(input.reporting_obligation_id);
    let obligationReads = 0;
    const getObligation = store.getObligation.bind(store);
    store.getObligation = async id => {
      obligationReads += 1;
      return getObligation(id);
    };

    await assert.rejects(
      () =>
        reconcileReportingStatusDeadlinesV1({
          store,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
          subscribers: [{ account_id: obligation.account.account_id, notify: async () => {} }],
        }),
      /mutually exclusive/
    );
    assert.deepEqual(failures, [], 'a deployment invariant is not recorded as an isolated tenant failure');
    assert.equal(obligationReads, 0, 'the deployment-wide conflict fails before obligation work starts');
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
    // RC3 core/reporting-delivery-config states this unconditionally: "feed_purpose
    // billing still requires required_finality official". A provisional snapshot
    // revision would otherwise be able to take a terminal accepted billing receipt.
    await assert.rejects(
      () =>
        producer.installConfiguration({
          ...valid,
          feedPurpose: 'billing',
          requiredFinality: 'snapshot',
          canonicalization: {
            id: 'billing-rows-v1',
            uri: 'https://schemas.fixture.example/canonicalization.json',
            sha256: 'c'.repeat(64),
            primaryKeys: valid.requestedDimensions.slice(0, 1),
          },
        }),
      /Billing reporting requires official ledger finality/
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

  test('replays an immutable pre-rule billing generation instead of revalidating it', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const legacyBilling = {
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      // billing with snapshot finality: installable before the rule existed,
      // refused by installConfiguration today.
      feedPurpose: 'billing',
      requiredFinality: 'snapshot',
      canonicalization: {
        id: 'billing-rows-v1',
        uri: 'https://schemas.fixture.example/canonicalization.json',
        sha256: 'c'.repeat(64),
        primaryKeys: request.requestedDimensions.slice(0, 1),
      },
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: new Date(Date.parse(request.period.start)).toISOString(),
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    // A fresh generation is still held to the current rule.
    await assert.rejects(
      () => producer.installConfiguration(legacyBilling),
      /Billing reporting requires official ledger finality/
    );
    // The row that predates the rule is immutable, so reinstalling it must
    // return the stored generation. Validating before resolving the replay
    // made an idempotent reinstall impossible and left no way to name it.
    await store.putConfiguration({
      ...legacyBilling,
      configurationId: 'configuration-legacy-billing',
      installedAt: legacyBilling.schedule.anchor,
      semanticFingerprint: `sha256:${sha(legacyBilling)}`,
    });
    const replayed = await producer.installConfiguration(legacyBilling);
    assert.equal(replayed.configurationId, 'configuration-legacy-billing');
    assert.equal(store.configurations.size, 1, 'no second generation is written');

    // The offering can also be withdrawn. A stored generation is immutable,
    // so reinstalling it must still return the stored row — resolving the
    // offering before reading the ledger made it throw "Unknown reporting
    // source offering" without ever looking.
    const withdrawn = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1),
      offerings: [],
      contact: { name: 'Reporting operations' },
    });
    const replayedWithoutOffering = await withdrawn.installConfiguration(legacyBilling);
    assert.equal(replayedWithoutOffering.configurationId, 'configuration-legacy-billing');
    // A genuinely new generation still needs a live offering.
    await assert.rejects(
      () => withdrawn.installConfiguration({ ...legacyBilling, delivery_config_version: 99 }),
      /Unknown reporting source offering/
    );
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

  test('projects rc.4 summary expectations without leaking them into complete periods', async () => {
    const store = new MemoryLedgerStore();
    const request = redactedReportingSourceRequestV1();
    const source = createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1);
    const producer = createReportingProducer({
      store,
      source,
      offerings: [redactedReportingSourceOfferingV1],
      contact: { name: 'Reporting operations' },
    });
    const anchor = Date.parse(request.period.start);
    const configurationInput = {
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
        deliverySlaMilliseconds: 3_600_000,
        recoveryWindowMilliseconds: 3_600_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    await producer.installConfiguration(configurationInput);
    [...store.configurations.values()][0].installedAt = new Date(anchor).toISOString();
    store.ledgerAsOf = new Date(anchor + 12 * 3_600_000).toISOString();

    const handler = createReportingStatusHandler(store);
    const context = { account: { account_id: request.account.account_id } };
    const completeSummary = await handler({ account: request.account, view: 'summary' }, context);
    assert.equal(completeSummary.health, 'complete');
    assert.equal(
      completeSummary.next_expected_at,
      new Date(anchor + 86_400_000).toISOString(),
      'a complete rc.4 summary forecasts the nearest future period start'
    );
    assert.equal(validateResponse('get_reporting_status', completeSummary, '3.2.0-rc.6').valid, true);

    const openSummary = await handler(
      {
        account: request.account,
        view: 'summary',
        period: {
          start: new Date(anchor).toISOString(),
          end: new Date(anchor + 3 * 86_400_000).toISOString(),
        },
      },
      context
    );
    assert.equal(openSummary.health, 'waiting');
    assert.equal(
      openSummary.next_expected_at,
      new Date(anchor + 86_400_000 + 3_600_000).toISOString(),
      'an open rc.4 summary retains the next obligation due time'
    );
    assert.equal(validateResponse('get_reporting_status', openSummary, '3.2.0-rc.6').valid, true);

    const completePeriods = await handler({ account: request.account, view: 'periods' }, context);
    assert.equal('next_expected_at' in completePeriods, false);
    assert.equal(validateResponse('get_reporting_status', completePeriods, '3.2.0-rc.6').valid, true);

    await producer.installConfiguration({
      ...configurationInput,
      delivery_config_version: configurationInput.delivery_config_version + 1,
      schedule: { ...configurationInput.schedule, anchor: store.ledgerAsOf },
    });
    const generations = [...store.configurations.values()].sort(
      (left, right) => left.delivery_config_version - right.delivery_config_version
    );
    generations[1].installedAt = new Date(anchor + 6 * 3_600_000).toISOString();
    const boundarySummary = await handler({ account: request.account, view: 'summary' }, context);
    assert.equal(boundarySummary.health, 'complete');
    assert.equal(boundarySummary.scope.delivery_config_generations.length, 2);
    assert.equal(
      boundarySummary.next_expected_at,
      new Date(anchor + 36 * 3_600_000).toISOString(),
      'forecast is strictly after ledger_as_of and comes from the active successor generation'
    );
    assert.equal(validateResponse('get_reporting_status', boundarySummary, '3.2.0-rc.6').valid, true);
  });

  test('keeps official obligation due time on delivery_sla rather than a private finality cutoff', async () => {
    const store = new MemoryLedgerStore();
    const { cadence, ...offeringBase } = redactedReportingSourceOfferingV1;
    const offering = {
      ...offeringBase,
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'PT6H',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P3D',
        correctionPolicy: 'immutable_correction',
      },
    };
    const request = redactedReportingSourceRequestV1();
    const anchor = Date.parse(request.period.start);
    const producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], offering),
      offerings: [offering],
      contact: { name: 'Reporting operations' },
    });
    await producer.installConfiguration({
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
        deliverySlaMilliseconds: 3_600_000,
        officialAfterMilliseconds: 21_600_000,
        recoveryWindowMilliseconds: 86_400_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    [...store.configurations.values()][0].installedAt = new Date(anchor).toISOString();

    store.ledgerAsOf = new Date(anchor + 12 * 3_600_000).toISOString();
    const openSummary = await createReportingStatusHandler(store)(
      {
        account: request.account,
        view: 'summary',
        period: {
          start: new Date(anchor).toISOString(),
          end: new Date(anchor + 2 * 86_400_000).toISOString(),
        },
      },
      { account: { account_id: request.account.account_id } }
    );
    assert.equal(openSummary.health, 'waiting');
    assert.equal(
      openSummary.next_expected_at,
      new Date(anchor + 86_400_000 + 3_600_000).toISOString(),
      'an open official summary forecasts the protocol delivery-SLA due time'
    );

    const [obligation] = await producer.planObligations(new Date(anchor + 86_400_000).toISOString());
    assert.equal(
      obligation.expectedAt,
      new Date(anchor + 86_400_000 + 3_600_000).toISOString(),
      'rc.4 expected_at is period.end plus delivery_sla for official generations too'
    );
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
    const validatedPeriods = validateResponse('get_reporting_status', periods, '3.2.0-rc.6');
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
    assert.equal(validateResponse('get_reporting_status', secondPage, '3.2.0-rc.6').valid, true);
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
    assert.equal(validateResponse('get_reporting_status', exact, '3.2.0-rc.6').valid, true);
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
    const validatedDelivery = validateResponse('get_media_buy_delivery', delivery, '3.2.0-rc.6');
    if (!validatedDelivery.valid) throw new Error(JSON.stringify(validatedDelivery));
    const missing = await handler(
      { account: request.account, view: 'revision', reporting_revision_id: 'rrev_missing' },
      context
    );
    assert.equal(missing.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', missing, '3.2.0-rc.6').valid, true);
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
    assert.equal(validateResponse('get_reporting_status', summary, '3.2.0-rc.6').valid, true);
    const filteredSummary = await handler({ account: request.account, view: 'summary', health: ['delayed'] }, context);
    assert.equal(filteredSummary.obligation_counts.total, 1, 'health is a periods-only filter');
    assert.equal(filteredSummary.health, summary.health);
    const officialOnly = await handler({ account: request.account, view: 'periods', finality: ['official'] }, context);
    assert.equal(officialOnly.periods[0].health, 'complete', 'display finality must not change obligation health');
    assert.equal(officialOnly.revisions.length, 0);
    assert.equal(officialOnly.pagination.has_more, false, 'filtered revisions must not create empty pages');
    assert.equal(officialOnly.pagination.total_count, 1);
    assert.equal(validateResponse('get_reporting_status', officialOnly, '3.2.0-rc.6').valid, true);
    const completeOnly = await handler({ account: request.account, view: 'periods', health: ['complete'] }, context);
    assert.equal(completeOnly.periods.length, 1);
    const unknownConfiguration = await handler(
      { account: request.account, view: 'summary', delivery_config_ids: ['missing-configuration'] },
      context
    );
    assert.equal(unknownConfiguration.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', unknownConfiguration, '3.2.0-rc.6').valid, true);
    const malformedCursor = await handler(
      { account: request.account, view: 'periods', pagination: { cursor: 'not-json' } },
      context
    );
    assert.equal(malformedCursor.failure_kind, 'lookup_unavailable');
    assert.equal(validateResponse('get_reporting_status', malformedCursor, '3.2.0-rc.6').valid, true);
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
    // The durable revision commits and the projection does not. That must not
    // abort the worker: every tenant queued behind this one would be stranded
    // by an obligation whose projection cannot be computed, and the recovery
    // path would rethrow the same failure on the next pass forever. It is
    // reported instead, and the obligation stays due.
    const transitionsBefore = (await store.listTransitions(obligation.reporting_obligation_id)).length;
    const interrupted = await producer.runWorker({
      now: () => new Date(anchor + 2 * 86_400_000 + 1),
      maxIterations: 1,
    });
    assert.equal(interrupted.revisionsCommitted, 1, 'the durable write still happened');
    assert.equal(interrupted.reconcilesDeferred, 1, 'and the unpublished projection is reported, not swallowed');
    assert.equal((await store.listRevisions(obligation.reporting_obligation_id)).length, 1);
    assert.notEqual(
      (await store.listTransitions(obligation.reporting_obligation_id)).at(-1).health,
      'complete',
      'the projection that failed published nothing'
    );
    assert.ok(transitionsBefore >= 1);
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
      assert.equal(validateResponse('get_reporting_status', response, '3.2.0-rc.6').valid, true);
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
    const { canonical_adjustment_sha256: adjustmentDigest, ...unsignedAdjustment } = adjustments[0].wireAdjustment;
    assert.equal(adjustmentDigest, sha(unsignedAdjustment));
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
    const validatedPeriods = validateResponse('get_reporting_status', periods, '3.2.0-rc.6');
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
    assert.equal(validateResponse('get_reporting_status', exact, '3.2.0-rc.6').valid, true);
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
    assert.match(
      REPORTING_NOTIFICATION_ACTIVITY_MIGRATION,
      /CREATE TABLE IF NOT EXISTS "adcp_reporting_notification_activity"/
    );
  });
});
