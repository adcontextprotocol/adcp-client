/**
 * `reportingLedgerMaintenance` is the factory behind `createReliableReportingService({ maintenance })`. These
 * cases pin what it refuses at construction and what its pass runs, against a fake store that has only the
 * maintenance methods, so they need no database. (The SDK pins the contract the service enforces around any
 * factory in the SDK (`test/lib/reliable-reporting-service.test.js`); the PostgreSQL behavior of each task is pinned in
 * `reliable-reporting-core-maintenance-pg.test.js` and `reporting-snapshot-compaction-pg.test.js`.)
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { reportingLedgerMaintenance } = require('@adcp/reporting-storage');

const STATUS_RETENTION_DAYS = 90;
const RECOVERY_SECONDS = 86_400;

/** The three methods every maintenance pass drives, on an object that is not a PostgreSQL store. */
const fakeStore = (overrides = {}) => ({
  retireExpiredPeriods: async () => ({ retired: 0, failed: [], failures: [] }),
  pruneChanges: async () => ({ deleted: 0 }),
  sweepRowWriteIntents: async () => ({ swept: 0, objectsDeleted: 0, failed: 0 }),
  ...overrides,
});

const build = (options, store = fakeStore()) =>
  reportingLedgerMaintenance(options)({
    store,
    statusRetentionDays: STATUS_RETENTION_DAYS,
    automatedRecoveryWindowSeconds: RECOVERY_SECONDS,
  });

describe('reportingLedgerMaintenance construction', () => {
  test('takes an options object and returns a factory, not a pass', () => {
    assert.equal(typeof reportingLedgerMaintenance(), 'function');
    assert.equal(typeof reportingLedgerMaintenance({}), 'function');
    assert.throws(() => reportingLedgerMaintenance(null), /maintenance must be an options object/);
    assert.throws(() => reportingLedgerMaintenance('retention'), /maintenance must be an options object/);
  });

  test('fails fast when the store cannot run ledger maintenance, naming the missing method', () => {
    assert.throws(
      () => build({ retention: { enabled: true } }, {}),
      /maintenance requires a PostgresReportingLedgerStore .*retireExpiredPeriods/
    );
    assert.throws(
      () => build({}, { retireExpiredPeriods: async () => ({}), pruneChanges: async () => ({}) }),
      /sweepRowWriteIntents/
    );
    assert.throws(() => build({ compaction: { enabled: true } }), /compactSupersededSnapshots/);
    assert.throws(() => build({ orphanCollection: { enabled: true, dryRun: true } }), /collectOrphanedRowObjects/);
  });

  test('fails fast on a change feed the store does not maintain, and on options the store would refuse', () => {
    const store = fakeStore();
    assert.doesNotThrow(() => build({ retention: { enabled: true }, changeFeed: true }, store));
    store.changeFeedEnabled = false;
    assert.throws(() => build({ changeFeed: true }, store), /changeFeed: true/);
    assert.doesNotThrow(() => build({ retention: { enabled: true } }, store), 'retention does not need the feed');
    store.changeFeedEnabled = true;
    assert.throws(() => build({ intervalMilliseconds: 0 }, store), /intervalMilliseconds/);
    assert.throws(() => build({ intervalMilliseconds: 1.5 }, store), /intervalMilliseconds/);
    assert.throws(() => build({ retention: { enabled: false } }, store), /enabled: true/);
    assert.throws(() => build({ retention: { enabled: true, limit: 0 } }, store), /limit/);
    assert.throws(
      () => build({ retention: { enabled: true, recordRetentionDays: 1 } }, store),
      /no shorter than statusRetentionDays/
    );
    assert.throws(() => build({ changeFeed: { maxFeedHoldDays: 0 } }, store), /maxFeedHoldDays/);
    assert.throws(() => build({ changeFeed: { changeRetentionDays: 1.5 } }, store), /changeRetentionDays/);
  });

  test('retention is checked against the retention the service advertises, not one passed here', () => {
    const factory = reportingLedgerMaintenance({ retention: { enabled: true, recordRetentionDays: 120 } });
    const context = statusRetentionDays => ({
      store: fakeStore(),
      statusRetentionDays,
      automatedRecoveryWindowSeconds: RECOVERY_SECONDS,
    });
    assert.doesNotThrow(() => factory(context(90)));
    assert.throws(() => factory(context(365)), /no shorter than statusRetentionDays/);
  });

  test('compaction asks the store to prove its row bindings are safe, at construction', () => {
    let checked = 0;
    const store = fakeStore({
      compactSupersededSnapshots: async () => ({ compacted: 0 }),
      assertCompactionSafeRowBindings: () => {
        checked += 1;
      },
    });
    build({}, store);
    assert.equal(checked, 0, 'no compaction, no check');
    build({ compaction: { enabled: true } }, store);
    assert.equal(checked, 1);
    assert.throws(
      () =>
        build(
          { compaction: { enabled: true } },
          {
            ...store,
            assertCompactionSafeRowBindings: () => {
              throw new TypeError('key template lacks {revision_key}');
            },
          }
        ),
      /key template lacks \{revision_key\}/
    );
    assert.throws(() => build({ compaction: { enabled: true, limit: 0 } }, store), /limit/);
  });

  test('defaults to a five minute interval and honours a configured one', () => {
    assert.equal(build({}).intervalMilliseconds, 300_000);
    assert.equal(build({ intervalMilliseconds: 60_000 }).intervalMilliseconds, 60_000);
  });
});

describe('reportingLedgerMaintenance passes', () => {
  test('without the pool the snapshot sweep is omitted; the row upload sweep always runs', async () => {
    const results = await build({}).run({});
    assert.deepEqual(
      results.map(result => result.task),
      ['row upload sweep']
    );
  });

  test('with a store that can reach the pool the snapshot sweep runs first', async () => {
    const swept = [];
    const store = fakeStore({
      sweepExpiredState: async limit => {
        swept.push(limit);
        return { snapshotsDeleted: 0, checkpointsDeleted: 0 };
      },
    });
    const results = await build({ retention: { enabled: true } }, store).run({});
    assert.deepEqual(
      results.map(result => result.task),
      ['snapshot sweep', 'row upload sweep', 'retention']
    );
    assert.deepEqual(swept, [1_000]);
  });

  test('orphanCollection needs the acknowledgement to delete, bounds its options, and resumes between passes', async () => {
    const ack = { enabled: true, acknowledgeExclusiveNamespace: true };
    const calls = [];
    const store = fakeStore({
      collectOrphanedRowObjects: async options => {
        calls.push(options);
        return {
          dryRun: options.dryRun === true,
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
          cursors: { objects: 'next-page' },
          completed: [],
          bindings: [],
        };
      },
    });
    assert.throws(() => build({ orphanCollection: { enabled: true } }, store), /acknowledgeExclusiveNamespace/);
    assert.throws(() => build({ orphanCollection: { ...ack, minAgeSeconds: 60 } }, store), /at least 1 day/);
    assert.throws(() => build({ orphanCollection: { ...ack, limit: 0 } }, store), /limit/);
    assert.throws(() => build({ orphanCollection: { ...ack, intervalSeconds: 0 } }, store), /intervalSeconds/);
    assert.throws(() => build({ orphanCollection: { ...ack, dryRun: 'yes' } }, store), /dryRun must be a boolean/);

    const maintenance = build({ orphanCollection: { ...ack, limit: 50, includeReadOnly: true } }, store);
    const first = await maintenance.run({});
    assert.ok(first.some(result => result.task === 'orphan object collection' && result.status === 'completed'));
    assert.deepEqual(calls[0], {
      acknowledgeExclusiveNamespace: true,
      limit: 50,
      includeReadOnly: true,
      cursors: {},
      skipBindings: [],
    });
    // The next pass resumes from the position this maintenance kept; another service starts from the beginning.
    await maintenance.run({});
    assert.deepEqual(calls[1].cursors, { objects: 'next-page' });
    await build({ orphanCollection: { ...ack } }, store).run({});
    assert.deepEqual(calls[2].cursors, {});

    const dry = build({ orphanCollection: { enabled: true, dryRun: true } }, store);
    await dry.run({});
    assert.equal(calls.at(-1).dryRun, true);
  });

  test('retention and compaction use the retention and recovery window the service advertises', async () => {
    const seen = {};
    const store = fakeStore({
      retireExpiredPeriods: async options => {
        seen.retention = options;
        return { retired: 0, failed: [], failures: [] };
      },
      compactSupersededSnapshots: async options => {
        seen.compaction = options;
        return { compacted: 0 };
      },
    });
    await build(
      { retention: { enabled: true, limit: 7 }, compaction: { enabled: true }, changeFeed: { maxFeedHoldDays: 9 } },
      store
    ).run({});
    assert.equal(seen.retention.statusRetentionDays, STATUS_RETENTION_DAYS);
    assert.equal(seen.retention.limit, 7);
    assert.equal(seen.retention.maxFeedHoldDays, 9);
    assert.equal(seen.compaction.statusRetentionDays, STATUS_RETENTION_DAYS);
    assert.equal(seen.compaction.automatedRecoveryWindowSeconds, RECOVERY_SECONDS);
    assert.equal(seen.compaction.maxFeedHoldDays, 9);
  });

  test('a task failure is reported in its result and to `report`, and the pass still finishes', async () => {
    const reported = [];
    const store = fakeStore({
      pruneChanges: async () => {
        throw new Error('prune exploded');
      },
    });
    const results = await build({ changeFeed: true }, store).run({
      report: async error => {
        reported.push(error);
      },
    });
    const prune = results.find(result => result.task === 'change-feed pruning');
    assert.equal(prune.status, 'failed');
    assert.match(String(prune.error), /prune exploded/);
    assert.ok(results.some(result => result.task === 'row upload sweep' && result.status === 'completed'));
    assert.equal(reported.length, 1);
  });

  test('an aborted pass does not report the failure it caused', async () => {
    const controller = new AbortController();
    const reported = [];
    const store = fakeStore({
      sweepRowWriteIntents: async () => {
        controller.abort();
        throw new Error('stopped');
      },
    });
    const results = await build({}, store).run({
      signal: controller.signal,
      report: async error => {
        reported.push(error);
      },
    });
    assert.equal(results[0].status, 'failed');
    assert.deepEqual(reported, [], 'an abort is shutdown, not a fault');
  });
});
