const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  ReportingMaintenancePartialFailureError,
  runReportingLedgerMaintenance,
} = require('../../dist/lib/reporting/service/maintenance.js');

const sweepResult = (overrides = {}) => ({
  swept: 0,
  objectsDeleted: 0,
  failed: 0,
  skippedUnconfigured: 0,
  deferred: 0,
  overdue: 0,
  ...overrides,
});
const retentionResult = (overrides = {}) => ({
  retired: 0,
  failed: [],
  failures: [],
  deferred: 0,
  stuck: [],
  ...overrides,
});

async function run({ sweep = sweepResult(), retention } = {}) {
  const reported = [];
  const results = await runReportingLedgerMaintenance({
    store: {
      sweepRowWriteIntents: async () => sweep,
      pruneChanges: async () => ({ deleted: 0 }),
      retireExpiredPeriods: async () => retention ?? retentionResult(),
    },
    statusRetentionDays: 30,
    retention: retention ? { enabled: true } : undefined,
    report: async error => {
      reported.push(error);
    },
  });
  return { results, reported };
}

describe('reporting maintenance warnings', () => {
  test('a quiet pass reports nothing', async () => {
    const { results, reported } = await run({ retention: retentionResult() });
    assert.deepEqual(reported, []);
    assert.ok(results.every(result => result.status === 'completed' && !result.partialFailure));
  });

  test('upload sweep backlog reaches the report callback even when nothing failed this pass', async () => {
    const { results, reported } = await run({
      sweep: sweepResult({ skippedUnconfigured: 2, deferred: 3, overdue: 1 }),
    });
    assert.equal(reported.length, 1);
    const [error] = reported;
    assert.ok(error instanceof ReportingMaintenancePartialFailureError);
    assert.equal(error.task, 'row upload sweep');
    assert.equal(error.failedCount, 0);
    assert.match(error.message, /2 expired upload\(s\) skipped because this host does not configure their row binding/);
    assert.match(error.message, /3 item\(s\) backing off/);
    assert.match(error.message, /1 upload\(s\) expired long ago and still unswept/);
    assert.equal(results[0].partialFailure, error);
    assert.equal(results[0].result.overdue, 1, 'the counts stay on the task result');
  });

  test('failed sweeps and their backlog are reported together', async () => {
    const { reported } = await run({ sweep: sweepResult({ failed: 2, deferred: 2 }) });
    assert.equal(reported.length, 1);
    assert.equal(reported[0].failedCount, 2);
    assert.match(reported[0].message, /could not process 2 item\(s\); 2 item\(s\) backing off/);
  });

  test('a persistently failing period is reported by ID and cause although it is in backoff', async () => {
    const { reported } = await run({
      retention: retentionResult({
        deferred: 1,
        stuck: [{ reporting_obligation_id: 'robl_stuck', attempts: 7, cause: 'STATE_UNAVAILABLE' }],
      }),
    });
    assert.equal(reported.length, 1);
    assert.equal(reported[0].task, 'retention');
    assert.equal(reported[0].failedCount, 0);
    assert.match(reported[0].message, /robl_stuck \(STATE_UNAVAILABLE, 7 attempts\)/);
  });

  test('a clean sweep result from a store without the new fields still works', async () => {
    const { reported } = await run({ sweep: { swept: 1, objectsDeleted: 1, failed: 0 } });
    assert.deepEqual(reported, []);
  });
});
