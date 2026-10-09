/**
 * PostgreSQL integration tests for period-aligned retention and abandoned
 * row-upload sweeps.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-row-retention-pg.test.js
 */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('reporting retention', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_retention_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let root;
  let rowStorage;
  let store;
  const rows = Array.from({ length: 30 }, (_, index) => ({ ordinal: index, value: index }));
  const count = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n);

  async function expire(obligationId, days = 40) {
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - ($2::integer * INTERVAL '1 day'),
              period_end = period_end - ($2::integer * INTERVAL '1 day'),
              created_at = created_at - ($2::integer * INTERVAL '1 day'),
              lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [obligationId, days]
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - ($2::integer * INTERVAL '1 day')
        WHERE obligation_id = $1`,
      [obligationId, days]
    );
  }

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-retention-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    rowStorage = {
      bindings: {
        objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'retained' },
      },
      providers: { filesystem: ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } }) },
    };
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, rowStorage });
    await store.readyRowStorage();
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('retires an expired period as a unit and refuses to resurrect it', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'retired' });
    await store.commitRevision(fixture.revision('rrev_retired_1', 1, rows), fixture.lease);
    await store.commitRevision(
      fixture.revision('rrev_retired_2', 2, rows, { supersedes_reporting_revision_id: 'rrev_retired_1' }),
      fixture.lease
    );
    const objectKeys = (
      await pool.query(
        `SELECT object_key FROM adcp_reporting_row_chunks WHERE obligation_id = $1 ORDER BY row_set_id`,
        [fixture.obligation.reporting_obligation_id]
      )
    ).rows.map(row => path.join(root, row.object_key));
    assert.equal(objectKeys.length, 2);
    assert.ok(objectKeys.every(existsSync));

    const retained = await createRowStorageFixture({ store, suffix: 'retained' });
    await store.commitRevision(retained.revision('rrev_retained_1', 1, rows), retained.lease);

    // Within the window nothing is eligible.
    assert.deepEqual(await store.retireExpiredPeriods({ statusRetentionDays: 30 }), {
      retired: 0,
      failed: [],
      failures: [],
    });

    await expire(fixture.obligation.reporting_obligation_id);
    // A recent publication on another period keeps that period, even when
    // the period itself ended long ago and no worker holds it.
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - INTERVAL '40 days', period_end = period_end - INTERVAL '40 days',
              state = 'terminal', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [retained.obligation.reporting_obligation_id]
    );
    const result = await store.retireExpiredPeriods({ statusRetentionDays: 30 });
    assert.deepEqual(result, { retired: 1, failed: [], failures: [] });

    const obligationId = fixture.obligation.reporting_obligation_id;
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_obligations WHERE obligation_id = $1`, [obligationId]),
      0
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_revisions WHERE obligation_id = $1`, [obligationId]),
      0
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE obligation_id = $1`, [obligationId]),
      0
    );
    assert.ok(
      objectKeys.every(file => !existsSync(file)),
      'external row objects are deleted'
    );
    const tombstone = (
      await pool.query(`SELECT * FROM adcp_reporting_obligation_tombstones WHERE obligation_id = $1`, [obligationId])
    ).rows[0];
    assert.equal(tombstone.state, 'retired');
    assert.equal(tombstone.final_revision_id, 'rrev_retired_2');
    assert.equal(tombstone.revision_count, 2);
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_obligations WHERE obligation_id = $1`, [
        retained.obligation.reporting_obligation_id,
      ]),
      1
    );

    assert.deepEqual(await store.listRetiredObligationOrdinals(fixture.request.account.account_id), [
      { configurationId: fixture.configuration.configurationId, periodOrdinal: 0 },
    ]);
    await assert.rejects(() => store.putObligation(fixture.obligation), ledger.ReportingLedgerPeriodRetiredError);
    assert.equal(await store.getRevision('rrev_retired_2', fixture.request.account.account_id), null);
  });

  test('resumes a retirement interrupted after its tombstone', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'resume' });
    await store.commitRevision(fixture.revision('rrev_resume_1', 1, rows), fixture.lease);
    await expire(fixture.obligation.reporting_obligation_id);
    const unconfigured = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    // Without the object binding the store cannot delete the bytes: phase 1
    // commits, phase 2 fails, and the period stays retiring.
    const first = await unconfigured.retireExpiredPeriods({ statusRetentionDays: 30 });
    assert.deepEqual(first, {
      retired: 0,
      failed: [fixture.obligation.reporting_obligation_id],
      failures: [{ reporting_obligation_id: fixture.obligation.reporting_obligation_id, cause: 'STATE_UNAVAILABLE' }],
    });
    await assert.rejects(
      () => store.getRevision('rrev_resume_1', fixture.request.account.account_id),
      error => ledger.isReportingRowStoreError(error) && error.code === 'ROWS_EXPIRED'
    );
    const resumed = await store.retireExpiredPeriods({ statusRetentionDays: 30 });
    assert.equal(resumed.retired, 1);
    assert.equal(
      (
        await pool.query(`SELECT state FROM adcp_reporting_obligation_tombstones WHERE obligation_id = $1`, [
          fixture.obligation.reporting_obligation_id,
        ])
      ).rows[0].state,
      'retired'
    );
  });

  test('sweeps only objects an abandoned upload created and nothing a commit references', async () => {
    const engine = new ledger.ReportingRowStorageV1(pool, rowStorage);
    await engine.ready();
    const { namespaceKey } = engine.installationIdentity;
    const provider = rowStorage.providers.filesystem;
    const location = { location: { root: 'rows' } };
    const put = async name => {
      const key = `retained/${namespaceKey}/sweep/${name}.jsonl`;
      const result = await provider.putIfAbsent(
        { ...location, key, bytes: Buffer.from('{"a":1}\n'), contentType: 'application/x-ndjson', metadata: {} },
        { signal: AbortSignal.timeout(5_000) }
      );
      return { objectKey: key, nativeVersion: result.nativeVersion };
    };
    const orphan = await put('orphan');
    const fresh = await put('fresh');
    const fixture = await createRowStorageFixture({ store, suffix: 'sweep' });
    await store.commitRevision(fixture.revision('rrev_sweep_1', 1, rows), fixture.lease);
    const committed = (
      await pool.query(
        `SELECT object_key, native_version FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_sweep_1'`
      )
    ).rows[0];
    const intent = async (rowSetId, objects, expiresSql) =>
      pool.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
         VALUES ('objects', $1, $2, $3, 'open', 'owner', $4::jsonb, ${expiresSql})`,
        [fixture.request.account.account_id, rowSetId, 'c'.repeat(64), JSON.stringify(objects)]
      );
    await intent(
      'rrev_abandoned',
      [orphan, { objectKey: committed.object_key, nativeVersion: committed.native_version }],
      `clock_timestamp() - INTERVAL '1 minute'`
    );
    await intent('rrev_in_flight', [fresh], `clock_timestamp() + INTERVAL '1 hour'`);

    const swept = await store.sweepRowWriteIntents();
    assert.deepEqual(swept, { swept: 1, objectsDeleted: 1, failed: 0 });
    assert.equal(existsSync(path.join(root, orphan.objectKey)), false);
    assert.equal(existsSync(path.join(root, committed.object_key)), true, 'committed objects are never swept');
    assert.equal(existsSync(path.join(root, fresh.objectKey)), true, 'unexpired uploads are left alone');
    assert.deepEqual(
      (await pool.query('SELECT row_set_id FROM adcp_reporting_row_write_intents')).rows.map(row => row.row_set_id),
      ['rrev_in_flight']
    );
    assert.deepEqual((await store.getRevision('rrev_sweep_1', fixture.request.account.account_id)).rows, rows);
  });
});

describe(
  'reporting retention holds for change-feed consumers',
  { skip: !DATABASE_URL && 'PostgreSQL URL not set' },
  () => {
    const schema = `adcp_reporting_retention_feed_${process.pid}`;
    let bootstrapPool;
    let pool;
    let ledger;
    let root;
    let store;
    const rows = Array.from({ length: 5 }, (_, index) => ({ ordinal: index, value: index }));
    const count = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n);

    async function expire(obligationId, days = 40) {
      await pool.query(
        `UPDATE adcp_reporting_obligations
          SET period_start = period_start - ($2::integer * INTERVAL '1 day'),
              period_end = period_end - ($2::integer * INTERVAL '1 day'),
              created_at = created_at - ($2::integer * INTERVAL '1 day'),
              lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
        [obligationId, days]
      );
      await pool.query(
        `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - ($2::integer * INTERVAL '1 day')
        WHERE obligation_id = $1`,
        [obligationId, days]
      );
    }

    /** Cursor at the end of the feed: a consumer saved here has read every change so far. */
    async function head(accountId) {
      let cursor;
      for (;;) {
        const page = await store.changesAfter({
          ...(accountId ? { account_id: accountId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        cursor = page.cursor;
        if (page.records.length === 0) return cursor;
      }
    }

    /**
     * Cursor after the feed has delivered the published revision. Earlier
     * obligation changes do not prove that the revision has been delivered. The
     * deployment-wide feed withholds changes while another transaction (other
     * suites share the server) is in flight, so wait for it to appear.
     */
    async function headPast(accountId, revisionId) {
      let cursor;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const page = await store.changesAfter({
          ...(accountId ? { account_id: accountId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        cursor = page.cursor;
        if (page.records.some(record => record.kind === 'revision' && record.record_id === revisionId)) {
          return head(accountId);
        }
        if (page.records.length === 0) await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('the feed never delivered the revision change');
    }

    const periodExists = async obligationId =>
      (await count(`SELECT count(*) AS n FROM adcp_reporting_obligations WHERE obligation_id = $1`, [obligationId])) ===
      1;

    before(async () => {
      const { Pool } = require('pg');
      ledger = require('../../dist/lib/reporting/ledger/index.js');
      root = mkdtempSync(path.join(tmpdir(), 'adcp-retention-feed-'));
      bootstrapPool = new Pool({ connectionString: DATABASE_URL });
      await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
      await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
      await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
      const rowStorage = {
        bindings: {
          objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'retained' },
        },
        providers: { filesystem: ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } }) },
      };
      store = new ledger.PostgresReportingLedgerStore(pool, {
        acknowledgeIsolatedDatabase: true,
        rowStorage,
        changeFeed: true,
      });
      await store.readyRowStorage();
    });

    after(async () => {
      if (pool) await pool.end();
      if (bootstrapPool) {
        await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await bootstrapPool.end();
      }
      if (root) rmSync(root, { recursive: true, force: true });
    });

    for (const kind of ['account', 'deployment']) {
      test(`holds an expired period for an unread ${kind} consumer, then retires it`, async () => {
        const fixture = await createRowStorageFixture({ store, suffix: `hold_${kind}` });
        const accountId = fixture.request.account.account_id;
        const obligationId = fixture.obligation.reporting_obligation_id;
        const scope = kind === 'account' ? accountId : undefined;
        // The consumer is registered before the period's changes exist.
        await pool.query('DELETE FROM adcp_reporting_feed_consumers');
        await store.saveFeedConsumerCursor('sink', await head(scope));
        await store.commitRevision(fixture.revision(`rrev_hold_${kind}_1`, 1, rows), fixture.lease);
        await expire(obligationId);

        // Fresh consumer, changes unread: the expired period is held, not failed.
        assert.deepEqual(await store.retireExpiredPeriods({ statusRetentionDays: 30 }), {
          retired: 0,
          failed: [],
          failures: [],
        });
        assert.ok(await periodExists(obligationId));
        assert.equal((await store.getRevision(`rrev_hold_${kind}_1`, accountId)).rows.length, 5);

        // The consumer passes the period's changes: it is released.
        await store.saveFeedConsumerCursor('sink', await headPast(scope, `rrev_hold_${kind}_1`));
        assert.deepEqual(await store.retireExpiredPeriods({ statusRetentionDays: 30 }), {
          retired: 1,
          failed: [],
          failures: [],
        });
        assert.equal(await periodExists(obligationId), false);
      });

      test(`retires a held period once the ${kind} consumer is stale beyond maxFeedHoldDays`, async () => {
        const fixture = await createRowStorageFixture({ store, suffix: `stale_${kind}` });
        const obligationId = fixture.obligation.reporting_obligation_id;
        const scope = kind === 'account' ? fixture.request.account.account_id : undefined;
        await pool.query('DELETE FROM adcp_reporting_feed_consumers');
        await store.saveFeedConsumerCursor('sink', await head(scope));
        await store.commitRevision(fixture.revision(`rrev_stale_${kind}_1`, 1, rows), fixture.lease);
        await expire(obligationId);
        assert.equal((await store.retireExpiredPeriods({ statusRetentionDays: 30 })).retired, 0);

        await pool.query(
          `UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '10 days'`
        );
        // Still live under a longer hold window.
        assert.equal((await store.retireExpiredPeriods({ statusRetentionDays: 30, maxFeedHoldDays: 30 })).retired, 0);
        assert.ok(await periodExists(obligationId));
        // Default hold is 7 days: the dead consumer no longer blocks retention.
        assert.deepEqual(await store.retireExpiredPeriods({ statusRetentionDays: 30 }), {
          retired: 1,
          failed: [],
          failures: [],
        });
        assert.equal(await periodExists(obligationId), false);
      });
    }

    test('an account consumer does not hold another account, and a non-positive hold is refused', async () => {
      const fixture = await createRowStorageFixture({ store, suffix: 'other_account' });
      const obligationId = fixture.obligation.reporting_obligation_id;
      await pool.query('DELETE FROM adcp_reporting_feed_consumers');
      await store.saveFeedConsumerCursor('elsewhere', await head('some-other-account'));
      await store.commitRevision(fixture.revision('rrev_other_account_1', 1, rows), fixture.lease);
      await expire(obligationId);
      assert.equal((await store.retireExpiredPeriods({ statusRetentionDays: 30 })).retired, 1);
      await assert.rejects(
        () => store.retireExpiredPeriods({ statusRetentionDays: 30, maxFeedHoldDays: 0 }),
        RangeError
      );
      await pool.query('DELETE FROM adcp_reporting_feed_consumers');
    });
  }
);
