/**
 * PostgreSQL integration tests for opt-in compaction of superseded snapshot
 * revisions (adcontextprotocol/adcp#8100, `content_retention`).
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-snapshot-compaction-pg.test.js
 */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

const STATUS_DAYS = 30;
const RECOVERY_SECONDS = 300;

describe('reporting snapshot compaction', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_compaction_${process.pid}`;
  const pgSchema = `adcp_reporting_compaction_pg_${process.pid}`;
  let bootstrapPool;
  let pool;
  let pgPool;
  let ledger;
  let root;
  let store;
  let pgStore;
  let sequence = 0;

  const rowsFor = (seed, length = 30) =>
    Array.from({ length }, (_, index) => ({ ordinal: index, value: seed * 1000 + index }));
  const count = async (sql, values = [], db = pool) => Number((await db.query(sql, values)).rows[0].n);
  const compact = (overrides = {}, target = store) =>
    target.compactSupersededSnapshots({
      statusRetentionDays: STATUS_DAYS,
      automatedRecoveryWindowSeconds: RECOVERY_SECONDS,
      ...overrides,
    });
  const rowSetState = async (revisionId, db = pool) =>
    (await db.query(`SELECT rows_state FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [revisionId])).rows[0]
      ?.rows_state;
  const objectFiles = async revisionId =>
    (await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [revisionId])).rows.map(
      row => path.join(root, row.object_ref)
    );
  /** Age one revision's `created_at`, which is what its predecessor's window and grace run from. */
  const age = (db, revisionId, interval) =>
    db.query(
      `UPDATE adcp_reporting_revisions SET created_at = clock_timestamp() - $2::interval WHERE revision_id = $1`,
      [revisionId, interval]
    );
  /** The worker is done: drop the lease so the obligation is eligible, and keep later fixtures from claiming it. */
  const finish = (db, fixture) =>
    db.query(
      `UPDATE adcp_reporting_obligations SET state = 'terminal', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [fixture.obligation.reporting_obligation_id]
    );

  /** A chain of `ages.length` snapshots; `ages[i]` is how old revision i+1's created_at is made. */
  async function buildChain(target, db, ages, { rows } = {}) {
    sequence += 1;
    const suffix = `c${sequence}`;
    const fixture = await createRowStorageFixture({ store: target, suffix });
    const ids = ages.map((_, index) => `rrev_${suffix}_${index + 1}`);
    for (const [index, id] of ids.entries()) {
      await target.commitRevision(
        fixture.revision(id, index + 1, rows ? rows(index) : rowsFor(sequence * 10 + index), {
          ...(index > 0 ? { supersedes_reporting_revision_id: ids[index - 1] } : {}),
        }),
        fixture.lease
      );
    }
    for (const [index, id] of ids.entries()) if (ages[index]) await age(db, id, ages[index]);
    await finish(db, fixture);
    return { fixture, ids, accountId: fixture.request.account.account_id };
  }

  async function exactRead(target, revisionId, accountId) {
    const handler = ledger.createReportingDeliveryHandler(target);
    return handler({ reporting_revision_id: revisionId }, { account: { account_id: accountId } });
  }

  async function readError(target, revisionId, accountId) {
    try {
      await exactRead(target, revisionId, accountId);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const states = async (ids, db = pool) => Promise.all(ids.map(id => rowSetState(id, db)));

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-compaction-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    await bootstrapPool.query(`CREATE SCHEMA "${pgSchema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    pgPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${pgSchema}"` });
    for (const db of [pool, pgPool]) {
      await db.query(ledger.REPORTING_LEDGER_MIGRATION);
      await db.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
      await db.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
      await db.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    }
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      changeFeed: true,
      rowStorage: {
        bindings: {
          objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'compacted' },
        },
        providers: { filesystem: ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } }) },
      },
    });
    await store.readyRowStorage();
    pgStore = new ledger.PostgresReportingLedgerStore(pgPool, { acknowledgeIsolatedDatabase: true, rowStorage: true });
    await pgStore.readyRowStorage();
  });

  after(async () => {
    if (pool) await pool.end();
    if (pgPool) await pgPool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${pgSchema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('a chain of five compacts only the older superseded snapshots outside the grace', async () => {
    // r1 and r2 were superseded long ago; r3 was superseded 30 minutes ago
    // (inside the one-hour grace); r4 is what the current r5 supersedes.
    const { ids, accountId, fixture } = await buildChain(store, pool, [null, '3 hours', '2 hours', '30 minutes', null]);
    const [r1, r2, r3, r4, r5] = ids;
    const files = await Promise.all(ids.map(objectFiles));
    assert.ok(files.flat().length > 0 && files.flat().every(existsSync));

    assert.deepEqual(await compact(), { compacted: 2, failed: [], failures: [] });
    assert.deepEqual(await states(ids), ['pruned', 'pruned', 'live', 'live', 'live']);
    assert.ok(files[0].every(file => !existsSync(file)) && files[1].every(file => !existsSync(file)));
    assert.ok([...files[2], ...files[3], ...files[4]].every(existsSync), 'retained revisions keep their objects');
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = ANY($1)`, [[r1, r2]]),
      0
    );

    // Exact reads: compacted revisions read exactly like an unknown ID.
    for (const id of [r1, r2]) {
      const error = await readError(store, id, accountId);
      assert.equal(error?.code, 'REFERENCE_NOT_FOUND');
    }
    const unknown = await readError(store, 'rrev_never_existed', accountId);
    assert.equal(unknown?.code, 'REFERENCE_NOT_FOUND');
    assert.equal(unknown.message, (await readError(store, r1, accountId)).message);
    for (const id of [r3, r4, r5]) assert.equal((await exactRead(store, id, accountId)).reporting_rows.length, 30);

    // Metadata for every revision stays listed; only the full-hydration list omits compacted rows.
    const listed = await store.listRevisionMetadata(fixture.obligation.reporting_obligation_id);
    assert.deepEqual(
      listed.map(revision => revision.reporting_revision_id),
      ids
    );
    assert.equal((await store.getRevisionMetadata(r1, accountId)).reporting_revision_id, r1);
    assert.deepEqual(
      (await store.listRevisions(fixture.obligation.reporting_obligation_id)).map(
        revision => revision.reporting_revision_id
      ),
      [r3, r4, r5]
    );

    // Idempotent, and the in-grace revision compacts once its grace passes.
    assert.deepEqual(await compact(), { compacted: 0, failed: [], failures: [] });
    await age(pool, r4, '2 hours');
    assert.equal((await compact()).compacted, 1);
    assert.deepEqual(await states(ids), ['pruned', 'pruned', 'pruned', 'live', 'live']);
    assert.equal((await readError(store, r3, accountId))?.code, 'REFERENCE_NOT_FOUND');
  });

  test('the recovery grace is the longer of the advertised window and one hour', async () => {
    // r1 and r2 were superseded 30 and 40 minutes ago; r3 is what current r4 supersedes.
    const { ids } = await buildChain(store, pool, [null, '30 minutes', '40 minutes', null]);
    assert.deepEqual(await compact(), { compacted: 0, failed: [], failures: [] });
    assert.deepEqual(await states(ids), ['live', 'live', 'live', 'live']);
    // r1's successor is now three hours old.
    await age(pool, ids[1], '3 hours');
    // A longer advertised recovery window lengthens the grace past one hour.
    assert.equal((await compact({ automatedRecoveryWindowSeconds: 4 * 3600 })).compacted, 0);
    assert.equal((await compact({ automatedRecoveryWindowSeconds: 2 * 3600 })).compacted, 1);
    assert.deepEqual(await states(ids), ['pruned', 'live', 'live', 'live']);
  });

  test('official revisions and the current revision are never compacted', async () => {
    const { ids, fixture, accountId } = await buildChain(store, pool, [null, '5 hours', null]);
    // Re-open the lease to add an official revision on top of the snapshots.
    await pool.query(
      `UPDATE adcp_reporting_obligations SET lease_owner = $2, lease_expires_at = clock_timestamp() + INTERVAL '10 minutes'
        WHERE obligation_id = $1`,
      [fixture.obligation.reporting_obligation_id, fixture.lease.owner]
    );
    await store.commitRevision(
      fixture.revision('rrev_official_1', 4, rowsFor(77), {
        finality: 'official',
        kind: 'official',
        supersedes_reporting_revision_id: ids[2],
      }),
      fixture.lease
    );
    await age(pool, 'rrev_official_1', '5 hours');
    await age(pool, ids[2], '6 hours');
    await finish(pool, fixture);

    // r1 and r2 are long superseded. r3 is named by the current official
    // revision, and the official revision is itself the current one.
    assert.equal((await compact()).compacted, 2);
    assert.deepEqual(await states([...ids, 'rrev_official_1']), ['pruned', 'pruned', 'live', 'live']);
    assert.equal((await exactRead(store, 'rrev_official_1', accountId)).reporting_rows.length, 30);

    // Nothing is left: the official revision is finality-protected.
    assert.equal((await compact()).compacted, 0);
    assert.equal(await rowSetState('rrev_official_1'), 'live');
  });

  describe('callers that are owed content', () => {
    const receipt = (revisionId, consumer, current = true, id = `rcpt_${++sequence}`) =>
      pool.query(
        `INSERT INTO adcp_reporting_receipts
           (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id, is_current, semantic_fingerprint, data, received_at)
         SELECT account_id, $2, $3, 'revision', $1, $4, 'fp-' || $3, '{}'::jsonb, clock_timestamp()
           FROM adcp_reporting_obligations LIMIT 1`,
        [revisionId, consumer, id, current]
      );
    const statement = (revisionId, obligationId, consumer, status, { current = true } = {}) =>
      pool.query(
        `INSERT INTO adcp_reporting_consumer_statuses
           (consumer_status_id, account_id, consumer_id, chain_key, revision_id, obligation_id, is_current,
            semantic_fingerprint, data, created_at)
         SELECT $1, account_id, $2, $1, $3, $4, $6, 'fp-' || $1,
                jsonb_build_object('consumer_status', $5::text), clock_timestamp()
           FROM adcp_reporting_obligations WHERE obligation_id = $4`,
        [`stmt_${++sequence}`, consumer, revisionId, obligationId, status, current]
      );

    test('keeps a revision named by any caller receipt or current received/unreadable/content_mismatch statement', async () => {
      // Seven long-superseded revisions, then the current one.
      const ages = [null, '3 hours', '3 hours', '3 hours', '3 hours', '3 hours', '3 hours', '3 hours', null];
      const { ids, fixture } = await buildChain(store, pool, ages);
      const obligationId = fixture.obligation.reporting_obligation_id;
      const [r1, r2, r3, r4, r5, r6, r7] = ids;
      await receipt(r1, 'consumer-a'); // current receipt
      await receipt(r2, 'consumer-b', false); // a superseded receipt still counts: any status
      await statement(r3, obligationId, 'consumer-a', 'received');
      await statement(r4, obligationId, 'consumer-b', 'unreadable');
      await statement(r5, obligationId, 'consumer-c', 'content_mismatch');
      await statement(r6, obligationId, 'consumer-a', 'revision_missing'); // does not pin
      await statement(r7, obligationId, 'consumer-a', 'received', { current: false }); // not current: does not pin

      assert.deepEqual(await compact(), { compacted: 2, failed: [], failures: [] });
      assert.deepEqual(await states(ids), ['live', 'live', 'live', 'live', 'live', 'pruned', 'pruned', 'live', 'live']);

      // The pin lasts only while the revision's window is open: once its
      // successor is older than statusRetentionDays, content is no longer owed.
      await age(pool, ids[1], '31 days'); // r1's successor
      await age(pool, ids[3], '31 days'); // r3's successor
      assert.equal((await compact()).compacted, 2);
      assert.deepEqual(await states(ids.slice(0, 5)), ['pruned', 'live', 'pruned', 'live', 'live']);
    });
  });

  test('chunks shared with a retained revision survive', async () => {
    // r2 repeats r1's rows byte for byte and shares its chunks; r3 differs.
    const same = rowsFor(900);
    const { ids, accountId } = await buildChain(store, pool, [null, '4 hours', '3 hours', null], {
      rows: index => (index < 2 ? same : rowsFor(910 + index)),
    });
    const [r1, r2, r3] = ids;
    const sharedFrom = (
      await pool.query(
        `SELECT rows_shared_from_row_set_id AS shared FROM adcp_reporting_row_sets WHERE row_set_id = $1`,
        [r2]
      )
    ).rows[0].shared;
    assert.equal(sharedFrom, r1);
    const sharedFiles = await objectFiles(r1);
    assert.deepEqual(sharedFiles, await objectFiles(r2));

    // r1 is outside every protection; r2 is superseded long ago too.
    assert.equal((await compact({ limit: 1 })).compacted, 1);
    assert.equal(await rowSetState(r1), 'pruned');
    assert.equal(await rowSetState(r2), 'live');
    assert.ok(sharedFiles.every(existsSync), 'the object r2 still references is kept');
    assert.equal((await exactRead(store, r2, accountId)).reporting_rows.length, 30);
    assert.equal((await readError(store, r1, accountId))?.code, 'REFERENCE_NOT_FOUND');

    // Once r2 is compacted too, the last reference is gone and the objects go.
    assert.equal((await compact()).compacted, 1);
    assert.equal(await rowSetState(r2), 'pruned');
    assert.ok(sharedFiles.every(file => !existsSync(file)));
    assert.equal((await exactRead(store, r3, accountId)).reporting_rows.length, 30);
  });

  test('PostgreSQL-binding chunk bodies are shared by content and removed with their last reference', async () => {
    const same = rowsFor(950);
    const { ids, accountId } = await buildChain(pgStore, pgPool, [null, '4 hours', '3 hours', null], {
      rows: index => (index < 2 ? same : rowsFor(960 + index)),
    });
    const [r1, r2, r3] = ids;
    const bodiesFor = revisionId =>
      count(
        `SELECT count(DISTINCT body.sha256) AS n FROM adcp_reporting_chunk_bodies body
           JOIN adcp_reporting_row_chunks chunk ON chunk.sha256 = body.sha256 AND chunk.row_set_id = $1`,
        [revisionId],
        pgPool
      );
    const before = await count(`SELECT count(*) AS n FROM adcp_reporting_chunk_bodies`, [], pgPool);
    assert.ok((await bodiesFor(r1)) > 0);

    assert.equal((await compact({ limit: 1 }, pgStore)).compacted, 1);
    assert.equal(await rowSetState(r1, pgPool), 'pruned');
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_chunk_bodies`, [], pgPool),
      before,
      'r2 still uses the bodies'
    );
    assert.equal((await exactRead(pgStore, r2, accountId)).reporting_rows.length, 30);
    assert.equal((await readError(pgStore, r1, accountId))?.code, 'REFERENCE_NOT_FOUND');

    assert.equal((await compact({}, pgStore)).compacted, 1);
    assert.ok((await count(`SELECT count(*) AS n FROM adcp_reporting_chunk_bodies`, [], pgPool)) < before);
    assert.equal((await readError(pgStore, r2, accountId))?.code, 'REFERENCE_NOT_FOUND');
    assert.equal((await exactRead(pgStore, r3, accountId)).reporting_rows.length, 30);
  });

  test('resumes a compaction interrupted after it marked the row set', async () => {
    const { ids, accountId } = await buildChain(store, pool, [null, '3 hours', null]);
    const [r1] = ids;
    const files = await objectFiles(r1);
    // A crashed pass: phase 1 committed, then the process died before deleting anything.
    await pool.query(`UPDATE adcp_reporting_row_sets SET rows_state = 'pruning' WHERE row_set_id = $1`, [r1]);
    assert.equal((await readError(store, r1, accountId))?.code, 'REFERENCE_NOT_FOUND');
    assert.ok(files.every(existsSync));

    assert.deepEqual(await compact(), { compacted: 1, failed: [], failures: [] });
    assert.equal(await rowSetState(r1), 'pruned');
    assert.ok(files.every(file => !existsSync(file)));
    assert.equal(await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [r1]), 0);
    assert.deepEqual(await compact(), { compacted: 0, failed: [], failures: [] });
  });

  test('a failed object delete leaves the revision pruning and the next pass finishes it', async () => {
    const { ids } = await buildChain(store, pool, [null, '3 hours', null]);
    const [r1] = ids;
    const files = await objectFiles(r1);
    // The provider fails once.
    const original = store.rowStorage.deleteObjects;
    store.rowStorage.deleteObjects = async () => {
      throw new ledger.ReportingRowStoreError('STATE_UNAVAILABLE', 'provider down');
    };
    try {
      const failed = await compact();
      assert.equal(failed.compacted, 0);
      assert.deepEqual(failed.failed, [r1]);
      assert.equal(failed.failures[0].cause, 'STATE_UNAVAILABLE');
    } finally {
      store.rowStorage.deleteObjects = original;
    }
    assert.equal(await rowSetState(r1), 'pruning');
    assert.ok(files.every(existsSync), 'nothing was deleted and the chunk manifest is intact');
    assert.deepEqual(await compact(), { compacted: 1, failed: [], failures: [] });
    assert.equal(await rowSetState(r1), 'pruned');
    assert.ok(files.every(file => !existsSync(file)));
  });

  test('a revision that is owed but whose content is lost answers unavailable, never not-found', async () => {
    const { ids, accountId } = await buildChain(store, pool, [null, '30 minutes', null]);
    const [r1] = ids;
    for (const file of await objectFiles(r1)) unlinkSync(file);
    const error = await readError(store, r1, accountId);
    assert.equal(error?.code, 'SERVICE_UNAVAILABLE');
    // It is in its grace, so compaction leaves it alone.
    assert.equal((await compact()).compacted, 0);
    assert.equal(await rowSetState(r1), 'live');
  });

  test('holds back for a live obligation lease, a pending materialization and an unread feed consumer', async () => {
    const { ids, fixture } = await buildChain(store, pool, [null, '3 hours', null]);
    const [r1] = ids;
    const obligationId = fixture.obligation.reporting_obligation_id;
    const accountId = fixture.request.account.account_id;

    // A live lease.
    await pool.query(
      `UPDATE adcp_reporting_obligations SET lease_expires_at = clock_timestamp() + INTERVAL '5 minutes' WHERE obligation_id = $1`,
      [obligationId]
    );
    assert.equal((await compact()).compacted, 0);
    await finish(pool, fixture);

    // A pending materialization of that revision.
    await pool.query(
      `INSERT INTO adcp_reporting_destination_authorizations (account_id, destination_ref, generation, authorized_at, data)
       VALUES ($1, 'dest', 1, clock_timestamp(), '{}'::jsonb)`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO adcp_reporting_managed_bindings
         (configuration_id, account_id, delivery_config_id, delivery_config_version, destination_ref,
          authorization_generation, semantic_fingerprint, data, created_at)
       SELECT configuration_id, account_id, delivery_config_id, delivery_config_version, 'dest', 1, 'fp', '{}'::jsonb, clock_timestamp()
         FROM adcp_reporting_configurations WHERE configuration_id = $1`,
      [fixture.configuration.configurationId]
    );
    await pool.query(
      `INSERT INTO adcp_reporting_materializations
         (materialization_id, account_id, configuration_id, obligation_id, revision_id, destination_ref,
          authorization_generation, attempt, status, data, created_at)
       VALUES ('mat_1', $1, $2, $3, $4, 'dest', 1, 1, 'pending', '{}'::jsonb, clock_timestamp())`,
      [accountId, fixture.configuration.configurationId, obligationId, r1]
    );
    assert.equal((await compact()).compacted, 0);
    await pool.query(
      `UPDATE adcp_reporting_materializations SET status = 'delivered' WHERE materialization_id = 'mat_1'`
    );

    // A feed consumer that registered before the revision and has not read it.
    await pool.query('DELETE FROM adcp_reporting_feed_consumers');
    await pool.query(
      `INSERT INTO adcp_reporting_feed_consumers (consumer_name, account_id, cursor_seq)
       VALUES ('sink', $1, 0)`,
      [accountId]
    );
    assert.equal((await compact()).compacted, 0, 'an unread consumer holds the revision');
    const passed = (
      await pool.query(`SELECT max(seq) AS seq FROM adcp_reporting_changes WHERE account_id = $1`, [accountId])
    ).rows[0].seq;
    await pool.query(`UPDATE adcp_reporting_feed_consumers SET cursor_seq = $1`, [passed]);
    assert.equal((await compact()).compacted, 1);
    assert.equal(await rowSetState(r1), 'pruned');
    await pool.query('DELETE FROM adcp_reporting_feed_consumers');

    // Compaction records no change row: the revision's metadata did not change.
    assert.equal(
      await count(
        `SELECT count(*) AS n FROM adcp_reporting_changes WHERE record_kind = 'retirement' AND obligation_id = $1`,
        [obligationId]
      ),
      0
    );
  });

  test('refuses invalid inputs', async () => {
    await assert.rejects(() => compact({ statusRetentionDays: 0 }), RangeError);
    await assert.rejects(() => compact({ automatedRecoveryWindowSeconds: 0 }), RangeError);
    await assert.rejects(() => compact({ limit: 0 }), RangeError);
    await assert.rejects(() => compact({ maxFeedHoldDays: 0 }), RangeError);
  });

  const unsafeTemplate = '{prefix}/{namespace_key}/{account_key}/{period_date}/{content_sha256}/{chunk_index}';
  const withTemplate = keyTemplate =>
    new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: {
          objects: {
            kind: 'object',
            provider: 'filesystem',
            location: { root: 'rows' },
            prefix: 'guarded',
            keyTemplate,
          },
        },
        providers: { filesystem: ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } }) },
      },
    });
  const refusal = error =>
    error instanceof ledger.ReportingRowStoreError &&
    error.code === 'INVALID_INPUT' &&
    /keyTemplate to include \{revision_key\}/.test(error.message);

  describe('object key template guard', () => {
    test('compactSupersededSnapshots refuses before deleting anything', async () => {
      const { ids } = await buildChain(store, pool, [null, '3 hours', null]);
      const unsafe = withTemplate(unsafeTemplate);
      await assert.rejects(() => compact({}, unsafe), refusal);
      assert.deepEqual(await states(ids), ['live', 'live', 'live']);
      assert.throws(() => unsafe.assertCompactionSafeRowBindings(), refusal);
    });

    test('the default and explicit {revision_key} templates are accepted', async () => {
      store.assertCompactionSafeRowBindings();
      pgStore.assertCompactionSafeRowBindings();
      const explicit = withTemplate(ledger.REPORTING_ROW_DEFAULT_KEY_TEMPLATE);
      explicit.assertCompactionSafeRowBindings();
      assert.deepEqual(await compact({ account_id: 'no-such-account' }, explicit), {
        compacted: 0,
        failed: [],
        failures: [],
      });
    });
  });

  describe('maintenance wiring', () => {
    let reporting;

    function createService(maintenance, target = store) {
      const source = require('../../dist/lib/reporting/source/index.js');
      const sourceOffering = structuredClone(source.redactedReportingSourceOfferingV1);
      sourceOffering.cadence = {
        ...sourceOffering.cadence,
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'PT0S',
      };
      const adapter = {
        sourceOffering,
        deliveryOffering: {
          offering_id: sourceOffering.offeringId,
          feed_purpose: 'analytics',
          report_definition_id: sourceOffering.contract.report_definition_id,
          report_definition_uri: sourceOffering.contract.reportDefinitionUri,
          report_definition_sha256: sourceOffering.contract.reportDefinitionSha256,
          reporting_profile: {
            id: sourceOffering.contract.reportingProfile,
            version: sourceOffering.contract.schemaVersion,
            schema_uri: sourceOffering.contract.schemaUri,
            schema_sha256: sourceOffering.contract.schemaSha256,
            schema_dialect: sourceOffering.contract.schemaDialect,
            schema_ref_policy: sourceOffering.contract.schemaRefPolicy,
            grain: sourceOffering.grain,
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
        },
        fetchSlice: request => ({
          reporting_period: { start: request.start_date, end: request.end_date },
          currency: 'USD',
          reporting_rows: [],
        }),
      };
      return reporting.createReliableReportingService({
        store: target,
        adapters: { fixture: adapter },
        contact: { name: 'Reporting operations', email: 'reporting@example.com' },
        automatedRecoveryWindowSeconds: RECOVERY_SECONDS,
        statusRetentionDays: STATUS_DAYS,
        resolveSource: account => ({
          adapterId: 'fixture',
          sourceScope: { network_id: `network-${account.id}` },
          sourceTimezone: 'UTC',
        }),
        resolveCurrency: () => 'USD',
        resolveCoverage: () => ({ constituents: [] }),
        ...(maintenance ? { maintenance } : {}),
      });
    }

    before(() => {
      reporting = require('../../dist/lib/reporting/service/index.js');
    });

    test('is off by default and opt-in through maintenance.compaction', async () => {
      const { ids } = await buildChain(store, pool, [null, '3 hours', null]);
      const [r1] = ids;

      for (const maintenance of [{}, { retention: { enabled: true } }, { changeFeed: true }]) {
        const results = await createService(maintenance).runMaintenance();
        assert.ok(!results.some(result => result.task === 'snapshot compaction'));
        assert.equal(await rowSetState(r1), 'live', 'nothing compacts unless asked');
      }

      const results = await createService({ compaction: { enabled: true } }).runMaintenance();
      const task = results.find(result => result.task === 'snapshot compaction');
      assert.equal(task.status, 'completed');
      assert.ok(task.result.compacted >= 1);
      assert.equal(task.partialFailure, undefined);
      assert.equal(await rowSetState(r1), 'pruned');
    });

    test('limit bounds a pass, and invalid options are refused up front', async () => {
      const { ids } = await buildChain(store, pool, [null, '3 hours', '3 hours', null]);
      const service = createService({ compaction: { enabled: true, limit: 1 } });
      const compactedBy = async () =>
        (await service.runMaintenance()).find(result => result.task === 'snapshot compaction').result.compacted;
      let total = 0;
      for (
        let pass = 0;
        pass < 10 && (await states(ids)).includes('live') && (await states(ids)).filter(s => s === 'pruned').length < 2;
        pass += 1
      ) {
        const compacted = await compactedBy();
        assert.ok(compacted <= 1, 'limit bounds one pass');
        total += compacted;
      }
      assert.ok(total >= 1);
      assert.deepEqual((await states(ids)).slice(2), ['live', 'live']);

      assert.throws(() => createService({ compaction: { enabled: false } }), TypeError);
      assert.throws(() => createService({ compaction: { enabled: true, limit: 0 } }), TypeError);
      assert.throws(() => createService({ compaction: true }), TypeError);
    });

    test('compaction refuses an unsafe key template at construction, and only when enabled', () => {
      const unsafe = withTemplate(unsafeTemplate);
      assert.throws(() => createService({ compaction: { enabled: true } }, unsafe), refusal);
      assert.doesNotThrow(() => createService({ retention: { enabled: true } }, unsafe));
      assert.doesNotThrow(() => createService({ compaction: { enabled: true } }));
    });

    test('a per-revision failure is reported as a partial failure', async () => {
      const { ids } = await buildChain(store, pool, [null, '3 hours', null]);
      const original = store.rowStorage.deleteObjects;
      store.rowStorage.deleteObjects = async () => {
        throw new ledger.ReportingRowStoreError('STATE_UNAVAILABLE', 'provider down');
      };
      try {
        const results = await createService({ compaction: { enabled: true } }).runMaintenance();
        const task = results.find(result => result.task === 'snapshot compaction');
        assert.equal(task.status, 'completed');
        assert.equal(task.result.failed[0], ids[0]);
        assert.ok(task.partialFailure);
      } finally {
        store.rowStorage.deleteObjects = original;
      }
      await compact();
      assert.equal(await rowSetState(ids[0]), 'pruned');
    });
  });
});
