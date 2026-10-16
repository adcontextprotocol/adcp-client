const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { ReportingMaintenancePartialFailureError, runReportingLedgerMaintenance } = require('../dist/maintenance.js');

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

describe('orphan object collection task', () => {
  const orphanResult = (overrides = {}) => ({
    dryRun: false,
    listed: 0,
    referenced: 0,
    tooYoung: 0,
    foreign: 0,
    deleted: 0,
    wouldDelete: 0,
    failed: 0,
    unsupported: [],
    skippedReadOnly: [],
    candidates: [],
    cursors: {},
    completed: [],
    bindings: [],
    ...overrides,
  });
  const runWith = async (collect, input = {}) => {
    const reported = [];
    const results = await runReportingLedgerMaintenance({
      store: {
        sweepRowWriteIntents: async () => sweepResult(),
        pruneChanges: async () => ({ deleted: 0 }),
        retireExpiredPeriods: async () => retentionResult(),
        ...(collect ? { collectOrphanedRowObjects: collect } : {}),
      },
      statusRetentionDays: 30,
      report: async error => {
        reported.push(error);
      },
      ...input,
    });
    return { results, reported, task: results.find(result => result.task === 'orphan object collection') };
  };

  test('forwards its options exactly, replaces the saved state, and rests after a clean finished listing', async () => {
    const seen = [];
    const orphanState = { cursors: { stale: 'old' } };
    const collect = async options => {
      seen.push(options);
      return orphanResult({ cursors: seen.length === 1 ? { objects: 'p2' } : {} });
    };
    const orphanCollection = {
      enabled: true,
      acknowledgeExclusiveNamespace: true,
      limit: 7,
      minAgeSeconds: 86400,
      includeReadOnly: true,
      intervalSeconds: 600,
    };
    const first = await runWith(collect, { orphanCollection, orphanState });
    assert.equal(first.task.status, 'completed');
    assert.deepEqual(seen[0], {
      acknowledgeExclusiveNamespace: true,
      limit: 7,
      minAgeSeconds: 86400,
      includeReadOnly: true,
      cursors: { stale: 'old' },
      skipBindings: [],
    });
    assert.deepEqual(orphanState.cursors, { objects: 'p2' }, 'replaced, not merged');
    assert.equal(orphanState.nextCycleAt, undefined, 'an unfinished listing carries on');

    await runWith(collect, { orphanCollection, orphanState });
    assert.deepEqual(seen[1].cursors, { objects: 'p2' });
    assert.deepEqual(orphanState.cursors, {});
    assert.ok(orphanState.nextCycleAt > Date.now(), 'a finished listing rests for the interval');
    await runWith(collect, { orphanCollection, orphanState });
    assert.equal(seen.length, 2, 'no store call while resting');
  });

  test('a binding that finished is not listed again while another needs more passes, and the cycle then rests', async () => {
    const seen = [];
    const answers = [
      orphanResult({ cursors: { slow: 't1' }, completed: ['fast'] }),
      orphanResult({ cursors: { slow: 't2' }, completed: [] }),
      orphanResult({ cursors: {}, completed: ['slow'] }),
    ];
    const collect = async options => {
      seen.push(options);
      return answers.shift();
    };
    const orphanState = { cursors: {} };
    const orphanCollection = { enabled: true, acknowledgeExclusiveNamespace: true, intervalSeconds: 600 };
    for (let pass = 0; pass < 3; pass += 1) await runWith(collect, { orphanCollection, orphanState });
    assert.deepEqual(
      seen.map(options => [options.skipBindings, options.cursors]),
      [
        [[], {}],
        [['fast'], { slow: 't1' }],
        [['fast'], { slow: 't2' }],
      ],
      'the finished binding is skipped for the rest of the cycle'
    );
    assert.deepEqual(orphanState.completed, [], 'a finished cycle starts the next one from scratch');
    assert.ok(orphanState.nextCycleAt > Date.now());
  });

  test('a failed binding keeps the task retrying every pass and names its cause; a rejected collector is a failed task', async () => {
    const orphanState = { cursors: {} };
    const failing = async () =>
      orphanResult({
        failed: 1,
        bindings: [{ bindingId: 'objects', status: 'failed', error: 'PROVIDER_UNAVAILABLE', failed: 1 }],
      });
    const orphanCollection = { enabled: true, dryRun: true };
    const { task, reported } = await runWith(failing, { orphanCollection, orphanState });
    assert.equal(orphanState.nextCycleAt, undefined, 'a listing with a failure is not finished');
    assert.match(task.partialFailure.message, /row binding objects \(PROVIDER_UNAVAILABLE\)/);
    assert.equal(reported.length, 1);

    const rejected = await runWith(
      async () => {
        throw new Error('database down');
      },
      { orphanCollection }
    );
    assert.equal(rejected.task.status, 'failed');
    assert.equal(rejected.reported.length, 1);

    const missing = await runWith(undefined, { orphanCollection });
    assert.equal(missing.task.status, 'failed');
    assert.match(String(missing.task.error), /collectOrphanedRowObjects/);
  });
});

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
