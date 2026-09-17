/**
 * PostgreSQL crash/race coverage for seller Managed Delivery and Reconciled Billing.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-managed-delivery-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('PostgresReportingManagedDeliveryStore', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_managed_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let core;
  let managed;
  let fixture;
  let snapshotFixture;
  let canonicalize;
  let validateResponse;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    canonicalize = require('../../dist/lib/utils/jcs.js').canonicalize;
    validateResponse = require('../../dist/lib/validation/schema-validator.js').validateResponse;
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    await pool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
    core = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
    });
    managed = new ledger.PostgresReportingManagedDeliveryStore(pool);
    fixture = await seedCoreLedger();
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('requires an explicit same-authority Core opt-in before advertising capabilities', async () => {
    assert.deepEqual(await managed.installBinding(fixture.binding), { inserted: false });
    const pendingReceipt = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(pendingReceipt.periods[0].health, 'action_required');
    assert.equal(
      pendingReceipt.periods[0].issues.some(value => value.code === 'RECEIPT_REQUIRED'),
      true
    );
    const coreOnly = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    await assert.rejects(
      () =>
        ledger.createReportingManagedDeliveryRuntime({
          coreStore: coreOnly,
          store: managed,
          adapter: {
            verificationProfiles: ['canonical_digest'],
            revocationFencesDeliveryGenerations: true,
            deliver: async () => materializationOutcome(fixture),
            read: async () => Buffer.alloc(0),
            revoke: async () => {},
          },
          offerings: [deliveryOffering()],
          automatedRecoveryWindowSeconds: 60,
          statusRetentionDays: 90,
          resourceRetentionDays: 30,
          authorizationRevocationSeconds: 60,
        }),
      /managedDelivery: true/
    );
  });

  test('refuses a first managed binding after a Core obligation is observable', async () => {
    const accountId = 'account-late-binding';
    const configuration = {
      ...fixture.configuration,
      configurationId: 'configuration-late-binding-1',
      account: { account_id: accountId },
      delivery_config_id: 'late-binding-files',
      offeringId: 'late-binding-files-v1',
      semanticFingerprint: 'configuration-late-binding-fingerprint',
    };
    await core.putConfiguration(configuration);
    await core.putObligation({
      ...fixture.obligation,
      reporting_obligation_id: 'obligation-late-binding-1',
      configurationId: configuration.configurationId,
      account: configuration.account,
      delivery_config_id: configuration.delivery_config_id,
      offeringId: configuration.offeringId,
      semanticFingerprint: 'obligation-late-binding-fingerprint',
    });
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-late-binding-1',
      generation: 1,
      authorized_at: fixture.now,
    });
    await assert.rejects(
      () =>
        managed.installBinding(
          ledger.reportingManagedDeliveryBindingV1({
            ...fixture.binding,
            configurationId: configuration.configurationId,
            account_id: accountId,
            delivery_config_id: configuration.delivery_config_id,
            destination_ref: 'destination-late-binding-1',
          })
        ),
      /PostgresReportingManagedDeliveryStore transaction failed/
    );
  });

  test('leases one worker, retries after a crash, and retains exact verified resources', async () => {
    let attempts = 0;
    let deliveryStarted;
    let releaseFirstDelivery;
    const started = new Promise(resolve => {
      deliveryStarted = resolve;
    });
    const firstDeliveryGate = new Promise(resolve => {
      releaseFirstDelivery = resolve;
    });
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) {
          deliveryStarted();
          await firstDeliveryGate;
          throw new Error('simulated process boundary');
        }
        return materializationOutcome(fixture);
      },
      read: async () => Buffer.from('exact retained bytes'),
      revoke: async () => {},
    };
    await managed.planMaterializations();
    const firstWorker = ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(fixture.now),
      maxIterations: 1,
    });
    await started;
    const secondWorker = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(fixture.now),
      maxIterations: 1,
    });
    releaseFirstDelivery();
    const concurrent = [await firstWorker, secondWorker];
    assert.equal(
      concurrent.reduce((sum, value) => sum + value.failed, 0),
      1
    );
    assert.equal(
      concurrent.reduce((sum, value) => sum + value.delivered, 0),
      0
    );
    assert.equal(attempts, 1, 'SKIP LOCKED exposes the pending attempt to only one worker');
    const second = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(fixture.now) + 1000),
      maxIterations: 2,
    });
    assert.equal(second.delivered, 1);
    assert.equal(attempts, 2);

    const rows = await pool.query(`SELECT attempt, status, data FROM adcp_reporting_materializations ORDER BY attempt`);
    assert.deepEqual(
      rows.rows.map(row => [row.attempt, row.status]),
      [
        [1, 'failed'],
        [2, 'available'],
      ]
    );
    fixture.materialization = rows.rows[1].data;
    const bytes = await ledger.readManagedReportingResource(managed, adapter, {
      account_id: fixture.accountId,
      resource_ref: fixture.materialization.resource.resource_ref,
    });
    assert.equal(Buffer.from(bytes).toString(), 'exact retained bytes');
  });

  test('projects RC3 receipt-required state, append-only repair, and exact replay', async () => {
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: context => context.agent.agent_url,
    });
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } };
    const beforeReceipt = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    assert.equal(beforeReceipt.periods[0].reconciliation_status, 'pending');
    assert.equal(beforeReceipt.periods[0].health, 'action_required');
    assert.equal(beforeReceipt.periods[0].issues.at(-1).code, 'RECEIPT_REQUIRED');
    const filteredOut = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'periods',
        period: fixture.period,
        health: ['complete'],
      },
      context
    );
    assert.equal(filteredOut.periods.length, 0);
    assert.equal(filteredOut.pagination.total_count, 0);
    assert.equal(filteredOut.pagination.has_more, false);
    assert.equal(beforeReceipt.materializations.length, 2, 'failed attempts remain immutable history');
    assert.equal(
      validateResponse('get_reporting_status', beforeReceipt, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', beforeReceipt, '3.2.0-rc.3').issues)
    );

    const syncReceipts = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => new Date(Date.parse(fixture.now) + 2000)
    );
    const rejected = receipt(fixture, {
      reporting_receipt_id: 'receipt-rejected-0001',
      status: 'rejected',
      observed_row_count: 3,
      rejection_codes: ['ROW_COUNT_MISMATCH'],
    });
    const rejectedResult = await syncReceipts(
      { idempotency_key: 'receipt-batch-rejected-0001', receipts: [rejected] },
      context
    );
    assert.equal(rejectedResult.results[0].result, 'recorded');
    assert.equal(validateResponse('sync_reporting_receipts', rejectedResult, '3.2.0-rc.3').valid, true);

    const accepted = receipt(fixture, {
      reporting_receipt_id: 'receipt-accepted-0001',
      supersedes_reporting_receipt_id: rejected.reporting_receipt_id,
      status: 'accepted',
    });
    const acceptedRequest = { idempotency_key: 'receipt-batch-accepted-0001', receipts: [accepted] };
    const acceptedResult = await syncReceipts(acceptedRequest, context);
    assert.equal(acceptedResult.results[0].result, 'recorded');
    const replay = await syncReceipts(acceptedRequest, context);
    assert.deepEqual(replay, acceptedResult, 'same batch key replays the original result');
    const conflict = await syncReceipts(
      {
        ...acceptedRequest,
        receipts: [{ ...accepted, observed_at: new Date(Date.parse(fixture.now) + 3000).toISOString() }],
      },
      context
    );
    assert.equal(conflict.results[0].errors[0].code, 'IDEMPOTENCY_CONFLICT');
    const unchanged = await syncReceipts(
      { idempotency_key: 'receipt-batch-accepted-0002', receipts: [accepted] },
      context
    );
    assert.equal(unchanged.results[0].result, 'unchanged');

    const acceptedStatus = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    assert.equal(acceptedStatus.periods[0].reconciliation_status, 'accepted');
    assert.equal(acceptedStatus.periods[0].health, 'complete');
    assert.equal(acceptedStatus.periods[0].receipt_count, 2);
    assert.equal(validateResponse('get_reporting_status', acceptedStatus, '3.2.0-rc.3').valid, true);

    const pagedReceipts = [];
    let cursor;
    do {
      const page = await getStatus(
        {
          account: { account_id: fixture.accountId },
          view: 'periods',
          period: fixture.period,
          pagination: { max_results: 1, ...(cursor ? { cursor } : {}) },
        },
        context
      );
      assert.equal(
        validateResponse('get_reporting_status', page, '3.2.0-rc.3').valid,
        true,
        JSON.stringify(validateResponse('get_reporting_status', page, '3.2.0-rc.3').issues)
      );
      pagedReceipts.push(...page.receipts);
      cursor = page.pagination.cursor;
    } while (cursor);
    assert.deepEqual(
      pagedReceipts.map(value => value.reporting_receipt_id),
      ['receipt-rejected-0001', 'receipt-accepted-0001']
    );

    const terminal = await syncReceipts(
      {
        idempotency_key: 'receipt-batch-terminal-0001',
        receipts: [
          receipt(fixture, {
            reporting_receipt_id: 'receipt-terminal-0001',
            supersedes_reporting_receipt_id: accepted.reporting_receipt_id,
            status: 'accepted',
          }),
        ],
      },
      context
    );
    assert.equal(terminal.results[0].result, 'failed');

    const foreign = await syncReceipts(
      {
        idempotency_key: 'receipt-batch-foreign-0001',
        receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-foreign-0001' })],
      },
      { ...context, account: { id: 'account-foreign' } }
    );
    assert.equal(foreign.results[0].result, 'failed');
    assert.equal(foreign.results[0].errors[0].message, terminal.results[0].errors[0].message);
  });

  test('serializes competing accepted receipts and exposes only caller-scoped history', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-two.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const [left, right] = await Promise.all([
      sync(
        {
          idempotency_key: 'receipt-concurrent-left-0001',
          receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-concurrent-left-0001' })],
        },
        context
      ),
      sync(
        {
          idempotency_key: 'receipt-concurrent-right-0001',
          receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-concurrent-right-0001' })],
        },
        context
      ),
    ]);
    assert.deepEqual([left.results[0].result, right.results[0].result].sort(), ['failed', 'recorded']);
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'revision',
        reporting_revision_id: fixture.revision.reporting_revision_id,
      },
      context
    );
    assert.equal(status.receipts.length, 1);
    assert.ok(status.receipts[0].reporting_receipt_id.startsWith('receipt-concurrent-'));
  });

  test('keeps official evidence immutable and reconciles append-only adjustments from a checkpoint', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } };
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const baseline = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    const rows = [];
    const rowBytes = Buffer.from(canonicalize(rows));
    const adjustment = {
      reporting_adjustment_id: 'adjustment-invalid-traffic-0001',
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
      adjustmentNumber: 1,
      manifest: { level: 'basic', objectRef: 'adjustment-manifest', sha256: 'd'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'adjustment-publication-1',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(rowBytes).digest('hex'),
        byteCount: rowBytes.byteLength,
        rowCount: 0,
      },
      rows,
      observedAt: fixture.now,
      dataThrough: fixture.period.end,
      sourceReadCutoffAt: fixture.now,
      createdAt: fixture.now,
      wireAdjustment: {
        reporting_adjustment_id: 'adjustment-invalid-traffic-0001',
        adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
        reason_code: 'invalid_traffic',
        accounting_period: fixture.period,
        control_total_deltas: [{ name: 'impressions', value: '-5', value_type: 'integer', unit: 'impressions' }],
        canonical_adjustment_sha256: 'e'.repeat(64),
        correction_observed_at: fixture.now,
        created_at: fixture.now,
      },
    };
    await core.commitAdjustment(adjustment, fixture.coreLease);
    const reopened = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'periods',
        period: fixture.period,
        changes_after: baseline.changes_checkpoint,
      },
      context
    );
    assert.equal(reopened.periods[0].reconciliation_status, 'pending');
    assert.equal(reopened.periods[0].issues.at(-1).code, 'ADJUSTMENT_RECEIPT_REQUIRED');
    assert.equal(reopened.adjustments.length, 1);
    assert.equal(reopened.revisions[0].reporting_revision_id, fixture.revision.reporting_revision_id);
    assert.equal(
      validateResponse('get_reporting_status', reopened, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', reopened, '3.2.0-rc.3').issues)
    );

    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const adjustmentResult = await sync(
      {
        idempotency_key: 'adjustment-receipt-batch-0001',
        adjustment_receipts: [
          {
            reporting_receipt_id: 'adjustment-receipt-accepted-0001',
            reporting_adjustment_id: adjustment.reporting_adjustment_id,
            adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
            status: 'accepted',
            observed_adjustment_sha256: adjustment.wireAdjustment.canonical_adjustment_sha256,
            observed_at: fixture.now,
          },
        ],
      },
      context
    );
    assert.equal(adjustmentResult.results[0].result, 'recorded');
    assert.equal(
      (await core.getRevision(fixture.revision.reporting_revision_id, fixture.accountId)).finality,
      'official'
    );
  });

  test('keeps a receipt commit concurrent with a snapshot visible after its checkpoint', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-three.example' } };
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const baseline = await getStatus(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      context
    );
    await pool.query(`
      CREATE FUNCTION delay_managed_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$;
      CREATE TRIGGER delay_managed_receipt_insert
        BEFORE INSERT ON adcp_reporting_receipts
        FOR EACH ROW EXECUTE FUNCTION delay_managed_receipt_insert()
    `);
    try {
      const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
      const write = sync(
        {
          idempotency_key: 'checkpoint-race-batch-0001',
          receipts: [receipt(fixture, { reporting_receipt_id: 'checkpoint-race-receipt-0001' })],
        },
        context
      );
      await new Promise(resolve => setTimeout(resolve, 25));
      const delta = getStatus(
        {
          account: { account_id: fixture.accountId },
          view: 'periods',
          period: fixture.period,
          changes_after: baseline.changes_checkpoint,
        },
        context
      );
      assert.equal((await write).results[0].result, 'recorded');
      const visible = await delta;
      assert.equal(
        visible.receipts.some(value => value.reporting_receipt_id === 'checkpoint-race-receipt-0001'),
        true
      );
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS delay_managed_receipt_insert ON adcp_reporting_receipts');
      await pool.query('DROP FUNCTION IF EXISTS delay_managed_receipt_insert()');
    }
  });

  test('revocation denies queued work and reads before asynchronous provider cleanup', async () => {
    const revokedAt = new Date(Date.parse(fixture.now) + 3000).toISOString();
    assert.equal(
      await managed.revokeDestination({
        account_id: fixture.accountId,
        destination_ref: fixture.binding.destination_ref,
        generation: fixture.binding.authorization_generation,
        revoked_at: revokedAt,
      }),
      true
    );
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => assert.fail('revoked work must not reach delivery I/O'),
      read: async () => assert.fail('revoked resources must not reach reader I/O'),
      revoke: async () => {},
    };
    assert.equal(
      await ledger.readManagedReportingResource(managed, adapter, {
        account_id: fixture.accountId,
        resource_ref: fixture.materialization.resource.resource_ref,
      }),
      null
    );
    const result = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(revokedAt),
      maxIterations: 2,
    });
    assert.equal(result.revocationsCompleted, 1);
    const revokedStatus = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })(
      { account: { account_id: fixture.accountId }, view: 'periods', period: fixture.period },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(revokedStatus.periods[0].health, 'action_required');
    assert.equal(revokedStatus.periods[0].successful_materialization_count, 1);
    assert.equal(
      revokedStatus.materializations.some(value => value.status === 'available'),
      true
    );
    const revokedReplay = await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-batch-accepted-0001',
        receipts: [
          receipt(fixture, {
            reporting_receipt_id: 'receipt-accepted-0001',
            supersedes_reporting_receipt_id: 'receipt-rejected-0001',
            status: 'accepted',
          }),
        ],
      },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    // An exact same-key replay is side-effect free and returns the caller its
    // own prior verdict. Revocation governs what may be newly accepted, not
    // what an already-answered idempotency key answers, and the body is the
    // caller's own receipt echoed back — no other consumer's state is read.
    assert.equal(revokedReplay.results[0].result, 'recorded');
    assert.equal(revokedReplay.results[0].receipt.reporting_receipt_id, 'receipt-accepted-0001');
    assert.equal(validateResponse('sync_reporting_receipts', revokedReplay, '3.2.0-rc.3').valid, true);
    // A new receipt under a fresh key is still refused while revoked.
    const revokedFresh = await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-batch-after-revoke-0001',
        receipts: [receipt(fixture, { reporting_receipt_id: 'receipt-after-revoke-0001' })],
      },
      { account: { id: fixture.accountId }, agent: { agent_url: 'https://buyer-one.example' } }
    );
    assert.equal(revokedFresh.results[0].result, 'failed', 'fail-closed still governs newly accepted evidence');
    const retained = await pool.query(
      'SELECT COUNT(*)::integer AS count FROM adcp_reporting_materializations WHERE account_id = $1',
      [fixture.accountId]
    );
    assert.equal(retained.rows[0].count, 2);
    await managed.authorizeDestination({
      account_id: fixture.accountId,
      destination_ref: fixture.binding.destination_ref,
      generation: 2,
      authorized_at: new Date(Date.parse(revokedAt) + 1000).toISOString(),
    });
    assert.equal(
      await managed.isAuthorizationCurrent({
        account_id: fixture.accountId,
        destination_ref: fixture.binding.destination_ref,
        generation: 1,
      }),
      false
    );
    assert.equal(
      await managed.isAuthorizationCurrent({
        account_id: fixture.accountId,
        destination_ref: fixture.binding.destination_ref,
        generation: 2,
      }),
      true
    );
    await assert.rejects(
      () =>
        managed.installBinding(
          ledger.reportingManagedDeliveryBindingV1({
            ...fixture.binding,
            authorization_generation: 2,
            created_at: new Date(Date.parse(revokedAt) + 1000).toISOString(),
          })
        ),
      /PostgresReportingManagedDeliveryStore transaction failed/
    );
    const secondRevokedAt = new Date(Date.parse(revokedAt) + 2000).toISOString();
    await managed.revokeDestination({
      account_id: fixture.accountId,
      destination_ref: fixture.binding.destination_ref,
      generation: 2,
      revoked_at: secondRevokedAt,
    });
    const expiredCleanup = await managed.claimRevocation({
      owner: 'stale-cleanup-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 1,
      account_id: fixture.accountId,
    });
    assert.ok(expiredCleanup);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(
      await managed.completeRevocation({ lease: expiredCleanup, completed_at: new Date().toISOString() }),
      false
    );
  });

  test('accepts a receipt for a snapshot-finality obligation its own contract requires', async () => {
    const snapshot = await seedSnapshotFinalityLedger();
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(snapshot),
      read: async () => Buffer.from('snapshot bytes'),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: snapshot.accountId });
    const worker = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(snapshot.now) + 1000),
      maxIterations: 2,
      account_id: snapshot.accountId,
    });
    assert.equal(worker.delivered, 1, 'a snapshot revision is materializable');
    const stored = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [snapshot.obligation.reporting_obligation_id]
    );
    snapshot.materialization = stored.rows[0].data;

    const context = { account: { id: snapshot.accountId }, agent: { agent_url: 'https://snapshot-buyer.example' } };
    const syncReceipts = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => new Date(Date.parse(snapshot.now) + 2000)
    );
    const acceptedRequest = {
      idempotency_key: 'receipt-snapshot-finality-0001',
      receipts: [receipt(snapshot, { reporting_receipt_id: 'receipt-snapshot-accepted-0001' })],
    };
    const accepted = await syncReceipts(acceptedRequest, context);
    assert.equal(
      accepted.results[0].result,
      'recorded',
      'hard-coding official finality made every snapshot-finality contract unreconcilable'
    );
    assert.equal(validateResponse('sync_reporting_receipts', accepted, '3.2.0-rc.3').valid, true);

    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      { account: { account_id: snapshot.accountId }, view: 'periods', period: snapshot.period },
      context
    );
    assert.equal(status.periods[0].reconciliation_status, 'accepted');
    assert.equal(
      validateResponse('get_reporting_status', status, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', status, '3.2.0-rc.3').issues)
    );
    snapshotFixture = { ...snapshot, acceptedRequest, acceptedResult: accepted };
  });

  test('keeps the receipt replay cache compact and replays a pre-upgrade row', async () => {
    const snapshot = snapshotFixture;
    const context = { account: { id: snapshot.accountId }, agent: { agent_url: 'https://snapshot-buyer.example' } };
    const syncReceipts = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => new Date(Date.parse(snapshot.now) + 3000)
    );
    const cached = await pool.query(`SELECT results FROM adcp_reporting_receipt_batches WHERE idempotency_key = $1`, [
      snapshot.acceptedRequest.idempotency_key,
    ]);
    const stored = cached.rows[0].results;
    assert.deepEqual(
      stored.map(value => value.kind),
      ['recorded'],
      'the replay row keeps a verdict, not a second copy of the receipt'
    );
    assert.equal(stored[0].receipt, undefined, 'receipt bodies are not duplicated into the replay cache');
    assert.ok(
      Buffer.byteLength(JSON.stringify(stored), 'utf8') < 512,
      'a compact replay row cannot grow with receipt size'
    );

    const replay = await syncReceipts(snapshot.acceptedRequest, context);
    assert.deepEqual(replay, snapshot.acceptedResult, 'replay is still byte-identical to the original response');

    // A key written by the previous build stored the whole response entry.
    await pool.query(`UPDATE adcp_reporting_receipt_batches SET results = $2::jsonb WHERE idempotency_key = $1`, [
      snapshot.acceptedRequest.idempotency_key,
      JSON.stringify(snapshot.acceptedResult.results),
    ]);
    const legacyReplay = await syncReceipts(snapshot.acceptedRequest, context);
    assert.deepEqual(
      legacyReplay,
      snapshot.acceptedResult,
      'an idempotency key in flight across the upgrade still replays'
    );

    // Retention ages the cache out, so reaching the per-consumer cap throttles
    // a burst instead of locking the consumer out permanently.
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE idempotency_key = $1`,
      [snapshot.acceptedRequest.idempotency_key]
    );
    const fresh = await syncReceipts(
      {
        idempotency_key: 'receipt-compact-cache-0002',
        receipts: [receipt(snapshot, { reporting_receipt_id: 'receipt-compact-cache-0002' })],
      },
      context
    );
    assert.equal(validateResponse('sync_reporting_receipts', fresh, '3.2.0-rc.3').valid, true);
    const remaining = await pool.query(`SELECT 1 FROM adcp_reporting_receipt_batches WHERE idempotency_key = $1`, [
      snapshot.acceptedRequest.idempotency_key,
    ]);
    assert.equal(remaining.rowCount, 0, 'expired replay rows are pruned for this caller only');
    const others = await pool.query(
      `SELECT 1 FROM adcp_reporting_receipt_batches WHERE consumer_id <> 'https://snapshot-buyer.example'`
    );
    assert.ok(others.rowCount > 0, 'another consumer replay cache is untouched');
  });

  test('replays a revision and adjustment stored before the canonical digests existed', async () => {
    const storedRevision = await pool.query(
      `UPDATE adcp_reporting_revisions
          SET data = jsonb_set(data, '{wireRevision}', (data->'wireRevision') - 'canonical_content_digest')
        WHERE revision_id = $1 RETURNING data`,
      [fixture.revision.reporting_revision_id]
    );
    assert.equal(storedRevision.rows[0].data.wireRevision.canonical_content_digest, undefined);
    const replayedRevision = await core.commitRevision(fixture.revision, fixture.coreLease);
    assert.equal(replayedRevision.inserted, false);
    assert.equal(
      replayedRevision.value.wireRevision.canonical_content_digest,
      undefined,
      'the pre-upgrade row is returned unchanged rather than rewritten'
    );
    await assert.rejects(
      () =>
        core.commitRevision(
          { ...fixture.revision, wireRevision: { ...fixture.revision.wireRevision, row_count: 99 } },
          fixture.coreLease
        ),
      /transaction failed/,
      'the tolerance covers the added digest and nothing else'
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions
          SET data = jsonb_set(data, '{wireRevision,canonical_content_digest}', $2::jsonb)
        WHERE revision_id = $1`,
      [fixture.revision.reporting_revision_id, JSON.stringify(fixture.revision.wireRevision.canonical_content_digest)]
    );

    const rows = [{ media_buy_id: 'buy-1', impressions: 7 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-legacy-digest-0001',
      adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: fixture.period.start, end: fixture.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: fixture.now,
      created_at: fixture.now,
    };
    const legacyAdjustment = {
      reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      adjusts_reporting_revision_id: fixture.revision.reporting_revision_id,
      adjustmentNumber: 2,
      manifest: { level: 'basic', objectRef: 'legacy-manifest', sha256: 'c'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'adjustment-publication-legacy',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: fixture.now,
      dataThrough: fixture.period.end,
      sourceReadCutoffAt: fixture.now,
      createdAt: fixture.now,
      wireAdjustment: wireAdjustmentWithoutDigest,
    };
    const inserted = await core.commitAdjustment(legacyAdjustment, fixture.coreLease);
    assert.equal(inserted.inserted, true);

    const upgraded = {
      ...legacyAdjustment,
      wireAdjustment: {
        ...wireAdjustmentWithoutDigest,
        canonical_adjustment_sha256: createHash('sha256')
          .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
          .digest('hex'),
      },
    };
    const replayedAdjustment = await core.commitAdjustment(upgraded, fixture.coreLease);
    assert.equal(replayedAdjustment.inserted, false);
    assert.equal(
      replayedAdjustment.value.wireAdjustment.canonical_adjustment_sha256,
      undefined,
      'the pre-upgrade adjustment row survives the replay untouched'
    );
    await assert.rejects(
      () =>
        core.commitAdjustment(
          {
            ...legacyAdjustment,
            wireAdjustment: { ...wireAdjustmentWithoutDigest, canonical_adjustment_sha256: 'a'.repeat(64) },
          },
          fixture.coreLease
        ),
      /transaction failed/,
      'only the digest RC3 derives from the stored content is tolerated'
    );
  });

  test('exposes every consumer receipt chain to the lifecycle projection', async () => {
    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: snapshotFixture.obligation.reporting_obligation_id,
      ledgerAsOf: new Date(Date.parse(snapshotFixture.now) + 600_000).toISOString(),
    });
    assert.equal(projection.binding.configurationId, snapshotFixture.configuration.configurationId);
    assert.ok(projection.materializationHistory.length >= 1);
    assert.deepEqual(
      projection.consumers.map(value => value.consumer_id),
      ['https://snapshot-buyer.example']
    );
    assert.ok(projection.consumers[0].receipts.length >= 1);
    assert.equal(
      await core.getManagedLifecycleProjection({
        reporting_obligation_id: 'obligation-does-not-exist',
        ledgerAsOf: snapshotFixture.now,
      }),
      null
    );
    // Nothing durable enumerates who owes a receipt, so the bundled store
    // cannot claim a complete roster on its own.
    assert.equal(projection.obligatedConsumerRosterComplete, false);

    // The supported seam: a seller whose authorization layer does know the
    // roster supplies it and gets accurate reconciled transitions. Without it
    // the fold stays conservative forever.
    const rosterAware = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async input => {
        assert.equal(input.reporting_obligation_id, snapshotFixture.obligation.reporting_obligation_id);
        assert.equal(input.account_id, snapshotFixture.accountId);
        return { ids: ['https://snapshot-buyer.example', 'https://governance.example'], complete: true };
      },
    });
    const supplied = await rosterAware.getManagedLifecycleProjection({
      reporting_obligation_id: snapshotFixture.obligation.reporting_obligation_id,
      ledgerAsOf: new Date(Date.parse(snapshotFixture.now) + 600_000).toISOString(),
    });
    assert.equal(supplied.obligatedConsumerRosterComplete, true);
    assert.deepEqual(supplied.obligatedConsumerIds, ['https://governance.example', 'https://snapshot-buyer.example']);

    // The hook's documented purpose is an external authorization lookup, so it
    // must never be awaited inside the authoritative transaction: a hung auth
    // service would pin a pooled connection and a snapshot per reconcile, and
    // the managed store shares the Core pool. Prove it by issuing an
    // independent query from inside the callback — that can only succeed if a
    // connection is free, which it is not while the store's own transaction is
    // still open on a single-connection pool.
    const { Pool } = require('pg');
    const singleConnection = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path="${schema}"`,
      max: 1,
    });
    try {
      let reentrantRows = -1;
      const serialized = new ledger.PostgresReportingLedgerStore(singleConnection, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
        obligatedConsumers: async () => {
          const probe = await singleConnection.query('SELECT 1 AS ok');
          reentrantRows = probe.rowCount;
          return { ids: ['https://snapshot-buyer.example'], complete: true };
        },
      });
      const outside = await serialized.getManagedLifecycleProjection({
        reporting_obligation_id: snapshotFixture.obligation.reporting_obligation_id,
        ledgerAsOf: new Date(Date.parse(snapshotFixture.now) + 600_000).toISOString(),
      });
      assert.equal(reentrantRows, 1, 'the callback runs with the store transaction already committed');
      assert.equal(outside.obligatedConsumerRosterComplete, true);
    } finally {
      await singleConnection.end();
    }
  });

  test('settles a lease issued under host clock skew against the database clock', async () => {
    const skewed = await seedSkewLedger();
    // A worker whose host clock is ten minutes behind the database. Before the
    // lease was issued from clock_timestamp(), the claim succeeded and the
    // settle matched zero rows, stranding the row at status 'pending'
    // attempt 1 where the planner's HAVING cannot see it — so the attempt cap
    // never engaged and the adapter was re-asked to deliver without bound.
    const behind = new Date(Date.now() - 10 * 60_000).toISOString();
    await managed.planMaterializations({ account_id: skewed.accountId });
    const claimed = await managed.claimMaterialization({
      owner: 'skewed-worker',
      now: behind,
      lease_milliseconds: 65_000,
      account_id: skewed.accountId,
    });
    assert.ok(claimed, 'the skewed worker can still claim');
    assert.ok(
      Date.parse(claimed.expires_at) > Date.now() - 60_000,
      'the committed expiry comes from the database clock, not the caller'
    );
    const settled = await managed.settleMaterialization({
      lease: claimed,
      now: behind,
      outcome: materializationOutcome(skewed),
    });
    assert.equal(settled, true, 'host clock skew must not strand a delivered materialization');
    const rows = await pool.query(
      `SELECT status FROM adcp_reporting_materializations WHERE obligation_id = $1 ORDER BY attempt`,
      [skewed.obligation.reporting_obligation_id]
    );
    assert.deepEqual(
      rows.rows.map(row => row.status),
      ['available'],
      'the row leaves pending instead of being re-delivered forever'
    );

    // Same single-clock rule for revocation cleanup.
    await managed.revokeDestination({
      account_id: skewed.accountId,
      destination_ref: skewed.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const cleanup = await managed.claimRevocation({
      owner: 'skewed-cleanup-worker',
      now: behind,
      lease_milliseconds: 65_000,
      account_id: skewed.accountId,
    });
    assert.ok(cleanup);
    assert.equal(
      await managed.completeRevocation({ lease: cleanup, completed_at: new Date().toISOString() }),
      true,
      'host clock skew must not prevent provider grant cleanup from committing'
    );
  });

  test('accepts an adjustment rejection whose digests agree', async () => {
    const semantic = await seedSkewLedger('semantic', 'consumer_receipt');
    const rows = [{ media_buy_id: 'buy-3', impressions: 11 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-semantic-0001',
      adjusts_reporting_revision_id: semantic.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: semantic.period.start, end: semantic.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: semantic.now,
      created_at: semantic.now,
    };
    const canonicalAdjustmentSha256 = createHash('sha256')
      .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
      .digest('hex');
    await core.commitAdjustment(
      {
        reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
        reporting_obligation_id: semantic.obligation.reporting_obligation_id,
        adjusts_reporting_revision_id: semantic.revision.reporting_revision_id,
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'semantic-manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'adjustment-publication-semantic',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: rows.length,
        },
        rows,
        observedAt: semantic.now,
        dataThrough: semantic.period.end,
        sourceReadCutoffAt: semantic.now,
        createdAt: semantic.now,
        wireAdjustment: { ...wireAdjustmentWithoutDigest, canonical_adjustment_sha256: canonicalAdjustmentSha256 },
      },
      semantic.coreLease
    );

    const context = { account: { id: semantic.accountId }, agent: { agent_url: 'https://semantic-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const adjustmentReceipt = overrides => ({
      reporting_receipt_id: 'adjustment-receipt-semantic-0001',
      reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
      adjusts_reporting_revision_id: semantic.revision.reporting_revision_id,
      observed_adjustment_sha256: canonicalAdjustmentSha256,
      observed_at: semantic.now,
      ...overrides,
    });

    // RC3 acceptance_match: "A digest OR SEMANTIC disagreement is rejected with
    // stable rejection_codes." A semantic disagreement has matching digests, so
    // requiring a digest mismatch to reject made the class unfileable, and an
    // accepted leaf being terminal left reconciliation with no exit at all.
    const semanticRejection = await sync(
      {
        idempotency_key: 'adjustment-semantic-reject-0001',
        adjustment_receipts: [adjustmentReceipt({ status: 'rejected', rejection_codes: ['SEMANTIC_MISMATCH'] })],
      },
      context
    );
    assert.equal(semanticRejection.results[0].result, 'recorded');
    assert.equal(validateResponse('sync_reporting_receipts', semanticRejection, '3.2.0-rc.3').valid, true);

    // Negative controls: a rejection with no codes, and an acceptance whose
    // digest disagrees, both stay refused.
    const uncoded = await sync(
      {
        idempotency_key: 'adjustment-semantic-reject-0002',
        adjustment_receipts: [
          adjustmentReceipt({ reporting_receipt_id: 'adjustment-receipt-semantic-0002', status: 'rejected' }),
        ],
      },
      context
    );
    assert.equal(uncoded.results[0].result, 'failed');
    const mismatchedAccept = await sync(
      {
        idempotency_key: 'adjustment-semantic-accept-0001',
        adjustment_receipts: [
          adjustmentReceipt({
            reporting_receipt_id: 'adjustment-receipt-semantic-0003',
            status: 'accepted',
            observed_adjustment_sha256: '1'.repeat(64),
          }),
        ],
      },
      context
    );
    assert.equal(mismatchedAccept.results[0].result, 'failed');
  });

  test('refuses a binding replay whose fingerprint was copied from different content', async () => {
    const authentic = fixture.binding;
    // Same configuration identity, different immutable content, carrying the
    // stored fingerprint. The replay branch used to trust the supplied value
    // and accept this as an idempotent no-op.
    await assert.rejects(
      () =>
        managed.installBinding({
          ...authentic,
          resource_retention_days: authentic.resource_retention_days + 1,
          semantic_fingerprint: authentic.semantic_fingerprint,
        }),
      /semantic fingerprint does not match its immutable content/
    );
    const stored = await pool.query('SELECT data FROM adcp_reporting_managed_bindings WHERE configuration_id = $1', [
      authentic.configurationId,
    ]);
    assert.equal(
      stored.rows[0].data.resource_retention_days,
      authentic.resource_retention_days,
      'the stored immutable binding is untouched'
    );
    assert.deepEqual(await managed.installBinding(authentic), { inserted: false }, 'an exact replay still succeeds');
  });

  test('scopes adjustment receipts to the adjustments the view returns', async () => {
    const context = { account: { id: fixture.accountId }, agent: { agent_url: 'https://semantic-buyer.example' } };
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const revisionView = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'revision',
        reporting_revision_id: fixture.revision.reporting_revision_id,
      },
      context
    );
    const returnedAdjustmentIds = new Set(revisionView.adjustments.map(value => value.reporting_adjustment_id));
    for (const value of revisionView.adjustment_receipts ?? []) {
      assert.ok(
        returnedAdjustmentIds.has(value.reporting_adjustment_id),
        'RC3 revision_adjustments: every adjustment_receipt must name one of those adjustments'
      );
    }
    assert.equal(
      validateResponse('get_reporting_status', revisionView, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', revisionView, '3.2.0-rc.3').issues)
    );

    // An unrelated revision returns no adjustments, so it must return no
    // adjustment receipts either.
    const unrelated = await getStatus(
      {
        account: { account_id: fixture.accountId },
        view: 'revision',
        reporting_revision_id: snapshotFixture.revision.reporting_revision_id,
      },
      { account: { id: snapshotFixture.accountId }, agent: { agent_url: 'https://semantic-buyer.example' } }
    );
    assert.deepEqual(unrelated.adjustments, []);
    assert.deepEqual(unrelated.adjustment_receipts ?? [], []);
  });

  test('keeps the prune account lock off the expensive selection', async () => {
    const heavy = await seedSkewLedger('prunelock', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(heavy),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: heavy.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: heavy.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [heavy.accountId ? heavy.obligation.reporting_obligation_id : null]
    );
    heavy.materialization = settled.rows[0].data;

    // A replay cache with real breadth. The previous shape asked a JSONB
    // containment question per candidate receipt, which the planner answered
    // with a join filter over all of it.
    const context = { account: { id: heavy.accountId }, agent: { agent_url: 'https://prunelock-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    await sync(
      {
        idempotency_key: 'receipt-prunelock-0001',
        receipts: [receipt(heavy, { reporting_receipt_id: 'receipt-prunelock-0001' })],
      },
      context
    );
    const filler = [];
    for (let index = 0; index < 400; index += 1) {
      filler.push([
        heavy.accountId,
        'https://prunelock-buyer.example',
        `filler-key-${String(index).padStart(6, '0')}`,
        'fingerprint',
        JSON.stringify([{ kind: 'recorded', id: `filler-receipt-${index}`, entry: 'revision' }]),
      ]);
    }
    for (const row of filler) {
      await pool.query(
        `INSERT INTO adcp_reporting_receipt_batches
           (account_id, consumer_id, idempotency_key, request_fingerprint, results)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        row
      );
    }
    // Enough candidate receipts that a per-candidate question is visible as
    // repeated scans rather than one pass.
    for (let index = 0; index < 200; index += 1) {
      await pool.query(
        `INSERT INTO adcp_reporting_receipts
           (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
            is_current, semantic_fingerprint, data, received_at, recorded_at)
         VALUES ($1,$2,$3,'revision',$4,false,'fingerprint','{}'::jsonb,
                 clock_timestamp() - INTERVAL '300 days', clock_timestamp() - INTERVAL '300 days')`,
        [
          heavy.accountId,
          'https://prunelock-buyer.example',
          `aged-receipt-${String(index).padStart(6, '0')}`,
          heavy.revision.reporting_revision_id,
        ]
      );
    }
    await pool.query('ANALYZE adcp_reporting_receipt_batches');
    await pool.query('ANALYZE adcp_reporting_receipts');

    // The shape that shipped before: one containment question per candidate
    // receipt. Shown here so the difference is a measurement, not a claim.
    const previousShape = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON)
       SELECT receipt.consumer_id, receipt.reporting_receipt_id
         FROM adcp_reporting_receipts receipt
        WHERE receipt.account_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM adcp_reporting_receipt_batches batch
             WHERE batch.account_id = receipt.account_id
               AND batch.consumer_id = receipt.consumer_id
               AND batch.results @> jsonb_build_array(
                     jsonb_build_object('id', receipt.reporting_receipt_id))
          )`,
      [heavy.accountId]
    );
    const previousLoops = [];
    const walkPrevious = node => {
      if (!node || typeof node !== 'object') return;
      if (node['Relation Name'] === 'adcp_reporting_receipt_batches') {
        previousLoops.push(Number(node['Actual Loops'] ?? 1));
      }
      for (const child of node.Plans ?? []) walkPrevious(child);
    };
    walkPrevious(previousShape.rows[0]['QUERY PLAN'][0].Plan);
    // Containment cannot be a hash key, so every candidate/row pair is
    // evaluated by the join filter — that is where the reviewer's six
    // million removals came from. Equality on the expanded ids can hash.
    const joinFilterRemovals = plannedJson => {
      const matches = [...JSON.stringify(plannedJson).matchAll(/"Rows Removed by Join Filter":\s*(\d+)/g)];
      return matches.reduce((total, match) => total + Number(match[1]), 0);
    };
    const previousRemovals = joinFilterRemovals(previousShape.rows[0]['QUERY PLAN']);
    assert.ok(previousRemovals > 0, 'the previous containment shape filters pairwise');

    // The selection must not be a join filter over the whole cache.
    const plan = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON)
       WITH live_referenced AS (
         SELECT DISTINCT batch.consumer_id,
                COALESCE(elem ->> 'id', elem ->> 'reporting_receipt_id') AS reporting_receipt_id
           FROM adcp_reporting_receipt_batches batch,
                LATERAL jsonb_array_elements(batch.results) elem
          WHERE batch.account_id = $1
       )
       SELECT receipt.consumer_id, receipt.reporting_receipt_id
         FROM adcp_reporting_receipts receipt
        WHERE receipt.account_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM live_referenced
             WHERE live_referenced.consumer_id = receipt.consumer_id
               AND live_referenced.reporting_receipt_id = receipt.reporting_receipt_id
          )`,
      [heavy.accountId]
    );
    // The property that matters is how many times the replay cache is read.
    // The old containment shape asked the question per candidate receipt, so
    // the cache was rescanned for each one; expanding it once is a single
    // pass no matter how many receipts are in scope.
    const loopsOverCache = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node['Relation Name'] === 'adcp_reporting_receipt_batches') {
        loopsOverCache.push(Number(node['Actual Loops'] ?? 1));
      }
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan.rows[0]['QUERY PLAN'][0].Plan);
    assert.ok(loopsOverCache.length >= 1, 'the replay cache is read');
    const currentRemovals = joinFilterRemovals(plan.rows[0]['QUERY PLAN']);
    assert.ok(
      currentRemovals < previousRemovals,
      `the expanded shape must not filter pairwise: ${currentRemovals} vs ${previousRemovals}`
    );
    assert.deepEqual(
      loopsOverCache.filter(loops => loops > 1),
      [],
      `the replay cache must be read once, not per receipt: loops ${JSON.stringify(loopsOverCache)}`
    );

    // And a concurrent Core write must not be blocked out while it runs.
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const started = Date.now();
    const [pruned, concurrent] = await Promise.all([
      retaining.pruneExpiredEvidence({ account_id: heavy.accountId }),
      (async () => {
        await core.putIssue({
          issueId: `reporting-issue.prunelock.${heavy.obligation.reporting_obligation_id}`,
          reporting_obligation_id: heavy.obligation.reporting_obligation_id,
          code: 'REPORT_OVERDUE',
          severity: 'delayed',
          responsibleParty: 'seller',
          recommendedAction: 'wait_for_retry',
          openedAt: heavy.now,
          observedAt: heavy.now,
        });
        return Date.now() - started;
      })(),
    ]);
    assert.ok(pruned, 'the prune completed');
    assert.ok(concurrent < 5_000, `a concurrent Core write must not wait out the account lock, waited ${concurrent}ms`);
  });

  test('fails materializations that used every delivery attempt during the worker run', async () => {
    const drained = await seedSkewLedger('workerexhaust');
    assert.equal(await managed.planMaterializations({ account_id: drained.accountId }), 1);
    for (let round = 0; round < 5; round += 1) {
      const claimed = await managed.claimMaterialization({
        owner: `pre-crash-${round}`,
        now: new Date().toISOString(),
        lease_milliseconds: 1,
        account_id: drained.accountId,
      });
      assert.ok(claimed, `claim ${round} should succeed`);
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    const stuck = await pool.query(
      `SELECT status, lease_generation FROM adcp_reporting_materializations WHERE account_id = $1`,
      [drained.accountId]
    );
    assert.equal(stuck.rows[0].status, 'pending');
    assert.equal(Number(stuck.rows[0].lease_generation), 5);

    // The worker itself has to clear it. Nothing else does: the claim
    // predicate refuses it and the planner skips an obligation with any
    // pending row, so the revision was stuck with replan 0 and claim null.
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(drained),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    const run = await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 3,
      account_id: drained.accountId,
    });
    assert.equal(run.exhausted, 1, 'the worker fails the exhausted row');
    assert.equal(run.planned, 1, 'and the revision can be planned again');
    assert.equal(run.delivered, 1, 'and delivered');
  });

  test('advances the roster refresh cursor past a tenant whose lookup fails', async () => {
    const { Pool } = require('pg');
    const failSchema = `${schema}_rosterfail`;
    await bootstrap.query(`CREATE SCHEMA "${failSchema}"`);
    const failPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${failSchema}"` });
    try {
      await failPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await failPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const failCore = new ledger.PostgresReportingLedgerStore(failPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const failManaged = new ledger.PostgresReportingManagedDeliveryStore(failPool);
      assert.equal(await failManaged.probe(failCore), true);
      const first = await seedSkewLedgerInto(failCore, failManaged, 'rosterfailone', 'consumer_receipt');
      const second = await seedSkewLedgerInto(failCore, failManaged, 'rosterfailtwo', 'consumer_receipt');
      const seen = [];
      const rosterStore = new ledger.PostgresReportingLedgerStore(failPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
        obligatedConsumers: async input => {
          seen.push(input.reporting_obligation_id);
          throw new Error('authorization service unavailable');
        },
      });
      // At limit 1 a failing first obligation used to be re-selected every
      // sweep, because the cursor only advanced on success — the healthy one
      // behind it was never reached at all.
      await rosterStore.refreshObligatedConsumerRosterVersions({ limit: 1 });
      await rosterStore.refreshObligatedConsumerRosterVersions({ limit: 1 });
      assert.deepEqual(
        [...seen].sort(),
        [first.obligation.reporting_obligation_id, second.obligation.reporting_obligation_id].sort(),
        'a failing tenant yields its slot to the next one'
      );
    } finally {
      await failPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${failSchema}" CASCADE`);
    }
  });

  test('resolves a stale managed issue once delivery succeeds again', async () => {
    const stale = await seedSkewLedger('staleissue');
    let failFirst = true;
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error('provider unavailable');
        }
        return materializationOutcome(stale);
      },
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: stale.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: stale.accountId });
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: stale.obligation.reporting_obligation_id,
    });
    const failed = await pool.query(
      `SELECT data ->> 'code' AS code, resolved_at FROM adcp_reporting_issues WHERE obligation_id = $1`,
      [stale.obligation.reporting_obligation_id]
    );
    assert.ok(
      failed.rows.some(row => row.code === 'DELIVERY_FAILED' && row.resolved_at === null),
      'the delivery failure is persisted'
    );

    // Redeliver successfully. The resolve sweep only covered Core codes, so
    // this stayed open and the status kept publishing a delivery failure
    // that no longer described anything.
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 3, account_id: stale.accountId });
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: stale.obligation.reporting_obligation_id,
    });
    const after = await pool.query(
      `SELECT data ->> 'code' AS code, resolved_at FROM adcp_reporting_issues WHERE obligation_id = $1`,
      [stale.obligation.reporting_obligation_id]
    );
    assert.equal(
      after.rows.some(row => row.code === 'DELIVERY_FAILED' && row.resolved_at === null),
      false,
      'a managed issue is resolved once it stops being true'
    );
  });

  test('does not poison the durable policy when startup validation refuses', async () => {
    const { Pool } = require('pg');
    const poisonSchema = `${schema}_poison`;
    await bootstrap.query(`CREATE SCHEMA "${poisonSchema}"`);
    const poisonPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${poisonSchema}"` });
    try {
      await poisonPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await poisonPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const poisonCore = new ledger.PostgresReportingLedgerStore(poisonPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const poisonManaged = new ledger.PostgresReportingManagedDeliveryStore(poisonPool);
      assert.equal(await poisonManaged.probe(poisonCore), true);
      // A tenant on a 900 second recovery window.
      await seedSkewLedgerInto(poisonCore, poisonManaged, 'poison', 'delivery_only', {
        recoveryWindowMilliseconds: 900_000,
      });
      // A runtime that would advertise 60s must be refused...
      await assert.rejects(
        () => poisonManaged.adoptAdvertisedRecoveryWindowSeconds(60),
        error => /at least the widest installed managed Core recovery window \(900s\)/.test(String(error.cause))
      );
      // ...and must leave nothing behind. Persisting first meant the correct
      // 900s restart was then refused as conflicting with a durable 60.
      const registry = await poisonPool.query(
        `SELECT advertised_recovery_window_seconds::text AS value FROM adcp_reporting_managed_policy`
      );
      assert.equal(registry.rowCount, 0, 'a refused adoption writes nothing');
      await poisonManaged.adoptAdvertisedRecoveryWindowSeconds(900);
      const settledRegistry = await poisonPool.query(
        `SELECT advertised_recovery_window_seconds::text AS value FROM adcp_reporting_managed_policy`
      );
      assert.equal(settledRegistry.rows[0].value, '900', 'the correct value then registers cleanly');
    } finally {
      await poisonPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${poisonSchema}" CASCADE`);
    }
  });

  async function seedSkewLedger(suffix = 'skew', reconciliationMode = 'delivery_only', seedOptions = {}) {
    return seedSkewLedgerInto(core, managed, suffix, reconciliationMode, seedOptions);
  }

  async function seedSkewLedgerInto(
    core,
    managed,
    suffix = 'skew',
    reconciliationMode = 'delivery_only',
    seedOptions = {}
  ) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 10_800_000).toISOString(),
      end: new Date(nowMs - 9_000_000).toISOString(),
    };
    const accountId = `account-managed-${suffix}`;
    const configuration = {
      configurationId: `configuration-managed-${suffix}-1`,
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: `${suffix}-files`,
      delivery_config_version: 1,
      offeringId: `${suffix}-files-v1`,
      report_definition_id: 'analytics-v1',
      feedPurpose: 'analytics',
      requiredFinality: 'official',
      canonicalization: {
        id: 'analytics-rows-v1',
        uri: 'https://schemas.fixture.example/canonicalization.json',
        sha256: 'c'.repeat(64),
        primaryKeys: ['media_buy_id'],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-3'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: period.start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: seedOptions.recoveryWindowMilliseconds ?? 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'analytics-v1' },
      installedAt: period.start,
      semanticFingerprint: `configuration-managed-${suffix}-fingerprint`,
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: `destination-${suffix}-1`,
      generation: 1,
      authorized_at: now,
    });
    const binding = ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: `destination-${suffix}-1`,
      authorization_generation: 1,
      feed_purpose: 'analytics',
      method: 'file_transfer',
      transport: 'fixture_object_store',
      verification_profile: 'canonical_digest',
      reconciliation_mode: reconciliationMode,
      resource_retention_days: 30,
      created_at: now,
    });
    if (seedOptions.install !== false) await managed.installBinding(binding);
    // installBinding refuses a first binding once the configuration has any
    // obligation, so a test exercising the install path itself must stop here.
    if (seedOptions.stopAfterBinding) return { accountId, now, period, configuration, binding };
    const obligation = {
      reporting_obligation_id: `obligation-managed-${suffix}-1`,
      configurationId: configuration.configurationId,
      account: configuration.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: configuration.offeringId,
      report_definition_id: configuration.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'official',
      periodOrdinal: 0,
      period: { ...period, sourceTimezone: 'UTC' },
      schedule: configuration.schedule,
      scopeResolvedAt: period.end,
      coverage: {
        status: 'full',
        evaluatedAt: period.end,
        mediaBuyIds: ['buy-3'],
        fullyCoveredMediaBuyIds: ['buy-3'],
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-3'],
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: period.end,
      recoveryDeadlineAt: new Date(Date.parse(period.end) + 60_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: `obligation-managed-${suffix}-fingerprint`,
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({
      owner: `${suffix}-core-worker`,
      now,
      leaseMilliseconds: 600_000,
      account_id: accountId,
    });
    const rows = [{ media_buy_id: 'buy-3', impressions: 4 }];
    const controlTotals = [{ name: 'impressions', value: '4', value_type: 'integer', unit: 'impressions' }];
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: `revision-managed-${suffix}-1`,
        row_count: rows.length,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const digest = {
      algorithm: 'sha256',
      value: '6'.repeat(64),
      canonicalization_id: 'analytics-rows-v1',
      canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
      canonicalization_sha256: 'c'.repeat(64),
    };
    const revision = {
      reporting_revision_id: `revision-managed-${suffix}-1`,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-managed-${suffix}-1`,
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        byteCount: revisionBytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: now,
      dataThrough: period.end,
      sourceReadCutoffAt: now,
      createdAt: now,
      wireRevision: {
        reporting_revision_id: `revision-managed-${suffix}-1`,
        revision_content_sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        report_definition_id: 'analytics-v1',
        report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
        report_definition_sha256: '9'.repeat(64),
        reporting_profile: 'analytics-v1',
        schema_version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: '8'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        account_id: accountId,
        media_buy_ids: ['buy-3'],
        coverage: {
          status: 'full',
          evaluated_at: now,
          media_buy_ids: ['buy-3'],
          fully_covered_media_buy_ids: ['buy-3'],
          partially_covered_media_buy_ids: [],
          unsupported_media_buy_ids: [],
          unknown_media_buy_ids: [],
          package_ids: [],
          covered_package_ids: [],
          unsupported_package_ids: [],
          unknown_package_ids: [],
          limitations: [],
        },
        period: { ...period, source_timezone: 'UTC' },
        finality: 'official',
        finality_basis: 'contractual_cutoff',
        finality_policy_id: 'contractual-cutoff-v1',
        finalized_at: now,
        observed_at: now,
        data_through: period.end,
        data_through_precision: 'exact',
        row_count: 1,
        control_totals: controlTotals,
        canonical_content_digest: digest,
        created_at: now,
      },
    };
    await core.commitRevision(revision, coreLease);
    return { accountId, now, period, configuration, obligation, revision, binding, coreLease };
  }

  test('refuses a lifecycle apply whose managed state moved under it', async () => {
    const race = await seedSkewLedger('cas', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(race),
      read: async () => Buffer.from('cas bytes'),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: race.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(race.now) + 1000),
      maxIterations: 2,
      account_id: race.accountId,
    });

    const ledgerAsOf = new Date(Date.parse(race.now) + 600_000).toISOString();
    const before = await core.getManagedLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      ledgerAsOf,
    });
    assert.ok(before.managedStateVersion, 'the projection carries a managed-state token');

    // A managed write lands between projection and apply. The stale apply must
    // be refused rather than persisting a health computed before it existed.
    await managed.revokeDestination({
      account_id: race.accountId,
      destination_ref: race.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const after = await core.getManagedLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      ledgerAsOf,
    });
    assert.notEqual(
      after.managedStateVersion,
      before.managedStateVersion,
      'a revocation moves the token; a token that never moves would make the CAS vacuous'
    );

    const stale = await core.applyLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      expectedRevisionIds: [race.revision.reporting_revision_id],
      expectedPreviousHealth: 'waiting',
      expectedObligationState: race.obligation.state,
      expectedAttemptCount: race.obligation.attemptCount,
      projectedIssues: [],
      ledgerAsOf,
      expectedManagedStateVersion: before.managedStateVersion,
    });
    assert.equal(stale.applied, false, 'a stale managed-state token is refused');

    const current = await core.applyLifecycleProjection({
      reporting_obligation_id: race.obligation.reporting_obligation_id,
      expectedRevisionIds: [race.revision.reporting_revision_id],
      expectedPreviousHealth: 'waiting',
      expectedObligationState: race.obligation.state,
      expectedAttemptCount: race.obligation.attemptCount,
      projectedIssues: [],
      ledgerAsOf,
      expectedManagedStateVersion: after.managedStateVersion,
    });
    assert.equal(current.applied, true, 'the same apply succeeds once the token matches — the CAS is not vacuous');
  });

  test('settles provider cleanup durably when the advertised window is zero', async () => {
    const zero = await seedSkewLedger('zerowindow');
    await managed.revokeDestination({
      account_id: zero.accountId,
      destination_ref: zero.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    let attempts = 0;
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(zero),
      read: async () => Buffer.from(''),
      // Slower than a trivial call, to prove the lease actually outlives the
      // work rather than passing because the work was instantaneous.
      revoke: async () => {
        attempts += 1;
        await new Promise(resolve => setTimeout(resolve, 60));
      },
    };
    // A zero-second promise used to scale the lease to 1 ms, which
    // completeRevocation fences against clock_timestamp() — so cleanup could
    // never commit and the grant was stranded forever.
    const result = await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 3,
      account_id: zero.accountId,
      authorizationRevocationSeconds: 0,
      leaseMilliseconds: 30_000,
      deliveryDeadlineMilliseconds: 10_000,
    });
    assert.equal(attempts, 1, 'bounded: the settled grant is not reselected');
    assert.equal(result.revocationsCompleted, 1, 'cleanup commits durably under a zero-second window');
    assert.ok(result.revocationsOverdue >= 1, 'a zero-second window is still reported as overdue');
    const row = await pool.query(
      `SELECT cleanup_completed_at FROM adcp_reporting_destination_authorizations
        WHERE account_id = $1 AND destination_ref = $2 AND generation = 1`,
      [zero.accountId, zero.binding.destination_ref]
    );
    assert.ok(row.rows[0].cleanup_completed_at, 'the durable cleanup marker is set');
  });

  test('orders receipts by the database clock even when the caller clock is skewed', async () => {
    const skewLedger = await seedSkewLedger('receiptclock', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(skewLedger),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: skewLedger.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(skewLedger.now) + 1000),
      maxIterations: 2,
      account_id: skewLedger.accountId,
    });
    const stored = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [skewLedger.obligation.reporting_obligation_id]
    );
    skewLedger.materialization = stored.rows[0].data;

    const context = {
      account: { id: skewLedger.accountId },
      agent: { agent_url: 'https://receiptclock-buyer.example' },
    };
    // A host a year in the past. Nothing durable may take that value.
    const skewed = new Date(Date.now() - 365 * 86_400_000);
    const sync = ledger.createSyncReportingReceiptsHandler(
      managed,
      value => value.agent.agent_url,
      () => skewed
    );
    const response = await sync(
      {
        idempotency_key: 'receipt-clock-skew-0001',
        receipts: [receipt(skewLedger, { reporting_receipt_id: 'receipt-clock-skew-0001' })],
      },
      context
    );
    assert.equal(response.results[0].result, 'recorded');
    const wireReceivedAt = Date.parse(response.results[0].receipt.received_at);
    assert.ok(
      wireReceivedAt > Date.now() - 600_000,
      'the published received_at comes from the database, not the skewed host'
    );
    const columns = await pool.query(
      `SELECT received_at, recorded_at FROM adcp_reporting_receipts WHERE reporting_receipt_id = $1`,
      ['receipt-clock-skew-0001']
    );
    assert.equal(
      columns.rows[0].received_at.toISOString(),
      columns.rows[0].recorded_at.toISOString(),
      'the instant a consumer is shown is the instant its receipt sorts and becomes visible at'
    );

    // The status read and the lifecycle projection must agree about it.
    const status = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })({ account: { account_id: skewLedger.accountId }, view: 'periods', period: skewLedger.period }, context);
    assert.equal(status.periods[0].receipt_count, 1);
    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: skewLedger.obligation.reporting_obligation_id,
      ledgerAsOf: status.ledger_as_of,
    });
    assert.deepEqual(
      projection.consumers.map(value => value.receipts.length),
      [1],
      'the lifecycle projection sees the same receipt the status read does'
    );
  });

  test('frees managed capacity without breaking replay or an advertised horizon', async () => {
    const aged = await seedSkewLedger('retention', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(aged),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: aged.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(aged.now) + 1000),
      maxIterations: 2,
      account_id: aged.accountId,
    });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [aged.obligation.reporting_obligation_id]
    );
    aged.materialization = settled.rows[0].data;

    const context = { account: { id: aged.accountId }, agent: { agent_url: 'https://retention-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const replayRequest = {
      idempotency_key: 'receipt-retention-replay-0001',
      receipts: [receipt(aged, { reporting_receipt_id: 'receipt-retention-0001' })],
    };
    const original = await sync(replayRequest, context);
    assert.equal(original.results[0].result, 'recorded');

    // Retention has a floor: it may not cut inside the replay window or inside
    // an advertised status horizon.
    assert.throws(
      () => new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 29 }),
      /at least the 30-day receipt replay retention/
    );
    assert.throws(
      () =>
        new ledger.PostgresReportingManagedDeliveryStore(pool, {
          evidenceRetentionDays: 60,
          statusRetentionDays: 90,
        }),
      /at least the advertised statusRetentionDays \(90\)/
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, {
      evidenceRetentionDays: 90,
      statusRetentionDays: 90,
    });

    assert.deepEqual(
      await retaining.pruneExpiredEvidence({ account_id: aged.accountId }),
      { materializations: 0, receipts: 0, batches: 0 },
      'nothing inside the retention window is ever removed'
    );

    // Age both the receipt and the materialization past the window, but leave
    // the replay batch row and the resource horizon live.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [aged.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [aged.accountId]
    );
    const heldByReplay = await retaining.pruneExpiredEvidence({ account_id: aged.accountId });
    assert.equal(heldByReplay.receipts, 0, 'a receipt named by a live replay row outlives its own age');
    assert.equal(
      heldByReplay.materializations,
      0,
      'a materialization whose resource is still readable outlives its own age'
    );
    const stillReplays = await sync(replayRequest, context);
    assert.deepEqual(stillReplays, original, 'exact replay survives a prune at the boundary');

    // Expire the replay row and the resource horizon; only now may they go.
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [aged.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [aged.accountId]
    );
    const freed = await retaining.pruneExpiredEvidence({ account_id: aged.accountId });
    assert.equal(freed.batches, 1, 'the expired replay row goes first so it stops pinning its receipts');
    assert.equal(freed.receipts, 1, 'the receipt goes once nothing live references it');
    assert.equal(freed.materializations, 1, 'the materialization goes once its resource horizon has passed');

    // Capacity is freed, but a revision that already succeeded must not be
    // replanned: the attempt tombstone is what stops a pruned success from
    // restarting at attempt 1 and re-delivering.
    assert.equal(
      await retaining.planMaterializations({ account_id: aged.accountId }),
      0,
      'a pruned successful revision does not restart'
    );
    const attemptTombstone = await pool.query(
      `SELECT highest_attempt, reached_success FROM adcp_reporting_materialization_tombstones
        WHERE account_id = $1`,
      [aged.accountId]
    );
    assert.equal(attemptTombstone.rowCount, 1, 'attempt history survives the prune');
    assert.equal(attemptTombstone.rows[0].reached_success, true);
    assert.ok(attemptTombstone.rows[0].highest_attempt >= 1);
    // And the account is not wedged: a different obligation still plans.
    const liveAgain = await seedSkewLedger('retentionlive');
    assert.equal(await retaining.planMaterializations({ account_id: liveAgain.accountId }), 1);

    // Without the option the store keeps lifetime accounting and refuses to
    // prune rather than silently deleting retained evidence.
    await assert.rejects(
      () => managed.pruneExpiredEvidence({ account_id: aged.accountId }),
      /requires PostgresReportingManagedDeliveryStore\(\{ evidenceRetentionDays \}\)/
    );
  });

  test('pairs no stale projection with a current token when a settle interleaves its reads', async () => {
    const race = await seedSkewLedger('interleave');
    await managed.planMaterializations({ account_id: race.accountId });
    const claimed = await managed.claimMaterialization({
      owner: 'interleave-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 120_000,
      account_id: race.accountId,
    });
    assert.ok(claimed, 'a pending materialization is waiting to be settled');

    // Commit the settle from an independent connection at the precise moment
    // the projection has read its materialization rows and has not yet read
    // the digest. Under READ COMMITTED those are two snapshots, so the pairing
    // that defeats the CAS is exactly: pre-settle health, post-settle token.
    const { Pool } = require('pg');
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    let interleaved = 0;
    const interleavingPool = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        client.query = async (sql, values) => {
          const result = await query(sql, values);
          if (
            interleaved === 0 &&
            typeof sql === 'string' &&
            sql.includes('materialization.changed_at') &&
            sql.includes('authz.revoked_at')
          ) {
            interleaved += 1;
            // A committed managed-state change on an independent connection,
            // issued directly so nothing in the store's own locking can be
            // mistaken for the isolation property under test.
            const outcome = materializationOutcome(race);
            const settled = await sidePool.query(
              `UPDATE adcp_reporting_materializations
                  SET status = 'available', changed_at = clock_timestamp(),
                      lease_owner = NULL, lease_expires_at = NULL, data = data || $2::jsonb
                WHERE materialization_id = $1`,
              [
                claimed.materialization.reporting_materialization_id,
                JSON.stringify({
                  status: 'available',
                  ready_at: new Date().toISOString(),
                  resource: outcome.resource,
                  verification: outcome.verification,
                }),
              ]
            );
            assert.equal(settled.rowCount, 1, 'the interleaved settle really did commit mid-projection');
          }
          return result;
        };
        const release = client.release.bind(client);
        client.release = (...args) => {
          client.query = query;
          client.release = release;
          return release(...args);
        };
        return client;
      },
      query: (sql, values) => pool.query(sql, values),
      end: async () => {},
    };

    try {
      const racing = new ledger.PostgresReportingLedgerStore(interleavingPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const ledgerAsOf = new Date(Date.now() + 60_000).toISOString();
      const projection = await racing.getManagedLifecycleProjection({
        reporting_obligation_id: race.obligation.reporting_obligation_id,
        ledgerAsOf,
      });
      assert.equal(interleaved, 1, 'the interleaving actually fired — otherwise this test proves nothing');
      // One snapshot: the projection did not see the settle, so its token
      // cannot be the post-settle one either.
      assert.equal(
        projection.materializationHistory.every(value => value.status === 'pending'),
        true,
        'the projection is internally consistent with the snapshot it read'
      );
      const current = await core.getManagedLifecycleProjection({
        reporting_obligation_id: race.obligation.reporting_obligation_id,
        ledgerAsOf,
      });
      assert.notEqual(
        projection.managedStateVersion,
        current.managedStateVersion,
        'the snapshot token differs from committed state, so apply must refuse it'
      );

      const stale = await core.applyLifecycleProjection({
        reporting_obligation_id: race.obligation.reporting_obligation_id,
        expectedRevisionIds: [race.revision.reporting_revision_id],
        expectedPreviousHealth: 'waiting',
        expectedObligationState: race.obligation.state,
        expectedAttemptCount: race.obligation.attemptCount,
        projectedIssues: [],
        ledgerAsOf,
        expectedManagedStateVersion: projection.managedStateVersion,
      });
      assert.equal(stale.applied, false, 'a health computed before the settle can never be applied');
      const fresh = await core.applyLifecycleProjection({
        reporting_obligation_id: race.obligation.reporting_obligation_id,
        expectedRevisionIds: [race.revision.reporting_revision_id],
        expectedPreviousHealth: 'waiting',
        expectedObligationState: race.obligation.state,
        expectedAttemptCount: race.obligation.attemptCount,
        projectedIssues: [],
        ledgerAsOf,
        expectedManagedStateVersion: current.managedStateVersion,
      });
      assert.equal(fresh.applied, true, 'and the same apply succeeds against post-settle state — not vacuous');
    } finally {
      await sidePool.end();
    }
  });

  test('does not backdate a later settlement into an earlier cutoff', async () => {
    const backdate = await seedSkewLedger('backdate');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(backdate),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    assert.equal(await managed.planMaterializations({ account_id: backdate.accountId }), 1);
    // `recorded_at` is a microsecond timestamp while `toISOString()` truncates
    // to milliseconds, so a cutoff taken in the same millisecond as the insert
    // would sort before it. Step past the boundary rather than race it.
    await new Promise(resolve => setTimeout(resolve, 5));
    // After the row exists, before it is settled.
    const beforeSettle = new Date().toISOString();
    await new Promise(resolve => setTimeout(resolve, 20));
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 2,
      account_id: backdate.accountId,
    });

    const earlier = await core.getManagedLifecycleProjection({
      reporting_obligation_id: backdate.obligation.reporting_obligation_id,
      ledgerAsOf: beforeSettle,
    });
    assert.deepEqual(
      earlier.materializationHistory.map(value => value.status),
      ['pending'],
      'at a cutoff before the settle the row was still pending'
    );
    assert.equal(earlier.materializationHistory[0].resource, undefined);
    assert.equal(earlier.materializationHistory[0].verification, undefined);

    const later = await core.getManagedLifecycleProjection({
      reporting_obligation_id: backdate.obligation.reporting_obligation_id,
      ledgerAsOf: new Date().toISOString(),
    });
    assert.deepEqual(
      later.materializationHistory.map(value => value.status),
      ['available'],
      'and at a cutoff after it the settlement is visible'
    );
  });

  test('releases a failed cleanup lease so a short window stays retry-eligible', async () => {
    const quick = await seedSkewLedger('failfast');
    await managed.revokeDestination({
      account_id: quick.accountId,
      destination_ref: quick.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    let attempts = 0;
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(quick),
      read: async () => Buffer.from(''),
      revoke: async () => {
        attempts += 1;
        throw new Error('provider unavailable');
      },
    };
    // A long lease with a short advertised window: holding the lease as the
    // retry delay would make the grant unreclaimable for 30 s while the 1 s
    // promise elapsed, so it would look leased rather than overdue.
    const first = await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 1,
      account_id: quick.accountId,
      authorizationRevocationSeconds: 1,
      leaseMilliseconds: 30_000,
      deliveryDeadlineMilliseconds: 10_000,
    });
    assert.equal(attempts, 1);
    assert.equal(first.revocationsCompleted, 0);
    const released = await pool.query(
      `SELECT cleanup_lease_owner, cleanup_lease_expires_at, cleanup_lease_generation
         FROM adcp_reporting_destination_authorizations
        WHERE account_id = $1 AND destination_ref = $2 AND generation = 1`,
      [quick.accountId, quick.binding.destination_ref]
    );
    assert.equal(released.rows[0].cleanup_lease_owner, null, 'the failed attempt gave up its lease');
    assert.ok(
      released.rows[0].cleanup_lease_expires_at > new Date(),
      'a short backoff replaces the lease, so the same worker tick cannot reclaim it in a tight loop'
    );
    assert.equal(Number(released.rows[0].cleanup_lease_generation), 1, 'the attempt still counted for ordering');
    assert.equal(
      await managed.claimRevocation({
        owner: 'immediate-worker',
        now: new Date().toISOString(),
        lease_milliseconds: 30_000,
        account_id: quick.accountId,
        authorization_revocation_seconds: 1,
        steal_after_milliseconds: 3_600_000,
      }),
      null,
      'not reclaimable inside the backoff'
    );

    // Retryable once the backoff elapses, and the elapsed SLA is reported
    // independently of any lease being held.
    adapter.revoke = async () => {
      attempts += 1;
    };
    await new Promise(resolve => setTimeout(resolve, 1100));
    // Fast-forward past the retry backoff rather than sleeping through it.
    await pool.query(
      `UPDATE adcp_reporting_destination_authorizations SET cleanup_lease_expires_at = clock_timestamp()
        WHERE account_id = $1 AND destination_ref = $2 AND generation = 1`,
      [quick.accountId, quick.binding.destination_ref]
    );
    const second = await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 2,
      account_id: quick.accountId,
      authorizationRevocationSeconds: 1,
      leaseMilliseconds: 30_000,
      deliveryDeadlineMilliseconds: 10_000,
    });
    assert.equal(attempts, 2, 'the grant is reclaimable once its backoff elapses');
    assert.equal(second.revocationsCompleted, 1);
    assert.ok(second.revocationsOverdue >= 1, 'overdue follows the SLA, not the lease');
  });

  test('holds every store instance to one durable agent-wide recovery window', async () => {
    // The promise is agent-wide and the registry is the database, so this runs
    // in its own schema: registering a window here must not constrain, or be
    // constrained by, the rest of the suite.
    const { Pool } = require('pg');
    const policySchema = `${schema}_policy`;
    await bootstrap.query(`CREATE SCHEMA "${policySchema}"`);
    const policyPool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path="${policySchema}"`,
    });
    try {
      await policyPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await policyPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);

      // Two instances, as two replicas would be, racing incompatible windows.
      const first = new ledger.PostgresReportingManagedDeliveryStore(policyPool);
      const second = new ledger.PostgresReportingManagedDeliveryStore(policyPool);
      const raced = await Promise.allSettled([
        first.adoptAdvertisedRecoveryWindowSeconds(60),
        second.adoptAdvertisedRecoveryWindowSeconds(900),
      ]);
      assert.equal(
        raced.filter(value => value.status === 'fulfilled').length,
        1,
        'exactly one window can win; in-memory state would have let both believe they had'
      );
      const registered = await policyPool.query(
        `SELECT advertised_recovery_window_seconds::text AS value FROM adcp_reporting_managed_policy`
      );
      const winner = Number(registered.rows[0].value);
      assert.ok(winner === 60 || winner === 900);

      // A third instance that never adopted is still held to the durable value.
      const third = new ledger.PostgresReportingManagedDeliveryStore(policyPool);
      await assert.rejects(
        () => third.adoptAdvertisedRecoveryWindowSeconds(winner === 60 ? 900 : 60),
        error => /already registered with an advertised recovery window/.test(String(error.cause))
      );

      // And the bound is enforced on the authoritative install path, by an
      // instance that has adopted nothing in this process.
      const policyCore = new ledger.PostgresReportingLedgerStore(policyPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const widerSeconds = winner + 60;
      const configuration = {
        ...fixture.configuration,
        configurationId: 'configuration-policy-wide-1',
        account: { account_id: 'account-policy' },
        delivery_config_id: 'policy-files',
        schedule: { ...fixture.configuration.schedule, recoveryWindowMilliseconds: widerSeconds * 1000 },
        semanticFingerprint: 'configuration-policy-wide-fingerprint',
      };
      await policyCore.putConfiguration(configuration);
      await third.authorizeDestination({
        account_id: 'account-policy',
        destination_ref: 'destination-policy-1',
        generation: 1,
        authorized_at: fixture.now,
      });
      const wideBinding = ledger.reportingManagedDeliveryBindingV1({
        ...fixture.binding,
        configurationId: configuration.configurationId,
        account_id: 'account-policy',
        delivery_config_id: configuration.delivery_config_id,
        destination_ref: 'destination-policy-1',
      });
      await assert.rejects(
        () => third.installBinding(wideBinding),
        error =>
          /transaction failed/.test(String(error)) &&
          new RegExp(`advertises automated_recovery_window_seconds ${winner}s`).test(String(error.cause))
      );
      const absent = await policyPool.query(
        'SELECT 1 FROM adcp_reporting_managed_bindings WHERE configuration_id = $1',
        [configuration.configurationId]
      );
      assert.equal(absent.rowCount, 0, 'nothing was written');
    } finally {
      await policyPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${policySchema}" CASCADE`);
    }
  });

  test('refuses evidence retention shorter than a durably advertised status horizon', async () => {
    const { Pool } = require('pg');
    const retentionSchema = `${schema}_retention`;
    await bootstrap.query(`CREATE SCHEMA "${retentionSchema}"`);
    const retentionPool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path="${retentionSchema}"`,
    });
    try {
      await retentionPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await retentionPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      // A runtime registers a 90-day status horizon.
      const runtime = new ledger.PostgresReportingManagedDeliveryStore(retentionPool);
      await runtime.adoptAdvertisedStatusRetentionDays(90);
      // A differently configured store with only 30 days of evidence retention
      // must refuse to prune rather than cut inside the registered promise.
      const short = new ledger.PostgresReportingManagedDeliveryStore(retentionPool, { evidenceRetentionDays: 30 });
      await assert.rejects(
        () => short.pruneExpiredEvidence({ account_id: 'account-any' }),
        error => /shorter than the advertised statusRetentionDays 90/.test(String(error.cause))
      );
      const sufficient = new ledger.PostgresReportingManagedDeliveryStore(retentionPool, {
        evidenceRetentionDays: 120,
      });
      assert.deepEqual(await sufficient.pruneExpiredEvidence({ account_id: 'account-any' }), {
        materializations: 0,
        receipts: 0,
        batches: 0,
      });
    } finally {
      await retentionPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${retentionSchema}" CASCADE`);
    }
  });

  test('keeps microsecond cutoff fidelity and ignores a lagging host clock', async () => {
    const micro = await seedSkewLedger('micro');
    await managed.planMaterializations({ account_id: micro.accountId });
    // Pin the row at an exact sub-millisecond instant. A host cutoff of
    // .123000 sorts before .123500, which is how a caller's `toISOString()`
    // silently drops a row written in the same millisecond.
    const pinned = await pool.query(
      `UPDATE adcp_reporting_materializations
          SET recorded_at = $2::timestamptz, changed_at = $2::timestamptz
        WHERE obligation_id = $1 RETURNING recorded_at::text AS recorded_at`,
      [micro.obligation.reporting_obligation_id, '2026-03-01T00:00:00.123500+00']
    );
    assert.equal(pinned.rowCount, 1);
    assert.ok(pinned.rows[0].recorded_at.includes('.1235'), 'the column really holds microseconds');

    const truncated = await core.getManagedLifecycleProjection({
      reporting_obligation_id: micro.obligation.reporting_obligation_id,
      ledgerAsOf: '2026-03-01T00:00:00.123Z',
    });
    assert.equal(truncated.materializationHistory.length, 0, 'a millisecond-truncated cutoff sorts before it');
    assert.equal(
      truncated.resolvedLedgerAsOf.startsWith('2026-03-01T00:00:00.123'),
      true,
      'a pinned cutoff is honoured exactly, not silently replaced'
    );

    const exact = await core.getManagedLifecycleProjection({
      reporting_obligation_id: micro.obligation.reporting_obligation_id,
      ledgerAsOf: '2026-03-01T00:00:00.123500+00',
    });
    assert.equal(exact.materializationHistory.length, 1, 'microsecond fidelity survives the comparison');

    // Unpinned: the store resolves its own instant, so neither a truncating
    // nor a lagging host can hide the row.
    const resolved = await core.getManagedLifecycleProjection({
      reporting_obligation_id: micro.obligation.reporting_obligation_id,
    });
    assert.equal(resolved.materializationHistory.length, 1);
    assert.ok(resolved.resolvedLedgerAsOf, 'the store reports the instant it used');
    assert.ok(
      Date.parse(resolved.resolvedLedgerAsOf) > Date.now() - 600_000,
      'the resolved instant is the database clock, not a lagging caller'
    );

    // A lagging host that reconciles without pinning still sees current state.
    const lagging = await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: micro.obligation.reporting_obligation_id,
      now: () => new Date(Date.now() - 365 * 86_400_000),
    });
    assert.notEqual(lagging, undefined);
  });

  test('schedules a lifecycle reconcile for a managed-only change after complete', async () => {
    const late = await seedSkewLedger('managedonly', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(late),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: late.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 2,
      account_id: late.accountId,
    });
    // Record a transition so the obligation has a "latest" to compare against,
    // and confirm Core alone would not reschedule it.
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: late.obligation.reporting_obligation_id,
    });
    const transitions = await core.listTransitions(late.obligation.reporting_obligation_id);
    assert.ok(transitions.length >= 1, 'the obligation has a persisted transition to go stale');

    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [late.obligation.reporting_obligation_id]
    );
    late.materialization = settled.rows[0].data;

    const dueBefore = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: late.accountId,
      limit: 100,
    });
    const idsBefore = dueBefore.map(value => value.reporting_obligation_id);

    // A managed-only change: a consumer receipt, which writes nothing Core
    // and moves no Core deadline.
    const context = { account: { id: late.accountId }, agent: { agent_url: 'https://managedonly-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const recorded = await sync(
      {
        idempotency_key: 'receipt-managed-only-0001',
        receipts: [receipt(late, { reporting_receipt_id: 'receipt-managed-only-0001' })],
      },
      context
    );
    assert.equal(recorded.results[0].result, 'recorded');

    const dueAfter = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: late.accountId,
      limit: 100,
    });
    assert.ok(
      dueAfter.some(value => value.reporting_obligation_id === late.obligation.reporting_obligation_id),
      'a managed-only receipt makes the obligation a reconcile candidate'
    );
    assert.equal(
      idsBefore.includes(late.obligation.reporting_obligation_id) &&
        dueAfter.length === dueBefore.length &&
        idsBefore.length === dueAfter.length,
      idsBefore.includes(late.obligation.reporting_obligation_id),
      'sanity: the candidate set is driven by the change, not constant'
    );

    // Revocation is a managed-only change too.
    await managed.revokeDestination({
      account_id: late.accountId,
      destination_ref: late.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const dueAfterRevoke = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: late.accountId,
      limit: 100,
    });
    assert.ok(
      dueAfterRevoke.some(value => value.reporting_obligation_id === late.obligation.reporting_obligation_id),
      'a revocation makes the obligation a reconcile candidate'
    );
  });

  test('fences a concurrent external roster change through the lifecycle CAS', async () => {
    const roster = await seedSkewLedger('rosterver', 'consumer_receipt');
    let version = 'v1';
    let reads = 0;
    const rosterAware = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => {
        reads += 1;
        return { ids: ['https://roster-buyer.example'], complete: true, version };
      },
    });
    const projection = await rosterAware.getManagedLifecycleProjection({
      reporting_obligation_id: roster.obligation.reporting_obligation_id,
    });
    assert.equal(projection.obligatedConsumerRosterVersion, 'v1');

    // The roster changes between projection and apply, outside the database.
    version = 'v2';
    assert.equal(
      await rosterAware.readObligatedConsumerRosterVersion({
        reporting_obligation_id: roster.obligation.reporting_obligation_id,
      }),
      'v2',
      'the version the reconciler re-reads reflects the change'
    );
    assert.ok(reads >= 2, 'the roster really is re-read rather than cached');

    // A roster with no declared version still moves when its content does.
    let ids = ['https://a.example'];
    const contentVersioned = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids, complete: true }),
    });
    const before = await contentVersioned.readObligatedConsumerRosterVersion({
      reporting_obligation_id: roster.obligation.reporting_obligation_id,
    });
    ids = ['https://a.example', 'https://b.example'];
    const after = await contentVersioned.readObligatedConsumerRosterVersion({
      reporting_obligation_id: roster.obligation.reporting_obligation_id,
    });
    assert.notEqual(before, after, 'an unversioned roster is still fenced by its content');
  });

  test('reclaims a crashed cleanup lease at the SLA boundary and counts overdue on the DB clock', async () => {
    const crashed = await seedSkewLedger('crashlease');
    await managed.revokeDestination({
      account_id: crashed.accountId,
      destination_ref: crashed.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    // A worker takes a very long lease and never comes back.
    const abandoned = await managed.claimRevocation({
      owner: 'crashed-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 3_600_000,
      account_id: crashed.accountId,
      authorization_revocation_seconds: 1,
    });
    assert.ok(abandoned);
    assert.equal(abandoned.overdue, false, 'inside the window at claim time');
    assert.ok(abandoned.remaining_milliseconds > 0);
    assert.ok(abandoned.revoked_at, 'the SLA anchor comes from the database, not the worker');

    // Not reclaimable while both the lease and the window hold.
    assert.equal(
      await managed.claimRevocation({
        owner: 'other-worker',
        now: new Date().toISOString(),
        lease_milliseconds: 60_000,
        account_id: crashed.accountId,
        authorization_revocation_seconds: 3_600,
        steal_after_milliseconds: 500,
      }),
      null
    );
    // Nor may a live holder be displaced merely because the SLA has passed:
    // without a stable steal grace every worker bumps the generation and
    // invalidates the previous holder's completion, so cleanup never lands.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(
      await managed.claimRevocation({
        owner: 'thrash-worker',
        now: new Date().toISOString(),
        lease_milliseconds: 60_000,
        account_id: crashed.accountId,
        authorization_revocation_seconds: 1,
        steal_after_milliseconds: 3_600_000,
      }),
      null,
      'an overdue grant is not stolen from a holder still inside its attempt budget'
    );

    // Past the 1s SLA the grant is reclaimable even though the hour-long lease
    // has not expired, and the database reports it overdue.
    const reclaimed = await managed.claimRevocation({
      owner: 'recovery-worker',
      now: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      lease_milliseconds: 60_000,
      account_id: crashed.accountId,
      authorization_revocation_seconds: 1,
      // The crashed holder has had its full attempt budget and not finished.
      steal_after_milliseconds: 500,
    });
    assert.ok(reclaimed, 'the SLA boundary reclaims a crashed lease');
    assert.equal(reclaimed.overdue, true, 'overdue is computed on the DB clock, not the skewed caller');
    assert.ok(reclaimed.generation > abandoned.generation, 'generation fences the crashed holder');
    assert.equal(
      await managed.completeRevocation({ lease: abandoned, completed_at: new Date().toISOString() }),
      false,
      'the crashed holder cannot commit over the new one'
    );
    assert.equal(await managed.completeRevocation({ lease: reclaimed, completed_at: new Date().toISOString() }), true);
  });

  test('keeps pruned receipt identity and terminal subjects permanent', async () => {
    const tomb = await seedSkewLedger('tombstone', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(tomb),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: tomb.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: tomb.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [tomb.obligation.reporting_obligation_id]
    );
    tomb.materialization = settled.rows[0].data;

    const context = { account: { id: tomb.accountId }, agent: { agent_url: 'https://tombstone-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const accepted = receipt(tomb, { reporting_receipt_id: 'receipt-tombstone-0001' });
    assert.equal(
      (await sync({ idempotency_key: 'receipt-tombstone-batch-0001', receipts: [accepted] }, context)).results[0]
        .result,
      'recorded'
    );

    // Age everything past retention and prune the bodies.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [tomb.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [tomb.accountId]
    );
    // An acceptance is held while its resource is still readable, so the
    // horizon has to pass before the body may be pruned.
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [tomb.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const pruned = await retaining.pruneExpiredEvidence({ account_id: tomb.accountId });
    assert.equal(pruned.receipts, 1, 'the body aged out');
    const tombstones = await pool.query(
      `SELECT status, was_current FROM adcp_reporting_receipt_tombstones WHERE reporting_receipt_id = $1`,
      ['receipt-tombstone-0001']
    );
    assert.equal(tombstones.rowCount, 1, 'identity is retained permanently');
    assert.equal(tombstones.rows[0].status, 'accepted');

    // The id cannot be rebound to different content now the body is gone.
    const rebind = await sync(
      {
        idempotency_key: 'receipt-tombstone-batch-0002',
        receipts: [receipt(tomb, { reporting_receipt_id: 'receipt-tombstone-0001', observed_row_count: 99 })],
      },
      context
    );
    assert.equal(rebind.results[0].result, 'failed', 'a pruned receipt id cannot bind new content');

    // And the terminal accepted subject cannot reopen.
    const reopen = await sync(
      {
        idempotency_key: 'receipt-tombstone-batch-0003',
        receipts: [
          receipt(tomb, {
            reporting_receipt_id: 'receipt-tombstone-reopen-01',
            status: 'rejected',
            rejection_codes: ['ROW_COUNT_MISMATCH'],
          }),
        ],
      },
      context
    );
    assert.equal(reopen.results[0].result, 'failed', 'a terminal subject stays terminal after its body expires');
  });

  test('advances a reconciliation watermark even when health does not move', async () => {
    const wm = await seedSkewLedger('watermark', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(wm),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: wm.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: wm.accountId });
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: wm.obligation.reporting_obligation_id,
    });
    const first = await pool.query(
      `SELECT processed_at, processed_state_version FROM adcp_reporting_lifecycle_state
        WHERE obligation_id = $1`,
      [wm.obligation.reporting_obligation_id]
    );
    assert.equal(first.rowCount, 1, 'a reconcile records that it looked');
    assert.ok(first.rows[0].processed_state_version);

    const dueBefore = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: wm.accountId,
      limit: 100,
    });
    assert.equal(
      dueBefore.some(value => value.reporting_obligation_id === wm.obligation.reporting_obligation_id),
      false,
      'a reconciled obligation stops being due even though its health never changed'
    );

    // A managed change makes it due again; reconciling it clears it again,
    // so it cannot sit at the head of a fair-ordered page forever.
    await managed.revokeDestination({
      account_id: wm.accountId,
      destination_ref: wm.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const dueAfter = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: wm.accountId,
      limit: 100,
    });
    assert.ok(dueAfter.some(value => value.reporting_obligation_id === wm.obligation.reporting_obligation_id));
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: wm.obligation.reporting_obligation_id,
    });
    const second = await pool.query(
      `SELECT processed_at FROM adcp_reporting_lifecycle_state WHERE obligation_id = $1`,
      [wm.obligation.reporting_obligation_id]
    );
    assert.ok(
      second.rows[0].processed_at > first.rows[0].processed_at,
      'the watermark advances, so the obligation drains instead of starving newer work'
    );
    const drained = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: wm.accountId,
      limit: 1,
    });
    assert.equal(
      drained.some(value => value.reporting_obligation_id === wm.obligation.reporting_obligation_id),
      false,
      'at limit 1 it no longer occupies the only slot'
    );
  });

  test('isolates one tenant failure from the rest of a sweep', async () => {
    const healthy = await seedSkewLedger('sweephealthy', 'consumer_receipt');
    const poison = await seedSkewLedger('sweeppoison', 'consumer_receipt');
    // A roster callback that throws only for the poisoned tenant. Before
    // isolation this aborted the whole sweep at that obligation.
    let healthyReconciled = 0;
    const sweepStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async input => {
        if (input.account_id === poison.accountId) throw new Error('authorization service unavailable');
        healthyReconciled += 1;
        return { ids: [], complete: true, version: 'v1' };
      },
    });
    // A direct reconcile still surfaces the error to its caller — only the
    // sweep contains it, and only per obligation.
    await assert.rejects(() =>
      ledger.reconcileReportingStatusLifecycleV1({
        store: sweepStore,
        reporting_obligation_id: poison.obligation.reporting_obligation_id,
      })
    );
    // Drive the real sweep path and confirm it reports what it attempted.
    const swept = await ledger.reconcileReportingStatusDeadlinesV1({
      store: sweepStore,
      ledgerAsOf: await core.readLedgerInstant(),
      limit: 100,
    });
    assert.ok(swept >= 1, 'the sweep completes despite a failing tenant');
    assert.ok(healthyReconciled >= 1, 'the healthy tenant was still reconciled');
    const poisonState = await pool.query(
      `SELECT processed_state_version, failure_count, next_attempt_at
         FROM adcp_reporting_lifecycle_state WHERE obligation_id = $1`,
      [poison.obligation.reporting_obligation_id]
    );
    assert.equal(poisonState.rows[0].processed_state_version, null, 'the watermark never advances on failure');
    assert.ok(poisonState.rows[0].failure_count >= 1, 'the failure is counted');
    assert.ok(poisonState.rows[0].next_attempt_at > new Date(), 'and backed off rather than re-run immediately');
    // Backed off, not hidden: the failing tenant yields its slot so a page of
    // poison tenants cannot monopolise every sweep.
    const fairPage = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: poison.accountId,
      limit: 1,
    });
    assert.equal(
      fairPage.some(value => value.reporting_obligation_id === poison.obligation.reporting_obligation_id),
      false,
      'the failing tenant yields its slot while backed off'
    );
  });

  test('retries managed readiness after a transient database failure', async () => {
    let failNext = true;
    const flaky = {
      connect: () => pool.connect(),
      query: (sql, values) => {
        if (failNext && typeof sql === 'string' && sql.includes('to_regclass')) {
          failNext = false;
          return Promise.reject(new Error('transient connection reset'));
        }
        return pool.query(sql, values);
      },
      end: async () => {},
    };
    const store = new ledger.PostgresReportingLedgerStore(flaky, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
    });
    const asOf = await core.readLedgerInstant();
    await assert.rejects(() => store.listLifecycleDueObligations({ ledgerAsOf: asOf, limit: 10 }));
    // A cached rejection would have disabled every later sweep until restart.
    const recovered = await store.listLifecycleDueObligations({ ledgerAsOf: asOf, limit: 10 });
    assert.ok(Array.isArray(recovered), 'readiness is re-probed rather than permanently poisoned');
  });

  test('keeps an authoritative roster free of unlisted principals', async () => {
    const authoritative = await seedSkewLedger('authroster', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(authoritative),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: authoritative.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      maxIterations: 2,
      account_id: authoritative.accountId,
    });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [authoritative.obligation.reporting_obligation_id]
    );
    authoritative.materialization = settled.rows[0].data;

    // A principal on the same account that is NOT on the authoritative roster
    // posts a receipt. It must not thereby join the obligated set.
    const rogue = { account: { id: authoritative.accountId }, agent: { agent_url: 'https://rogue.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    await sync(
      {
        idempotency_key: 'receipt-rogue-0001',
        receipts: [receipt(authoritative, { reporting_receipt_id: 'receipt-rogue-0001' })],
      },
      rogue
    );

    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: ['https://listed.example'], complete: true }),
    });
    const projection = await rosterStore.getManagedLifecycleProjection({
      reporting_obligation_id: authoritative.obligation.reporting_obligation_id,
    });
    assert.deepEqual(
      projection.obligatedConsumerIds,
      ['https://listed.example'],
      'a complete roster excludes principals it does not list'
    );
    assert.equal(
      projection.obligatedConsumerIds.includes('https://rogue.example'),
      false,
      'a same-account rogue principal cannot insert itself into the obligated set'
    );
    // The version the reconciler re-reads must match what the projection
    // hashed, or an unversioned roster burns its retry budget every pass.
    assert.equal(
      await rosterStore.readObligatedConsumerRosterVersion({
        reporting_obligation_id: authoritative.obligation.reporting_obligation_id,
      }),
      projection.obligatedConsumerRosterVersion,
      'projection and re-check agree, so an unversioned roster converges'
    );

    // An incomplete roster is only a hint, so observed principals still count.
    const hintStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: ['https://listed.example'], complete: false }),
    });
    const hinted = await hintStore.getManagedLifecycleProjection({
      reporting_obligation_id: authoritative.obligation.reporting_obligation_id,
    });
    assert.ok(hinted.obligatedConsumerIds.includes('https://rogue.example'));
    assert.equal(
      await hintStore.readObligatedConsumerRosterVersion({
        reporting_obligation_id: authoritative.obligation.reporting_obligation_id,
      }),
      hinted.obligatedConsumerRosterVersion
    );
  });

  test('refuses a billing binding without consumer-receipt reconciliation', async () => {
    const illegal = await seedSkewLedger('illegalbilling', 'delivery_only', { install: false, stopAfterBinding: true });
    const billingBinding = ledger.reportingManagedDeliveryBindingV1({
      ...illegal.binding,
      feed_purpose: 'billing',
      reconciliation_mode: 'delivery_only',
    });
    await assert.rejects(
      () => managed.installBinding(billingBinding),
      error => /Billing managed bindings require consumer-receipt reconciliation/.test(String(error.cause))
    );
    const absent = await pool.query('SELECT 1 FROM adcp_reporting_managed_bindings WHERE configuration_id = $1', [
      illegal.configuration.configurationId,
    ]);
    assert.equal(absent.rowCount, 0, 'the illegal pairing never lands');
  });

  test('watermarks at the projection cutoff, not the commit instant', async () => {
    const gap = await seedSkewLedger('cutoffgap', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(gap),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: gap.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: gap.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [gap.obligation.reporting_obligation_id]
    );
    gap.materialization = settled.rows[0].data;

    // Reconcile at a cutoff deliberately in the past, with nothing changing
    // underneath, so no CAS retry moves the cutoff forward.
    const pastCutoff = new Date(Date.now() - 60_000).toISOString();
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: gap.obligation.reporting_obligation_id,
      ledgerAsOf: pastCutoff,
    });
    const watermark = await pool.query(
      `SELECT processed_at FROM adcp_reporting_lifecycle_state WHERE obligation_id = $1`,
      [gap.obligation.reporting_obligation_id]
    );
    assert.equal(
      watermark.rows[0].processed_at.toISOString(),
      new Date(pastCutoff).toISOString(),
      'the watermark is the cutoff the projection read at, not the commit instant'
    );

    // Anything recorded after that cutoff — including work that landed while
    // the reconcile was committing — is therefore still due. Watermarking at
    // commit time would have buried it permanently.
    const context = { account: { id: gap.accountId }, agent: { agent_url: 'https://cutoffgap-buyer.example' } };
    const recorded = await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-cutoff-gap-0001',
        receipts: [receipt(gap, { reporting_receipt_id: 'receipt-cutoff-gap-0001' })],
      },
      context
    );
    assert.equal(recorded.results[0].result, 'recorded');
    const due = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: gap.accountId,
      limit: 100,
    });
    assert.ok(
      due.some(value => value.reporting_obligation_id === gap.obligation.reporting_obligation_id),
      'a change after the cutoff is still due'
    );
  });

  test('re-arms a lifecycle reconcile when the external roster version changes', async () => {
    const rearm = await seedSkewLedger('rosterrearm', 'consumer_receipt');
    let version = 'r1';
    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: ['https://rearm.example'], complete: true, version }),
    });
    await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: rearm.obligation.reporting_obligation_id,
    });
    const settledDue = await rosterStore.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: rearm.accountId,
      limit: 100,
    });
    assert.equal(
      settledDue.some(value => value.reporting_obligation_id === rearm.obligation.reporting_obligation_id),
      false,
      'a reconciled obligation is not due on an unchanged roster'
    );

    // The roster changes outside the database. Publishing the observed
    // version is what makes it visible to due selection at all.
    version = 'r2';
    // Refresh through the sweep's own path rather than calling the reader
    // directly: a manual refresh would mask the circularity being tested.
    await rosterStore.refreshObligatedConsumerRosterVersions({
      account_id: rearm.accountId,
      limit: 100,
    });
    const rearmedDue = await rosterStore.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: rearm.accountId,
      limit: 100,
    });
    assert.ok(
      rearmedDue.some(value => value.reporting_obligation_id === rearm.obligation.reporting_obligation_id),
      'a roster version change schedules reconciliation'
    );
    const stored = await pool.query(
      `SELECT current_roster_version, processed_roster_version FROM adcp_reporting_lifecycle_state
        WHERE obligation_id = $1`,
      [rearm.obligation.reporting_obligation_id]
    );
    assert.equal(stored.rows[0].current_roster_version, 'r2');
    assert.equal(stored.rows[0].processed_roster_version, 'r1');
  });

  test('keeps pruned conclusions in the lifecycle and filtered projections', async () => {
    const conclusions = await seedSkewLedger('conclusions', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(conclusions),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: conclusions.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: conclusions.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [conclusions.obligation.reporting_obligation_id]
    );
    conclusions.materialization = settled.rows[0].data;
    const context = {
      account: { id: conclusions.accountId },
      agent: { agent_url: 'https://conclusions-buyer.example' },
    };
    await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-conclusions-0001',
        receipts: [receipt(conclusions, { reporting_receipt_id: 'receipt-conclusions-0001' })],
      },
      context
    );
    const beforePrune = await core.getManagedLifecycleProjection({
      reporting_obligation_id: conclusions.obligation.reporting_obligation_id,
    });
    assert.ok(beforePrune.consumers.length >= 1);

    // Age everything out and prune both bodies and attempt rows.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [conclusions.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [conclusions.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET recorded_at = clock_timestamp() - INTERVAL '200 days',
              data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [conclusions.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const pruned = await retaining.pruneExpiredEvidence({ account_id: conclusions.accountId });
    assert.equal(pruned.receipts, 1);
    assert.equal(pruned.materializations, 1);

    // Both conclusions must survive their evidence in the lifecycle
    // projection: the acceptance, and the fact a delivery ever happened.
    const afterPrune = await core.getManagedLifecycleProjection({
      reporting_obligation_id: conclusions.obligation.reporting_obligation_id,
    });
    assert.deepEqual(
      afterPrune.tombstonedAcceptedSubjects.map(value => value.subjectId),
      [conclusions.revision.reporting_revision_id],
      'the accepted subject survives as a tombstone'
    );
    assert.deepEqual(
      [...afterPrune.tombstonedDeliveredRevisionIds],
      [conclusions.revision.reporting_revision_id],
      'so does the fact that a delivery succeeded'
    );
    // Without the delivered tombstone the handler would compute
    // deliveredEver=false and drag the accepted subject back to pending.
    const status = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })({ account: { account_id: conclusions.accountId }, view: 'periods', period: conclusions.period }, context);
    assert.equal(
      status.periods[0].reconciliation_status,
      'accepted',
      'a settled period stays settled after its evidence ages out'
    );
  });

  test('rejects a settle the database considers under-retained and terminalizes it', async () => {
    const retain = await seedSkewLedger('underretain');
    await managed.planMaterializations({ account_id: retain.accountId });
    const claimed = await managed.claimMaterialization({
      owner: 'retention-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 120_000,
      account_id: retain.accountId,
    });
    assert.ok(claimed);
    const outcome = materializationOutcome(retain);
    // Expires in a day; the binding promises 30. A worker whose clock lags
    // could satisfy 30 days locally, so the database has to judge it.
    outcome.resource.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    const settled = await managed.settleMaterialization({
      lease: claimed,
      now: new Date().toISOString(),
      outcome,
      minimum_resource_retention_days: 30,
    });
    assert.equal(settled, false, 'the database refuses an under-retained resource');
    const row = await pool.query(
      `SELECT status, data ->> 'failure_code' AS failure_code FROM adcp_reporting_materializations
        WHERE materialization_id = $1`,
      [claimed.materialization.reporting_materialization_id]
    );
    assert.equal(row.rows[0].status, 'failed', 'and does not leave the row pending forever');
    assert.equal(row.rows[0].failure_code, 'RESOURCE_RETENTION_INSUFFICIENT');
    // The attempt is spent, so the revision can be replanned rather than stuck.
    assert.equal(await managed.planMaterializations({ account_id: retain.accountId }), 1);
  });

  test('refuses a billing binding whose Core configuration is not official finality', async () => {
    const legacy = await seedSkewLedger('legacybilling', 'consumer_receipt', {
      install: false,
      stopAfterBinding: true,
    });
    // A configuration generation created before billing implied official
    // finality. Core install would refuse it today; the row still exists.
    await pool.query(
      `UPDATE adcp_reporting_configurations
          SET data = jsonb_set(jsonb_set(data, '{feedPurpose}', '"billing"'), '{requiredFinality}', '"snapshot"')
        WHERE configuration_id = $1`,
      [legacy.configuration.configurationId]
    );
    const billingBinding = ledger.reportingManagedDeliveryBindingV1({
      ...legacy.binding,
      feed_purpose: 'billing',
      reconciliation_mode: 'consumer_receipt',
    });
    await assert.rejects(
      () => managed.installBinding(billingBinding),
      error => /official finality/.test(String(error.cause))
    );
    const absent = await pool.query('SELECT 1 FROM adcp_reporting_managed_bindings WHERE configuration_id = $1', [
      legacy.configuration.configurationId,
    ]);
    assert.equal(absent.rowCount, 0, 'the legacy configuration cannot be bound for billing');
  });

  test('does not let one consumer pruned acceptance settle the obligation for another', async () => {
    const shared = await seedSkewLedger('twoconsumer', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(shared),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: shared.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: shared.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [shared.obligation.reporting_obligation_id]
    );
    shared.materialization = settled.rows[0].data;

    // Only consumer A accepts. B owes a receipt and never sends one.
    const contextA = { account: { id: shared.accountId }, agent: { agent_url: 'https://consumer-a.example' } };
    await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-two-consumer-a-0001',
        receipts: [receipt(shared, { reporting_receipt_id: 'receipt-two-consumer-a-0001' })],
      },
      contextA
    );
    // Prune A's body so only its tombstone remains.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [shared.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [shared.accountId]
    );
    // An acceptance is held while its resource is still readable, so the
    // horizon has to pass before the body may be pruned.
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [shared.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    assert.equal((await retaining.pruneExpiredEvidence({ account_id: shared.accountId })).receipts, 1);

    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: shared.obligation.reporting_obligation_id,
    });
    assert.deepEqual(
      projection.tombstonedAcceptedSubjects.map(value => value.consumerId),
      ['https://consumer-a.example'],
      'the tombstone remembers whose acceptance it was'
    );

    // A roster naming both consumers: A is settled by its tombstone, B is not.
    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({
        ids: ['https://consumer-a.example', 'https://consumer-b.example'],
        complete: true,
        version: 'two',
      }),
    });
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: shared.obligation.reporting_obligation_id,
    });
    assert.equal(
      transition?.health ?? 'action_required',
      'action_required',
      "A's pruned acceptance must not settle the obligation on B's behalf"
    );
    // And B's own read still shows it owes a receipt.
    const statusB = await ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    })(
      { account: { account_id: shared.accountId }, view: 'periods', period: shared.period },
      { account: { id: shared.accountId }, agent: { agent_url: 'https://consumer-b.example' } }
    );
    assert.equal(statusB.periods[0].reconciliation_status, 'pending');
  });

  test('re-arms on a roster change without anyone reconciling first', async () => {
    const autonomous = await seedSkewLedger('rosterauto', 'consumer_receipt');
    let version = 'a1';
    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: ['https://auto.example'], complete: true, version }),
    });
    await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: autonomous.obligation.reporting_obligation_id,
    });
    assert.equal(
      (
        await rosterStore.listLifecycleDueObligations({
          ledgerAsOf: await core.readLedgerInstant(),
          account_id: autonomous.accountId,
          limit: 100,
        })
      ).some(value => value.reporting_obligation_id === autonomous.obligation.reporting_obligation_id),
      false,
      'settled on an unchanged roster'
    );

    // The roster changes outside the database and nobody reconciles. The
    // sweep itself has to notice — publishing the version only inside a
    // reconcile was circular, so this never became due.
    version = 'a2';
    const swept = await ledger.reconcileReportingStatusDeadlinesV1({
      store: rosterStore,
      account_id: autonomous.accountId,
      limit: 100,
    });
    assert.ok(swept >= 0);
    const stored = await pool.query(
      `SELECT current_roster_version, processed_roster_version FROM adcp_reporting_lifecycle_state
        WHERE obligation_id = $1`,
      [autonomous.obligation.reporting_obligation_id]
    );
    assert.equal(
      stored.rows[0].current_roster_version,
      stored.rows[0].processed_roster_version,
      'the sweep both noticed the change and reconciled it'
    );
    assert.equal(stored.rows[0].processed_roster_version, 'a2');
  });

  test('does not overwrite a roster observation published while the apply was in flight', async () => {
    const raced = await seedSkewLedger('rostercas', 'consumer_receipt');
    let version = 'r1';
    const roster = async () => ({ ids: ['https://rostercas.example'], complete: true, version });
    const { Pool } = require('pg');
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    const sideStore = new ledger.PostgresReportingLedgerStore(sidePool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: roster,
    });
    let interleaved = 0;
    const interleavingPool = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        client.query = async (sql, values) => {
          const result = await query(sql, values);
          if (
            interleaved === 0 &&
            typeof sql === 'string' &&
            sql.includes('FROM adcp_reporting_obligations WHERE obligation_id = $1 FOR UPDATE')
          ) {
            interleaved += 1;
            // The roster changes and a refresh publishes it on an
            // independent connection, after this reconcile re-checked the
            // version and while its apply is open. The apply then wrote the
            // version it had used over the newer observation, and because
            // due-ness is exactly "current differs from processed", the
            // change had nothing left to re-arm from.
            version = 'r2';
            await sideStore.recordObligatedConsumerRosterVersion({
              reporting_obligation_id: raced.obligation.reporting_obligation_id,
              version: 'r2',
            });
          }
          return result;
        };
        const release = client.release.bind(client);
        client.release = (...args) => {
          client.query = query;
          client.release = release;
          return release(...args);
        };
        return client;
      },
      query: (sql, values) => pool.query(sql, values),
      end: async () => {},
    };

    try {
      const rosterStore = new ledger.PostgresReportingLedgerStore(interleavingPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
        obligatedConsumers: roster,
      });
      await ledger.reconcileReportingStatusLifecycleV1({
        store: rosterStore,
        reporting_obligation_id: raced.obligation.reporting_obligation_id,
      });
      assert.equal(interleaved, 1, 'the interleaving actually fired — otherwise this test proves nothing');
      const stored = await pool.query(
        `SELECT current_roster_version, processed_roster_version FROM adcp_reporting_lifecycle_state
          WHERE obligation_id = $1`,
        [raced.obligation.reporting_obligation_id]
      );
      assert.equal(
        stored.rows[0].current_roster_version,
        'r2',
        'the newer roster observation survives the apply that did not see it'
      );
      // Either it was reconciled against r2 on the retry, or it is still due
      // for one. What it may never be is settled against r1 with the change
      // erased.
      const settledAgainstStale =
        stored.rows[0].processed_roster_version === 'r1' && stored.rows[0].current_roster_version === 'r1';
      assert.equal(settledAgainstStale, false);
    } finally {
      await sidePool.end();
    }
  });

  test('does not let a fast worker host bury database-timestamped work', async () => {
    const skewed = await seedSkewLedger('hostskew', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(skewed),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: skewed.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: skewed.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [skewed.obligation.reporting_obligation_id]
    );
    skewed.materialization = settled.rows[0].data;

    // A sweep driven with no pinned cutoff resolves the ledger's clock, so a
    // host running a minute fast cannot stamp a future watermark.
    await ledger.reconcileReportingStatusDeadlinesV1({ store: core, account_id: skewed.accountId, limit: 100 });
    const watermark = await pool.query(
      `SELECT processed_at, clock_timestamp() AS db_now FROM adcp_reporting_lifecycle_state
        WHERE obligation_id = $1`,
      [skewed.obligation.reporting_obligation_id]
    );
    assert.ok(watermark.rowCount === 1);
    assert.ok(
      watermark.rows[0].processed_at <= watermark.rows[0].db_now,
      'the watermark never runs ahead of the database clock'
    );

    // A receipt committed now must still be seen, which a host-pinned future
    // watermark would have buried.
    const context = { account: { id: skewed.accountId }, agent: { agent_url: 'https://hostskew-buyer.example' } };
    await ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url)(
      {
        idempotency_key: 'receipt-host-skew-0001',
        receipts: [receipt(skewed, { reporting_receipt_id: 'receipt-host-skew-0001' })],
      },
      context
    );
    const due = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: skewed.accountId,
      limit: 100,
    });
    assert.ok(
      due.some(value => value.reporting_obligation_id === skewed.obligation.reporting_obligation_id),
      'work committed after the sweep is still due'
    );
  });

  test('holds an acceptance while its resource is readable and keeps counters on emitted records', async () => {
    const counters = await seedSkewLedger('counters', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(counters),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: counters.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, { maxIterations: 2, account_id: counters.accountId });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [counters.obligation.reporting_obligation_id]
    );
    counters.materialization = settled.rows[0].data;
    const context = { account: { id: counters.accountId }, agent: { agent_url: 'https://counters-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const rejected = await sync(
      {
        idempotency_key: 'receipt-counters-0001',
        receipts: [
          receipt(counters, {
            reporting_receipt_id: 'receipt-counters-rejected-01',
            status: 'rejected',
            observed_row_count: 99,
            rejection_codes: ['ROW_COUNT_MISMATCH'],
          }),
        ],
      },
      context
    );
    assert.equal(rejected.results[0].result, 'recorded');
    await sync(
      {
        idempotency_key: 'receipt-counters-0002',
        receipts: [
          receipt(counters, {
            reporting_receipt_id: 'receipt-counters-accepted-01',
            supersedes_reporting_receipt_id: 'receipt-counters-rejected-01',
          }),
        ],
      },
      context
    );

    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      { account: { account_id: counters.accountId }, view: 'periods', period: counters.period },
      context
    );
    const period = status.periods[0];
    // Counters must describe exactly what the response emits. Counting only
    // the required revision's receipts undercounted the repaired chain, which
    // a buyer recomputing the association reports as
    // ASSOCIATED_HISTORY_INCOMPLETE.
    assert.equal(
      period.receipt_count,
      status.receipts.filter(value => value.reporting_obligation_id === period.reporting_obligation_id).length,
      'receipt_count equals the receipts actually emitted'
    );
    assert.equal(
      period.accepted_receipt_count,
      status.receipts.filter(
        value => value.reporting_obligation_id === period.reporting_obligation_id && value.status === 'accepted'
      ).length
    );
    assert.equal(period.receipt_count, 2, 'both the rejected and the repairing receipt are counted');
    assert.equal(
      validateResponse('get_reporting_status', status, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', status, '3.2.0-rc.3').issues)
    );

    // Retention holds the acceptance while the resource it accepts is still
    // readable, so a period can never read complete with nothing to show.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [counters.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [counters.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    assert.equal(
      (await retaining.pruneExpiredEvidence({ account_id: counters.accountId })).receipts,
      0,
      'an acceptance outlives its own age while its resource is readable'
    );
    const stillValid = await getStatus(
      { account: { account_id: counters.accountId }, view: 'periods', period: counters.period },
      context
    );
    assert.equal(validateResponse('get_reporting_status', stillValid, '3.2.0-rc.3').valid, true);

    // Once the resource horizon passes, both may go together.
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}',
                to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [counters.accountId]
    );
    assert.equal((await retaining.pruneExpiredEvidence({ account_id: counters.accountId })).receipts, 2);
    const afterPrune = await getStatus(
      { account: { account_id: counters.accountId }, view: 'periods', period: counters.period },
      context
    );
    assert.equal(
      afterPrune.periods[0].receipt_count,
      0,
      'counters still describe emitted records once the bodies are gone'
    );
    assert.notEqual(afterPrune.periods[0].health, 'complete', 'and the period no longer claims to be settled');
    assert.equal(
      validateResponse('get_reporting_status', afterPrune, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', afterPrune, '3.2.0-rc.3').issues)
    );
  });

  test('advances the roster refresh cursor past a full page', async () => {
    // Its own schema: the cursor is global, so a shared schema full of other
    // obligations makes "which page did it pick" unanswerable.
    const { Pool } = require('pg');
    const cursorSchema = `${schema}_cursor`;
    await bootstrap.query(`CREATE SCHEMA "${cursorSchema}"`);
    const cursorPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${cursorSchema}"` });
    try {
      await cursorPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await cursorPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const cursorCore = new ledger.PostgresReportingLedgerStore(cursorPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const cursorManaged = new ledger.PostgresReportingManagedDeliveryStore(cursorPool);
      assert.equal(await cursorManaged.probe(cursorCore), true);
      const ids = [];
      for (const suffix of ['one', 'two']) {
        const seeded = await seedSkewLedgerInto(cursorCore, cursorManaged, `cursor${suffix}`, 'consumer_receipt');
        ids.push(seeded.obligation.reporting_obligation_id);
      }
      const seen = [];
      const rosterStore = new ledger.PostgresReportingLedgerStore(cursorPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
        obligatedConsumers: async input => {
          seen.push(input.reporting_obligation_id);
          return { ids: [], complete: true, version: 'c1' };
        },
      });
      // One obligation per page. Ordering by the reconciliation watermark —
      // which a refresh never advances — made every sweep re-read the same
      // first row, so nothing beyond one page was ever refreshed and those
      // obligations' roster changes could never re-arm.
      assert.equal(await rosterStore.refreshObligatedConsumerRosterVersions({ limit: 1 }), 1);
      assert.equal(await rosterStore.refreshObligatedConsumerRosterVersions({ limit: 1 }), 1);
      assert.deepEqual([...seen].sort(), [...ids].sort(), 'successive pages advance to new obligations');
      const refreshed = await cursorPool.query(
        `SELECT obligation_id, roster_refreshed_at FROM adcp_reporting_lifecycle_state
          WHERE obligation_id = ANY($1::text[])`,
        [ids]
      );
      assert.equal(refreshed.rowCount, 2);
      for (const row of refreshed.rows) assert.ok(row.roster_refreshed_at, 'the refresh cursor is recorded');
    } finally {
      await cursorPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${cursorSchema}" CASCADE`);
    }
  });

  test('uses one lock order so pruning and binding install cannot deadlock', async () => {
    const racer = await seedSkewLedger('lockorder', 'delivery_only', { install: false, stopAfterBinding: true });
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    // Pruning took policy then account while install took account then
    // policy. Run them against each other repeatedly; an ABBA order fails
    // with 40P01 rather than serializing.
    for (let round = 0; round < 12; round += 1) {
      const outcomes = await Promise.allSettled([
        retaining.pruneExpiredEvidence({ account_id: racer.accountId }),
        managed.installBinding(racer.binding),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          assert.equal(
            /deadlock detected|40P01/.test(String(outcome.reason?.cause ?? outcome.reason)),
            false,
            `deadlock on round ${round}: ${String(outcome.reason?.cause ?? outcome.reason)}`
          );
        }
      }
    }
  });

  test('bounds delivery attempts when a worker keeps dying before it settles', async () => {
    const stuck = await seedSkewLedger('leaseloss');
    assert.equal(await managed.planMaterializations({ account_id: stuck.accountId }), 1);
    let claims = 0;
    // A worker that claims and dies. Nothing settles and nothing
    // terminalizes, and `attempt` only advances in the planner — so the row
    // used to be reclaimable without bound and the adapter re-delivered on
    // every pass. Lease generation is now the durable attempt count.
    for (let round = 0; round < 12; round += 1) {
      const claimed = await managed.claimMaterialization({
        owner: `crash-worker-${round}`,
        now: new Date().toISOString(),
        lease_milliseconds: 1,
        account_id: stuck.accountId,
      });
      if (!claimed) break;
      claims += 1;
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert.equal(claims, 5, 'delivery attempts are capped rather than unbounded');

    // A row that used every attempt must not sit pending and invisible: the
    // planner skips an obligation with any pending row, so it would never be
    // retried or replanned.
    const beforeSweep = await pool.query(`SELECT status FROM adcp_reporting_materializations WHERE account_id = $1`, [
      stuck.accountId,
    ]);
    assert.equal(beforeSweep.rows[0].status, 'pending');
    assert.equal(await managed.failExhaustedMaterializations({ account_id: stuck.accountId }), 1);
    const row = await pool.query(
      `SELECT status, data ->> 'failure_code' AS failure_code FROM adcp_reporting_materializations
        WHERE account_id = $1`,
      [stuck.accountId]
    );
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].failure_code, 'DELIVERY_ATTEMPTS_EXHAUSTED');
  });

  test('revalidates prune victims under the lock against a replay that commits after selection', async () => {
    const raced = await seedSkewLedger('prunerace', 'consumer_receipt');
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(raced),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await managed.planMaterializations({ account_id: raced.accountId });
    await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.parse(raced.now) + 1000),
      maxIterations: 2,
      account_id: raced.accountId,
    });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [raced.obligation.reporting_obligation_id]
    );
    raced.materialization = settled.rows[0].data;

    const context = { account: { id: raced.accountId }, agent: { agent_url: 'https://prunerace-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const recordedReceipt = await sync(
      {
        idempotency_key: 'receipt-prunerace-batch-0001',
        receipts: [receipt(raced, { reporting_receipt_id: 'receipt-prunerace-0001' })],
      },
      context
    );
    assert.equal(recordedReceipt.results[0].result, 'recorded');

    // Age everything past retention and let the resource horizon pass, so an
    // unraced prune would take all three rows.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [raced.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET recorded_at = clock_timestamp() - INTERVAL '200 days',
              data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [raced.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [raced.accountId]
    );

    // Selection deliberately runs unlocked. Commit a real replay on an
    // independent connection in exactly that gap: the candidates are already
    // chosen, and the account lock has not been taken yet.
    const { Pool } = require('pg');
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    const sideSync = ledger.createSyncReportingReceiptsHandler(
      new ledger.PostgresReportingManagedDeliveryStore(sidePool),
      value => value.agent.agent_url
    );
    let interleaved = 0;
    const interleavingPool = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        client.query = async (sql, values) => {
          const result = await query(sql, values);
          if (interleaved === 0 && typeof sql === 'string' && sql.includes('ORDER BY materialization.recorded_at')) {
            interleaved += 1;
            const replayed = await sideSync(
              {
                idempotency_key: 'receipt-prunerace-batch-0002',
                receipts: [receipt(raced, { reporting_receipt_id: 'receipt-prunerace-0001' })],
              },
              context
            );
            assert.equal(replayed.results[0].result, 'unchanged', 'the interleaved replay really did commit');
          }
          return result;
        };
        const release = client.release.bind(client);
        client.release = (...args) => {
          client.query = query;
          client.release = release;
          return release(...args);
        };
        return client;
      },
      query: (sql, values) => pool.query(sql, values),
      end: async () => {},
    };

    try {
      const retaining = new ledger.PostgresReportingManagedDeliveryStore(interleavingPool, {
        evidenceRetentionDays: 90,
      });
      const pruned = await retaining.pruneExpiredEvidence({ account_id: raced.accountId });
      assert.equal(interleaved, 1, 'the interleaving actually fired — otherwise this test proves nothing');
      // The interleaved sync ages out its own consumer's replay cache before
      // it measures it, so the expired batch row was already gone by the time
      // the prune reached its delete.
      assert.equal(pruned.batches, 0);
      assert.equal(pruned.receipts, 0, 'a receipt a replay committed against after selection is not deleted');
      assert.equal(pruned.materializations, 0, 'nor the materialization that the surviving receipt still names');
      const survivors = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM adcp_reporting_receipts WHERE account_id = $1)::int AS receipts,
           (SELECT COUNT(*) FROM adcp_reporting_materializations WHERE account_id = $1)::int AS materializations`,
        [raced.accountId]
      );
      assert.equal(survivors.rows[0].receipts, 1);
      assert.equal(survivors.rows[0].materializations, 1);
      const batches = await pool.query(
        `SELECT COUNT(*)::int AS live FROM adcp_reporting_receipt_batches
          WHERE account_id = $1 AND recorded_at >= clock_timestamp() - INTERVAL '30 days'`,
        [raced.accountId]
      );
      assert.deepEqual(
        await pool
          .query(`SELECT COUNT(*)::int AS total FROM adcp_reporting_receipt_batches WHERE account_id = $1`, [
            raced.accountId,
          ])
          .then(value => value.rows[0].total),
        batches.rows[0].live,
        'no expired replay row survived the pass'
      );
      // The promise the replay made is still keepable.
      const again = await sync(
        {
          idempotency_key: 'receipt-prunerace-batch-0002',
          receipts: [receipt(raced, { reporting_receipt_id: 'receipt-prunerace-0001' })],
        },
        context
      );
      assert.equal(again.results[0].result, 'unchanged', 'the replay still reproduces its receipt');
    } finally {
      await sidePool.end();
    }
  });

  test('refuses to overwrite a settlement that commits while the exhaustion sweep waits', async () => {
    const contended = await seedSkewLedger('sweeprace');
    assert.equal(await managed.planMaterializations({ account_id: contended.accountId }), 1);
    for (let round = 0; round < 8; round += 1) {
      const claimed = await managed.claimMaterialization({
        owner: `sweeprace-worker-${round}`,
        now: new Date().toISOString(),
        lease_milliseconds: 1,
        account_id: contended.accountId,
      });
      if (!claimed) break;
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    const exhausted = await pool.query(
      `SELECT materialization_id, status, lease_generation FROM adcp_reporting_materializations
        WHERE account_id = $1`,
      [contended.accountId]
    );
    assert.equal(exhausted.rows[0].status, 'pending');
    assert.equal(Number(exhausted.rows[0].lease_generation), 5, 'the row is sweep-eligible');

    // A settle already holding the row lock, uncommitted. The sweep's
    // subquery therefore still reads `pending` and its UPDATE parks on the
    // row; committing the settle while it waits is the race.
    const { Pool } = require('pg');
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    const holder = await sidePool.connect();
    try {
      await holder.query('BEGIN');
      const settled = await holder.query(
        `UPDATE adcp_reporting_materializations
            SET status = 'delivered', changed_at = clock_timestamp(),
                lease_owner = NULL, lease_expires_at = NULL,
                data = data || jsonb_build_object('status', 'delivered')
          WHERE materialization_id = $1`,
        [exhausted.rows[0].materialization_id]
      );
      assert.equal(settled.rowCount, 1);
      const sweeping = managed.failExhaustedMaterializations({ account_id: contended.accountId });
      await new Promise(resolve => setTimeout(resolve, 200));
      await holder.query('COMMIT');
      assert.equal(await sweeping, 0, 'the sweep re-checks eligibility against the row it finally locked');
    } finally {
      holder.release();
      await sidePool.end();
    }
    const outcome = await pool.query(
      `SELECT status, data ->> 'failure_code' AS failure_code FROM adcp_reporting_materializations
        WHERE account_id = $1`,
      [contended.accountId]
    );
    assert.equal(outcome.rows[0].status, 'delivered', 'the successful settlement survives');
    assert.equal(outcome.rows[0].failure_code, null);
  });

  test('admits an exact resubmission at the receipt cap because it adds no row', async () => {
    // Its own schema: this fills a consumer to MAX_RECEIPTS_PER_CONSUMER, and
    // a hundred thousand rows in the shared schema would be paid for by every
    // other test's scans.
    const { Pool } = require('pg');
    const capSchema = `${schema}_capacity`;
    await bootstrap.query(`CREATE SCHEMA "${capSchema}"`);
    const capPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${capSchema}"` });
    try {
      await capPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await capPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const capCore = new ledger.PostgresReportingLedgerStore(capPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const capManaged = new ledger.PostgresReportingManagedDeliveryStore(capPool);
      const full = await seedSkewLedgerInto(capCore, capManaged, 'capacity', 'consumer_receipt');
      const adapter = {
        verificationProfiles: ['canonical_digest'],
        revocationFencesDeliveryGenerations: true,
        deliver: async () => materializationOutcome(full),
        read: async () => Buffer.from(''),
        revoke: async () => {},
      };
      await capManaged.planMaterializations({ account_id: full.accountId });
      await ledger.runManagedDeliveryWorker(capManaged, adapter, {
        maxIterations: 2,
        account_id: full.accountId,
      });
      const settled = await capPool.query(
        `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
        [full.obligation.reporting_obligation_id]
      );
      full.materialization = settled.rows[0].data;

      const consumerId = 'https://capacity-buyer.example';
      const context = { account: { id: full.accountId }, agent: { agent_url: consumerId } };
      const sync = ledger.createSyncReportingReceiptsHandler(capManaged, value => value.agent.agent_url);
      // A rejection rather than an acceptance, so the subject stays open and
      // a genuinely new row is still admissible at the boundary below.
      const rejected = receipt(full, {
        reporting_receipt_id: 'receipt-capacity-0001',
        status: 'rejected',
        rejection_codes: ['ROW_COUNT_MISMATCH'],
      });
      const first = await sync({ idempotency_key: 'receipt-capacity-batch-0001', receipts: [rejected] }, context);
      assert.equal(first.results[0].result, 'recorded');

      // Fill the consumer to exactly MAX_RECEIPTS_PER_CONSUMER.
      await capPool.query(
        `INSERT INTO adcp_reporting_receipts
          (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
           is_current, semantic_fingerprint, data, received_at, recorded_at)
         SELECT $1, $2, 'receipt-capacity-filler-' || i, 'revision', 'subject-capacity-filler-' || i,
                false, 'filler', '{}'::jsonb, clock_timestamp(), clock_timestamp()
           FROM generate_series(1, 99999) AS i`,
        [full.accountId, consumerId]
      );
      const atCap = await capPool.query(
        `SELECT COUNT(*)::int AS receipts FROM adcp_reporting_receipts
          WHERE account_id = $1 AND consumer_id = $2`,
        [full.accountId, consumerId]
      );
      assert.equal(atCap.rows[0].receipts, 100_000, 'the consumer is exactly at its cap');

      // The same receipt again under a new idempotency key: not a batch
      // replay, so it walks the full record path — and stores nothing.
      const resubmitted = await sync({ idempotency_key: 'receipt-capacity-batch-0002', receipts: [rejected] }, context);
      assert.equal(
        resubmitted.results[0].result,
        'unchanged',
        'an identical receipt that adds no row is not refused for capacity'
      );
      assert.deepEqual(resubmitted.results[0].receipt, first.results[0].receipt);

      // Capacity still binds on anything that would add a row, and refusing
      // it leaves the current leaf alone.
      const superseding = receipt(full, {
        reporting_receipt_id: 'receipt-capacity-0002',
        status: 'rejected',
        rejection_codes: ['ROW_COUNT_MISMATCH'],
        supersedes_reporting_receipt_id: 'receipt-capacity-0001',
      });
      const refused = await sync({ idempotency_key: 'receipt-capacity-batch-0003', receipts: [superseding] }, context);
      assert.equal(refused.results[0].result, 'failed', 'a new row is still refused at the cap');
      const leaf = await capPool.query(
        `SELECT reporting_receipt_id FROM adcp_reporting_receipts
          WHERE account_id = $1 AND consumer_id = $2 AND is_current`,
        [full.accountId, consumerId]
      );
      assert.deepEqual(
        leaf.rows.map(value => value.reporting_receipt_id),
        ['receipt-capacity-0001'],
        'a capacity refusal does not demote the current leaf'
      );

      // One row below the cap, the same submission is admitted — so the
      // refusal above was capacity and not the content.
      await capPool.query(
        `DELETE FROM adcp_reporting_receipts
          WHERE account_id = $1 AND consumer_id = $2 AND reporting_receipt_id = 'receipt-capacity-filler-1'`,
        [full.accountId, consumerId]
      );
      const admitted = await sync({ idempotency_key: 'receipt-capacity-batch-0004', receipts: [superseding] }, context);
      assert.equal(admitted.results[0].result, 'recorded');
    } finally {
      await capPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${capSchema}" CASCADE`);
    }
  });

  async function deliverOnce(fixtureValue, storeValue = managed) {
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => materializationOutcome(fixtureValue),
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    await storeValue.planMaterializations({ account_id: fixtureValue.accountId });
    await ledger.runManagedDeliveryWorker(storeValue, adapter, {
      maxIterations: 2,
      account_id: fixtureValue.accountId,
    });
    const settled = await pool.query(
      `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
      [fixtureValue.obligation.reporting_obligation_id]
    );
    fixtureValue.materialization = settled.rows[0].data;
    return fixtureValue;
  }

  test('keeps a pruned rejected leaf in the chain instead of reopening the subject', async () => {
    const chain = await deliverOnce(await seedSkewLedger('tombchain', 'consumer_receipt'));
    const context = { account: { id: chain.accountId }, agent: { agent_url: 'https://tombchain-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const first = await sync(
      {
        idempotency_key: 'receipt-tombchain-batch-0001',
        receipts: [
          receipt(chain, {
            reporting_receipt_id: 'receipt-tombchain-0001',
            status: 'rejected',
            rejection_codes: ['ROW_COUNT_MISMATCH'],
          }),
        ],
      },
      context
    );
    assert.equal(first.results[0].result, 'recorded');

    // Age the receipt and its replay row out, and let the resource horizon
    // pass so the acceptance hold does not keep it. The materialization row
    // itself stays inside retention, so the evidence a later correction
    // needs is still there and this is purely about the receipt chain.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [chain.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [chain.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [chain.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const pruned = await retaining.pruneExpiredEvidence({ account_id: chain.accountId });
    assert.equal(pruned.receipts, 1, 'the rejected leaf body is gone');
    const tombstone = await pool.query(
      `SELECT was_current, status FROM adcp_reporting_receipt_tombstones
        WHERE account_id = $1 AND reporting_receipt_id = 'receipt-tombchain-0001'`,
      [chain.accountId]
    );
    assert.equal(tombstone.rows[0].was_current, true);

    // A fresh root: the same repair content with no supersedes. Losing the
    // body must not turn the subject back into virgin ground.
    const omission = await sync(
      {
        idempotency_key: 'receipt-tombchain-batch-0002',
        receipts: [
          receipt(chain, {
            reporting_receipt_id: 'receipt-tombchain-0003',
            status: 'rejected',
            rejection_codes: ['ROW_COUNT_MISMATCH'],
          }),
        ],
      },
      context
    );
    assert.equal(omission.results[0].result, 'failed', 'a pruned leaf still owns its subject');

    // And its real successor is admitted, which it was not while the pruned
    // leaf counted as absent.
    const correction = await sync(
      {
        idempotency_key: 'receipt-tombchain-batch-0003',
        receipts: [
          receipt(chain, {
            reporting_receipt_id: 'receipt-tombchain-0002',
            status: 'rejected',
            rejection_codes: ['ROW_COUNT_MISMATCH'],
            supersedes_reporting_receipt_id: 'receipt-tombchain-0001',
          }),
        ],
      },
      context
    );
    assert.equal(correction.results[0].result, 'recorded', 'the successor of a pruned leaf still extends the chain');
    const leaf = await pool.query(
      `SELECT reporting_receipt_id FROM adcp_reporting_receipts WHERE account_id = $1 AND is_current`,
      [chain.accountId]
    );
    assert.deepEqual(
      leaf.rows.map(value => value.reporting_receipt_id),
      ['receipt-tombchain-0002']
    );
  });

  test('holds an adjustment acceptance while the revision resource it corrects is readable', async () => {
    const adjusted = await deliverOnce(await seedSkewLedger('adjretain', 'consumer_receipt'));
    const rows = [{ media_buy_id: 'buy-3', impressions: 12 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-adjretain-0001',
      adjusts_reporting_revision_id: adjusted.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: adjusted.period.start, end: adjusted.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: adjusted.now,
      created_at: adjusted.now,
    };
    const canonicalAdjustmentSha256 = createHash('sha256')
      .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
      .digest('hex');
    await core.commitAdjustment(
      {
        reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
        reporting_obligation_id: adjusted.obligation.reporting_obligation_id,
        adjusts_reporting_revision_id: adjusted.revision.reporting_revision_id,
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'adjretain-manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'adjustment-publication-adjretain',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: rows.length,
        },
        rows,
        observedAt: adjusted.now,
        dataThrough: adjusted.period.end,
        sourceReadCutoffAt: adjusted.now,
        createdAt: adjusted.now,
        wireAdjustment: { ...wireAdjustmentWithoutDigest, canonical_adjustment_sha256: canonicalAdjustmentSha256 },
      },
      adjusted.coreLease
    );

    const context = { account: { id: adjusted.accountId }, agent: { agent_url: 'https://adjretain-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const accepted = await sync(
      {
        idempotency_key: 'adjustment-adjretain-batch-0001',
        adjustment_receipts: [
          {
            reporting_receipt_id: 'adjustment-receipt-adjretain-0001',
            reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
            adjusts_reporting_revision_id: adjusted.revision.reporting_revision_id,
            observed_adjustment_sha256: canonicalAdjustmentSha256,
            observed_at: adjusted.now,
            status: 'accepted',
          },
        ],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');

    // Age the receipt and its replay row past retention, and leave the
    // revision's resource readable. An adjustment receipt names no
    // materialization, so the acceptance hold used to miss it entirely and
    // the period kept a `complete` with the evidence for it deleted.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [adjusted.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [adjusted.accountId]
    );
    const live = await pool.query(
      `SELECT (data -> 'resource' ->> 'expires_at')::timestamptz > clock_timestamp() AS readable
         FROM adcp_reporting_materializations WHERE account_id = $1`,
      [adjusted.accountId]
    );
    assert.equal(live.rows[0].readable, true, 'the revision resource this adjustment corrects is still readable');

    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const pruned = await retaining.pruneExpiredEvidence({ account_id: adjusted.accountId });
    assert.equal(pruned.receipts, 0, 'an adjustment acceptance outlives its age while the revision stays readable');
    const surviving = await pool.query(
      `SELECT COUNT(*)::int AS receipts FROM adcp_reporting_receipts WHERE account_id = $1`,
      [adjusted.accountId]
    );
    assert.equal(surviving.rows[0].receipts, 1);
  });

  test('admits a correction alongside the exact receipt it supersedes in one batch', async () => {
    const pair = await deliverOnce(await seedSkewLedger('dupsubject', 'consumer_receipt'));
    const context = { account: { id: pair.accountId }, agent: { agent_url: 'https://dupsubject-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const rejected = receipt(pair, {
      reporting_receipt_id: 'receipt-dupsubject-0001',
      status: 'rejected',
      rejection_codes: ['ROW_COUNT_MISMATCH'],
    });
    const first = await sync({ idempotency_key: 'receipt-dupsubject-batch-0001', receipts: [rejected] }, context);
    assert.equal(first.results[0].result, 'recorded');

    // The shape a consumer resubmitting its own state produces: everything it
    // holds for the subject, including the receipt already stored. The
    // duplicate-subject rule is about two claimants, and an entry that
    // resolves to an existing row writes nothing, so it is not one.
    const correction = receipt(pair, {
      reporting_receipt_id: 'receipt-dupsubject-0002',
      status: 'rejected',
      rejection_codes: ['ROW_COUNT_MISMATCH'],
      supersedes_reporting_receipt_id: 'receipt-dupsubject-0001',
    });
    const both = await sync(
      { idempotency_key: 'receipt-dupsubject-batch-0002', receipts: [rejected, correction] },
      context
    );
    assert.deepEqual(
      both.results.map(value => value.result),
      ['unchanged', 'recorded']
    );
    assert.equal(validateResponse('sync_reporting_receipts', both, '3.2.0-rc.3').valid, true);
    const leaf = await pool.query(
      `SELECT reporting_receipt_id FROM adcp_reporting_receipts WHERE account_id = $1 AND is_current`,
      [pair.accountId]
    );
    assert.deepEqual(
      leaf.rows.map(value => value.reporting_receipt_id),
      ['receipt-dupsubject-0002']
    );

    // Two genuinely competing new receipts for one subject are still refused.
    const rival = receipt(pair, {
      reporting_receipt_id: 'receipt-dupsubject-0003',
      status: 'rejected',
      rejection_codes: ['ROW_COUNT_MISMATCH'],
      supersedes_reporting_receipt_id: 'receipt-dupsubject-0002',
    });
    const other = receipt(pair, {
      reporting_receipt_id: 'receipt-dupsubject-0004',
      status: 'rejected',
      rejection_codes: ['CONTROL_TOTAL_MISMATCH'],
      supersedes_reporting_receipt_id: 'receipt-dupsubject-0002',
    });
    const contested = await sync(
      { idempotency_key: 'receipt-dupsubject-batch-0003', receipts: [rival, other] },
      context
    );
    assert.deepEqual(
      contested.results.map(value => value.result),
      ['failed', 'failed']
    );
  });

  test('takes the lifecycle account lock before failing exhausted materializations', async () => {
    const fenced = await seedSkewLedger('sweeplock');
    assert.equal(await managed.planMaterializations({ account_id: fenced.accountId }), 1);
    for (let round = 0; round < 8; round += 1) {
      const claimed = await managed.claimMaterialization({
        owner: `sweeplock-worker-${round}`,
        now: new Date().toISOString(),
        lease_milliseconds: 1,
        account_id: fenced.accountId,
      });
      if (!claimed) break;
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    // The lifecycle apply holds exactly this lock while it validates the
    // managed state version and writes its transition. An unlocked sweep
    // could commit pending -> failed inside that window, and the lifecycle
    // then published a projection taken before the row failed.
    const { Pool } = require('pg');
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    const holder = await sidePool.connect();
    let settled = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `adcp-reporting-account:${fenced.accountId}`,
      ]);
      const sweeping = managed.failExhaustedMaterializations({ account_id: fenced.accountId }).then(value => {
        settled = true;
        return value;
      });
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(settled, false, 'the sweep waits for the account lock rather than racing the apply');
      await holder.query('COMMIT');
      assert.equal(await sweeping, 1, 'and completes once the lock is free');
    } finally {
      holder.release();
      await sidePool.end();
    }
  });

  test('never watermarks ahead of the ledger clock when a caller pins a future cutoff', async () => {
    const fast = await deliverOnce(await seedSkewLedger('futurepin', 'consumer_receipt'));
    // A host running a minute fast. The cutoff it pins is not a cutoff this
    // database has reached.
    await ledger.reconcileReportingStatusLifecycleV1({
      store: core,
      reporting_obligation_id: fast.obligation.reporting_obligation_id,
      ledgerAsOf: new Date(Date.now() + 60_000).toISOString(),
    });
    const watermark = await pool.query(
      `SELECT processed_at <= clock_timestamp() AS reached FROM adcp_reporting_lifecycle_state
        WHERE obligation_id = $1`,
      [fast.obligation.reporting_obligation_id]
    );
    assert.equal(watermark.rowCount, 1, 'the reconcile recorded a watermark');
    assert.equal(watermark.rows[0].reached, true, 'the watermark is an instant this ledger has actually reached');
    const transitions = await pool.query(
      `SELECT COUNT(*)::int AS ahead FROM adcp_reporting_transitions
        WHERE obligation_id = $1 AND occurred_at > clock_timestamp()`,
      [fast.obligation.reporting_obligation_id]
    );
    assert.equal(transitions.rows[0].ahead, 0, 'nor is any transition dated ahead of it');

    // Everything the database timestamps inside that skew must still re-arm.
    await managed.revokeDestination({
      account_id: fast.accountId,
      destination_ref: fast.binding.destination_ref,
      generation: 1,
      revoked_at: new Date().toISOString(),
    });
    const due = await core.listLifecycleDueObligations({
      ledgerAsOf: await core.readLedgerInstant(),
      account_id: fast.accountId,
      limit: 100,
    });
    assert.ok(
      due.some(value => value.reporting_obligation_id === fast.obligation.reporting_obligation_id),
      'a database-timestamped revocation is not buried behind a future watermark'
    );
  });

  test('keeps one current-leaf tombstone per subject across successive prunes', async () => {
    const chain = await deliverOnce(await seedSkewLedger('tombtwice', 'consumer_receipt'));
    const context = { account: { id: chain.accountId }, agent: { agent_url: 'https://tombtwice-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const rejection = id => ({
      reporting_receipt_id: id,
      status: 'rejected',
      rejection_codes: ['ROW_COUNT_MISMATCH'],
    });
    const age = async () => {
      await pool.query(
        `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
          WHERE account_id = $1`,
        [chain.accountId]
      );
      await pool.query(
        `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
          WHERE account_id = $1`,
        [chain.accountId]
      );
      await pool.query(
        `UPDATE adcp_reporting_materializations
            SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
          WHERE account_id = $1`,
        [chain.accountId]
      );
    };

    const first = await sync(
      {
        idempotency_key: 'receipt-tombtwice-batch-0001',
        receipts: [receipt(chain, rejection('receipt-tombtwice-0001'))],
      },
      context
    );
    assert.equal(first.results[0].result, 'recorded');
    await age();
    assert.equal((await retaining.pruneExpiredEvidence({ account_id: chain.accountId })).receipts, 1);

    // The successor of the pruned leaf, which the tombstone chain admits.
    const second = await sync(
      {
        idempotency_key: 'receipt-tombtwice-batch-0002',
        receipts: [
          receipt(chain, {
            ...rejection('receipt-tombtwice-0002'),
            supersedes_reporting_receipt_id: 'receipt-tombtwice-0001',
          }),
        ],
      },
      context
    );
    assert.equal(second.results[0].result, 'recorded');
    await age();
    assert.equal((await retaining.pruneExpiredEvidence({ account_id: chain.accountId })).receipts, 1);

    // Two prunes, two leaves tombstoned. A subject has one leaf, so only the
    // later one may still claim to be current — otherwise the read picks
    // whichever row the scan returns first and can answer for a leaf that was
    // superseded two prunes ago.
    const current = await pool.query(
      `SELECT reporting_receipt_id FROM adcp_reporting_receipt_tombstones
        WHERE account_id = $1 AND was_current ORDER BY reporting_receipt_id`,
      [chain.accountId]
    );
    assert.deepEqual(
      current.rows.map(value => value.reporting_receipt_id),
      ['receipt-tombtwice-0002'],
      'exactly one tombstone still claims the subject, and it is the later leaf'
    );

    const third = await sync(
      {
        idempotency_key: 'receipt-tombtwice-batch-0003',
        receipts: [
          receipt(chain, {
            ...rejection('receipt-tombtwice-0003'),
            supersedes_reporting_receipt_id: 'receipt-tombtwice-0002',
          }),
        ],
      },
      context
    );
    assert.equal(third.results[0].result, 'recorded', 'the successor of the latest pruned leaf is admitted');
    const stale = await sync(
      {
        idempotency_key: 'receipt-tombtwice-batch-0004',
        receipts: [
          receipt(chain, {
            ...rejection('receipt-tombtwice-0004'),
            supersedes_reporting_receipt_id: 'receipt-tombtwice-0001',
          }),
        ],
      },
      context
    );
    assert.equal(stale.results[0].result, 'failed', 'and succeeding a leaf two prunes old is still refused');
  });

  test('fails only the accounts the exhaustion sweep actually locked', async () => {
    // Its own schema: this runs the sweep with no account filter, and a
    // shared schema full of other fixtures makes "which accounts did it
    // touch" unanswerable.
    const { Pool } = require('pg');
    const sweepSchema = `${schema}_sweepscope`;
    await bootstrap.query(`CREATE SCHEMA "${sweepSchema}"`);
    const sweepPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${sweepSchema}"` });
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${sweepSchema}"` });
    try {
      await sweepPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await sweepPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const sweepCore = new ledger.PostgresReportingLedgerStore(sweepPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const sweepManaged = new ledger.PostgresReportingManagedDeliveryStore(sweepPool);
      const exhaust = async suffix => {
        const seeded = await seedSkewLedgerInto(sweepCore, sweepManaged, suffix);
        assert.equal(await sweepManaged.planMaterializations({ account_id: seeded.accountId }), 1);
        for (let round = 0; round < 8; round += 1) {
          const claimed = await sweepManaged.claimMaterialization({
            owner: `${suffix}-worker-${round}`,
            now: new Date().toISOString(),
            lease_milliseconds: 1,
            account_id: seeded.accountId,
          });
          if (!claimed) break;
          await new Promise(resolve => setTimeout(resolve, 3));
        }
        return seeded;
      };
      const locked = await exhaust('sweepa');
      const later = await exhaust('sweepb');
      // Not yet eligible: its lease has not expired, so the sweep's selection
      // does not see it and never takes its account lock.
      await sweepPool.query(
        `UPDATE adcp_reporting_materializations
            SET lease_expires_at = clock_timestamp() + INTERVAL '400 milliseconds'
          WHERE account_id = $1`,
        [later.accountId]
      );

      const holder = await sidePool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `adcp-reporting-account:${locked.accountId}`,
        ]);
        // Waiting on one account's lock is real time, and another account's
        // lease expires inside it. The mutation re-reads eligibility, so
        // without restricting it to the accounts this transaction locked, the
        // newly eligible one was failed with its lock never taken.
        const sweeping = sweepManaged.failExhaustedMaterializations({});
        await new Promise(resolve => setTimeout(resolve, 700));
        await holder.query('COMMIT');
        assert.equal(await sweeping, 1, 'only the locked account is failed');
      } finally {
        holder.release();
      }
      const statuses = await sweepPool.query(
        `SELECT account_id, status FROM adcp_reporting_materializations ORDER BY account_id`,
        []
      );
      assert.deepEqual(
        statuses.rows.map(value => [value.account_id, value.status]).sort(),
        [
          [locked.accountId, 'failed'],
          [later.accountId, 'pending'],
        ].sort(),
        'the account whose lock was never taken is left for the next sweep'
      );
      assert.equal(
        await sweepManaged.failExhaustedMaterializations({}),
        1,
        'and the next sweep takes its lock and fails it'
      );
    } finally {
      await sidePool.end();
      await sweepPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${sweepSchema}" CASCADE`);
    }
  });

  test('projects a lifecycle verdict for a subject repaired past the snapshot bound', async () => {
    const { Pool } = require('pg');
    const deepSchema = `${schema}_deepchain`;
    await bootstrap.query(`CREATE SCHEMA "${deepSchema}"`);
    const deepPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${deepSchema}"` });
    try {
      await deepPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await deepPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const deepCore = new ledger.PostgresReportingLedgerStore(deepPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const deepManaged = new ledger.PostgresReportingManagedDeliveryStore(deepPool);
      const deep = await seedSkewLedgerInto(deepCore, deepManaged, 'deepchain', 'consumer_receipt');
      const adapter = {
        verificationProfiles: ['canonical_digest'],
        revocationFencesDeliveryGenerations: true,
        deliver: async () => materializationOutcome(deep),
        read: async () => Buffer.from(''),
        revoke: async () => {},
      };
      await deepManaged.planMaterializations({ account_id: deep.accountId });
      await ledger.runManagedDeliveryWorker(deepManaged, adapter, {
        maxIterations: 2,
        account_id: deep.accountId,
      });
      const settled = await deepPool.query(
        `SELECT data FROM adcp_reporting_materializations WHERE obligation_id = $1 AND status = 'available'`,
        [deep.obligation.reporting_obligation_id]
      );
      deep.materialization = settled.rows[0].data;

      const consumerId = 'https://deepchain-buyer.example';
      const context = { account: { id: deep.accountId }, agent: { agent_url: consumerId } };
      const sync = ledger.createSyncReportingReceiptsHandler(deepManaged, value => value.agent.agent_url);
      const accepted = await sync(
        {
          idempotency_key: 'receipt-deepchain-batch-0001',
          receipts: [receipt(deep, { reporting_receipt_id: 'receipt-deepchain-0001' })],
        },
        context
      );
      assert.equal(accepted.results[0].result, 'recorded');

      // A subject repaired more times than a snapshot page may carry: a real
      // chain, each repair superseding the one before it, with the recorded
      // acceptance as its leaf. The receipt store admits 100,000 receipts per
      // consumer, so this is a state the write path allows; the lifecycle
      // used to read the whole chain and throw above 10,000, which no retry
      // or backoff could ever clear.
      await deepPool.query(
        `INSERT INTO adcp_reporting_receipts
          (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
           supersedes_receipt_id, is_current, semantic_fingerprint, data, received_at, recorded_at)
         SELECT $1, $2, 'receipt-deepchain-superseded-' || i, 'revision', $3,
                CASE WHEN i = 1 THEN NULL ELSE 'receipt-deepchain-superseded-' || (i - 1) END,
                false, 'superseded', '{}'::jsonb, clock_timestamp(), clock_timestamp()
           FROM generate_series(1, 10001) AS i`,
        [deep.accountId, consumerId, deep.revision.reporting_revision_id]
      );
      const tip = await deepPool.query(
        `UPDATE adcp_reporting_receipts
            SET supersedes_receipt_id = 'receipt-deepchain-superseded-10001',
                recorded_at = clock_timestamp()
          WHERE account_id = $1 AND reporting_receipt_id = 'receipt-deepchain-0001'`,
        [deep.accountId]
      );
      assert.equal(tip.rowCount, 1, 'the acceptance is the tip of that chain');

      const projection = await deepCore.getManagedLifecycleProjection({
        reporting_obligation_id: deep.obligation.reporting_obligation_id,
        ledgerAsOf: await deepCore.readLedgerInstant(),
      });
      assert.equal(projection.consumers.length, 1, 'the consumer is still projected');
      assert.deepEqual(
        projection.consumers[0].receipts.map(value => value.reporting_receipt_id),
        ['receipt-deepchain-0001'],
        'the verdict reads the chain leaf, which is all it has ever used'
      );
      // And the whole reconcile completes rather than failing forever.
      await ledger.reconcileReportingStatusLifecycleV1({
        store: deepCore,
        reporting_obligation_id: deep.obligation.reporting_obligation_id,
      });
      const watermark = await deepPool.query(
        `SELECT processed_at FROM adcp_reporting_lifecycle_state WHERE obligation_id = $1`,
        [deep.obligation.reporting_obligation_id]
      );
      assert.equal(watermark.rowCount, 1, 'the obligation reconciles instead of failing every pass');
    } finally {
      await deepPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${deepSchema}" CASCADE`);
    }
  });

  test('does not restore a future caller cutoff when the compare-and-set retries', async () => {
    const retried = await deliverOnce(await seedSkewLedger('retrypin', 'consumer_receipt'));
    const { Pool } = require('pg');
    const sidePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    let interleaved = 0;
    const interleavingPool = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        client.query = async (sql, values) => {
          const result = await query(sql, values);
          if (
            interleaved === 0 &&
            typeof sql === 'string' &&
            sql.includes('FROM adcp_reporting_obligations WHERE obligation_id = $1 FOR UPDATE')
          ) {
            interleaved += 1;
            // Move managed state under the open apply so its token no longer
            // matches. The apply refuses and the reconcile retries, which is
            // the path that used to hand the caller's future pin straight
            // back to the retry it was clamped out of.
            const moved = await sidePool.query(
              `UPDATE adcp_reporting_materializations SET changed_at = clock_timestamp()
                WHERE account_id = $1`,
              [retried.accountId]
            );
            assert.equal(moved.rowCount, 1, 'the interleaved managed write really did commit');
          }
          return result;
        };
        const release = client.release.bind(client);
        client.release = (...args) => {
          client.query = query;
          client.release = release;
          return release(...args);
        };
        return client;
      },
      query: (sql, values) => pool.query(sql, values),
      end: async () => {},
    };

    try {
      const racing = new ledger.PostgresReportingLedgerStore(interleavingPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      await ledger.reconcileReportingStatusLifecycleV1({
        store: racing,
        reporting_obligation_id: retried.obligation.reporting_obligation_id,
        // A host running an hour fast.
        ledgerAsOf: new Date(Date.now() + 3_600_000).toISOString(),
      });
      assert.equal(interleaved, 1, 'the compare-and-set really was forced to retry');
      const dated = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM adcp_reporting_transitions
             WHERE obligation_id = $1 AND occurred_at > clock_timestamp())::int AS transitions,
           (SELECT COUNT(*) FROM adcp_reporting_issues
             WHERE obligation_id = $1 AND observed_at > clock_timestamp())::int AS issues,
           (SELECT COUNT(*) FROM adcp_reporting_transitions WHERE obligation_id = $1)::int AS total`,
        [retried.obligation.reporting_obligation_id]
      );
      assert.ok(dated.rows[0].total >= 1, 'the retry did persist something to check');
      assert.equal(dated.rows[0].transitions, 0, 'no transition is dated ahead of the ledger clock');
      assert.equal(dated.rows[0].issues, 0, 'nor is any issue');
      const watermark = await pool.query(
        `SELECT processed_at <= clock_timestamp() AS reached FROM adcp_reporting_lifecycle_state
          WHERE obligation_id = $1`,
        [retried.obligation.reporting_obligation_id]
      );
      assert.equal(watermark.rows[0].reached, true);
    } finally {
      await sidePool.end();
    }
  });

  test('keeps an adjustment receipt readable when paging splits it from its adjustment', async () => {
    const paged = await deliverOnce(await seedSkewLedger('pageadj', 'consumer_receipt'));
    const rows = [{ media_buy_id: 'buy-3', impressions: 13 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-pageadj-0001',
      adjusts_reporting_revision_id: paged.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: paged.period.start, end: paged.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: paged.now,
      created_at: paged.now,
    };
    const canonicalAdjustmentSha256 = createHash('sha256')
      .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
      .digest('hex');
    await core.commitAdjustment(
      {
        reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
        reporting_obligation_id: paged.obligation.reporting_obligation_id,
        adjusts_reporting_revision_id: paged.revision.reporting_revision_id,
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'pageadj-manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'adjustment-publication-pageadj',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: rows.length,
        },
        rows,
        observedAt: paged.now,
        dataThrough: paged.period.end,
        sourceReadCutoffAt: paged.now,
        createdAt: paged.now,
        wireAdjustment: { ...wireAdjustmentWithoutDigest, canonical_adjustment_sha256: canonicalAdjustmentSha256 },
      },
      paged.coreLease
    );

    const context = { account: { id: paged.accountId }, agent: { agent_url: 'https://pageadj-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const accepted = await sync(
      {
        idempotency_key: 'adjustment-pageadj-batch-0001',
        adjustment_receipts: [
          {
            reporting_receipt_id: 'adjustment-receipt-pageadj-0001',
            reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
            adjusts_reporting_revision_id: paged.revision.reporting_revision_id,
            observed_adjustment_sha256: canonicalAdjustmentSha256,
            observed_at: paged.now,
            status: 'accepted',
          },
        ],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');

    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    // One item per page. The adjustment and the receipt that names it are
    // separate items, so they land on different pages; filtering the receipt
    // against its own page's adjustments dropped it from every page and the
    // acceptance was unreadable through the API meant to evidence it.
    const seenReceipts = [];
    let cursor;
    let pages = 0;
    do {
      const page = await getStatus(
        {
          account: { account_id: paged.accountId },
          view: 'periods',
          period: paged.period,
          pagination: { max_results: 1, ...(cursor ? { cursor } : {}) },
        },
        context
      );
      pages += 1;
      assert.equal(
        validateResponse('get_reporting_status', page, '3.2.0-rc.3').valid,
        true,
        JSON.stringify(validateResponse('get_reporting_status', page, '3.2.0-rc.3').issues)
      );
      for (const value of page.adjustment_receipts ?? []) {
        seenReceipts.push(value.reporting_receipt_id);
        // RC3 revision_adjustments still holds per page: the receipt may only
        // appear beside the correction it names.
        assert.ok(
          (page.adjustments ?? []).some(
            adjustment => adjustment.reporting_adjustment_id === value.reporting_adjustment_id
          ),
          'the adjustment the receipt names travels with it'
        );
      }
      cursor = page.pagination.cursor;
    } while (cursor);
    assert.ok(pages > 1, 'sanity: paging really did split this obligation');
    assert.deepEqual(seenReceipts, ['adjustment-receipt-pageadj-0001'], 'the acceptance is readable exactly once');
  });

  test('projects the receipt leaf as of the cutoff, not the leaf as of now', async () => {
    const asOf = await deliverOnce(await seedSkewLedger('asofleaf', 'consumer_receipt'));
    const context = { account: { id: asOf.accountId }, agent: { agent_url: 'https://asofleaf-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const rejected = await sync(
      {
        idempotency_key: 'receipt-asofleaf-batch-0001',
        receipts: [
          receipt(asOf, {
            reporting_receipt_id: 'receipt-asofleaf-0001',
            status: 'rejected',
            rejection_codes: ['ROW_COUNT_MISMATCH'],
          }),
        ],
      },
      context
    );
    assert.equal(rejected.results[0].result, 'recorded');

    // The cutoff sits between the rejection and the acceptance that repairs
    // it. Step past the rejection's own microsecond so it is inside.
    const cutoff = (
      await pool.query(
        `SELECT to_char((MAX(recorded_at) + INTERVAL '1 microsecond') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value
           FROM adcp_reporting_receipts WHERE account_id = $1`,
        [asOf.accountId]
      )
    ).rows[0].value;

    const accepted = await sync(
      {
        idempotency_key: 'receipt-asofleaf-batch-0002',
        receipts: [
          receipt(asOf, {
            reporting_receipt_id: 'receipt-asofleaf-0002',
            supersedes_reporting_receipt_id: 'receipt-asofleaf-0001',
          }),
        ],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');

    // As of the cutoff the buyer had filed a rejection. Asking which row is
    // current *now* and only then applying the cutoff answered "neither": the
    // rejection was no longer current and the acceptance was out of scope, so
    // the projection reported no receipt at all and the reconcile persisted
    // RECEIPT_REQUIRED over a rejection that had already been filed.
    const historical = await core.getManagedLifecycleProjection({
      reporting_obligation_id: asOf.obligation.reporting_obligation_id,
      ledgerAsOf: cutoff,
    });
    assert.deepEqual(
      historical.consumers.map(value => value.receipts.map(entry => entry.reporting_receipt_id)),
      [['receipt-asofleaf-0001']],
      'the cutoff sees the leaf that was current then'
    );
    assert.equal(historical.consumers[0].receipts[0].status, 'rejected');

    // And the present still sees the acceptance.
    const current = await core.getManagedLifecycleProjection({
      reporting_obligation_id: asOf.obligation.reporting_obligation_id,
      ledgerAsOf: await core.readLedgerInstant(),
    });
    assert.deepEqual(
      current.consumers.map(value => value.receipts.map(entry => entry.reporting_receipt_id)),
      [['receipt-asofleaf-0002']]
    );
    assert.equal(current.consumers[0].receipts[0].status, 'accepted');
  });

  test('projects the whole admitted consumer-by-subject cross product', async () => {
    const { Pool } = require('pg');
    const wideSchema = `${schema}_crossproduct`;
    await bootstrap.query(`CREATE SCHEMA "${wideSchema}"`);
    const widePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${wideSchema}"` });
    try {
      await widePool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await widePool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const wideCore = new ledger.PostgresReportingLedgerStore(widePool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const wideManaged = new ledger.PostgresReportingManagedDeliveryStore(widePool);
      const wide = await seedSkewLedgerInto(wideCore, wideManaged, 'crossproduct', 'consumer_receipt');

      // One revision and 99 adjustments is 100 subjects; 101 consumers each
      // filing a valid 100-entry batch is 10,100 leaves. Every part of that is
      // admitted by the write path — the per-array cap is 100 and the
      // per-consumer cap is 100,000 — and the projection refused all of it
      // against a flat 10,000-row bound that a product was never the right
      // shape for.
      await widePool.query(
        `INSERT INTO adcp_reporting_adjustments
          (adjustment_id, obligation_id, adjusts_revision_id, adjustment_number, content_sha256, data, created_at)
         SELECT 'adjustment-crossproduct-' || i, $1, $2::text, i, repeat('a', 64),
                jsonb_build_object(
                  'reporting_adjustment_id', 'adjustment-crossproduct-' || i,
                  'adjusts_reporting_revision_id', $2::text,
                  'createdAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ),
                clock_timestamp()
           FROM generate_series(1, 99) AS i`,
        [wide.obligation.reporting_obligation_id, wide.revision.reporting_revision_id]
      );
      await widePool.query(
        `INSERT INTO adcp_reporting_receipts
          (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
           is_current, semantic_fingerprint, data, received_at, recorded_at)
         SELECT $1,
                'https://crossproduct-' || consumer || '.example',
                'receipt-crossproduct-' || consumer || '-' || subject,
                CASE WHEN subject = 0 THEN 'revision' ELSE 'adjustment' END,
                CASE WHEN subject = 0 THEN $2 ELSE 'adjustment-crossproduct-' || subject END,
                true, 'leaf', '{"status":"accepted"}'::jsonb, clock_timestamp(), clock_timestamp()
           FROM generate_series(1, 101) AS consumer, generate_series(0, 99) AS subject`,
        [wide.accountId, wide.revision.reporting_revision_id]
      );

      const projection = await wideCore.getManagedLifecycleProjection({
        reporting_obligation_id: wide.obligation.reporting_obligation_id,
        ledgerAsOf: await wideCore.readLedgerInstant(),
      });
      assert.equal(projection.consumers.length, 101, 'every consumer is projected');
      assert.equal(
        projection.consumers.reduce(
          (total, value) => total + value.receipts.length + value.adjustmentReceipts.length,
          0
        ),
        10_100,
        'and every one of their leaves'
      );
      assert.equal(projection.receiptEvidenceComplete, true, 'nothing was truncated');
      // And a reconcile over it completes rather than deferring forever.
      await ledger.reconcileReportingStatusLifecycleV1({
        store: wideCore,
        reporting_obligation_id: wide.obligation.reporting_obligation_id,
      });
      const watermark = await widePool.query(
        `SELECT processed_at FROM adcp_reporting_lifecycle_state WHERE obligation_id = $1`,
        [wide.obligation.reporting_obligation_id]
      );
      assert.equal(watermark.rowCount, 1);
    } finally {
      await widePool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${wideSchema}" CASCADE`);
    }
  });

  test('stores receipt instants at database precision, not host milliseconds', async () => {
    const micro = await deliverOnce(await seedSkewLedger('microsecond', 'consumer_receipt'));
    const context = { account: { id: micro.accountId }, agent: { agent_url: 'https://microsecond-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const recorded = await sync(
      {
        idempotency_key: 'receipt-microsecond-batch-0001',
        receipts: [receipt(micro, { reporting_receipt_id: 'receipt-microsecond-0001' })],
      },
      context
    );
    assert.equal(recorded.results[0].result, 'recorded');
    // The instant used to go through a JS Date, which holds milliseconds, so
    // recorded_at was durably older than the microsecond watermark written
    // from the same clock and the reconcile it should trigger never became
    // due. Six fractional digits on the wire, and the column equal to them.
    assert.match(recorded.results[0].receipt.received_at, /\.\d{6}Z$/);
    const stored = await pool.query(
      `SELECT recorded_at = (data ->> 'received_at')::timestamptz AS aligned,
              recorded_at = received_at AS same_column,
              to_char(recorded_at AT TIME ZONE 'UTC', 'US') AS fraction
         FROM adcp_reporting_receipts
        WHERE account_id = $1 AND reporting_receipt_id = 'receipt-microsecond-0001'`,
      [micro.accountId]
    );
    assert.equal(stored.rows[0].aligned, true, 'the ordering column is the instant the wire reports');
    assert.equal(stored.rows[0].same_column, true);
    assert.equal(stored.rows[0].fraction.length, 6);
  });

  test('does not fold evidence recorded after the cutoff into a historical reconcile', async () => {
    const historical = await deliverOnce(await seedSkewLedger('historyscope', 'consumer_receipt'));
    const consumerId = 'https://historyscope-buyer.example';
    const context = { account: { id: historical.accountId }, agent: { agent_url: consumerId } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const accepted = await sync(
      {
        idempotency_key: 'receipt-historyscope-batch-0001',
        receipts: [receipt(historical, { reporting_receipt_id: 'receipt-historyscope-0001' })],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');

    // An authoritative roster, so the verdict turns on the evidence rather
    // than on the conservative unknown-roster fail-safe.
    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: [consumerId], complete: true, version: 'h1' }),
    });
    const cutoff = await rosterStore.readLedgerInstant();
    const settled = await rosterStore.getManagedLifecycleProjection({
      reporting_obligation_id: historical.obligation.reporting_obligation_id,
      ledgerAsOf: cutoff,
    });
    assert.equal(settled.consumers[0].receipts[0].reporting_receipt_id, 'receipt-historyscope-0001');

    // A correction filed after that cutoff. At the cutoff it does not exist,
    // so demanding a receipt for it reconciles a moment that never happened:
    // the adjustment was folded in while the receipt that would answer it was
    // filtered out by the same cutoff.
    const rows = [{ media_buy_id: 'buy-3', impressions: 14 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-historyscope-0001',
      adjusts_reporting_revision_id: historical.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: historical.period.start, end: historical.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    await core.commitAdjustment(
      {
        reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
        reporting_obligation_id: historical.obligation.reporting_obligation_id,
        adjusts_reporting_revision_id: historical.revision.reporting_revision_id,
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'historyscope-manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'adjustment-publication-historyscope',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: rows.length,
        },
        rows,
        observedAt: new Date().toISOString(),
        dataThrough: historical.period.end,
        sourceReadCutoffAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        wireAdjustment: {
          ...wireAdjustmentWithoutDigest,
          canonical_adjustment_sha256: createHash('sha256')
            .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
            .digest('hex'),
        },
      },
      historical.coreLease
    );

    const atCutoff = await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: historical.obligation.reporting_obligation_id,
      ledgerAsOf: cutoff,
    });
    const transitions = await core.listTransitions(historical.obligation.reporting_obligation_id);
    assert.notEqual(
      (atCutoff ?? transitions.at(-1)).health,
      'action_required',
      'a correction that did not exist at the cutoff cannot make that moment unreconciled'
    );
    // And reconciling now, when the correction does exist, does demand one.
    const atNow = await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: historical.obligation.reporting_obligation_id,
    });
    const latest = atNow ?? (await core.listTransitions(historical.obligation.reporting_obligation_id)).at(-1);
    assert.equal(latest.health, 'action_required', 'sanity: the correction does change the present verdict');
  });

  test('dates pruned conclusions so a historical cutoff cannot settle on them', async () => {
    const conclusion = await deliverOnce(await seedSkewLedger('tombcutoff', 'consumer_receipt'));
    const context = { account: { id: conclusion.accountId }, agent: { agent_url: 'https://tombcutoff-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    // Accepted AFTER the cutoff above.
    const accepted = await sync(
      {
        idempotency_key: 'receipt-tombcutoff-batch-0001',
        receipts: [receipt(conclusion, { reporting_receipt_id: 'receipt-tombcutoff-0001' })],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [conclusion.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [conclusion.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET recorded_at = clock_timestamp() - INTERVAL '200 days',
              data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [conclusion.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    const pruned = await retaining.pruneExpiredEvidence({ account_id: conclusion.accountId });
    assert.equal(pruned.receipts, 1);
    assert.equal(pruned.materializations, 1);
    // Older than the acceptance and the delivery this tombstone records,
    // both of which sit 200 days back after the ageing above.
    const cutoff = (
      await pool.query(
        `SELECT to_char((clock_timestamp() - INTERVAL '300 days') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`
      )
    ).rows[0].value;

    // A conclusion is a fact about an instant. Applying it at a cutoff before
    // it happened let a historical reconcile settle on evidence that did not
    // exist yet.
    const before = await core.getManagedLifecycleProjection({
      reporting_obligation_id: conclusion.obligation.reporting_obligation_id,
      ledgerAsOf: cutoff,
    });
    assert.deepEqual(before.tombstonedAcceptedSubjects, [], 'the acceptance had not happened at this cutoff');
    assert.deepEqual(before.tombstonedDeliveredRevisionIds, [], 'nor had the delivery it records');
    const after = await core.getManagedLifecycleProjection({
      reporting_obligation_id: conclusion.obligation.reporting_obligation_id,
      ledgerAsOf: await core.readLedgerInstant(),
    });
    assert.equal(after.tombstonedAcceptedSubjects.length, 1, 'and both still apply at a later cutoff');
    assert.equal(after.tombstonedDeliveredRevisionIds.length, 1);
  });

  test('does not let a pruned successor hand the chain back to its predecessor', async () => {
    const revived = await deliverOnce(await seedSkewLedger('revive', 'consumer_receipt'));
    const context = { account: { id: revived.accountId }, agent: { agent_url: 'https://revive-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const rejected = await sync(
      {
        idempotency_key: 'receipt-revive-batch-0001',
        receipts: [
          receipt(revived, {
            reporting_receipt_id: 'receipt-revive-0001',
            status: 'rejected',
            rejection_codes: ['ROW_COUNT_MISMATCH'],
          }),
        ],
      },
      context
    );
    assert.equal(rejected.results[0].result, 'recorded');
    const accepted = await sync(
      {
        idempotency_key: 'receipt-revive-batch-0002',
        receipts: [
          receipt(revived, {
            reporting_receipt_id: 'receipt-revive-0002',
            supersedes_reporting_receipt_id: 'receipt-revive-0001',
          }),
        ],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');

    // Age out only the acceptance. The rejection it superseded stays live.
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1 AND reporting_receipt_id = 'receipt-revive-0002'`,
      [revived.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [revived.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [revived.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    assert.equal((await retaining.pruneExpiredEvidence({ account_id: revived.accountId })).receipts, 1);
    const live = await pool.query(`SELECT reporting_receipt_id FROM adcp_reporting_receipts WHERE account_id = $1`, [
      revived.accountId,
    ]);
    assert.deepEqual(
      live.rows.map(value => value.reporting_receipt_id),
      ['receipt-revive-0001'],
      'the rejection it superseded is still stored'
    );

    // Counting only live successors made that rejection the leaf again: the
    // subject read rejected, overriding the acceptance tombstone, while the
    // write path refused any repair because the tombstone says terminal.
    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: revived.obligation.reporting_obligation_id,
      ledgerAsOf: await core.readLedgerInstant(),
    });
    assert.deepEqual(
      projection.consumers.flatMap(value => value.receipts.map(entry => entry.reporting_receipt_id)),
      [],
      'a receipt whose successor was pruned is not a leaf'
    );
    assert.equal(projection.tombstonedAcceptedSubjects.length, 1, 'the acceptance still settles the subject');

    // The public read has to say the same thing. It builds its verdict from
    // the live receipt set, where the rejection is now the only row, so
    // reading the leaf before the conclusion reported `rejected` against a
    // subject the lifecycle considers accepted — a disagreement no later
    // write could resolve, because the write path refuses to repair a
    // terminally accepted subject.
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      { account: { account_id: revived.accountId }, view: 'periods', period: revived.period },
      context
    );
    assert.equal(
      status.periods[0].reconciliation_status,
      'accepted',
      'the pruned acceptance outranks the rejection it superseded'
    );
    assert.equal(
      validateResponse('get_reporting_status', status, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', status, '3.2.0-rc.3').issues)
    );
  });

  test('omits managed evidence for revisions a finality filter excludes', async () => {
    // Its own snapshot-finality fixture rather than the shared one: the
    // revision has to be non-official for `finality: ['official']` to have
    // anything to exclude.
    const snapshot = await deliverOnce(await seedSnapshotFinalityLedger('finalityscope'));
    const context = {
      account: { id: snapshot.accountId },
      agent: { agent_url: 'https://finalityscope-buyer.example' },
    };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const filed = await sync(
      {
        idempotency_key: 'receipt-finalityscope-batch-0001',
        receipts: [receipt(snapshot, { reporting_receipt_id: 'receipt-finalityscope-0001' })],
      },
      context
    );
    assert.equal(filed.results[0].result, 'recorded');
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const official = await getStatus(
      {
        account: { account_id: snapshot.accountId },
        view: 'periods',
        period: snapshot.period,
        finality: ['official'],
      },
      context
    );
    assert.deepEqual(official.revisions, [], 'sanity: the snapshot revision is filtered out');
    // Managed evidence names a revision. Returning it while its revision is
    // filtered out left public references to a revision the response does not
    // contain.
    assert.deepEqual(official.materializations ?? [], []);
    assert.deepEqual(official.receipts ?? [], []);
    assert.equal(
      validateResponse('get_reporting_status', official, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('get_reporting_status', official, '3.2.0-rc.3').issues)
    );
    // Unfiltered, the same read still carries them.
    const unfiltered = await getStatus(
      { account: { account_id: snapshot.accountId }, view: 'periods', period: snapshot.period },
      context
    );
    assert.ok((unfiltered.receipts ?? []).length >= 1, 'sanity: the evidence exists');
  });

  test('truncates an oversized roster and an oversized conclusion set instead of failing', async () => {
    const { Pool } = require('pg');
    const guardSchema = `${schema}_guards`;
    await bootstrap.query(`CREATE SCHEMA "${guardSchema}"`);
    const guardPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${guardSchema}"` });
    try {
      await guardPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await guardPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const wideRoster = Array.from({ length: 10_001 }, (_value, index) => `https://guard-${index}.example`);
      const guardCore = new ledger.PostgresReportingLedgerStore(guardPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
        obligatedConsumers: async () => ({ ids: wideRoster, complete: true, version: 'g1' }),
      });
      const guardManaged = new ledger.PostgresReportingManagedDeliveryStore(guardPool);
      const guarded = await seedSkewLedgerInto(guardCore, guardManaged, 'guards', 'consumer_receipt');

      // A roster this process will not hold is still valid state. Throwing
      // wedged the obligation forever, because nothing about a retry makes a
      // roster smaller.
      const projection = await guardCore.getManagedLifecycleProjection({
        reporting_obligation_id: guarded.obligation.reporting_obligation_id,
        ledgerAsOf: await guardCore.readLedgerInstant(),
      });
      assert.equal(projection.obligatedConsumerIds.length, 10_000, 'truncated, not refused');
      assert.equal(
        projection.obligatedConsumerRosterComplete,
        false,
        'a truncated roster is not the authoritative roster it claimed to be'
      );
      assert.equal(projection.receiptEvidenceComplete, false);

      // Conclusions truncate the same way, and must say so: every subject
      // past the cut reads as never settled, which is exactly how retention
      // reopens work that was already done.
      await guardPool.query(
        `INSERT INTO adcp_reporting_adjustments
          (adjustment_id, obligation_id, adjusts_revision_id, adjustment_number, content_sha256, data, created_at)
         SELECT 'adjustment-guards-' || i, $1, $2::text, i, repeat('a', 64),
                jsonb_build_object(
                  'reporting_adjustment_id', 'adjustment-guards-' || i,
                  'createdAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                ),
                clock_timestamp()
           FROM generate_series(1, 99) AS i`,
        [guarded.obligation.reporting_obligation_id, guarded.revision.reporting_revision_id]
      );
      await guardPool.query(
        `INSERT INTO adcp_reporting_receipt_tombstones
          (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
           status, was_current, semantic_fingerprint, subject_recorded_at)
         SELECT $1,
                'https://guard-' || consumer || '.example',
                'receipt-guards-' || consumer || '-' || subject,
                CASE WHEN subject = 0 THEN 'revision' ELSE 'adjustment' END,
                CASE WHEN subject = 0 THEN $2::text ELSE 'adjustment-guards-' || subject END,
                'accepted', true, 'tomb', clock_timestamp()
           FROM generate_series(1, 101) AS consumer, generate_series(0, 99) AS subject`,
        [guarded.accountId, guarded.revision.reporting_revision_id]
      );
      const withTombstones = await guardCore.getManagedLifecycleProjection({
        reporting_obligation_id: guarded.obligation.reporting_obligation_id,
        ledgerAsOf: await guardCore.readLedgerInstant(),
      });
      assert.equal(withTombstones.tombstonedAcceptedSubjects.length, 10_000, 'truncated deterministically');
      assert.equal(
        withTombstones.receiptEvidenceComplete,
        false,
        'and reported, so the fold cannot settle on a partial conclusion set'
      );
      // Whatever else is true, the obligation still reconciles rather than
      // failing every pass.
      await ledger.reconcileReportingStatusLifecycleV1({
        store: guardCore,
        reporting_obligation_id: guarded.obligation.reporting_obligation_id,
      });
      const watermark = await guardPool.query(
        `SELECT processed_at FROM adcp_reporting_lifecycle_state WHERE obligation_id = $1`,
        [guarded.obligation.reporting_obligation_id]
      );
      assert.equal(watermark.rowCount, 1);
    } finally {
      await guardPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${guardSchema}" CASCADE`);
    }
  });

  test('reads an obligation’s receipts through the subject index, not a global scan', async () => {
    const { Pool } = require('pg');
    const planSchema = `${schema}_receiptplan`;
    await bootstrap.query(`CREATE SCHEMA "${planSchema}"`);
    const planPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${planSchema}"` });
    try {
      await planPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await planPool.query(ledger.REPORTING_MANAGED_DELIVERY_MIGRATION);
      const planCore = new ledger.PostgresReportingLedgerStore(planPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      const planManaged = new ledger.PostgresReportingManagedDeliveryStore(planPool);
      const planned = await seedSkewLedgerInto(planCore, planManaged, 'receiptplan', 'consumer_receipt');
      // Receipt history belonging to other obligations, which is what the old
      // shape re-scanned on every due obligation in every sweep.
      await planPool.query(
        `INSERT INTO adcp_reporting_receipts
          (account_id, consumer_id, reporting_receipt_id, receipt_kind, subject_id,
           is_current, semantic_fingerprint, data, received_at, recorded_at)
         SELECT 'account-plan-noise', 'https://plan-noise.example', 'receipt-plan-noise-' || i,
                'revision', 'revision-plan-noise-' || i, true, 'noise', '{}'::jsonb,
                clock_timestamp(), clock_timestamp()
           FROM generate_series(1, 40000) AS i`
      );
      await planPool.query(
        `INSERT INTO adcp_reporting_consumer_statuses
          (account_id, consumer_id, consumer_status_id, obligation_id, revision_id, chain_key,
           is_current, semantic_fingerprint, data, created_at)
         SELECT 'account-plan-noise', 'https://plan-noise.example', 'status-plan-noise-' || i,
                NULL, NULL, 'chain-plan-noise-' || i, false, 'noise', '{}'::jsonb, clock_timestamp()
           FROM generate_series(1, 40000) AS i`
      );
      await planPool.query('ANALYZE adcp_reporting_receipts');
      await planPool.query('ANALYZE adcp_reporting_consumer_statuses');

      // Capture the statement the store actually issues and explain that,
      // rather than a hand-written approximation of it.
      let captured;
      let capturedDigest;
      const capturingPool = {
        connect: async () => {
          const client = await planPool.connect();
          const query = client.query.bind(client);
          client.query = async (sql, values) => {
            if (typeof sql === 'string' && sql.includes('WITH subject AS')) captured = { sql, values };
            if (typeof sql === 'string' && sql.includes('md5(COALESCE(string_agg(marker')) {
              capturedDigest = { sql, values };
            }
            return query(sql, values);
          };
          const release = client.release.bind(client);
          client.release = (...args) => {
            client.query = query;
            client.release = release;
            return release(...args);
          };
          return client;
        },
        query: (sql, values) => planPool.query(sql, values),
        end: async () => {},
      };
      const capturing = new ledger.PostgresReportingLedgerStore(capturingPool, {
        acknowledgeIsolatedDatabase: true,
        managedDelivery: true,
      });
      await capturing.getManagedLifecycleProjection({
        reporting_obligation_id: planned.obligation.reporting_obligation_id,
        ledgerAsOf: await planCore.readLedgerInstant(),
      });
      assert.ok(captured, 'the projection issued its receipt read');
      const explained = await planPool.query(`EXPLAIN (FORMAT JSON) ${captured.sql}`, captured.values);
      const plan = JSON.stringify(explained.rows[0]['QUERY PLAN']);
      assert.equal(
        /"Node Type":"Seq Scan","Parallel Aware":(?:true|false),"Async Capable":(?:true|false),"Relation Name":"adcp_reporting_receipts"/.test(
          plan
        ),
        false,
        `the receipt table is not scanned whole: ${plan}`
      );
      assert.match(plan, /adcp_reporting_receipts_subject/);

      // The shape this replaced, explained against the same data: asking the
      // global receipt table which of its rows belong to this obligation.
      // Without this comparison the assertion above only says "the plan we
      // have is fine", not that it is better than the plan we had.
      const previous = await planPool.query(
        `EXPLAIN (FORMAT JSON)
         SELECT receipt.consumer_id, receipt.receipt_kind, receipt.data
           FROM adcp_reporting_receipts receipt
          WHERE receipt.recorded_at <= $2
            AND ((receipt.receipt_kind = 'revision' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_revisions revision
                    WHERE revision.revision_id = receipt.subject_id
                      AND revision.obligation_id = $1))
              OR (receipt.receipt_kind = 'adjustment' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_adjustments adjustment
                    WHERE adjustment.adjustment_id = receipt.subject_id
                      AND adjustment.obligation_id = $1)))`,
        [planned.obligation.reporting_obligation_id, captured.values[1]]
      );
      assert.match(
        JSON.stringify(previous.rows[0]['QUERY PLAN']),
        /"Node Type":"Seq Scan"[^}]*"Relation Name":"adcp_reporting_receipts"/,
        'sanity: the shape this replaced really did scan the whole receipt table'
      );

      // The managed state digest runs inside applyLifecycleProjection, which
      // holds the account lock. A scan here is not merely slow: it is a scan
      // with that lock held, which is what pushed concurrent Core writes past
      // their lock timeout and failed them with 55P03.
      assert.ok(capturedDigest, 'the projection read its managed state digest');
      const digestPlan = JSON.stringify(
        (await planPool.query(`EXPLAIN (FORMAT JSON) ${capturedDigest.sql}`, capturedDigest.values)).rows[0][
          'QUERY PLAN'
        ]
      );
      for (const relation of ['adcp_reporting_receipts', 'adcp_reporting_consumer_statuses']) {
        assert.equal(
          new RegExp(`"Node Type":"Seq Scan"[^}]*"Relation Name":"${relation}"`).test(digestPlan),
          false,
          `the digest does not scan ${relation} under the account lock: ${digestPlan}`
        );
      }
      const previousDigest = await planPool.query(
        `EXPLAIN (FORMAT JSON)
         SELECT COUNT(*) FROM adcp_reporting_receipts receipt
          WHERE (receipt.receipt_kind = 'revision' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_revisions revision
                    WHERE revision.revision_id = receipt.subject_id AND revision.obligation_id = $1))
             OR (receipt.receipt_kind = 'adjustment' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_adjustments adjustment
                    WHERE adjustment.adjustment_id = receipt.subject_id AND adjustment.obligation_id = $1))`,
        [planned.obligation.reporting_obligation_id]
      );
      assert.match(
        JSON.stringify(previousDigest.rows[0]['QUERY PLAN']),
        /"Node Type":"Seq Scan"[^}]*"Relation Name":"adcp_reporting_receipts"/,
        'sanity: the digest shape this replaced scanned the whole receipt table too'
      );
    } finally {
      await planPool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${planSchema}" CASCADE`);
    }
  });

  test('folds a correction the database holds even when its author clock ran ahead', async () => {
    const fast = await deliverOnce(await seedSkewLedger('fastauthor', 'consumer_receipt'));
    const consumerId = 'https://fastauthor-buyer.example';
    const context = { account: { id: fast.accountId }, agent: { agent_url: consumerId } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const accepted = await sync(
      {
        idempotency_key: 'receipt-fastauthor-batch-0001',
        receipts: [receipt(fast, { reporting_receipt_id: 'receipt-fastauthor-0001' })],
      },
      context
    );
    assert.equal(accepted.results[0].result, 'recorded');

    // A producer host an hour ahead of the database. The row commits now; the
    // body it carries is dated an hour from now.
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    const rows = [{ media_buy_id: 'buy-3', impressions: 15 }];
    const bytes = Buffer.from(canonicalize(rows), 'utf8');
    const wireAdjustmentWithoutDigest = {
      reporting_adjustment_id: 'adjustment-fastauthor-0001',
      adjusts_reporting_revision_id: fast.revision.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: fast.period.start, end: fast.period.end },
      control_total_deltas: [{ name: 'row_count', value: '0', value_type: 'integer' }],
      correction_observed_at: ahead,
      created_at: ahead,
    };
    await core.commitAdjustment(
      {
        reporting_adjustment_id: wireAdjustmentWithoutDigest.reporting_adjustment_id,
        reporting_obligation_id: fast.obligation.reporting_obligation_id,
        adjusts_reporting_revision_id: fast.revision.reporting_revision_id,
        adjustmentNumber: 1,
        manifest: { level: 'basic', objectRef: 'fastauthor-manifest', sha256: 'b'.repeat(64), byteCount: 1 },
        sourcePublicationId: 'adjustment-publication-fastauthor',
        binding: {
          algorithm: 'rfc8785_jcs_v1',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteCount: bytes.byteLength,
          rowCount: rows.length,
        },
        rows,
        observedAt: ahead,
        dataThrough: fast.period.end,
        sourceReadCutoffAt: ahead,
        createdAt: ahead,
        wireAdjustment: {
          ...wireAdjustmentWithoutDigest,
          canonical_adjustment_sha256: createHash('sha256')
            .update(canonicalize(wireAdjustmentWithoutDigest), 'utf8')
            .digest('hex'),
        },
      },
      fast.coreLease
    );

    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: [consumerId], complete: true, version: 'f1' }),
    });
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: fast.obligation.reporting_obligation_id,
    });
    const persisted = transition ?? (await core.listTransitions(fast.obligation.reporting_obligation_id)).at(-1);
    const getStatus = ledger.createReportingStatusHandler(core, {
      resolveConsumerId: value => value.agent.agent_url,
    });
    const status = await getStatus(
      { account: { account_id: fast.accountId }, view: 'periods', period: fast.period },
      context
    );
    // The public read orders by the database column, so it always saw the
    // correction. Judging the fold by the author's clock hid it from the
    // lifecycle while the watermark advanced past the row's own recorded_at,
    // so the obligation never became due again and the two never converged.
    assert.equal(status.periods[0].health, 'action_required', 'the public read demands a receipt for it');
    assert.equal(persisted.health, status.periods[0].health, 'and the lifecycle agrees with the public read');
  });

  test('settles a delivery whose retention the database accepts and a fast worker would not', async () => {
    const skewed = await seedSkewLedger('workerahead');
    assert.equal(await managed.planMaterializations({ account_id: skewed.accountId }), 1);
    // Exactly the binding's 30-day promise plus half an hour, measured from
    // the database clock that judges it.
    const expiresAt = (
      await pool.query(
        `SELECT to_char((clock_timestamp() + INTERVAL '30 days' + INTERVAL '30 minutes') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`
      )
    ).rows[0].value;
    const outcome = materializationOutcome(skewed);
    outcome.resource.expires_at = expiresAt;
    const adapter = {
      verificationProfiles: ['canonical_digest'],
      revocationFencesDeliveryGenerations: true,
      deliver: async () => outcome,
      read: async () => Buffer.from(''),
      revoke: async () => {},
    };
    // A worker two hours ahead of the database. Judging retention on its own
    // clock rejected a resource the database considers well inside the
    // window, and the refusal surfaced as DELIVERY_FAILED.
    const counts = await ledger.runManagedDeliveryWorker(managed, adapter, {
      now: () => new Date(Date.now() + 7_200_000),
      maxIterations: 2,
      account_id: skewed.accountId,
    });
    assert.equal(counts.failed ?? 0, 0, 'host skew is not a delivery failure');
    const row = await pool.query(
      `SELECT status, data ->> 'failure_code' AS failure_code FROM adcp_reporting_materializations
        WHERE account_id = $1`,
      [skewed.accountId]
    );
    assert.equal(row.rows[0].status, 'available');
    assert.equal(row.rows[0].failure_code, null);

    // The database is still the authority that refuses a genuinely
    // under-retained resource.
    const short = await seedSkewLedger('workershort');
    await managed.planMaterializations({ account_id: short.accountId });
    const shortOutcome = materializationOutcome(short);
    shortOutcome.resource.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    await ledger.runManagedDeliveryWorker(
      managed,
      { ...adapter, deliver: async () => shortOutcome },
      { maxIterations: 2, account_id: short.accountId }
    );
    const refused = await pool.query(
      `SELECT status, data ->> 'failure_code' AS failure_code FROM adcp_reporting_materializations
        WHERE account_id = $1`,
      [short.accountId]
    );
    assert.equal(refused.rows[0].status, 'failed');
    assert.equal(refused.rows[0].failure_code, 'RESOURCE_RETENTION_INSUFFICIENT');
  });

  test('does not demand a receipt for a revision the cutoff predates', async () => {
    const early = await deliverOnce(await seedSkewLedger('earlycutoff', 'consumer_receipt'));
    const consumerId = 'https://earlycutoff-buyer.example';
    const context = { account: { id: early.accountId }, agent: { agent_url: consumerId } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    assert.equal(
      (
        await sync(
          {
            idempotency_key: 'receipt-earlycutoff-batch-0001',
            receipts: [receipt(early, { reporting_receipt_id: 'receipt-earlycutoff-0001' })],
          },
          context
        )
      ).results[0].result,
      'recorded'
    );

    // After the obligation was due, before anything was published. Managed
    // evidence is cutoff-bounded, so leaving the revision set unbounded put a
    // revision into the fold with no materialization and no receipt in scope
    // — an unmet consumer obligation for a revision that did not exist at the
    // instant being described.
    const cutoff = (
      await pool.query(
        `SELECT to_char((clock_timestamp() - INTERVAL '60 seconds') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`
      )
    ).rows[0].value;
    const projection = await core.getManagedLifecycleProjection({
      reporting_obligation_id: early.obligation.reporting_obligation_id,
      ledgerAsOf: cutoff,
    });
    assert.deepEqual(projection.visibleRevisionIds, [], 'the ledger held no revision at that cutoff');

    const rosterStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      managedDelivery: true,
      obligatedConsumers: async () => ({ ids: [consumerId], complete: true, version: 'e1' }),
    });
    await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: early.obligation.reporting_obligation_id,
      ledgerAsOf: cutoff,
    });
    const issues = await pool.query(
      `SELECT data ->> 'code' AS code FROM adcp_reporting_issues
        WHERE obligation_id = $1 AND resolved_at IS NULL`,
      [early.obligation.reporting_obligation_id]
    );
    assert.equal(
      issues.rows.some(row => row.code === 'RECEIPT_REQUIRED'),
      false,
      'no receipt is owed for a revision the cutoff predates'
    );
    // And reconciling now, where the revision and its receipt both exist,
    // settles rather than escalating.
    await ledger.reconcileReportingStatusLifecycleV1({
      store: rosterStore,
      reporting_obligation_id: early.obligation.reporting_obligation_id,
    });
    const settled = await pool.query(
      `SELECT data ->> 'code' AS code FROM adcp_reporting_issues
        WHERE obligation_id = $1 AND resolved_at IS NULL`,
      [early.obligation.reporting_obligation_id]
    );
    assert.deepEqual(settled.rows, [], 'sanity: the present state has nothing outstanding');
  });

  test('answers a re-presented pruned receipt without recreating its row', async () => {
    const gone = await deliverOnce(await seedSkewLedger('norecreate', 'consumer_receipt'));
    const context = { account: { id: gone.accountId }, agent: { agent_url: 'https://norecreate-buyer.example' } };
    const sync = ledger.createSyncReportingReceiptsHandler(managed, value => value.agent.agent_url);
    const body = receipt(gone, { reporting_receipt_id: 'receipt-norecreate-0001' });
    assert.equal(
      (await sync({ idempotency_key: 'receipt-norecreate-batch-0001', receipts: [body] }, context)).results[0].result,
      'recorded'
    );
    await pool.query(
      `UPDATE adcp_reporting_receipts SET recorded_at = clock_timestamp() - INTERVAL '200 days'
        WHERE account_id = $1`,
      [gone.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_receipt_batches SET recorded_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = $1`,
      [gone.accountId]
    );
    await pool.query(
      `UPDATE adcp_reporting_materializations
          SET data = jsonb_set(data, '{resource,expires_at}', to_jsonb(to_char(clock_timestamp() - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
        WHERE account_id = $1`,
      [gone.accountId]
    );
    const retaining = new ledger.PostgresReportingManagedDeliveryStore(pool, { evidenceRetentionDays: 90 });
    assert.equal((await retaining.pruneExpiredEvidence({ account_id: gone.accountId })).receipts, 1);
    const tombstone = await pool.query(
      `SELECT to_char(COALESCE(subject_recorded_at, pruned_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
         FROM adcp_reporting_receipt_tombstones
        WHERE account_id = $1 AND reporting_receipt_id = 'receipt-norecreate-0001'`,
      [gone.accountId]
    );

    // Byte-identical, under a new idempotency key so it walks the record path
    // rather than replaying a batch. Falling through the matching tombstone
    // re-created the row with a fresh instant: the retention clock restarted,
    // the reclaimed storage came back, and the published `received_at` moved
    // to a moment the consumer never filed anything at.
    const again = await sync({ idempotency_key: 'receipt-norecreate-batch-0002', receipts: [body] }, context);
    assert.equal(again.results[0].result, 'unchanged');
    assert.equal(again.results[0].receipt.received_at, tombstone.rows[0].recorded_at);
    const rows = await pool.query(`SELECT COUNT(*)::int AS live FROM adcp_reporting_receipts WHERE account_id = $1`, [
      gone.accountId,
    ]);
    assert.equal(rows.rows[0].live, 0, 'the pruned body is not recreated');
    assert.equal(
      validateResponse('sync_reporting_receipts', again, '3.2.0-rc.3').valid,
      true,
      JSON.stringify(validateResponse('sync_reporting_receipts', again, '3.2.0-rc.3').issues)
    );
  });

  test('refuses a successful settlement that retains nothing at all', async () => {
    const unbounded = await seedSkewLedger('noexpiry');
    assert.equal(await managed.planMaterializations({ account_id: unbounded.accountId }), 1);
    const claimed = await managed.claimMaterialization({
      owner: 'noexpiry-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 120_000,
      account_id: unbounded.accountId,
    });
    assert.ok(claimed);
    const outcome = materializationOutcome(unbounded);
    // A direct store caller, which does not pass through the worker's shape
    // assertion. A NULL expiry was treated as exempt from the retention
    // window, so this persisted as a permanently successful materialization
    // whose bytes no reader can ever fetch — and nothing revisits it, because
    // it is not pending.
    delete outcome.resource.expires_at;
    assert.equal(
      await managed.settleMaterialization({ lease: claimed, now: new Date().toISOString(), outcome }),
      false,
      'a successful outcome must name an expiry the database can check'
    );
    const row = await pool.query(
      `SELECT status, data ->> 'failure_code' AS failure_code FROM adcp_reporting_materializations
        WHERE account_id = $1`,
      [unbounded.accountId]
    );
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].failure_code, 'RESOURCE_RETENTION_INSUFFICIENT');
  });

  test('defaults settlement retention to the binding promise and refuses nonsense', async () => {
    const promised = await seedSkewLedger('retentiondefault');
    await managed.planMaterializations({ account_id: promised.accountId });
    const claimed = await managed.claimMaterialization({
      owner: 'default-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 120_000,
      account_id: promised.accountId,
    });
    assert.ok(claimed);
    assert.equal(claimed.binding.resource_retention_days, 30);
    const outcome = materializationOutcome(promised);
    // Satisfies no retention at all, and is already expired.
    outcome.resource.expires_at = new Date(Date.now() - 86_400_000).toISOString();
    // Omitting the argument used to mean zero, which accepted this.
    assert.equal(
      await managed.settleMaterialization({ lease: claimed, now: new Date().toISOString(), outcome }),
      false,
      'the binding promise is the floor when the caller names none'
    );
    await assert.rejects(
      () =>
        managed.settleMaterialization({
          lease: claimed,
          now: new Date().toISOString(),
          outcome: materializationOutcome(promised),
          minimum_resource_retention_days: -1,
        }),
      /non-negative safe integer/
    );
    // An explicit value may tighten the requirement, never waive it. Taking
    // the caller's number outright let an explicit 0 accept a one-day
    // resource against a thirty-day binding. A fresh row, because the claim
    // above has already been spent by the refusal it was testing.
    const undercut = await seedSkewLedger('retentionundercut');
    await managed.planMaterializations({ account_id: undercut.accountId });
    const freshClaim = await managed.claimMaterialization({
      owner: 'undercut-worker',
      now: new Date().toISOString(),
      lease_milliseconds: 120_000,
      account_id: undercut.accountId,
    });
    assert.ok(freshClaim);
    assert.equal(freshClaim.binding.resource_retention_days, 30);
    const shortLived = materializationOutcome(undercut);
    shortLived.resource.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal(
      await managed.settleMaterialization({
        lease: freshClaim,
        now: new Date().toISOString(),
        outcome: shortLived,
        minimum_resource_retention_days: 0,
      }),
      false,
      'an explicit zero cannot undercut the binding promise'
    );
    const undercutRow = await pool.query(`SELECT status FROM adcp_reporting_materializations WHERE account_id = $1`, [
      undercut.accountId,
    ]);
    assert.equal(undercutRow.rows[0].status, 'failed', 'and the refused attempt is spent, not left pending');
  });

  async function seedCoreLedger() {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 3_600_000).toISOString(),
      end: new Date(nowMs - 1_800_000).toISOString(),
    };
    const accountId = 'account-managed';
    const configuration = {
      configurationId: 'configuration-managed-1',
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: 'billing-files',
      delivery_config_version: 1,
      offeringId: 'billing-files-v1',
      report_definition_id: 'billing-v1',
      feedPurpose: 'billing',
      requiredFinality: 'official',
      canonicalization: {
        id: 'billing-rows-v1',
        uri: 'https://schemas.fixture.example/canonicalization.json',
        sha256: 'c'.repeat(64),
        primaryKeys: ['media_buy_id'],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-1'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: period.start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'billing-v1' },
      installedAt: period.start,
      semanticFingerprint: 'configuration-managed-fingerprint',
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: 'destination-generation-1',
      generation: 1,
      authorized_at: now,
    });
    const binding = ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: 'destination-generation-1',
      authorization_generation: 1,
      feed_purpose: 'billing',
      method: 'file_transfer',
      transport: 'fixture_object_store',
      verification_profile: 'canonical_digest',
      reconciliation_mode: 'consumer_receipt',
      resource_retention_days: 30,
      created_at: now,
    });
    await managed.installBinding(binding);
    const obligation = {
      reporting_obligation_id: 'obligation-managed-1',
      configurationId: configuration.configurationId,
      account: configuration.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: configuration.offeringId,
      report_definition_id: configuration.report_definition_id,
      feedPurpose: 'billing',
      requiredFinality: 'official',
      periodOrdinal: 0,
      period: { ...period, sourceTimezone: 'UTC' },
      schedule: configuration.schedule,
      scopeResolvedAt: period.end,
      coverage: {
        status: 'full',
        evaluatedAt: period.end,
        mediaBuyIds: ['buy-1'],
        fullyCoveredMediaBuyIds: ['buy-1'],
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-1'],
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: period.end,
      recoveryDeadlineAt: new Date(Date.parse(period.end) + 60_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: 'obligation-managed-fingerprint',
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({ owner: 'core-worker', now, leaseMilliseconds: 600_000 });
    const rows = [{ media_buy_id: 'buy-1', impressions: 5 }];
    const controlTotals = [{ name: 'impressions', value: '5', value_type: 'integer', unit: 'impressions' }];
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: 'revision-managed-official-1',
        row_count: rows.length,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const digest = {
      algorithm: 'sha256',
      value: 'b'.repeat(64),
      canonicalization_id: 'billing-rows-v1',
      canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
      canonicalization_sha256: 'c'.repeat(64),
    };
    const revision = {
      reporting_revision_id: 'revision-managed-official-1',
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'official',
      kind: 'official',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: 'publication-managed-1',
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        byteCount: revisionBytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: now,
      dataThrough: period.end,
      sourceReadCutoffAt: now,
      createdAt: now,
      wireRevision: {
        reporting_revision_id: 'revision-managed-official-1',
        revision_content_sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        report_definition_id: 'billing-v1',
        report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
        report_definition_sha256: '9'.repeat(64),
        reporting_profile: 'billing-v1',
        schema_version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: '8'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        account_id: accountId,
        media_buy_ids: ['buy-1'],
        coverage: {
          status: 'full',
          evaluated_at: now,
          media_buy_ids: ['buy-1'],
          fully_covered_media_buy_ids: ['buy-1'],
          partially_covered_media_buy_ids: [],
          unsupported_media_buy_ids: [],
          unknown_media_buy_ids: [],
          package_ids: [],
          covered_package_ids: [],
          unsupported_package_ids: [],
          unknown_package_ids: [],
          limitations: [],
        },
        period: { ...period, source_timezone: 'UTC' },
        finality: 'official',
        finality_basis: 'contractual_cutoff',
        finality_policy_id: 'contractual-cutoff-v1',
        finalized_at: now,
        observed_at: now,
        data_through: period.end,
        data_through_precision: 'exact',
        row_count: 1,
        control_totals: controlTotals,
        canonical_content_digest: digest,
        created_at: now,
      },
    };
    await core.commitRevision(revision, coreLease);
    return { accountId, now, period, configuration, obligation, revision, binding, coreLease };
  }

  async function seedSnapshotFinalityLedger(suffix = 'snapshot') {
    // A non-billing consumer_receipt contract whose Core configuration requires
    // only snapshot finality. Legal under RC3 and previously unreconcilable.
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const period = {
      start: new Date(nowMs - 7_200_000).toISOString(),
      end: new Date(nowMs - 5_400_000).toISOString(),
    };
    const accountId = `account-managed-${suffix}`;
    const canonicalization = {
      id: 'analytics-rows-v1',
      uri: 'https://schemas.fixture.example/canonicalization.json',
      sha256: 'c'.repeat(64),
      primaryKeys: ['media_buy_id'],
    };
    const configuration = {
      configurationId: `configuration-managed-${suffix}-1`,
      account: { account_id: accountId },
      sourceScope: { warehouse: 'fixture' },
      delivery_config_id: 'analytics-files',
      delivery_config_version: 1,
      offeringId: 'analytics-files-v1',
      report_definition_id: 'analytics-v1',
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      canonicalization,
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-2'],
      sourceTimezone: 'UTC',
      schedule: {
        anchor: period.start,
        periodMilliseconds: 1_800_000,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: 60_000,
      },
      sourceSettings: {},
      contract: { reportingProfile: 'analytics-v1' },
      installedAt: period.start,
      semanticFingerprint: `configuration-managed-${suffix}-fingerprint`,
    };
    await core.putConfiguration(configuration);
    await managed.authorizeDestination({
      account_id: accountId,
      destination_ref: `destination-${suffix}-1`,
      generation: 1,
      authorized_at: now,
    });
    const binding = ledger.reportingManagedDeliveryBindingV1({
      configurationId: configuration.configurationId,
      account_id: accountId,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      destination_ref: `destination-${suffix}-1`,
      authorization_generation: 1,
      feed_purpose: 'analytics',
      method: 'file_transfer',
      transport: 'fixture_object_store',
      verification_profile: 'canonical_digest',
      reconciliation_mode: 'consumer_receipt',
      resource_retention_days: 30,
      created_at: now,
    });
    await managed.installBinding(binding);
    const obligation = {
      reporting_obligation_id: `obligation-managed-${suffix}-1`,
      configurationId: configuration.configurationId,
      account: configuration.account,
      sourceScope: configuration.sourceScope,
      delivery_config_id: configuration.delivery_config_id,
      delivery_config_version: 1,
      offeringId: configuration.offeringId,
      report_definition_id: configuration.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      periodOrdinal: 0,
      period: { ...period, sourceTimezone: 'UTC' },
      schedule: configuration.schedule,
      scopeResolvedAt: period.end,
      coverage: {
        status: 'full',
        evaluatedAt: period.end,
        mediaBuyIds: ['buy-2'],
        fullyCoveredMediaBuyIds: ['buy-2'],
        partiallyCoveredMediaBuyIds: [],
        unsupportedMediaBuyIds: [],
        unknownMediaBuyIds: [],
      },
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: ['buy-2'],
      sourceSettings: {},
      contract: configuration.contract,
      expectedAt: period.end,
      recoveryDeadlineAt: new Date(Date.parse(period.end) + 60_000).toISOString(),
      publicationOffsets: [],
      nextAttemptAt: period.end,
      attemptCount: 0,
      state: 'pending',
      semanticFingerprint: `obligation-managed-${suffix}-fingerprint`,
      createdAt: now,
    };
    await core.putObligation(obligation);
    const coreLease = await core.claimObligation({
      owner: `${suffix}-core-worker`,
      now,
      leaseMilliseconds: 600_000,
      account_id: accountId,
    });
    const rows = [{ media_buy_id: 'buy-2', impressions: 9 }];
    const controlTotals = [{ name: 'impressions', value: '9', value_type: 'integer', unit: 'impressions' }];
    const revisionBytes = Buffer.from(
      canonicalize({
        reporting_revision_id: `revision-managed-${suffix}-1`,
        row_count: rows.length,
        control_totals: controlTotals,
        reporting_rows: rows,
      })
    );
    const digest = {
      algorithm: 'sha256',
      value: '5'.repeat(64),
      canonicalization_id: canonicalization.id,
      canonicalization_uri: canonicalization.uri,
      canonicalization_sha256: canonicalization.sha256,
    };
    const revision = {
      reporting_revision_id: `revision-managed-${suffix}-1`,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber: 1,
      finality: 'snapshot',
      kind: 'snapshot',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-managed-${suffix}-1`,
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        byteCount: revisionBytes.byteLength,
        rowCount: rows.length,
      },
      rows,
      observedAt: now,
      dataThrough: period.end,
      sourceReadCutoffAt: now,
      createdAt: now,
      wireRevision: {
        reporting_revision_id: `revision-managed-${suffix}-1`,
        revision_content_sha256: createHash('sha256').update(revisionBytes).digest('hex'),
        report_definition_id: 'analytics-v1',
        report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
        report_definition_sha256: '9'.repeat(64),
        reporting_profile: 'analytics-v1',
        schema_version: '1.0',
        schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
        schema_sha256: '8'.repeat(64),
        schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
        schema_ref_policy: 'local_fragment_only',
        account_id: accountId,
        media_buy_ids: ['buy-2'],
        coverage: {
          status: 'full',
          evaluated_at: now,
          media_buy_ids: ['buy-2'],
          fully_covered_media_buy_ids: ['buy-2'],
          partially_covered_media_buy_ids: [],
          unsupported_media_buy_ids: [],
          unknown_media_buy_ids: [],
          package_ids: [],
          covered_package_ids: [],
          unsupported_package_ids: [],
          unknown_package_ids: [],
          limitations: [],
        },
        period: { ...period, source_timezone: 'UTC' },
        finality: 'snapshot',
        observed_at: now,
        data_through: period.end,
        data_through_precision: 'exact',
        row_count: 1,
        control_totals: controlTotals,
        canonical_content_digest: digest,
        created_at: now,
      },
    };
    await core.commitRevision(revision, coreLease);
    return { accountId, now, period, configuration, obligation, revision, binding, coreLease };
  }
});

function materializationOutcome(fixture) {
  return {
    status: 'available',
    resource: {
      resource_ref: 'resource-managed-1',
      kind: 'manifest',
      location: 'reports/revision-managed-official-1/manifest.json',
      manifest_version: '1.0',
      manifest_sha256: 'f'.repeat(64),
      immutability: 'immutable_location',
      expires_at: new Date(Date.parse(fixture.now) + 31 * 86_400_000).toISOString(),
    },
    verification: {
      verified_at: fixture.now,
      verification_path: 'representative_consumer',
      verification_profile: 'canonical_digest',
      row_count: 1,
      control_totals: fixture.revision.wireRevision.control_totals,
      physical_checksums: [{ object_ref: 'rows.json', algorithm: 'sha256', value: '7'.repeat(64) }],
      canonical_content_digest: fixture.revision.wireRevision.canonical_content_digest,
    },
  };
}

function receipt(fixture, overrides = {}) {
  return {
    reporting_receipt_id: 'receipt-accepted-default-0001',
    reporting_obligation_id: fixture.obligation.reporting_obligation_id,
    reporting_revision_id: fixture.revision.reporting_revision_id,
    reporting_materialization_id: fixture.materialization.reporting_materialization_id,
    status: 'accepted',
    verification_profile: 'canonical_digest',
    observed_row_count: 1,
    observed_control_totals: fixture.revision.wireRevision.control_totals,
    observed_canonical_content_digest: fixture.revision.wireRevision.canonical_content_digest,
    observed_manifest_sha256: fixture.materialization.resource.manifest_sha256,
    observed_at: fixture.now,
    ...overrides,
  };
}

function deliveryOffering() {
  return {
    offering_id: 'managed-file-transfer-v1',
    feed_purpose: 'analytics',
    report_definition_id: 'billing-v1',
    report_definition_uri: 'https://schemas.fixture.example/report-definition.json',
    report_definition_sha256: 'd'.repeat(64),
    reporting_profile: {
      id: 'billing-v1',
      version: '1.0',
      schema_uri: 'https://schemas.fixture.example/reporting-profile.json',
      schema_sha256: 'e'.repeat(64),
      schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
      schema_ref_policy: 'local_fragment_only',
      grain: 'media_buy/day',
      primary_keys: ['media_buy_id'],
      metrics: [{ name: 'impressions', value_type: 'integer' }],
      dimensions: [{ name: 'media_buy_id', value_type: 'string' }],
    },
    schedule: { period_duration: 'PT30M', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['official'],
    reconciliation_mode: 'delivery_only',
    method: {
      pattern: 'file_transfer',
      transport: 'fixture_object_store',
      orchestration: 'producer_managed',
      destination_modes: ['existing'],
      provider: { domain: 'fixture.example' },
      format: 'jsonl',
    },
  };
}
