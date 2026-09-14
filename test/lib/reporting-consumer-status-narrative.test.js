const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createReportingStatusHandler } = require('../../dist/lib/reporting/ledger/index.js');
const { redactedReportingSourceRequestV1 } = require('../../dist/lib/reporting/source/index.js');
const { validateResponse } = require('../../dist/lib/validation/index.js');

const ACCOUNT = 'narrative-account';
const CONSUMER = 'consumer-a';
const OTHER_CONSUMER = 'consumer-b';
const PERIOD_END = '2026-09-02T00:00:00.000Z';
const EXPECTED_AT = '2026-09-02T01:00:00.000Z';
// expectedAt + automated_recovery_window_seconds (1h) — the rc.3 buyer posting deadline.
const RECOVERY_DEADLINE = '2026-09-02T02:00:00.000Z';
const DIGEST = 'a'.repeat(64);

function obligation() {
  const request = redactedReportingSourceRequestV1();
  return {
    reporting_obligation_id: 'obligation-narrative',
    configurationId: 'configuration-narrative',
    account: { account_id: ACCOUNT },
    sourceScope: request.sourceScope,
    delivery_config_id: request.delivery_config_id,
    delivery_config_version: request.delivery_config_version,
    offeringId: request.offeringId,
    report_definition_id: request.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    periodOrdinal: 0,
    period: { start: request.period.start, end: PERIOD_END, sourceTimezone: 'UTC' },
    schedule: {
      anchor: request.period.start,
      periodMilliseconds: 86_400_000,
      deliverySlaMilliseconds: 3_600_000,
      recoveryWindowMilliseconds: 3_600_000,
    },
    scopeResolvedAt: PERIOD_END,
    coverage: {
      status: 'full',
      evaluatedAt: PERIOD_END,
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
    expectedAt: EXPECTED_AT,
    recoveryDeadlineAt: RECOVERY_DEADLINE,
    publicationOffsets: [],
    nextAttemptAt: EXPECTED_AT,
    attemptCount: 0,
    state: 'pending',
    semanticFingerprint: `sha256:${'a'.repeat(64)}`,
    createdAt: PERIOD_END,
  };
}

const revision = (id, number, createdAt, supersedes) => ({
  reporting_revision_id: id,
  reporting_obligation_id: 'obligation-narrative',
  revisionNumber: number,
  finality: 'snapshot',
  kind: 'snapshot',
  ...(supersedes ? { supersedes_reporting_revision_id: supersedes } : {}),
  binding: { algorithm: 'rfc8785_jcs_v1', sha256: DIGEST, byteCount: 2, rowCount: 0 },
  observedAt: createdAt,
  dataThrough: PERIOD_END,
  sourceReadCutoffAt: createdAt,
  createdAt,
  manifest: {},
  sourcePublicationId: `pub-${id}`,
  wireRevision: { reporting_revision_id: id, revision_content_sha256: DIGEST },
});

const statement = (id, consumer_status, extra = {}, recorded_at) => ({
  consumerId: CONSUMER,
  account_id: ACCOUNT,
  reporting_status_id: id,
  delivery_config_id: obligation().delivery_config_id,
  delivery_config_version: obligation().delivery_config_version,
  report_definition_id: obligation().report_definition_id,
  period: { start: obligation().period.start, end: PERIOD_END, source_timezone: 'UTC' },
  reporting_obligation_id: 'obligation-narrative',
  consumer_status,
  status_as_of: recorded_at,
  recorded_at,
  ...extra,
});

/**
 * Minimal `ReportingLedgerStore` with an injectable clock and consumer-status
 * chain. The Postgres store reads `ledger_as_of` from `statement_timestamp()`,
 * so driving the rc.3 grace and deadline transitions against the *live handler*
 * needs a store whose clock the test owns.
 */
class NarrativeStore {
  constructor() {
    this.ledgerAsOf = EXPECTED_AT;
    this.revisions = [revision('rev-1', 1, EXPECTED_AT)];
    this.statuses = [];
    this.snapshots = new Map();
  }

  /** Caller-scoped: only the authenticated consumer's own chain is visible. */
  scopedStatuses(consumerId) {
    return consumerId ? this.statuses.filter(value => value.consumerId === consumerId) : [];
  }

  async createSnapshot(query) {
    const scoped = this.scopedStatuses(query.consumer_id);
    const snapshot = {
      snapshotId: `snapshot-${this.snapshots.size}`,
      ledgerAsOf: this.ledgerAsOf,
      changesCheckpoint: this.ledgerAsOf,
      queryFingerprint: 'fingerprint',
      query: structuredClone(query),
      configurations: [],
      coverageOrdinals: [],
      obligations: [obligation()],
      revisions: structuredClone(this.revisions),
      adjustments: [],
      consumerStatuses: structuredClone(scoped),
      consumerStatusProjection: structuredClone(scoped),
      issues: [],
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return structuredClone(snapshot);
  }

  async readSnapshotPage(snapshotId, accountId) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.query.account_id !== accountId) throw new Error('unavailable');
    return {
      snapshot: structuredClone(snapshot),
      obligations: structuredClone(snapshot.obligations),
      revisions: structuredClone(snapshot.revisions),
      adjustments: [],
      consumerStatuses: structuredClone(snapshot.consumerStatuses),
      totalCount: snapshot.obligations.length,
      offset: 0,
      limit: 100,
      hasMore: false,
    };
  }
}

const context = { account: { id: ACCOUNT }, consumer: CONSUMER };

async function read(handler, view = 'periods', consumer = CONSUMER) {
  return handler({ view }, { account: { id: ACCOUNT }, consumer });
}

const periodOf = response => response.periods[0];
const issuesOf = response => periodOf(response).issues ?? [];
const mismatchOf = response => issuesOf(response).find(issue => issue.code === 'CONSUMER_STATUS_MISMATCH');

/**
 * The consumer agrees with the seller, so this caller's view is undegraded.
 * `healthy` and `complete` are the open- and closed-scope spellings of that;
 * these reads leave the period filter to the default horizon, which closes the
 * scope, so pinning one spelling would assert scope closure rather than
 * agreement.
 */
function assertUndegraded(response, message) {
  assert.ok(
    ['healthy', 'complete'].includes(periodOf(response).health),
    `${message}: got ${periodOf(response).health}`
  );
  assert.equal(mismatchOf(response), undefined, message);
}

describe('rc.3 consumer-status narrative against the live handler', () => {
  let store;
  let handler;

  beforeEach(() => {
    store = new NarrativeStore();
    handler = createReportingStatusHandler(store, {
      resolveConsumerId: ctx => ctx.consumer,
    });
  });

  test('received on the current revision is healthy with no issue', async () => {
    store.statuses.push(
      statement(
        'narrative-received-0001',
        'received',
        {
          reporting_revision_id: 'rev-1',
          observed_revision_content_sha256: DIGEST,
        },
        EXPECTED_AT
      )
    );

    assertUndegraded(await read(handler), 'agreeing with the current revision is not a conflict');
  });

  test('restatement → within grace is delayed, past grace is action_required, then received on the new revision is healthy again', async () => {
    store.statuses.push(
      statement(
        'narrative-received-0001',
        'received',
        {
          reporting_revision_id: 'rev-1',
          observed_revision_content_sha256: DIGEST,
        },
        EXPECTED_AT
      )
    );

    // Seller restates. Grace deadline = rev-2 created_at + delivery_sla (1h).
    store.revisions.push(revision('rev-2', 2, '2026-09-02T01:10:00.000Z', 'rev-1'));

    store.ledgerAsOf = '2026-09-02T01:30:00.000Z';
    const withinGrace = await read(handler);
    assert.equal(periodOf(withinGrace).health, 'delayed', 'the buyer read what the seller then required');
    const delayedIssue = mismatchOf(withinGrace);
    assert.equal(delayedIssue.severity, 'delayed');
    assert.equal(delayedIssue.recommended_action, 'wait_for_retry');
    assert.equal(delayedIssue.opened_at, '2026-09-02T01:10:00.000Z');
    assert.equal(delayedIssue.reporting_status_id, 'narrative-received-0001');

    store.ledgerAsOf = '2026-09-02T02:30:00.000Z';
    const pastGrace = await read(handler);
    assert.equal(periodOf(pastGrace).health, 'action_required', 'the window is bounded');
    const escalated = mismatchOf(pastGrace);
    assert.equal(escalated.severity, 'action_required');
    // One work item across the transition, not two.
    assert.equal(escalated.issue_id, delayedIssue.issue_id);
    assert.equal(escalated.opened_at, delayedIssue.opened_at);

    // The buyer supersedes with a received naming the new revision.
    store.statuses.push(
      statement(
        'narrative-received-0002',
        'received',
        {
          supersedes_reporting_status_id: 'narrative-received-0001',
          reporting_revision_id: 'rev-2',
          observed_revision_content_sha256: DIGEST,
        },
        '2026-09-02T02:40:00.000Z'
      )
    );

    assertUndegraded(await read(handler), 'agreeing with the current leaf clears the mismatch');
  });

  test('content_mismatch round trip: escalates immediately, clears only when superseded', async () => {
    store.statuses.push(
      statement(
        'narrative-mismatch-0001',
        'content_mismatch',
        {
          reporting_revision_id: 'rev-1',
          observed_revision_content_sha256: DIGEST,
          mismatch_code: 'coverage_short',
        },
        EXPECTED_AT
      )
    );

    store.ledgerAsOf = '2026-09-02T01:05:00.000Z';
    const disputed = await read(handler);
    // No grace window: the buyer read the revision the seller still requires.
    assert.equal(periodOf(disputed).health, 'action_required');
    const issue = mismatchOf(disputed);
    assert.equal(issue.severity, 'action_required');
    assert.equal(issue.opened_at, EXPECTED_AT);

    // A seller cannot return the period to healthy while the causing statement
    // is still the consumer's current leaf — the projection recomputes it.
    store.ledgerAsOf = '2026-09-03T00:00:00.000Z';
    assert.equal(periodOf(await read(handler)).health, 'action_required', 'still the current leaf');

    store.statuses.push(
      statement(
        'narrative-mismatch-0002',
        'received',
        {
          supersedes_reporting_status_id: 'narrative-mismatch-0001',
          reporting_revision_id: 'rev-1',
          observed_revision_content_sha256: DIGEST,
        },
        '2026-09-03T01:00:00.000Z'
      )
    );

    assertUndegraded(await read(handler), 'superseding the disputed statement clears it');
  });

  test('consumer_status_pending appears after the deadline and clears on any posted status', async () => {
    // Before the deadline, silence is not yet counted.
    store.ledgerAsOf = '2026-09-02T01:30:00.000Z';
    let summary = await read(handler, 'summary');
    assert.equal(summary.obligation_counts.consumer_status_pending, 0);

    // expected_at + automated_recovery_window_seconds has passed with an empty chain.
    store.ledgerAsOf = '2026-09-02T02:30:00.000Z';
    summary = await read(handler, 'summary');
    assert.equal(summary.obligation_counts.consumer_status_pending, 1);
    // Never a health input, and it overlaps rather than partitions the counts:
    // the same obligation is counted both as pending and under its health.
    assert.ok(['healthy', 'complete'].includes(summary.health), `got ${summary.health}`);
    assert.equal(summary.obligation_counts.healthy + summary.obligation_counts.complete, 1);
    assert.equal(summary.obligation_counts.total, 1);
    assert.deepEqual(summary.issues, [], 'silence creates no issue');

    // Any posted status clears it — even a negative one.
    store.statuses.push(statement('narrative-missing-0001', 'revision_missing', {}, '2026-09-02T02:35:00.000Z'));
    summary = await read(handler, 'summary');
    assert.equal(summary.obligation_counts.consumer_status_pending, 0, 'a chain with any leaf is current');
    assert.equal(summary.health, 'action_required', 'but the negative statement is still a conflict');
  });

  test('consumer_status_pending is caller-scoped and the response stays schema-valid', async () => {
    store.ledgerAsOf = '2026-09-02T02:30:00.000Z';
    store.statuses.push(
      statement(
        'narrative-received-0001',
        'received',
        {
          reporting_revision_id: 'rev-1',
          observed_revision_content_sha256: DIGEST,
        },
        EXPECTED_AT
      )
    );

    const mine = await read(handler, 'summary', CONSUMER);
    const theirs = await read(handler, 'summary', OTHER_CONSUMER);
    assert.equal(mine.obligation_counts.consumer_status_pending, 0, 'I posted a status');
    assert.equal(theirs.obligation_counts.consumer_status_pending, 1, 'they did not');
    // One caller's statement must not appear in another caller's view.
    assert.deepEqual(theirs.issues, []);

    for (const [label, response] of [
      ['mine', mine],
      ['theirs', theirs],
    ]) {
      const outcome = validateResponse('get_reporting_status', response);
      assert.equal(outcome.valid, true, `${label}: ${JSON.stringify(outcome.issues)}`);
    }
  });

  test('an advertised escalation window forces a contact_* action past its boundary', async () => {
    const escalating = createReportingStatusHandler(store, {
      resolveConsumerId: ctx => ctx.consumer,
      consumerMismatchEscalation: {
        escalationSeconds: 1_800,
        operationsContact: { email: 'reporting-ops@seller.example' },
      },
    });
    store.statuses.push(
      statement(
        'narrative-received-0001',
        'received',
        {
          reporting_revision_id: 'rev-1',
          observed_revision_content_sha256: DIGEST,
        },
        EXPECTED_AT
      )
    );
    store.revisions.push(revision('rev-2', 2, '2026-09-02T01:10:00.000Z', 'rev-1'));

    // Inside the 1h grace window but past the 30-minute escalation boundary.
    store.ledgerAsOf = '2026-09-02T01:45:00.000Z';
    const response = await escalating({ view: 'periods' }, context);
    const issue = mismatchOf(response);
    assert.equal(issue.severity, 'action_required', 'escalation beats an open grace window');
    assert.match(issue.recommended_action, /^contact_/, 'a retry hint must not survive the boundary');
  });
});
