/**
 * PostgreSQL integration tests for seller reporting ledger fencing and snapshot isolation.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-ledger-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('PostgresReportingLedgerStore', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_ledger_test_${process.pid}`;
  let bootstrapPool;
  let pool;
  let store;
  let canonicalize;
  let ReportingLedgerContinuityError;
  let ReportingLedgerLeaseLostError;
  let ReportingLedgerSnapshotUnavailableError;
  let sweepExpiredReportingLedgerState;

  before(async () => {
    const { Pool } = require('pg');
    const ledger = require('../../dist/lib/reporting/ledger/index.js');
    canonicalize = require('../../dist/lib/utils/jcs.js').canonicalize;
    ReportingLedgerContinuityError = ledger.ReportingLedgerContinuityError;
    ReportingLedgerLeaseLostError = ledger.ReportingLedgerLeaseLostError;
    ReportingLedgerSnapshotUnavailableError = ledger.ReportingLedgerSnapshotUnavailableError;
    sweepExpiredReportingLedgerState = ledger.sweepExpiredReportingLedgerState;
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
  });

  test('fences stale workers and binds stored rows before snapshot reads', async () => {
    const source = require('../../dist/lib/reporting/source/index.js');
    const request = source.redactedReportingSourceRequestV1();
    const now = Date.now();
    const configuration = {
      configurationId: 'rcfg_pg_fixture',
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
      semanticFingerprint: 'sha256:configuration',
    };
    await store.putConfiguration(configuration);
    const obligation = {
      reporting_obligation_id: 'robl_pg_fixture',
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
      semanticFingerprint: 'sha256:obligation',
      createdAt: new Date(now).toISOString(),
    };
    await store.putObligation(obligation);

    const first = await store.claimObligation({
      owner: 'worker-one',
      now: new Date(now).toISOString(),
      leaseMilliseconds: 60_000,
    });
    assert.ok(first);
    const competing = await store.claimObligation({
      owner: 'worker-two',
      now: new Date(now).toISOString(),
      leaseMilliseconds: 60_000,
    });
    assert.equal(competing, null);
    await pool.query(
      `UPDATE adcp_reporting_obligations SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE obligation_id = $1`,
      [obligation.reporting_obligation_id]
    );
    const second = await store.claimObligation({
      owner: 'worker-two',
      now: new Date(now).toISOString(),
      leaseMilliseconds: 60_000,
    });
    assert.ok(second);

    const rows = [{ media_buy_id: request.coverage.mediaBuyIds[0], impressions: 0, viewable_rate: 0.875 }];
    const bytes = Buffer.from(
      canonicalize({
        reporting_revision_id: 'rrev_pg_fixture',
        row_count: rows.length,
        control_totals: [],
        reporting_rows: rows,
      })
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const revision = {
      reporting_revision_id: 'rrev_pg_fixture',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      kind: 'snapshot',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'publication-pg-fixture',
      binding: { algorithm: 'rfc8785_jcs_v1', sha256, byteCount: bytes.byteLength, rowCount: rows.length },
      rows,
      observedAt: new Date(now).toISOString(),
      dataThrough: new Date(now - 1_000).toISOString(),
      sourceReadCutoffAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      wireRevision: {
        reporting_revision_id: 'rrev_pg_fixture',
        revision_content_sha256: sha256,
        control_totals: [],
      },
    };
    await assert.rejects(() => store.commitRevision(revision, first), ReportingLedgerLeaseLostError);
    await assert.rejects(
      () =>
        store.commitRevision(revision, {
          ...second,
          obligation: { ...second.obligation, reporting_obligation_id: 'robl_pg_other' },
        }),
      ReportingLedgerLeaseLostError
    );
    const committed = await store.commitRevision(revision, second);
    assert.equal(committed.inserted, true);
    const staleFailureIssue = {
      issueId: 'rpti_pg_stale_worker_failure',
      reporting_obligation_id: obligation.reporting_obligation_id,
      code: 'PRODUCTION_FAILED',
      severity: 'delayed',
      responsibleParty: 'seller',
      recommendedAction: 'wait_for_retry',
      openedAt: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    };
    await assert.rejects(
      () =>
        store.updateObligation(
          { ...first.obligation, attemptCount: first.obligation.attemptCount + 1 },
          first,
          staleFailureIssue
        ),
      ReportingLedgerLeaseLostError
    );
    assert.equal(
      (await store.listIssues(obligation.reporting_obligation_id)).some(
        value => value.issueId === staleFailureIssue.issueId
      ),
      false,
      'an expired worker cannot reopen a production issue after its replacement commits'
    );
    const exactHandler = require('../../dist/lib/reporting/ledger/index.js').createReportingStatusHandler(store);
    const exact = await exactHandler(
      {
        account: request.account,
        view: 'revision',
        reporting_revision_id: revision.reporting_revision_id,
      },
      { account: { account_id: request.account.account_id } }
    );
    assert.equal(exact.revision.reporting_revision_id, revision.reporting_revision_id);
    assert.deepEqual(exact.reporting_rows, rows);
    await assert.rejects(
      () => store.commitRevision({ ...revision, finality: 'official', kind: 'official' }, second),
      /transaction failed/
    );
    const officialId = 'rrev_pg_fixture_official';
    const officialBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: officialId,
        row_count: rows.length,
        control_totals: [],
        reporting_rows: rows,
      })
    );
    const officialSha256 = createHash('sha256').update(officialBytes).digest('hex');
    const official = {
      ...revision,
      reporting_revision_id: officialId,
      revisionNumber: 2,
      finality: 'official',
      kind: 'official',
      supersedes_reporting_revision_id: revision.reporting_revision_id,
      sourcePublicationId: 'publication-pg-fixture-official',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: officialSha256,
        byteCount: officialBytes.byteLength,
        rowCount: rows.length,
      },
      wireRevision: {
        ...revision.wireRevision,
        reporting_revision_id: officialId,
        revision_content_sha256: officialSha256,
      },
    };
    assert.equal((await store.commitRevision(official, second)).inserted, true);
    const afterOfficialId = 'rrev_pg_fixture_after_official';
    const afterOfficialBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: afterOfficialId,
        row_count: rows.length,
        control_totals: [],
        reporting_rows: rows,
      })
    );
    const afterOfficialSha256 = createHash('sha256').update(afterOfficialBytes).digest('hex');
    await assert.rejects(
      () =>
        store.commitRevision(
          {
            ...revision,
            reporting_revision_id: afterOfficialId,
            revisionNumber: 3,
            supersedes_reporting_revision_id: officialId,
            binding: {
              algorithm: 'rfc8785_jcs_v1',
              sha256: afterOfficialSha256,
              byteCount: afterOfficialBytes.byteLength,
              rowCount: rows.length,
            },
            wireRevision: {
              ...revision.wireRevision,
              reporting_revision_id: afterOfficialId,
              revision_content_sha256: afterOfficialSha256,
            },
          },
          second
        ),
      ReportingLedgerContinuityError
    );

    const issue = {
      issueId: 'rpti_pg_fixture',
      reporting_obligation_id: obligation.reporting_obligation_id,
      code: 'PRODUCTION_FAILED',
      severity: 'delayed',
      responsibleParty: 'seller',
      recommendedAction: 'wait_for_retry',
      openedAt: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    };
    await store.putIssue(issue);
    await store.resolveIssue(issue.issueId, new Date(now + 1).toISOString());
    await store.putIssue({ ...issue, observedAt: new Date(now + 2).toISOString() });
    assert.equal((await store.listIssues(obligation.reporting_obligation_id)).at(-1).resolvedAt, undefined);
    await store.resolveIssue(issue.issueId, new Date(now + 3).toISOString());
    assert.equal(
      (await store.listIssues(obligation.reporting_obligation_id)).at(-1).resolvedAt,
      new Date(now + 3).toISOString()
    );

    const competingTransitions = await Promise.all(
      ['delayed', 'complete'].map((health, index) =>
        store.appendTransition({
          transitionId: `rst_pg_competing_${index}`,
          reporting_obligation_id: obligation.reporting_obligation_id,
          previousHealth: 'waiting',
          health,
          issueIds: [],
          occurredAt: new Date(now + 10 + index).toISOString(),
        })
      )
    );
    assert.equal(
      competingTransitions.filter(value => value.inserted).length,
      1,
      'only one transition may advance a predecessor health state'
    );
    const firstTransition = (await store.listTransitions(obligation.reporting_obligation_id))[0];
    assert.equal(
      (
        await store.appendTransition({
          transitionId: 'rst_pg_same_timestamp_successor',
          reporting_obligation_id: obligation.reporting_obligation_id,
          previousHealth: firstTransition.health,
          health: 'action_required',
          issueIds: [],
          occurredAt: firstTransition.occurredAt,
        })
      ).inserted,
      true
    );
    assert.equal((await store.listTransitions(obligation.reporting_obligation_id)).at(-1).health, 'action_required');

    const upgradeAccount = { account_id: 'account-pre-v14-finality' };
    const upgradeConfiguration = {
      ...configuration,
      configurationId: 'rcfg_pg_pre_v14_finality',
      account: upgradeAccount,
      delivery_config_id: 'delivery-pg-pre-v14-finality',
      semanticFingerprint: 'sha256:pre-v14-finality-configuration',
    };
    await store.putConfiguration(upgradeConfiguration);
    const upgradeObligation = {
      ...obligation,
      reporting_obligation_id: 'robl_pg_pre_v14_finality',
      configurationId: upgradeConfiguration.configurationId,
      account: upgradeAccount,
      delivery_config_id: upgradeConfiguration.delivery_config_id,
      semanticFingerprint: 'sha256:pre-v14-finality-obligation',
    };
    await store.putObligation(upgradeObligation);
    const snapshotCreatedAt = new Date(now + 100).toISOString();
    const legacyTransitionAt = new Date(now + 200).toISOString();
    const officialCreatedAt = new Date(now + 300).toISOString();
    const upgradeSnapshot = {
      ...revision,
      reporting_revision_id: 'rrev_pg_pre_v14_snapshot',
      reporting_obligation_id: upgradeObligation.reporting_obligation_id,
      createdAt: snapshotCreatedAt,
      wireRevision: {
        ...revision.wireRevision,
        reporting_revision_id: 'rrev_pg_pre_v14_snapshot',
      },
    };
    await pool.query(
      `INSERT INTO adcp_reporting_revisions
         (revision_id, obligation_id, revision_number, finality, kind, content_sha256, data, created_at)
       VALUES ($1, $2, 1, 'snapshot', 'snapshot', $3, $4::jsonb, $5)`,
      [
        'rrev_pg_pre_v14_snapshot',
        upgradeObligation.reporting_obligation_id,
        'pre-v14-snapshot',
        JSON.stringify(upgradeSnapshot),
        snapshotCreatedAt,
      ]
    );
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_pg_pre_v14_without_finality',
        reporting_obligation_id: upgradeObligation.reporting_obligation_id,
        previousHealth: 'waiting',
        health: 'complete',
        issueIds: [],
        occurredAt: legacyTransitionAt,
      }),
      { inserted: true }
    );
    const upgradeOfficial = {
      ...official,
      reporting_revision_id: 'rrev_pg_pre_v14_official',
      reporting_obligation_id: upgradeObligation.reporting_obligation_id,
      supersedes_reporting_revision_id: upgradeSnapshot.reporting_revision_id,
      createdAt: officialCreatedAt,
      wireRevision: {
        ...official.wireRevision,
        reporting_revision_id: 'rrev_pg_pre_v14_official',
      },
    };
    await pool.query(
      `INSERT INTO adcp_reporting_revisions
         (revision_id, obligation_id, revision_number, finality, kind, supersedes_revision_id,
          content_sha256, data, created_at)
       VALUES ($1, $2, 2, 'official', 'official', $3, $4, $5::jsonb, $6)`,
      [
        'rrev_pg_pre_v14_official',
        upgradeObligation.reporting_obligation_id,
        'rrev_pg_pre_v14_snapshot',
        'pre-v14-official',
        JSON.stringify(upgradeOfficial),
        officialCreatedAt,
      ]
    );
    // A pre-v14 row's baseline is never reconstructed, so it resolves to 'none'
    // and the store fails closed against any other claimed predecessor.
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_pg_pre_v14_reconstructed_predecessor',
        reporting_obligation_id: upgradeObligation.reporting_obligation_id,
        previousHealth: 'complete',
        health: 'complete',
        previousFinality: 'snapshot',
        finality: 'official',
        issueIds: [],
        occurredAt: new Date(now + 400).toISOString(),
      }),
      { inserted: false }
    );
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_pg_pre_v14_official_successor',
        reporting_obligation_id: upgradeObligation.reporting_obligation_id,
        previousHealth: 'complete',
        health: 'complete',
        previousFinality: 'none',
        finality: 'official',
        issueIds: [],
        occurredAt: new Date(now + 400).toISOString(),
      }),
      { inserted: true }
    );
    assert.equal(
      (await store.listTransitions(upgradeObligation.reporting_obligation_id))[0].finality,
      'none',
      'the pre-v14 row carries the committed baseline after the first resolution'
    );

    const snapshot = await store.createSnapshot({ account_id: request.account.account_id, view: 'periods' });
    assert.match(snapshot.changesCheckpoint, /^[0-9a-f-]{36}$/i);
    const page = await store.readSnapshotPage(snapshot.snapshotId, request.account.account_id, undefined, 10);
    assert.equal(page.revisions.length, 2);
    assert.equal('rows' in page.revisions[0], false, 'snapshots must not duplicate revision row payloads');
    await assert.rejects(
      () => store.readSnapshotPage(snapshot.snapshotId, 'different-account', undefined, 10),
      /unavailable/
    );
    for (const invalid of [null, 1, []]) {
      await assert.rejects(
        () =>
          store.readSnapshotPage(
            snapshot.snapshotId,
            request.account.account_id,
            Buffer.from(JSON.stringify(invalid)).toString('base64url'),
            10
          ),
        ReportingLedgerSnapshotUnavailableError
      );
    }
    await assert.rejects(
      () =>
        store.createSnapshot({
          account_id: request.account.account_id,
          view: 'periods',
          feed_purposes: ['billing'],
          changes_after: snapshot.changesCheckpoint,
        }),
      ReportingLedgerSnapshotUnavailableError
    );

    const deadlineConfiguration = {
      ...configuration,
      configurationId: 'rcfg_pg_deadline',
      delivery_config_id: `${request.delivery_config_id}-deadline`,
      schedule: { ...configuration.schedule, anchor: new Date(now - 7_200_000).toISOString() },
      installedAt: new Date(now - 7_200_000).toISOString(),
      supersededAt: new Date(now - 3_600_000).toISOString(),
      semanticFingerprint: 'sha256:deadline-configuration',
    };
    await store.putConfiguration(deadlineConfiguration);
    const expectedAt = new Date(Date.now() + 500).toISOString();
    const deadlineObligation = {
      ...obligation,
      reporting_obligation_id: 'robl_pg_deadline',
      configurationId: deadlineConfiguration.configurationId,
      delivery_config_id: deadlineConfiguration.delivery_config_id,
      period: {
        start: new Date(now - 7_200_000).toISOString(),
        end: new Date(now - 3_600_000).toISOString(),
        sourceTimezone: 'UTC',
      },
      schedule: deadlineConfiguration.schedule,
      scopeResolvedAt: new Date(now - 3_600_000).toISOString(),
      coverage: { ...obligation.coverage, evaluatedAt: new Date(now - 3_600_000).toISOString() },
      expectedAt,
      recoveryDeadlineAt: new Date(Date.parse(expectedAt) + 3_600_000).toISOString(),
      nextAttemptAt: expectedAt,
      semanticFingerprint: 'sha256:deadline-obligation',
      createdAt: new Date().toISOString(),
    };
    await store.putObligation(deadlineObligation);
    const beforeDeadline = await store.createSnapshot({ account_id: request.account.account_id, view: 'periods' });
    await new Promise(resolve => setTimeout(resolve, 700));
    const afterDeadline = await store.createSnapshot({
      account_id: request.account.account_id,
      view: 'periods',
      changes_after: beforeDeadline.changesCheckpoint,
    });
    const deadlinePage = await store.readSnapshotPage(
      afterDeadline.snapshotId,
      request.account.account_id,
      undefined,
      100
    );
    assert.equal(
      deadlinePage.obligations.some(
        value => value.reporting_obligation_id === deadlineObligation.reporting_obligation_id
      ),
      true,
      'changes_after must include health deadlines crossed without a write'
    );

    await pool.query(
      `INSERT INTO adcp_reporting_snapshots
       (snapshot_id, account_id, query_fingerprint, data, byte_count, created_at, expires_at)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, 'expired', '{}'::jsonb, 2,
               clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 minute')`,
      [request.account.account_id]
    );
    await Promise.all([
      store.createSnapshot({ account_id: request.account.account_id, view: 'periods' }),
      store.createSnapshot({ account_id: 'second-account', view: 'periods' }),
    ]);
    await pool.query(
      `INSERT INTO adcp_reporting_checkpoints
         (checkpoint_id, account_id, scope_fingerprint, ledger_as_of, expires_at)
       VALUES ('00000000-0000-4000-8000-000000000002', 'inactive-account', 'expired',
               clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 minute')`
    );
    const swept = await sweepExpiredReportingLedgerState(pool, 10);
    assert.equal(swept.checkpointsDeleted, 1);
  });
});
