/**
 * PostgreSQL integration tests for the orphan collector's ownership fence (adcp-client#3292): a clone or
 * restore of the ledger database that shares the live one's bucket, configuration, installation identity and
 * namespace key must not delete the live database's newer objects.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test npm test --workspace=@adcp/reporting-storage -- test/reporting-orphan-collector-fence-pg.test.js
 */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const DAY = 24 * 3600 * 1000;

describe('orphan collector ownership fence', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const live = `adcp_fence_live_${process.pid}`;
  const clone = `adcp_fence_clone_${process.pid}`;
  const bare = `adcp_fence_bare_${process.pid}`;
  const schemas = [live, clone, bare];
  const later = () => new Date(Date.now() + 8 * DAY);
  let ledger;
  let bootstrapPool;
  let root;
  let provider;
  let namespaceKey;
  let liveStore;
  let livePool;
  let clonePool;
  let cloneStore;
  let barePool;
  let bareStore;
  const pools = [];
  const base = { location: { root: 'rows' } };
  const providerCalls = { delete: [], put: [] };

  const key = name => `orph/${namespaceKey}/${name}`;
  const fenceDirectory = () => path.join(root, 'orph', namespaceKey, '_collector-fence');
  const fenceFiles = () => (existsSync(fenceDirectory()) ? readdirSync(fenceDirectory()).sort() : []);
  const fenceName = epoch => `${String(epoch).padStart(16, '0')}.json`;
  const onDisk = name => existsSync(path.join(root, name));
  const context = () => ({ signal: AbortSignal.timeout(5_000) });
  async function putObject(objectRef, body = '{"a":1}\n') {
    const created = await provider.putIfAbsent(
      {
        ...base,
        objectRef,
        bytes: Buffer.from(body),
        contentType: 'application/x-ndjson',
        metadata: { 'adcp-installation': 'x', 'adcp-intent': 'y' },
      },
      context()
    );
    return created.nativeVersionRef;
  }
  const collect = (target, overrides = {}) =>
    target.collectOrphanedRowObjects({ now: later(), acknowledgeExclusiveNamespace: true, ...overrides });
  const objectsBinding = result => result.bindings.find(item => item.bindingId === 'objects');
  const fenceRow = async pool =>
    (await pool.query('SELECT epoch::int AS epoch, token, previous_token FROM adcp_reporting_orphan_collector_fences'))
      .rows[0];
  const addIntent = (pool, rowSetId, objectRef, nativeVersionRef) =>
    pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ('objects', 'acct_fence', $1, $2, 'open', 'owner', $3::jsonb, clock_timestamp() + INTERVAL '1 hour')`,
      [rowSetId, 'e'.repeat(64), JSON.stringify([{ object_ref: objectRef, native_version_ref: nativeVersionRef }])]
    );
  const fenceRecord = epoch => JSON.parse(readFileSync(path.join(fenceDirectory(), fenceName(epoch)), 'utf8'));

  async function newPool(schema) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    pools.push(pool);
    return pool;
  }

  function newStore(pool) {
    const rowStorage = {
      bindings: {
        objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' },
        // Shares `objects`' bucket and prefix, as a renamed or successor binding does.
        twin: {
          kind: 'object',
          provider: 'filesystem',
          location: { root: 'rows' },
          prefix: 'orph',
          keyTemplate: '{prefix}/{namespace_key}/twin/{revision_key}/{content_sha256}/{chunk_index}',
          readOnly: true,
        },
      },
      providers: { filesystem: provider },
      selectRowBinding: () => 'objects',
    };
    return new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, rowStorage });
  }

  /** A point-in-time copy of every table in `from`: what a staging clone or a restore carries. */
  async function copySchema(from, to) {
    await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${to}" CASCADE`);
    await bootstrapPool.query(`CREATE SCHEMA "${to}"`);
    const tables = (
      await bootstrapPool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [from]
      )
    ).rows.map(row => row.table_name);
    for (const table of tables) {
      await bootstrapPool.query(
        `CREATE TABLE "${to}"."${table}" (LIKE "${from}"."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`
      );
      await bootstrapPool.query(`INSERT INTO "${to}"."${table}" SELECT * FROM "${from}"."${table}"`);
    }
  }

  async function freshClone() {
    if (clonePool) {
      await clonePool.end();
      pools.splice(pools.indexOf(clonePool), 1);
      clonePool = undefined;
    }
    await copySchema(live, clone);
    clonePool = await newPool(clone);
    cloneStore = newStore(clonePool);
    await cloneStore.readyRowStorage();
    return cloneStore;
  }

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-fence-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    for (const schema of schemas) await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await bootstrapPool.query(`CREATE SCHEMA "${live}"`);
    await bootstrapPool.query(`CREATE SCHEMA "${bare}"`);
    livePool = await newPool(live);
    await livePool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await livePool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    await livePool.query(ledger.REPORTING_ORPHAN_FENCE_MIGRATION);
    // A database that has not applied the fence migration.
    barePool = await newPool(bare);
    await barePool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await barePool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    const filesystem = ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } });
    provider = new Proxy(filesystem, {
      get(target, property) {
        if (property === 'delete') {
          return async (input, ctx) => {
            providerCalls.delete.push(input.objectRef);
            return target.delete(input, ctx);
          };
        }
        if (property === 'putIfAbsent') {
          return async (input, ctx) => {
            providerCalls.put.push(input.objectRef);
            return target.putIfAbsent(input, ctx);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    liveStore = newStore(livePool);
    await liveStore.readyRowStorage();
    const engine = new ledger.ReportingRowStorageV1(livePool, {
      bindings: { objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' } },
      providers: { filesystem: provider },
    });
    await engine.ready();
    namespaceKey = engine.installationIdentity.namespaceKey;
    bareStore = newStore(barePool);
    await bareStore.readyRowStorage();
  });

  beforeEach(async () => {
    providerCalls.delete.length = 0;
    providerCalls.put.length = 0;
    await livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences');
    await livePool.query('DELETE FROM adcp_reporting_row_write_intents');
    rmSync(path.join(root, 'orph'), { recursive: true, force: true });
    if (clonePool) {
      await clonePool.end();
      pools.splice(pools.indexOf(clonePool), 1);
      clonePool = undefined;
    }
  });

  after(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined);
    if (bootstrapPool) {
      for (const schema of schemas) await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('the first real pass claims epoch 1, each later pass claims the next epoch and prunes the old ones', async () => {
    const orphan = key('acct/a.jsonl');
    await putObject(orphan);
    const first = await collect(liveStore);
    assert.equal(objectsBinding(first).status, 'complete');
    assert.equal(objectsBinding(first).deleted, 1);
    assert.deepEqual(first.fenced, []);
    assert.deepEqual(fenceFiles(), [fenceName(1)]);
    assert.deepEqual(await fenceRow(livePool), { epoch: 1, token: fenceRecord(1).token, previous_token: null });
    assert.equal(fenceRecord(1).namespace_key, namespaceKey);
    assert.equal(onDisk(orphan), false);

    await collect(liveStore);
    assert.deepEqual(fenceFiles(), [fenceName(1), fenceName(2)]);
    assert.equal(fenceRecord(2).previous_token, fenceRecord(1).token);
    assert.notEqual(fenceRecord(2).token, fenceRecord(1).token, 'every claim carries a fresh token');
    await collect(liveStore);
    await collect(liveStore);
    assert.deepEqual(fenceFiles(), [fenceName(3), fenceName(4)], 'older claims are superseded and pruned');
    assert.deepEqual((await fenceRow(livePool)).epoch, 4);
  });

  test('the fence chain is not a row object: it is neither listed, counted as foreign nor deleted', async () => {
    await putObject(key('acct/a.jsonl'));
    await collect(liveStore);
    const second = await collect(liveStore, { dryRun: true });
    assert.equal(objectsBinding(second).foreign, 0);
    assert.equal(objectsBinding(second).listed, 0);
    assert.ok(fenceFiles().length >= 1);
  });

  test('a dry run checks the fence without claiming it, and reports what a real pass would delete', async () => {
    const orphan = key('acct/dry.jsonl');
    await putObject(orphan);
    providerCalls.put.length = 0;
    const dry = await collect(liveStore, { dryRun: true });
    assert.equal(objectsBinding(dry).wouldDelete, 1);
    assert.deepEqual(dry.fenced, []);
    assert.deepEqual(fenceFiles(), [], 'a dry run writes no fence object');
    assert.equal(await fenceRow(livePool), undefined, 'and records no claim');
    assert.deepEqual(providerCalls.put, [], 'and writes nothing at all');
  });

  test('a clone taken before the original last collected is fenced and deletes nothing', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore); // epoch 1: the state a clone is taken from
    await freshClone();
    // The live database goes on writing after the clone was taken. The clone's tables know nothing of it.
    const newer = key('acct/written-after-the-clone.jsonl');
    await addIntent(livePool, 'rrev_after_the_clone', newer, await putObject(newer));
    await collect(liveStore); // epoch 2: the live database out-claims every copy of epoch 1
    assert.ok(onDisk(newer), 'the live database references it');

    const refused = await collect(cloneStore);
    assert.deepEqual(refused.fenced, ['objects']);
    const outcome = objectsBinding(refused);
    assert.equal(outcome.status, 'fenced');
    assert.equal(outcome.fence.cause, 'fence_advanced');
    assert.equal(outcome.fence.fenceEpoch, 2);
    assert.equal(outcome.fence.recordedEpoch, 1);
    assert.match(outcome.fence.detail, /takeOverOrphanCollectorFence/);
    assert.equal(refused.deleted, 0);
    assert.equal(refused.listed, 0, 'a fenced binding is not even listed');
    assert.ok(onDisk(newer), "the live database's newer object survives its clone");
    assert.equal((await fenceRow(clonePool)).epoch, 1, 'the clone recorded nothing');

    const dry = await collect(cloneStore, { dryRun: true });
    assert.deepEqual(dry.fenced, ['objects'], 'a dry run reports the fenced binding too');
    assert.equal(dry.wouldDelete, 0);
    assert.deepEqual(dry.candidates, []);

    // The live database is unaffected and still collects its own orphans.
    const own = key('acct/live-orphan.jsonl');
    await putObject(own);
    const result = await collect(liveStore);
    assert.deepEqual(result.fenced, []);
    assert.equal(onDisk(own), false);
    assert.ok(onDisk(newer));

    // Control: this is what the fence prevents. A clone that has taken the namespace over deletes the object
    // its own tables know nothing about.
    await cloneStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
    await collect(cloneStore);
    assert.equal(onDisk(newer), false);
  });

  test('a clone that collects first claims the namespace and fences the original: first claim wins', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await freshClone();
    const claimed = await collect(cloneStore);
    assert.deepEqual(claimed.fenced, [], 'nothing distinguishes the copy from the original until one claims');
    assert.equal((await fenceRow(clonePool)).epoch, 2);
    const original = await collect(liveStore);
    assert.deepEqual(original.fenced, ['objects']);
    assert.equal(objectsBinding(original).fence.cause, 'fence_advanced');
    assert.match(objectsBinding(original).fence.detail, /another database that shares this namespace has collected/);
  });

  test('a restore to an older database state is fenced until an operator takes over', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore); // epoch 1
    const snapshot = (await livePool.query('SELECT * FROM adcp_reporting_orphan_collector_fences')).rows;
    await collect(liveStore); // epoch 2
    await collect(liveStore); // epoch 3
    // Point-in-time restore: the database goes back to its state at epoch 1; the bucket is at epoch 3.
    await livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences');
    for (const row of snapshot) {
      await livePool.query(
        'INSERT INTO adcp_reporting_orphan_collector_fences (fence_scope, epoch, token, previous_token, claimed_at) VALUES ($1, $2, $3, $4, $5)',
        [row.fence_scope, row.epoch, row.token, row.previous_token, row.claimed_at]
      );
    }
    const newer = key('acct/lost-with-the-restore.jsonl');
    await putObject(newer);
    const refused = await collect(liveStore);
    assert.equal(objectsBinding(refused).fence.cause, 'fence_advanced');
    assert.ok(onDisk(newer));

    await assert.rejects(() => liveStore.takeOverOrphanCollectorFence({}), TypeError);
    await assert.rejects(
      () => liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: false }),
      TypeError
    );
    assert.ok(onDisk(newer), 'a refused takeover changes nothing');

    const tokenBeforeTakeover = fenceRecord(3).token;
    const taken = await liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
    assert.deepEqual(taken, [{ bindingIds: ['objects'], epoch: 4, previousEpoch: 3 }]);
    assert.equal(fenceRecord(4).previous_token, tokenBeforeTakeover);
    assert.deepEqual(fenceFiles(), [fenceName(4)], 'a takeover supersedes every older fence object');
    const resumed = await collect(liveStore);
    assert.deepEqual(resumed.fenced, []);
    assert.equal(objectsBinding(resumed).status, 'complete');
    assert.equal(onDisk(newer), false, 'after a takeover the restored database collects again');
  });

  test('a takeover fences out the previous owner', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await freshClone();
    const taken = await cloneStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
    assert.equal(taken[0].epoch, 2);
    const original = await collect(liveStore);
    assert.equal(objectsBinding(original).fence.cause, 'fence_advanced');
    assert.deepEqual((await collect(cloneStore)).fenced, []);
  });

  test('takeOver validates its bindings and covers a binding that shares a fence once', async () => {
    await assert.rejects(
      () => liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true, bindings: ['missing'] }),
      RangeError
    );
    const taken = await liveStore.takeOverOrphanCollectorFence({
      acknowledgePreviousOwnerGone: true,
      includeReadOnly: true,
    });
    assert.deepEqual(taken, [{ bindingIds: ['objects', 'twin'], epoch: 1, previousEpoch: null }]);
    assert.deepEqual(fenceFiles(), [fenceName(1)]);
  });

  test('bindings that share a bucket and prefix share one fence and one claim per pass', async () => {
    await putObject(key('acct/a.jsonl'));
    const result = await collect(liveStore, { includeReadOnly: true });
    assert.deepEqual(result.fenced, []);
    assert.deepEqual(
      result.bindings.map(item => item.status),
      ['complete', 'complete']
    );
    assert.deepEqual(fenceFiles(), [fenceName(1)]);
    assert.equal((await fenceRow(livePool)).epoch, 1);
  });

  test('a database with no recorded claim refuses a namespace that already has one', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences');
    const refused = await collect(liveStore);
    assert.equal(objectsBinding(refused).fence.cause, 'claimed_elsewhere');
    assert.equal(objectsBinding(refused).fence.recordedEpoch, undefined);
  });

  test('a recorded claim with no fence in the bucket is refused as missing, never silently re-claimed', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await collect(liveStore);
    rmSync(fenceDirectory(), { recursive: true, force: true });
    const survivor = key('acct/survivor.jsonl');
    await putObject(survivor);
    const refused = await collect(liveStore);
    assert.equal(objectsBinding(refused).fence.cause, 'fence_missing');
    assert.ok(onDisk(survivor));
  });

  test('a database newer than its bucket is refused as regressed', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await collect(liveStore);
    // The database comes back from a newer backup than the bucket: it records epoch 5, the bucket holds 2.
    await livePool.query(`UPDATE adcp_reporting_orphan_collector_fences SET epoch = 5, previous_token = $1`, [
      '55555555-5555-4555-8555-555555555555',
    ]);
    const refused = await collect(liveStore);
    assert.equal(objectsBinding(refused).fence.cause, 'fence_regressed');
    assert.equal(objectsBinding(refused).fence.fenceEpoch, 2);
    assert.equal(objectsBinding(refused).fence.recordedEpoch, 5);
  });

  test('two claims of one epoch: the loser is fenced as a token mismatch, and a lost race as claim_lost', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore); // epoch 1, recorded
    // Another database wrote epoch 1 under a different token (the bucket was replaced).
    const file = path.join(fenceDirectory(), fenceName(1));
    const record = fenceRecord(1);
    writeFileSync(file, `${JSON.stringify({ ...record, token: '11111111-1111-4111-8111-111111111111' })}\n`);
    const mismatch = await collect(liveStore);
    assert.equal(objectsBinding(mismatch).fence.cause, 'token_mismatch');

    // A claim of the next epoch that another database wrote between the check and the write.
    await livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences');
    rmSync(fenceDirectory(), { recursive: true, force: true });
    await collect(liveStore); // epoch 1 again, recorded
    const intruder = {
      ...fenceRecord(1),
      epoch: 2,
      token: '22222222-2222-4222-8222-222222222222',
      previous_token: fenceRecord(1).token,
    };
    const racing = new Proxy(provider, {
      get(target, property) {
        if (property === 'putIfAbsent') {
          return async (input, ctx) => {
            // The intruder's epoch 2 lands first.
            writeFileSync(path.join(fenceDirectory(), fenceName(2)), `${JSON.stringify(intruder)}\n`);
            return target.putIfAbsent(input, ctx);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const racingStore = new ledger.PostgresReportingLedgerStore(livePool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' } },
        providers: { filesystem: racing },
        selectRowBinding: () => 'objects',
      },
    });
    await racingStore.readyRowStorage();
    const lost = await collect(racingStore);
    assert.equal(objectsBinding(lost).fence.cause, 'claim_lost');
    assert.equal(lost.deleted, 0);
    // The next pass sees the other database's epoch.
    assert.equal(objectsBinding(await collect(liveStore)).fence.cause, 'token_mismatch');
  });

  test('malformed, foreign-namespace or oversized fence objects fail closed', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    const file = path.join(fenceDirectory(), fenceName(1));
    const survivor = key('acct/survivor.jsonl');
    await putObject(survivor);
    for (const content of [
      'not json',
      JSON.stringify({ ...fenceRecord(1), namespace_key: 'f'.repeat(64) }),
      JSON.stringify({ ...fenceRecord(1), extra: true }),
      JSON.stringify({ ...fenceRecord(1), epoch: 9 }),
      JSON.stringify({ ...fenceRecord(1), token: 'nope' }),
      `${JSON.stringify(fenceRecord(1))}${' '.repeat(5000)}`,
    ]) {
      writeFileSync(file, content);
      const refused = await collect(liveStore);
      assert.equal(objectsBinding(refused).fence.cause, 'fence_unreadable', content.slice(0, 40));
      assert.ok(onDisk(survivor));
    }
    // A takeover supersedes even an unreadable chain.
    const taken = await liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
    assert.equal(taken[0].epoch, 2);
    assert.equal(taken[0].previousEpoch, 1);
    assert.deepEqual((await collect(liveStore)).fenced, []);
  });

  test('two versions of one epoch are ambiguous and fail closed', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    const duplicating = new Proxy(provider, {
      get(target, property) {
        if (property === 'list') {
          return async (input, ctx) => {
            const listed = await target.list(input, ctx);
            return input.prefix.endsWith('/_collector-fence/')
              ? {
                  ...listed,
                  objects: [...listed.objects, ...listed.objects.map(entry => ({ ...entry, nativeVersionRef: 'v2' }))],
                }
              : listed;
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new ledger.PostgresReportingLedgerStore(livePool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' } },
        providers: { filesystem: duplicating },
        selectRowBinding: () => 'objects',
      },
    });
    await store.readyRowStorage();
    assert.equal(objectsBinding(await collect(store)).fence.cause, 'fence_unreadable');
  });

  test('an unfinished claim (intent recorded, object never written) is completed by the next pass', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore); // epoch 1
    const orphan = key('acct/after-crash.jsonl');
    await putObject(orphan);
    // A crash after the intent for epoch 2 committed and before its object was written.
    const intent = '33333333-3333-4333-8333-333333333333';
    await livePool.query(
      `UPDATE adcp_reporting_orphan_collector_fences SET epoch = 2, token = $1, previous_token = $2`,
      [intent, fenceRecord(1).token]
    );
    const result = await collect(liveStore);
    assert.deepEqual(result.fenced, []);
    assert.equal(onDisk(orphan), false);
    assert.notEqual(fenceRecord(2).token, intent, 'a finished claim carries a fresh token');
    assert.equal(fenceRecord(2).token, (await fenceRow(livePool)).token);
    assert.equal(fenceRecord(2).previous_token, fenceRecord(1).token);
    assert.equal((await fenceRow(livePool)).epoch, 2);

    // The same for a crash during the very first claim.
    await livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences');
    rmSync(fenceDirectory(), { recursive: true, force: true });
    await livePool.query(
      `INSERT INTO adcp_reporting_orphan_collector_fences (fence_scope, epoch, token, previous_token)
       SELECT $1, 1, $2, NULL`,
      [await scopeOf(liveStore), intent]
    );
    assert.deepEqual((await collect(liveStore)).fenced, []);
    assert.notEqual(fenceRecord(1).token, intent);
    assert.equal(fenceRecord(1).token, (await fenceRow(livePool)).token);
  });

  async function scopeOf(store) {
    return (await store.rowStorage.collectorFenceLocation('objects')).scope;
  }

  test('two hosts of the same database collecting at once do not fence each other', async () => {
    await putObject(key('acct/a.jsonl'));
    await putObject(key('acct/b.jsonl'));
    for (let round = 0; round < 3; round += 1) {
      const [first, second] = await Promise.all([collect(liveStore), collect(liveStore)]);
      assert.deepEqual([first.fenced, second.fenced], [[], []]);
      assert.equal(first.failed + second.failed, 0);
    }
    // The fence lock serializes the claims of one database, so every pass claims exactly one epoch.
    assert.equal((await fenceRow(livePool)).epoch, 6);
    assert.deepEqual(fenceFiles(), [fenceName(5), fenceName(6)]);
  });

  test('another database claiming mid-pass stops the deletes on the next page', async () => {
    for (const name of ['a', 'b', 'c']) await putObject(key(`acct/${name}.jsonl`));
    const intruding = new Proxy(provider, {
      get(target, property) {
        if (property === 'list') {
          return async (input, ctx) => {
            const listed = await target.list(input, ctx);
            if (!input.prefix.endsWith('/_collector-fence/')) {
              if (input.pageToken?.endsWith('/acct/a.jsonl')) {
                // After the first object's page, another database claims the next epoch.
                const record = fenceRecord(1);
                writeFileSync(
                  path.join(fenceDirectory(), fenceName(2)),
                  `${JSON.stringify({ ...record, epoch: 2, token: '44444444-4444-4444-8444-444444444444', previous_token: record.token })}\n`
                );
              }
            }
            return listed;
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new ledger.PostgresReportingLedgerStore(livePool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' } },
        providers: { filesystem: intruding },
        selectRowBinding: () => 'objects',
      },
    });
    await store.readyRowStorage();
    const result = await collect(store, { pageSize: 1 });
    assert.equal(objectsBinding(result).status, 'fenced');
    assert.equal(objectsBinding(result).fence.cause, 'fence_advanced');
    assert.equal(objectsBinding(result).deleted, 1, 'the page before the claim was deleted, no page after it');
    assert.deepEqual(result.fenced, ['objects']);
  });

  test('without the fence migration a real pass and a dry run both refuse, and nothing is deleted', async () => {
    const orphan = key('acct/needs-migration.jsonl');
    await putObject(orphan);
    for (const dryRun of [false, true]) {
      const result = await collect(bareStore, { dryRun });
      assert.deepEqual(result.fenced, ['objects']);
      assert.equal(objectsBinding(result).fence.cause, 'migration_required');
      assert.match(objectsBinding(result).fence.detail, /npx adcp-reporting-storage migrate/);
    }
    assert.ok(onDisk(orphan));
    await assert.rejects(
      () => bareStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true }),
      /migrate/
    );
  });

  test('the versioned migrations apply the fence table, and reapplying it changes nothing', async () => {
    const versions = ledger.migrations().map(item => item.name);
    assert.ok(versions.includes('reporting_orphan_collector_fence'));
    const fence = ledger.migrations().find(item => item.name === 'reporting_orphan_collector_fence');
    assert.deepEqual(fence.statements(), [ledger.REPORTING_ORPHAN_FENCE_MIGRATION]);
    await livePool.query(ledger.REPORTING_ORPHAN_FENCE_MIGRATION);
    await assert.rejects(
      () =>
        livePool.query(
          `INSERT INTO adcp_reporting_orphan_collector_fences (fence_scope, epoch, token) VALUES ($1, 0, $2)`,
          ['a'.repeat(64), '33333333-3333-4333-8333-333333333333']
        ),
      /check/i
    );
  });

  /** A store over `pool` whose provider can be intercepted per operation. */
  function storeWith(pool, hooks) {
    const wrapped = new Proxy(provider, {
      get(target, property) {
        const hook = hooks[property];
        if (hook) return (input, ctx) => hook(input, ctx, () => target[property](input, ctx));
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' } },
        providers: { filesystem: wrapped },
        selectRowBinding: () => 'objects',
      },
    });
  }
  const isFenceKey = input => typeof input.objectRef === 'string' && input.objectRef.includes('/_collector-fence/');
  const isFencePrefix = input => typeof input.prefix === 'string' && input.prefix.endsWith('/_collector-fence/');

  test('a provider failure while reading or writing the fence is a failed binding, not a fenced one', async () => {
    const orphan = key('acct/provider-down.jsonl');
    await putObject(orphan);
    const down = () => Object.assign(new Error('provider down'), { name: 'Error' });
    const listing = storeWith(livePool, {
      list: (input, ctx, next) => {
        if (isFencePrefix(input)) throw down();
        return next();
      },
    });
    await listing.readyRowStorage();
    const failedList = await collect(listing, { cursors: { objects: 'orph/some-token' } });
    assert.equal(objectsBinding(failedList).status, 'failed');
    assert.equal(objectsBinding(failedList).error, 'PROVIDER_UNAVAILABLE');
    assert.deepEqual(failedList.fenced, []);
    assert.equal(failedList.failed, 1);
    assert.deepEqual(failedList.cursors, { objects: 'orph/some-token' }, 'the listing position is kept');
    assert.ok(onDisk(orphan));
    assert.equal(await fenceRow(livePool), undefined, 'a claim that could not read the bucket records nothing');

    // The write of the claim fails after its intent committed.
    const writing = storeWith(livePool, {
      putIfAbsent: (input, ctx, next) => {
        if (isFenceKey(input)) throw down();
        return next();
      },
    });
    await writing.readyRowStorage();
    const failedPut = await collect(writing);
    assert.equal(objectsBinding(failedPut).status, 'failed');
    assert.deepEqual(failedPut.fenced, []);
    assert.equal(failedPut.deleted, 0);
    assert.ok(onDisk(orphan), 'a claim that could not be written deletes nothing');
    assert.equal((await fenceRow(livePool)).epoch, 1, 'the intent stays recorded');
    assert.deepEqual(fenceFiles(), []);

    // The next healthy pass finishes that claim, with a fresh token, and then collects.
    const intent = (await fenceRow(livePool)).token;
    const recovered = await collect(liveStore);
    assert.deepEqual(recovered.fenced, []);
    assert.equal(onDisk(orphan), false);
    assert.equal(fenceRecord(1).namespace_key, namespaceKey);
    assert.notEqual(fenceRecord(1).token, intent, 'a finished claim never reuses the token a copy could hold');
    assert.equal((await fenceRow(livePool)).token, fenceRecord(1).token);

    // A failure while re-reading the fence before a delete is a failed binding too.
    await putObject(key('acct/second.jsonl'));
    let fenceLists = 0;
    const rechecking = storeWith(livePool, {
      list: (input, ctx, next) => {
        if (isFencePrefix(input) && (fenceLists += 1) > 1) throw down();
        return next();
      },
    });
    await rechecking.readyRowStorage();
    const failedRecheck = await collect(rechecking);
    assert.equal(objectsBinding(failedRecheck).status, 'failed');
    assert.deepEqual(failedRecheck.fenced, []);
    assert.equal(objectsBinding(failedRecheck).deleted, 0);

    // An aborted signal is an abort, not a refusal.
    await assert.rejects(() => collect(liveStore, { signal: AbortSignal.abort() }));
  });

  test('a copy taken while a claim was unfinished cannot adopt the same token as the original', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore); // epoch 1
    // The original wrote its intent for epoch 2 and never got the object out; a copy is taken in that window.
    const intent = '66666666-6666-4666-8666-666666666666';
    await livePool.query(
      `UPDATE adcp_reporting_orphan_collector_fences SET epoch = 2, token = $1, previous_token = $2`,
      [intent, fenceRecord(1).token]
    );
    await freshClone();
    const newer = key('acct/live-only.jsonl');
    await addIntent(livePool, 'rrev_live_only', newer, await putObject(newer));
    const [original, copy] = [await collect(liveStore), await collect(cloneStore)];
    assert.deepEqual(original.fenced, [], 'the first to finish the claim owns it');
    assert.deepEqual(copy.fenced, ['objects']);
    assert.equal(objectsBinding(copy).fence.cause, 'token_mismatch', 'the copy does not adopt the original token');
    assert.ok(onDisk(newer));
    assert.deepEqual(fenceRecord(2).token, (await fenceRow(livePool)).token);
    assert.notEqual(fenceRecord(2).token, intent);
  });

  test('a sibling host waits for a claim in flight instead of finishing it under another token', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore); // epoch 1
    await putObject(key('acct/a.jsonl'));
    let reached;
    const atPut = new Promise(resolve => (reached = resolve));
    let release;
    const held = new Promise(resolve => (release = resolve));
    const slow = storeWith(livePool, {
      putIfAbsent: async (input, ctx, next) => {
        if (isFenceKey(input)) {
          reached();
          await held;
        }
        return next();
      },
    });
    await slow.readyRowStorage();
    const first = collect(slow); // commits its intent for epoch 2, then waits to write it
    await atPut;
    let siblingDone = false;
    const sibling = collect(liveStore).then(result => {
      siblingDone = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(siblingDone, false, 'the sibling waits on the fence lock while the claim is in flight');
    assert.equal((await fenceRow(livePool)).epoch, 2, 'the intent is already recorded');
    release();
    const [early, late] = await Promise.all([first, sibling]);
    assert.deepEqual([early.fenced, late.fenced], [[], []]);
    // The first claim is epoch 2 under its own token; the sibling then claims epoch 3 on top of it.
    assert.equal(fenceRecord(3).previous_token, fenceRecord(2).token);
    assert.equal((await fenceRow(livePool)).epoch, 3);
    assert.equal((await fenceRow(livePool)).token, fenceRecord(3).token);
  });

  test('the fence is claimed before the first delete of a pass', async () => {
    const events = [];
    const ordered = storeWith(livePool, {
      putIfAbsent: (input, ctx, next) => {
        if (isFenceKey(input)) events.push('claim');
        return next();
      },
      delete: (input, ctx, next) => {
        events.push(isFenceKey(input) ? 'prune' : 'delete');
        return next();
      },
    });
    await ordered.readyRowStorage();
    for (const name of ['a', 'b']) await putObject(key(`acct/${name}.jsonl`));
    await collect(ordered);
    assert.deepEqual(events, ['claim', 'delete', 'delete']);
  });

  test('a takeover recovers every refusal, and moves past a database that is ahead of its bucket', async () => {
    const seed = async () => {
      await putObject(key('acct/seed.jsonl'));
      await collect(liveStore);
      await collect(liveStore);
    };
    const recipes = {
      claimed_elsewhere: async () => livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences'),
      fence_missing: async () => rmSync(fenceDirectory(), { recursive: true, force: true }),
      token_mismatch: async () =>
        writeFileSync(
          path.join(fenceDirectory(), fenceName(2)),
          `${JSON.stringify({ ...fenceRecord(2), token: '77777777-7777-4777-8777-777777777777' })}\n`
        ),
      fence_regressed: async () =>
        livePool.query(`UPDATE adcp_reporting_orphan_collector_fences SET epoch = 5, previous_token = $1`, [
          '88888888-8888-4888-8888-888888888888',
        ]),
      fence_unreadable: async () => writeFileSync(path.join(fenceDirectory(), fenceName(2)), 'garbage'),
    };
    for (const [cause, recipe] of Object.entries(recipes)) {
      await beforeEachReset();
      await seed();
      await recipe();
      const refused = await collect(liveStore);
      assert.equal(objectsBinding(refused).fence.cause, cause);
      const taken = await liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
      const expected = cause === 'fence_regressed' ? 6 : 3;
      assert.equal(taken[0].epoch, expected, cause);
      assert.deepEqual((await collect(liveStore)).fenced, [], `${cause} is recovered by a takeover`);
    }
  });

  async function beforeEachReset() {
    await livePool.query('DELETE FROM adcp_reporting_orphan_collector_fences');
    await livePool.query('DELETE FROM adcp_reporting_row_write_intents');
    rmSync(path.join(root, 'orph'), { recursive: true, force: true });
  }

  test('a takeover removes every version of a duplicated chain, so normal collection works again', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await collect(liveStore);
    const duplicated = storeWith(livePool, {
      list: async (input, ctx, next) => {
        const listed = await next();
        return isFencePrefix(input)
          ? {
              ...listed,
              objects: [...listed.objects, ...listed.objects.map(entry => ({ ...entry, nativeVersionRef: 'v2' }))],
            }
          : listed;
      },
    });
    await duplicated.readyRowStorage();
    assert.equal(objectsBinding(await collect(duplicated)).fence.cause, 'fence_unreadable');
    const taken = await duplicated.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
    assert.equal(taken[0].epoch, 3);
    assert.deepEqual(fenceFiles(), [fenceName(3)], 'every superseded object is gone, the predecessor included');
    assert.deepEqual((await collect(liveStore)).fenced, [], 'a clean listing no longer refuses');
  });

  test('a takeover can be limited to named bindings, skips readOnly ones, and refuses a provider that cannot list', async () => {
    const taken = await liveStore.takeOverOrphanCollectorFence({
      acknowledgePreviousOwnerGone: true,
      bindings: ['objects'],
    });
    assert.deepEqual(taken, [{ bindingIds: ['objects'], epoch: 1, previousEpoch: null }]);
    const defaults = await liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true });
    assert.deepEqual(defaults, [{ bindingIds: ['objects'], epoch: 2, previousEpoch: 1 }], 'readOnly twin is left out');

    const noList = new Proxy(provider, {
      get(target, property) {
        if (property === 'list') return undefined;
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new ledger.PostgresReportingLedgerStore(livePool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'orph' } },
        providers: { filesystem: noList },
        selectRowBinding: () => 'objects',
      },
    });
    await assert.rejects(
      () => store.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true, bindings: ['objects'] }),
      RangeError
    );
    await assert.rejects(
      () => liveStore.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true, signal: AbortSignal.abort() }),
      /abort/i
    );
  });

  test('a fenced clone refuses every binding that shares the fence, with one check and no cursor kept', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await freshClone();
    await collect(liveStore);
    const refused = await collect(cloneStore, {
      includeReadOnly: true,
      cursors: { objects: 'orph/stale-token' },
    });
    assert.deepEqual(refused.fenced, ['objects', 'twin']);
    assert.deepEqual(refused.cursors, {}, 'a refused binding does not keep a listing position');
    assert.deepEqual(refused.completed, []);
    assert.equal(refused.listed, 0);
  });

  test('a fenced namespace never rests a whole interval in the maintenance cycle, and applying the fix resumes it', async () => {
    await putObject(key('acct/seed.jsonl'));
    await collect(liveStore);
    await freshClone();
    await collect(liveStore);
    const orphanState = { cursors: {} };
    const run = () =>
      ledger.runReportingLedgerMaintenance({
        store: cloneStore,
        statusRetentionDays: 30,
        orphanCollection: { enabled: true, acknowledgeExclusiveNamespace: true, intervalSeconds: 7 * 24 * 3600 },
        orphanState,
      });
    const results = await run();
    const task = results.find(item => item.task === 'orphan object collection');
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.result.fenced, ['objects']);
    assert.match(task.partialFailure.message, /fence_advanced/);
    const rest = orphanState.nextCycleAt - Date.now();
    assert.ok(rest > 0 && rest <= 3_600_000, `a fenced cycle looks again within the hour (${rest} ms)`);
  });
});
