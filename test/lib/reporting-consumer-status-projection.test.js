const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assertReportingConsumerMismatchEscalation,
  assertSupportedReportingAuthoritativeParty,
  projectReportingConsumerStatusMismatchV1,
  UnsupportedReportingFeatureError,
} = require('../../dist/lib/reporting/ledger/index.js');
const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');

const HOUR = 3_600_000;
const PERIOD = { start: '2026-03-08T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z', sourceTimezone: 'UTC' };

function obligation(overrides = {}) {
  return {
    reporting_obligation_id: 'ob-1',
    account: { account_id: 'acct-1' },
    delivery_config_id: 'cfg-1',
    delivery_config_version: 1,
    report_definition_id: 'rd-1',
    period: PERIOD,
    expectedAt: '2026-03-09T01:00:00.000Z',
    recoveryDeadlineAt: '2026-03-09T05:00:00.000Z',
    schedule: {
      anchor: PERIOD.start,
      periodMilliseconds: 24 * HOUR,
      deliverySlaMilliseconds: HOUR,
      recoveryWindowMilliseconds: 4 * HOUR,
    },
    ...overrides,
  };
}

function statement(overrides = {}) {
  return {
    consumerId: 'consumer-a',
    account_id: 'acct-1',
    reporting_status_id: 'consumer-status.received.0001',
    delivery_config_id: 'cfg-1',
    delivery_config_version: 1,
    report_definition_id: 'rd-1',
    period: { start: PERIOD.start, end: PERIOD.end, source_timezone: 'UTC' },
    reporting_obligation_id: 'ob-1',
    reporting_revision_id: 'rev-1',
    observed_revision_content_sha256: 'a'.repeat(64),
    consumer_status: 'received',
    status_as_of: '2026-03-09T01:30:00.000Z',
    recorded_at: '2026-03-09T01:31:00.000Z',
    ...overrides,
  };
}

const revision = (id, number, createdAt, supersedes) => ({
  reporting_revision_id: id,
  revisionNumber: number,
  createdAt,
  ...(supersedes ? { supersedes_reporting_revision_id: supersedes } : {}),
});

// The buyer read rev-1; the seller then restated to rev-2 at 02:00. With a 1h
// delivery SLA the re-read grace deadline is 03:00.
const RESTATED = [
  revision('rev-1', 1, '2026-03-09T01:00:00.000Z'),
  revision('rev-2', 2, '2026-03-09T02:00:00.000Z', 'rev-1'),
];
const GRACE_DEADLINE = '2026-03-09T03:00:00.000Z';

describe('rc.3 consumer-status mismatch projection', () => {
  test('a received statement naming the current revision is not a conflict', () => {
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      [revision('rev-1', 1, '2026-03-09T01:00:00.000Z')],
      'healthy',
      '2026-03-09T04:00:00.000Z'
    );
    assert.equal(projection, undefined);
  });

  test('silence is not a conflict — an absent leaf produces no issue', () => {
    assert.equal(
      projectReportingConsumerStatusMismatchV1(obligation(), undefined, RESTATED, 'healthy', GRACE_DEADLINE),
      undefined
    );
  });

  test('an already-degraded seller projection is left to its own production issue', () => {
    // Consumer status degrades only an otherwise healthy/complete view; it never
    // stacks a second issue onto seller lateness.
    for (const sellerHealth of ['waiting', 'delayed', 'action_required']) {
      assert.equal(
        projectReportingConsumerStatusMismatchV1(
          obligation(),
          statement({ consumer_status: 'revision_missing', reporting_revision_id: undefined }),
          RESTATED,
          sellerHealth,
          '2026-03-09T04:00:00.000Z'
        ),
        undefined,
        sellerHealth
      );
    }
  });

  test('content_mismatch is a contract-fact disagreement and escalates immediately', () => {
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement({
        consumer_status: 'content_mismatch',
        mismatch_code: 'coverage_short',
        reporting_status_id: 'consumer-status.mismatch.0001',
      }),
      [revision('rev-1', 1, '2026-03-09T01:00:00.000Z')],
      'complete',
      '2026-03-09T01:31:00.000Z'
    );

    assert.equal(projection.health, 'action_required');
    assert.equal(projection.issue.severity, 'action_required');
    assert.equal(projection.issue.code, 'CONSUMER_STATUS_MISMATCH');
    assert.equal(projection.issue.recommendedAction, 'contact_seller');
    // No grace window: the buyer read the revision the seller still requires
    // and disagrees with its content, so there is nothing to re-read.
    assert.equal(projection.staleReceivedGraceDeadline, undefined);
    assert.equal(projection.issue.openedAt, '2026-03-09T01:31:00.000Z', 'anchored to when the seller recorded it');
  });

  test('every other negative status is immediately action_required', () => {
    for (const [consumer_status, extra, responsibleParty, action] of [
      [
        'obligation_missing',
        { reporting_obligation_id: undefined, reporting_revision_id: undefined },
        'seller',
        'contact_seller',
      ],
      ['revision_missing', { reporting_revision_id: undefined }, 'seller', 'contact_seller'],
      ['unreadable', { failure_code: 'integrity_mismatch' }, 'provider', 'repair_access'],
    ]) {
      const projection = projectReportingConsumerStatusMismatchV1(
        obligation(),
        statement({ consumer_status, observed_revision_content_sha256: undefined, ...extra }),
        RESTATED,
        'healthy',
        '2026-03-09T04:00:00.000Z'
      );
      assert.equal(projection.health, 'action_required', consumer_status);
      assert.equal(projection.issue.responsibleParty, responsibleParty, consumer_status);
      assert.equal(projection.issue.recommendedAction, action, consumer_status);
      assert.equal(projection.staleReceivedGraceDeadline, undefined, consumer_status);
    }
  });
});

describe('rc.3 stale-received grace window', () => {
  test('a received statement made stale by a restatement is delayed inside the window', () => {
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      RESTATED,
      'healthy',
      '2026-03-09T02:30:00.000Z'
    );

    assert.equal(projection.health, 'delayed');
    assert.equal(projection.issue.severity, 'delayed');
    // The buyer consumed exactly what the seller then required, so this is a
    // retry, not an escalation.
    assert.equal(projection.issue.recommendedAction, 'wait_for_retry');
    assert.equal(projection.staleReceivedGraceDeadline, GRACE_DEADLINE);
    assert.equal(projection.issue.openedAt, '2026-03-09T02:00:00.000Z', 'anchored to the first supersession');
  });

  test('the window is bounded — at the deadline the same issue escalates', () => {
    const inside = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      RESTATED,
      'healthy',
      '2026-03-09T02:59:59.999Z'
    );
    const atBoundary = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      RESTATED,
      'healthy',
      GRACE_DEADLINE
    );

    assert.equal(inside.health, 'delayed');
    assert.equal(atBoundary.health, 'action_required');
    assert.equal(atBoundary.issue.recommendedAction, 'contact_seller');
    // One work item across the transition, not two.
    assert.equal(atBoundary.issue.issueId, inside.issue.issueId);
    assert.equal(atBoundary.issue.openedAt, inside.issue.openedAt);
  });

  test('opened_at does not advance across re-emission', () => {
    const openedAt = new Set(
      ['2026-03-09T02:10:00.000Z', '2026-03-09T02:50:00.000Z', '2026-03-09T09:00:00.000Z'].map(
        ledgerAsOf =>
          projectReportingConsumerStatusMismatchV1(obligation(), statement(), RESTATED, 'healthy', ledgerAsOf).issue
            .openedAt
      )
    );
    assert.deepEqual([...openedAt], ['2026-03-09T02:00:00.000Z'], 'one instant across every poll');
  });

  test('later restatements do not restart the window', () => {
    // rev-3 supersedes rev-2, not the revision the buyer named, so the anchor
    // stays at rev-2's commit. Otherwise a seller could hold a genuinely
    // unresolved mismatch below action_required by restating on a timer.
    const withLaterRestatement = [...RESTATED, revision('rev-3', 3, '2026-03-09T02:55:00.000Z', 'rev-2')];
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      withLaterRestatement,
      'healthy',
      '2026-03-09T03:10:00.000Z'
    );

    assert.equal(projection.staleReceivedGraceDeadline, GRACE_DEADLINE);
    assert.equal(projection.health, 'action_required');
  });

  test('opened_at never predates the statement that caused the issue', () => {
    // The buyer posts `received` naming rev-1 two hours AFTER the seller already
    // superseded it. Anchoring opened_at to the supersession would date the
    // issue before the seller could have observed the disagreement — and with a
    // 30-minute escalation window it would be emitted already escalated on its
    // very first read.
    // Supersession 02:00, grace to 03:00, but the buyer only files at 02:50.
    // Read at 02:55 with a 30-minute escalation window: anchoring opened_at to
    // the supersession would make this five-minute-old issue already escalated.
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement({ recorded_at: '2026-03-09T02:50:00.000Z' }),
      RESTATED,
      'healthy',
      '2026-03-09T02:55:00.000Z',
      { escalationSeconds: 1_800, operationsContact: { email: 'ops@seller.example' } }
    );

    assert.equal(projection.issue.openedAt, '2026-03-09T02:50:00.000Z', 'the later of supersession and statement');
    assert.equal(projection.health, 'delayed');
    assert.equal(projection.issue.recommendedAction, 'wait_for_retry', 'a five-minute-old issue is not escalated');
    // The grace deadline stays anchored to the supersession, as the spec requires.
    assert.equal(projection.staleReceivedGraceDeadline, GRACE_DEADLINE);
  });

  test('sub-millisecond instants are compared exactly, not truncated', () => {
    // Date.parse would floor .0009Z to .000Z and end the window early.
    const precise = [
      revision('rev-1', 1, '2026-03-09T01:00:00.000Z'),
      revision('rev-2', 2, '2026-03-09T02:00:00.0009Z', 'rev-1'),
    ];
    const justInside = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      precise,
      'healthy',
      '2026-03-09T03:00:00.0005Z'
    );
    assert.equal(justInside.health, 'delayed', 'still inside the window by half a millisecond');
  });

  test('a zero delivery SLA falls back to the automated recovery window', () => {
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation({
        schedule: {
          anchor: PERIOD.start,
          periodMilliseconds: 24 * HOUR,
          deliverySlaMilliseconds: 0,
          recoveryWindowMilliseconds: 4 * HOUR,
        },
      }),
      statement(),
      RESTATED,
      'healthy',
      '2026-03-09T03:30:00.000Z'
    );

    // rev-2 committed 02:00 + 4h recovery window = 06:00, so a zero-SLA feed
    // still yields a bounded re-read window rather than no window at all.
    assert.equal(projection.staleReceivedGraceDeadline, '2026-03-09T06:00:00.000Z');
    assert.equal(projection.health, 'delayed');
  });

  test('no revision claiming supersession means no unearned grace', () => {
    // The buyer names a revision nothing supersedes, so the SDK cannot prove it
    // read what the seller then required. Fail closed.
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement({ reporting_revision_id: 'rev-unknown' }),
      [revision('rev-1', 1, '2026-03-09T01:00:00.000Z')],
      'healthy',
      '2026-03-09T01:35:00.000Z'
    );

    assert.equal(projection.health, 'action_required');
    assert.equal(projection.staleReceivedGraceDeadline, undefined);
  });
});

describe('rc.3 consumer-mismatch escalation', () => {
  const escalation = {
    escalationSeconds: 1_800,
    operationsContact: { email: 'reporting-ops@seller.example' },
  };

  test('the escalation boundary overrides an open grace window', () => {
    // opened_at is 02:00 and the window is 30 minutes, so 02:31 is past
    // escalation while still inside the 03:00 grace deadline.
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      RESTATED,
      'healthy',
      '2026-03-09T02:31:00.000Z',
      escalation
    );

    assert.equal(projection.health, 'action_required');
    assert.equal(projection.staleReceivedGraceDeadline, GRACE_DEADLINE, 'the window is still reported');
    assert.notEqual(projection.issue.recommendedAction, 'wait_for_retry', 'a retry hint must not survive escalation');
    assert.equal(projection.issue.recommendedAction, 'contact_seller');
  });

  test('before the boundary an advertised window changes nothing', () => {
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      RESTATED,
      'healthy',
      '2026-03-09T02:10:00.000Z',
      escalation
    );
    assert.equal(projection.health, 'delayed');
    assert.equal(projection.issue.recommendedAction, 'wait_for_retry');
  });

  test('escalation names the diagnosed party and retires repair_access', () => {
    const projection = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement({
        consumer_status: 'unreadable',
        failure_code: 'access_denied',
        observed_revision_content_sha256: undefined,
      }),
      RESTATED,
      'healthy',
      '2026-03-09T09:00:00.000Z',
      escalation
    );

    assert.equal(projection.issue.responsibleParty, 'provider');
    assert.equal(projection.issue.recommendedAction, 'contact_provider');
  });

  test('the escalation clock runs from opened_at, not from the poll', () => {
    // Same statement, two polls far apart. If the clock restarted per read the
    // second would still be un-escalated.
    const late = projectReportingConsumerStatusMismatchV1(
      obligation(),
      statement(),
      RESTATED,
      'healthy',
      '2026-03-10T00:00:00.000Z',
      escalation
    );
    assert.equal(late.issue.openedAt, '2026-03-09T02:00:00.000Z');
    assert.equal(late.issue.recommendedAction, 'contact_seller');
  });
});

describe('rc.3 reserved authoritative_party', () => {
  test('seller and absence are accepted', () => {
    assert.doesNotThrow(() => assertSupportedReportingAuthoritativeParty({}));
    assert.doesNotThrow(() => assertSupportedReportingAuthoritativeParty({ authoritative_party: 'seller' }));
    assert.doesNotThrow(() => assertSupportedReportingAuthoritativeParty({ authoritativeParty: 'seller' }));
  });

  test('consumer is refused with UNSUPPORTED_FEATURE rather than coerced', () => {
    for (const configuration of [
      { delivery_config_id: 'cfg-1', authoritative_party: 'consumer' },
      { delivery_config_id: 'cfg-1', authoritativeParty: 'consumer' },
    ]) {
      let error;
      try {
        assertSupportedReportingAuthoritativeParty(configuration);
      } catch (thrown) {
        error = thrown;
      }
      assert.ok(error instanceof UnsupportedReportingFeatureError, 'must be the typed refusal, not a generic Error');
      assert.equal(error.code, 'UNSUPPORTED_FEATURE');
      // Must be an AdcpError: createAdcpServer projects every other throw to
      // SERVICE_UNAVAILABLE, whose recovery is `transient` — which would tell
      // the buyer to retry the very request this refuses.
      assert.ok(error instanceof AdcpError, 'must reach the framework error mapper');
      assert.equal(error.recovery, 'terminal', 'retrying an unimplemented capability is never useful');
      assert.equal(error.details.requested_authoritative_party, 'consumer');
      assert.match(error.message, /7440/, 'points at the tracking issue');
    }
  });

  test('an explicit null is not treated as absence', () => {
    assert.throws(
      () => assertSupportedReportingAuthoritativeParty({ delivery_config_id: 'cfg-1', authoritative_party: null }),
      UnsupportedReportingFeatureError
    );
  });

  test('a wrong-shaped argument is refused instead of silently passing', () => {
    // Handing over the enclosing `reporting_delivery_configs[i]` or the whole
    // array are the realistic mistakes; a guard that no-ops on them is not a
    // guard.
    for (const wrong of [null, undefined, [], 'cfg-1', 42]) {
      assert.throws(() => assertSupportedReportingAuthoritativeParty(wrong), TypeError, JSON.stringify(wrong));
    }
  });

  test('buyer-supplied diagnostics are flattened and bounded', () => {
    let error;
    try {
      assertSupportedReportingAuthoritativeParty({
        delivery_config_id: `cfg\n injected-log-record ${'x'.repeat(200)}`,
        authoritative_party: `consumer\r\n${'y'.repeat(500)}`,
      });
    } catch (thrown) {
      error = thrown;
    }
    for (const value of [error.details.requested_authoritative_party, error.details.delivery_config_id]) {
      assert.ok(value.length <= 64, 'bounded');
      assert.doesNotMatch(value, /[\r\n\t]/, 'cannot forge a log record');
    }
  });
});

describe('rc.3 escalation option validation', () => {
  test('an unusable escalation window is refused at wiring time', () => {
    // NaN makes every comparison false so escalation silently never fires; a
    // negative window escalates everything on first read. Both look like a
    // working policy from outside.
    for (const escalationSeconds of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          assertReportingConsumerMismatchEscalation({ escalationSeconds, operationsContact: { email: 'o@e.example' } }),
        TypeError,
        String(escalationSeconds)
      );
    }
  });

  test('a window with nowhere to escalate to is refused', () => {
    assert.throws(
      () => assertReportingConsumerMismatchEscalation({ escalationSeconds: 3600, operationsContact: {} }),
      TypeError
    );
  });

  test('absence is allowed and a complete commitment passes through', () => {
    assert.equal(assertReportingConsumerMismatchEscalation(undefined), undefined);
    const valid = { escalationSeconds: 0, operationsContact: { url: 'https://ops.seller.example/reporting' } };
    assert.equal(assertReportingConsumerMismatchEscalation(valid), valid);
  });
});
