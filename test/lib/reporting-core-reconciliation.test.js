'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const YAML = require('yaml');

const { reconcileReportingCoreV1 } = require('../../dist/lib');

const EXPECTED_AT = '2026-08-01T02:00:00.000Z';
const RECOVERY_SECONDS = 2 * 60 * 60;

function obligation(overrides = {}) {
  return {
    reporting_obligation_id: 'obligation-core-1',
    account_id: 'reporting_core_lab',
    report_definition_id: 'report-core-1',
    reporting_profile: 'standard',
    media_buy_ids: ['media-buy-core-001', 'media-buy-core-002'],
    scope_resolved_at: '2026-08-01T01:00:00.000Z',
    coverage: { status: 'full' },
    period: {
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-08-01T01:00:00.000Z',
      source_timezone: 'UTC',
    },
    expected_at: EXPECTED_AT,
    required_finality: 'snapshot',
    ...overrides,
  };
}

function revision(overrides = {}) {
  return {
    reporting_revision_id: 'revision-core-1',
    account_id: 'reporting_core_lab',
    report_definition_id: 'report-core-1',
    reporting_profile: 'standard',
    media_buy_ids: ['media-buy-core-002', 'media-buy-core-001'],
    period: {
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-08-01T01:00:00.000Z',
      source_timezone: 'UTC',
    },
    finality: 'snapshot',
    row_count: 2,
    ...overrides,
  };
}

function reconcile({
  ledgerAsOf,
  obligations = [obligation()],
  revisions = [],
  closed = false,
  coverageComplete = true,
  recoverySeconds = RECOVERY_SECONDS,
} = {}) {
  return reconcileReportingCoreV1({
    obligations,
    revisions,
    scope: { closed, coverageComplete },
    clocks: {
      ledgerAsOf: ledgerAsOf ?? '2026-08-01T01:59:59.999Z',
      automatedRecoveryWindowSeconds: recoverySeconds,
    },
  });
}

function fixtureStep(storyboard, phaseId, stepId) {
  const phase = storyboard.phases.find(candidate => candidate.id === phaseId);
  assert.ok(phase, `missing fixture phase ${phaseId}`);
  const step = phase.steps.find(candidate => candidate.id === stepId);
  assert.ok(step, `missing fixture step ${stepId}`);
  return step;
}

function fixtureValue(step, fieldPath) {
  const validation = step.validations.find(
    candidate => candidate.check === 'field_value' && candidate.path === fieldPath
  );
  assert.ok(validation, `missing fixture validation ${fieldPath}`);
  return validation.value;
}

describe('Core-only buyer reporting reconciliation', () => {
  test('projects the complete five-state matrix at exact clock and scope boundaries', () => {
    const fixturePath = path.resolve(__dirname, '../../src/lib/compliance-fixtures/reporting-core.yaml');
    const storyboard = YAML.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(storyboard.id, 'reporting_core');
    assert.match(storyboard.narrative, /five\s+health states/);

    const delayedClock = fixtureValue(
      fixtureStep(storyboard, 'obligation_lifecycle', 'advance_beyond_sla'),
      'simulated.simulated_now'
    );
    const actionClock = fixtureValue(
      fixtureStep(storyboard, 'obligation_lifecycle', 'advance_beyond_recovery'),
      'simulated.simulated_now'
    );
    assert.equal(delayedClock, '2026-08-01T02:05:00.000Z');
    assert.equal(actionClock, '2026-08-01T04:05:00.000Z');

    assert.equal(reconcile().health, 'waiting');
    assert.equal(reconcile({ ledgerAsOf: EXPECTED_AT }).health, 'delayed', 'expected_at is due');
    assert.equal(reconcile({ ledgerAsOf: delayedClock }).health, 'delayed');
    assert.equal(reconcile({ ledgerAsOf: '2026-08-01T03:59:59.999Z' }).health, 'delayed');
    assert.equal(
      reconcile({ ledgerAsOf: '2026-08-01T04:00:00.000Z' }).health,
      'action_required',
      'the recovery deadline is an inclusive escalation boundary'
    );
    assert.equal(reconcile({ ledgerAsOf: actionClock }).health, 'action_required');
    assert.equal(reconcile({ revisions: [revision()] }).health, 'healthy');
    assert.equal(reconcile({ revisions: [revision()], closed: true }).health, 'complete');
  });

  test('treats an explicit zero-row revision as reporting, not a missing report', () => {
    const result = reconcile({
      ledgerAsOf: '2026-08-01T04:05:00.000Z',
      revisions: [revision({ row_count: 0 })],
      closed: true,
    });

    assert.equal(result.health, 'complete');
    assert.equal(result.obligations[0].health, 'complete');
    assert.equal(result.obligations[0].productionStatus, 'published');
    assert.equal(result.obligations[0].satisfied, true);
    assert.equal(result.obligations[0].revisionCount, 1);
    assert.equal(result.obligations[0].qualifyingRevisionCount, 1);
  });

  test('joins revisions only by the Core logical-slice identity and applies finality', () => {
    const expectedOfficial = obligation({ required_finality: 'official' });
    const unrelated = revision({
      reporting_revision_id: 'revision-other-period',
      period: {
        start: '2026-08-01T01:00:00.000Z',
        end: '2026-08-01T02:00:00.000Z',
        source_timezone: 'UTC',
      },
    });
    const snapshot = revision();
    const official = revision({ reporting_revision_id: 'revision-core-official', finality: 'official' });

    const snapshotOnly = reconcile({ obligations: [expectedOfficial], revisions: [snapshot, unrelated] });
    assert.equal(snapshotOnly.health, 'waiting');
    assert.deepEqual(snapshotOnly.obligations[0].reportingRevisionIds, ['revision-core-1']);
    assert.equal(snapshotOnly.obligations[0].qualifyingRevisionCount, 0);

    const satisfied = reconcile({ obligations: [expectedOfficial], revisions: [snapshot, official, unrelated] });
    assert.equal(satisfied.health, 'healthy');
    assert.equal(satisfied.obligations[0].qualifyingRevisionCount, 1);
  });

  test('normalizes equivalent RFC 3339 period boundaries before joining', () => {
    const equivalent = revision({
      period: {
        start: '2026-08-01T00:00:00Z',
        end: '2026-08-01T02:00:00+01:00',
        source_timezone: 'UTC',
      },
    });

    const result = reconcile({ revisions: [equivalent] });
    assert.equal(result.health, 'healthy');
    assert.equal(result.obligations[0].revisionCount, 1);
  });

  test('preserves submillisecond precision at due and recovery boundaries', () => {
    const precise = obligation({ expected_at: '2026-08-01T02:00:00.000500Z' });

    assert.equal(
      reconcile({ obligations: [precise], ledgerAsOf: '2026-08-01T02:00:00.000499Z', recoverySeconds: 1 }).health,
      'waiting'
    );
    assert.equal(
      reconcile({ obligations: [precise], ledgerAsOf: '2026-08-01T02:00:00.000500Z', recoverySeconds: 1 }).health,
      'delayed'
    );
    assert.equal(
      reconcile({ obligations: [precise], ledgerAsOf: '2026-08-01T02:00:01.000499Z', recoverySeconds: 1 }).health,
      'delayed'
    );
    assert.equal(
      reconcile({ obligations: [precise], ledgerAsOf: '2026-08-01T02:00:01.000500Z', recoverySeconds: 1 }).health,
      'action_required'
    );
  });

  test('makes incomplete obligation coverage and incomplete scope coverage action-required', () => {
    assert.equal(
      reconcile({ obligations: [obligation({ coverage: { status: 'partial' } })], revisions: [revision()] }).health,
      'action_required'
    );
    assert.equal(reconcile({ obligations: [], coverageComplete: false }).health, 'action_required');
  });

  test('never reads managed-delivery, inspection, or receipt fields and exposes no hooks for them', () => {
    const fail = name => () => {
      throw new Error(`Core reconciler read forbidden ${name}`);
    };
    const coreObligation = obligation();
    for (const name of [
      'destination_ref',
      'materialization_count',
      'receipt_count',
      'reconciliation_mode',
      'canonicalization',
    ]) {
      Object.defineProperty(coreObligation, name, { get: fail(name) });
    }
    const coreRevision = revision({ row_count: 0 });
    for (const name of ['canonical_content_digest', 'report_definition_uri', 'schema_uri', 'manifest']) {
      Object.defineProperty(coreRevision, name, { get: fail(name) });
    }
    const input = {
      obligations: [coreObligation],
      revisions: [coreRevision],
      scope: { closed: true, coverageComplete: true },
      clocks: {
        ledgerAsOf: '2026-08-01T04:05:00.000Z',
        automatedRecoveryWindowSeconds: RECOVERY_SECONDS,
      },
    };
    for (const name of ['materializations', 'receipts', 'resourceReader', 'syncReportingReceipts']) {
      Object.defineProperty(input, name, { get: fail(name) });
    }

    assert.equal(reconcileReportingCoreV1(input).health, 'complete');
  });

  test('rejects ambiguous identities and invalid recovery clocks', () => {
    assert.throws(() => reconcile({ obligations: [obligation(), obligation()] }), /duplicate reporting obligation id/);
    assert.throws(
      () =>
        reconcileReportingCoreV1({
          obligations: [obligation()],
          revisions: [],
          scope: { closed: false, coverageComplete: true },
          clocks: { ledgerAsOf: EXPECTED_AT, automatedRecoveryWindowSeconds: -1 },
        }),
      /non-negative safe integer/
    );
    assert.throws(
      () =>
        reconcile({
          revisions: [revision({ media_buy_ids: ['media-buy-core-001', 'media-buy-core-001'] })],
        }),
      /media_buy_ids must be unique/
    );
  });
});
