const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { memoryStorage } = require('../../dist/lib/storage/index.js');
const ledger = require('../../dist/lib/reporting/ledger/index.js');
const { addReportingInstantOffset } = require('../../dist/lib/reporting/ledger/instant.js');
const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

/** A ledger store that did not opt in: same methods, no `issueEventsSupported`. */
function withoutIssueEvents() {
  const store = new MemoryLedgerStore();
  Object.defineProperty(store, 'issueEventsSupported', { value: undefined });
  return store;
}

const {
  createReportingIssueEventDispatcherV1,
  planReportingIssueEventsV1,
  renderReportingIssueEventV1,
  reportingIssueEscalationV1,
  reportingIssueEventIdV1,
  ReportingIssueObserverError,
} = ledger;

const ESCALATION = { escalationSeconds: 3_600, operationsContact: { email: 'ops@seller.example' } };
const PERIOD = { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' };

/** A memory store with one obligation (plus helpers to drive revisions and statements). */
function fixture({ obligationId = 'ob-1', accountId = 'acct-1', deliveryConfigId = 'dc-1' } = {}) {
  const store = memoryStorage().ledger;
  const world = { store, ids: new Set() };
  world.addObligation = (id = obligationId, account = accountId, dc = deliveryConfigId) => {
    store.obligations.set(id, {
      reporting_obligation_id: id,
      configurationId: `cfg-${id}`,
      periodOrdinal: 0,
      account: { account_id: account },
      delivery_config_id: dc,
      delivery_config_version: 1,
      report_definition_id: 'rd-1',
      requiredFinality: 'snapshot',
      period: { ...PERIOD, sourceTimezone: 'UTC' },
      expectedAt: '2026-09-02T01:00:00Z',
      recoveryDeadlineAt: '2026-09-02T02:00:00Z',
      schedule: { deliverySlaMilliseconds: 3_600_000, recoveryWindowMilliseconds: 3_600_000 },
      state: 'pending',
      semanticFingerprint: 'x',
      coverage: { status: 'full' },
    });
  };
  world.at = instant => {
    store.ledgerAsOf = instant;
  };
  world.commit = (number, { id = obligationId, account = accountId } = {}) =>
    store.commitRevision({
      reporting_revision_id: `${id}-rev-${number}`,
      reporting_obligation_id: id,
      revisionNumber: number,
      ...(number > 1 ? { supersedes_reporting_revision_id: `${id}-rev-${number - 1}` } : {}),
      createdAt: store.ledgerAsOf,
      finality: 'snapshot',
      binding: { sha256: `h${number}` },
      wireRevision: { account_id: account },
    });
  world.status = (statusId, consumerStatus, extra = {}) => ({
    reporting_status_id: statusId,
    consumerId: 'buyer-1',
    account_id: accountId,
    delivery_config_id: deliveryConfigId,
    delivery_config_version: 1,
    report_definition_id: 'rd-1',
    period: { ...PERIOD, source_timezone: 'UTC' },
    consumer_status: consumerStatus,
    status_as_of: store.ledgerAsOf,
    ...extra,
  });
  world.sync = (key, status, account = accountId) =>
    store.syncConsumerStatusBatch({
      account_id: account,
      consumerId: status.consumerId,
      idempotencyKey: key,
      requestFingerprint: `fp-${key}`,
      entries: [{ status }],
    });
  world.kinds = () => [...store.issueEvents.values()].map(value => value.kind);
  world.events = () => [...store.issueEvents.values()];
  world.addObligation();
  return world;
}

const sid = n => `status-${String(n).padStart(16, '0')}`;

describe('issue event ids and instants', () => {
  test('event id matches the golden vector shared with the Python SDK', () => {
    assert.equal(
      reportingIssueEventIdV1('rpti_example', 'buyer-1', 'opened'),
      'rpie_3838185b0fe2e44fb50b8155e113491031c92e3d'
    );
    assert.notEqual(
      reportingIssueEventIdV1('rpti_example', 'buyer-1', 'resolved'),
      reportingIssueEventIdV1('rpti_example', 'buyer-1', 'opened')
    );
  });

  test('addReportingInstantOffset keeps sub-millisecond digits', () => {
    assert.equal(addReportingInstantOffset('2026-01-01T00:00:00.1234567Z', 1_000), '2026-01-01T00:00:01.1234567Z');
    assert.equal(addReportingInstantOffset('2026-01-01T00:00:00Z', 1_500), '2026-01-01T00:00:01.500Z');
  });
});

describe('planReportingIssueEventsV1', () => {
  const occurrence = (issueId, openedAt = '2026-09-02T02:00:00.000Z') => ({
    issueId,
    accountId: 'acct-1',
    consumerId: 'buyer-1',
    reportingObligationId: 'ob-1',
    reportingStatusId: `status-of-${issueId}`,
    openedAt,
  });
  const openedRecord = (issueId, occurredAt = '2026-09-02T02:00:00.000Z') => ({
    eventId: reportingIssueEventIdV1(issueId, 'buyer-1', 'opened'),
    kind: 'opened',
    issueId,
    accountId: 'acct-1',
    consumerId: 'buyer-1',
    reportingObligationId: 'ob-1',
    reportingStatusId: `status-of-${issueId}`,
    occurredAt,
  });

  test('opens new conflicts and ignores conflicts that are already open', () => {
    const plan = planReportingIssueEventsV1({
      open: [openedRecord('rpti_a')],
      conflicts: [occurrence('rpti_a'), occurrence('rpti_b', '2026-09-02T02:30:00.000Z')],
      at: '2026-09-02T03:00:00.000Z',
    });
    assert.deepEqual(
      plan.map(value => [value.kind, value.issueId]),
      [['opened', 'rpti_b']]
    );
    assert.equal(plan[0].occurredAt, '2026-09-02T02:30:00.000Z');
    assert.equal(plan[0].eventId, reportingIssueEventIdV1('rpti_b', 'buyer-1', 'opened'));
  });

  test('resolves open occurrences that no longer conflict, at the write instant', () => {
    const plan = planReportingIssueEventsV1({
      open: [openedRecord('rpti_a')],
      conflicts: [],
      at: '2026-09-02T03:00:00.000Z',
    });
    assert.deepEqual(
      plan.map(value => value.kind),
      ['resolved']
    );
    assert.equal(plan[0].occurredAt, '2026-09-02T03:00:00.000Z');
  });

  test('a resolution is never dated before the occurrence opened', () => {
    const plan = planReportingIssueEventsV1({
      open: [openedRecord('rpti_a', '2026-09-02T04:00:00.000Z')],
      conflicts: [],
      at: '2026-09-02T03:00:00.000Z',
    });
    assert.equal(plan[0].occurredAt, '2026-09-02T04:00:00.000Z');
  });

  test('puts resolutions before openings', () => {
    const plan = planReportingIssueEventsV1({
      open: [openedRecord('rpti_old')],
      conflicts: [occurrence('rpti_new')],
      at: '2026-09-02T03:00:00.000Z',
    });
    assert.deepEqual(
      plan.map(value => [value.kind, value.issueId]),
      [
        ['resolved', 'rpti_old'],
        ['opened', 'rpti_new'],
      ]
    );
  });

  test('reportingIssueEscalationV1 is undefined before the boundary and exact at it', () => {
    const opened = openedRecord('rpti_a', '2026-09-02T02:00:00.1234567Z');
    assert.equal(reportingIssueEscalationV1(opened, 3_600, '2026-09-02T03:00:00.1234566Z'), undefined);
    const escalated = reportingIssueEscalationV1(opened, 3_600, '2026-09-02T03:00:00.1234567Z');
    assert.equal(escalated.kind, 'escalated');
    assert.equal(escalated.occurredAt, '2026-09-02T03:00:00.1234567Z');
    assert.equal(escalated.eventId, reportingIssueEventIdV1('rpti_a', 'buyer-1', 'escalated'));
  });
});

describe('memory store records issue events with the write', () => {
  test('an agreeing received statement records nothing', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'received', { reporting_revision_id: 'ob-1-rev-1' }));
    assert.equal(w.store.issueEvents.size, 0);
  });

  test('a restatement that makes the statement stale opens in commitRevision', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'received', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T02:00:00.000Z');
    await w.commit(2);
    const [event] = w.events();
    assert.deepEqual(w.kinds(), ['opened']);
    assert.equal(event.occurredAt, '2026-09-02T02:00:00.000Z');
    assert.equal(event.accountId, 'acct-1');
    assert.equal(event.consumerId, 'buyer-1');
    assert.equal(event.reportingStatusId, sid(1));
    assert.equal(event.eventId, reportingIssueEventIdV1(event.issueId, event.consumerId, 'opened'));
  });

  // Under today's TypeScript projection a real restatement cannot clear a mismatch (adcp-client#3653), so
  // this seeds an open occurrence for a leaf that does not conflict and pins that commitRevision's settle
  // branch is wired: it resolves what the projection no longer reports.
  test('commitRevision resolves an open occurrence whose leaf no longer conflicts', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    // A received statement naming the revision about to be committed agrees with it once it exists.
    const statement = {
      ...w.status(sid(1), 'received', { reporting_revision_id: 'ob-1-rev-2' }),
      recorded_at: '2026-09-02T01:00:00.000Z',
    };
    w.store.consumerStatements.push(statement);
    const issueId = 'rpti_seeded';
    w.store.issueEvents.set(reportingIssueEventIdV1(issueId, 'buyer-1', 'opened'), {
      eventId: reportingIssueEventIdV1(issueId, 'buyer-1', 'opened'),
      kind: 'opened',
      issueId,
      accountId: 'acct-1',
      consumerId: 'buyer-1',
      reportingObligationId: 'ob-1',
      reportingStatusId: sid(1),
      occurredAt: '2026-09-02T01:00:00.000Z',
      seq: 1,
      recordedAt: '2026-09-02T01:00:00.000Z',
      dueAt: '2026-09-02T01:00:00.000Z',
      attempts: 0,
    });
    w.at('2026-09-02T02:00:00.000Z');
    await w.commit(2);
    const resolved = w.events().filter(value => value.kind === 'resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].issueId, issueId);
    assert.equal(resolved[0].occurredAt, '2026-09-02T02:00:00.000Z');
    assert.equal(w.events().filter(value => value.kind === 'opened').length, 1, 'no new occurrence');
  });

  for (const negative of ['unreadable', 'revision_missing']) {
    test(`a ${negative} status filed after a revision opens at ingest`, async () => {
      const w = fixture();
      w.at('2026-09-02T00:30:00.000Z');
      await w.commit(1);
      w.at('2026-09-02T01:00:00.000Z');
      await w.sync('k1', w.status(sid(1), negative, { reporting_revision_id: 'ob-1-rev-1' }));
      assert.deepEqual(w.kinds(), ['opened']);
      // The ingest's own instant: the statement's recorded_at, which is never before the revision anchor.
      assert.equal(w.events()[0].occurredAt, '2026-09-02T01:00:00.000Z');
    });
  }

  test('a negative status filed before any revision opens at the first revision commit', async () => {
    const w = fixture();
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    assert.equal(w.store.issueEvents.size, 0);
    w.at('2026-09-02T02:00:00.000Z');
    await w.commit(1);
    assert.deepEqual(w.kinds(), ['opened']);
    assert.equal(w.events()[0].occurredAt, '2026-09-02T02:00:00.000Z');
  });

  test('superseding with an agreeing statement resolves the old occurrence', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T01:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
    assert.deepEqual(w.kinds(), ['opened', 'resolved']);
    const [opened, resolved] = w.events();
    assert.equal(resolved.issueId, opened.issueId);
    assert.equal(resolved.occurredAt, '2026-09-02T01:30:00.000Z');
  });

  test('superseding with another conflicting statement resolves the old and opens a new one', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T01:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'revision_missing', {
        reporting_revision_id: 'ob-1-rev-1',
        supersedes_reporting_status_id: sid(1),
      })
    );
    assert.deepEqual(w.kinds(), ['opened', 'resolved', 'opened']);
    const [first, resolved, second] = w.events();
    assert.equal(resolved.issueId, first.issueId);
    assert.notEqual(second.issueId, first.issueId);
    assert.equal(second.reportingStatusId, sid(2));
  });

  test('an exact batch replay and an unchanged same-id batch record nothing', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    const status = w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' });
    await w.sync('k1', status);
    assert.equal(w.store.issueEvents.size, 1);
    w.at('2026-09-02T05:00:00.000Z');
    await w.sync('k1', status);
    const [unchanged] = await w.sync('k2', status);
    assert.equal(unchanged.inserted, false);
    assert.equal(w.store.issueEvents.size, 1);
  });

  test('only opened, escalated and resolved are ever emitted', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T03:00:00.000Z');
    await w.store.sweepIssueEscalations({ escalationSeconds: 3_600 });
    w.at('2026-09-02T03:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
    assert.deepEqual(w.kinds(), ['opened', 'escalated', 'resolved']);
    for (const kind of w.kinds()) assert.ok(!['acknowledged', 'waived'].includes(kind));
  });
});

describe('escalation sweep', () => {
  async function openAt(w) {
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
  }

  test('nothing before the boundary; exactly once at the exact boundary', async () => {
    const w = fixture();
    await openAt(w);
    w.at('2026-09-02T01:59:59.999Z');
    assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 3_600 }), 0);
    w.at('2026-09-02T02:00:00.000Z');
    assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 3_600 }), 1);
    const escalated = w.events().find(value => value.kind === 'escalated');
    assert.equal(escalated.occurredAt, '2026-09-02T02:00:00.000Z');
    w.at('2026-09-02T09:00:00.000Z');
    assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 3_600 }), 0);
    assert.equal(w.kinds().filter(kind => kind === 'escalated').length, 1);
  });

  test('a resolved occurrence is not escalated', async () => {
    const w = fixture();
    await openAt(w);
    w.at('2026-09-02T01:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
    w.at('2026-09-02T09:00:00.000Z');
    assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 3_600 }), 0);
    assert.deepEqual(w.kinds(), ['opened', 'resolved']);
  });

  test('the dispatcher records no escalation without an escalation commitment', async () => {
    const w = fixture();
    await openAt(w);
    w.at('2026-09-02T09:00:00.000Z');
    const dispatcher = createReportingIssueEventDispatcherV1({ store: w.store, observer: () => {} });
    const turn = await dispatcher.runOnce();
    assert.equal(turn.escalationsRecorded, 0);
    assert.equal(turn.delivered, 1);
    assert.deepEqual(w.kinds(), ['opened']);
  });
});

describe('claim, complete, release and prune', () => {
  async function twoEventsOnOneOccurrence() {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T01:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
    return w;
  }

  test('an occurrence leases one event at a time, in recording order', async () => {
    const w = await twoEventsOnOneOccurrence();
    const first = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10 });
    assert.deepEqual(
      first.map(value => value.kind),
      ['opened']
    );
    assert.equal(first[0].attempts, 1);
    assert.ok(first[0].statement, 'the causing statement rides on the lease');
    assert.deepEqual(await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10 }), []);
    assert.equal(await w.store.completeIssueEvent(first[0]), true);
    const second = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10 });
    assert.deepEqual(
      second.map(value => value.kind),
      ['resolved']
    );
  });

  test('an expired lease is reclaimed with attempt 2 and the old lease is stale', async () => {
    const w = await twoEventsOnOneOccurrence();
    const [first] = await w.store.claimIssueEvents({ leaseMilliseconds: 1_000, limit: 1 });
    w.at('2026-09-02T01:30:00.999Z');
    assert.deepEqual(await w.store.claimIssueEvents({ leaseMilliseconds: 1_000, limit: 1 }), []);
    w.at('2026-09-02T01:30:01.001Z');
    const [again] = await w.store.claimIssueEvents({ leaseMilliseconds: 1_000, limit: 1 });
    assert.equal(again.eventId, first.eventId);
    assert.equal(again.attempts, 2);
    assert.equal(await w.store.completeIssueEvent(first), false);
    assert.equal(await w.store.releaseIssueEvent(first, { retryAfterMilliseconds: 0 }), false);
    assert.equal(await w.store.completeIssueEvent(again), true);
  });

  test('release backs the event off: not due before the delay, due after', async () => {
    const w = await twoEventsOnOneOccurrence();
    const [lease] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
    assert.equal(await w.store.releaseIssueEvent(lease, { retryAfterMilliseconds: 5_000 }), true);
    w.at('2026-09-02T01:30:04.999Z');
    assert.deepEqual(await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 }), []);
    w.at('2026-09-02T01:30:05.000Z');
    const [again] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
    assert.equal(again.eventId, lease.eventId);
    assert.equal(again.attempts, 2);
  });

  test('prune deletes only whole closed occurrences, delivered past the retention', async () => {
    const w = await twoEventsOnOneOccurrence();
    const [opened] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
    assert.equal(await w.store.completeIssueEvent(opened), true);
    w.at('2030-01-01T00:00:00.000Z');
    assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 1_000 }), 0, 'resolved is still undelivered');
    w.at('2026-09-02T01:30:00.000Z');
    const [resolved] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
    assert.equal(resolved.kind, 'resolved');
    assert.equal(await w.store.completeIssueEvent(resolved), true);
    // The causing statement was superseded, so the occurrence is closed and goes whole once past retention.
    w.at('2026-09-02T01:30:00.500Z');
    assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 1_000 }), 0);
    w.at('2026-09-02T01:30:01.001Z');
    assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 1_000 }), 2);
    assert.deepEqual(w.kinds(), []);
  });

  test('accountId scopes claims and sweeps', async () => {
    const w = fixture();
    w.addObligation('ob-2', 'acct-2', 'dc-2');
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    await w.commit(1, { id: 'ob-2', account: 'acct-2' });
    w.at('2026-09-02T01:00:00.000Z');
    const two = {
      ...w.status(sid(3), 'unreadable', { reporting_revision_id: 'ob-2-rev-1' }),
      account_id: 'acct-2',
      delivery_config_id: 'dc-2',
    };
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    await w.sync('k2', two, 'acct-2');
    assert.equal(w.store.issueEvents.size, 2);
    w.at('2026-09-02T09:00:00.000Z');
    assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 3_600, accountId: 'acct-2' }), 1);
    assert.equal(w.events().find(value => value.kind === 'escalated').accountId, 'acct-2');
    const claimed = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10, accountId: 'acct-1' });
    assert.deepEqual(
      claimed.map(value => value.accountId),
      ['acct-1']
    );
    const rest = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10 });
    assert.deepEqual(
      rest.map(value => value.accountId),
      ['acct-2']
    );
  });
});

describe('issue event dispatcher', () => {
  async function staleReceived() {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'received', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T02:00:00.000Z');
    await w.commit(2);
    return w;
  }

  test('a sync observer receives a rendered opened, then escalated, then resolved event', async () => {
    const w = await staleReceived();
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store: w.store,
      observer: event => void seen.push(event),
      escalation: ESCALATION,
    });
    let turn = await dispatcher.runOnce({ accountId: 'acct-1' });
    assert.equal(turn.delivered, 1);
    const [opened] = seen;
    assert.equal(opened.kind, 'opened');
    assert.equal(opened.attempt, 1);
    assert.equal(opened.issue.code, 'CONSUMER_STATUS_MISMATCH');
    assert.equal(opened.issue.severity, 'delayed');
    assert.equal(opened.issue.recommendedAction, 'wait_for_retry');
    assert.equal(opened.issue.openedAt, opened.occurredAt);
    assert.ok(Object.isFrozen(opened));

    w.at('2026-09-02T03:00:00.000Z');
    turn = await dispatcher.runOnce({ accountId: 'acct-1' });
    assert.equal(turn.escalationsRecorded, 1);
    const escalated = seen.at(-1);
    assert.equal(escalated.kind, 'escalated');
    assert.equal(escalated.occurredAt, '2026-09-02T03:00:00.000Z');
    assert.equal(escalated.issue.code, 'CONSUMER_STATUS_MISMATCH');
    assert.equal(escalated.issue.severity, 'action_required');
    assert.match(escalated.issue.recommendedAction, /^contact_/);
    assert.equal(escalated.issueId, opened.issueId);

    w.at('2026-09-02T03:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-2', supersedes_reporting_status_id: sid(1) })
    );
    await dispatcher.runOnce({ accountId: 'acct-1' });
    const resolved = seen.at(-1);
    assert.equal(resolved.kind, 'resolved');
    assert.equal(resolved.issue, null);
    assert.equal(resolved.occurredAt, '2026-09-02T03:30:00.000Z');
    assert.deepEqual(
      seen.map(value => value.kind),
      ['opened', 'escalated', 'resolved']
    );
    assert.equal(new Set(seen.map(value => value.eventId)).size, 3);
  });

  test('a throwing observer is retried with the same eventId and attempt 2 after the backoff', async () => {
    const w = await staleReceived();
    let fail = true;
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store: w.store,
      retryBaseMilliseconds: 1_000,
      observer: event => {
        seen.push(event);
        if (fail) throw new Error('boom');
      },
    });
    let turn = await dispatcher.runOnce();
    assert.equal(turn.failed, 1);
    assert.equal(turn.delivered, 0);
    assert.ok(turn.errors[0] instanceof ReportingIssueObserverError);
    assert.equal(turn.errors[0].component, 'issue_observer');
    assert.equal(turn.errors[0].eventId, seen[0].eventId);
    fail = false;
    turn = await dispatcher.runOnce();
    assert.equal(turn.delivered, 0, 'not due before the backoff');
    w.at('2026-09-02T02:00:01.000Z');
    turn = await dispatcher.runOnce();
    assert.equal(turn.delivered, 1);
    assert.equal(seen.at(-1).eventId, seen[0].eventId);
    assert.equal(seen.at(-1).attempt, 2);
  });

  test('an async observer past the timeout is a failure; a fast async observer is delivered', async () => {
    const w = await staleReceived();
    const slow = createReportingIssueEventDispatcherV1({
      store: w.store,
      observerTimeoutMilliseconds: 50,
      retryBaseMilliseconds: 1_000,
      observer: () => new Promise(resolve => setTimeout(resolve, 500)),
    });
    const turn = await slow.runOnce();
    assert.equal(turn.failed, 1);
    assert.equal(turn.errors[0].component, 'issue_observer');
    assert.match(String(turn.errors[0].cause?.message), /timed out/);
    w.at('2026-09-02T02:00:01.000Z');
    const fast = createReportingIssueEventDispatcherV1({
      store: w.store,
      observerTimeoutMilliseconds: 50,
      observer: async () => {},
    });
    assert.equal((await fast.runOnce()).delivered, 1);
  });

  test('a store whose getObligation throws yields issue_events:snapshot and the event is released', async () => {
    const w = await staleReceived();
    let broken = true;
    const store = new Proxy(w.store, {
      get(target, property) {
        if (property === 'getObligation' && broken) {
          return async () => {
            throw new Error('db down');
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store,
      retryBaseMilliseconds: 1_000,
      observer: event => void seen.push(event),
    });
    let turn = await dispatcher.runOnce();
    assert.equal(turn.errors[0].component, 'issue_events:snapshot');
    assert.equal(turn.failed, 1);
    assert.equal(turn.delivered, 0);
    assert.equal(seen.length, 0, 'not delivered unrendered');
    assert.ok(w.events().every(value => value.deliveredAt === undefined));
    broken = false;
    w.at('2026-09-02T02:00:01.000Z');
    turn = await dispatcher.runOnce();
    assert.equal(turn.delivered, 1);
    assert.equal(seen[0].issue.code, 'CONSUMER_STATUS_MISMATCH');
  });

  test('unrenderable evidence gives issue: null rather than a throw', () => {
    const lease = {
      eventId: reportingIssueEventIdV1('rpti_x', 'buyer-1', 'opened'),
      kind: 'opened',
      issueId: 'rpti_x',
      accountId: 'acct-1',
      consumerId: 'buyer-1',
      reportingObligationId: 'ob-1',
      reportingStatusId: sid(1),
      occurredAt: '2026-09-02T02:00:00.000Z',
      recordedAt: '2026-09-02T02:00:00.000Z',
      attempts: 3,
      leaseToken: 't',
      leaseExpiresAt: '2026-09-02T03:00:00.000Z',
    };
    const noContext = renderReportingIssueEventV1(lease, undefined);
    assert.equal(noContext.issue, null);
    assert.equal(noContext.attempt, 3);
    const garbage = renderReportingIssueEventV1(lease, { obligation: {}, revisions: [], issues: [], statement: {} });
    assert.equal(garbage.issue, null);
    assert.equal(renderReportingIssueEventV1({ ...lease, kind: 'resolved' }, undefined).issue, null);
  });

  test('constructor refuses unsupported stores and non-function observers', () => {
    assert.throws(
      () => createReportingIssueEventDispatcherV1({ store: withoutIssueEvents(), observer: () => {} }),
      TypeError
    );
    assert.throws(
      () => createReportingIssueEventDispatcherV1({ store: memoryStorage().ledger, observer: 'nope' }),
      TypeError
    );
  });
});

describe('occurrences are keyed by consumer, and retention prunes only closed ones', () => {
  const openUnreadable = async (w, consumerId = 'buyer-1', statusId = sid(1)) => {
    w.at('2026-09-02T00:30:00.000Z');
    if (w.store.revisions.size === 0) await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync(
      `open-${consumerId}-${statusId}`,
      w.status(statusId, 'unreadable', { consumerId, reporting_revision_id: 'ob-1-rev-1' })
    );
  };
  const deliverAll = async w => {
    for (;;) {
      const leases = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 });
      if (leases.length === 0) return;
      for (const lease of leases) await w.store.completeIssueEvent(lease);
    }
  };

  test('an open occurrence survives prune; once superseded it is pruned whole', async () => {
    const w = fixture();
    await openUnreadable(w);
    await deliverAll(w);
    w.at('2030-01-01T00:00:00.000Z');
    assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 1_000 }), 0);
    assert.deepEqual(w.kinds(), ['opened'], 'the open occurrence is untouched');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
    assert.deepEqual(w.kinds(), ['opened', 'resolved']);
    await deliverAll(w);
    w.at('2030-01-01T00:01:00.000Z');
    assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 1_000 }), 2);
    assert.deepEqual(w.kinds(), []);
  });

  test('an escalation window longer than the retention still escalates', async () => {
    const w = fixture();
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store: w.store,
      observer: event => void seen.push(event.kind),
      escalation: { escalationSeconds: 10 * 86_400, operationsContact: { email: 'ops@seller.example' } },
    }); // default retention: 7 days
    await openUnreadable(w);
    await dispatcher.runOnce();
    w.at('2026-09-10T01:00:00.000Z'); // 8 days: past the retention, inside the window
    await dispatcher.runOnce();
    assert.deepEqual(w.kinds(), ['opened'], 'opened was not pruned');
    w.at('2026-09-12T02:00:00.000Z');
    const turn = await dispatcher.runOnce();
    assert.equal(turn.escalationsRecorded, 1);
    assert.deepEqual(seen, ['opened', 'escalated']);
    assert.equal(w.events().find(value => value.kind === 'escalated').occurredAt, '2026-09-12T01:00:00.000Z');
  });

  test('a resolved occurrence whose statement is still current is kept; a superseded one is pruned and not recreated', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    // Anchor: seed an open occurrence for a leaf that agrees once rev-2 exists (see the resolve-on-restatement test).
    w.store.consumerStatements.push({
      ...w.status(sid(1), 'received', { reporting_revision_id: 'ob-1-rev-2' }),
      recorded_at: '2026-09-02T01:00:00.000Z',
    });
    const seeded = reportingIssueEventIdV1('rpti_seeded', 'buyer-1', 'opened');
    w.store.issueEvents.set(seeded, {
      eventId: seeded,
      kind: 'opened',
      issueId: 'rpti_seeded',
      accountId: 'acct-1',
      consumerId: 'buyer-1',
      reportingObligationId: 'ob-1',
      reportingStatusId: sid(1),
      occurredAt: '2026-09-02T01:00:00.000Z',
      seq: 1,
      recordedAt: '2026-09-02T01:00:00.000Z',
      dueAt: '2026-09-02T01:00:00.000Z',
      attempts: 0,
    });
    w.at('2026-09-02T02:00:00.000Z');
    await w.commit(2);
    // A second consumer's occurrence, opened and then superseded: closed.
    await openUnreadable(w, 'buyer-2', sid(7));
    w.at('2026-09-02T03:00:00.000Z');
    await w.sync(
      'k-two',
      w.status(sid(8), 'received', {
        consumerId: 'buyer-2',
        reporting_revision_id: 'ob-1-rev-2',
        supersedes_reporting_status_id: sid(7),
      })
    );
    assert.deepEqual(
      w
        .events()
        .filter(value => value.consumerId === 'buyer-2')
        .map(value => value.kind),
      ['opened', 'resolved']
    );
    await deliverAll(w);
    const prunedIds = w
      .events()
      .filter(value => value.consumerId === 'buyer-2')
      .map(value => value.eventId);
    w.at('2030-01-01T00:00:00.000Z');
    assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 1_000 }), 2, 'only the closed occurrence');
    const anchor = w.events().filter(value => value.consumerId === 'buyer-1');
    assert.deepEqual(
      anchor.map(value => value.kind),
      ['opened', 'resolved'],
      'the anchor stays'
    );
    // A later commit re-derives occurrences but cannot record the pruned event ids again.
    w.at('2030-01-02T00:00:00.000Z');
    await w.commit(3);
    for (const eventId of prunedIds) assert.equal(w.store.issueEvents.has(eventId), false, eventId);
    assert.equal(w.events().filter(value => value.issueId === 'rpti_seeded').length, 2, 'the anchor stays single');
  });

  test('two consumers filing the same status id get independent occurrences', async () => {
    const w = fixture();
    await openUnreadable(w, 'buyer-1', sid(1));
    await openUnreadable(w, 'buyer-2', sid(1));
    const [one, two] = w.events();
    assert.equal(one.kind, 'opened');
    assert.equal(two.kind, 'opened');
    assert.equal(one.issueId, two.issueId, 'same issue id');
    assert.deepEqual([one.consumerId, two.consumerId], ['buyer-1', 'buyer-2']);
    assert.notEqual(one.eventId, two.eventId);
    assert.equal(one.eventId, reportingIssueEventIdV1(one.issueId, 'buyer-1', 'opened'));
    assert.equal(two.eventId, reportingIssueEventIdV1(two.issueId, 'buyer-2', 'opened'));
    // One event per consumer occurrence, leased independently.
    const claimed = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10 });
    assert.deepEqual(claimed.map(lease => lease.consumerId).sort(), ['buyer-1', 'buyer-2']);
    for (const lease of claimed) await w.store.completeIssueEvent(lease);
    // buyer-1 supersedes and resolves; buyer-2 stays open and escalates.
    w.at('2026-09-02T01:30:00.000Z');
    await w.sync(
      'k-one',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
    const byConsumer = consumer =>
      w
        .events()
        .filter(value => value.consumerId === consumer)
        .map(value => value.kind);
    assert.deepEqual(byConsumer('buyer-1'), ['opened', 'resolved']);
    assert.deepEqual(byConsumer('buyer-2'), ['opened']);
    w.at('2026-09-02T09:00:00.000Z');
    assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 3_600 }), 1);
    assert.deepEqual(byConsumer('buyer-1'), ['opened', 'resolved']);
    assert.deepEqual(byConsumer('buyer-2'), ['opened', 'escalated']);
  });
});

describe('principal on issue events', () => {
  const subscription = {
    tenantId: 'tenant-1',
    principalId: 'principal-1',
    subscriptionId: 'sub-1',
    offeringId: 'offering-1',
    ownership: 'owed_set',
  };

  async function openAndResolve(w) {
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    await w.sync('k1', w.status(sid(1), 'unreadable', { reporting_revision_id: 'ob-1-rev-1' }));
    w.at('2026-09-02T01:30:00.000Z');
    await w.sync(
      'k2',
      w.status(sid(2), 'received', { reporting_revision_id: 'ob-1-rev-1', supersedes_reporting_status_id: sid(1) })
    );
  }

  test('opened and resolved both carry the obligation principal', async () => {
    const w = fixture();
    w.store.obligations.get('ob-1').subscription = subscription;
    await openAndResolve(w);
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store: w.store,
      observer: event => void seen.push(event),
    });
    await dispatcher.runOnce();
    assert.deepEqual(
      seen.map(event => event.kind),
      ['opened', 'resolved']
    );
    for (const event of seen) assert.deepEqual(event.principal, { tenantId: 'tenant-1', principalId: 'principal-1' });
  });

  test('a resolved event is still delivered, without a principal, when the obligation is gone', async () => {
    const w = fixture();
    w.store.obligations.get('ob-1').subscription = subscription;
    await openAndResolve(w);
    w.store.obligations.delete('ob-1');
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store: w.store,
      observer: event => void seen.push(event),
    });
    const turn = await dispatcher.runOnce();
    assert.equal(turn.delivered, 2);
    const resolved = seen.find(event => event.kind === 'resolved');
    assert.ok(resolved);
    assert.equal('principal' in resolved, false);
    assert.equal(resolved.issue, null);
  });
});

describe('abort', () => {
  test('aborting inside the observer stops the batch and releases the rest immediately', async () => {
    const w = fixture();
    w.at('2026-09-02T00:30:00.000Z');
    await w.commit(1);
    w.at('2026-09-02T01:00:00.000Z');
    for (const consumer of ['buyer-1', 'buyer-2', 'buyer-3']) {
      await w.sync(
        `k-${consumer}`,
        w.status(sid(1), 'unreadable', { consumerId: consumer, reporting_revision_id: 'ob-1-rev-1' })
      );
    }
    assert.equal(w.store.issueEvents.size, 3);
    const controller = new AbortController();
    const seen = [];
    const dispatcher = createReportingIssueEventDispatcherV1({
      store: w.store,
      observer: event => {
        seen.push(event.eventId);
        controller.abort();
      },
    });
    const turn = await dispatcher.runOnce({ signal: controller.signal });
    assert.equal(seen.length, 1, 'the observer is not called again');
    assert.equal(turn.delivered, 1);
    // No wait for lease expiry: the other two are claimable at the same instant.
    const again = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10 });
    assert.equal(again.length, 2);
    assert.ok(!again.some(lease => lease.eventId === seen[0]));
    assert.deepEqual(
      again.map(lease => lease.attempts),
      [2, 2]
    );
  });
});

describe('createReliableReportingService issueObserver', () => {
  function deliveryOffering() {
    const source = redactedReportingSourceOfferingV1;
    return {
      offering_id: source.offeringId,
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
        primary_keys: ['media_buy_id'],
      },
      schedule: {
        period_duration: 'P1D',
        alignment: 'source_timezone',
        period_timezone_policy: 'fixed',
        period_timezone: 'UTC',
        delivery_sla: 'PT0S',
      },
      supported_finality: ['snapshot'],
      reconciliation_mode: 'delivery_only',
    };
  }

  function adapter() {
    const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
    sourceOffering.cadence = {
      ...sourceOffering.cadence,
      expectedAvailabilityLag: 'PT0S',
      worstCaseAvailabilityLag: 'PT0S',
    };
    return {
      sourceOffering,
      deliveryOffering: deliveryOffering(),
      fetchSlice: (request, context) => ({
        reporting_period: { start: request.start_date, end: request.end_date },
        currency: context.sourceSettings.currency,
        reporting_rows: [],
      }),
    };
  }

  function options(overrides = {}) {
    return {
      adapters: { fixture: adapter() },
      contact: { name: 'Reporting operations', email: 'reporting@example.com' },
      automatedRecoveryWindowSeconds: 86_400,
      statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
      resolveSource: account => ({
        adapterId: 'fixture',
        sourceScope: { network_id: `network-${account.id}` },
        sourceTimezone: 'UTC',
      }),
      resolveCurrency: () => 'USD',
      resolveCoverage: account => {
        const [template] = redactedReportingSourceRequestV1().coverage.constituents;
        const mediaBuyId = `media-buy-${account.id}`;
        return {
          constituents: [
            {
              ...structuredClone(template),
              constituentId: `constituent-${account.id}`,
              mediaBuyId,
              productBinding: { ...structuredClone(template.productBinding), mediaBuyId },
            },
          ],
        };
      },
      ...overrides,
    };
  }

  test('refuses an issueObserver against a store without issue-event support', () => {
    assert.throws(
      () => createReliableReportingService(options({ store: withoutIssueEvents(), issueObserver: () => {} })),
      error => error.name === 'PlatformConfigError' && error.configField === 'issueObserver'
    );
  });

  test('refuses a non-function issueObserver', () => {
    assert.throws(
      () => createReliableReportingService(options({ storage: memoryStorage(), issueObserver: 'nope' })),
      error => error.name === 'PlatformConfigError' && error.configField === 'issueObserver'
    );
  });

  test('runCycle returns issueEvents and delivers recorded events to the observer', async () => {
    const storage = memoryStorage();
    const seen = [];
    const service = createReliableReportingService(options({ storage, issueObserver: event => void seen.push(event) }));
    const empty = await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });
    assert.deepEqual(empty.issueEvents, { escalationsRecorded: 0, delivered: 0, failed: 0, errors: [] });

    const eventId = reportingIssueEventIdV1('rpti_seeded', 'buyer-1', 'opened');
    storage.ledger.issueEvents.set(eventId, {
      eventId,
      kind: 'opened',
      issueId: 'rpti_seeded',
      accountId: 'account-a',
      consumerId: 'buyer-1',
      reportingObligationId: 'ob-missing',
      reportingStatusId: sid(1),
      occurredAt: '2026-09-02T02:00:00.000Z',
      seq: 1,
      recordedAt: '2026-09-02T02:00:00.000Z',
      dueAt: '2026-09-02T02:00:00.000Z',
      attempts: 0,
    });
    const cycle = await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });
    assert.equal(cycle.issueEvents.delivered, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].eventId, eventId);
    assert.equal(seen[0].issue, null, 'evidence is gone, so the issue is not rendered');
  });

  test('a service without issueObserver carries no issueEvents', async () => {
    const service = createReliableReportingService(options({ storage: memoryStorage() }));
    const cycle = await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });
    assert.equal(cycle.issueEvents, undefined);
  });
});
