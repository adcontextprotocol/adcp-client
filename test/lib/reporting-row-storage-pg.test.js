/**
 * PostgreSQL integration tests for chunked revision row storage.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-row-storage-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('PostgresReportingLedgerStore row storage', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_rows_pg_${process.pid}`;
  let bootstrapPool;
  let pool;
  let store;
  let ledger;
  let canonicalize;
  let request;
  let obligation;
  let lease;
  const now = Date.now();

  const rows = Array.from({ length: 1_200 }, (_, index) => ({
    ordinal: index,
    label: index % 7 === 0 ? `café 😀 ${index}` : `row-${index}`,
    impressions: index * 3,
    viewable_rate: index / 1_000,
  }));

  function binding(id, value, controlTotals = []) {
    const bytes = Buffer.from(
      canonicalize({
        reporting_revision_id: id,
        row_count: value.length,
        control_totals: controlTotals,
        reporting_rows: value,
      })
    );
    return {
      algorithm: 'rfc8785_jcs_v1',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteCount: bytes.byteLength,
      rowCount: value.length,
    };
  }

  function revision(id, revisionNumber, value, extra = {}) {
    const bound = binding(id, value);
    return {
      reporting_revision_id: id,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber,
      finality: 'snapshot',
      kind: 'snapshot',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-${id}`,
      binding: bound,
      rows: value,
      observedAt: new Date(now + revisionNumber).toISOString(),
      dataThrough: new Date(now - 1_000).toISOString(),
      sourceReadCutoffAt: new Date(now + revisionNumber).toISOString(),
      createdAt: new Date(now).toISOString(),
      wireRevision: { reporting_revision_id: id, revision_content_sha256: bound.sha256, control_totals: [] },
      ...extra,
    };
  }

  const count = async (table, where = 'TRUE', values = []) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values)).rows[0].n);

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    canonicalize = require('../../dist/lib/utils/jcs.js').canonicalize;
    const source = require('../../dist/lib/reporting/source/index.js');
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, rowStorage: true });
    await store.readyRowStorage();

    request = source.redactedReportingSourceRequestV1();
    const configuration = {
      configurationId: 'rcfg_rows',
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: new Date(now - 3_600_000).toISOString(),
        periodMilliseconds: 3_600_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 3_600_000,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
      installedAt: new Date(now - 3_600_000).toISOString(),
      semanticFingerprint: 'sha256:configuration-rows',
    };
    await store.putConfiguration(configuration);
    obligation = {
      reporting_obligation_id: 'robl_rows',
      configurationId: configuration.configurationId,
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      periodOrdinal: 0,
      period: {
        start: new Date(now - 3_600_000).toISOString(),
        end: new Date(now - 1_000).toISOString(),
        sourceTimezone: 'UTC',
      },
      schedule: configuration.schedule,
      scopeResolvedAt: new Date(now - 1_000).toISOString(),
      coverage: {
        status: 'full',
        evaluatedAt: new Date(now - 1_000).toISOString(),
        mediaBuyIds: request.coverage.mediaBuyIds,
        fullyCoveredMediaBuyIds: request.coverage.mediaBuyIds,
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceSettings: request.sourceSettings,
      contract: request.contract,
      expectedAt: new Date(now - 1_000).toISOString(),
      recoveryDeadlineAt: new Date(now + 3_600_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: new Date(now - 1_000).toISOString(),
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: 'sha256:obligation-rows',
      createdAt: new Date(now).toISOString(),
    };
    await store.putObligation(obligation);
    lease = await store.claimObligation({
      owner: 'rows-worker',
      now: new Date(now).toISOString(),
      leaseMilliseconds: 600_000,
    });
    assert.ok(lease);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
  });

  test('stores verified chunks instead of inline rows and serves exact pages', async () => {
    const first = revision('rrev_rows_1', 1, rows);
    const committed = await store.commitRevision(first, lease);
    assert.equal(committed.inserted, true);
    assert.deepEqual(committed.value.rows, rows, 'the commit result still carries the rows');
    assert.equal(
      (
        await pool.query(`SELECT data ? 'rows' AS inline FROM adcp_reporting_revisions WHERE revision_id = $1`, [
          first.reporting_revision_id,
        ])
      ).rows[0].inline,
      false
    );
    assert.equal(await count('adcp_reporting_row_sets', 'row_set_id = $1', [first.reporting_revision_id]), 1);
    const chunks = await pool.query(
      `SELECT jsonb_array_length(segments) AS segments FROM adcp_reporting_row_chunks WHERE row_set_id = $1`,
      [first.reporting_revision_id]
    );
    assert.deepEqual(
      chunks.rows.map(row => row.segments),
      [3]
    );

    const replay = await store.commitRevision(first, lease);
    assert.equal(replay.inserted, false);
    assert.deepEqual(replay.value.rows, rows);
    assert.deepEqual((await store.getRevision(first.reporting_revision_id, request.account.account_id)).rows, rows);
    assert.deepEqual((await store.listRevisions(obligation.reporting_obligation_id))[0].rows, rows);
    assert.deepEqual(
      await store.readRevisionRows({
        reporting_revision_id: first.reporting_revision_id,
        account_id: request.account.account_id,
        offset: 450,
        limit: 100,
      }),
      { rows: rows.slice(450, 550), total: rows.length },
      'a page that crosses a segment boundary verifies both segments'
    );
    assert.equal(
      await store.readRevisionRows({
        reporting_revision_id: first.reporting_revision_id,
        account_id: 'acct_other',
        offset: 0,
        limit: 10,
      }),
      null
    );

    const deliver = ledger.createReportingDeliveryHandler(store);
    const paged = [];
    let cursor;
    do {
      const page = await deliver(
        {
          account: request.account,
          reporting_revision_id: first.reporting_revision_id,
          pagination: { max_results: 500, ...(cursor ? { cursor } : {}) },
        },
        { account: { account_id: request.account.account_id } }
      );
      assert.equal(page.pagination.total_count, rows.length);
      paged.push(...page.reporting_rows);
      cursor = page.pagination.cursor;
    } while (cursor);
    assert.deepEqual(paged, rows);
  });

  test('repeated rows within an obligation share one body', async () => {
    const bodiesBefore = await count('adcp_reporting_chunk_bodies');
    const second = revision('rrev_rows_2', 2, rows, { supersedes_reporting_revision_id: 'rrev_rows_1' });
    assert.equal((await store.commitRevision(second, lease)).inserted, true);
    assert.equal(await count('adcp_reporting_chunk_bodies'), bodiesBefore);
    assert.equal(
      (
        await pool.query(
          `SELECT rows_shared_from_row_set_id AS shared FROM adcp_reporting_row_sets WHERE row_set_id = 'rrev_rows_2'`
        )
      ).rows[0].shared,
      'rrev_rows_1',
      'a header-only revision records the row set it repeats'
    );
    assert.deepEqual((await store.getRevision('rrev_rows_2', request.account.account_id)).rows, rows);
  });

  test('stores adjustment rows under the rows_v1 profile', async () => {
    const officialRows = rows.slice(0, 5);
    const official = revision('rrev_rows_3', 3, officialRows, {
      supersedes_reporting_revision_id: 'rrev_rows_2',
      finality: 'official',
      kind: 'official',
    });
    assert.equal((await store.commitRevision(official, lease)).inserted, true);
    const correctedRows = officialRows.map(row => ({ ...row, impressions: row.impressions + 1 }));
    const bytes = Buffer.from(canonicalize(correctedRows));
    const adjustment = {
      reporting_adjustment_id: 'radj_rows_1',
      reporting_obligation_id: obligation.reporting_obligation_id,
      adjusts_reporting_revision_id: official.reporting_revision_id,
      adjustmentNumber: 1,
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'b'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'publication-radj-rows-1',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength,
        rowCount: correctedRows.length,
      },
      rows: correctedRows,
      observedAt: new Date(now + 10).toISOString(),
      dataThrough: new Date(now - 1_000).toISOString(),
      sourceReadCutoffAt: new Date(now + 10).toISOString(),
      createdAt: new Date(now).toISOString(),
      wireAdjustment: { reporting_adjustment_id: 'radj_rows_1', control_total_deltas: [] },
    };
    const committed = await store.commitAdjustment(adjustment, lease);
    assert.equal(committed.inserted, true);
    assert.equal(
      (await pool.query(`SELECT digest_profile FROM adcp_reporting_row_sets WHERE row_set_id = 'radj_rows_1'`)).rows[0]
        .digest_profile,
      'rows_v1'
    );
    assert.deepEqual((await store.listAdjustments(obligation.reporting_obligation_id))[0].rows, correctedRows);
  });

  test('fails closed on tampered manifests, lost bodies and expired rows', async () => {
    const accountId = request.account.account_id;
    const rowStoreCode = async (operation, code) =>
      assert.rejects(operation, error => ledger.isReportingRowStoreError(error) && error.code === code);
    const deliver = ledger.createReportingDeliveryHandler(store);
    const context = { account: { account_id: accountId } };
    const read = id => deliver({ account: request.account, reporting_revision_id: id }, context);

    await pool.query('ALTER TABLE adcp_reporting_row_chunks DISABLE TRIGGER adcp_reporting_row_chunks_immutable');
    const original = (
      await pool.query(`SELECT segments FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_rows_2'`)
    ).rows[0].segments;
    const tampered = structuredClone(original);
    tampered[1].sha256 = 'f'.repeat(64);
    await pool.query(`UPDATE adcp_reporting_row_chunks SET segments = $1::jsonb WHERE row_set_id = 'rrev_rows_2'`, [
      JSON.stringify(tampered),
    ]);
    await rowStoreCode(() => store.getRevision('rrev_rows_2', accountId), 'ROWS_INTEGRITY_FAILED');
    await assert.rejects(
      () => read('rrev_rows_2'),
      error => error.code === 'SERVICE_UNAVAILABLE'
    );
    await pool.query(`UPDATE adcp_reporting_row_chunks SET segments = $1::jsonb WHERE row_set_id = 'rrev_rows_2'`, [
      JSON.stringify(original),
    ]);
    await pool.query('ALTER TABLE adcp_reporting_row_chunks ENABLE TRIGGER adcp_reporting_row_chunks_immutable');

    await pool.query(
      `UPDATE adcp_reporting_row_sets SET rows_state = 'pruned', rows_state_changed_at = clock_timestamp()
        WHERE row_set_id = 'rrev_rows_1'`
    );
    await rowStoreCode(() => store.getRevision('rrev_rows_1', accountId), 'ROWS_EXPIRED');
    await assert.rejects(
      () => read('rrev_rows_1'),
      error => error.code === 'REFERENCE_NOT_FOUND' && error.field === 'reporting_revision_id'
    );

    await pool.query(`DELETE FROM adcp_reporting_chunk_bodies WHERE obligation_id = $1`, [
      obligation.reporting_obligation_id,
    ]);
    await rowStoreCode(() => store.getRevision('rrev_rows_2', accountId), 'ROWS_UNAVAILABLE');
    await assert.rejects(
      () => read('rrev_rows_2'),
      error => error.code === 'SERVICE_UNAVAILABLE'
    );
    const status = await ledger.createReportingStatusHandler(store)(
      { account: request.account, view: 'revision', reporting_revision_id: 'rrev_rows_2' },
      context
    );
    assert.equal('reporting_rows' in status, false);
  });

  test('migrates inline rows in resumable batches and quarantines unverifiable documents', async () => {
    const inlineStore = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    const inlineObligation = {
      ...obligation,
      reporting_obligation_id: 'robl_rows_inline',
      periodOrdinal: 1,
      semanticFingerprint: 'sha256:obligation-rows-inline',
    };
    await inlineStore.putObligation(inlineObligation);
    const inlineLease = await inlineStore.claimObligation({
      owner: 'inline-worker',
      now: new Date(now).toISOString(),
      leaseMilliseconds: 600_000,
    });
    assert.equal(inlineLease.obligation.reporting_obligation_id, 'robl_rows_inline');
    const previous = obligation;
    obligation = inlineObligation;
    const legacyRows = rows.slice(0, 600);
    try {
      for (const [index, id] of ['rrev_inline_1', 'rrev_inline_2', 'rrev_inline_3'].entries()) {
        await inlineStore.commitRevision(
          revision(
            id,
            index + 1,
            legacyRows,
            index ? { supersedes_reporting_revision_id: `rrev_inline_${index}` } : {}
          ),
          inlineLease
        );
      }
    } finally {
      obligation = previous;
    }
    // A document whose rows no longer reproduce its binding is never rewritten.
    await pool.query(
      `UPDATE adcp_reporting_revisions SET data = jsonb_set(data, '{rows,0,impressions}', '999999')
        WHERE revision_id = 'rrev_inline_2'`
    );

    let cursor;
    let migrated = 0;
    const quarantined = [];
    do {
      const batch = await store.migrateInlineRows({ limit: 1, cursor, account_id: request.account.account_id });
      migrated += batch.migrated;
      quarantined.push(...batch.quarantined);
      cursor = batch.cursor;
    } while (cursor);
    assert.equal(migrated, 2);
    assert.deepEqual(quarantined, ['rrev_inline_2']);
    const inline = await pool.query(
      `SELECT revision_id, data ? 'rows' AS inline FROM adcp_reporting_revisions
        WHERE obligation_id = 'robl_rows_inline' ORDER BY revision_number`
    );
    assert.deepEqual(
      inline.rows.map(row => [row.revision_id, row.inline]),
      [
        ['rrev_inline_1', false],
        ['rrev_inline_2', true],
        ['rrev_inline_3', false],
      ]
    );
    for (const id of ['rrev_inline_1', 'rrev_inline_3']) {
      assert.deepEqual((await store.getRevision(id, request.account.account_id)).rows, legacyRows);
    }
    assert.equal((await store.migrateInlineRows({ account_id: request.account.account_id })).migrated, 0);
  });

  test('migrates inline adjustment rows under the rows_v1 profile', async () => {
    const inlineStore = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    const adjustedObligation = {
      ...obligation,
      reporting_obligation_id: 'robl_rows_adjusted',
      periodOrdinal: 2,
      semanticFingerprint: 'sha256:obligation-rows-adjusted',
    };
    await inlineStore.putObligation(adjustedObligation);
    const adjustedLease = await inlineStore.claimObligation({
      owner: 'adjusted-worker',
      now: new Date(now).toISOString(),
      leaseMilliseconds: 600_000,
    });
    assert.equal(adjustedLease.obligation.reporting_obligation_id, 'robl_rows_adjusted');
    const previous = obligation;
    obligation = adjustedObligation;
    const officialRows = rows.slice(0, 4);
    try {
      await inlineStore.commitRevision(
        revision('rrev_adjusted_official', 1, officialRows, { finality: 'official', kind: 'official' }),
        adjustedLease
      );
    } finally {
      obligation = previous;
    }
    const correctedRows = officialRows.map(row => ({ ...row, impressions: row.impressions + 10 }));
    const bytes = Buffer.from(canonicalize(correctedRows));
    await inlineStore.commitAdjustment(
      {
        reporting_adjustment_id: 'radj_inline_1',
        reporting_obligation_id: adjustedObligation.reporting_obligation_id,
        adjusts_reporting_revision_id: 'rrev_adjusted_official',
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'publication-radj-inline-1',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: correctedRows.length,
        },
        rows: correctedRows,
        observedAt: new Date(now + 20).toISOString(),
        dataThrough: new Date(now - 1_000).toISOString(),
        sourceReadCutoffAt: new Date(now + 20).toISOString(),
        createdAt: new Date(now).toISOString(),
        wireAdjustment: { reporting_adjustment_id: 'radj_inline_1', control_total_deltas: [] },
      },
      adjustedLease
    );

    let cursor;
    let migrated = 0;
    do {
      const batch = await store.migrateInlineRows({ cursor, account_id: request.account.account_id });
      // rrev_inline_2 was deliberately left unverifiable by the previous test.
      assert.deepEqual(
        batch.quarantined.filter(id => id !== 'rrev_inline_2'),
        []
      );
      migrated += batch.migrated;
      cursor = batch.cursor;
    } while (cursor);
    assert.ok(migrated >= 2, 'the official revision and its adjustment migrate');
    const rowSet = (
      await pool.query(
        `SELECT row_set_kind, digest_profile, row_count FROM adcp_reporting_row_sets WHERE row_set_id = 'radj_inline_1'`
      )
    ).rows[0];
    assert.deepEqual(rowSet, { row_set_kind: 'adjustment', digest_profile: 'rows_v1', row_count: '4' });
    assert.equal(
      (
        await pool.query(
          `SELECT data ? 'rows' AS inline FROM adcp_reporting_adjustments WHERE adjustment_id = 'radj_inline_1'`
        )
      ).rows[0].inline,
      false
    );
    assert.deepEqual(
      (await store.listAdjustments(adjustedObligation.reporting_obligation_id)).map(value => value.rows),
      [correctedRows]
    );
  });

  test('refuses a binding registered by another deployment namespace', async () => {
    const other = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: { deploymentNamespace: 'another-deployment' },
    });
    await assert.rejects(
      () => other.readyRowStorage(),
      error => ledger.isReportingRowStoreError(error) && error.code === 'UNSAFE_BINDING'
    );
  });
});
