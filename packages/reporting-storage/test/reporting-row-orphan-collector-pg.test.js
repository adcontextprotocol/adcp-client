/**
 * PostgreSQL integration tests for the orphaned row-object collector, using the filesystem provider.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test npm test --workspace=@adcp/reporting-storage -- test/reporting-row-orphan-collector-pg.test.js
 */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, describe, test } = require('node:test');

const { createRowStorageFixture } = require('./helpers/reporting-row-storage-fixture.js');

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
  const deleteCalls = [];
  // Test hooks on the provider: replace a listing page, or make every object look older.
  let listOverride = null;
  let ageShiftMs = 0;
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
  const collect = (overrides = {}) =>
    store.collectOrphanedRowObjects({ now: later(), acknowledgeExclusiveNamespace: true, ...overrides });
  const binding = (result, id) => result.bindings.find(item => item.bindingId === id);

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
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
            deleteCalls.push(`${location.objectRef}@${location.nativeVersionRef}`);
            return target.delete(location, context);
          };
        }
        if (property === 'list') {
          return async (input, context) => {
            const failure = listFailures.shift();
            if (failure) throw failure;
            const real = async page => {
              const listed = await target.list(page, context);
              return ageShiftMs
                ? {
                    ...listed,
                    objects: listed.objects.map(object => ({
                      ...object,
                      createdAt: new Date(Date.parse(object.createdAt) - ageShiftMs).toISOString(),
                    })),
                  }
                : listed;
            };
            return listOverride ? listOverride(input, real) : real(input);
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
      // Shares `objects`' root and prefix, as a renamed or successor binding does.
      twin: {
        kind: 'object',
        provider: 'filesystem',
        location: { root: 'rows' },
        prefix: 'orph',
        keyTemplate: '{prefix}/{namespace_key}/twin/{revision_key}/{content_sha256}/{chunk_index}',
        readOnly: true,
      },
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
    deleteCalls.length = 0;
    listOverride = null;
    ageShiftMs = 0;
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

    const dry = await collect({ dryRun: true, bindings: ['objects'] });
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
    const early = await store.collectOrphanedRowObjects({ acknowledgeExclusiveNamespace: true });
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
    assert.deepEqual(first.skippedReadOnly, ['legacy', 'twin']);
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

  test('reports the bindings whose listing finished, and does not list the ones it is told to skip', async () => {
    await putObject(key('acct/skip.jsonl'));
    await putObject(key('acct/skip2.jsonl'));
    const first = await collect({ dryRun: true, includeReadOnly: true, bindings: ['objects', 'twin'] });
    assert.deepEqual([...first.completed].sort(), ['objects', 'twin']);
    const partial = await collect({ dryRun: true, bindings: ['objects'], limit: 1, pageSize: 1 });
    assert.deepEqual(partial.completed, [], 'a listing that stopped at its budget is not finished');
    const skipped = await collect({
      dryRun: true,
      includeReadOnly: true,
      bindings: ['objects', 'twin'],
      skipBindings: ['objects'],
    });
    assert.deepEqual(
      skipped.bindings.map(item => item.bindingId),
      ['twin']
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
    assert.deepEqual(failed.cursors, {}, 'a resumed listing that fails on its first page restarts next pass');
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

  async function untilBlocked(holderClient, run) {
    const { rows } = await holderClient.query('SELECT pg_backend_pid() AS pid');
    const pending = run();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const blocked = await bootstrapPool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [rows[0].pid]
      );
      // Wrapped: returning the promise itself would make the caller wait for it.
      if (blocked.rows[0].n > 0) return { pending };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('the collector never blocked on the object lock');
  }
  const lockKey = objectRef => `adcp-reporting-object:objects:${objectRef}`;

  test('takes the per-object lock and rechecks under it: an intent committed while it waits keeps the object', async () => {
    const orphan = key('acct/locked.jsonl.gz');
    const version = await putObject(orphan);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey(orphan)]);
      // The collector has passed its unlocked pre-check and is parked on the lock.
      const { pending } = await untilBlocked(holder, () => collect({ bindings: ['objects'] }));
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

  test('a commit that adopts the object while the collector waits on the lock keeps it', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'orphans_adopt' });
    await store.commitRevision(fixture.revision('rrev_orphans_adopt', 1, rows), fixture.lease);
    const chunk = (
      await pool.query(`SELECT object_ref, row_set_id FROM adcp_reporting_row_chunks WHERE obligation_id = $1`, [
        fixture.obligation.reporting_obligation_id,
      ])
    ).rows[0];
    // The row set is `pruned`, so nothing names the object and the pre-check passes it.
    await pool.query(`UPDATE adcp_reporting_row_sets SET rows_state = 'pruned' WHERE row_set_id = $1`, [
      chunk.row_set_id,
    ]);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey(chunk.object_ref)]);
      const { pending } = await untilBlocked(holder, () => collect({ bindings: ['objects'] }));
      // The adopting commit makes the row set live again under the lock, then releases it.
      await holder.query(`UPDATE adcp_reporting_row_sets SET rows_state = 'live' WHERE row_set_id = $1`, [
        chunk.row_set_id,
      ]);
      await holder.query('COMMIT');
      const result = await pending;
      assert.equal(binding(result, 'objects').deleted, 0);
      assert.ok(onDisk(chunk.object_ref));
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  test('serializes with an adoption through another binding that shares the prefix', async () => {
    const orphan = key('acct/shared-lock.jsonl.gz');
    const version = await putObject(orphan);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // A writer on `twin` adopts the object: it holds the lock of its own binding.
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `adcp-reporting-object:twin:${orphan}`,
      ]);
      const { pending } = await untilBlocked(holder, () => collect({ bindings: ['objects'] }));
      await holder.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
         VALUES ('twin', 'acct_orphans', 'rrev_twin_adopting', $1, 'open', 'owner', $2::jsonb, clock_timestamp() + INTERVAL '1 hour')`,
        ['d'.repeat(64), JSON.stringify([{ object_ref: orphan, native_version_ref: version }])]
      );
      await holder.query('COMMIT');
      const result = await pending;
      assert.equal(binding(result, 'objects').deleted, 0);
      assert.ok(onDisk(orphan));
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  test('a record under another binding that shares the bucket and prefix keeps the object', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'orphans_twin' });
    await store.commitRevision(fixture.revision('rrev_orphans_twin', 1, rows), fixture.lease);
    const chunk = (
      await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE obligation_id = $1`, [
        fixture.obligation.reporting_obligation_id,
      ])
    ).rows[0].object_ref;
    // `twin` shares `objects`' root and prefix (a renamed or successor binding): its collector lists the
    // same objects, whose records live under the other binding.
    const result = await collect({ bindings: ['twin'], includeReadOnly: true });
    assert.equal(binding(result, 'twin').listed >= 1, true);
    assert.equal(binding(result, 'twin').deleted, 0);
    assert.ok(onDisk(chunk));
    // An intent under the other binding protects an object the same way.
    const inFlight = key('acct/twin-in-flight.jsonl');
    await addIntent('rrev_twin_in_flight', inFlight, await putObject(inFlight), { binding: 'objects' });
    assert.equal(binding(await collect({ bindings: ['twin'], includeReadOnly: true }), 'twin').deleted, 0);
    assert.ok(onDisk(inFlight));
  });

  test('a row set that is pruning or unavailable keeps its object; a pruned one does not', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'orphans_states' });
    await store.commitRevision(fixture.revision('rrev_orphans_states', 1, rows), fixture.lease);
    const chunk = (
      await pool.query(`SELECT object_ref, row_set_id FROM adcp_reporting_row_chunks WHERE obligation_id = $1`, [
        fixture.obligation.reporting_obligation_id,
      ])
    ).rows[0];
    try {
      for (const [state, expected] of [
        ['pruning', 0],
        ['unavailable', 0],
        ['pruned', 1],
      ]) {
        await pool.query(`UPDATE adcp_reporting_row_sets SET rows_state = $2 WHERE row_set_id = $1`, [
          chunk.row_set_id,
          state,
        ]);
        const dry = await collect({ dryRun: true, bindings: ['objects'] });
        assert.equal(dry.wouldDelete, expected, state);
      }
    } finally {
      await pool.query(`UPDATE adcp_reporting_row_sets SET rows_state = 'live' WHERE row_set_id = $1`, [
        chunk.row_set_id,
      ]);
    }
  });

  test('an intent written by an older SDK (objectKey, nativeVersion) keeps its object', async () => {
    const legacyKey = key('acct/older-sdk.jsonl');
    const version = await putObject(legacyKey);
    await pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ('objects', 'acct_orphans', 'rrev_older_sdk', $1, 'sweeping', 'owner', $2::jsonb, clock_timestamp() + INTERVAL '1 hour')`,
      ['a'.repeat(64), JSON.stringify([{ objectKey: legacyKey, nativeVersion: version }])]
    );
    const result = await collect({ bindings: ['objects'] });
    assert.equal(binding(result, 'objects').referenced, 1);
    assert.ok(onDisk(legacyKey));
  });

  test('a hostile provider cannot make it delete outside the owned prefix or act on malformed entries', async () => {
    const good = key('acct/good.jsonl');
    const goodVersion = await putObject(good);
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    const entry = (objectRef, extra = {}) => ({
      objectRef,
      nativeVersionRef: 'v1',
      sizeBytes: 1,
      createdAt: old,
      ...extra,
    });
    const outside = [
      'orph/other-namespace/x.jsonl',
      `orph/${namespaceKey}-sibling/x.jsonl`,
      `elsewhere/${namespaceKey}/x.jsonl`,
    ];
    for (const name of outside) await putObject(name);
    listOverride = async () => ({
      objects: [
        ...outside.map(name => entry(name)),
        entry(key('negative.jsonl'), { sizeBytes: -1 }),
        entry(key('no-version.jsonl'), { nativeVersionRef: '' }),
        entry(key('bad-date.jsonl'), { createdAt: 12345 }),
        entry(key('epoch-date.jsonl'), { createdAt: '0' }),
        entry(key('dot-segment/../escape.jsonl')),
        entry(key(`${'x'.repeat(1100)}.jsonl`)),
        null,
        'a string',
        entry(good, { nativeVersionRef: goodVersion }),
      ],
      skipped: 2,
    });
    const result = await collect({ bindings: ['objects'] });
    assert.deepEqual(
      deleteCalls,
      [`${good}@${goodVersion}`],
      'only the one legitimate entry is deleted, at its version'
    );
    assert.equal(binding(result, 'objects').foreign, 13, 'eleven dropped here and two the provider left out');
    for (const name of outside) assert.ok(onDisk(name));
  });

  test('a provider that returns the same token twice, or too many objects, fails the binding without looping', async () => {
    await putObject(key('acct/loop.jsonl'));
    let calls = 0;
    listOverride = async () => {
      calls += 1;
      return { objects: [], nextPageToken: 'same' };
    };
    const repeated = await collect({ bindings: ['objects'], limit: 5, pageSize: 1 });
    assert.equal(binding(repeated, 'objects').status, 'failed');
    assert.equal(binding(repeated, 'objects').error, 'PROVIDER_UNAVAILABLE');
    assert.ok(calls <= 3, `stopped after ${calls} requests`);
    assert.deepEqual(repeated.cursors, {}, 'a token that repeats is not resumed from');

    // Empty pages with fresh tokens are bounded by the page cap, not by the object budget.
    let page = 0;
    listOverride = async () => ({ objects: [], nextPageToken: `t${(page += 1)}` });
    const empty = await collect({ bindings: ['objects'], limit: 5, pageSize: 5 });
    assert.equal(binding(empty, 'objects').status, 'partial');
    assert.ok(page <= 4 && empty.cursors.objects, 'the pass stopped and kept its place');

    listOverride = async input => ({
      objects: Array.from({ length: input.pageSize + 1 }, (_, index) => ({
        objectRef: key(`over${index}.jsonl`),
        nativeVersionRef: 'v',
        sizeBytes: 1,
        createdAt: new Date().toISOString(),
      })),
    });
    const over = await collect({ bindings: ['objects'], limit: 3, pageSize: 2 });
    assert.equal(binding(over, 'objects').status, 'failed');
    assert.equal(over.deleted, 0);
  });

  test('a failure on the first page of a resumed listing drops the cursor; one mid-pass keeps it', async () => {
    for (const index of [1, 2, 3]) await putObject(key(`acct/c${index}.jsonl`));
    listFailures.push(new Error('expired token'));
    const stale = await collect({ cursors: { objects: 'orph/stale-token' }, bindings: ['objects'] });
    assert.equal(binding(stale, 'objects').status, 'failed');
    assert.deepEqual(stale.cursors, {}, 'the next pass restarts from the beginning instead of wedging');

    // A transient failure on a later page keeps the position reached this pass.
    let served = 0;
    listOverride = async (input, target) => {
      served += 1;
      if (served === 2) throw new Error('transient');
      return target(input);
    };
    const mid = await collect({ bindings: ['objects'], pageSize: 1 });
    assert.equal(binding(mid, 'objects').status, 'failed');
    assert.ok(mid.cursors.objects, 'resumes from the page that failed');
  });

  test('validates its inputs, requires the namespace acknowledgement to delete, and stops on abort', async () => {
    const ack = { acknowledgeExclusiveNamespace: true };
    await assert.rejects(() => store.collectOrphanedRowObjects({ ...ack, minAgeSeconds: 3600 }), RangeError);
    await assert.rejects(() => store.collectOrphanedRowObjects({ ...ack, minAgeSeconds: 1.5 }), RangeError);
    await assert.rejects(() => store.collectOrphanedRowObjects({ ...ack, bindings: ['missing'] }), RangeError);
    await assert.rejects(() => store.collectOrphanedRowObjects({ ...ack, limit: 0 }), RangeError);
    for (const now of [new Date(Number.NaN), '2030-01-01', 5]) {
      await assert.rejects(() => store.collectOrphanedRowObjects({ ...ack, now }), RangeError, String(now));
    }
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      () => collect({ signal: abort.signal }),
      error => error.name === 'AbortError'
    );
    const recent = key('acct/recent.jsonl');
    await putObject(recent);
    // Deleting needs the acknowledgement; a dry run does not.
    await assert.rejects(() => store.collectOrphanedRowObjects({ now: later() }), /acknowledgeExclusiveNamespace/);
    assert.equal((await store.collectOrphanedRowObjects({ now: later(), dryRun: true })).wouldDelete, 1);
    assert.ok(onDisk(recent));
    // The default age is 7 days: a two-day-old object is safe at the default.
    assert.equal((await store.collectOrphanedRowObjects({ ...ack, now: new Date(Date.now() + 2 * DAY) })).deleted, 0);
    assert.ok(onDisk(recent));
    assert.equal(
      (await store.collectOrphanedRowObjects({ ...ack, now: new Date(Date.now() + 2 * DAY), minAgeSeconds: 86400 }))
        .deleted,
      1
    );
  });

  describe('maintenance', () => {
    const maintenance = require('../dist/maintenance.js');
    // The namespace key is known only once the store is ready, so build the names when a test runs.
    const nameList = () => ['m0', 'm1', 'm2'].map(name => key(`acct/${name}.jsonl`));
    const optionsOf = overrides => ({ enabled: true, acknowledgeExclusiveNamespace: true, ...overrides });
    const task = results => results.find(result => result.task === 'orphan object collection');

    test('option validation: deletion needs the acknowledgement, and ages, limits and intervals are bounded', () => {
      const check = options => maintenance.assertReportingLedgerMaintenanceOptions({ orphanCollection: options }, 30);
      assert.throws(() => check({ enabled: false }), TypeError);
      assert.throws(() => check({ enabled: true }), /acknowledgeExclusiveNamespace/);
      assert.throws(() => check(optionsOf({ minAgeSeconds: 60 })), RangeError);
      assert.throws(() => check(optionsOf({ limit: 0 })), TypeError);
      assert.throws(() => check(optionsOf({ intervalSeconds: 0 })), TypeError);
      assert.throws(() => check(optionsOf({ includeReadOnly: 'yes' })), TypeError);
      check({ enabled: true, dryRun: true });
      check(optionsOf({ intervalSeconds: 3600, limit: 5, minAgeSeconds: 86400 }));
    });

    test('a pass deletes through the store, resumes through the shared state, and rests for the interval', async () => {
      const names = nameList();
      for (const name of names) await putObject(name);
      const orphanState = { cursors: {} };
      const reported = [];
      const run = (orphanCollection, extra = {}) =>
        maintenance.runReportingLedgerMaintenance({
          store,
          statusRetentionDays: 30,
          orphanCollection,
          orphanState,
          report: async error => {
            reported.push(error);
          },
          ...extra,
        });
      assert.equal(task(await run(undefined)), undefined, 'off unless enabled');

      // Objects look old only through the provider's clock.
      ageShiftMs = 8 * DAY;
      const first = task(await run(optionsOf({ limit: 2, intervalSeconds: 3600 })));
      assert.equal(first.status, 'completed');
      assert.equal(first.result.deleted, 2);
      assert.ok(orphanState.cursors.objects, 'the listing is not finished, so the state carries its position');
      assert.equal(orphanState.nextCycleAt, undefined);
      assert.deepEqual(first.result.unsupported, ['nolist']);
      assert.match(first.partialFailure.message, /nolist/);
      assert.ok(reported.some(error => /orphan object collection/.test(error.message)));

      const second = task(await run(optionsOf({ limit: 2, intervalSeconds: 3600 })));
      assert.equal(second.result.deleted, 1);
      assert.deepEqual(orphanState.cursors, {}, 'the finished listing clears its cursors');
      assert.ok(orphanState.nextCycleAt > Date.now(), 'and rests until the interval has passed');
      assert.ok(names.every(name => !onDisk(name)));

      // During the rest nothing is listed at all.
      listFailures.push(new Error('must not be called'));
      const resting = task(await run(optionsOf({ intervalSeconds: 3600 })));
      assert.equal(resting.result.listed, 0);
      assert.equal(listFailures.length, 1, 'no listing request was made');
      listFailures.length = 0;
      orphanState.nextCycleAt = Date.now() - 1;
      assert.equal(task(await run(optionsOf({ intervalSeconds: 3600 }))).result.bindings.length > 0, true);
    });

    test('dry run reports and deletes nothing, and a failed binding names its cause in the warning', async () => {
      const names = nameList();
      for (const name of names) await putObject(name);
      ageShiftMs = 8 * DAY;
      const dry = task(
        await maintenance.runReportingLedgerMaintenance({
          store,
          statusRetentionDays: 30,
          orphanCollection: { enabled: true, dryRun: true },
        })
      );
      assert.equal(dry.result.wouldDelete, 3);
      assert.equal(dry.result.deleted, 0);
      assert.ok(names.every(onDisk));

      listFailures.push(new Error('provider down'));
      const failed = task(
        await maintenance.runReportingLedgerMaintenance({
          store,
          statusRetentionDays: 30,
          orphanCollection: optionsOf(),
        })
      );
      assert.match(failed.partialFailure.message, /row binding objects \(PROVIDER_UNAVAILABLE\)/);
    });
  });
});
