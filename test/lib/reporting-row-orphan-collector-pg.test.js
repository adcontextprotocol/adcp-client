/**
 * PostgreSQL integration tests for the orphaned row-object collector, using the filesystem provider.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-row-orphan-collector-pg.test.js
 */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const DAY = 24 * 3600 * 1000;

describe('orphaned row object collector', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_orphans_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let root;
  let store;
  let namespaceKey;
  let provider;
  const failingKeys = new Set();
  const listFailures = [];
  const rows = Array.from({ length: 4 }, (_, index) => ({ ordinal: index, value: index }));
  const base = { location: { root: 'rows' } };
  const later = () => new Date(Date.now() + 8 * DAY);

  const key = (name, prefix = 'orph') => `${prefix}/${namespaceKey}/${name}`;
  const onDisk = name => existsSync(path.join(root, name));
  async function putObject(objectRef, body = '{"a":1}\n') {
    const created = await provider.putIfAbsent(
      {
        ...base,
        objectRef,
        bytes: Buffer.from(body),
        contentType: 'application/x-ndjson',
        metadata: { 'adcp-installation': 'x', 'adcp-intent': 'y' },
      },
      { signal: AbortSignal.timeout(5_000) }
    );
    return created.nativeVersionRef;
  }
  const addIntent = (rowSetId, objectRef, nativeVersionRef, { binding = 'objects', state = 'open' } = {}) =>
    pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ($1, 'acct_orphans', $2, $3, $4, 'owner', $5::jsonb, clock_timestamp() + INTERVAL '1 hour')`,
      [
        binding,
        rowSetId,
        'e'.repeat(64),
        state,
        JSON.stringify(objectRef ? [{ object_ref: objectRef, native_version_ref: nativeVersionRef }] : []),
      ]
    );
  const collect = (overrides = {}) => store.collectOrphanedRowObjects({ now: later(), ...overrides });
  const binding = (result, id) => result.bindings.find(item => item.bindingId === id);

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-orphans-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    const filesystem = ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } });
    provider = new Proxy(filesystem, {
      get(target, property) {
        if (property === 'delete') {
          return async (location, context) => {
            if (failingKeys.has(location.objectRef)) throw new Error('provider unavailable');
            return target.delete(location, context);
          };
        }
        if (property === 'list') {
          return async (input, context) => {
            const failure = listFailures.shift();
            if (failure) throw failure;
            return target.list(input, context);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // The same filesystem provider without `list`, for a binding that cannot be collected.
    const noList = new Proxy(filesystem, {
      get(target, property) {
        if (property === 'list') return undefined;
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bindings = {
      objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' },
      legacy: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'legacy', readOnly: true },
      nolist: { kind: 'object', provider: 'nolist', location: { root: 'rows' }, prefix: 'nolist' },
    };
    const rowStorage = {
      bindings,
      providers: { filesystem: provider, nolist: noList },
      selectRowBinding: () => 'objects',
    };
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, rowStorage });
    await store.readyRowStorage();
    const engine = new ledger.ReportingRowStorageV1(pool, rowStorage);
    await engine.ready();
    namespaceKey = engine.installationIdentity.namespaceKey;
  });

  beforeEach(async () => {
    failingKeys.clear();
    listFailures.length = 0;
    await pool.query('DELETE FROM adcp_reporting_row_write_intents');
    rmSync(path.join(root, 'orph'), { recursive: true, force: true });
    rmSync(path.join(root, 'legacy'), { recursive: true, force: true });
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('deletes an orphan and keeps committed, intent-named and young objects', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'orphans_commit' });
    await store.commitRevision(fixture.revision('rrev_orphans_1', 1, rows), fixture.lease);
    const committed = (
      await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE obligation_id = $1`, [
        fixture.obligation.reporting_obligation_id,
      ])
    ).rows[0].object_ref;
    // An upload that succeeded and was never recorded anywhere.
    const orphan = key('acct/orphan.jsonl.gz');
    await putObject(orphan);
    // Named by an open upload that has not committed yet.
    const inFlight = key('acct/in-flight.jsonl.gz');
    await addIntent('rrev_in_flight', inFlight, await putObject(inFlight));
    // A bare key never recorded anywhere, but too young at the real clock.
    const young = key('acct/young.jsonl');
    await putObject(young);

    const dry = await collect({ dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(
      dry.candidates.map(candidate => [candidate.bindingId, candidate.objectRef]),
      [
        ['objects', orphan],
        ['objects', young],
      ].sort((a, b) => (a[1] < b[1] ? -1 : 1))
    );
    assert.equal(dry.wouldDelete, 2);
    assert.equal(dry.deleted, 0);
    assert.ok([orphan, committed, inFlight, young].every(onDisk), 'a dry run deletes nothing');

    // At the real clock nothing is old enough.
    const early = await store.collectOrphanedRowObjects();
    assert.equal(early.deleted, 0);
    assert.equal(binding(early, 'objects').tooYoung, 4);
    assert.ok([orphan, committed, inFlight, young].every(onDisk));

    const result = await collect();
    const objects = binding(result, 'objects');
    assert.equal(objects.status, 'complete');
    assert.equal(objects.listed, 4);
    assert.equal(objects.referenced, 2, 'the committed chunk and the open intent');
    assert.equal(objects.deleted, 2);
    assert.equal(onDisk(orphan), false);
    assert.equal(onDisk(young), false, 'old enough under the pass clock and named by nothing');
    assert.ok(onDisk(committed));
    assert.ok(onDisk(inFlight));
    assert.deepEqual(result.cursors, {});
    // The committed revision still reads.
    assert.equal((await store.getRevision('rrev_orphans_1', fixture.request.account.account_id)).rows.length, 4);
  });

  test('never touches keys outside {prefix}/{namespace_key}/ or objects that are not row objects', async () => {
    const outside = [
      `orph/other-namespace/a.jsonl.gz`,
      `orph/${namespaceKey}-sibling/a.jsonl.gz`,
      `orph.jsonl.gz`,
      `elsewhere/${namespaceKey}/a.jsonl.gz`,
    ];
    for (const name of outside) await putObject(name);
    const notRowObject = [key('notes.txt'), key('acct/a.jsonl.tmp'), key('acct/a.json')];
    for (const name of notRowObject) await putObject(name);
    const orphan = key('acct/real-orphan.jsonl');
    await putObject(orphan);

    const result = await collect();
    assert.equal(binding(result, 'objects').deleted, 1);
    assert.equal(onDisk(orphan), false);
    for (const name of [...outside, ...notRowObject]) assert.ok(onDisk(name), `${name} is untouched`);
    assert.equal(binding(result, 'objects').foreign, 2, 'the .txt and .json under the prefix are counted, not touched');
  });

  test('skips readOnly bindings unless asked, and reports a binding whose provider cannot list', async () => {
    const legacy = key('acct/legacy-orphan.jsonl', 'legacy');
    await putObject(legacy);
    const first = await collect();
    assert.deepEqual(first.skippedReadOnly, ['legacy']);
    assert.deepEqual(first.unsupported, ['nolist']);
    assert.equal(binding(first, 'legacy').status, 'read_only');
    assert.equal(binding(first, 'nolist').status, 'unsupported');
    assert.ok(onDisk(legacy));

    const included = await collect({ includeReadOnly: true });
    assert.deepEqual(included.skippedReadOnly, []);
    assert.equal(binding(included, 'legacy').deleted, 1);
    assert.equal(onDisk(legacy), false);
  });

  test('pages with a per-pass budget and resumes from the returned cursors until the listing ends', async () => {
    const names = Array.from({ length: 5 }, (_, index) => key(`acct/${index}.jsonl.gz`));
    for (const name of names) await putObject(name);
    const first = await collect({ limit: 2, pageSize: 1, bindings: ['objects'] });
    assert.equal(binding(first, 'objects').status, 'partial');
    assert.equal(binding(first, 'objects').listed, 2);
    assert.ok(first.cursors.objects);
    let cursors = first.cursors;
    let passes = 1;
    while (Object.keys(cursors).length > 0) {
      const next = await collect({ limit: 2, pageSize: 2, cursors, bindings: ['objects'] });
      cursors = next.cursors;
      passes += 1;
      assert.ok(passes < 10);
    }
    assert.equal(passes, 3);
    assert.ok(
      names.every(name => !onDisk(name)),
      'every object was visited exactly once across the passes'
    );
  });

  test('a delete that fails is counted and does not stop the rest; a listing failure keeps its cursor', async () => {
    const stuck = key('acct/a-stuck.jsonl');
    const fine = key('acct/b-fine.jsonl');
    await putObject(stuck);
    await putObject(fine);
    failingKeys.add(stuck);
    const result = await collect();
    assert.equal(binding(result, 'objects').failed, 1);
    assert.equal(binding(result, 'objects').deleted, 1);
    assert.equal(result.failed, 1);
    assert.ok(onDisk(stuck));
    assert.equal(onDisk(fine), false);

    failingKeys.clear();
    listFailures.push(Object.assign(new Error('provider down'), { name: 'Error' }));
    const failed = await collect({ cursors: { objects: 'orph/some-token' }, bindings: ['objects'] });
    assert.equal(binding(failed, 'objects').status, 'failed');
    assert.equal(binding(failed, 'objects').error, 'PROVIDER_UNAVAILABLE');
    assert.deepEqual(failed.cursors, { objects: 'orph/some-token' }, 'the same page is retried next pass');
    assert.equal(onDisk(stuck), true);
    assert.equal((await collect()).deleted, 1, 'and the stuck object goes once the provider recovers');
  });

  test('a record that names the key at another version, or a row set not yet pruned, keeps the object', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'orphans_versions' });
    await store.commitRevision(fixture.revision('rrev_orphans_v', 1, rows), fixture.lease);
    const chunk = (
      await pool.query(
        `SELECT object_ref, native_version_ref FROM adcp_reporting_row_chunks WHERE obligation_id = $1`,
        [fixture.obligation.reporting_obligation_id]
      )
    ).rows[0];
    // The recorded version no longer matches the object on disk, as after a copy that changed its mtime.
    await pool.query(
      `UPDATE adcp_reporting_row_chunks SET native_version_ref = 'some-other-version' WHERE object_ref = $1`,
      [chunk.object_ref]
    );
    // An intent in `sweeping` still names its object: that sweep owns it.
    const swept = key('acct/swept.jsonl');
    await addIntent('rrev_sweeping_owner', swept, await putObject(swept), { state: 'sweeping' });
    try {
      const result = await collect();
      assert.equal(binding(result, 'objects').deleted, 0);
      assert.equal(binding(result, 'objects').referenced, 2);
      assert.ok(onDisk(chunk.object_ref));
      assert.ok(onDisk(swept));
    } finally {
      await pool.query(`UPDATE adcp_reporting_row_chunks SET native_version_ref = $2 WHERE object_ref = $1`, [
        chunk.object_ref,
        chunk.native_version_ref,
      ]);
    }
  });

  test('takes the per-object lock and rechecks under it: an intent committed while it waits keeps the object', async () => {
    const orphan = key('acct/locked.jsonl.gz');
    const version = await putObject(orphan);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `adcp-reporting-object:objects:${orphan}`,
      ]);
      let settled = false;
      const pending = collect({ bindings: ['objects'] }).finally(() => {
        settled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(settled, false, 'the delete waits for the object lock');
      // A writer adopts the object: its intent commits, then the lock is released.
      await holder.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
         VALUES ('objects', 'acct_orphans', 'rrev_adopting', $1, 'open', 'owner', $2::jsonb, clock_timestamp() + INTERVAL '1 hour')`,
        ['f'.repeat(64), JSON.stringify([{ object_ref: orphan, native_version_ref: version }])]
      );
      await holder.query('COMMIT');
      const result = await pending;
      assert.equal(binding(result, 'objects').deleted, 0);
      assert.equal(binding(result, 'objects').referenced, 1);
      assert.ok(onDisk(orphan));
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  test('validates its inputs and stops on abort', async () => {
    await assert.rejects(() => store.collectOrphanedRowObjects({ minAgeSeconds: 3600 }), RangeError);
    await assert.rejects(() => store.collectOrphanedRowObjects({ minAgeSeconds: 1.5 }), RangeError);
    await assert.rejects(() => store.collectOrphanedRowObjects({ bindings: ['missing'] }), RangeError);
    await assert.rejects(() => store.collectOrphanedRowObjects({ limit: 0 }), RangeError);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      () => collect({ signal: abort.signal }),
      error => error.name === 'AbortError'
    );
    // The default age is 7 days: a day-old object is safe at the real clock.
    const recent = key('acct/recent.jsonl');
    await putObject(recent);
    assert.equal((await store.collectOrphanedRowObjects({ now: new Date(Date.now() + 2 * DAY) })).deleted, 0);
    assert.ok(onDisk(recent));
    assert.equal(
      (await store.collectOrphanedRowObjects({ now: new Date(Date.now() + 2 * DAY), minAgeSeconds: 86400 })).deleted,
      1
    );
  });

  test('is wired into maintenance: opt-in, resumable through the shared cursors, and its backlog is reported', async () => {
    const {
      runReportingLedgerMaintenance,
      assertReportingLedgerMaintenanceOptions,
    } = require('../../dist/lib/reporting/service/maintenance.js');
    assert.throws(
      () => assertReportingLedgerMaintenanceOptions({ orphanCollection: { enabled: false } }, 30),
      TypeError
    );
    assert.throws(
      () => assertReportingLedgerMaintenanceOptions({ orphanCollection: { enabled: true, minAgeSeconds: 60 } }, 30),
      RangeError
    );
    assert.throws(
      () => assertReportingLedgerMaintenanceOptions({ orphanCollection: { enabled: true, limit: 0 } }, 30),
      TypeError
    );
    assertReportingLedgerMaintenanceOptions({ orphanCollection: { enabled: true, dryRun: true, limit: 5 } }, 30);

    const names = Array.from({ length: 3 }, (_, index) => key(`acct/m${index}.jsonl`));
    for (const name of names) await putObject(name);
    const reported = [];
    const orphanCursors = {};
    const run = orphanCollection =>
      runReportingLedgerMaintenance({
        store,
        statusRetentionDays: 30,
        orphanCollection,
        orphanCursors,
        report: async error => {
          reported.push(error);
        },
      });
    const off = await run(undefined);
    assert.equal(
      off.some(result => result.task === 'orphan object collection'),
      false,
      'off unless enabled'
    );

    // The store's clock cannot be moved through maintenance, so a pass at the real clock deletes nothing.
    const first = await run({ enabled: true, limit: 2 });
    const task = first.find(result => result.task === 'orphan object collection');
    assert.equal(task.status, 'completed');
    assert.equal(task.result.deleted, 0);
    assert.deepEqual(task.result.unsupported, ['nolist']);
    assert.ok(Object.keys(orphanCursors).includes('objects'), 'the cursor holder carries the listing position');
    assert.ok(task.partialFailure, 'an unsupported binding is surfaced as a warning');
    assert.match(task.partialFailure.message, /nolist/);
    assert.ok(reported.some(error => /orphan object collection/.test(error.message)));
    assert.ok(names.every(onDisk));
  });
});
